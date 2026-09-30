use std::collections::{HashMap, HashSet};
use std::path::Path;

use anyhow::Result;
use rusqlite::types::ValueRef;
use rusqlite::{Connection, OpenFlags};
use serde_json::{Map, Value, json};

use crate::engine::database::Database;
use crate::engine::openai::FunctionCall;
use crate::engine::types::{Label, MessageRef};

const MAX_QUERY_ROWS: usize = 50;
const MAX_QUERY_OUTPUT: usize = 20_000;

const DATABASE_DESCRIPTION: &str = r#"The database is SQLite. Timestamps named ts are Slack message timestamps such as "1790783004.000100" (seconds since 1970). They sort correctly as text.

Tables:
- conversations(id, data, is_member, is_muted, last_read, history_latest). data is JSON: {"id", "name", "kind": "channel" | "private" | "dm" | "group", "userId" for direct messages}.
- messages(conversation_id, ts, thread_ts, user_id, subtype, data). data is JSON with "text", "user", "thread_ts", "reply_count", "reactions", "files", "attachments", "bot_profile". A thread reply has thread_ts different from ts. The database holds recent unread messages, followed threads, and messages the user opened, not full history.
- users(id, data). data is JSON: {"id", "handle", "displayName"}.
- threads(conversation_id, thread_ts, last_read): threads the user follows.
- classifications(conversation_id, ts, label, reason, source, previous_label, created_at). source is "model" or "user". A "user" row is a correction by the user.
- memories(id, content, created_at, updated_at).
- saved_items(conversation_id, ts, state, date_created): messages the user saved for later.

Use json_extract(data, '$.text') to read JSON fields."#;

pub fn definitions() -> Value {
    let label = json!({ "type": "string", "enum": ["important", "other"] });
    let tool = |name: &str, description: &str, properties: Value, required: &[&str]| {
        json!({
            "type": "function",
            "name": name,
            "description": description,
            "strict": true,
            "parameters": { "type": "object", "properties": properties, "required": required, "additionalProperties": false },
        })
    };
    json!([
        tool(
            "classify_message",
            "Record the classification of one message from the current batch. Call this once for every message.",
            json!({
                "message_id": { "type": "string", "description": "The id of the message from the batch." },
                "label": label,
                "reason": { "type": "string", "description": "One short sentence that explains the decision to the user." },
            }),
            &["message_id", "label", "reason"],
        ),
        tool(
            "save_memory",
            "Save a short, general rule or fact that will help classify future messages, such as a preference the user showed through a correction.",
            json!({ "content": { "type": "string" } }),
            &["content"],
        ),
        tool(
            "update_memory",
            "Replace the content of an existing memory.",
            json!({ "memory_id": { "type": "integer" }, "content": { "type": "string" } }),
            &["memory_id", "content"],
        ),
        tool(
            "delete_memory",
            "Delete a memory that is wrong, outdated, or duplicated.",
            json!({ "memory_id": { "type": "integer" } }),
            &["memory_id"],
        ),
        tool(
            "query_database",
            &format!(
                "Run one read-only SQL SELECT statement against the local Slack database and return up to {MAX_QUERY_ROWS} rows as JSON. Use it when a message needs more context, for example earlier messages in the conversation, the thread it belongs to, how the user classified similar messages, or who the author is.\n\n{DATABASE_DESCRIPTION}"
            ),
            json!({ "sql": { "type": "string" } }),
            &["sql"],
        ),
    ])
}

pub struct ToolContext<'a> {
    pub batch: &'a HashMap<String, MessageRef>,
    pub classified: HashSet<String>,
    pub model: &'a str,
}

pub struct Toolbox {
    read_only: Connection,
}

fn value_to_json(value: ValueRef<'_>) -> Value {
    match value {
        ValueRef::Null => Value::Null,
        ValueRef::Integer(integer) => json!(integer),
        ValueRef::Real(real) => json!(real),
        ValueRef::Text(text) => Value::String(String::from_utf8_lossy(text).into_owned()),
        ValueRef::Blob(blob) => Value::String(format!("<{} bytes>", blob.len())),
    }
}

impl Toolbox {
    pub fn open(path: &Path) -> Result<Toolbox> {
        let read_only = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX)?;
        Ok(Toolbox { read_only })
    }

    pub fn execute(&self, database: &Database, call: &FunctionCall, context: &mut ToolContext) -> String {
        let Ok(arguments) = serde_json::from_str::<Value>(&call.arguments) else {
            return "Error: the arguments were not valid JSON.".into();
        };
        let text = |name: &str| arguments.get(name).and_then(Value::as_str).unwrap_or_default().to_string();
        let integer = |name: &str| arguments.get(name).and_then(Value::as_i64).unwrap_or(-1);
        let result = match call.name.as_str() {
            "classify_message" => self.classify(database, &text("message_id"), &text("label"), &text("reason"), context),
            "save_memory" => database.add_memory(&text("content")).map(|id| format!("Saved memory {id}.")),
            "update_memory" => database.update_memory(integer("memory_id"), &text("content")).map(|updated| {
                if updated { "Memory updated.".into() } else { "Error: no memory has that id.".into() }
            }),
            "delete_memory" => database.delete_memory(integer("memory_id")).map(|deleted| {
                if deleted { "Memory deleted.".into() } else { "Error: no memory has that id.".into() }
            }),
            "query_database" => self.query(&text("sql")),
            other => Ok(format!("Error: unknown tool {other}.")),
        };
        result.unwrap_or_else(|error| format!("Error: {error}"))
    }

    fn classify(&self, database: &Database, id: &str, label: &str, reason: &str, context: &mut ToolContext) -> Result<String> {
        let Some(reference) = context.batch.get(id) else { return Ok(format!("Error: {id} is not in the current batch.")) };
        let Some(label) = Label::parse(label) else { return Ok("Error: label must be important or other.".into()) };
        database.save_model_classification(reference, label, reason, context.model)?;
        context.classified.insert(id.to_string());
        Ok("Recorded.".into())
    }

    fn query(&self, sql: &str) -> Result<String> {
        let statement_text = sql.trim().trim_end_matches(';').trim();
        let lowercase = statement_text.to_ascii_lowercase();
        if !(lowercase.starts_with("select") || lowercase.starts_with("with")) || statement_text.contains(';') {
            return Ok("Error: only one SELECT statement is allowed.".into());
        }
        let mut statement = self.read_only.prepare(statement_text)?;
        let columns: Vec<String> = statement.column_names().into_iter().map(String::from).collect();
        let mut rows = statement.query([])?;
        let mut results = Vec::new();
        while let Some(row) = rows.next()? {
            let mut object = Map::new();
            for (index, column) in columns.iter().enumerate() {
                object.insert(column.clone(), value_to_json(row.get_ref(index)?));
            }
            results.push(Value::Object(object));
            if results.len() >= MAX_QUERY_ROWS {
                break;
            }
        }
        let output = Value::Array(results).to_string();
        if output.len() > MAX_QUERY_OUTPUT {
            let cut = (0..=MAX_QUERY_OUTPUT).rev().find(|index| output.is_char_boundary(*index)).unwrap_or(0);
            return Ok(format!("{}… (output truncated)", &output[..cut]));
        }
        Ok(output)
    }
}
