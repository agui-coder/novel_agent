use crate::engine::llm::{self, Message};
use crate::engine::tools::ToolRegistry;
use serde::Serialize;
use std::sync::{mpsc, Arc, atomic::AtomicBool};

#[derive(Debug, Clone, Serialize)]
pub struct AgentEvent {
    pub event: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<serde_json::Value>,
}

impl AgentEvent {
    pub fn ack(task_id: &str) -> Self {
        AgentEvent { event: "ack".into(), data: Some(serde_json::json!({"task_id": task_id})) }
    }
    pub fn stage(node_title: &str, stage: &str, status: &str) -> Self {
        AgentEvent { event: "stage".into(), data: Some(serde_json::json!({"node_title": node_title, "stage": stage, "status": status})) }
    }
    pub fn delta(text: &str) -> Self {
        AgentEvent { event: "delta".into(), data: Some(serde_json::json!({"text": text})) }
    }
    pub fn done(answer: &str, task_id: &str) -> Self {
        AgentEvent { event: "done".into(), data: Some(serde_json::json!({"answer": answer, "task_id": task_id})) }
    }
    pub fn error(msg: &str) -> Self {
        AgentEvent { event: "error".into(), data: Some(serde_json::json!({"message": msg})) }
    }
}

#[derive(Debug, Clone, Copy)]
pub enum AgentType {
    Continuation,
    Review,
    Outline,
}

/// Run agent, pushing events through sender as they happen.
pub fn run_agent_streaming(
    agent_type: AgentType,
    book_id: &str,
    intent: &str,
    active_file: &str,
    tools: &ToolRegistry,
    max_iterations: usize,
    sender: &mpsc::Sender<AgentEvent>,
    cancel: Option<&Arc<AtomicBool>>,
) -> Result<(), String> {
    let task_id = uuid::Uuid::new_v4().to_string().split('-').next().unwrap_or("t").to_string();
    sender.send(AgentEvent::ack(&task_id)).ok();

    let system_prompt = match agent_type {
        AgentType::Continuation => crate::engine::prompts::CONTINUATION_PROMPT,
        AgentType::Review => crate::engine::prompts::REVIEW_PROMPT,
        AgentType::Outline => crate::engine::prompts::OUTLINE_DISCUSS_PROMPT,
    };

    let user_content = format!(
        "当前 book_id: {}\n当前目标文件: {}\n作者指令: {}",
        book_id, active_file, intent
    );

    let mut messages: Vec<Message> = vec![
        Message::system(system_prompt),
        Message::user(&user_content),
    ];

    let mut iteration = 0;
    let mut final_answer = String::new();

    loop {
        if iteration >= max_iterations {
            sender.send(AgentEvent::error("Agent 达到最大迭代次数")).ok();
            break;
        }
        iteration += 1;

        if let Some(c) = cancel {
            if c.load(std::sync::atomic::Ordering::Relaxed) {
                sender.send(AgentEvent::error("已取消")).ok();
                return Ok(());
            }
        }

        sender.send(AgentEvent::stage(&format!("LLM (round {})", iteration), "llm_start", "started")).ok();

        // Use streaming to get real-time deltas + tool calls
        let (delta_tx, delta_rx) = std::sync::mpsc::channel::<String>();
        let tool_calls = match llm::chat_streaming(&messages, Some(tools.schemas()), &delta_tx) {
            Ok(tc) => {
                drop(delta_tx); // close sender so receiver loop ends
                for chunk in delta_rx {
                    final_answer.push_str(&chunk);
                    sender.send(AgentEvent::delta(&chunk)).ok();
                }
                tc
            }
            Err(e) => {
                // Fallback to blocking
                let (content, tc) = match llm::chat_blocking(&messages, Some(tools.schemas())) {
                    Ok((c, tc)) => (c, tc),
                    Err(e2) => { sender.send(AgentEvent::error(&e2)).ok(); return Err(e2); }
                };
                if let Some(ref c) = content { final_answer.push_str(c); sender.send(AgentEvent::delta(c)).ok(); }
                tc
            }
        };

        sender.send(AgentEvent::stage(&format!("LLM done (round {})", iteration), "llm_end", "finished")).ok();

        if let Some(ref tc_list) = tool_calls {
            if !tc_list.is_empty() {
                for tc in tc_list {
                    let tn = &tc.function.name;
                    let args: serde_json::Value = serde_json::from_str(&tc.function.arguments).unwrap_or(serde_json::json!({}));
                    sender.send(AgentEvent::stage(&format!("Tool: {}", tn), "tool_call", "started")).ok();
                    let r = tools.execute(tn, book_id, &args);
                    let rs = if r.is_error { format!("ERROR: {}", r.content) } else { r.content.clone() };
                    sender.send(AgentEvent::stage(&format!("Tool done: {}", tn), "tool_result", "finished")).ok();
                    messages.push(Message::assistant_with_tools(vec![tc.clone()]));
                    messages.push(Message::tool_result(&tc.id, tn, &rs));
                }
                continue;
            }
        }

        sender.send(AgentEvent::done(&final_answer, &task_id)).ok();
        break;
    }

    Ok(())
}
