use crate::AppState;
use serde_json::{json, Value};
use std::sync::{Arc, Mutex};
use tauri::{Emitter, State};

const MAX_BATCH_CHAPTERS: usize = 50;
const MAX_WORKERS: usize = 4;

fn prompt_for(p: &str) -> &'static str {
    match p { "summary" => include_str!("../../prompts/pipeline_summary.md"), "world" => include_str!("../../prompts/pipeline_world.md"), _ => "" }
}
fn output_for(p: &str) -> &'static str {
    match p { "summary" => "summary.md", "world" => "world_model.md", _ => "output.md" }
}

fn extract_json(text: &str) -> Result<Value, String> {
    let mut raw = text.trim().to_string();
    if let Some(start) = raw.find("```") {
        if let Some(end) = raw[start+3..].find("```") {
            raw = raw[start+3..start+3+end].trim().to_string();
        }
    }
    if let Ok(v) = serde_json::from_str(&raw) { return Ok(v); }
    if let Some(s) = raw.find('{') {
        if let Some(e) = raw.rfind('}') {
            if let Ok(v) = serde_json::from_str(&raw[s..=e]) { return Ok(v); }
        }
    }
    Err("Invalid JSON".into())
}

fn repair_prompt(prompt_base: &str, bad_answer: &str, error: &str, batch_n: usize, total: usize, start: usize, end: usize) -> String {
    format!("{}是后端 JSON 语法修复器。下面是模型返回的摘要归档 JSON，但语法无效。只修复语法，不新增事实，不扩写，不输出代码块，不寒暄。所有键名必须继续使用中文。批次：{}/{}\n章节范围：{}-{}\n解析错误：{}\n\n待修复内容：\n{}", prompt_base, batch_n, total, start, end, error, bad_answer)
}

fn call_llm_with_repair(system: &str, user: &str) -> Result<String, String> {
    let msgs = vec![crate::engine::llm::Message::system(system), crate::engine::llm::Message::user(user)];
    let (content, _) = crate::engine::llm::chat_blocking(&msgs, None).map_err(|e| e.to_string())?;
    let ans = content.unwrap_or_default();
    if ans.trim().is_empty() { return Err("Empty response".into()); }

    // Try to parse as JSON for validation
    if let Err(e) = extract_json(&ans) {
        // One repair attempt
        let repair_user = repair_prompt(system, &ans, &e, 0, 1, 0, 0);
        let rmsgs = vec![crate::engine::llm::Message::system(system), crate::engine::llm::Message::user(&repair_user)];
        let (rcontent, _) = crate::engine::llm::chat_blocking(&rmsgs, None).map_err(|e| e.to_string())?;
        let repaired = rcontent.unwrap_or(ans);
        return Ok(repaired);
    }
    Ok(ans)
}

#[tauri::command]
pub fn run_pipeline(
    app: tauri::AppHandle, state: State<'_, AppState>,
    book_id: Option<String>, book_name: Option<String>, pipeline: String,
) -> Result<serde_json::Value, String> {
    let id = crate::storage::resolve_book_id(&state.storage_root, book_id.as_deref(), book_name.as_deref())?;
    let prompt = prompt_for(&pipeline);
    if prompt.is_empty() { return Err(format!("Unknown pipeline: {}", pipeline)); }
    let  out_name = output_for(&pipeline).to_string();
    let tid = uuid::Uuid::new_v4().to_string().split('-').next().unwrap_or("t").to_string();
    let storage = state.storage_root.clone();
    let result_tid = tid.clone();
    let closure_tid = result_tid.clone();

    std::thread::spawn(move || {
        let emit = |event: &str, data: Value| { app.emit("pipeline:event", &json!({"event":event,"data":data})).ok(); };
        emit("ack", json!({"task_id":closure_tid,"pipeline":&pipeline}));

        let book_dir = std::path::Path::new(&storage).join(&id);
        let chapters_dir = book_dir.join("chapters");
        let mut chapters: Vec<(String, String)> = Vec::new(); // (title, content)
        if let Ok(ents) = std::fs::read_dir(&chapters_dir) {
            let mut files: Vec<_> = ents.filter_map(|e| e.ok()).collect();
            files.sort_by_key(|e| e.file_name());
            for f in &files {
                if let Ok(c) = std::fs::read_to_string(f.path()) {
                    let name = f.file_name().to_string_lossy().to_string();
                    let title = name.trim_end_matches(".md").to_string();
                    chapters.push((title, c));
                }
            }
        }
        if chapters.is_empty() { emit("error", json!({"message":"No chapters","task_id":closure_tid})); return; }
        let total = ((chapters.len() + MAX_BATCH_CHAPTERS - 1) / MAX_BATCH_CHAPTERS).max(1);
        emit("progress", json!({"title":"running","status":"processing","task_id":closure_tid,"total":total,"current":0}));

        // Process batches concurrently
        let results: Arc<Mutex<Vec<(usize, String)>>> = Arc::new(Mutex::new(Vec::new()));
        let errors: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
        let sys = prompt.to_string();

        std::thread::scope(|scope| {
            let mut handles: Vec<std::thread::ScopedJoinHandle<()>> = Vec::new();
            for (batch_idx, batch_chunk) in chapters.chunks(MAX_BATCH_CHAPTERS).enumerate() {
                let batch_num = batch_idx + 1;
                let s = sys.clone();
                let r = results.clone();
                let e = errors.clone();
                let chunk: Vec<(String, String)> = batch_chunk.to_vec();
                let bid = id.clone();

                let handle = scope.spawn(move || {
                    let start = batch_num * MAX_BATCH_CHAPTERS - MAX_BATCH_CHAPTERS + 1;
                    let end = start + chunk.len() - 1;
                    let chapter_block: String = chunk.iter().map(|(t, c)| format!("【{t}】\n\n{c}")).collect::<Vec<_>>().join("\n\n---\n\n");
                    let user = format!("书名：{}\n批次：{}/{}\n章节范围：{}-{}\n\n原文章节：\n{}", bid, batch_num, total, start, end, chapter_block);
                    match call_llm_with_repair(&s, &user) {
                        Ok(ans) => { r.lock().unwrap().push((batch_num, ans)); }
                        Err(err) => { e.lock().unwrap().push(format!("Batch {}: {}", batch_num, err)); }
                    }
                });
                handles.push(handle);
            }
            for h in handles { h.join().ok(); }
        });

        let errs = errors.lock().unwrap();
        if !errs.is_empty() { emit("error", json!({"message":errs.join("; "),"task_id":closure_tid})); return; }

        let mut sorted: Vec<(usize, String)> = results.lock().unwrap().drain(..).collect();
        sorted.sort_by_key(|(i, _)| *i);
        let merged: String = sorted.into_iter().map(|(_, s)| s).collect::<Vec<_>>().join("\n\n---\n\n");

        let header = format!("# 剧情摘要\n\n> 自动生成于 {}\n\n", chrono::Utc::now().format("%Y-%m-%d %H:%M"));
        let final_content = header + &merged;

        if let Ok((fp, rel)) = crate::commands::archive::resolve_file_path(&book_dir, &out_name) {
            if let Err(e) = std::fs::write(&fp, &final_content) { emit("error", json!({"message":format!("Write: {}",e),"task_id":closure_tid})); return; }
            crate::commands::archive::git_commit(&book_dir, &rel, &format!("[AI_Summary] pipeline {}", pipeline)).ok();
            emit("done", json!({"pipeline":pipeline,"output_file":out_name,"size":final_content.len(),"batches":total,"task_id":closure_tid}));
        } else {
            emit("error", json!({"message":"Path error","task_id":closure_tid}));
        }
    });

    Ok(json!({"task_id": result_tid, "status": "started"}))
}
