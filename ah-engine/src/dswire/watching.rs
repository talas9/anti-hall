//! The DevSwarm thread: the file watcher over every DevSwarm source, the start-up reconcile and the loop that turns batches of
//! changes into reconciles. The watcher is generic (it knows directories, not DevSwarm); this module chooses the directories and
//! says what a change in each of them means.
use super::{Wire, consume, facts};
use crate::defaults;
use crate::devswarm_rt::reconcile::Cause;
use crate::devswarm_rt::state::Lifecycle;
use crate::meshw::idlock::devswarm_root;
use crate::meshw::union;
use crate::watch::{Config, Watcher, poll::Filter};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::time::Duration;

/// What a watched directory is.
#[derive(Debug, Clone, PartialEq)]
pub enum Role {
    /// A source of the workspace state: a change is a hint to reconcile.
    State,
    /// A workspace's transcript directory: a change dirties that workspace for Jev.
    Transcript(String),
    /// A workspace's git directory: a commit or checkout dirties that workspace for Jev.
    Git(String),
}

/// The directories to watch now, with the filter and role of each.
pub fn wanted(w: &Wire, cfg: &Config) -> Vec<(PathBuf, Filter, Role)> {
    let mut out: Vec<(PathBuf, Filter, Role)> = Vec::new();
    if let Some(db) = &w.rt.detection().app_db
        && let (Some(dir), Some(name)) = (db.parent(), db.file_name().and_then(|n| n.to_str()))
    {
        out.push((dir.to_path_buf(), cfg.sqlite_filter(name), Role::State));
    }
    let root = devswarm_root(&w.home);
    for k in defaults::list("devswarm_wire.watch_state_dirs") {
        out.push((root.join(defaults::text(k)), Filter::All, Role::State));
    }
    let snap = w.rt.current();
    for ws in snap.workspaces.values().filter(|x| x.lifecycle.value == Lifecycle::Active) {
        let Some(wt) = ws.worktree.as_deref() else { continue };
        if let Some(key) = facts::repo_key(wt) {
            out.push((union::store_dir(&w.home, &key), Filter::All, Role::State));
        }
        let descs = facts::descriptors(&w.home);
        for d in descs.iter().filter(|d| d.worktree == wt || d.id == ws.id) {
            if let Some(dir) = facts::transcript_path(&w.home, &d.worktree, &d.session).parent() {
                out.push((dir.to_path_buf(), Filter::All, Role::Transcript(ws.id.clone())));
            }
        }
        if let Some(g) = git_dir(wt) {
            out.push((g, Filter::names(defaults::list("devswarm_wire.watch_git_names")), Role::Git(ws.id.clone())));
        }
    }
    out
}

/// A worktree's git directory: `<wt>/.git` itself, or the target of the `gitdir:` line a linked worktree has in its place.
fn git_dir(wt: &str) -> Option<PathBuf> {
    let spec = defaults::raw("devswarm_wire.git_dir_file");
    let p = Path::new(wt).join(spec.str_field("file"));
    if p.is_dir() {
        return Some(p);
    }
    let line = std::fs::read_to_string(&p).ok()?;
    let target = line.lines().next()?.strip_prefix(spec.str_field("prefix"))?.trim();
    let t = Path::new(target);
    Some(if t.is_absolute() { t.to_path_buf() } else { Path::new(wt).join(t) })
}

/// Bring the watcher in line with [`wanted`]: add directories that appeared, drop ones no longer wanted.
pub fn sync(w: &Wire, watcher: &Watcher, have: &mut HashMap<PathBuf, Role>) {
    let want = wanted(w, watcher.config());
    for (dir, filter, role) in &want {
        if have.get(dir) != Some(role) {
            if have.contains_key(dir) {
                watcher.remove(dir);
            }
            watcher.add(dir, filter.clone());
            have.insert(dir.clone(), role.clone());
        }
    }
    let gone: Vec<PathBuf> = have.keys().filter(|d| !want.iter().any(|(x, _, _)| x == *d)).cloned().collect();
    for d in gone {
        watcher.remove(&d);
        have.remove(&d);
    }
}

/// What a batch of changed paths asks for.
#[derive(Debug, Default, PartialEq)]
pub struct Plan {
    /// A state source changed, or the watcher lost track.
    pub reconcile: Option<Cause>,
    /// Workspaces whose transcript or git directory changed.
    pub dirty: Vec<String>,
}

/// Classify a batch against the watched directories.
pub fn plan(have: &HashMap<PathBuf, Role>, rescan: bool, paths: &[PathBuf]) -> Plan {
    let mut p = Plan::default();
    if rescan {
        p.reconcile = Some(Cause::Overflow);
    }
    for path in paths {
        match path.parent().and_then(|d| have.get(d)) {
            Some(Role::State) if p.reconcile.is_none() => p.reconcile = Some(Cause::Event),
            Some(Role::Transcript(id) | Role::Git(id)) if !p.dirty.contains(id) => p.dirty.push(id.clone()),
            _ => {}
        }
    }
    p
}

/// The thread body: reconcile at start, then one reconcile per batch, until `stop` says the daemon is draining.
pub fn run(w: &Wire, stop: &dyn Fn() -> bool) {
    w.reconcile(Cause::Startup);
    let watcher = Watcher::start(Config::load());
    let mut have: HashMap<PathBuf, Role> = HashMap::new();
    sync(w, &watcher, &mut have);
    let wait = Duration::from_millis(defaults::num("devswarm_wire.wait_ms"));
    while !stop() {
        w.act_if_pending();
        w.events_if_due();
        let Some(batch) = watcher.next(wait) else { continue };
        let p = plan(&have, batch.rescan, &batch.paths);
        if !p.dirty.is_empty() {
            let n = consume::queue_ids(&w.state_dir, &p.dirty);
            if n > 0 {
                w.count_dirty(n);
            }
            w.run_jev();
        }
        if let Some(cause) = p.reconcile {
            w.reconcile(cause);
            sync(w, &watcher, &mut have);
        }
    }
}
