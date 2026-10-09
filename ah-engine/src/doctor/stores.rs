//! DevSwarm per-project stores that are leaked test fixtures (a registry with one row whose worktree is under a temp directory and
//! is gone): the report every `doctor` run gives, and the explicit `--repair-test-stores [--apply]`. Ported from
//! `doctor-repair.js` (`planLeakedTestFixtureStores`, `checkLeakedTestFixtureStores`, `runTestStoreRepair`).
//!
//! The repair never deletes: a store that still matches the exact criterion when the apply runs is moved aside (a rename inside the
//! DevSwarm directory, out of the stores' listing), so the data survives and the move can be undone. The stores the engine reads
//! are the SQLite ones; a store with a journal backend (or a forced one) is not inspected, and the report says so.
//!
//! Also here: `--repair-resurrected`, which needs the DevSwarm message-forwarding and liveness machinery the engine does not carry
//! yet: with no store on this machine it has nothing to do; with stores it is reported as deferred to the Node doctor.
use super::Doc;
use super::orphans::RepairRow;
use crate::defaults;
use crate::migrate::{self, Ctx};
use std::path::{Path, PathBuf};

/// One store that matches the leaked-fixture criterion.
pub struct Leak {
    hash: String,
    worktree: String,
}

/// What a scan of the stores found.
pub struct Scan {
    leaks: Vec<Leak>,
    /// Stores the engine does not read (journal backend).
    uninspected: Vec<String>,
}

fn store_dir(ctx: &Ctx, hash: &str) -> PathBuf {
    ctx.devswarm().join(defaults::text("migrate.store_dir")).join(hash)
}

/// The backend a store is on: `true` for SQLite, `false` for the journal (or anything the engine does not read).
fn is_sqlite(ctx: &Ctx, dir: &Path) -> bool {
    let forced = ctx.env.get(defaults::text("doctor.store_backend_env")).map(|v| v.trim().to_lowercase()).unwrap_or_default();
    if forced == defaults::text("doctor.backend_journal") {
        return false;
    }
    if forced == defaults::text("doctor.backend_sqlite") {
        return true;
    }
    let marker = std::fs::read_to_string(dir.join(defaults::text("doctor.backend_marker"))).map(|t| t.trim().to_lowercase()).unwrap_or_default();
    if marker == defaults::text("doctor.backend_journal") {
        return false;
    }
    if marker == defaults::text("doctor.backend_sqlite") {
        return true;
    }
    if std::fs::metadata(dir.join(defaults::text("doctor.store_db"))).is_ok_and(|m| m.len() > 0) {
        return true;
    }
    // no database: a journal that holds files is a journal store; a fresh directory has nothing to read either way
    !std::fs::read_dir(dir.join(defaults::text("migrate.store_journal_dir"))).is_ok_and(|mut d| d.next().is_some())
}

/// The `worktree_path` of every registry row of a SQLite store, read-only. `None` when the store cannot be read.
fn registry_worktrees(dir: &Path) -> Option<Vec<Option<String>>> {
    let db = dir.join(defaults::text("doctor.store_db"));
    let conn = rusqlite::Connection::open_with_flags(&db, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX).ok()?;
    let mut st = conn.prepare(defaults::text("doctor.registry_query")).ok()?;
    let rows = st.query_map([], |r| r.get::<_, Option<String>>(0)).ok()?;
    rows.collect::<Result<Vec<_>, _>>().ok()
}

fn tmp_like(ctx: &Ctx, p: &str) -> bool {
    let tmp = ctx
        .env
        .get(defaults::text("doctor.tmpdir_env"))
        .filter(|t| !t.is_empty())
        .cloned()
        .unwrap_or_else(|| defaults::text("doctor.tmpdir_default").to_string());
    let tmp = tmp.trim_end_matches('/');
    p.starts_with(tmp) || defaults::list("doctor.tmp_prefixes").iter().any(|pre| p.starts_with(pre))
}

/// `planLeakedTestFixtureStores`, over every store the engine can read.
pub fn scan(ctx: &Ctx) -> Scan {
    let mut out = Scan { leaks: Vec::new(), uninspected: Vec::new() };
    for hash in migrate::list_store_hashes(ctx) {
        let dir = store_dir(ctx, &hash);
        if !is_sqlite(ctx, &dir) {
            out.uninspected.push(hash);
            continue;
        }
        let Some(rows) = registry_worktrees(&dir) else { continue };
        let [Some(wt)] = rows.as_slice() else { continue };
        if tmp_like(ctx, wt) && !Path::new(wt).exists() {
            out.leaks.push(Leak { hash, worktree: wt.clone() });
        }
    }
    out
}

/// The always-on report of leaked fixture stores; silent when there are none.
pub fn detect_section(doc: &mut Doc, ctx: &Ctx) {
    let found = scan(ctx);
    if found.leaks.is_empty() {
        return;
    }
    let cap = defaults::num("doctor.leaks_examples") as usize;
    let shown: Vec<String> =
        found.leaks.iter().take(cap).map(|l| defaults::render("doctor_msg.leak_example", &[("hash", &l.hash), ("worktree", &l.worktree)])).collect();
    let more = if found.leaks.len() > cap { defaults::render("doctor_msg.leak_more", &[("n", &(found.leaks.len() - cap))]) } else { String::new() };
    doc.head(defaults::text("doctor_msg.head_leaks"));
    doc.warnl(defaults::render("doctor_msg.leak_summary", &[("count", &found.leaks.len()), ("shown", &shown.join(", ")), ("more", &more)]));
}

/// `runTestStoreRepair`: the plan as dry-run rows, or, with `apply`, each store that still matches moved aside.
pub fn repair_test_stores(ctx: &Ctx, apply: bool) -> Vec<RepairRow> {
    let id = defaults::text("doctor.repair_stores_id").to_string();
    let found = scan(ctx);
    let mut rows: Vec<RepairRow> = Vec::new();
    if found.leaks.is_empty() {
        rows.push((id.clone(), "skipped", defaults::text("doctor_msg.stores_none").to_string()));
    }
    for leak in &found.leaks {
        let row_id = defaults::render("doctor.repair_store_id", &[("hash", &leak.hash)]);
        let dir = store_dir(ctx, &leak.hash);
        if !apply {
            rows.push((row_id, "skipped", defaults::render("doctor_msg.stores_would", &[("dir", &dir.display()), ("worktree", &leak.worktree)])));
            continue;
        }
        // the same criterion again immediately before the move: a store that became live in between is left alone
        let still = is_sqlite(ctx, &dir)
            && registry_worktrees(&dir).is_some_and(|r| matches!(r.as_slice(), [Some(wt)] if *wt == leak.worktree) && !Path::new(&leak.worktree).exists());
        if !still {
            rows.push((row_id, "skipped", defaults::text("doctor_msg.stores_changed").to_string()));
            continue;
        }
        let stamp = crate::checks::jsport::date::to_iso(crate::checks::jsport::date::now_ms()).unwrap_or_default().replace([':', '.'], "-");
        let dest = ctx.devswarm().join(defaults::text("doctor.stores_aside_dir")).join(format!("{}-{stamp}", leak.hash));
        let moved = dest.parent().map_or(Ok(()), std::fs::create_dir_all).and_then(|()| std::fs::rename(&dir, &dest));
        match moved {
            Ok(()) => rows.push((
                row_id,
                "fixed",
                defaults::render("doctor_msg.stores_moved", &[("dir", &dir.display()), ("dest", &dest.display()), ("worktree", &leak.worktree)]),
            )),
            Err(e) => rows.push((row_id, "failed", defaults::render("doctor_msg.stores_failed", &[("dir", &dir.display()), ("error", &e)]))),
        }
    }
    if !found.uninspected.is_empty() {
        rows.push((id, "gated", defaults::render("doctor_msg.stores_uninspected", &[("n", &found.uninspected.len())])));
    }
    rows
}

/// `runResurrectedRepair`: with no store there is nothing to do; with stores the engine defers to the Node doctor (nothing is touched).
pub fn repair_resurrected(ctx: &Ctx) -> Vec<RepairRow> {
    let id = defaults::text("doctor.repair_resurrected_id").to_string();
    if migrate::list_store_hashes(ctx).is_empty() {
        vec![(id, "skipped", defaults::text("doctor_msg.resurrected_none").to_string())]
    } else {
        vec![(id, "gated", defaults::text("doctor_msg.resurrected_deferred").to_string())]
    }
}
