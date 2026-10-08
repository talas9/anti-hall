//! The gates of `hooks/jev-weekly-scorecard.js` (SessionStart).
use super::*;
use crate::checks::guardkit::settings::Undecidable;

/// The registered `jev-weekly-scorecard` check.
pub struct JevWeeklyScorecard;

/// True when the weekly report would read no row at all: no retained generation of the decision log
/// (`jev-assist.js` `retainedLogFiles`: `<log>.<n>` and the log itself) holds a line that is not blank
/// (`readNdjsonFiles` skips blank lines). A line that does not parse as JSON is skipped by Node too, but this does not
/// decide that, so such a file leaves the report to Node.
fn no_log_rows(log: &str) -> bool {
    let p = std::path::Path::new(log);
    let (Some(dir), Some(base)) = (p.parent(), p.file_name().and_then(|b| b.to_str())) else { return false };
    // `fs.readdirSync` failing yields no file at all, the live log included.
    let Ok(rd) = std::fs::read_dir(dir) else { return true };
    let prefix = format!("{base}.");
    rd.flatten().all(|e| {
        let name = e.file_name();
        let Some(name) = name.to_str() else { return true };
        let generation = name.strip_prefix(&prefix).is_some_and(|n| !n.is_empty() && n.bytes().all(|b| b.is_ascii_digit()));
        if name != base && !generation {
            return true;
        }
        // An unreadable file (a directory, a dangling link) is skipped, as `readFileSync` throwing is.
        let Ok(bytes) = std::fs::read(e.path()) else { return true };
        crate::checks::guardkit::text::lossy_owned(bytes).split('\n').all(|l| trimmed(l).is_empty())
    })
}

/// The hook's answer, when the engine can give it; `Err` when the Node hook must run.
///
/// The Node hook returns, in this order: in a judge child; with Jev off; with the weekly notice off; in a DevSwarm child
/// workspace; with the latch younger than a week. Past all of them it writes the latch, then builds the 7-day report
/// and names the first integration ready to switch. With no decision row on disk the report is empty and the hook
/// stops after the latch: the engine does that itself. Any row leaves the report (scripts/jev-report.js `buildReport`,
/// its KEEP/REMOVE verdicts and the mode lookup) and the latch write that precedes it to Node.
pub(crate) fn decide(_payload: &Value, st: &Settings, root: &str) -> Gate {
    if judge_child(st) {
        return Ok(Verdict::Allow);
    }
    if !is_true(st, "session_gates.jev_enabled_setting", legacy_enabled_strict(st), root)? {
        return Ok(Verdict::Allow);
    }
    // `get('jev', 'weeklyNotice', true) !== false`
    if get_setting(st, defaults::raw("jev_weekly.notice_setting"), Some(Value::Bool(true)), root)? == Some(Value::Bool(false)) {
        return Ok(Verdict::Allow);
    }
    if st.env.get(defaults::text("session_gates.child_branch_env")).is_some_and(|v| !trimmed(v).is_empty()) {
        return Ok(Verdict::Allow);
    }
    let key = defaults::text("jev_weekly.latch_key");
    let last = stored_time(st, defaults::text("jev_weekly.latch_file"), key).unwrap_or(0.0);
    let now = now_ms();
    if now - last < defaults::num("jev_weekly.period_ms") as f64 {
        return Ok(Verdict::Allow);
    }
    let dir = format!("{}/{}", st.home, defaults::text("session_gates.anti_hall_dir"));
    if !no_log_rows(&paths::join(&dir, defaults::text("jev_weekly.decision_log"))) {
        return Err(Undecidable);
    }
    // `writeLatch`: best effort, a failure is swallowed and the (empty) report still runs.
    let file = paths::join(&dir, defaults::text("jev_weekly.latch_file"));
    let tmp = format!("{file}{}{}", defaults::text("jev_weekly.latch_tmp_infix"), std::process::id());
    crate::discard::harmless(write_like_node(&file, &tmp, &format!("{{{}:{}}}", Value::from(key), now as u64)));
    Ok(Verdict::Allow)
}

gate_check!(JevWeeklyScorecard, "jev-weekly-scorecard", "jev_weekly.summary", decide);
