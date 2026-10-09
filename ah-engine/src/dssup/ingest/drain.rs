//! The drain of one project, native: the loop body of `companion/devswarm-ingest.js` `ingestLoopGen`, one iteration at a time.
//!
//! SINGLE CONSUMER. Two readers of `hivecontrol workspace monitor` split the destructive native queue between them and silently
//! lose messages, so the drain takes the project's O_EXCL lock (`locks/ingest-project-<repo key>.lock`, Node's file and
//! protocol; a live holder is NEVER taken over) and backs off while any legacy per-worktree consumer of the repo is alive. The
//! lock is re-stamped every iteration; when it is found lost the drain stops.
//!
//! LOSS-FREE. Every non-empty monitor output is written to the delivery WAL (fsynced) before it is parsed; an iteration issues a
//! new destructive read only when no earlier batch is still pending and the WAL (and its spill) can be written. A batch the
//! store refuses (partition locked or not registered) stays pending and is replayed first. A batch of no known shape is
//! quarantined, and its bytes stay in the WAL too.
// Discard triage (E3): every `.ok()` / `unwrap_or_default()` in this module is a deliberate keep, for these reasons:
// - a heartbeat or log write that fails must never stop the loop (Node: "fail-open: liveness heartbeat is best-effort")
// - a file that is absent or unparsable is the absent value
use super::import::{self, Imported, Refused};
use super::monitor::{self, Breaker, Hc, Poll};
use super::wal::{self, Capture};
use crate::checks::git::util::Settings;
use crate::checks::guardkit::nodelock::{self, Refresh};
use crate::checks::guardkit::ojson::OVal;
use crate::defaults;
use crate::dsact::runner::{RunSpec, Runner};
use crate::meshw::common::{Inv, Obj, n, s, s_or_null};
use crate::meshw::ident;
use crate::meshw::idlock::devswarm_root;
use crate::meshw::store::{MeshStore, RegistryRow};
use crate::meshw::summary;
use serde_json::{Value, json};
use std::path::{Path, PathBuf};

/// One project the engine drains.
#[derive(Debug, Clone, PartialEq)]
pub struct Project {
    /// The main worktree (the daemon's working directory).
    pub worktree: String,
    /// The shared store key.
    pub repo_key: String,
    /// The Primary's partition id (`primary-<hash of the real path>`).
    pub workspace_id: String,
}

impl Project {
    /// Resolve a path to its project: the git worktree root, its repo key and its Primary id. `None` for a path that is not in a
    /// git repository (nothing to drain there).
    pub fn resolve(path: &str) -> Option<Project> {
        let wt = ident::resolve_caller_worktree(path).ok().flatten()?;
        let repo_key = ident::repo_key_for_worktree(&wt).ok().flatten()?;
        let workspace_id = ident::primary_workspace_id(&wt).ok()?;
        Some(Project { worktree: wt, repo_key, workspace_id })
    }
}

/// Settings of the drain, read once per start.
#[derive(Debug, Clone)]
pub struct Cfg {
    /// `-i` of the monitor call.
    pub interval_sec: u64,
    /// `-t` of the monitor call.
    pub timeout_sec: u64,
    /// Kill bound of the monitor call.
    pub hard_ms: u64,
    /// Base of the backoff ladders.
    pub base_backoff_ms: u64,
}

impl Cfg {
    /// Read the settings (monitor timeout through Node's tiers; the rest from the shipped defaults).
    pub fn read(st: &Settings) -> Cfg {
        let entry = defaults::raw("devswarm_ingest.set_timeout_sec");
        let t = crate::dsact::settings::resolve(st, entry)
            .as_f64()
            .filter(|t| *t > 0.0)
            .unwrap_or_else(|| entry.get("default").and_then(crate::defaults::V::as_integer).unwrap_or(0) as f64);
        let timeout_sec = t.floor().max(1.0) as u64;
        Cfg {
            interval_sec: defaults::num("devswarm_ingest.interval_sec"),
            timeout_sec,
            hard_ms: timeout_sec * 1000 + defaults::num("devswarm_ingest.hard_margin_ms"),
            base_backoff_ms: defaults::num("devswarm_ingest.backoff_base_ms"),
        }
    }
}

/// How the drain started.
#[derive(Debug, Clone, PartialEq)]
pub enum Start {
    /// Lock taken, store open, Primary registered.
    Started,
    /// Not started, and why; the caller tries again later. Nothing was read from the native queue.
    Refused(String),
}

/// What one iteration wants next.
#[derive(Debug, Clone, PartialEq)]
pub struct Step {
    /// How long to wait before the next iteration.
    pub wait_ms: u64,
    /// The drain must stop (the lock was lost).
    pub stop: bool,
}

/// Counters of one run.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Stats {
    /// Monitor calls made.
    pub iterations: u64,
    /// Rows inserted.
    pub inserted: u64,
    /// Rows that were already there.
    pub duplicate: u64,
    /// Iterations that failed or deferred.
    pub errors: u64,
    /// Batches of no known shape.
    pub loss_events: u64,
    /// WAL batches replayed.
    pub wal_replayed: u64,
    /// The WAL (or its spill) is not writable: destructive reads are refused.
    pub wal_blocked: bool,
    /// Message times that came from the import clock because the engine does not reproduce that `Date.parse` form.
    pub ts_fallbacks: u64,
    /// Summaries the engine could not derive (the next derive refreshes it).
    pub summary_deferred: u64,
}

/// The monitor outcome mirrored into the heartbeat.
#[derive(Debug, Clone, Default)]
struct MonState {
    last_ok: Option<i64>,
    last_attempt: Option<i64>,
    failures: u64,
    code: Option<String>,
    error: Option<String>,
}

/// The drain of one project.
pub struct Drainer {
    /// The project.
    pub project: Project,
    /// What it ran with.
    pub stats: Stats,
    home: PathBuf,
    st: Settings,
    cfg: Cfg,
    hc: Hc,
    lock: Option<nodelock::Held>,
    store: Option<MeshStore>,
    breaker: Breaker,
    mon: MonState,
    wal_file: PathBuf,
    wal_replay_needed: bool,
    wal_blocked_logged: bool,
    transient_hb_logged: bool,
    last_quarantine_at: Option<i64>,
    quarantine_suppressed: u64,
    started_at: i64,
    code_version: Option<String>,
    witness: Option<super::witness::Mirror>,
    last_refusal: Option<String>,
}

fn now_ms() -> i64 {
    crate::health::now_ms() as i64
}

fn lock_params() -> nodelock::Params {
    nodelock::Params {
        stale_ms: defaults::num("devswarm_ingest.lock_stale_ms"),
        wait_ms: 0,
        step_ms: defaults::num("mesh_write.id_lock_step_ms"),
        reclaim_stale_ms: defaults::num("mesh_write.id_lock_reclaim_stale_ms"),
        release_tries: defaults::num("mesh_write.id_lock_release_tries"),
        release_step_ms: defaults::num("mesh_write.id_lock_release_step_ms"),
        boot_slop_s: defaults::num("mesh_write.id_lock_boot_slop_s"),
        steal_dead: true,
    }
}

/// Append a `[ISO] line` to the ingest log (the file the Node daemon's unit writes), best effort.
pub fn log_line(home: &Path, line: &str) {
    let now = now_ms();
    let iso = crate::checks::jsport::date::to_iso(now as f64).unwrap_or_default();
    let p = home.join(defaults::text("devswarm_ingest.log_file"));
    if let Some(d) = p.parent() {
        crate::discard::harmless(std::fs::create_dir_all(d)); // keep: logging must never stop the loop
    }
    if let Ok(mut f) = std::fs::OpenOptions::new().append(true).create(true).open(&p) {
        crate::discard::harmless(std::io::Write::write_all(&mut f, format!("[{iso}] {line}\n").as_bytes())); // keep: same
    }
}

impl Drainer {
    /// A drain for `project` (nothing is touched until [`Drainer::start`]).
    pub fn new(home: &Path, st: &Settings, project: Project) -> Drainer {
        let hc = monitor::resolve_hc(st, &devswarm_root(home));
        let cfg = Cfg::read(st);
        let wal_file = wal::wal_path(&devswarm_root(home), defaults::text("devswarm_ingest.wal_kind"), &project.repo_key);
        let code_version = defaults::root()
            .and_then(|r| std::fs::read_to_string(r.join(defaults::text("devswarm_ingest.plugin_json"))).ok())
            .and_then(|t| serde_json::from_str::<Value>(&t).ok())
            .and_then(|v| v["version"].as_str().map(str::to_string));
        Drainer {
            breaker: Breaker::new(cfg.base_backoff_ms),
            project,
            stats: Stats::default(),
            home: home.to_path_buf(),
            st: st.clone(),
            cfg,
            hc,
            lock: None,
            store: None,
            mon: MonState::default(),
            wal_file,
            wal_replay_needed: true,
            wal_blocked_logged: false,
            transient_hb_logged: false,
            last_quarantine_at: None,
            quarantine_suppressed: 0,
            started_at: now_ms(),
            code_version,
            witness: None,
            last_refusal: None,
        }
    }

    /// The lock file of this project.
    pub fn lock_path(&self) -> PathBuf {
        devswarm_root(&self.home).join(defaults::text("mesh_write.dir_locks")).join(format!(
            "{}{}{}",
            defaults::text("devswarm_ingest.lock_prefix"),
            self.project.repo_key,
            defaults::text("mesh_write.lock_suffix")
        ))
    }

    fn inv(&self) -> Inv {
        Inv {
            home: self.home.clone(),
            env: self.st.env.clone(),
            cwd: self.project.worktree.clone(),
            now: now_ms(),
            stdin: None,
            write_home: self.home.clone(),
            store_override: None,
        }
    }

    fn log(&self, line: &str) {
        log_line(&self.home, line);
    }

    /// Take the lock, check no legacy consumer of the repo is alive, open the store and register the Primary. Nothing is read from
    /// the native queue before all of that holds.
    pub fn start(&mut self, runner: &dyn Runner) -> Start {
        let Some(held) = nodelock::acquire_respecting_live(&self.lock_path().to_string_lossy(), lock_params()) else {
            return self.refuse(defaults::text("devswarm_ingest.msg_lock_held").to_string());
        };
        self.lock = Some(held);
        if defaults::num("devswarm_ingest.legacy_probe") == 1 {
            let live = legacy_holders(runner, &self.home, &self.project.worktree);
            if !live.is_empty() {
                let why = defaults::render("devswarm_ingest.msg_legacy_alive", &[("holders", &live.join(", "))]);
                self.release();
                return self.refuse(why);
            }
        }
        match crate::meshw::common::open_store(&self.inv(), &self.project.repo_key) {
            Ok(st) => self.store = Some(st),
            Err(d) => {
                let why = defaults::render("devswarm_ingest.msg_store_unavailable", &[("why", &d.0)]);
                self.release();
                return self.refuse(why);
            }
        }
        self.last_refusal = None;
        self.log(&defaults::render(
            "devswarm_ingest.msg_started",
            &[("worktree", &self.project.worktree), ("ws", &self.project.workspace_id), ("bin", &self.hc.bin), ("src", &self.hc.source)],
        ));
        if monitor::usable(&self.hc) == Some(false) {
            self.log(&defaults::render("devswarm_ingest.msg_hc_unusable", &[("bin", &self.hc.bin), ("src", &self.hc.source)]));
        }
        self.self_register();
        self.witness = super::witness::Mirror::open(&self.home, &self.project.repo_key);
        Start::Started
    }

    /// A refusal to start, logged once per distinct reason (a Node consumer holding the lock is retried every few seconds and must not flood the log).
    fn refuse(&mut self, why: String) -> Start {
        if self.last_refusal.as_deref() != Some(&why) {
            self.log(&format!("{}{why}", defaults::text("devswarm_ingest.msg_refused_prefix")));
            self.last_refusal = Some(why.clone());
        }
        Start::Refused(why)
    }

    fn release(&mut self) {
        if let Some(l) = self.lock.take() {
            l.release();
        }
    }

    /// Stop: release the lock and close the store.
    pub fn stop(&mut self) {
        self.store = None;
        self.release();
    }

    /// Re-stamp the lock; false when it was definitively lost.
    pub fn beat_lock(&mut self) -> bool {
        let Some(l) = &self.lock else { return false };
        match l.refresh() {
            Refresh::Ok => {
                self.transient_hb_logged = false;
                true
            }
            Refresh::Lost => false,
            Refresh::Error => {
                if !self.transient_hb_logged {
                    self.transient_hb_logged = true;
                    self.log(defaults::text("devswarm_ingest.msg_hb_transient"));
                }
                true
            }
        }
    }

    /// The registry upsert of the Primary's own id, merge-preserving (a fuller row written by `register-primary` keeps its inbox,
    /// cursor and nudge command). Failures are logged, never fatal: until it lands the store refuses batches and they stay pending.
    pub fn self_register(&self) {
        let Some(store) = &self.store else { return };
        let ws = &self.project.workspace_id;
        let existing = store.registry_row(ws).ok().flatten();
        let row = RegistryRow {
            id: ws.clone(),
            worktree_path: Some(self.project.worktree.clone()),
            session_id: Some(ws.clone()),
            inbox_path: existing.as_ref().and_then(|r| r.inbox_path.clone()),
            cursor_path: existing.as_ref().and_then(|r| r.cursor_path.clone()),
            nudge_command: existing.as_ref().and_then(|r| r.nudge_command.clone()),
        };
        let same = |a: &str, b: &str| a == b || ident::realpath(a).is_some_and(|x| ident::realpath(b).is_some_and(|y| x == y));
        if let Err(e) = store.upsert_registry(&row, now_ms(), same) {
            self.log(&defaults::render("devswarm_ingest.msg_register_failed", &[("ws", ws), ("err", &e)]));
        }
    }

    /// Write the liveness heartbeat (`heartbeats/ingest-<repo key>.json`), Node's keys in Node's order.
    pub fn write_heartbeat(&self) {
        let p = devswarm_root(&self.home).join(defaults::text("devswarm_ingest.dir_heartbeats")).join(format!(
            "{}{}{}",
            defaults::text("devswarm_ingest.hb_prefix"),
            self.project.repo_key,
            defaults::text("devswarm_ingest.json_suffix")
        ));
        let num = |v: Option<i64>| v.map_or(OVal::Null, |x| n(x as f64));
        let trunc = |t: &str, k: &str| OVal::Str(t.chars().take(defaults::num(k) as usize).collect());
        let mut o = Obj::default();
        o.put("ts", n(now_ms() as f64))
            .put("workspaceId", s(&self.project.workspace_id))
            .put("workingDir", s(&self.project.worktree))
            .put("pid", n(f64::from(std::process::id())))
            .put("lastMonitorOkMs", num(self.mon.last_ok))
            .put("lastMonitorAttemptMs", num(self.mon.last_attempt))
            .put("consecutiveMonitorFailures", n(self.mon.failures as f64))
            .put("lastMonitorErrorCode", s_or_null(self.mon.code.as_deref()))
            .put("lastMonitorError", self.mon.error.as_deref().map_or(OVal::Null, |e| trunc(e, "devswarm_ingest.hb_error_chars")))
            .put("hivecontrolBin", s(&self.hc.bin))
            .put("hivecontrolSource", s(&self.hc.source))
            .put("daemonPath", self.st.env.get(defaults::text("devswarm_ingest.env_path")).map_or(OVal::Null, |v| trunc(v, "devswarm_ingest.hb_path_chars")))
            .put("codeVersion", s_or_null(self.code_version.as_deref()))
            .put("startedAtMs", n(self.started_at as f64));
        if let Some(d) = p.parent() {
            crate::discard::harmless(std::fs::create_dir_all(d)); // keep: a heartbeat is best effort
        }
        let tmp = PathBuf::from(format!("{}.{}{}", p.display(), std::process::id(), defaults::text("devswarm_ingest.tmp_suffix")));
        let ok = std::fs::write(&tmp, o.done().stringify()).and_then(|()| std::fs::rename(&tmp, &p));
        if ok.is_err() {
            crate::discard::harmless(std::fs::remove_file(&tmp)); // keep: our own temp
        }
    }

    /// Both liveness signals (the lock's time and the heartbeat file); false when the lock is lost.
    pub fn beat(&mut self) -> bool {
        let alive = self.beat_lock();
        self.write_heartbeat();
        alive
    }

    fn derive(&mut self) {
        let Some(store) = &self.store else { return };
        if let Some(why) = summary::derive_after_write(store, &self.inv(), &self.project.repo_key) {
            self.stats.summary_deferred += 1;
            self.log(&defaults::render("devswarm_ingest.msg_summary_deferred", &[("why", &why)]));
        }
    }

    fn import(&self, raw: &str, now: i64) -> Result<Imported, Refused> {
        let Some(store) = &self.store else { return Err(Refused::Store(defaults::text("devswarm_ingest.msg_no_store").to_string())) };
        import::ingest_payload(store, &self.home, &self.project.workspace_id, raw, now)
    }

    /// Replay every open batch of the WAL (and of a prior reader key's, adopted); true when nothing is left pending.
    fn replay_wal(&mut self) -> bool {
        let now = now_ms();
        match wal::absorb_spill(&self.wal_file, now) {
            Ok(_) => {}
            Err(e) => {
                self.stats.wal_blocked = true;
                if !self.wal_blocked_logged {
                    self.wal_blocked_logged = true;
                    self.log(&defaults::render("devswarm_ingest.msg_wal_spill_blocked", &[("err", &e), ("dir", &wal::spill_dir(&self.wal_file).display())]));
                }
                return false;
            }
        }
        let mut open: Vec<(PathBuf, wal::Open)> = match wal::pending(&self.wal_file) {
            Ok(v) => v.into_iter().map(|b| (self.wal_file.clone(), b)).collect(),
            Err(e) => {
                self.stats.wal_blocked = true;
                self.log(&defaults::render("devswarm_ingest.msg_wal_unreadable", &[("err", &e), ("file", &self.wal_file.display())]));
                return false;
            }
        };
        open.extend(wal::adopt_for_worktree(
            &devswarm_root(&self.home),
            defaults::text("devswarm_ingest.wal_kind"),
            &self.project.worktree,
            &self.wal_file,
            now,
        ));
        for (file, b) in open {
            let ing = match self.import(&b.raw, now) {
                Ok(i) => i,
                Err(r) => {
                    self.log(&defaults::render("devswarm_ingest.msg_replay_deferred", &[("why", &format!("{r:?}"))]));
                    if r == Refused::Gone {
                        self.self_register();
                    }
                    return false;
                }
            };
            self.account(&ing);
            self.stats.wal_replayed += 1;
            if ing.inserted > 0 {
                self.derive();
            }
            let closed = if ing.lossy {
                wal::close_batch(
                    &file,
                    &b.e,
                    "quarantine",
                    &format!("\"reason\":{}", serde_json::to_string(defaults::text("devswarm_ingest.reason_unparseable")).unwrap_or_default()),
                    now_ms(),
                )
            } else {
                wal::close_batch(&file, &b.e, "done", &format!("\"inserted\":{},\"duplicate\":{}", ing.inserted, ing.duplicate), now_ms())
            };
            if closed.is_err() {
                return false;
            }
        }
        wal::maybe_rotate(&self.wal_file, now);
        true
    }

    fn account(&mut self, ing: &Imported) {
        self.stats.inserted += ing.inserted as u64;
        self.stats.duplicate += ing.duplicate as u64;
        self.stats.ts_fallbacks += ing.rows.iter().filter(|r| r.ts_fallback).count() as u64;
    }

    fn quarantine(&mut self, raw: &str, now: i64) {
        self.stats.loss_events += 1;
        let due = self.last_quarantine_at.is_none_or(|t| now - t >= defaults::num("devswarm_ingest.quarantine_rate_ms") as i64);
        if !due {
            self.quarantine_suppressed += 1;
            return;
        }
        let dir = devswarm_root(&self.home).join(defaults::text("devswarm_ingest.dir_quarantine"));
        let capped = std::fs::read_dir(&dir).is_ok_and(|d| d.count() >= defaults::num("devswarm_ingest.quarantine_max_files") as usize);
        let path = (!capped).then(|| {
            std::fs::create_dir_all(&dir).ok()?;
            let max = defaults::num("devswarm_ingest.quarantine_max_bytes") as usize;
            let mut body = raw.to_string();
            if body.len() > max {
                let mut cut = max;
                while !body.is_char_boundary(cut) {
                    cut -= 1;
                }
                body.truncate(cut);
                body.push_str(&defaults::render("devswarm_ingest.msg_truncated_at", &[("n", &max)]));
            }
            let stamp = crate::checks::jsport::date::to_iso(now as f64).unwrap_or_default().replace([':', '.'], "-");
            let p = dir.join(format!(
                "{}{}-{stamp}-{}{}",
                defaults::text("devswarm_ingest.quarantine_prefix"),
                self.project.repo_key,
                std::process::id(),
                defaults::text("devswarm_ingest.quarantine_suffix")
            ));
            std::fs::write(&p, body).ok().map(|()| p)
        });
        let suppressed = std::mem::take(&mut self.quarantine_suppressed);
        self.log(&defaults::render(
            "devswarm_ingest.msg_loss",
            &[
                ("bytes", &raw.len()),
                (
                    "where",
                    &path.flatten().map_or_else(
                        || {
                            if capped {
                                defaults::text("devswarm_ingest.msg_quarantine_capped").to_string()
                            } else {
                                defaults::text("devswarm_ingest.msg_quarantine_failed").to_string()
                            }
                        },
                        |p| p.display().to_string(),
                    ),
                ),
                ("suppressed", &suppressed),
            ],
        ));
        self.last_quarantine_at = Some(now);
    }

    fn base_wait(&self) -> u64 {
        self.cfg.base_backoff_ms
    }

    /// One iteration of Node's loop: lock beat, WAL admission, ONE destructive read, WAL first, import, close, then the breaker or
    /// the pace. The heartbeat is written at the top (Node's place) and again at the end, so a failing monitor shows in it at once
    /// instead of one iteration later.
    pub fn step(&mut self, runner: &dyn Runner) -> Step {
        let out = self.step_inner(runner);
        if !out.stop {
            self.write_heartbeat();
        }
        out
    }

    fn step_inner(&mut self, runner: &dyn Runner) -> Step {
        let stop = Step { wait_ms: 0, stop: true };
        if !self.beat_lock() {
            self.log(defaults::text("devswarm_ingest.msg_lock_lost"));
            return stop;
        }
        if self.wal_replay_needed {
            if !self.replay_wal() {
                self.stats.errors += 1;
                return Step { wait_ms: self.base_wait(), stop: false };
            }
            self.wal_replay_needed = false;
        }
        if let Some(why) = wal::preflight(&self.wal_file) {
            self.stats.errors += 1;
            self.stats.wal_blocked = true;
            if !self.wal_blocked_logged {
                self.wal_blocked_logged = true;
                self.log(&defaults::render("devswarm_ingest.msg_wal_blocked", &[("why", &why), ("file", &self.wal_file.display())]));
            }
            self.wal_replay_needed = true;
            return Step { wait_ms: self.base_wait(), stop: false };
        }
        self.wal_blocked_logged = false;
        self.stats.wal_blocked = false;
        if !self.beat() {
            self.log(defaults::text("devswarm_ingest.msg_lock_lost"));
            return stop;
        }
        let started = std::time::Instant::now();
        let poll: Poll = monitor::poll(runner, &self.hc, &self.project.worktree, self.cfg.interval_sec, self.cfg.timeout_sec, self.cfg.hard_ms);
        let now = now_ms();
        self.mon.last_attempt = Some(now);
        self.stats.iterations += 1;
        if !poll.raw.is_empty() {
            if poll.truncated {
                self.log(&defaults::render("devswarm_ingest.msg_output_truncated", &[("bytes", &poll.raw.len())]));
            }
            let entry = match wal::capture_raw(&self.wal_file, &poll.raw, now, Some(&self.project.worktree)) {
                Capture::Wal(e) => Some(e),
                other => {
                    self.log(&defaults::render("devswarm_ingest.msg_wal_write_failed", &[("what", &format!("{other:?}"))]));
                    self.wal_replay_needed = true;
                    self.stats.wal_blocked = true;
                    None
                }
            };
            match self.import(&poll.raw, now) {
                Err(r) => {
                    self.stats.errors += 1;
                    if entry.is_some() {
                        self.wal_replay_needed = true;
                    }
                    if r == Refused::Gone {
                        self.self_register();
                    }
                    self.log(&defaults::render("devswarm_ingest.msg_import_refused", &[("why", &format!("{r:?}")), ("kept", &entry.is_some())]));
                    return Step { wait_ms: self.base_wait(), stop: false };
                }
                Ok(ing) => {
                    self.account(&ing);
                    if ing.inserted > 0 {
                        self.derive();
                    }
                    if let Some(e) = &entry {
                        let closed = if ing.lossy {
                            wal::close_batch(
                                &self.wal_file,
                                e,
                                "quarantine",
                                &format!("\"reason\":{}", serde_json::to_string(defaults::text("devswarm_ingest.reason_unparseable")).unwrap_or_default()),
                                now_ms(),
                            )
                        } else {
                            wal::close_batch(&self.wal_file, e, "done", &format!("\"inserted\":{},\"duplicate\":{}", ing.inserted, ing.duplicate), now_ms())
                        };
                        if closed.is_err() {
                            self.wal_replay_needed = true;
                        }
                    }
                    if let Some(m) = &mut self.witness {
                        m.record(&poll.raw, now, &ing);
                    }
                    if ing.lossy {
                        self.quarantine(&poll.raw, now);
                    }
                }
            }
        }
        if !poll.ok {
            self.stats.errors += 1;
            let v = self.breaker.on_failure(&poll, now);
            self.mon.failures = v.consecutive;
            self.mon.code = v.code.clone();
            self.mon.error = poll.error.clone();
            if let Some(l) = &v.log {
                self.log(l);
            }
            return Step { wait_ms: v.backoff_ms, stop: false };
        }
        if let Some(l) = self.breaker.on_success(now) {
            self.log(&l);
        }
        self.mon.last_ok = self.breaker.last_ok_ms;
        self.mon.failures = 0;
        self.mon.code = None;
        self.mon.error = None;
        let interval_ms = (self.cfg.interval_sec.max(1) * 1000).min(defaults::num("devswarm_ingest.max_pace_ms"));
        let elapsed = started.elapsed().as_millis() as u64;
        Step { wait_ms: interval_ms.saturating_sub(elapsed), stop: false }
    }

    /// Run the Node witness when it is due: Node's `ingestPayload` over the mirrored batches in a scratch HOME, compared with the
    /// mirror and with the live store. Bounded; never changes what the drain did.
    pub fn maybe_witness(&mut self, runner: &dyn Runner) {
        let now = now_ms();
        let (Some(m), Some(store), Some(root)) = (&mut self.witness, &self.store, defaults::root()) else { return };
        if m.due(now) {
            m.compare(runner, &root, store, &self.project, now);
        }
    }

    /// The monitor outcome and counters, for the status verb.
    pub fn status(&self) -> Value {
        json!({
            "worktree": self.project.worktree, "repoKey": self.project.repo_key, "workspaceId": self.project.workspace_id,
            "lockHeld": self.lock.is_some(), "iterations": self.stats.iterations, "inserted": self.stats.inserted,
            "duplicate": self.stats.duplicate, "errors": self.stats.errors, "lossEvents": self.stats.loss_events,
            "walReplayed": self.stats.wal_replayed, "walBlocked": self.stats.wal_blocked, "tsFallbacks": self.stats.ts_fallbacks,
            "summaryDeferred": self.stats.summary_deferred, "lastMonitorOkMs": self.mon.last_ok,
            "consecutiveMonitorFailures": self.mon.failures, "hivecontrol": self.hc.bin,
        })
    }
}

/// Legacy per-worktree consumers of this repo that are still alive (their `ingest-<worktree hash>.lock` names a live local pid, or
/// is unparseable and fresh). Fails toward BLOCKING; removes nothing. Empty when none.
pub fn legacy_holders(runner: &dyn Runner, home: &Path, main_worktree: &str) -> Vec<String> {
    let mut worktrees = vec![main_worktree.to_string()];
    let r = runner.run(&RunSpec {
        bin: Some(defaults::text("devswarm_wire.git_bin").to_string()),
        args: defaults::list("devswarm_ingest.git_worktree_args").iter().map(|s| (*s).to_string()).collect(),
        cwd: Some(main_worktree.to_string()),
        timeout_ms: defaults::num("devswarm_wire.git_timeout_ms"),
        ..RunSpec::default()
    });
    if r.ok {
        for l in r.stdout.lines() {
            if let Some(p) = l.strip_prefix(defaults::text("devswarm_ingest.porcelain_worktree")) {
                let p = p.trim().to_string();
                if !worktrees.contains(&p) {
                    worktrees.push(p);
                }
            }
        }
    }
    let dir = devswarm_root(home).join(defaults::text("mesh_write.dir_locks"));
    let mut live = Vec::new();
    for wt in worktrees {
        let Ok(id) = ident::primary_workspace_id(&wt) else { continue };
        let hash = id.trim_start_matches(defaults::text("mesh_write.primary_prefix"));
        let p = dir.join(format!("{}{hash}{}", defaults::text("devswarm_ingest.legacy_lock_prefix"), defaults::text("mesh_write.lock_suffix")));
        let Ok(text) = std::fs::read_to_string(&p) else { continue };
        let pid = serde_json::from_str::<Value>(&text).ok().and_then(|v| v["pid"].as_i64());
        let alive = match pid {
            Some(pid) if pid > 0 && pid <= i64::from(i32::MAX) => {
                // SAFETY: signal 0 only probes for the process.
                unsafe { libc::kill(pid as i32, 0) == 0 || std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM) }
            }
            // unparseable: a fresh one is a live holder mid-write; a stale one is abandoned
            _ => std::fs::metadata(&p)
                .and_then(|m| m.modified())
                .map(|t| t.elapsed().map_or(true, |e| e.as_millis() as u64 <= defaults::num("devswarm_ingest.lock_stale_ms")))
                .unwrap_or(true),
        };
        if alive {
            live.push(format!("{wt} ({})", pid.map_or("?".to_string(), |p| p.to_string())));
        }
    }
    live
}
