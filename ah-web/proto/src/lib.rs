//! The wire types between the Command Center server and its page. The server sends `Snapshot` as the data of the
//! `snapshot` server-sent event; the page reads `Boot` once from the index file. No texts live here.
pub mod tel;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

pub mod ops;

/// The event stream the page subscribes to (a URL of this package's own protocol, not a setting).
pub const STREAM_PATH: &str = "/api/stream";
/// The server-sent event name carrying a [`Snapshot`] (on connect, and when a stream missed a change).
pub const SNAPSHOT_EVENT: &str = "snapshot";
/// The server-sent event name carrying a [`Delta`] (every later change).
pub const DELTA_EVENT: &str = "delta";
/// The POST route that runs one agent action ([`ActionReq`] in, [`ActionRes`] out).
pub const ACTION_PATH: &str = "/api/action";
/// The GET route (the agent id is appended) that answers an agent's details.
pub const DETAIL_PATH: &str = "/api/agent/";
/// The element of the index file that holds the [`Boot`] JSON.
pub const BOOT_ELEMENT_ID: &str = "boot";

/// One tracked agent, reduced to what the page shows.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
pub struct Agent {
    /// The tracker's id (a session id or a sub-agent id).
    pub id: String,
    /// What to call it: its name, else its project folder, else a short id.
    pub label: String,
    /// `main`, `workspace`, `subagent`, `teammate`, `codex` or `heartbeat`.
    pub kind: String,
    /// `primary`, `solo`, ... when the tracker knows one.
    pub role: String,
    /// `running`, `waiting` or `done`.
    pub state: String,
    /// The parent agent's id, empty for a root.
    pub parent: String,
    /// The project directory.
    pub project: String,
    /// Seconds since the agent last produced output; `None` when unknown.
    pub last_output_s: Option<u64>,
    /// The agent's current step ("doing now"), cut to the configured length.
    pub step: String,
    /// Output tokens so far.
    pub tokens_out: u64,
    /// Tool calls so far.
    pub tool_calls: u64,
    /// The turn ended and only a shell command the agent started is still running (the registry says `shell`): shown as
    /// "idle, shell running", not "running".
    #[serde(default)]
    pub idle_shell: bool,
    /// The project's top folder (the git checkout the directory belongs to); empty when the agent reports no directory.
    #[serde(default)]
    pub project_root: String,
    /// What to call that project.
    #[serde(default)]
    pub project_name: String,
    /// Not a tracked agent: a parent that a sub-agent names but the tracker does not list.
    #[serde(default)]
    pub placeholder: bool,
}

/// The engine's vital signs (`CTL pulse`), reduced to what the header shows.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
pub struct Pulse {
    /// Engine CPU since the previous pulse, parts per thousand of one core; `None` on the first pulse.
    pub cpu_permille: Option<u64>,
    /// Engine resident memory, KB.
    pub rss_kb: u64,
    /// Engine physical footprint, KB: the figure its memory budget is measured on; `None` from an engine that does not report it.
    #[serde(default)]
    pub footprint_kb: Option<u64>,
    /// Requests the engine has handled.
    pub requests: u64,
    /// Requests that failed.
    pub errors: u64,
    /// Seconds since the engine daemon started.
    pub uptime_s: u64,
    /// The engine's version text (`CTL pulse` `version`).
    #[serde(default)]
    pub version: String,
    /// First 8 hex digits of the engine executable's SHA-256 (`CTL pulse` `build_sha`); empty from an engine that does not report it.
    #[serde(default)]
    pub build_sha: String,
    /// The plugin version the engine loaded (`CTL pulse` `plugin_version`); empty when not reported.
    #[serde(default)]
    pub plugin_version: String,
    /// The build version the hook client (ah-hook) last reported to the engine; empty before its first call.
    #[serde(default)]
    pub hook_version: String,
    /// The version-compatibility mismatches the engine reported and this server found, one sentence each; empty when all hold.
    #[serde(default)]
    pub compat: Vec<String>,
}

/// One line of the activity feed, already in plain language.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
pub struct FeedItem {
    /// Order of arrival (unique, rising).
    pub n: u64,
    /// When it happened, ms since the epoch.
    pub ts_ms: u64,
    /// `block`, `advisory`, `error` or `mesh`: picks the colour.
    pub tone: String,
    /// The sentence.
    pub text: String,
}

/// One check decision from the engine's decisions ring, ready to animate.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
pub struct Decision {
    /// The engine's ring sequence number.
    pub seq: u64,
    pub ts_ms: u64,
    /// The hook event that ran the check.
    pub event: String,
    pub check: String,
    /// The session that ran the hook (an agent's tracker id for a main session); empty when the engine did not record it.
    #[serde(default)]
    pub session: String,
    /// `allow`, `block`, `advisory`, `error` or `defer`.
    pub decision: String,
    /// The id of the rule that named the check.
    pub rule: String,
    /// The check's wall time, microseconds.
    pub us: u64,
    pub injected_bytes: u64,
    /// The effect colour key the decision plays in (from `web.live_decision_fx`).
    pub fx: String,
}

/// One line of the engine's action log (an action taken, refused or failed).
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
pub struct ActionEvt {
    pub ts_ms: u64,
    pub feature: String,
    pub action: String,
    pub target: String,
    /// `ok`, `refused` or `failed`.
    pub outcome: String,
    pub reason: String,
}

/// One row of the engine's Jev decision log (what was asked, not the prompt: the log holds hashes, verdicts, confidences, latencies, costs).
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
pub struct JevEvt {
    pub ts_ms: u64,
    /// The integration that asked (`agentWaste`, `stopClaim`, ...).
    pub id: String,
    /// Jev's answer as the log wrote it (JSON text); empty when it gave none.
    pub verdict: String,
    pub conf: Option<f64>,
    /// `on` (may change the outcome), `shadow` (logged only) or `off`.
    pub mode: String,
    pub latency_ms: u64,
    pub cost_usd: Option<f64>,
    /// Why Jev did not act, when the log says (`reason`).
    pub reason: String,
    /// Whether the call changed the outcome.
    pub changed: bool,
    /// The check that asked, when the engine recorded it.
    #[serde(default)]
    pub check: String,
    /// Who answered: `jev` (it judged), `cache`, or `baseline-only` (Jev is off and the rule decided alone); empty when not logged.
    #[serde(default)]
    pub backend: String,
}

/// The hook wiring for the Live screen: which checks answer which events (from `describe`).
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
pub struct LiveMap {
    /// Event names.
    pub events: Vec<String>,
    /// Check names.
    pub checks: Vec<String>,
    /// (event, check) pairs, in dispatch order.
    pub edges: Vec<(String, String)>,
}

/// The route that answers the [`LiveMap`].
pub const LIVE_MAP_PATH: &str = "/api/live/map";
/// The GET route that answers the [`Health`] document.
pub const HEALTH_PATH: &str = "/api/health";
/// The POST route that runs one topology node action ([`TopoReq`] in, [`ActionRes`] out).
pub const TOPO_ACTION_PATH: &str = "/api/topo/action";

/// One holder of the engine's memory ledger (`status` `memory.ledger.heap.holders`).
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
pub struct Holder {
    pub name: String,
    pub bytes: u64,
    /// Its own soft and hard limits, bytes; 0 when it has none.
    pub soft: u64,
    pub hard: u64,
    /// `ok`, `soft` or `hard`, in the engine's words.
    pub level: String,
}

/// One client (a hook session) of the engine's I/O registry (`CTL io`).
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
pub struct ClientRow {
    pub id: String,
    /// What to call it: the project and the session or agent title the tracker knows it by; empty when the tracker does not know it.
    #[serde(default)]
    pub label: String,
    pub calls: u64,
    pub timeouts: u64,
    pub fail_open: u64,
    pub cold_starts: u64,
    pub last_ms: u64,
    pub p50_us: u64,
    pub p95_us: u64,
    /// The percentile fell in the histogram's last bucket: the figure is then a lower bound ("at least"), not a ceiling.
    #[serde(default)]
    pub p50_over: bool,
    #[serde(default)]
    pub p95_over: bool,
}

/// One store (a file or a database) of the engine's I/O registry.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
pub struct StoreRow {
    pub id: String,
    pub reads: u64,
    pub writes: u64,
    pub bytes_in: u64,
    pub bytes_out: u64,
    pub errors: u64,
    pub last_ms: u64,
    pub p50_us: u64,
    pub p95_us: u64,
    #[serde(default)]
    pub p50_over: bool,
    #[serde(default)]
    pub p95_over: bool,
}

/// The Health and Topology screens' data: one reduced reading of the engine (`pulse`, `status` and `io`). A field the engine does not
/// report is `None` or empty, never a made-up value.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
pub struct Health {
    /// When the server read it, ms since the epoch.
    pub at_ms: u64,
    /// False when the engine did not answer (the rest is then empty).
    pub engine_ok: bool,
    pub pid: u64,
    pub uptime_s: u64,
    pub version: String,
    /// CPU since the previous pulse, parts per thousand of one core; with its soft and hard bars (from `web.health_cpu_*`).
    pub cpu_permille: Option<u64>,
    pub cpu_soft_permille: u64,
    pub cpu_hard_permille: u64,
    /// The budget metric, KB, with the engine's soft and hard memory limits; RSS is for the tooltip.
    pub footprint_kb: u64,
    pub rss_kb: u64,
    pub mem_soft_kb: u64,
    pub mem_hard_kb: u64,
    pub requests: u64,
    pub errors: u64,
    pub slow_replies: u64,
    pub busy_replies: u64,
    pub panics: u64,
    pub restarts: u64,
    pub queue_depth: u64,
    pub workers: u64,
    /// The engine's own degraded flag and the reason it gives (empty when none).
    pub degraded: bool,
    pub degraded_reason: String,
    /// Load average per core; `None` when the platform did not say.
    pub load_per_core: Option<f64>,
    /// Free disk, KB; `None` when the engine does not report it.
    pub disk_free_kb: Option<u64>,
    /// The biggest memory holders, largest first.
    pub holders: Vec<Holder>,
    /// False when the engine's I/O registry is switched off (clients and stores are then empty).
    pub io_enabled: bool,
    pub clients: Vec<ClientRow>,
    pub stores: Vec<StoreRow>,
}

/// One subsystem of the topology: its label and the stores it uses (`web.topo_subsystems`).
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
pub struct TopoSub {
    pub id: String,
    pub label: String,
    pub stores: Vec<String>,
}

/// One entry of a topology node's menu (`web.topo_actions`).
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
pub struct TopoActionDef {
    /// Node kind it applies to: `client`, `engine`, `subsystem` or `store`.
    pub kind: String,
    pub name: String,
    /// Key of the page's text table.
    pub label: String,
    pub confirm: bool,
    /// True for the entry that only shows what the page already has (no engine call).
    pub local: bool,
    /// True when it needs the store to have a viewer (`web.topo_viewers`).
    pub needs_viewer: bool,
}

/// The Topology screen's settings, from `web.toml`.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
pub struct TopoCfg {
    pub subsystems: Vec<TopoSub>,
    /// Store ids that can be opened in the viewer.
    pub viewers: Vec<String>,
    pub actions: Vec<TopoActionDef>,
    /// Store ids that are databases (drawn as such; the rest are files).
    pub databases: Vec<String>,
    /// Failure share (per cent of calls) at which a client or store turns amber, then red.
    pub warn_fail_pct: f64,
    pub bad_fail_pct: f64,
    /// Seconds without a call after which a client or store reads as idle.
    pub idle_s: u64,
    /// Most clients drawn.
    pub clients_max: usize,
    /// Milliseconds between two readings, in Full and in Lite.
    pub poll_full_ms: u64,
    pub poll_lite_ms: u64,
    /// Most memory holders listed.
    pub holders_max: usize,
    /// Memory (% of the soft limit) and CPU (% of the soft bar) at which the headline turns to a warning.
    pub warn_pct: u64,
}

/// One action on one topology node.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
pub struct TopoReq {
    /// The node's kind and its id inside it (a store id, `engine`, a subsystem id, a client id).
    pub kind: String,
    pub id: String,
    pub action: String,
    pub confirmed: bool,
}

/// What the server knows now.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
pub struct Snapshot {
    /// The sequence number of the last change in this snapshot; the next [`Delta`] is `seq + 1`.
    pub seq: u64,
    /// The engine's vital signs; `None` before the first pulse.
    pub pulse: Option<Pulse>,
    /// The newest feed lines, oldest first.
    pub feed: Vec<FeedItem>,
    /// When the engine produced the list, in ms since the epoch; 0 before the first successful read.
    pub generated_ms: u64,
    /// False when the last read of the engine failed (the list is then the last good one, or empty).
    pub engine_ok: bool,
    /// The agents that are not finished.
    pub agents: Vec<Agent>,
    /// The newest decisions, oldest first (so a page that opens late has something to show).
    #[serde(default)]
    pub decisions: Vec<Decision>,
}

/// Everything the page needs before the first snapshot: its texts and thresholds, all from the plugin's `web.toml`.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
pub struct Boot {
    /// Label by key.
    pub ui: BTreeMap<String, String>,
    /// Heartbeat colour thresholds, in seconds.
    pub heartbeat_warn_s: u64,
    /// See `heartbeat_warn_s`.
    pub heartbeat_stale_s: u64,
    /// Order of agent kinds in the tree.
    pub kind_order: Vec<String>,
    /// `auto`, `full` or `lite`: the tier the page starts in.
    pub mode: String,
    /// Header pill colour limits.
    pub limits: PulseLimits,
    /// The action menu, in order.
    pub actions: Vec<ActionDef>,
    /// Feed lines kept on screen.
    pub feed_max: usize,
    /// The graph component's config (`web_graph.toml` as JSON text).
    #[serde(default)]
    pub graph: String,
    /// The Live screen's settings.
    #[serde(default)]
    pub live: LiveCfg,
    /// The plugin's version (from its `plugin.json`); empty when unreadable.
    #[serde(default)]
    pub plugin_version: String,
    /// This server's version.
    #[serde(default)]
    pub web_version: String,
    /// How the page writes long numbers.
    #[serde(default)]
    pub number: NumFmt,
    /// The Health and Topology screens' settings.
    #[serde(default)]
    pub topo: TopoCfg,
}

/// The Live screen's settings (`web.live_*`).
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
pub struct LiveCfg {
    /// Most check nodes drawn.
    pub checks_max: usize,
    /// Most event nodes drawn.
    pub events_max: usize,
    /// Seconds a window of the rate figures covers.
    pub rate_window_s: u64,
    /// Seconds the "blocks" counter covers.
    pub block_window_s: u64,
    /// Rows of the timeline strip.
    pub timeline_max: usize,
    /// Decisions kept per node for the side panel.
    pub panel_rows: usize,
    /// Checks in the top list.
    pub top_n: usize,
    /// Milliseconds between counter and wire-rate updates.
    pub tick_ms: u64,
    /// Decision names that count as a block.
    pub block_decisions: Vec<String>,
    /// Action name -> effect kind (`ripple`, `ring`, `shake`).
    pub action_fx: std::collections::BTreeMap<String, String>,
    /// Outcome (`ok`, `refused`, `failed`) -> effect colour key.
    pub outcome_fx: std::collections::BTreeMap<String, String>,
    /// Effect colour key of a decision's first leg.
    pub travel_fx: String,
    /// Node sizes and gaps of the three columns, in graph units.
    pub col_gap: f32,
    pub row_gap: f32,
    /// Most rule nodes drawn.
    pub rules_max: usize,
    /// Least time between two scan-line sweeps, ms.
    pub scan_gap_ms: u64,
    /// Jev mode -> effect colour key.
    pub jev_fx: std::collections::BTreeMap<String, String>,
    /// Hook event -> effect colour key of the packet that carries it.
    pub hook_fx: std::collections::BTreeMap<String, String>,
    /// Effect colour key of a hook event `hook_fx` does not name.
    pub hook_fx_default: String,
    /// The hook events the legend lists, in order.
    pub hook_legend: Vec<String>,
    /// How long after a judgement by Jev its node keeps glowing, ms.
    pub jev_glow_ms: u64,
}

/// Where the header pills turn amber and red (from `web.toml`).
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
pub struct PulseLimits {
    /// CPU, parts per thousand of one core.
    pub cpu_warn_permille: u64,
    /// See `cpu_warn_permille`.
    pub cpu_bad_permille: u64,
    /// Memory, MB.
    pub mem_warn_mb: u64,
    /// See `mem_warn_mb`.
    pub mem_bad_mb: u64,
    /// Failed requests.
    pub err_warn: u64,
    /// See `err_warn`.
    pub err_bad: u64,
}

/// A change since sequence `seq - 1`: only what moved.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
pub struct Delta {
    /// The sequence number this delta brings the page to (a gap means the page missed one and reconnects).
    pub seq: u64,
    /// New engine-reachable flag, when it changed.
    pub engine_ok: Option<bool>,
    /// New list timestamp, when the agent list changed.
    pub generated_ms: Option<u64>,
    /// New vital signs, when they changed.
    pub pulse: Option<Pulse>,
    /// Agents that are new or changed.
    pub upsert: Vec<Agent>,
    /// Ids of agents that are gone.
    pub removed: Vec<String>,
    /// New feed lines.
    pub feed: Vec<FeedItem>,
    /// New decisions, oldest first.
    #[serde(default)]
    pub decisions: Vec<Decision>,
    /// New lines of the action log.
    #[serde(default)]
    pub actions: Vec<ActionEvt>,
    /// New rows of the Jev decision log.
    #[serde(default)]
    pub jev: Vec<JevEvt>,
}

/// One action on one agent, from the menu.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
pub struct ActionReq {
    /// The agent's tracker id.
    pub id: String,
    /// An action name from `web.actions` (`progress`, `ping`, `stop`).
    pub action: String,
    /// True once the person confirmed an action that asks for it.
    pub confirmed: bool,
}

/// The outcome of an action, in the engine verb's own words.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
pub struct ActionRes {
    /// True when the verb succeeded.
    pub ok: bool,
    /// `done`, `refused` or `failed`.
    pub outcome: String,
    /// The verb's message (or the refusal reason).
    pub message: String,
}

/// An agent's details (`CTL agents agent=<id>`), flattened to text rows.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
pub struct Detail {
    /// Label and value pairs.
    pub rows: Vec<(String, String)>,
    /// The agent's task list when the engine reports one; empty otherwise (the page then says there is none, it never invents one).
    #[serde(default)]
    pub tasks: Vec<TaskRow>,
}

/// One task of an agent's task list.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
pub struct TaskRow {
    pub subject: String,
    /// `pending`, `in_progress`, `completed` or `blocked` (the engine's words).
    pub status: String,
    pub priority: String,
    /// When it last changed, ms since the epoch; 0 when not reported.
    pub changed_ms: u64,
}

/// One entry of the action menu.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
pub struct ActionDef {
    /// The name sent in [`ActionReq`].
    pub name: String,
    /// The label key in the UI text table.
    pub label: String,
    /// True when the menu asks first.
    pub confirm: bool,
    /// True for the one that opens details (no engine call).
    pub local: bool,
}

/// One step of the number format: from `from` up, a number is divided by `div` and gets `suffix` (`web.number_units`).
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
pub struct NumUnit {
    pub suffix: String,
    pub from: u64,
    pub div: u64,
}

/// The one number format of the whole page (`web.number_units`, `web.number_decimals`): long numbers read as 12k, 1.1M.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
pub struct NumFmt {
    /// Ascending by `from`; the last step whose `from` the number reaches applies.
    pub units: Vec<NumUnit>,
    /// Digits after the point; a trailing zero part is dropped.
    pub decimals: usize,
}

impl NumFmt {
    /// `n` as text: whole below the first step, else scaled with its suffix.
    pub fn fmt(&self, n: u64) -> String {
        let Some(u) = self.units.iter().rev().find(|u| n >= u.from && u.div > 0) else {
            return n.to_string();
        };
        let text = format!("{:.*}", self.decimals, n as f64 / u.div as f64);
        let text = if text.contains('.') { text.trim_end_matches('0').trim_end_matches('.').to_string() } else { text };
        format!("{text}{}", u.suffix)
    }
}
