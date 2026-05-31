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
