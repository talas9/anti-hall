//! Task-list compliance (GH #958): where a session's task list lives, what covers a task that waits, and the three negligence signals
//! (`stale_list`, `untracked_request`, `inprogress_waiting`). Every threshold, text and path is plugin config (`nudges.compliance`,
//! `taskstate.*`, `msg.agent_*`); the counts come from the tracker's own event stream (`Agent::calls_since_task`, `calls_since_ask`).
//!
//! Claude Code keeps a session's tasks in `<store_base>/session-<first 8 of the id>/`, or in a NAMED list (`<store_base>/<list id>/`)
//! when the session ran with the list-id variable set. The tracker reads transcripts, not the session's environment, so the hook side
//! ([`note_task_list`]) saves the named id it sees and the tick reads it back.
use super::signals::{Raised, age_within, running};
use super::{Agent, Env, State, fmtn, lim, pth};
use crate::defaults::{self, V};
use serde_json::Value;
use std::path::{Path, PathBuf};

/// One task of the session's task list.
pub(super) struct Task {
    pub(super) id: String,
    pub(super) subject: String,
    pub(super) status: String,
    pub(super) owner: String,
    pub(super) blocked: Vec<String>,
    /// `metadata.blockedOn` carries a stated reason: the task waits on something outside the session, so it is never negligence.
    pub(super) held: bool,
}

fn num(t: &V, k: &str) -> u64 {
    t.get(k).and_then(V::as_integer).unwrap_or(0).max(0) as u64
}

fn valid_list_id(id: &str) -> bool {
    regex::Regex::new(defaults::text("taskstate.list_id_re")).is_ok_and(|r| r.is_match(id))
}

/// The file holding the named task list id a session's hooks saw.
fn list_file(home: &Path, sid: &str) -> PathBuf {
    home.join(pth("base")).join(pth("dir")).join(pth("tasklists")).join(super::sinks::key_of(sid))
}

/// Hook side: save the named task list id (the list-id variable of the request environment) under the session, so the tick reads the
/// list Claude Code really writes. Free when the variable is unset; one small read when it is set; a write only when it changed.
pub(crate) fn note_task_list(req: &crate::reqenv::RequestEnv, p: &Value) {
    let Some(list) = req.get(defaults::text("taskstate.list_id_env")).filter(|l| valid_list_id(l)) else { return };
    let Some(sid) = p.get("session_id").and_then(Value::as_str).filter(|s| !s.is_empty()) else { return };
    let home = crate::checks::git::util::Settings::from_env(req).home;
    if home.is_empty() {
        return;
    }
    let file = list_file(Path::new(&home), sid);
    if std::fs::read_to_string(&file).is_ok_and(|t| t.trim() == list) {
        return;
    }
    if let Some(d) = file.parent()
        && let Err(e) = std::fs::create_dir_all(d)
    {
        crate::health::log_event("agents", "tasklist_note", &e.to_string());
        return;
    }
    if let Err(e) = crate::atomic::write(&file, list.to_string()) {
        crate::health::log_event("agents", "tasklist_note", &e.to_string());
    }
}

/// The directory of the session's task list: the named list its hooks saw, else the first of `taskstate.store_dir_names` that exists
/// (following its pointer file one hop, as the hook side does). `None`: the session has no list on disk.
fn store_dir(env: &Env, sid: &str) -> Option<PathBuf> {
    if sid.is_empty() || !sid.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_')) {
        return None;
    }
    let base = defaults::list("taskstate.store_base").into_iter().fold(env.home.clone(), |p, part| p.join(part));
    if let Ok(named) = std::fs::read_to_string(list_file(&env.home, sid)) {
        let dir = base.join(named.trim());
        if valid_list_id(named.trim()) && dir.is_dir() {
            return Some(dir);
        }
    }
    let sid8: String = sid.chars().take(num(defaults::raw("nudges.compliance"), "sid_chars") as usize).collect();
    for name in defaults::list("taskstate.store_dir_names") {
        let dir = base.join(defaults::fill(name, &[("sid", &sid), ("sid8", &sid8)]));
        if !dir.is_dir() {
            continue;
        }
        let max = defaults::num("taskstate.store_pointer_max_bytes") as usize;
        let ptr = std::fs::read(dir.join(defaults::text("taskstate.store_pointer_file"))).ok().map(|b| String::from_utf8_lossy(&b[..b.len().min(max)]).trim().to_string());
        if let Some(id) = ptr.filter(|id| valid_list_id(id))
            && base.join(&id).is_dir()
        {
            return Some(base.join(id));
        }
        return Some(dir);
    }
    None
}

/// The session's task list (`nudges.idle_wake` field names, `taskstate.store_*` bounds); unreadable files are skipped (no task list is
/// no nudge).
pub(super) fn session_tasks(env: &Env, sid: &str) -> Vec<Task> {
    let c = defaults::raw("nudges.idle_wake");
    let Some(dir) = store_dir(env, sid) else { return Vec::new() };
    let Ok(rd) = std::fs::read_dir(dir) else { return Vec::new() };
    let (max_files, max_bytes) = (defaults::num("taskstate.store_max_files") as usize, defaults::num("taskstate.store_file_max_bytes"));
    let mut out = Vec::new();
    for e in rd.flatten().filter(|e| e.file_name().to_string_lossy().ends_with(c.str_field("task_ext"))).take(max_files) {
        if e.metadata().is_ok_and(|m| m.len() > max_bytes) {
            continue;
        }
        let Some(v) = std::fs::read_to_string(e.path()).ok().and_then(|t| serde_json::from_str::<Value>(&t).ok()) else { continue };
        let s = |k: &str| v.get(c.str_field(k)).map(|x| x.as_str().map_or_else(|| x.to_string(), str::to_string)).unwrap_or_default();
        let blocked = v
            .get(c.str_field("f_blocked"))
            .and_then(Value::as_array)
            .map(|b| b.iter().map(|x| x.as_str().map_or_else(|| x.to_string(), str::to_string)).collect())
            .unwrap_or_default();
        let held = v
            .get(c.str_field("f_metadata"))
            .and_then(|m| m.get(c.str_field("f_blocked_on")))
            .and_then(Value::as_str)
            .is_some_and(|r| r.trim().chars().count() >= defaults::num("idle_rule.blocked_on_min") as usize);
        out.push(Task { id: s("f_id"), subject: s("f_subject"), status: s("f_status"), owner: s("f_owner"), blocked, held });
    }
    out.sort_by(|x, y| x.id.cmp(&y.id));
    out
}

/// The tasks the compliance and idle signals read for `a`: only the session kinds `nudges.compliance.kinds` watch, and only while one
/// of the signals that read them is switched on.
pub(super) fn load(env: &Env, a: &Agent) -> Vec<Task> {
    let on = env.switch("agent_tracker.idle_wake_sw") || env.switch("agent_tracker.parallel_sw") || env.switch("agent_tracker.compliance_sw");
    if !on || a.gone || !defaults::raw("nudges.compliance").get("kinds").map(V::strings).unwrap_or_default().contains(&a.kind.as_str()) {
        return Vec::new();
    }
    session_tasks(env, &a.id)
}

/// A background job the session started and has not seen end (within `bg_bash_ms`), or an armed Monitor, cron or wakeup: something is
/// running or will wake the session, so waiting is not negligence.
pub(super) fn covered(a: &Agent, now: u64) -> bool {
    a.bg_ids.values().any(|t| age_within(now, *t, lim("bg_bash_ms"))) || a.armed_until > now
}

fn owner_live(st: &State, a: &Agent, owner: &str) -> bool {
    !owner.is_empty() && st.agents.values().any(|s| s.id != a.id && !s.gone && !s.dead && running(s) && (s.name == owner || s.id == owner))
}

fn running_children(st: &State, a: &Agent) -> bool {
    st.agents.values().any(|s| super::is_child(s) && s.parent == a.id && running(s))
}

/// A child of the session named `owner` has finished (state done): a task it owns has nobody on it, and a `blockedOn` reason that
/// waits on it is stale (the 2026-11-23 incident: every open task carried a reason naming lanes that had finished, so nothing spoke for 8 h).
pub(super) fn owner_done(st: &State, a: &Agent, owner: &str) -> bool {
    !owner.is_empty()
        && st.agents.values().any(|s| super::is_child(s) && s.parent == a.id && (s.name == owner || s.id == owner) && super::signals::state_of(s) == super::state_name("done"))
}

/// A task held by a stated `blockedOn` reason, unless its owner is a finished child of the session (then the reason cannot still hold).
fn held_now(t: &Task, st: &State, a: &Agent) -> bool {
    t.held && !owner_done(st, a, &t.owner)
}

/// An in-progress task nobody works on: its owner is not a running agent (no owner at all: no lane of the session runs either).
fn orphaned(t: &Task, st: &State, a: &Agent) -> bool {
    !held_now(t, st, a) && t.status == defaults::raw("nudges.compliance").str_field("in_progress") && !owner_live(st, a, &t.owner) && (!t.owner.is_empty() || !running_children(st, a))
}

/// Open tasks whose blockers are all closed (or gone) that nobody works on: pending with no owner, or in progress and orphaned, with no
/// background job or Monitor covering the session.
pub(super) fn dispatchable<'a>(tasks: &'a [Task], st: &State, a: &Agent, now: u64) -> Vec<&'a Task> {
    let c = defaults::raw("nudges.idle_wake");
    let (open, closed) = (c.get("open_statuses").map(V::strings).unwrap_or_default(), c.get("closed_statuses").map(V::strings).unwrap_or_default());
    let shut = |id: &String| tasks.iter().find(|t| t.id == *id).is_none_or(|t| closed.contains(&t.status.as_str()));
    let cover = covered(a, now);
    tasks
        .iter()
        .filter(|t| {
            !held_now(t, st, a)
                && t.blocked.iter().all(shut)
                && ((open.contains(&t.status.as_str()) && (t.owner.is_empty() || owner_done(st, a, &t.owner))) || (!cover && orphaned(t, st, a)))
        })
        .collect()
}

fn subjects(ts: &[&Task]) -> String {
    let c = defaults::raw("nudges.compliance");
    ts.iter().take(num(c, "tasks_shown") as usize).map(|t| t.subject.as_str()).collect::<Vec<_>>().join(c.str_field("joiner"))
}

pub(super) fn watched(env: &Env, a: &Agent) -> bool {
    env.switch("agent_tracker.compliance_sw")
        && !a.gone
        && defaults::raw("nudges.compliance").get("kinds").map(V::strings).unwrap_or_default().contains(&a.kind.as_str())
}

fn open_tasks<'a>(tasks: &'a [Task]) -> Vec<&'a Task> {
    let closed = defaults::raw("nudges.idle_wake").get("closed_statuses").map(V::strings).unwrap_or_default();
    tasks.iter().filter(|t| !t.held && !closed.contains(&t.status.as_str())).collect()
}

/// Record, before the signals are read, since when each in-progress task has had nobody on it; any cover clears the clocks.
pub(super) fn update_waiting(env: &Env, a: &mut Agent, st: &State, tasks: &[Task], now: u64) {
    if !watched(env, a) || covered(a, now) {
        a.ip_since.clear();
        return;
    }
    let ids: Vec<&str> = tasks.iter().filter(|t| orphaned(t, st, a)).map(|t| t.id.as_str()).collect();
    a.ip_since.retain(|id, _| ids.contains(&id.as_str()));
    for id in ids {
        a.ip_since.entry(id.to_string()).or_insert(now);
    }
}

/// `stale_list`: a task is open and the session made `stale_calls` work calls with no TaskCreate/TaskUpdate. Text: the open subjects.
pub(super) fn stale_list(env: &Env, a: &Agent, tasks: &[Task]) -> Option<Raised> {
    let open = open_tasks(tasks);
    if !watched(env, a) || open.is_empty() || a.calls_since_task < num(defaults::raw("nudges.compliance"), "stale_calls") {
        return None;
    }
    Some((a.calls_since_task, subjects(&open)))
}

/// `untracked_request`: the owner's last prompt was followed by `untracked_calls` tool calls and no TaskCreate/TaskUpdate.
pub(super) fn untracked_request(env: &Env, a: &Agent) -> Option<Raised> {
    (watched(env, a) && a.ask_open && a.calls_since_ask >= num(defaults::raw("nudges.compliance"), "untracked_calls")).then(|| (a.calls_since_ask, String::new()))
}

/// `inprogress_waiting`: a task has been in progress for `inprogress_ms` with no live agent and no background job or Monitor.
/// Evidence: the longest wait in seconds. Text: the waiting subjects.
pub(super) fn inprogress_waiting(env: &Env, a: &Agent, tasks: &[Task], now: u64) -> Option<Raised> {
    if !watched(env, a) || covered(a, now) {
        return None;
    }
    let min = num(defaults::raw("nudges.compliance"), "inprogress_ms");
    let due: Vec<(&Task, u64)> = tasks.iter().filter_map(|t| a.ip_since.get(&t.id).map(|s| (t, now.saturating_sub(*s)))).filter(|(_, w)| *w >= min).collect();
    let longest = due.iter().map(|(_, w)| *w).max()?;
    Some((longest / fmtn("ms_per_s"), subjects(&due.iter().map(|(t, _)| *t).collect::<Vec<_>>())))
}

/// Count one compliance event (`compliance{signal,outcome}`); other signals are not counted.
pub(super) fn count(sig: &str, outcome: &str) {
    if defaults::list("agent_tracker.compliance_signals").contains(&sig) {
        crate::metrics::bump("compliance", &[("signal", sig), ("outcome", outcome)]);
    }
}

/// A held reminder: `suppressed:<reason>`.
pub(super) fn suppressed(sig: &str, reason: &str) {
    let o = defaults::raw("nudges.compliance_outcomes");
    count(sig, &format!("{}{}{reason}", o.str_field("suppressed"), o.str_field("reason_sep")));
}

/// A reminded flag cleared: `acted_on` when the session made a task-list call since it was raised, else `false`.
pub(super) fn cleared(sig: &str, acted: bool) {
    let o = defaults::raw("nudges.compliance_outcomes");
    count(sig, o.str_field(if acted { "acted_on" } else { "not_acted" }));
}

/// A reminder was queued: `fired`.
pub(super) fn fired(sig: &str) {
    count(sig, defaults::raw("nudges.compliance_outcomes").str_field("fired"));
}

/// A reminder reached its channel: `delivered_wake` (a wake row) or `delivered_hook` (the session's hook delivered it); `key` names the
/// outcome in `nudges.compliance_outcomes`.
pub(super) fn delivered(sig: &str, key: &str) {
    count(sig, defaults::raw("nudges.compliance_outcomes").str_field(key));
}
