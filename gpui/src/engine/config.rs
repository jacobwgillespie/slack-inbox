use std::env;
use std::path::{Path, PathBuf};

use crate::engine::types::CredentialMode;

const ENVIRONMENT_FILE: &str = ".env.local";
const DEFAULT_DATABASE_PATH: &str = "data/slack.sqlite";
const DEFAULT_CLASSIFIER_MODEL: &str = "gpt-6-luna";

#[derive(Clone, Debug)]
pub struct Credentials {
    pub origin: String,
    pub user_token: Option<String>,
    pub session_token: Option<String>,
    pub session_cookie: Option<String>,
}

impl Credentials {
    pub fn mode(&self) -> CredentialMode {
        if self.session_token.is_some() {
            CredentialMode::Session
        } else if self.user_token.is_some() {
            CredentialMode::User
        } else {
            CredentialMode::None
        }
    }
}

#[derive(Clone, Debug)]
pub struct ClassifierConfig {
    pub api_key: String,
    pub model: String,
}

#[derive(Clone, Debug)]
pub struct Config {
    pub credentials: Credentials,
    pub database_path: PathBuf,
    pub classifier: Option<ClassifierConfig>,
    pub problems: Vec<String>,
}

fn find_project_directory() -> PathBuf {
    let current = env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
    current
        .ancestors()
        .find(|directory| directory.join(ENVIRONMENT_FILE).is_file())
        .map(Path::to_path_buf)
        .unwrap_or(current)
}

fn variable(name: &str) -> Option<String> {
    env::var(name).ok().map(|value| value.trim().to_string()).filter(|value| !value.is_empty())
}

fn credential_problems(credentials: &Credentials) -> Vec<String> {
    let mut problems = Vec::new();
    match credentials.session_cookie.as_deref() {
        Some(cookie) if cookie.starts_with("xoxc-") => problems.push(
            "SLACK_SESSION_COOKIE holds an xoxc- token. Put the token in SLACK_SESSION_TOKEN and the d cookie (xoxd-) in SLACK_SESSION_COOKIE.".into(),
        ),
        Some(cookie) if !cookie.starts_with("xoxd-") => {
            problems.push("SLACK_SESSION_COOKIE must be the value of the d cookie, which starts with xoxd-.".into())
        }
        _ => {}
    }
    if credentials.session_token.as_deref().is_some_and(|token| !token.starts_with("xoxc-")) {
        problems.push("SLACK_SESSION_TOKEN must start with xoxc-.".into());
    }
    if credentials.session_token.is_some() && credentials.session_cookie.is_none() {
        problems.push("SLACK_SESSION_TOKEN is set, but SLACK_SESSION_COOKIE is missing.".into());
    }
    if credentials.mode() == CredentialMode::None {
        problems.push(format!("Set SLACK_USER_TOKEN or SLACK_SESSION_TOKEN in {ENVIRONMENT_FILE}."));
    }
    problems
}

impl Config {
    pub fn load() -> Config {
        let project = find_project_directory();
        if variable("SLACK_INBOX_IGNORE_ENV_FILE").is_none() {
            let _ = dotenvy::from_path(project.join(ENVIRONMENT_FILE));
        }

        let credentials = Credentials {
            origin: variable("SLACK_API_ORIGIN").unwrap_or_else(|| "https://slack.com".into()),
            user_token: variable("SLACK_USER_TOKEN"),
            session_token: variable("SLACK_SESSION_TOKEN"),
            session_cookie: variable("SLACK_SESSION_COOKIE"),
        };
        let database_path = variable("SLACK_DATABASE_PATH")
            .map(PathBuf::from)
            .map(|path| if path.is_absolute() { path } else { project.join(path) })
            .unwrap_or_else(|| project.join(DEFAULT_DATABASE_PATH));
        let classifier = variable("OPENAI_API_KEY").map(|api_key| ClassifierConfig {
            api_key,
            model: variable("OPENAI_CLASSIFIER_MODEL").unwrap_or_else(|| DEFAULT_CLASSIFIER_MODEL.into()),
        });
        let problems = credential_problems(&credentials);
        Config { credentials, database_path, classifier, problems }
    }
}
