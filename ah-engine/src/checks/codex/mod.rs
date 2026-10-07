//! The Codex availability and quota hooks, ported from Node: `codex-availability` (SessionStart), `codex-quota-detect`
//! (PostToolUse on Agent) and `codex-nudge` (Stop).
//!
//! All three share the quota record in `~/.anti-hall/codex-availability.json` ([`quota`]). Each answers exactly as its Node
//! hook does or defers to it.
pub mod availability;
pub mod detect;
pub mod nudge;
pub mod quota;

use crate::checks::git::util::Settings;
use crate::reqenv::RequestEnv;

/// The settings view of one request: the home directory and the environment the switch chain reads.
pub(crate) fn settings_of(env: &RequestEnv) -> Settings {
    Settings { home: env.get("HOME").unwrap_or("").to_string(), env: env.to_map() }
}

/// `ANTIHALL_JUDGE_CHILD=1`: the judge child's hooks are no-ops (`hooks/lib/judge-child-exit.js`).
pub(crate) fn judge_child(env: &RequestEnv) -> bool {
    env.get(crate::defaults::text("codex_handover.judge_child_env")) == Some(crate::defaults::text("codex_handover.judge_child_on"))
}

#[cfg(test)]
mod tests;
