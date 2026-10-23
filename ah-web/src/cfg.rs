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

/// One entry of a topology node's menu: what the page shows and the engine arguments it runs (`{pid}`, `{viewer}`, `{id}` are filled by the server).
#[derive(Debug, Clone, Deserialize)]
pub struct TopoActionCfg {
    pub kind: String,
    pub name: String,
    pub label: String,
    pub confirm: bool,
    pub local: bool,
    pub needs_viewer: bool,
    pub args: Vec<String>,
}

/// A store that can be opened in the viewer: its id in the I/O registry and the id `diag file` takes.
#[derive(Debug, Clone, Deserialize)]
pub struct TopoViewer {
    pub store: String,
    pub file: String,
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
    pub number_units: Vec<ah_web_proto::NumUnit>,
    pub number_decimals: usize,
    pub number_raw_keys: Vec<String>,
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
    pub live_checks_max: usize,
    pub live_events_max: usize,
    pub live_rate_window_s: u64,
    pub live_block_window_s: u64,
    pub live_timeline_max: usize,
    pub live_panel_rows: usize,
    pub live_top_n: usize,
    pub live_tick_ms: u64,
    pub live_block_decisions: Vec<String>,
    pub live_action_fx: BTreeMap<String, String>,
    pub live_outcome_fx: BTreeMap<String, String>,
    pub live_travel_fx: String,
    pub live_decision_fx: BTreeMap<String, String>,
    pub live_inject_decision: String,
    pub live_inject_fx: String,
    pub live_backfill: usize,
    pub live_actions_file: String,
    pub live_actions_max_bytes: u64,
    pub live_map_ttl_s: u64,
    pub live_map_timeout_ms: u64,
    pub live_map_parts: Vec<String>,
    pub manage_file: String,
    pub live_graph_rel: String,
    pub ops_cfg_rel: String,
    pub plugin_manifest_rel: String,
    pub live_jev_log_rel: String,
    pub live_rules_max: usize,
    pub live_scan_gap_ms: u64,
    pub live_jev_fx: BTreeMap<String, String>,
    pub live_col_gap: f32,
    pub live_row_gap: f32,
    pub health_cache_ms: u64,
    pub footprint_fallback_ms: u64,
    pub health_cpu_soft_permille: u64,
    pub health_cpu_hard_permille: u64,
    pub health_holders_max: usize,
    pub health_warn_pct: u64,
    pub topo_subsystems: Vec<ah_web_proto::TopoSub>,
    pub topo_viewers: Vec<TopoViewer>,
    pub topo_databases: Vec<String>,
    pub topo_actions: Vec<TopoActionCfg>,
    pub topo_warn_fail_pct: f64,
    pub topo_bad_fail_pct: f64,
    pub topo_idle_s: u64,
    pub topo_clients_max: usize,
    pub topo_poll_full_ms: u64,
    pub topo_poll_lite_ms: u64,
    pub topo_action_max_chars: usize,
    pub msg_topo_unknown: String,
    pub msg_topo_no_viewer: String,
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

    /// The number format of the page.
    pub fn number(&self) -> ah_web_proto::NumFmt {
        ah_web_proto::NumFmt { units: self.number_units.clone(), decimals: self.number_decimals }
    }

    /// The Live screen's part of the start-up data.
    pub fn live(&self) -> ah_web_proto::LiveCfg {
        ah_web_proto::LiveCfg {
            checks_max: self.live_checks_max,
            events_max: self.live_events_max,
            rate_window_s: self.live_rate_window_s,
            block_window_s: self.live_block_window_s,
            timeline_max: self.live_timeline_max,
            panel_rows: self.live_panel_rows,
            top_n: self.live_top_n,
            tick_ms: self.live_tick_ms,
            block_decisions: self.live_block_decisions.clone(),
            action_fx: self.live_action_fx.clone(),
            outcome_fx: self.live_outcome_fx.clone(),
            travel_fx: self.live_travel_fx.clone(),
            col_gap: self.live_col_gap,
            row_gap: self.live_row_gap,
            rules_max: self.live_rules_max,
            scan_gap_ms: self.live_scan_gap_ms,
            jev_fx: self.live_jev_fx.clone(),
        }
    }

    /// The Health and Topology screens' part of the start-up data (the engine arguments and viewer files stay on the server).
    pub fn topo(&self) -> ah_web_proto::TopoCfg {
        ah_web_proto::TopoCfg {
            subsystems: self.topo_subsystems.clone(),
            viewers: self.topo_viewers.iter().map(|v| v.store.clone()).collect(),
            actions: self
                .topo_actions
                .iter()
                .map(|a| ah_web_proto::TopoActionDef { kind: a.kind.clone(), name: a.name.clone(), label: a.label.clone(), confirm: a.confirm, local: a.local, needs_viewer: a.needs_viewer })
                .collect(),
            databases: self.topo_databases.clone(),
            warn_fail_pct: self.topo_warn_fail_pct,
            bad_fail_pct: self.topo_bad_fail_pct,
            idle_s: self.topo_idle_s,
            clients_max: self.topo_clients_max,
            poll_full_ms: self.topo_poll_full_ms,
            poll_lite_ms: self.topo_poll_lite_ms,
            holders_max: self.health_holders_max,
            warn_pct: self.health_warn_pct,
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

/// The graph component's config as the JSON text the page reads: every `[web.graph.<path>]` table's `value` at `<path>`.
pub fn graph_json(path: &Path) -> Result<String, String> {
    let text = std::fs::read_to_string(path).map_err(|e| format!("{}: {e}", path.display()))?;
    let doc: toml::Table = text.parse().map_err(|e| format!("{}: {e}", path.display()))?;
    let graph = doc.get("web").and_then(|w| w.get("graph")).and_then(toml::Value::as_table).ok_or("no [web.graph] section")?;
    fn walk(t: &toml::Table, out: &mut serde_json::Map<String, serde_json::Value>) {
        for (k, v) in t {
            match v.as_table() {
                Some(sub) if sub.contains_key("value") && sub.contains_key("doc") => {
                    out.insert(k.clone(), serde_json::to_value(&sub["value"]).unwrap_or_default());
                }
                Some(sub) => {
                    let mut child = serde_json::Map::new();
                    walk(sub, &mut child);
                    out.insert(k.clone(), serde_json::Value::Object(child));
                }
                None => {}
            }
        }
    }
    let mut root = serde_json::Map::new();
    walk(graph, &mut root);
    serde_json::to_string(&serde_json::Value::Object(root)).map_err(|e| e.to_string())
}
