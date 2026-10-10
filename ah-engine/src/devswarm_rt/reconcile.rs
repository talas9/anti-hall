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
use crate::mem::{Owner, Spec};
use crate::metrics::Metrics;
use serde::{Deserialize, Serialize};
use std::collections::VecDeque;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, RwLock, Weak};

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

struct Hold {
    cur: RwLock<Arc<Snapshot>>,
    edges: Mutex<VecDeque<Edge>>,
    generations: Mutex<Vec<Weak<Snapshot>>>,
}

impl Hold {
    fn new() -> Hold {
        let cur = Arc::new(Snapshot::default());
        Hold { cur: RwLock::new(cur.clone()), edges: Mutex::new(VecDeque::new()), generations: Mutex::new(vec![Arc::downgrade(&cur)]) }
    }

    fn generation_bytes_locked(generations: &mut Vec<Weak<Snapshot>>) -> usize {
        generations.retain(|w| w.strong_count() > 0);
        generations.iter().filter_map(Weak::upgrade).map(|s| s.estimated_bytes()).sum()
    }

    fn edge_bytes_locked(edges: &VecDeque<Edge>) -> usize {
        edges.iter().map(Edge::estimated_bytes).sum()
    }

    fn bytes_from_locks(generations: &mut Vec<Weak<Snapshot>>, edges: &VecDeque<Edge>) -> usize {
        Self::generation_bytes_locked(generations) + Self::edge_bytes_locked(edges)
    }

    fn set_current(&self, snap: Arc<Snapshot>) {
        *self.cur.write().unwrap_or_else(|e| e.into_inner()) = snap.clone();
        let mut generations = self.generations.lock().unwrap_or_else(|e| e.into_inner());
        generations.retain(|w| w.strong_count() > 0);
        if !generations.iter().any(|w| w.ptr_eq(&Arc::downgrade(&snap))) {
            generations.push(Arc::downgrade(&snap));
        }
    }

    fn shrink_to(&self, target: usize) {
        let mut edges = self.edges.lock().unwrap_or_else(|e| e.into_inner());
        let mut generations = self.generations.lock().unwrap_or_else(|e| e.into_inner());
        while Self::bytes_from_locks(&mut generations, &edges) > target && edges.pop_front().is_some() {}
        if Self::bytes_from_locks(&mut generations, &edges) <= target {
            return;
        }
        let mut cur = self.cur.write().unwrap_or_else(|e| e.into_inner());
        let mut next = (**cur).clone();
        while Self::edge_bytes_locked(&edges) + next.estimated_bytes() > target && next.workspaces.pop_last().is_some() {}
        let next = Arc::new(next);
        generations.push(Arc::downgrade(&next));
        *cur = next;
    }

    fn clear(&self) {
        self.edges.lock().unwrap_or_else(|e| e.into_inner()).clear();
        self.set_current(Arc::new(Snapshot::default()));
    }
}

impl Owner for Hold {
    fn bytes(&self) -> usize {
        let edges = self.edges.lock().unwrap_or_else(|e| e.into_inner());
        let mut generations = self.generations.lock().unwrap_or_else(|e| e.into_inner());
        Self::bytes_from_locks(&mut generations, &edges)
    }

    fn shrink(&self, target: usize) {
        self.shrink_to(target);
    }

    fn recycle(&self) {
        self.clear();
    }
}

/// The DevSwarm workspace state service.
pub struct Rt {
    cfg: Cfg,
    det: Detection,
    hold: Arc<Hold>,
    budget: crate::mem::Budget,
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
        let hold = Arc::new(Hold::new());
        let owner: Arc<dyn Owner> = hold.clone();
        let budget = crate::mem::global().register(
            Spec::new("devswarm_rt", "mem.devswarm_rt_soft_bytes", "mem.devswarm_rt_hard_bytes", "mem.devswarm_rt_low_water_pct")
                .with_entries("mem.devswarm_rt_max_edges"),
            Arc::downgrade(&owner),
        );
        Rt {
            cfg,
            det,
            hold,
            budget,
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
        self.hold.cur.read().unwrap_or_else(|e| e.into_inner()).clone()
    }

    /// One workspace.
    pub fn workspace(&self, id: &str) -> Option<Workspace> {
        self.current().workspaces.get(id).cloned()
    }

    /// The edges newer than `generation`, oldest first (what a session has not seen yet).
    pub fn edges_since(&self, generation: u64) -> Vec<Edge> {
        self.hold.edges.lock().unwrap_or_else(|e| e.into_inner()).iter().filter(|e| e.generation > generation).cloned().collect()
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
        self.hold.set_current(Arc::new(snap));
        self.budget.observe();
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
            let mut log = self.hold.edges.lock().unwrap_or_else(|e| e.into_inner());
            log.extend(edges.iter().cloned());
            let mem_edges = self.budget.max_entries();
            let max_edges = if mem_edges > 0 { mem_edges.min(self.cfg.edge_cap) } else { self.cfg.edge_cap };
            while log.len() > max_edges {
                log.pop_front();
            }
        }
        let report = Report { generation: next.generation, edges: edges.clone(), repairs };
        self.hold.set_current(Arc::new(next));
        self.budget.observe();
        let next = self.current();
        super::linefile::write(&next);
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
        self.hold.edges.lock().unwrap_or_else(|e| e.into_inner()).iter().filter(|e| e.kind == kind).cloned().collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::devswarm_rt::state::{Activity, Field, Lifecycle, Paused, PrView, Src};
    use std::collections::BTreeMap;

    fn field<T>(value: T) -> Field<T> {
        Field { value, source: Src::AppDb, observed_ms: 1, sig: "sig".into() }
    }

    fn workspace(id: &str) -> Workspace {
        Workspace {
            id: id.to_string(),
            label: Some(format!("label-{id}")),
            worktree: Some(format!("/tmp/{id}")),
            branch: Some("branch".into()),
            repo: Some("repo".into()),
            lifecycle: field(Lifecycle::Active),
            paused: field(Paused::No),
            activity: field(Activity::Working),
            unread: field(Some(1usize)),
            plan_step: field(Some("step".into())),
            last_activity_ms: field(Some(1i64)),
            pr: field(None::<PrView>),
        }
    }

    fn edge(n: u64) -> Edge {
        Edge {
            ws: format!("w{n}"),
            kind: EdgeKind::Activity,
            from: "old".into(),
            to: "new".into(),
            generation: n,
            at_ms: 1,
            while_down: false,
            hold_until_ms: 0,
        }
    }

    #[test]
    fn holder_shrinks_edges_before_snapshot_to_byte_cap() {
        let h = Hold::new();
        *h.edges.lock().unwrap() = VecDeque::from([edge(1), edge(2)]);
        let mut workspaces = BTreeMap::new();
        workspaces.insert("a".into(), workspace("a"));
        workspaces.insert("b".into(), workspace("b"));
        h.set_current(Arc::new(Snapshot { generation: 1, at_ms: 1, seeded: true, app_readable: true, workspaces }));
        let empty = Snapshot::default().estimated_bytes();
        h.shrink(empty);
        assert!(h.bytes() <= empty);
        assert!(h.edges.lock().unwrap().is_empty());
        assert!(h.cur.read().unwrap().workspaces.is_empty());
    }

    #[test]
    fn holder_recycle_clears_snapshot_and_edges() {
        let h = Hold::new();
        *h.edges.lock().unwrap() = VecDeque::from([edge(1)]);
        let mut workspaces = BTreeMap::new();
        workspaces.insert("a".into(), workspace("a"));
        h.set_current(Arc::new(Snapshot { generation: 1, at_ms: 1, seeded: true, app_readable: true, workspaces }));
        h.recycle();
        assert!(h.edges.lock().unwrap().is_empty());
        assert!(h.cur.read().unwrap().workspaces.is_empty());
    }

    #[test]
    fn externally_held_old_snapshots_stay_accounted_until_drop() {
        let h = Hold::new();
        let mut old_workspaces = BTreeMap::new();
        old_workspaces.insert("old".into(), workspace("old"));
        let old = Arc::new(Snapshot { generation: 1, at_ms: 1, seeded: true, app_readable: true, workspaces: old_workspaces });
        let old_bytes = old.estimated_bytes();
        h.set_current(old.clone());
        h.set_current(Arc::new(Snapshot::default()));
        assert!(h.bytes() >= Snapshot::default().estimated_bytes() + old_bytes);
        drop(old);
        assert_eq!(h.bytes(), Snapshot::default().estimated_bytes());
    }
}
