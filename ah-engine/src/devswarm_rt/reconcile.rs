//! The live store and the reconciler: one atomically swapped [`Snapshot`], the bounded edge log, the start-up diff against
//! the persisted state, and the repair count that measures the event layer.
//!
//! Every path (an event hint, the periodic tick, an overflow, start-up) is the same operation: read all sources, derive a
//! snapshot, diff it against the current one. What differs is only how the resulting edges are classified:
//! * `Startup`: edges are flagged `while_down` (they happened while the engine was not running) and carry a notify hold.
//! * `Event`: the normal path.
//! * `Periodic` / `Overflow`: any edge found here is one the event path did not apply, so it counts in `rt_reconcile_repairs`.
use crate::db::{Db, Op, RtEdgeRow, RtOp, RtRow};
use crate::devswarm_rt::detect::{Detection, Mode};
use crate::devswarm_rt::sources::{self, FsProbe, GithubState, Probe};
use crate::devswarm_rt::state::{self, Cfg, Edge, EdgeKind, Inputs, Snapshot, Workspace};
use crate::metrics::Metrics;
use serde::{Deserialize, Serialize};
use std::collections::VecDeque;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, RwLock};

/// Why a reconcile runs.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Cause {
    /// The engine started: compare with the persisted state.
    Startup,
    /// A source change hint.
    Event,
    /// The `reconcile_ms` tick.
    Periodic,
    /// The event layer dropped events (queue overflow, `Rescan`).
    Overflow,
}

/// What one run produced.
#[derive(Debug, Clone, PartialEq)]
pub struct Report {
    /// The generation after the run.
    pub generation: u64,
    /// The changes found.
    pub edges: Vec<Edge>,
    /// How many of them an event should have delivered (counted in `rt_reconcile_repairs`).
    pub repairs: u64,
}

/// The persisted body of one workspace: the record and the generation it was written at.
#[derive(Serialize, Deserialize)]
struct Stored {
    generation: u64,
    ws: Workspace,
}

/// The DevSwarm workspace state service.
pub struct Rt {
    cfg: Cfg,
    det: Detection,
    cur: RwLock<Arc<Snapshot>>,
    edges: Mutex<VecDeque<Edge>>,
    repairs: AtomicU64,
    emitted: AtomicU64,
    mismatches: AtomicU64,
    published: Mutex<(u64, u64, u64)>,
    /// Serialises runs: two overlapping reconciles would diff against the same base and double-emit.
    run: Mutex<()>,
}

impl Rt {
    /// A service with an empty, unseeded state.
    pub fn new(cfg: Cfg, det: Detection) -> Rt {
        Rt {
            cfg,
            det,
            cur: RwLock::new(Arc::new(Snapshot::default())),
            edges: Mutex::new(VecDeque::new()),
            repairs: AtomicU64::new(0),
            emitted: AtomicU64::new(0),
            mismatches: AtomicU64::new(0),
            published: Mutex::new((0, 0, 0)),
            run: Mutex::new(()),
        }
    }

    /// The configured mode (consumers act only on `On`).
    pub fn mode(&self) -> Mode {
        self.det.mode
    }

    /// How often the owner of the event layer should call [`Rt::run`] with [`Cause::Periodic`].
    pub fn reconcile_interval(&self) -> std::time::Duration {
        std::time::Duration::from_millis(self.cfg.reconcile_ms.max(0) as u64)
    }

    /// Compare the current state with the Node witness, append the differences to the shadow log and count them
    /// (`rt_shadow_mismatches`). Returns the differences; `None` when the witness has not produced its files.
    pub fn shadow_compare(&self) -> Option<Vec<crate::devswarm_rt::shadow::Mismatch>> {
        use crate::devswarm_rt::shadow;
        let snap = self.current();
        let found = shadow::compare(&snap, &shadow::witness_dir(&self.det.home))?;
        self.mismatches.fetch_add(found.len() as u64, Ordering::Relaxed);
        if let Some(log) = shadow::log_path()
            && let Err(e) = shadow::append(&log, snap.at_ms, snap.generation, &found)
        {
            crate::discard::note("rt_shadow_log", &e.to_string());
        }
        Some(found)
    }

    /// What detection found at start.
    pub fn detection(&self) -> &Detection {
        &self.det
    }

    /// The settings in use.
    pub fn cfg(&self) -> &Cfg {
        &self.cfg
    }

    /// The current snapshot (read API for consumers; never blocks on a reconcile's reads).
    pub fn current(&self) -> Arc<Snapshot> {
        self.cur.read().unwrap_or_else(|e| e.into_inner()).clone()
    }

    /// One workspace.
    pub fn workspace(&self, id: &str) -> Option<Workspace> {
        self.current().workspaces.get(id).cloned()
    }

    /// The edges newer than `generation`, oldest first (what a session has not seen yet).
    pub fn edges_since(&self, generation: u64) -> Vec<Edge> {
        self.edges.lock().unwrap_or_else(|e| e.into_inner()).iter().filter(|e| e.generation > generation).cloned().collect()
    }

    /// Changes found by a periodic or overflow reconcile that events had not applied.
    pub fn repairs(&self) -> u64 {
        self.repairs.load(Ordering::Relaxed)
    }

    /// Load the state persisted by an earlier run, so the start-up reconcile can diff against it. Rows that do not parse are
    /// skipped (they are treated as new). Returns how many rows were loaded.
    pub fn load_persisted(&self, db: &Db) -> usize {
        let ns = self.cfg.namespace.clone();
        let rows: Vec<(String, String, i64)> = db
            .read(|c| {
                let mut st = c.prepare_cached(crate::sql::RT_ENTITY_ALL)?;
                st.query_map(rusqlite::params![ns], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, i64>(3)?))).and_then(|it| it.collect())
            })
            .unwrap_or_default(); // keep: unreadable persisted state means a fresh start, which seeds without edges
        let mut snap = Snapshot::default();
        for (key, body, observed) in rows {
            match serde_json::from_str::<Stored>(&body) {
                Ok(s) => {
                    snap.generation = snap.generation.max(s.generation);
                    snap.at_ms = snap.at_ms.max(observed);
                    snap.workspaces.insert(key, s.ws);
                }
                Err(e) => crate::discard::note("rt_persisted_row", &e.to_string()),
            }
        }
        snap.seeded = !snap.workspaces.is_empty();
        let n = snap.workspaces.len();
        *self.cur.write().unwrap_or_else(|e| e.into_inner()) = Arc::new(snap);
        n
    }

    /// Read the sources from the real home and reconcile (the production path).
    pub fn run_live(&self, cause: Cause, gh: Option<&dyn GithubState>, db: Option<&Db>) -> Report {
        let now = crate::health::now_ms() as i64;
        let probe = FsProbe::new(&self.det.home, now);
        let app = self.det.app_db.as_deref().and_then(sources::read_app);
        self.run(cause, &Inputs { app: app.as_ref(), probe: &probe as &dyn Probe, gh, now }, db)
    }

    /// Reconcile against the given sources: derive, diff, swap, remember the edges, persist.
    pub fn run(&self, cause: Cause, inp: &Inputs<'_>, db: Option<&Db>) -> Report {
        let _one_at_a_time = self.run.lock().unwrap_or_else(|e| e.into_inner());
        let prev = self.current();
        let mut next = state::derive(&self.cfg, inp, &prev);
        let (edges, repairs) = if !prev.seeded {
            // the first read ever (no persisted state): seed without claiming anything changed
            next.seeded = inp.app.is_some();
            (Vec::new(), 0)
        } else {
            let generation = prev.generation + 1;
            let e = state::diff(&prev, &next, &self.cfg, generation, inp.now, cause == Cause::Startup);
            let repairs = if matches!(cause, Cause::Periodic | Cause::Overflow) { e.len() as u64 } else { 0 };
            (e, repairs)
        };
        next.generation = if edges.is_empty() { prev.generation } else { prev.generation + 1 };
        if !edges.is_empty() {
            self.repairs.fetch_add(repairs, Ordering::Relaxed);
            self.emitted.fetch_add(edges.len() as u64, Ordering::Relaxed);
            let mut log = self.edges.lock().unwrap_or_else(|e| e.into_inner());
            log.extend(edges.iter().cloned());
            while log.len() > self.cfg.edge_cap {
                log.pop_front();
            }
        }
        let report = Report { generation: next.generation, edges: edges.clone(), repairs };
        let next = Arc::new(next);
        *self.cur.write().unwrap_or_else(|e| e.into_inner()) = next.clone();
        if let Some(db) = db
            && next.app_readable
        {
            self.persist(db, &next, &edges);
        }
        report
    }

    fn persist(&self, db: &Db, snap: &Snapshot, edges: &[Edge]) {
        let rows = snap
            .workspaces
            .values()
            .filter_map(|w| {
                let body = serde_json::to_string(&Stored { generation: snap.generation, ws: w.clone() }).ok()?;
                Some(RtRow { key: w.id.clone(), body, src_sig: w.lifecycle.sig.clone(), observed_ms: snap.at_ms })
            })
            .collect();
        let edges = edges
            .iter()
            .map(|e| RtEdgeRow {
                key: e.ws.clone(),
                kind: e.kind.as_str().to_string(),
                from: e.from.clone(),
                to: e.to.clone(),
                generation: e.generation as i64,
                at_ms: e.at_ms,
                while_down: e.while_down,
            })
            .collect();
        let op = RtOp { ns: self.cfg.namespace.clone(), rows, edges, edge_cap: self.cfg.edge_cap as i64 };
        if let Err(e) = db.submit(Op::Rt(op)) {
            crate::discard::note("rt_persist", &e.to_string());
        }
    }

    /// Add what happened since the last call to the engine's counters (`rt_reconcile_repairs`, `rt_edges`).
    pub fn publish(&self, m: &mut Metrics) {
        let (r, e, x) = (self.repairs.load(Ordering::Relaxed), self.emitted.load(Ordering::Relaxed), self.mismatches.load(Ordering::Relaxed));
        let mut p = self.published.lock().unwrap_or_else(|x| x.into_inner());
        m.add("rt_reconcile_repairs", &[], r - p.0);
        m.add("rt_edges", &[], e - p.1);
        m.add("rt_shadow_mismatches", &[], x - p.2);
        *p = (r, e, x);
    }

    /// Edges of one kind in the retained log (diagnostics and tests).
    pub fn edges_of(&self, kind: EdgeKind) -> Vec<Edge> {
        self.edges.lock().unwrap_or_else(|e| e.into_inner()).iter().filter(|e| e.kind == kind).cloned().collect()
    }
}
