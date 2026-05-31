use serde_json::{json, Value};
use std::fs;
use std::path::Path;

fn config_path() -> std::path::PathBuf {
    let base = std::env::var("APPDATA")
        .or_else(|_| std::env::var("HOME"))
        .unwrap_or_default();
    let dir = Path::new(&base).join("novel-agent");
    fs::create_dir_all(&dir).ok();
    dir.join("config.json")
}

#[tauri::command]
pub fn get_config() -> Result<Value, String> {
    let path = config_path();
    if path.exists() {
        let content = fs::read_to_string(&path).map_err(|e| format!("Read: {}", e))?;
        serde_json::from_str(&content).map_err(|e| format!("Parse: {}", e))
    } else {
        Ok(json!({}))
    }
}

#[tauri::command]
pub fn save_config(values: Value) -> Result<Value, String> {
    crate::engine::llm::invalidate_config_cache();
    let path = config_path();
    let mut config = if path.exists() {
        let content = fs::read_to_string(&path).unwrap_or_default();
        serde_json::from_str(&content).unwrap_or(json!({}))
    } else {
        json!({})
    };

    if let Value::Object(ref mut map) = config {
        if let Value::Object(updates) = values {
            for (k, v) in updates {
                map.insert(k, v);
            }
        }
    }

    let json_str = serde_json::to_string_pretty(&config).map_err(|e| format!("Serialize: {}", e))?;
    fs::write(&path, json_str).map_err(|e| format!("Write: {}", e))?;
    Ok(config)
}
