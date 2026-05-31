use std::fs;
use std::path::Path;

use super::TRACKED_LAYOUT_DIRS;
use super::TRACKED_LAYOUT_FILES;
use super::BookMetadata;
use serde_json;

pub fn ensure_book_layout(storage_root: &str, book_id: &str, book_name: &str) -> Result<(), String> {
    let book_dir = Path::new(storage_root).join(book_id);

    // Create book directory
    fs::create_dir_all(&book_dir)
        .map_err(|e| format!("Failed to create book directory: {}", e))?;

    // Create tracked subdirectories
    for dir_name in TRACKED_LAYOUT_DIRS {
        fs::create_dir_all(book_dir.join(dir_name)).ok();
    }

    // Create metadata.json if missing
    let meta_path = book_dir.join("metadata.json");
    if !meta_path.exists() {
        let meta = BookMetadata {
            book_id: book_id.to_string(),
            book_name: book_name.to_string(),
            created: Some(chrono::Utc::now().format("%Y-%m-%d").to_string()),
        };
        let json = serde_json::to_string_pretty(&meta)
            .map_err(|e| format!("Failed to serialize metadata: {}", e))?;
        fs::write(&meta_path, json)
            .map_err(|e| format!("Failed to write metadata.json: {}", e))?;
    }

    // Create tracked files if missing (as empty files)
    for file_name in TRACKED_LAYOUT_FILES {
        if file_name == &"metadata.json" {
            continue; // already handled above
        }
        let file_path = book_dir.join(file_name);
        if !file_path.exists() {
            fs::write(&file_path, "").ok();
        }
    }

    // Initialize git if missing
    let git_dir = book_dir.join(".git");
    if !git_dir.exists() {
        git2::Repository::init(&book_dir)
            .map_err(|e| format!("Failed to init git: {}", e))?;
    }

    Ok(())
}

pub fn inspect_book_layout(storage_root: &str, book_id: &str) -> Result<Vec<String>, String> {
    let book_dir = Path::new(storage_root).join(book_id);
    if !book_dir.exists() {
        return Ok(vec!["book directory missing".into()]);
    }

    let mut issues = Vec::new();

    for dir_name in TRACKED_LAYOUT_DIRS {
        if !book_dir.join(dir_name).exists() {
            issues.push(format!("directory missing: {}", dir_name));
        }
    }

    for file_name in TRACKED_LAYOUT_FILES {
        if !book_dir.join(file_name).exists() {
            issues.push(format!("file missing: {}", file_name));
        }
    }

    if !book_dir.join(".git").exists() {
        issues.push(".git missing".into());
    }

    Ok(issues)
}
