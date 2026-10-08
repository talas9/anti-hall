//! Which open tasks the Stop is about: the actionable-now set (`classifyOpen`) behind the idle-neglect block, the
//! not-honestly-blocked set (`unblockedOpen`) behind the generic block, and the DevSwarm questions both ask
//! (`devswarmChildAttended`, `anyLiveDevswarmChildren`).
//!
//! The DevSwarm answers come from the DevSwarm app's own SQLite database, read by Node through `node:sqlite` behind a
//! capability gate. The engine does not reproduce that read: when the database file exists and the answer is needed, the
//! call is [`Unsure`] and the Node hook decides. Without the file Node's answer is fixed (no record, nothing live), and the
//! engine gives the same one.
use crate::checks::git::util::Settings;
use crate::checks::guardkit::jsre;
use crate::checks::guardkit::settings::{get_bool, get_enum};
use crate::checks::guardkit::text::js_trim;
use crate::checks::taskkit::jsval::{R, Unsure};
use crate::checks::taskstate::{Task, TaskMap};
use crate::defaults;
use regex::Regex;
use std::collections::HashSet;

struct Res {
    coordinator: Regex,
    owner_subject: Regex,
    ws_prefix: Regex,
    priority: Regex,
}

fn res() -> &'static Res {
    static R: crate::defaults::Cache<Res> = crate::defaults::Cache::new();
    R.get_or_init(|| Res {
        coordinator: jsre::compile(defaults::text("task_guard.coordinator_owner_re"), true),
        owner_subject: jsre::compile(defaults::text("dispatch_tier.owner_subject_re"), true),
        ws_prefix: jsre::compile(defaults::text("task_guard.workspace_prefix_re"), true),
        priority: jsre::compile(defaults::text("task_guard.priority_rank_re"), false),
    })
}

fn done(t: &Task) -> bool {
    defaults::list("taskstate.done_statuses").contains(&t.status_lc().as_str())
}

/// An owner that is the orchestrator itself (`main`, `orchestrator`, `coordinator`): the task still counts as unowned.
fn coordinator_owner(o: &str) -> bool {
    res().coordinator.is_match(o)
}

/// `isOwnerBlocked` of `lib/dispatch-demand.js`: an owner/user/human/external `blockedOn` marker, or an `OWNER:` /
/// `OWNER DECISION` subject, while the marker switch is on.
pub fn owner_blocked(t: &Task, st: &Settings) -> bool {
    if !get_bool(st, defaults::raw("dispatch_tier.owner_marker_setting")) {
        return false;
    }
    if defaults::list("dispatch_tier.owner_values").contains(&t.blocked_on_text().as_str()) {
        return true;
    }
    res().owner_subject.is_match(&t.content)
}

/// `priorityRank(p)`: `pN` is N, `low` and `deferred` rank below the default, anything else (or none) is the default.
fn priority_rank(p: Option<&str>) -> f64 {
    let Some(p) = p.filter(|p| !p.is_empty()) else { return defaults::num("task_guard.priority_default_rank") as f64 };
    let s = js_trim(p).to_lowercase();
    if let Some(c) = res().priority.captures(&s) {
        // `parseInt` of a digit run
        return c[1].parse::<f64>().unwrap_or(f64::INFINITY);
    }
    if defaults::list("task_guard.priority_low").contains(&s.as_str()) {
        return defaults::num("task_guard.priority_low_rank") as f64;
    }
    defaults::num("task_guard.priority_default_rank") as f64
}

/// `idleNeglectMinPriorityRank()`: the rank of the `guards.idleNeglectMinPriority` floor.
fn min_priority_rank(st: &Settings) -> f64 {
    let raw = get_enum(st, defaults::raw("task_guard.min_priority_setting"));
    match res().priority.captures(js_trim(&raw).to_lowercase().as_str()) {
        Some(c) => c[1].parse::<f64>().unwrap_or(f64::INFINITY),
        None => defaults::num("task_guard.priority_default_rank") as f64,
    }
}

/// `classifyOpen(openTasks, taskMap)`: the open tasks that can be dispatched now (pending, unowned or owned by the
/// orchestrator, block state known, not waiting on the owner, no open or unknown blocker, at or above the priority floor).
pub fn actionable<'a>(open: &[&'a Task], tasks: &TaskMap, st: &Settings) -> Vec<&'a Task> {
    let known: HashSet<&str> = tasks.values().map(|t| t.id.as_str()).collect();
    let not_done: HashSet<&str> = tasks.values().filter(|t| !done(t)).map(|t| t.id.as_str()).collect();
    let floor = min_priority_rank(st);
    let pending = defaults::text("task_guard.pending_status");
    let mut out = Vec::new();
    for t in open {
        if t.status_lc() != pending || t.block_unknown {
            continue;
        }
        if !t.owner.is_empty() && !coordinator_owner(&t.owner) {
            continue;
        }
        if owner_blocked(t, st) {
            continue;
        }
        if t.blocked_by.iter().any(|id| not_done.contains(id.as_str()) || !known.contains(id.as_str())) {
            continue;
        }
        if priority_rank(t.priority.as_deref()) > floor {
            continue;
        }
        out.push(*t);
    }
    out
}

/// `unblockedOpen(openTasks, taskMap)`: the open tasks the generic block lists. A task waiting (through any chain) on an
/// open task that is itself free or waiting on the owner is honestly blocked and left out, as is a task waiting on the
/// owner and one owned by a live DevSwarm workspace.
pub fn unblocked<'a>(open: &[&'a Task], tasks: &TaskMap, st: &Settings) -> R<Vec<&'a Task>> {
    let open_statuses = defaults::list("taskstate.open_statuses");
    let mut open_ids: Vec<&str> = Vec::new();
    for t in tasks.values() {
        if open_statuses.contains(&t.status_lc().as_str()) && !open_ids.contains(&t.id.as_str()) {
            open_ids.push(t.id.as_str());
        }
    }
    let open_set: HashSet<&str> = open_ids.iter().copied().collect();
    let valid = |t: &Task| -> Vec<String> { t.blocked_by.iter().filter(|id| **id != t.id && open_set.contains(id.as_str())).cloned().collect() };
    let mut reach: HashSet<String> = HashSet::new();
    for id in &open_ids {
        if let Some(t) = tasks.get(id)
            && (valid(t).is_empty() || owner_blocked(t, st))
        {
            reach.insert(id.to_string());
        }
    }
    let mut changed = true;
    while changed {
        changed = false;
        for id in &open_ids {
            if reach.contains(*id) {
                continue;
            }
            let Some(t) = tasks.get(id) else { continue };
            if valid(t).iter().any(|b| reach.contains(b)) {
                reach.insert(id.to_string());
                changed = true;
            }
        }
    }
    let mut out = Vec::new();
    for t in open {
        if owner_blocked(t, st) || valid(t).iter().any(|b| reach.contains(b)) || child_attended(&t.owner, st)? {
            continue;
        }
        out.push(*t);
    }
    Ok(out)
}

/// The DevSwarm app database `companion/lib/devswarm-app-db.js` `appDbPath` names: the override variable (`off` turns it
/// off), else the per-platform application data path. `None` when there is none.
fn app_db_path(st: &Settings) -> Option<String> {
    let over = st.env.get(defaults::text("task_guard.app_db_env")).map(|v| js_trim(v).to_string()).unwrap_or_default();
    if !over.is_empty() {
        return (over.to_lowercase() != defaults::text("task_guard.app_db_off")).then_some(over);
    }
    if st.home.is_empty() {
        return None;
    }
    let base = if cfg!(target_os = "macos") {
        let mut p = std::path::PathBuf::from(&st.home);
        p.extend(defaults::list("task_guard.app_db_darwin_dir"));
        p
    } else if cfg!(target_os = "linux") {
        match st.env.get(defaults::text("task_guard.app_db_xdg_env")).filter(|v| !v.is_empty()) {
            Some(x) => std::path::PathBuf::from(x),
            None => std::path::Path::new(&st.home).join(defaults::text("task_guard.app_db_linux_config")),
        }
    } else {
        return None;
    };
    let mut p = base;
    p.extend(defaults::list("task_guard.app_db_file"));
    Some(p.to_string_lossy().into_owned())
}

/// Node's DevSwarm answers are fixed (no record, nothing live) when the app database file is absent; with it present only
/// the `node:sqlite` read can tell, which the engine does not do.
fn app_db_present(st: &Settings) -> bool {
    app_db_path(st).is_some_and(|p| std::fs::metadata(p).is_ok_and(|m| m.is_file()))
}

/// `devswarmChildAttended(owner)`: the owner names a live DevSwarm workspace. [`Unsure`] when that needs the app database.
fn child_attended(owner: &str, st: &Settings) -> R<bool> {
    let o = js_trim(owner);
    if o.is_empty() || coordinator_owner(o) {
        return Ok(false);
    }
    let id = res().ws_prefix.replace(o, "");
    if js_trim(&id).is_empty() {
        return Ok(false);
    }
    if app_db_present(st) { Err(Unsure) } else { Ok(false) }
}

/// `anyLiveDevswarmChildren()`: some DevSwarm workspace is not archived. [`Unsure`] when that needs the app database.
pub fn any_live_children(st: &Settings) -> R<bool> {
    if app_db_present(st) { Err(Unsure) } else { Ok(false) }
}

/// The id a block hash and a dispatch label use: `String(t.id || t.content || t.subject || '')`.
pub fn hash_id(t: &Task) -> String {
    if !t.id.is_empty() { t.id.clone() } else { t.content.clone() }
}
