//! S8: the deferred post-update stages, run by the engine item by item.
//!
//! The supervisor takes one stage per tick (`fold-all-stores`, `heal-orphan-partitions`, `fold-archived-rows`,
//! `heal-registry-rows`). Node runs it as `runDeferredStage` and the stage function walks the stage's pending stores through
//! `sweepItemsFor`, `runThrottledSweep`, `recordSweepResult` and `recordRun`. With `devswarm_sup.sweep_tail_mode = engine` this
//! module does the same walk natively:
//!
//! * the items are the pending list of the stage's own marker in `update-sweep-state.json` (`sweepItemsFor`'s resume branch);
//! * each item goes through the engine's witnessed port of Node's function for it (the mesh fold, the orphan heal, the registry
//!   heal, the archived-row and twin-descriptor folds); an item the engine cannot decide in full, or whose witness does not
//!   agree, is run by Node's own function for that one item in a bounded subprocess, as the stage did before the port;
//! * the walk stops before the next item once the stage budget is spent, and the marker is written ONCE at the end, atomically,
//!   with the same shapes and the same completeness predicate as `migrations.js`; a crash between items leaves the old marker,
//!   so the next tick walks the same list again (every item is idempotent).
//!
//! A stage whose marker holds no usable resume list, or says the version is already complete, is left to Node whole: Node would
//! enumerate every store there. Nothing here deletes a message; the only removal the ported functions perform is the guarded
//! registry-row delete of the fold.
use super::gate::Verdict;
use super::{Hooks, archive, fold, heal, orphans};
use crate::checks::guardkit::ojson::OVal;
use crate::defaults;
use crate::dsact::runner::Runner;
use crate::dssup::tick::{Ctx, node, parse};
use serde_json::{Map, Value, json};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

/// What a stage run produced.
pub struct StageOut {
    /// Node's result shape for the stage (`runDeferredStage`'s return value).
    pub result: Value,
    /// One record per item: the item, who did it, and why Node did it when it did.
    pub items: Vec<Value>,
    /// The budget the stage ran under, ms.
    pub budget_ms: f64,
}

// ---- the marker (`update-sweep-state.json`, owned by migrations.js) ---------------------------------------------------------

fn marker_path(home: &Path) -> PathBuf {
    home.join(defaults::text("devswarm_sup.ds_update_state"))
}

/// `readSweepState`: the marker object, `{}` for a missing, unreadable or non-object file.
fn read_state(home: &Path) -> OVal {
    match std::fs::read(marker_path(home)).ok().and_then(|b| OVal::parse(&String::from_utf8_lossy(&b))) {
        Some(v @ OVal::Obj(_)) => v,
        _ => OVal::Obj(Vec::new()),
    }
}

/// `writeSweepState`: tmp + rename. A failure is reported and the caller carries on (Node: "the next run re-sweeps").
fn write_state(home: &Path, state: &OVal) -> bool {
    let p = marker_path(home);
    if let Some(d) = p.parent() {
        crate::discard::harmless(std::fs::create_dir_all(d)); // keep: the write below reports the failure
    }
    crate::atomic::write(&p, state.stringify()).is_ok()
}

/// What `sweepItemsFor` selects.
enum Items {
    /// The version is already stamped complete.
    Skip,
    /// No usable resume list: Node would enumerate every store.
    Enumerate,
    /// A prior partial run's pending list.
    List(Vec<String>),
}

/// `sweepItemsFor(state, key, version, ...)`.
fn sweep_items_for(state: &OVal, key: &str, version: &str) -> Items {
    let Some(s) = state.get(key) else { return Items::Enumerate };
    if matches!(s.get("completedVersion"), Some(OVal::Str(c)) if c == version) {
        return Items::Skip;
    }
    if matches!(s.get(defaults::text("devswarm_sup.ds_pending_version")), Some(OVal::Str(p)) if p == version)
        && let Some(OVal::Arr(a)) = s.get(defaults::text("devswarm_sup.ds_pending_hashes"))
        && !a.is_empty()
    {
        let strings: Vec<String> = a.iter().filter_map(|x| if let OVal::Str(t) = x { Some(t.clone()) } else { None }).collect();
        // a list holding anything but strings is not one Node would walk the same way
        return if strings.len() == a.len() { Items::List(strings) } else { Items::Enumerate };
    }
    Items::Enumerate
}

/// `recordSweepResult(home, state, key, version, sweep, opts)` and, for a drained walk, `recordRun`.
#[allow(clippy::too_many_arguments)]
fn record_sweep_result(
    ctx: &Ctx,
    state: &OVal,
    key: &str,
    version: &str,
    processed: &[String],
    remaining: &[String],
    exhausted: bool,
    clean: bool,
    pending_rows: f64,
    forward_failed: f64,
) {
    let prev = state.get(key);
    let completed = match prev.and_then(|p| p.get("completedVersion")) {
        Some(v) if v.truthy() => v.clone(),
        _ => OVal::Null,
    };
    let strings = |v: &[String]| OVal::Arr(v.iter().cloned().map(OVal::Str).collect());
    let entry = if exhausted {
        OVal::Obj(vec![
            ("pendingVersion".into(), OVal::Str(version.into())),
            ("pendingHashes".into(), strings(remaining)),
            ("lastCompletedHash".into(), processed.last().map_or(OVal::Null, |l| OVal::Str(l.clone()))),
            ("completedVersion".into(), completed),
        ])
    } else {
        OVal::Obj(vec![
            ("completedVersion".into(), completed),
            ("pendingVersion".into(), OVal::Null),
            ("pendingHashes".into(), OVal::Arr(Vec::new())),
            ("lastCompletedHash".into(), OVal::Null),
        ])
    };
    let mut next = state.clone();
    next.set(key, entry);
    write_state(ctx.home, &next);
    if !exhausted {
        let result = json!({"errors": if clean { 0 } else { 1 }, "pendingRows": pending_rows, "forwardFailed": forward_failed, "left": []});
        record_run(ctx, key, version, &result);
    }
}

/// `recordRun(home, key, version, result)`: stamp the version only when the one completeness predicate says the pass is done.
fn record_run(ctx: &Ctx, key: &str, version: &str, result: &Value) -> bool {
    if version.is_empty() || !incomplete_reasons(result).is_empty() {
        return false;
    }
    let mut state = read_state(ctx.home);
    let mut entry = match state.get(key) {
        Some(e @ OVal::Obj(_)) => e.clone(),
        _ => OVal::Obj(Vec::new()),
    };
    for (k, v) in [
        ("completedVersion", OVal::Str(version.into())),
        ("completedTs", OVal::Num(ctx.now as f64)),
        ("pendingVersion", OVal::Null),
        ("pendingHashes", OVal::Arr(Vec::new())),
        ("lastCompletedHash", OVal::Null),
    ] {
        entry.set(k, v);
    }
    state.set(key, entry);
    write_state(ctx.home, &state)
}

// ---- the completeness predicate (migrations.js incompleteReasons) -----------------------------------------------------------

fn js_num(v: Option<&Value>) -> f64 {
    match v {
        Some(Value::Number(n)) => n.as_f64().unwrap_or(0.0),
        Some(Value::Bool(b)) => f64::from(u8::from(*b)),
        Some(Value::String(s)) => s.trim().parse::<f64>().ok().filter(|x| x.is_finite()).unwrap_or(0.0),
        _ => 0.0,
    }
}

/// `countOf`.
fn count_of(v: Option<&Value>) -> f64 {
    match v {
        Some(Value::Array(a)) => a.len() as f64,
        other => js_num(other),
    }
}

/// A count as the JSON number JavaScript would print: an integer when it is one.
fn jn(x: f64) -> Value {
    if x.fract() == 0.0 && x.abs() < 1e15 { json!(x as i64) } else { json!(x) }
}

fn truthy(v: Option<&Value>) -> bool {
    match v {
        None | Some(Value::Null) => false,
        Some(Value::Bool(b)) => *b,
        Some(Value::Number(n)) => n.as_f64().is_some_and(|x| x != 0.0 && !x.is_nan()),
        Some(Value::String(s)) => !s.is_empty(),
        Some(_) => true,
    }
}

fn js_text(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        other => other.to_string(),
    }
}

/// A count as JavaScript prints it.
fn fmt_n(x: f64) -> String {
    if x.fract() == 0.0 && x.abs() < 1e15 { format!("{}", x as i64) } else { format!("{x}") }
}

fn is_retryable_left(x: &Value) -> bool {
    let Value::Object(o) = x else { return false };
    let terminal = defaults::list("devswarm_recon.terminal_left_reasons");
    let reasons: Vec<String> = match o.get("reasons") {
        Some(Value::Array(a)) if !a.is_empty() => a.iter().map(|r| if truthy(Some(r)) { js_text(r) } else { String::new() }).collect(),
        _ => vec![o.get("reason").filter(|r| truthy(Some(r))).map(js_text).unwrap_or_default()],
    };
    reasons.iter().any(|r| !terminal.contains(&r.as_str()))
}

/// `incompleteReasons(result)`: why a pass is not done (empty: done).
pub fn incomplete_reasons(r: &Value) -> Vec<String> {
    let Value::Object(o) = r else { return vec![defaults::text("devswarm_recon.inc_no_result").into()] };
    let mut out = Vec::new();
    if o.get("ok") == Some(&Value::Bool(false)) {
        out.push(match o.get("error").filter(|e| truthy(Some(e))) {
            Some(e) => defaults::render("devswarm_recon.inc_not_ok_error", &[("error", &js_text(e))]),
            None => defaults::text("devswarm_recon.inc_not_ok").into(),
        });
    }
    let n = count_of(o.get("errors"));
    if n > 0.0 {
        out.push(defaults::render("devswarm_recon.inc_errors", &[("n", &fmt_n(n))]));
    }
    if truthy(o.get("budgetExhausted")) {
        let s = count_of(o.get("skipped"));
        out.push(if s > 0.0 {
            defaults::render("devswarm_recon.inc_budget_skipped", &[("n", &fmt_n(s))])
        } else {
            defaults::text("devswarm_recon.inc_budget").into()
        });
    }
    let n = count_of(o.get("pendingRows"));
    if n > 0.0 {
        out.push(defaults::render("devswarm_recon.inc_pending", &[("n", &fmt_n(n))]));
    }
    let n = count_of(o.get("forwardFailed"));
    if n > 0.0 {
        out.push(defaults::render("devswarm_recon.inc_forward", &[("n", &fmt_n(n))]));
    }
    if let Some(Value::Array(left)) = o.get("left") {
        let mut by: Vec<(String, usize)> = Vec::new();
        for x in left.iter().filter(|x| is_retryable_left(x)) {
            let k = x.get("reason").filter(|r| truthy(Some(r))).map_or_else(|| defaults::text("devswarm_recon.reason_unknown").to_string(), js_text);
            match by.iter_mut().find(|(r, _)| *r == k) {
                Some(e) => e.1 += 1,
                None => by.push((k, 1)),
            }
        }
        if !by.is_empty() {
            let parts: Vec<String> = by.iter().map(|(k, c)| defaults::render("devswarm_recon.inc_retry_item", &[("reason", k), ("n", c)])).collect();
            out.push(defaults::render("devswarm_recon.inc_retryable", &[("list", &parts.join(defaults::text("devswarm_recon.sep_retry")))]));
        }
    }
    out
}

// ---- running one item -------------------------------------------------------------------------------------------------------

struct Walk<'a> {
    ctx: &'a Ctx<'a>,
    runner: &'a dyn Runner,
    hooks: &'a Hooks<'a>,
    stage: &'a str,
    deadline_ms: i64,
    timeout_ms: u64,
}

impl Walk<'_> {
    /// Node's own function for one item, bounded. A subprocess that fails is the stage function's `{ok:false}` catch.
    fn node_item(&self, item: &str) -> Value {
        let deadline = self.deadline_ms.to_string();
        let r = node(self.runner, self.ctx, defaults::text("devswarm_recon.node_item_snippet"), &[self.stage, item, &deadline], self.timeout_ms);
        if r.ok {
            parse(&r.stdout)
        } else {
            let why = r.error.clone().unwrap_or_else(|| crate::dssup::tick::cut(&r.stderr));
            json!({"ok": false, "error": why})
        }
    }

    /// The engine's witnessed result for one item, shaped like Node's; `Err(why)` sends the item to Node.
    fn engine_item(&self, item: &str) -> Result<Value, String> {
        let agreed = |v: &Verdict, deferred: &[(String, String)]| -> Result<(), String> {
            if *v != Verdict::Agreed {
                Err(defaults::text("devswarm_recon.why_witness_mismatch").into())
            } else if !deferred.is_empty() {
                Err(defaults::text("devswarm_recon.why_units_handed_back").into())
            } else {
                Ok(())
            }
        };
        if self.stage == defaults::text("devswarm_recon.stage_fold_all") {
            let e = fold::run(self.ctx, self.runner, item, self.hooks).map_err(|d| d.0)?;
            agreed(&e.verdict, &e.deferred)?;
            let r = &e.result;
            Ok(json!({"ok": true, "retired": r.retired, "forwarded": r.forwarded, "folded": r.folded, "pending": r.pending.len()}))
        } else if self.stage == defaults::text("devswarm_recon.stage_heal_orphans") {
            let e = orphans::run(self.ctx, self.runner, item, self.hooks).map_err(|d| d.0)?;
            agreed(&e.verdict, &e.deferred)?;
            Ok(e.result)
        } else {
            let e = heal::run(self.ctx, self.runner, item, self.hooks).map_err(|d| d.0)?;
            agreed(&e.verdict, &e.deferred)?;
            Ok(e.result)
        }
    }
}

/// The running totals of a store stage (the closure variables of the stage functions).
#[derive(Default)]
struct Acc {
    retired: f64,
    forwarded: f64,
    folded: f64,
    errors: f64,
    pending_rows: f64,
    partial_groups: f64,
    forward_failed: f64,
    adopted: f64,
    unhealable: f64,
    skipped: f64,
    deadline_skipped: f64,
    sample: Vec<Value>,
    checked: f64,
    healed: f64,
    rehomed: f64,
    stores: Vec<Value>,
}

fn field(r: &Value, k: &str) -> f64 {
    js_num(r.get(k))
}

impl Acc {
    /// The worker body of the stage function for one item's result.
    fn take(&mut self, stage: &str, item: &str, r: &Value) {
        let failed = r.is_null() || r.get("ok") == Some(&Value::Bool(false));
        if stage == defaults::text("devswarm_recon.stage_fold_all") {
            if failed {
                self.errors += 1.0;
                return;
            }
            if truthy(r.get("budgetExhausted")) {
                let s = field(r, "skipped");
                self.partial_groups += if s.is_finite() && s > 0.0 { s } else { 1.0 };
            }
            if let Some(Value::Array(a)) = r.get("forwardFailed") {
                self.forward_failed += a.len() as f64;
            }
            self.retired += r.get("retired").and_then(Value::as_array).map_or(0.0, |a| a.len() as f64);
            self.forwarded += field(r, "forwarded");
            self.folded += field(r, "folded");
            self.pending_rows += field(r, "pending");
        } else if stage == defaults::text("devswarm_recon.stage_heal_orphans") {
            if failed {
                self.errors += 1.0;
                return;
            }
            self.adopted += field(r, "adopted");
            self.forwarded += field(r, "forwarded");
            self.unhealable += field(r, "unhealable");
            self.skipped += field(r, "skipped");
            self.deadline_skipped += field(r, "deadlineSkipped");
            self.pending_rows += field(r, "pending");
            self.errors += field(r, "errors");
            let cap = defaults::num("devswarm_recon.unhealable_sample_cap") as usize;
            if let Some(Value::Array(d)) = r.get("detail") {
                for x in d {
                    if self.sample.len() >= cap {
                        break;
                    }
                    if x.get("action").and_then(Value::as_str) == Some(defaults::text("devswarm_recon.action_unhealable")) {
                        self.sample.push(json!({"repoKey": item, "id": x.get("id").cloned().unwrap_or(Value::Null), "reason": if truthy(x.get("reason")) { x["reason"].clone() } else { Value::Null }}));
                    }
                }
            }
        } else {
            if r.is_null() || r.get("threw") == Some(&Value::Bool(true)) {
                self.errors += 1.0;
                return;
            }
            self.checked += field(r, "checked");
            self.healed += field(r, "healed");
            self.rehomed += field(r, "rehomed");
            let ids: Vec<Value> = r
                .get("rows")
                .and_then(Value::as_array)
                .map(|rows| {
                    rows.iter()
                        .filter(|row| truthy(row.get("healedDescriptor")) || truthy(row.get("healedRegistryPath")) || truthy(row.get("rehomed")))
                        .map(|row| row.get("id").filter(|i| !i.is_null()).cloned().unwrap_or_else(|| json!("?")))
                        .collect()
                })
                .unwrap_or_default();
            if !ids.is_empty() {
                self.stores.push(json!({"repoKey": item, "rows": ids}));
            }
        }
    }
}

fn budget_ms(ctx: &Ctx) -> f64 {
    crate::dssup::setting(ctx.st, "devswarm_sup.set_sweep_budget_ms").as_f64().filter(|b| b.is_finite() && *b >= 0.0).unwrap_or(0.0)
}

fn pause(ms: u64) {
    if ms > 0 {
        std::thread::sleep(Duration::from_millis(ms));
    }
}

/// Run one deferred stage natively. `None`: the engine does not take this stage now (not engine mode, an unknown stage, a marker
/// the engine will not interpret) and Node's `runDeferredStage` runs it whole.
pub fn run(ctx: &Ctx, runner: &dyn Runner, stage: &str, hooks: &Hooks) -> Option<StageOut> {
    if !archive::engine_mode(ctx.st) {
        return None;
    }
    let timeout_ms = defaults::raw("devswarm_sup.duty.deferred").get("timeout_ms").and_then(crate::defaults::V::as_integer).unwrap_or(0).max(1) as u64;
    let budget = budget_ms(ctx);
    let w = Walk { ctx, runner, hooks, stage, deadline_ms: ctx.now + budget as i64, timeout_ms };
    if stage == defaults::text("devswarm_recon.stage_archived") {
        return Some(archived(&w, budget));
    }
    let key = defaults::raw("devswarm_sup.ds_stage_keys").get(stage).and_then(crate::defaults::V::as_str)?;
    let state = read_state(ctx.home);
    let version = match state.get(key).and_then(|e| e.get(defaults::text("devswarm_sup.ds_pending_version"))) {
        Some(OVal::Str(v)) if !v.is_empty() => v.clone(),
        _ => return None,
    };
    let Items::List(items) = sweep_items_for(&state, key, &version) else { return None };
    let yield_ms = defaults::num("devswarm_recon.stage_yield_ms");
    let start = Instant::now();
    let mut acc = Acc::default();
    let (mut processed, mut records): (Vec<String>, Vec<Value>) = (Vec::new(), Vec::new());
    for (i, item) in items.iter().enumerate() {
        if i > 0 && start.elapsed().as_millis() as f64 >= budget {
            break;
        }
        (hooks.at)(&format!("stage:{stage}:{i}:before"));
        let (r, by, why) = match w.engine_item(item) {
            Ok(r) => (r, defaults::text("devswarm_recon.by_engine"), String::new()),
            Err(why) => (w.node_item(item), defaults::text("devswarm_recon.by_node"), why),
        };
        acc.take(stage, item, &r);
        records.push(json!({"item": item, "by": by, "why": why}));
        processed.push(item.clone());
        (hooks.at)(&format!("stage:{stage}:{i}:after"));
        if i + 1 < items.len() {
            pause(yield_ms);
        }
    }
    let remaining: Vec<String> = items[processed.len()..].to_vec();
    let exhausted = processed.len() < items.len();
    (hooks.at)(&format!("stage:{stage}:record:before"));
    let (clean, pending_rows, forward_failed) = if stage == defaults::text("devswarm_recon.stage_fold_all") {
        (acc.errors == 0.0, acc.pending_rows + acc.partial_groups, acc.forward_failed)
    } else if stage == defaults::text("devswarm_recon.stage_heal_orphans") {
        (acc.errors == 0.0, acc.pending_rows + acc.deadline_skipped, 0.0)
    } else {
        (acc.errors == 0.0, 0.0, 0.0)
    };
    record_sweep_result(ctx, &state, key, &version, &processed, &remaining, exhausted, clean, pending_rows, forward_failed);
    (hooks.at)(&format!("stage:{stage}:record:after"));
    let n_stores = fmt_n(processed.len() as f64);
    let tail = |detail: &mut String| {
        if exhausted {
            detail.push_str(&defaults::render("devswarm_recon.d_budget", &[("n", &remaining.len())]));
        }
    };
    let n = |x: f64| fmt_n(x);
    let result = if stage == defaults::text("devswarm_recon.stage_fold_all") {
        let mut d = defaults::render("devswarm_recon.d_fold", &[("retired", &n(acc.retired)), ("stores", &n_stores)]);
        if acc.forwarded > 0.0 {
            d.push_str(&defaults::render("devswarm_recon.d_forwarded", &[("n", &n(acc.forwarded))]));
        }
        if acc.pending_rows > 0.0 {
            d.push_str(&defaults::render("devswarm_recon.d_fold_pending", &[("n", &n(acc.pending_rows))]));
        }
        if acc.errors > 0.0 {
            d.push_str(&defaults::render("devswarm_recon.d_errors", &[("n", &n(acc.errors))]));
        }
        if acc.partial_groups > 0.0 {
            d.push_str(&defaults::render("devswarm_recon.d_fold_partial", &[("n", &n(acc.partial_groups))]));
        }
        if acc.forward_failed > 0.0 {
            d.push_str(&defaults::render("devswarm_recon.d_fold_fwdfail", &[("n", &n(acc.forward_failed))]));
        }
        tail(&mut d);
        json!({"attempted": true, "stores": processed.len(), "retired": jn(acc.retired), "forwarded": jn(acc.forwarded), "folded": jn(acc.folded), "errors": jn(acc.errors), "pendingRows": jn(acc.pending_rows),
            "budgetExhausted": exhausted, "pending": remaining.len(), "detail": d})
    } else if stage == defaults::text("devswarm_recon.stage_heal_orphans") {
        let mut d = defaults::render("devswarm_recon.d_orph", &[("adopted", &n(acc.adopted)), ("stores", &n_stores)]);
        if acc.forwarded > 0.0 {
            d.push_str(&defaults::render("devswarm_recon.d_forwarded", &[("n", &n(acc.forwarded))]));
        }
        if acc.unhealable > 0.0 {
            let sample = if acc.sample.is_empty() {
                String::new()
            } else {
                let names: Vec<String> = acc
                    .sample
                    .iter()
                    .take(defaults::num("devswarm_recon.sample_names") as usize)
                    .map(|u| format!("{}/{}", js_text(&u["repoKey"]), js_text(&u["id"])))
                    .collect();
                let more = if acc.unhealable > acc.sample.len() as f64 || acc.sample.len() > defaults::num("devswarm_recon.sample_names") as usize {
                    defaults::text("devswarm_recon.d_orph_more")
                } else {
                    ""
                };
                defaults::render("devswarm_recon.d_orph_sample", &[("list", &(names.join(defaults::text("devswarm_recon.sep_sample")) + more))])
            };
            d.push_str(&defaults::render("devswarm_recon.d_orph_unheal", &[("n", &n(acc.unhealable)), ("sample", &sample)]));
        }
        if acc.skipped > 0.0 {
            d.push_str(&defaults::render("devswarm_recon.d_orph_skipped", &[("n", &n(acc.skipped))]));
        }
        if acc.pending_rows > 0.0 {
            d.push_str(&defaults::render("devswarm_recon.d_orph_pending", &[("n", &n(acc.pending_rows))]));
        }
        if acc.errors > 0.0 {
            d.push_str(&defaults::render("devswarm_recon.d_errors", &[("n", &n(acc.errors))]));
        }
        tail(&mut d);
        json!({"attempted": true, "stores": processed.len(), "adopted": jn(acc.adopted), "forwarded": jn(acc.forwarded), "unhealable": jn(acc.unhealable), "skipped": jn(acc.skipped), "pendingRows": jn(acc.pending_rows),
            "errors": jn(acc.errors), "unhealableSample": acc.sample, "budgetExhausted": exhausted, "pending": remaining.len(), "detail": d})
    } else {
        let mut d = if acc.healed == 0.0 && acc.rehomed == 0.0 {
            defaults::render("devswarm_recon.d_heal_none", &[("checked", &n(acc.checked)), ("stores", &n_stores)])
        } else {
            defaults::render(
                "devswarm_recon.d_heal_some",
                &[("healed", &n(acc.healed)), ("rehomed", &n(acc.rehomed)), ("checked", &n(acc.checked)), ("stores", &n_stores)],
            )
        };
        tail(&mut d);
        json!({"attempted": true, "checked": jn(acc.checked), "healed": jn(acc.healed), "rehomed": jn(acc.rehomed), "errors": jn(acc.errors), "stores": acc.stores,
            "budgetExhausted": exhausted, "pending": remaining.len(), "detail": d})
    };
    Some(StageOut { result, items: records, budget_ms: budget })
}

// ---- fold-archived-rows -----------------------------------------------------------------------------------------------------

/// One half of the archived stage: the engine's witnessed plan, else Node's function for that half.
fn half(w: &Walk, label: &str, plan: crate::meshw::ident::R<archive::Plan>, records: &mut Vec<Value>) -> Value {
    let engine = plan.map_err(|d| d.0).and_then(|p| {
        let run = archive::run_plan(w.ctx, w.runner, &p, w.hooks);
        if run.verdict != Verdict::Agreed {
            Err(defaults::text("devswarm_recon.why_witness_mismatch").to_string())
        } else if !run.deferred.is_empty() {
            Err(defaults::text("devswarm_recon.why_units_handed_back").to_string())
        } else {
            Ok(run.result)
        }
    });
    let (r, by, why) = match engine {
        Ok(r) => (r, defaults::text("devswarm_recon.by_engine"), String::new()),
        Err(why) => (w.node_item(label), defaults::text("devswarm_recon.by_node"), why),
    };
    records.push(json!({"item": label, "by": by, "why": why}));
    r
}

/// `foldArchivedRowsPostUpdate` with no version: both halves run, nothing is stamped, the resume markers (written by the folds
/// themselves) drive the next pass.
fn archived(w: &Walk, budget: f64) -> StageOut {
    let ctx = w.ctx;
    let stage = w.stage;
    let mut records = Vec::new();
    let deadline = Some(w.deadline_ms);
    (w.hooks.at)(&format!("stage:{stage}:rows:before"));
    let r = half(w, "rows", archive::fold_archived_rows(ctx.home, ctx.now, deadline), &mut records);
    (w.hooks.at)(&format!("stage:{stage}:rows:after"));
    if r.get("threw") == Some(&Value::Bool(true)) {
        let d = defaults::render("devswarm_recon.d_raised", &[("stage", &stage), ("error", &js_text(&r["error"]))]);
        return StageOut { result: json!({"attempted": false, "detail": d}), items: records, budget_ms: budget };
    }
    let r = if r.is_null() { json!({}) } else { r };
    let mut not_stamped: Vec<String> = Vec::new();
    let mut why_not = |label_key: &str, res: &Value| {
        let why = incomplete_reasons(res);
        if !why.is_empty() {
            not_stamped.push(defaults::render(
                "devswarm_recon.fmt_not_stamped",
                &[("label", &defaults::text(label_key)), ("why", &why.join(defaults::text("devswarm_recon.sep_reasons")))],
            ));
        }
    };
    why_not("devswarm_recon.label_rows", &r);
    (w.hooks.at)(&format!("stage:{stage}:family:before"));
    let fr = half(w, "family", archive::fold_archived_family(ctx.home, ctx.now, deadline), &mut records);
    (w.hooks.at)(&format!("stage:{stage}:family:after"));
    let (fam_retired, fam_left, fam_errors, fam_ok) = if fr.get("threw") == Some(&Value::Bool(true)) {
        (0.0, 0.0, 1.0, false)
    } else {
        let fr = if fr.is_null() { json!({}) } else { fr };
        why_not("devswarm_recon.label_twins", &fr);
        (
            fr.get("retired").and_then(Value::as_array).map_or(0.0, |a| a.len() as f64),
            fr.get("left").and_then(Value::as_array).map_or(0.0, |a| a.len() as f64),
            js_num(fr.get("errors")),
            fr.get("ok") != Some(&Value::Bool(false)),
        )
    };
    let retired = r.get("retired").and_then(Value::as_array).map_or(0.0, |a| a.len() as f64);
    let left = r.get("left").and_then(Value::as_array).map_or(0.0, |a| a.len() as f64);
    let exhausted = truthy(r.get("budgetExhausted"));
    let skipped = js_num(r.get("skipped"));
    let forwarded = js_num(r.get("forwarded"));
    let errors = js_num(r.get("errors"));
    let mut d = defaults::render("devswarm_recon.d_arch", &[("retired", &fmt_n(retired))]);
    let mut add = |on: bool, key: &str, v: &str| {
        if on {
            d.push_str(&defaults::render(key, &[("n", &v), ("list", &v)]));
        }
    };
    add(fam_retired > 0.0, "devswarm_recon.d_arch_fam", &fmt_n(fam_retired));
    add(forwarded > 0.0, "devswarm_recon.d_forwarded", &fmt_n(forwarded));
    add(left > 0.0, "devswarm_recon.d_arch_left", &fmt_n(left));
    add(fam_left > 0.0, "devswarm_recon.d_arch_famleft", &fmt_n(fam_left));
    add(errors > 0.0, "devswarm_recon.d_arch_errors", &fmt_n(errors));
    add(fam_errors > 0.0, "devswarm_recon.d_arch_famerrors", &fmt_n(fam_errors));
    add(!fam_ok, "devswarm_recon.d_arch_famnotok", "");
    add(exhausted, "devswarm_recon.d_arch_budget", &fmt_n(skipped));
    add(!not_stamped.is_empty(), "devswarm_recon.d_arch_notstamped", &not_stamped.join(defaults::text("devswarm_recon.sep_not_stamped")));
    let ns: Vec<Value> = not_stamped.iter().map(|s| json!(s)).collect();
    let mut m = Map::new();
    for (k, v) in [
        ("attempted", json!(true)),
        ("retired", jn(retired)),
        ("forwarded", jn(forwarded)),
        ("left", jn(left)),
        ("errors", jn(errors)),
        ("familyDescriptorsRetired", jn(fam_retired)),
        ("familyDescriptorsLeft", jn(fam_left)),
        ("familyDescriptorsErrors", jn(fam_errors)),
        ("familyDescriptorsOk", json!(fam_ok)),
        ("budgetExhausted", json!(exhausted)),
        ("skipped", jn(skipped)),
        ("notStamped", Value::Array(ns)),
        ("detail", json!(d)),
    ] {
        m.insert(k.into(), v);
    }
    StageOut { result: Value::Object(m), items: records, budget_ms: budget }
}
