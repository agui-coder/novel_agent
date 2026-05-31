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

fn resolve(sr: &str, bid: Option<String>, bn: Option<String>, af: &str, intent: &str, _ft: Option<String>) -> Result<(String, AgentType, usize), String> {
    let id = crate::storage::resolve_book_id(sr, bid.as_deref(), bn.as_deref())?;
    let at = match af {
        "chapter_outline.md"|"brainstorm.md"|"master_outline.md"|"arc_outline.md" => AgentType::Outline,
        "chapter_draft.md" => if intent.contains("审核")||intent.contains("审查") { AgentType::Review } else { AgentType::Continuation },
        _ => AgentType::Continuation,
    };
    Ok((id, at, match at { AgentType::Continuation => 45, AgentType::Review => 10, AgentType::Outline => 30 }))
}

#[tauri::command]
pub fn deduce_stream(app: tauri::AppHandle, state: State<'_, AppState>, book_id: Option<String>, book_name: Option<String>, active_file: String, intent: String, file_type: Option<String>) -> Result<DeduceResult, String> {
    let (id, at, max_iter) = resolve(&state.storage_root, book_id, book_name, &active_file, &intent, file_type)?;
    let task_id = uuid::Uuid::new_v4().to_string().split('-').next().unwrap_or("t").to_string();
    let cancel = Arc::new(AtomicBool::new(false));
    CANCEL_FLAGS.lock().unwrap().insert(task_id.clone(), cancel.clone());
    let (tx, rx) = mpsc::channel::<agent::AgentEvent>();
    std::thread::spawn(move || { for e in rx { app.emit("deduce:event", &e).ok(); } });
    let tid = task_id.clone();
    std::thread::spawn(move || {
        let tools = ToolRegistry::new();
        if let Err(e) = agent::run_agent_streaming(at, &id, &intent, &active_file, &tools, max_iter, &tx, Some(&cancel)) { tx.send(agent::AgentEvent::error(&e)).ok(); }
        CANCEL_FLAGS.lock().unwrap().remove(&tid);
    });
    Ok(DeduceResult { task_id })
}

#[tauri::command]
pub fn deduce_blocking(state: State<'_, AppState>, book_id: Option<String>, book_name: Option<String>, active_file: String, intent: String, file_type: Option<String>) -> Result<DeduceBlockingResult, String> {
    let (id, at, max_iter) = resolve(&state.storage_root, book_id, book_name, &active_file, &intent, file_type)?;
    let task_id = uuid::Uuid::new_v4().to_string().split('-').next().unwrap_or("t").to_string();
    let (tx, rx) = mpsc::channel(); let tools = ToolRegistry::new();
    agent::run_agent_streaming(at, &id, &intent, &active_file, &tools, max_iter, &tx, None)?;
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
