//! Built-in `check = "stale-agent-stop-note"`: a port of the Node stale-agent-stop-note (PreToolUse on TaskStop; advisory
//! only, never blocks).
//!
//! When TaskStop names an agent that the transcript shows was sent a message (a teammate's inbox) or resumed (a background
//! agent) after its last report, with no report since, one line says so: the agent may be working, and a report the
//! coordinator read earlier describes the state before the message. It says nothing when the state is unknown.
//!
//! Differences from the Node hook (deliberate): a transcript the scan cannot read exactly as JavaScript would defers the
//! call to Node, and so does a request whose `HOME` is unset (the settings file is read from it).
//!
//! Mirrors `hooks/stale-agent-stop-note.js`.
use crate::checks::agent_scan::{self, Opts, Scan, Unsupported};
use crate::checks::git::util::Settings;
use crate::checks::guardkit::msg::{self, Kind, Parts};
use crate::checks::guardkit::settings::get_bool;
use crate::checks::guardkit::text::{collapse_ws, js_trim, js_trim_end, slice_utf16};
use crate::checks::{Check, Verdict};
use crate::defaults;
use crate::reqenv::RequestEnv;
use crate::rules::Subject;
use regex::Regex;
use serde_json::Value;

#[cfg(test)]
mod tests;

fn control_re() -> &'static Regex {
    static R: crate::defaults::Cache<Regex> = crate::defaults::Cache::new();
    R.get_or_init(|| crate::checks::lit_re(defaults::text("stale_note.control_re")))
}

/// `oneLine(s, max)`: control characters and white space runs become one space, and a name past `max` UTF-16 units is cut.
fn one_line(s: &str, max: usize) -> Result<String, Unsupported> {
    let spaced = control_re().replace_all(s, " ");
    let o = js_trim(&collapse_ws(&spaced)).to_string();
    if agent_scan::utf16_len(&o) > max {
        let cut = slice_utf16(&o, max).ok_or(Unsupported)?;
        return Ok(format!("{}{}", js_trim_end(&cut), defaults::text("stale_note.ellipsis")));
    }
    Ok(o)
}

/// `Math.round`: halves go up.
fn js_round(x: f64) -> f64 {
    (x + 0.5).floor()
}

/// `note(scan, taskId, nowMs)`: the advisory line, or `None`.
pub fn note(scan: &Scan, task_id: &str, now_ms: f64) -> Result<Option<String>, Unsupported> {
    if task_id.is_empty() {
        return Ok(None);
    }
    let guard = defaults::text("stale_note.guard_name");
    let max = defaults::num("stale_note.name_max") as usize;
    let pm = scan.pending.iter().find(|(n, p)| n == task_id || (!p.agent_id.is_empty() && p.agent_id == task_id));
    if let Some((name, p)) = pm {
        let last = if p.last_idle_ms.is_finite() {
            defaults::text("stale_note.msg_pending_last").replace("{time}", &agent_scan::hhmm(p.last_idle_ms))
        } else {
            String::new()
        };
        let seen = if p.last_seen_ms > p.sent_at_ms {
            let min = js_round((now_ms - p.last_seen_ms) / 60000.0).max(0.0);
            defaults::text("stale_note.msg_pending_seen").replace("{min}", &format!("{}", min as i64))
        } else {
            String::new()
        };
        // Built piece by piece: a name that holds `{sent}` must not be filled in a second time.
        let what = format!(
            "\"{}\"{}{}{}{}",
            one_line(name, max)?,
            defaults::text("stale_note.msg_pending_a"),
            agent_scan::hhmm(p.sent_at_ms),
            defaults::text("stale_note.msg_pending_b"),
            last
        ) + defaults::text("stale_note.msg_pending_c");
        let why = format!("{}{seen}", defaults::text("stale_note.msg_pending_why"));
        return Ok(Some(msg::message(
            Kind::Warn,
            guard,
            &Parts { what: &what, why: &why, instead: defaults::text("stale_note.msg_instead"), ..Parts::default() },
        )));
    }
    if let Some(rec) = scan.launched.get(task_id)
        && !rec.teammate
        && !scan.terminal.contains(task_id)
        && let Some(r) = rec.resumed_at_ms
        && r.is_finite()
        && r > 0.0
    {
        let what = format!(
            "\"{}\"{}{}{}",
            one_line(task_id, max)?,
            defaults::text("stale_note.msg_resumed_a"),
            agent_scan::hhmm(r),
            defaults::text("stale_note.msg_resumed_b")
        );
        return Ok(Some(msg::message(
            Kind::Warn,
            guard,
            &Parts { what: &what, why: defaults::text("stale_note.msg_resumed_why"), instead: defaults::text("stale_note.msg_instead"), ..Parts::default() },
        )));
    }
    Ok(None)
}

/// The check's decision on one payload.
///
/// Mirrors `hooks/stale-agent-stop-note.js` `main`.
pub fn decide(p: &Value, env: &RequestEnv) -> Verdict {
    if agent_scan::home_dir(env).is_none() {
        return Verdict::Defer;
    }
    let st = Settings::from_env(env);
    if !get_bool(&st, defaults::raw("stale_note.setting")) {
        return Verdict::Allow;
    }
    if !p.is_object() || p.get("tool_name").and_then(Value::as_str) != Some(defaults::text("stale_note.tool")) {
        return Verdict::Allow;
    }
    let task_id = p.get("tool_input").and_then(|i| i.get("task_id")).and_then(Value::as_str).filter(|s| !s.is_empty());
    let path = p.get("transcript_path").and_then(Value::as_str).filter(|s| !s.is_empty());
    let (Some(task_id), Some(path)) = (task_id, path) else { return Verdict::Allow };
    let now = agent_scan::now_ms();
    let scan = match agent_scan::scan_transcript(path, defaults::num("stale_note.scan_bytes"), &Opts { now_ms: now, ignore_unanswered_stops: true }) {
        Ok(Some(s)) => s,
        Ok(None) => return Verdict::Allow,
        Err(Unsupported) => return Verdict::Defer,
    };
    match note(&scan, task_id, now) {
        Ok(Some(text)) => Verdict::Advisory(msg::advisory_json("PreToolUse", &text)),
        Ok(None) => Verdict::Allow,
        Err(Unsupported) => Verdict::Defer,
    }
}

/// The registered `stale-agent-stop-note` check.
pub struct StaleAgentStopNote;

impl Check for StaleAgentStopNote {
    fn name(&self) -> &'static str {
        "stale-agent-stop-note"
    }

    fn summary(&self) -> &'static str {
        defaults::text("stale_note.summary")
    }

    fn run(&self, s: &Subject<'_>, _opts: &Value) -> Option<Verdict> {
        (s.tool == Some(defaults::text("stale_note.tool"))).then_some(Verdict::Defer)
    }

    fn run_env(&self, _s: &Subject<'_>, payload: &Value, _opts: &Value, env: &RequestEnv) -> Option<Verdict> {
        Some(decide(payload, env))
    }
}
