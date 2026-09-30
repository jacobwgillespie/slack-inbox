use std::io::ErrorKind;
use std::net::TcpStream;
use std::thread;
use std::time::{Duration, Instant};

use anyhow::{Result, anyhow};
use serde::Deserialize;
use serde_json::{Value, json};
use tungstenite::client::IntoClientRequest;
use tungstenite::stream::MaybeTlsStream;
use tungstenite::{Message as Frame, WebSocket};

use crate::engine::Shared;
use crate::engine::slack_client::SlackError;
use crate::engine::types::RealtimeState;

const PING_INTERVAL: Duration = Duration::from_secs(30);
const STALE_CONNECTION_AGE: Duration = Duration::from_secs(60);
const READ_TIMEOUT: Duration = Duration::from_secs(1);
const INITIAL_RECONNECT_DELAY: Duration = Duration::from_secs(1);
const MAX_RECONNECT_DELAY: Duration = Duration::from_secs(60);
const UNSUPPORTED_TOKEN_ERRORS: [&str; 3] = ["not_allowed_token_type", "method_deprecated", "missing_scope"];

#[derive(Deserialize)]
struct Connect {
    url: String,
}

enum Outcome {
    Closed,
    Unsupported,
}

fn set_read_timeout(socket: &WebSocket<MaybeTlsStream<TcpStream>>) -> Result<()> {
    let stream = match socket.get_ref() {
        MaybeTlsStream::Plain(stream) => stream,
        MaybeTlsStream::Rustls(stream) => stream.get_ref(),
        _ => return Err(anyhow!("unsupported WebSocket stream")),
    };
    stream.set_read_timeout(Some(READ_TIMEOUT))?;
    Ok(())
}

pub fn run_loop(shared: &Shared) {
    let mut delay = INITIAL_RECONNECT_DELAY;
    while !shared.is_stopped() {
        shared.update_status(|status| status.realtime = RealtimeState::Connecting);
        match connect(shared, &mut delay) {
            Ok(Outcome::Unsupported) => {
                shared.update_status(|status| status.realtime = RealtimeState::Unavailable);
                return;
            }
            Ok(Outcome::Closed) => {}
            Err(error) => eprintln!("Slack real-time connection failed: {error:#}"),
        }
        if shared.is_stopped() {
            return;
        }
        shared.update_status(|status| status.realtime = RealtimeState::Disconnected);
        thread::sleep(delay);
        delay = (delay * 2).min(MAX_RECONNECT_DELAY);
    }
}

fn connect(shared: &Shared, delay: &mut Duration) -> Result<Outcome> {
    let url = match shared.client.call::<Connect>("rtm.connect", &[]) {
        Ok(connect) => connect.url,
        Err(SlackError { code, .. }) if UNSUPPORTED_TOKEN_ERRORS.contains(&code.as_str()) => return Ok(Outcome::Unsupported),
        Err(error) => return Err(error.into()),
    };
    let mut request = url.into_client_request()?;
    if let Some(cookie) = shared.client.realtime_cookie() {
        request.headers_mut().insert("cookie", cookie.parse()?);
    }
    let (mut socket, _) = tungstenite::connect(request)?;
    set_read_timeout(&socket)?;

    let mut last_message = Instant::now();
    let mut last_ping = Instant::now();
    let mut ping_id = 0u64;
    while !shared.is_stopped() {
        match socket.read() {
            Ok(Frame::Text(text)) => {
                last_message = Instant::now();
                let Ok(event) = serde_json::from_str::<Value>(&text) else { continue };
                match event.get("type").and_then(Value::as_str) {
                    Some("hello") => {
                        *delay = INITIAL_RECONNECT_DELAY;
                        shared.update_status(|status| status.realtime = RealtimeState::Connected);
                        shared.request_sync();
                    }
                    Some("goodbye") => return Ok(Outcome::Closed),
                    Some("pong") => {}
                    _ => shared.handle_realtime_event(&event),
                }
            }
            Ok(Frame::Close(_)) => return Ok(Outcome::Closed),
            Ok(_) => last_message = Instant::now(),
            Err(tungstenite::Error::Io(error)) if matches!(error.kind(), ErrorKind::WouldBlock | ErrorKind::TimedOut) => {}
            Err(tungstenite::Error::ConnectionClosed | tungstenite::Error::AlreadyClosed) => return Ok(Outcome::Closed),
            Err(error) => return Err(error.into()),
        }
        if last_message.elapsed() > STALE_CONNECTION_AGE {
            return Ok(Outcome::Closed);
        }
        if last_ping.elapsed() > PING_INTERVAL {
            ping_id += 1;
            socket.send(Frame::text(json!({ "id": ping_id, "type": "ping" }).to_string()))?;
            last_ping = Instant::now();
        }
    }
    let _ = socket.close(None);
    Ok(Outcome::Closed)
}
