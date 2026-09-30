use anyhow::Result;
use serde::Deserialize;
use serde_json::Value;

use crate::engine::Shared;
use crate::engine::database::ThreadRecord;
use crate::engine::types::Message;

const PAGE_SIZE: usize = 10;
const MAX_PAGES: usize = 5;

#[derive(Deserialize)]
struct RootMessage {
    #[serde(flatten)]
    message: Message,
    channel: String,
    last_read: Option<String>,
    latest_reply: Option<String>,
}

#[derive(Deserialize)]
struct RawThread {
    root_msg: RootMessage,
    #[serde(default)]
    unread_replies: Vec<Message>,
    #[serde(default)]
    latest_replies: Vec<Message>,
}

#[derive(Deserialize)]
struct ThreadView {
    #[serde(default)]
    threads: Vec<RawThread>,
    #[serde(default)]
    has_more: bool,
    #[serde(default)]
    total_unread_replies: usize,
}

impl Shared {
    pub(super) fn sync_threads(&self) -> Result<()> {
        let mut threads: Vec<RawThread> = Vec::new();
        let mut current_ts: Option<String> = None;
        let mut unread_seen = 0;
        let mut complete = false;
        for _ in 0..MAX_PAGES {
            let mut params = vec![("limit", PAGE_SIZE.to_string())];
            if let Some(current_ts) = &current_ts {
                params.push(("current_ts", current_ts.clone()));
            }
            let view: ThreadView = self.client.call("subscriptions.thread.getView", &params)?;
            unread_seen += view.threads.iter().map(|thread| thread.unread_replies.len()).sum::<usize>();
            let last = view.threads.last().map(|thread| {
                thread.root_msg.latest_reply.clone().unwrap_or_else(|| thread.root_msg.message.ts.clone())
            });
            let finished = !view.has_more || last.is_none() || unread_seen >= view.total_unread_replies;
            threads.extend(view.threads);
            if finished {
                complete = true;
                break;
            }
            current_ts = last;
        }

        let mut records = Vec::new();
        let mut messages = Vec::new();
        for thread in threads {
            let RawThread { root_msg, unread_replies, latest_replies } = thread;
            records.push(ThreadRecord {
                channel: root_msg.channel.clone(),
                thread_ts: root_msg.message.ts.clone(),
                last_read: root_msg.last_read.clone().unwrap_or_else(|| root_msg.message.ts.clone()),
            });
            messages.push((root_msg.channel.clone(), root_msg.message));
            for reply in unread_replies.into_iter().chain(latest_replies) {
                messages.push((root_msg.channel.clone(), reply));
            }
        }
        self.database().apply_thread_view(&records, &messages, complete)?;
        self.changed();
        Ok(())
    }

    pub(super) fn mark_thread_read(&self, channel: &str, thread_ts: &str, ts: &str) -> Result<()> {
        self.client.call::<Value>(
            "subscriptions.thread.mark",
            &[("channel", channel.into()), ("thread_ts", thread_ts.into()), ("ts", ts.into())],
        )?;
        self.database().set_thread_last_read(channel, thread_ts, ts)?;
        self.changed();
        Ok(())
    }

    pub(super) fn handle_thread_event(&self, kind: &str, event: &Value) -> bool {
        let subscription = event.get("subscription").filter(|value| value.is_object()).unwrap_or(event);
        let field = |name: &str| subscription.get(name).and_then(Value::as_str).map(String::from);
        let (Some(channel), Some(thread_ts)) = (field("channel"), field("thread_ts")) else { return false };
        let database = self.database();
        match kind {
            "thread_marked" => match field("last_read") {
                Some(last_read) => database.set_thread_last_read(&channel, &thread_ts, &last_read).is_ok(),
                None => false,
            },
            "thread_subscribed" => {
                let last_read = field("last_read").unwrap_or_else(|| thread_ts.clone());
                let stored = database.set_thread(&ThreadRecord { channel, thread_ts, last_read }).is_ok();
                drop(database);
                self.request_sync();
                stored
            }
            "thread_unsubscribed" => database.delete_thread(&channel, &thread_ts).is_ok(),
            _ => false,
        }
    }
}
