//! The wire types between the Command Center server and its page. The server sends `Snapshot` as the data of the
//! `snapshot` server-sent event; the page reads `Boot` once from the index file. No texts live here.
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

/// The event stream the page subscribes to (a URL of this package's own protocol, not a setting).
pub const STREAM_PATH: &str = "/api/stream";
/// The server-sent event name carrying a [`Snapshot`].
pub const SNAPSHOT_EVENT: &str = "snapshot";
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

/// What the server knows now.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
pub struct Snapshot {
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
}
