//! Storage behind a trait (D19, D22): everything the engine remembers goes through [`Store`].
//!
//! Why a trait: the daemon keeps its records in the embedded SQLite pair (`hot.db`, `archive.db`, D21) through
//! [`SqliteStore`], and the rest of the engine does not care which backend it has. [`MemStore`] is the in-memory
//! implementation: bounded, lost when the process exits, used by tests and as the daemon's fallback when storage cannot
//! open (hooks never depend on storage, D9).
// Discard triage (E3): every `.ok()` / `unwrap_or_default()` in this file is a deliberate keep, for these reasons:
// - an absent field is the empty value
// - text that does not parse or decode is the absent value (Node Number()/JSON.parse catch parity)
// A failure that must be seen goes through `crate::discard` instead.

use crate::db::{Db, Op};
use crate::discard::Logged;
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
    /// The database behind this store, when it has one (telemetry persists through it, D78).
    fn db(&self) -> Option<Arc<Db>> {
        None
    }
    /// Keep a metrics snapshot (exported counters and histograms, D51); true when it was kept.
    fn save_metrics(&self, ts_ms: u64, body: &serde_json::Value) -> bool;
    /// The last metrics snapshot kept, with its time.
    fn load_metrics(&self) -> Option<(u64, serde_json::Value)>;
    /// Rollups of `resolution` from `since_ms` on, oldest first, as `{bucket_ms, ts_ms, metrics}`.
    fn rollups(&self, resolution: &str, since_ms: u64) -> Vec<serde_json::Value>;
}

/// The configured rollup resolutions: (name, bucket length in ms, how long rollups are kept in ms).
pub fn resolutions() -> Vec<(&'static str, u64, u64)> {
    crate::defaults::raw("telemetry.rollups")
        .as_array()
        .unwrap_or_default()
        .iter()
        .filter_map(|r| {
            let n = |k: &str| r.get(k).and_then(crate::defaults::V::as_integer).map(|v| v.max(1) as u64 * 1000);
            Some((r.get("name")?.as_str()?, n("bucket_s")?, n("keep_s")?))
        })
        .collect()
}

/// The in-memory store: a ring of recent events plus exact per-combination counters.
pub struct MemStore {
    inner: Mutex<MemInner>,
    metrics: Mutex<Option<(u64, serde_json::Value)>>,
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
        MemStore { inner: Mutex::new(inner), metrics: Mutex::new(None) }
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

    fn save_metrics(&self, ts_ms: u64, body: &serde_json::Value) -> bool {
        *self.metrics.lock().unwrap_or_else(|e| e.into_inner()) = Some((ts_ms, body.clone()));
        true
    }

    fn load_metrics(&self) -> Option<(u64, serde_json::Value)> {
        self.metrics.lock().unwrap_or_else(|e| e.into_inner()).clone()
    }

    fn rollups(&self, _: &str, _: u64) -> Vec<serde_json::Value> {
        Vec::new() // memory keeps only the latest snapshot
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
        crate::discard::logged("db_barrier", self.db.barrier());
        self.db
            .read(|c| {
                let mut st = c.prepare_cached(sql::IMPACT_TOTALS)?;
                let rows = st.query_map(rusqlite::params![f.kind, f.project], |r| {
                    Ok(ImpactCount { kind: r.get(0)?, check: r.get(1)?, reason: r.get(2)?, project: r.get(3)?, count: r.get::<_, i64>(4)?.max(0) as u64 })
                })?;
                rows.collect()
            })
            .or_default_logged("db_read")
    }

    fn recent_impact(&self, f: &ImpactFilter, limit: usize) -> Vec<ImpactEvent> {
        crate::discard::logged("db_barrier", self.db.barrier());
        let mut v: Vec<ImpactEvent> = self
            .db
            .read(|c| {
                let mut st = c.prepare_cached(sql::IMPACT_RECENT)?;
                let rows = st.query_map(rusqlite::params![f.kind, f.project, limit as i64], |r| {
                    Ok(ImpactEvent { ts_ms: r.get::<_, i64>(0)?.max(0) as u64, kind: r.get(1)?, check: r.get(2)?, reason: r.get(3)?, project: r.get(4)? })
                })?;
                rows.collect()
            })
            .or_default_logged("db_read");
        v.reverse();
        v
    }

    fn held_events(&self) -> usize {
        crate::discard::logged("db_barrier", self.db.barrier());
        self.db.read(|c| c.query_row(sql::IMPACT_HELD, [], |r| r.get::<_, i64>(0))).map(|n| n.max(0) as usize).unwrap_or(0)
    }

    fn persisted(&self) -> bool {
        true
    }

    fn db(&self) -> Option<Arc<Db>> {
        Some(self.db.clone())
    }

    fn dropped(&self) -> u64 {
        self.dropped.load(SeqCst)
    }

    /// The snapshot goes to hot.db (acknowledged after commit), then into each resolution's rollup bucket in
    /// archive.db (replaced while the bucket is current, so each bucket ends up holding its last snapshot).
    fn save_metrics(&self, ts_ms: u64, body: &serde_json::Value) -> bool {
        let text = body.to_string();
        if self.db.write(Op::Metrics { ts_ms, body: text.clone() }).is_err() {
            return false;
        }
        crate::discard::harmless(self.db.archive(|c| {
            for (name, bucket, _) in resolutions() {
                c.prepare_cached(sql::ROLLUP_SAVE)?.execute(rusqlite::params![name, (ts_ms - ts_ms % bucket) as i64, ts_ms as i64, text])?;
            }
            Ok(())
        })); // keep: formatting into a String cannot fail
        true
    }

    fn load_metrics(&self) -> Option<(u64, serde_json::Value)> {
        let (ts, body): (i64, String) =
            self.db.read(|c| c.query_row(sql::METRICS_LOAD, [], |r| Ok((r.get(0)?, r.get(1)?)))).ok_logged("storage_metrics_load")?;
        Some((ts.max(0) as u64, serde_json::from_str(&body).ok()?))
    }

    fn rollups(&self, resolution: &str, since_ms: u64) -> Vec<serde_json::Value> {
        self.db
            .archive(|c| {
                let mut st = c.prepare_cached(sql::ROLLUP_LIST)?;
                let rows = st.query_map(rusqlite::params![resolution, since_ms as i64], |r| {
                    let body: String = r.get(2)?;
                    Ok(serde_json::json!({"bucket_ms": r.get::<_, i64>(0)?, "ts_ms": r.get::<_, i64>(1)?, "metrics": serde_json::from_str::<serde_json::Value>(&body).unwrap_or_default()}))
                })?;
                Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
            })
            .or_default_logged("db_read")
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
    fn metrics_snapshots_and_rollups_survive_reopening() {
        let d = crate::db::TempDir::new("metrics");
        let body = serde_json::json!({"counters": {"requests": 7}, "histograms": {}});
        {
            let s = SqliteStore::new(Db::open(&d.0).unwrap());
            assert!(s.save_metrics(120_000, &body));
            assert!(s.save_metrics(130_000, &serde_json::json!({"counters": {"requests": 9}, "histograms": {}})));
        }
        let s = SqliteStore::new(Db::open(&d.0).unwrap());
        let (ts, b) = s.load_metrics().unwrap();
        assert_eq!((ts, b["counters"]["requests"].as_u64()), (130_000, Some(9)), "the newest snapshot");
        let (name, _, _) = resolutions()[0];
        let r = s.rollups(name, 0);
        assert_eq!(r.len(), 1, "both snapshots fall in one bucket, which keeps the last: {r:?}");
        assert_eq!(r[0]["metrics"]["counters"]["requests"], 9);
        let m = MemStore::new(1, 1, "o");
        assert!(m.load_metrics().is_none() && m.save_metrics(1, &body) && m.load_metrics().is_some());
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
