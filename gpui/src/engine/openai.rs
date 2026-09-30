use std::thread;
use std::time::Duration;

use anyhow::{Result, anyhow};
use serde_json::{Value, json};

const RESPONSES_URL: &str = "https://api.openai.com/v1/responses";
const MAX_ATTEMPTS: u32 = 4;

pub struct FunctionCall {
    pub call_id: String,
    pub name: String,
    pub arguments: String,
}

pub struct OpenAIClient {
    api_key: String,
    agent: ureq::Agent,
}

impl OpenAIClient {
    pub fn new(api_key: String) -> Self {
        let agent = ureq::Agent::config_builder()
            .http_status_as_error(false)
            .timeout_global(Some(Duration::from_secs(300)))
            .build()
            .into();
        Self { api_key, agent }
    }

    pub fn respond(&self, model: &str, instructions: &str, input: &[Value], tools: &Value) -> Result<Vec<Value>> {
        let body = json!({
            "model": model,
            "instructions": instructions,
            "input": input,
            "tools": tools,
            "store": false,
            "include": ["reasoning.encrypted_content"],
        });
        for attempt in 1..=MAX_ATTEMPTS {
            let mut response = self
                .agent
                .post(RESPONSES_URL)
                .header("authorization", format!("Bearer {}", self.api_key))
                .send_json(&body)?;
            let status = response.status().as_u16();
            if (status == 429 || status >= 500) && attempt < MAX_ATTEMPTS {
                let seconds = response
                    .headers()
                    .get("retry-after")
                    .and_then(|value| value.to_str().ok())
                    .and_then(|value| value.parse().ok())
                    .unwrap_or(2u64.pow(attempt));
                thread::sleep(Duration::from_secs(seconds));
                continue;
            }
            let result: Value = response.body_mut().read_json().unwrap_or(Value::Null);
            if status >= 400 || result.get("error").is_some_and(|error| !error.is_null()) {
                let message = result
                    .pointer("/error/message")
                    .and_then(Value::as_str)
                    .map_or_else(|| format!("OpenAI request failed with status {status}"), String::from);
                return Err(anyhow!(message));
            }
            return Ok(result.get("output").and_then(Value::as_array).cloned().unwrap_or_default());
        }
        Err(anyhow!("OpenAI request failed after {MAX_ATTEMPTS} attempts"))
    }
}

pub fn function_calls(output: &[Value]) -> Vec<FunctionCall> {
    output
        .iter()
        .filter(|item| item.get("type").and_then(Value::as_str) == Some("function_call"))
        .filter_map(|item| {
            Some(FunctionCall {
                call_id: item.get("call_id")?.as_str()?.to_string(),
                name: item.get("name")?.as_str()?.to_string(),
                arguments: item.get("arguments")?.as_str()?.to_string(),
            })
        })
        .collect()
}
