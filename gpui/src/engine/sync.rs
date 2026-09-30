use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use std::thread;
use std::time::Duration;

use anyhow::Result;
use serde::Deserialize;
use serde_json::Value;

use crate::engine::database::{StoredConversation, now_seconds};
use crate::engine::slack_client::SlackError;
use crate::engine::slack_data::{RawConversation, RawCount, RawUser, to_conversation, to_user};
use crate::engine::types::{
    CredentialMode, InboxItem, Message, PreferenceSource, RealtimeState, Session, Snapshot, SyncError, User,
};
use crate::engine::{Shared, parallel_each, text};

const SESSION_SYNC_INTERVAL: Duration = Duration::from_secs(30);
const REALTIME_SYNC_INTERVAL: Duration = Duration::from_secs(5 * 60);
const USER_SYNC_INTERVAL: Duration = Duration::from_secs(60);
const DIRECTORY_MAX_AGE_MILLIS: i64 = 60 * 60 * 1000;
const HISTORY_LIMIT: usize = 100;
pub const INBOX_MESSAGE_LIMIT: usize = 100;
const WORKERS: usize = 4;
const READ_MARKER_EVENTS: [&str; 4] = ["channel_marked", "group_marked", "im_marked", "mpim_marked"];
const MEMBERSHIP_EVENTS: [&str; 10] = [
    "channel_joined",
    "channel_left",
    "channel_rename",
    "group_joined",
    "group_left",
    "group_rename",
    "im_created",
    "im_close",
    "mpim_joined",
    "mpim_close",
];

#[derive(Clone, Copy)]
enum Directory {
    Conversations,
    Users,
    Emoji,
}

impl Directory {
    fn key(self) -> &'static str {
        match self {
            Directory::Conversations => "conversations_synced_at",
            Directory::Users => "users_synced_at",
            Directory::Emoji => "emoji_synced_at",
        }
    }
}

#[derive(Deserialize)]
struct AuthTest {
    user_id: String,
    user: String,
    team_id: String,
    url: String,
}

#[derive(Deserialize)]
struct Counts {
    #[serde(default)]
    channels: Vec<RawCount>,
    #[serde(default)]
    mpims: Vec<RawCount>,
    #[serde(default)]
    ims: Vec<RawCount>,
}

#[derive(Deserialize)]
struct History {
    messages: Vec<Message>,
    #[serde(default)]
    has_more: bool,
}

#[derive(Deserialize)]
struct ConversationInfo {
    channel: RawConversation,
}

fn now_millis() -> i64 {
    now_seconds() * 1000
}

fn describe_error(error: &anyhow::Error) -> SyncError {
    match error.downcast_ref::<SlackError>() {
        Some(slack) => SyncError { code: slack.code.clone(), message: slack.to_string(), needed: slack.needed.clone() },
        None => SyncError { code: "internal_error".into(), message: error.to_string(), needed: None },
    }
}

pub fn run_loop(shared: &Shared) {
    while !shared.is_stopped() {
        shared.run_sync();
        let interval = shared.sync_interval();
        shared.sync_signal.wait(Some(interval), &shared.stopped);
    }
}

impl Shared {
    fn sync_interval(&self) -> Duration {
        let status = self.status.lock().unwrap();
        if status.realtime == RealtimeState::Connected {
            REALTIME_SYNC_INTERVAL
        } else if status.mode == CredentialMode::Session {
            SESSION_SYNC_INTERVAL
        } else {
            USER_SYNC_INTERVAL
        }
    }

    fn run_sync(&self) {
        self.update_status(|status| {
            status.running = true;
            status.done = 0;
            status.total = 0;
            status.error = None;
        });
        let result = self.sync_once();
        self.update_status(|status| {
            status.running = false;
            match &result {
                Ok(()) => status.last_completed_at = Some(now_millis()),
                Err(error) => status.error = Some(describe_error(error)),
            }
        });
        match result {
            Ok(()) => self.schedule_classifier(Duration::ZERO),
            Err(error) => eprintln!("Slack sync failed: {error:#}"),
        }
    }

    fn sync_once(&self) -> Result<()> {
        self.ensure_session()?;
        self.refresh_directory(Directory::Conversations, false)?;
        if self.mode() == CredentialMode::Session {
            self.sync_with_counts()?;
            if let Err(error) = self.sync_threads() {
                eprintln!("Could not sync threads: {error:#}");
            }
        } else {
            self.sync_with_conversation_info()?;
        }
        if let Err(error) = self.sync_preferences() {
            eprintln!("Could not sync Later and mute settings: {error:#}");
        }
        self.refresh_directory(Directory::Users, false)?;
        let _ = self.refresh_directory(Directory::Emoji, false);
        Ok(())
    }

    fn ensure_session(&self) -> Result<()> {
        if self.mode() == CredentialMode::None {
            return Err(SlackError::new("auth.test", "not_authed").into());
        }
        if self.session_verified.load(std::sync::atomic::Ordering::SeqCst) {
            return Ok(());
        }
        let result: AuthTest = self.client.call("auth.test", &[])?;
        let session = Session { user_id: result.user_id, handle: result.user, team_id: result.team_id, url: result.url };
        let previous = self.session();
        let database = self.database();
        if previous.is_some_and(|previous| previous.user_id != session.user_id || previous.team_id != session.team_id) {
            database.clear_workspace()?;
        }
        database.set_metadata("session", &session)?;
        drop(database);
        *self.session.lock().unwrap() = Some(session);
        self.session_verified.store(true, std::sync::atomic::Ordering::SeqCst);
        Ok(())
    }

    fn is_stale(&self, directory: Directory) -> bool {
        let synced_at = self.database().metadata::<i64>(directory.key()).unwrap_or(0);
        now_millis() - synced_at > DIRECTORY_MAX_AGE_MILLIS
    }

    pub(super) fn invalidate_directory(&self, directory_key: &str) {
        let _ = self.database().set_metadata(directory_key, &0);
        self.request_sync();
    }

    fn refresh_directory(&self, directory: Directory, force: bool) -> Result<()> {
        if !force && !self.is_stale(directory) {
            return Ok(());
        }
        match directory {
            Directory::Conversations => {
                let raw: Vec<RawConversation> = self.client.paginate(
                    "users.conversations",
                    "channels",
                    &[
                        ("types", "public_channel,private_channel,mpim,im".into()),
                        ("exclude_archived", "true".into()),
                        ("limit", "200".into()),
                    ],
                )?;
                let conversations: Vec<_> =
                    raw.iter().filter(|entry| !entry.is_user_deleted).map(to_conversation).collect();
                self.database().replace_conversations(&conversations)?;
            }
            Directory::Users => {
                let members: Vec<RawUser> = self.client.paginate("users.list", "members", &[("limit", "1000".into())])?;
                let users: Vec<User> = members.iter().map(to_user).collect();
                self.database().replace_users(&users)?;
            }
            Directory::Emoji => {
                let result: Value = self.client.call("emoji.list", &[])?;
                let emoji: HashMap<String, String> =
                    serde_json::from_value(result.get("emoji").cloned().unwrap_or(Value::Null)).unwrap_or_default();
                self.database().replace_emoji(&emoji)?;
            }
        }
        self.database().set_metadata(directory.key(), &now_millis())?;
        self.changed();
        Ok(())
    }

    fn known_conversations(&self) -> Result<HashMap<String, StoredConversation>> {
        Ok(self
            .database()
            .conversations()?
            .into_iter()
            .map(|stored| (stored.conversation.id.clone(), stored))
            .collect())
    }

    fn sync_with_counts(&self) -> Result<()> {
        let result: Counts = self.client.call("client.counts", &[])?;
        let counts: Vec<RawCount> = result.channels.into_iter().chain(result.mpims).chain(result.ims).collect();
        let mut known = self.known_conversations()?;
        if counts.iter().any(|count| count.has_unreads() && !known.contains_key(&count.id)) {
            self.refresh_directory(Directory::Conversations, true)?;
            known = self.known_conversations()?;
        }

        let tracked: Vec<&RawCount> = counts.iter().filter(|count| known.contains_key(&count.id)).collect();
        let states: Vec<(String, String)> = tracked.iter().map(|count| (count.id.clone(), count.last_read())).collect();
        self.database().set_read_states(&states)?;
        self.changed();

        let outdated: Vec<&RawCount> = tracked
            .into_iter()
            .filter(|count| {
                count.has_unreads()
                    && (count.latest.is_none()
                        || count.latest.as_deref() != known.get(&count.id).and_then(|stored| stored.history_latest.as_deref()))
            })
            .collect();
        self.update_status(|status| status.total = outdated.len());
        parallel_each(outdated, WORKERS, |count| {
            if self.is_stopped() {
                return;
            }
            if let Err(error) = self.fetch_unread_window(&count.id, &count.last_read(), count.latest.as_deref()) {
                eprintln!("Could not sync {}: {error:#}", count.id);
            }
            self.update_status(|status| status.done += 1);
        });
        Ok(())
    }

    fn sync_with_conversation_info(&self) -> Result<()> {
        let mut conversations: Vec<StoredConversation> = self.database().conversations()?;
        let unread_first = |stored: &StoredConversation| match (&stored.newest_ts, &stored.last_read) {
            (Some(newest), Some(last_read)) if newest > last_read => 0,
            _ => 1,
        };
        conversations.sort_by(|a, b| {
            a.conversation
                .kind
                .priority()
                .cmp(&b.conversation.kind.priority())
                .then(unread_first(a).cmp(&unread_first(b)))
                .then(b.newest_ts.cmp(&a.newest_ts))
        });
        self.update_status(|status| status.total = conversations.len());
        parallel_each(conversations, WORKERS, |stored| {
            if self.is_stopped() {
                return;
            }
            let channel = stored.conversation.id.as_str();
            let result = self
                .client
                .call::<ConversationInfo>("conversations.info", &[("channel", channel.into())])
                .map_err(anyhow::Error::from)
                .and_then(|info| {
                    let last_read = info.channel.last_read.unwrap_or_else(|| "0".into());
                    self.database().set_read_states(&[(channel.to_string(), last_read.clone())])?;
                    self.fetch_unread_window(channel, &last_read, None)
                });
            if let Err(error) = result {
                eprintln!("Could not sync {}: {error:#}", stored.conversation.name);
            }
            self.update_status(|status| status.done += 1);
        });
        Ok(())
    }

    fn fetch_unread_window(&self, channel: &str, last_read: &str, latest: Option<&str>) -> Result<()> {
        let history: History = self.client.call(
            "conversations.history",
            &[("channel", channel.into()), ("oldest", last_read.into()), ("limit", HISTORY_LIMIT.to_string())],
        )?;
        self.database().replace_history_window(channel, last_read, &history.messages, !history.has_more, latest)?;
        self.changed();
        Ok(())
    }

    fn request_missing_users(&self, ids: Vec<String>) {
        if ids.is_empty() || self.database().metadata::<i64>(Directory::Users.key()).is_none() {
            return;
        }
        let mut requested = self.requested_users.lock().unwrap();
        let new: Vec<String> = ids.into_iter().filter(|id| requested.insert(id.clone())).collect();
        drop(requested);
        if new.is_empty() {
            return;
        }
        let client = &self.client;
        let fetched: Vec<User> = new
            .iter()
            .filter_map(|id| client.call::<Value>("users.info", &[("user", id.clone())]).ok())
            .filter_map(|result| serde_json::from_value::<RawUser>(result.get("user")?.clone()).ok())
            .map(|raw| to_user(&raw))
            .collect();
        for user in &fetched {
            let _ = self.database().upsert_user(user);
        }
        if !fetched.is_empty() {
            self.changed();
        }
    }

    pub(super) fn snapshot(self: &Arc<Self>) -> Result<Snapshot> {
        let session = self.session();
        let database = self.database();
        let mut items = Vec::new();
        if let Some(session) = &session {
            let inbox = database.inbox(&session.user_id, INBOX_MESSAGE_LIMIT)?;
            let conversation_ids: Vec<String> = inbox.iter().map(|item| item.conversation.id.clone()).collect();
            let classifications = database.classifications(&conversation_ids)?;
            for mut item in inbox {
                for message in &mut item.messages {
                    message.classification = classifications.get(&format!("{}:{}", item.conversation.id, message.ts)).cloned();
                }
                items.push(item);
            }
            if self.mode() == CredentialMode::Session {
                items.extend(database.thread_inbox(&session.user_id)?);
            }
        }
        let later = database.later()?;
        let muted = database.muted_conversation_ids()?;
        let ids = referenced_user_ids(items.iter().chain(later.items.iter()));
        let users = database.users_by_id(&ids)?;
        drop(database);

        let missing_users: Vec<String> = ids.into_iter().filter(|id| !users.contains_key(id)).collect();
        let missing_messages = later.missing;
        if !missing_users.is_empty() || !missing_messages.is_empty() {
            let worker = Arc::clone(self);
            thread::spawn(move || {
                worker.request_missing_users(missing_users);
                for reference in missing_messages {
                    worker.fetch_saved_message(&reference);
                }
            });
        }

        let preference_source =
            if self.uses_slack_preferences() { PreferenceSource::Slack } else { PreferenceSource::Local };
        let sync = self.status.lock().unwrap().clone();
        Ok(Snapshot { session, sync, items, later: later.items, muted, preference_source, users })
    }

    pub(super) fn mark_read(&self, channel: &str, ts: &str) -> Result<()> {
        self.client.call::<Value>("conversations.mark", &[("channel", channel.into()), ("ts", ts.into())])?;
        self.database().set_read_states(&[(channel.to_string(), ts.to_string())])?;
        self.changed();
        Ok(())
    }

    pub(super) fn post_message(&self, channel: &str, text: &str, thread_ts: Option<&str>) -> Result<()> {
        let mut params = vec![("channel", channel.to_string()), ("text", text.to_string())];
        if let Some(thread_ts) = thread_ts {
            params.push(("thread_ts", thread_ts.to_string()));
        }
        let result: Value = self.client.call("chat.postMessage", &params)?;
        if let Some(message) = result.get("message").and_then(|message| serde_json::from_value::<Message>(message.clone()).ok()) {
            self.database().upsert_messages(channel, &[message])?;
        }
        self.changed();
        Ok(())
    }

    pub(super) fn thread_replies(&self, channel: &str, ts: &str) -> Result<(Vec<Message>, HashMap<String, User>)> {
        let messages: Vec<Message> = self.client.paginate(
            "conversations.replies",
            "messages",
            &[("channel", channel.into()), ("ts", ts.into()), ("limit", "200".into())],
        )?;
        self.database().upsert_messages(channel, &messages)?;
        let replies: Vec<Message> = messages.into_iter().filter(|message| message.ts != ts).collect();
        let ids: Vec<String> = replies.iter().flat_map(message_user_ids).collect::<HashSet<_>>().into_iter().collect();
        let users = self.database().users_by_id(&ids)?;
        Ok((replies, users))
    }

    pub(super) fn handle_realtime_event(&self, event: &Value) {
        let kind = event.get("type").and_then(Value::as_str).unwrap_or_default();
        let channel = event.get("channel").and_then(Value::as_str);
        let handled = match (kind, channel) {
            ("message", Some(channel)) => {
                self.handle_message_event(channel, event);
                true
            }
            (kind, Some(channel)) if READ_MARKER_EVENTS.contains(&kind) => match event.get("ts").and_then(Value::as_str) {
                Some(ts) => self.database().set_read_states(&[(channel.to_string(), ts.to_string())]).is_ok(),
                None => false,
            },
            ("reaction_added" | "reaction_removed", _) => {
                self.handle_reaction_event(kind == "reaction_added", event);
                true
            }
            ("user_change", _) => match event.get("user").and_then(|user| serde_json::from_value::<RawUser>(user.clone()).ok()) {
                Some(raw) => self.database().upsert_user(&to_user(&raw)).is_ok(),
                None => false,
            },
            (kind, _) if MEMBERSHIP_EVENTS.contains(&kind) => {
                self.invalidate_directory(Directory::Conversations.key());
                true
            }
            ("emoji_changed", _) => {
                self.invalidate_directory(Directory::Emoji.key());
                true
            }
            ("pref_change", _) if event.get("name").and_then(Value::as_str) == Some("all_notifications_prefs") => {
                if let Some(value) = event.get("value") {
                    self.apply_notification_preferences(value);
                }
                false
            }
            (kind, _) if kind.starts_with("thread_") => self.handle_thread_event(kind, event),
            _ => false,
        };
        if handled {
            self.changed();
        }
    }

    fn handle_message_event(&self, channel: &str, event: &Value) {
        if !self.database().has_member_conversation(channel) {
            self.invalidate_directory(Directory::Conversations.key());
            return;
        }
        match event.get("subtype").and_then(Value::as_str) {
            Some("message_deleted") => {
                if let Some(ts) = event.get("deleted_ts").and_then(Value::as_str) {
                    let _ = self.database().delete_message(channel, ts);
                }
            }
            Some("message_changed" | "message_replied") => {
                if let Some(message) = event.get("message").and_then(|message| serde_json::from_value::<Message>(message.clone()).ok()) {
                    let _ = self.database().upsert_messages(channel, &[message]);
                }
            }
            _ => {
                if let Ok(message) = serde_json::from_value::<Message>(event.clone()) {
                    let _ = self.database().upsert_messages(channel, &[message]);
                    self.schedule_classifier(Duration::from_secs(3));
                }
            }
        }
    }

    fn handle_reaction_event(&self, added: bool, event: &Value) {
        let channel = event.pointer("/item/channel").and_then(Value::as_str);
        let ts = event.pointer("/item/ts").and_then(Value::as_str);
        let name = event.get("reaction").and_then(Value::as_str);
        let (Some(channel), Some(ts), Some(name)) = (channel, ts, name) else { return };
        let database = self.database();
        let Some(mut message) = database.message(channel, ts) else { return };
        match message.reactions.iter_mut().find(|reaction| reaction.name == name) {
            Some(reaction) if added => reaction.count += 1,
            Some(reaction) => reaction.count = reaction.count.saturating_sub(1),
            None if added => message.reactions.push(crate::engine::types::Reaction { name: name.into(), count: 1 }),
            None => {}
        }
        message.reactions.retain(|reaction| reaction.count > 0);
        let _ = database.upsert_messages(channel, &[message]);
    }
}

fn message_user_ids(message: &Message) -> Vec<String> {
    let mut ids: Vec<String> = message.user.iter().cloned().collect();
    ids.extend(text::mentioned_user_ids(&message.text));
    ids
}

fn referenced_user_ids<'a>(items: impl Iterator<Item = &'a InboxItem>) -> Vec<String> {
    let mut ids = HashSet::new();
    for item in items {
        ids.extend(item.conversation.user_id.clone());
        if let Some(thread) = &item.thread {
            ids.extend(message_user_ids(&thread.root));
        }
        for message in &item.messages {
            ids.extend(message_user_ids(message));
        }
    }
    ids.into_iter().collect()
}
