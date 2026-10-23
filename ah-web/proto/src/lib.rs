//! The wire types between the Command Center server and its page. The server sends `Snapshot` as the data of the
//! `snapshot` server-sent event; the page reads `Boot` once from the index file. No texts live here.
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

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
}

/// The engine's vital signs (`CTL pulse`), reduced to what the header shows.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
pub struct Pulse {
    /// Engine CPU since the previous pulse, parts per thousand of one core; `None` on the first pulse.
    pub cpu_permille: Option<u64>,
    /// Engine resident memory, KB.
    pub rss_kb: u64,
    /// Requests the engine has handled.
    pub requests: u64,
    /// Requests that failed.
    pub errors: u64,
    /// Seconds since the engine daemon started.
    pub uptime_s: u64,
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
