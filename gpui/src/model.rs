use std::collections::HashMap;
use std::time::{Duration, Instant};

use slack_inbox_gpui::engine::timestamps;
use slack_inbox_gpui::engine::types::{ConversationKind, InboxItem, Label, Message, Session, Snapshot, User};

const OVERRIDE_LIFETIME: Duration = Duration::from_secs(120);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum View {
    Important,
    Other,
    Later,
    Muted,
}

impl View {
    pub const ALL: [View; 4] = [View::Important, View::Other, View::Later, View::Muted];

    pub fn title(self) -> &'static str {
        match self {
            View::Important => "Important",
            View::Other => "Other",
            View::Later => "Later",
            View::Muted => "Muted",
        }
    }

    pub fn index(self) -> usize {
        View::ALL.iter().position(|view| *view == self).unwrap_or(0)
    }
}

pub fn latest_ts(item: &InboxItem) -> &str {
    item.messages.last().map_or("0", |message| message.ts.as_str())
}

pub fn message_key(item: &InboxItem, message: &Message) -> String {
    format!("{}:{}", item.conversation.id, message.ts)
}

struct Override<T> {
    value: T,
    expires_at: Instant,
}

impl<T> Override<T> {
    fn new(value: T) -> Self {
        Self { value, expires_at: Instant::now() + OVERRIDE_LIFETIME }
    }

    fn active(&self) -> bool {
        self.expires_at > Instant::now()
    }
}

#[derive(Default)]
pub struct Inbox {
    snapshot: Option<Snapshot>,
    users: HashMap<String, User>,
    read_cursors: HashMap<String, Override<Option<String>>>,
    later_overrides: HashMap<String, Override<Option<InboxItem>>>,
    mute_overrides: HashMap<String, Override<bool>>,
    label_overrides: HashMap<String, Override<Option<Label>>>,
}

impl Inbox {
    pub fn apply(&mut self, snapshot: Snapshot) {
        self.users.extend(snapshot.users.iter().map(|(id, user)| (id.clone(), user.clone())));
        self.snapshot = Some(snapshot);
        self.read_cursors.retain(|_, entry| entry.active());
        self.later_overrides.retain(|_, entry| entry.active());
        self.mute_overrides.retain(|_, entry| entry.active());
        self.label_overrides.retain(|_, entry| entry.active());
    }

    pub fn snapshot(&self) -> Option<&Snapshot> {
        self.snapshot.as_ref()
    }

    pub fn session(&self) -> Option<&Session> {
        self.snapshot.as_ref().and_then(|snapshot| snapshot.session.as_ref())
    }

    pub fn users(&self) -> &HashMap<String, User> {
        &self.users
    }

    pub fn merge_users(&mut self, users: HashMap<String, User>) {
        self.users.extend(users);
    }

    pub fn is_muted(&self, channel: &str) -> bool {
        match self.mute_overrides.get(channel) {
            Some(entry) => entry.value,
            None => self.snapshot.as_ref().is_some_and(|snapshot| snapshot.muted.contains(channel)),
        }
    }

    pub fn message_label(&self, item: &InboxItem, message: &Message) -> Option<Label> {
        match self.label_overrides.get(&message_key(item, message)) {
            Some(entry) => entry.value,
            None => message.classification.as_ref().map(|classification| classification.label),
        }
    }

    pub fn mentions_self(&self, item: &InboxItem) -> bool {
        let Some(session) = self.session() else { return false };
        let mention = format!("<@{}", session.user_id);
        item.messages.iter().any(|message| message.text.contains(&mention))
    }

    fn is_message_important(&self, item: &InboxItem, message: &Message) -> bool {
        if let Some(label) = self.message_label(item, message) {
            return label == Label::Important;
        }
        if matches!(item.conversation.kind, ConversationKind::Dm | ConversationKind::Group) {
            return true;
        }
        self.session().is_some_and(|session| message.text.contains(&format!("<@{}", session.user_id)))
    }

    fn is_important(&self, item: &InboxItem) -> bool {
        item.thread.is_some() || item.messages.iter().any(|message| self.is_message_important(item, message))
    }

    fn unread(&self, item: &InboxItem) -> Option<InboxItem> {
        let cursor = self.read_cursors.get(&item.id).and_then(|entry| entry.value.clone());
        let messages: Vec<Message> = item
            .messages
            .iter()
            .filter(|message| cursor.as_deref().is_none_or(|cursor| timestamps::is_after(&message.ts, cursor)))
            .cloned()
            .collect();
        (!messages.is_empty()).then(|| InboxItem { messages, ..item.clone() })
    }

    fn later_items(&self) -> Vec<InboxItem> {
        let Some(snapshot) = &self.snapshot else { return Vec::new() };
        let mut later: HashMap<String, InboxItem> =
            snapshot.later.iter().map(|item| (item.id.clone(), item.clone())).collect();
        for (id, entry) in &self.later_overrides {
            match &entry.value {
                Some(item) => {
                    later.entry(id.clone()).or_insert_with(|| item.clone());
                }
                None => {
                    later.remove(id);
                }
            }
        }
        let mut later: Vec<InboxItem> = later.into_values().collect();
        later.sort_by_key(|item| std::cmp::Reverse(item.saved.as_ref().map_or(0, |saved| saved.saved_at)));
        later
    }

    pub fn visible(&self, view: View) -> Vec<InboxItem> {
        if view == View::Later {
            return self.later_items();
        }
        let Some(snapshot) = &self.snapshot else { return Vec::new() };
        let mut items: Vec<InboxItem> = snapshot
            .items
            .iter()
            .filter_map(|item| self.unread(item))
            .filter(|item| {
                let muted = item.thread.is_none() && self.is_muted(&item.conversation.id);
                match view {
                    View::Muted => muted,
                    View::Important => !muted && self.is_important(item),
                    View::Other => !muted && !self.is_important(item),
                    View::Later => false,
                }
            })
            .collect();
        items.sort_by(|a, b| timestamps::compare(latest_ts(b), latest_ts(a)));
        items
    }

    pub fn counts(&self) -> [usize; 4] {
        View::ALL.map(|view| self.visible(view).len())
    }

    pub fn set_read_cursor(&mut self, item_id: &str, cursor: Option<String>) {
        self.read_cursors.insert(item_id.to_string(), Override::new(cursor));
    }

    pub fn set_later(&mut self, id: &str, item: Option<InboxItem>) {
        self.later_overrides.insert(id.to_string(), Override::new(item));
    }

    pub fn set_muted(&mut self, channel: &str, muted: bool) {
        self.mute_overrides.insert(channel.to_string(), Override::new(muted));
    }

    pub fn set_label(&mut self, key: String, label: Option<Label>) {
        self.label_overrides.insert(key, Override::new(label));
    }
}
