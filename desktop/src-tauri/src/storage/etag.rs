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

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    #[test]
    fn test_compute_etag_consistent() {
        let a = compute_etag("hello world");
        let b = compute_etag("hello world");
        assert_eq!(a, b);
        assert_eq!(a.len(), 64);
    }

    #[test]
    fn test_compute_etag_different() {
        assert_ne!(compute_etag("hello"), compute_etag("world"));
    }

    #[test]
    fn test_compute_file_etag() {
        let dir = std::env::temp_dir();
        let path = dir.join("test_etag.txt");
        let mut f = std::fs::File::create(&path).unwrap();
        f.write_all(b"test content").unwrap();
        let etag = compute_file_etag(&path).unwrap();
        assert_eq!(etag, compute_etag("test content"));
        std::fs::remove_file(&path).ok();
    }
}
