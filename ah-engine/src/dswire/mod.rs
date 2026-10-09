//! The DevSwarm wiring (lane dswire): the daemon thread that keeps the realtime workspace state live, the triggers of the action
//! layer, and the consumers of the state.
//!
//! * [`Wire::start`] starts the layer only when DevSwarm is detected (the app database or a workspace descriptor exists) and
//!   `devswarm_rt.mode` is not `off`; otherwise it returns `None` and no thread, watcher or file exists. The one thread owns a
//!   [`crate::watch::Watcher`] over the app database directory and its `-wal`, the DevSwarm state directories, the mesh store
//!   directories, and per active workspace its transcript directory and git directory. A batch of changes is a hint: the state is
//!   always re-derived from the sources ([`crate::devswarm_rt::Rt::run_live`]); an overflow is a full reconcile. The scheduler job
//!   `devswarm_reconcile` is the safety net under the events (`devswarm_rt.reconcile_ms`); what it finds that events missed counts
//!   in `rt_reconcile_repairs`.
//! * The three automatic actions (auto-archive, poke, escalate) fire from the state under their existing Node settings, but only
//!   when `devswarm_rt.act.<action>.executor` is `engine` (the default). With another executor the engine stands down and counts
//!   it. Owner actions go through `ah-engine devswarm <verb>` ([`cli`]) under the role matrix.
//! * Consumers: [`consume::advisory`] (the `devswarm-rt-advisory` hook check), [`consume::line`] (the statusline segment) and the
//!   per-child Jev dirty queue ([`consume::mark_dirty`]).
pub mod cli;
pub mod consume;
pub mod facts;
pub mod live;
pub mod nudges;
pub mod watching;

use crate::db::Db;
use crate::devswarm_rt::detect::Mode;
use crate::devswarm_rt::reconcile::{Cause, Report, Rt};
use crate::devswarm_rt::state::EdgeKind;
use crate::dsact::exec::Act;
use crate::dsact::ledger::Word;
use crate::dsact::runner::{Runner, System};
use crate::metrics::Metrics;
use crate::reqenv::RequestEnv;
use live::RtLive;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicI64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};

/// Who runs an action.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Executor {
    /// The engine, in the daemon.
    Engine,
    /// The Node supervisor; the engine stands down.
    Node,
    /// Nobody.
    Off,
}

/// A setting through the layered configuration (environment, `settings.json`, `config.toml`, shipped default).
pub fn effective_text(key: &str) -> String {
    let (layers, _errs) = crate::cfgstore::load_layers_cold(&crate::cfgstore::Paths::from_env());
    crate::cfgstore::Effective::resolve_process(&layers).text(key)
}

/// `devswarm_rt.act.<kind>.executor` (`kind` is `auto_archive`, `poke` or `escalate`). An unknown word reads as `node`: a mistyped
/// setting makes the engine stand down, never act twice.
pub fn executor(kind: &str) -> Executor {
    let key = match kind {
        "auto_archive" => "devswarm_rt.act.auto_archive.executor",
        "poke" => "devswarm_rt.act.poke.executor",
        "escalate" => "devswarm_rt.act.escalate.executor",
        _ => return Executor::Node,
    };
    resolve_executor(kind, &effective_text(key), crate::dssup::owner())
}

/// The executor a setting word means. `auto` (poke and escalate only) is the engine once the engine owns the supervisor duties,
/// else Node; a word that is not one of the known ones reads as Node.
pub fn resolve_executor(kind: &str, word: &str, owner: crate::dssup::Owner) -> Executor {
    let v = word.trim().to_ascii_lowercase();
    let words = crate::defaults::list("devswarm_wire.executor_words");
    if v == crate::defaults::text("devswarm_wire.executor_auto") && kind != "auto_archive" {
        return if owner == crate::dssup::Owner::Engine { Executor::Engine } else { Executor::Node };
    }
    match words.iter().position(|w| *w == v) {
        Some(0) => Executor::Engine,
        Some(2) => Executor::Off,
        _ => Executor::Node,
    }
}

/// Where the daemon's counters go; a test or a one-shot passes a sink that drops them.
pub type Sink = Arc<dyn Fn(&mut dyn FnMut(&mut Metrics)) + Send + Sync>;

/// The running layer.
pub struct Wire {
    /// The realtime state service.
    pub rt: Rt,
    /// The home directory.
    pub home: PathBuf,
    /// The engine state directory.
    pub state_dir: PathBuf,
    db: Option<Arc<Db>>,
    sink: Sink,
    runner: Box<dyn Runner + Send + Sync>,
    last_act: AtomicI64,
    act_lock: Mutex<()>,
    jev_busy: Arc<AtomicBool>,
    exec: Box<dyn Fn(&str) -> Executor + Send + Sync>,
    env: RequestEnv,
    act_gap_ms: i64,
    act_pending: AtomicBool,
    dirty: crate::dsact::events::Dirty,
    tele: crate::dsact::tele::Tele,
}

static GLOBAL: OnceLock<Arc<Wire>> = OnceLock::new();

/// The layer of this process, when it was started.
pub fn global() -> Option<&'static Arc<Wire>> {
    GLOBAL.get()
}

fn now_ms() -> i64 {
    crate::health::now_ms() as i64
}

impl Wire {
    /// A layer over an already detected `rt`; starts nothing. The tests and the daemon both build through this.
    pub fn new(rt: Rt, home: &Path, state_dir: &Path, db: Option<Arc<Db>>, sink: Sink, runner: Box<dyn Runner + Send + Sync>) -> Wire {
        Wire {
            rt,
            home: home.to_path_buf(),
            state_dir: state_dir.to_path_buf(),
            db,
            sink,
            runner,
            last_act: AtomicI64::new(0),
            act_lock: Mutex::new(()),
            jev_busy: Arc::new(AtomicBool::new(false)),
            exec: Box::new(executor),
            env: RequestEnv::capture(),
            act_gap_ms: crate::defaults::num("devswarm_wire.act_min_gap_ms") as i64,
            act_pending: AtomicBool::new(false),
            dirty: crate::dsact::events::Dirty::new(),
            tele: crate::dsact::tele::Tele::new(state_dir),
        }
    }

    /// The least time between two unforced action sweeps (tests shorten it).
    pub fn with_act_gap(mut self, ms: i64) -> Wire {
        self.act_gap_ms = ms;
        self
    }

    /// Resolve executors with `f` instead of the layered configuration (tests, which must not read the real home).
    pub fn with_executor(mut self, f: impl Fn(&str) -> Executor + Send + Sync + 'static) -> Wire {
        self.exec = Box::new(f);
        self
    }

    /// Run the actions with this request environment (its HOME selects the settings the actions obey).
    pub fn with_env(mut self, env: RequestEnv) -> Wire {
        self.env = env;
        self
    }

    /// Start the layer in the daemon: nothing at all (no thread, no watcher) unless DevSwarm is detected.
    pub fn start(home: &Path, state_dir: &Path, db: Option<Arc<Db>>, sink: Sink, stop: Arc<dyn Fn() -> bool + Send + Sync>) -> Option<Arc<Wire>> {
        let env: HashMap<String, String> = std::env::vars().collect();
        let rt = crate::devswarm_rt::start(home, &env)?;
        let wire = Arc::new(Wire::new(rt, home, state_dir, db, sink, Box::new(System::configured())));
        if let Some(db) = &wire.db {
            wire.rt.load_persisted(db);
        }
        GLOBAL.set(wire.clone()).ok()?;
        let w = wire.clone();
        std::thread::Builder::new().name("ah-dswire".into()).spawn(move || watching::run(&w, &*stop)).ok()?;
        Some(wire)
    }

    fn count(&self, f: &mut dyn FnMut(&mut Metrics)) {
        (self.sink)(f);
    }

    /// One reconcile for `cause`, then what follows from it: counters, Jev dirty marks, the action sweeps.
    pub fn reconcile(&self, cause: Cause) -> Report {
        let rep = self.rt.run_live(cause, None, self.db.as_deref());
        self.count(&mut |m| self.rt.publish(m));
        if self.rt.mode() != Mode::On {
            return rep;
        }
        let marked = consume::mark_dirty(&self.rt, &self.state_dir, &rep.edges);
        if marked > 0 {
            self.count(&mut |m| m.add("dswire_jev_dirty", &[], marked as u64));
            self.run_jev();
        }
        self.dirty.mark(&rep.edges, now_ms());
        let kinds: Vec<&str> = crate::defaults::list("devswarm_wire.act_edge_kinds");
        let trigger = !matches!(cause, Cause::Event) || rep.edges.iter().any(|e| kinds.contains(&e.kind.as_str()));
        if trigger {
            self.act_sweeps(!matches!(cause, Cause::Event));
        }
        rep
    }

    /// The Jev sweep of the queued workspaces, on its own short-lived thread (a Jev call may wait on a model).
    pub fn run_jev(&self) {
        let only = consume::take_dirty(&self.rt, &self.state_dir);
        if only.is_empty() || self.jev_busy.swap(true, Ordering::SeqCst) {
            if !only.is_empty() {
                consume::queue_ids(&self.state_dir, &only); // a sweep is running: keep them for the next one
            }
            return;
        }
        let home = self.home.clone();
        let busy = self.jev_busy.clone();
        let snap = self.rt.current();
        let spawned = std::thread::Builder::new().name("ah-dswire-jev".into()).spawn(move || {
            let env = crate::jev::settings::Env::process();
            crate::jev::sweep::sweep_rt(&home, &env, now_ms(), Some(&only), Some(&snap));
            busy.store(false, Ordering::SeqCst);
        });
        if spawned.is_err() {
            self.jev_busy.store(false, Ordering::SeqCst);
        }
    }

    /// The automatic action sweeps, once per `act_min_gap_ms` unless `force`. Each action runs only when its executor is the engine.
    pub fn act_sweeps(&self, force: bool) -> Vec<serde_json::Value> {
        let _one = self.act_lock.lock().unwrap_or_else(|e| e.into_inner());
        let now = now_ms();
        if !force && now - self.last_act.load(Ordering::SeqCst) < self.act_gap_ms {
            self.act_pending.store(true, Ordering::SeqCst); // an edge inside the gap is not lost: the thread runs the sweep when the gap has passed
            return Vec::new();
        }
        self.act_pending.store(false, Ordering::SeqCst);
        self.last_act.store(now, Ordering::SeqCst);
        let live = RtLive { rt: &self.rt, home: self.home.clone(), runner: &*self.runner, state_dir: self.state_dir.clone(), env: self.env.clone(), now };
        let act = Act::new(&self.home, &self.state_dir, self.env.clone(), &live, &*self.runner).with_tele(self.tele.clone());
        let kinds = crate::defaults::list("devswarm_wire.act_kinds");
        let mut out = Vec::new();
        let engine = |k: &str| (self.exec)(k) == Executor::Engine;
        // with the event trigger on, an edge archives through the dirty set (events_if_due); the full sweep is the timer's safety net
        let events = act.event_trigger_on() && !force;
        if engine(kinds[0]) && events {
            // nothing here: the event path owns plain edges
        } else if engine(kinds[0]) {
            let s = act.auto_archive_sweep();
            for (k, outcome) in [("archived", "done"), ("failed", "failed")] {
                let n = s.get(k).and_then(|v| v.as_array()).map_or(0, Vec::len) as u64;
                if n > 0 {
                    self.count(&mut |m| m.add("dswire_actions", &[("kind", "auto-archive"), ("outcome", outcome)], n));
                }
            }
            out.push(s);
        } else {
            self.count(&mut |m| m.inc("dswire_standdown", &[("kind", kinds[0])]));
        }
        // the double-run guard: Node's supervisor is still sweeping (its log is fresh), so it may poke and escalate; the engine
        // stands down for both until it has been switched off
        let node_alive = crate::dssup::node_running(&self.home, now).is_some();
        let (poke, esc) = (engine(kinds[1]) && !node_alive, engine(kinds[2]) && !node_alive);
        if poke || esc {
            let allow = |k: &str| (k == "poke" && poke) || (k == "escalate" && esc);
            for r in act.poke_sweep_for(&allow) {
                self.after_nudge(&r, now);
                self.count(&mut |m| m.inc("dswire_actions", &[("kind", &r.kind), ("outcome", r.word.text())]));
                out.push(r.json());
            }
        }
        if force {
            act.mistake_scan();
        }
        if force {
            self.nag(&act);
        }
        self.count(&mut |m| act.tele().publish(m));
        for (k, on) in [(kinds[1], poke), (kinds[2], esc)] {
            if !on {
                self.count(&mut |m| m.inc("dswire_standdown", &[("kind", k)]));
            }
        }
        out
    }

    fn after_nudge(&self, r: &crate::dsact::exec::Report, now: i64) {
        if r.word != Word::Done {
            return;
        }
        match r.kind.as_str() {
            "poke" => {
                let attempt = r.key.rsplit(':').next().and_then(|n| n.parse().ok());
                nudges::record(&self.state_dir, &r.id, attempt, now);
                if let Some(n) = attempt {
                    crate::dssup::verdict::mirror_poke(&self.home, &r.id, n, now);
                }
            }
            "escalate" => {
                nudges::record(&self.state_dir, &r.id, None, now);
                crate::dssup::verdict::mirror_escalate(&self.home, &r.id, now);
                // the one-time notice to the parent, by Node's own function (best effort; a parked notice is retried by the liveness sweep)
                if let Some(root) = crate::defaults::root() {
                    let st = crate::checks::git::util::Settings::from_env(&self.env);
                    crate::dssup::tick::notify_escalation(&*self.runner, &self.home, &root, &st, &r.id);
                }
            }
            _ => {}
        }
    }

    /// The "done but open" nag pass (feature 2): queues the text for the Primary's next prompt.
    fn nag(&self, act: &Act<'_>) {
        act.nag_tick(&crate::dsact::nag::PendingFile(self.state_dir.clone()));
    }

    /// Archive the workspaces an edge marked dirty once they have been quiet for the debounce time (feature 3). Cheap when nothing
    /// is waiting. Runs only when the engine is the auto-archive executor.
    pub fn events_if_due(&self) {
        if self.dirty.pending() == 0 || self.rt.mode() != Mode::On || (self.exec)(crate::defaults::list("devswarm_wire.act_kinds")[0]) != Executor::Engine {
            return;
        }
        let _one = self.act_lock.lock().unwrap_or_else(|e| e.into_inner());
        let now = now_ms();
        let live = RtLive { rt: &self.rt, home: self.home.clone(), runner: &*self.runner, state_dir: self.state_dir.clone(), env: self.env.clone(), now };
        let act = Act::new(&self.home, &self.state_dir, self.env.clone(), &live, &*self.runner).with_tele(self.tele.clone());
        let s = act.auto_archive_events(&self.dirty);
        let n = s.get("archived").and_then(|v| v.as_array()).map_or(0, Vec::len) as u64;
        if n > 0 {
            self.count(&mut |m| m.add("dswire_actions", &[("kind", "auto-archive"), ("outcome", "done")], n));
        }
        self.count(&mut |m| act.tele().publish(m));
    }

    /// Run the sweep an edge asked for while the gap was still open, once the gap has passed. Cheap when nothing is pending.
    pub fn act_if_pending(&self) {
        if self.act_pending.load(Ordering::SeqCst) && self.rt.mode() == Mode::On {
            self.act_sweeps(false);
        }
    }

    /// Whether an edge of kind `k` is one the action sweeps react to (for the watcher's decision).
    pub fn act_kind(k: EdgeKind) -> bool {
        crate::defaults::list("devswarm_wire.act_edge_kinds").contains(&k.as_str())
    }
}

impl Wire {
    pub(crate) fn count_dirty(&self, n: usize) {
        self.count(&mut |m| m.add("dswire_jev_dirty", &[], n as u64));
    }
}

/// The scheduled safety-net job: one periodic reconcile (and the action sweeps that follow it). Inert where the layer did not start.
pub fn scheduled() -> String {
    match global() {
        Some(w) => {
            let r = w.reconcile(Cause::Periodic);
            serde_json::json!({"generation": r.generation, "edges": r.edges.len(), "repairs": r.repairs}).to_string()
        }
        None => String::new(),
    }
}

impl Wire {
    pub(crate) fn count_advisory(&self) {
        self.count(&mut |m| m.inc("dswire_advisory", &[]));
    }
}
