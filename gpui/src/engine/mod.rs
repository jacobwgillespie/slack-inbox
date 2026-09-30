mod classifier;
mod classifier_tools;
pub mod config;
mod database;
mod openai;
mod preferences;
mod realtime;
mod slack_client;
mod slack_data;
mod sync;
pub mod text;
mod threads;
pub mod timestamps;
pub mod types;

use std::collections::HashSet;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex, MutexGuard};
use std::thread;
use std::time::{Duration, Instant};

use anyhow::{Result, anyhow};

use config::{ClassifierConfig, Config};
use database::Database;
use slack_client::SlackClient;
use types::{
    ClassifierStatus, CredentialMode, Label, Message, MessageRef, RealtimeState, Session, Snapshot, SyncStatus, User,
};

pub use types::Classification;

pub struct Signal {
    due: Mutex<Option<Instant>>,
    changed: Condvar,
}

impl Signal {
    fn new() -> Self {
        Self { due: Mutex::new(None), changed: Condvar::new() }
    }

    pub fn request(&self, delay: Duration) {
        let mut due = self.due.lock().unwrap();
        let requested = Instant::now() + delay;
        *due = Some(due.map_or(requested, |existing| existing.min(requested)));
        self.changed.notify_all();
    }

    pub fn wake(&self) {
        self.changed.notify_all();
    }

    fn wait(&self, fallback: Option<Duration>, stopped: &AtomicBool) {
        let deadline = fallback.map(|fallback| Instant::now() + fallback);
        let mut due = self.due.lock().unwrap();
        loop {
            if stopped.load(Ordering::SeqCst) {
                return;
            }
            let now = Instant::now();
            if let Some(requested) = *due {
                if requested <= now {
                    *due = None;
                    return;
                }
            }
            if deadline.is_some_and(|deadline| deadline <= now) {
                return;
            }
            let until = [*due, deadline].into_iter().flatten().min();
            due = match until {
                Some(until) => self.changed.wait_timeout(due, until - now).unwrap().0,
                None => self.changed.wait(due).unwrap(),
            };
        }
    }
}

pub struct Shared {
    database: Mutex<Database>,
    client: SlackClient,
    status: Mutex<SyncStatus>,
    session: Mutex<Option<Session>>,
    session_verified: AtomicBool,
    stopped: AtomicBool,
    sync_signal: Signal,
    classifier_signal: Signal,
    classifier: Option<ClassifierConfig>,
    database_path: std::path::PathBuf,
    requested_users: Mutex<HashSet<String>>,
    pending_saved_messages: Mutex<HashSet<String>>,
    on_change: Box<dyn Fn() + Send + Sync>,
}

impl Shared {
    fn database(&self) -> MutexGuard<'_, Database> {
        self.database.lock().unwrap()
    }

    fn mode(&self) -> CredentialMode {
        self.status.lock().unwrap().mode
    }

    fn session(&self) -> Option<Session> {
        self.session.lock().unwrap().clone()
    }

    fn uses_slack_preferences(&self) -> bool {
        self.mode() == CredentialMode::Session
    }

    fn is_stopped(&self) -> bool {
        self.stopped.load(Ordering::SeqCst)
    }

    fn update_status(&self, update: impl FnOnce(&mut SyncStatus)) {
        update(&mut self.status.lock().unwrap());
        self.changed();
    }

    fn changed(&self) {
        (self.on_change)();
    }

    fn request_sync(&self) {
        self.sync_signal.request(Duration::ZERO);
    }

    fn schedule_classifier(&self, delay: Duration) {
        if self.classifier.is_some() {
            self.classifier_signal.request(delay);
        }
    }
}

pub fn parallel_each<T: Send>(items: Vec<T>, workers: usize, work: impl Fn(T) + Sync) {
    let queue = Mutex::new(items.into_iter());
    thread::scope(|scope| {
        for _ in 0..workers {
            scope.spawn(|| {
                loop {
                    let Some(item) = queue.lock().unwrap().next() else { return };
                    work(item);
                }
            });
        }
    });
}

#[derive(Clone)]
pub struct Engine {
    shared: Arc<Shared>,
}

impl Engine {
    pub fn start(config: &Config, on_change: impl Fn() + Send + Sync + 'static) -> Result<Engine> {
        let database = Database::open(&config.database_path)?;
        let mode = config.credentials.mode();
        let session = database.metadata::<Session>("session");
        let status = SyncStatus {
            mode,
            realtime: if mode == CredentialMode::Session { RealtimeState::Connecting } else { RealtimeState::Unavailable },
            classifier: ClassifierStatus { enabled: config.classifier.is_some(), ..Default::default() },
            running: false,
            done: 0,
            total: 0,
            last_completed_at: None,
            error: None,
        };
        let shared = Arc::new(Shared {
            database: Mutex::new(database),
            client: SlackClient::new(config.credentials.clone()),
            status: Mutex::new(status),
            session: Mutex::new(session),
            session_verified: AtomicBool::new(false),
            stopped: AtomicBool::new(false),
            sync_signal: Signal::new(),
            classifier_signal: Signal::new(),
            classifier: config.classifier.clone(),
            database_path: config.database_path.clone(),
            requested_users: Mutex::new(HashSet::new()),
            pending_saved_messages: Mutex::new(HashSet::new()),
            on_change: Box::new(on_change),
        });

        let worker = shared.clone();
        thread::spawn(move || sync::run_loop(&worker));
        if mode == CredentialMode::Session {
            let worker = shared.clone();
            thread::spawn(move || realtime::run_loop(&worker));
        }
        if shared.classifier.is_some() {
            let worker = shared.clone();
            thread::spawn(move || classifier::run_loop(&worker));
        }
        Ok(Engine { shared })
    }

    pub fn stop(&self) {
        self.shared.stopped.store(true, Ordering::SeqCst);
        self.shared.sync_signal.wake();
        self.shared.classifier_signal.wake();
    }

    pub fn snapshot(&self) -> Result<Snapshot> {
        self.shared.snapshot()
    }

    pub fn emoji(&self) -> Result<std::collections::HashMap<String, String>> {
        self.shared.database().emoji()
    }

    pub fn request_sync(&self) {
        self.shared.request_sync();
    }

    pub fn mark_read(&self, channel: &str, ts: &str) -> Result<()> {
        self.shared.mark_read(channel, ts)
    }

    pub fn mark_thread_read(&self, channel: &str, thread_ts: &str, ts: &str) -> Result<()> {
        if self.shared.mode() != CredentialMode::Session {
            return Err(anyhow!("Thread read state needs a session token."));
        }
        self.shared.mark_thread_read(channel, thread_ts, ts)
    }

    pub fn post_message(&self, channel: &str, text: &str, thread_ts: Option<&str>) -> Result<()> {
        self.shared.post_message(channel, text, thread_ts)
    }

    pub fn thread_replies(&self, channel: &str, ts: &str) -> Result<(Vec<Message>, std::collections::HashMap<String, User>)> {
        self.shared.thread_replies(channel, ts)
    }

    pub fn save_for_later(&self, reference: &MessageRef) -> Result<bool> {
        self.shared.save_for_later(reference)
    }

    pub fn complete_later(&self, reference: &MessageRef) -> Result<()> {
        self.shared.set_saved_state(reference, database::SavedState::Completed)
    }

    pub fn reopen_later(&self, reference: &MessageRef) -> Result<()> {
        self.shared.set_saved_state(reference, database::SavedState::InProgress)
    }

    pub fn remove_later(&self, reference: &MessageRef) -> Result<()> {
        self.shared.remove_saved_item(reference)
    }

    pub fn set_muted(&self, channel: &str, muted: bool) -> Result<()> {
        self.shared.set_muted(channel, muted)
    }

    pub fn set_classification(&self, references: &[MessageRef], label: Label) -> Result<()> {
        self.shared.database().transaction(|database| {
            for reference in references {
                database.save_user_classification(reference, label)?;
            }
            Ok(())
        })?;
        self.shared.changed();
        self.shared.schedule_classifier(Duration::from_secs(3));
        Ok(())
    }

    pub fn restore_classifications(&self, entries: &[(MessageRef, Option<Classification>)]) -> Result<()> {
        self.shared.database().transaction(|database| {
            for (reference, classification) in entries {
                database.restore_classification(reference, classification.as_ref())?;
            }
            Ok(())
        })?;
        self.shared.changed();
        Ok(())
    }
}
