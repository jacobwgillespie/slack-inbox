use std::collections::HashMap;

use crate::engine::types::{Message, User};

struct Delimited {
    open: char,
    close: char,
    allows_whitespace: bool,
}

const ANGLE: Delimited = Delimited { open: '<', close: '>', allows_whitespace: true };
const EMOJI: Delimited = Delimited { open: ':', close: ':', allows_whitespace: false };

impl Delimited {
    fn replace(&self, text: &str, replacement: impl Fn(&str) -> Option<String>) -> String {
        let mut output = String::with_capacity(text.len());
        let mut rest = text;
        while let Some(start) = rest.find(self.open) {
            output.push_str(&rest[..start]);
            let after = &rest[start + self.open.len_utf8()..];
            let replaced = after
                .find(self.close)
                .filter(|end| self.allows_whitespace || !after[..*end].contains(char::is_whitespace))
                .and_then(|end| Some((replacement(&after[..end])?, end)));
            match replaced {
                Some((value, end)) => {
                    output.push_str(&value);
                    rest = &after[end + self.close.len_utf8()..];
                }
                None => {
                    output.push(self.open);
                    rest = after;
                }
            }
        }
        output.push_str(rest);
        output
    }
}

fn angle_label(body: &str, users: &HashMap<String, User>) -> String {
    let (target, label) = body.split_once('|').map_or((body, None), |(target, label)| (target, Some(label)));
    if let Some(id) = target.strip_prefix('@') {
        return format!("@{}", users.get(id).map_or(label.unwrap_or(id), |user| user.display_name.as_str()));
    }
    if let Some(id) = target.strip_prefix('#') {
        return format!("#{}", label.unwrap_or(id));
    }
    if target.starts_with("!subteam") || target.starts_with("!date") {
        return label.unwrap_or_default().to_string();
    }
    if let Some(keyword) = target.strip_prefix('!') {
        return format!("@{keyword}");
    }
    match label {
        Some(label) if target.starts_with("http") => format!("{label} ({target})"),
        Some(label) => label.to_string(),
        None => target.to_string(),
    }
}

fn emoji(name: &str) -> Option<String> {
    let base = name.split("::").next().unwrap_or(name);
    emojis::get_by_shortcode(base).map(|emoji| emoji.as_str().to_string())
}

pub fn readable(text: &str, users: &HashMap<String, User>) -> String {
    let resolved = ANGLE.replace(text, |body| Some(angle_label(body, users)));
    EMOJI.replace(&resolved, emoji).replace("&lt;", "<").replace("&gt;", ">").replace("&amp;", "&")
}

pub fn message_text(message: &Message, users: &HashMap<String, User>) -> String {
    let mut parts = vec![readable(&message.text, users)];
    for attachment in &message.attachments {
        let text = [attachment.pretext.as_deref(), attachment.title.as_deref(), attachment.text.as_deref().or(attachment.fallback.as_deref())]
            .into_iter()
            .flatten()
            .collect::<Vec<_>>()
            .join(" · ");
        parts.push(readable(&text, users));
    }
    for file in &message.files {
        parts.push(format!("📎 {}", file.title.as_deref().or(file.name.as_deref()).unwrap_or("File")));
    }
    parts.retain(|part| !part.trim().is_empty());
    parts.join("\n")
}

pub fn mentioned_user_ids(text: &str) -> Vec<String> {
    text.match_indices("<@")
        .filter_map(|(index, _)| {
            let id: String = text[index + 2..].chars().take_while(|character| character.is_ascii_alphanumeric()).collect();
            (!id.is_empty()).then_some(id)
        })
        .collect()
}

pub fn mentions_everyone(text: &str) -> bool {
    ["<!here", "<!channel", "<!everyone"].iter().any(|keyword| text.contains(keyword))
}
