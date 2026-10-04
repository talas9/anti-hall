//! Size control and retention (D26): `ah-engine maintain`.
//!
//! One run, in order:
//!  1. **Move** what has left its active life from hot.db to archive.db: consumed mailbox messages older than
//!     `retention.mailbox_consumed_s`, key values expired longer than `retention.kv_expired_s`, and impact events older
//!     than `retention.impact_hot_s` or beyond the `retention.impact_hot_rows` cap (their totals stay in hot.db). Each
//!     batch is copied and committed to archive.db first (synced like hot.db), then removed from hot.db; a crash in
//!     between leaves a copy in both, and the next run's copy is a no-op (rows keep their keys), so nothing is lost.
//!  2. **Prune** derived bookkeeping only: applied write ids older than `retention.applied_s` (D59).
//!  3. **Hard delete** archived user data only when `retention.archive_delete_after_s` is set (default 0: never, D26).
//!  4. **Checkpoint** both WALs (`TRUNCATE`) and **VACUUM** both databases.
//!
//! It runs in the calling process against the files directly, so it works with the daemon up or down: SQLite's locks
//! keep the two apart (a daemon write that meets the lock waits `storage.busy_timeout_ms`, then the client retries and
//! spools it, D24). The daemon's in-memory layer holds only active items, and a move takes only inactive ones (a key
//! set again since its copy is not removed). Scheduling it is the scheduler's job (planned, D33).
use crate::db::open_file;
use crate::defaults;
use crate::error::DbError;
use crate::sql;
use rusqlite::{params, Connection, Row};
use serde_json::{json, Value};
use std::path::Path;

fn ms(key: &str) -> i64 {
    defaults::num(key).saturating_mul(1000) as i64
}

/// Bytes of a file (0 when missing).
fn size(p: &Path) -> u64 {
    std::fs::metadata(p).map(|m| m.len()).unwrap_or(0)
}

/// Sizes of both databases and their WAL files.
pub fn sizes(dir: &Path) -> Value {
    let f = |k: &str| dir.join(defaults::text(k));
    let wal = |k: &str| {
        let mut p = f(k).into_os_string();
        p.push(defaults::text("storage.wal_suffix"));
        size(Path::new(&p))
    };
    json!({
        "hot_bytes": size(&f("storage.hot_file")),
        "hot_wal_bytes": wal("storage.hot_file"),
        "archive_bytes": size(&f("storage.archive_file")),
        "archive_wal_bytes": wal("storage.archive_file"),
    })
}

/// One selected row: the parameters for the archive insert, then the parameters for the hot.db delete.
type Moved = (Vec<rusqlite::types::Value>, Vec<rusqlite::types::Value>);

/// Copy rows selected from hot.db into archive.db, commit, then remove them from hot.db; batch by batch until none is
/// left (or `retention.max_batches`). `select` returns the batch's rows as parameter lists for `insert` and `delete`.
fn move_rows(
    hot: &mut Connection,
    arch: &mut Connection,
    select: &dyn Fn(&Connection) -> rusqlite::Result<Vec<Moved>>,
    insert: &str,
    delete: &str,
) -> Result<u64, DbError> {
    let mut moved = 0;
    for _ in 0..defaults::num("retention.max_batches") {
        let rows = select(hot)?;
        if rows.is_empty() {
            break;
        }
        let tx = arch.transaction()?;
        for (ins, _) in &rows {
            tx.prepare_cached(insert)?.execute(rusqlite::params_from_iter(ins.iter()))?;
        }
        tx.commit()?; // the archive copy is on disk before anything leaves hot.db
        let tx = hot.transaction()?;
        for (_, del) in &rows {
            moved += tx.prepare_cached(delete)?.execute(rusqlite::params_from_iter(del.iter()))? as u64;
        }
        tx.commit()?;
    }
    Ok(moved)
}

fn v(r: &Row, i: usize) -> rusqlite::Result<rusqlite::types::Value> {
    r.get(i)
}

/// Run one maintenance pass over the databases in `dir` and return its report (also recorded in hot.db).
pub fn run(dir: &Path) -> Result<Value, DbError> {
    let now = crate::health::now_ms() as i64;
    let before = sizes(dir);
    let mut hot = open_file(&dir.join(defaults::text("storage.hot_file")), "storage.hot_synchronous", sql::HOT_MIGRATIONS)?;
    let mut arch = open_file(&dir.join(defaults::text("storage.archive_file")), "storage.hot_synchronous", sql::ARCHIVE_MIGRATIONS)?;
    let batch = defaults::num("retention.batch_rows") as i64;

    let mail_cutoff = now - ms("retention.mailbox_consumed_s");
    let mail = move_rows(
        &mut hot,
        &mut arch,
        &|c| {
            let mut st = c.prepare_cached(sql::MAIL_ARCHIVABLE)?;
            let rows =
                st.query_map(params![mail_cutoff, batch], |r| Ok((vec![v(r, 0)?, v(r, 1)?, v(r, 2)?, v(r, 3)?, v(r, 4)?, now.into()], vec![v(r, 0)?])))?;
            rows.collect()
        },
        sql::ARCH_MAIL_INSERT,
        sql::MAIL_DELETE_ARCHIVED,
    )?;

    let kv_cutoff = now - ms("retention.kv_expired_s");
    let kv = move_rows(
        &mut hot,
        &mut arch,
        &|c| {
            let mut st = c.prepare_cached(sql::KV_ARCHIVABLE)?;
            let rows = st.query_map(params![kv_cutoff, batch], |r| {
                Ok((vec![v(r, 0)?, v(r, 1)?, v(r, 2)?, v(r, 3)?, v(r, 4)?, now.into()], vec![v(r, 0)?, v(r, 1)?, v(r, 4)?, kv_cutoff.into()]))
            })?;
            rows.collect()
        },
        sql::ARCH_KV_INSERT,
        sql::KV_DELETE_ARCHIVED,
    )?;

    let impact_cutoff = now - ms("retention.impact_hot_s");
    let cap_id: i64 = hot.query_row(sql::IMPACT_CAP_ID, params![defaults::num("retention.impact_hot_rows") as i64], |r| r.get(0)).unwrap_or(0);
    let impact = move_rows(
        &mut hot,
        &mut arch,
        &|c| {
            let mut st = c.prepare_cached(sql::IMPACT_ARCHIVABLE)?;
            let rows = st.query_map(params![impact_cutoff, cap_id, batch], |r| {
                Ok((vec![v(r, 0)?, v(r, 1)?, v(r, 2)?, v(r, 3)?, v(r, 4)?, v(r, 5)?, now.into()], vec![v(r, 0)?]))
            })?;
            rows.collect()
        },
        sql::ARCH_IMPACT_INSERT,
        sql::IMPACT_DELETE_ARCHIVED,
    )?;

    let pruned_applied = hot.execute(sql::APPLIED_PRUNE, params![now - ms("retention.applied_s")])? as u64;

    let delete_after = ms("retention.archive_delete_after_s");
    let mut archive_deleted = json!(null);
    if delete_after > 0 {
        let cutoff = now - delete_after;
        let tx = arch.transaction()?;
        let counts = [sql::ARCH_DELETE_MAIL, sql::ARCH_DELETE_KV, sql::ARCH_DELETE_IMPACT].map(|q| tx.execute(q, params![cutoff]).unwrap_or(0));
        tx.commit()?;
        archive_deleted = json!({"mailbox": counts[0], "kv": counts[1], "impact": counts[2]});
        crate::health::log_event("retention", "archive_delete", &archive_deleted.to_string());
    }

    for c in [&hot, &arch] {
        c.query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |_| Ok(()))?;
        c.execute_batch("VACUUM")?;
        c.query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |_| Ok(()))?;
    }
    let report = json!({
        "moved_to_archive": {"mailbox": mail, "kv": kv, "impact": impact},
        "pruned": {"applied_write_ids": pruned_applied},
        "archive_deleted": archive_deleted,
        "checkpointed": true,
        "vacuumed": true,
        "before": before,
        "after": sizes(dir),
        "ts_ms": now,
    });
    hot.execute(sql::MAINT_LOG, params![now, report.to_string()])?;
    if pruned_applied > 0 {
        crate::health::log_event("retention", "prune", &defaults::render("msg.log_pruned", &[("n", &pruned_applied)]));
    }
    Ok(report)
}

/// Maintenance runs so far and when the last one ran (ms since the epoch, 0 when never).
pub fn stats(c: &Connection) -> (u64, u64) {
    c.query_row(sql::MAINT_STATS, [], |r| Ok((r.get::<_, i64>(0)?.max(0) as u64, r.get::<_, i64>(1)?.max(0) as u64))).unwrap_or((0, 0))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::{Db, Op, ProjVerb, TempDir};
    use crate::storage::ImpactEvent;

    fn count(c: &Connection, q: &str) -> i64 {
        c.query_row(q, [], |r| r.get(0)).unwrap()
    }

    #[test]
    fn inactive_rows_move_to_the_archive_and_active_ones_stay() {
        let d = TempDir::new("maint");
        let db = Db::open(&d.0).unwrap();
        let w = |verb: ProjVerb| db.write(Op::Proj { project: "/p".into(), write_id: String::new(), verb }).unwrap();
        w(ProjVerb::Put("consumed".into()));
        w(ProjVerb::Put("pending".into()));
        w(ProjVerb::Take);
        w(ProjVerb::Set { key: "gone".into(), value: "old".into(), expires_ms: Some(1) });
        w(ProjVerb::Set { key: "live".into(), value: "v".into(), expires_ms: None });
        for _ in 0..3 {
            db.write(Op::Impact(ImpactEvent { ts_ms: 1, kind: "block".into(), check: "git".into(), reason: "r".into(), project: "p".into() })).unwrap();
        }
        // a consumed message counts as old enough only after retention; age it by hand
        let hot = Connection::open(d.0.join("hot.db")).unwrap();
        hot.execute("UPDATE mailbox SET consumed_ms = 1 WHERE consumed_ms IS NOT NULL", []).unwrap();
        let r = run(&d.0).unwrap();
        assert_eq!(r["moved_to_archive"]["mailbox"], 1, "{r}");
        assert_eq!(r["moved_to_archive"]["kv"], 1, "{r}");
        assert_eq!(r["moved_to_archive"]["impact"], 3, "{r}");
        assert_eq!(count(&hot, "SELECT COUNT(*) FROM mailbox"), 1, "the pending message stays in hot.db");
        assert_eq!(count(&hot, "SELECT COUNT(*) FROM kv"), 1, "the live key stays");
        assert_eq!(count(&hot, "SELECT count FROM impact_totals"), 3, "totals stay exact after the events move");
        let arch = Connection::open(d.0.join("archive.db")).unwrap();
        assert_eq!(count(&arch, "SELECT COUNT(*) FROM mailbox WHERE body = 'consumed'"), 1);
        assert_eq!(count(&arch, "SELECT COUNT(*) FROM kv WHERE key = 'gone'"), 1);
        assert_eq!(count(&arch, "SELECT COUNT(*) FROM impact"), 3);
        assert!(r["archive_deleted"].is_null(), "no hard delete unless configured (D26)");
        assert_eq!(stats(&hot).0, 1, "the run is recorded");
        let again = run(&d.0).unwrap();
        assert_eq!(again["moved_to_archive"]["mailbox"], 0, "a second run has nothing to move");
    }

    #[test]
    fn a_crash_between_copy_and_remove_loses_nothing_and_duplicates_nothing() {
        let d = TempDir::new("maint-crash");
        let db = Db::open(&d.0).unwrap();
        db.write(Op::Proj { project: "/p".into(), write_id: String::new(), verb: ProjVerb::Put("m".into()) }).unwrap();
        db.write(Op::Proj { project: "/p".into(), write_id: String::new(), verb: ProjVerb::Take }).unwrap();
        db.close();
        let hot = Connection::open(d.0.join("hot.db")).unwrap();
        hot.execute("UPDATE mailbox SET consumed_ms = 1", []).unwrap();
        // simulate the crash: the archive copy committed, hot.db still holds the row
        let arch = open_file(&d.0.join("archive.db"), "storage.archive_synchronous", sql::ARCHIVE_MIGRATIONS).unwrap();
        arch.execute(sql::ARCH_MAIL_INSERT, params![1, "/p", "m", 0, 1, 5]).unwrap();
        drop(arch);
        run(&d.0).unwrap();
        let arch = Connection::open(d.0.join("archive.db")).unwrap();
        assert_eq!(count(&arch, "SELECT COUNT(*) FROM mailbox"), 1, "one copy, not two");
        assert_eq!(count(&hot, "SELECT COUNT(*) FROM mailbox"), 0);
    }

    #[test]
    fn the_impact_cap_moves_the_oldest_events() {
        let d = TempDir::new("maint-cap");
        drop(Db::open(&d.0).unwrap()); // create and migrate
        let cap = defaults::num("retention.impact_hot_rows") as i64;
        let now = crate::health::now_ms() as i64;
        let mut hot = Connection::open(d.0.join("hot.db")).unwrap();
        let tx = hot.transaction().unwrap();
        for i in 0..cap + 5 {
            tx.execute(sql::IMPACT_INSERT, params![now, "block", "", i.to_string(), "p"]).unwrap();
        }
        tx.commit().unwrap();
        let r = run(&d.0).unwrap();
        assert_eq!(r["moved_to_archive"]["impact"], 5, "{r}");
        assert_eq!(count(&hot, "SELECT COUNT(*) FROM impact"), cap);
        assert_eq!(count(&hot, "SELECT MIN(CAST(reason AS INTEGER)) FROM impact"), 5, "the oldest moved first");
    }
}
