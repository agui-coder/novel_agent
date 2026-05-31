use thiserror::Error;

#[derive(Debug, Error)]
pub enum LlmError {
    #[error("API error: {0}")]
    Api(String),
    #[error("Rate limited: {0}")]
    RateLimited(String),
    #[error("Empty response from LLM")]
    EmptyResponse,
    #[error("Tool call parse error: {0}")]
    ToolParse(String),
    #[error("Missing API key — configure in Settings")]
    MissingApiKey,
    #[error("Context length exceeded")]
    ContextLengthExceeded { body: String },
    #[error("Network error: {0}")]
    Network(String),
    #[error("Parse error: {0}")]
    Parse(String),
}

impl LlmError {
    pub fn is_retryable(&self) -> bool {
        matches!(self, Self::RateLimited(_) | Self::Network(_))
    }
    pub fn is_context_exceeded(&self) -> bool {
        matches!(self, Self::ContextLengthExceeded { .. })
    }
}

#[derive(Debug, Error)]
pub enum ToolError {
    #[error("Not found: {resource}")]
    NotFound { resource: String },
    #[error("Write conflict on {file}")]
    WriteConflict { file: String },
    #[error("Permission denied: {0}")]
    Permission(String),
    #[error("IO error: {0}")]
    Io(String),
    #[error("Validation error: {0}")]
    Validation(String),
    #[error("Unknown tool: {name}")]
    UnknownTool { name: String },
}

impl ToolError {
    pub fn is_retryable(&self) -> bool {
        matches!(self, Self::Io(_))
    }
}
