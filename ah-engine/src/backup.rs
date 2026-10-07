//! Backup and restore (D27): `ah-engine backup` and `ah-engine restore`.
//!
//! **Backup** copies hot.db and archive.db with SQLite's online backup API, so the snapshot is consistent even while the
//! daemon writes (a copy that a write interrupts starts over). The copy is then scrubbed: text columns that can hold
//! what agents wrote (message bodies, values, recorded results) go through the same scrubber as diagnostics (secrets
//! and the home path removed, `health.scrub_patterns`), and the file is VACUUMed so the unscrubbed pages are gone, then
//! checked with `PRAGMA integrity_check`. Project keys are kept as they are, because a restore needs them to find each
//! project's data; the snapshot directory is private (0700). A `manifest.json` lists the files.
//!
//! **Restore** first takes an unscrubbed snapshot of the current state into a `pre-restore-<time>` directory, which it
//! never deletes, then stops the daemon, takes the daemon's singleton lock so none can start, and copies each database
//! from the snapshot into place with the same backup API (WAL-safe). The next hook call starts a daemon on the restored
//! state. A database the snapshot lacks is left as it is.
use crate::db::open_file;
use crate::defaults;
use crate::error::DbError;
use crate::sql;
use rusqlite::backup::Backup;
use rusqlite::{Connection, OpenFlags, params};
use serde_json::{Value, json};
use std::os::unix::io::AsRawFd;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

/// The two database file names, as shipped.
fn db_files() -> [&'static str; 2] {
    [defaults::text("storage.hot_file"), defaults::text("storage.archive_file")]
}

/// Copy the database at `src` to the new file `dst` with the online backup API.
fn copy(src: &Path, dst: &Path) -> Result<(), DbError> {
    let from = Connection::open_with_flags(src, OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX)?;
    from.busy_timeout(defaults::millis("storage.busy_timeout_ms"))?;
    let mut to = Connection::open(dst)?;
    Backup::new(&from, &mut to)?.run_to_completion(defaults::num("backup.pages_per_step") as i32, defaults::millis("backup.pause_ms"), None)?;
    // a snapshot is one self-contained file, not a database plus a WAL
    to.pragma_update(None, "journal_mode", defaults::text("backup.journal_mode"))?;
    Ok(())
}

/// Scrub every text column listed in `backup.scrub_columns` (`table.column`) that exists in `c`, then VACUUM so no
/// unscrubbed page is left in the file. Returns how many rows changed. Equal values scrub to equal values, so each
/// distinct value is rewritten once wherever it occurs (this also works for tables without a rowid).
fn scrub(c: &Connection) -> Result<u64, DbError> {
    let mut changed = 0;
    for tc in defaults::list("backup.scrub_columns") {
        let Some((table, col)) = tc.split_once('.') else { continue };
        let exists: bool = c.query_row(sql::TABLE_EXISTS, params![table], |r| r.get(0))?;
        if !exists {
            continue;
        }
        let fill = |q: &str| q.replace("{table}", table).replace("{col}", col);
        let values: Vec<String> = {
            let mut st = c.prepare(&fill(sql::SCRUB_SELECT))?;
            let it = st.query_map([], |r| r.get(0))?;
            it.collect::<rusqlite::Result<_>>()?
        };
        let mut up = c.prepare(&fill(sql::SCRUB_UPDATE))?;
        for text in values {
            let clean = crate::health::scrub(&text);
            if clean != text {
                changed += up.execute(params![text, clean])? as u64;
            }
        }
    }
    c.execute_batch("VACUUM")?;
    Ok(changed)
}

fn integrity(c: &Connection) -> Result<String, DbError> {
    Ok(c.query_row("PRAGMA integrity_check", [], |r| r.get(0))?)
}

fn stamp() -> String {
    crate::health::now_ms().to_string()
}

/// Snapshot both databases of `dir` into `dest` (created, private). `scrubbed` runs the scrubber; a pre-restore copy
/// is not scrubbed, because it must be able to bring back exactly what was there.
pub fn snapshot(dir: &Path, dest: &Path, scrubbed: bool) -> Result<Value, DbError> {
    let io = |e: String| DbError::Sql(e);
    crate::limits::ensure_private_dir(dest.parent().unwrap_or(dest)).map_err(|e| io(e.to_string()))?;
    crate::limits::ensure_private_dir(dest).map_err(|e| io(e.to_string()))?;
    let mut files = vec![];
    for name in db_files() {
        let src = dir.join(name);
        if !src.exists() {
            continue;
        }
        let dst = dest.join(name);
        copy(&src, &dst)?;
        let c = Connection::open(&dst)?;
        let changed = if scrubbed { scrub(&c)? } else { 0 };
        let check = integrity(&c)?;
        let version: i64 = c.query_row("PRAGMA user_version", [], |r| r.get(0))?;
        drop(c);
        let bytes = std::fs::metadata(&dst).map(|m| m.len()).unwrap_or(0);
        files.push(json!({"name": name, "bytes": bytes, "schema_version": version, "integrity": check, "values_scrubbed": changed}));
    }
    let manifest = json!({
        "created_ms": crate::health::now_ms(),
        "engine_version": crate::version(),
        "scrubbed": scrubbed,
        "files": files,
        "path": dest.to_string_lossy(),
    });
    std::fs::write(dest.join(defaults::text("backup.manifest_file")), manifest.to_string()).map_err(|e| io(e.to_string()))?;
    Ok(manifest)
}

/// `ah-engine backup [--to <dir>]`: a scrubbed snapshot, by default in `backups/<ms>` inside the state directory.
pub fn backup(dir: &Path, to: Option<&Path>) -> Result<Value, DbError> {
    let dest = to.map(Path::to_path_buf).unwrap_or_else(|| dir.join(defaults::text("files.backups_dir")).join(stamp()));
    if dest.join(defaults::text("backup.manifest_file")).exists() {
        return Err(DbError::Sql(defaults::render("msg.backup_exists", &[("path", &dest.display())])));
    }
    snapshot(dir, &dest, true)
}

/// Stop the daemon (if one answers) and wait until it is gone, then hold its singleton lock so none starts while
/// the databases are swapped. The lock is released when the returned file is dropped.
fn quiesce(dir: &Path) -> Result<std::fs::File, DbError> {
    let sock = crate::paths::socket_in(dir);
    crate::client::exchange(&sock, b"CTL stop\n", defaults::millis("client.ctl_timeout_ms")); // keep: the daemon may already be gone
    let lock_path = crate::paths::lock_for(&sock);
    let f = std::fs::OpenOptions::new().create(true).read(true).write(true).truncate(false).open(&lock_path).map_err(|e| DbError::Sql(e.to_string()))?;
    let t = Instant::now();
    while t.elapsed() < defaults::millis("backup.stop_wait_ms") {
        if unsafe { libc::flock(f.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } == 0 {
            return Ok(f);
        }
        std::thread::sleep(Duration::from_millis(defaults::num("daemon.lock_poll_ms")));
    }
    Err(DbError::Sql(defaults::text("msg.restore_daemon_busy").to_string()))
}

/// `ah-engine restore <snapshot>`: keep the current state as a pre-restore snapshot (never deleted), then swap.
pub fn restore(dir: &Path, from: &Path) -> Result<Value, DbError> {
    // validate the snapshot before touching anything
    let mut present = vec![];
    for name in db_files() {
        let p = from.join(name);
        if !p.exists() {
            continue;
        }
        let c = Connection::open_with_flags(&p, OpenFlags::SQLITE_OPEN_READ_ONLY)?;
        let check = integrity(&c)?;
        if check != "ok" {
            return Err(DbError::Sql(defaults::render("msg.restore_damaged", &[("path", &p.display()), ("check", &check)])));
        }
        let version: i64 = c.query_row("PRAGMA user_version", [], |r| r.get(0))?;
        let known = if name == db_files()[0] { sql::HOT_MIGRATIONS.len() } else { sql::ARCHIVE_MIGRATIONS.len() };
        if version > known as i64 {
            return Err(DbError::Schema { db: name.to_string(), found: version, known });
        }
        present.push(name);
    }
    if !present.contains(&db_files()[0]) {
        return Err(DbError::Sql(defaults::render("msg.restore_no_hot", &[("path", &from.display())])));
    }
    let _lock = quiesce(dir)?;
    let pre: PathBuf = dir.join(defaults::text("files.backups_dir")).join(format!("{}{}", defaults::text("backup.pre_restore_prefix"), stamp()));
    let kept = snapshot(dir, &pre, false)?;
    let mut restored = vec![];
    for name in present {
        let migrations = if name == db_files()[0] { sql::HOT_MIGRATIONS } else { sql::ARCHIVE_MIGRATIONS };
        let sync = if name == db_files()[0] { "storage.hot_synchronous" } else { "storage.archive_synchronous" };
        let src = Connection::open_with_flags(from.join(name), OpenFlags::SQLITE_OPEN_READ_ONLY)?;
        let mut live = Connection::open(dir.join(name))?;
        live.busy_timeout(defaults::millis("storage.busy_timeout_ms"))?;
        Backup::new(&src, &mut live)?.run_to_completion(defaults::num("backup.pages_per_step") as i32, defaults::millis("backup.pause_ms"), None)?;
        drop((src, live));
        // the copy carries the snapshot's journal mode and schema version: reopen with the shipped settings (WAL) and
        // bring the schema up to this build's migrations
        let live = open_file(&dir.join(name), sync, migrations)?;
        let check = integrity(&live)?;
        live.query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |_| Ok(()))?;
        restored.push(json!({"name": name, "integrity": check}));
    }
    crate::health::log_event("restore", "-", &defaults::render("msg.log_restored", &[("from", &from.display()), ("kept", &pre.display())]));
    Ok(json!({"restored_from": from.to_string_lossy(), "restored": restored, "pre_restore_snapshot": kept}))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::{Db, Op, ProjVerb, TempDir};

    fn put(db: &Db, body: &str) {
        db.write(Op::Proj { project: "/p".into(), write_id: String::new(), verb: ProjVerb::Put(body.into()) }).unwrap();
    }

    fn bodies(p: &Path) -> Vec<String> {
        let c = Connection::open(p).unwrap();
        let mut st = c.prepare("SELECT body FROM mailbox ORDER BY id").unwrap();

        st.query_map([], |r| r.get(0)).unwrap().map(Result::unwrap).collect()
    }

    #[test]
    fn a_backup_is_consistent_scrubbed_and_self_contained() {
        let d = TempDir::new("bk");
        let db = Db::open(&d.0).unwrap();
        put(&db, "plain message");
        put(&db, "token=ghp_abcdefghijklmnopqrstuvwxyz0123456789 here");
        db.archive(|_| Ok(())).unwrap();
        let out = d.0.join("snap");
        let m = backup(&d.0, Some(&out)).unwrap();
        assert_eq!(m["scrubbed"], true);
        assert_eq!(m["files"].as_array().unwrap().len(), 2, "{m}");
        assert!(m["files"].as_array().unwrap().iter().all(|f| f["integrity"] == "ok"));
        let b = bodies(&out.join("hot.db"));
        assert_eq!(b[0], "plain message");
        assert!(!b[1].contains("ghp_"), "secrets are scrubbed: {}", b[1]);
        let raw = std::fs::read(out.join("hot.db")).unwrap();
        assert!(!raw.windows(4).any(|w| w == b"ghp_"), "no unscrubbed page is left in the file");
        assert!(!out.join("hot.db-wal").exists(), "one file per database");
        assert!(bodies(&d.0.join("hot.db"))[1].contains("ghp_"), "the live database is untouched");
        assert!(backup(&d.0, Some(&out)).is_err(), "an existing snapshot is never overwritten");
    }

    #[test]
    fn restore_keeps_the_current_state_then_swaps() {
        let d = TempDir::new("rs");
        let db = Db::open(&d.0).unwrap();
        put(&db, "before");
        let snap = d.0.join("snap");
        backup(&d.0, Some(&snap)).unwrap();
        put(&db, "after the backup");
        db.close();
        drop(db);
        let r = restore(&d.0, &snap).unwrap();
        assert_eq!(bodies(&d.0.join("hot.db")), vec!["before"], "the live state is the snapshot's");
        let kept = PathBuf::from(r["pre_restore_snapshot"]["path"].as_str().unwrap());
        assert_eq!(bodies(&kept.join("hot.db")), vec!["before", "after the backup"], "the state before the restore is kept, unscrubbed");
        let db = Db::open(&d.0).unwrap();
        put(&db, "works after restore");
        assert_eq!(bodies(&d.0.join("hot.db")).len(), 2);
        let mode: String = db.read(|c| c.query_row("PRAGMA journal_mode", [], |r| r.get(0))).unwrap();
        assert_eq!(mode.to_lowercase(), "wal", "the live database is back in WAL");
    }

    #[test]
    fn a_damaged_or_newer_snapshot_is_refused_before_anything_changes() {
        let d = TempDir::new("rs-bad");
        let snap = d.0.join("snap");
        std::fs::create_dir_all(&snap).unwrap();
        assert!(restore(&d.0, &snap).is_err(), "no hot.db in the snapshot");
        let c = Connection::open(snap.join("hot.db")).unwrap();
        c.pragma_update(None, "user_version", 999).unwrap();
        drop(c);
        assert!(matches!(restore(&d.0, &snap), Err(DbError::Schema { .. })));
        assert!(!d.0.join("backups").exists(), "nothing was touched");
    }
}
