use std::collections::{HashMap, HashSet};
use std::path::Path;

use anyhow::Result;
use rusqlite::{Connection, OptionalExtension, params, params_from_iter};
use serde::Serialize;
use serde::de::DeserializeOwned;

use crate::engine::timestamps;
use crate::engine::types::{
    Classification, ClassificationSource, Conversation, InboxItem, Label, Message, MessageRef, SavedInfo, ThreadContext,
    User,
};

const IGNORED_SUBTYPES: [&str; 4] = ["channel_join", "channel_leave", "group_join", "group_leave"];

const SCHEMA: &str = "
  CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, data TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS emoji (name TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS conversations (
    id TEXT PRIMARY KEY,
    data TEXT NOT NULL,
    is_member INTEGER NOT NULL DEFAULT 1,
    last_read TEXT,
    history_latest TEXT
  );
  CREATE TABLE IF NOT EXISTS messages (
    conversation_id TEXT NOT NULL,
    ts TEXT NOT NULL,
    thread_ts TEXT,
    user_id TEXT,
    subtype TEXT,
    data TEXT NOT NULL,
    PRIMARY KEY (conversation_id, ts)
  );
  CREATE INDEX IF NOT EXISTS messages_by_thread ON messages (conversation_id, thread_ts);
  CREATE TABLE IF NOT EXISTS threads (
    conversation_id TEXT NOT NULL,
    thread_ts TEXT NOT NULL,
    last_read TEXT NOT NULL,
    PRIMARY KEY (conversation_id, thread_ts)
  );
  CREATE TABLE IF NOT EXISTS classifications (
    conversation_id TEXT NOT NULL,
    ts TEXT NOT NULL,
    label TEXT NOT NULL,
    reason TEXT NOT NULL,
    source TEXT NOT NULL,
    model TEXT,
    previous_label TEXT,
    reviewed INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (conversation_id, ts)
  );
  CREATE TABLE IF NOT EXISTS classification_attempts (
    conversation_id TEXT NOT NULL,
    ts TEXT NOT NULL,
    attempts INTEGER NOT NULL,
    PRIMARY KEY (conversation_id, ts)
  );
  CREATE TABLE IF NOT EXISTS memories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    content TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS saved_items (
    conversation_id TEXT NOT NULL,
    ts TEXT NOT NULL,
    state TEXT NOT NULL,
    date_created INTEGER NOT NULL,
    PRIMARY KEY (conversation_id, ts)
  );
";

const COLUMN_MIGRATIONS: [(&str, &str, &str); 1] = [("conversations", "is_muted", "INTEGER NOT NULL DEFAULT 0")];

const TOP_LEVEL: &str = "(thread_ts IS NULL OR thread_ts = ts OR subtype = 'thread_broadcast')";
const TOP_LEVEL_MESSAGE: &str = "(m.thread_ts IS NULL OR m.thread_ts = m.ts OR m.subtype = 'thread_broadcast')";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SavedState {
    InProgress,
    Completed,
}

impl SavedState {
    fn as_str(self) -> &'static str {
        match self {
            SavedState::InProgress => "in_progress",
            SavedState::Completed => "completed",
        }
    }
}

#[derive(Clone, Debug)]
pub struct SavedItem {
    pub reference: MessageRef,
    pub state: SavedState,
    pub date_created: i64,
}

#[derive(Clone, Debug)]
pub struct StoredConversation {
    pub conversation: Conversation,
    pub last_read: Option<String>,
    pub history_latest: Option<String>,
    pub newest_ts: Option<String>,
}

#[derive(Clone, Debug)]
pub struct ThreadRecord {
    pub channel: String,
    pub thread_ts: String,
    pub last_read: String,
}

#[derive(Clone, Debug)]
pub struct Memory {
    pub id: i64,
    pub content: String,
}

#[derive(Clone, Debug)]
pub struct Correction {
    pub reference: MessageRef,
    pub label: Label,
    pub previous_label: Option<Label>,
    pub text: String,
}

pub struct LaterResult {
    pub items: Vec<InboxItem>,
    pub missing: Vec<MessageRef>,
}

fn to_json<T: Serialize>(value: &T) -> String {
    serde_json::to_string(value).unwrap_or_else(|_| "null".into())
}

fn from_json<T: DeserializeOwned>(text: &str) -> Option<T> {
    serde_json::from_str(text).ok()
}

fn now_millis() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |duration| duration.as_millis() as i64)
}

pub fn now_seconds() -> i64 {
    now_millis() / 1000
}

fn placeholders(count: usize) -> String {
    vec!["?"; count].join(", ")
}

pub struct Database {
    connection: Connection,
}

impl Database {
    pub fn open(path: &Path) -> Result<Database> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let connection = Connection::open(path)?;
        connection.pragma_update(None, "journal_mode", "WAL")?;
        connection.busy_timeout(std::time::Duration::from_secs(5))?;
        connection.execute_batch(SCHEMA)?;
        let database = Database { connection };
        database.migrate_columns()?;
        Ok(database)
    }

    fn migrate_columns(&self) -> Result<()> {
        for (table, column, definition) in COLUMN_MIGRATIONS {
            let mut statement = self.connection.prepare(&format!("PRAGMA table_info({table})"))?;
            let exists = statement.query_map([], |row| row.get::<_, String>(1))?.flatten().any(|name| name == column);
            if !exists {
                self.connection.execute_batch(&format!("ALTER TABLE {table} ADD COLUMN {column} {definition}"))?;
            }
        }
        Ok(())
    }

    pub fn transaction<T>(&self, work: impl FnOnce(&Database) -> Result<T>) -> Result<T> {
        let transaction = self.connection.unchecked_transaction()?;
        let result = work(self)?;
        transaction.commit()?;
        Ok(result)
    }

    pub fn clear_workspace(&self) -> Result<()> {
        self.transaction(|database| {
            for table in [
                "metadata",
                "users",
                "emoji",
                "conversations",
                "messages",
                "saved_items",
                "threads",
                "classifications",
                "classification_attempts",
            ] {
                database.connection.execute(&format!("DELETE FROM {table}"), [])?;
            }
            Ok(())
        })
    }

    pub fn metadata<T: DeserializeOwned>(&self, key: &str) -> Option<T> {
        let value: Option<String> = self
            .connection
            .query_row("SELECT value FROM metadata WHERE key = ?", [key], |row| row.get(0))
            .optional()
            .ok()
            .flatten();
        value.and_then(|value| from_json(&value))
    }

    pub fn set_metadata<T: Serialize>(&self, key: &str, value: &T) -> Result<()> {
        self.connection.execute(
            "INSERT INTO metadata (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
            params![key, to_json(value)],
        )?;
        Ok(())
    }

    pub fn replace_users(&self, users: &[User]) -> Result<()> {
        self.transaction(|database| {
            database.connection.execute("DELETE FROM users", [])?;
            let mut insert = database.connection.prepare("INSERT INTO users (id, data) VALUES (?, ?)")?;
            for user in users {
                insert.execute(params![user.id, to_json(user)])?;
            }
            Ok(())
        })
    }

    pub fn upsert_user(&self, user: &User) -> Result<()> {
        self.connection.execute(
            "INSERT INTO users (id, data) VALUES (?, ?) ON CONFLICT (id) DO UPDATE SET data = excluded.data",
            params![user.id, to_json(user)],
        )?;
        Ok(())
    }

    pub fn users_by_id(&self, ids: &[String]) -> Result<HashMap<String, User>> {
        if ids.is_empty() {
            return Ok(HashMap::new());
        }
        let mut statement =
            self.connection.prepare(&format!("SELECT data FROM users WHERE id IN ({})", placeholders(ids.len())))?;
        let users = statement
            .query_map(params_from_iter(ids), |row| row.get::<_, String>(0))?
            .flatten()
            .filter_map(|data| from_json::<User>(&data))
            .map(|user| (user.id.clone(), user))
            .collect();
        Ok(users)
    }

    pub fn replace_emoji(&self, emoji: &HashMap<String, String>) -> Result<()> {
        self.transaction(|database| {
            database.connection.execute("DELETE FROM emoji", [])?;
            let mut insert = database.connection.prepare("INSERT INTO emoji (name, value) VALUES (?, ?)")?;
            for (name, value) in emoji {
                insert.execute(params![name, value])?;
            }
            Ok(())
        })
    }

    pub fn emoji(&self) -> Result<HashMap<String, String>> {
        let mut statement = self.connection.prepare("SELECT name, value FROM emoji")?;
        let emoji = statement.query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?.flatten().collect();
        Ok(emoji)
    }

    pub fn replace_conversations(&self, conversations: &[Conversation]) -> Result<()> {
        self.transaction(|database| {
            database.connection.execute("UPDATE conversations SET is_member = 0", [])?;
            let mut upsert = database.connection.prepare(
                "INSERT INTO conversations (id, data, is_member) VALUES (?, ?, 1)
                 ON CONFLICT (id) DO UPDATE SET data = excluded.data, is_member = 1",
            )?;
            for conversation in conversations {
                upsert.execute(params![conversation.id, to_json(conversation)])?;
            }
            Ok(())
        })
    }

    pub fn upsert_conversation(&self, conversation: &Conversation, is_member: bool) -> Result<()> {
        self.connection.execute(
            "INSERT INTO conversations (id, data, is_member) VALUES (?, ?, ?)
             ON CONFLICT (id) DO UPDATE SET data = excluded.data",
            params![conversation.id, to_json(conversation), is_member],
        )?;
        Ok(())
    }

    pub fn conversations(&self) -> Result<Vec<StoredConversation>> {
        let mut statement = self.connection.prepare(&format!(
            "SELECT c.data, c.last_read, c.history_latest,
               (SELECT MAX(m.ts) FROM messages m WHERE m.conversation_id = c.id AND {TOP_LEVEL_MESSAGE})
             FROM conversations c WHERE c.is_member = 1"
        ))?;
        let rows = statement
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, Option<String>>(1)?,
                    row.get::<_, Option<String>>(2)?,
                    row.get::<_, Option<String>>(3)?,
                ))
            })?
            .flatten()
            .filter_map(|(data, last_read, history_latest, newest_ts)| {
                Some(StoredConversation { conversation: from_json(&data)?, last_read, history_latest, newest_ts })
            })
            .collect();
        Ok(rows)
    }

    pub fn has_member_conversation(&self, id: &str) -> bool {
        self.exists("SELECT 1 FROM conversations WHERE id = ? AND is_member = 1", &[id])
    }

    pub fn has_conversation(&self, id: &str) -> bool {
        self.exists("SELECT 1 FROM conversations WHERE id = ?", &[id])
    }

    fn exists(&self, sql: &str, values: &[&str]) -> bool {
        self.connection.query_row(sql, params_from_iter(values), |_| Ok(())).optional().ok().flatten().is_some()
    }

    pub fn set_read_states(&self, states: &[(String, String)]) -> Result<()> {
        self.transaction(|database| {
            let mut update = database.connection.prepare("UPDATE conversations SET last_read = ? WHERE id = ?")?;
            for (id, last_read) in states {
                update.execute(params![last_read, id])?;
            }
            Ok(())
        })
    }

    pub fn muted_conversation_ids(&self) -> Result<HashSet<String>> {
        let mut statement = self.connection.prepare("SELECT id FROM conversations WHERE is_muted = 1")?;
        let ids = statement.query_map([], |row| row.get::<_, String>(0))?.flatten().collect();
        Ok(ids)
    }

    pub fn set_muted(&self, id: &str, muted: bool) -> Result<()> {
        self.connection.execute("UPDATE conversations SET is_muted = ? WHERE id = ?", params![muted, id])?;
        Ok(())
    }

    pub fn replace_muted(&self, ids: &HashSet<String>) -> Result<()> {
        self.transaction(|database| {
            database.connection.execute("UPDATE conversations SET is_muted = 0", [])?;
            let mut update = database.connection.prepare("UPDATE conversations SET is_muted = 1 WHERE id = ?")?;
            for id in ids {
                update.execute([id])?;
            }
            Ok(())
        })
    }

    pub fn replace_history_window(
        &self,
        channel: &str,
        oldest: &str,
        messages: &[Message],
        complete: bool,
        latest: Option<&str>,
    ) -> Result<()> {
        let mut returned: Vec<&str> = messages.iter().map(|message| message.ts.as_str()).collect();
        returned.sort_by(|a, b| timestamps::compare(a, b));
        let window_start = if complete { Some(oldest) } else { returned.first().copied() };
        self.transaction(|database| {
            if let Some(start) = window_start {
                let comparison = if complete { ">" } else { ">=" };
                database.connection.execute(
                    &format!("DELETE FROM messages WHERE conversation_id = ? AND ts {comparison} ? AND {TOP_LEVEL}"),
                    params![channel, start],
                )?;
            }
            database.insert_messages(channel, messages)?;
            database.connection.execute(
                "UPDATE conversations SET history_latest = ? WHERE id = ?",
                params![latest.or(returned.last().copied()), channel],
            )?;
            Ok(())
        })
    }

    pub fn upsert_messages(&self, channel: &str, messages: &[Message]) -> Result<()> {
        self.transaction(|database| database.insert_messages(channel, messages))
    }

    fn insert_messages(&self, channel: &str, messages: &[Message]) -> Result<()> {
        let mut upsert = self.connection.prepare_cached(
            "INSERT INTO messages (conversation_id, ts, thread_ts, user_id, subtype, data) VALUES (?, ?, ?, ?, ?, ?)
             ON CONFLICT (conversation_id, ts) DO UPDATE SET
               thread_ts = excluded.thread_ts, user_id = excluded.user_id, subtype = excluded.subtype, data = excluded.data",
        )?;
        for message in messages {
            upsert.execute(params![channel, message.ts, message.thread_ts, message.user, message.subtype, to_json(message)])?;
        }
        Ok(())
    }

    pub fn message(&self, channel: &str, ts: &str) -> Option<Message> {
        let data: Option<String> = self
            .connection
            .query_row("SELECT data FROM messages WHERE conversation_id = ? AND ts = ?", [channel, ts], |row| row.get(0))
            .optional()
            .ok()
            .flatten();
        data.and_then(|data| from_json(&data))
    }

    pub fn delete_message(&self, channel: &str, ts: &str) -> Result<()> {
        self.connection.execute("DELETE FROM messages WHERE conversation_id = ? AND ts = ?", [channel, ts])?;
        Ok(())
    }

    pub fn inbox(&self, self_id: &str, message_limit: usize) -> Result<Vec<InboxItem>> {
        let ignored = placeholders(IGNORED_SUBTYPES.len());
        let mut statement = self.connection.prepare(&format!(
            "SELECT c.data, m.data
             FROM conversations c
             JOIN messages m ON m.conversation_id = c.id
             WHERE c.is_member = 1
               AND c.last_read IS NOT NULL
               AND m.ts > c.last_read
               AND {TOP_LEVEL_MESSAGE}
               AND COALESCE(m.user_id, '') <> ?
               AND COALESCE(m.subtype, '') NOT IN ({ignored})
             ORDER BY c.id, m.ts"
        ))?;
        let mut values: Vec<&str> = vec![self_id];
        values.extend(IGNORED_SUBTYPES);
        let rows = statement.query_map(params_from_iter(values), |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)))?;

        let mut items: Vec<InboxItem> = Vec::new();
        for (conversation, message) in rows.flatten() {
            let (Some(conversation), Some(message)) = (from_json::<Conversation>(&conversation), from_json::<Message>(&message))
            else {
                continue;
            };
            match items.last_mut() {
                Some(item) if item.id == conversation.id => item.messages.push(message),
                _ => items.push(InboxItem {
                    id: conversation.id.clone(),
                    conversation,
                    messages: vec![message],
                    thread: None,
                    saved: None,
                }),
            }
        }
        for item in &mut items {
            let excess = item.messages.len().saturating_sub(message_limit);
            item.messages.drain(..excess);
        }
        Ok(items)
    }

    pub fn set_thread(&self, thread: &ThreadRecord) -> Result<()> {
        self.connection.execute(
            "INSERT INTO threads (conversation_id, thread_ts, last_read) VALUES (?, ?, ?)
             ON CONFLICT (conversation_id, thread_ts) DO UPDATE SET last_read = excluded.last_read",
            params![thread.channel, thread.thread_ts, thread.last_read],
        )?;
        Ok(())
    }

    pub fn set_thread_last_read(&self, channel: &str, thread_ts: &str, last_read: &str) -> Result<()> {
        self.connection.execute(
            "UPDATE threads SET last_read = ? WHERE conversation_id = ? AND thread_ts = ?",
            params![last_read, channel, thread_ts],
        )?;
        Ok(())
    }

    pub fn delete_thread(&self, channel: &str, thread_ts: &str) -> Result<()> {
        self.connection.execute("DELETE FROM threads WHERE conversation_id = ? AND thread_ts = ?", [channel, thread_ts])?;
        Ok(())
    }

    pub fn apply_thread_view(&self, threads: &[ThreadRecord], messages: &[(String, Message)], complete: bool) -> Result<()> {
        self.transaction(|database| {
            for thread in threads {
                database.set_thread(thread)?;
            }
            for (channel, message) in messages {
                database.insert_messages(channel, std::slice::from_ref(message))?;
            }
            if !complete {
                return Ok(());
            }
            let returned: HashSet<String> =
                threads.iter().map(|thread| format!("{}:{}", thread.channel, thread.thread_ts)).collect();
            let mut statement = database.connection.prepare("SELECT conversation_id, thread_ts FROM threads")?;
            let rows: Vec<(String, String)> =
                statement.query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?.flatten().collect();
            let mut mark_read = database.connection.prepare(
                "UPDATE threads SET last_read = COALESCE(
                   (SELECT MAX(ts) FROM messages WHERE conversation_id = threads.conversation_id AND thread_ts = threads.thread_ts),
                   last_read)
                 WHERE conversation_id = ? AND thread_ts = ?",
            )?;
            for (channel, thread_ts) in rows {
                if !returned.contains(&format!("{channel}:{thread_ts}")) {
                    mark_read.execute([channel, thread_ts])?;
                }
            }
            Ok(())
        })
    }

    pub fn thread_inbox(&self, self_id: &str) -> Result<Vec<InboxItem>> {
        let mut statement = self.connection.prepare(
            "SELECT c.data, root.data, m.data, t.thread_ts
             FROM threads t
             JOIN conversations c ON c.id = t.conversation_id
             JOIN messages root ON root.conversation_id = t.conversation_id AND root.ts = t.thread_ts
             JOIN messages m ON m.conversation_id = t.conversation_id AND m.thread_ts = t.thread_ts AND m.ts <> t.thread_ts
             WHERE m.ts > t.last_read AND COALESCE(m.user_id, '') <> ?
             ORDER BY t.conversation_id, t.thread_ts, m.ts",
        )?;
        let rows = statement.query_map([self_id], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, String>(2)?, row.get::<_, String>(3)?))
        })?;
        let mut items: Vec<InboxItem> = Vec::new();
        for (conversation, root, message, thread_ts) in rows.flatten() {
            let (Some(conversation), Some(root), Some(message)) =
                (from_json::<Conversation>(&conversation), from_json::<Message>(&root), from_json::<Message>(&message))
            else {
                continue;
            };
            let id = format!("thread:{}:{}", conversation.id, thread_ts);
            match items.last_mut() {
                Some(item) if item.id == id => item.messages.push(message),
                _ => items.push(InboxItem {
                    id,
                    conversation,
                    messages: vec![message],
                    thread: Some(ThreadContext { ts: thread_ts, root }),
                    saved: None,
                }),
            }
        }
        Ok(items)
    }

    pub fn saved_item(&self, reference: &MessageRef) -> Option<SavedItem> {
        self.connection
            .query_row(
                "SELECT state, date_created FROM saved_items WHERE conversation_id = ? AND ts = ?",
                [&reference.channel, &reference.ts],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?)),
            )
            .optional()
            .ok()
            .flatten()
            .map(|(state, date_created)| SavedItem {
                reference: reference.clone(),
                state: if state == "completed" { SavedState::Completed } else { SavedState::InProgress },
                date_created,
            })
    }

    pub fn set_saved_item(&self, item: &SavedItem) -> Result<()> {
        self.connection.execute(
            "INSERT INTO saved_items (conversation_id, ts, state, date_created) VALUES (?, ?, ?, ?)
             ON CONFLICT (conversation_id, ts) DO UPDATE SET state = excluded.state, date_created = excluded.date_created",
            params![item.reference.channel, item.reference.ts, item.state.as_str(), item.date_created],
        )?;
        Ok(())
    }

    pub fn delete_saved_item(&self, reference: &MessageRef) -> Result<()> {
        self.connection
            .execute("DELETE FROM saved_items WHERE conversation_id = ? AND ts = ?", [&reference.channel, &reference.ts])?;
        Ok(())
    }

    pub fn replace_in_progress_saved_items(&self, items: &[SavedItem], keep_created_after: i64) -> Result<()> {
        self.transaction(|database| {
            database.connection.execute(
                "DELETE FROM saved_items WHERE state = 'in_progress' AND date_created < ?",
                [keep_created_after],
            )?;
            for item in items {
                database.set_saved_item(item)?;
            }
            Ok(())
        })
    }

    pub fn later(&self) -> Result<LaterResult> {
        let mut statement = self.connection.prepare(
            "SELECT s.conversation_id, s.ts, s.date_created, c.data, m.data
             FROM saved_items s
             LEFT JOIN conversations c ON c.id = s.conversation_id
             LEFT JOIN messages m ON m.conversation_id = s.conversation_id AND m.ts = s.ts
             WHERE s.state = 'in_progress'
             ORDER BY s.date_created DESC",
        )?;
        let rows = statement.query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, i64>(2)?,
                row.get::<_, Option<String>>(3)?,
                row.get::<_, Option<String>>(4)?,
            ))
        })?;
        let mut result = LaterResult { items: Vec::new(), missing: Vec::new() };
        for (channel, ts, date_created, conversation, message) in rows.flatten() {
            let conversation = conversation.as_deref().and_then(from_json::<Conversation>);
            let message = message.as_deref().and_then(from_json::<Message>);
            let (Some(conversation), Some(message)) = (conversation, message) else {
                result.missing.push(MessageRef::new(channel, ts));
                continue;
            };
            result.items.push(InboxItem {
                id: format!("{channel}:{ts}"),
                conversation,
                messages: vec![message],
                thread: None,
                saved: Some(SavedInfo { ts, saved_at: date_created }),
            });
        }
        Ok(result)
    }

    pub fn classifications(&self, conversation_ids: &[String]) -> Result<HashMap<String, Classification>> {
        if conversation_ids.is_empty() {
            return Ok(HashMap::new());
        }
        let mut statement = self.connection.prepare(&format!(
            "SELECT conversation_id, ts, label, reason, source FROM classifications WHERE conversation_id IN ({})",
            placeholders(conversation_ids.len())
        ))?;
        let rows = statement.query_map(params_from_iter(conversation_ids), |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, String>(4)?,
            ))
        })?;
        let mut result = HashMap::new();
        for (channel, ts, label, reason, source) in rows.flatten() {
            let Some(label) = Label::parse(&label) else { continue };
            let source = if source == "user" { ClassificationSource::User } else { ClassificationSource::Model };
            result.insert(format!("{channel}:{ts}"), Classification { label, reason, source });
        }
        Ok(result)
    }

    pub fn classification_attempts(&self) -> Result<HashMap<String, i64>> {
        let mut statement = self.connection.prepare("SELECT conversation_id, ts, attempts FROM classification_attempts")?;
        let attempts = statement
            .query_map([], |row| Ok((format!("{}:{}", row.get::<_, String>(0)?, row.get::<_, String>(1)?), row.get(2)?)))?
            .flatten()
            .collect();
        Ok(attempts)
    }

    pub fn record_classification_attempts(&self, references: &[MessageRef]) -> Result<()> {
        self.transaction(|database| {
            let mut upsert = database.connection.prepare(
                "INSERT INTO classification_attempts (conversation_id, ts, attempts) VALUES (?, ?, 1)
                 ON CONFLICT (conversation_id, ts) DO UPDATE SET attempts = attempts + 1",
            )?;
            for reference in references {
                upsert.execute([&reference.channel, &reference.ts])?;
            }
            Ok(())
        })
    }

    pub fn save_model_classification(&self, reference: &MessageRef, label: Label, reason: &str, model: &str) -> Result<()> {
        self.connection.execute(
            "INSERT INTO classifications (conversation_id, ts, label, reason, source, model, created_at)
             VALUES (?, ?, ?, ?, 'model', ?, ?)
             ON CONFLICT (conversation_id, ts) DO UPDATE SET
               label = excluded.label, reason = excluded.reason, model = excluded.model, created_at = excluded.created_at
             WHERE classifications.source = 'model'",
            params![reference.channel, reference.ts, label.as_str(), reason, model, now_millis()],
        )?;
        Ok(())
    }

    pub fn save_user_classification(&self, reference: &MessageRef, label: Label) -> Result<()> {
        let existing: Option<(String, String, Option<String>)> = self
            .connection
            .query_row(
                "SELECT label, source, previous_label FROM classifications WHERE conversation_id = ? AND ts = ?",
                [&reference.channel, &reference.ts],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .optional()?;
        let previous_label = match existing {
            Some((_, source, previous)) if source == "user" => previous,
            Some((label, _, _)) => Some(label),
            None => None,
        };
        self.connection.execute(
            "INSERT INTO classifications (conversation_id, ts, label, reason, source, previous_label, reviewed, created_at)
             VALUES (?, ?, ?, 'Set by you', 'user', ?, 0, ?)
             ON CONFLICT (conversation_id, ts) DO UPDATE SET
               label = excluded.label, reason = excluded.reason, source = 'user',
               previous_label = excluded.previous_label, reviewed = 0, created_at = excluded.created_at",
            params![reference.channel, reference.ts, label.as_str(), previous_label, now_millis()],
        )?;
        Ok(())
    }

    pub fn restore_classification(&self, reference: &MessageRef, classification: Option<&Classification>) -> Result<()> {
        let Some(classification) = classification else {
            self.connection
                .execute("DELETE FROM classifications WHERE conversation_id = ? AND ts = ?", [&reference.channel, &reference.ts])?;
            return Ok(());
        };
        let source = match classification.source {
            ClassificationSource::Model => "model",
            ClassificationSource::User => "user",
        };
        self.connection.execute(
            "INSERT INTO classifications (conversation_id, ts, label, reason, source, created_at) VALUES (?, ?, ?, ?, ?, ?)
             ON CONFLICT (conversation_id, ts) DO UPDATE SET
               label = excluded.label, reason = excluded.reason, source = excluded.source, previous_label = NULL, reviewed = 1",
            params![reference.channel, reference.ts, classification.label.as_str(), classification.reason, source, now_millis()],
        )?;
        Ok(())
    }

    pub fn unreviewed_corrections(&self, limit: usize) -> Result<Vec<Correction>> {
        let mut statement = self.connection.prepare(
            "SELECT c.conversation_id, c.ts, c.label, c.previous_label, json_extract(m.data, '$.text')
             FROM classifications c
             LEFT JOIN messages m ON m.conversation_id = c.conversation_id AND m.ts = c.ts
             WHERE c.source = 'user' AND c.reviewed = 0
             ORDER BY c.created_at DESC LIMIT ?",
        )?;
        let corrections = statement
            .query_map([limit as i64], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, Option<String>>(3)?,
                    row.get::<_, Option<String>>(4)?,
                ))
            })?
            .flatten()
            .filter_map(|(channel, ts, label, previous, text)| {
                Some(Correction {
                    reference: MessageRef::new(channel, ts),
                    label: Label::parse(&label)?,
                    previous_label: previous.as_deref().and_then(Label::parse),
                    text: text.unwrap_or_default(),
                })
            })
            .collect();
        Ok(corrections)
    }

    pub fn mark_corrections_reviewed(&self, references: &[MessageRef]) -> Result<()> {
        self.transaction(|database| {
            let mut update = database
                .connection
                .prepare("UPDATE classifications SET reviewed = 1 WHERE conversation_id = ? AND ts = ?")?;
            for reference in references {
                update.execute([&reference.channel, &reference.ts])?;
            }
            Ok(())
        })
    }

    pub fn memories(&self) -> Result<Vec<Memory>> {
        let mut statement = self.connection.prepare("SELECT id, content FROM memories ORDER BY id")?;
        let memories =
            statement.query_map([], |row| Ok(Memory { id: row.get(0)?, content: row.get(1)? }))?.flatten().collect();
        Ok(memories)
    }

    pub fn add_memory(&self, content: &str) -> Result<i64> {
        let now = now_millis();
        self.connection.execute(
            "INSERT INTO memories (content, created_at, updated_at) VALUES (?, ?, ?)",
            params![content, now, now],
        )?;
        Ok(self.connection.last_insert_rowid())
    }

    pub fn update_memory(&self, id: i64, content: &str) -> Result<bool> {
        let changed = self
            .connection
            .execute("UPDATE memories SET content = ?, updated_at = ? WHERE id = ?", params![content, now_millis(), id])?;
        Ok(changed > 0)
    }

    pub fn delete_memory(&self, id: i64) -> Result<bool> {
        Ok(self.connection.execute("DELETE FROM memories WHERE id = ?", [id])? > 0)
    }
}
