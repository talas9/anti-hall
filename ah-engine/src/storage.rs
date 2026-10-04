//! Storage behind a trait (D19, D22): everything the engine remembers goes through [`Store`].
//!
//! Why a trait: the daemon keeps its records in the embedded SQLite pair (`hot.db`, `archive.db`, D21) through
//! [`SqliteStore`], and the rest of the engine does not care which backend it has. [`MemStore`] is the in-memory
//! implementation: bounded, lost when the process exits, used by tests and as the daemon's fallback when storage cannot
//! open (hooks never depend on storage, D9).
use crate::db::{Db, Op};
use crate::sql;
use std::collections::{HashMap, VecDeque};
use std::sync::atomic::{AtomicU64, Ordering::SeqCst};
use std::sync::{Arc, Mutex};

/// One thing the engine did that affected a call (D52). The project is a hashed key, never a path.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ImpactEvent {
    /// When it happened, milliseconds since the Unix epoch.
    pub ts_ms: u64,
    /// Stable kind, one of the registered `impact.*` names.
    pub kind: String,
    /// The check that acted (empty for rule matches and request-level events).
    pub check: String,
    /// The reason code: the rule or check id for a block, the failure class for a fallback.
    pub reason: String,
    /// Hashed project key.
    pub project: String,
}

/// Which events a query wants; an empty field matches everything.
#[derive(Debug, Clone, Default)]
pub struct ImpactFilter {
    /// Only this kind.
    pub kind: String,
    /// Only this hashed project key.
    pub project: String,
}

/// Exact counts of one (kind, check, reason, project) combination.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ImpactCount {
    /// Impact kind.
    pub kind: String,
    /// Check name, possibly empty.
    pub check: String,
    /// Reason code, possibly empty.
    pub reason: String,
    /// Hashed project key.
    pub project: String,
    /// Occurrences.
    pub count: u64,
}

/// What the engine stores. Implementations must keep memory bounded: a store whose memory grows without limit is a bug
/// (D25). Every method takes `&self`, so callers hold no lock of their own across a store call (D9).
pub trait Store: Send + Sync {
    /// Remember one impact event.
    fn record_impact(&self, event: ImpactEvent);
    /// Exact counts per combination, filtered.
    fn impact_counts(&self, filter: &ImpactFilter) -> Vec<ImpactCount>;
    /// The most recent events, newest last, filtered, at most `limit`.
    fn recent_impact(&self, filter: &ImpactFilter, limit: usize) -> Vec<ImpactEvent>;
    /// How many events are held right now (not the exact total: see `impact_counts`).
    fn held_events(&self) -> usize;
    /// True when what is recorded survives a restart.
    fn persisted(&self) -> bool {
        false
    }
    /// Events that could not be recorded (the writer queue was full).
    fn dropped(&self) -> u64 {
        0
    }
}

/// The in-memory store: a ring of recent events plus exact per-combination counters.
pub struct MemStore {
    inner: Mutex<MemInner>,
}

struct MemInner {
    events: VecDeque<ImpactEvent>,
    cap: usize,
    counts: HashMap<(String, String, String, String), u64>,
    max_series: usize,
    overflow: String,
}

impl MemStore {
    /// A store holding at most `cap` events and `max_series` distinct count combinations; combinations beyond that
    /// are counted under `overflow` as their reason, so totals stay exact while memory stays flat.
    pub fn new(cap: usize, max_series: usize, overflow: &str) -> MemStore {
        let inner =
            MemInner { events: VecDeque::new(), cap: cap.max(1), counts: HashMap::new(), max_series: max_series.max(1), overflow: overflow.to_string() };
        MemStore { inner: Mutex::new(inner) }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, MemInner> {
        self.inner.lock().unwrap_or_else(|e| e.into_inner())
    }
}

impl Store for MemStore {
    fn record_impact(&self, e: ImpactEvent) {
        let mut s = self.lock();
        let s = &mut *s;
        let mut key = (e.kind.clone(), e.check.clone(), e.reason.clone(), e.project.clone());
        if !s.counts.contains_key(&key) && s.counts.len() >= s.max_series {
            key = (e.kind.clone(), e.check.clone(), s.overflow.clone(), s.overflow.clone());
        }
        *s.counts.entry(key).or_insert(0) += 1;
        if s.events.len() >= s.cap {
            s.events.pop_front();
        }
        s.events.push_back(e);
    }

    fn impact_counts(&self, f: &ImpactFilter) -> Vec<ImpactCount> {
        let mut out: Vec<ImpactCount> = self
            .lock()
            .counts
            .iter()
            .filter(|((k, _, _, p), _)| (f.kind.is_empty() || *k == f.kind) && (f.project.is_empty() || *p == f.project))
            .map(|((kind, check, reason, project), count)| ImpactCount {
                kind: kind.clone(),
                check: check.clone(),
                reason: reason.clone(),
                project: project.clone(),
                count: *count,
            })
            .collect();
        out.sort_by(|a, b| (&a.kind, &a.check, &a.reason, &a.project).cmp(&(&b.kind, &b.check, &b.reason, &b.project)));
        out
    }

    fn recent_impact(&self, f: &ImpactFilter, limit: usize) -> Vec<ImpactEvent> {
        let mut v: Vec<ImpactEvent> = self
            .lock()
            .events
            .iter()
            .rev()
            .filter(|e| (f.kind.is_empty() || e.kind == f.kind) && (f.project.is_empty() || e.project == f.project))
            .take(limit)
            .cloned()
            .collect();
        v.reverse();
        v
    }

    fn held_events(&self) -> usize {
        self.lock().events.len()
    }
}

/// The durable store: impact events and their exact totals in hot.db (D52), written through the group-committing
/// writer. Recording never waits (the hook path must not wait on storage, D9); a read first waits for the writes
/// queued before it, so it sees them.
pub struct SqliteStore {
    db: Arc<Db>,
    dropped: AtomicU64,
}

impl SqliteStore {
    /// A store over an open database.
    pub fn new(db: Arc<Db>) -> SqliteStore {
        SqliteStore { db, dropped: AtomicU64::new(0) }
    }
}

impl Store for SqliteStore {
    fn record_impact(&self, e: ImpactEvent) {
        if self.db.submit(Op::Impact(e)).is_err() {
            self.dropped.fetch_add(1, SeqCst);
        }
    }

    fn impact_counts(&self, f: &ImpactFilter) -> Vec<ImpactCount> {
        let _ = self.db.barrier();
        self.db
            .read(|c| {
                let mut st = c.prepare_cached(sql::IMPACT_TOTALS)?;
                let rows = st.query_map(rusqlite::params![f.kind, f.project], |r| {
                    Ok(ImpactCount { kind: r.get(0)?, check: r.get(1)?, reason: r.get(2)?, project: r.get(3)?, count: r.get::<_, i64>(4)?.max(0) as u64 })
                })?;
                rows.collect()
            })
            .unwrap_or_default()
    }

    fn recent_impact(&self, f: &ImpactFilter, limit: usize) -> Vec<ImpactEvent> {
        let _ = self.db.barrier();
        let mut v: Vec<ImpactEvent> = self
            .db
            .read(|c| {
                let mut st = c.prepare_cached(sql::IMPACT_RECENT)?;
                let rows = st.query_map(rusqlite::params![f.kind, f.project, limit as i64], |r| {
                    Ok(ImpactEvent { ts_ms: r.get::<_, i64>(0)?.max(0) as u64, kind: r.get(1)?, check: r.get(2)?, reason: r.get(3)?, project: r.get(4)? })
                })?;
                rows.collect()
            })
            .unwrap_or_default();
        v.reverse();
        v
    }

    fn held_events(&self) -> usize {
        let _ = self.db.barrier();
        self.db.read(|c| c.query_row(sql::IMPACT_HELD, [], |r| r.get::<_, i64>(0))).map(|n| n.max(0) as usize).unwrap_or(0)
    }

    fn persisted(&self) -> bool {
        true
    }

    fn dropped(&self) -> u64 {
        self.dropped.load(SeqCst)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ev(kind: &str, reason: &str, project: &str) -> ImpactEvent {
        ImpactEvent { ts_ms: 1, kind: kind.into(), check: "git".into(), reason: reason.into(), project: project.into() }
    }

    #[test]
    fn the_ring_is_bounded_but_counts_stay_exact() {
        let s = MemStore::new(3, 100, "other");
        for _ in 0..10 {
            s.record_impact(ev("block", "force_push", "p1"));
        }
        assert_eq!(s.held_events(), 3);
        let c = s.impact_counts(&ImpactFilter::default());
        assert_eq!(c.len(), 1);
        assert_eq!(c[0].count, 10, "ten blocks happened even though only three events are held");
    }

    #[test]
    fn series_are_bounded_and_overflow_is_still_counted() {
        let s = MemStore::new(10, 2, "other");
        for i in 0..5 {
            s.record_impact(ev("block", &format!("r{i}"), "p"));
        }
        let c = s.impact_counts(&ImpactFilter::default());
        assert!(c.len() <= 3, "two real series plus the overflow series: {c:?}");
        assert_eq!(c.iter().map(|x| x.count).sum::<u64>(), 5);
    }

    /// Behaviour every backend must share.
    fn conformance(s: &dyn Store) {
        s.record_impact(ev("block", "a", "p1"));
        s.record_impact(ev("block", "a", "p1"));
        s.record_impact(ev("warning", "b", "p2"));
        let all = s.impact_counts(&ImpactFilter::default());
        assert_eq!(all.len(), 2);
        assert_eq!(all[0].kind, "block", "sorted by kind");
        assert_eq!(all[0].count, 2);
        let f = ImpactFilter { kind: "warning".into(), project: String::new() };
        assert_eq!(s.impact_counts(&f).len(), 1);
        let recent = s.recent_impact(&ImpactFilter::default(), 2);
        assert_eq!(recent.len(), 2);
        assert_eq!(recent[1].kind, "warning", "newest last");
        assert_eq!(s.held_events(), 3);
        let f = ImpactFilter { kind: String::new(), project: "p2".into() };
        assert_eq!(s.recent_impact(&f, 5)[0].reason, "b");
    }

    #[test]
    fn both_backends_behave_the_same() {
        conformance(&MemStore::new(10, 10, "other"));
        let d = crate::db::TempDir::new("store");
        let db = Db::open(&d.0).unwrap();
        let s = SqliteStore::new(db.clone());
        conformance(&s);
        assert!(s.persisted() && !MemStore::new(1, 1, "o").persisted());
    }

    #[test]
    fn sqlite_records_survive_reopening() {
        let d = crate::db::TempDir::new("reopen");
        {
            let db = Db::open(&d.0).unwrap();
            let s = SqliteStore::new(db.clone());
            for _ in 0..3 {
                s.record_impact(ev("block", "force_push", "p"));
            }
            db.close();
        }
        let s = SqliteStore::new(Db::open(&d.0).unwrap());
        assert_eq!(s.impact_counts(&ImpactFilter::default())[0].count, 3);
    }

    #[test]
    fn filters_apply_to_counts_and_events() {
        let s = MemStore::new(10, 10, "other");
        s.record_impact(ev("block", "a", "p1"));
        s.record_impact(ev("warning", "b", "p2"));
        let f = ImpactFilter { kind: "warning".into(), project: String::new() };
        assert_eq!(s.impact_counts(&f).len(), 1);
        assert_eq!(s.recent_impact(&f, 5).len(), 1);
        let f = ImpactFilter { kind: String::new(), project: "p1".into() };
        assert_eq!(s.recent_impact(&f, 5)[0].reason, "a");
    }
}
