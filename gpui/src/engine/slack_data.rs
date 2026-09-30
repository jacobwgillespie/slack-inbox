use serde::Deserialize;

use crate::engine::timestamps;
use crate::engine::types::{Conversation, ConversationKind, User};

#[derive(Clone, Debug, Deserialize)]
pub struct RawConversation {
    pub id: String,
    pub name: Option<String>,
    pub user: Option<String>,
    #[serde(default)]
    pub is_im: bool,
    #[serde(default)]
    pub is_mpim: bool,
    #[serde(default)]
    pub is_private: bool,
    #[serde(default)]
    pub is_user_deleted: bool,
    #[serde(default)]
    pub is_member: bool,
    pub last_read: Option<String>,
}

#[derive(Clone, Debug, Default, Deserialize)]
pub struct RawProfile {
    pub display_name: Option<String>,
    pub real_name: Option<String>,
    pub image_48: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
pub struct RawUser {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub profile: RawProfile,
}

#[derive(Clone, Debug, Deserialize)]
pub struct RawCount {
    pub id: String,
    pub last_read: Option<String>,
    pub latest: Option<String>,
    #[serde(default)]
    pub has_unreads: bool,
}

impl RawCount {
    pub fn last_read(&self) -> String {
        self.last_read.clone().unwrap_or_else(|| "0".into())
    }

    pub fn has_unreads(&self) -> bool {
        self.has_unreads || timestamps::is_after(self.latest.as_deref().unwrap_or("0"), self.last_read.as_deref().unwrap_or("0"))
    }
}

fn non_empty(value: &Option<String>) -> Option<String> {
    value.clone().filter(|value| !value.is_empty())
}

pub fn to_conversation(raw: &RawConversation) -> Conversation {
    if raw.is_im {
        return Conversation {
            id: raw.id.clone(),
            name: raw.user.clone().unwrap_or_else(|| raw.id.clone()),
            kind: ConversationKind::Dm,
            user_id: raw.user.clone(),
        };
    }
    let name = raw.name.clone().unwrap_or_else(|| raw.id.clone());
    if raw.is_mpim {
        let without_prefix = name.trim_start_matches("mpdm-");
        let handles = match without_prefix.rsplit_once('-') {
            Some((base, suffix)) if suffix.chars().all(|character| character.is_ascii_digit()) => base,
            _ => without_prefix,
        };
        return Conversation {
            id: raw.id.clone(),
            name: handles.split("--").collect::<Vec<_>>().join(", "),
            kind: ConversationKind::Group,
            user_id: None,
        };
    }
    Conversation {
        id: raw.id.clone(),
        name,
        kind: if raw.is_private { ConversationKind::Private } else { ConversationKind::Channel },
        user_id: None,
    }
}

pub fn to_user(raw: &RawUser) -> User {
    User {
        id: raw.id.clone(),
        handle: raw.name.clone(),
        display_name: non_empty(&raw.profile.display_name)
            .or_else(|| non_empty(&raw.profile.real_name))
            .unwrap_or_else(|| raw.name.clone()),
        avatar: raw.profile.image_48.clone(),
    }
}
