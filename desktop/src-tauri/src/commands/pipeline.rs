use crate::AppState;
use serde_json::json;
use tauri::{Emitter, State};

fn prompt_for(p: &str) -> &'static str {
    match p { "summary" => include_str!("../../prompts/pipeline_summary.md"), "world" => include_str!("../../prompts/pipeline_world.md"), _ => "" }
}
fn output_for(p: &str) -> &'static str {
    match p { "summary" => "summary.md", "world" => "world_model.md", _ => "output.md" }
}

#[tauri::command]
pub fn run_pipeline(
    app: tauri::AppHandle, state: State<'_, AppState>,
    book_id: Option<String>, book_name: Option<String>, pipeline: String,
) -> Result<serde_json::Value, String> {
    let id = crate::storage::resolve_book_id(&state.storage_root, book_id.as_deref(), book_name.as_deref())?;
    let prompt = prompt_for(&pipeline);
    if prompt.is_empty() { return Err(format!("Unknown pipeline: {}", pipeline)); }
    let out_name = output_for(&pipeline).to_string();
    let task_id = uuid::Uuid::new_v4().to_string().split('-').next().unwrap_or("t").to_string();
    let result_tid = task_id.clone();
    let storage = state.storage_root.clone();

    std::thread::spawn(move || {
        let t = task_id; let p = pipeline; let o = out_name;
        let emit = |event: &str, data: serde_json::Value| { app.emit("pipeline:event", &json!({"event":event,"data":data})).ok(); };
        emit("ack", json!({"task_id":t,"pipeline":p.clone()}));

        let book_dir = std::path::Path::new(&storage).join(&id);
        let chapters_dir = book_dir.join("chapters");
        let mut src = String::new();
        if let Ok(ents) = std::fs::read_dir(&chapters_dir) {
            let mut files: Vec<_> = ents.filter_map(|e| e.ok()).collect();
            files.sort_by_key(|e| e.file_name());
            for f in files.iter().take(50) {
                if let Ok(c) = std::fs::read_to_string(f.path()) { src.push_str(&c); src.push_str("\n\n---\n\n"); }
            }
        }
        if src.is_empty() { emit("error", json!({"message":"No chapters found","task_id":t})); return; }
        emit("progress", json!({"title":p,"status":"running","task_id":t}));

        let msgs = vec![crate::engine::llm::Message::system(prompt), crate::engine::llm::Message::user(&format!("书名: {}\n\n{}", id, &src[..src.len().min(120000)]))];
        match crate::engine::llm::chat_blocking(&msgs, None) {
            Ok((Some(ans), _)) => {
                let (fp, _) = match crate::commands::archive::resolve_file_path(&book_dir, &o) { Ok(p) => p, Err(e) => { emit("error", json!({"message":e,"task_id":t})); return; } };
                if let Err(e) = std::fs::write(&fp, &ans) { emit("error", json!({"message":format!("Write: {}",e),"task_id":t})); return; }
                crate::commands::archive::git_commit(&book_dir, &o, &format!("[AI_Update] pipeline {}", p)).ok();
                emit("done", json!({"pipeline":p,"output_file":o,"size":ans.len(),"task_id":t}));
            }
            Err(e) => { emit("error", json!({"message":e,"task_id":t})); }
            _ => { emit("error", json!({"message":"Empty response","task_id":t})); }
        }
    });

    Ok(json!({"task_id": result_tid, "status": "started"}))
}
