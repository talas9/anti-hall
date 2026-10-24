//! The first-run dry-run report phase of `sweep` (`companion/lib/devswarm-retention.js`): on a machine that never ran retention
//! the sweep does not tombstone anything; it reports, store by store within a time budget, what it WOULD prune, into
//! `retention-dry-run.json` and the retention log, and once every store is reported the phase flips to `armed` (the state the
//! tombstoning of [`super::sweep`] needs).
//!
//! Nothing here removes or changes a message: it writes the report, the state's phase and one log line. The report is the
//! engine's own plan; the journal fold it names is owner-gated (`devswarm_sup.rt_fold_alone`), so a store with a journal reports it
//! as not eligible while that switch is off.
use super::apply::{Settings, log_event, obj_mut};
use super::{choose, witness_log};
use crate::checks::guardkit::ojson::OVal;
use crate::defaults;
use crate::dsact::runner::Runner;
use crate::dssup::tick::Ctx;
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

/// What the journal fold of a store would do: no journal, a journal the owner-gated fold (`rt_fold_alone`) would fold, or a journal
/// that is not folded while the switch is off.
pub(super) fn legacy_of(ctx: &Ctx, hash: &str) -> Value {
    let mine = super::fold::items(ctx.home, hash);
    if mine.is_empty() {
        return json!({"eligible": false, "reason": "no-journal", "files": []});
    }
    if crate::dssup::setting(ctx.st, "devswarm_sup.set_rt_fold_alone").as_bool().unwrap_or(false) {
        // the armed fold holds a store whose merge into sqlite is not proven complete: the report says the same
        if let Some(reason) = super::fold::ineligible(ctx.home, hash) {
            return json!({"eligible": false, "reason": reason, "files": []});
        }
        return json!({"eligible": true, "reason": null, "files": super::fold::files_json(&mine)});
    }
    json!({"eligible": false, "reason": defaults::text("devswarm_sup.rt_why_fold_off"), "files": []})
}

/// `summarize(r)` of a dry `pruneStore`, for one store.
pub(super) fn summary(ctx: &Ctx, _runner: &dyn Runner, st: &OVal, s: &Settings, hash: &str) -> OVal {
    let now = ctx.now as f64;
    let holds = super::plan::holds_of(st, hash, now);
    let bytes_before = super::apply::store_bytes(ctx.home, hash);
    let plan = match super::plan::plan_store(ctx.home, hash, s.rules(), now, &holds) {
        Ok(p) => p,
        // Node's `catch` in `pruneStore`: a failed result, nothing else
        Err(Defer(why)) => return failed_summary(ctx, hash, bytes_before, why),
    };
    let (_chosen, choice) = choose(&plan, s, bytes_before);
    witness_log(ctx, &json!({"ts": ctx.now, "duty": "retention", "store": hash, "native": true, "phase": "dry-run"}));
    let legacy = legacy_of(ctx, hash);
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
    OVal::Obj(vec![
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
    ])
}

/// The summary of a dry store whose plan failed: `ok: false` with the error text, the counts at zero, the log line Node writes.
fn failed_summary(ctx: &Ctx, hash: &str, bytes_before: u64, why: String) -> OVal {
    log_event(
        ctx.home,
        &[("event", OVal::Str(defaults::text("devswarm_sup.rt_ev_prune_error").into())), ("store", OVal::Str(hash.into())), ("error", OVal::Str(why.clone()))],
    );
    let mut o = skipped_summary(hash, bytes_before, true, None, legacy_of(ctx, hash));
    if let OVal::Obj(v) = &mut o {
        for (k, x) in v.iter_mut() {
            match k.as_str() {
                "ok" => *x = OVal::Bool(false),
                "error" => *x = OVal::Str(why.clone()),
                "mbAfter" => *x = n(mb1(bytes_before as f64)),
                _ => {}
            }
        }
    }
    o
}

/// `summarize(r)` for a store `pruneStore` returns untouched (`skipped`: disabled, not a sqlite store, no store) or whose plan failed:
/// no rows, no candidates, nothing protected, `mbAfter` null (Node leaves `bytesAfter` unset on an early return).
pub(super) fn skipped_summary(hash: &str, bytes_before: u64, dry_run: bool, skipped: Option<&str>, legacy: Value) -> OVal {
    let protected = OVal::Obj(defaults::list("devswarm_sup.rt_protected_names").into_iter().map(|k| (k.to_string(), n(0.0))).collect());
    let legacy_files = legacy["files"].as_array().map_or(0, Vec::len);
    let legacy_o = OVal::Obj(vec![
        ("eligible".into(), OVal::Bool(legacy["eligible"].as_bool().unwrap_or(false))),
        ("reason".into(), legacy["reason"].as_str().map_or(OVal::Null, |r| OVal::Str(r.into()))),
        ("files".into(), n(legacy_files as f64)),
    ]);
    OVal::Obj(vec![
        ("ok".into(), OVal::Bool(true)),
        ("hash".into(), OVal::Str(hash.into())),
        ("skipped".into(), skipped.map_or(OVal::Null, |x| OVal::Str(x.into()))),
        ("error".into(), OVal::Null),
        ("dryRun".into(), OVal::Bool(dry_run)),
        ("mbBefore".into(), n(mb1(bytes_before as f64))),
        ("mbAfter".into(), OVal::Null),
        ("rows".into(), n(0.0)),
        ("alreadyTombstoned".into(), n(0.0)),
        ("ageCandidates".into(), n(0.0)),
        ("sizeCandidates".into(), n(0.0)),
        ("candidateMB".into(), n(0.0)),
        ("tombstoned".into(), n(0.0)),
        ("overLimit".into(), OVal::Bool(false)),
        ("overLimitProtected".into(), OVal::Bool(false)),
        ("vacuum".into(), OVal::Null),
        ("budgetExhausted".into(), OVal::Bool(false)),
        ("protected".into(), protected),
        ("legacy".into(), legacy_o),
    ])
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
pub fn phase(ctx: &Ctx, runner: &dyn Runner, st: &mut OVal, s: &Settings, dry: bool, budget_ms: f64) -> Value {
    let t0 = std::time::Instant::now();
    let rpath = report_path(ctx.home);
    let mut report = match std::fs::read(&rpath).ok().and_then(|b| OVal::parse(&String::from_utf8_lossy(&b))) {
        Some(o @ OVal::Obj(_)) => o,
        // a truthy scalar: Node's `report.stores = {}` throws on it and the sweep answers `{ran: false, error}`
        Some(o) if o.truthy() && !matches!(o, OVal::Arr(_)) => return json!({"ran": false, "error": defaults::text("devswarm_sup.rt_msg_report_shape")}),
        // an array (or nothing readable) keeps no entry by hash: a fresh report
        _ => OVal::Obj(vec![("startedAt".into(), n(ctx.now as f64)), ("stores".into(), OVal::Obj(Vec::new()))]),
    };
    match report.get("stores") {
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
        let sum = summary(ctx, runner, st, s, &x.hash);
        if let Some(stores) = obj_mut(&mut report, "stores") {
            stores.set(&x.hash, sum);
        }
        done += 1;
    }
    let remaining = stores.iter().filter(|x| !report.get("stores").and_then(|r| r.get(&x.hash)).is_some_and(OVal::truthy)).count();
    report.set("archiveCap", super::cap::plan(ctx.home, s).oval(true));
    report.set("settings", settings_json(s));
    if dry {
        return json!({"ran": true, "phase": "dry-run", "reported": done, "remaining": remaining, "dryRun": true});
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
    json!({"ran": true, "phase": "dry-run", "reported": done, "remaining": remaining, "ms": t0.elapsed().as_millis() as u64})
}
