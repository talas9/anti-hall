//! Built-in `check = "coordinator-work-guard"` (the PostToolUse window pass is in [`post`]): the part of the Node coordinator-work-guard (PreToolUse and PostToolUse
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
// Discard triage (E3): every `.ok()` / `unwrap_or_default()` in this file is a deliberate keep, for these reasons:
// - an absent field is the empty value
// A failure that must be seen goes through `crate::discard` instead.

use crate::checks::git::util::Settings;
use crate::checks::guardkit::text::js_trim;
use crate::checks::{Check, Verdict};
use crate::defaults;
use crate::reqenv::RequestEnv;
use crate::rules::Subject;
use serde_json::Value;

pub mod post;
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
pub(crate) fn payload_is_codex(p: &Value) -> bool {
    defaults::list("coordinator_work.codex_markers").iter().all(|k| p.get(k).and_then(Value::as_str).is_some_and(|s| !s.is_empty()))
}

/// True when the payload alone proves this is not the main thread. On a Codex payload any present, non-null subagent
/// marker counts; on a Claude payload a truthy one does (and the entrypoint variable, which the engine cannot see, is the
/// only other way to be a subagent, so its absence proves nothing).
///
/// Mirrors `coordinator-detect.js` `isCoordinator` (payload part), `isSubagent` and `isSubagentByPayload`.
pub(crate) fn subagent_by_payload(p: &Value) -> bool {
    let markers = defaults::list("coordinator_work.agent_markers");
    if payload_is_codex(p) { markers.iter().any(|k| present(p, k)) } else { markers.iter().any(|k| truthy(p.get(k))) }
}

/// True when the payload is a Codex payload by `coordinator-detect.js` `isCodexPayload`: it names the Codex-only tool, or
/// carries both Codex marker fields as non-empty strings. A payload that is not a JSON object is not.
fn is_codex_payload(p: &Value) -> bool {
    p.is_object() && (p.get("tool_name").and_then(Value::as_str) == Some(defaults::text("coordinator_work.codex_tool")) || payload_is_codex(p))
}

/// True when the session is the main thread, by `coordinator-detect.js` `isCoordinator`: the payload carries no subagent
/// marker and the host's entry point (read from the request environment, never the daemon's) is a main-thread one. An
/// absent or unknown entry point is not the main thread (the Node guards fail open there).
///
/// Mirrors `coordinator-detect.js` `isCoordinator`.
pub(crate) fn is_coordinator(p: &Value, env: &RequestEnv) -> bool {
    let entry = env.get(defaults::text("coordinator_work.entrypoint_env")).unwrap_or("");
    if is_codex_payload(p) {
        return entry.is_empty() && !defaults::list("coordinator_work.agent_markers").iter().any(|k| present(p, k));
    }
    if subagent_by_payload(p) || entry == defaults::text("coordinator_work.subagent_entrypoint") {
        return false;
    }
    defaults::list("coordinator_work.main_entrypoints").contains(&entry) || entry.starts_with(defaults::text("coordinator_work.main_entrypoint_prefix"))
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
        Some(decide(payload).unwrap_or(Verdict::Allow))
    }

    /// PostToolUse records the call in the window ([`post`]); PreToolUse is [`decide`]. A silent PostToolUse answer is `Allow`,
    /// not `None`: `None` would hand the call to the Node hook, which would record it a second time.
    fn run_env(&self, s: &Subject<'_>, payload: &Value, opts: &Value, env: &RequestEnv) -> Option<Verdict> {
        if s.event == defaults::text("coordinator_work.post_event") {
            let root = opts.get("plugin_root").and_then(Value::as_str).or_else(|| env.get(defaults::env_name("plugin_root"))).unwrap_or_default();
            return Some(post::decide_post(payload, &Settings::from_env(env), env, root).unwrap_or(Verdict::Allow));
        }
        Some(decide(payload).unwrap_or(Verdict::Allow))
    }
}
