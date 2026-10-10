//! The embedded SQLite pair (D19, D21, D23, D73): `hot.db` for frequent small writes, `archive.db` for history.
//!
//! One writer thread owns the hot.db write connection. Requests hand it a [`Op`] over a bounded queue and, when they
//! need an acknowledgement, wait for the reply, which is sent only after the transaction holding the write has
//! committed (D23). Whatever is queued while a commit runs goes into the next transaction, so concurrent writers share
//! one sync (group commit). Each write runs inside its own savepoint, so a refused write never undoes its neighbours.
//!
//! Reads use a second connection (WAL lets them run while the writer commits). archive.db is opened on first use.
//! After a commit the writer also updates the in-memory layer ([`Mem`]: active key-value items and pub/sub, D20, D22),
//! so memory always follows the commit order and never holds anything SQLite does not.
//! Every SQLite setting (journal mode, synchronous level, fullfsync, cache, mmap, timeouts) comes from
//! `defaults/storage.toml`; the schema lives in `sql.rs` and is migrated by version on open.
// Discard triage (E3): every `.ok()` / `unwrap_or_default()` in this file is a deliberate keep, for these reasons:
// - an absent field is the empty value
// - a panicked or timed-out helper yields no output; the caller treats that as no answer
// A failure that must be seen goes through `crate::discard` instead.

use crate::defaults;
use crate::error::DbError;
use crate::error::StoreError;
use crate::sql;
use crate::storage::ImpactEvent;
use crate::tier::{Bus, Tiered};
use rusqlite::{Connection, OpenFlags, OptionalExtension, TransactionBehavior, params};
use std::path::{Path, PathBuf};
use std::sync::mpsc::{self, Receiver, SyncSender, TrySendError};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

/// One write the writer thread applies.
#[derive(Debug, Clone)]
pub enum Op {
    /// Record an impact event and count it in its total (D52).
    Impact(ImpactEvent),
    /// No change: answered once everything queued before it has committed (read-your-writes for a following read).
    Barrier,
    /// A scheduler write (D33): saves a schedule, opens or closes a run record. Answers the new run's id for a start.
    Sched(SchedOp),
    /// Replace the metrics snapshot (D51).
    Metrics {
        /// When it was taken.
        ts_ms: u64,
        /// The exported counters and histograms.
        body: String,
    },
    /// A telemetry write (D78): a flush of counters and events, or a prune.
    Telemetry(crate::telemetry::persist::TelOp),
    /// A realtime-state write (lane B1): the entity rows and change records of one namespace.
    Rt(RtOp),
    /// A project-partition write (D21 pending mailbox and key-value state). A non-empty `write_id` makes it idempotent:
    /// a repeat with the same id returns the first result and changes nothing (D24).
    Proj {
        /// The project key (derived by the daemon from the request's cwd).
        project: String,
        /// Idempotency key, or empty.
        write_id: String,
        /// What to do.
        verb: ProjVerb,
    },
}

/// One persisted realtime entity.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RtRow {
    /// Entity key (a workspace id).
    pub key: String,
    /// The entity as JSON text.
    pub body: String,
    /// Signature of the source state it was derived from.
    pub src_sig: String,
    /// When its sources were last read.
    pub observed_ms: i64,
}

/// One persisted realtime change record.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RtEdgeRow {
    /// Entity key.
    pub key: String,
    /// What changed.
    pub kind: String,
    /// The value before.
    pub from: String,
    /// The value after.
    pub to: String,
    /// Snapshot generation that produced it.
    pub generation: i64,
    /// When it was found.
    pub at_ms: i64,
    /// Found by the start-up diff, i.e. it happened while the engine was down.
    pub while_down: bool,
}

/// A realtime-state write: one namespace's snapshot and the changes that led to it, in one transaction.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RtOp {
    /// Namespace (the feature).
    pub ns: String,
    /// The complete set of entities: rows of the namespace not listed here are removed.
    pub rows: Vec<RtRow>,
    /// New change records to append.
    pub edges: Vec<RtEdgeRow>,
    /// Keep at most this many change records for the namespace.
    pub edge_cap: i64,
}

/// A scheduler write.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SchedOp {
    /// Save a job's schedule.
    Save {
        /// Job name.
        job: String,
        /// When it runs next (ms since the epoch).
        next_ms: u64,
        /// Failed runs since the last success.
        failures: u32,
        /// No run before this time (ms since the epoch; 0: none).
        cooldown_until_ms: u64,
    },
    /// A run starts.
    Start {
        /// Job name.
        job: String,
        /// When it was due.
        due_ms: u64,
        /// When it started.
        started_ms: u64,
        /// 1 for the first try, 2 for the first retry, ...
        attempt: u32,
    },
    /// A run ends.
    End {
        /// The run id `Start` answered.
        id: i64,
        /// When it ended.
        ended_ms: u64,
        /// ok, failed, timeout, ...
        status: String,
        /// What it reported.
        detail: String,
    },
    /// A finished run, recorded in one go.
    Record {
        /// Job name.
        job: String,
        /// When it was due.
        due_ms: u64,
        /// When it started.
        started_ms: u64,
        /// When it ended.
        ended_ms: u64,
        /// How it ended.
        status: String,
        /// Which try.
        attempt: u32,
        /// What it reported.
        detail: String,
    },
    /// Close the runs a killed daemon left open, with this status.
    Interrupted {
        /// When they are closed.
        now_ms: u64,
        /// The status they get.
        status: String,
        /// The status they still have.
        running: String,
    },
}

/// A state-changing project operation.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ProjVerb {
    /// Append a message to the project's mailbox.
    Put(String),
    /// Consume the oldest pending message (it is marked consumed, never deleted, D26).
    Take,
    /// Set a key, optionally expiring at a time (ms since the epoch).
    Set {
        /// The key.
        key: String,
        /// The value.
        value: String,
        /// When the value stops being active, if ever.
        expires_ms: Option<u64>,
    },
}

/// The in-memory layer: active key-value items (budgeted, D25) and the pub/sub channels (D20).
pub struct Mem {
    /// Active key-value items, keyed by (project, key).
    pub kv: Mutex<Tiered<(String, String), String>>,
    /// Pub/sub channels; a committed mailbox put or key set is announced on `project:<hash>`.
    pub bus: Bus,
    /// Bumped by every write that touches `kv`, so a read that raced a write does not promote a stale value.
    seq: std::sync::atomic::AtomicU64,
    /// Transactions the writer committed since open (group commit puts several writes in one).
    pub commits: std::sync::atomic::AtomicU64,
    /// Writes those transactions carried.
    pub writes: std::sync::atomic::AtomicU64,
}

impl Mem {
    fn new() -> Mem {
        Mem {
            kv: Mutex::new(Tiered::new(defaults::num("tier.budget_kb") as usize * 1024)),
            bus: Bus::new(defaults::num("tier.bus_queue") as usize, defaults::num("tier.bus_channels") as usize),
            seq: std::sync::atomic::AtomicU64::new(0),
            commits: std::sync::atomic::AtomicU64::new(0),
            writes: std::sync::atomic::AtomicU64::new(0),
        }
    }

    /// The write sequence now; pass it to [`Mem::promote`] after reading SQLite.
    pub fn seq(&self) -> u64 {
        self.seq.load(std::sync::atomic::Ordering::SeqCst)
    }

    /// Make a value read from SQLite active, unless a write happened since `seq` was taken (then the next read
    /// promotes the newer value instead).
    pub fn promote(&self, seq: u64, k: (String, String), v: String, expires_ms: Option<u64>) {
        let mut kv = lk(&self.kv);
        if self.seq() == seq && !kv.contains(&k) {
            let size = item_size(&k, &v);
            kv.insert(k, v, size, expires_ms);
        }
    }

    /// After a commit: make written items active and announce them.
    fn committed(&self, op: &Op) {
        let Op::Proj { project, verb, .. } = op else { return };
        let channel = format!("{}{}", defaults::text("tier.project_channel_prefix"), crate::telemetry::project_hash(project));
        match verb {
            ProjVerb::Set { key, value, expires_ms } => {
                self.seq.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                let k = (project.clone(), key.clone());
                let size = item_size(&k, value);
                lk(&self.kv).insert(k, value.clone(), size, *expires_ms);
                self.bus.publish(&channel, &serde_json::json!({"kind": "kv", "key": key}).to_string());
            }
            ProjVerb::Put(_) => self.bus.publish(&channel, &serde_json::json!({"kind": "mail"}).to_string()),
            ProjVerb::Take => {}
        }
    }
}

/// Bytes an item is charged against the budget: its text plus a fixed per-item overhead.
fn item_size(k: &(String, String), v: &str) -> usize {
    k.0.len() + k.1.len() + v.len() + defaults::num("tier.item_overhead") as usize
}

struct Job {
    op: Op,
    reply: Option<SyncSender<Result<String, DbError>>>,
}

fn lk<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

/// The open databases and the writer thread.
pub struct Db {
    tx: Mutex<Option<SyncSender<Job>>>,
    read: Mutex<Connection>,
    archive: Mutex<Option<Connection>>,
    dir: PathBuf,
    writer: Mutex<Option<JoinHandle<()>>>,
    /// The in-memory layer over hot.db.
    pub mem: Arc<Mem>,
}

/// Apply the shipped SQLite settings to a connection; `sync_key` names its synchronous level.
fn configure(c: &Connection, sync_key: &str) -> Result<(), DbError> {
    c.busy_timeout(defaults::millis("storage.busy_timeout_ms"))?;
    let want = defaults::text("storage.journal_mode");
    let got: String = c.pragma_update_and_check(None, "journal_mode", want, |r| r.get(0))?;
    if !got.eq_ignore_ascii_case(want) {
        return Err(DbError::JournalMode(got));
    }
    c.pragma_update(None, "synchronous", defaults::text(sync_key))?;
    c.pragma_update(None, "fullfsync", defaults::num("storage.fullfsync") as i64)?;
    c.pragma_update(None, "checkpoint_fullfsync", defaults::num("storage.fullfsync") as i64)?;
    // a negative cache_size is in KiB rather than pages (SQLite convention)
    c.pragma_update(None, "cache_size", -(defaults::num("storage.cache_kb") as i64))?;
    c.pragma_update(None, "mmap_size", defaults::num("storage.mmap_kb") as i64 * 1024)?;
    c.pragma_update(None, "wal_autocheckpoint", defaults::num("storage.wal_autocheckpoint") as i64)?;
    Ok(())
}

/// Run every migration `c` has not seen yet, each in its own transaction with its version bump. Re-running is a no-op.
pub fn migrate(c: &mut Connection, name: &str, migrations: &[&str]) -> Result<(), DbError> {
    let have: i64 = c.query_row("PRAGMA user_version", [], |r| r.get(0))?;
    if have > migrations.len() as i64 {
        return Err(DbError::Schema { db: name.to_string(), found: have, known: migrations.len() });
    }
    for (i, m) in migrations.iter().enumerate().skip(have.max(0) as usize) {
        let tx = c.transaction_with_behavior(TransactionBehavior::Immediate)?;
        tx.execute_batch(m)?;
        tx.pragma_update(None, "user_version", (i + 1) as i64)?;
        tx.commit()?;
    }
    Ok(())
}

/// Open one database file with the shipped settings and its migrations applied.
pub(crate) fn open_file(path: &Path, sync_key: &str, migrations: &[&str]) -> Result<Connection, DbError> {
    let flags = OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_CREATE | OpenFlags::SQLITE_OPEN_NO_MUTEX;
    let mut c = Connection::open_with_flags(path, flags)?;
    configure(&c, sync_key)?;
    let name = path.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
    migrate(&mut c, &name, migrations)?;
    Ok(c)
}

impl Db {
    /// Open (creating and migrating as needed) hot.db in `dir` and start the writer. archive.db opens on first use.
    pub fn open(dir: &Path) -> Result<Arc<Db>, DbError> {
        Db::open_with_window(dir, defaults::millis("storage.group_commit_ms"))
    }

    /// [`Db::open`] with an explicit group-commit window (`storage.group_commit_ms` is the configured one).
    pub fn open_with_window(dir: &Path, window: Duration) -> Result<Arc<Db>, DbError> {
        let hot = dir.join(defaults::text("storage.hot_file"));
        let write = open_file(&hot, "storage.hot_synchronous", sql::HOT_MIGRATIONS)?;
        let read = open_file(&hot, "storage.hot_synchronous", sql::HOT_MIGRATIONS)?;
        let (tx, rx) = mpsc::sync_channel(defaults::num("storage.write_queue") as usize);
        let mem = Arc::new(Mem::new());
        let m = mem.clone();
        let handle = std::thread::Builder::new().name("ah-db-writer".into()).spawn(move || writer_supervised(write, rx, m, window)).map_err(|e| {
            crate::discard::note("db_writer_spawn", &e.to_string());
            DbError::Unavailable
        })?;
        Ok(Arc::new(Db {
            tx: Mutex::new(Some(tx)),
            read: Mutex::new(read),
            archive: Mutex::new(None),
            dir: dir.to_path_buf(),
            writer: Mutex::new(Some(handle)),
            mem,
        }))
    }

    /// The directory holding both database files.
    pub fn dir(&self) -> &Path {
        &self.dir
    }

    fn enqueue(&self, job: Job) -> Result<(), DbError> {
        let tx = lk(&self.tx).clone().ok_or(DbError::Unavailable)?;
        tx.try_send(job).map_err(|e| match e {
            TrySendError::Full(_) => DbError::Busy,
            TrySendError::Disconnected(_) => DbError::Unavailable,
        })
    }

    /// Apply `op` and wait for its commit: `Ok` means it is on disk (D23). A timeout leaves the write queued.
    pub fn write(&self, op: Op) -> Result<String, DbError> {
        let (tx, rx) = mpsc::sync_channel(1);
        self.enqueue(Job { op, reply: Some(tx) })?;
        rx.recv_timeout(defaults::millis("storage.ack_timeout_ms")).unwrap_or(Err(DbError::Timeout))
    }

    /// Queue `op` without waiting (telemetry from the hook path, which must never wait on storage, D9).
    pub fn submit(&self, op: Op) -> Result<(), DbError> {
        self.enqueue(Job { op, reply: None })
    }

    /// Wait until every write queued before this call has committed.
    pub fn barrier(&self) -> Result<(), DbError> {
        self.write(Op::Barrier).map(|_| ())
    }

    /// Run `f` on the hot.db read connection.
    pub fn read<R>(&self, f: impl FnOnce(&Connection) -> rusqlite::Result<R>) -> Result<R, DbError> {
        Ok(f(&lk(&self.read))?)
    }

    /// Run `f` on archive.db, opening (and migrating) it on first use.
    pub fn archive<R>(&self, f: impl FnOnce(&mut Connection) -> Result<R, DbError>) -> Result<R, DbError> {
        let mut g = lk(&self.archive);
        if g.is_none() {
            let path = self.dir.join(defaults::text("storage.archive_file"));
            *g = Some(open_file(&path, "storage.archive_synchronous", sql::ARCHIVE_MIGRATIONS)?);
        }
        match g.as_mut() {
            Some(c) => f(c),
            None => Err(DbError::Unavailable),
        }
    }

    /// Stop taking writes, commit everything queued, and stop the writer. Idempotent.
    pub fn close(&self) {
        drop(lk(&self.tx).take());
        if let Some(h) = lk(&self.writer).take() {
            crate::discard::harmless(h.join()); // keep: reaping or draining a child or thread that already ended
        }
    }
}

impl Drop for Db {
    fn drop(&mut self) {
        self.close();
    }
}

/// The writer thread (group commit, D23): take one job, then gather more for up to `window` (with a zero window,
/// only what is already queued), at most `storage.batch_max`; commit them as one transaction, then answer each. A
/// longer window trades the first write's latency for fewer syncs under load. Ends when every sender is gone and the
/// queue is empty.
fn writer_supervised(mut conn: Connection, rx: Receiver<Job>, mem: Arc<Mem>, window: Duration) {
    let mut panics = 0_u64;
    loop {
        let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| writer(&mut conn, &rx, &mem, window)));
        if r.is_ok() {
            return;
        }
        panics += 1;
        let max = defaults::num("daemon.thread_restart_max");
        crate::health::log_event(
            "thread_panic",
            "db_writer",
            &defaults::render("msg.thread_panic", &[("thread", &"db_writer"), ("n", &panics), ("max", &max)]),
        );
        crate::health::record_failure(
            "panic",
            "thread_panic",
            &defaults::render("msg.thread_panic", &[("thread", &"db_writer"), ("n", &panics), ("max", &max)]),
        );
        if panics > max {
            return;
        }
        std::thread::sleep(defaults::millis("daemon.thread_restart_backoff_ms"));
    }
}

fn writer(conn: &mut Connection, rx: &Receiver<Job>, mem: &Mem, window: Duration) {
    let max = defaults::num("storage.batch_max") as usize;
    while let Ok(first) = rx.recv() {
        let mut batch = vec![first];
        let deadline = Instant::now() + window;
        while batch.len() < max {
            let left = deadline.saturating_duration_since(Instant::now());
            let next = if left.is_zero() { rx.try_recv().ok() } else { rx.recv_timeout(left).ok() };
            match next {
                Some(j) => batch.push(j),
                None => break,
            }
        }
        commit_batch(conn, batch, mem);
    }
}

/// Apply a batch in one transaction, each job in its own savepoint; a failed commit fails every job in it.
fn commit_batch(conn: &mut Connection, batch: Vec<Job>, mem: &Mem) {
    let mut results: Vec<Result<String, DbError>> = Vec::with_capacity(batch.len());
    let outcome = if batch.iter().all(|j| matches!(j.op, Op::Barrier)) {
        batch.iter().for_each(|_| results.push(Ok(String::new())));
        Ok(())
    } else {
        let r = run_tx(conn, &batch, &mut results);
        if r.is_ok() {
            mem.commits.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            mem.writes.fetch_add(batch.len() as u64, std::sync::atomic::Ordering::SeqCst);
        }
        r
    };
    if let Err(e) = outcome {
        results = batch.iter().map(|_| Err(e.clone())).collect();
    }
    for (j, r) in batch.iter().zip(&results) {
        if r.is_ok() {
            mem.committed(&j.op);
        }
    }
    for (j, r) in batch.into_iter().zip(results) {
        if let Some(tx) = j.reply {
            crate::discard::harmless(tx.send(r)); // keep: the receiver is gone; nobody is waiting for the result
        }
    }
}

fn run_tx(conn: &mut Connection, batch: &[Job], results: &mut Vec<Result<String, DbError>>) -> Result<(), DbError> {
    let mut tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
    for j in batch {
        let sp = tx.savepoint()?;
        match apply(&sp, &j.op) {
            Ok(v) => {
                sp.commit()?;
                results.push(Ok(v));
            }
            Err(e) => {
                drop(sp); // rolls back this job only
                results.push(Err(e));
            }
        }
    }
    tx.commit()?;
    Ok(())
}

/// One job's statements.
fn apply(c: &Connection, op: &Op) -> Result<String, DbError> {
    match op {
        Op::Barrier => Ok(String::new()),
        Op::Impact(e) => {
            c.prepare_cached(sql::IMPACT_INSERT)?.execute(params![e.ts_ms as i64, e.kind, e.check, e.reason, e.project])?;
            c.prepare_cached(sql::IMPACT_COUNT)?.execute(params![e.kind, e.check, e.reason, e.project])?;
            Ok(String::new())
        }
        Op::Sched(op) => sched_apply(c, op),
        Op::Metrics { ts_ms, body } => {
            c.prepare_cached(sql::METRICS_SAVE)?.execute(params![*ts_ms as i64, body])?;
            Ok(String::new())
        }
        Op::Telemetry(t) => crate::telemetry::persist::apply(c, t),
        Op::Rt(r) => rt_apply(c, r),
        Op::Proj { project, write_id, verb } => {
            if !write_id.is_empty()
                && let Some(r) = c.prepare_cached(sql::APPLIED_GET)?.query_row(params![write_id], |r| r.get::<_, String>(0)).optional()?
            {
                return Ok(r); // already applied: same answer, no change
            }
            let now = crate::health::now_ms() as i64;
            let r = proj_apply(c, project, verb, now)?;
            if !write_id.is_empty() {
                c.prepare_cached(sql::APPLIED_PUT)?.execute(params![write_id, now, r])?;
            }
            Ok(r)
        }
    }
}

fn rt_apply(c: &Connection, op: &RtOp) -> Result<String, DbError> {
    let mut have: Vec<String> = Vec::new();
    {
        let mut st = c.prepare_cached(sql::RT_ENTITY_KEYS)?;
        for k in st.query_map(params![op.ns], |r| r.get::<_, String>(0))? {
            have.push(k?);
        }
    }
    for k in have.iter().filter(|k| !op.rows.iter().any(|r| &r.key == *k)) {
        c.prepare_cached(sql::RT_ENTITY_DROP)?.execute(params![op.ns, k])?;
    }
    for r in &op.rows {
        c.prepare_cached(sql::RT_ENTITY_PUT)?.execute(params![op.ns, r.key, r.body, r.src_sig, r.observed_ms])?;
    }
    for e in &op.edges {
        c.prepare_cached(sql::RT_EDGE_PUT)?.execute(params![op.ns, e.key, e.kind, e.from, e.to, e.generation, e.at_ms, e.while_down as i64])?;
    }
    c.prepare_cached(sql::RT_EDGE_TRIM)?.execute(params![op.ns, op.edge_cap])?;
    Ok(String::new())
}

fn sched_apply(c: &Connection, op: &SchedOp) -> Result<String, DbError> {
    let now = crate::health::now_ms() as i64;
    match op {
        SchedOp::Save { job, next_ms, failures, cooldown_until_ms } => {
            c.prepare_cached(sql::SCHED_SAVE)?.execute(params![job, *next_ms as i64, *failures as i64, *cooldown_until_ms as i64, now])?;
        }
        SchedOp::Start { job, due_ms, started_ms, attempt } => {
            c.prepare_cached(sql::RUN_START)?.execute(params![job, *due_ms as i64, *started_ms as i64, "running", *attempt as i64])?;
            return Ok(c.last_insert_rowid().to_string());
        }
        SchedOp::End { id, ended_ms, status, detail } => {
            c.prepare_cached(sql::RUN_END)?.execute(params![id, *ended_ms as i64, status, detail])?;
        }
        SchedOp::Record { job, due_ms, started_ms, ended_ms, status, attempt, detail } => {
            c.prepare_cached(sql::RUN_INSERT)?.execute(params![job, *due_ms as i64, *started_ms as i64, *ended_ms as i64, status, *attempt as i64, detail])?;
        }
        SchedOp::Interrupted { now_ms, status, running } => {
            c.prepare_cached(sql::RUN_INTERRUPTED)?.execute(params![*now_ms as i64, status, running])?;
        }
    }
    Ok(String::new())
}

fn cap(name: &str) -> i64 {
    defaults::num(&format!("store.{name}")) as i64
}

/// Refuse a write that would start a new project partition past `store.max_projects`.
fn check_project(c: &Connection, project: &str) -> Result<(), DbError> {
    let known: bool = c.prepare_cached(sql::PROJECT_KNOWN)?.query_row(params![project], |r| r.get(0))?;
    if !known && c.prepare_cached(sql::PROJECT_COUNT)?.query_row([], |r| r.get::<_, i64>(0))? >= cap("max_projects") {
        return Err(DbError::Rejected(StoreError::TooManyProjects));
    }
    Ok(())
}

fn proj_apply(c: &Connection, project: &str, verb: &ProjVerb, now: i64) -> Result<String, DbError> {
    match verb {
        ProjVerb::Put(body) => {
            check_project(c, project)?;
            if c.prepare_cached(sql::MAIL_PENDING)?.query_row(params![project], |r| r.get::<_, i64>(0))? >= cap("mailbox_cap") {
                return Err(DbError::Rejected(StoreError::MailboxFull));
            }
            c.prepare_cached(sql::MAIL_PUT)?.execute(params![project, body, now])?;
            Ok("ok".to_string())
        }
        ProjVerb::Take => {
            let next = c.prepare_cached(sql::MAIL_NEXT)?.query_row(params![project], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?))).optional()?;
            match next {
                Some((id, body)) => {
                    c.prepare_cached(sql::MAIL_CONSUME)?.execute(params![id, now])?;
                    Ok(body)
                }
                None => Ok(String::new()),
            }
        }
        ProjVerb::Set { key, value, expires_ms } => {
            check_project(c, project)?;
            let active: bool = c.prepare_cached(sql::KV_ACTIVE)?.query_row(params![project, key, now], |r| r.get(0))?;
            if !active && c.prepare_cached(sql::KV_COUNT)?.query_row(params![project, now], |r| r.get::<_, i64>(0))? >= cap("kv_cap") {
                return Err(DbError::Rejected(StoreError::TooManyKeys));
            }
            c.prepare_cached(sql::KV_SET)?.execute(params![project, key, value, expires_ms.map(|e| e as i64), now])?;
            Ok("ok".to_string())
        }
    }
}

/// A unique temporary state directory for tests, removed when the returned guard drops.
#[doc(hidden)]
pub struct TempDir(pub PathBuf);

impl TempDir {
    /// A fresh directory under the system temp dir named after `tag`.
    pub fn new(tag: &str) -> TempDir {
        use std::sync::atomic::{AtomicU64, Ordering};
        static N: AtomicU64 = AtomicU64::new(0);
        let p = std::env::temp_dir().join(format!("ah-db-{tag}-{}-{}", std::process::id(), N.fetch_add(1, Ordering::SeqCst)));
        crate::discard::harmless(std::fs::remove_dir_all(&p)); // keep: cleanup that raced; an absent file is the goal state
        crate::discard::harmless(std::fs::create_dir_all(&p)); // keep: the write that follows fails too when the directory is missing
        TempDir(p)
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        crate::discard::harmless(std::fs::remove_dir_all(&self.0)); // keep: cleanup that raced; an absent file is the goal state
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ev(kind: &str) -> ImpactEvent {
        ImpactEvent { ts_ms: 7, kind: kind.into(), check: "git".into(), reason: "r".into(), project: "p".into() }
    }

    #[test]
    fn hot_db_uses_wal_and_the_configured_durability() {
        let d = TempDir::new("pragma");
        let db = Db::open(&d.0).unwrap();
        let (mode, sync, full): (String, i64, i64) = db
            .read(|c| {
                Ok((
                    c.query_row("PRAGMA journal_mode", [], |r| r.get(0))?,
                    c.query_row("PRAGMA synchronous", [], |r| r.get(0))?,
                    c.query_row("PRAGMA fullfsync", [], |r| r.get(0))?,
                ))
            })
            .unwrap();
        assert_eq!(mode.to_lowercase(), "wal");
        assert_eq!(sync, 2, "FULL is level 2");
        assert_eq!(full, 0, "fullfsync defaults to off (D73)");
        let arch: i64 = db.archive(|c| Ok(c.query_row("PRAGMA synchronous", [], |r| r.get(0))?)).unwrap();
        assert_eq!(arch, 1, "archive.db uses NORMAL (1)");
        assert!(d.0.join("archive.db").exists(), "archive.db is created on first use");
    }

    #[test]
    fn migrations_are_versioned_and_idempotent() {
        let d = TempDir::new("migrate");
        let p = d.0.join("hot.db");
        {
            let db = Db::open(&d.0).unwrap();
            db.write(Op::Impact(ev("block"))).unwrap();
        }
        let mut c = Connection::open(&p).unwrap();
        let v: i64 = c.query_row("PRAGMA user_version", [], |r| r.get(0)).unwrap();
        assert_eq!(v, sql::HOT_MIGRATIONS.len() as i64);
        migrate(&mut c, "hot.db", sql::HOT_MIGRATIONS).unwrap();
        migrate(&mut c, "hot.db", sql::HOT_MIGRATIONS).unwrap();
        let n: i64 = c.query_row("SELECT COUNT(*) FROM impact", [], |r| r.get(0)).unwrap();
        assert_eq!(n, 1, "re-running migrations keeps the data");
        c.pragma_update(None, "user_version", 99).unwrap();
        drop(c);
        assert!(matches!(Db::open(&d.0).err(), Some(DbError::Schema { found: 99, .. })), "a newer schema is refused, not rewritten");
    }

    #[test]
    fn a_write_is_acknowledged_only_after_it_is_visible_to_a_new_connection() {
        let d = TempDir::new("ack");
        let db = Db::open(&d.0).unwrap();
        db.write(Op::Impact(ev("block"))).unwrap();
        let other = Connection::open(d.0.join("hot.db")).unwrap();
        let n: i64 = other.query_row("SELECT count FROM impact_totals", [], |r| r.get(0)).unwrap();
        assert_eq!(n, 1);
    }

    #[test]
    fn concurrent_writes_share_commits_within_the_window() {
        use std::sync::atomic::Ordering::SeqCst;
        let d = TempDir::new("group");
        let db = Db::open_with_window(&d.0, Duration::from_millis(100)).unwrap();
        let threads: Vec<_> = (0..20)
            .map(|_| {
                let db = db.clone();
                std::thread::spawn(move || db.write(Op::Impact(ev("block"))).unwrap())
            })
            .collect();
        threads.into_iter().for_each(|t| {
            t.join().unwrap();
        });
        let (commits, writes) = (db.mem.commits.load(SeqCst), db.mem.writes.load(SeqCst));
        assert_eq!(writes, 20);
        assert!(commits < 20, "20 concurrent writes inside one window share commits: {commits}");
        let solo = TempDir::new("solo");
        let db = Db::open_with_window(&solo.0, Duration::ZERO).unwrap();
        for _ in 0..5 {
            db.write(Op::Impact(ev("block"))).unwrap();
        }
        assert_eq!(db.mem.commits.load(SeqCst), 5, "sequential writes with no window commit one by one");
    }

    #[test]
    fn queued_writes_commit_before_close_returns() {
        let d = TempDir::new("close");
        let db = Db::open(&d.0).unwrap();
        for _ in 0..500 {
            db.submit(Op::Impact(ev("fallback"))).unwrap();
        }
        db.close();
        assert_eq!(db.write(Op::Barrier), Err(DbError::Unavailable), "a closed store takes no writes");
        let c = Connection::open(d.0.join("hot.db")).unwrap();
        let n: i64 = c.query_row("SELECT COUNT(*) FROM impact", [], |r| r.get(0)).unwrap();
        assert_eq!(n, 500);
    }
}
