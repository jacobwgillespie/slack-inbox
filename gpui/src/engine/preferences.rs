use std::collections::{HashMap, HashSet};

use anyhow::Result;
use serde::Deserialize;
use serde_json::Value;

use crate::engine::Shared;
use crate::engine::database::{SavedItem, SavedState, now_seconds};
use crate::engine::slack_data::{RawConversation, to_conversation};
use crate::engine::types::{Message, MessageRef};

const SAVED_PAGE_SIZE: &str = "50";

#[derive(Deserialize)]
struct RawSavedItem {
    item_id: String,
    item_type: String,
    ts: Option<String>,
    state: String,
    date_created: i64,
}

#[derive(Deserialize, Default)]
struct ChannelNotificationPreferences {
    #[serde(default)]
    muted: bool,
}

#[derive(Deserialize, Default)]
struct NotificationPreferences {
    #[serde(default)]
    channels: HashMap<String, ChannelNotificationPreferences>,
}

#[derive(Deserialize)]
struct Messages {
    #[serde(default)]
    messages: Vec<Message>,
}

#[derive(Deserialize)]
struct ConversationInfo {
    channel: RawConversation,
}

fn parse_notification_preferences(value: &Value) -> NotificationPreferences {
    match value {
        Value::String(text) => serde_json::from_str(text).unwrap_or_default(),
        other => serde_json::from_value(other.clone()).unwrap_or_default(),
    }
}

fn saved_params(reference: &MessageRef) -> Vec<(&'static str, String)> {
    vec![("item_type", "message".into()), ("item_id", reference.channel.clone()), ("ts", reference.ts.clone())]
}

impl Shared {
    pub(super) fn sync_preferences(&self) -> Result<()> {
        if !self.uses_slack_preferences() {
            return Ok(());
        }
        self.sync_saved_items()?;
        let result: Value = self.client.call("users.prefs.get", &[])?;
        self.apply_notification_preferences(result.pointer("/prefs/all_notifications_prefs").unwrap_or(&Value::Null));
        Ok(())
    }

    fn sync_saved_items(&self) -> Result<()> {
        let started_at = now_seconds();
        let items: Vec<RawSavedItem> =
            self.client.paginate("saved.list", "saved_items", &[("limit", SAVED_PAGE_SIZE.into())])?;
        let records: Vec<SavedItem> = items
            .into_iter()
            .filter(|item| item.item_type == "message" && item.state == "in_progress")
            .filter_map(|item| {
                Some(SavedItem {
                    reference: MessageRef::new(item.item_id, item.ts?),
                    state: SavedState::InProgress,
                    date_created: item.date_created,
                })
            })
            .collect();
        self.database().replace_in_progress_saved_items(&records, started_at)?;
        self.changed();
        Ok(())
    }

    pub(super) fn apply_notification_preferences(&self, value: &Value) {
        let preferences = parse_notification_preferences(value);
        let muted: HashSet<String> =
            preferences.channels.into_iter().filter(|(_, channel)| channel.muted).map(|(id, _)| id).collect();
        let _ = self.database().replace_muted(&muted);
        self.changed();
    }

    fn update_saved_item(&self, reference: &MessageRef, mark: &str) -> Result<()> {
        let mut params = saved_params(reference);
        params.push(("mark", mark.into()));
        self.client.call::<Value>("saved.update", &params)?;
        Ok(())
    }

    pub(super) fn save_for_later(&self, reference: &MessageRef) -> Result<bool> {
        let existing = self.database().saved_item(reference);
        if existing.as_ref().is_some_and(|item| item.state == SavedState::InProgress) {
            return Ok(false);
        }
        if self.uses_slack_preferences() {
            if existing.is_some() {
                self.update_saved_item(reference, "uncompleted")?;
            } else if self.client.call::<Value>("saved.add", &saved_params(reference)).is_err() {
                self.update_saved_item(reference, "uncompleted")?;
            }
        }
        self.database().set_saved_item(&SavedItem {
            reference: reference.clone(),
            state: SavedState::InProgress,
            date_created: existing.as_ref().map_or_else(now_seconds, |item| item.date_created),
        })?;
        self.changed();
        Ok(existing.is_none())
    }

    pub(super) fn set_saved_state(&self, reference: &MessageRef, state: SavedState) -> Result<()> {
        let existing = self.database().saved_item(reference);
        if self.uses_slack_preferences() {
            self.update_saved_item(reference, if state == SavedState::Completed { "completed" } else { "uncompleted" })?;
        }
        self.database().set_saved_item(&SavedItem {
            reference: reference.clone(),
            state,
            date_created: existing.map_or_else(now_seconds, |item| item.date_created),
        })?;
        self.changed();
        Ok(())
    }

    pub(super) fn remove_saved_item(&self, reference: &MessageRef) -> Result<()> {
        if self.uses_slack_preferences() {
            self.client.call::<Value>("saved.delete", &saved_params(reference))?;
        }
        self.database().delete_saved_item(reference)?;
        self.changed();
        Ok(())
    }

    pub(super) fn set_muted(&self, channel: &str, muted: bool) -> Result<()> {
        if self.uses_slack_preferences() {
            let result: Value = self.client.call(
                "users.prefs.setNotifications",
                &[
                    ("name", "muted".into()),
                    ("value", muted.to_string()),
                    ("global", "false".into()),
                    ("channel_id", channel.into()),
                ],
            )?;
            if let Some(preferences) = result.get("all_notifications_prefs") {
                self.apply_notification_preferences(preferences);
                return Ok(());
            }
        }
        self.database().set_muted(channel, muted)?;
        self.changed();
        Ok(())
    }

    pub(super) fn fetch_saved_message(&self, reference: &MessageRef) {
        if !self.pending_saved_messages.lock().unwrap().insert(reference.key()) {
            return;
        }
        match self.load_saved_message(reference) {
            Ok(()) => self.changed(),
            Err(error) => eprintln!("Could not load saved message {}: {error:#}", reference.key()),
        }
    }

    fn load_saved_message(&self, reference: &MessageRef) -> Result<()> {
        let channel = reference.channel.as_str();
        if !self.database().has_conversation(channel) {
            let info: ConversationInfo = self.client.call("conversations.info", &[("channel", channel.into())])?;
            self.database().upsert_conversation(&to_conversation(&info.channel), info.channel.is_member)?;
        }
        if self.database().message(channel, &reference.ts).is_some() {
            return Ok(());
        }
        let window = [
            ("channel", reference.channel.clone()),
            ("latest", reference.ts.clone()),
            ("oldest", reference.ts.clone()),
            ("inclusive", "true".to_string()),
            ("limit", "1".to_string()),
        ];
        for method in ["conversations.history", "conversations.replies"] {
            let mut params = window.to_vec();
            if method == "conversations.replies" {
                params.push(("ts", reference.ts.clone()));
            }
            let result: Messages = self.client.call(method, &params)?;
            if let Some(message) = result.messages.into_iter().find(|message| message.ts == reference.ts) {
                self.database().upsert_messages(channel, &[message])?;
                return Ok(());
            }
        }
        Ok(())
    }
}
