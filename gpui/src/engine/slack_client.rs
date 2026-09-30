use std::collections::HashMap;
use std::fmt;
use std::sync::{Condvar, Mutex};
use std::time::{Duration, Instant};

use serde::de::DeserializeOwned;
use serde_json::Value;

use crate::engine::config::Credentials;

const CONCURRENCY_PER_METHOD: usize = 4;
const DEFAULT_RETRY_SECONDS: u64 = 5;

#[derive(Debug, Clone)]
pub struct SlackError {
    pub method: String,
    pub code: String,
    pub needed: Option<String>,
}

impl SlackError {
    pub fn new(method: &str, code: impl Into<String>) -> Self {
        Self { method: method.into(), code: code.into(), needed: None }
    }
}

impl fmt::Display for SlackError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "{} failed: {}", self.method, self.code)
    }
}

impl std::error::Error for SlackError {}

pub type Params<'a> = &'a [(&'a str, String)];

#[derive(Default)]
struct MethodState {
    active: usize,
    paused_until: Option<Instant>,
}

pub struct SlackClient {
    credentials: Credentials,
    agent: ureq::Agent,
    methods: Mutex<HashMap<String, MethodState>>,
    available: Condvar,
}

impl SlackClient {
    pub fn new(credentials: Credentials) -> Self {
        let agent = ureq::Agent::config_builder()
            .http_status_as_error(false)
            .timeout_global(Some(Duration::from_secs(60)))
            .build()
            .into();
        Self { credentials, agent, methods: Mutex::new(HashMap::new()), available: Condvar::new() }
    }

    pub fn realtime_cookie(&self) -> Option<String> {
        self.credentials.session_token.as_ref()?;
        self.credentials.session_cookie.as_ref().map(|cookie| format!("d={cookie}"))
    }

    fn acquire(&self, method: &str) {
        let mut methods = self.methods.lock().unwrap();
        loop {
            let state = methods.entry(method.to_string()).or_default();
            let now = Instant::now();
            if let Some(until) = state.paused_until.filter(|until| *until > now) {
                methods = self.available.wait_timeout(methods, until - now).unwrap().0;
                continue;
            }
            if state.active < CONCURRENCY_PER_METHOD {
                state.active += 1;
                return;
            }
            methods = self.available.wait(methods).unwrap();
        }
    }

    fn release(&self, method: &str, pause: Option<Duration>) {
        let mut methods = self.methods.lock().unwrap();
        let state = methods.entry(method.to_string()).or_default();
        state.active = state.active.saturating_sub(1);
        if let Some(pause) = pause {
            let until = Instant::now() + pause;
            state.paused_until = Some(state.paused_until.map_or(until, |existing| existing.max(until)));
        }
        self.available.notify_all();
    }

    fn send(&self, method: &str, params: Params) -> Result<(u16, Option<u64>, Value), SlackError> {
        let mut form: Vec<(&str, &str)> = params.iter().map(|(key, value)| (*key, value.as_str())).collect();
        let url = format!("{}/api/{}", self.credentials.origin, method);
        let mut request = self.agent.post(&url);
        if let Some(token) = &self.credentials.session_token {
            form.push(("token", token));
            if let Some(cookie) = &self.credentials.session_cookie {
                request = request.header("cookie", format!("d={cookie}"));
            }
        } else if let Some(token) = &self.credentials.user_token {
            request = request.header("authorization", format!("Bearer {token}"));
        }
        let mut response = request.send_form(form).map_err(|error| SlackError::new(method, error.to_string()))?;
        let status = response.status().as_u16();
        let retry_after = response
            .headers()
            .get("retry-after")
            .and_then(|value| value.to_str().ok())
            .and_then(|value| value.parse().ok());
        let body = response.body_mut().read_json::<Value>().unwrap_or(Value::Null);
        Ok((status, retry_after, body))
    }

    pub fn call_value(&self, method: &str, params: Params) -> Result<Value, SlackError> {
        loop {
            self.acquire(method);
            let result = self.send(method, params);
            let pause = match &result {
                Ok((429, retry_after, _)) => Some(Duration::from_secs(retry_after.unwrap_or(DEFAULT_RETRY_SECONDS))),
                _ => None,
            };
            self.release(method, pause);
            let (status, _, body) = result?;
            if status == 429 {
                continue;
            }
            if body.get("ok").and_then(Value::as_bool) != Some(true) {
                let code = body.get("error").and_then(Value::as_str).map_or_else(|| format!("http_{status}"), String::from);
                let needed = body.get("needed").and_then(Value::as_str).map(String::from);
                return Err(SlackError { method: method.into(), code, needed });
            }
            return Ok(body);
        }
    }

    pub fn call<T: DeserializeOwned>(&self, method: &str, params: Params) -> Result<T, SlackError> {
        let body = self.call_value(method, params)?;
        serde_json::from_value(body).map_err(|error| SlackError::new(method, format!("invalid_response: {error}")))
    }

    pub fn paginate<T: DeserializeOwned>(&self, method: &str, key: &str, params: Params) -> Result<Vec<T>, SlackError> {
        let mut results = Vec::new();
        let mut cursor: Option<String> = None;
        loop {
            let mut page_params: Vec<(&str, String)> = params.to_vec();
            if let Some(cursor) = &cursor {
                page_params.push(("cursor", cursor.clone()));
            }
            let page = self.call_value(method, &page_params)?;
            if let Some(entries) = page.get(key) {
                let entries: Vec<T> = serde_json::from_value(entries.clone())
                    .map_err(|error| SlackError::new(method, format!("invalid_response: {error}")))?;
                results.extend(entries);
            }
            cursor = page
                .pointer("/response_metadata/next_cursor")
                .and_then(Value::as_str)
                .filter(|cursor| !cursor.is_empty())
                .map(String::from);
            if cursor.is_none() {
                return Ok(results);
            }
        }
    }
}
