use crate::engine::agent::{self, AgentType};
use crate::engine::tools::ToolRegistry;
use crate::AppState;
use serde::Serialize;
use std::collections::HashMap;
use std::sync::{mpsc, Arc, Mutex, atomic::AtomicBool};
use tauri::{Emitter, State};

static CANCEL_FLAGS: std::sync::LazyLock<Mutex<HashMap<String, Arc<AtomicBool>>>> =
    std::sync::LazyLock::new(|| Mutex::new(HashMap::new()));

#[derive(Debug, Serialize, Clone)]
pub struct DeduceResult { pub task_id: String }

#[derive(Debug, Serialize, Clone)]
pub struct DeduceBlockingResult { pub task_id: String, pub answer: String }

struct AgentConfig { max_iter: usize, memory_window: usize, conv_state_key: Option<String> }

fn resolve(sr: &str, bid: Option<String>, bn: Option<String>, af: &str, intent: &str, _ft: Option<String>) -> Result<(String, AgentType, AgentConfig), String> {
    let id = crate::storage::resolve_book_id(sr, bid.as_deref(), bn.as_deref())?;
    let (at, cfg) = match af {
        "chapter_outline.md"|"brainstorm.md"|"master_outline.md"|"arc_outline.md" => (AgentType::Outline, AgentConfig{max_iter:30,memory_window:0,conv_state_key:Some("outline_state".into())}),
        "chapter_draft.md" => if intent.contains("审核")||intent.contains("审查") {
            (AgentType::Review, AgentConfig{max_iter:10,memory_window:10,conv_state_key:None})
        } else {
            (AgentType::Continuation, AgentConfig{max_iter:45,memory_window:10,conv_state_key:None})
        },
        "style_fingerprint.md"|"style_review.md"|"style_constraints_for_continuation.md"|"style_guide.md" => (AgentType::Style, AgentConfig{max_iter:15,memory_window:0,conv_state_key:None}),
        "world_model.md"|"status_card.md"|"domain_rules.md" => if intent.contains("考据")||intent.contains("research") {
            (AgentType::WorldOnline, AgentConfig{max_iter:10,memory_window:6,conv_state_key:None})
        } else {
            (AgentType::WorldRead, AgentConfig{max_iter:15,memory_window:6,conv_state_key:None})
        },
        _ => (AgentType::Continuation, AgentConfig{max_iter:45,memory_window:10,conv_state_key:None}),
    };
    Ok((id, at, cfg))
}

#[tauri::command]
pub fn deduce_stream(app: tauri::AppHandle, state: State<'_, AppState>, book_id: Option<String>, book_name: Option<String>, active_file: String, intent: String, file_type: Option<String>) -> Result<DeduceResult, String> {
    let (id, at, cfg) = resolve(&state.storage_root, book_id, book_name, &active_file, &intent, file_type)?;
    let task_id = uuid::Uuid::new_v4().to_string().split('-').next().unwrap_or("t").to_string();
    let cancel = Arc::new(AtomicBool::new(false));
    CANCEL_FLAGS.lock().unwrap().insert(task_id.clone(), cancel.clone());
    let (tx, rx) = mpsc::channel::<agent::AgentEvent>();
    std::thread::spawn(move || { for e in rx { app.emit("deduce:event", &e).ok(); } });
    let tid = task_id.clone();
    let sr = state.storage_root.clone();
    std::thread::spawn(move || {
        let tools = ToolRegistry::new(&sr);
        if let Err(e) = agent::run_agent_streaming(at, &id, &intent, &active_file, &tools, cfg.max_iter, &tx, Some(&cancel), &[]) { tx.send(agent::AgentEvent::error(&e)).ok(); }
        CANCEL_FLAGS.lock().unwrap().remove(&tid);
    });
    Ok(DeduceResult { task_id })
}

#[tauri::command]
pub fn deduce_blocking(state: State<'_, AppState>, book_id: Option<String>, book_name: Option<String>, active_file: String, intent: String, file_type: Option<String>) -> Result<DeduceBlockingResult, String> {
    let (id, at, cfg) = resolve(&state.storage_root, book_id, book_name, &active_file, &intent, file_type)?;
    let task_id = uuid::Uuid::new_v4().to_string().split('-').next().unwrap_or("t").to_string();
    let (tx, rx) = mpsc::channel();
    let sr = state.storage_root.clone();
    let tools = ToolRegistry::new(&sr);
    agent::run_agent_streaming(at, &id, &intent, &active_file, &tools, cfg.max_iter, &tx, None, &[])?;
    let mut answer = String::new();
    for e in rx {
        if e.event == "delta" { if let Some(ref d) = e.data { if let Some(t) = d.get("text").and_then(|v| v.as_str()) { answer.push_str(t); } } }
        if e.event == "done" { if let Some(ref d) = e.data { if let Some(t) = d.get("answer").and_then(|v| v.as_str()) { answer = t.to_string(); } } }
    }
    Ok(DeduceBlockingResult { task_id, answer })
}

#[tauri::command]
pub fn stop_generation(task_id: String) -> Result<(), String> {
    if let Some(flag) = CANCEL_FLAGS.lock().unwrap().get(&task_id) { flag.store(true, std::sync::atomic::Ordering::Relaxed); Ok(()) } else { Err("Task not found".into()) }
}
