use crate::AppState;
use serde::{Deserialize, Serialize};
use std::fs;
use tauri::State;

use crate::commands::archive::{git_commit, resolve_file_path};
use crate::storage::etag;

#[derive(Debug, Serialize)]
pub struct DraftActionResult {
    pub status: String,
    pub book_id: String,
    pub message: String,
}

#[derive(Debug, Deserialize)]
pub struct DraftWrite {
    pub file_name: String,
    pub section_path: String,
    pub content: String,
    pub base_etag: String,
}

fn do_append(storage_root: &str, book_id: Option<String>, book_name: Option<String>, file_name: &str, content: &str, base_etag: Option<String>) -> Result<(String, usize), String> {
    let id = crate::storage::resolve_book_id(storage_root, book_id.as_deref(), book_name.as_deref())?;
    let book_dir = std::path::Path::new(storage_root).join(&id);
    let (file_path, normalized_rel) = resolve_file_path(&book_dir, file_name)?;
    if let Some(ref be) = base_etag {
        if file_path.exists() {
            if *be != etag::compute_file_etag(&file_path)? { return Err(format!("ETag mismatch for {}", file_name)); }
        }
    }
    let mut existing = if file_path.exists() { fs::read_to_string(&file_path).map_err(|e| format!("Read error: {}", e))? } else { String::new() };
    if !existing.is_empty() && !existing.ends_with('\n') { existing.push('\n'); }
    existing.push_str(content);
    if !existing.ends_with('\n') { existing.push('\n'); }
    fs::write(&file_path, &existing).map_err(|e| format!("Write error: {}", e))?;
    git_commit(&book_dir, &normalized_rel, "[AI_Update] draft append")?;
    Ok((id, existing.len()))
}

#[tauri::command]
pub fn draft_append_section(
    state: State<AppState>, book_id: Option<String>, book_name: Option<String>,
    file_name: String, section_path: String, content: String,
    base_etag: Option<String>, origin: Option<String>, message: Option<String>,
) -> Result<DraftActionResult, String> {
    let _ = (origin, message);
    let (bid, _) = do_append(&state.storage_root, book_id, book_name, &file_name, &format!("\n\n{}", content), base_etag)?;
    Ok(DraftActionResult { status: "success".into(), book_id: bid, message: format!("Appended to '{}': {} chars", section_path, content.len()) })
}

#[tauri::command]
pub fn draft_replace_section(
    state: State<AppState>, book_id: Option<String>, book_name: Option<String>,
    file_name: String, section_path: String, content: String,
    base_etag: Option<String>, origin: Option<String>, message: Option<String>,
) -> Result<DraftActionResult, String> {
    let _ = (origin, message);
    let id = crate::storage::resolve_book_id(&state.storage_root, book_id.as_deref(), book_name.as_deref())?;
    let book_dir = std::path::Path::new(&state.storage_root).join(&id);
    let (file_path, normalized_rel) = resolve_file_path(&book_dir, &file_name)?;
    if let Some(ref be) = base_etag {
        if file_path.exists() && *be != etag::compute_file_etag(&file_path)? { return Err(format!("ETag mismatch for {}", file_name)); }
    }
    fs::write(&file_path, &content).map_err(|e| format!("Write error: {}", e))?;
    git_commit(&book_dir, &normalized_rel, "[AI_Update] draft replace")?;
    Ok(DraftActionResult { status: "success".into(), book_id: id, message: format!("Replaced '{}': {} chars", section_path, content.len()) })
}

#[tauri::command]
pub fn draft_sync_all(
    state: State<AppState>, book_id: Option<String>, book_name: Option<String>, writes: Vec<DraftWrite>,
) -> Result<Vec<DraftActionResult>, String> {
    let mut results = Vec::new();
    for write in writes {
        let (bid, _) = do_append(&state.storage_root, book_id.clone(), book_name.clone(), &write.file_name, &write.content, Some(write.base_etag))?;
        results.push(DraftActionResult { status: "success".into(), book_id: bid, message: format!("Synced {}", write.file_name) });
    }
    Ok(results)
}

#[tauri::command]
pub fn draft_confirm(
    state: State<AppState>, book_id: Option<String>, book_name: Option<String>,
    file_name: String, message: Option<String>,
) -> Result<DraftActionResult, String> {
    let id = crate::storage::resolve_book_id(&state.storage_root, book_id.as_deref(), book_name.as_deref())?;
    let book_dir = std::path::Path::new(&state.storage_root).join(&id);
    if !book_dir.join(&file_name).exists() { return Err("Draft file not found".into()); }
    git_commit(&book_dir, &file_name, &format!("[User_Edit] {}", message.unwrap_or_else(|| format!("confirm {}", file_name))))?;
    Ok(DraftActionResult { status: "success".into(), book_id: id, message: format!("Confirmed {}", file_name) })
}

#[tauri::command]
pub fn draft_rollback(
    state: State<AppState>, book_id: Option<String>, book_name: Option<String>, file_name: String,
) -> Result<DraftActionResult, String> {
    let id = crate::storage::resolve_book_id(&state.storage_root, book_id.as_deref(), book_name.as_deref())?;
    let book_dir = std::path::Path::new(&state.storage_root).join(&id);
    let repo = git2::Repository::open(&book_dir).map_err(|e| format!("Git error: {}", e))?;
    let head = repo.head().map_err(|e| format!("Git head error: {}", e))?;
    let commit = head.peel_to_commit().map_err(|e| format!("Git peel error: {}", e))?;
    let tree = commit.tree().map_err(|e| format!("Git tree error: {}", e))?;
    let entry = tree.get_path(std::path::Path::new(&file_name)).map_err(|_| format!("File not in git: {}", file_name))?;
    let blob = repo.find_blob(entry.id()).map_err(|e| format!("Git blob error: {}", e))?;
    fs::write(&book_dir.join(&file_name), blob.content()).map_err(|e| format!("Write error: {}", e))?;
    Ok(DraftActionResult { status: "success".into(), book_id: id, message: format!("Rolled back {}", file_name) })
}
