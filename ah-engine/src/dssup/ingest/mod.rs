//! The native ingest drain (lane l7b): the engine takes over what the Node ingest daemon (`companion/devswarm-ingest.js`, one
//! launchd / systemd unit per project) does, so the kit can uninstall those units.
//!
//! * [`Owner`] is the switch (`devswarm_ingest.mode`): `witness` (default) leaves the drain to the Node daemons and starts nothing;
//!   `engine` makes the daemon run one drain thread per project. While a Node daemon still holds a project's lock the engine's
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
use crate::meshw::idlock::devswarm_root;
use drain::{Drainer, Project, Start};
use serde_json::{Value, json};
use std::collections::BTreeSet;
use std::path::{Path, PathBuf};
use std::sync::Arc;

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
        let fresh = v["ts"].as_i64().is_some_and(|ts| now - ts <= defaults::num("devswarm_ingest.discover_max_age_ms") as i64);
        if let (true, Some(dir)) = (fresh, v["workingDir"].as_str())
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
        crate::discard::harmless(h.join()); // keep: a panicked drain already reported itself
        let _sent = tx.send(()); // keep: the receiver is gone only after its own timeout
    });
    rx.recv_timeout(defaults::millis("devswarm_ingest.shutdown_wait_ms")).is_ok()
}

/// Start the drain in the daemon: nothing at all unless the mode is `engine`. One manager thread re-discovers the projects and
/// keeps one drain thread per project; every thread ends when `stop` turns true (see [`join_all`]).
pub fn start(home: &Path, state_dir: &Path, stop: Arc<dyn Fn() -> bool + Send + Sync>) {
    if owner() != Owner::Engine {
        return;
    }
    let (home, state_dir) = (home.to_path_buf(), state_dir.to_path_buf());
    let handle = std::thread::spawn(move || {
        let mut running: std::collections::HashMap<String, std::thread::JoinHandle<()>> = std::collections::HashMap::new();
        while !stop() {
            running.retain(|_, h| !h.is_finished());
            let st = Settings::from_env(&crate::reqenv::RequestEnv::capture());
            let explicit = crate::dswire::effective_text("devswarm_ingest.projects");
            for p in discover(&home, &state_dir, &explicit, now_ms()) {
                if running.contains_key(&p.repo_key) {
                    continue;
                }
                let (h, st2, s2) = (home.clone(), st.clone(), stop.clone());
                let key = p.repo_key.clone();
                running.insert(key, std::thread::spawn(move || run_project(&h, &st2, p, &System::configured(), &*s2)));
            }
            let mut left = defaults::num("devswarm_ingest.discover_ms");
            while left > 0 && !stop() {
                let nap = left.min(defaults::num("devswarm_ingest.stop_poll_ms").max(1));
                std::thread::sleep(std::time::Duration::from_millis(nap));
                left -= nap;
            }
        }
        for (_, h) in running {
            crate::discard::harmless(h.join()); // keep: a panicked worker already reported itself
        }
    });
    if let Ok(mut m) = MANAGER.lock() {
        *m = Some(handle);
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
