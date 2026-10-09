//! `devswarm.js retention status | run [--dry-run] [--store X]` (lane l8c): the command-line face of the retention duty,
//! `status` and `run` of `companion/lib/devswarm-retention.js`.
//!
//! * `status` is a read: the settings, the phase, the stores by size and the archive size.
//! * `run --dry-run` plans every store (or the one named) read only, each plan agreed with Node's own planner exactly as the
//!   first-run report phase does ([`super::dry`]), and prints what `run` would do.
//! * `run` acts only under the duty's own bar ([`super::one_store`]): the engine's plan and Node's read-only planner must agree
//!   on the exact rows, and a second plan must equal the first. It acts on ONE store (the one named, or the only one) with no
//!   legacy journal to fold; anything else (several stores, a journal, a disabled setting, a lock held, a witness that
//!   disagrees or cannot run) is Node's, decided before the first write. After the first write nothing defers any more: the
//!   caller reports a committed failure instead of running Node.
//!
//! `restore` rewrites tombstoned rows from an archive and is left to Node.
use super::apply::{Pruned, Settings};
use super::{Ended, Store, cap, dry, fold, read_settings, read_state, sqlite_stores, write_state};
use crate::checks::guardkit::nodelock;
use crate::checks::guardkit::ojson::OVal;
use crate::defaults;
use crate::dsact::runner::Runner;
use crate::dssup::tick::Ctx;
use crate::meshw::ident::{Defer, defer};
use serde_json::Value;

fn n(x: f64) -> OVal {
    OVal::Num(x)
}

fn s(x: &str) -> OVal {
    OVal::Str(x.to_string())
}

/// `a.0 ? ... : ...` for a field of a state entry: a truthy value as it is, else null.
fn truthy_or_null(v: Option<&OVal>) -> OVal {
    v.filter(|x| x.truthy()).cloned().unwrap_or(OVal::Null)
}

/// `retention status`.
pub fn status(ctx: &Ctx) -> Result<OVal, Defer> {
    let st = settings_of(ctx);
    let state = read_state(ctx.home)?;
    let mut stores: Vec<Store> = sqlite_stores(ctx.home);
    stores.sort_by_key(|x| std::cmp::Reverse(x.bytes));
    let max = st.max_bytes();
    let files = cap::list(ctx.home);
    let archive_bytes: u64 = files.iter().map(|f| f.bytes).sum();
    let report = dry::report_path(ctx.home);
    let mut rows = Vec::new();
    for x in &stores {
        let mut o = vec![
            ("hash".to_string(), s(&x.hash)),
            ("mb".to_string(), n(dry::mb1(x.bytes as f64))),
            ("overLimit".to_string(), OVal::Bool(x.bytes as f64 > max)),
        ];
        if let Some(e) = state.get(defaults::text("devswarm_sup.rt_state_stores")).and_then(|m| m.get(&x.hash)).filter(|e| e.truthy()) {
            o.push(("lastRunAt".to_string(), truthy_or_null(e.get("lastRunAt"))));
            o.push(("overLimitProtected".to_string(), OVal::Bool(e.get("overLimitProtected").is_some_and(OVal::truthy))));
        }
        rows.push(OVal::Obj(o));
    }
    Ok(OVal::Obj(vec![
        ("ok".into(), OVal::Bool(true)),
        ("action".into(), s(defaults::text("devswarm_cli.ret_action_status"))),
        ("settings".into(), dry::settings_json(&st)),
        ("phase".into(), state.get(defaults::text("devswarm_sup.rt_state_phase")).cloned().unwrap_or(OVal::Null)),
        ("dryRunCompletedAt".into(), truthy_or_null(state.get(defaults::text("devswarm_sup.rt_dry_completed_key")))),
        ("dryRunReport".into(), if report.exists() { s(&report.to_string_lossy()) } else { OVal::Null }),
        ("stores".into(), OVal::Arr(rows)),
        ("archive".into(), OVal::Obj(vec![("files".into(), n(files.len() as f64)), ("mb".into(), n(dry::mb1(archive_bytes as f64)))])),
        ("log".into(), s(&ctx.home.join(defaults::text("devswarm_sup.rt_log_file")).to_string_lossy())),
    ]))
}

fn settings_of(ctx: &Ctx) -> Settings {
    read_settings(ctx)
}

/// The summary of a store the engine pruned (`summarize(r)` of a real run).
fn real_summary(r: &Pruned) -> OVal {
    let names = defaults::list("devswarm_sup.rt_protected_names");
    let protected = OVal::Obj(names.iter().zip(r.protected).map(|(k, v)| ((*k).to_string(), n(v as f64))).collect());
    OVal::Obj(vec![
        ("ok".into(), OVal::Bool(r.ok)),
        ("hash".into(), s(&r.hash)),
        ("skipped".into(), OVal::Null),
        ("error".into(), r.error.as_deref().map_or(OVal::Null, s)),
        ("dryRun".into(), OVal::Bool(false)),
        ("mbBefore".into(), n(dry::mb1(r.bytes_before as f64))),
        ("mbAfter".into(), n(dry::mb1(r.bytes_after as f64))),
        ("rows".into(), n(r.total_rows as f64)),
        ("alreadyTombstoned".into(), n(r.already_tombstoned as f64)),
        ("ageCandidates".into(), n(r.age_candidates as f64)),
        ("sizeCandidates".into(), n(r.size_candidates as f64)),
        ("candidateMB".into(), n(dry::mb1(r.candidate_bytes as f64))),
        ("tombstoned".into(), n(r.tombstoned as f64)),
        ("overLimit".into(), OVal::Bool(r.over_limit)),
        ("overLimitProtected".into(), OVal::Bool(r.over_limit_protected)),
        ("vacuum".into(), r.vacuum.clone().unwrap_or(OVal::Null)),
        ("budgetExhausted".into(), OVal::Bool(r.budget_exhausted)),
        ("protected".into(), protected),
        (
            "legacy".into(),
            OVal::Obj(vec![
                ("eligible".into(), OVal::Bool(false)),
                ("reason".into(), s(defaults::text("devswarm_cli.ret_reason_no_journal"))),
                ("files".into(), n(0.0)),
            ]),
        ),
    ])
}

/// `retention run [--dry-run] [--store X]`: `(ok, result)` or the hand-over to Node.
pub fn run(ctx: &Ctx, runner: &dyn Runner, dry_run: bool, store: Option<&str>) -> Result<(bool, OVal), Defer> {
    let st_settings = settings_of(ctx);
    if !st_settings.enabled() {
        return defer("disabled");
    }
    let Some(held) = nodelock::acquire(&super::lock_path(ctx.home), super::lock_params()) else { return defer("lock-busy") };
    let out = locked(ctx, runner, &st_settings, dry_run, store);
    held.release();
    out
}

fn locked(ctx: &Ctx, runner: &dyn Runner, s_: &Settings, dry_run: bool, store: Option<&str>) -> Result<(bool, OVal), Defer> {
    let mut state = read_state(ctx.home)?;
    let stores = sqlite_stores(ctx.home);
    let targets: Vec<String> = match store {
        Some(x) => {
            if !stores.iter().any(|y| y.hash == x) {
                return defer("unknown-store");
            }
            vec![x.to_string()]
        }
        None => stores.iter().map(|y| y.hash.clone()).collect(),
    };
    if dry_run {
        let mut rows = Vec::new();
        for h in &targets {
            rows.push(dry::summary(ctx, runner, &state, s_, h)?);
        }
        let ok = rows.iter().all(|r| !matches!(r.get("ok"), Some(OVal::Bool(false))));
        return Ok((ok, result(true, s_, rows, cap::plan(ctx.home, s_).oval(true))));
    }
    if targets.len() != 1 {
        return defer("several-stores");
    }
    let hash = &targets[0];
    if !fold::items(ctx.home, hash).is_empty() {
        return defer("legacy-journal");
    }
    let pruned = match super::one_store(ctx, runner, &mut state, s_, hash, false, true) {
        Ended::Pruned(r) => r,
        Ended::Held(why) => return Err(Defer(why)),
        Ended::Fallback(d) => return Err(d),
        Ended::DryRun(_) => return defer("unexpected-dry-run"),
    };
    super::record_store(&mut state, hash, &pruned, ctx.now);
    write_state(ctx.home, &state);
    let plan = cap::plan(ctx.home, s_);
    let cap_val = if plan.removed.is_empty() {
        plan.oval(false)
    } else {
        // archive files over the cap are evicted only on Node's exact list; the rows are already tombstoned, so a hold-up is
        // a committed failure
        let v = super::archive_cap(ctx, runner, s_);
        let done: Vec<(String, u64)> = v["removed"]
            .as_array()
            .map(|a| a.iter().filter_map(|x| Some((x["file"].as_str()?.to_string(), x["bytes"].as_u64()?))).collect())
            .unwrap_or_default();
        if v.get("held").is_some() || done != plan.removed {
            return defer("archive-cap");
        }
        plan.oval(false)
    };
    let ok = pruned.ok;
    Ok((ok, result(false, s_, vec![real_summary(&pruned)], cap_val)))
}

fn result(dry_run: bool, s_: &Settings, stores: Vec<OVal>, cap: OVal) -> OVal {
    let ok = stores.iter().all(|r| !matches!(r.get("ok"), Some(OVal::Bool(false))));
    OVal::Obj(vec![
        ("ok".into(), OVal::Bool(ok)),
        ("action".into(), s(defaults::text("devswarm_cli.ret_action_run"))),
        ("dryRun".into(), OVal::Bool(dry_run)),
        ("settings".into(), dry::settings_json(s_)),
        ("stores".into(), OVal::Arr(stores)),
        ("archiveCap".into(), cap),
    ])
}

/// Node's JSON for a value the engine builds (for comparing in tests).
pub fn json_of(v: &OVal) -> Value {
    serde_json::from_str(&v.stringify()).unwrap_or(Value::Null)
}
