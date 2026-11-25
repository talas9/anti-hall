//! Task-list compliance (GH #958): where a session's task list lives, what covers a task that waits, and the three negligence signals
//! (`stale_list`, `untracked_request`, `inprogress_waiting`). Every threshold, text and path is plugin config (`nudges.compliance`,
//! `taskstate.*`, `msg.agent_*`); the counts come from the tracker's own event stream (`Agent::calls_since_task`, `calls_since_ask`).
//!
//! Claude Code keeps a session's tasks in `<store_base>/session-<first 8 of the id>/`, or in a NAMED list (`<store_base>/<list id>/`)
//! when the session ran with the list-id variable set. The tracker reads transcripts, not the session's environment, so the hook side
//! ([`note_task_list`]) saves the named id it sees and the tick reads it back.
use super::signals::{Raised, age_within, running};
use super::{Agent, Env, HoldDue, State, fmtn, lim, pth};
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
    /// Identity of the hold for its clock: the task id and a hash of the `blockedOn` text (empty when not held). A changed reason is a
    /// confirmed blocker and restarts the clock; an unchanged one does not.
    pub(super) held_key: String,
    /// The `blockedOn` reason names the owner or a human (a word of `dispatch_tier.owner_values`): only they can clear it.
    pub(super) owner_held: bool,
    /// [`super::owner_holds::reason_hash`] of the reason (empty when not held): what a confirmation is tied to.
    pub(super) reason_hash: String,
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
        let ptr = std::fs::read(dir.join(defaults::text("taskstate.store_pointer_file")))
            .ok()
            .map(|b| String::from_utf8_lossy(&b[..b.len().min(max)]).trim().to_string());
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
        let reason = v.get(c.str_field("f_metadata")).and_then(|m| m.get(c.str_field("f_blocked_on"))).and_then(Value::as_str).map(str::trim).unwrap_or("");
        let held = reason.chars().count() >= defaults::num("idle_rule.blocked_on_min") as usize;
        let held_key = if held { format!("{}#{:x}", s("f_id"), crate::health::fnv(reason)) } else { String::new() };
        let owner_held = held && owner_named(reason);
        let reason_hash = if held { super::owner_holds::reason_hash(reason) } else { String::new() };
        out.push(Task { id: s("f_id"), subject: s("f_subject"), status: s("f_status"), owner: s("f_owner"), blocked, held, held_key, owner_held, reason_hash });
    }
    out.sort_by(|x, y| x.id.cmp(&y.id));
    out
}

/// Whether a `blockedOn` reason names the owner or a human: any whole word of it (lowercase; split at every character that is neither
/// alphanumeric nor one of `dispatch_tier.owner_word_joiners`, so "user-facing" stays one word) is one of `dispatch_tier.owner_values`:
/// "owner", "NEEDS OWNER: x" and "owner: deferred until y" match. The ONE owner matcher: the tracker's hold_owner and the Stop
/// idle-tasks check (through the script host's `ownerNamed`) both call it (GH #959).
pub(crate) fn owner_named(reason: &str) -> bool {
    let owners = defaults::list("dispatch_tier.owner_values");
    let joiners = defaults::text("dispatch_tier.owner_word_joiners");
    reason.to_lowercase().split(|ch: char| !ch.is_alphanumeric() && !joiners.contains(ch)).any(|w| !w.is_empty() && owners.contains(&w))
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
        && st
            .agents
            .values()
            .any(|s| super::is_child(s) && s.parent == a.id && (s.name == owner || s.id == owner) && super::signals::state_of(s) == super::state_name("done"))
}

/// A task held by a stated `blockedOn` reason, unless its owner is a finished child of the session (then the reason cannot still hold).
fn held_now(t: &Task, st: &State, a: &Agent) -> bool {
    t.held && !owner_done(st, a, &t.owner)
}

/// An in-progress task nobody works on: its owner is not a running agent (no owner at all: no lane of the session runs either).
fn orphaned(t: &Task, st: &State, a: &Agent) -> bool {
    !held_now(t, st, a)
        && t.status == defaults::raw("nudges.compliance").str_field("in_progress")
        && !owner_live(st, a, &t.owner)
        && (!t.owner.is_empty() || !running_children(st, a))
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

/// Whether the tracker keeps the hold clocks of `a`: a live session of a kind `nudges.compliance.kinds` names, whatever the compliance
/// switch says (GH #959: with compliance off the clocks were cleared and the idle exemption never ended). The signals that speak about
/// a hold stay gated by [`watched`].
fn clocked(a: &Agent) -> bool {
    !a.gone && defaults::raw("nudges.compliance").get("kinds").map(V::strings).unwrap_or_default().contains(&a.kind.as_str())
}

/// Record, before the signals are read, since when each open held task has carried its current `blockedOn` reason (the clock of
/// `nudges.hold.hold_max_ms`). Unlike the in-progress clocks, a cover does not stop it: a hold is bounded whatever else runs.
pub(super) fn update_held(env: &Env, a: &mut Agent, tasks: &[Task], now: u64) {
    if !clocked(a) {
        a.held_since.clear();
        a.hold_due.clear();
        return;
    }
    let closed = defaults::raw("nudges.idle_wake").get("closed_statuses").map(V::strings).unwrap_or_default();
    let open_held: Vec<&Task> = tasks.iter().filter(|t| t.held && !closed.contains(&t.status.as_str())).collect();
    // since when each open task has carried ANY blockedOn reason (rewrites do not restart it): the total blocked time the owner sees;
    // a task missing here (state from before this map) starts at its oldest reason clock (GH #959 P2.3)
    let ids: Vec<&str> = open_held.iter().map(|t| t.id.as_str()).collect();
    a.blocked_since.retain(|id, _| ids.contains(&id.as_str()));
    for id in &ids {
        if !a.blocked_since.contains_key(*id) {
            let prefix = format!("{id}#");
            let oldest = a.held_since.iter().filter(|(k, _)| k.starts_with(&prefix)).map(|(_, s)| *s).min().unwrap_or(now);
            a.blocked_since.insert((*id).to_string(), oldest);
        }
    }
    let keys: Vec<&str> = open_held.iter().map(|t| t.held_key.as_str()).collect();
    a.held_since.retain(|k, _| keys.contains(&k.as_str()));
    for k in keys {
        a.held_since.entry(k.to_string()).or_insert(now);
    }
    let held_since = &a.held_since;
    a.hold_n.retain(|k, _| held_since.contains_key(k));
    // a confirmation belongs to the reason it confirmed: a rewritten reason (or a task no longer owner-held) is a new blocker (P1.4);
    // state from before the reason map keeps its confirmation for the reason it has now
    let owner: Vec<&Task> = open_held.iter().copied().filter(|t| t.owner_held).collect();
    let rh = |id: &str| owner.iter().find(|t| t.id == id).map(|t| t.reason_hash.clone());
    let stale: Vec<String> = a.hold_owner.keys().filter(|id| rh(id).is_none_or(|h| a.hold_owner_reason.get(*id).is_some_and(|r| *r != h))).cloned().collect();
    for id in stale {
        a.hold_owner.remove(&id);
    }
    a.hold_owner_reason = a.hold_owner.keys().filter_map(|id| rh(id).map(|h| (id.clone(), h))).collect();
    if watched(env, a) {
        // the confirmations the Stop recorded hold here too (the owner is told instead of the session)
        let file = super::owner_holds::read(&env.home, &a.id);
        for t in &owner {
            if file.get(&t.id).is_some_and(|e| e.r == t.reason_hash && now < e.u) && !a.hold_owner.contains_key(&t.id) {
                a.hold_owner.insert(t.id.clone(), 0);
                a.hold_owner_reason.insert(t.id.clone(), t.reason_hash.clone());
            }
        }
        owner_notice(env, a, tasks, now);
        share_confirmed(env, a, &owner, now);
    }
    // the holds the next hold_expired reminder names: the only ones it counts, bumps and confirms (P1.2)
    a.hold_due = named_holds(a, tasks, now).into_iter().map(|t| HoldDue { key: t.held_key.clone(), id: t.id.clone(), subject: t.subject.clone(), owner: t.owner_held, rh: t.reason_hash.clone() }).collect();
}

/// Write the tracker's confirmations (with their last owner notice, so each entry's bound moves with the notices) into the shared
/// file, under its lock; the Stop's fresh entries for the session's open owner-held tasks are kept, everything else is dropped.
fn share_confirmed(env: &Env, a: &Agent, owner: &[&Task], now: u64) {
    if !env.act {
        return;
    }
    let mine: Vec<(String, String, u64)> = a.hold_owner.iter().filter_map(|(id, n)| a.hold_owner_reason.get(id).map(|r| (id.clone(), r.clone(), *n))).collect();
    let open: Vec<(String, String)> = owner.iter().map(|t| (t.id.clone(), t.reason_hash.clone())).collect();
    let current = super::owner_holds::read(&env.home, &a.id);
    let want_same = mine.len() == current.len() && mine.iter().all(|(id, r, n)| current.get(id).is_some_and(|e| e.r == *r && e.n == *n));
    if want_same {
        return;
    }
    super::owner_holds::update(&env.home, &a.id, |m| {
        m.retain(|id, e| open.iter().any(|(i, r)| i == id && *r == e.r) && (now < e.u || mine.iter().any(|(i, _, _)| i == id)));
        for (id, r, n) in &mine {
            let c = m.get(id).filter(|e| e.r == *r).map_or(now, |e| e.c);
            m.insert(id.clone(), super::owner_holds::Entry { u: super::owner_holds::until(c, *n), r: r.clone(), c, n: *n });
        }
    });
}

/// A hold_expired reminder was delivered: each hold it named (`Agent::hold_due`, never another task's hold, never one past the shown
/// cap, GH #959) has one more reminder on its count, and a named owner-held task counts as confirmed with the session (from here on
/// only the owner is told).
pub(super) fn hold_sent(a: &mut Agent) {
    for d in a.hold_due.clone() {
        *a.hold_n.entry(d.key).or_insert(0) += 1;
        if d.owner {
            a.hold_owner.entry(d.id.clone()).or_insert(0);
            a.hold_owner_reason.insert(d.id, d.rh);
        }
    }
}

/// Owner-held tasks the session was already asked to confirm (its hold ran past `hold_max_ms` then): one notice for the owner per
/// task id per `owner_notice_ms` (the existing owner-notices route), never another word to the session. Only the tasks the notice
/// names (`nudges.compliance.tasks_shown`, the longest-unnoticed first) are advanced. A rewritten reason is a new blocker: its
/// confirmation, and with it the notice clock, is dropped in [`update_held`].
fn owner_notice(env: &Env, a: &mut Agent, tasks: &[Task], now: u64) {
    if !env.act || !env.switch("agent_tracker.remind_setting") || !watched(env, a) {
        return;
    }
    let hold = defaults::raw("nudges.hold");
    let every = num(hold, "owner_notice_ms");
    let mut due: Vec<(&Task, u64, u64)> = tasks
        .iter()
        .filter(|t| t.owner_held)
        .filter_map(|t| a.hold_owner.get(&t.id).filter(|last| **last == 0 || now.saturating_sub(**last) >= every).map(|last| (t, *last)))
        .filter(|(t, _)| a.held_since.contains_key(&t.held_key))
        // the total time blocked, from the first blockedOn seen on the task (a rewritten reason does not read 0s, GH #959)
        .map(|(t, last)| (t, last, a.blocked_since.get(&t.id).or_else(|| a.held_since.get(&t.held_key)).map_or(0, |s| now.saturating_sub(*s))))
        .collect();
    due.sort_by(|x, y| x.1.cmp(&y.1).then_with(|| x.0.id.cmp(&y.0.id)));
    due.truncate(num(defaults::raw("nudges.compliance"), "tasks_shown") as usize);
    let Some(longest) = due.iter().map(|(_, _, w)| *w).max() else { return };
    let who: String = (if a.name.is_empty() { &a.id } else { &a.name }).chars().take(fmtn("name_max") as usize).collect();
    let text = defaults::render(
        "msg.agent_hold_owner",
        &[("agent", &who), ("tasks", &subjects(&due.iter().map(|(t, _, _)| *t).collect::<Vec<_>>())), ("held", &super::sinks::age(longest))],
    );
    let r = super::sinks::Reminder {
        id: format!("{:x}", crate::health::fnv(&format!("{}hold_owner{now}", a.id))),
        ts: now,
        signal: "hold_owner".into(),
        agent: a.id.clone(),
        text,
    };
    use super::sinks::Sink;
    let sink = super::sinks::OwnerNotices;
    let f = super::signals::base(a).tok("channel", sink.channel()).num("evidence", due.len() as u64);
    match sink.deliver(env, "", &r) {
        Ok(()) => {
            for (t, _, _) in &due {
                a.hold_owner.insert(t.id.clone(), now);
            }
            super::signals::rec(env, "reminder", "hold_owner", crate::telemetry::event::Outcome::Advise, f);
            count_any("hold_owner", defaults::raw("nudges.compliance_outcomes").str_field("fired"));
        }
        Err(e) => crate::health::log_event("agents", "queue_write", &e),
    }
}

/// Whether the open work of an idle workspace (or main) session sits inside a live bounded hold (GH #959: idle_open_task spoke 10 min
/// after a rewritten `blockedOn` restarted the hold). The work is the task its declared step names, else every open task of its own
/// list; every one must be held (`held_now`) with its clock inside `nudges.hold.hold_max_ms` ([`update_held`] starts the clock at the
/// first sighting, before the signals are read; a missing clock is no hold). Past the bound hold_expired speaks instead. A subagent or
/// teammate is never exempt: an idle child is in state done, and a finished owner's reason holds nothing (`owner_done`, 2026-11-23).
pub(super) fn idle_work_held(a: &Agent, st: &State, tasks: &[Task], now: u64) -> bool {
    if super::is_child(a) {
        return false;
    }
    let max = num(defaults::raw("nudges.hold"), "hold_max_ms");
    let closed = defaults::raw("nudges.idle_wake").get("closed_statuses").map(V::strings).unwrap_or_default();
    let open: Vec<&Task> = tasks.iter().filter(|t| !closed.contains(&t.status.as_str())).collect();
    let step: Vec<&Task> = open.iter().copied().filter(|t| !a.step_task.is_empty() && t.id == a.step_task).collect();
    let work = if step.is_empty() { open } else { step };
    !work.is_empty() && work.iter().all(|t| held_now(t, st, a) && a.held_since.get(&t.held_key).is_some_and(|s| now.saturating_sub(*s) < max))
}

/// The open held tasks whose hold has run past `nudges.hold.hold_max_ms`, with how long each has been held.
fn expired_holds<'a>(a: &Agent, tasks: &'a [Task], now: u64) -> Vec<(&'a Task, u64)> {
    let max = num(defaults::raw("nudges.hold"), "hold_max_ms");
    // an owner-held task the session already confirmed once is the owner's to hear about, not the session's (see `owner_notice`)
    tasks.iter().filter(|t| t.held && !(t.owner_held && a.hold_owner.contains_key(&t.id))).filter_map(|t| a.held_since.get(&t.held_key).map(|s| (t, now.saturating_sub(*s)))).filter(|(_, w)| *w >= max).collect()
}

/// The expired holds one hold_expired reminder names: at most `nudges.compliance.tasks_shown`, the least reminded first (then by id),
/// so a long list rotates through the cap instead of starving its tail (P1.2).
fn named_holds<'a>(a: &Agent, tasks: &'a [Task], now: u64) -> Vec<&'a Task> {
    let mut due: Vec<&Task> = expired_holds(a, tasks, now).into_iter().map(|(t, _)| t).collect();
    due.sort_by(|x, y| a.hold_n.get(&x.held_key).copied().unwrap_or(0).cmp(&a.hold_n.get(&y.held_key).copied().unwrap_or(0)).then_with(|| x.id.cmp(&y.id)));
    due.truncate(num(defaults::raw("nudges.compliance"), "tasks_shown") as usize);
    due
}

/// `hold_expired`: a task has carried a `blockedOn` reason for `hold_max_ms`. Evidence: the longest hold in seconds among the named
/// tasks; text: their subjects. The exemption is time-bounded: this speaks after it, every cooldown, until the blocker is confirmed,
/// cleared or the task closed.
pub(super) fn hold_expired(env: &Env, a: &Agent, tasks: &[Task], now: u64) -> Option<Raised> {
    if !watched(env, a) {
        return None;
    }
    let named = named_holds(a, tasks, now);
    let longest = named.iter().filter_map(|t| a.held_since.get(&t.held_key)).map(|s| now.saturating_sub(*s)).max()?;
    let c = defaults::raw("nudges.compliance");
    Some((longest / fmtn("ms_per_s"), named.iter().map(|t| t.subject.as_str()).collect::<Vec<_>>().join(c.str_field("joiner"))))
}

/// The reminder text: advice first; once any named task has had `order_after` reminders, the order, with each named task carrying its
/// OWN count (`msg.agent_hold_task_count`; P1.3: one shared number misreported every task but one).
pub(super) fn hold_text(a: &Agent, evidence: u64, tasks: &str) -> String {
    let hold = defaults::raw("nudges.hold");
    let count = |d: &HoldDue| a.hold_n.get(&d.key).copied().unwrap_or(0);
    let order = a.hold_due.iter().any(|d| count(d) >= num(hold, "order_after"));
    let held = super::sinks::age(evidence * fmtn("ms_per_s"));
    if !order {
        return defaults::render("msg.agent_hold_expired", &[("tasks", &tasks), ("n", &evidence), ("held", &held)]);
    }
    let c = defaults::raw("nudges.compliance");
    let listed: Vec<String> = a.hold_due.iter().map(|d| defaults::render("msg.agent_hold_task_count", &[("task", &d.subject), ("sent", &count(d))])).collect();
    defaults::render("msg.agent_hold_expired_order", &[("tasks", &listed.join(c.str_field("joiner"))), ("n", &evidence), ("held", &held)])
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
    (watched(env, a) && a.ask_open && a.calls_since_ask >= num(defaults::raw("nudges.compliance"), "untracked_calls"))
        .then(|| (a.calls_since_ask, String::new()))
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

/// Count one event for ANY signal (not only the compliance ones): `undeliverable` and `cleared:<why>` are owed for every flag.
pub(super) fn count_any(sig: &str, outcome: &str) {
    crate::metrics::bump("compliance", &[("signal", sig), ("outcome", outcome)]);
}

/// A raised flag that reached nobody (no route, every write failed, or it stayed undelivered past `limits.undelivered_ms`).
pub(super) fn undeliverable(sig: &str, why: &str) {
    let o = defaults::raw("nudges.compliance_outcomes");
    count_any(sig, o.str_field("undeliverable"));
    crate::health::log_event("agents", "undeliverable", &format!("{sig}: {why}"));
}

/// A flag cleared, and why (`cleared:<why>`).
pub(super) fn cleared_why(sig: &str, why: &str) {
    let o = defaults::raw("nudges.compliance_outcomes");
    count_any(sig, &format!("{}{}{why}", o.str_field("cleared"), o.str_field("reason_sep")));
}
