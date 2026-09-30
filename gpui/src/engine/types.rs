use std::collections::{HashMap, HashSet};

use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Session {
    pub user_id: String,
    pub handle: String,
    pub team_id: String,
    pub url: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct User {
    pub id: String,
    pub handle: String,
    pub display_name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub avatar: Option<String>,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ConversationKind {
    Channel,
    Private,
    Dm,
    Group,
}

impl ConversationKind {
    pub fn priority(self) -> u8 {
        match self {
            ConversationKind::Dm => 0,
            ConversationKind::Group => 1,
            ConversationKind::Private => 2,
            ConversationKind::Channel => 3,
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Conversation {
    pub id: String,
    pub name: String,
    pub kind: ConversationKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub user_id: Option<String>,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "lowercase")]
pub enum Label {
    Important,
    Other,
}

impl Label {
    pub fn as_str(self) -> &'static str {
        match self {
            Label::Important => "important",
            Label::Other => "other",
        }
    }

    pub fn parse(value: &str) -> Option<Label> {
        match value {
            "important" => Some(Label::Important),
            "other" => Some(Label::Other),
            _ => None,
        }
    }

    pub fn opposite(self) -> Label {
        match self {
            Label::Important => Label::Other,
            Label::Other => Label::Important,
        }
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ClassificationSource {
    Model,
    User,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct Classification {
    pub label: Label,
    pub reason: String,
    pub source: ClassificationSource,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
pub struct BotIcons {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub image_48: Option<String>,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
pub struct BotProfile {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub icons: Option<BotIcons>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct SlackFile {
    #[serde(default)]
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub permalink: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct Attachment {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fallback: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pretext: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title_link: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
pub struct Reaction {
    pub name: String,
    pub count: u32,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct Message {
    pub ts: String,
    #[serde(default)]
    pub text: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub user: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub username: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub subtype: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thread_ts: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reply_count: Option<u32>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub files: Vec<SlackFile>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub attachments: Vec<Attachment>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub reactions: Vec<Reaction>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bot_profile: Option<BotProfile>,
    #[serde(default, skip_serializing)]
    pub classification: Option<Classification>,
}

#[derive(Clone, Debug)]
pub struct ThreadContext {
    pub ts: String,
    pub root: Message,
}

#[derive(Clone, Debug)]
pub struct SavedInfo {
    pub ts: String,
    pub saved_at: i64,
}

#[derive(Clone, Debug)]
pub struct InboxItem {
    pub id: String,
    pub conversation: Conversation,
    pub messages: Vec<Message>,
    pub thread: Option<ThreadContext>,
    pub saved: Option<SavedInfo>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CredentialMode {
    Session,
    User,
    None,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RealtimeState {
    Connecting,
    Connected,
    Disconnected,
    Unavailable,
}

#[derive(Clone, Debug, Default)]
pub struct ClassifierStatus {
    pub enabled: bool,
    pub running: bool,
    pub pending: usize,
    pub error: Option<String>,
}

#[derive(Clone, Debug)]
pub struct SyncError {
    pub code: String,
    pub message: String,
    pub needed: Option<String>,
}

#[derive(Clone, Debug)]
pub struct SyncStatus {
    pub mode: CredentialMode,
    pub realtime: RealtimeState,
    pub classifier: ClassifierStatus,
    pub running: bool,
    pub done: usize,
    pub total: usize,
    pub last_completed_at: Option<i64>,
    pub error: Option<SyncError>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PreferenceSource {
    Slack,
    Local,
}

#[derive(Clone, Debug)]
pub struct Snapshot {
    pub session: Option<Session>,
    pub sync: SyncStatus,
    pub items: Vec<InboxItem>,
    pub later: Vec<InboxItem>,
    pub muted: HashSet<String>,
    pub preference_source: PreferenceSource,
    pub users: HashMap<String, User>,
}

#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub struct MessageRef {
    pub channel: String,
    pub ts: String,
}

impl MessageRef {
    pub fn new(channel: impl Into<String>, ts: impl Into<String>) -> Self {
        Self { channel: channel.into(), ts: ts.into() }
    }

    pub fn key(&self) -> String {
        format!("{}:{}", self.channel, self.ts)
    }
}
