//! The app sync duty, native: one read of the DevSwarm desktop app's database per tick, applied to anti-hall's own state
//! (`appDbSyncIfDue` / `syncAppState` of `scripts/devswarm-lib/repair.js`), so a tick with nothing to change starts no Node process.
//!
//! In order: the archived markers for workspaces the app shows archived or deleted ([`plan::plan_marks`], never a delete, never an
//! overwrite), the retirement of markers the app shows open again, the names cache, the message-gap cross-check (at most every
//! `devswarm_sup.as_gap_cooldown_ms`), and `app-state.json`.
//!
//! The bar for what touches user state:
//! * a marker is written only from the engine's own plan ([`plan::plan_marks`]: never a delete, never an overwrite), each write
//!   recorded in the action ledger; the names cache and `app-state.json` only ever hold derived data;
//! * retiring a marker restores the descriptor and revives the registry row through the recon planner's own restore, and only then
//!   moves the marker to `archived-retired/` with a `retired` record (never a delete); a marker that cannot be restored stays and
//!   is named as pending;
//! * anything the engine cannot read exactly like JavaScript holds the whole sync before the first write, and every step is
//!   idempotent, so the next tick repeats nothing.
pub mod plan;
pub mod snap;
pub mod state;

use super::tick::Ctx;
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

fn log_native(ctx: &Ctx, rec: &Value) {
    crate::dsact::exec::append_line(&ctx.home.join(defaults::text("devswarm_sup.witness_file")), rec);
}

/// What one pass of the sync produced.
pub struct Pass {
    /// `appDbSyncIfDue`' record.
    pub record: Value,
    /// The `app-state.json` document (`None`: no database).
    pub state: Option<OVal>,
    /// The `retiredMarkers` summary (`None`: no database).
    pub retired: Option<OVal>,
}

/// How one pass runs.
#[derive(Debug, Clone, Copy, Default)]
pub struct Opts {
    /// Compute everything, write nothing and start no process.
    pub dry: bool,
    /// The message-gap cooldown in ms (`None`: `devswarm_sup.as_gap_cooldown_ms`); 0 scans every time.
    pub cooldown: Option<f64>,
    /// The CLI's rule: the marks are committed (`mark_committed`) as the first write.
    pub strict: bool,
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
    pass_with(ctx, runner, Opts { dry, ..Opts::default() })
}

/// [`pass`] with its options given.
pub fn pass_with(ctx: &Ctx, _runner: &dyn Runner, o: Opts) -> Result<Pass, Defer> {
    let dry = o.dry;
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
        return Ok(Pass { record: rec, state: None, retired: None });
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
        if o.strict {
            crate::meshw::mark_committed();
        }
        log_native(ctx, &json!({"ts": ctx.now, "duty": "app_sync-mark", "native": true, "ids": planned.len()}));
        for m in &marks.marks {
            let t0 = std::time::Instant::now();
            let outcome = match plan::write_marker(ctx.home, m, ctx.now) {
                plan::Wrote::Marked => {
                    marked += 1;
                    deleted += u64::from(m.deleted);
                    Some(defaults::text("devswarm_sup.as_action_marked"))
                }
                plan::Wrote::Exists => None,
                plan::Wrote::Failed(_) => {
                    errors += 1;
                    Some(defaults::text("devswarm_sup.as_action_failed"))
                }
            };
            if let Some(outcome) = outcome {
                super::tick::record_action(
                    ctx.home,
                    &super::tick::Action {
                        action: defaults::text("devswarm_sup.as_action_mark"),
                        target: &m.id,
                        inputs: json!({"deletedInApp": m.deleted}),
                        outcome,
                        reason: "",
                        latency_ms: t0.elapsed().as_millis() as u64,
                        now: ctx.now,
                    },
                );
            }
        }
    }
    let pending = (planned.len() as u64).saturating_sub(if dry { 0 } else { marked });
    let archived_summary =
        obj(vec![("marked", n(marked as f64)), ("pending", n(pending as f64)), ("deletedInApp", n(deleted as f64)), ("errors", n(errors as f64))]);
    // 2. the stale markers the app shows open: each is restored (descriptor, registry row) and only then moved to archived-retired/
    // (never deleted); one that cannot be restored stays where it is and is named as pending
    let retire = plan::plan_retire(ctx.home, &snap, ctx.now)?;
    let (mut retired, mut r_errors, mut r_gone) = (0u64, 0u64, 0u64);
    if !retire.ids.is_empty() && !dry {
        if o.strict {
            crate::meshw::mark_committed();
        }
        log_native(ctx, &json!({"ts": ctx.now, "duty": "app_sync-retire", "native": true, "ids": retire.ids.len()}));
        for id in &retire.ids {
            let t0 = std::time::Instant::now();
            let (outcome, reason) = match plan::retire_marker(ctx, id, id) {
                plan::Retired::Done => {
                    retired += 1;
                    (defaults::text("devswarm_sup.as_action_retired"), String::new())
                }
                plan::Retired::Gone => {
                    r_gone += 1;
                    continue;
                }
                plan::Retired::Left(why) => (defaults::text("devswarm_sup.as_action_left"), why),
                plan::Retired::Failed(why) => {
                    r_errors += 1;
                    (defaults::text("devswarm_sup.as_action_failed"), why)
                }
            };
            super::tick::record_action(
                ctx.home,
                &super::tick::Action {
                    action: defaults::text("devswarm_sup.as_action_retire"),
                    target: id,
                    inputs: json!({}),
                    outcome,
                    reason: &reason,
                    latency_ms: t0.elapsed().as_millis() as u64,
                    now: ctx.now,
                },
            );
        }
    }
    let r_pending = (retire.ids.len() as u64).saturating_sub(if dry { 0 } else { retired + r_gone });
    let retired_summary = obj(vec![("retired", n(retired as f64)), ("pending", n(r_pending as f64)), ("errors", n(r_errors as f64))]);
    let retired_out = retired_summary.clone();
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
    let (gaps, scanned) = match state::previous_gaps(&prev, ctx.now, o.cooldown)? {
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
    Ok(Pass { record: rec, state: Some(built.state), retired: Some(retired_out) })
}

/// The duty: native. Data the engine cannot read exactly like JavaScript holds the sync (nothing written, counted, tried again next tick).
pub fn duty(ctx: &Ctx, runner: &dyn Runner) -> Value {
    if !enabled(ctx) {
        return json!({"duty": "app_sync", "outcome": "ran", "detail": {"ran": false, "reason": defaults::text("devswarm_sup.as_reason_disabled")}});
    }
    match pass(ctx, runner, env_dry(ctx)) {
        Ok(p) => json!({"duty": "app_sync", "outcome": "ran", "detail": p.record}),
        Err(Defer(why)) => json!({"duty": "app_sync", "outcome": "held", "detail": super::tick::held("dssup:app_sync:read", &why)}),
    }
}
