//! A generic, bounded file-change watcher (realtime lane R1).
//!
//! It knows directories and file names and nothing else: GitHub realtime, DevSwarm realtime and any other consumer add the
//! directories they care about and read coalesced [`Batch`]es. A batch is only a hint that something changed: the consumer
//! re-reads its source and compares a signature of its own.
//!
//! # Backends
//!
//! * **events** ([`notify`]): OS file events (FSEvents on macOS, inotify on Linux), non-recursive per directory, filtered by
//!   file name. Used by default: it measured 0.009 permille idle CPU and a 15 ms p95 detection latency on a realistic watch
//!   set, where polling that set costs 15 permille at 250 ms (4.5 at 800 ms, 746 ms p95) (numbers in DECISIONS.md).
//! * **poll** ([`poll`]): list or stat the watched names every `realtime.poll_ms` and compare (modification time, size,
//!   inode). Used where events do not arrive (9p and drvfs on WSL2, NFS, SMB, FUSE: [`fstype`] names the filesystem and
//!   `realtime.fs_poll_types` lists the ones to poll), when the OS refuses a watch (the kernel's watch limit, a directory
//!   that does not exist yet), and when `realtime.backend = poll`.
//!
//! [`Decision`] reports which backend a directory got and why.
//!
//! # Bounds
//!
//! * Changes are coalesced per file over `realtime.debounce_ms`, with a ceiling of `realtime.max_delay_ms` for a file that
//!   never stops changing.
//! * At most `realtime.queue_cap` distinct files are held. Past it everything held is dropped and ONE rescan signal is
//!   produced instead ([`Batch::rescan`]): the consumer reconciles everything, so a storm of any size costs a fixed amount.
//! * A directory with more than `realtime.max_entries` matching files reports a rescan when its listing changes.
//!
//! All numbers, names and lists are plugin settings (`engine/defaults/realtime.toml`).

pub mod fstype;
pub mod notify;
pub mod poll;

use crate::defaults;
use poll::{DirState, Filter};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex, MutexGuard};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

/// The tunables of a watcher. [`Config::load`] reads them from the shipped settings; tests build their own.
#[derive(Clone, Debug)]
pub struct Config {
    /// `auto` or `poll`; anything else is read as `auto`.
    pub backend: String,
    /// Scan interval.
    pub poll: Duration,
    /// Quiet time before a changed file is reported.
    pub debounce: Duration,
    /// Ceiling on how long a continuously changing file is held back.
    pub max_delay: Duration,
    /// Most distinct files held before a rescan signal replaces them.
    pub queue_cap: usize,
    /// Most matching files tracked per directory.
    pub max_entries: usize,
    /// Filesystem types that are always polled.
    pub fs_poll_types: Vec<String>,
    /// Side-file suffixes of a SQLite database.
    pub sqlite_suffixes: Vec<String>,
    /// Detection latency target (p95).
    pub latency_target: Duration,
    /// Idle CPU budget in thousandths of one core.
    pub cpu_budget_permille: u64,
}

impl Config {
    /// The settings as currently loaded (defaults, `settings.json` and environment layers).
    pub fn load() -> Config {
        Config {
            backend: defaults::text("realtime.backend").to_string(),
            poll: defaults::millis("realtime.poll_ms"),
            debounce: defaults::millis("realtime.debounce_ms"),
            max_delay: defaults::millis("realtime.max_delay_ms"),
            queue_cap: defaults::num("realtime.queue_cap") as usize,
            max_entries: defaults::num("realtime.max_entries") as usize,
            fs_poll_types: defaults::list("realtime.fs_poll_types").into_iter().map(String::from).collect(),
            sqlite_suffixes: defaults::list("realtime.sqlite_suffixes").into_iter().map(String::from).collect(),
            latency_target: defaults::millis("realtime.latency_target_ms"),
            cpu_budget_permille: defaults::num("realtime.cpu_budget_permille"),
        }
    }

    /// A [`Filter`] for a SQLite database name and its side files.
    pub fn sqlite_filter(&self, db: &str) -> Filter {
        let suffixes: Vec<&str> = self.sqlite_suffixes.iter().map(String::as_str).collect();
        Filter::sqlite(db, &suffixes)
    }
}

/// How a directory is observed.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Backend {
    /// OS file events.
    Events,
    /// Compare file signatures every poll interval.
    Poll,
}

/// Why a directory got its backend.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Reason {
    /// `realtime.backend = poll`.
    Forced,
    /// Its filesystem type is in `realtime.fs_poll_types` (events do not arrive there).
    FsType(String),
    /// Auto on a filesystem that delivers OS events.
    LocalFs,
    /// The OS refused the watch (the text is its error): the directory is polled instead.
    EventsFailed(String),
}

/// The backend chosen for one directory, with the filesystem type that led to it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Decision {
    /// The directory.
    pub dir: PathBuf,
    /// The filesystem type, when it could be told.
    pub fstype: Option<String>,
    /// The backend.
    pub backend: Backend,
    /// Why.
    pub reason: Reason,
}

/// Choose the backend for `dir` under `cfg`.
pub fn decide(cfg: &Config, dir: &Path) -> Decision {
    let ty = fstype::fs_type(dir);
    decide_with(cfg, dir, ty)
}

/// [`decide`] with the filesystem type supplied (fixtures for the 9p, drvfs, NFS, SMB and FUSE cases).
pub fn decide_with(cfg: &Config, dir: &Path, ty: Option<String>) -> Decision {
    let patterns: Vec<&str> = cfg.fs_poll_types.iter().map(String::as_str).collect();
    let (backend, reason) = if cfg.backend == "poll" {
        (Backend::Poll, Reason::Forced)
    } else if let Some(t) = ty.as_deref().filter(|t| fstype::matches_any(t, &patterns)) {
        (Backend::Poll, Reason::FsType(t.to_string()))
    } else {
        (Backend::Events, Reason::LocalFs)
    };
    Decision { dir: dir.to_path_buf(), fstype: ty, backend, reason }
}

/// What a consumer receives.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Batch {
    /// The watcher fell behind (queue overflow or an oversized directory): reconcile everything. `paths` is empty then.
    pub rescan: bool,
    /// Changed files, sorted.
    pub paths: Vec<PathBuf>,
}

/// Coalescing and the bounded queue, with the clock passed in so it is testable without sleeping.
#[derive(Debug)]
pub struct Coalescer {
    cap: usize,
    debounce: Duration,
    max_delay: Duration,
    pending: HashMap<PathBuf, (Instant, Instant)>,
    overflow: Option<(Instant, Instant)>,
}

impl Coalescer {
    /// An empty queue.
    pub fn new(cap: usize, debounce: Duration, max_delay: Duration) -> Coalescer {
        Coalescer { cap: cap.max(1), debounce, max_delay, pending: HashMap::new(), overflow: None }
    }

    /// Record a change of `path` seen at `now`.
    pub fn push(&mut self, path: PathBuf, now: Instant) {
        if let Some((_, last)) = self.overflow.as_mut() {
            *last = now; // already covered by the rescan that is pending
            return;
        }
        if let Some((_, last)) = self.pending.get_mut(&path) {
            *last = now;
            return;
        }
        if self.pending.len() >= self.cap {
            self.pending.clear();
            self.overflow = Some((now, now));
            return;
        }
        self.pending.insert(path, (now, now));
    }

    /// Ask for a full rescan (a directory too large to track, or a backend that lost events).
    pub fn rescan(&mut self, now: Instant) {
        self.pending.clear();
        match self.overflow.as_mut() {
            Some((_, last)) => *last = now,
            None => self.overflow = Some((now, now)),
        }
    }

    fn due(&self, first: Instant, last: Instant) -> Instant {
        (last + self.debounce).min(first + self.max_delay)
    }

    /// The batch that is ready at `now`, if any. A rescan comes alone; held files are reported once quiet or overdue.
    pub fn take_ready(&mut self, now: Instant) -> Option<Batch> {
        if let Some((first, last)) = self.overflow {
            if now >= self.due(first, last) {
                self.overflow = None;
                return Some(Batch { rescan: true, paths: Vec::new() });
            }
            return None;
        }
        let ready: Vec<PathBuf> = self.pending.iter().filter(|(_, (f, l))| now >= self.due(*f, *l)).map(|(p, _)| p.clone()).collect();
        if ready.is_empty() {
            return None;
        }
        for p in &ready {
            self.pending.remove(p);
        }
        let mut paths = ready;
        paths.sort();
        Some(Batch { rescan: false, paths })
    }

    /// When the next held item becomes ready (so a consumer can sleep exactly that long), or `None` when nothing is held.
    pub fn next_due(&self) -> Option<Instant> {
        let o = self.overflow.map(|(f, l)| self.due(f, l));
        let p = self.pending.values().map(|(f, l)| self.due(*f, *l)).min();
        match (o, p) {
            (Some(a), Some(b)) => Some(a.min(b)),
            (a, b) => a.or(b),
        }
    }

    /// Items currently held (a rescan counts as none).
    pub fn held(&self) -> usize {
        self.pending.len()
    }
}

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

/// The bounded queue both backends feed and the consumer drains.
struct Queue {
    q: Mutex<Coalescer>,
    ready: Condvar,
}

impl Queue {
    fn changed(&self, paths: Vec<PathBuf>) {
        let now = Instant::now();
        let mut q = lock(&self.q);
        for p in paths {
            q.push(p, now);
        }
        drop(q);
        self.ready.notify_all();
    }

    fn rescan(&self) {
        lock(&self.q).rescan(Instant::now());
        self.ready.notify_all();
    }
}

struct Shared {
    queue: Arc<Queue>,
    polled: Mutex<Vec<DirState>>,
    events: Mutex<Option<notify::Events>>,
    stop: AtomicBool,
    wake: Mutex<()>,
    wake_cv: Condvar,
}

/// A running watcher: any number of directories, one bounded queue, events for the directories that can have them and one
/// scan thread for the rest (idle when there are none).
pub struct Watcher {
    cfg: Config,
    shared: Arc<Shared>,
    thread: Option<JoinHandle<()>>,
}

impl Watcher {
    /// Start a watcher with no directories yet.
    pub fn start(cfg: Config) -> Watcher {
        let shared = Arc::new(Shared {
            queue: Arc::new(Queue { q: Mutex::new(Coalescer::new(cfg.queue_cap, cfg.debounce, cfg.max_delay)), ready: Condvar::new() }),
            polled: Mutex::new(Vec::new()),
            events: Mutex::new(None),
            stop: AtomicBool::new(false),
            wake: Mutex::new(()),
            wake_cv: Condvar::new(),
        });
        let (s, poll, cap) = (Arc::clone(&shared), cfg.poll, cfg.max_entries);
        let thread = std::thread::Builder::new().name("ah-watch".into()).spawn(move || scan_loop(&s, poll, cap)).ok();
        Watcher { cfg, shared, thread }
    }

    /// The tunables this watcher runs with.
    pub fn config(&self) -> &Config {
        &self.cfg
    }

    fn watch_events(&self, dir: &Path, filter: Filter) -> Result<(), String> {
        let mut slot = lock(&self.shared.events);
        if slot.is_none() {
            let queue = Arc::clone(&self.shared.queue);
            let sink: notify::Sink = Arc::new(move |sig| match sig {
                notify::Signal::Changed(paths) => queue.changed(paths),
                notify::Signal::Rescan => queue.rescan(),
            });
            *slot = Some(notify::Events::new(sink)?);
        }
        match slot.as_mut() {
            Some(ev) => ev.watch(dir, filter),
            None => Err(String::new()),
        }
    }

    /// Watch `dir` (non-recursive) for the names `filter` selects. Only later changes are reported (a consumer reconciles
    /// its source once at start). Returns the backend decision for the directory.
    pub fn add(&self, dir: &Path, filter: Filter) -> Decision {
        let mut decision = decide(&self.cfg, dir);
        if decision.backend == Backend::Events
            && let Err(e) = self.watch_events(dir, filter.clone())
        {
            decision.backend = Backend::Poll;
            decision.reason = Reason::EventsFailed(e);
        }
        if decision.backend == Backend::Poll {
            let state = DirState::new(dir, filter, self.cfg.max_entries);
            lock(&self.shared.polled).push(state);
            self.wake();
        }
        decision
    }

    /// Stop watching `dir`.
    pub fn remove(&self, dir: &Path) {
        lock(&self.shared.polled).retain(|d| d.dir() != dir);
        if let Some(ev) = lock(&self.shared.events).as_mut() {
            ev.unwatch(dir);
        }
    }

    fn wake(&self) {
        let _gate = lock(&self.shared.wake); // taken so the scan thread is either waiting (and woken) or has not yet checked
        self.shared.wake_cv.notify_all();
    }

    /// Wait up to `timeout` for the next batch.
    pub fn next(&self, timeout: Duration) -> Option<Batch> {
        let deadline = Instant::now() + timeout;
        let queue = &self.shared.queue;
        let mut q = lock(&queue.q);
        loop {
            let now = Instant::now();
            if let Some(b) = q.take_ready(now) {
                return Some(b);
            }
            if now >= deadline {
                return None;
            }
            let until = q.next_due().map_or(deadline, |d| d.min(deadline));
            let wait = until.saturating_duration_since(now);
            q = queue.ready.wait_timeout(q, wait).unwrap_or_else(|e| e.into_inner()).0;
        }
    }

    /// Ask for a full reconcile (the consumer started, or lost track of its source).
    pub fn request_rescan(&self) {
        self.shared.queue.rescan();
    }
}

impl Drop for Watcher {
    fn drop(&mut self) {
        self.shared.stop.store(true, Ordering::SeqCst);
        drop(lock(&self.shared.events).take()); // ends the OS watches and the callback's hold on the queue
        self.wake();
        if let Some(t) = self.thread.take() {
            crate::discard::harmless(t.join().map_err(|_| ())); // keep: a scan thread that panicked has nothing left to report
        }
    }
}

fn scan_loop(s: &Shared, poll: Duration, max_entries: usize) {
    let mut gate = lock(&s.wake);
    while !s.stop.load(Ordering::SeqCst) {
        let idle = lock(&s.polled).is_empty();
        gate = if idle {
            s.wake_cv.wait(gate).unwrap_or_else(|e| e.into_inner())
        } else {
            s.wake_cv.wait_timeout(gate, poll).unwrap_or_else(|e| e.into_inner()).0
        };
        if s.stop.load(Ordering::SeqCst) {
            break;
        }
        let mut found: Vec<PathBuf> = Vec::new();
        let mut overflow = false;
        for d in lock(&s.polled).iter_mut() {
            let scan = d.scan(max_entries);
            overflow |= scan.overflow;
            found.extend(scan.changed);
        }
        if !found.is_empty() {
            s.queue.changed(found);
        }
        if overflow {
            s.queue.rescan();
        }
    }
}

#[cfg(test)]
mod tests;
