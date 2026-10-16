//! The native ingest drain (lane l7b): the engine takes over what the Node ingest daemon (`companion/devswarm-ingest.js`, one
//! launchd / systemd unit per project) does, so the kit can uninstall those units.
//!
//! * [`Owner`] is the switch (`devswarm_ingest.mode`): `witness` (default) leaves the drain to the Node daemons and starts nothing;
//!   `engine` runs project drains through bounded worker slots. While a Node daemon still holds a project's lock the engine's
//!   drain for that project waits (the lock is the single-consumer guard: it never takes a live holder's lock) and takes over the
//!   moment the holder is gone. Nothing is ever double-drained.
//! * [`drain`] is one project's drain, [`wal`] its delivery write-ahead log (Node's format, so a WAL left open by either side is
//!   replayed by the other), [`import`] the loss-free import into the store, [`monitor`] the bounded `hivecontrol workspace
//!   monitor` call with Node's circuit breaker, and [`witness`] the non-acting Node comparison on a mirror.
//! * Which projects: the explicit `devswarm_ingest.projects` setting (paths separated by `:`), the working directories of fresh
//!   Node ingest heartbeats (so a project served today is served after the cutover), and what an earlier run remembered. A path
//!   that is not a git repository is skipped. Nothing is deleted from the remembered list.
// Discard triage (E3): every `.ok()` / `unwrap_or_default()` in this module is a deliberate keep, for these reasons:
// - a heartbeat or state file that is absent or unparsable is the absent value (discovery is additive)
pub mod drain;
pub mod import;
pub mod monitor;
pub mod wal;
pub mod witness;

use crate::checks::git::util::Settings;
use crate::defaults;
use crate::dsact::runner::{Runner, System};
use crate::mem::{Owner as MemOwner, Spec};
use crate::meshw::idlock::devswarm_root;
use drain::{Drainer, Project, Start};
use serde_json::{Value, json};
use std::collections::{BTreeSet, HashMap};
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

/// The projects to drain: explicit, from fresh Node heartbeats, and remembered. Newly found paths are remembered in
/// `<state dir>/devswarm_ingest.remembered`. One project per repo key.
pub fn discover(home: &Path, state_dir: &Path, explicit: &str, now: i64) -> Vec<Project> {
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
    let remembered_file = state_dir.join(defaults::text("devswarm_ingest.remembered"));
    let remembered: Vec<String> =
        read_json(&remembered_file).and_then(|v| v.as_array().map(|a| a.iter().filter_map(|x| x.as_str().map(str::to_string)).collect())).unwrap_or_default();
    let before: BTreeSet<String> = remembered.iter().cloned().collect();
    let mut seen: BTreeSet<String> = BTreeSet::new();
    let mut out = Vec::new();
    for p in paths.iter().chain(remembered.iter()) {
        if let Some(pr) = Project::resolve(p)
            && seen.insert(pr.repo_key.clone())
        {
            out.push(pr);
        }
    }
    let now_set: BTreeSet<String> = before.union(&paths.iter().cloned().collect()).cloned().collect();
    if now_set != before {
        crate::discard::harmless(std::fs::create_dir_all(state_dir)); // keep: remembering is an optimisation
        crate::discard::harmless(crate::atomic::write(&remembered_file, json!(now_set.into_iter().collect::<Vec<_>>()).to_string())); // keep: same
    }
    out
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

/// What a worker runs for one job: the drain loop of its project until the stop test turns true.
type DrainFn = Arc<dyn Fn(&Path, &Settings, Project, &dyn Fn() -> bool) + Send + Sync>;

struct Job {
    project: Project,
    st: Settings,
    stop: Arc<AtomicBool>,
    run: DrainFn,
}

enum Msg {
    Run(Job),
    Stop,
}

fn spawn_pool_worker(home: PathBuf, stop: Arc<dyn Fn() -> bool + Send + Sync>, rx: Arc<Mutex<mpsc::Receiver<Msg>>>, done: mpsc::Sender<String>) -> PoolWorker {
    let worker_stop = Arc::new(AtomicBool::new(false));
    let worker_stop2 = worker_stop.clone();
    let handle = std::thread::spawn(move || {
        while !stop() && !worker_stop2.load(Ordering::Relaxed) {
            let msg = {
                let rx = rx.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
                rx.recv_timeout(std::time::Duration::from_millis(defaults::num("devswarm_ingest.stop_poll_ms").max(1)))
            };
            match msg {
                Ok(Msg::Run(job)) => {
                    let key = job.project.repo_key.clone();
                    // The worker's own flag too: a lowered cap retires this worker while its job runs.
                    let should_stop = || stop() || worker_stop2.load(Ordering::Relaxed) || job.stop.load(Ordering::Relaxed);
                    let _boundary = crate::crash::enter("thread", "", "", "", "devswarm_ingest_project");
                    (job.run)(&home, &job.st, job.project, &should_stop);
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
    let mut left = max_threads.saturating_sub(running.len());
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

fn stop_idle_workers(running: &mut HashMap<String, Assignment>, active: &BTreeSet<String>, now: i64, idle_ttl: i64) {
    for key in active {
        if let Some(w) = running.get_mut(key) {
            w.last_seen_ms = now;
        }
    }
    for (key, w) in running {
        if !active.contains(key) && now.saturating_sub(w.last_seen_ms) >= idle_ttl {
            w.stop.store(true, Ordering::Relaxed);
        }
    }
}

fn stop_workers_outside_cap(running: &HashMap<String, Assignment>, desired: &BTreeSet<String>, project_count: usize, max_threads: usize) {
    if project_count <= max_threads {
        return;
    }
    for (key, w) in running {
        if !desired.contains(key) {
            w.stop.store(true, Ordering::Relaxed);
        }
    }
}

/// A sleep that wakes at once when `stop` turns true, and re-stamps the lock and heartbeat while it waits. False: the lock was lost.
fn wait(d: &mut Drainer, ms: u64, stop: &dyn Fn() -> bool) -> bool {
    let poll = defaults::num("devswarm_ingest.stop_poll_ms").max(1);
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
pub fn run_project(home: &Path, st: &Settings, project: Project, runner: &dyn Runner, stop: &dyn Fn() -> bool) {
    let mut d = Drainer::new(home, st, project);
    while !stop() {
        match d.start(runner) {
            Start::Refused(_) => {
                let mut left = defaults::num("devswarm_ingest.lock_retry_ms");
                while left > 0 && !stop() {
                    let nap = left.min(defaults::num("devswarm_ingest.stop_poll_ms").max(1));
                    std::thread::sleep(std::time::Duration::from_millis(nap));
                    left -= nap;
                }
                continue;
            }
            Start::Started => {}
        }
        d.write_heartbeat();
        while !stop() {
            let step = d.step(runner);
            if step.stop {
                break;
            }
            d.maybe_witness(runner);
            if !wait(&mut d, step.wait_ms, stop) {
                break;
            }
        }
        d.stop();
    }
    d.stop();
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
        return;
    }
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
        let (tx, rx) = mpsc::channel();
        let rx = Arc::new(Mutex::new(rx));
        let (done_tx, done_rx) = mpsc::channel();
        let mut workers: Vec<PoolWorker> = Vec::new();
        let mut retiring: Vec<PoolWorker> = Vec::new();
        let mut running: HashMap<String, Assignment> = HashMap::new();
        let mut cursor = 0usize;
        let mut panics = 0u64;
        let drain: DrainFn = Arc::new(|home, st, project, stop| run_project(home, st, project, &System::configured(), stop));
        while !stop_for_run() {
            for key in done_rx.try_iter() {
                running.remove(&key);
            }
            if note_worker_panics(&mut workers, &mut panics) {
                restart_for_run("devswarm_ingest_project");
                return;
            }
            let st = Settings::from_env(&crate::reqenv::RequestEnv::capture());
            let explicit = crate::dswire::effective_text("devswarm_ingest.projects");
            let now = now_ms();
            let active = active_repo_keys(&home, &explicit, now);
            let idle_ttl = defaults::num("mem.devswarm_ingest_idle_ttl_ms") as i64;
            stop_idle_workers(&mut running, &active, now, idle_ttl);
            let max_threads = defaults::num("mem.devswarm_ingest_max_threads") as usize;
            let max_worker_threads = worker_threads_for_cap(max_threads);
            let projects = discover(&home, &state_dir, &explicit, now);
            let ordered = rotated_projects(&projects, cursor);
            let desired = desired_project_keys(&projects, max_worker_threads, cursor);
            stop_workers_outside_cap(&running, &desired, projects.len(), max_worker_threads);
            if running.len() > max_worker_threads {
                for w in running.values() {
                    w.stop.store(true, Ordering::Relaxed);
                }
            }
            join_finished_workers(&mut retiring);
            let _joined = enforce_worker_cap_drop(&mut workers, max_worker_threads, &tx, &mut retiring);
            let _signaled = reconcile_worker_count(&mut workers, max_worker_threads, &home, stop_for_run.clone(), &rx, &tx, &done_tx);
            for p in startable_projects(&ordered, &running, max_worker_threads) {
                let key = p.repo_key.clone();
                let local_stop = Arc::new(AtomicBool::new(false));
                if tx.send(Msg::Run(Job { project: p, st: st.clone(), stop: local_stop.clone(), run: drain.clone() })).is_ok() {
                    running.insert(key, Assignment { stop: local_stop, last_seen_ms: now });
                }
            }
            if !projects.is_empty() && max_worker_threads > 0 {
                cursor = (cursor + max_worker_threads) % projects.len();
            }
            ledger.sync(&running);
            budget.observe();
            let mut left = defaults::num("devswarm_ingest.discover_ms");
            while left > 0 && !stop_for_run() {
                let nap = left.min(defaults::num("devswarm_ingest.stop_poll_ms").max(1));
                std::thread::sleep(std::time::Duration::from_millis(nap));
                left -= nap;
            }
        }
        for w in running.values() {
            w.stop.store(true, Ordering::Relaxed);
        }
        for w in &workers {
            w.stop.store(true, Ordering::Relaxed);
            let _sent = tx.send(Msg::Stop); // keep: workers also see the global stop
        }
        for w in workers.into_iter().chain(retiring) {
            crate::discard::logged("ingest_worker_join", w.handle.join().map_err(|_| "panic"));
        }
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
    let out = discover(home, &scratch, explicit, now);
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
        Assignment { stop: Arc::new(AtomicBool::new(false)), last_seen_ms: 10 }
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
        let run: DrainFn = Arc::new(move |_, _, _, should_stop| {
            let _sent = entered_tx.send(());
            while !should_stop() {
                std::thread::yield_now();
            }
        });
        let job = Job { project: project("a"), st: Settings::from_env(&crate::reqenv::RequestEnv::capture()), stop: Arc::new(AtomicBool::new(false)), run };
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
        running.insert("active".to_string(), Assignment { stop: Arc::new(AtomicBool::new(false)), last_seen_ms: 5 });
        running.insert("idle".to_string(), Assignment { stop: Arc::new(AtomicBool::new(false)), last_seen_ms: 5 });
        stop_idle_workers(&mut running, &BTreeSet::from(["active".to_string()]), 15, 10);
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
