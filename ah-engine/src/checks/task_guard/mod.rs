//! Built-in `check = "task-guard"`: the Node task-guard Stop hook (`hooks/task-guard.js`).
//!
//! task-guard blocks a Stop while the session's task list still has open tasks. This check reads the same tail of the
//! transcript, rebuilds the task list the same way (`taskstate`) and answers as the Node hook does: the quiet Stops (no open
//! task, every open task honestly blocked, the same set already blocked, the block cap reached), the steps aside (an OMC
//! loop, live agents, a spent per-prompt budget) and both blocks: the sharp idle-neglect block (dispatchable tasks no
//! running agent covers, `lib/dispatch-demand.js`) and the generic one, with the loop-state file, the per-prompt budget file
//! and the idle-neglect metrics written as Node writes them.
//!
//! Deferred to the Node hook (D74), never decided here: any record or value the port cannot read exactly (the reconstruction,
//! the agent scan, a state file only JavaScript could parse, a timestamp only V8 could read, a subject cut through a
//! surrogate pair), and every answer that needs the DevSwarm app database (whether a task owner is a live workspace, whether
//! any workspace is live): Node reads it through `node:sqlite` behind its DevSwarm capability gate, which the engine does
//! not reproduce, so with the database file present those Stops go to Node (without it Node's answer is fixed and the engine
//! gives it). The parallel cap needs the CPU count as libuv reads it: exact on macOS, on Linux only while no CPU quota is in
//! play; otherwise, unless `guards.maxParallelDispatch` sets it, the Stop is deferred. Every value that can defer is computed
//! before the first write, so a deferred Stop has changed no file.
use crate::checks::agent_scan::{self, Opts};
use crate::checks::git::util::Settings;
use crate::checks::guardkit::jsval::Js;
use crate::checks::guardkit::msg::{Kind, Parts, message, render};
use crate::checks::guardkit::settings::{get_bool, get_number, is_skipped};
use crate::checks::spawnctx::Home;
use crate::checks::taskkit::js_string;
use crate::checks::taskkit::jsval::{R, Unsure, get, truthy};
use crate::checks::taskstate::parse::{Facts, reconstruct};
use crate::checks::taskstate::tail::{lines_of, read_tail};
use crate::checks::taskstate::unknown::{js_sort, safe_key, sha1_hex, unknown_note, unknown_note_plan};
use crate::checks::taskstate::{Task, TaskMap, Variant, backfill::backfill};
use crate::checks::{Check, Exact, Verdict};
use crate::defaults;
use crate::reqenv::RequestEnv;
use crate::rules::Subject;
use serde_json::Value;
use std::path::Path;

mod budget;
mod demand;
mod omc;
mod open;
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
    // `(session_id && String(session_id)) || sha1(transcript)`: an id whose text is empty (`[]`) also falls back
    let given = match get(p, "session_id").filter(|v| truthy(v)) {
        Some(v) => js_string(v).ok_or(Unsure)?,
        None => String::new(),
    };
    let session_id =
        if given.is_empty() { sha1_hex(transcript.as_bytes())[..defaults::num("task_guard.session_hash_len") as usize].to_string() } else { given };
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
    let open: Vec<&Task> = tasks.values().filter(|t| t.is_open()).collect();
    if open.is_empty() {
        crate::discard::harmless(std::fs::remove_file(&state_file)); // keep: cleanup that raced; an absent file is the goal state
        return quiet(out, &tasks, st, &session_id);
    }
    let fire = open_tasks(p, st, transcript, &session_id, &safe_session, &state_file, &tasks, &open, &mut out)?;
    Ok(match fire {
        Some(v) => v,
        None => quiet(out, &tasks, st, &session_id)?,
    })
}

/// `quietExit()`: the unknown-state note when it is due, then nothing more.
fn quiet(mut out: String, tasks: &TaskMap, st: &Settings, session_id: &str) -> R<Verdict> {
    let note = unknown_note(tasks, &st.home, session_id, defaults::text("task_guard.unknown_tag"))?;
    if !note.is_empty() {
        out.push_str(&defaults::render("task_guard.note_line", &[("note", &note)]));
    }
    Ok(exact(out))
}

fn exact(out: String) -> Verdict {
    if out.is_empty() { Verdict::Allow } else { Verdict::Exact(Exact { code: 0, out, err: String::new() }) }
}

/// The sorted ids of a task set, joined (the block hash basis).
fn joined_ids(ts: &[&Task]) -> String {
    let mut ids: Vec<String> = ts.iter().map(|t| open::hash_id(t)).collect();
    js_sort(&mut ids);
    ids.join(defaults::text("task_guard.hash_sep"))
}

/// The loop state of the last block: its hash and the block count (`{ hash, blocks }`, or a legacy bare hash).
fn read_state(file: &Path) -> R<(String, f64)> {
    let Ok(b) = std::fs::read(file) else { return Ok((String::new(), 0.0)) };
    let text = crate::checks::guardkit::text::lossy_owned(b);
    let raw = crate::checks::guardkit::text::js_trim(&text);
    if raw.is_empty() {
        return Ok((String::new(), 0.0));
    }
    Ok(match demand::parse_js(raw)? {
        Some(v @ (Js::Obj(_) | Js::Arr(_))) => (
            v.get(defaults::text("task_guard.state_hash_key")).and_then(Js::as_str).unwrap_or("").to_string(),
            v.get(defaults::text("task_guard.state_blocks_key")).and_then(Js::as_f64).filter(|n| n.is_finite()).unwrap_or(0.0),
        ),
        _ => (raw.to_string(), 0.0),
    })
}

/// `isCodexPayload(payload)`: an `apply_patch` call, or a payload with both a `turn_id` and a `model`.
fn codex_payload(p: &Value) -> bool {
    if !p.is_object() {
        return false;
    }
    if get(p, "tool_name").and_then(Value::as_str) == Some(defaults::text("task_guard.codex_patch_tool")) {
        return true;
    }
    let nonempty = |k: &str| get(p, k).and_then(Value::as_str).is_some_and(|s| !s.is_empty());
    nonempty("turn_id") && nonempty("model")
}

/// `renderList(nudgeTasks)`: the first tasks of the generic block, `"subject" ["status"]` each.
fn render_list(ts: &[&Task]) -> R<String> {
    let mut parts = Vec::new();
    for t in ts.iter().take(defaults::num("task_guard.list_max") as usize) {
        let unknown = defaults::text("task_guard.subject_unknown");
        let raw = if !t.content.is_empty() && t.content != t.id { t.content.as_str() } else { unknown };
        let subject = demand::one_line(raw, defaults::num("task_guard.subject_max") as usize)?;
        let subject = if subject.is_empty() { unknown.to_string() } else { subject };
        let open_word = defaults::text("task_guard.status_open");
        let status = demand::one_line(t.status.as_deref().filter(|s| !s.is_empty()).unwrap_or(open_word), defaults::num("task_guard.status_max") as usize)?;
        let status = if status.is_empty() { open_word.to_string() } else { status };
        parts.push(format!("{} [{}]", demand::js_quote(&subject), demand::js_quote(&status)));
    }
    Ok(parts.join(defaults::text("task_guard.list_sep")))
}

/// Everything after "some task is open". `Ok(None)` is a quiet exit (the caller adds the unknown-state note).
#[allow(clippy::too_many_arguments)]
fn open_tasks(
    p: &Value,
    st: &Settings,
    transcript: &str,
    session_id: &str,
    safe_session: &str,
    state_file: &Path,
    tasks: &TaskMap,
    open: &[&Task],
    out: &mut String,
) -> R<Option<Verdict>> {
    let actionable = open::actionable(open, tasks, st);
    let have_agents = demand::agents_running(st)?;
    let mut demand = demand::Demand { fire: false, proven: false, unknown: false, dispatch: Vec::new(), cap: None };
    if !actionable.is_empty() {
        if get_bool(st, defaults::raw("task_guard.dispatch_demand_setting")) {
            let opts = Opts { now_ms: agent_scan::now_ms(), ignore_unanswered_stops: false };
            let running = agent_scan::running_agents_or_null(transcript, &opts).map_err(|_| Unsure)?;
            let known: Vec<String> = tasks.keys().cloned().collect();
            demand = demand::evaluate(st, &actionable, &known, open, running)?;
            if get_bool(st, defaults::raw("task_guard.proven_only_setting")) && !demand.unknown {
                demand.fire = demand.proven;
            }
        } else {
            demand = demand::Demand { fire: !have_agents, proven: false, unknown: false, dispatch: actionable.clone(), cap: None };
        }
    }
    let idle = demand.fire;
    let nudge = open::unblocked(open, tasks, st)?;
    if !idle && nudge.is_empty() {
        return Ok(None);
    }
    let sep = defaults::text("task_guard.hash_sep");
    let hash = if idle {
        let tags = defaults::list("task_guard.idle_hash_tags").join(sep);
        sha1_hex(format!("{tags}{sep}{}", joined_ids(&demand.dispatch)).as_bytes())
    } else {
        sha1_hex(joined_ids(&nudge).as_bytes())
    };
    let (last_hash, blocks) = read_state(state_file)?;
    if hash == last_hash || blocks >= defaults::num("task_guard.max_blocks") as f64 {
        return Ok(None);
    }
    let cwd = match get(p, "cwd") {
        Some(Value::String(c)) => Some(c.as_str()),
        _ => None,
    };
    let sid = match get(p, "session_id").filter(|v| truthy(v)) {
        Some(v) => Some(js_string(v).ok_or(Unsure)?).filter(|s| !s.is_empty()),
        None => None,
    };
    if omc::loop_active(st, cwd, sid.as_deref())? {
        out.push_str(defaults::text("task_guard.omc_line"));
        return Ok(Some(exact(std::mem::take(out))));
    }
    if !idle && have_agents {
        out.push_str(defaults::text("task_guard.agents_line"));
        return Ok(Some(exact(std::mem::take(out))));
    }
    // From here the Stop blocks unless the budget is spent. Everything that can defer is settled before the first write.
    let home = match crate::checks::spawnctx::state_home(&st.env) {
        Home::Ok(h) => Some(h),
        Home::Guarded => None,
        Home::Unknown => return Err(Unsure),
    };
    let budget = budget::check(st, home.as_deref(), safe_session, p, transcript)?;
    let reason = block_reason(p, st, idle, &demand, &nudge)?;
    let metrics = match (&home, idle) {
        (Some(h), true) => Some(demand::idle_neglect_metrics(h)?),
        _ => None,
    };
    let note = unknown_note_plan(tasks, &st.home, session_id, defaults::text("task_guard.unknown_tag"))?;
    match budget {
        budget::Budget::Spent => return Ok(Some(exact(std::mem::take(out)))),
        budget::Budget::Block(Some((file, body))) if !budget::write(&file, &body) => return Ok(Some(exact(std::mem::take(out)))),
        budget::Budget::Block(_) => {}
    }
    let state = Js::Obj(vec![
        (defaults::text("task_guard.state_hash_key").to_string(), Js::Str(hash)),
        (defaults::text("task_guard.state_blocks_key").to_string(), Js::Num(blocks + 1.0)),
    ]);
    let written = state_file.parent().is_some_and(|d| std::fs::create_dir_all(d).is_ok())
        && crate::atomic::write_after_reply(state_file, state.stringify(), crate::atomic::Style::default()).is_ok(); // lands with the reply (review P1-2)
    if !written {
        return Ok(Some(exact(std::mem::take(out))));
    }
    if let Some((file, body)) = metrics {
        demand::write_metrics(&file, &body);
    }
    let mut reason = reason;
    let note = note.apply();
    if !note.is_empty() {
        reason.push('\n');
        reason.push_str(&note);
    }
    out.push_str(&defaults::render("task_guard.block_json", &[("reason", &demand::js_quote(&reason))]));
    Ok(Some(exact(std::mem::take(out))))
}

/// The block reason: the idle-neglect block naming the dispatchable tasks, or the generic block naming the open ones.
fn block_reason(p: &Value, st: &Settings, idle: bool, demand: &demand::Demand<'_>, nudge: &[&Task]) -> R<String> {
    let upd = defaults::text(if codex_payload(p) { "task_guard.update_codex" } else { "task_guard.update_claude" });
    let guard = defaults::text("task_guard.guard_name");
    if idle {
        let max = defaults::num("task_guard.dispatch_list_max") as usize;
        let labels: Vec<String> = demand.dispatch.iter().take(max).map(|t| demand::label(t)).collect::<R<_>>()?;
        let n = demand.dispatch.len();
        let more = if n > max { render("task_guard.more", &[("n", &(n - max).to_string())]) } else { String::new() };
        let cap = match demand.cap {
            Some(c) if c != 0.0 => crate::checks::guardkit::jsval::number_to_string(c),
            _ => defaults::text("task_guard.cap_formula").to_string(),
        };
        let ds = if open::any_live_children(st)? { render("task_guard.idle_devswarm", &[("upd", upd)]) } else { String::new() };
        let what = render("task_guard.idle_what", &[("n", &n.to_string()), ("list", &labels.join(defaults::text("task_guard.label_sep"))), ("more", &more)]);
        let instead = render("task_guard.idle_instead", &[("cap", &cap), ("upd", upd), ("devswarm", &ds)]);
        let parts = Parts {
            what: &what,
            why: defaults::text("task_guard.idle_why"),
            instead: &instead,
            allowed: defaults::text("task_guard.idle_allowed"),
            ..Parts::default()
        };
        return Ok(message(Kind::Block, guard, &parts));
    }
    let max = defaults::num("task_guard.list_max") as usize;
    let n = nudge.len();
    let more = if n > max { render("task_guard.more", &[("n", &(n - max).to_string())]) } else { String::new() };
    let what = render("task_guard.generic_what", &[("list", &render_list(nudge)?), ("more", &more)]);
    let instead = render("task_guard.generic_instead", &[("upd", upd)]);
    let allowed = render("task_guard.generic_allowed", &[("upd", upd)]);
    let parts = Parts { what: &what, why: defaults::text("task_guard.generic_why"), instead: &instead, allowed: &allowed, ..Parts::default() };
    Ok(message(Kind::Block, guard, &parts))
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
