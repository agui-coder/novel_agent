use crate::AppState;
use crate::storage;
use serde::Serialize;
use sha2::Digest;
use std::fs;
use std::path::Path;
use tauri::State;

#[derive(Debug, Serialize)]
pub struct ImportPreview {
    pub book_name: String,
    pub source_dir: String,
    pub chapter_count: usize,
    pub total_chars: usize,
    pub chapters: Vec<ImportChapterInfo>,
    pub warnings: Vec<String>,
}

#[derive(Debug, Serialize)]
pub struct ImportChapterInfo {
    pub index: u32,
    pub title: String,
    pub source_file: String,
    pub target_file: String,
    pub chars: usize,
}

#[derive(Debug, Serialize)]
pub struct ImportResult {
    pub book_id: String,
    pub book_name: String,
    pub saved_count: usize,
    pub written_files: Vec<String>,
}

fn scan_chapters(source_dir: &Path) -> Result<(Vec<(u32, String, String, usize)>, Vec<String>), String> {
    let mut chapters: Vec<(u32, String, String, usize)> = Vec::new(); // (index, title, source_file, chars)
    let mut warnings = Vec::new();

    let mut files: Vec<_> = fs::read_dir(source_dir)
        .map_err(|e| format!("Cannot read directory: {}", e))?
        .filter_map(|e| e.ok())
        .map(|e| e.path())
        .filter(|p| {
            let ext = p.extension().and_then(|e| e.to_str()).unwrap_or("").to_lowercase();
            ext == "txt" || ext == "md"
        })
        .collect();
    files.sort();

    if files.is_empty() {
        return Err("No .txt or .md files found in directory".into());
    }

    let chapter_re = regex::Regex::new(r"^第[零一二三四五六七八九十百千0-9]+章").unwrap();

    for file_path in &files {
        let fname = file_path.file_name().unwrap_or_default().to_string_lossy().to_string();
        let content = fs::read_to_string(file_path).map_err(|e| format!("Read {}: {}", fname, e))?;

        if content.trim().is_empty() {
            warnings.push(format!("Skipped empty file: {}", fname));
            continue;
        }

        // Try splitting by chapter markers
        let mut found_chapters = false;
        let mut current_title = String::new();
        let mut current_text = String::new();

        for line in content.lines() {
            let trimmed = line.trim();
            if chapter_re.is_match(trimmed) {
                if !current_title.is_empty() && !current_text.trim().is_empty() {
                    let idx = chapters.len() as u32 + 1;
                    chapters.push((idx, current_title.clone(), fname.clone(), current_text.chars().filter(|c| !c.is_whitespace()).count()));
                }
                current_title = trimmed.to_string();
                current_text = String::new();
                found_chapters = true;
            } else if !current_title.is_empty() {
                current_text.push_str(line);
                current_text.push('\n');
            }
        }
        // Last chapter
        if !current_title.is_empty() && !current_text.trim().is_empty() {
            let idx = chapters.len() as u32 + 1;
            chapters.push((idx, current_title, fname.clone(), current_text.chars().filter(|c| !c.is_whitespace()).count()));
        }

        // If no chapter markers found, treat entire file as one chapter
        if !found_chapters {
            let idx = chapters.len() as u32 + 1;
            let title = fname.trim_end_matches(".txt").trim_end_matches(".md").to_string();
            chapters.push((idx, title, fname.clone(), content.chars().filter(|c| !c.is_whitespace()).count()));
        }
    }

    Ok((chapters, warnings))
}

#[tauri::command]
pub fn import_preview(state: State<'_, AppState>, source_dir: String) -> Result<ImportPreview, String> {
    let dir = Path::new(&source_dir);
    if !dir.is_dir() { return Err("Source is not a directory".into()); }

    let (chapters, warnings) = scan_chapters(dir)?;
    let total_chars: usize = chapters.iter().map(|c| c.3).sum();
    let book_name = dir.file_name().unwrap_or_default().to_string_lossy().to_string();

    Ok(ImportPreview {
        book_name,
        source_dir,
        chapter_count: chapters.len(),
        total_chars,
        chapters: chapters.into_iter().map(|(i, t, s, c)| { let tf = format!("{:04}_{}.md", i, sanitize_filename(&t)); ImportChapterInfo { index: i, title: t, source_file: s, target_file: tf, chars: c } }).collect(),
        warnings,
    })
}

#[tauri::command]
pub fn import_confirm(
    state: State<'_, AppState>,
    source_dir: String,
    book_name: String,
    book_id: Option<String>,
) -> Result<ImportResult, String> {
    let (chapters, _warnings) = scan_chapters(Path::new(&source_dir))?;
    if chapters.is_empty() { return Err("No chapters to import".into()); }

    let id = book_id.unwrap_or_else(|| {
        let normalized = book_name.trim().to_lowercase();
        let hash_hex = hex::encode(sha2::Sha256::digest(normalized.as_bytes()));
        let slug = normalized.replace(' ', "_").chars().filter(|c| c.is_alphanumeric() || *c == '_').take(30).collect::<String>();
        format!("{}_{}", slug, &hash_hex[..8])
    });
    let book_dir = Path::new(&state.storage_root).join(&id);
    let chapters_dir = book_dir.join("chapters");
    fs::create_dir_all(&chapters_dir).map_err(|e| format!("Create dir: {}", e))?;

    let meta = serde_json::json!({"book_id": &id, "book_name": &book_name, "created": &chrono::Utc::now().format("%Y-%m-%d").to_string()});
    let meta_json = serde_json::to_string_pretty(&meta).unwrap_or_default();
    fs::write(book_dir.join("metadata.json"), &meta_json).ok();

    // Create placeholder files
    for f in storage::TRACKED_LAYOUT_FILES {
        if *f != "metadata.json" && !book_dir.join(f).exists() {
            fs::write(book_dir.join(f), "").ok();
        }
    }
    fs::create_dir_all(book_dir.join("chapters")).ok();

    let mut written = Vec::new();
    for (idx, title, _src, chars) in &chapters {
        let fname = format!("{:04}_{}.md", idx, sanitize_filename(title));
        let heading = format!("# {}\n\n", title);
        let content = if *chars > 0 { heading } else { heading };
        let path = chapters_dir.join(&fname);
        fs::write(&path, &content).map_err(|e| format!("Write {}: {}", fname, e))?;
        written.push(fname);
    }

    // Init git
    git2::Repository::init(&book_dir).ok();
    // First commit
    if let Ok(repo) = git2::Repository::open(&book_dir) {
        if let Ok(mut idx) = repo.index() {
            idx.add_all(&["*"], git2::IndexAddOption::DEFAULT, None).ok();
            idx.write().ok();
            if let Ok(tree_id) = idx.write_tree() {
                if let Ok(tree) = repo.find_tree(tree_id) {
                    if let Ok(sig) = repo.signature() {
                        repo.commit(Some("HEAD"), &sig, &sig, "Initial import", &tree, &[]).ok();
                    }
                }
            }
        }
    }

    Ok(ImportResult { book_id: id, book_name, saved_count: written.len(), written_files: written })
}

fn sanitize_filename(s: &str) -> String {
    s.chars().map(|c| if c.is_alphanumeric() || c == '_' || c == '-' { c } else { '_' }).take(50).collect()
}
