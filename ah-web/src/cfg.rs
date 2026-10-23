//! The typed view of the plugin's `web.toml`. Every key is a field without a default: a missing or mistyped key is a load
//! error naming it, never a silent fallback to a value compiled in here.
use serde::Deserialize;
use std::collections::BTreeMap;
use std::path::Path;

/// One entry of the action menu: what the page shows and the engine arguments it runs (`{id}` is the agent's id).
#[derive(Debug, Clone, Deserialize)]
pub struct ActionCfg {
    pub name: String,
    pub label: String,
    pub confirm: bool,
    pub local: bool,
    pub done: String,
    pub args: Vec<String>,
}

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
    pub port: u16,
    pub mode: String,
    pub full_push_ms: u64,
    pub lite_push_ms: u64,
    pub push_min_ms: u64,
    pub ctl_timeout_ms: u64,
    pub ctl_max_bytes: usize,
    pub delta_ring: usize,
    pub pulse_min_interval_ms: u64,
    pub agents_poll_ms: u64,
    pub decisions_poll_ms: u64,
    pub mesh_poll_ms: u64,
    pub mesh_db_rel: String,
    pub mesh_limit: u64,
    pub feed_max: usize,
    pub feed_decisions_shown: Vec<String>,
    pub feed_text: BTreeMap<String, String>,
    pub feed_events: BTreeMap<String, String>,
    pub pulse_cpu_warn_permille: u64,
    pub pulse_cpu_bad_permille: u64,
    pub pulse_mem_warn_mb: u64,
    pub pulse_mem_bad_mb: u64,
    pub pulse_err_warn: u64,
    pub pulse_err_bad: u64,
    pub action_timeout_ms: u64,
    pub actions: Vec<ActionCfg>,
    pub detail_skip_keys: Vec<String>,
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
    pub msg_action_unknown: String,
    pub msg_action_bad_id: String,
    pub msg_action_confirm: String,
    pub msg_action_timeout: String,
    pub msg_action_failed: String,
    pub action_note_max_chars: usize,
    pub ui: BTreeMap<String, String>,
}

impl Settings {
    /// The page's start-up data: the part of the settings the page needs.
    pub fn limits(&self) -> ah_web_proto::PulseLimits {
        ah_web_proto::PulseLimits {
            cpu_warn_permille: self.pulse_cpu_warn_permille,
            cpu_bad_permille: self.pulse_cpu_bad_permille,
            mem_warn_mb: self.pulse_mem_warn_mb,
            mem_bad_mb: self.pulse_mem_bad_mb,
            err_warn: self.pulse_err_warn,
            err_bad: self.pulse_err_bad,
        }
    }

    /// The menu the page shows (the engine arguments stay on the server).
    pub fn menu(&self) -> Vec<ah_web_proto::ActionDef> {
        self.actions.iter().map(|a| ah_web_proto::ActionDef { name: a.name.clone(), label: a.label.clone(), confirm: a.confirm, local: a.local }).collect()
    }

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
