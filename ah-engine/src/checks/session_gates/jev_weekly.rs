//! The gates of `hooks/jev-weekly-scorecard.js` (SessionStart).
use super::*;
use crate::checks::guardkit::settings::Undecidable;

/// The registered `jev-weekly-scorecard` check.
pub struct JevWeeklyScorecard;

/// `Ok(())` when the Node hook would stay silent without writing anything; `Err` when it must run.
///
/// The Node hook returns, in this order: in a judge child; with Jev off; with the weekly notice off; in a DevSwarm child
/// workspace; with the latch younger than a week. Past all of them it writes the latch and builds the report, which is
/// Node's to do.
pub(crate) fn decide(_payload: &Value, st: &Settings, root: &str) -> Gate {
    if judge_child(st) {
        return Ok(());
    }
    if !is_true(st, "session_gates.jev_enabled_setting", legacy_enabled_strict(st), root)? {
        return Ok(());
    }
    // `get('jev', 'weeklyNotice', true) !== false`
    if get_setting(st, defaults::raw("jev_weekly.notice_setting"), Some(Value::Bool(true)), root)? == Some(Value::Bool(false)) {
        return Ok(());
    }
    if st.env.get(defaults::text("session_gates.child_branch_env")).is_some_and(|v| !trimmed(v).is_empty()) {
        return Ok(());
    }
    let last = stored_time(st, defaults::text("jev_weekly.latch_file"), "lastCheckedTs").unwrap_or(0.0);
    if now_ms() - last < defaults::num("jev_weekly.period_ms") as f64 {
        return Ok(());
    }
    Err(Undecidable)
}

gate_check!(JevWeeklyScorecard, "jev-weekly-scorecard", "jev_weekly.summary", decide);
