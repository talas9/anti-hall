//! The live state the action layer reads. The realtime state model (lane rt2) will implement this trait; until it merges the
//! tests use a fixture. Every method reads the source NOW (never a snapshot): the layer calls it again right before it acts,
//! so a fact that changed between the plan and the action is seen. `None` means "could not read", which the decision script
//! treats as not proven.
use serde_json::Value;

/// Facts about DevSwarm, as of the moment of the call.
pub trait LiveState {
    /// DevSwarm is installed and its app database is readable. False makes the whole layer inert.
    fn present(&self) -> bool;
    /// The current time, milliseconds since the epoch.
    fn now_ms(&self) -> i64;
    /// Ids of the active, tracked child workspaces (the auto-archive candidates).
    fn candidates(&self) -> Vec<String>;
    /// Ids whose liveness verdict is `stale` (the poke / escalate candidates).
    fn stale(&self) -> Vec<String>;
    /// The decision script's facts for `kind` on workspace `id` (see the script header for each kind's shape).
    fn facts(&self, kind: &str, id: &str) -> Option<Value>;
    /// Whether the app database now lists `id` as archived.
    fn archived(&self, id: &str) -> Option<bool>;
    /// What an auto-archived workspace looks like now, for the mistake signals: `{head, activityMs}` (its worktree's HEAD and the
    /// newest activity). `None` when it cannot be read.
    fn post_archive(&self, _id: &str) -> Option<Value> {
        None
    }
    /// The rows of a delete plan for archives older than `days`: each `{id, eligible, ...evidence}`.
    fn prune_rows(&self, days: u64) -> Vec<Value>;
}
