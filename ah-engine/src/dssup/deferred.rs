//! The deferred post-update stage, native: `deferredSweepIfDue` of `companion/devswarm-supervisor.js`.
//!
//! Every tick the supervisor takes ONE of four post-update stages in rotation (`fold-all-stores`, `heal-orphan-partitions`,
//! `fold-archived-rows`, `heal-registry-rows`), but only runs it when the stage's OWN marker says work was deferred. The
//! rotation cursor (`deferred-sweep-state.json`), the marker peek and the "nothing pending" answer are the whole tick on a
//! machine with nothing deferred, so they are native: no Node process is started for a no-op tick. A stage that has work is run
//! by Node's own `runDeferredStage` (the stage bodies are the store folds of `update.js`, thousands of lines that move user
//! data and are not ported).
//!
//! Like Node, the cursor is advanced BEFORE the stage is peeked or run, so a stage that hangs or fails is not retried first on
//! every tick. A cursor the engine cannot read exactly like Node (a fractional index selects no stage in JavaScript) hands the
//! tick to Node's function.
// Discard triage (E3): every `.ok()` / `unwrap_or_default()` in this module is a deliberate keep, for these reasons:
// - an unreadable marker or cursor is the absent one (Node: `try { JSON.parse(...) } catch (_) {}`, fail-open to "nothing pending")
use super::tick::{Ctx, node};
use crate::checks::guardkit::ojson::OVal;
use crate::defaults;
use crate::dsact::runner::Runner;
use crate::meshw::idlock::devswarm_root;
use serde_json::{Value, json};
use std::path::Path;

fn read(p: &Path) -> Option<OVal> {
    std::fs::read(p).ok().and_then(|b| OVal::parse(&String::from_utf8_lossy(&b)))
}

/// The rotation cursor: `Some(index)` for a usable one, `Err` for a value JavaScript would index differently.
fn cursor(home: &Path) -> Result<usize, ()> {
    let n = defaults::list("devswarm_sup.ds_stages").len() as f64;
    match read(&devswarm_root(home).join(defaults::text("devswarm_sup.ds_state_file")))
        .as_ref()
        .and_then(|v| v.get(defaults::text("devswarm_sup.ds_cursor_key")))
    {
        Some(OVal::Num(x)) if x.is_finite() => {
            let i = ((x % n) + n) % n;
            if i.fract() == 0.0 { Ok(i as usize) } else { Err(()) }
        }
        _ => Ok(0),
    }
}

/// `hasDeferredWork(stage, home)`: the stage's own marker holds a non-empty pending list.
pub fn has_deferred_work(home: &Path, stage: &str) -> bool {
    let root = devswarm_root(home);
    if let Some(key) = defaults::raw("devswarm_sup.ds_stage_keys").get(stage).and_then(crate::defaults::V::as_str) {
        let state = read(&home.join(defaults::text("devswarm_sup.ds_update_state")));
        let Some(entry) = state.as_ref().and_then(|s| s.get(key)) else { return false };
        let version = entry.get(defaults::text("devswarm_sup.ds_pending_version")).is_some_and(OVal::truthy);
        return version && matches!(entry.get(defaults::text("devswarm_sup.ds_pending_hashes")), Some(OVal::Arr(a)) if !a.is_empty());
    }
    // the archived-row fold keeps two resume markers
    let strings = |a: &[OVal]| a.iter().filter(|x| matches!(x, OVal::Str(_))).count();
    let buckets = read(&root.join(defaults::text("devswarm_sup.ds_resume_file")));
    let any_bucket = match buckets.as_ref().and_then(|b| b.get(defaults::text("devswarm_sup.ds_buckets_key"))) {
        Some(OVal::Obj(o)) => o.iter().any(|(_, v)| matches!(v, OVal::Arr(a) if strings(a) > 0)),
        _ => false,
    };
    let family = read(&root.join(defaults::text("devswarm_sup.ds_family_file")));
    let ids = matches!(family.as_ref().and_then(|f| f.get(defaults::text("devswarm_sup.ds_ids_key"))), Some(OVal::Arr(a)) if strings(a) > 0);
    any_bucket || ids
}

/// The hashes a stage's marker in the update sweep state still has to visit (the entry's pending list).
fn pending_hashes(home: &Path, stage: &str) -> Vec<String> {
    let Some(key) = defaults::raw("devswarm_sup.ds_stage_keys").get(stage).and_then(crate::defaults::V::as_str) else { return Vec::new() };
    let state = read(&home.join(defaults::text("devswarm_sup.ds_update_state")));
    match state.as_ref().and_then(|s| s.get(key)).and_then(|e| e.get(defaults::text("devswarm_sup.ds_pending_hashes"))) {
        Some(OVal::Arr(a)) => a.iter().filter_map(|x| if let OVal::Str(s) = x { Some(s.clone()) } else { None }).collect(),
        _ => Vec::new(),
    }
}

/// `devswarm_sup.sweep_tail_mode` is `engine`.
fn tail_by_engine(ctx: &Ctx) -> bool {
    super::setting(ctx.st, "devswarm_sup.set_sweep_tail_mode").as_str() == Some(defaults::text("devswarm_sup.sweep_tail_engine"))
}

/// The ported part of a stage, run before Node's stage function when the mode says so: the orphan-partition heal, store by store,
/// each witnessed against Node's own function and applied only when both agree. A store the engine cannot decide in full, or a
/// witness that disagrees, writes nothing and is left to Node's stage, which runs right after exactly as it would have. The
/// stage's marker (pending list, completion stamp) stays Node's.
fn engine_part(ctx: &Ctx, runner: &dyn Runner, stage: &str) -> Value {
    if stage != defaults::text("devswarm_recon.stage_heal_orphans") {
        return Value::Null;
    }
    let mut stores = Vec::new();
    for key in pending_hashes(ctx.home, stage).into_iter().take(defaults::num("devswarm_recon.tail_max_stores") as usize) {
        use super::recon::orphans;
        stores.push(match orphans::run(ctx, runner, &key, &super::recon::Hooks::none()) {
            Ok(r) => json!({"repoKey": key, "agreed": r.verdict == super::recon::gate::Verdict::Agreed, "adopted": r.result["adopted"], "unhealable": r.result["unhealable"], "handedBack": r.deferred.len()}),
            Err(d) => json!({"repoKey": key, "handedBack": d.0}),
        });
    }
    Value::Array(stores)
}

/// The duty's record: Node's `{ stage, ran, reason | budgetMs, result }`.
pub fn duty(ctx: &Ctx, runner: &dyn Runner) -> Value {
    let d = defaults::raw("devswarm_sup.duty.deferred");
    let stages = defaults::list("devswarm_sup.ds_stages");
    let fallback = |why: &str| {
        let timeout = d.get("timeout_ms").and_then(crate::defaults::V::as_integer).unwrap_or(0).max(1) as u64;
        let r = node(runner, ctx, d.str_field("snippet"), &[], timeout);
        if r.ok {
            json!({"duty": "deferred", "outcome": "ran", "detail": super::tick::parse(&r.stdout), "node": why})
        } else {
            json!({"duty": "deferred", "outcome": "failed", "error": r.error.clone().unwrap_or_else(|| super::tick::cut(&r.stderr)), "status": r.status, "timedOut": r.timed_out, "node": why})
        }
    };
    let Ok(idx) = cursor(ctx.home) else { return fallback("cursor") };
    let stage = stages[idx];
    // persisted BEFORE the stage is peeked or run
    let p = devswarm_root(ctx.home).join(defaults::text("devswarm_sup.ds_state_file"));
    if let Some(dir) = p.parent() {
        crate::discard::harmless(std::fs::create_dir_all(dir)); // keep: the cursor is best effort (Node: "fail-open")
    }
    crate::discard::harmless(crate::atomic::write(&p, format!("{{\"{}\":{}}}", defaults::text("devswarm_sup.ds_cursor_key"), (idx + 1) % stages.len()))); // keep: same
    if !has_deferred_work(ctx.home, stage) {
        return json!({"duty": "deferred", "outcome": "ran", "detail": {"stage": stage, "ran": false, "reason": defaults::text("devswarm_sup.ds_reason_no_marker")}});
    }
    let timeout = d.get("timeout_ms").and_then(crate::defaults::V::as_integer).unwrap_or(0).max(1) as u64;
    let engine = if tail_by_engine(ctx) { engine_part(ctx, runner, stage) } else { Value::Null };
    let r = node(runner, ctx, d.str_field("stage_snippet"), &[stage], timeout);
    if r.ok {
        let mut rec = json!({"duty": "deferred", "outcome": "ran", "detail": super::tick::parse(&r.stdout)});
        if !engine.is_null() {
            rec["engine"] = engine;
        }
        rec
    } else {
        json!({"duty": "deferred", "outcome": "failed", "error": r.error.clone().unwrap_or_else(|| super::tick::cut(&r.stderr)), "status": r.status, "timedOut": r.timed_out})
    }
}
