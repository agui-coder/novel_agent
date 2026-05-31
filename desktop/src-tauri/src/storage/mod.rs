pub mod etag;
pub mod layout;

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};

pub const TRACKED_LAYOUT_DIRS: &[&str] = &["chapters"];
pub const TRACKED_LAYOUT_FILES: &[&str] = &[
    "metadata.json",
    "world_model.md",
    "status_card.md",
    "summary.md",
    "style_fingerprint.md",
    "style_review.md",
    "style_constraints_for_continuation.md",
    "error_archive.md",
    "domain_rules.md",
    "brainstorm.md",
    "master_outline.md",
    "arc_outline.md",
    "chapter_outline.md",
    "chapter_draft.md",
];

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct BookMetadata {
    pub book_name: String,
    pub book_id: String,
    #[serde(default)]
    pub created: Option<String>,
}

pub fn resolve_storage_root(resource_dir: &Path) -> String {
    // Check env var first
    if let Ok(env_path) = std::env::var("STORAGE_ROOT") {
        let p = Path::new(&env_path);
        if p.exists() {
            return p.to_string_lossy().to_string();
        }
    }

    // Try resource_dir/storage
    let resource_storage = resource_dir.join("storage");
    if resource_storage.exists() {
        return resource_storage.to_string_lossy().to_string();
    }

    // Dev mode: walk up to find novel_git_server/storage
    let cwd_storage = std::env::current_dir().ok().map(|d| d.join("storage")).filter(|p| p.exists());
    if let Some(ref p) = cwd_storage {
        if p.exists() { return p.to_string_lossy().to_string(); }
    }
    let mut current = resource_dir.to_path_buf();
    for _ in 0..6 {
        let candidate = current.join("novel_git_server").join("storage");
        if candidate.exists() {
            return candidate.to_string_lossy().to_string();
        }
        if let Some(parent) = current.parent() {
            current = parent.to_path_buf();
        } else {
            break;
        }
    }

    // Last resort: create storage under resource dir
    fs::create_dir_all(&resource_storage).ok();
    resource_storage.to_string_lossy().to_string()
}

pub fn get_book_paths(storage_root: &str, book_id: &str) -> Result<PathBuf, String> {
    let book_dir = Path::new(storage_root).join(book_id);
    if !book_dir.exists() {
        return Err(format!("Book not found: {}", book_id));
    }
    Ok(book_dir)
}

pub fn find_book_id(storage_root: &str, book_name: &str) -> Option<String> {
    let dir = match fs::read_dir(storage_root) {
        Ok(d) => d,
        Err(_) => return None,
    };

    for entry in dir.flatten() {
        let meta_path = entry.path().join("metadata.json");
        if let Ok(content) = fs::read_to_string(&meta_path) {
            if let Ok(meta) = serde_json::from_str::<BookMetadata>(&content) {
                if meta.book_name == book_name || meta.book_id == book_name {
                    return Some(meta.book_id);
                }
            }
        }
    }
    None
}

pub fn resolve_book_id(
    storage_root: &str,
    book_id: Option<&str>,
    book_name: Option<&str>,
) -> Result<String, String> {
    if let Some(id) = book_id {
        if !id.trim().is_empty() {
            let book_dir = Path::new(storage_root).join(id.trim());
            if book_dir.exists() {
                return Ok(id.trim().to_string());
            }
        }
    }
    if let Some(name) = book_name {
        if !name.trim().is_empty() {
            if let Some(id) = find_book_id(storage_root, name.trim()) {
                return Ok(id);
            }
        }
    }
    Err("Book not found. Provide valid book_id or book_name.".into())
}
