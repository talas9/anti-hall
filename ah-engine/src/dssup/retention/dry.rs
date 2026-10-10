//! The first-run dry-run report phase of `sweep` (`companion/lib/devswarm-retention.js`): on a machine that never ran retention
//! the sweep does not tombstone anything; it reports, store by store within a time budget, what it WOULD prune, into
//! `retention-dry-run.json` and the retention log, and once every store is reported the phase flips to `armed` (the state the
//! tombstoning of [`super::sweep`] needs).
//!
//! Nothing here removes or changes a message: it writes the report, the state's phase and one log line. Because the flip to
//! `armed` is what later permits tombstoning, each store's summary is still agreed with Node's own planner first (the same
//! read-only witness as the armed sweep); a disagreement leaves the whole sweep to Node's own function, as before this port.
use super::apply::{Settings, log_event, obj_mut};
use super::{Witness, ask_node, choose, disagreement, witness_log};
use crate::checks::guardkit::ojson::OVal;
use crate::defaults;
use crate::dsact::runner::Runner;
use crate::dssup::tick::{Ctx, node};
use crate::meshw::ident::Defer;
use serde_json::{Value, json};
use std::path::{Path, PathBuf};

pub(super) fn report_path(home: &Path) -> PathBuf {
    crate::meshw::idlock::devswarm_root(home).join(defaults::text("devswarm_sup.rt_dry_report_file"))
}

/// `Math.round(x * 10) / 10` on a megabyte count.
pub(super) fn mb1(bytes: f64) -> f64 {
    let mb = defaults::num("devswarm_sup.rt_mb") as f64;
    ((bytes / mb) * 10.0 + 0.5).floor() / 10.0
}

fn n(x: f64) -> OVal {
    OVal::Num(x)
}

/// Node's answer to a dry run of the journal fold of one store, or the engine's own "no journal".
pub(super) fn legacy_of(ctx: &Ctx, runner: &dyn Runner, hash: &str) -> Result<Value, Defer> {
    if !super::fold::any(ctx.home, hash) {
        return Ok(json!({"eligible": false, "reason": "no-journal", "files": []}));
    }
    match node_fold_dry(ctx, runner, hash) {
        // no Node on this machine: whether the journal may be folded is Node's merge check, so the report names nothing to fold
        Err(why) if why == defaults::text("devswarm_sup.msg_no_node") => Ok(json!({"eligible": false, "reason": why, "files": []})),
        r => r.map_err(Defer),
    }
}

/// `summarize(r)` of a dry `pruneStore`, for one store.
pub(super) fn summary(ctx: &Ctx, runner: &dyn Runner, st: &OVal, s: &Settings, hash: &str) -> Result<OVal, Defer> {
    let now = ctx.now as f64;
    let holds = super::plan::holds_of(st, hash, now);
    let bytes_before = super::apply::store_bytes(ctx.home, hash);
    let plan = super::plan::plan_store(ctx.home, hash, s.rules(), now, &holds)?;
    let (_chosen, choice) = choose(&plan, s, bytes_before);
    let require = crate::dssup::setting(ctx.st, "devswarm_sup.set_rt_require_witness").as_bool().unwrap_or(true);
    match ask_node(ctx, runner, hash, s, st) {
        Witness::Said(v) => {
            let mut why = disagreement(&plan, &choice, &v);
            let all_bytes: i64 = plan.cands.iter().map(|c| c.blen).sum();
            let protected = choice.over && (bytes_before as f64 - all_bytes as f64) > s.max_bytes();
            if why.is_none() && v["dry"]["overLimitProtected"].as_bool() != Some(protected) {
                why = Some(defaults::text("devswarm_sup.rt_msg_dry_differ").to_string());
            }
            if let Some(w) = why {
                witness_log(ctx, &json!({"ts": ctx.now, "duty": "retention", "store": hash, "match": false, "detail": w}));
                return Err(Defer(w));
            }
            witness_log(ctx, &json!({"ts": ctx.now, "duty": "retention", "store": hash, "match": true, "phase": "dry-run"}));
        }
        Witness::Unavailable(why) => {
            witness_log(ctx, &json!({"ts": ctx.now, "duty": "retention", "store": hash, "match": Value::Null, "error": why}));
            if require {
                return Err(Defer(format!("{}: {why}", defaults::text("devswarm_sup.rt_msg_no_witness"))));
            }
        }
        // no Node on this machine: the report phase writes only its report, from the engine's own plan
        Witness::Absent(why) => {
            witness_log(ctx, &json!({"ts": ctx.now, "duty": "retention", "store": hash, "match": Value::Null, "node": why, "phase": "dry-run"}));
        }
    }
    let legacy = legacy_of(ctx, runner, hash)?;
    let all_bytes: i64 = plan.cands.iter().map(|c| c.blen).sum();
    let over_protected = choice.over && (bytes_before as f64 - all_bytes as f64) > s.max_bytes();
    let mut prot = [0i64; 7];
    for p in plan.parts.values() {
        for (i, x) in [p.too_new, p.keep_last, p.unread, p.question, p.ndjson, p.broadcast, p.held].into_iter().enumerate() {
            prot[i] += x;
        }
    }
    let protected = OVal::Obj(defaults::list("devswarm_sup.rt_protected_names").into_iter().zip(prot).map(|(k, v)| (k.to_string(), n(v as f64))).collect());
    let legacy_files = legacy["files"].as_array().map_or(0, Vec::len);
    let legacy_o = OVal::Obj(vec![
        ("eligible".into(), OVal::Bool(legacy["eligible"].as_bool().unwrap_or(false))),
        ("reason".into(), legacy["reason"].as_str().map_or(OVal::Null, |r| OVal::Str(r.into()))),
        ("files".into(), n(legacy_files as f64)),
    ]);
    Ok(OVal::Obj(vec![
        ("ok".into(), OVal::Bool(true)),
        ("hash".into(), OVal::Str(hash.into())),
        ("skipped".into(), OVal::Null),
        ("error".into(), OVal::Null),
        ("dryRun".into(), OVal::Bool(true)),
        ("mbBefore".into(), n(mb1(bytes_before as f64))),
        ("mbAfter".into(), n(mb1(bytes_before as f64))),
        ("rows".into(), n(plan.total_rows as f64)),
        ("alreadyTombstoned".into(), n(plan.total_tombstoned as f64)),
        ("ageCandidates".into(), n(choice.age as f64)),
        ("sizeCandidates".into(), n(choice.size as f64)),
        ("candidateMB".into(), n(mb1(choice.bytes as f64))),
        ("tombstoned".into(), n(0.0)),
        ("overLimit".into(), OVal::Bool(choice.over)),
        ("overLimitProtected".into(), OVal::Bool(over_protected)),
        ("vacuum".into(), OVal::Null),
        ("budgetExhausted".into(), OVal::Bool(false)),
        ("protected".into(), protected),
        ("legacy".into(), legacy_o),
    ]))
}

pub(super) fn settings_json(s: &Settings) -> OVal {
    OVal::Obj(vec![
        ("days".into(), n(s.days)),
        ("maxStoreMB".into(), n(s.max_store_mb)),
        ("keepPerPartition".into(), n(s.keep as f64)),
        ("archive".into(), OVal::Bool(s.archive)),
        ("archiveMaxMB".into(), n(s.archive_max_mb)),
        ("enabled".into(), OVal::Bool(s.enabled())),
    ])
}

fn num_of(v: Option<&OVal>) -> f64 {
    match v {
        Some(OVal::Num(x)) => *x,
        _ => 0.0,
    }
}

/// One sweep of the first-run phase. `dry` (the engine's own dry-run switch) computes and writes nothing.
pub fn phase(ctx: &Ctx, runner: &dyn Runner, st: &mut OVal, s: &Settings, dry: bool, budget_ms: f64) -> Result<Value, Defer> {
    let t0 = std::time::Instant::now();
    let rpath = report_path(ctx.home);
    let mut report = match std::fs::read(&rpath).ok().and_then(|b| OVal::parse(&String::from_utf8_lossy(&b))) {
        Some(o @ OVal::Obj(_)) => o,
        Some(o) if o.truthy() => return Err(Defer(defaults::text("devswarm_sup.rt_msg_report_shape").into())),
        _ => OVal::Obj(vec![("startedAt".into(), n(ctx.now as f64)), ("stores".into(), OVal::Obj(Vec::new()))]),
    };
    match report.get("stores") {
        Some(OVal::Arr(_)) => return Err(Defer(defaults::text("devswarm_sup.rt_msg_report_shape").into())),
        Some(OVal::Obj(_)) => {}
        _ => report.set("stores", OVal::Obj(Vec::new())),
    }
    let stores = super::sqlite_stores(ctx.home);
    let mut done = 0usize;
    for x in &stores {
        if report.get("stores").and_then(|r| r.get(&x.hash)).is_some_and(OVal::truthy) {
            continue;
        }
        if t0.elapsed().as_millis() as f64 > budget_ms {
            break;
        }
        let sum = summary(ctx, runner, st, s, &x.hash)?;
        obj_mut(&mut report, "stores").set(&x.hash, sum);
        done += 1;
    }
    let remaining = stores.iter().filter(|x| !report.get("stores").and_then(|r| r.get(&x.hash)).is_some_and(OVal::truthy)).count();
    report.set("archiveCap", super::cap::plan(ctx.home, s).oval(true));
    report.set("settings", settings_json(s));
    if dry {
        return Ok(json!({"ran": true, "phase": "dry-run", "reported": done, "remaining": remaining, "dryRun": true}));
    }
    if let Some(d) = rpath.parent() {
        crate::discard::harmless(std::fs::create_dir_all(d)); // keep: the write below reports the failure
    }
    crate::discard::harmless(crate::atomic::write(&rpath, report.stringify())); // keep: Node: `try { writeJsonAtomic(...) } catch (_) {}`
    if remaining == 0 {
        st.set(defaults::text("devswarm_sup.rt_state_phase"), OVal::Str(defaults::text("devswarm_sup.rt_phase_armed").into()));
        st.set(defaults::text("devswarm_sup.rt_dry_completed_key"), n(ctx.now as f64));
        let (mut rows, mut mb) = (0.0, 0.0);
        if let Some(OVal::Obj(all)) = report.get("stores") {
            for (_, r) in all {
                rows += num_of(r.get("ageCandidates")) + num_of(r.get("sizeCandidates"));
                mb += num_of(r.get("candidateMB"));
            }
        }
        let count = match report.get("stores") {
            Some(OVal::Obj(all)) => all.len(),
            _ => 0,
        };
        log_event(
            ctx.home,
            &[
                ("event", OVal::Str(defaults::text("devswarm_sup.rt_ev_dry_complete").into())),
                ("stores", n(count as f64)),
                ("wouldPruneRows", n(rows)),
                ("wouldPruneMB", n(((mb * 10.0) + 0.5).floor() / 10.0)),
                ("report", OVal::Str(rpath.to_string_lossy().into_owned())),
            ],
        );
    }
    super::write_state(ctx.home, st);
    Ok(json!({"ran": true, "phase": "dry-run", "reported": done, "remaining": remaining, "ms": t0.elapsed().as_millis() as u64}))
}

/// Node's own dry-run fold answer for `hash`.
pub(super) fn node_fold_dry(ctx: &Ctx, runner: &dyn Runner, hash: &str) -> Result<Value, String> {
    let d = defaults::raw("devswarm_sup.duty.retention");
    let timeout = d.get("timeout_ms").and_then(crate::defaults::V::as_integer).unwrap_or(0).max(1) as u64;
    let r = node(runner, ctx, d.str_field("fold_dry_snippet"), &[hash], timeout);
    if !r.ok {
        if r.missing {
            return Err(defaults::text("devswarm_sup.msg_no_node").into());
        }
        return Err(r.error.clone().unwrap_or_else(|| crate::dssup::tick::cut(&r.stderr)));
    }
    serde_json::from_str::<Value>(r.stdout.lines().rev().find(|l| !l.trim().is_empty()).unwrap_or_default()).map_err(|e| e.to_string())
}
