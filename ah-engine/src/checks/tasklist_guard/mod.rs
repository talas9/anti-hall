//! Built-in `check = "tasklist-guard"`: the non-blocking half of the Node tasklist-guard Stop hook.
//!
//! tasklist-guard blocks a Stop when real work was done and was not tracked as tasks, a task is stalled in progress, or the
//! per-session progress file is missing or stale. This check reproduces every Stop on which Node does not block, including the
//! file effects Node has there (the progress directory made, the progress and history indexes kept, the one resume-verification
//! nudge and its marker), and answers the plan-mode advisory and the resume nudge with the exact bytes Node prints. A Stop that
//! would block (work done, and no task activity, a stale task or a stale progress file) goes to the Node hook, which owns the
//! block texts, the loop state, the Jev consult, the acknowledgement and the stop budget (D74). Anything the port cannot read
//! exactly is deferred too.
//!
//! Mirrors `hooks/tasklist-guard.js` `main` up to the decision to block.
mod scan;

use crate::checks::git::util::Settings;
use crate::checks::guardkit::paths::join;
use crate::checks::guardkit::settings::{get_bool, get_number, is_skipped};
use crate::checks::guardkit::text::{js_trim, slice_utf16};
use crate::checks::task_lifecycle_log::append_index_line_if_absent;
use crate::checks::taskkit::jsval::{R, Unsure, get, truthy};
use crate::checks::taskkit::root::session_project_root;
use crate::checks::taskkit::workdetect::{Ctx, tmpdir};
use crate::checks::taskkit::{js_string, session_path_id, time};
use crate::checks::{Check, Exact, Verdict};
use crate::defaults;
use crate::reqenv::RequestEnv;
use crate::rules::Subject;
use serde_json::Value;
use std::path::Path;

#[cfg(test)]
mod tests;

/// `sanitizeReason(s)`: controls become spaces (newlines survive), runs of blanks collapse, blanks around a newline go, the text
/// is trimmed and cut with an ellipsis. `None` when the cut would split a surrogate pair.
fn sanitize_reason(s: &str) -> Option<String> {
    let spaced: String = s.chars().map(|c| if matches!(c, '\u{0}'..='\u{9}' | '\u{b}'..='\u{1f}' | '\u{7f}'..='\u{9f}') { ' ' } else { c }).collect();
    let mut collapsed = String::new();
    let mut in_run = false;
    for c in spaced.chars() {
        if c == ' ' || c == '\t' {
            if !in_run {
                collapsed.push(' ');
            }
            in_run = true;
        } else {
            in_run = false;
            collapsed.push(c);
        }
    }
    let mut out = String::new();
    let cs: Vec<char> = collapsed.chars().collect();
    let mut i = 0usize;
    while i < cs.len() {
        // ` ?\n ?` -> `\n`
        if cs[i] == '\n' || (cs[i] == ' ' && cs.get(i + 1) == Some(&'\n')) {
            let start = if cs[i] == ' ' { i + 1 } else { i };
            let mut end = start + 1;
            if cs.get(end) == Some(&' ') {
                end += 1;
            }
            out.push('\n');
            i = end;
        } else {
            out.push(cs[i]);
            i += 1;
        }
    }
    let t = js_trim(&out).to_string();
    let max = defaults::num("tasklist_guard.reason_max") as usize;
    let units: usize = t.chars().map(char::len_utf16).sum();
    if units > max {
        let cut = slice_utf16(&t, max)?;
        return Some(format!("{}…", cut.trim_end_matches(crate::checks::guardkit::text::is_js_space)));
    }
    Some(t)
}

/// `progressRelPath` segments for a date and session.
fn dated(base: &[&str], date: &str, sid: &str) -> Vec<String> {
    let mut v: Vec<String> = base.iter().map(|s| s.to_string()).collect();
    v.push(date.to_string());
    v.push(format!("{sid}.md"));
    v
}

fn join_all(root: &str, segs: &[String]) -> String {
    segs.iter().fold(root.to_string(), |acc, s| join(&acc, s))
}

/// `maintainSessionIndex(root, date, sid, kind)`.
fn maintain_session_index(root: &str, date: &str, sid: &str, kind: &str) {
    let index = join(&join(&join(root, ".anti-hall"), kind), "INDEX.md");
    let sep = defaults::text("task_lifecycle_log.separator");
    let line = format!("- {date}{sep}{sid}{sep}[{kind}](../{date}/{sid}.md)");
    append_index_line_if_absent(&index, sid, &line);
}

/// `isFreshRelativeToWork(tsMs, scan)`.
fn is_fresh(ts: f64, last_work: f64, fresh_ms: f64, now: f64) -> bool {
    if !ts.is_finite() || ts <= 0.0 {
        return false;
    }
    if last_work > 0.0 {
        return last_work <= ts + defaults::num("tasklist_guard.fresh_grace_ms") as f64;
    }
    now - ts <= fresh_ms
}

/// The mtime of a file in milliseconds, with the fraction, as `st.mtimeMs` has it.
fn mtime_ms(m: &std::fs::Metadata) -> f64 {
    m.modified().ok().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map_or(0.0, |d| d.as_secs_f64() * 1000.0)
}

/// `checkResumeVerification`: the nudge text when a resumed handover was never verified, after recording that it was sent.
fn check_resume_verification(home: &str, sid: &str, work: u64, threshold: f64) -> R<Option<String>> {
    if home.is_empty() || sid.is_empty() || (work as f64) < threshold {
        return Ok(None);
    }
    let dir = Path::new(home).join(".anti-hall");
    let marker_path = dir.join(format!("{}{sid}.json", defaults::text("tasklist_guard.resume_marker_prefix")));
    let Ok(raw) = std::fs::read(&marker_path) else { return Ok(None) };
    if crate::checks::guardkit::jsdiff::js_reads_differently(&raw) {
        return Err(Unsure);
    }
    let Ok(marker) = serde_json::from_str::<Value>(&String::from_utf8_lossy(&raw)) else {
        return Ok(None);
    };
    let Some(file) = get(&marker, "handoverFile").and_then(Value::as_str).filter(|s| !s.is_empty()) else { return Ok(None) };
    let Ok(bytes) = std::fs::read(file) else { return Ok(None) };
    if String::from_utf8_lossy(&bytes).contains(defaults::text("tasklist_guard.resume_verified_marker")) {
        return Ok(None);
    }
    let fired = dir.join(format!("{}{sid}.json", defaults::text("tasklist_guard.resume_nudged_prefix")));
    if fired.exists() {
        return Ok(None);
    }
    if std::fs::create_dir_all(&dir).is_err() || std::fs::write(&fired, format!("{{\"nudged\":true,\"ts\":{}}}", time::now_ms())).is_err() {
        return Ok(None);
    }
    Ok(Some(defaults::render("tasklist_guard.resume_text", &[("file", &file)])))
}

/// The decision for one payload.
pub fn decide(p: &Value, st: &Settings) -> Verdict {
    match decide_inner(p, st) {
        Ok(v) => v,
        Err(Unsure) => Verdict::Defer,
    }
}

fn decide_inner(p: &Value, st: &Settings) -> R<Verdict> {
    if st.env.get(defaults::text("task_guard.judge_child_env")).map(String::as_str) == Some("1") {
        return Ok(Verdict::Allow);
    }
    if !get_bool(st, defaults::raw("tasklist_guard.setting")) || is_skipped(st, defaults::text("tasklist_guard.guard_name")) {
        return Ok(Verdict::Allow);
    }
    if get(p, "permission_mode").and_then(Value::as_str).is_some_and(|m| m.to_lowercase() == defaults::text("tasklist_guard.plan_mode_value")) {
        return Ok(Verdict::Exact(Exact { code: 0, out: defaults::text("tasklist_guard.plan_mode_text").to_string(), err: String::new() }));
    }
    let Some(Value::String(transcript)) = get(p, "transcript_path").filter(|v| truthy(v)) else { return Ok(Verdict::Allow) };
    if st.home.is_empty() {
        return Err(Unsure);
    }
    let raw_sid = match get(p, "session_id") {
        Some(v) if !v.is_null() => js_string(v).ok_or(Unsure)?,
        _ => String::new(),
    };
    let sid = session_path_id(&raw_sid);
    let date = time::iso(time::now_ms())[..10].to_string();
    let progress_rel = dated(defaults::list("tasklist_guard.progress_dir").as_slice(), &date, &sid);
    let history_rel = dated(defaults::list("tasklist_guard.history_dir").as_slice(), &date, &sid);
    // `cwd` falsy or not a string: no root, nothing to join onto.
    let cwd: Option<&str> = match get(p, "cwd") {
        Some(Value::String(c)) if !c.is_empty() => Some(c.as_str()),
        _ => None,
    };
    let root: Option<String> = match cwd {
        Some(c) => Some(session_project_root(c, &st.home).ok_or(Unsure)?),
        None => None,
    };
    let progress_abs = root.as_deref().map(|r| join_all(r, &progress_rel));
    let history_abs = root.as_deref().map(|r| join_all(r, &history_rel));
    let codex = crate::checks::taskkit::is_codex_platform(p);
    let tmp = tmpdir(&|k| st.env.get(k).cloned());
    let abs_cwd = cwd.filter(|c| crate::checks::guardkit::paths::is_absolute(c));
    let cx = Ctx { tmp: &tmp, cwd: abs_cwd };
    // A scan that throws in Node ends the hook quietly (no decision, nothing written).
    let Some((scan, needs_agents)) = scan::scan_transcript(transcript, progress_abs.as_deref(), codex, cx)? else { return Ok(Verdict::Allow) };
    let threshold = get_number(st, defaults::raw("tasklist_guard.threshold_setting"));
    let work = scan.work_count;
    let fresh_ms = get_number(st, defaults::raw("tasklist_guard.fresh_setting"));
    let now = time::now_ms() as f64;

    // Progress-file freshness (fail-open layering: an unreadable cwd or progress directory never blocks).
    let mut progress_fresh = true;
    if let (Some(c), Some(r)) = (cwd, root.as_deref()) {
        if !crate::checks::guardkit::paths::is_absolute(c) {
            return Err(Unsure);
        }
        if std::fs::metadata(c).is_ok_and(|m| m.is_dir()) {
            let dir = join(&join_all(r, &defaults::list("tasklist_guard.progress_dir").iter().map(|s| s.to_string()).collect::<Vec<_>>()), &date);
            if std::fs::create_dir_all(&dir).is_ok() {
                let ppath = join_all(r, &progress_rel);
                progress_fresh = match std::fs::symlink_metadata(&ppath) {
                    Ok(m) if m.is_file() => {
                        maintain_session_index(r, &date, &sid, "progress");
                        is_fresh(mtime_ms(&m), scan.last_work_ts, fresh_ms, now)
                    }
                    _ => false,
                };
            }
        }
    }
    if !progress_fresh
        && scan.last_progress_write_ts.is_finite()
        && scan.last_progress_write_ts > 0.0
        && is_fresh(scan.last_progress_write_ts, scan.last_work_ts, fresh_ms, now)
    {
        progress_fresh = true;
    }
    // History index: kept whenever the session's own history file exists.
    if let (Some(r), Some(h)) = (root.as_deref(), history_abs.as_deref())
        && std::fs::symlink_metadata(h).is_ok_and(|m| m.is_file())
    {
        maintain_session_index(r, &date, &sid, "history");
    }
    // The resume-verification nudge: independent of the block decision below.
    if let Some(text) = check_resume_verification(&st.home, &sid, work, threshold)? {
        let reason = sanitize_reason(&text).ok_or(Unsure)?;
        // `decision` then `reason`, as the Node object has them
        let quoted = serde_json::to_string(&reason).map_err(|_| Unsure)?;
        return Ok(Verdict::Exact(Exact { code: 0, out: format!("{{\"decision\":\"block\",\"reason\":{quoted}}}\n"), err: String::new() }));
    }
    if (work as f64) < threshold {
        return Ok(Verdict::Allow);
    }
    // Two or more tasks in progress on a Claude session: whether they are stalled depends on the running agents, which Node
    // scans and the engine does not, so Node decides unless the Stop is already settled above.
    let should_block = needs_agents || !scan.saw_task_activity || !progress_fresh;
    if !should_block {
        return Ok(Verdict::Allow);
    }
    Ok(Verdict::Defer)
}

/// The registered `tasklist-guard` check.
pub struct TasklistGuard;

impl Check for TasklistGuard {
    fn name(&self) -> &'static str {
        "tasklist-guard"
    }

    fn summary(&self) -> &'static str {
        defaults::text("tasklist_guard.summary")
    }

    fn run(&self, _s: &Subject<'_>, _opts: &Value) -> Option<Verdict> {
        Some(Verdict::Defer)
    }

    fn run_env(&self, _s: &Subject<'_>, payload: &Value, _opts: &Value, env: &RequestEnv) -> Option<Verdict> {
        Some(decide(payload, &Settings::from_env(env)))
    }
}
