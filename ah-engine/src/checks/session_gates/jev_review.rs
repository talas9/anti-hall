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

/// `realHomeUnderTest(resolveHome(...))`: a test marker is set and the home is the password database one, where the Node
/// hook's `resolveHome` throws (and the hook prints nothing). The engine leaves that case to Node.
fn real_home_under_test(st: &Settings) -> bool {
    let set = |k: &str| st.env.get(k).is_some_and(|v| !v.is_empty());
    if set(defaults::text("session_gates.allow_real_home_env")) || !defaults::list("session_gates.test_markers").iter().any(|k| set(k)) {
        return false;
    }
    crate::checks::jsport::home::real_home()
        .is_some_and(|r| crate::checks::git::util::resolve(&st.home, "", "/") == crate::checks::git::util::resolve(&r, "", "/"))
}

/// jev-recommend `headlessAllowed`: `jev.recommendNoticeHeadless`, whose default turns true under `context.protocolLevel`
/// full while the setting is not set anywhere (`source(...) === 'default'`).
fn headless_allowed(st: &Settings, root: &str) -> Result<bool, Undecidable> {
    // A null fallback comes back only when no tier holds a value: the setting's source is its default.
    let set = get_setting(st, defaults::raw("jev_review.headless_setting"), Some(Value::Null), root)?;
    if set == Some(Value::Null) {
        let level = get_setting(st, defaults::raw("jev_review.protocol_level_setting"), None, root)?;
        return Ok(level.as_ref().and_then(Value::as_str) == Some(defaults::text("jev_review.protocol_full")));
    }
    Ok(set == Some(Value::Bool(true)))
}

/// The hook's answer, when the engine can give it; `Err` when the Node hook must run.
///
/// With Jev and the semantic judge both off there is no legacy-key notice and no review line, so only the "recommend Jev"
/// notice can speak: it is silent when switched off, in a non-interactive run it is not allowed in, and for 30 days after
/// it was shown. When it is due the engine writes its latch and shows it, as `lib/jev-recommend.js` `sessionNotice` does
/// (a latch it cannot write shows nothing). With Jev or the judge on, the other two notices are Node's (the review line
/// reads the review log and records what it showed; the legacy-key notice probes key files and the Jev client config).
pub(crate) fn decide(payload: &Value, st: &Settings, root: &str) -> Gate {
    if judge_child(st) || subagent_payload(payload) {
        return Ok(Verdict::Allow);
    }
    if real_home_under_test(st) {
        return Err(Undecidable);
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
        return Ok(Verdict::Allow);
    }
    let headless = st.env.get(defaults::text("session_gates.entrypoint_env")).is_some_and(|e| e.starts_with(defaults::text("session_gates.headless_prefix")));
    if headless && !codex_payload(payload) && !headless_allowed(st, root)? {
        return Ok(Verdict::Allow);
    }
    let rel = defaults::text("jev_review.recommend_latch_file");
    let key = defaults::text("jev_review.latch_key");
    let last = stored_time(st, rel, key).unwrap_or(0.0);
    let now = now_ms();
    if last > 0.0 && last <= now && now - last < defaults::num("jev_review.remind_every_ms") as f64 {
        return Ok(Verdict::Allow);
    }
    let file = paths::join(&format!("{}/{}", st.home, defaults::text("session_gates.anti_hall_dir")), rel);
    let tmp = format!("{file}.{}{}", std::process::id(), defaults::text("jev_review.latch_tmp_suffix"));
    let body = format!("{{{}:{}}}\n", Value::from(key), now as u64);
    if write_like_node(&file, &tmp, &body).is_err() {
        return Ok(Verdict::Allow);
    }
    Ok(Verdict::Advisory(advisory_json(event_name(payload), defaults::text("jev_review.recommend_notice"))))
}

gate_check!(JevReviewReminder, "jev-review-reminder", "jev_review.summary", decide);
