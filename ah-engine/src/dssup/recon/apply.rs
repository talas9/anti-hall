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
            Op::Append { .. } | Op::Rename { .. } | Op::Derive { .. } | Op::Log { .. } | Op::Pull { .. } => {}
        }
    }
    Ok(())
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
            c.prepare_cached(crate::sql::MESHW_REGISTRY_UPSERT)?
                .execute(rusqlite::params![row.id, row.worktree_path, row.session_id, row.inbox_path, row.cursor_path, row.nudge_command, env.now])?;
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
        Op::Append { rel, bytes } => {
            mkparent(&at(rel))?;
            let mut f = std::fs::OpenOptions::new().create(true).append(true).open(at(rel)).map_err(|e| e.to_string())?;
            f.write_all(bytes).map_err(|e| e.to_string())
        }
        Op::Rename { rel, to } => {
            if !at(rel).exists() {
                return Ok(());
            }
            mkparent(&at(to))?;
            std::fs::rename(at(rel), at(to)).map_err(|e| e.to_string())
        }
        Op::Upsert { store, row, pre } => upsert(env, store, row, pre),
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
            Err(e) => UnitEnd::Failed(e),
        },
    };
    if let Some(h) = held {
        h.release();
    }
    end
}
