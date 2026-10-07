//! Built-in `check = "orch-on-spawn"`: a port of the silent half of the Node orch-on-spawn hook (PreToolUse on Agent, Task
//! and Workflow; Codex's spawn tool).
//!
//! The hook delivers the full orchestration text once per context epoch, on the coordinator's first spawn, but only when
//! the SessionStart hook left a marker that says the text is still owed (`pending`, an opt-in mode). In every other case
//! it prints nothing, and that is the case this check answers: a call that is not a spawn, a payload without a session, a
//! switched-off feature, a skipped guard, the `full` protocol level, a subagent's own call, a missing or settled marker.
//! A pending marker defers to Node, which owns the claim race, the lease and the transcript scan; nothing is touched
//! before the deferral, so Node sees the state exactly as it was.
//!
//! Mirrors `hooks/orch-on-spawn.js` `main` up to the marker check.
use crate::checks::git::util::Settings;
use crate::checks::guardkit::settings::{get_bool, get_enum, is_skipped};
use crate::checks::spawnctx::orch_state::read_marker;
use crate::checks::spawnctx::{Home, os_homedir, state_home, subagent_by_payload};
use crate::checks::{Check, Verdict};
use crate::defaults;
use crate::reqenv::RequestEnv;
use crate::rules::Subject;
use serde_json::Value;

#[cfg(test)]
mod tests;

/// The check's decision on one payload. `None`: nothing to say.
pub fn decide(p: &Value, st: &Settings) -> Option<Verdict> {
    if !p.is_object() {
        return None;
    }
    if let Some(tool) = p.get("tool_name").and_then(Value::as_str)
        && !defaults::list("orch_on_spawn.spawn_tools").contains(&tool)
    {
        return None;
    }
    let sid = p.get("session_id").and_then(Value::as_str).filter(|s| !s.is_empty())?;
    if os_homedir(&st.env).is_none() {
        return Some(Verdict::Defer);
    }
    if !get_bool(st, defaults::raw("orch_state.setting")) || is_skipped(st, defaults::text("orch_state.skip_name")) {
        return None;
    }
    if get_enum(st, defaults::raw("orch_state.protocol_setting")) == defaults::text("orch_state.full_level") || subagent_by_payload(p) {
        return None;
    }
    let Home::Ok(home) = state_home(&st.env) else { return None };
    let pending = defaults::list("orch_state.decisions")[0];
    match read_marker(&home, sid) {
        Some(m) if m.decision == pending => Some(Verdict::Defer),
        _ => None,
    }
}

/// The registered `orch-on-spawn` check.
pub struct OrchOnSpawn;

impl Check for OrchOnSpawn {
    fn name(&self) -> &'static str {
        "orch-on-spawn"
    }

    fn summary(&self) -> &'static str {
        defaults::text("orch_on_spawn.summary")
    }

    fn run(&self, _s: &Subject<'_>, _opts: &Value) -> Option<Verdict> {
        Some(Verdict::Defer)
    }

    fn run_env(&self, _s: &Subject<'_>, payload: &Value, _opts: &Value, env: &RequestEnv) -> Option<Verdict> {
        decide(payload, &Settings::from_env(env)).or(Some(Verdict::Allow))
    }
}
