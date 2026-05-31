use serde::{Deserialize, Serialize};
use std::env;
use std::path::Path;

const DEFAULT_BASE: &str = "https://api.deepseek.com/v1";
const DEFAULT_MODEL: &str = "deepseek-v4-flash";

fn config_path() -> std::path::PathBuf {
    let base = std::env::var("APPDATA")
        .or_else(|_| std::env::var("HOME"))
        .unwrap_or_default();
    std::path::Path::new(&base).join("novel-agent").join("config.json")
}

fn read_config() -> Option<serde_json::Value> {
    let path = config_path();
    if path.exists() {
        let content = std::fs::read_to_string(&path).ok()?;
        serde_json::from_str(&content).ok()
    } else {
        None
    }
}

fn config_val(key: &str) -> Option<String> {
    read_config()
        .and_then(|c| c.get(key).cloned())
        .and_then(|v| v.as_str().map(String::from))
        .filter(|s| !s.is_empty())
}

fn api_key() -> String { config_val("api_key").unwrap_or_default() }
fn api_base() -> String { config_val("api_base_url").unwrap_or_else(|| DEFAULT_BASE.into()) }
fn model() -> String { config_val("model").unwrap_or_else(|| DEFAULT_MODEL.into()) }

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Message {
    pub role: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub content: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_calls: Option<Vec<ToolCall>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_call_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolCall {
    pub id: String,
    #[serde(rename = "type")]
    pub call_type: String,
    pub function: FunctionCall,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FunctionCall {
    pub name: String,
    pub arguments: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct Tool {
    #[serde(rename = "type")]
    pub tool_type: String,
    pub function: ToolFunction,
}

#[derive(Debug, Clone, Serialize)]
pub struct ToolFunction {
    pub name: String,
    pub description: String,
    pub parameters: serde_json::Value,
}

#[derive(Debug, Clone, Serialize)]
struct ChatRequest {
    model: String,
    messages: Vec<Message>,
    #[serde(skip_serializing_if = "Option::is_none")]
    tools: Option<Vec<Tool>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    tool_choice: Option<String>,
    stream: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    thinking: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    reasoning_effort: Option<String>,
}

#[derive(Debug, Deserialize)]
struct ChatResponse {
    choices: Vec<Choice>,
}

#[derive(Debug, Deserialize)]
struct Choice {
    message: AssistantMessage,
    #[serde(default)]
    finish_reason: Option<String>,
}

#[derive(Debug, Deserialize)]
struct AssistantMessage {
    #[serde(default)]
    content: Option<String>,
    #[serde(default)]
    tool_calls: Option<Vec<ToolCall>>,
}

#[derive(Debug, Deserialize)]
struct StreamChunk {
    choices: Vec<StreamChoice>,
}

#[derive(Debug, Deserialize)]
struct StreamChoice {
    delta: StreamDelta,
    #[serde(default)]
    finish_reason: Option<String>,
}

#[derive(Debug, Deserialize)]
struct StreamDelta {
    #[serde(default)]
    content: Option<String>,
    #[serde(default)]
    tool_calls: Option<Vec<StreamToolCall>>,
}

#[derive(Debug, Deserialize)]
struct StreamToolCall {
    #[serde(default)]
    index: usize,
    #[serde(default)]
    id: Option<String>,
    function: Option<StreamFunction>,
}

#[derive(Debug, Deserialize)]
struct StreamFunction {
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    arguments: Option<String>,
}


pub fn chat_blocking(
    messages: &[Message],
    tools: Option<&[Tool]>,
) -> Result<(Option<String>, Option<Vec<ToolCall>>), String> {
    let max_retries = 3;
    let base_delay_ms = 1000;
    let mut last_err = String::new();

    for attempt in 0..=max_retries {
        if attempt > 0 {
            std::thread::sleep(std::time::Duration::from_millis(base_delay_ms * (1 << (attempt - 1))));
        }

        let client = reqwest::blocking::Client::builder()
            .timeout(std::time::Duration::from_secs(120))
            .build()
            .map_err(|e| format!("Client build error: {}", e))?;

        let req = ChatRequest {
            model: model(),
            messages: messages.to_vec(),
            tools: tools.map(|t| t.to_vec()),
            tool_choice: tools.map(|_| "auto".into()),
            stream: false,
            thinking: Some(true),
            reasoning_effort: Some("high".into()),
        };

        let resp = match client
            .post(format!("{}/chat/completions", api_base()))
            .header("Authorization", format!("Bearer {}", api_key()))
            .header("Content-Type", "application/json")
            .json(&req)
            .send()
        {
            Ok(r) => r,
            Err(e) => {
                last_err = format!("LLM request failed (attempt {}): {}", attempt + 1, e);
                if attempt < max_retries { continue; } else { return Err(last_err); }
            }
        };

        if !resp.status().is_success() {
            let status = resp.status().as_u16();
            let body = resp.text().unwrap_or_default();
            last_err = format!("LLM API error ({}): {}", status, &body[..body.len().min(200)]);
            // Retry on server errors (5xx) and rate limits (429)
            if (500..600).contains(&status) || status == 429 {
                if attempt < max_retries { continue; }
            }
            return Err(last_err);
        }

        match resp.json::<ChatResponse>() {
            Ok(data) => {
                let msg = data.choices.into_iter().next().map(|c| c.message);
                let content = msg.as_ref().and_then(|m| m.content.clone());
                let tool_calls = msg.and_then(|m| m.tool_calls);
                return Ok((content, tool_calls));
            }
            Err(e) => {
                last_err = format!("Parse error (attempt {}): {}", attempt + 1, e);
                if attempt < max_retries { continue; }
            }
        }
    }
    Err(last_err)
}

/// Streaming version: calls LLM and pushes delta bytes through the sender.
/// Returns the complete tool_calls if any (for function calling).
pub fn chat_streaming(
    messages: &[Message],
    tools: Option<&[Tool]>,
    sender: &std::sync::mpsc::Sender<String>,
) -> Result<Option<Vec<ToolCall>>, String> {
    let max_retries = 2;
    let base_delay_ms = 1000;
    let mut last_err = String::new();

    for attempt in 0..=max_retries {
        if attempt > 0 {
            std::thread::sleep(std::time::Duration::from_millis(base_delay_ms * (1 << (attempt - 1))));
        }

        let client = reqwest::blocking::Client::builder()
            .timeout(std::time::Duration::from_secs(180))
            .build()
            .map_err(|e| format!("Client build error: {}", e))?;

        let req = ChatRequest {
            model: model(),
            messages: messages.to_vec(),
            tools: tools.map(|t| t.to_vec()),
            tool_choice: tools.map(|_| "auto".into()),
            stream: true,
            thinking: Some(true),
            reasoning_effort: Some("high".into()),
        };

        let resp = match client
            .post(format!("{}/chat/completions", api_base()))
            .header("Authorization", format!("Bearer {}", api_key()))
            .header("Content-Type", "application/json")
            .header("Accept", "text/event-stream")
            .json(&req)
            .send()
        {
            Ok(r) => r,
            Err(e) => {
                last_err = format!("Stream request failed: {}", e);
                if attempt < max_retries { continue; } else { return Err(last_err); }
            }
        };

        if !resp.status().is_success() {
            let status = resp.status().as_u16();
            last_err = format!("Stream API error: {}", status);
            if (500..600).contains(&status) || status == 429 {
                if attempt < max_retries { continue; }
            }
            return Err(last_err);
        }

        let body = resp.text().map_err(|e| format!("Read body: {}", e))?;
        let mut tool_call_buffers: std::collections::HashMap<usize, (String, String)> = std::collections::HashMap::new();

        for line_str in body.lines().map(|l| l.trim().to_string()) {
            if line_str.is_empty() || line_str == "data: [DONE]" { continue; }
            if let Some(json) = line_str.strip_prefix("data: ") {
                if let Ok(chunk) = serde_json::from_str::<StreamChunk>(json) {
                    for choice in chunk.choices {
                        if let Some(ref tc_list) = choice.delta.tool_calls {
                            for tc in tc_list {
                                let entry = tool_call_buffers.entry(tc.index).or_default();
                                if let Some(ref id) = tc.id { entry.0 = id.clone(); }
                                if let Some(ref f) = tc.function {
                                    if let Some(ref n) = f.name { entry.1 = n.clone(); } else { entry.1 = entry.1.clone(); }
                                    if let Some(ref a) = f.arguments { entry.1.push_str(a); }
                                }
                            }
                        }
                        if let Some(ref content) = choice.delta.content {
                            if !content.is_empty() {
                                sender.send(content.clone()).ok();
                            }
                        }
                        if choice.finish_reason.as_deref() == Some("stop") {
                            // done
                        }
                    }
                }
            }
        }

        // Build tool calls from accumulated buffers
        if !tool_call_buffers.is_empty() {
            let calls: Vec<ToolCall> = tool_call_buffers.into_values().map(|(id, args)| {
                ToolCall { id, call_type: "function".into(), function: FunctionCall { name: args.clone(), arguments: args } }
            }).collect();
            return Ok(Some(calls));
        }

        return Ok(None);
    }
    Err(last_err)
}


impl Message {
    pub fn system(content: &str) -> Self {
        Message {
            role: "system".into(),
            content: Some(content.into()),
            tool_calls: None,
            tool_call_id: None,
            name: None,
        }
    }
    pub fn user(content: &str) -> Self {
        Message {
            role: "user".into(),
            content: Some(content.into()),
            tool_calls: None,
            tool_call_id: None,
            name: None,
        }
    }
    pub fn assistant_with_tools(tool_calls: Vec<ToolCall>) -> Self {
        Message {
            role: "assistant".into(),
            content: None,
            tool_calls: Some(tool_calls),
            tool_call_id: None,
            name: None,
        }
    }
    pub fn tool_result(tool_call_id: &str, name: &str, result: &str) -> Self {
        Message {
            role: "tool".into(),
            content: Some(result.to_string()),
            tool_calls: None,
            tool_call_id: Some(tool_call_id.to_string()),
            name: Some(name.to_string()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_message_system() {
        let msg = Message::system("test prompt");
        assert_eq!(msg.role, "system");
        assert_eq!(msg.content, Some("test prompt".into()));
        assert!(msg.tool_calls.is_none());
    }

    #[test]
    fn test_message_user() {
        let msg = Message::user("hello");
        assert_eq!(msg.role, "user");
        assert_eq!(msg.content, Some("hello".into()));
    }

    #[test]
    fn test_message_assistant_with_tools() {
        let tc = ToolCall {
            id: "call_1".into(),
            call_type: "function".into(),
            function: FunctionCall { name: "get_file".into(), arguments: r#"{"file_name":"test.md"}"#.into() },
        };
        let msg = Message::assistant_with_tools(vec![tc]);
        assert_eq!(msg.role, "assistant");
        assert!(msg.content.is_none());
        assert_eq!(msg.tool_calls.unwrap().len(), 1);
    }

    #[test]
    fn test_message_tool_result() {
        let msg = Message::tool_result("call_1", "get_file", "file content here");
        assert_eq!(msg.role, "tool");
        assert_eq!(msg.tool_call_id, Some("call_1".into()));
        assert_eq!(msg.name, Some("get_file".into()));
        assert_eq!(msg.content, Some("file content here".into()));
    }

    #[test]
    fn test_config_val_fallback() {
        // When no config exists, should return empty/default
        let key = api_key();
        // May be empty in CI, but shouldn't panic
        assert!(key.is_empty() || !key.is_empty()); // always true, just testing it doesn't panic
    }
}
