//! The typed view of the plugin's `web.toml`. Every key is a field without a default: a missing or mistyped key is a load
//! error naming it, never a silent fallback to a value compiled in here.
use serde::Deserialize;
use std::collections::BTreeMap;
use std::path::Path;

/// All settings the server reads.
#[derive(Debug, Clone, Deserialize)]
pub struct Settings {
    pub enabled: bool,
    pub bind_host: String,
    pub port_min: u16,
    pub port_max: u16,
    pub bind_attempts: u32,
    pub idle_exit_s: u64,
    pub idle_check_s: u64,
    pub token_bytes: usize,
    pub cookie_name: String,
    pub state_file: String,
    pub static_dir: String,
    pub pkg_dir: String,
    pub index_file: String,
    pub agents_cmd: Vec<String>,
    pub agents_poll_ms: u64,
    pub agents_timeout_ms: u64,
    pub agents_max_bytes: usize,
    pub sse_keepalive_s: u64,
    pub max_streams: usize,
    pub heartbeat_warn_s: u64,
    pub heartbeat_stale_s: u64,
    pub csp: String,
    pub mime: BTreeMap<String, String>,
    pub boot_marker: String,
    pub step_max_chars: usize,
    pub kind_order: Vec<String>,
    pub msg_unauthorized: String,
    pub msg_busy: String,
    pub msg_not_found: String,
    pub ui: BTreeMap<String, String>,
}

impl Settings {
    /// Read `path` (a `web.toml`: every `[web.<name>]` table's `value`).
    pub fn load(path: &Path) -> Result<Settings, String> {
        let text = std::fs::read_to_string(path).map_err(|e| format!("{}: {e}", path.display()))?;
        let doc: toml::Table = text.parse().map_err(|e| format!("{}: {e}", path.display()))?;
        let web = doc.get("web").and_then(toml::Value::as_table).ok_or("no [web] section")?;
        let mut flat = toml::Table::new();
        for (name, entry) in web {
            if let Some(v) = entry.get("value") {
                flat.insert(name.clone(), v.clone());
            }
        }
        toml::Value::Table(flat).try_into().map_err(|e| format!("{}: {e}", path.display()))
    }
}
