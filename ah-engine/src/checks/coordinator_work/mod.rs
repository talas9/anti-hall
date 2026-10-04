//! Built-in `check = "coordinator-work-guard"`: the part of the Node coordinator-work-guard (PreToolUse and PostToolUse
//! on Bash) that can be decided exactly without the command classifier.
//!
//! The Node guard keeps a per-session window of the main thread's state-changing Bash calls, nudges once per crossing
//! of a threshold and blocks past a second one. Every one of those decisions needs `classifyBashWork` from
//! `command-guard.js` (planned with the command-guard port, D75) and, for "is this the main thread", the hook process's
//! `CLAUDE_CODE_ENTRYPOINT` (the engine does not see the hook's environment). What is decided here: a call that is not
//! a Bash call, has no session id, or carries a subagent marker in its payload is not the main thread, so the guard
//! says nothing, exactly as Node does. Every other call defers to the Node guard, which owns the window state; the
//! engine keeps no window of its own, so the two can never disagree about it.
//!
//! Mirrors `hooks/coordinator-work-guard.js` `main` (the early exits) and `hooks/coordinator-detect.js` `isCoordinator`
//! (the payload-only part).
use crate::checks::guardkit::text::js_trim;
use crate::checks::{Check, Verdict};
use crate::defaults;
use crate::rules::Subject;
use serde_json::Value;

#[cfg(test)]
mod tests;

/// JavaScript truthiness of a JSON value (`undefined`, `null`, `false`, `0`, `""` are falsy).
fn truthy(v: Option<&Value>) -> bool {
    match v {
        None | Some(Value::Null) => false,
        Some(Value::Bool(b)) => *b,
        Some(Value::Number(n)) => n.as_f64().is_some_and(|f| f != 0.0),
        Some(Value::String(s)) => !s.is_empty(),
        Some(_) => true,
    }
}

/// `'key' in payload && payload[key] != null`.
fn present(p: &Value, key: &str) -> bool {
    p.get(key).is_some_and(|v| !v.is_null())
}

/// A Codex payload: a non-empty string for each of the Codex marker fields (the `apply_patch` tool name is Codex-only too,
/// but this check only sees Bash).
///
/// Mirrors `coordinator-detect.js` `isCodexPayload`.
fn is_codex(p: &Value) -> bool {
    defaults::list("coordinator_work.codex_markers").iter().all(|k| p.get(k).and_then(Value::as_str).is_some_and(|s| !s.is_empty()))
}

/// True when the payload alone proves this is not the main thread. On a Codex payload any present, non-null subagent
/// marker counts; on a Claude payload a truthy one does (and the entrypoint variable, which the engine cannot see, is the
/// only other way to be a subagent, so its absence proves nothing).
///
/// Mirrors `coordinator-detect.js` `isCoordinator` (payload part), `isSubagent` and `isSubagentByPayload`.
fn subagent_by_payload(p: &Value) -> bool {
    let markers = defaults::list("coordinator_work.agent_markers");
    if is_codex(p) { markers.iter().any(|k| present(p, k)) } else { markers.iter().any(|k| truthy(p.get(k))) }
}

/// The check's decision on one payload. `None`: nothing to say.
///
/// Mirrors `hooks/coordinator-work-guard.js` `main`.
pub fn decide(p: &Value) -> Option<Verdict> {
    if !p.is_object() || p.get("tool_name").and_then(Value::as_str) != Some("Bash") {
        return None;
    }
    if p.get("session_id").and_then(Value::as_str).map(js_trim).is_none_or(str::is_empty) {
        return None;
    }
    if subagent_by_payload(p) {
        return None;
    }
    Some(Verdict::Defer)
}

/// The registered `coordinator-work-guard` check.
pub struct CoordinatorWorkGuard;

impl Check for CoordinatorWorkGuard {
    fn name(&self) -> &'static str {
        "coordinator-work-guard"
    }

    fn summary(&self) -> &'static str {
        defaults::text("coordinator_work.summary")
    }

    fn run(&self, s: &Subject<'_>, _opts: &Value) -> Option<Verdict> {
        (s.tool == Some("Bash")).then_some(Verdict::Defer)
    }

    fn run_payload(&self, _s: &Subject<'_>, payload: &Value, _opts: &Value) -> Option<Verdict> {
        decide(payload)
    }
}
