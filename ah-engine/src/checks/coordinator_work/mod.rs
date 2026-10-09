//! What the payload alone says about the main thread: the Codex marker test and the subagent marker test of `coordinator-detect.js`
//! (`isCodexPayload`, `isSubagentByPayload`). The `coordinator-work-guard` check itself is the plugin script
//! `engine/logic/coordinator-work-guard.js`; `command` (the last compiled check) shares these two tests until it is a script too.
// Discard triage (E3): every `.ok()` / `unwrap_or_default()` in this file is a deliberate keep, for these reasons:
// - an absent field is the empty value
// A failure that must be seen goes through `crate::discard` instead.

use crate::defaults;
use serde_json::Value;

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
