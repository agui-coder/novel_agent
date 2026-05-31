use serde::{Deserialize, Serialize};
use std::io::{BufRead, BufReader, Write};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;

pub struct SidecarHandle {
    process: Child,
    pub stdin: std::process::ChildStdin,
}

impl SidecarHandle {
    pub fn new(python_path: &str, sidecar_script: &str) -> Result<Self, String> {
        let mut child = Command::new(python_path)
            .arg(sidecar_script)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| format!("Failed to start Python sidecar: {}", e))?;

        let stdin = child.stdin.take().ok_or("Failed to open sidecar stdin")?;
        Ok(SidecarHandle { process: child, stdin })
    }

    pub fn send(&mut self, request: &SidecarRequest) -> Result<(), String> {
        let json = serde_json::to_string(request).map_err(|e| format!("JSON error: {}", e))?;
        self.stdin.write_all(json.as_bytes()).map_err(|e| format!("Write error: {}", e))?;
        self.stdin.write_all(b"\n").map_err(|e| format!("Write error: {}", e))?;
        self.stdin.flush().map_err(|e| format!("Flush error: {}", e))?;
        Ok(())
    }

    pub fn kill(&mut self) {
        self.process.kill().ok();
    }
}

#[derive(Debug, Serialize, Deserialize)]
pub struct SidecarRequest {
    pub method: String,
    pub params: serde_json::Value,
    #[serde(default)]
    pub id: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct SidecarResponse {
    pub id: Option<String>,
    pub result: Option<serde_json::Value>,
    pub error: Option<String>,
}

pub struct SidecarManager {
    handle: Mutex<Option<SidecarHandle>>,
    python_path: String,
    script_path: String,
}

impl SidecarManager {
    pub fn new(python_path: String, script_path: String) -> Self {
        SidecarManager {
            handle: Mutex::new(None),
            python_path,
            script_path,
        }
    }

    pub fn ensure_started(&self) -> Result<(), String> {
        let mut guard = self.handle.lock().map_err(|e| format!("Lock error: {}", e))?;
        if guard.is_none() {
            *guard = Some(SidecarHandle::new(&self.python_path, &self.script_path)?);
        }
        Ok(())
    }

    pub fn send_request(&self, method: &str, params: serde_json::Value) -> Result<SidecarResponse, String> {
        self.ensure_started()?;
        let mut guard = self.handle.lock().map_err(|e| format!("Lock error: {}", e))?;
        let handle = guard.as_mut().ok_or("Sidecar not started")?;

        let request = SidecarRequest {
            method: method.to_string(),
            params,
            id: Some(uuid::Uuid::new_v4().to_string()),
        };
        handle.send(&request)?;

        // Read response line
        let stdout = handle.process.stdout.as_mut().ok_or("No stdout")?;
        let mut reader = BufReader::new(stdout);
        let mut line = String::new();
        reader.read_line(&mut line).map_err(|e| format!("Read error: {}", e))?;

        serde_json::from_str(&line).map_err(|e| format!("Parse error: {}", e))
    }

    pub fn stop(&self) {
        if let Ok(mut guard) = self.handle.lock() {
            if let Some(ref mut h) = *guard {
                h.kill();
            }
            *guard = None;
        }
    }
}
