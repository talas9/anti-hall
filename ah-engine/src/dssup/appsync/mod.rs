//! The app sync duty, native: one read of the DevSwarm desktop app's database per tick, applied to anti-hall's own state
//! (`appDbSyncIfDue` / `syncAppState` of `scripts/devswarm-lib/repair.js`), so a tick with nothing to change starts no Node process.
//!
//! In order: the archived markers for workspaces the app shows archived or deleted ([`plan::plan_marks`], never a delete, never an
//! overwrite), the retirement of markers the app shows open again, the names cache, the message-gap cross-check (at most every
//! `devswarm_sup.as_gap_cooldown_ms`), and `app-state.json`.
//!
//! The bar for what touches user state:
//! * a marker is written, and a marker retired, only when Node's own function, run read only (a dry run) on the same state, names
//!   exactly the same workspaces. A disagreement, or a Node that cannot run, does nothing for that step and logs it; the rest of
//!   the sync (names, state) still runs, because they only write derived caches;
//! * retiring a marker (a restored descriptor, a revived registry row, hard links) is executed by Node's own function, after that
//!   agreement: the engine decides, Node's function is the actor for the one step whose store and identity logic is not ported;
//! * anything the engine cannot read exactly like JavaScript hands the whole sync to Node's function, and every step is idempotent,
//!   so a hand-over after a partial pass repeats nothing.
//!
//! Every [`witness_every_ms`](crate::defaults) the whole state is also computed by Node's function read only and compared byte
//! for byte with the engine's; a mismatch is logged for review.
pub mod plan;
pub mod snap;
pub mod state;

use super::tick::{Ctx, node};
use crate::checks::guardkit::ojson::OVal;
use crate::defaults;
use crate::dsact::runner::Runner;
use crate::meshw::ident::{self, Defer};
use serde_json::{Value, json};
use std::path::Path;

/// Whether the sync is switched on (`devswarm.appSync`).
pub fn enabled(ctx: &Ctx) -> bool {
    super::setting(ctx.st, "devswarm_sup.set_app_sync").as_bool().unwrap_or(true)
}

fn state_path(home: &Path) -> std::path::PathBuf {
    super::root(home).join(defaults::text("devswarm_sup.as_state_file"))
}

fn witness_log(ctx: &Ctx, rec: &Value) {
    crate::dsact::exec::append_line(&ctx.home.join(defaults::text("devswarm_sup.witness_file")), rec);
}

/// The app database path as the Node snippets take it (`""` when the sync has none: they then use their own default).
fn app_db_arg(ctx: &Ctx) -> String {
    let env: ident::Env = ctx.st.env.clone();
    ident::app_db_path(ctx.home, &env).unwrap_or_else(|| defaults::text("mesh_write.app_db_off").to_string())
}

/// One Node snippet of the duty, bounded; its last output line as JSON.
fn ask_node(ctx: &Ctx, runner: &dyn Runner, key: &str) -> Result<Value, String> {
    let d = defaults::raw("devswarm_sup.duty.app_sync");
    let timeout = d.get("timeout_ms").and_then(crate::defaults::V::as_integer).unwrap_or(0).max(1) as u64;
    let r = node(runner, ctx, d.str_field(key), &[&app_db_arg(ctx), &ctx.now.to_string()], timeout);
    if !r.ok {
        return Err(r.error.clone().unwrap_or_else(|| if r.missing { defaults::text("devswarm_sup.msg_no_node").into() } else { super::tick::cut(&r.stderr) }));
    }
    serde_json::from_str(r.stdout.lines().rev().find(|l| !l.trim().is_empty()).unwrap_or_default()).map_err(|e| e.to_string())
}

fn ids_of(v: &Value) -> Vec<String> {
    v["ids"].as_array().map(|a| a.iter().filter_map(|x| x.as_str().map(str::to_string)).collect()).unwrap_or_default()
}

/// What one pass of the sync produced.
struct Pass {
    /// `appDbSyncIfDue`' record.
    record: Value,
    /// The `app-state.json` document (`None`: no database).
    state: Option<OVal>,
}

fn obj(v: Vec<(&str, OVal)>) -> OVal {
    OVal::Obj(v.into_iter().map(|(k, x)| (k.to_string(), x)).collect())
}

fn n(x: f64) -> OVal {
    OVal::Num(x)
}

/// The dry-run switch of Node's `syncAppState` (`ANTIHALL_INGEST_DRY_RUN=1` in the environment).
fn env_dry(ctx: &Ctx) -> bool {
    ctx.st.env.get(defaults::text("devswarm_sup.as_env_dry")).is_some_and(|v| v == defaults::text("devswarm_sup.as_env_dry_on"))
}

/// One pass. `dry`: compute everything, write nothing and start no process.
fn pass(ctx: &Ctx, runner: &dyn Runner, dry: bool) -> Result<Pass, Defer> {
    let started = std::time::Instant::now();
    let elapsed = || started.elapsed().as_millis() as u64;
    let env: ident::Env = ctx.st.env.clone();
    let file = ident::app_db_path(ctx.home, &env);
    let snap = match &file {
        Some(f) => snap::read(f)?,
        None => None,
    };
    let prev: Option<OVal> = std::fs::read(state_path(ctx.home)).ok().and_then(|b| OVal::parse(&String::from_utf8_lossy(&b)));
    let write_state = |state: &OVal| {
        if dry {
            return;
        }
        let p = state_path(ctx.home);
        if let Some(d) = p.parent() {
            crate::discard::harmless(std::fs::create_dir_all(d)); // keep: the write below reports the failure
        }
        crate::discard::harmless(crate::atomic::write(&p, state.stringify())); // keep: Node's `writeAtomicJson` failure ends the sync as an error; the next tick repeats it
    };
    let Some(snap) = snap else {
        let reason = defaults::text("devswarm_sup.as_reason_no_db");
        write_state(&obj(vec![("v", n(1.0)), ("at", n(ctx.now as f64)), ("ok", OVal::Bool(false)), ("reason", OVal::Str(reason.into()))]));
        let rec = json!({"ran": true, "ok": true, "appDb": false, "reason": reason, "elapsedMs": elapsed(), "archived": null, "names": null,
            "unknownToAntiHall": null, "gapTotal": null, "gapsScanned": false, "schemaMissing": null, "error": null});
        return Ok(Pass { record: rec, state: None });
    };
    // whatever the engine cannot read exactly like JavaScript must hand the sync over BEFORE the first write, so Node's own run
    // then reports the same counts it would have alone
    plan::read_json_dir(&plan::dir_of(ctx.home, "devswarm_sup.as_dir_workspaces"))?;
    plan::read_json_dir(&plan::dir_of(ctx.home, "devswarm_sup.as_dir_archived"))?;
    // 1. the archived markers
    let marks = plan::plan_marks(ctx.home, &snap)?;
    let (mut marked, mut deleted, mut errors) = (0u64, 0u64, 0u64);
    let planned: Vec<String> = marks.marks.iter().map(|m| m.id.clone()).collect();
    if !planned.is_empty() && !dry {
        match ask_node(ctx, runner, "mark_dry_snippet") {
            Ok(v) if ids_of(&v) == planned => {
                witness_log(ctx, &json!({"ts": ctx.now, "duty": "app_sync-mark", "match": true, "ids": planned.len()}));
                for m in &marks.marks {
                    match plan::write_marker(ctx.home, m, ctx.now) {
                        plan::Wrote::Marked => {
                            marked += 1;
                            deleted += u64::from(m.deleted);
                        }
                        plan::Wrote::Exists => {}
                        plan::Wrote::Failed(_) => errors += 1,
                    }
                }
            }
            Ok(v) => witness_log(ctx, &json!({"ts": ctx.now, "duty": "app_sync-mark", "match": false, "engine": planned, "node": v})),
            Err(why) => witness_log(ctx, &json!({"ts": ctx.now, "duty": "app_sync-mark", "match": Value::Null, "error": why})),
        }
    }
    let pending = (planned.len() as u64).saturating_sub(if dry { 0 } else { marked });
    let archived_summary = obj(vec![("marked", n(marked as f64)), ("pending", n(pending as f64)), ("deletedInApp", n(deleted as f64)), ("errors", n(errors as f64))]);
    // 2. the stale markers the app shows open
    let retire = plan::plan_retire(ctx.home, &snap, ctx.now)?;
    let (mut retired, mut r_errors) = (0u64, 0u64);
    let mut r_pending = retire.ids.len() as u64;
    if !retire.ids.is_empty() && !dry {
        match ask_node(ctx, runner, "retire_dry_snippet") {
            Ok(v) if ids_of(&v) == retire.ids => {
                witness_log(ctx, &json!({"ts": ctx.now, "duty": "app_sync-retire", "match": true, "ids": retire.ids.len()}));
                match ask_node(ctx, runner, "retire_snippet") {
                    Ok(r) => {
                        retired = r["retired"].as_u64().unwrap_or(0);
                        r_pending = r["pending"].as_u64().unwrap_or(0);
                        r_errors = r["errors"].as_u64().unwrap_or(0);
                    }
                    Err(why) => {
                        witness_log(ctx, &json!({"ts": ctx.now, "duty": "app_sync-retire", "match": Value::Null, "error": why}));
                        r_errors += 1;
                    }
                }
            }
            Ok(v) => witness_log(ctx, &json!({"ts": ctx.now, "duty": "app_sync-retire", "match": false, "engine": retire.ids, "node": v})),
            Err(why) => witness_log(ctx, &json!({"ts": ctx.now, "duty": "app_sync-retire", "match": Value::Null, "error": why})),
        }
    }
    let retired_summary = obj(vec![("retired", n(retired as f64)), ("pending", n(r_pending as f64)), ("errors", n(r_errors as f64))]);
    // 3. what is on disk now
    let descs = plan::read_json_dir(&plan::dir_of(ctx.home, "devswarm_sup.as_dir_workspaces"))?;
    let archived = plan::read_json_dir(&plan::dir_of(ctx.home, "devswarm_sup.as_dir_archived"))?;
    let (checked, refreshed) = if dry {
        (0, 0)
    } else {
        let all: Vec<plan::Desc> = descs.iter().chain(archived.iter()).cloned().collect();
        state::refresh_names(ctx.home, &snap, &all, ctx.now)?
    };
    let names_summary = obj(vec![("checked", n(checked as f64)), ("refreshed", n(refreshed as f64))]);
    // 4. the gaps, at most every cooldown
    let (gaps, scanned) = match state::previous_gaps(&prev, ctx.now)? {
        Some(g) => (g, false),
        None => (file.as_deref().map_or(Ok(None), |f| state::message_gaps(ctx.home, f, &snap, ctx.now))?.unwrap_or(OVal::Null), true),
    };
    let total = if matches!(gaps, OVal::Null) { None } else { Some(state::gap_total(&gaps)) };
    let built = state::build(
        &snap,
        &state::Inputs { home: ctx.home, now: ctx.now, descs: &descs, archived: &archived, archived_summary, retired_summary, names_summary, gaps },
    )?;
    write_state(&built.state);
    let rec = json!({"ran": true, "ok": true, "appDb": true, "reason": null, "elapsedMs": elapsed(),
        "archived": {"marked": marked, "pending": pending, "deletedInApp": deleted, "errors": errors},
        "names": {"checked": checked, "refreshed": refreshed}, "unknownToAntiHall": built.unknown, "gapTotal": total.map(|g| if g.fract() == 0.0 { json!(g as i64) } else { json!(g) }),
        "gapsScanned": scanned, "schemaMissing": snap.missing.len(), "error": null});
    Ok(Pass { record: rec, state: Some(built.state) })
}

/// The periodic comparison: Node's `syncAppState` in a dry run against the engine's own dry pass, byte for byte.
fn compare_with_node(ctx: &Ctx, runner: &dyn Runner) {
    if !super::witness::due(ctx, "app_sync") {
        return;
    }
    let mine = match pass(ctx, runner, true) {
        Ok(p) => p.state.map(|s| s.stringify()),
        Err(Defer(why)) => {
            witness_log(ctx, &json!({"ts": ctx.now, "duty": "app_sync", "match": Value::Null, "error": why}));
            return;
        }
    };
    let d = defaults::raw("devswarm_sup.duty.app_sync");
    let timeout = d.get("timeout_ms").and_then(crate::defaults::V::as_integer).unwrap_or(0).max(1) as u64;
    let r = node(runner, ctx, d.str_field("witness_snippet"), &[&app_db_arg(ctx), &ctx.now.to_string()], timeout);
    if !r.ok {
        witness_log(ctx, &json!({"ts": ctx.now, "duty": "app_sync", "match": Value::Null, "error": r.error.unwrap_or_else(|| super::tick::cut(&r.stderr))}));
        return;
    }
    let theirs = r.stdout.lines().rev().find(|l| !l.trim().is_empty()).unwrap_or_default().to_string();
    let engine = mine.unwrap_or_else(|| defaults::text("devswarm_sup.as_undefined").to_string());
    let same = engine == theirs;
    let at = engine.bytes().zip(theirs.bytes()).position(|(a, b)| a != b).unwrap_or(engine.len().min(theirs.len()));
    witness_log(ctx, &json!({"ts": ctx.now, "duty": "app_sync", "match": same, "firstDifference": if same { Value::Null } else { json!(at) }}));
}

/// The duty: native, or Node's function when the engine cannot read the data exactly like JavaScript.
pub fn duty(ctx: &Ctx, runner: &dyn Runner) -> Value {
    if !enabled(ctx) {
        return json!({"duty": "app_sync", "outcome": "ran", "detail": {"ran": false, "reason": defaults::text("devswarm_sup.as_reason_disabled")}});
    }
    if !env_dry(ctx) {
        compare_with_node(ctx, runner);
    }
    match pass(ctx, runner, env_dry(ctx)) {
        Ok(p) => json!({"duty": "app_sync", "outcome": "ran", "detail": p.record}),
        Err(Defer(why)) => {
            let d = defaults::raw("devswarm_sup.duty.app_sync");
            let timeout = d.get("timeout_ms").and_then(crate::defaults::V::as_integer).unwrap_or(0).max(1) as u64;
            let owner = if ctx.engine_pokes { defaults::text("devswarm_sup.owner_engine") } else { defaults::text("devswarm_sup.owner_node") };
            let r = node(runner, ctx, d.str_field("snippet"), &[owner], timeout);
            if r.ok {
                json!({"duty": "app_sync", "outcome": "ran", "detail": super::tick::parse(&r.stdout), "node": why})
            } else {
                json!({"duty": "app_sync", "outcome": "failed", "error": r.error.clone().unwrap_or_else(|| super::tick::cut(&r.stderr)), "status": r.status, "timedOut": r.timed_out, "node": why})
            }
        }
    }
}
