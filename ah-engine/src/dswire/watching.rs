//! The DevSwarm thread: the file watcher over every DevSwarm source, the start-up reconcile and the loop that turns batches of
//! changes into reconciles. The watcher is generic (it knows directories, not DevSwarm); this module chooses the directories and
//! says what a change in each of them means.
use super::gate::TranscriptGate;
use super::storewatch::VersionWatch;
use super::{Wire, facts};
use crate::defaults;
use crate::devswarm_rt::detect::Mode;
use crate::devswarm_rt::reconcile::Cause;
use crate::devswarm_rt::state::Lifecycle;
use crate::meshw::idlock::devswarm_root;
use crate::meshw::union;
use crate::watch::{Config, Watcher, poll::Filter};
use std::collections::HashMap;
use std::path::PathBuf;
use std::time::{Duration, Instant};

/// What a watched directory is.
#[derive(Debug, Clone, PartialEq)]
pub enum Role {
    /// A source of the workspace state: a change is a hint to reconcile.
    State,
    /// The workspace heartbeats: a hint to reconcile, except the beat of a workspace the state calls working (see
    /// [`plan_with`]), which cannot change anything the reconcile derives.
    Beat,
    /// A workspace's transcript directory: a change dirties that workspace for Jev.
    Transcript(String),
    /// A workspace's git directory: a commit or checkout dirties that workspace for Jev.
    Git(String),
}

/// The directories to watch now, with the filter and role of each. SQLite files are never watched by name (see
/// [`version_sources`]).
pub fn wanted(w: &Wire, cfg: &Config) -> Vec<(PathBuf, Filter, Role)> {
    let mut out: Vec<(PathBuf, Filter, Role)> = Vec::new();
    let root = devswarm_root(&w.home);
    // files a sibling daemon writes into the state directories that no reconcile reads (its heartbeat every ~2 s was 76 % of
    // all hints in the live19 profile): not hints
    let ignore: Vec<String> = defaults::list("devswarm_wire.state_ignore_prefixes").into_iter().map(|k| defaults::text(k).to_string()).collect();
    // a writer's staged temp file (`x.json.tmp.<pid>`) is never the event: its rename to the real name is
    let temp: Vec<String> = defaults::list("devswarm_wire.state_ignore_contains").into_iter().map(|k| defaults::text(k).to_string()).collect();
    for k in defaults::list("devswarm_wire.watch_state_dirs") {
        let role = if k == defaults::text("devswarm_wire.beat_dir_key") { Role::Beat } else { Role::State };
        out.push((root.join(defaults::text(k)), cfg.all_but(ignore.clone(), temp.clone()), role));
    }
    let snap = w.rt.current();
    let descs = facts::descriptors_with(&w.home, Some(w.rt.read_cache())); // read once for every workspace
    for ws in snap.workspaces.values().filter(|x| x.lifecycle.value == Lifecycle::Active) {
        let Some(wt) = ws.worktree.as_deref() else { continue };
        if let Some(key) = facts::repo_key(wt) {
            // the store's other files (its backend marker) are state sources; its SQLite files are not watched, their commits are
            // seen through `PRAGMA data_version`: the reconcile itself opens the store, and the open touches those files, so
            // watching them made every reconcile trigger the next one (live P0, 2026-10-15)
            out.push((union::store_dir(&w.home, &key), cfg.no_sqlite_filter(defaults::text("mesh_write.store_file")), Role::State));
        }
        for d in descs.iter().filter(|d| d.worktree == wt || d.id == ws.id) {
            if let Some(dir) = facts::transcript_path(&w.home, &d.worktree, &d.session).parent() {
                out.push((dir.to_path_buf(), cfg.all_filter(), Role::Transcript(ws.id.clone())));
            }
        }
        if let Some(g) = facts::git_dir(wt) {
            out.push((g, Filter::names(defaults::list("devswarm_wire.watch_git_names")), Role::Git(ws.id.clone())));
        }
    }
    out
}

/// The SQLite databases whose commits are a hint to reconcile, found by `PRAGMA data_version` on a held connection: the app
/// database and the mesh store of every active workspace.
pub fn version_sources(w: &Wire) -> Vec<PathBuf> {
    let mut out: Vec<PathBuf> = w.rt.detection().app_db.iter().cloned().collect();
    for ws in w.rt.current().workspaces.values().filter(|x| x.lifecycle.value == Lifecycle::Active) {
        if let Some(key) = ws.worktree.as_deref().and_then(facts::repo_key) {
            let db = union::store_dir(&w.home, &key).join(defaults::text("mesh_write.store_file"));
            if !out.contains(&db) {
                out.push(db);
            }
        }
    }
    out
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
    /// The transcript files that changed, by workspace (the transcript gate decides whether they count).
    pub transcripts: Vec<(String, PathBuf)>,
    /// Heartbeats in the batch that were not a hint (their workspace is working and a beat cannot change that).
    pub quiet_beats: usize,
}

/// Classify a batch against the watched directories.
pub fn plan(have: &HashMap<PathBuf, Role>, rescan: bool, paths: &[PathBuf]) -> Plan {
    plan_with(have, rescan, paths, &|_| false)
}

/// [`plan`], where `quiet(id)` says that a heartbeat of workspace `id` cannot change the state (the state calls the workspace
/// working: a newer beat leaves it working, and the silence deadline check re-reads the beat when the clock runs out). Any other
/// beat (a stuck or unknown workspace, one the state does not know yet) is a hint, so a real change is never missed.
pub fn plan_with(have: &HashMap<PathBuf, Role>, rescan: bool, paths: &[PathBuf], quiet: &dyn Fn(&str) -> bool) -> Plan {
    let mut p = Plan::default();
    if rescan {
        p.reconcile = Some(Cause::Overflow);
    }
    for path in paths {
        match path.parent().and_then(|d| have.get(d)) {
            Some(Role::Beat) => {
                let name = path.file_name().map(|n| n.to_string_lossy()).unwrap_or_default();
                let id = name.strip_suffix(defaults::text("mesh_write.json_suffix"));
                if id.is_some_and(quiet) {
                    p.quiet_beats += 1;
                } else if p.reconcile.is_none() {
                    p.reconcile = Some(Cause::Event);
                }
            }
            Some(Role::State) if p.reconcile.is_none() => p.reconcile = Some(Cause::Event),
            Some(Role::Transcript(id)) => {
                p.transcripts.push((id.clone(), path.clone()));
                if !p.dirty.contains(id) {
                    p.dirty.push(id.clone());
                }
            }
            Some(Role::Git(id)) if !p.dirty.contains(id) => p.dirty.push(id.clone()),
            _ => {}
        }
    }
    p
}

/// The work the thread has done since the process started: wakes, batches received, paths in them, reconciles deferred, store
/// commits seen and transcript events the gate held back (the `status --threads` work counters; reading them costs nothing).
pub mod work {
    use std::sync::atomic::{AtomicU64, Ordering};
    /// Times the thread woke from its sleep.
    pub static WAKES: AtomicU64 = AtomicU64::new(0);
    /// Batches the watcher handed the thread.
    pub static BATCHES: AtomicU64 = AtomicU64::new(0);
    /// Changed paths in those batches.
    pub static PATHS: AtomicU64 = AtomicU64::new(0);
    /// Reconcile requests folded into one already waiting for `devswarm_wire.reconcile_min_gap_ms` to pass.
    pub static DEFERRED: AtomicU64 = AtomicU64::new(0);
    /// Polls of the held SQLite connections in which a commit by another process was seen.
    pub static STORE_COMMITS: AtomicU64 = AtomicU64::new(0);
    /// Transcript events the gate did not act on (no growth, or inside the interval).
    pub static TRANSCRIPT_SKIPPED: AtomicU64 = AtomicU64::new(0);
    /// Heartbeats of working workspaces that were not a hint to reconcile.
    pub static QUIET_BEATS: AtomicU64 = AtomicU64::new(0);
    pub(crate) fn add(c: &AtomicU64, n: u64) {
        c.fetch_add(n, Ordering::Relaxed);
    }
    /// `(name, value)` of every counter.
    pub fn snapshot() -> Vec<(&'static str, u64)> {
        let g = |c: &AtomicU64| c.load(Ordering::Relaxed);
        vec![
            ("wakes", g(&WAKES)),
            ("batches", g(&BATCHES)),
            ("paths", g(&PATHS)),
            ("reconciles_deferred", g(&DEFERRED)),
            ("store_commits", g(&STORE_COMMITS)),
            ("transcript_skipped", g(&TRANSCRIPT_SKIPPED)),
            ("quiet_beats", g(&QUIET_BEATS)),
        ]
    }
}

/// The cause that covers both: an overflow (a full reconcile that counts repairs) wins over a plain event.
fn merge(a: Option<Cause>, b: Cause) -> Cause {
    if a == Some(Cause::Overflow) { Cause::Overflow } else { b }
}

/// The settings the loop reads on every wake, resolved once (and again when the shipped settings are reloaded) instead of looked
/// up by name each time.
struct Tun {
    wait: Duration,
    min_sleep: Duration,
    gap: Duration,
    store_poll: Duration,
    transcript_min: Duration,
    flush: Duration,
}

impl Tun {
    fn load() -> Tun {
        Tun {
            wait: defaults::millis("devswarm_wire.wait_ms"),
            min_sleep: defaults::millis("devswarm_wire.min_sleep_ms"),
            gap: defaults::millis("devswarm_wire.reconcile_min_gap_ms"),
            store_poll: defaults::millis("devswarm_wire.store_poll_ms"),
            transcript_min: defaults::millis("devswarm_wire.transcript_min_interval_ms"),
            flush: defaults::millis("devswarm_wire.jev_dirty_flush_ms"),
        }
    }
}

/// What exists only while the layer is on: the watcher and the change detectors beside it.
struct Live {
    watcher: Watcher,
    have: HashMap<PathBuf, Role>,
    versions: VersionWatch,
    gate: TranscriptGate,
    next_store: Instant,
    next_flush: Instant,
}

impl Live {
    fn start(w: &Wire, tun: &Tun) -> Live {
        let watcher = Watcher::start(Config::load());
        let mut live = Live {
            watcher,
            have: HashMap::new(),
            versions: VersionWatch::new(),
            gate: TranscriptGate::new(tun.transcript_min),
            next_store: Instant::now() + tun.store_poll,
            next_flush: Instant::now() + tun.flush,
        };
        live.sync(w);
        live
    }

    /// Bring the watched directories and the held connections in line with the state.
    fn sync(&mut self, w: &Wire) {
        sync(w, &self.watcher, &mut self.have);
        self.versions.sync(&version_sources(w));
        let have = &self.have;
        self.gate.retain(&|id| have.values().any(|r| matches!(r, Role::Transcript(x) if x == id)));
    }
}

/// The time left until `at`, never more than `cap`.
fn until(at: Instant, now: Instant, cap: Duration) -> Duration {
    at.saturating_duration_since(now).min(cap)
}

/// The thread body: reconcile at start, then one reconcile per hint (a state file event, a commit seen in a held SQLite file) at
/// most once per `devswarm_wire.reconcile_min_gap_ms` (a hint inside the gap is folded into the reconcile at its end, never
/// dropped), until `stop` says the daemon is draining. The thread sleeps until the next thing is due, never longer than
/// `devswarm_wire.wait_ms`. While `devswarm_rt.mode` is `off` it holds no watcher and does no work.
pub fn run(w: &Wire, stop: &dyn Fn() -> bool) {
    let mut tun = Tun::load();
    let mut generation = defaults::generation();
    w.refresh_followup_next();
    let mut live: Option<Live> = None;
    let mut last = Instant::now();
    let mut pending: Option<Cause> = None;
    while !stop() {
        if defaults::generation() != generation {
            generation = defaults::generation();
            tun = Tun::load();
        }
        if w.refresh_mode() == Mode::Off {
            if live.take().is_some() {
                w.jev.flush(); // the watcher is gone (dropped above); keep the queue
            }
            pending = None;
            std::thread::sleep(tun.wait);
            continue;
        }
        let l = match live.as_mut() {
            Some(l) => l,
            None => {
                w.reconcile(Cause::Startup);
                last = Instant::now();
                live.insert(Live::start(w, &tun))
            }
        };
        work::add(&work::WAKES, 1);
        w.act_if_pending();
        w.events_if_due();
        w.stall_tick();
        let now = Instant::now();
        if now >= l.next_store {
            l.next_store = now + tun.store_poll;
            if l.versions.changed() {
                work::add(&work::STORE_COMMITS, 1);
                pending = Some(merge(pending, Cause::Event));
            }
        }
        l.gate.set_min(tun.transcript_min);
        let held_back = l.gate.tick(now); // growth the interval held back, now due
        if now >= l.next_flush {
            l.next_flush = now + tun.flush;
            w.run_jev(); // the queued sweeps start here, at most one per flush interval, however many batches queued ids since
            w.jev.flush();
        }
        if !held_back.is_empty() {
            queue_dirty(w, &held_back);
            if w.stuck_among(&held_back) {
                pending = Some(merge(pending, Cause::Event));
            }
        }
        // sleep until the next thing is due
        let mut sleep = tun.wait;
        if pending.is_some() {
            sleep = sleep.min(tun.gap.saturating_sub(last.elapsed()));
        }
        sleep = sleep.min(until(l.next_store, now, tun.wait));
        if let Some(t) = l.gate.next_due() {
            sleep = sleep.min(until(t, now, tun.wait));
        }
        if w.jev.unsaved() {
            sleep = sleep.min(until(l.next_flush, now, tun.wait));
        }
        let now_ms = super::now_ms();
        for ms in [w.act_due_in(now_ms), w.events_due_in(now_ms), w.stall_due_in(now_ms)].into_iter().flatten() {
            sleep = sleep.min(Duration::from_millis(ms.max(0) as u64));
        }
        if let Some(batch) = l.watcher.next(sleep.max(tun.min_sleep)) {
            work::add(&work::BATCHES, 1);
            work::add(&work::PATHS, batch.paths.len() as u64);
            crate::threads::tally(&format!("dswire_batches.{}", batch_role(&batch.paths)), 1);
            let p = plan_with(&l.have, batch.rescan, &batch.paths, &|id| w.beat_is_quiet(id));
            work::add(&work::QUIET_BEATS, p.quiet_beats as u64);
            // a transcript is gated (it only matters when it grew, and not more than once per interval); a commit is not
            let mut dirty: Vec<String> = Vec::new();
            for id in &p.dirty {
                let files: Vec<PathBuf> = p.transcripts.iter().filter(|(x, _)| x == id).map(|(_, f)| f.clone()).collect();
                if git_dirty(&l.have, id, &batch.paths) || (!files.is_empty() && l.gate.observe(id, &files, Instant::now())) {
                    dirty.push(id.clone());
                } else {
                    work::add(&work::TRANSCRIPT_SKIPPED, 1);
                }
            }
            if !dirty.is_empty() {
                queue_dirty(w, &dirty);
            }
            // a transcript or git event on a workspace the state calls stuck: the silence clock reset, so read the state again now
            if let Some(cause) = p.reconcile.or_else(|| w.stuck_among(&dirty).then_some(Cause::Event)) {
                if pending.is_some() {
                    work::add(&work::DEFERRED, 1);
                }
                pending = Some(merge(pending, cause));
            }
        }
        if let Some(cause) = pending
            && last.elapsed() >= tun.gap
        {
            pending = None;
            w.reconcile(cause);
            last = Instant::now();
            l.sync(w);
        }
    }
    w.jev.flush();
}

/// Queue the per-child Jev sweeps of `ids`; the loop's flush tick starts them (a sweep per batch was a thread per batch: #191).
fn queue_dirty(w: &Wire, ids: &[String]) {
    let n = w.jev.queue(ids);
    if n > 0 {
        w.count_dirty(n);
    }
}

/// Whether a changed path in the batch belongs to `id`'s git directory.
fn git_dirty(have: &HashMap<PathBuf, Role>, id: &str, paths: &[PathBuf]) -> bool {
    paths.iter().any(|p| matches!(p.parent().and_then(|d| have.get(d)), Some(Role::Git(x)) if x == id))
}

/// What a batch of changed paths is made of, for the work counters: the DevSwarm state directory's role (`batch_role_names`) when
/// every path is in the same one, the mixed label when they differ, the other label when none is (transcripts, repositories).
fn batch_role(paths: &[PathBuf]) -> &'static str {
    let (dirs, names) = (crate::defaults::list("devswarm_wire.batch_role_dirs"), crate::defaults::list("devswarm_wire.batch_role_names"));
    let role = |p: &PathBuf| dirs.iter().position(|d| p.parent().and_then(|x| x.file_name()).is_some_and(|n| n == crate::defaults::text(d)));
    match paths.first().map(role) {
        Some(Some(i)) if paths.iter().all(|p| role(p) == Some(i)) => names.get(i).copied().unwrap_or(crate::defaults::text("devswarm_wire.batch_role_other")),
        Some(Some(_)) => crate::defaults::text("devswarm_wire.batch_role_mixed"),
        _ => crate::defaults::text("devswarm_wire.batch_role_other"),
    }
}
