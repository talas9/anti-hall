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
#[derive(Debug, Clone, Default)]
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
    /// When the task file was last written (ms; 0 unknown): a write after a hold reminder named the task confirms the hold (#972).
    pub(super) mtime: u64,
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
        let mtime = crate::checks::agent_scan::mtime_ms(&e.path()).map_or(0, |m| m.max(0.0) as u64);
        out.push(Task { id: s("f_id"), subject: s("f_subject"), status: s("f_status"), owner: s("f_owner"), blocked, held, held_key, owner_held, mtime });
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

/// Whether any signal that reads the task list is switched on.
pub(super) fn readers_on(env: &Env) -> bool {
    env.switch("agent_tracker.idle_wake_sw") || env.switch("agent_tracker.parallel_sw") || env.switch("agent_tracker.compliance_sw")
}

/// The session's whole task list for the hold clocks, read whatever the reader switches say (GH #959: switching a reader back on
/// must never find the clocks gone and grant a fresh hold).
pub(super) fn load_all(env: &Env, a: &Agent) -> Vec<Task> {
    if !clocked(a) {
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

/// Whether the tracker keeps the hold clocks of `a`: a live session of a kind `nudges.compliance.kinds` names, whatever the switches of
/// the signals that read the clocks say (GH #959: with them off the clocks were cleared, and switching one back on granted a fresh
/// hold). The signals that speak about a hold stay gated by [`watched`].
pub(super) fn clocked(a: &Agent) -> bool {
    !a.gone && defaults::raw("nudges.compliance").get("kinds").map(V::strings).unwrap_or_default().contains(&a.kind.as_str())
}

/// Record, before the signals are read, since when each open held task has carried its current `blockedOn` reason (the clock of
/// `nudges.hold.hold_max_ms`) and since when it has carried any reason at all (the total the owner notice keys on). Unlike the
/// in-progress clocks, a cover does not stop them: a hold is bounded whatever else runs. `tasks` is the session's whole list, read
/// whether or not a signal that reads it is on.
pub(super) fn update_held(env: &Env, a: &mut Agent, tasks: &[Task], now: u64) {
    if !clocked(a) {
        a.held_since.clear();
        a.hold_due.clear();
        return;
    }
    let closed = defaults::raw("nudges.idle_wake").get("closed_statuses").map(V::strings).unwrap_or_default();
    let open_held: Vec<&Task> = tasks.iter().filter(|t| t.held && !closed.contains(&t.status.as_str())).collect();
    // since when each open task has carried ANY blockedOn reason (rewrites do not restart it); a task missing here (state from before
    // this map) starts at its oldest reason clock
    let ids: Vec<&str> = open_held.iter().map(|t| t.id.as_str()).collect();
    a.blocked_since.retain(|id, _| ids.contains(&id.as_str()));
    for id in &ids {
        if !a.blocked_since.contains_key(*id) {
            let prefix = format!("{id}#");
            let oldest = a.held_since.iter().filter(|(k, _)| k.starts_with(&prefix)).map(|(_, s)| *s).min().unwrap_or(now);
            a.blocked_since.insert((*id).to_string(), oldest);
        }
    }
    // #961 confirm-once, tracker side: a write of a task after a hold reminder named it (a rewritten reason, or the same reason saved
    // again) is the session's answer; that hold is silent for confirm_ms, tied to the reason it confirmed
    for t in &open_held {
        if let Some(told) = a.hold_told.get(&t.id).copied()
            && t.mtime > told
        {
            a.hold_confirmed.insert(t.id.clone(), (t.held_key.clone(), now));
            a.hold_told.remove(&t.id);
            suppressed_outcome("hold_expired", "confirmed");
        }
    }
    a.hold_told.retain(|id, _| ids.contains(&id.as_str()));
    a.hold_confirmed.retain(|id, _| ids.contains(&id.as_str()));
    let keys: Vec<&str> = open_held.iter().map(|t| t.held_key.as_str()).collect();
    a.held_since.retain(|k, _| keys.contains(&k.as_str()));
    for k in keys {
        a.held_since.entry(k.to_string()).or_insert(now);
    }
    let held_since = &a.held_since;
    a.hold_n.retain(|k, _| held_since.contains_key(k));
    a.hold_last.retain(|k, _| held_since.contains_key(k));
    // state from before `owner_noticed` kept the last notice in `hold_owner`: carried over BEFORE any pruning, so a detour to a
    // non-owner reason on the first tick after the upgrade cannot lose it (and send a second notice inside owner_notice_ms)
    for (id, last) in &a.hold_owner {
        if *last > 0 {
            a.owner_noticed.entry(id.clone()).or_insert(*last);
        }
    }
    let owner_ids: Vec<&str> = open_held.iter().filter(|t| t.owner_held).map(|t| t.id.as_str()).collect();
    a.hold_owner.retain(|id, _| owner_ids.contains(&id.as_str()));
    // kept per task until it closes or its blockedOn is cleared: a short detour to a non-owner reason must not restart the interval
    a.owner_noticed.retain(|id, _| ids.contains(&id.as_str()));
    owner_notice(env, a, tasks, now);
    // the holds the next hold_expired reminder may name, in rank order: at most tasks_shown ([`hold_render`] lists as many as fit)
    a.hold_due = named_holds(a, tasks, now).into_iter().map(|t| HoldDue { key: t.held_key.clone(), id: t.id.clone(), subject: t.subject.clone(), owner: t.owner_held }).collect();
}

/// A hold_expired reminder reached the session itself: each hold [`hold_render`] listed in it (never another task's, never one the cap
/// left out, GH #959) has one more reminder on its count and its last-reminded time, and a listed owner-held task counts as confirmed.
pub(super) fn hold_sent(a: &mut Agent, named: &[HoldDue], now: u64) {
    for d in named {
        *a.hold_n.entry(d.key.clone()).or_insert(0) += 1;
        a.hold_last.insert(d.key.clone(), now);
        a.hold_told.insert(d.id.clone(), now);
        if d.owner {
            a.hold_owner.entry(d.id.clone()).or_insert(0);
        }
    }
}

/// Text as the reminder shows it: runs of whitespace collapsed, as the text cap ([`super::cap`]) collapses them.
fn flat(s: &str) -> String {
    s.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// How a task is named in a hold reminder or owner notice: its subject (whitespace collapsed), or `msg.agent_hold_task_ref` with its
/// id when the subject is empty, so a listed task is always visibly named.
fn shown_name(id: &str, subject: &str) -> String {
    let s = flat(subject);
    if s.is_empty() { flat(&defaults::fill_once(defaults::text("msg.agent_hold_task_ref"), &[("id", &id)])) } else { s }
}

/// A `msg.*` text with its values inserted in one pass ([`defaults::fill_once`]): a subject holding `{held}` is shown as written.
fn render1(key: &str, args: &[(&str, &dyn std::fmt::Display)]) -> String {
    defaults::fill_once(defaults::text(key), args)
}

/// Lay a list out into one message, item by item, under `agent_tracker.spam.max_text` (GH #959: the forward design; nothing is
/// matched back out of the text). `render` renders the whole message from the items listed so far (index, shown name). Each item is
/// tried whole, then shortened to the room left (at least `nudges.hold.subject_min` visible characters after trimming, plus
/// `nudges.hold.subject_cut`); one that fits in neither form is skipped and the next is tried. Returns the text (whitespace collapsed, so the cap leaves it unchanged) and the
/// indices listed, in order: only those may be counted, confirmed or noticed.
pub(super) fn fit(names: &[String], render: impl Fn(&[(usize, String)]) -> String) -> (String, Vec<usize>) {
    let max = defaults::raw("agent_tracker.spam").get("max_text").and_then(V::as_integer).unwrap_or(0).max(0) as usize;
    let hold = defaults::raw("nudges.hold");
    let (min, cut) = (num(hold, "subject_min") as usize, hold.str_field("subject_cut"));
    let fits = |shown: &[(usize, String)]| flat(&render(shown)).chars().count() <= max;
    let short = |name: &str, n: usize| format!("{}{cut}", name.chars().take(n).collect::<String>().trim_end());
    let mut shown: Vec<(usize, String)> = Vec::new();
    for (i, name) in names.iter().enumerate() {
        let mut trial = shown.clone();
        trial.push((i, name.clone()));
        if fits(&trial) {
            shown = trial;
            continue;
        }
        let len = name.chars().count();
        // the longest prefix (min..len) that fits; the rendered length grows with the prefix, so a binary search finds it
        let (mut lo, mut hi, mut best) = (min, len.saturating_sub(1), None);
        while lo <= hi && hi > 0 {
            let mid = lo + (hi - lo) / 2;
            let mut cand = shown.clone();
            cand.push((i, short(name, mid)));
            if fits(&cand) {
                best = Some(mid);
                lo = mid + 1;
            } else if mid == 0 {
                break;
            } else {
                hi = mid - 1;
            }
        }
        // a shorter prefix shows no more characters, so if the longest that fits keeps fewer than `min` after trimming, none does
        let visible = |n: usize| name.chars().take(n).collect::<String>().trim_end().chars().count();
        if let Some(n) = best.filter(|n| visible(*n) >= min) {
            shown.push((i, short(name, n)));
        }
    }
    (flat(&render(&shown)), shown.into_iter().map(|(i, _)| i).collect())
}

/// The owner notice: an open task whose current `blockedOn` names the owner or a human and that has been blocked (any reason, rewrites
/// included: `blocked_since`) for `hold_max_ms` in total is the owner's to hear about, at most once per task per `owner_notice_ms` (the
/// owner-notices route). Keyed on the total, not on the per-reason clock or the session's confirmation, so rewriting the reason never
/// starves it (GH #959). The tasks are listed longest-unnoticed first (then the longest blocked) as many as fit ([`fit`], at most
/// `tasks_shown`), and only the listed ones are advanced.
fn owner_notice(env: &Env, a: &mut Agent, tasks: &[Task], now: u64) {
    if !env.act || !env.switch("agent_tracker.remind_setting") || !watched(env, a) {
        return;
    }
    let hold = defaults::raw("nudges.hold");
    let (every, max) = (num(hold, "owner_notice_ms"), num(hold, "hold_max_ms"));
    let closed = defaults::raw("nudges.idle_wake").get("closed_statuses").map(V::strings).unwrap_or_default();
    let mut due: Vec<(&Task, u64, u64)> = tasks
        .iter()
        .filter(|t| t.owner_held && !closed.contains(&t.status.as_str()))
        .filter_map(|t| a.blocked_since.get(&t.id).map(|s| (t, now.saturating_sub(*s))))
        .filter(|(_, blocked)| *blocked >= max)
        .map(|(t, blocked)| (t, a.owner_noticed.get(&t.id).copied().unwrap_or(0), blocked))
        .filter(|(_, last, _)| *last == 0 || now.saturating_sub(*last) >= every)
        .collect();
    due.sort_by(|x, y| x.1.cmp(&y.1).then_with(|| y.2.cmp(&x.2)).then_with(|| x.0.id.cmp(&y.0.id)));
    let c = defaults::raw("nudges.compliance");
    due.truncate(num(c, "tasks_shown") as usize);
    if due.is_empty() {
        return;
    }
    let who: String = (if a.name.is_empty() { &a.id } else { &a.name }).chars().take(fmtn("name_max") as usize).collect();
    let names: Vec<String> = due.iter().map(|(t, _, _)| shown_name(&t.id, &t.subject)).collect();
    let (text, listed) = fit(&names, |shown| {
        let longest = shown.iter().map(|(i, _)| due[*i].2).max().unwrap_or(0);
        let tasks = shown.iter().map(|(_, n)| n.as_str()).collect::<Vec<_>>().join(c.str_field("joiner"));
        render1("msg.agent_hold_owner", &[("agent", &who), ("tasks", &tasks), ("held", &super::sinks::age(longest))])
    });
    if listed.is_empty() {
        return;
    }
    let due: Vec<(&Task, u64, u64)> = listed.into_iter().map(|i| due[i]).collect();
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
                a.owner_noticed.insert(t.id.clone(), now);
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
    !work.is_empty() && work.iter().all(|t| held_now(t, st, a) && (a.held_since.get(&t.held_key).is_some_and(|s| now.saturating_sub(*s) < max) || confirmed(a, t, now)))
}

/// The session confirmed this exact hold (it wrote the task after a reminder named it) within `nudges.hold.confirm_ms` (#972, #961).
fn confirmed(a: &Agent, t: &Task, now: u64) -> bool {
    let ms = num(defaults::raw("nudges.hold"), "confirm_ms");
    a.hold_confirmed.get(&t.id).is_some_and(|(k, at)| *k == t.held_key && now.saturating_sub(*at) < ms)
}

/// The open held tasks whose hold has run past `nudges.hold.hold_max_ms`, with how long each has been held.
fn expired_holds<'a>(a: &Agent, tasks: &'a [Task], now: u64) -> Vec<(&'a Task, u64)> {
    let max = num(defaults::raw("nudges.hold"), "hold_max_ms");
    // an owner-held task the session already confirmed once is the owner's to hear about, not the session's (see `owner_notice`)
    tasks
        .iter()
        .filter(|t| t.held && !(t.owner_held && a.hold_owner.contains_key(&t.id)) && !confirmed(a, t, now))
        .filter_map(|t| a.held_since.get(&t.held_key).map(|s| (t, now.saturating_sub(*s))))
        .filter(|(_, w)| *w >= max)
        .collect()
}

/// The expired holds one hold_expired reminder may name, in rank order: the least reminded first, then the one reminded longest ago
/// (never reminded first), then the oldest hold; at most `nudges.compliance.tasks_shown`. A long list rotates through the cap and no
/// task starves the others (GH #959).
fn named_holds<'a>(a: &Agent, tasks: &'a [Task], now: u64) -> Vec<&'a Task> {
    let mut due: Vec<&Task> = expired_holds(a, tasks, now).into_iter().map(|(t, _)| t).collect();
    let rank = |t: &Task| {
        let get = |m: &std::collections::BTreeMap<String, u64>| m.get(&t.held_key).copied().unwrap_or(0);
        (get(&a.hold_n), get(&a.hold_last), get(&a.held_since))
    };
    due.sort_by(|x, y| rank(x).cmp(&rank(y)).then_with(|| x.id.cmp(&y.id)));
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

/// The hold_expired reminder and the holds it lists (GH #959): the tasks of `hold_due` in rank order, added one by one, each shortened
/// if needed, until the text cap ([`fit`]). Advice first; once a listed task has had `order_after` reminders, the order, each listed
/// task carrying its OWN count (`msg.agent_hold_task_count`). `{held}`/`{n}` are the longest hold among the listed tasks. Only the
/// returned holds may be counted or confirmed ([`hold_sent`]).
pub(super) fn hold_render(a: &Agent, now: u64) -> (String, Vec<HoldDue>) {
    let hold = defaults::raw("nudges.hold");
    let c = defaults::raw("nudges.compliance");
    let count = |d: &HoldDue| a.hold_n.get(&d.key).copied().unwrap_or(0);
    let names: Vec<String> = a.hold_due.iter().map(|d| shown_name(&d.id, &d.subject)).collect();
    let (text, listed) = fit(&names, |shown| {
        let ds: Vec<(&HoldDue, &str)> = shown.iter().map(|(i, n)| (&a.hold_due[*i], n.as_str())).collect();
        let longest = ds.iter().filter_map(|(d, _)| a.held_since.get(&d.key)).map(|s| now.saturating_sub(*s)).max().unwrap_or(0);
        let n = longest / fmtn("ms_per_s");
        let held = super::sinks::age(n * fmtn("ms_per_s"));
        if ds.iter().any(|(d, _)| count(d) >= num(hold, "order_after")) {
            let tasks: Vec<String> = ds.iter().map(|(d, name)| render1("msg.agent_hold_task_count", &[("task", name), ("sent", &count(d))])).collect();
            render1("msg.agent_hold_expired_order", &[("tasks", &tasks.join(c.str_field("joiner"))), ("n", &n), ("held", &held)])
        } else {
            let tasks = ds.iter().map(|(_, name)| *name).collect::<Vec<_>>().join(c.str_field("joiner"));
            render1("msg.agent_hold_expired", &[("tasks", &tasks), ("n", &n), ("held", &held)])
        }
    });
    (text, listed.into_iter().map(|i| a.hold_due[i].clone()).collect())
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

/// A held reminder, counted for any signal: `suppressed:<reason>` (#972).
pub(super) fn suppressed_any(sig: &str, reason: &str) {
    suppressed_outcome(sig, reason);
}

/// A held reminder, counted for any signal: `suppressed:<reason>` (#972: a hold confirmed by the session's answer).
fn suppressed_outcome(sig: &str, reason: &str) {
    let o = defaults::raw("nudges.compliance_outcomes");
    count_any(sig, &format!("{}{}{reason}", o.str_field("suppressed"), o.str_field("reason_sep")));
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
