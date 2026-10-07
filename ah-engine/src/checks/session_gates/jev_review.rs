//! The gates of `hooks/jev-review-reminder.js` (SessionStart), with those of the two notices it carries.
use super::*;
use crate::checks::guardkit::settings::Undecidable;

/// The registered `jev-review-reminder` check.
pub struct JevReviewReminder;

/// `isSubagentPayload(payload)`.
fn subagent_payload(p: &Value) -> bool {
    let Some(o) = p.as_object() else { return false };
    let truthy = |v: &Value| match v {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::Number(n) => n.as_f64().is_some_and(|f| f != 0.0),
        Value::String(s) => !s.is_empty(),
        _ => true,
    };
    // `payload.agent_id || payload.agent_type`, then `isSidechain === true || is_sidechain === true`
    defaults::list("session_gates.agent_key_markers").iter().any(|k| o.get(*k).is_some_and(truthy))
        || defaults::list("session_gates.sidechain_flags").iter().any(|k| o.get(*k) == Some(&Value::Bool(true)))
}

/// `isCodexPayload(payload)`.
fn codex_payload(p: &Value) -> bool {
    let Some(o) = p.as_object() else { return false };
    if o.get("tool_name").and_then(Value::as_str) == Some(defaults::text("session_gates.codex_tool")) {
        return true;
    }
    defaults::list("session_gates.codex_fields").iter().all(|k| o.get(*k).and_then(Value::as_str).is_some_and(|s| !s.is_empty()))
}

/// `Ok(())` when the Node hook would stay silent without writing anything; `Err` when it must run.
///
/// With Jev and the semantic judge both off there is no legacy-key notice and no review line, so only the "recommend Jev"
/// notice can speak: it is silent when switched off, and for 30 days after it was shown. A non-interactive run decides
/// that through settings the engine does not read, and a notice that is due writes its own latch, so both go to Node.
pub(crate) fn decide(payload: &Value, st: &Settings, root: &str) -> Gate {
    if judge_child(st) || subagent_payload(payload) {
        return Ok(());
    }
    // credentials.sessionNotice (Jev on, or the judge on) and the review line (Jev on) need the Node hook.
    if is_true(st, "session_gates.jev_enabled_setting", false, root)?
        || is_true(st, "session_gates.jev_semantic_judge_setting", false, root)?
        || is_true(st, "session_gates.jev_enabled_setting", legacy_enabled_strict(st), root)?
    {
        return Err(Undecidable);
    }
    // jev-recommend: applicable only while Jev is off and the notice is not switched off.
    if get_setting(st, defaults::raw("jev_review.recommend_setting"), Some(Value::Bool(true)), root)? == Some(Value::Bool(false)) {
        return Ok(());
    }
    let headless = st.env.get(defaults::text("session_gates.entrypoint_env")).is_some_and(|e| e.starts_with(defaults::text("session_gates.headless_prefix")));
    if headless && !codex_payload(payload) {
        return Err(Undecidable);
    }
    let last = stored_time(st, defaults::text("jev_review.recommend_latch_file"), "lastShownTs").unwrap_or(0.0);
    let now = now_ms();
    if last > 0.0 && last <= now && now - last < defaults::num("jev_review.remind_every_ms") as f64 {
        return Ok(());
    }
    Err(Undecidable)
}

gate_check!(JevReviewReminder, "jev-review-reminder", "jev_review.summary", decide);
