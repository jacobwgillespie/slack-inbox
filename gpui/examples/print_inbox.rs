use std::thread;
use std::time::Duration;

use slack_inbox_gpui::engine::Engine;
use slack_inbox_gpui::engine::config::Config;

fn main() -> anyhow::Result<()> {
    let config = Config::load();
    for problem in &config.problems {
        eprintln!("Configuration problem: {problem}");
    }
    let seconds = std::env::args().nth(1).and_then(|value| value.parse().ok()).unwrap_or(10);
    let engine = Engine::start(&config, || {})?;
    thread::sleep(Duration::from_secs(seconds));
    let snapshot = engine.snapshot()?;
    println!("session: {:?}", snapshot.session.as_ref().map(|session| &session.handle));
    println!("sync: {:?}", snapshot.sync);
    for item in &snapshot.items {
        let labels: Vec<_> = item
            .messages
            .iter()
            .map(|message| message.classification.as_ref().map_or("-", |classification| classification.label.as_str()))
            .collect();
        println!("item {} {} messages {:?} thread {}", item.id, item.messages.len(), labels, item.thread.is_some());
    }
    for item in &snapshot.later {
        println!("later {} {}", item.id, item.conversation.name);
    }
    println!("muted: {:?}", snapshot.muted);
    engine.stop();
    Ok(())
}
