use std::collections::HashMap;

use chrono::{DateTime, Local, TimeZone};
use slack_inbox_gpui::engine::text;
use slack_inbox_gpui::engine::timestamps;
use slack_inbox_gpui::engine::types::{Conversation, ConversationKind, InboxItem, Message, Session, User};

pub fn summary(message: &Message, users: &HashMap<String, User>) -> String {
    text::message_text(message, users).split_whitespace().collect::<Vec<_>>().join(" ")
}

pub fn author_name(message: &Message, users: &HashMap<String, User>) -> String {
    message
        .user
        .as_ref()
        .and_then(|id| users.get(id))
        .map(|user| user.display_name.clone())
        .or_else(|| message.bot_profile.as_ref().and_then(|bot| bot.name.clone()))
        .or_else(|| message.username.clone())
        .unwrap_or_else(|| "Unknown".to_string())
}

pub fn conversation_label(conversation: &Conversation, users: &HashMap<String, User>, session: Option<&Session>) -> String {
    match conversation.kind {
        ConversationKind::Dm => conversation
            .user_id
            .as_ref()
            .and_then(|id| users.get(id))
            .map_or_else(|| conversation.name.clone(), |user| user.display_name.clone()),
        ConversationKind::Group => conversation
            .name
            .split(", ")
            .filter(|handle| Some(*handle) != session.map(|session| session.handle.as_str()))
            .collect::<Vec<_>>()
            .join(", "),
        ConversationKind::Channel | ConversationKind::Private => format!("#{}", conversation.name),
    }
}

pub fn kind_label(item: &InboxItem) -> &'static str {
    if item.thread.is_some() {
        return "Thread";
    }
    match item.conversation.kind {
        ConversationKind::Dm => "Direct message",
        ConversationKind::Group => "Group message",
        ConversationKind::Private => "Private channel",
        ConversationKind::Channel => "Channel",
    }
}

fn local_time(ts: &str) -> Option<DateTime<Local>> {
    Local.timestamp_opt(timestamps::seconds(ts), 0).single()
}

pub fn list_time(ts: &str) -> String {
    let Some(time) = local_time(ts) else { return String::new() };
    let now = Local::now();
    if time.date_naive() == now.date_naive() {
        time.format("%-I:%M %p").to_string()
    } else if now.signed_duration_since(time).num_days() < 6 {
        time.format("%a").to_string()
    } else {
        time.format("%b %-d").to_string()
    }
}

pub fn message_time(ts: &str) -> String {
    let Some(time) = local_time(ts) else { return String::new() };
    if time.date_naive() == Local::now().date_naive() {
        time.format("%-I:%M %p").to_string()
    } else {
        time.format("%b %-d, %-I:%M %p").to_string()
    }
}

pub fn permalink(session: &Session, channel: &str, ts: &str) -> String {
    format!("{}/archives/{}/p{}", session.url.trim_end_matches('/'), channel, ts.replace('.', ""))
}

pub fn pluralize(count: usize, noun: &str) -> String {
    if count == 1 { format!("1 {noun}") } else { format!("{count} {noun}s") }
}
