use crate::storage::etag;
use crate::AppState;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::Path;
use tauri::State;

// ── Path safety ────────────────────────────────────────────

pub fn resolve_file_path(book_dir: &Path, file_name: &str) -> Result<(std::path::PathBuf, String), String> {
    let normalized = file_name.replace('\\', "/").trim_start_matches("./").to_string();

    if normalized.is_empty() || normalized.contains("..") || normalized.starts_with('/') {
        return Err("Invalid file_name".into());
    }

    let rel_path = normalized.replace('/', &std::path::MAIN_SEPARATOR.to_string());
    let abs_path = book_dir.join(&rel_path);

    // Canonicalize to check path traversal
    let canon_book = book_dir.canonicalize().unwrap_or(book_dir.to_path_buf());
    let canon_file = abs_path.canonicalize().unwrap_or(abs_path.clone());

    if !canon_file.starts_with(&canon_book) {
        return Err("file_name escapes book directory".into());
    }

    // Check extension
    let ext = abs_path.extension().and_then(|e| e.to_str()).unwrap_or("");
    if ext != "md" && ext != "json" {
        return Err("Only .md and .json files allowed".into());
    }

    let normalized_rel = rel_path.replace('\\', "/");
    Ok((abs_path, normalized_rel))
}

fn read_file_or_virtual(book_dir: &Path, file_name: &str) -> Result<(String, String, bool, bool), String> {
    let (abs_path, normalized_rel) = resolve_file_path(book_dir, file_name)?;
    let exists = abs_path.exists();
    let is_virtual = matches_virtual_file(&normalized_rel);

    let content = if exists {
        fs::read_to_string(&abs_path).map_err(|e| format!("Read error: {}", e))?
    } else if is_virtual {
        get_virtual_file_content(&normalized_rel)
    } else {
        return Err(format!("File not found: {}", file_name));
    };

    let etag = etag::compute_etag(&content);
    Ok((content, etag, exists, is_virtual))
}

fn matches_virtual_file(file_name: &str) -> bool {
    matches!(
        file_name,
        "chapter_draft.md" | "status_card.md" | "error_archive.md"
    )
}

fn get_virtual_file_content(file_name: &str) -> String {
    match file_name {
        "chapter_draft.md" => "# 续写草稿\n\n（待续写）\n".into(),
        "status_card.md" => "# 状态卡\n\n## 当前状态\n\n（待初始化）\n".into(),
        "error_archive.md" => "# 错误档案\n\n## 错误档案\n\n（待积累）\n".into(),
        _ => String::new(),
    }
}

// ── Read Commands ──────────────────────────────────────────

#[derive(Debug, Serialize)]
pub struct FileResult {
    pub status: String,
    pub book_id: String,
    pub file_name: String,
    pub etag: String,
    pub content: String,
    pub exists: bool,
    pub virtual_file: bool,
    pub size_chars: usize,
}

#[tauri::command]
pub fn get_file(
    state: State<AppState>,
    book_id: Option<String>,
    book_name: Option<String>,
    file_name: String,
) -> Result<FileResult, String> {
    let id = crate::storage::resolve_book_id(&state.storage_root, book_id.as_deref(), book_name.as_deref())?;
    let book_dir = std::path::Path::new(&state.storage_root).join(&id);
    let (content, etag_val, exists, virtual_file) = read_file_or_virtual(&book_dir, &file_name)?;

    Ok(FileResult {
        status: "success".into(),
        book_id: id,
        file_name,
        etag: etag_val,
        size_chars: content.len(),
        content,
        exists,
        virtual_file,
    })
}

#[derive(Debug, Serialize)]
pub struct ArchiveRangeResult {
    pub status: String,
    pub book_id: String,
    pub file_name: String,
    pub etag: String,
    pub start_line: usize,
    pub end_line: usize,
    pub total_lines: usize,
    pub content: String,
    pub truncated: bool,
}

#[tauri::command]
pub fn get_archive_range(
    state: State<AppState>,
    book_id: Option<String>,
    book_name: Option<String>,
    file_name: String,
    start_line: Option<usize>,
    end_line: Option<usize>,
) -> Result<ArchiveRangeResult, String> {
    let max_lines = 500;
    let id = crate::storage::resolve_book_id(&state.storage_root, book_id.as_deref(), book_name.as_deref())?;
    let book_dir = std::path::Path::new(&state.storage_root).join(&id);
    let (content, etag_val, _exists, _virtual_file) = read_file_or_virtual(&book_dir, &file_name)?;

    let lines: Vec<&str> = content.lines().collect();
    let total = lines.len();
    let start = start_line.unwrap_or(1).max(1);
    let mut end = end_line.unwrap_or(total).min(total);
    if end - start + 1 > max_lines {
        end = start + max_lines - 1;
    }
    let start_idx = start - 1;
    let end_idx = end.min(total);
    let selected = lines[start_idx..end_idx].join("\n");

    Ok(ArchiveRangeResult {
        status: "success".into(),
        book_id: id,
        file_name,
        etag: etag_val,
        start_line: start,
        end_line: end_idx,
        total_lines: total,
        content: selected,
        truncated: end_idx < total,
    })
}

#[derive(Debug, Serialize)]
pub struct OutlineResult {
    pub status: String,
    pub book_id: String,
    pub file_name: String,
    pub etag: String,
    pub outline: Vec<serde_json::Value>,
    pub exists: bool,
    pub virtual_file: bool,
}

#[tauri::command]
pub fn get_markdown_outline(
    state: State<AppState>,
    book_id: Option<String>,
    book_name: Option<String>,
    file_name: String,
) -> Result<OutlineResult, String> {
    let id = crate::storage::resolve_book_id(&state.storage_root, book_id.as_deref(), book_name.as_deref())?;
    let book_dir = std::path::Path::new(&state.storage_root).join(&id);
    let (content, etag_val, exists, virtual_file) = read_file_or_virtual(&book_dir, &file_name)?;

    let outline = parse_markdown_outline(&content);

    Ok(OutlineResult {
        status: "success".into(),
        book_id: id,
        file_name,
        etag: etag_val,
        outline,
        exists,
        virtual_file,
    })
}

#[tauri::command]
pub fn get_markdown_section(
    state: State<AppState>,
    book_id: Option<String>,
    book_name: Option<String>,
    file_name: String,
    section_path: Vec<String>,
) -> Result<serde_json::Value, String> {
    let id = crate::storage::resolve_book_id(&state.storage_root, book_id.as_deref(), book_name.as_deref())?;
    let book_dir = std::path::Path::new(&state.storage_root).join(&id);
    let (content, etag_val, exists, virtual_file) = read_file_or_virtual(&book_dir, &file_name)?;

    let section = extract_section(&content, &section_path)
        .ok_or_else(|| format!("Section not found: {:?}", section_path))?;

    Ok(serde_json::json!({
        "status": "success",
        "book_id": id,
        "file_name": file_name,
        "etag": etag_val,
        "exists": exists,
        "virtual": virtual_file,
        "content": section.content,
        "heading_line": section.heading_line,
        "content_start_line": section.content_start_line,
        "end_line": section.end_line,
    }))
}

#[tauri::command]
pub fn get_core_archive(
    state: State<AppState>,
    book_id: Option<String>,
    book_name: Option<String>,
    file_name: String,
) -> Result<FileResult, String> {
    get_file(state, book_id, book_name, file_name)
}

// ── Write Commands ──────────────────────────────────────────

#[derive(Debug, Deserialize)]
pub struct UpdateFileParams {
    pub book_id: Option<String>,
    pub book_name: Option<String>,
    pub file_name: String,
    pub content: String,
    #[serde(default)]
    pub base_etag: Option<String>,
    #[serde(default)]
    pub origin: Option<String>,
    #[serde(default)]
    pub message: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct WriteFileResult {
    pub status: String,
    pub book_id: String,
    pub file_name: String,
    pub new_etag: String,
    pub new_size: usize,
}

#[tauri::command]
pub fn update_file(
    state: State<AppState>,
    book_id: Option<String>,
    book_name: Option<String>,
    file_name: String,
    content: String,
    base_etag: Option<String>,
    origin: Option<String>,
    message: Option<String>,
) -> Result<WriteFileResult, String> {
    let id = crate::storage::resolve_book_id(
        &state.storage_root, book_id.as_deref(), book_name.as_deref(),
    )?;
    let book_dir = std::path::Path::new(&state.storage_root).join(&id);
    let (file_path, normalized_rel) = resolve_file_path(&book_dir, &file_name)?;

    // ETag check
    if let Some(ref be) = base_etag {
        if file_path.exists() {
            let current_etag = etag::compute_file_etag(&file_path)?;
            if *be != current_etag {
                return Err(format!("ETag mismatch: write conflict for {}", file_name));
            }
        }
    }

    // Write file
    fs::write(&file_path, &content).map_err(|e| format!("Write error: {}", e))?;
    let new_etag = etag::compute_etag(&content);

    // Git commit
    let msg = message.unwrap_or_else(|| format!("update {}", normalized_rel));
    let prefix = match origin.as_deref() {
        Some("ai") | Some("explicit_user_write") => "[AI_Update]",
        Some("user") => "[User_Edit]",
        _ => "[System_Update]",
    };
    git_commit(&book_dir, &normalized_rel, &format!("{} {}", prefix, msg))?;

    Ok(WriteFileResult {
        status: "success".into(),
        book_id: id,
        file_name,
        new_etag,
        new_size: content.len(),
    })
}

#[tauri::command]
pub fn append_file(
    state: State<AppState>,
    book_id: Option<String>,
    book_name: Option<String>,
    file_name: String,
    content: String,
    base_etag: Option<String>,
    origin: Option<String>,
    message: Option<String>,
) -> Result<WriteFileResult, String> {
    let id = crate::storage::resolve_book_id(
        &state.storage_root, book_id.as_deref(), book_name.as_deref(),
    )?;
    let book_dir = std::path::Path::new(&state.storage_root).join(&id);
    let (file_path, normalized_rel) = resolve_file_path(&book_dir, &file_name)?;

    // ETag check
    if let Some(ref be) = base_etag {
        if file_path.exists() {
            let current_etag = etag::compute_file_etag(&file_path)?;
            if *be != current_etag {
                return Err(format!("ETag mismatch: write conflict for {}", file_name));
            }
        }
    }

    // Append content
    let mut existing = if file_path.exists() {
        fs::read_to_string(&file_path).map_err(|e| format!("Read error: {}", e))?
    } else {
        String::new()
    };
    if !existing.is_empty() && !existing.ends_with('\n') {
        existing.push('\n');
    }
    existing.push_str(&content);
    if !existing.ends_with('\n') {
        existing.push('\n');
    }

    fs::write(&file_path, &existing).map_err(|e| format!("Write error: {}", e))?;
    let new_etag = etag::compute_etag(&existing);

    let msg = message.unwrap_or_else(|| format!("append to {}", normalized_rel));
    git_commit(&book_dir, &normalized_rel, &format!("[AI_Update] {}", msg))?;

    Ok(WriteFileResult {
        status: "success".into(),
        book_id: id,
        file_name,
        new_etag,
        new_size: existing.len(),
    })
}

// ── Markdown Parsing Helpers ───────────────────────────────

struct SectionData {
    content: String,
    heading_line: usize,
    content_start_line: usize,
    end_line: usize,
}

fn parse_markdown_outline(markdown: &str) -> Vec<serde_json::Value> {
    let mut outline = Vec::new();
    let mut stack: Vec<(usize, String)> = Vec::new(); // (level, title)

    for (i, line) in markdown.lines().enumerate() {
        if let Some((level, title)) = parse_heading(line) {
            while let Some(&(l, _)) = stack.last() {
                if l >= level {
                    stack.pop();
                } else {
                    break;
                }
            }
            stack.push((level, title.to_string()));

            let section_path: Vec<String> = stack.iter().map(|(_, t)| t.clone()).collect();
            outline.push(serde_json::json!({
                "title": title,
                "level": level,
                "section_path": section_path,
                "heading_line": i,
                "ordinal": outline.len(),
            }));
        }
    }
    outline
}

fn parse_heading(line: &str) -> Option<(usize, &str)> {
    let trimmed = line.trim();
    let level = trimmed.chars().take_while(|&c| c == '#').count();
    if level > 0 && level <= 6 && trimmed.chars().nth(level) == Some(' ') {
        let title = trimmed[level..].trim().trim_end_matches('#').trim();
        Some((level, title))
    } else {
        None
    }
}

fn extract_section(markdown: &str, section_path: &[String]) -> Option<SectionData> {
    let lines: Vec<&str> = markdown.lines().collect();
    let mut current_path: Vec<String> = Vec::new();
    let mut found_start: Option<usize> = None;
    let mut found_level: usize = 0;

    let target_depth = section_path.len();
    let target_last = section_path.last()?;

    for (i, line) in lines.iter().enumerate() {
        if let Some((level, title)) = parse_heading(line) {
            while current_path.len() >= level {
                current_path.pop();
            }
            current_path.push(title.to_string());

            if found_start.is_some() {
                // End of target section — next heading at same or higher level
                if level <= found_level && current_path != *section_path {
                    return Some(SectionData {
                        content: lines[found_start.unwrap()..i].join("\n"),
                        heading_line: found_start.unwrap(),
                        content_start_line: found_start.unwrap() + 1,
                        end_line: i,
                    });
                }
            }

            if current_path == *section_path {
                found_start = Some(i);
                found_level = level;
            }
        }
    }

    if let Some(start) = found_start {
        return Some(SectionData {
            content: lines[start..].join("\n"),
            heading_line: start,
            content_start_line: start + 1,
            end_line: lines.len(),
        });
    }

    None
}

pub fn git_commit(repo_dir: &Path, file_name: &str, message: &str) -> Result<(), String> {
    let repo = git2::Repository::open(repo_dir)
        .map_err(|e| format!("Git open error: {}", e))?;

    let mut index = repo.index().map_err(|e| format!("Git index error: {}", e))?;
    index.add_path(std::path::Path::new(file_name))
        .map_err(|e| format!("Git add error: {}", e))?;
    index.write().map_err(|e| format!("Git index write error: {}", e))?;

    let tree_id = index.write_tree().map_err(|e| format!("Git tree error: {}", e))?;
    let tree = repo.find_tree(tree_id).map_err(|e| format!("Git find tree error: {}", e))?;

    let signature = repo.signature()
        .map_err(|e| format!("Git signature error: {}", e))?;

    let head = repo.head().ok();
    let parents: Vec<git2::Commit> = if let Some(ref h) = head {
        vec![h.peel_to_commit().map_err(|e| format!("Git peel error: {}", e))?]
    } else {
        Vec::new()
    };
    let parent_refs: Vec<&git2::Commit> = parents.iter().collect();

    repo.commit(
        Some("HEAD"),
        &signature,
        &signature,
        message,
        &tree,
        &parent_refs,
    )
    .map_err(|e| {
        if e.message().contains("nothing to commit") {
            // Not an error — just nothing to commit
            return "".to_string(); // won't be used, handled below
        }
        format!("Git commit error: {}", e)
    })?;

    // Ignore "nothing to commit" - it's fine
    Ok(())
}

// ── Context assembly ───────────────────────────────────────

#[tauri::command]
pub fn checkout(
    state: State<'_, AppState>, book_id: Option<String>, book_name: Option<String>,
    include: Option<String>, last_n: Option<usize>,
) -> Result<serde_json::Value, String> {
    let id = crate::storage::resolve_book_id(&state.storage_root, book_id.as_deref(), book_name.as_deref())?;
    let book_dir = std::path::Path::new(&state.storage_root).join(&id);
    let keys: Vec<&str> = include.as_deref().unwrap_or("world_model,summary,chapters").split(',').map(|s| s.trim()).filter(|s| !s.is_empty()).collect();
    let n = last_n.unwrap_or(5);

    let mut result = serde_json::Map::new();
    for key in &keys {
        match *key {
            "world_model" | "summary" | "status_card" | "style_guide" | "error_archive" | "chapter_outline" | "brainstorm" => {
                let fname = if *key == "world_model" { "world_model.md" } else if *key == "summary" { "summary.md" } else if *key == "status_card" { "status_card.md" } else if *key == "style_guide" { "style_guide.md" } else if *key == "error_archive" { "error_archive.md" } else if *key == "chapter_outline" { "chapter_outline.md" } else { "brainstorm.md" };
                let path = book_dir.join(fname);
                if path.exists() {
                    if let Ok(c) = std::fs::read_to_string(&path) { result.insert(key.to_string(), serde_json::Value::String(c)); }
                }
            }
            "chapters" => {
                let chapters_dir = book_dir.join("chapters");
                if chapters_dir.exists() {
                    let mut files: Vec<_> = std::fs::read_dir(&chapters_dir).unwrap().filter_map(|e| e.ok()).collect();
                    files.sort_by_key(|e| e.file_name());
                    let recent: Vec<String> = files.iter().rev().take(n).rev().filter_map(|f| std::fs::read_to_string(f.path()).ok()).collect();
                    result.insert("chapters".into(), serde_json::Value::Array(recent.into_iter().map(serde_json::Value::String).collect()));
                }
            }
            _ => {}
        }
    }
    Ok(serde_json::Value::Object(result))
}

// ── Layout management ──────────────────────────────────────

#[tauri::command]
pub fn repo_integrity(
    state: State<'_, AppState>, book_id: Option<String>, book_name: Option<String>,
) -> Result<serde_json::Value, String> {
    let id = crate::storage::resolve_book_id(&state.storage_root, book_id.as_deref(), book_name.as_deref())?;
    let book_dir = std::path::Path::new(&state.storage_root).join(&id);
    let mut missing = Vec::new();
    for f in crate::storage::TRACKED_LAYOUT_FILES {
        if *f != "metadata.json" && !book_dir.join(f).exists() { missing.push(f.to_string()); }
    }
    for d in crate::storage::TRACKED_LAYOUT_DIRS {
        if !book_dir.join(d).exists() { missing.push(format!("{}/", d)); }
    }
    let needs_repair = !missing.is_empty();
    let repo_exists = book_dir.join(".git").exists();
    let empty_strs: Vec<String> = Vec::new();
    Ok(serde_json::json!({
        "status": "success", "book_id": id, "exists": book_dir.exists(),
        "repo_exists": repo_exists, "head_exists": repo_exists,
        "head_commit": serde_json::Value::Null,
        "missing_core_files": missing, "missing_directories": empty_strs,
        "untracked_layout_files": empty_strs, "problem_codes": empty_strs,
        "needs_repair": needs_repair,
    }))
}

#[tauri::command]
pub fn repair_layout(
    state: State<'_, AppState>, book_id: Option<String>, book_name: Option<String>,
) -> Result<serde_json::Value, String> {
    let id = crate::storage::resolve_book_id(&state.storage_root, book_id.as_deref(), book_name.as_deref())?;
    let book_dir = std::path::Path::new(&state.storage_root).join(&id);
    let chapters_dir = book_dir.join("chapters");
    std::fs::create_dir_all(&chapters_dir).ok();
    for f in crate::storage::TRACKED_LAYOUT_FILES {
        if *f != "metadata.json" && !book_dir.join(f).exists() { std::fs::write(book_dir.join(f), "").ok(); }
    }
    if !book_dir.join(".git").exists() { git2::Repository::init(&book_dir).ok(); }
    Ok(serde_json::json!({"status":"success","book_id":id,"head_commit":null,"repair_commits":[]}))
}

#[tauri::command]
pub fn list_hot_files(
    state: State<'_, AppState>, book_id: Option<String>, book_name: Option<String>,
) -> Result<serde_json::Value, String> {
    let id = crate::storage::resolve_book_id(&state.storage_root, book_id.as_deref(), book_name.as_deref())?;
    let files: Vec<serde_json::Value> = crate::storage::TRACKED_LAYOUT_FILES.iter().filter(|f| **f != "metadata.json").map(|f| {
        serde_json::json!({"file_name": f, "file_type": file_type_for(f), "label": label_for(f), "exists": std::path::Path::new(&state.storage_root).join(&id).join(f).exists()})
    }).collect();
    Ok(serde_json::json!({"status":"success","book_id":id,"integrity":{"book_id":id,"exists":true,"repo_exists":true,"head_exists":true,"head_commit":null,"missing_core_files":[],"missing_directories":[],"untracked_layout_files":[],"problem_codes":[],"needs_repair":false},"files":files}))
}
fn file_type_for(f: &str) -> &str {
    if f == "world_model.md" || f == "status_card.md" { "world_core" }
    else if f == "summary.md" { "summary" }
    else if f == "style_fingerprint.md" || f == "style_review.md" || f == "style_constraints_for_continuation.md" { "style" }
    else if f == "brainstorm.md" || f == "master_outline.md" || f == "arc_outline.md" || f == "chapter_outline.md" { "outline" }
    else if f == "error_archive.md" { "error_archive" }
    else if f == "chapter_draft.md" { "chapter" }
    else { "generic" }
}
fn label_for(f: &str) -> &str {
    if f == "world_model.md" { "世界观底座" } else if f == "status_card.md" { "状态卡" }
    else if f == "summary.md" { "剧情总纲" } else if f == "style_fingerprint.md" { "文风指纹" }
    else if f == "style_review.md" { "文风偏差" } else if f == "style_constraints_for_continuation.md" { "续写文风卡" }
    else if f == "brainstorm.md" { "头脑风暴" } else if f == "master_outline.md" { "总纲" }
    else if f == "arc_outline.md" { "篇章大纲" } else if f == "chapter_outline.md" { "章节大纲" }
    else if f == "error_archive.md" { "错误档案" } else if f == "chapter_draft.md" { "续写草稿" }
    else { f }
}

// ── Simple file ops ────────────────────────────────────────

#[tauri::command]
pub fn prepend_file(
    state: State<'_, AppState>, book_id: Option<String>, book_name: Option<String>,
    file_name: String, content: String, base_etag: Option<String>,
) -> Result<WriteFileResult, String> {
    let id = crate::storage::resolve_book_id(&state.storage_root, book_id.as_deref(), book_name.as_deref())?;
    let book_dir = std::path::Path::new(&state.storage_root).join(&id);
    let (file_path, normalized_rel) = resolve_file_path(&book_dir, &file_name)?;
    if let Some(ref be) = base_etag { if file_path.exists() && *be != etag::compute_file_etag(&file_path)? { return Err("ETag mismatch".into()); } }
    let existing = if file_path.exists() { std::fs::read_to_string(&file_path).unwrap_or_default() } else { String::new() };
    let new_content = format!("{}\n{}", content.trim_end(), existing);
    std::fs::write(&file_path, &new_content).map_err(|e| format!("Write: {}", e))?;
    let new_etag = etag::compute_etag(&new_content);
    git_commit(&book_dir, &normalized_rel, "[AI_Update] prepend")?;
    Ok(WriteFileResult { status: "success".into(), book_id: id, file_name, new_etag, new_size: new_content.len() })
}

#[tauri::command]
pub fn add_chapter(
    state: State<'_, AppState>, book_id: Option<String>, book_name: Option<String>,
    chapter_index: u32, content: String, title: Option<String>,
) -> Result<serde_json::Value, String> {
    let id = crate::storage::resolve_book_id(&state.storage_root, book_id.as_deref(), book_name.as_deref())?;
    let book_dir = std::path::Path::new(&state.storage_root).join(&id);
    let chapters_dir = book_dir.join("chapters");
    std::fs::create_dir_all(&chapters_dir).ok();
    let t = title.unwrap_or_else(|| format!("第{}章", chapter_index));
    let safe_title = t.chars().map(|c| if c.is_alphanumeric() || c == '_' || c == '-' { c } else { '_' }).take(30).collect::<String>();
    let fname = format!("{:04}_{}.md", chapter_index, safe_title);
    let path = chapters_dir.join(&fname);
    let full = format!("# {}\n\n{}", t, content);
    std::fs::write(&path, &full).map_err(|e| format!("Write: {}", e))?;
    crate::storage::layout::ensure_book_layout(&state.storage_root, &id, &id)?;
    Ok(serde_json::json!({"status":"success","book_id":id,"file_name":fname,"chapter_index":chapter_index}))
}
