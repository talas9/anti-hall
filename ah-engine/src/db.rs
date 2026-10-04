//! The embedded SQLite pair (D19, D21, D23, D73): `hot.db` for frequent small writes, `archive.db` for history.
//!
//! One writer thread owns the hot.db write connection. Requests hand it a [`Op`] over a bounded queue and, when they
//! need an acknowledgement, wait for the reply, which is sent only after the transaction holding the write has
//! committed (D23). Whatever is queued while a commit runs goes into the next transaction, so concurrent writers share
//! one sync (group commit). Each write runs inside its own savepoint, so a refused write never undoes its neighbours.
//!
//! Reads use a second connection (WAL lets them run while the writer commits). archive.db is opened on first use.
//! Every SQLite setting (journal mode, synchronous level, fullfsync, cache, mmap, timeouts) comes from
//! `defaults/storage.toml`; the schema lives in `sql.rs` and is migrated by version on open.
use crate::defaults;
use crate::error::DbError;
use crate::sql;
use crate::storage::ImpactEvent;
use rusqlite::{params, Connection, OpenFlags, TransactionBehavior};
use std::path::{Path, PathBuf};
use std::sync::mpsc::{self, Receiver, SyncSender, TrySendError};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;

/// One write the writer thread applies.
#[derive(Debug, Clone)]
pub enum Op {
    /// Record an impact event and count it in its total (D52).
    Impact(ImpactEvent),
    /// No change: answered once everything queued before it has committed (read-your-writes for a following read).
    Barrier,
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
fn open_file(path: &Path, sync_key: &str, migrations: &[&str]) -> Result<Connection, DbError> {
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
        let hot = dir.join(defaults::text("storage.hot_file"));
        let write = open_file(&hot, "storage.hot_synchronous", sql::HOT_MIGRATIONS)?;
        let read = open_file(&hot, "storage.hot_synchronous", sql::HOT_MIGRATIONS)?;
        let (tx, rx) = mpsc::sync_channel(defaults::num("storage.write_queue") as usize);
        let handle = std::thread::spawn(move || writer(write, rx));
        Ok(Arc::new(Db {
            tx: Mutex::new(Some(tx)),
            read: Mutex::new(read),
            archive: Mutex::new(None),
            dir: dir.to_path_buf(),
            writer: Mutex::new(Some(handle)),
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
            let _ = h.join();
        }
    }
}

impl Drop for Db {
    fn drop(&mut self) {
        self.close();
    }
}

/// The writer thread: take one job, add whatever else is already queued (up to `storage.batch_max`), commit them as
/// one transaction, then answer each. Ends when every sender is gone and the queue is empty.
fn writer(mut conn: Connection, rx: Receiver<Job>) {
    let max = defaults::num("storage.batch_max") as usize;
    while let Ok(first) = rx.recv() {
        let mut batch = vec![first];
        while batch.len() < max {
            match rx.try_recv() {
                Ok(j) => batch.push(j),
                Err(_) => break,
            }
        }
        commit_batch(&mut conn, batch);
    }
}

/// Apply a batch in one transaction, each job in its own savepoint; a failed commit fails every job in it.
fn commit_batch(conn: &mut Connection, batch: Vec<Job>) {
    let mut results: Vec<Result<String, DbError>> = Vec::with_capacity(batch.len());
    let outcome = if batch.iter().all(|j| matches!(j.op, Op::Barrier)) {
        batch.iter().for_each(|_| results.push(Ok(String::new())));
        Ok(())
    } else {
        run_tx(conn, &batch, &mut results)
    };
    if let Err(e) = outcome {
        results = batch.iter().map(|_| Err(e.clone())).collect();
    }
    for (j, r) in batch.into_iter().zip(results) {
        if let Some(tx) = j.reply {
            let _ = tx.send(r);
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
        let _ = std::fs::remove_dir_all(&p);
        let _ = std::fs::create_dir_all(&p);
        TempDir(p)
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
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
