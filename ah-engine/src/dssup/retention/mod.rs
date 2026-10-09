//! The retention duty, native: `sweep` of `companion/lib/devswarm-retention.js` in its steady (armed) state.
//!
//! Retention keeps the per-project message stores from growing without bound by TOMBSTONING the bodies of old, fully read
//! messages (never deleting a row: positions, counts and dedupe depend on every row staying), archive first. Because a wrong
//! write loses a user's message text, this port holds a stricter bar than "same as Node":
//!
//! 1. the engine plans natively ([`plan`]) and Node's own `planStore` + dry-run `pruneStore` plan the SAME store read only
//!    (the non-acting witness); the engine writes only when the two agree on the exact candidate rows, every partition's
//!    statistics and the counts it chose, and only if a second native plan, taken after Node's, is identical to the first
//!    (so the store did not move under the comparison);
//! 2. any disagreement, or a witness that cannot run while `retention_require_witness` is on, does NOTHING that run and logs it;
//!    the store is tried again after `witness_every_ms` (never a weaker or riskier action than Node's);
//! 3. what it writes ([`apply`]) is a subset of what Node's transaction would: each row is re-checked against the live database
//!    inside the transaction, and the archive (verified gzip, fsynced) always comes first;
//! 4. whatever it cannot read exactly like Node (an unexpected column type, a missing `gzip`, the dry-run report phase of a
//!    machine's first run, an unreadable table) hands the whole sweep to Node's own function, as before this port.
//!
//! Left to Node, by design: the one-time dry-run report phase, `foldLegacyJournal` (it needs the store merge) and the archive
//! size cap eviction; the engine calls Node's functions for them only when there is something for them to do.
// Discard triage (E3): every `.ok()` / `unwrap_or_default()` in this module is a deliberate keep, for these reasons:
// - an unreadable or unparsable state file is the empty state (Node: `readJson(p, null)`)
pub mod apply;
pub mod cap;
pub mod cli;
pub mod dry;
pub mod fold;
pub mod gz;
pub mod plan;

use super::tick::{Ctx, node};
use crate::checks::guardkit::nodelock;
use crate::checks::guardkit::ojson::OVal;
use crate::defaults;
use crate::dsact::runner::Runner;
use crate::meshw::ident::Defer;
use crate::meshw::idlock::devswarm_root;
use apply::{Chosen, Pruned, Run, Settings, obj_mut};
use plan::Plan;
use serde_json::{Value, json};
use std::path::{Path, PathBuf};

pub(crate) fn now_ms() -> i64 {
    crate::health::now_ms() as i64
}

/// Read the five retention settings (environment, `settings.json`, shipped defaults; numbers exactly as Node reads them).
pub fn read_settings(ctx: &Ctx) -> Settings {
    let num = |key: &str| super::setting(ctx.st, key).as_f64().unwrap_or(0.0);
    Settings {
        days: num("devswarm_sup.set_rt_days"),
        max_store_mb: num("devswarm_sup.set_rt_max_store_mb"),
        keep: num("devswarm_sup.set_rt_keep").floor() as i64,
        archive: super::setting(ctx.st, "devswarm_sup.set_rt_archive").as_bool().unwrap_or(true),
        archive_max_mb: num("devswarm_sup.set_rt_archive_max_mb"),
    }
}

fn state_path(home: &Path) -> PathBuf {
    devswarm_root(home).join(defaults::text("devswarm_sup.rt_state_file"))
}

/// `readState(home)`: the state object with `stores`, `holds` and `phase` normalised the way Node does. An object whose
/// `stores` or `holds` is an array is a shape this port will not touch.
pub fn read_state(home: &Path) -> Result<OVal, Defer> {
    let mut st = match std::fs::read(state_path(home)).ok().and_then(|b| OVal::parse(&String::from_utf8_lossy(&b))) {
        Some(o @ OVal::Obj(_)) => o,
        _ => OVal::Obj(Vec::new()),
    };
    for k in [defaults::text("devswarm_sup.rt_state_stores"), defaults::text("devswarm_sup.rt_state_holds")] {
        match st.get(k) {
            Some(OVal::Arr(_)) => return Err(Defer("state-shape".into())),
            Some(v) if v.truthy() && matches!(v, OVal::Obj(_)) => {}
            _ => st.set(k, OVal::Obj(Vec::new())),
        }
    }
    let armed = defaults::text("devswarm_sup.rt_phase_armed");
    if !matches!(st.get(defaults::text("devswarm_sup.rt_state_phase")), Some(OVal::Str(p)) if p == armed) {
        st.set(defaults::text("devswarm_sup.rt_state_phase"), OVal::Str(defaults::text("devswarm_sup.rt_phase_dry").into()));
    }
    Ok(st)
}

/// Write the state the way Node does (the whole object, atomically). Unchanged content is not rewritten.
pub(super) fn write_state(home: &Path, st: &OVal) {
    let text = st.stringify();
    let p = state_path(home);
    if std::fs::read_to_string(&p).is_ok_and(|t| t == text) {
        return;
    }
    if let Some(d) = p.parent() {
        crate::discard::harmless(std::fs::create_dir_all(d)); // keep: the write below reports the failure
    }
    crate::discard::harmless(crate::atomic::write(&p, text)); // keep: Node's writeState returns false and the sweep goes on
}

fn is_armed(st: &OVal) -> bool {
    matches!(st.get(defaults::text("devswarm_sup.rt_state_phase")), Some(OVal::Str(p)) if p == defaults::text("devswarm_sup.rt_phase_armed"))
}

/// A store the sweep may touch: a sqlite store with data.
#[derive(Debug, Clone)]
pub struct Store {
    /// The store key.
    pub hash: String,
    /// Size on disk (database and log).
    pub bytes: u64,
}

/// `sqliteStores(home)`.
pub fn sqlite_stores(home: &Path) -> Vec<Store> {
    let root = devswarm_root(home).join(defaults::text("devswarm_sup.rt_store_dir"));
    let (legacy, repokey) =
        (regex::Regex::new(defaults::text("devswarm_sup.rt_hash_re_legacy")), regex::Regex::new(defaults::text("devswarm_sup.rt_hash_re_repokey")));
    let (Ok(legacy), Ok(repokey)) = (legacy, repokey) else { return Vec::new() };
    let mut names: Vec<String> = std::fs::read_dir(&root).into_iter().flatten().flatten().filter_map(|e| e.file_name().into_string().ok()).collect();
    names.sort();
    let mut out = Vec::new();
    for hash in names.into_iter().filter(|n| legacy.is_match(n) || repokey.is_match(n)) {
        let dir = root.join(&hash);
        let marker = std::fs::read_to_string(dir.join(defaults::text("devswarm_sup.rt_backend_marker"))).map(|m| m.trim().to_lowercase()).unwrap_or_default();
        if marker == defaults::text("devswarm_sup.rt_backend_journal") {
            continue;
        }
        if std::fs::metadata(dir.join(defaults::text("devswarm_sup.rt_db_file"))).map_or(0, |m| m.len()) == 0 {
            continue;
        }
        let bytes = apply::store_bytes(home, &hash);
        out.push(Store { hash, bytes });
    }
    out
}

pub(super) fn lock_path(home: &Path) -> String {
    devswarm_root(home).join(defaults::text("devswarm_sup.rt_lock_file")).to_string_lossy().into_owned()
}

pub(super) fn lock_params() -> nodelock::Params {
    nodelock::Params { stale_ms: defaults::num("devswarm_sup.rt_lock_stale_ms"), wait_ms: 0, steal_dead: true, ..nodelock::Params::swarm() }
}

fn budget_ms(ctx: &Ctx) -> f64 {
    super::setting(ctx.st, "devswarm_sup.set_rt_budget_ms").as_f64().unwrap_or(0.0)
}

// ---- the agreement with Node's planner -----------------------------------------------------------------------------------------

/// The engine's plan as the witness reports it: `[id, pos, partition, blen, oldEnough]` per candidate.
fn cand_rows(p: &Plan) -> Vec<Value> {
    p.cands.iter().map(|c| json!([c.id, c.pos, c.partition, c.blen, i32::from(c.old_enough)])).collect()
}

/// A number as JSON the way JavaScript prints it (a whole number has no fraction).
fn jnum(x: f64) -> Value {
    if x.is_finite() && x.fract() == 0.0 && x.abs() < defaults::num("mesh.js_safe_int") as f64 { Value::from(x as i64) } else { Value::from(x) }
}

fn parts_json(p: &Plan) -> Value {
    let mut m = serde_json::Map::new();
    for (k, s) in &p.parts {
        m.insert(
            k.clone(),
            json!({"rows": s.rows, "candidates": s.candidates, "candidateBytes": s.candidate_bytes, "tombstoned": s.tombstoned, "bound": s.bound.map_or(Value::Null, jnum),
                "protected": {"tooNew": s.too_new, "keepLast": s.keep_last, "unread": s.unread, "question": s.question, "ndjson": s.ndjson, "broadcast": s.broadcast, "held": s.held}}),
        );
    }
    Value::Object(m)
}

/// The numbers `pruneStore`'s dry run reports about the choice.
#[derive(Debug, Clone, PartialEq)]
struct Choice {
    age: usize,
    size: usize,
    bytes: i64,
    over: bool,
}

fn choose(p: &Plan, s: &Settings, bytes_before: u64) -> (Chosen, Choice) {
    let mut chosen = Chosen::by_age(p);
    let age = chosen.list.len();
    let max = s.max_bytes();
    let over = bytes_before as f64 > max;
    let size = if over { chosen.add_for(p, bytes_before as f64 - max) } else { 0 };
    let bytes = chosen.bytes();
    (chosen, Choice { age, size, bytes, over })
}

/// What Node's planner says about the same store, or why the witness could not run.
enum Witness {
    Said(Value),
    Unavailable(String),
}

fn ask_node(ctx: &Ctx, runner: &dyn Runner, hash: &str, s: &Settings, st: &OVal) -> Witness {
    let d = defaults::raw("devswarm_sup.duty.retention");
    let holds = st.get(defaults::text("devswarm_sup.rt_state_holds")).map_or(Value::Null, |h| serde_json::from_str(&h.stringify()).unwrap_or(Value::Null));
    let spec = json!({"hash": hash, "now": ctx.now, "holds": holds, "settings": {
        "days": s.days, "maxStoreMB": s.max_store_mb, "keepPerPartition": s.keep, "archive": s.archive, "archiveMaxMB": s.archive_max_mb, "enabled": s.enabled()}});
    let timeout = d.get("witness_timeout_ms").and_then(crate::defaults::V::as_integer).unwrap_or(0).max(1) as u64;
    let r = node(runner, ctx, d.str_field("witness_snippet"), &[&spec.to_string()], timeout);
    if !r.ok {
        return Witness::Unavailable(
            r.error.clone().unwrap_or_else(|| if r.missing { defaults::text("devswarm_sup.msg_no_node").into() } else { super::tick::cut(&r.stderr) }),
        );
    }
    match serde_json::from_str::<Value>(r.stdout.lines().rev().find(|l| !l.trim().is_empty()).unwrap_or_default()) {
        Ok(v) => Witness::Said(v),
        Err(e) => Witness::Unavailable(format!("{}: {e}", defaults::text("devswarm_sup.rt_msg_witness_output"))),
    }
}

/// The first difference between the engine's plan and Node's, or `None` when they agree on everything.
fn disagreement(p: &Plan, c: &Choice, node: &Value) -> Option<String> {
    let dry = &node["dry"];
    if dry["ok"] != true || !dry["skipped"].is_null() {
        return Some(format!("{}: {}", defaults::text("devswarm_sup.rt_msg_node_plan"), dry));
    }
    let mine = cand_rows(p);
    let theirs = node["cands"].as_array().cloned().unwrap_or_default();
    if mine != theirs {
        let first = mine.iter().zip(theirs.iter()).position(|(a, b)| a != b).unwrap_or(mine.len().min(theirs.len()));
        return Some(format!("{} {first} ({} vs {})", defaults::text("devswarm_sup.rt_msg_cand_differ"), mine.len(), theirs.len()));
    }
    let mine_parts = parts_json(p);
    if mine_parts != node["parts"] {
        let first = mine_parts.as_object().into_iter().flatten().find(|(k, v)| node["parts"].get(k.as_str()) != Some(*v));
        let detail = first.map_or(String::new(), |(k, v)| format!(" ({k}: engine {v} node {})", node["parts"].get(k.as_str()).unwrap_or(&Value::Null)));
        return Some(format!("{}{detail}", defaults::text("devswarm_sup.rt_msg_parts_differ")));
    }
    let n = |k: &str| dry[k].as_i64().unwrap_or(-1);
    if (n("ageCandidates"), n("sizeCandidates"), n("candidateBytes"), dry["overLimit"].as_bool()) != (c.age as i64, c.size as i64, c.bytes, Some(c.over)) {
        return Some(defaults::render("devswarm_sup.rt_msg_choice_differ", &[("engine", &format!("{c:?}")), ("node", dry)]));
    }
    None
}

/// How one store ended.
pub(super) enum Ended {
    Pruned(Box<Pruned>),
    DryRun(Value),
    Held(String),
    Fallback(Defer),
}

fn witness_log(ctx: &Ctx, rec: &Value) {
    crate::dsact::exec::append_line(&ctx.home.join(defaults::text("devswarm_sup.witness_file")), rec);
}

/// The engine's sweep of one store: plan, agree with Node, plan again, then (not in a dry run) archive and tombstone.
pub(super) fn one_store(ctx: &Ctx, runner: &dyn Runner, st: &mut OVal, s: &Settings, hash: &str, dry: bool, mark: bool) -> Ended {
    let now = ctx.now as f64;
    let holds = plan::holds_of(st, hash, now);
    let bytes_before = apply::store_bytes(ctx.home, hash);
    let first = match plan::plan_store(ctx.home, hash, s.rules(), now, &holds) {
        Ok(p) => p,
        Err(d) => return Ended::Fallback(d),
    };
    let (chosen, choice) = choose(&first, s, bytes_before);
    let require = super::setting(ctx.st, "devswarm_sup.set_rt_require_witness").as_bool().unwrap_or(true);
    match ask_node(ctx, runner, hash, s, st) {
        Witness::Said(v) => {
            if let Some(why) = disagreement(&first, &choice, &v) {
                witness_log(ctx, &json!({"ts": ctx.now, "duty": "retention", "store": hash, "match": false, "detail": why}));
                return Ended::Held(why);
            }
            witness_log(
                ctx,
                &json!({"ts": ctx.now, "duty": "retention", "store": hash, "match": true, "candidates": first.cands.len(), "chosen": choice.age + choice.size}),
            );
        }
        Witness::Unavailable(why) => {
            witness_log(ctx, &json!({"ts": ctx.now, "duty": "retention", "store": hash, "match": Value::Null, "error": why}));
            if require {
                return Ended::Held(format!("{}: {why}", defaults::text("devswarm_sup.rt_msg_no_witness")));
            }
        }
    }
    // the store must not have moved under the comparison
    let second = match plan::plan_store(ctx.home, hash, s.rules(), now, &holds) {
        Ok(p) => p,
        Err(d) => return Ended::Fallback(d),
    };
    if cand_rows(&first) != cand_rows(&second) || parts_json(&first) != parts_json(&second) {
        witness_log(ctx, &json!({"ts": ctx.now, "duty": "retention", "store": hash, "match": false, "detail": defaults::text("devswarm_sup.rt_msg_unstable")}));
        return Ended::Held(defaults::text("devswarm_sup.rt_msg_unstable").to_string());
    }
    if dry {
        return Ended::DryRun(
            json!({"hash": hash, "candidates": first.cands.len(), "ageCandidates": choice.age, "sizeCandidates": choice.size, "candidateBytes": choice.bytes, "overLimit": choice.over}),
        );
    }
    let mut run = Run { home: ctx.home, hash, settings: *s, now, budget_ms: if mark { f64::INFINITY } else { budget_ms(ctx) }, state: st, commit: mark };
    match apply::prune(&mut run, &first, chosen, choice.size, choice.age, bytes_before, choice.over) {
        Ok(mut r) => {
            r.total_rows = first.total_rows;
            r.already_tombstoned = first.total_tombstoned;
            for p in first.parts.values() {
                for (i, x) in [p.too_new, p.keep_last, p.unread, p.question, p.ndjson, p.broadcast, p.held].into_iter().enumerate() {
                    r.protected[i] += x;
                }
            }
            Ended::Pruned(Box::new(r))
        }
        Err(d) => Ended::Fallback(d),
    }
}

/// `recordStore(st, hash, r, now)`.
pub(super) fn record_store(st: &mut OVal, hash: &str, r: &Pruned, now: i64) {
    let prev_total = match obj_mut(obj_mut(st, defaults::text("devswarm_sup.rt_state_stores")), hash).get(defaults::text("devswarm_sup.rt_state_tombstoned")) {
        Some(OVal::Num(n)) if n.is_finite() => *n,
        Some(OVal::Str(t)) => crate::checks::guardkit::text::js_number_of_str(t),
        _ => 0.0,
    };
    let e = obj_mut(obj_mut(st, defaults::text("devswarm_sup.rt_state_stores")), hash);
    let n = |x: f64| OVal::Num(x);
    for (k, v) in [
        ("lastRunAt", n(now as f64)),
        ("tombstoned", n(if prev_total.is_nan() { 0.0 } else { prev_total } + r.tombstoned as f64)),
        ("lastTombstoned", n(r.tombstoned as f64)),
        ("bytesBefore", n(r.bytes_before as f64)),
        ("bytesAfter", n(r.bytes_after as f64)),
        ("overLimitProtected", OVal::Bool(r.over_limit_protected)),
        ("vacuum", r.vacuum.clone().unwrap_or(OVal::Null)),
        ("error", OVal::Null),
        ("budgetExhausted", OVal::Bool(r.budget_exhausted)),
    ] {
        e.set(k, v);
    }
}

/// The journal fold of a store, only when there is a journal to fold. Whether the journal is safe to fold is Node's own merge
/// check (a read-only dry run); the engine folds only the exact files Node's dry run names.
fn legacy_fold(ctx: &Ctx, runner: &dyn Runner, hash: &str) -> Value {
    let mine = fold::items(ctx.home, hash);
    if mine.is_empty() {
        return Value::Null;
    }
    let node = match dry::node_fold_dry(ctx, runner, hash) {
        Ok(v) => v,
        Err(why) => {
            witness_log(ctx, &json!({"ts": ctx.now, "duty": "retention-fold", "store": hash, "match": Value::Null, "error": why}));
            return json!({"held": why});
        }
    };
    if node["eligible"] != true {
        return node;
    }
    if !fold::agrees(&mine, &node) {
        let why = defaults::text("devswarm_sup.rt_msg_fold_differ");
        witness_log(ctx, &json!({"ts": ctx.now, "duty": "retention-fold", "store": hash, "match": false, "detail": why}));
        return json!({"held": why});
    }
    witness_log(ctx, &json!({"ts": ctx.now, "duty": "retention-fold", "store": hash, "match": true, "files": mine.len()}));
    fold::run(ctx.home, hash, &mine)
}

/// The archive cap: nothing to evict needs no comparison; an eviction list must be Node's exact dry-run list.
pub(super) fn archive_cap(ctx: &Ctx, runner: &dyn Runner, s: &Settings) -> Value {
    if s.archive_max_mb <= 0.0 {
        return Value::Null;
    }
    let p = cap::plan(ctx.home, s);
    if p.removed.is_empty() {
        return p.json(false);
    }
    let d = defaults::raw("devswarm_sup.duty.retention");
    let timeout = d.get("timeout_ms").and_then(crate::defaults::V::as_integer).unwrap_or(0).max(1) as u64;
    let spec = json!({"days": s.days, "maxStoreMB": s.max_store_mb, "keepPerPartition": s.keep, "archive": s.archive, "archiveMaxMB": s.archive_max_mb, "enabled": s.enabled()});
    let r = node(runner, ctx, d.str_field("cap_dry_snippet"), &[&spec.to_string()], timeout);
    let said = if r.ok { serde_json::from_str::<Value>(r.stdout.lines().rev().find(|l| !l.trim().is_empty()).unwrap_or_default()).ok() } else { None };
    let Some(node_plan) = said else {
        let why = r.error.clone().unwrap_or_else(|| super::tick::cut(&r.stderr));
        witness_log(ctx, &json!({"ts": ctx.now, "duty": "retention-cap", "match": Value::Null, "error": why}));
        return json!({"held": why});
    };
    if !cap::same(&p, &node_plan) {
        let why = defaults::text("devswarm_sup.rt_msg_cap_differ");
        witness_log(ctx, &json!({"ts": ctx.now, "duty": "retention-cap", "match": false, "detail": why}));
        return json!({"held": why});
    }
    witness_log(ctx, &json!({"ts": ctx.now, "duty": "retention-cap", "match": true, "files": p.removed.len()}));
    let done = cap::evict(ctx.home, &p);
    let mut v = p.json(false);
    v["removed"] = Value::Array(done.iter().map(|(f, b)| json!({"file": f, "bytes": b})).collect());
    v
}

/// The native sweep. `Err` hands the whole sweep to Node's function (nothing of Node's is half done by then).
fn sweep(ctx: &Ctx, runner: &dyn Runner, dry: bool) -> Result<Value, Defer> {
    let s = read_settings(ctx);
    if !s.enabled() {
        return Ok(json!({"ran": false, "reason": defaults::text("devswarm_sup.msg_disabled")}));
    }
    let Some(held) = nodelock::acquire(&lock_path(ctx.home), lock_params()) else {
        return Ok(json!({"ran": false, "reason": defaults::text("devswarm_sup.rt_reason_lock_busy")}));
    };
    let out = locked(ctx, runner, &s, dry);
    held.release();
    out
}

fn locked(ctx: &Ctx, runner: &dyn Runner, s: &Settings, dry_switch: bool) -> Result<Value, Defer> {
    let dry = dry_switch;
    let t0 = std::time::Instant::now();
    let mut st = read_state(ctx.home)?;
    if !is_armed(&st) {
        return dry::phase(ctx, runner, &mut st, s, dry_switch, budget_ms(ctx));
    }
    let stores = sqlite_stores(ctx.home);
    let interval = defaults::num("devswarm_sup.rt_store_min_interval_ms") as f64;
    let ran_recently = |hash: &str, st: &OVal| -> bool {
        let e = st.get(defaults::text("devswarm_sup.rt_state_stores")).and_then(|x| x.get(hash));
        let last = match e.and_then(|e| e.get("lastRunAt")) {
            Some(OVal::Num(n)) => *n,
            _ => 0.0,
        };
        last > ctx.now as f64 - interval && !e.and_then(|e| e.get("budgetExhausted")).is_some_and(OVal::truthy)
    };
    let mut due: Vec<&Store> = stores.iter().filter(|x| !ran_recently(&x.hash, &st)).collect();
    due.sort_by_key(|x| std::cmp::Reverse(x.bytes));
    // a store whose last comparison disagreed is not tried again before the witness interval has passed
    let backoff = defaults::num("devswarm_sup.witness_every_ms") as i64;
    due.retain(|x| !held_back(ctx, &x.hash, backoff));
    let mut result = Value::Null;
    if let Some(target) = due.first() {
        match one_store(ctx, runner, &mut st, s, &target.hash, dry, false) {
            Ended::Pruned(r) => {
                let fold = legacy_fold(ctx, runner, &target.hash);
                record_store(&mut st, &target.hash, &r, ctx.now);
                result = json!({"ok": r.ok, "hash": r.hash, "tombstoned": r.tombstoned, "ageCandidates": r.age_candidates, "sizeCandidates": r.size_candidates,
                    "overLimit": r.over_limit, "overLimitProtected": r.over_limit_protected, "budgetExhausted": r.budget_exhausted, "batches": r.batches, "legacy": fold});
            }
            Ended::DryRun(v) => result = v,
            Ended::Held(why) => {
                stamp_held(ctx, &target.hash);
                result = json!({"hash": target.hash, "held": why});
            }
            Ended::Fallback(d) => return Err(d),
        }
    }
    let cap = if dry { Value::Null } else { archive_cap(ctx, runner, s) };
    if !dry {
        write_state(ctx.home, &st);
    }
    Ok(
        json!({"ran": true, "phase": defaults::text("devswarm_sup.rt_phase_armed"), "store": result, "archiveCap": cap, "dryRun": dry, "ms": t0.elapsed().as_millis() as u64}),
    )
}

fn held_path(ctx: &Ctx) -> PathBuf {
    ctx.home.join(defaults::text("devswarm_sup.rt_held_file"))
}

fn held_back(ctx: &Ctx, hash: &str, window_ms: i64) -> bool {
    std::fs::read_to_string(held_path(ctx))
        .ok()
        .and_then(|t| serde_json::from_str::<Value>(&t).ok())
        .and_then(|v| v.get(hash).and_then(Value::as_i64))
        .is_some_and(|at| ctx.now >= at && ctx.now - at < window_ms)
}

fn stamp_held(ctx: &Ctx, hash: &str) {
    let p = held_path(ctx);
    let mut m: serde_json::Map<String, Value> = std::fs::read_to_string(&p).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default();
    m.insert(hash.to_string(), json!(ctx.now));
    if let Some(d) = p.parent() {
        crate::discard::harmless(std::fs::create_dir_all(d)); // keep: a lost stamp only repeats a comparison
    }
    crate::discard::harmless(crate::atomic::write(&p, Value::Object(m).to_string())); // keep: same
}

/// The duty: native in the armed state, Node's own function otherwise (or whenever the port declines).
pub fn duty(ctx: &Ctx, runner: &dyn Runner) -> Value {
    let dry = super::setting(ctx.st, "devswarm_sup.set_dry_run_retention").as_bool().unwrap_or(false);
    match sweep(ctx, runner, dry) {
        Ok(v) => json!({"duty": "retention", "outcome": if dry { "dry-run" } else { "ran" }, "detail": v}),
        Err(Defer(why)) => {
            if dry {
                return json!({"duty": "retention", "outcome": "dry-run", "detail": {"ran": false, "reason": why}});
            }
            let d = defaults::raw("devswarm_sup.duty.retention");
            let owner = if ctx.engine_pokes { defaults::text("devswarm_sup.owner_engine") } else { defaults::text("devswarm_sup.owner_node") };
            let timeout = d.get("timeout_ms").and_then(crate::defaults::V::as_integer).unwrap_or(0).max(1) as u64;
            let r = node(runner, ctx, d.str_field("snippet"), &[owner], timeout);
            if r.ok {
                json!({"duty": "retention", "outcome": "ran", "detail": super::tick::parse(&r.stdout), "node": why})
            } else {
                json!({"duty": "retention", "outcome": "failed", "error": r.error.clone().unwrap_or_else(|| super::tick::cut(&r.stderr)), "status": r.status, "timedOut": r.timed_out, "node": why})
            }
        }
    }
}
