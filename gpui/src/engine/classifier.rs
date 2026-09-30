use std::collections::{HashMap, HashSet};
use std::time::Duration;

use anyhow::Result;
use chrono::{TimeZone, Utc};
use serde_json::{Value, json};

use crate::engine::classifier_tools::{Toolbox, ToolContext, definitions};
use crate::engine::database::{Correction, now_seconds};
use crate::engine::openai::{OpenAIClient, function_calls};
use crate::engine::sync::INBOX_MESSAGE_LIMIT;
use crate::engine::types::{ConversationKind, InboxItem, Message, MessageRef, Session, User};
use crate::engine::{Shared, text, timestamps};

const BATCH_SIZE: usize = 25;
const MAX_BATCHES_PER_RUN: usize = 8;
const MAX_TURNS: usize = 12;
const MAX_ATTEMPTS: i64 = 3;
const MAX_MESSAGE_AGE_SECONDS: i64 = 7 * 24 * 60 * 60;
const MAX_TEXT_LENGTH: usize = 1500;
const CORRECTION_LIMIT: usize = 20;
const RETRY_DELAY: Duration = Duration::from_secs(60);
const CONTINUE_DELAY: Duration = Duration::from_secs(3);

const INSTRUCTIONS: &str = r#"You sort Slack messages for one person into two groups:

- "important": messages this person should read soon. Examples: a direct question or request to them, a mention of them, a decision or change that affects their work, a problem in something they own, and messages from people who work closely with them.
- "other": messages they can read later or skip. Examples: general announcements, automated notifications that need no action from them, social conversation, and discussion that does not involve them.

For each message in the batch, call classify_message exactly once. Give a short reason the person can understand at a glance.

The memories list holds rules you saved earlier. Follow them. They take priority over the general guidance above.

The corrections list shows messages where the person changed your classification. For each correction, decide what preference it shows, such as a channel, a sender, or a kind of message the person cares about more or less than you expected. Save a memory that states that preference as a rule for future messages, for example "Messages in #announcements are important." or "Successful deploy notifications are other; failed deploys are important." Use query_database if you need more context to find the rule. Keep memories short and general. Update or delete a memory instead of saving a duplicate or a contradicting one. Do not save a memory that only describes one specific message.

You can use query_database for more context, for example earlier messages in the same conversation or how the person classified similar messages. Use it only when the batch does not give you enough information. When every message is classified and your memories are up to date, reply with a short summary and stop."#;

struct PendingMessage {
    id: String,
    item: InboxItem,
    message: Message,
}

fn truncate(text: String) -> String {
    if text.chars().count() <= MAX_TEXT_LENGTH {
        return text;
    }
    format!("{}…", text.chars().take(MAX_TEXT_LENGTH).collect::<String>())
}

fn conversation_description(item: &InboxItem, users: &HashMap<String, User>) -> String {
    let conversation = &item.conversation;
    match conversation.kind {
        ConversationKind::Dm => format!(
            "direct message with {}",
            conversation.user_id.as_ref().and_then(|id| users.get(id)).map_or(conversation.name.as_str(), |user| user.display_name.as_str())
        ),
        ConversationKind::Group => format!("group message with {}", conversation.name),
        ConversationKind::Private => format!("private channel #{}", conversation.name),
        ConversationKind::Channel => format!("channel #{}", conversation.name),
    }
}

fn author(message: &Message, users: &HashMap<String, User>) -> String {
    message
        .user
        .as_ref()
        .and_then(|id| users.get(id))
        .map(|user| user.display_name.clone())
        .or_else(|| message.bot_profile.as_ref().and_then(|bot| bot.name.clone()))
        .or_else(|| message.username.clone())
        .unwrap_or_else(|| "unknown".into())
}

pub fn run_loop(shared: &Shared) {
    let Some(config) = shared.classifier.clone() else { return };
    let toolbox = match Toolbox::open(&shared.database_path) {
        Ok(toolbox) => toolbox,
        Err(error) => {
            shared.update_status(|status| status.classifier.error = Some(error.to_string()));
            return;
        }
    };
    let openai = OpenAIClient::new(config.api_key.clone());
    while !shared.is_stopped() {
        shared.classifier_signal.wait(None, &shared.stopped);
        if shared.is_stopped() {
            return;
        }
        let Some(session) = shared.session() else { continue };
        shared.update_status(|status| {
            status.classifier.running = true;
            status.classifier.error = None;
        });
        let result = shared.classify_pending(&session, &openai, &config.model, &toolbox);
        let pending = shared.pending_messages(&session).map(|pending| pending.len()).unwrap_or(0);
        shared.update_status(|status| {
            status.classifier.running = false;
            status.classifier.pending = pending;
            if let Err(error) = &result {
                status.classifier.error = Some(format!("{error:#}"));
            }
        });
        match result {
            Err(error) => {
                eprintln!("Message classification failed: {error:#}");
                shared.classifier_signal.request(RETRY_DELAY);
            }
            Ok(()) if pending > 0 => shared.classifier_signal.request(CONTINUE_DELAY),
            Ok(()) => {}
        }
    }
}

impl Shared {
    fn pending_messages(&self, session: &Session) -> Result<Vec<PendingMessage>> {
        let database = self.database();
        let items = database.inbox(&session.user_id, INBOX_MESSAGE_LIMIT)?;
        let conversation_ids: Vec<String> = items.iter().map(|item| item.conversation.id.clone()).collect();
        let classifications = database.classifications(&conversation_ids)?;
        let attempts = database.classification_attempts()?;
        drop(database);

        let oldest = now_seconds() - MAX_MESSAGE_AGE_SECONDS;
        let mut pending = Vec::new();
        for item in items {
            for message in &item.messages {
                let id = format!("{}:{}", item.conversation.id, message.ts);
                if classifications.contains_key(&id) || attempts.get(&id).copied().unwrap_or(0) >= MAX_ATTEMPTS {
                    continue;
                }
                if timestamps::seconds(&message.ts) < oldest {
                    continue;
                }
                pending.push(PendingMessage { id, item: item.clone(), message: message.clone() });
            }
        }
        pending.sort_by(|a, b| timestamps::compare(&b.message.ts, &a.message.ts));
        Ok(pending)
    }

    fn classify_pending(&self, session: &Session, openai: &OpenAIClient, model: &str, toolbox: &Toolbox) -> Result<()> {
        let initial = self.pending_messages(session)?.len();
        self.update_status(|status| status.classifier.pending = initial);
        for _ in 0..MAX_BATCHES_PER_RUN {
            if self.is_stopped() {
                return Ok(());
            }
            let batch: Vec<PendingMessage> = self.pending_messages(session)?.into_iter().take(BATCH_SIZE).collect();
            let corrections = self.database().unreviewed_corrections(CORRECTION_LIMIT)?;
            if batch.is_empty() && corrections.is_empty() {
                return Ok(());
            }
            self.classify_batch(session, &batch, &corrections, openai, model, toolbox)?;
            let remaining = self.pending_messages(session)?.len();
            self.update_status(|status| status.classifier.pending = remaining);
        }
        Ok(())
    }

    fn batch_request(&self, session: &Session, batch: &[PendingMessage], corrections: &[Correction]) -> Result<Value> {
        let mut user_ids: HashSet<String> = HashSet::from([session.user_id.clone()]);
        for pending in batch {
            user_ids.extend(pending.message.user.clone());
            user_ids.extend(pending.item.conversation.user_id.clone());
            user_ids.extend(text::mentioned_user_ids(&pending.message.text));
        }
        let database = self.database();
        let users = database.users_by_id(&user_ids.into_iter().collect::<Vec<_>>())?;
        let memories = database.memories()?;
        drop(database);

        let mention = format!("<@{}", session.user_id);
        let messages: Vec<Value> = batch
            .iter()
            .map(|PendingMessage { id, item, message }| {
                json!({
                    "id": id,
                    "conversation": conversation_description(item, &users),
                    "author": author(message, &users),
                    "author_is_bot": message.user.is_none() || message.bot_profile.is_some(),
                    "sent_at": Utc.timestamp_opt(timestamps::seconds(&message.ts), 0).single().map(|time| time.to_rfc3339()),
                    "mentions_person": message.text.contains(&mention),
                    "mentions_everyone": text::mentions_everyone(&message.text),
                    "reply_count": message.reply_count.unwrap_or(0),
                    "text": truncate(text::message_text(message, &users)),
                })
            })
            .collect();
        Ok(json!({
            "person": {
                "name": users.get(&session.user_id).map_or(session.handle.as_str(), |user| user.display_name.as_str()),
                "handle": session.handle,
                "id": session.user_id,
            },
            "memories": memories.iter().map(|memory| json!({ "id": memory.id, "content": memory.content })).collect::<Vec<_>>(),
            "corrections": corrections.iter().map(|correction| json!({
                "conversation_id": correction.reference.channel,
                "ts": correction.reference.ts,
                "text": truncate(text::readable(&correction.text, &users)),
                "changed_from": correction.previous_label.map_or("unclassified", |label| label.as_str()),
                "changed_to": correction.label.as_str(),
            })).collect::<Vec<_>>(),
            "messages": messages,
        }))
    }

    fn classify_batch(
        &self,
        session: &Session,
        batch: &[PendingMessage],
        corrections: &[Correction],
        openai: &OpenAIClient,
        model: &str,
        toolbox: &Toolbox,
    ) -> Result<()> {
        let request = self.batch_request(session, batch, corrections)?;
        let references: HashMap<String, MessageRef> = batch
            .iter()
            .map(|pending| (pending.id.clone(), MessageRef::new(pending.item.conversation.id.clone(), pending.message.ts.clone())))
            .collect();
        let mut context = ToolContext { batch: &references, classified: HashSet::new(), model };
        let mut input = vec![json!({ "role": "user", "content": serde_json::to_string_pretty(&request)? })];
        let tools = definitions();

        let outcome = (|| -> Result<()> {
            for _ in 0..MAX_TURNS {
                if self.is_stopped() {
                    return Ok(());
                }
                let output = openai.respond(model, INSTRUCTIONS, &input, &tools)?;
                let calls = function_calls(&output);
                input.extend(output);
                if calls.is_empty() {
                    return Ok(());
                }
                for call in calls {
                    let result = toolbox.execute(&self.database(), &call, &mut context);
                    input.push(json!({ "type": "function_call_output", "call_id": call.call_id, "output": result }));
                }
                if !context.classified.is_empty() {
                    self.changed();
                }
            }
            Ok(())
        })();

        let unclassified: Vec<MessageRef> = references
            .iter()
            .filter(|(id, _)| !context.classified.contains(*id))
            .map(|(_, reference)| reference.clone())
            .collect();
        self.database().record_classification_attempts(&unclassified)?;
        outcome?;
        let reviewed: Vec<MessageRef> = corrections.iter().map(|correction| correction.reference.clone()).collect();
        self.database().mark_corrections_reviewed(&reviewed)?;
        self.changed();
        Ok(())
    }
}
