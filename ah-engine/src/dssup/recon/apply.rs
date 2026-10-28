//! Applying an op list: the one piece of code that touches a home, whether the home is a scratch mirror (`M_eng`) or the real
//! one. A unit is applied under its lock, after every precondition the plan recorded is re-checked; a drifted precondition
//! writes nothing for the unit.
use super::view::{pre_of, registry};
use super::{Hooks, Op, Pre, RegRow, Unit, UnitEnd};
use crate::checks::git::util::Settings;
use crate::checks::guardkit::ojson::OVal;
use crate::defaults;
use crate::meshw::common::Inv;
use crate::meshw::store::{MeshStore, RegistryRow};
use std::io::Write;
use std::path::{Path, PathBuf};

/// Where and when ops are applied.
pub struct Env<'a> {
    /// The home the ops touch.
    pub home: &'a Path,
    /// The clock (`updated_at`, `generatedAt`): the real one, or the pinned one the witness gave Node.
    pub now: i64,
    /// The settings tiers (environment for the summary projection).
    pub st: &'a Settings,
    /// The central log's directory; `None` is the home's own (`.anti-hall/logs`).
    pub log_dir: Option<PathBuf>,
}

impl Env<'_> {
    fn inv(&self) -> Inv {
        Inv {
            home: self.home.to_path_buf(),
            env: self.st.env.clone(),
            cwd: String::new(),
            now: self.now,
            stdin: None,
            write_home: self.home.to_path_buf(),
            store_override: None,
        }
    }

    /// A scratch mirror (the witness redirects its central log; the real home never does). A mirror's inodes are its own, so
    /// an inode recorded from the real home is only checked on the real one.
    fn is_mirror(&self) -> bool {
        self.log_dir.is_some()
    }

    fn log_dir(&self) -> PathBuf {
        self.log_dir.clone().unwrap_or_else(|| self.home.join(defaults::text("mesh_write.dir_anti_hall")).join(defaults::text("mesh_write.dir_logs")))
    }
}

fn pre_ok(home: &Path, rel: &str, pre: &Pre) -> Result<(), String> {
    let now = pre_of(home, rel);
    match pre {
        Pre::Any => Ok(()),
        p if *p == now => Ok(()),
        _ => Err(rel.to_string()),
    }
}

/// The row of `id` now, as the plan's `pre` would have read it.
fn row_now(home: &Path, store: &str, id: &str) -> Result<Option<RegRow>, String> {
    let rows = registry(home, store).map_err(|d| d.0)?;
    Ok(rows.into_iter().find(|r| r.row.id == id))
}

/// Re-check every precondition of `ops`; the text names the first that drifted.
pub fn check(env: &Env, ops: &[Op]) -> Result<(), String> {
    for op in ops {
        match op {
            Op::Write { rel, pre, .. } | Op::Unlink { rel, pre } => pre_ok(env.home, rel, pre)?,
            Op::Upsert { store, row, pre } => {
                if row_now(env.home, store, &row.id)?.map(Box::new) != *pre {
                    return Err(format!("{store}:{}", row.id));
                }
            }
            Op::RemoveRegistryIf { store, id, pre, .. } => {
                if row_now(env.home, store, id)?.map(Box::new).as_ref() != Some(pre) {
                    return Err(format!("{store}:{id}"));
                }
            }
            Op::Guard { store, partition, sig, files } => {
                if super::view::partition_sig(env.home, store, partition).map_err(|d| d.0)? != *sig {
                    return Err(format!("{store}:{partition}"));
                }
                for (rel, pre) in files {
                    pre_ok(env.home, rel, pre)?;
                }
            }
            Op::Link { from, pre, ino, .. } => {
                pre_ok(env.home, from, pre)?;
                if !env.is_mirror()
                    && let Some(want) = ino
                    && ino_of(&env.home.join(from)) != Some(*want)
                {
                    return Err(from.clone());
                }
            }
            Op::Remove { store, guard } => {
                if row_now(env.home, store, &guard.row.id)?.map(Box::new).as_ref() != Some(guard) {
                    return Err(format!("{store}:{}", guard.row.id));
                }
            }
            Op::Append { .. }
            | Op::Rename { .. }
            | Op::Derive { .. }
            | Op::Log { .. }
            | Op::UnlinkLinked { .. }
            | Op::Forward { .. }
            | Op::Mkdir { .. }
            | Op::RaiseCursors { .. }
            | Op::ImportCursors { .. }
            | Op::Pull { .. } => {}
        }
    }
    Ok(())
}

/// `(device, inode)` of the file at `p` without following a link; `None` when it is not there.
pub fn ino_of(p: &Path) -> Option<(u64, u64)> {
    use std::os::unix::fs::MetadataExt;
    std::fs::symlink_metadata(p).ok().map(|m| (m.dev(), m.ino()))
}

fn remove_guarded(env: &Env, store: &str, guard: &RegRow) -> Result<(), String> {
    let st = MeshStore::open(&super::view::store_db(env.home, store)).map_err(|e| e.to_string())?;
    let c = st.reader().conn();
    let g = &guard.row;
    let n = crate::meshw::store::retry_busy(|| {
        c.prepare_cached(crate::sql::RECON_REGISTRY_DELETE_IF)?.execute(rusqlite::params![g.id, g.session_id, guard.updated_at, guard.write_seq])
    })
    .map_err(|e| e.to_string())?;
    if n == 1 { Ok(()) } else { Err(format!("drift:{store}:{}", g.id)) }
}

fn upsert(env: &Env, store: &str, row: &RegistryRow, pre: &Option<Box<RegRow>>) -> Result<(), String> {
    let db = super::view::store_db(env.home, store);
    let st = MeshStore::open(&db).map_err(|e| e.to_string())?;
    let c = st.reader().conn();
    crate::meshw::store::retry_busy(|| {
        c.execute_batch(crate::sql::MESHW_BEGIN_IMMEDIATE)?;
        let r = (|| -> rusqlite::Result<bool> {
            let now: Option<RegRow> = c
                .prepare_cached(crate::sql::RECON_REGISTRY_ONE)?
                .query_map(rusqlite::params![row.id], |r| {
                    Ok(RegRow {
                        row: RegistryRow {
                            id: r.get(0)?,
                            worktree_path: r.get(1)?,
                            session_id: r.get(2)?,
                            inbox_path: r.get(3)?,
                            cursor_path: r.get(4)?,
                            nudge_command: r.get(5)?,
                        },
                        updated_at: r.get(6)?,
                        write_seq: r.get(7)?,
                    })
                })?
                .next()
                .transpose()?;
            if now.map(Box::new) != *pre {
                return Ok(false);
            }
            c.prepare_cached(crate::sql::MESHW_REGISTRY_UPSERT)?.execute(rusqlite::params![
                row.id,
                row.worktree_path,
                row.session_id,
                row.inbox_path,
                row.cursor_path,
                row.nudge_command,
                env.now
            ])?;
            Ok(true)
        })();
        match r {
            Ok(true) => c.execute_batch(crate::sql::MESHW_COMMIT).map(|()| true),
            Ok(false) => c.execute_batch(crate::sql::MESHW_ROLLBACK).map(|()| false),
            Err(e) => {
                crate::discard::harmless(c.execute_batch(crate::sql::MESHW_ROLLBACK)); // keep: the statement's own error is the one reported
                Err(e)
            }
        }
    })
    .map_err(|e| e.to_string())
    .and_then(|applied| if applied { Ok(()) } else { Err(format!("drift:{store}:{}", row.id)) })
}

/// The failure text of an op that wrote nothing and left the unit untouched: the unit is handed back, not failed.
pub fn skip(why: &str) -> String {
    format!("{}{why}", defaults::text("devswarm_recon.skip_prefix"))
}

fn open_store(env: &Env, store: &str) -> Result<MeshStore, String> {
    MeshStore::open(&super::view::store_db(env.home, store)).map_err(|e| e.to_string())
}

/// `appendIntoPartition` for mesh rows: the destination's id lock, a recheck that it is still registered, then the inserts.
fn forward(env: &Env, store: &str, dest: &str, rows: &[crate::meshw::store::MeshRow], allow_archived: bool) -> Result<(), String> {
    let Some(held) = crate::meshw::idlock::acquire(env.home, dest) else { return Err(skip(defaults::text("devswarm_recon.why_lock_busy"))) };
    let done = (|| -> Result<bool, String> {
        let st = open_store(env, store)?;
        let registered = st.is_registered(dest).map_err(|e| e.to_string())?;
        if !registered && !(allow_archived && crate::meshw::summary::archive_complete_ids(env.home).contains(dest)) {
            return Ok(false);
        }
        for m in rows {
            st.append_mesh_row(m).map_err(|e| e.to_string())?;
        }
        Ok(true)
    })();
    held.release();
    match done {
        Ok(true) => Ok(()),
        Ok(false) => Err(skip(defaults::text("devswarm_recon.why_dest_gone"))),
        Err(e) => Err(e),
    }
}

/// `importLegacy` for a partition whose floor rows are missing (see [`Op::ImportCursors`]).
fn import_cursors(env: &Env, store: &str, partition: &str) -> Result<(), String> {
    use crate::migrate::readercur::{Cx, Handle, import_legacy};
    let h = Handle::Rw(open_store(env, store)?);
    let mut cx = Cx::new(&env.home.to_string_lossy());
    cx.now = env.now;
    import_legacy(&mut cx, &h, partition, None, false)?;
    if cx.deferred {
        return Err(skip(defaults::text("devswarm_recon.why_import_undecided")));
    }
    Ok(())
}

/// `raiseAllLossFree` (store namespace) and the legacy projection after it, with the clock the witness pinned.
fn raise(env: &Env, store: &str, partition: &str, value: i64) -> Result<(), String> {
    let st = open_store(env, store)?;
    let ns = defaults::text("mesh_write.cursor_ns_store");
    let moved = st
        .cursor_txn(|tx| {
            let rows = tx.rows(partition)?;
            if crate::meshw::cursors::needs_import(&rows) {
                return Ok(None);
            }
            let mut n = 0;
            for r in rows.iter().filter(|r| r.ns == ns && r.value < value) {
                let retired = crate::meshw::cursors::is_retired(r);
                tx.put(&crate::meshw::store::CursorPut {
                    partition: partition.into(),
                    ns: ns.into(),
                    reader: r.reader.clone(),
                    value,
                    retired_line: retired.then_some(Some(value)),
                    updated_at: env.now,
                })?;
                n += 1;
            }
            Ok(Some(n))
        })
        .map_err(|e| e.to_string())?;
    if moved.is_none() {
        return Err(defaults::text("mesh_write.err_cursor_import_needed").to_string());
    }
    // dualWrite: best effort, upward only
    if value > 0 {
        if crate::meshw::cursors::legacy_safe(partition) {
            let p = crate::meshw::cursors::primary_cursor_path(env.home, partition);
            if crate::meshw::cursors::read_cursor(&p) < value as f64 {
                crate::discard::harmless(crate::meshw::cursors::ack_to(&p, value as f64)); // keep: the projection is best-effort in Node
            }
        }
        if (st.reader().cursor(partition).unwrap_or(0) as i64) < value {
            crate::discard::harmless(st.set_cursor(partition, value, env.now)); // keep: as above
        }
    }
    Ok(())
}

/// `logCursorWrite`'s rotation, loss-free: once the journal holds more than `cap` non-blank records, the newest `cap` stay and the
/// older ones are APPENDED to the journal's older file (`.1`); what that file already holds stays. The overflow is written first, so
/// a failure in between leaves every record in at least one of the two files (at worst in both: a repeat, never a loss).
fn rotate_tail(path: &Path, cap: usize) -> Result<(), String> {
    let text = std::fs::read_to_string(path).map_err(|e| e.to_string())?;
    let lines: Vec<&str> = text.split('\n').filter(|l| !l.trim().is_empty()).collect();
    if lines.len() <= cap {
        return Ok(());
    }
    let (old, keep) = lines.split_at(lines.len() - cap);
    let mut older = path.as_os_str().to_os_string();
    older.push(defaults::text("devswarm_recon.cursor_log_older_suffix"));
    crate::meshw::cursors::append_older(&std::path::PathBuf::from(older), &format!("{}\n", old.join("\n"))).map_err(|e| e.to_string())?;
    crate::atomic::write(path, format!("{}\n", keep.join("\n"))).map_err(|e| e.to_string())
}

/// `removeRegistryIf`: the NULL-safe conditional delete of one registry row.
fn remove_if(env: &Env, store: &str, id: &str, session_id: &Option<String>, updated_at: Option<i64>, write_seq: Option<i64>) -> Result<(), String> {
    let st = open_store(env, store)?;
    let c = st.reader().conn();
    let n = crate::meshw::store::retry_busy(|| {
        c.prepare_cached(crate::sql::RECON_REGISTRY_DELETE_IF)?.execute(rusqlite::params![id, session_id, updated_at, write_seq])
    })
    .map_err(|e| e.to_string())?;
    if n == 0 { Err(format!("drift:{store}:{id}")) } else { Ok(()) }
}

fn log_line(env: &Env, component: &str, op: &str, level: &str, msg: &str, ctx: &str) {
    let f = defaults::list("devswarm_cli.log_entry_fields");
    let mut rest = match OVal::parse(ctx) {
        Some(OVal::Obj(o)) => o,
        _ => Vec::new(),
    };
    let take = |rest: &mut Vec<(String, OVal)>, k: &str| rest.iter().position(|(n, _)| n == k).map(|i| rest.remove(i).1);
    let repo = take(&mut rest, f[4]).unwrap_or_else(|| {
        env.st.env.get(defaults::text("devswarm_cli.log_env_repo_key")).filter(|v| !v.is_empty()).map_or(OVal::Null, |v| OVal::Str(v.clone()))
    });
    let mesh = take(&mut rest, f[5]).unwrap_or(OVal::Null);
    let mut e = vec![
        (f[0].to_string(), OVal::Str(crate::checks::taskkit::time::iso(crate::health::now_ms() as i64))),
        (f[1].to_string(), OVal::Str(component.to_string())),
        (f[2].to_string(), OVal::Str(op.to_string())),
        (f[3].to_string(), OVal::Str(level.to_string())),
        (f[4].to_string(), repo),
        (f[5].to_string(), mesh),
        (f[6].to_string(), OVal::Num(f64::from(std::process::id()))),
        (f[7].to_string(), OVal::Str(msg.to_string())),
    ];
    if !rest.is_empty() {
        e.push((f[9].to_string(), OVal::Obj(rest)));
    }
    crate::meshw::clog::write_line(&env.log_dir(), &format!("{}\n", OVal::Obj(e).stringify()));
}

fn run_op(env: &Env, op: &Op, hook: &dyn Fn(&str)) -> Result<(), String> {
    let at = |rel: &str| env.home.join(rel);
    let mkparent = |p: &Path| p.parent().map_or(Ok(()), std::fs::create_dir_all).map_err(|e| e.to_string());
    match op {
        Op::Write { rel, bytes, .. } => {
            mkparent(&at(rel))?;
            crate::atomic::write(at(rel), bytes).map_err(|e| e.to_string())
        }
        Op::Unlink { rel, .. } => match std::fs::remove_file(at(rel)) {
            Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(e.to_string()),
            _ => Ok(()),
        },
        Op::Append { rel, bytes, keep } => {
            mkparent(&at(rel))?;
            let mut f = std::fs::OpenOptions::new().create(true).append(true).open(at(rel)).map_err(|e| e.to_string())?;
            f.write_all(bytes).map_err(|e| e.to_string())?;
            match keep {
                Some(cap) => rotate_tail(&at(rel), *cap),
                None => Ok(()),
            }
        }
        Op::Rename { rel, to } => {
            if !at(rel).exists() {
                return Ok(());
            }
            mkparent(&at(to))?;
            std::fs::rename(at(rel), at(to)).map_err(|e| e.to_string())
        }
        Op::Upsert { store, row, pre } => upsert(env, store, row, pre),
        Op::Forward { store, dest, rows, allow_archived } => forward(env, store, dest, rows, *allow_archived),
        Op::Mkdir { rel } => std::fs::create_dir_all(at(rel)).map_err(|e| e.to_string()),
        Op::ImportCursors { store, partition } => import_cursors(env, store, partition),
        Op::RaiseCursors { store, partition, value } => raise(env, store, partition, *value),
        Op::RemoveRegistryIf { store, id, session_id, updated_at, write_seq, .. } => remove_if(env, store, id, session_id, *updated_at, *write_seq),
        Op::Guard { .. } => Ok(()),
        Op::Link { from, to, .. } => {
            mkparent(&at(to))?;
            match std::fs::hard_link(at(from), at(to)) {
                Err(e) if e.kind() != std::io::ErrorKind::AlreadyExists => Err(e.to_string()),
                _ => Ok(()),
            }
        }
        Op::UnlinkLinked { rel, other } => match (ino_of(&at(rel)), ino_of(&at(other))) {
            (None, _) => Ok(()),
            (Some(a), Some(b)) if a == b => std::fs::remove_file(at(rel)).map_err(|e| e.to_string()),
            _ => Err(defaults::render("devswarm_recon.msg_not_linked", &[("rel", rel), ("other", other)])),
        },
        Op::Remove { store, guard } => remove_guarded(env, store, guard),
        Op::Derive { store } => {
            let st = MeshStore::open(&super::view::store_db(env.home, store)).map_err(|e| e.to_string())?;
            match crate::meshw::summary::derive_after_write(&st, &env.inv(), store) {
                None => Ok(()),
                Some(why) => Err(format!("derive:{why}")),
            }
        }
        Op::Pull { id, cwd } => super::pull::apply_pull(env, id, cwd, hook),
        Op::Log { component, op, level, msg, ctx } => {
            log_line(env, component, op, level, msg, ctx);
            Ok(())
        }
    }
}

/// Apply every op of `ops` in order (no lock, no precondition check: the caller did both).
pub fn run(env: &Env, label: &str, ops: &[Op], hooks: &Hooks) -> Result<(), String> {
    for (i, op) in ops.iter().enumerate() {
        (hooks.at)(&format!("{label}:{i}:before"));
        run_op(env, op, hooks.at)?;
        (hooks.at)(&format!("{label}:{i}:after"));
    }
    Ok(())
}

/// One unit, the way it is applied to a real home: take its lock (a busy lock is a deferral, nothing written), re-check the
/// preconditions (drift is a deferral), apply the ops. A step that fails after earlier steps landed is [`UnitEnd::Failed`].
pub fn unit(env: &Env, u: &Unit, hooks: &Hooks) -> UnitEnd {
    let held = match &u.lock {
        Some(id) => match crate::meshw::idlock::acquire(env.home, id) {
            Some(h) => Some(h),
            None => return UnitEnd::Deferred(defaults::text("devswarm_recon.why_lock_busy").to_string()),
        },
        None => None,
    };
    let end = match check(env, &u.ops) {
        Err(what) => UnitEnd::Deferred(format!("{}{what}", defaults::text("devswarm_recon.why_drift"))),
        Ok(()) => match run(env, &u.label, &u.ops, hooks) {
            Ok(()) => UnitEnd::Applied,
            Err(e) if e.starts_with(defaults::text("devswarm_recon.skip_prefix")) => UnitEnd::Deferred(e),
            Err(e) => UnitEnd::Failed(e),
        },
    };
    if let Some(h) = held {
        h.release();
    }
    end
}

#[cfg(test)]
mod rotation_tests {
    use super::*;

    #[test]
    fn dssup_recon_cursor_log_rotation_keeps_the_newest_records_and_appends_the_older_ones_to_dot_one() {
        crate::defaults::init().unwrap();
        let d = crate::db::TempDir::new("cursor-rotation");
        let p = d.0.join(defaults::text("devswarm_recon.file_samples"));
        std::fs::write(&p, "{\"n\":1}\n{\"n\":2}\n\n{\"n\":3}\n{\"n\":4}\n").unwrap();
        let older = d.0.join(format!("{}{}", defaults::text("devswarm_recon.file_samples"), defaults::text("devswarm_recon.cursor_log_older_suffix")));
        std::fs::write(&older, "{\"n\":0}\n").unwrap();
        // at or under the cap nothing moves
        rotate_tail(&p, 4).unwrap();
        assert_eq!(std::fs::read_to_string(&older).unwrap(), "{\"n\":0}\n");
        // over it: the newest two stay, the older two go to the END of `.1`; what `.1` held stays (nothing is lost)
        rotate_tail(&p, 2).unwrap();
        assert_eq!(std::fs::read_to_string(&p).unwrap(), "{\"n\":3}\n{\"n\":4}\n");
        assert_eq!(std::fs::read_to_string(&older).unwrap(), "{\"n\":0}\n{\"n\":1}\n{\"n\":2}\n");
        // a second rotation appends again
        std::fs::write(&p, "{\"n\":3}\n{\"n\":4}\n{\"n\":5}\n").unwrap();
        rotate_tail(&p, 2).unwrap();
        assert_eq!(std::fs::read_to_string(&older).unwrap(), "{\"n\":0}\n{\"n\":1}\n{\"n\":2}\n{\"n\":3}\n");
    }
}

#[cfg(test)]
mod import_tests {
    use super::*;

    #[test]
    fn dssup_recon_import_cursors_creates_the_floors_once_so_the_raise_can_run() {
        crate::defaults::init().unwrap();
        let dir = crate::db::TempDir::new("import-cursors");
        let home = dir.0.join("home");
        std::fs::create_dir_all(&home).unwrap();
        let st = Settings { home: home.to_string_lossy().into_owned(), env: std::collections::HashMap::new() };
        let env = Env { home: &home, now: 1_760_000_000_000, st: &st, log_dir: None };
        let rows = |partition: &str| crate::meshw::cursors::rows_of(&open_store(&env, "store").unwrap(), partition).unwrap();
        // a partition nobody imported yet: the raise refuses (it would have to import first) ...
        assert!(crate::meshw::cursors::needs_import(&rows("p1")));
        assert!(raise(&env, "store", "p1", 5).is_err());
        // ... the import op creates the floor of every namespace ...
        run_op(&env, &Op::ImportCursors { store: "store".into(), partition: "p1".into() }, &|_| {}).unwrap();
        let after = rows("p1");
        assert!(!crate::meshw::cursors::needs_import(&after), "{after:?}");
        let floor = defaults::text("mesh_write.floor_reader");
        assert_eq!(after.iter().filter(|r| r.reader == floor).count(), defaults::list("mesh_write.cursor_namespaces").len());
        // ... a second import writes nothing (the floors are the gate) ...
        run_op(&env, &Op::ImportCursors { store: "store".into(), partition: "p1".into() }, &|_| {}).unwrap();
        assert_eq!(rows("p1"), after);
        // ... and the raise lifts every row of the namespace, floor included
        run_op(&env, &Op::RaiseCursors { store: "store".into(), partition: "p1".into(), value: 5 }, &|_| {}).unwrap();
        let ns = defaults::text("mesh_write.ns_store");
        let raised = rows("p1");
        assert!(raised.iter().filter(|r| r.ns == ns).all(|r| r.value == 5), "{raised:?}");
    }
}
