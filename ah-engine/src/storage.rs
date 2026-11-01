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

/// One guard block, for asking about it afterwards. `reason` is the first line of the guard's own message, capped.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct BlockRow {
    /// When it happened, milliseconds since the Unix epoch.
    pub ts_ms: u64,
    /// The check (guard) that blocked.
    pub guard: String,
    /// The id of the rule that named the check.
    pub rule: String,
    /// The hook event being served.
    pub event: String,
    /// The session whose call was blocked.
    pub session: String,
    /// The subagent whose call was blocked (empty for the main thread).
    pub agent: String,
    /// The tool the call used.
    pub tool: String,
    /// Hashed project key.
    pub project: String,
    /// The first line of the block message.
    pub reason: String,
    /// 0, or how many blocks this guard gave this session inside the repeat window when this one was the repeat (`session_switches.toml`).
    pub repeat: u64,
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
    /// Remember one guard block (stores that keep nothing ignore it).
    fn record_block(&self, _row: BlockRow) {}
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
    /// The newest rollup of `resolution` taken at or before `cutoff_ms` as (time, snapshot, true); when none is that old, the
    /// oldest one as (time, snapshot, false); `None` when there is no rollup at all.
    fn rollup_at(&self, _resolution: &str, _cutoff_ms: u64) -> Option<(u64, serde_json::Value, bool)> {
        None
    }
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
    fn record_block(&self, row: BlockRow) {
        if self.db.submit(Op::Block(row)).is_err() {
            self.dropped.fetch_add(1, SeqCst);
        }
    }

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

    fn rollup_at(&self, resolution: &str, cutoff_ms: u64) -> Option<(u64, serde_json::Value, bool)> {
        self.db.archive(|c| Ok(rollup_at_in(c, resolution, cutoff_ms))).or_default_logged("db_read")
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

/// The newest rollup of `resolution` at or before `cutoff_ms` (the snapshot a windowed report starts or ends at) as
/// (time, snapshot, true), else the oldest one as (time, snapshot, false); `None` when there is none or its body is unreadable.
/// Both lookups walk the (resolution, bucket) primary key: no scan, no temporary sort.
fn rollup_at_in(c: &rusqlite::Connection, resolution: &str, cutoff_ms: u64) -> Option<(u64, serde_json::Value, bool)> {
    let row = |sql: &'static str, args: &[&dyn rusqlite::ToSql]| -> Option<(i64, String)> {
        c.prepare_cached(sql).ok_logged("db_read")?.query_row(args, |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?))).ok()
    };
    let cutoff = i64::try_from(cutoff_ms).unwrap_or(i64::MAX);
    let (found, exact) = match row(sql::ROLLUP_AT, &[&resolution, &cutoff]) {
        Some(r) => (r, true),
        None => (row(sql::ROLLUP_OLDEST, &[&resolution])?, false),
    };
    // a body that is not JSON is `null` (the report names it unreadable), not a missing snapshot
    Some((u64::try_from(found.0).unwrap_or(0), serde_json::from_str(&found.1).unwrap_or(serde_json::Value::Null), exact))
}

/// Why the metrics databases cannot be opened for reading.
#[derive(Debug, PartialEq, Eq)]
pub enum ReadOnlyError {
    /// There is no hot.db in the state directory: nothing was ever stored.
    Missing,
    /// The database exists but cannot be read as it is (older or newer schema, or not a database): the message says so.
    Unreadable(String),
}

/// The stored metrics snapshots, opened for reading only (`telemetry report` with no daemon). It never creates a file, never
/// migrates, never writes: both databases are opened `SQLITE_OPEN_READ_ONLY` with `query_only` on, a schema older or newer than this
/// engine's is refused with a message instead of being migrated, and an absent archive.db is simply no rollups (it is not created).
pub struct ReadOnlyStore {
    hot: Mutex<rusqlite::Connection>,
    archive: Option<Mutex<rusqlite::Connection>>,
}

impl ReadOnlyStore {
    /// `file:<path>?immutable=1` with the path percent-encoded (`?`, `#`, `%`, spaces and every other byte outside the URI's unreserved set).
    fn immutable_uri(path: &std::path::Path) -> String {
        let mut out = String::from("file:");
        for b in path.to_string_lossy().bytes() {
            if b.is_ascii_alphanumeric() || matches!(b, b'/' | b'-' | b'_' | b'.' | b'~') {
                out.push(b as char);
            } else {
                out.push_str(&format!("%{b:02X}"));
            }
        }
        out.push_str("?immutable=1");
        out
    }

    /// Open one database file for reading without creating or writing a file. Three cases, from the files beside it (SQLite keeps a
    /// WAL database's `-wal` and `-shm` exactly while a connection is open, deletes them at the last clean close, and a stopped daemon
    /// leaves them with the committed data in the `-wal`):
    /// - none of them: nothing has it open and nothing waits in a log, so it is opened `immutable=1` (SQLite documents: no file locking,
    ///   no change detection, nothing created, works in a read-only directory);
    /// - all of them, and no rollback journal: the data may be in the `-wal`, which `immutable` would silently ignore, so it is opened
    ///   read-only the ordinary way, which creates nothing and refreshes only the derived `-shm` index in place;
    /// - some of them, or a journal: SQLite would have to create or recover files to read it, so the report refuses with a message.
    fn open_file(path: &std::path::Path, migrations: &[&str]) -> Result<rusqlite::Connection, String> {
        use rusqlite::OpenFlags;
        let name = path.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
        let unreadable = |why: String| crate::defaults::render("delivery.report_db_unreadable", &[("db", &name), ("why", &why)]);
        let exists = |suffix: &&str| {
            let mut p = path.as_os_str().to_os_string();
            p.push(suffix);
            std::fs::symlink_metadata(&p).is_ok()
        };
        let pair = crate::defaults::list("delivery.report_db_sidecars");
        let (have, blockers): (Vec<&str>, Vec<&str>) = (
            pair.iter().filter(|s| exists(s)).copied().collect(),
            crate::defaults::list("delivery.report_db_blockers").iter().filter(|s| exists(s)).copied().collect(),
        );
        let flags = OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX;
        let opened = if blockers.is_empty() && have.is_empty() {
            rusqlite::Connection::open_with_flags(Self::immutable_uri(path), flags | OpenFlags::SQLITE_OPEN_URI)
        } else if blockers.is_empty() && have.len() == pair.len() {
            rusqlite::Connection::open_with_flags(path, flags)
        } else {
            let files: Vec<&str> = have.iter().chain(&blockers).copied().collect();
            return Err(crate::defaults::render("delivery.report_db_busy", &[("db", &name), ("files", &files.join(", "))]));
        };
        let c = opened.map_err(|e| unreadable(e.to_string()))?;
        c.busy_timeout(crate::defaults::millis("storage.busy_timeout_ms")).map_err(|e| unreadable(e.to_string()))?;
        c.pragma_update(None, "query_only", true).map_err(|e| unreadable(e.to_string()))?;
        let found: i64 = c.query_row("PRAGMA user_version", [], |r| r.get(0)).map_err(|e| unreadable(e.to_string()))?;
        let known = migrations.len();
        let key = match usize::try_from(found) {
            Ok(f) if f == known => return Ok(c),
            Ok(f) if f < known => "delivery.report_schema_old",
            _ => "delivery.report_schema_new",
        };
        Err(crate::defaults::render(key, &[("db", &name), ("found", &found), ("known", &known)]))
    }

    /// Open the databases of the state directory `dir` for reading.
    pub fn open(dir: &std::path::Path) -> Result<ReadOnlyStore, ReadOnlyError> {
        let hot = dir.join(crate::defaults::text("storage.hot_file"));
        if !hot.exists() {
            return Err(ReadOnlyError::Missing);
        }
        let hot = Self::open_file(&hot, sql::HOT_MIGRATIONS).map_err(ReadOnlyError::Unreadable)?;
        let arch = dir.join(crate::defaults::text("storage.archive_file"));
        let archive = if arch.exists() { Some(Mutex::new(Self::open_file(&arch, sql::ARCHIVE_MIGRATIONS).map_err(ReadOnlyError::Unreadable)?)) } else { None };
        Ok(ReadOnlyStore { hot: Mutex::new(hot), archive })
    }
}

impl Store for ReadOnlyStore {
    fn record_impact(&self, _: ImpactEvent) {}

    fn impact_counts(&self, _: &ImpactFilter) -> Vec<ImpactCount> {
        Vec::new()
    }

    fn recent_impact(&self, _: &ImpactFilter, _: usize) -> Vec<ImpactEvent> {
        Vec::new()
    }

    fn held_events(&self) -> usize {
        0
    }

    fn save_metrics(&self, _: u64, _: &serde_json::Value) -> bool {
        false
    }

    fn load_metrics(&self) -> Option<(u64, serde_json::Value)> {
        let c = self.hot.lock().unwrap_or_else(|e| e.into_inner());
        let (ts, body): (i64, String) = c.query_row(sql::METRICS_LOAD, [], |r| Ok((r.get(0)?, r.get(1)?))).ok_logged("storage_metrics_load")?;
        // a body that is not JSON is returned as `null`, never as "no snapshot": the report names the snapshot unreadable
        Some((u64::try_from(ts).unwrap_or(0), serde_json::from_str(&body).unwrap_or(serde_json::Value::Null)))
    }

    fn rollups(&self, _: &str, _: u64) -> Vec<serde_json::Value> {
        Vec::new()
    }

    fn rollup_at(&self, resolution: &str, cutoff_ms: u64) -> Option<(u64, serde_json::Value, bool)> {
        let c = self.archive.as_ref()?.lock().unwrap_or_else(|e| e.into_inner());
        rollup_at_in(&c, resolution, cutoff_ms)
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
    fn a_snapshot_lookup_walks_the_primary_key_and_returns_the_newest_at_or_before_the_cutoff() {
        let d = crate::db::TempDir::new("rollup-at");
        let db = Db::open(&d.0).unwrap();
        let s = SqliteStore::new(db.clone());
        let (name, bucket, _) = resolutions()[0];
        let body = |n: u64| serde_json::json!({"counters": {"requests": n}, "histograms": {}});
        let (t1, t2) = (9 * bucket + 10, 10 * bucket + bucket / 2);
        assert!(s.save_metrics(t1, &body(1)) && s.save_metrics(t2, &body(2)));
        // the bucket holding the cutoff keeps a LATER snapshot: the lookup steps back to the previous bucket
        assert_eq!(s.rollup_at(name, 10 * bucket + 1).map(|r| (r.0, r.2)), Some((t1, true)));
        assert_eq!(s.rollup_at(name, t2).map(|r| (r.0, r.2)), Some((t2, true)));
        assert_eq!(s.rollup_at(name, u64::MAX).map(|r| (r.0, r.2)), Some((t2, true)), "a cutoff past i64 is clamped, not wrapped");
        assert_eq!(s.rollup_at(name, 5).map(|r| (r.0, r.2)), Some((t1, false)), "none that old: the oldest, marked inexact");
        for (q, args) in [(sql::ROLLUP_AT, 2usize), (sql::ROLLUP_OLDEST, 1usize)] {
            let plan: Vec<String> = db
                .archive(|c| {
                    let mut st = c.prepare(&format!("EXPLAIN QUERY PLAN {q}"))?;
                    let rows: Vec<String> = if args == 2 {
                        st.query_map(rusqlite::params![name, 100_i64], |r| r.get::<_, String>(3))?.collect::<rusqlite::Result<_>>()?
                    } else {
                        st.query_map(rusqlite::params![name], |r| r.get::<_, String>(3))?.collect::<rusqlite::Result<_>>()?
                    };
                    Ok(rows)
                })
                .unwrap();
            let plan = plan.join(" | ");
            assert!(plan.contains("USING PRIMARY KEY") && !plan.contains("SCAN") && !plan.contains("TEMP B-TREE"), "{q}: {plan}");
        }
    }

    #[test]
    fn the_read_only_store_reads_snapshots_and_changes_nothing_and_refuses_a_schema_it_would_have_to_migrate() {
        let snapshot = |dir: &std::path::Path| -> Vec<(String, u64, std::time::SystemTime)> {
            let mut v: Vec<_> = std::fs::read_dir(dir)
                .unwrap()
                .map(|e| e.unwrap())
                .map(|e| (e.file_name().to_string_lossy().to_string(), e.metadata().unwrap().len(), e.metadata().unwrap().modified().unwrap()))
                .collect();
            v.sort();
            v
        };
        let d = crate::db::TempDir::new("ro-store");
        assert_eq!(ReadOnlyStore::open(&d.0).err(), Some(ReadOnlyError::Missing), "no hot.db: nothing is created");
        assert!(std::fs::read_dir(&d.0).unwrap().next().is_none());
        {
            let s = SqliteStore::new(Db::open(&d.0).unwrap());
            assert!(s.save_metrics(120_000, &serde_json::json!({"counters": {"requests": 7}, "histograms": {}})));
        }
        let before = snapshot(&d.0);
        {
            let ro = ReadOnlyStore::open(&d.0).unwrap();
            assert_eq!(ro.load_metrics().map(|(t, b)| (t, b["counters"]["requests"].as_u64())), Some((120_000, Some(7))));
            assert_eq!(ro.rollup_at(resolutions()[0].0, 130_000).map(|r| (r.0, r.2)), Some((120_000, true)));
            assert!(!ro.save_metrics(1, &serde_json::json!({})), "nothing is written");
        }
        // SQLite itself may leave empty -wal / -shm sidecars of a WAL database it opened; the database files are byte-for-byte as they were
        let files = |v: &[(String, u64, std::time::SystemTime)]| v.iter().filter(|f| f.0.ends_with(".db")).cloned().collect::<Vec<_>>();
        assert_eq!(files(&snapshot(&d.0)), files(&before), "hot.db and archive.db: same size and mtime");
        // a schema older than this engine's is reported, never migrated; archive.db is not created when absent
        let old = crate::db::TempDir::new("ro-old");
        {
            let c = rusqlite::Connection::open(old.0.join(crate::defaults::text("storage.hot_file"))).unwrap();
            c.pragma_update(None, "user_version", 8).unwrap();
        }
        let err = match ReadOnlyStore::open(&old.0) {
            Err(ReadOnlyError::Unreadable(m)) => m,
            other => panic!("{:?}", other.err()),
        };
        assert!(err.contains("older") && err.contains("version 8"), "{err}");
        let c = rusqlite::Connection::open(old.0.join(crate::defaults::text("storage.hot_file"))).unwrap();
        assert_eq!(c.query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0)).unwrap(), 8, "still 8: not migrated");
        assert!(!old.0.join(crate::defaults::text("storage.archive_file")).exists(), "archive.db was not created");
        c.pragma_update(None, "user_version", 99).unwrap();
        drop(c);
        assert!(matches!(ReadOnlyStore::open(&old.0).err(), Some(ReadOnlyError::Unreadable(m)) if m.contains("newer")));
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
