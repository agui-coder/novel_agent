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

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn setup_tmp() -> String {
        let dir = std::env::temp_dir().join(format!("novel_test_{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        dir.to_string_lossy().to_string()
    }

    #[test]

    #[test]
    fn test_find_book_id_by_name() {
        let root = setup_tmp();
        let book_dir = Path::new(&root).join("test_book_abc");
        fs::create_dir_all(&book_dir).unwrap();
        let meta = BookMetadata { book_id: "test_book_abc".into(), book_name: "测试书".into(), created: None };
        fs::write(book_dir.join("metadata.json"), serde_json::to_string(&meta).unwrap()).unwrap();

        let found = find_book_id(&root, "测试书");
        assert_eq!(found, Some("test_book_abc".into()));

        let not_found = find_book_id(&root, "不存在");
        assert_eq!(not_found, None);

        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn test_resolve_book_id_by_name() {
        let root = setup_tmp();
        let book_dir = Path::new(&root).join("found_by_name");
        fs::create_dir_all(&book_dir).unwrap();
        fs::write(book_dir.join("metadata.json"), r#"{"book_id":"found_by_name","book_name":"星辰大海"}"#).unwrap();

        let id = resolve_book_id(&root, None, Some("星辰大海")).unwrap();
        assert_eq!(id, "found_by_name");

        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn test_resolve_book_id_not_found() {
        let root = setup_tmp();
        let err = resolve_book_id(&root, Some("nonexistent"), None);
        assert!(err.is_err());
        fs::remove_dir_all(&root).ok();
    }
}
