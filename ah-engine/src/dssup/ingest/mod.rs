//! The native ingest drain (lane l7b): the engine takes over what the Node ingest daemon (`companion/devswarm-ingest.js`, one
//! launchd / systemd unit per project) does, so the kit can uninstall those units.
//!
//! * [`Owner`] is the switch (`devswarm_ingest.mode`): `witness` (default) leaves the drain to the Node daemons and starts nothing;
//!   `engine` runs project drains through bounded worker slots. While a Node daemon still holds a project's lock the engine's
//!   drain for that project waits (the lock is the single-consumer guard: it never takes a live holder's lock) and takes over the
//!   moment the holder is gone. Nothing is ever double-drained.
//! * [`drain`] is one project's drain, [`wal`] its delivery write-ahead log (Node's format, so a WAL left open by either side is
//!   replayed by the other), [`import`] the loss-free import into the store, [`monitor`] the bounded `hivecontrol workspace
//!   monitor` call with Node's circuit breaker.
//! * Which projects: the explicit `devswarm_ingest.projects` setting (paths separated by `:`), the worktrees of the registered
//!   DevSwarm workspaces (so a new project is drained without a Node ingest unit), the working directories of fresh Node ingest
//!   heartbeats (so a project served today is served after the cutover), and what an earlier run remembered. Unless
//!   `devswarm_ingest.require_registered` is off, only an explicit path or a project a workspace descriptor names qualifies: a
//!   scratch clone an agent worked in never does. A path that is not a git repository is skipped. Nothing is deleted from the
//!   remembered list.
//! * [`write_owner`] keeps the ownership marker (`devswarm/<devswarm_ingest.owner_file>`) the Node ingest installers read: while
//!   it says engine, no Node path installs or heals an ingest unit.
// Discard triage (E3): every `.ok()` / `unwrap_or_default()` in this module is a deliberate keep, for these reasons:
// - a heartbeat or state file that is absent or unparsable is the absent value (discovery is additive)
pub mod drain;
pub mod import;
pub mod monitor;
pub mod wal;

use crate::checks::git::util::Settings;
use crate::checks::guardkit::nodelock;
use crate::defaults;
use crate::dsact::runner::{Runner, System};
use crate::mem::{Owner as MemOwner, Spec};
use crate::meshw::idlock::devswarm_root;
use drain::{Drainer, DropReason, Project, Start};
use serde_json::{Value, json};
use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, mpsc};

/// Who owns the drain.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Owner {
    /// The Node ingest daemons; the engine drains nothing.
    Witness,
    /// The engine.
    Engine,
}

impl Owner {
    /// Parse the `devswarm_ingest.mode` word; anything but the engine word is witness, so a typo never starts a second consumer.
    pub fn parse(word: &str) -> Owner {
        let words = defaults::list("devswarm_ingest.mode_words");
        if words.get(1).is_some_and(|w| word.trim().eq_ignore_ascii_case(w)) { Owner::Engine } else { Owner::Witness }
    }
}

/// The configured owner.
pub fn owner() -> Owner {
    Owner::parse(&crate::dswire::effective_text("devswarm_ingest.mode"))
}

fn now_ms() -> i64 {
    crate::health::now_ms() as i64
}

fn read_json(p: &Path) -> Option<Value> {
    serde_json::from_str(&std::fs::read_to_string(p).ok()?).ok()
}

/// The repo keys the registered DevSwarm workspaces carry (descriptor `repoKey`), and one existing worktree per key.
fn registered(home: &Path) -> (BTreeSet<String>, Vec<String>) {
    let dir = devswarm_root(home).join(defaults::text("mesh_write.dir_workspaces"));
    let (field_key, field_wt) = (defaults::text("mesh_write.field_repo_key"), defaults::text("mesh_write.field_worktree_path"));
    let mut names: Vec<PathBuf> = std::fs::read_dir(&dir)
        .into_iter()
        .flatten()
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.to_string_lossy().ends_with(defaults::text("devswarm_ingest.json_suffix")))
        .collect();
    names.sort();
    let (mut keys, mut worktrees) = (BTreeSet::new(), std::collections::BTreeMap::new());
    for p in names {
        let Some(v) = read_json(&p) else { continue };
        let Some(key) = v.get(field_key).and_then(Value::as_str).filter(|k| !k.is_empty()) else { continue };
        keys.insert(key.to_string());
        if !worktrees.contains_key(key)
            && let Some(wt) = v.get(field_wt).and_then(Value::as_str).filter(|w| Path::new(w).is_dir())
        {
            worktrees.insert(key.to_string(), wt.to_string());
        }
    }
    (keys, worktrees.into_values().collect())
}

/// The last drop reason logged per path. In-process on purpose: the discovery loop runs in one daemon thread and repeats every
/// `devswarm_ingest.discover_ms`, so a map keeps it to one line per (path, reason) with no file I/O; a restart repeats each line
/// once, which is wanted (the log then says what the new process sees). Bounded by `devswarm_ingest.drop_log_max_paths`.
static DROPPED: Mutex<BTreeMap<String, String>> = Mutex::new(BTreeMap::new());

/// Log that `path` is not drained, and count it, when `reason` is new for the path.
fn note_drop(home: &Path, path: &str, reason: &DropReason) {
    let word = reason.word();
    {
        let mut g = DROPPED.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        if g.get(path).is_some_and(|w| w == word) {
            return;
        }
        if g.len() >= defaults::num("devswarm_ingest.drop_log_max_paths") as usize && !g.contains_key(path) {
            g.clear();
        }
        g.insert(path.to_string(), word.to_string());
    }
    drain::log_line(home, &defaults::render("devswarm_ingest.msg_project_dropped", &[("path", &path), ("reason", &word), ("detail", &reason.detail)]));
    crate::metrics::bump("ingest_drops", &[("reason", word)]);
}

/// The path resolves again (or was never dropped): forget its reason, so a later drop is logged afresh.
fn note_kept(path: &str) {
    DROPPED.lock().unwrap_or_else(std::sync::PoisonError::into_inner).remove(path);
}

/// The projects to drain: explicit, the registered workspaces' projects, from fresh Node heartbeats, and remembered; all but the
/// explicit ones only when a workspace descriptor names their repo key (`devswarm_ingest.require_registered`). Newly found
/// qualifying paths are remembered in `<state dir>/devswarm_ingest.remembered`. One project per repo key.
pub fn discover(home: &Path, state_dir: &Path, explicit: &str, now: i64) -> Vec<Project> {
    discover_with(home, state_dir, explicit, now, true)
}

/// [`discover`]; `log` writes the drop lines (the read-only status verb, a separate process each time, does not).
fn discover_with(home: &Path, state_dir: &Path, explicit: &str, now: i64, log: bool) -> Vec<Project> {
    let mut paths: BTreeSet<String> = BTreeSet::new();
    let sep = defaults::text("devswarm_ingest.projects_separator");
    let explicit: BTreeSet<String> = explicit.split(sep).map(str::trim).filter(|p| !p.is_empty()).map(str::to_string).collect();
    let require = defaults::raw("devswarm_ingest.require_registered").as_bool().unwrap_or(true);
    let (registered_keys, registered_worktrees) = registered(home);
    paths.extend(registered_worktrees);
    let hb_dir = devswarm_root(home).join(defaults::text("devswarm_ingest.dir_heartbeats"));
    for e in std::fs::read_dir(&hb_dir).into_iter().flatten().flatten() {
        let name = e.file_name().to_string_lossy().into_owned();
        if !name.starts_with(defaults::text("devswarm_ingest.hb_prefix")) || !name.ends_with(defaults::text("devswarm_ingest.json_suffix")) {
            continue;
        }
        let Some(v) = read_json(&e.path()) else { continue };
        let fresh = v.get("ts").and_then(|t| t.as_i64()).is_some_and(|ts| now - ts <= defaults::num("devswarm_ingest.discover_max_age_ms") as i64);
        if let (true, Some(dir)) = (fresh, v.get("workingDir").and_then(|d| d.as_str()))
            && Path::new(dir).is_dir()
        {
            paths.insert(dir.to_string());
        }
    }
    let remembered_file = state_dir.join(defaults::text("devswarm_ingest.remembered"));
    let remembered: Vec<String> =
        read_json(&remembered_file).and_then(|v| v.as_array().map(|a| a.iter().filter_map(|x| x.as_str().map(str::to_string)).collect())).unwrap_or_default();
    let before: BTreeSet<String> = remembered.iter().cloned().collect();
    let mut seen: BTreeSet<String> = BTreeSet::new();
    let mut out = Vec::new();
    let mut found: BTreeSet<String> = BTreeSet::new();
    for p in explicit.iter().chain(paths.iter()).chain(remembered.iter()) {
        let pr = match Project::resolve_why(p) {
            Ok(pr) => pr,
            Err(why) => {
                if log {
                    note_drop(home, p, &why);
                }
                continue;
            }
        };
        if require && !explicit.contains(p) && !registered_keys.contains(&pr.repo_key) {
            if log {
                note_drop(home, p, &DropReason::new("devswarm_ingest.drop_reason_unregistered", pr.repo_key));
            }
            continue;
        }
        if log {
            note_kept(p);
        }
        if !before.contains(p) {
            found.insert(p.clone());
        }
        if seen.insert(pr.repo_key.clone()) {
            out.push(pr);
        }
    }
    let now_set: BTreeSet<String> = before.union(&found).cloned().collect();
    if now_set != before {
        crate::discard::harmless(std::fs::create_dir_all(state_dir)); // keep: remembering is an optimisation
        crate::discard::harmless(crate::atomic::write(&remembered_file, json!(now_set.into_iter().collect::<Vec<_>>()).to_string())); // keep: same
    }
    out
}

/// Write the ownership marker the Node ingest installers read (`devswarm/<devswarm_ingest.owner_file>`): `owner` is the mode word,
/// `validForMs` how long it holds after `ts` (`devswarm_ingest.owner_valid_ms`). Best effort: a marker that cannot be written leaves
/// Node's own health gates in charge, as before.
pub fn write_owner(home: &Path, who: Owner, now: i64) {
    let words = defaults::list("devswarm_ingest.mode_words");
    let word = if who == Owner::Engine { words.get(1) } else { words.first() };
    let body = json!({
        "owner": word,
        "pid": std::process::id(),
        "ts": now,
        "validForMs": defaults::num("devswarm_ingest.owner_valid_ms"),
    });
    let path = devswarm_root(home).join(defaults::text("devswarm_ingest.owner_file"));
    if let Some(dir) = path.parent() {
        crate::discard::harmless(std::fs::create_dir_all(dir)); // keep: the write below reports its own failure
    }
    crate::discard::logged("ingest_owner_marker", crate::atomic::write(&path, body.to_string()));
}

fn active_repo_keys(home: &Path, explicit: &str, now: i64) -> BTreeSet<String> {
    let mut paths: BTreeSet<String> = BTreeSet::new();
    let sep = defaults::text("devswarm_ingest.projects_separator");
    paths.extend(explicit.split(sep).map(str::trim).filter(|p| !p.is_empty()).map(str::to_string));
    let hb_dir = devswarm_root(home).join(defaults::text("devswarm_ingest.dir_heartbeats"));
    for e in std::fs::read_dir(&hb_dir).into_iter().flatten().flatten() {
        let name = e.file_name().to_string_lossy().into_owned();
        if !name.starts_with(defaults::text("devswarm_ingest.hb_prefix")) || !name.ends_with(defaults::text("devswarm_ingest.json_suffix")) {
            continue;
        }
        let Some(v) = read_json(&e.path()) else { continue };
        let fresh = v.get("ts").and_then(|t| t.as_i64()).is_some_and(|ts| now - ts <= defaults::num("devswarm_ingest.discover_max_age_ms") as i64);
        if let (true, Some(dir)) = (fresh, v.get("workingDir").and_then(|d| d.as_str()))
            && Path::new(dir).is_dir()
        {
            paths.insert(dir.to_string());
        }
    }
    paths.into_iter().filter_map(|p| Project::resolve(&p).map(|pr| pr.repo_key)).collect()
}

struct Assignment {
    stop: Arc<AtomicBool>,
    /// Set by the drain while it holds the project's lock (it waits for a Node holder with this off).
    draining: Arc<AtomicBool>,
    last_seen_ms: i64,
}

#[derive(Clone)]
struct WorkerSlot {
    repo_key: String,
    stop: Arc<AtomicBool>,
    last_seen_ms: i64,
}

#[derive(Default)]
struct Ledger {
    slots: std::sync::Mutex<Vec<WorkerSlot>>,
}

impl Ledger {
    fn sync(&self, running: &HashMap<String, Assignment>) {
        let mut slots: Vec<WorkerSlot> =
            running.iter().map(|(repo_key, w)| WorkerSlot { repo_key: repo_key.clone(), stop: w.stop.clone(), last_seen_ms: w.last_seen_ms }).collect();
        slots.sort_by(|a, b| a.last_seen_ms.cmp(&b.last_seen_ms).then_with(|| a.repo_key.cmp(&b.repo_key)));
        *self.slots.lock().unwrap_or_else(std::sync::PoisonError::into_inner) = slots;
    }

    fn estimated_bytes(slots: &[WorkerSlot]) -> usize {
        std::mem::size_of::<Ledger>() + slots.iter().map(|s| std::mem::size_of::<WorkerSlot>() + s.repo_key.len()).sum::<usize>()
    }
}

impl MemOwner for Ledger {
    fn bytes(&self) -> usize {
        let slots = self.slots.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        Self::estimated_bytes(&slots)
    }

    fn shrink(&self, target: usize) {
        let mut slots = self.slots.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        while Self::estimated_bytes(&slots) > target {
            let Some(s) = slots.first() else { break };
            s.stop.store(true, Ordering::Relaxed);
            slots.remove(0);
        }
    }

    fn recycle(&self) {
        let mut slots = self.slots.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        for s in &*slots {
            s.stop.store(true, Ordering::Relaxed);
        }
        slots.clear();
    }
}

struct PoolWorker {
    handle: std::thread::JoinHandle<()>,
    stop: Arc<AtomicBool>,
}

/// What a worker runs for one job: the drain loop of its project until the stop test turns true. The flag is on while the drain
/// holds the project's lock.
type DrainFn = Arc<dyn Fn(&Path, &Settings, Project, &dyn Fn() -> bool, &AtomicBool) + Send + Sync>;

struct Job {
    project: Project,
    st: Settings,
    stop: Arc<AtomicBool>,
    draining: Arc<AtomicBool>,
    run: DrainFn,
}

enum Msg {
    Run(Job),
    Stop,
}

fn spawn_pool_worker(home: PathBuf, stop: Arc<dyn Fn() -> bool + Send + Sync>, rx: Arc<Mutex<mpsc::Receiver<Msg>>>, done: mpsc::Sender<String>) -> PoolWorker {
    let worker_stop = Arc::new(AtomicBool::new(false));
    let worker_stop2 = worker_stop.clone();
    // An idle worker blocks on the queue: a job, a `Stop` or the queue closing wakes it. A `Stop` goes to whichever idle worker takes it, so
    // the worker told to retire may only learn it from its own flag at the end of the wait: that wait is `worker_idle_wait_ms`, not the
    // 200 ms of the stop-side joins (five wake-ups a second per worker was a steady cost of an idle daemon).
    let spawned = std::thread::Builder::new().name(defaults::text("devswarm_ingest.worker_thread_name").to_string()).spawn(move || {
        while !stop() && !worker_stop2.load(Ordering::Relaxed) {
            let msg = {
                let rx = rx.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
                rx.recv_timeout(std::time::Duration::from_millis(defaults::num("devswarm_ingest.worker_idle_wait_ms").max(1)))
            };
            match msg {
                Ok(Msg::Run(job)) => {
                    let key = job.project.repo_key.clone();
                    // The worker's own flag too: a lowered cap retires this worker while its job runs.
                    let should_stop = || stop() || worker_stop2.load(Ordering::Relaxed) || job.stop.load(Ordering::Relaxed);
                    let _boundary = crate::crash::enter("thread", "", "", "", "devswarm_ingest_project");
                    (job.run)(&home, &job.st, job.project, &should_stop, &job.draining);
                    let _sent = done.send(key); // keep: the manager may already be stopping
                }
                Ok(Msg::Stop) => {
                    if stop() || worker_stop2.load(Ordering::Relaxed) {
                        break;
                    }
                }
                Err(mpsc::RecvTimeoutError::Disconnected) => break,
                Err(mpsc::RecvTimeoutError::Timeout) => {}
            }
        }
    });
    let handle = spawned.unwrap_or_else(|e| {
        // a thread the system will not start does the job's work never: the manager sees it finished and counts a panic
        crate::discard::note("ingest_worker_spawn", &e.to_string());
        std::thread::spawn(|| {})
    });
    PoolWorker { handle, stop: worker_stop }
}

fn reconcile_worker_count(
    workers: &mut Vec<PoolWorker>,
    max_worker_threads: usize,
    home: &Path,
    stop: Arc<dyn Fn() -> bool + Send + Sync>,
    rx: &Arc<Mutex<mpsc::Receiver<Msg>>>,
    tx: &mpsc::Sender<Msg>,
    done: &mpsc::Sender<String>,
) -> usize {
    join_finished_workers(workers);
    let excess = workers.len().saturating_sub(max_worker_threads);
    let mut signaled = 0usize;
    for w in workers.iter().rev().take(excess) {
        w.stop.store(true, Ordering::Relaxed);
        if tx.send(Msg::Stop).is_ok() {
            signaled += 1;
        }
    }
    while workers.len() < max_worker_threads {
        workers.push(spawn_pool_worker(home.to_path_buf(), stop.clone(), rx.clone(), done.clone()));
    }
    signaled
}

/// Join the workers that already ended, counting consecutive panics (an orderly end resets the count). True when the count passed
/// `daemon.thread_restart_max`: the manager then asks the daemon for a clean restart instead of respawning forever.
fn note_worker_panics(workers: &mut Vec<PoolWorker>, panics: &mut u64) -> bool {
    let mut i = 0;
    while i < workers.len() {
        if workers.get(i).is_some_and(|w| !w.handle.is_finished()) {
            i += 1;
            continue;
        }
        match workers.remove(i).handle.join() {
            Ok(()) => *panics = 0,
            Err(_) => {
                crate::discard::note("ingest_worker_join", "panic");
                *panics += 1;
                let max = defaults::num("daemon.thread_restart_max");
                let msg = defaults::render("msg.thread_panic", &[("thread", &"devswarm_ingest_project"), ("n", &*panics), ("max", &max)]);
                crate::health::log_event("thread_panic", "devswarm_ingest_project", &msg);
            }
        }
    }
    *panics > defaults::num("daemon.thread_restart_max")
}

fn join_finished_workers(workers: &mut Vec<PoolWorker>) {
    let mut i = 0;
    while i < workers.len() {
        if workers.get(i).is_some_and(|w| w.handle.is_finished()) {
            let w = workers.remove(i);
            crate::discard::logged("ingest_worker_join", w.handle.join().map_err(|_| "panic"));
        } else {
            i += 1;
        }
    }
}

/// Retire workers above the cap: signal each, then wait at most `devswarm_ingest.shutdown_wait_ms` for it to finish its iteration.
/// One still running then moves to `retiring` (its flag stays set; the manager joins it once it ends) so the manager never hangs.
fn enforce_worker_cap_drop(workers: &mut Vec<PoolWorker>, max_worker_threads: usize, tx: &mpsc::Sender<Msg>, retiring: &mut Vec<PoolWorker>) -> usize {
    let mut signaled = 0usize;
    while workers.len() > max_worker_threads {
        let Some(w) = workers.pop() else { break };
        w.stop.store(true, Ordering::Relaxed);
        if tx.send(Msg::Stop).is_ok() {
            signaled += 1;
        }
        if wait_finished(&w.handle, defaults::millis("devswarm_ingest.shutdown_wait_ms")) {
            crate::discard::logged("ingest_worker_join", w.handle.join().map_err(|_| "panic"));
        } else {
            crate::discard::note("ingest_worker_join", "running");
            retiring.push(w);
        }
        join_finished_workers(workers);
    }
    signaled
}

/// Wait at most `limit` for a thread to end, polling every `devswarm_ingest.stop_poll_ms`. True when it ended.
fn wait_finished(handle: &std::thread::JoinHandle<()>, limit: std::time::Duration) -> bool {
    let poll = std::time::Duration::from_millis(defaults::num("devswarm_ingest.stop_poll_ms").max(1));
    let start = std::time::Instant::now();
    while !handle.is_finished() {
        let elapsed = start.elapsed();
        if elapsed >= limit {
            return false;
        }
        std::thread::sleep(poll.min(limit - elapsed));
    }
    true
}

fn worker_threads_for_cap(max_threads: usize) -> usize {
    max_threads.saturating_sub(1)
}

fn startable_projects(projects: &[Project], running: &HashMap<String, Assignment>, max_threads: usize) -> Vec<Project> {
    let mut left = max_threads.saturating_sub(live_count(running));
    let mut out = Vec::new();
    for p in projects {
        if left == 0 {
            break;
        }
        if running.contains_key(&p.repo_key) {
            continue;
        }
        out.push(p.clone());
        left -= 1;
    }
    out
}

fn rotated_projects(projects: &[Project], cursor: usize) -> Vec<Project> {
    if projects.is_empty() {
        return Vec::new();
    }
    let start = cursor % projects.len();
    let (head, tail) = projects.split_at(start);
    tail.iter().chain(head).cloned().collect()
}

fn desired_project_keys(projects: &[Project], max_threads: usize, cursor: usize) -> BTreeSet<String> {
    rotated_projects(projects, cursor).into_iter().take(max_threads).map(|p| p.repo_key).collect()
}

/// Ask the job of `key` to stop. A drain that holds its lock is logged with `why`; a job that only waits for a Node holder is not
/// a drain, and its stop is not logged.
fn request_stop(home: &Path, key: &str, w: &Assignment, why: &str) {
    if w.stop.swap(true, Ordering::Relaxed) {
        return;
    }
    if w.draining.load(Ordering::Relaxed) {
        drain::log_line(home, &defaults::render("devswarm_ingest.msg_stop_requested", &[("key", &key), ("why", &defaults::text(why))]));
    }
}

fn stop_idle_workers(home: &Path, running: &mut HashMap<String, Assignment>, active: &BTreeSet<String>, now: i64, idle_ttl: i64) {
    for key in active {
        if let Some(w) = running.get_mut(key) {
            w.last_seen_ms = now;
        }
    }
    for (key, w) in running.iter() {
        if !active.contains(key) && now.saturating_sub(w.last_seen_ms) >= idle_ttl {
            request_stop(home, key, w, "devswarm_ingest.reason_idle");
        }
    }
}

/// With more projects than slots, free the slots of jobs outside this tick's window that only WAIT for a Node holder, so every
/// project gets a turn at the lock. A drain that holds its lock is never stopped here: stopping it would leave its project
/// undrained until its next turn (addendum P: a drain taken over from Node stopped one tick later and stayed down for minutes).
fn stop_workers_outside_cap(running: &HashMap<String, Assignment>, desired: &BTreeSet<String>, project_count: usize, max_threads: usize) {
    if project_count <= max_threads {
        return;
    }
    for (key, w) in running {
        if !desired.contains(key) && !w.draining.load(Ordering::Relaxed) {
            w.stop.store(true, Ordering::Relaxed);
        }
    }
}

/// The jobs not yet asked to stop (a stopped job still holds its worker until it returns, which the pool's queue absorbs).
fn live_count(running: &HashMap<String, Assignment>) -> usize {
    running.values().filter(|w| !w.stop.load(Ordering::Relaxed)).count()
}

/// A sleep that wakes at once when `stop` turns true, and re-stamps the lock and heartbeat while it waits. False: the lock was lost.
fn wait(d: &mut Drainer, ms: u64, stop: &dyn Fn() -> bool) -> bool {
    let poll = defaults::num("devswarm_ingest.idle_poll_ms").max(1);
    let beat_every = defaults::num("devswarm_ingest.beat_every_ms").max(poll);
    let (mut left, mut since) = (ms, 0u64);
    while left > 0 && !stop() {
        let nap = left.min(poll);
        std::thread::sleep(std::time::Duration::from_millis(nap));
        left -= nap;
        since += nap;
        if since >= beat_every {
            since = 0;
            if !d.beat() {
                return false;
            }
        }
    }
    true
}

/// The drain loop of one project, until `stop`. Lock refused: wait and try again (a Node consumer holds it). Lock lost: start over.
pub fn run_project(home: &Path, st: &Settings, project: Project, runner: &dyn Runner, stop: &dyn Fn() -> bool, draining: &AtomicBool) {
    let mut d = Drainer::new(home, st, project);
    while !stop() {
        match d.start(runner) {
            Start::Refused(_) => {
                let mut left = defaults::num("devswarm_ingest.lock_retry_ms");
                while left > 0 && !stop() {
                    let nap = left.min(defaults::num("devswarm_ingest.idle_poll_ms").max(1));
                    std::thread::sleep(std::time::Duration::from_millis(nap));
                    left -= nap;
                }
                continue;
            }
            Start::Started => {}
        }
        draining.store(true, Ordering::Relaxed);
        d.write_heartbeat();
        let mut why = "devswarm_ingest.reason_stop_requested";
        while !stop() {
            let step = d.step(runner);
            if step.stop {
                why = "devswarm_ingest.reason_lock_lost";
                break;
            }
            if !wait(&mut d, step.wait_ms, stop) {
                why = "devswarm_ingest.reason_lock_lost";
                break;
            }
        }
        d.stop();
        draining.store(false, Ordering::Relaxed);
        drain::log_line(
            home,
            &defaults::render("devswarm_ingest.msg_stopped", &[("worktree", &d.project.worktree), ("why", &defaults::text(why)), ("n", &d.stats.iterations)]),
        );
    }
    d.stop();
}

/// The caps one manager tick runs under (read from the settings each tick).
#[derive(Debug, Clone, Copy)]
struct Cap {
    /// `mem.devswarm_ingest_max_threads`: the manager plus the drain workers.
    max_threads: usize,
    /// `mem.devswarm_ingest_idle_ttl_ms`.
    idle_ttl: i64,
}

/// The drain manager: the worker pool and which project each worker drains. One [`Manager::tick`] per discovery.
struct Manager {
    home: PathBuf,
    stop: Arc<dyn Fn() -> bool + Send + Sync>,
    drain: DrainFn,
    tx: mpsc::Sender<Msg>,
    rx: Arc<Mutex<mpsc::Receiver<Msg>>>,
    done_tx: mpsc::Sender<String>,
    done_rx: mpsc::Receiver<String>,
    workers: Vec<PoolWorker>,
    retiring: Vec<PoolWorker>,
    running: HashMap<String, Assignment>,
    cursor: usize,
    panics: u64,
    /// The projects last reported waiting for a slot (logged when this changes).
    short: BTreeSet<String>,
}

impl Manager {
    fn new(home: &Path, stop: Arc<dyn Fn() -> bool + Send + Sync>, drain: DrainFn) -> Manager {
        let (tx, rx) = mpsc::channel();
        let (done_tx, done_rx) = mpsc::channel();
        Manager {
            home: home.to_path_buf(),
            stop,
            drain,
            tx,
            rx: Arc::new(Mutex::new(rx)),
            done_tx,
            done_rx,
            workers: Vec::new(),
            retiring: Vec::new(),
            running: HashMap::new(),
            cursor: 0,
            panics: 0,
            short: BTreeSet::new(),
        }
    }

    /// One pass: collect ended jobs, stop idle and out-of-window drains, size the pool, hand out the projects. True: the
    /// workers panicked too often and the daemon must restart.
    fn tick(&mut self, projects: &[Project], active: &BTreeSet<String>, st: &Settings, now: i64, cap: Cap) -> bool {
        for key in self.done_rx.try_iter() {
            self.running.remove(&key);
        }
        if note_worker_panics(&mut self.workers, &mut self.panics) {
            return true;
        }
        stop_idle_workers(&self.home, &mut self.running, active, now, cap.idle_ttl);
        let max_worker_threads = worker_threads_for_cap(cap.max_threads);
        let ordered = rotated_projects(projects, self.cursor);
        let desired = desired_project_keys(projects, max_worker_threads, self.cursor);
        stop_workers_outside_cap(&self.running, &desired, projects.len(), max_worker_threads);
        if live_count(&self.running) > max_worker_threads {
            for (key, w) in &self.running {
                request_stop(&self.home, key, w, "devswarm_ingest.reason_over_cap");
            }
        }
        join_finished_workers(&mut self.retiring);
        let _joined = enforce_worker_cap_drop(&mut self.workers, max_worker_threads, &self.tx, &mut self.retiring);
        let _signaled = reconcile_worker_count(&mut self.workers, max_worker_threads, &self.home, self.stop.clone(), &self.rx, &self.tx, &self.done_tx);
        for p in startable_projects(&ordered, &self.running, max_worker_threads) {
            let key = p.repo_key.clone();
            let (local_stop, draining) = (Arc::new(AtomicBool::new(false)), Arc::new(AtomicBool::new(false)));
            let job = Job { project: p, st: st.clone(), stop: local_stop.clone(), draining: draining.clone(), run: self.drain.clone() };
            if self.tx.send(Msg::Run(job)).is_ok() {
                self.running.insert(key, Assignment { stop: local_stop, draining, last_seen_ms: now });
            }
        }
        if !projects.is_empty() && max_worker_threads > 0 {
            self.cursor = (self.cursor + max_worker_threads) % projects.len();
        }
        self.note_short(projects, max_worker_threads);
        false
    }

    /// Log (once per change) the projects no other consumer holds that get no drain because every slot is draining.
    fn note_short(&mut self, projects: &[Project], max_worker_threads: usize) {
        let live: Vec<&Assignment> = self.running.values().filter(|w| !w.stop.load(Ordering::Relaxed)).collect();
        let full = live.len() >= max_worker_threads && live.iter().all(|w| w.draining.load(Ordering::Relaxed));
        let short: BTreeSet<String> = if full {
            projects
                .iter()
                .filter(|p| !self.running.contains_key(&p.repo_key))
                .filter(|p| !nodelock::held_respecting_live(&drain::lock_path_of(&self.home, &p.repo_key).to_string_lossy(), drain::lock_params()))
                .map(|p| p.repo_key.clone())
                .collect()
        } else {
            BTreeSet::new()
        };
        if short != self.short && !short.is_empty() {
            let names = short.iter().cloned().collect::<Vec<_>>().join(", ");
            drain::log_line(
                &self.home,
                &defaults::render("devswarm_ingest.msg_slots_short", &[("n", &short.len()), ("slots", &max_worker_threads), ("projects", &names)]),
            );
        }
        self.short = short;
    }

    /// Stop every drain and join every worker.
    fn shutdown(self) {
        for (key, w) in &self.running {
            request_stop(&self.home, key, w, "devswarm_ingest.reason_shutdown");
        }
        for w in &self.workers {
            w.stop.store(true, Ordering::Relaxed);
            let _sent = self.tx.send(Msg::Stop); // keep: workers also see the global stop
        }
        for w in self.workers.into_iter().chain(self.retiring) {
            crate::discard::logged("ingest_worker_join", w.handle.join().map_err(|_| "panic"));
        }
    }
}

static MANAGER: std::sync::Mutex<Option<std::thread::JoinHandle<()>>> = std::sync::Mutex::new(None);

/// Wait (at most `devswarm_ingest.shutdown_wait_ms`) for the drain threads to finish their iteration. The daemon calls this on its
/// way out: a monitor call in flight has already taken its messages off the native queue, so the process must not exit before they
/// are in the WAL and the store. True when nothing was left running.
pub fn join_all() -> bool {
    let handle = MANAGER.lock().ok().and_then(|mut m| m.take());
    let Some(h) = handle else { return true };
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        crate::discard::logged("ingest_manager_join", h.join().map_err(|_| "panic"));
        let _sent = tx.send(()); // keep: the receiver is gone only after its own timeout
    });
    rx.recv_timeout(defaults::millis("devswarm_ingest.shutdown_wait_ms")).is_ok()
}

/// Start the drain in the daemon: nothing at all unless the mode is `engine`. One manager thread re-discovers the projects and
/// keeps at most `mem.devswarm_ingest_max_threads` active drain workers; every worker ends when `stop` turns true (see
/// [`join_all`]). The manager runs supervised: a panic restarts it, and too many panics ask the daemon for a clean restart.
pub fn start(home: &Path, state_dir: &Path, stop: Arc<dyn Fn() -> bool + Send + Sync>, restart: Arc<dyn Fn(&str) + Send + Sync>) {
    if owner() != Owner::Engine {
        write_owner(home, Owner::Witness, now_ms());
        return;
    }
    write_owner(home, Owner::Engine, now_ms());
    let (home, state_dir) = (home.to_path_buf(), state_dir.to_path_buf());
    let stop_for_run = stop.clone();
    let restart_for_run = restart.clone();
    let run = Arc::new(move || {
        let ledger = Arc::new(Ledger::default());
        let owner: Arc<dyn MemOwner> = ledger.clone();
        let budget = crate::mem::global().register(
            Spec::new("devswarm_ingest", "mem.devswarm_ingest_soft_bytes", "mem.devswarm_ingest_hard_bytes", "mem.devswarm_ingest_low_water_pct"),
            Arc::downgrade(&owner),
        );
        let drain: DrainFn = Arc::new(|home, st, project, stop, draining| run_project(home, st, project, &System::configured(), stop, draining));
        let mut m = Manager::new(&home, stop_for_run.clone(), drain);
        let mut owner_written = 0i64;
        while !stop_for_run() {
            let st = Settings::from_env(&crate::reqenv::RequestEnv::capture());
            let explicit = crate::dswire::effective_text("devswarm_ingest.projects");
            let now = now_ms();
            if now - owner_written >= defaults::num("devswarm_ingest.owner_refresh_ms") as i64 {
                write_owner(&home, Owner::Engine, now);
                owner_written = now;
            }
            let active = active_repo_keys(&home, &explicit, now);
            let projects = discover(&home, &state_dir, &explicit, now);
            let cap = Cap {
                max_threads: defaults::num("mem.devswarm_ingest_max_threads") as usize,
                idle_ttl: defaults::num("mem.devswarm_ingest_idle_ttl_ms") as i64,
            };
            if m.tick(&projects, &active, &st, now, cap) {
                restart_for_run("devswarm_ingest_project");
                return;
            }
            ledger.sync(&m.running);
            budget.observe();
            let mut left = defaults::num("devswarm_ingest.discover_ms");
            while left > 0 && !stop_for_run() {
                let nap = left.min(defaults::num("devswarm_ingest.idle_poll_ms").max(1));
                std::thread::sleep(std::time::Duration::from_millis(nap));
                left -= nap;
            }
        }
        m.shutdown();
    });
    let handle = crate::crash::spawn_supervised("devswarm_ingest", stop, restart, run);
    if let Ok(mut m) = MANAGER.lock() {
        *m = handle;
    }
}

/// The status of the drain, for `ah-engine devswarm ingest`: the owner, the discovered projects and the state of each lock and
/// heartbeat, read-only.
pub fn status(home: &Path, state_dir: &Path, now: i64) -> Value {
    let explicit = crate::dswire::effective_text("devswarm_ingest.projects");
    let words = defaults::list("devswarm_ingest.mode_words");
    let projects: Vec<Value> = discover_readonly(home, state_dir, &explicit, now)
        .iter()
        .map(|p| {
            let d = Drainer::new(home, &Settings::from_env(&crate::reqenv::RequestEnv::capture()), p.clone());
            let lock = std::fs::read_to_string(d.lock_path()).ok().and_then(|t| serde_json::from_str::<Value>(&t).ok());
            let hb = read_json(&devswarm_root(home).join(defaults::text("devswarm_ingest.dir_heartbeats")).join(format!(
                "{}{}{}",
                defaults::text("devswarm_ingest.hb_prefix"),
                p.repo_key,
                defaults::text("devswarm_ingest.json_suffix")
            )));
            json!({"worktree": p.worktree, "repoKey": p.repo_key, "workspaceId": p.workspace_id, "lock": lock, "heartbeat": hb})
        })
        .collect();
    json!({"mode": if owner() == Owner::Engine { words.get(1) } else { words.first() }, "projects": projects})
}

/// [`discover`] without remembering anything (the status verb writes nothing).
fn discover_readonly(home: &Path, state_dir: &Path, explicit: &str, now: i64) -> Vec<Project> {
    let scratch: PathBuf = std::env::temp_dir().join(format!("{}{}", defaults::text("devswarm_ingest.status_scratch"), std::process::id()));
    let remembered = state_dir.join(defaults::text("devswarm_ingest.remembered"));
    crate::discard::harmless(std::fs::create_dir_all(&scratch)); // keep: our own scratch
    if let Ok(t) = std::fs::read(&remembered) {
        crate::discard::harmless(crate::atomic::write(scratch.join(defaults::text("devswarm_ingest.remembered")), t)); // keep: a read-only copy
    }
    let out = discover_with(home, &scratch, explicit, now, false);
    crate::discard::harmless(std::fs::remove_dir_all(&scratch)); // keep: our own scratch
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn project(key: &str) -> Project {
        Project { worktree: format!("/tmp/{key}"), repo_key: key.to_string(), workspace_id: format!("primary-{key}") }
    }

    fn worker() -> Assignment {
        Assignment { stop: Arc::new(AtomicBool::new(false)), draining: Arc::new(AtomicBool::new(false)), last_seen_ms: 10 }
    }

    /// A stand-in drain: a project in `lockable` holds its lock and counts drain cycles; any other waits as for a live Node holder
    /// (the refusal loop of [`run_project`]). A count in `end_after` ends that project's drain once, after that many cycles.
    #[derive(Default)]
    struct Fake {
        lockable: Mutex<BTreeSet<String>>,
        starts: Mutex<HashMap<String, u32>>,
        cycles: Mutex<HashMap<String, u64>>,
        end_after: Mutex<HashMap<String, u64>>,
    }

    impl Fake {
        fn starts(&self, k: &str) -> u32 {
            self.starts.lock().unwrap().get(k).copied().unwrap_or(0)
        }
        fn cycles(&self, k: &str) -> u64 {
            self.cycles.lock().unwrap().get(k).copied().unwrap_or(0)
        }
    }

    fn fake_drain(f: Arc<Fake>) -> DrainFn {
        Arc::new(move |_, _, p, should_stop, draining| {
            let key = p.repo_key;
            *f.starts.lock().unwrap().entry(key.clone()).or_default() += 1;
            while !should_stop() {
                if f.lockable.lock().unwrap().contains(&key) {
                    draining.store(true, Ordering::Relaxed);
                    let n = {
                        let mut c = f.cycles.lock().unwrap();
                        let e = c.entry(key.clone()).or_default();
                        *e += 1;
                        *e
                    };
                    let mut ends = f.end_after.lock().unwrap();
                    if ends.get(&key) == Some(&n) {
                        ends.remove(&key);
                        break;
                    }
                }
                std::thread::sleep(std::time::Duration::from_millis(2));
            }
            draining.store(false, Ordering::Relaxed);
        })
    }

    /// A manager over seven projects (`p0`..`p6`, all active) with `lockable` free of any Node holder, ticked `ticks` times; `between`
    /// runs after each tick with its number.
    fn run_manager(home: &Path, f: &Arc<Fake>, max_threads: usize, ticks: usize, mut between: impl FnMut(usize)) {
        let projects: Vec<Project> = (0..7).map(|i| project(&format!("p{i}"))).collect();
        let active: BTreeSet<String> = projects.iter().map(|p| p.repo_key.clone()).collect();
        let st = Settings::from_env(&crate::reqenv::RequestEnv::capture());
        let mut m = Manager::new(home, Arc::new(|| false), fake_drain(f.clone()));
        for t in 0..ticks {
            assert!(!m.tick(&projects, &active, &st, 1_000 + t as i64, Cap { max_threads, idle_ttl: i64::MAX / 2 }));
            std::thread::sleep(std::time::Duration::from_millis(60));
            between(t);
        }
        m.shutdown();
    }

    fn scratch_home(tag: &str) -> crate::db::TempDir {
        defaults::init().unwrap();
        crate::db::TempDir::new(tag)
    }

    #[test]
    fn a_draining_project_is_never_preempted_while_node_holders_fill_the_other_projects() {
        // the live shape of addendum P: seven projects, five held by live Node daemons, three drain slots
        let home = scratch_home("ingest-mgr-keep");
        let f = Arc::new(Fake::default());
        f.lockable.lock().unwrap().extend(["p0".to_string(), "p1".to_string()]);
        let mut mid = (0, 0);
        run_manager(&home.0, &f, 4, 14, |t| {
            if t == 6 {
                mid = (f.cycles("p0"), f.cycles("p1"));
            }
        });
        assert_eq!((f.starts("p0"), f.starts("p1")), (1, 1), "each free project was started once and never stopped");
        assert!(f.cycles("p0") > mid.0 && f.cycles("p1") > mid.1, "both kept draining in the second half: {mid:?}");
    }

    #[test]
    fn a_drain_that_ends_is_rearmed_on_the_next_tick() {
        let home = scratch_home("ingest-mgr-rearm");
        let f = Arc::new(Fake::default());
        f.lockable.lock().unwrap().insert("p0".to_string());
        f.end_after.lock().unwrap().insert("p0".to_string(), 3); // the drain ends (a lost lock) after three cycles
        let mut after_end = 0;
        run_manager(&home.0, &f, 4, 10, |t| {
            if t == 4 {
                after_end = f.cycles("p0");
            }
        });
        assert_eq!(f.starts("p0"), 2, "started, ended once, started again");
        assert!(f.cycles("p0") > after_end && after_end > 3, "it drains again after the re-arm");
    }

    #[test]
    fn a_project_whose_node_holder_goes_away_is_taken_over_and_kept() {
        let home = scratch_home("ingest-mgr-handover");
        let f = Arc::new(Fake::default());
        f.lockable.lock().unwrap().insert("p0".to_string());
        let mut at = (0, 0);
        run_manager(&home.0, &f, 4, 24, |t| {
            if t == 3 {
                f.lockable.lock().unwrap().insert("p4".to_string()); // its Node daemon is booted out
            }
            if t == 14 {
                at = (f.starts("p4"), f.cycles("p4"));
            }
        });
        assert!(at.1 > 0, "the engine drains p4 within ten ticks of the handover");
        assert_eq!(f.starts("p4"), at.0, "and is not stopped again after that");
        assert!(f.cycles("p4") > at.1, "p4 kept draining");
        assert_eq!(f.starts("p0"), 1, "p0 was never stopped");
    }

    #[test]
    fn projects_left_without_a_drain_slot_are_logged() {
        let home = scratch_home("ingest-mgr-short");
        let f = Arc::new(Fake::default());
        f.lockable.lock().unwrap().extend(["p0", "p1", "p2"].map(str::to_string));
        run_manager(&home.0, &f, 3, 8, |_| {});
        let log = std::fs::read_to_string(home.0.join(defaults::text("devswarm_ingest.log_file"))).unwrap_or_default();
        assert!(log.contains("mem.devswarm_ingest_max_threads"), "the short slot count is named: {log}");
    }

    #[test]
    fn startable_projects_never_exceeds_thread_cap() {
        let projects = vec![project("a"), project("b"), project("c")];
        let mut running = HashMap::new();
        running.insert("a".to_string(), worker());
        let start = startable_projects(&projects, &running, 2);
        assert_eq!(start.iter().map(|p| p.repo_key.as_str()).collect::<Vec<_>>(), vec!["b"]);
    }

    #[test]
    fn rotating_window_services_projects_beyond_the_cap() {
        let projects = vec![project("a"), project("b"), project("c"), project("d")];
        let first = desired_project_keys(&projects, 2, 0);
        let second = desired_project_keys(&projects, 2, 2);
        assert_eq!(first.iter().map(String::as_str).collect::<Vec<_>>(), vec!["a", "b"]);
        assert_eq!(second.iter().map(String::as_str).collect::<Vec<_>>(), vec!["c", "d"]);
        assert_eq!(first.len(), 2);
        assert_eq!(second.len(), 2);
    }

    #[test]
    fn cap_enforcement_stops_workers_outside_the_desired_window() {
        let mut running = HashMap::new();
        running.insert("a".to_string(), worker());
        running.insert("b".to_string(), worker());
        running.insert("c".to_string(), worker());
        let desired = BTreeSet::from(["a".to_string(), "b".to_string()]);
        stop_workers_outside_cap(&running, &desired, 3, 2);
        assert!(!running["a"].stop.load(Ordering::Relaxed));
        assert!(!running["b"].stop.load(Ordering::Relaxed));
        assert!(running["c"].stop.load(Ordering::Relaxed));
    }

    #[test]
    fn worker_pool_stays_at_or_under_the_configured_cap() {
        let (tx, rx) = mpsc::channel();
        let rx = Arc::new(Mutex::new(rx));
        let (done_tx, _done_rx) = mpsc::channel();
        let stopped = Arc::new(AtomicBool::new(false));
        let stopped2 = stopped.clone();
        let stop: Arc<dyn Fn() -> bool + Send + Sync> = Arc::new(move || stopped2.load(Ordering::Relaxed));
        let mut workers = Vec::new();
        let cap = 2usize;
        let worker_cap = worker_threads_for_cap(cap);
        let _signaled = reconcile_worker_count(&mut workers, worker_cap, &std::env::temp_dir(), stop.clone(), &rx, &tx, &done_tx);
        assert!(workers.len() < cap);
        let _signaled = reconcile_worker_count(&mut workers, worker_cap, &std::env::temp_dir(), stop.clone(), &rx, &tx, &done_tx);
        assert!(workers.len() < cap);
        stopped.store(true, Ordering::Relaxed);
        for _ in 0..workers.len() {
            let _sent = tx.send(Msg::Stop);
        }
        for w in workers {
            crate::discard::harmless(w.handle.join());
        }
    }

    #[test]
    fn worker_pool_cap_drop_signals_every_excess_thread() {
        let (tx, rx) = mpsc::channel();
        let rx = Arc::new(Mutex::new(rx));
        let (done_tx, _done_rx) = mpsc::channel();
        let stopped = Arc::new(AtomicBool::new(false));
        let stopped2 = stopped.clone();
        let stop: Arc<dyn Fn() -> bool + Send + Sync> = Arc::new(move || stopped2.load(Ordering::Relaxed));
        let mut workers = Vec::new();
        let _signaled = reconcile_worker_count(&mut workers, 3, &std::env::temp_dir(), stop.clone(), &rx, &tx, &done_tx);
        let stop_msgs = reconcile_worker_count(&mut workers, 1, &std::env::temp_dir(), stop.clone(), &rx, &tx, &done_tx);
        stopped.store(true, Ordering::Relaxed);
        for w in workers {
            crate::discard::harmless(w.handle.join());
        }
        assert!(stop_msgs >= 2);
    }

    #[test]
    fn worker_pool_cap_drop_joins_to_the_lowered_cap() {
        let (tx, rx) = mpsc::channel();
        let rx = Arc::new(Mutex::new(rx));
        let (done_tx, _done_rx) = mpsc::channel();
        let stopped = Arc::new(AtomicBool::new(false));
        let stopped2 = stopped.clone();
        let stop: Arc<dyn Fn() -> bool + Send + Sync> = Arc::new(move || stopped2.load(Ordering::Relaxed));
        let mut workers = Vec::new();
        let _signaled = reconcile_worker_count(&mut workers, 3, &std::env::temp_dir(), stop.clone(), &rx, &tx, &done_tx);
        let signaled = enforce_worker_cap_drop(&mut workers, 1, &tx, &mut Vec::new());
        assert_eq!(workers.len(), 1);
        assert_eq!(signaled, 2);
        let _sent = tx.send(Msg::Stop);
        std::thread::sleep(std::time::Duration::from_millis(defaults::num("devswarm_ingest.stop_poll_ms").max(1)));
        join_finished_workers(&mut workers);
        assert_eq!(workers.len(), 1);
        assert!(!workers[0].handle.is_finished());
        stopped.store(true, Ordering::Relaxed);
        let _sent = tx.send(Msg::Stop);
        for w in workers {
            crate::discard::harmless(w.handle.join());
        }
    }

    #[test]
    fn lowering_the_cap_ends_an_active_job_on_a_removed_worker() {
        let (tx, rx) = mpsc::channel();
        let rx = Arc::new(Mutex::new(rx));
        let (done_tx, done_rx) = mpsc::channel();
        let released = Arc::new(AtomicBool::new(false)); // the global stop: only the failure path turns it on
        let released2 = released.clone();
        let stop: Arc<dyn Fn() -> bool + Send + Sync> = Arc::new(move || released2.load(Ordering::Relaxed));
        let mut workers = Vec::new();
        let _signaled = reconcile_worker_count(&mut workers, 1, &std::env::temp_dir(), stop.clone(), &rx, &tx, &done_tx);
        let (entered_tx, entered_rx) = mpsc::channel();
        let run: DrainFn = Arc::new(move |_, _, _, should_stop, _| {
            let _sent = entered_tx.send(());
            while !should_stop() {
                std::thread::yield_now();
            }
        });
        let job = Job {
            project: project("a"),
            st: Settings::from_env(&crate::reqenv::RequestEnv::capture()),
            stop: Arc::new(AtomicBool::new(false)),
            draining: Arc::new(AtomicBool::new(false)),
            run,
        };
        assert!(tx.send(Msg::Run(job)).is_ok());
        assert!(entered_rx.recv().is_ok(), "the worker is inside the active job"); // the job's own stop flag stays off
        let (joined_tx, joined_rx) = mpsc::channel();
        let dropper = std::thread::spawn(move || {
            let _signaled = enforce_worker_cap_drop(&mut workers, 0, &tx, &mut Vec::new());
            let _sent = joined_tx.send(workers.len());
        });
        let deadline = defaults::millis("devswarm_ingest.shutdown_wait_ms");
        let joined = joined_rx.recv_timeout(deadline.saturating_mul(2));
        released.store(true, Ordering::Relaxed); // free a hung worker so the test ends either way
        crate::discard::harmless(dropper.join());
        assert_eq!(joined.ok(), Some(0), "the cap drop returned with the worker removed");
        assert_eq!(done_rx.try_recv().ok().as_deref(), Some("a"), "the active job ended on the removed worker's stop flag");
    }

    #[test]
    fn the_cap_drop_wait_is_bounded() {
        let (go_tx, go_rx) = mpsc::channel::<()>();
        let h = std::thread::spawn(move || crate::discard::harmless(go_rx.recv()));
        assert!(!wait_finished(&h, std::time::Duration::ZERO), "a running thread is reported unfinished at the limit");
        assert!(go_tx.send(()).is_ok());
        assert!(wait_finished(&h, defaults::millis("devswarm_ingest.shutdown_wait_ms")), "an ended thread is reported finished");
        assert!(h.join().is_ok());
    }

    #[test]
    fn configured_total_cap_of_one_starts_no_worker_threads() {
        assert_eq!(worker_threads_for_cap(1), 0);
        let (tx, rx) = mpsc::channel();
        let rx = Arc::new(Mutex::new(rx));
        let (done_tx, _done_rx) = mpsc::channel();
        let stop: Arc<dyn Fn() -> bool + Send + Sync> = Arc::new(|| false);
        let mut workers = Vec::new();
        let _signaled = reconcile_worker_count(&mut workers, worker_threads_for_cap(1), &std::env::temp_dir(), stop, &rx, &tx, &done_tx);
        assert!(workers.is_empty());
    }

    #[test]
    fn idle_projects_are_stopped_after_the_configured_ttl() {
        let mut running = HashMap::new();
        running
            .insert("active".to_string(), Assignment { stop: Arc::new(AtomicBool::new(false)), draining: Arc::new(AtomicBool::new(false)), last_seen_ms: 5 });
        running.insert("idle".to_string(), Assignment { stop: Arc::new(AtomicBool::new(false)), draining: Arc::new(AtomicBool::new(false)), last_seen_ms: 5 });
        stop_idle_workers(&std::env::temp_dir(), &mut running, &BTreeSet::from(["active".to_string()]), 15, 10);
        assert_eq!(running["active"].last_seen_ms, 15);
        assert!(!running["active"].stop.load(Ordering::Relaxed));
        assert!(running["idle"].stop.load(Ordering::Relaxed));
    }

    #[test]
    fn ledger_shrink_stops_oldest_idle_workers() {
        let ledger = Ledger::default();
        let old = Arc::new(AtomicBool::new(false));
        let young = Arc::new(AtomicBool::new(false));
        *ledger.slots.lock().unwrap() = vec![
            WorkerSlot { repo_key: "old".into(), stop: old.clone(), last_seen_ms: 1 },
            WorkerSlot { repo_key: "young".into(), stop: young.clone(), last_seen_ms: 2 },
        ];
        ledger.shrink(0);
        assert!(old.load(Ordering::Relaxed));
        assert!(young.load(Ordering::Relaxed));
        assert_eq!(ledger.bytes(), std::mem::size_of::<Ledger>());
    }
}
