use crate::AppState;
use serde::{Deserialize, Serialize};
use std::fs;
use tauri::State;

#[derive(Debug, Serialize)]
pub struct ReadChapterResult {
    pub status: String,
    pub book_id: String,
    pub chapter_index: u32,
    pub file_name: String,
    pub content: String,
    pub size_chars: usize,
}

#[tauri::command]
pub fn read_chapter(
    state: State<AppState>,
    book_id: Option<String>,
    book_name: Option<String>,
    chapter_index: u32,
) -> Result<ReadChapterResult, String> {
    let id = crate::storage::resolve_book_id(&state.storage_root, book_id.as_deref(), book_name.as_deref())?;
    let book_dir = std::path::Path::new(&state.storage_root).join(&id);
    let chapters_dir = book_dir.join("chapters");

    let prefix = format!("{:04}", chapter_index);
    let candidates: Vec<_> = fs::read_dir(&chapters_dir)
        .map_err(|_| "Chapters directory not found".to_string())?
        .filter_map(|e| e.ok())
        .filter(|e| e.file_name().to_string_lossy().starts_with(&prefix))
        .collect();

    if candidates.is_empty() {
        return Err(format!("Chapter {} not found", chapter_index));
    }

    let path = candidates[0].path();
    let content = fs::read_to_string(&path).map_err(|e| format!("Read error: {}", e))?;

    Ok(ReadChapterResult {
        status: "success".into(),
        book_id: id,
        chapter_index,
        file_name: path.file_name().unwrap_or_default().to_string_lossy().into(),
        size_chars: content.len(),
        content,
    })
}

#[derive(Debug, Serialize)]
pub struct SearchChapterResult {
    pub status: String,
    pub book_id: String,
    pub keyword: String,
    pub hits: Vec<ChapterHit>,
}

#[derive(Debug, Serialize)]
pub struct ChapterHit {
    pub chapter_index: u32,
    pub file_name: String,
    pub count: usize,
}

#[tauri::command]
pub fn search_chapter_index(
    state: State<AppState>,
    book_id: Option<String>,
    book_name: Option<String>,
    keyword: String,
) -> Result<SearchChapterResult, String> {
    let id = crate::storage::resolve_book_id(&state.storage_root, book_id.as_deref(), book_name.as_deref())?;
    let book_dir = std::path::Path::new(&state.storage_root).join(&id);
    let chapters_dir = book_dir.join("chapters");

    let mut hits = Vec::new();
    if let Ok(entries) = fs::read_dir(&chapters_dir) {
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            if !name.ends_with(".md") {
                continue;
            }
            if let Ok(content) = fs::read_to_string(entry.path()) {
                let count = content.matches(&keyword).count();
                if count > 0 {
                    if let Some(idx) = parse_chapter_index(&name) {
                        hits.push(ChapterHit { chapter_index: idx, file_name: name, count });
                    }
                }
            }
        }
    }

    hits.sort_by_key(|h| h.chapter_index);

    Ok(SearchChapterResult {
        status: "success".into(),
        book_id: id,
        keyword,
        hits,
    })
}

fn parse_chapter_index(name: &str) -> Option<u32> {
    let num_part = name.split('_').next()?.split('.').next()?;
    num_part.parse().ok()
}

#[derive(Debug, Serialize)]
pub struct ExtractHighlightsResult {
    pub status: String,
    pub book_id: String,
    pub chapter_index: u32,
    pub hits: Vec<HighlightHit>,
    pub total_hits: usize,
}

#[derive(Debug, Serialize)]
pub struct HighlightHit {
    pub keyword: String,
    pub position: usize,
    pub snippet: String,
}

#[tauri::command]
pub fn extract_chapter_highlights(
    state: State<AppState>,
    book_id: Option<String>,
    book_name: Option<String>,
    chapter_index: u32,
    keywords: String,
    context_sentences: Option<usize>,
) -> Result<ExtractHighlightsResult, String> {
    let id = crate::storage::resolve_book_id(&state.storage_root, book_id.as_deref(), book_name.as_deref())?;
    let book_dir = std::path::Path::new(&state.storage_root).join(&id);
    let chapters_dir = book_dir.join("chapters");

    let prefix = format!("{:04}", chapter_index);
    let candidates: Vec<_> = fs::read_dir(&chapters_dir)
        .map_err(|_| "Chapters directory not found".to_string())?
        .filter_map(|e| e.ok())
        .filter(|e| e.file_name().to_string_lossy().starts_with(&prefix))
        .collect();

    if candidates.is_empty() {
        return Ok(ExtractHighlightsResult {
            status: "success".into(), book_id: id, chapter_index, hits: vec![], total_hits: 0,
        });
    }

    let content = fs::read_to_string(candidates[0].path()).map_err(|e| format!("Read error: {}", e))?;
    let kw_list: Vec<&str> = keywords.split(',').map(|s| s.trim()).filter(|s| !s.is_empty()).collect();
    let ctx = context_sentences.unwrap_or(2).min(6).max(1);
    let mut hits = Vec::new();
    let mut total_chars = 0usize;
    let max_chars = 1000usize;

    for kw in kw_list.iter().take(20) {
        let mut pos = 0usize;
        while pos < content.len() && total_chars < max_chars {
            if let Some(idx) = content[pos..].find(kw) {
                let abs = pos + idx;
                let mut start = abs.saturating_sub(200);
                let mut end = (abs + kw.len() + 200).min(content.len());

                // Expand to sentence boundaries
                for _ in 0..ctx {
                    for boundary in &['。', '！', '？', '\n'] {
                        if let Some(bs) = content[..abs].rfind(*boundary).filter(|&i| i > start) {
                            start = bs + boundary.len_utf8();
                        }
                        if let Some(be) = content[end..].find(*boundary) {
                            end = (end + be + boundary.len_utf8()).min(content.len());
                        }
                    }
                }

                let snippet = content[start..end].trim().to_string();
                if !snippet.is_empty() {
                    total_chars += snippet.len();
                    hits.push(HighlightHit { keyword: kw.to_string(), position: abs, snippet });
                }
                pos = abs + kw.len();
            } else {
                break;
            }
        }
    }

    Ok(ExtractHighlightsResult {
        status: "success".into(),
        book_id: id,
        chapter_index,
        total_hits: hits.len(),
        hits,
    })
}

#[derive(Debug, Serialize)]
pub struct ValidateChapterLengthsResult {
    pub status: String,
    pub book_id: String,
    pub file_name: String,
    pub chapters: Vec<ChapterLengthInfo>,
}

#[derive(Debug, Serialize)]
pub struct ChapterLengthInfo {
    pub title: String,
    pub non_whitespace_chars: usize,
    pub status: String,
    pub under_min: bool,
    pub over_max: bool,
}

#[tauri::command]
pub fn validate_chapter_lengths(
    state: State<AppState>,
    book_id: Option<String>,
    book_name: Option<String>,
    file_name: Option<String>,
    min_chars: Option<usize>,
    target_chars: Option<usize>,
    max_chars: Option<usize>,
) -> Result<ValidateChapterLengthsResult, String> {
    let id = crate::storage::resolve_book_id(&state.storage_root, book_id.as_deref(), book_name.as_deref())?;
    let book_dir = std::path::Path::new(&state.storage_root).join(&id);
    let fname = file_name.unwrap_or_else(|| "chapter_draft.md".into());
    let min_c = min_chars.unwrap_or(2200);
    let max_c = max_chars.unwrap_or(3200);

    let file_path = book_dir.join(&fname);
    let content = fs::read_to_string(&file_path).map_err(|_| format!("File not found: {}", fname))?;

    let mut chapters = Vec::new();
    let mut current_title = String::new();
    let mut current_content = String::new();

    for line in content.lines() {
        let trimmed = line.trim();
        let level = trimmed.chars().take_while(|&c| c == '#').count();
        if level == 2 && trimmed.chars().nth(level) == Some(' ') {
            if !current_title.is_empty() {
                let nwc = current_content.chars().filter(|c| !c.is_whitespace()).count();
                chapters.push(ChapterLengthInfo {
                    title: current_title,
                    non_whitespace_chars: nwc,
                    status: if nwc < min_c { "under_min" } else if nwc > max_c { "over_max" } else { "ok" }.into(),
                    under_min: nwc < min_c,
                    over_max: nwc > max_c,
                });
            }
            current_title = trimmed[2..].trim().to_string();
            current_content = String::new();
        } else if !current_title.is_empty() {
            current_content.push_str(line);
            current_content.push('\n');
        }
    }

    // Don't forget the last chapter
    if !current_title.is_empty() {
        let nwc = current_content.chars().filter(|c| !c.is_whitespace()).count();
        chapters.push(ChapterLengthInfo {
            title: current_title,
            non_whitespace_chars: nwc,
            status: if nwc < min_c { "under_min" } else if nwc > max_c { "over_max" } else { "ok" }.into(),
            under_min: nwc < min_c,
            over_max: nwc > max_c,
        });
    }

    Ok(ValidateChapterLengthsResult {
        status: "success".into(),
        book_id: id,
        file_name: fname,
        chapters,
    })
}
