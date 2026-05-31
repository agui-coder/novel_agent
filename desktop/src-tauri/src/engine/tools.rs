use crate::engine::llm::Tool;
use crate::storage;
use serde_json::json;
use std::collections::HashMap;
use std::fs;
use std::path::Path;

use crate::commands::archive::{git_commit, resolve_file_path};
use crate::storage::etag;

#[derive(Debug, Clone)]
pub struct ToolResult {
    pub content: String,
    pub is_error: bool,
}

pub type ToolFn = fn(&str, &str, &serde_json::Value) -> Result<String, String>;

pub struct ToolRegistry {
    schemas: Vec<Tool>,
    handlers: HashMap<String, ToolFn>,
    storage_root: String,
}

impl ToolRegistry {
    pub fn new(storage_root: &str) -> Self {
        let mut registry = ToolRegistry {
            schemas: Vec::new(),
            handlers: HashMap::new(),
            storage_root: storage_root.to_string(),
        };

        registry.register(
            "get_markdown_outline",
            "读取 Markdown 文件的标题结构、section_path 与 base_etag，用于安全定位章节和写入前校验",
            json!({
                "type": "object",
                "properties": {
                    "book_id": {"type": "string", "description": "书库 ID"},
                    "book_name": {"type": "string", "description": "书名"},
                    "file_name": {"type": "string", "description": "目标 Markdown 文件名"}
                },
                "required": ["file_name"]
            }),
            handle_get_outline,
        );

        registry.register(
            "get_markdown_section",
            "读取 Markdown 文件的局部章节内容，用于核对证据",
            json!({
                "type": "object",
                "properties": {
                    "book_id": {"type": "string"},
                    "book_name": {"type": "string"},
                    "file_name": {"type": "string"},
                    "section_path": {"type": "string", "description": "章节路径，如 '续写草稿/第1章'"}
                },
                "required": ["file_name", "section_path"]
            }),
            handle_get_section,
        );

        registry.register(
            "get_archive_range",
            "按行范围读取书库归档内容，用于抽样核对",
            json!({
                "type": "object",
                "properties": {
                    "book_id": {"type": "string"},
                    "book_name": {"type": "string"},
                    "file_name": {"type": "string"},
                    "start_line": {"type": "integer", "default": 1},
                    "end_line": {"type": "integer", "default": 100}
                },
                "required": ["file_name"]
            }),
            handle_get_range,
        );

        registry.register(
            "get_core_archive",
            "读取书库核心档案全文（world_model.md, summary.md, status_card.md 等）",
            json!({
                "type": "object",
                "properties": {
                    "book_id": {"type": "string"},
                    "book_name": {"type": "string"},
                    "file_name": {"type": "string"}
                },
                "required": ["file_name"]
            }),
            handle_get_core,
        );

        registry.register(
            "draft_append_markdown_section",
            "向草稿文件追加子章节。file_name 只用裸文件名",
            json!({
                "type": "object",
                "properties": {
                    "book_id": {"type": "string"},
                    "book_name": {"type": "string"},
                    "file_name": {"type": "string", "description": "目标文件名，只能是裸文件名如 chapter_draft.md"},
                    "section_path": {"type": "string", "description": "父级章节路径，如 '续写草稿'"},
                    "content": {"type": "string", "description": "要追加的 Markdown 内容，必须以 ## 标题开头"},
                    "base_etag": {"type": "string", "description": "最近读取同一文件获得的 etag"}
                },
                "required": ["file_name", "section_path", "content", "base_etag"]
            }),
            handle_append_draft,
        );

        registry.register(
            "draft_replace_markdown_section",
            "替换草稿中的指定章节",
            json!({
                "type": "object",
                "properties": {
                    "book_id": {"type": "string"},
                    "book_name": {"type": "string"},
                    "file_name": {"type": "string"},
                    "section_path": {"type": "string"},
                    "content": {"type": "string", "description": "替换后的完整 Markdown 内容，必须包含标题行"},
                    "base_etag": {"type": "string"}
                },
                "required": ["file_name", "section_path", "content", "base_etag"]
            }),
            handle_replace_draft,
        );

        registry.register(
            "validate_chapter_lengths",
            "只读统计 chapter_draft.md 中各章非空白字符数",
            json!({
                "type": "object",
                "properties": {
                    "book_id": {"type": "string"},
                    "book_name": {"type": "string"},
                    "file_name": {"type": "string", "default": "chapter_draft.md"},
                    "min_chars": {"type": "integer", "default": 2200},
                    "target_chars": {"type": "integer", "default": 2500},
                    "max_chars": {"type": "integer", "default": 3200}
                },
                "required": []
            }),
            handle_validate_lengths,
        );

        registry.register(
            "extract_chapter_highlights",
            "只读抽取章节高价值片段作为证据，不写入任何文件",
            json!({
                "type": "object",
                "properties": {
                    "book_id": {"type": "string"},
                    "book_name": {"type": "string"},
                    "chapter_index": {"type": "integer"},
                    "keywords": {"type": "string", "description": "逗号分隔的关键词"}
                },
                "required": ["chapter_index", "keywords"]
            }),
            handle_extract_highlights,
        );

        registry.register(
            "generate_style_diagnostics",
            "只读生成文风诊断与打磨提示，结果作为 style_advisory 参考，不阻塞调度",
            json!({
                "type": "object",
                "properties": {
                    "book_id": {"type": "string"},
                    "book_name": {"type": "string"},
                    "draft_file": {"type": "string", "default": "chapter_draft.md"},
                    "source_count": {"type": "integer", "default": 12},
                    "draft_chapters": {"type": "string"}
                },
                "required": []
            }),
            handle_style_diagnostics,
        );

        registry
    }

    fn register(&mut self, name: &str, desc: &str, params: serde_json::Value, handler: ToolFn) {
        self.schemas.push(Tool {
            tool_type: "function".into(),
            function: crate::engine::llm::ToolFunction {
                name: name.into(),
                description: desc.into(),
                parameters: params,
            },
        });
        self.handlers.insert(name.to_string(), handler);
    }

    pub fn schemas(&self) -> &[Tool] {
        &self.schemas
    }

    pub fn execute(&self, name: &str, book_id: &str, args: &serde_json::Value) -> ToolResult {
        match self.handlers.get(name) {
            Some(handler) => match handler(&self.storage_root, book_id, args) {
                Ok(content) => ToolResult { content, is_error: false },
                Err(e) => ToolResult { content: e, is_error: true },
            },
            None => ToolResult {
                content: format!("Unknown tool: {}", name),
                is_error: true,
            },
        }
    }
}

// ── Tool handlers ──────────────────────────────────────────

fn read_file(book_dir: &Path, file_name: &str) -> Result<(String, String, bool), String> {
    let (file_path, _) = resolve_file_path(book_dir, file_name)?;
    let exists = file_path.exists();
    let content = if exists {
        fs::read_to_string(&file_path).map_err(|e| format!("Read error: {}", e))?
    } else {
        String::new()
    };
    let e = etag::compute_etag(&content);
    Ok((content, e, exists))
}

fn get_book_dir(storage_root: &str, args: &serde_json::Value) -> Result<std::path::PathBuf, String> {
    let book_id = args.get("book_id").and_then(|v| v.as_str()).filter(|s| !s.is_empty());
    let book_name = args.get("book_name").and_then(|v| v.as_str()).filter(|s| !s.is_empty());
    let id = storage::resolve_book_id(storage_root, book_id, book_name)?;
    Ok(Path::new(storage_root).join(&id))
}

fn handle_get_outline(storage_root: &str, book_id: &str, args: &serde_json::Value) -> Result<String, String> {
    let file_name = args.get("file_name").and_then(|v| v.as_str()).unwrap_or("chapter_draft.md");
    let book_dir = get_book_dir(storage_root, args)?;
    let (content, etag_val, exists) = read_file(&book_dir, file_name)?;

    let mut outline = Vec::new();
    for (i, line) in content.lines().enumerate() {
        let trimmed = line.trim();
        let level = trimmed.chars().take_while(|&c| c == '#').count();
        if level > 0 && level <= 6 && trimmed.chars().nth(level) == Some(' ') {
            let title = trimmed[level..].trim().trim_end_matches('#').trim();
            outline.push(format!("[L{}] {} (line {})", level, title, i + 1));
        }
    }

    Ok(serde_json::json!({
        "status": "success", "book_id": book_id, "file_name": file_name,
        "etag": etag_val, "exists": exists, "virtual": !exists,
        "outline": outline,
        "outline_count": outline.len()
    }).to_string())
}

fn handle_get_section(storage_root: &str, _book_id: &str, args: &serde_json::Value) -> Result<String, String> {
    let file_name = args.get("file_name").and_then(|v| v.as_str()).unwrap_or("chapter_draft.md");
    let section_path = args.get("section_path").and_then(|v| v.as_str()).unwrap_or("");
    let book_dir = get_book_dir(storage_root, args)?;
    let (content, etag_val, exists) = read_file(&book_dir, file_name)?;

    let parts: Vec<&str> = section_path.split('/').collect();
    let mut current_path: Vec<String> = Vec::new();
    let mut found_content = String::new();
    let mut in_target = false;
    let mut target_level = 0;

    for line in content.lines() {
        let trimmed = line.trim();
        let level = trimmed.chars().take_while(|&c| c == '#').count();
        if level > 0 && level <= 6 && trimmed.chars().nth(level) == Some(' ') {
            let title = trimmed[level..].trim().trim_end_matches('#').trim().to_string();
            while current_path.len() >= level { current_path.pop(); }
            current_path.push(title);

            if in_target && level <= target_level && current_path != parts {
                break;
            }
            in_target = current_path.iter().zip(parts.iter()).all(|(a, b)| a == b);
            if in_target { target_level = level; }
        } else if in_target {
            found_content.push_str(line);
            found_content.push('\n');
        }
    }

    Ok(serde_json::json!({
        "status": "success", "file_name": file_name,
        "etag": etag_val, "exists": exists,
        "content": found_content
    }).to_string())
}

fn handle_get_range(storage_root: &str, _book_id: &str, args: &serde_json::Value) -> Result<String, String> {
    let file_name = args.get("file_name").and_then(|v| v.as_str()).unwrap_or("summary.md");
    let start = args.get("start_line").and_then(|v| v.as_u64()).unwrap_or(1) as usize;
    let end = args.get("end_line").and_then(|v| v.as_u64()).unwrap_or(100) as usize;
    let book_dir = get_book_dir(storage_root, args)?;
    let (content, etag_val, _exists) = read_file(&book_dir, file_name)?;

    let lines: Vec<&str> = content.lines().collect();
    let si = (start.max(1) - 1).min(lines.len());
    let ei = end.min(lines.len());
    let selected = lines[si..ei].join("\n");

    Ok(serde_json::json!({
        "status": "success", "file_name": file_name, "etag": etag_val,
        "start_line": si + 1, "end_line": ei, "total_lines": lines.len(),
        "content": selected, "truncated": ei < lines.len()
    }).to_string())
}

fn handle_get_core(storage_root: &str, _book_id: &str, args: &serde_json::Value) -> Result<String, String> {
    let file_name = args.get("file_name").and_then(|v| v.as_str()).unwrap_or("world_model.md");
    let book_dir = get_book_dir(storage_root, args)?;
    let (content, etag_val, exists) = read_file(&book_dir, file_name)?;
    Ok(serde_json::json!({
        "status": "success", "file_name": file_name, "etag": etag_val,
        "content": content, "exists": exists, "size_chars": content.len()
    }).to_string())
}

fn handle_append_draft(storage_root: &str, _book_id: &str, args: &serde_json::Value) -> Result<String, String> {
    let file_name = args.get("file_name").and_then(|v| v.as_str()).unwrap_or("chapter_draft.md");
    let section_path = args.get("section_path").and_then(|v| v.as_str()).unwrap_or("");
    let content = args.get("content").and_then(|v| v.as_str()).unwrap_or("");
    let base_etag = args.get("base_etag").and_then(|v| v.as_str());

    let book_dir = get_book_dir(storage_root, args)?;
    let (file_path, normalized_rel) = resolve_file_path(&book_dir, file_name)?;

    if let Some(be) = base_etag {
        if file_path.exists() && *be != etag::compute_file_etag(&file_path)? {
            return Ok(serde_json::json!({
                "status": "error", "code": "WRITE_CONFLICT",
                "message": format!("ETag mismatch for {}", file_name)
            }).to_string());
        }
    }

    let mut existing = if file_path.exists() { fs::read_to_string(&file_path).map_err(|e| format!("Read: {}", e))? } else { String::new() };
    if !existing.is_empty() && !existing.ends_with('\n') { existing.push('\n'); }
    existing.push_str(content);
    if !existing.ends_with('\n') { existing.push('\n'); }
    crate::commands::archive::atomic_write(&file_path, &existing)?;
    git_commit(&book_dir, &normalized_rel, "[AI_Update] draft append")?;

    let new_etag = etag::compute_etag(&existing);
    Ok(serde_json::json!({
        "status": "success", "file_name": file_name, "section_path": section_path,
        "new_etag": new_etag, "appended_chars": content.len(), "new_size": existing.len()
    }).to_string())
}

fn handle_replace_draft(storage_root: &str, _book_id: &str, args: &serde_json::Value) -> Result<String, String> {
    let file_name = args.get("file_name").and_then(|v| v.as_str()).unwrap_or("chapter_draft.md");
    let content = args.get("content").and_then(|v| v.as_str()).unwrap_or("");
    let base_etag = args.get("base_etag").and_then(|v| v.as_str());

    let book_dir = get_book_dir(storage_root, args)?;
    let (file_path, normalized_rel) = resolve_file_path(&book_dir, file_name)?;

    if let Some(be) = base_etag {
        if file_path.exists() && *be != etag::compute_file_etag(&file_path)? {
            return Ok(serde_json::json!({
                "status": "error", "code": "WRITE_CONFLICT",
                "message": format!("ETag mismatch for {}", file_name)
            }).to_string());
        }
    }

    crate::commands::archive::atomic_write(&file_path, content)?;
    git_commit(&book_dir, &normalized_rel, "[AI_Update] draft replace")?;

    Ok(serde_json::json!({"status": "success", "file_name": file_name, "new_size": content.len()}).to_string())
}

fn handle_validate_lengths(storage_root: &str, _book_id: &str, args: &serde_json::Value) -> Result<String, String> {
    let file_name = args.get("file_name").and_then(|v| v.as_str()).unwrap_or("chapter_draft.md");
    let min_c = args.get("min_chars").and_then(|v| v.as_u64()).unwrap_or(2200) as usize;
    let max_c = args.get("max_chars").and_then(|v| v.as_u64()).unwrap_or(3200) as usize;
    let book_dir = get_book_dir(storage_root, args)?;
    let (content, _etag, _) = read_file(&book_dir, file_name)?;

    let mut chapters = Vec::new();
    let mut current_title = String::new();
    let mut current_text = String::new();

    for line in content.lines() {
        let trimmed = line.trim();
        let level = trimmed.chars().take_while(|&c| c == '#').count();
        if level == 2 && trimmed.chars().nth(level) == Some(' ') {
            if !current_title.is_empty() {
                let nwc = current_text.chars().filter(|c| !c.is_whitespace()).count();
                chapters.push(serde_json::json!({
                    "title": current_title,
                    "non_whitespace_chars": nwc,
                    "status": if nwc < min_c { "under_min" } else if nwc > max_c { "over_max" } else { "ok" },
                    "under_min": nwc < min_c,
                    "over_max": nwc > max_c
                }));
            }
            current_title = trimmed[2..].trim().to_string();
            current_text = String::new();
        } else if !current_title.is_empty() {
            current_text.push_str(line);
            current_text.push('\n');
        }
    }
    if !current_title.is_empty() {
        let nwc = current_text.chars().filter(|c| !c.is_whitespace()).count();
        chapters.push(serde_json::json!({
            "title": current_title,
            "non_whitespace_chars": nwc,
            "status": if nwc < min_c { "under_min" } else if nwc > max_c { "over_max" } else { "ok" },
            "under_min": nwc < min_c,
            "over_max": nwc > max_c
        }));
    }

    Ok(serde_json::json!({
        "status": "success", "file_name": file_name,
        "min_chars": min_c, "max_chars": max_c,
        "chapters": chapters
    }).to_string())
}

fn handle_extract_highlights(storage_root: &str, _book_id: &str, args: &serde_json::Value) -> Result<String, String> {
    let chapter_index = args.get("chapter_index").and_then(|v| v.as_u64()).unwrap_or(1) as u32;
    let keywords = args.get("keywords").and_then(|v| v.as_str()).unwrap_or("");
    let book_dir = get_book_dir(storage_root, args)?;
    let chapters_dir = book_dir.join("chapters");

    let prefix = format!("{:04}", chapter_index);
    let candidates: Vec<_> = if let Ok(entries) = fs::read_dir(&chapters_dir) {
        entries.filter_map(|e| e.ok()).filter(|e| e.file_name().to_string_lossy().starts_with(&prefix)).collect()
    } else { vec![] };

    if candidates.is_empty() {
        return Ok(serde_json::json!({"status": "success", "hits": [], "total_hits": 0}).to_string());
    }

    let content = fs::read_to_string(candidates[0].path()).map_err(|e| format!("Read: {}", e))?;
    let kw_list: Vec<&str> = keywords.split(',').map(|s| s.trim()).filter(|s| !s.is_empty()).collect();
    let mut hits = Vec::new();
    let mut total = 0usize;

    for kw in kw_list.iter().take(20) {
        for (idx, _) in content.match_indices(*kw) {
            if total >= 1000 { break; }
            let start = idx.saturating_sub(100);
            let end = (idx + kw.len() + 100).min(content.len());
            let snippet = content[start..end].trim().to_string();
            if !snippet.is_empty() {
                hits.push(serde_json::json!({"keyword": kw, "position": idx, "snippet": snippet}));
                total += snippet.len();
            }
        }
    }

    Ok(serde_json::json!({
        "status": "success", "chapter_index": chapter_index,
        "hits": hits, "total_hits": hits.len(), "truncated": total >= 1000
    }).to_string())
}

fn handle_style_diagnostics(storage_root: &str, _book_id: &str, args: &serde_json::Value) -> Result<String, String> {
    let book_dir = get_book_dir(storage_root, args)?;
    let draft_file = args.get("draft_file").and_then(|v| v.as_str()).unwrap_or("chapter_draft.md");
    let source_count = args.get("source_count").and_then(|v| v.as_u64()).unwrap_or(12) as usize;

    // Read draft
    let draft_path = book_dir.join(draft_file);
    let draft_text = if draft_path.exists() { fs::read_to_string(&draft_path).unwrap_or_default() } else { String::new() };

    // Read source chapters for comparison
    let chapters_dir = book_dir.join("chapters");
    let mut source_text = String::new();
    if chapters_dir.exists() {
        let mut files: Vec<_> = fs::read_dir(&chapters_dir).map(|d| d.filter_map(|e| e.ok()).collect::<Vec<_>>()).unwrap_or_default();
        files.sort_by_key(|e| e.file_name());
        for f in files.iter().rev().take(source_count) {
            if let Ok(c) = fs::read_to_string(f.path()) { source_text.push_str(&c); source_text.push_str("\n\n"); }
        }
    }

    // Compute basic metrics
    let draft_chars = draft_text.chars().filter(|c| !c.is_whitespace()).count();
    let source_lines: Vec<&str> = source_text.lines().collect();
    let draft_lines: Vec<&str> = draft_text.lines().collect();

    // Dialogue ratio (lines starting with "xxx：" or containing 「)
    let dialogue_re = regex::Regex::new(r".+[：:].+|「.+」").unwrap_or(regex::Regex::new(r".").unwrap());
    let source_dialogue = source_lines.iter().filter(|l| dialogue_re.is_match(l)).count();
    let draft_dialogue = draft_lines.iter().filter(|l| dialogue_re.is_match(l)).count();
    let source_ratio = if source_lines.is_empty() { 0.0 } else { source_dialogue as f64 / source_lines.len() as f64 };
    let draft_ratio = if draft_lines.is_empty() { 0.0 } else { draft_dialogue as f64 / draft_lines.len() as f64 };

    // Paragraph count
    let draft_paras = draft_text.split("\n\n").filter(|p| !p.trim().is_empty()).count();
    let avg_para_chars = if draft_paras > 0 { draft_chars / draft_paras } else { 0 };

    let red_flags: Vec<String> = Vec::new();
    let mut warnings: Vec<String> = Vec::new();
    if draft_ratio < source_ratio * 0.5 { warnings.push(format!("对白比例偏低 (draft {:.0}% vs source {:.0}%)", draft_ratio * 100.0, source_ratio * 100.0)); }

    Ok(serde_json::json!({
        "status": "success",
        "style_gate": {
            "status": if red_flags.is_empty() { "pass" } else { "fail" },
            "drafts": [{
                "red_flags": red_flags,
                "repair_plan": {
                    "gate_profile": {"name": "basic_style_check"},
                    "priority_metrics": {"avg_para": avg_para_chars, "dialogue_ratio": draft_ratio, "environment_density": 0.0, "exposition_density": 0.0}
                }
            }]
        },
        "metrics": {
            "draft_chars": draft_chars, "draft_paragraphs": draft_paras,
            "avg_para_chars": avg_para_chars,
            "source_dialogue_ratio": source_ratio, "draft_dialogue_ratio": draft_ratio
        },
        "warnings": warnings,
        "locks_scheduler": false,
        "author_revision_owner": "human_author"
    }).to_string())
}
