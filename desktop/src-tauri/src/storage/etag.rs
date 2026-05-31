use sha2::{Digest, Sha256};

pub fn compute_etag(content: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(content.as_bytes());
    hex::encode(hasher.finalize())
}

pub fn compute_file_etag(path: &std::path::Path) -> Result<String, String> {
    let content = std::fs::read_to_string(path)
        .map_err(|e| format!("Failed to read file for etag: {}", e))?;
    Ok(compute_etag(&content))
}
