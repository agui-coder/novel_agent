use crate::sidecar::{SidecarManager, SidecarResponse};
use crate::AppState;
use serde::{Deserialize, Serialize};
use std::sync::Mutex;
use tauri::State;

/// Global sidecar manager, lazily initialized
static SIDECAR: once_cell::sync::Lazy<Mutex<Option<SidecarManager>>> =
    once_cell::sync::Lazy::new(|| Mutex::new(None));

fn get_sidecar() -> Result<&'static Mutex<Option<SidecarManager>>, String> {
    Ok(&SIDECAR)
}

fn ensure_sidecar() -> Result<(), String> {
    let guard = get_sidecar()?;
    let mut mgr_opt = guard.lock().map_err(|e| format!("Lock error: {}", e))?;
    if mgr_opt.is_none() {
        // Find Python sidecar script
        let candidates = vec![
            "python_sidecar/main.py",
            "../python_sidecar/main.py",
            "../../novel_git_server/engine/sidecar_main.py",
        ];
        let script = candidates.iter().find(|p| std::path::Path::new(p).exists())
            .unwrap_or(&"../../novel_git_server/engine/sidecar_main.py");

        let python = if cfg!(windows) { "python" } else { "python3" };
        *mgr_opt = Some(SidecarManager::new(python.to_string(), script.to_string()));
    }
    Ok(())
}

// ── Commands ───────────────────────────────────────────────

#[derive(Debug, Serialize)]
pub struct SidecarStatus {
    pub running: bool,
    pub pid: Option<u32>,
}

#[tauri::command]
pub fn start_sidecar(state: State<AppState>) -> Result<SidecarStatus, String> {
    ensure_sidecar()?;
    let guard = get_sidecar()?;
    let mgr_opt = guard.lock().map_err(|e| format!("Lock error: {}", e))?;
    if let Some(ref mgr) = *mgr_opt {
        mgr.ensure_started()?;
    }
    Ok(SidecarStatus { running: true, pid: None })
}

#[tauri::command]
pub fn stop_sidecar() -> Result<SidecarStatus, String> {
    if let Ok(guard) = get_sidecar() {
        if let Ok(mut mgr_opt) = guard.lock() {
            if let Some(ref mgr) = *mgr_opt {
                mgr.stop();
            }
            *mgr_opt = None;
        }
    }
    Ok(SidecarStatus { running: false, pid: None })
}

#[tauri::command]
pub fn sidecar_deduce(
    state: State<AppState>,
    book_id: String,
    book_name: Option<String>,
    active_file: String,
    intent: String,
    file_type: Option<String>,
) -> Result<serde_json::Value, String> {
    ensure_sidecar()?;
    let guard = get_sidecar()?;
    let mgr_opt = guard.lock().map_err(|e| format!("Lock error: {}", e))?;
    let mgr = mgr_opt.as_ref().ok_or("Sidecar not started")?;

    let response = mgr.send_request("deduce", serde_json::json!({
        "book_id": book_id,
        "book_name": book_name.unwrap_or_default(),
        "active_file": active_file,
        "intent": intent,
        "file_type": file_type.unwrap_or_default(),
        "storage_root": state.storage_root,
    }))?;

    Ok(response.result.unwrap_or(serde_json::json!({"status": "error", "message": "No result"})))
}

#[tauri::command]
pub fn sidecar_deduce_stream(
    state: State<AppState>,
    book_id: String,
    book_name: Option<String>,
    active_file: String,
    intent: String,
    file_type: Option<String>,
) -> Result<serde_json::Value, String> {
    // For streaming, return task_id immediately, frontend uses SSE endpoint
    ensure_sidecar()?;
    let guard = get_sidecar()?;
    let mgr_opt = guard.lock().map_err(|e| format!("Lock error: {}", e))?;
    let mgr = mgr_opt.as_ref().ok_or("Sidecar not started")?;

    let response = mgr.send_request("deduce_stream", serde_json::json!({
        "book_id": book_id,
        "book_name": book_name.unwrap_or_default(),
        "active_file": active_file,
        "intent": intent,
        "file_type": file_type.unwrap_or_default(),
        "storage_root": state.storage_root,
    }))?;

    Ok(response.result.unwrap_or(serde_json::json!({"task_id": "", "status": "error"})))
}
