use crate::storage::{self, layout, BookMetadata};
use serde::{Deserialize, Serialize};
use sha2::Digest;
use std::fs;
use tauri::State;

use crate::AppState;

#[derive(Debug, Serialize, Deserialize)]
pub struct InitBookParams {
    pub book_name: String,
    #[serde(default)]
    pub book_id: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct InitBookResult {
    pub status: String,
    pub book_id: String,
    pub book_name: String,
    pub created: bool,
}

#[tauri::command]
pub fn init_book(
    state: State<AppState>,
    book_name: String,
    book_id: Option<String>,
) -> Result<InitBookResult, String> {
    let resolved_id = book_id.unwrap_or_else(|| {
        let normalized = book_name.trim().to_lowercase();
        let hash_suffix = &sha2::Sha256::digest(normalized.as_bytes());
        let hash_hex = hex::encode(hash_suffix);
        format!("{}_{}", normalized.replace(' ', "_"), &hash_hex[..8])
    });

    let book_dir = std::path::Path::new(&state.storage_root).join(&resolved_id);
    let created = !book_dir.exists();

    layout::ensure_book_layout(&state.storage_root, &resolved_id, &book_name)?;

    Ok(InitBookResult {
        status: "success".into(),
        book_id: resolved_id,
        book_name,
        created,
    })
}

#[derive(Debug, Serialize)]
pub struct BookSearchResult {
    pub status: String,
    pub books: Vec<BookMetadata>,
}

#[tauri::command]
pub fn search_books(state: State<AppState>, query: String) -> Result<BookSearchResult, String> {
    let mut books = Vec::new();
    let dir = fs::read_dir(&state.storage_root)
        .map_err(|e| format!("Failed to read storage: {}", e))?;

    for entry in dir.flatten() {
        let meta_path = entry.path().join("metadata.json");
        if let Ok(content) = fs::read_to_string(&meta_path) {
            if let Ok(meta) = serde_json::from_str::<BookMetadata>(&content) {
                let q = query.to_lowercase();
                if meta.book_name.to_lowercase().contains(&q)
                    || meta.book_id.to_lowercase().contains(&q)
                    || query.is_empty()
                {
                    books.push(meta);
                }
            }
        }
    }

    Ok(BookSearchResult {
        status: "success".into(),
        books,
    })
}

#[derive(Debug, Serialize)]
pub struct PingResult {
    pub status: String,
    pub book_id: String,
    pub exists: bool,
    pub layout_issues: Vec<String>,
}

#[tauri::command]
pub fn ping_book(state: State<AppState>, book_id: String) -> Result<PingResult, String> {
    let book_dir = std::path::Path::new(&state.storage_root).join(&book_id);
    let exists = book_dir.exists();
    let issues = if exists {
        layout::inspect_book_layout(&state.storage_root, &book_id).unwrap_or_default()
    } else {
        vec!["book not found".into()]
    };

    Ok(PingResult {
        status: if exists { "ok" } else { "not_found" }.into(),
        book_id,
        exists,
        layout_issues: issues,
    })
}
