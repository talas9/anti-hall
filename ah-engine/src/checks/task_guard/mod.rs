//! Built-in `check = "task-guard"`: the quiet half of the Node task-guard Stop hook.
//!
//! task-guard blocks a Stop while the session's task list still has open tasks. This check reproduces the Stops where there is
//! nothing to block: it reads the same tail of the transcript, rebuilds the task list the same way (`taskstate`), and when no
//! task is open it does what the Node hook does there (removes the loop state file, prints the pruning advisory and the
//! unknown-state note when they apply) and answers. A Stop with any open task, and any record or value the port cannot read
//! exactly, is deferred: the Node hook runs and decides (D74). The engine therefore never blocks, never allows where Node
//! would block, and never answers a Stop on which Node's decision depends on running agents, OMC loops, DevSwarm or the
//! per-prompt budget.
//!
//! Mirrors `hooks/task-guard.js` `main` up to the open-task decision.
use crate::checks::git::util::Settings;
use crate::checks::guardkit::settings::{get_bool, get_number, is_skipped};
use crate::checks::taskkit::js_string;
use crate::checks::taskkit::jsval::{R, Unsure, get, truthy};
use crate::checks::taskstate::parse::{Facts, reconstruct};
use crate::checks::taskstate::tail::{lines_of, read_tail};
use crate::checks::taskstate::unknown::{safe_key, sha1_hex, unknown_note};
use crate::checks::taskstate::{TaskMap, Variant, backfill::backfill};
use crate::checks::{Check, Exact, Verdict};
use crate::defaults;
use crate::reqenv::RequestEnv;
use crate::rules::Subject;
use serde_json::Value;
use std::path::Path;

#[cfg(test)]
mod tests;

/// `parseTasksFromFile(path)`: the task list of a transcript, empty when it cannot be read.
pub fn parse_tasks(path: &str) -> R<TaskMap> {
    let window = defaults::num("taskstate.tail_bytes");
    let Some((data, truncated)) = read_tail(path, window) else { return Ok(TaskMap::default()) };
    let lines = lines_of(&data, truncated);
    let mut facts: Facts = reconstruct(&lines, Variant::Guard)?;
    if truncated {
        backfill(&mut facts, path, window)?;
    }
    Ok(facts.tasks)
}

/// JavaScript's text for a finite number.
fn js_number_text(n: f64) -> R<String> {
    js_string(&serde_json::Number::from_f64(n).map(Value::Number).ok_or(Unsure)?).ok_or(Unsure)
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
    if !get_bool(st, defaults::raw("task_guard.setting")) || is_skipped(st, defaults::text("task_guard.guard_name")) {
        return Ok(Verdict::Allow);
    }
    let Some(Value::String(transcript)) = get(p, "transcript_path").filter(|v| truthy(v)) else { return Ok(Verdict::Allow) };
    if st.home.is_empty() {
        return Err(Unsure);
    }
    let session_id = match get(p, "session_id").filter(|v| truthy(v)) {
        Some(v) => js_string(v).ok_or(Unsure)?,
        None => sha1_hex(transcript.as_bytes())[..defaults::num("task_guard.session_hash_len") as usize].to_string(),
    };
    let safe_session = safe_key(&session_id);
    let state_file = Path::new(&st.home).join(defaults::text("paths.base_dir")).join(format!("{}{safe_session}", defaults::text("task_guard.state_prefix")));

    let tasks = parse_tasks(transcript)?;
    let done: Vec<&str> = defaults::list("taskstate.done_statuses");
    let completed = tasks.values().filter(|t| done.contains(&t.status_lc().as_str())).count();
    let mut out = String::new();
    let prune_after = get_number(st, defaults::raw("task_guard.prune_setting"));
    if prune_after.is_finite() && prune_after > 0.0 && completed as f64 > prune_after {
        out.push_str(&defaults::render("task_guard.prune_advisory", &[("n", &completed), ("limit", &js_number_text(prune_after)?)]));
    }
    if tasks.values().any(|t| t.is_open()) {
        // Open tasks: the sharp and the generic blocks depend on agents, OMC loops and the stop budget. Node decides, and prints
        // the advisory above itself.
        return Ok(Verdict::Defer);
    }
    crate::discard::harmless(std::fs::remove_file(&state_file)); // keep: cleanup that raced; an absent file is the goal state
    let note = unknown_note(&tasks, &st.home, &session_id, defaults::text("task_guard.unknown_tag"))?;
    if !note.is_empty() {
        out.push_str(&defaults::render("task_guard.note_line", &[("note", &note)]));
    }
    Ok(if out.is_empty() { Verdict::Allow } else { Verdict::Exact(Exact { code: 0, out, err: String::new() }) })
}

/// The registered `task-guard` check.
pub struct TaskGuard;

impl Check for TaskGuard {
    fn name(&self) -> &'static str {
        "task-guard"
    }

    fn summary(&self) -> &'static str {
        defaults::text("task_guard.summary")
    }

    fn run(&self, _s: &Subject<'_>, _opts: &Value) -> Option<Verdict> {
        Some(Verdict::Defer)
    }

    fn run_env(&self, _s: &Subject<'_>, payload: &Value, _opts: &Value, env: &RequestEnv) -> Option<Verdict> {
        Some(decide(payload, &Settings::from_env(env)))
    }
}
