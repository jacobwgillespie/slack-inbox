use std::collections::{HashMap, HashSet};
use std::sync::mpsc;
use std::time::Duration;

use anyhow::Result;
use gpui_kit::assets::IconName;
use gpui_kit::component::button::{Button, ButtonVariants};
use gpui_kit::component::input::{InputEvent, Textarea, TextareaState};
use gpui_kit::component::tab::{Tab, TabBar};
use gpui_kit::component::tag::Tag;
use gpui_kit::component::{ActiveTheme, Sizable, StyledExt, h_flex, v_flex};
use gpui_kit::prelude::*;
use gpui_kit::*;
use slack_inbox_gpui::engine::config::Config;
use slack_inbox_gpui::engine::text;
use slack_inbox_gpui::engine::timestamps;
use slack_inbox_gpui::engine::types::{
    Classification, ClassificationSource, InboxItem, Label, Message, MessageRef, RealtimeState, SavedInfo,
};
use slack_inbox_gpui::engine::Engine;

use crate::format::{self, pluralize};
use crate::model::{Inbox, View, latest_ts, message_key};

const TOAST_DURATION: Duration = Duration::from_secs(6);
const SNAPSHOT_DEBOUNCE: Duration = Duration::from_millis(150);
const LIST_WIDTH: f32 = 400.;

actions!(
    inbox,
    [
        Next,
        Previous,
        Open,
        Back,
        Done,
        Later,
        Mute,
        Recategorize,
        Check,
        Reply,
        ReplyInThread,
        OpenInSlack,
        Undo,
        Refresh,
        NextView,
        PreviousView,
        ShowImportant,
        ShowOther,
        ShowLater,
        ShowMuted,
        ToggleHelp,
        Quit,
    ]
);

const SHORTCUTS: [(&str, &str); 17] = [
    ("J / K", "Next or previous conversation, or message while reading"),
    ("Enter / O", "Read conversation, or show thread replies while reading"),
    ("Esc", "Return to list, clear selection, or leave the reply box"),
    ("Tab / Shift-Tab", "Next or previous view"),
    ("1 – 4", "Important, Other, Later, Muted"),
    ("E", "Mark as read (in Later: mark complete)"),
    ("L", "Save the newest message for later and mark as read"),
    ("M", "Mute or unmute conversation"),
    ("C", "Move to Important or Other, and teach the classifier"),
    ("X", "Select for a bulk action"),
    ("Z", "Undo the last action"),
    ("R", "Reply in conversation"),
    ("T", "Reply in thread of current message"),
    ("U", "Open in Slack"),
    ("Shift-R", "Refresh"),
    ("?", "Show or hide shortcuts"),
    ("Cmd-Q", "Quit"),
];

pub fn bind_keys(cx: &mut App) {
    let list = Some("Inbox && !Input");
    cx.bind_keys([
        KeyBinding::new("j", Next, list),
        KeyBinding::new("down", Next, list),
        KeyBinding::new("k", Previous, list),
        KeyBinding::new("up", Previous, list),
        KeyBinding::new("enter", Open, list),
        KeyBinding::new("o", Open, list),
        KeyBinding::new("escape", Back, Some("Inbox")),
        KeyBinding::new("e", Done, list),
        KeyBinding::new("l", Later, list),
        KeyBinding::new("m", Mute, list),
        KeyBinding::new("c", Recategorize, list),
        KeyBinding::new("x", Check, list),
        KeyBinding::new("r", Reply, list),
        KeyBinding::new("t", ReplyInThread, list),
        KeyBinding::new("u", OpenInSlack, list),
        KeyBinding::new("z", Undo, list),
        KeyBinding::new("shift-r", Refresh, list),
        KeyBinding::new("tab", NextView, list),
        KeyBinding::new("shift-tab", PreviousView, list),
        KeyBinding::new("1", ShowImportant, list),
        KeyBinding::new("2", ShowOther, list),
        KeyBinding::new("3", ShowLater, list),
        KeyBinding::new("4", ShowMuted, list),
        KeyBinding::new("?", ToggleHelp, list),
        KeyBinding::new("cmd-q", Quit, None),
    ]);
    cx.on_action(|_: &Quit, cx| cx.quit());
}

enum ThreadReplies {
    Loading,
    Loaded(Vec<Message>),
}

struct Toast {
    id: usize,
    message: String,
    error: bool,
}

type UndoAction = Box<dyn FnOnce(&mut InboxView, &mut Context<InboxView>)>;

pub struct InboxView {
    engine: Option<Engine>,
    startup_error: Option<String>,
    config_problems: Vec<String>,
    inbox: Inbox,
    view: View,
    selected: Option<String>,
    reading: bool,
    focused_ts: Option<String>,
    checked: HashSet<String>,
    threads: HashMap<String, ThreadReplies>,
    thread_target: Option<String>,
    help_open: bool,
    toast: Option<Toast>,
    toast_counter: usize,
    undo: Option<UndoAction>,
    composer: Entity<TextareaState>,
    sending: bool,
    focus_handle: FocusHandle,
    list_scroll: ScrollHandle,
    message_scroll: ScrollHandle,
    _subscriptions: Vec<Subscription>,
}

impl Focusable for InboxView {
    fn focus_handle(&self, _: &App) -> FocusHandle {
        self.focus_handle.clone()
    }
}

impl InboxView {
    pub fn new(config: Config, window: &mut Window, cx: &mut Context<Self>) -> Self {
        let composer = cx.new(|cx| {
            TextareaState::new(window, cx).placeholder("Reply").auto_grow(1, 8).submit_on_enter(true)
        });
        let composer_events = cx.subscribe_in(&composer, window, |this, _, event: &InputEvent, window, cx| {
            if let InputEvent::PressEnter { shift: false, .. } = event {
                this.send(window, cx);
            }
        });
        let appearance = cx.observe_window_appearance(window, |_, window, cx| {
            gpui_kit::component::Theme::sync_system_appearance(Some(window), cx);
        });

        let (sender, receiver) = gpui_kit::base::async_util::unbounded::<()>();
        let (engine, startup_error) = match Engine::start(&config, move || {
            let _ = sender.try_send(());
        }) {
            Ok(engine) => (Some(engine), None),
            Err(error) => (None, Some(format!("{error:#}"))),
        };

        if let Some(engine) = engine.clone() {
            cx.spawn(async move |this, cx| {
                let mut first = true;
                loop {
                    if !first && receiver.recv().await.is_err() {
                        break;
                    }
                    first = false;
                    while receiver.try_recv().is_ok() {}
                    let engine = engine.clone();
                    let snapshot = cx.background_executor().spawn(async move { engine.snapshot() }).await;
                    let applied = this.update(cx, |this, cx| {
                        match snapshot {
                            Ok(snapshot) => this.apply_snapshot(snapshot),
                            Err(error) => this.show_error(format!("{error:#}"), cx),
                        }
                        cx.notify();
                    });
                    if applied.is_err() {
                        break;
                    }
                    cx.background_executor().timer(SNAPSHOT_DEBOUNCE).await;
                }
            })
            .detach();
        }

        Self {
            engine,
            startup_error,
            config_problems: config.problems.clone(),
            inbox: Inbox::default(),
            view: View::Important,
            selected: None,
            reading: false,
            focused_ts: None,
            checked: HashSet::new(),
            threads: HashMap::new(),
            thread_target: None,
            help_open: false,
            toast: None,
            toast_counter: 0,
            undo: None,
            composer,
            sending: false,
            focus_handle: cx.focus_handle(),
            list_scroll: ScrollHandle::new(),
            message_scroll: ScrollHandle::new(),
            _subscriptions: vec![composer_events, appearance],
        }
    }

    fn apply_snapshot(&mut self, snapshot: slack_inbox_gpui::engine::types::Snapshot) {
        self.inbox.apply(snapshot);
        self.repair_selection();
    }

    fn visible(&self) -> Vec<InboxItem> {
        self.inbox.visible(self.view)
    }

    fn current_item(&self) -> Option<InboxItem> {
        let selected = self.selected.as_ref()?;
        self.visible().into_iter().find(|item| &item.id == selected)
    }

    fn repair_selection(&mut self) {
        let visible = self.visible();
        if self.selected.as_ref().is_some_and(|selected| visible.iter().any(|item| &item.id == selected)) {
            return;
        }
        let first = visible.first().map(|item| item.id.clone());
        self.select(first);
    }

    fn select(&mut self, id: Option<String>) {
        let visible = self.visible();
        let item = id.as_ref().and_then(|id| visible.iter().find(|item| &item.id == id));
        self.focused_ts = item.and_then(|item| item.messages.first()).map(|message| message.ts.clone());
        self.thread_target = None;
        if item.is_none() {
            self.reading = false;
        }
        if let Some(index) = id.as_ref().and_then(|id| visible.iter().position(|item| &item.id == id)) {
            self.list_scroll.scroll_to_item(index);
        }
        self.message_scroll.scroll_to_item(0);
        self.selected = id;
    }

    fn target_ids(&self) -> Vec<String> {
        let visible: HashSet<String> = self.visible().into_iter().map(|item| item.id).collect();
        let checked: Vec<String> = self.checked.iter().filter(|id| visible.contains(*id)).cloned().collect();
        if !checked.is_empty() {
            return checked;
        }
        self.selected.iter().filter(|id| visible.contains(*id)).cloned().collect()
    }

    fn items_for(&self, ids: &[String]) -> Vec<InboxItem> {
        let visible = self.visible();
        ids.iter().filter_map(|id| visible.iter().find(|item| &item.id == id).cloned()).collect()
    }

    fn selection_after_removal(&self, ids: &[String]) -> Option<String> {
        let visible: Vec<String> = self.visible().into_iter().map(|item| item.id).collect();
        let removed: HashSet<&String> = ids.iter().collect();
        let index = self.selected.as_ref().and_then(|id| visible.iter().position(|item| item == id)).unwrap_or(0);
        visible[index..]
            .iter()
            .find(|id| !removed.contains(id))
            .or_else(|| visible[..index].iter().rev().find(|id| !removed.contains(id)))
            .cloned()
    }

    fn remove_and_advance(&mut self, ids: &[String], apply: impl FnOnce(&mut Self)) {
        let next = self.selection_after_removal(ids);
        apply(self);
        self.checked.clear();
        self.select(next);
    }

    fn reselect(&mut self, ids: &[String]) {
        let visible = self.visible();
        if let Some(id) = ids.iter().find(|id| visible.iter().any(|item| &item.id == *id)) {
            self.select(Some(id.clone()));
        }
    }

    fn show_toast(&mut self, message: String, error: bool, undo: Option<UndoAction>, cx: &mut Context<Self>) {
        self.toast_counter += 1;
        let id = self.toast_counter;
        self.toast = Some(Toast { id, message, error });
        self.undo = undo;
        cx.spawn(async move |this, cx| {
            cx.background_executor().timer(TOAST_DURATION).await;
            let _ = this.update(cx, |this, cx| {
                if this.toast.as_ref().is_some_and(|toast| toast.id == id) {
                    this.toast = None;
                    this.undo = None;
                    cx.notify();
                }
            });
        })
        .detach();
        cx.notify();
    }

    fn show_error(&mut self, message: String, cx: &mut Context<Self>) {
        self.show_toast(message, true, None, cx);
    }

    fn perform<T: Send + 'static>(
        &self,
        cx: &mut Context<Self>,
        work: impl FnOnce(&Engine) -> Result<T> + Send + 'static,
    ) {
        let Some(engine) = self.engine.clone() else { return };
        cx.spawn(async move |this, cx| {
            let result = cx.background_executor().spawn(async move { work(&engine) }).await;
            if let Err(error) = result {
                let _ = this.update(cx, |this, cx| this.show_error(format!("{error:#}"), cx));
            }
        })
        .detach();
    }

    fn sync_read_position(&self, item: &InboxItem, ts: String, cx: &mut Context<Self>) {
        let channel = item.conversation.id.clone();
        let thread_ts = item.thread.as_ref().map(|thread| thread.ts.clone());
        self.perform(cx, move |engine| match &thread_ts {
            Some(thread_ts) => engine.mark_thread_read(&channel, thread_ts, &ts),
            None => engine.mark_read(&channel, &ts),
        });
    }

    fn clear_from_inbox(&mut self, items: &[InboxItem], cx: &mut Context<Self>) -> UndoAction {
        for item in items {
            self.inbox.set_read_cursor(&item.id, Some(latest_ts(item).to_string()));
            self.sync_read_position(item, latest_ts(item).to_string(), cx);
        }
        let items = items.to_vec();
        Box::new(move |this, cx| {
            for item in &items {
                this.inbox.set_read_cursor(&item.id, None);
                if let Some(first) = item.messages.first() {
                    this.sync_read_position(item, timestamps::preceding(&first.ts), cx);
                }
            }
            let ids: Vec<String> = items.iter().map(|item| item.id.clone()).collect();
            this.reselect(&ids);
        })
    }

    fn mark_done(&mut self, message: Option<&str>, cx: &mut Context<Self>) {
        let ids = self.target_ids();
        let items = self.items_for(&ids);
        if items.is_empty() {
            return;
        }
        if self.view == View::Later {
            let references: Vec<MessageRef> = items.iter().filter_map(saved_reference).collect();
            self.remove_and_advance(&ids, |this| {
                for item in &items {
                    this.inbox.set_later(&item.id, None);
                }
            });
            let completed = references.clone();
            self.perform(cx, move |engine| completed.iter().try_for_each(|reference| engine.complete_later(reference)));
            let text = message.map_or_else(|| format!("Completed {}", pluralize(items.len(), "Later item")), String::from);
            let undo: UndoAction = Box::new(move |this, cx| {
                for item in &items {
                    this.inbox.set_later(&item.id, Some(item.clone()));
                }
                this.reselect(&ids);
                this.perform(cx, move |engine| references.iter().try_for_each(|reference| engine.reopen_later(reference)));
            });
            self.show_toast(text, false, Some(undo), cx);
            return;
        }
        let mut undo = None;
        self.remove_and_advance(&ids, |this| undo = Some(this.clear_from_inbox(&items, cx)));
        let text = message.map_or_else(|| format!("Marked {} as read", pluralize(items.len(), "conversation")), String::from);
        self.show_toast(text, false, undo, cx);
    }

    fn save_for_later(&mut self, cx: &mut Context<Self>) {
        if self.view == View::Later {
            return;
        }
        let ids = self.target_ids();
        let items = self.items_for(&ids);
        let saved: Vec<InboxItem> = items.iter().filter_map(to_later_item).collect();
        if saved.is_empty() {
            return;
        }
        let saved_count = saved.len();
        let (created_sender, created_receiver) = mpsc::channel::<Vec<bool>>();
        let references: Vec<MessageRef> = saved.iter().filter_map(saved_reference).collect();
        let requested = references.clone();
        self.perform(cx, move |engine| {
            let created = requested.iter().map(|reference| engine.save_for_later(reference)).collect::<Result<Vec<_>>>()?;
            let _ = created_sender.send(created);
            Ok(())
        });
        let mut restore = None;
        self.remove_and_advance(&ids, |this| {
            for item in &saved {
                this.inbox.set_later(&item.id, Some(item.clone()));
            }
            restore = Some(this.clear_from_inbox(&items, cx));
        });
        let undo: UndoAction = Box::new(move |this, cx| {
            if let Some(restore) = restore {
                restore(this, cx);
            }
            for item in &saved {
                this.inbox.set_later(&item.id, None);
            }
            this.perform(cx, move |engine| {
                let created = created_receiver.recv().unwrap_or_default();
                references
                    .iter()
                    .zip(created)
                    .filter(|(_, created)| *created)
                    .try_for_each(|(reference, _)| engine.remove_later(reference))
            });
        });
        self.show_toast(format!("Saved {} for later", pluralize(saved_count, "conversation")), false, Some(undo), cx);
    }

    fn toggle_mute(&mut self, cx: &mut Context<Self>) {
        if self.view == View::Later {
            return;
        }
        let items: Vec<InboxItem> =
            self.items_for(&self.target_ids()).into_iter().filter(|item| item.thread.is_none()).collect();
        if items.is_empty() {
            return;
        }
        let muting = self.view != View::Muted;
        let ids: Vec<String> = items.iter().map(|item| item.id.clone()).collect();
        let channels: Vec<String> = items.iter().map(|item| item.conversation.id.clone()).collect();
        let apply = move |this: &mut Self, muted: bool, cx: &mut Context<Self>| {
            for channel in &channels {
                this.inbox.set_muted(channel, muted);
            }
            let channels = channels.clone();
            this.perform(cx, move |engine| channels.iter().try_for_each(|channel| engine.set_muted(channel, muted)));
        };
        let apply_again = apply.clone();
        self.remove_and_advance(&ids, |this| apply(this, muting, cx));
        let text = format!("{} {}", if muting { "Muted" } else { "Unmuted" }, pluralize(items.len(), "conversation"));
        let undo: UndoAction = Box::new(move |this, cx| {
            apply_again(this, !muting, cx);
            this.reselect(&ids);
        });
        self.show_toast(text, false, Some(undo), cx);
    }

    fn recategorize(&mut self, cx: &mut Context<Self>) {
        let label = match self.view {
            View::Important => Label::Other,
            View::Other => Label::Important,
            View::Later | View::Muted => return,
        };
        let items: Vec<InboxItem> =
            self.items_for(&self.target_ids()).into_iter().filter(|item| item.thread.is_none()).collect();
        if items.is_empty() {
            return;
        }
        let ids: Vec<String> = items.iter().map(|item| item.id.clone()).collect();
        let previous: Vec<(String, MessageRef, Option<Classification>)> = items
            .iter()
            .flat_map(|item| {
                item.messages.iter().map(|message| {
                    (message_key(item, message), MessageRef::new(item.conversation.id.clone(), message.ts.clone()), message.classification.clone())
                })
            })
            .collect();
        self.remove_and_advance(&ids, |this| {
            for (key, _, _) in &previous {
                this.inbox.set_label(key.clone(), Some(label));
            }
        });
        let references: Vec<MessageRef> = previous.iter().map(|(_, reference, _)| reference.clone()).collect();
        self.perform(cx, move |engine| engine.set_classification(&references, label));
        let text = format!("Moved {} to {}", pluralize(items.len(), "conversation"), if label == Label::Important { "Important" } else { "Other" });
        let undo: UndoAction = Box::new(move |this, cx| {
            for (key, _, classification) in &previous {
                this.inbox.set_label(key.clone(), classification.as_ref().map(|classification| classification.label));
            }
            this.reselect(&ids);
            let entries: Vec<(MessageRef, Option<Classification>)> =
                previous.into_iter().map(|(_, reference, classification)| (reference, classification)).collect();
            this.perform(cx, move |engine| engine.restore_classifications(&entries));
        });
        self.show_toast(text, false, Some(undo), cx);
    }

    fn move_selection(&mut self, delta: isize) {
        if self.reading {
            let Some(item) = self.current_item() else { return };
            let messages = item.thread.iter().map(|thread| &thread.root).chain(item.messages.iter()).collect::<Vec<_>>();
            let index = messages.iter().position(|message| Some(&message.ts) == self.focused_ts.as_ref()).unwrap_or(0);
            let next = (index as isize + delta).clamp(0, messages.len() as isize - 1) as usize;
            if let Some(message) = messages.get(next) {
                self.focused_ts = Some(message.ts.clone());
                let divider_offset = usize::from(item.thread.is_some() && next > 0);
                self.message_scroll.scroll_to_item(next + divider_offset);
            }
            return;
        }
        let visible = self.visible();
        if visible.is_empty() {
            return;
        }
        let index = self.selected.as_ref().and_then(|id| visible.iter().position(|item| &item.id == id)).unwrap_or(0);
        let next = (index as isize + delta).clamp(0, visible.len() as isize - 1) as usize;
        self.select(Some(visible[next].id.clone()));
    }

    fn set_view(&mut self, view: View) {
        self.view = view;
        self.reading = false;
        self.checked.clear();
        let first = self.visible().first().map(|item| item.id.clone());
        self.select(first);
    }

    fn cycle_view(&mut self, delta: isize) {
        let index = (self.view.index() as isize + delta).rem_euclid(View::ALL.len() as isize) as usize;
        self.set_view(View::ALL[index]);
    }

    fn open(&mut self, cx: &mut Context<Self>) {
        if self.reading {
            if let Some(ts) = self.focused_ts.clone() {
                self.toggle_thread(&ts, cx);
            }
            return;
        }
        if self.current_item().is_some() {
            self.reading = true;
        }
    }

    fn toggle_thread(&mut self, ts: &str, cx: &mut Context<Self>) {
        let Some(item) = self.current_item() else { return };
        let Some(message) = find_message(&item, ts) else { return };
        if message.reply_count.unwrap_or(0) == 0 {
            return;
        }
        let key = format!("{}:{}", item.conversation.id, ts);
        if self.threads.remove(&key).is_some() {
            return;
        }
        self.threads.insert(key.clone(), ThreadReplies::Loading);
        let Some(engine) = self.engine.clone() else { return };
        let channel = item.conversation.id.clone();
        let ts = ts.to_string();
        cx.spawn(async move |this, cx| {
            let result = cx.background_executor().spawn(async move { engine.thread_replies(&channel, &ts) }).await;
            let _ = this.update(cx, |this, cx| {
                match result {
                    Ok((replies, users)) => {
                        this.inbox.merge_users(users);
                        this.threads.insert(key, ThreadReplies::Loaded(replies));
                    }
                    Err(error) => {
                        this.threads.remove(&key);
                        this.show_error(format!("{error:#}"), cx);
                    }
                }
                cx.notify();
            });
        })
        .detach();
    }

    fn back(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let composer_focused = self.composer.read(cx).focus_handle(cx).is_focused(window);
        if composer_focused {
            self.thread_target = None;
            window.focus(&self.focus_handle, cx);
        } else if self.help_open {
            self.help_open = false;
        } else if self.thread_target.is_some() {
            self.thread_target = None;
        } else if !self.checked.is_empty() {
            self.checked.clear();
        } else {
            self.reading = false;
        }
    }

    fn focus_composer(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.composer.update(cx, |composer, cx| composer.focus(window, cx));
    }

    fn reply(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.current_item().is_none() {
            return;
        }
        self.thread_target = None;
        self.focus_composer(window, cx);
    }

    fn reply_in_thread(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(item) = self.current_item() else { return };
        let ts = if self.reading { self.focused_ts.clone() } else { None }.unwrap_or_else(|| latest_ts(&item).to_string());
        let message = find_message(&item, &ts);
        self.thread_target = Some(message.and_then(|message| message.thread_ts.clone()).unwrap_or(ts));
        self.focus_composer(window, cx);
    }

    fn send(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let text = self.composer.read(cx).value().to_string();
        let Some(item) = self.current_item() else { return };
        if text.trim().is_empty() || self.sending {
            return;
        }
        let Some(engine) = self.engine.clone() else { return };
        self.sending = true;
        let channel = item.conversation.id.clone();
        let thread = self.thread_target.clone().or_else(|| item.thread.as_ref().map(|thread| thread.ts.clone()));
        let item_id = item.id.clone();
        cx.spawn_in(window, async move |this, cx| {
            let result =
                cx.background_executor().spawn(async move { engine.post_message(&channel, &text, thread.as_deref()) }).await;
            let _ = this.update_in(cx, |this, window, cx| {
                this.sending = false;
                match result {
                    Ok(()) => {
                        this.composer.update(cx, |composer, cx| composer.set_value("", window, cx));
                        this.thread_target = None;
                        window.focus(&this.focus_handle, cx);
                        this.checked.clear();
                        this.selected = Some(item_id);
                        this.mark_done(Some("Reply sent"), cx);
                    }
                    Err(error) => this.show_error(format!("{error:#}"), cx),
                }
                cx.notify();
            });
        })
        .detach();
    }

    fn open_in_slack(&mut self, cx: &mut Context<Self>) {
        let (Some(item), Some(session)) = (self.current_item(), self.inbox.session()) else { return };
        let ts = if self.reading { self.focused_ts.clone() } else { None }.unwrap_or_else(|| latest_ts(&item).to_string());
        cx.open_url(&format::permalink(session, &item.conversation.id, &ts));
    }

    fn toggle_checked(&mut self) {
        let Some(id) = self.selected.clone() else { return };
        if !self.checked.remove(&id) {
            self.checked.insert(id);
        }
    }

    fn undo(&mut self, cx: &mut Context<Self>) {
        if let Some(undo) = self.undo.take() {
            self.toast = None;
            undo(self, cx);
        }
    }
}

fn find_message<'a>(item: &'a InboxItem, ts: &str) -> Option<&'a Message> {
    match &item.thread {
        Some(thread) if thread.root.ts == ts => Some(&thread.root),
        _ => item.messages.iter().find(|message| message.ts == ts),
    }
}

fn saved_reference(item: &InboxItem) -> Option<MessageRef> {
    let ts = item.saved.as_ref().map(|saved| saved.ts.clone()).or_else(|| item.messages.last().map(|message| message.ts.clone()))?;
    Some(MessageRef::new(item.conversation.id.clone(), ts))
}

fn to_later_item(item: &InboxItem) -> Option<InboxItem> {
    let message = item.messages.last()?.clone();
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |duration| duration.as_secs() as i64);
    Some(InboxItem {
        id: format!("{}:{}", item.conversation.id, message.ts),
        conversation: item.conversation.clone(),
        saved: Some(SavedInfo { ts: message.ts.clone(), saved_at: now }),
        messages: vec![message],
        thread: None,
    })
}

impl InboxView {
    fn render_header(&self, cx: &mut Context<Self>) -> impl IntoElement + use<> {
        let counts = self.inbox.counts();
        let theme = cx.theme().clone();
        let sync = self.inbox.snapshot().map(|snapshot| snapshot.sync.clone());
        let mut status: Vec<AnyElement> = Vec::new();
        if let Some(sync) = &sync {
            if let Some(error) = &sync.classifier.error {
                status.push(div().text_color(theme.danger).child(format!("Classifier failed: {error}")).into_any_element());
            } else if sync.classifier.running && sync.classifier.pending > 0 {
                status.push(div().child(format!("Sorting {}", sync.classifier.pending)).into_any_element());
            }
            if let Some(error) = sync.error.as_ref().filter(|_| !sync.running) {
                status.push(div().text_color(theme.danger).child(format!("Sync failed: {}", error.code)).into_any_element());
            }
            match sync.realtime {
                RealtimeState::Connected => status.push(
                    h_flex()
                        .gap_1p5()
                        .child(div().size_2().rounded_full().bg(theme.success))
                        .child("Live")
                        .into_any_element(),
                ),
                RealtimeState::Disconnected => status.push(div().child("Reconnecting").into_any_element()),
                _ => {}
            }
            if sync.running && (sync.total > 0 || sync.last_completed_at.is_none()) {
                let label =
                    if sync.total > 0 { format!("Syncing {} of {}", sync.done, sync.total) } else { "Syncing".into() };
                status.push(div().child(label).into_any_element());
            }
        }
        h_flex()
            .h(px(48.))
            .px_4()
            .gap_4()
            .border_b_1()
            .border_color(theme.border)
            .bg(theme.title_bar)
            .child(div().font_semibold().child("Inbox"))
            .child(
                TabBar::new("views")
                    .segmented()
                    .small()
                    .selected_index(self.view.index())
                    .children(View::ALL.iter().zip(counts).map(|(view, count)| Tab::new().label(format!("{}  {}", view.title(), count))))
                    .on_click(cx.listener(|this, index: &usize, _, cx| {
                        this.set_view(View::ALL[*index]);
                        cx.notify();
                    })),
            )
            .child(
                h_flex()
                    .ml_auto()
                    .gap_3()
                    .text_xs()
                    .text_color(theme.muted_foreground)
                    .children(status)
                    .child(
                        Button::new("refresh")
                            .icon(IconName::RefreshCw)
                            .ghost()
                            .small()
                            .tooltip("Refresh (Shift-R)")
                            .on_click(cx.listener(|this, _, _, _| {
                                if let Some(engine) = &this.engine {
                                    engine.request_sync();
                                }
                            })),
                    )
                    .child(
                        Button::new("help")
                            .label("?")
                            .ghost()
                            .small()
                            .tooltip("Keyboard shortcuts (?)")
                            .on_click(cx.listener(|this, _, _, cx| {
                                this.help_open = !this.help_open;
                                cx.notify();
                            })),
                    ),
            )
    }

    fn render_row(&self, item: &InboxItem, cx: &mut Context<Self>) -> impl IntoElement + use<> {
        let theme = cx.theme().clone();
        let users = self.inbox.users();
        let selected = self.selected.as_ref() == Some(&item.id);
        let checked = self.checked.contains(&item.id);
        let label = format::conversation_label(&item.conversation, users, self.inbox.session());
        let latest = item.messages.last();
        let preview = latest.map(|message| {
            let summary = format::summary(message, users);
            if item.conversation.kind == slack_inbox_gpui::engine::types::ConversationKind::Dm {
                summary
            } else {
                format!("{}: {}", format::author_name(message, users), summary)
            }
        });
        let mentioned = item.thread.is_none() && self.inbox.mentions_self(item);
        let id = item.id.clone();
        let done_id = item.id.clone();
        let initial = label.trim_start_matches('#').chars().next().unwrap_or('?').to_uppercase().to_string();

        h_flex()
            .id(SharedString::from(format!("row-{}", item.id)))
            .items_start()
            .gap_3()
            .px_3()
            .py_2p5()
            .border_b_1()
            .border_color(theme.border)
            .border_l_2()
            .border_color(if selected { theme.primary } else { theme.border })
            .when(selected, |row| row.bg(theme.list_active))
            .when(checked, |row| row.bg(theme.warning.opacity(0.15)))
            .hover(|row| row.bg(theme.list_hover))
            .cursor_pointer()
            .on_click(cx.listener(move |this, event: &ClickEvent, _, cx| {
                if event.modifiers().secondary() || event.modifiers().shift {
                    this.checked.insert(id.clone());
                } else if this.selected.as_ref() == Some(&id) && event.click_count() >= 2 || this.selected.as_ref() == Some(&id) && !this.reading {
                    this.reading = true;
                } else {
                    this.select(Some(id.clone()));
                }
                cx.notify();
            }))
            .child(
                Button::new(SharedString::from(format!("done-{}", item.id)))
                    .icon(IconName::Check)
                    .ghost()
                    .xsmall()
                    .tooltip(if self.view == View::Later { "Mark complete (E)" } else { "Mark as read (E)" })
                    .on_click(cx.listener(move |this, _, _, cx| {
                        this.checked.clear();
                        this.selected = Some(done_id.clone());
                        this.mark_done(None, cx);
                        cx.stop_propagation();
                    })),
            )
            .child(
                div()
                    .size(px(32.))
                    .flex_none()
                    .rounded_md()
                    .bg(theme.muted)
                    .flex()
                    .items_center()
                    .justify_center()
                    .text_sm()
                    .font_semibold()
                    .text_color(theme.muted_foreground)
                    .child(if item.thread.is_some() { "↳".to_string() } else { initial }),
            )
            .child(
                v_flex()
                    .flex_1()
                    .min_w_0()
                    .gap_0p5()
                    .child(
                        h_flex()
                            .gap_1p5()
                            .child(div().font_semibold().truncate().child(label))
                            .when(item.messages.len() > 1, |heading| {
                                heading.child(Tag::primary().small().rounded_full().child(item.messages.len().to_string()))
                            })
                            .when(item.thread.is_some(), |heading| heading.child(Tag::info().small().child("Thread")))
                            .when(mentioned, |heading| heading.child(Tag::warning().small().child("Mention")))
                            .child(
                                div()
                                    .ml_auto()
                                    .flex_none()
                                    .text_xs()
                                    .text_color(theme.muted_foreground)
                                    .child(format::list_time(latest_ts(item))),
                            ),
                    )
                    .when_some(item.thread.as_ref(), |body, thread| {
                        body.child(
                            div()
                                .text_xs()
                                .text_color(theme.muted_foreground)
                                .truncate()
                                .child(format!("{}: {}", format::author_name(&thread.root, users), format::summary(&thread.root, users))),
                        )
                    })
                    .when_some(preview, |body, preview| {
                        body.child(div().text_sm().text_color(theme.muted_foreground).line_clamp(2).child(preview))
                    }),
            )
    }

    fn render_list(&self, cx: &mut Context<Self>) -> impl IntoElement + use<> {
        let theme = cx.theme().clone();
        let items = self.visible();
        let container = div()
            .id("items")
            .w(px(LIST_WIDTH))
            .flex_none()
            .h_full()
            .border_r_1()
            .border_color(theme.border)
            .bg(theme.sidebar);
        if items.is_empty() {
            let (title, detail) = match self.view {
                View::Important => ("All caught up", "No unread direct messages, mentions, or threads."),
                View::Other => ("Nothing else unread", "Every channel is read."),
                View::Later => ("Nothing saved", "Press L on a conversation, or save a message for later in Slack."),
                View::Muted => ("No muted unreads", "Muted conversations with unread messages appear here."),
            };
            let loading = self.inbox.snapshot().is_none_or(|snapshot| snapshot.session.is_none());
            return container.child(
                v_flex()
                    .size_full()
                    .items_center()
                    .justify_center()
                    .gap_1()
                    .p_8()
                    .when(loading, |empty| empty.child(div().text_color(theme.muted_foreground).child("Loading conversations…")))
                    .when(!loading, |empty| {
                        empty
                            .child(div().font_semibold().child(title))
                            .child(div().text_sm().text_color(theme.muted_foreground).child(detail))
                    }),
            );
        }
        container
            .overflow_y_scroll()
            .track_scroll(&self.list_scroll)
            .children(items.iter().map(|item| self.render_row(item, cx).into_any_element()).collect::<Vec<_>>())
    }

    fn render_message(&self, item: &InboxItem, message: &Message, cx: &mut Context<Self>) -> AnyElement {
        let theme = cx.theme().clone();
        let users = self.inbox.users();
        let focused = self.reading && self.focused_ts.as_ref() == Some(&message.ts);
        let key = format!("{}:{}", item.conversation.id, message.ts);
        let replies = self.threads.get(&key);
        let label = self.inbox.message_label(item, message);
        let reason = message.classification.as_ref().map(|classification| {
            let source = if classification.source == ClassificationSource::User { "Set by you" } else { "Classifier" };
            format!("{source}: {}", classification.reason)
        });
        let ts = message.ts.clone();
        let toggle_ts = message.ts.clone();
        let thread_ts = message.thread_ts.clone().unwrap_or_else(|| message.ts.clone());
        let reply_count = message.reply_count.unwrap_or(0);
        let is_root = item.thread.as_ref().is_some_and(|thread| thread.root.ts == message.ts);

        v_flex()
            .id(SharedString::from(format!("message-{key}")))
            .px_5()
            .py_2()
            .gap_1()
            .border_l_2()
            .border_color(if focused { theme.primary } else { theme.background })
            .when(focused, |row| row.bg(theme.list_active))
            .on_click(cx.listener(move |this, _, _, cx| {
                this.reading = true;
                this.focused_ts = Some(ts.clone());
                cx.notify();
            }))
            .child(
                h_flex()
                    .gap_2()
                    .child(div().font_semibold().child(format::author_name(message, users)))
                    .child(div().text_xs().text_color(theme.muted_foreground).child(format::message_time(&message.ts)))
                    .when(is_root, |header| header.child(Tag::secondary().small().child("Thread start")))
                    .when_some(label, |header, label| {
                        let tag = match label {
                            Label::Important => Tag::warning().small().child("Important"),
                            Label::Other => Tag::secondary().small().child("Other"),
                        };
                        header.child(
                            div()
                                .id(SharedString::from(format!("label-{key}")))
                                .when_some(reason.clone(), |tag_container, reason| tag_container.tooltip(move |window, cx| {
                                    gpui_kit::component::tooltip::Tooltip::new(reason.clone()).build(window, cx)
                                }))
                                .child(tag),
                        )
                    }),
            )
            .child(div().text_sm().whitespace_normal().child(text::message_text(message, users)))
            .when(!message.reactions.is_empty(), |body| {
                body.child(h_flex().gap_1().flex_wrap().children(message.reactions.iter().map(|reaction| {
                    Tag::secondary().small().rounded_full().child(format!("{} {}", text::readable(&format!(":{}:", reaction.name), users), reaction.count))
                })))
            })
            .child(
                h_flex()
                    .gap_3()
                    .when(reply_count > 0, |footer| {
                        footer.child(
                            Button::new(SharedString::from(format!("replies-{key}")))
                                .icon(IconName::MessageSquare)
                                .label(pluralize(reply_count as usize, "reply").replace("replys", "replies"))
                                .link()
                                .xsmall()
                                .on_click(cx.listener(move |this, _, _, cx| {
                                    this.toggle_thread(&toggle_ts, cx);
                                    cx.notify();
                                })),
                        )
                    })
                    .child(
                        Button::new(SharedString::from(format!("reply-{key}")))
                            .label("Reply in thread")
                            .link()
                            .xsmall()
                            .on_click(cx.listener(move |this, _, window, cx| {
                                this.thread_target = Some(thread_ts.clone());
                                this.focus_composer(window, cx);
                                cx.notify();
                            })),
                    ),
            )
            .when_some(replies, |body, replies| match replies {
                ThreadReplies::Loading => body.child(div().text_xs().text_color(theme.muted_foreground).child("Loading replies…")),
                ThreadReplies::Loaded(replies) => body.child(
                    v_flex().ml_2().pl_3().gap_2().border_l_2().border_color(theme.border).children(replies.iter().map(|reply| {
                        v_flex()
                            .child(
                                h_flex()
                                    .gap_2()
                                    .child(div().text_sm().font_semibold().child(format::author_name(reply, users)))
                                    .child(div().text_xs().text_color(theme.muted_foreground).child(format::message_time(&reply.ts))),
                            )
                            .child(div().text_sm().whitespace_normal().child(text::message_text(reply, users)))
                    })),
                ),
            })
            .into_any_element()
    }

    fn render_detail(&self, cx: &mut Context<Self>) -> impl IntoElement + use<> {
        let theme = cx.theme().clone();
        let Some(item) = self.current_item() else {
            return v_flex()
                .flex_1()
                .h_full()
                .items_center()
                .justify_center()
                .text_color(theme.muted_foreground)
                .child("Select a conversation to read it.");
        };
        let users = self.inbox.users();
        let title = format::conversation_label(&item.conversation, users, self.inbox.session());
        let count = item.messages.len();
        let subtitle = if self.view == View::Later {
            format!("{} · Saved for later", format::kind_label(&item))
        } else if item.thread.is_some() {
            format!("Thread · {} new {}", count, if count == 1 { "reply" } else { "replies" })
        } else {
            format!("{} · {} unread", format::kind_label(&item), count)
        };
        let mut messages: Vec<AnyElement> = Vec::new();
        if let Some(thread) = &item.thread {
            messages.push(self.render_message(&item, &thread.root, cx));
            messages.push(
                div()
                    .px_5()
                    .py_1()
                    .text_xs()
                    .font_semibold()
                    .text_color(theme.primary)
                    .child(format!("{} new {}", count, if count == 1 { "reply" } else { "replies" }))
                    .into_any_element(),
            );
        }
        for message in &item.messages {
            messages.push(self.render_message(&item, message, cx));
        }
        let view = self.view;
        let is_thread = item.thread.is_some();
        let reply_thread = self.thread_target.clone().or_else(|| item.thread.as_ref().map(|thread| thread.ts.clone()));
        let reply_parent = reply_thread.as_deref().and_then(|ts| find_message(&item, ts)).map(|message| format::author_name(message, users));

        v_flex()
            .flex_1()
            .min_w_0()
            .h_full()
            .child(
                h_flex()
                    .px_5()
                    .py_3()
                    .gap_4()
                    .border_b_1()
                    .border_color(theme.border)
                    .child(
                        v_flex()
                            .min_w_0()
                            .child(div().text_lg().font_semibold().truncate().child(title))
                            .child(div().text_xs().text_color(theme.muted_foreground).child(subtitle)),
                    )
                    .child(
                        h_flex()
                            .ml_auto()
                            .gap_1()
                            .child(
                                Button::new("detail-done")
                                    .icon(IconName::Check)
                                    .label(if view == View::Later { "Complete" } else { "Mark read" })
                                    .small()
                                    .outline()
                                    .on_click(cx.listener(|this, _, _, cx| {
                                        this.checked.clear();
                                        this.mark_done(None, cx);
                                    })),
                            )
                            .when(view != View::Later, |actions| {
                                actions.child(
                                    Button::new("detail-later")
                                        .icon(IconName::Clock)
                                        .label("Later")
                                        .small()
                                        .outline()
                                        .on_click(cx.listener(|this, _, _, cx| {
                                            this.checked.clear();
                                            this.save_for_later(cx);
                                        })),
                                )
                            })
                            .when(!is_thread && matches!(view, View::Important | View::Other), |actions| {
                                actions.child(
                                    Button::new("detail-move")
                                        .icon(IconName::ArrowLeftRight)
                                        .label(if view == View::Important { "Move to Other" } else { "Move to Important" })
                                        .small()
                                        .outline()
                                        .on_click(cx.listener(|this, _, _, cx| {
                                            this.checked.clear();
                                            this.recategorize(cx);
                                        })),
                                )
                            })
                            .when(!is_thread && view != View::Later, |actions| {
                                actions.child(
                                    Button::new("detail-mute")
                                        .icon(IconName::BellOff)
                                        .label(if view == View::Muted { "Unmute" } else { "Mute" })
                                        .small()
                                        .outline()
                                        .on_click(cx.listener(|this, _, _, cx| {
                                            this.checked.clear();
                                            this.toggle_mute(cx);
                                        })),
                                )
                            })
                            .child(
                                Button::new("detail-slack")
                                    .icon(IconName::ExternalLink)
                                    .label("Slack")
                                    .small()
                                    .outline()
                                    .on_click(cx.listener(|this, _, _, cx| this.open_in_slack(cx))),
                            ),
                    ),
            )
            .child(
                div()
                    .id("messages")
                    .flex_1()
                    .overflow_y_scroll()
                    .track_scroll(&self.message_scroll)
                    .py_2()
                    .children(messages),
            )
            .child(
                v_flex()
                    .px_5()
                    .py_3()
                    .gap_1p5()
                    .border_t_1()
                    .border_color(theme.border)
                    .when(reply_thread.is_some(), |composer| {
                        composer.child(div().text_xs().text_color(theme.muted_foreground).child(match reply_parent {
                            Some(author) => format!("Replying in thread to {author}"),
                            None => "Replying in thread".into(),
                        }))
                    })
                    .child(
                        h_flex()
                            .items_end()
                            .gap_2()
                            .child(div().flex_1().child(Textarea::new(&self.composer).w_full()))
                            .child(
                                Button::new("send")
                                    .label(if self.sending { "Sending" } else { "Send" })
                                    .primary()
                                    .loading(self.sending)
                                    .on_click(cx.listener(|this, _, window, cx| this.send(window, cx))),
                            ),
                    )
                    .child(
                        div()
                            .text_xs()
                            .text_color(theme.muted_foreground)
                            .child("Enter sends and marks the conversation read · Shift-Enter adds a line · Esc leaves the reply box"),
                    ),
            )
    }

    fn render_toast(&self, cx: &mut Context<Self>) -> Option<impl IntoElement + use<>> {
        let toast = self.toast.as_ref()?;
        let theme = cx.theme().clone();
        let has_undo = self.undo.is_some();
        Some(
            div().absolute().bottom_5().left_0().right_0().flex().justify_center().child(
                h_flex()
                    .gap_3()
                    .px_4()
                    .py_2()
                    .rounded_lg()
                    .shadow_lg()
                    .bg(if toast.error { theme.danger } else { theme.foreground })
                    .text_color(if toast.error { theme.danger_foreground } else { theme.background })
                    .text_sm()
                    .child(toast.message.clone())
                    .when(has_undo, |toast| {
                        toast.child(
                            div()
                                .id("undo")
                                .font_semibold()
                                .cursor_pointer()
                                .child("Undo (Z)")
                                .on_click(cx.listener(|this, _, _, cx| {
                                    this.undo(cx);
                                    cx.notify();
                                })),
                        )
                    }),
            ),
        )
    }

    fn render_help(&self, cx: &mut Context<Self>) -> Option<impl IntoElement + use<>> {
        if !self.help_open {
            return None;
        }
        let theme = cx.theme().clone();
        Some(
            div()
                .id("help")
                .absolute()
                .inset_0()
                .bg(theme.overlay)
                .flex()
                .items_center()
                .justify_center()
                .on_click(cx.listener(|this, _, _, cx| {
                    this.help_open = false;
                    cx.notify();
                }))
                .child(
                    v_flex()
                        .w(px(560.))
                        .p_6()
                        .gap_2()
                        .rounded_xl()
                        .shadow_xl()
                        .bg(theme.popover)
                        .border_1()
                        .border_color(theme.border)
                        .child(div().text_lg().font_semibold().pb_2().child("Keyboard shortcuts"))
                        .children(SHORTCUTS.iter().map(|(keys, description)| {
                            h_flex()
                                .gap_4()
                                .child(div().w(px(130.)).flex_none().text_sm().font_semibold().child(*keys))
                                .child(div().text_sm().text_color(theme.muted_foreground).child(*description))
                        })),
                ),
        )
    }

    fn render_setup(&self, cx: &mut Context<Self>) -> Option<impl IntoElement + use<>> {
        let snapshot_error = self
            .inbox
            .snapshot()
            .filter(|snapshot| snapshot.session.is_none())
            .and_then(|snapshot| snapshot.sync.error.clone());
        let message = self.startup_error.clone().or_else(|| snapshot_error.map(|error| error.message))?;
        let theme = cx.theme().clone();
        Some(
            v_flex()
                .size_full()
                .items_center()
                .justify_center()
                .p_8()
                .child(
                    v_flex()
                        .w(px(560.))
                        .gap_3()
                        .child(div().text_xl().font_semibold().child("Could not load Slack"))
                        .child(div().text_sm().text_color(theme.danger).child(message))
                        .children(self.config_problems.iter().map(|problem| div().text_sm().child(problem.clone())))
                        .child(div().text_sm().text_color(theme.muted_foreground).child(
                            "Put SLACK_USER_TOKEN, or SLACK_SESSION_TOKEN and SLACK_SESSION_COOKIE, in .env.local in this directory or a parent directory, then restart the app.",
                        ))
                        .child(Button::new("retry").label("Try again").primary().on_click(cx.listener(|this, _, _, _| {
                            if let Some(engine) = &this.engine {
                                engine.request_sync();
                            }
                        }))),
                ),
        )
    }
}

impl Render for InboxView {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = cx.theme().clone();
        let root = v_flex()
            .key_context("Inbox")
            .track_focus(&self.focus_handle)
            .size_full()
            .bg(theme.background)
            .text_color(theme.foreground)
            .on_action(cx.listener(|this, _: &Next, _, cx| {
                this.move_selection(1);
                cx.notify();
            }))
            .on_action(cx.listener(|this, _: &Previous, _, cx| {
                this.move_selection(-1);
                cx.notify();
            }))
            .on_action(cx.listener(|this, _: &Open, _, cx| {
                this.open(cx);
                cx.notify();
            }))
            .on_action(cx.listener(|this, _: &Back, window, cx| {
                this.back(window, cx);
                cx.notify();
            }))
            .on_action(cx.listener(|this, _: &Done, _, cx| this.mark_done(None, cx)))
            .on_action(cx.listener(|this, _: &Later, _, cx| this.save_for_later(cx)))
            .on_action(cx.listener(|this, _: &Mute, _, cx| this.toggle_mute(cx)))
            .on_action(cx.listener(|this, _: &Recategorize, _, cx| this.recategorize(cx)))
            .on_action(cx.listener(|this, _: &Check, _, cx| {
                this.toggle_checked();
                cx.notify();
            }))
            .on_action(cx.listener(|this, _: &Reply, window, cx| this.reply(window, cx)))
            .on_action(cx.listener(|this, _: &ReplyInThread, window, cx| {
                this.reply_in_thread(window, cx);
                cx.notify();
            }))
            .on_action(cx.listener(|this, _: &OpenInSlack, _, cx| this.open_in_slack(cx)))
            .on_action(cx.listener(|this, _: &Undo, _, cx| {
                this.undo(cx);
                cx.notify();
            }))
            .on_action(cx.listener(|this, _: &Refresh, _, _| {
                if let Some(engine) = &this.engine {
                    engine.request_sync();
                }
            }))
            .on_action(cx.listener(|this, _: &NextView, _, cx| {
                this.cycle_view(1);
                cx.notify();
            }))
            .on_action(cx.listener(|this, _: &PreviousView, _, cx| {
                this.cycle_view(-1);
                cx.notify();
            }))
            .on_action(cx.listener(|this, _: &ShowImportant, _, cx| {
                this.set_view(View::Important);
                cx.notify();
            }))
            .on_action(cx.listener(|this, _: &ShowOther, _, cx| {
                this.set_view(View::Other);
                cx.notify();
            }))
            .on_action(cx.listener(|this, _: &ShowLater, _, cx| {
                this.set_view(View::Later);
                cx.notify();
            }))
            .on_action(cx.listener(|this, _: &ShowMuted, _, cx| {
                this.set_view(View::Muted);
                cx.notify();
            }))
            .on_action(cx.listener(|this, _: &ToggleHelp, _, cx| {
                this.help_open = !this.help_open;
                cx.notify();
            }));

        if let Some(setup) = self.render_setup(cx) {
            return root.child(setup);
        }
        let header = self.render_header(cx);
        let list = self.render_list(cx);
        let detail = self.render_detail(cx);
        let toast = self.render_toast(cx);
        let help = self.render_help(cx);
        root.relative()
            .child(header)
            .child(h_flex().flex_1().min_h_0().items_start().child(list).child(detail))
            .children(toast)
            .children(help)
    }
}

