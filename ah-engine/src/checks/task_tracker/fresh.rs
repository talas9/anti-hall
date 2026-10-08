//! The per-turn note about the open tasks (`freshnessNote` of `hooks/task-tracker.js`), planned without writing anything.
//!
//! The note is built from the task list rebuilt out of the end of the transcript. Two things in the Node hook go beyond what
//! the engine reproduces, and both are decided here BEFORE the caller writes anything, so a deferral leaves no trace:
//! a task the per-turn DISPATCH NOW line would name (it counts the agents running in the session, asks Jev for a tier and
//! records a demand), and a dispatch-tier recommendation whose outcome is still to be labelled. Everything else, the
//! open-tasks line and the unknown-state note, is reproduced exactly.
// Discard triage (E3): every `.ok()` / `unwrap_or_default()` in this file is a deliberate keep, for these reasons:
// - an absent field is the empty value
// - text that does not parse or decode is the absent value (Node Number()/JSON.parse catch parity)
// A failure that must be seen goes through `crate::discard` instead.

use crate::checks::git::util::Settings;
use crate::checks::guardkit::jsdiff::js_reads_differently_str;
use crate::checks::guardkit::jsre;
use crate::checks::guardkit::msg;
use crate::checks::guardkit::settings::get_bool;
use crate::checks::guardkit::text::{collapse_ws, js_trim, js_trim_end, slice_utf16};
use crate::checks::jsport::json::{self, Fail, J};
use crate::checks::taskkit::jsval::{R, Unsure};
use crate::checks::taskstate::parse::{Facts, reconstruct};
use crate::checks::taskstate::tail::{lines_of, read_tail};
use crate::checks::taskstate::{Task, TaskMap, Variant, backfill::backfill};
use crate::defaults;
use std::collections::HashSet;

/// What the note will say, and what is still to be written when it is said.
pub struct Fresh {
    /// The tasks the unknown-state note is about (written when the note is produced).
    pub tasks: TaskMap,
    /// The open-tasks line, empty when no task is open.
    pub line: String,
}

/// `isOwnerBlocked(t)`: a task waiting on the owner (the `blockedOn` marker or an `OWNER:` subject) is not work the agent can
/// close. The marker is honoured unless its switch is off.
pub fn owner_blocked(t: &Task, st: &Settings) -> bool {
    if !get_bool(st, defaults::raw("dispatch_tier.owner_marker_setting")) {
        return false;
    }
    if defaults::list("dispatch_tier.owner_values").contains(&t.blocked_on_text().as_str()) {
        return true;
    }
    jsre::compile(defaults::text("dispatch_tier.owner_subject_re"), true).is_match(&t.content)
}

/// `classifyOpen(open, taskMap)`: how many pending, unowned (or coordinator-owned) tasks no open blocker holds back.
fn actionable(open: &[&Task], tasks: &TaskMap, st: &Settings) -> usize {
    let done = defaults::list("task_tracker.done_statuses");
    let known: HashSet<&str> = tasks.values().map(|t| t.id.as_str()).collect();
    let not_done: HashSet<&str> = tasks.values().filter(|t| !done.contains(&t.status_lc().as_str())).map(|t| t.id.as_str()).collect();
    let main_owner = jsre::compile(defaults::text("task_tracker.main_owner_re"), true);
    open.iter()
        .filter(|t| t.status_lc() == defaults::text("task_tracker.pending_status"))
        .filter(|t| !t.block_unknown)
        .filter(|t| t.owner.is_empty() || main_owner.is_match(&t.owner))
        .filter(|t| !owner_blocked(t, st))
        .filter(|t| !t.blocked_by.iter().any(|b| not_done.contains(b.as_str()) || !known.contains(b.as_str())))
        .count()
}

/// `oneLine(s, max)`: control characters become spaces, white space is collapsed and trimmed, and a long text is cut with an
/// ellipsis. `Err` when the cut would split a surrogate pair.
fn one_line(s: &str, max: usize) -> R<String> {
    let stripped = jsre::compile(defaults::text("task_tracker.control_re"), false).replace_all(s, " ").into_owned();
    let o = js_trim(&collapse_ws(&stripped)).to_string();
    if o.encode_utf16().count() > max {
        let cut = slice_utf16(&o, max).ok_or(Unsure)?;
        return Ok(format!("{}{}", js_trim_end(&cut), defaults::text("task_tracker.ellipsis")));
    }
    Ok(o)
}

/// JavaScript truthiness of a parsed value.
fn truthy(v: Option<&J>) -> bool {
    match v {
        None | Some(J::Null) | Some(J::Bool(false)) => false,
        Some(J::Num(n)) => *n != 0.0 && !n.is_nan(),
        Some(J::Str(s)) => !s.is_empty(),
        Some(_) => true,
    }
}

/// Whether the dispatch-tier state holds a recommendation of this session whose outcome `trackOutcomes` would still label.
/// The engine does not label outcomes, so such a session is left to Node. An unreadable state file is no state, as in Node.
fn outcome_pending(home: &str, session: &str) -> R<bool> {
    let path = format!("{home}/{}/{}", defaults::text("paths.base_dir"), defaults::text("dispatch_tier.state_file"));
    let Ok(bytes) = std::fs::read(&path) else { return Ok(false) };
    let raw = String::from_utf8_lossy(&bytes).into_owned();
    if js_reads_differently_str(&raw) {
        return Err(Unsure);
    }
    let st = match json::parse(&raw, defaults::num("task_tracker.json_max_depth") as usize) {
        Ok(v) => v,
        Err(Fail::Invalid) => return Ok(false),
        Err(Fail::Unsupported) => return Err(Unsure),
    };
    let Some(sess) = st.get("sessions").and_then(|s| s.get(session)) else { return Ok(false) };
    match sess.get("tasks") {
        None | Some(J::Null) => Ok(false),
        Some(J::Obj(tasks)) => {
            for (_, rec) in tasks {
                let J::Obj(_) = rec else { return Err(Unsure) };
                if !(truthy(rec.get("dispatch")) && truthy(rec.get("result"))) {
                    return Ok(true);
                }
            }
            Ok(false)
        }
        Some(_) => Err(Unsure),
    }
}

/// The note for this prompt, planned. `Ok(None)`: nothing to read (no transcript), so no note and no unknown-state note.
pub fn plan(st: &Settings, home: &str, transcript: Option<&str>, session_raw: &str) -> R<Option<Fresh>> {
    let Some(tp) = transcript else { return Ok(None) };
    if std::fs::metadata(tp).map(|m| m.len()).unwrap_or(0) == 0 {
        return Ok(None); // Node's readTail answers null for a missing, unreadable or empty file
    }
    let window = defaults::num("taskstate.tail_bytes");
    let Some((data, truncated)) = read_tail(tp, window) else { return Ok(None) };
    let lines = lines_of(&data, truncated);
    let mut facts: Facts = reconstruct(&lines, Variant::State)?;
    backfill(&mut facts, tp, window)?;
    let tasks = facts.tasks;
    // dispatchTier outcome labelling runs before anything else and writes: not reproduced
    let sid = if session_raw.is_empty() { defaults::text("task_tracker.unknown_session") } else { session_raw };
    if outcome_pending(home, sid)? {
        return Err(Unsure);
    }
    let open: Vec<&Task> = tasks.values().filter(|t| t.is_open()).collect();
    if open.is_empty() {
        return Ok(Some(Fresh { tasks, line: String::new() }));
    }
    // the per-turn DISPATCH NOW line: it counts running agents, asks Jev for a tier and records a demand
    if get_bool(st, defaults::raw("task_tracker.dd_setting")) && actionable(&open, &tasks, st) >= 1 {
        return Err(Unsure);
    }
    let (blocked, counted): (Vec<&Task>, Vec<&Task>) = open.iter().partition(|t| owner_blocked(t, st));
    let in_progress = jsre::compile(defaults::text("task_tracker.in_progress_re"), true);
    let oldest = counted.iter().find(|t| in_progress.is_match(t.status.as_deref().unwrap_or("")));
    let subject = match oldest {
        None => String::new(),
        Some(t) => {
            let known = t.content != t.id;
            one_line(if known { &t.content } else { defaults::text("task_tracker.subject_unknown") }, defaults::num("task_tracker.subject_max") as usize)?
        }
    };
    let tail = if oldest.is_some() && !subject.is_empty() {
        msg::render("task_tracker.subject_tail", &[("subject", &serde_json::to_string(&subject).map_err(|_| Unsure)?)])
    } else {
        String::new()
    };
    let mut why: Vec<String> = Vec::new();
    for t in &blocked {
        let b = t.blocked_on_text();
        let w = if b.is_empty() { defaults::text("task_tracker.owner_word").to_string() } else { b };
        if !why.contains(&w) {
            why.push(w);
        }
    }
    let blocked_tail = if blocked.is_empty() {
        String::new()
    } else {
        msg::render("task_tracker.blocked_tail", &[("n", &blocked.len().to_string()), ("why", &why.join(defaults::text("task_tracker.why_joiner")))])
    };
    let line = if counted.is_empty() {
        msg::render("task_tracker.open_zero", &[("blocked", &blocked_tail)])
    } else {
        msg::render("task_tracker.open_some", &[("n", &counted.len().to_string()), ("blocked", &blocked_tail), ("tail", &tail)])
    };
    Ok(Some(Fresh { tasks, line }))
}
