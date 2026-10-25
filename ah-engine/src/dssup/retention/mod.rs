//! The retention duty, native: `sweep` of `companion/lib/devswarm-retention.js` in its steady (armed) state.
//!
//! Retention keeps the per-project message stores from growing without bound by TOMBSTONING the bodies of old, fully read
//! messages (never deleting a row: positions, counts and dedupe depend on every row staying), archive first. Because a wrong
//! write loses a user's message text, this port holds a stricter bar than "same as Node":
//!
//! 1. the engine plans natively ([`plan`]) twice, and writes only when the second plan, taken after the first, is identical to it
//!    (so the store did not move under the plan); the plan is logged (`devswarm_sup.witness_file`) next to what was done;
//! 2. what it writes ([`apply`]) is a subset of what Node's transaction would: each row is re-checked against the live database
//!    inside the transaction, and the archive (verified gzip, fsynced) always comes first;
//! 3. whatever it cannot read exactly like Node (an unexpected column type, a missing `gzip`, an unreadable table) holds the sweep
//!    (counted `native_unable`, nothing written, tried again);
//! 4. the two operations that remove data for good, the journal fold (the raw journal file is removed) and the archive-cap
//!    eviction (archived bodies are removed), are owner-gated: `devswarm_sup.rt_fold_alone` and `devswarm_sup.rt_cap_alone` are
//!    OFF by default and while off the step is `held` (counted as `held`, nothing removed, named in the record).
// Discard triage (E3): every `.ok()` / `unwrap_or_default()` in this module is a deliberate keep, for these reasons:
// - an unreadable or unparsable state file is the empty state (Node: `readJson(p, null)`)
pub mod apply;
pub mod cap;
pub mod cli;
pub mod dry;
pub mod fold;
pub mod gz;
pub mod plan;

use super::tick::Ctx;
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

/// `readState(home)`: the state object with `stores`, `holds` and `phase` normalised the way Node does. An array where `stores` or
/// `holds` should be an object keeps no entry by hash in Node (it reads as empty, and is written back as such), so it is the empty object.
pub fn read_state(home: &Path) -> OVal {
    let mut st = match std::fs::read(state_path(home)).ok().and_then(|b| OVal::parse(&String::from_utf8_lossy(&b))) {
        Some(o @ OVal::Obj(_)) => o,
        _ => OVal::Obj(Vec::new()),
    };
    for k in [defaults::text("devswarm_sup.rt_state_stores"), defaults::text("devswarm_sup.rt_state_holds")] {
        match st.get(k) {
            Some(v) if v.truthy() && matches!(v, OVal::Obj(_)) => {}
            _ => st.set(k, OVal::Obj(Vec::new())),
        }
    }
    let armed = defaults::text("devswarm_sup.rt_phase_armed");
    if !matches!(st.get(defaults::text("devswarm_sup.rt_state_phase")), Some(OVal::Str(p)) if p == armed) {
        st.set(defaults::text("devswarm_sup.rt_state_phase"), OVal::Str(defaults::text("devswarm_sup.rt_phase_dry").into()));
    }
    st
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

/// How one store ended.
pub(super) enum Ended {
    Pruned(Box<Pruned>),
    DryRun(Value),
    Held(String),
}

fn witness_log(ctx: &Ctx, rec: &Value) {
    crate::dsact::exec::append_line(&ctx.home.join(defaults::text("devswarm_sup.witness_file")), rec);
}

/// The engine's sweep of one store: plan, plan again, then (not in a dry run) archive and tombstone.
pub(super) fn one_store(ctx: &Ctx, _runner: &dyn Runner, st: &mut OVal, s: &Settings, hash: &str, dry: bool, mark: bool) -> Ended {
    let now = ctx.now as f64;
    let holds = plan::holds_of(st, hash, now);
    let bytes_before = apply::store_bytes(ctx.home, hash);
    let first = match plan::plan_store(ctx.home, hash, s.rules(), now, &holds) {
        Ok(p) => p,
        Err(Defer(why)) => return plan_failed(ctx, hash, bytes_before, why, dry),
    };
    let (chosen, choice) = choose(&first, s, bytes_before);
    witness_log(
        ctx,
        &json!({"ts": ctx.now, "duty": "retention", "store": hash, "native": true, "candidates": first.cands.len(), "chosen": choice.age + choice.size}),
    );
    // the store must not have moved under the comparison
    let second = match plan::plan_store(ctx.home, hash, s.rules(), now, &holds) {
        Ok(p) => p,
        Err(Defer(why)) => return plan_failed(ctx, hash, bytes_before, why, dry),
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
    let mut r = apply::prune(&mut run, &first, chosen, choice.size, choice.age, bytes_before, choice.over);
    r.total_rows = first.total_rows;
    r.already_tombstoned = first.total_tombstoned;
    for p in first.parts.values() {
        for (i, x) in [p.too_new, p.keep_last, p.unread, p.question, p.ndjson, p.broadcast, p.held].into_iter().enumerate() {
            r.protected[i] += x;
        }
    }
    Ended::Pruned(Box::new(r))
}

/// A plan that could not be made (a value Node's sqlite binding refuses, an unreadable table) ends the store the way Node's `catch`
/// in `pruneStore` does: nothing is written, the store's result is `ok: false` with the error text, and a `prune-error` line is logged.
fn plan_failed(ctx: &Ctx, hash: &str, bytes_before: u64, why: String, dry: bool) -> Ended {
    apply::log_event(
        ctx.home,
        &[("event", OVal::Str(defaults::text("devswarm_sup.rt_ev_prune_error").into())), ("store", OVal::Str(hash.into())), ("error", OVal::Str(why.clone()))],
    );
    if dry {
        return Ended::DryRun(json!({"hash": hash, "ok": false, "error": why}));
    }
    Ended::Pruned(Box::new(Pruned { hash: hash.to_string(), ok: false, error: Some(why), bytes_before, bytes_after: bytes_before, ..Pruned::default() }))
}

/// `recordStore(st, hash, r, now)`.
pub(super) fn record_store(st: &mut OVal, hash: &str, r: &Pruned, now: i64) {
    let Some(e) = obj_mut(st, defaults::text("devswarm_sup.rt_state_stores")).and_then(|stores| obj_mut(stores, hash)) else {
        return;
    };
    let prev_total = match e.get(defaults::text("devswarm_sup.rt_state_tombstoned")) {
        Some(OVal::Num(n)) if n.is_finite() => *n,
        Some(OVal::Str(t)) => crate::checks::guardkit::text::js_number_of_str(t),
        _ => 0.0,
    };
    let n = |x: f64| OVal::Num(x);
    for (k, v) in [
        ("lastRunAt", n(now as f64)),
        ("tombstoned", n(if prev_total.is_nan() { 0.0 } else { prev_total } + r.tombstoned as f64)),
        ("lastTombstoned", n(r.tombstoned as f64)),
        ("bytesBefore", n(r.bytes_before as f64)),
        ("bytesAfter", n(r.bytes_after as f64)),
        ("overLimitProtected", OVal::Bool(r.over_limit_protected)),
        ("vacuum", r.vacuum.clone().unwrap_or(OVal::Null)),
        ("error", r.error.as_deref().map_or(OVal::Null, |x| OVal::Str(x.into()))),
        ("budgetExhausted", OVal::Bool(r.budget_exhausted)),
    ] {
        e.set(k, v);
    }
}

/// Whether an owner-gated removal (`rt_fold_alone`, `rt_cap_alone`) is switched on; OFF by default.
fn alone(ctx: &Ctx, key: &str) -> bool {
    super::setting(ctx.st, key).as_bool().unwrap_or(false)
}

/// An owner-gated removal that is off: nothing is removed, the step is counted as `held` and named in the record.
fn held_alone(ctx: &Ctx, step: &str, hash: Option<&str>, key: &str) -> Value {
    crate::obs::counters::account("duty", step, crate::obs::counters::Outcome::Held, 0, 0);
    let why = defaults::text(key);
    witness_log(ctx, &json!({"ts": ctx.now, "duty": step, "store": hash, "native": true, "held": why}));
    json!({"held": why})
}

/// The journal fold of a store, only when there is a journal to fold. The raw journal file is removed after its verified compressed
/// copy exists, which is owner-gated (`rt_fold_alone`): off, the fold is `held`.
fn legacy_fold(ctx: &Ctx, hash: &str) -> Value {
    let mine = fold::items(ctx.home, hash);
    if mine.is_empty() {
        return Value::Null;
    }
    if !alone(ctx, "devswarm_sup.set_rt_fold_alone") {
        return held_alone(ctx, defaults::text("devswarm_sup.rt_step_fold"), Some(hash), "devswarm_sup.rt_why_fold_off");
    }
    // Node's `foldLegacyJournal` eligibility, now the engine's own: only a store whose merge into sqlite is PROVEN complete has its raw
    // journal removed; the archive copy being byte-equal says nothing about the messages having reached the database
    if let Some(reason) = fold::ineligible(ctx.home, hash) {
        witness_log(ctx, &json!({"ts": ctx.now, "duty": "retention-fold", "store": hash, "native": true, "held": reason}));
        return json!({"hash": hash, "eligible": false, "reason": reason, "files": [], "dryRun": false});
    }
    witness_log(ctx, &json!({"ts": ctx.now, "duty": "retention-fold", "store": hash, "native": true, "files": mine.len()}));
    fold::run(ctx.home, hash, &mine)
}

/// The archive cap: nothing to evict needs no gate; removing archived bodies is owner-gated (`rt_cap_alone`): off, it is `held`.
pub(super) fn archive_cap(ctx: &Ctx, _runner: &dyn Runner, s: &Settings) -> Value {
    if s.archive_max_mb <= 0.0 {
        return Value::Null;
    }
    let p = cap::plan(ctx.home, s);
    if p.removed.is_empty() {
        return p.json(false);
    }
    if !alone(ctx, "devswarm_sup.set_rt_cap_alone") {
        return held_alone(ctx, defaults::text("devswarm_sup.rt_step_cap"), None, "devswarm_sup.rt_why_cap_off");
    }
    witness_log(ctx, &json!({"ts": ctx.now, "duty": "retention-cap", "native": true, "files": p.removed.len()}));
    let done = cap::evict(ctx.home, &p);
    let mut v = p.json(false);
    v["removed"] = Value::Array(done.iter().map(|(f, b)| json!({"file": f, "bytes": b})).collect());
    v
}

/// The native sweep.
fn sweep(ctx: &Ctx, runner: &dyn Runner, dry: bool) -> Value {
    let s = read_settings(ctx);
    if !s.enabled() {
        return json!({"ran": false, "reason": defaults::text("devswarm_sup.msg_disabled")});
    }
    let Some(held) = nodelock::acquire(&lock_path(ctx.home), lock_params()) else {
        return json!({"ran": false, "reason": defaults::text("devswarm_sup.rt_reason_lock_busy")});
    };
    let out = locked(ctx, runner, &s, dry);
    held.release();
    out
}

fn locked(ctx: &Ctx, runner: &dyn Runner, s: &Settings, dry_switch: bool) -> Value {
    let dry = dry_switch;
    let t0 = std::time::Instant::now();
    let mut st = read_state(ctx.home);
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
    let backoff = defaults::num("devswarm_sup.rt_held_backoff_ms") as i64;
    due.retain(|x| !held_back(ctx, &x.hash, backoff));
    let mut result = Value::Null;
    if let Some(target) = due.first() {
        let started = std::time::Instant::now();
        match one_store(ctx, runner, &mut st, s, &target.hash, dry, false) {
            Ended::Pruned(r) => {
                let fold = legacy_fold(ctx, &target.hash);
                record_store(&mut st, &target.hash, &r, ctx.now);
                if r.tombstoned > 0 || !r.ok {
                    super::tick::record_action(
                        ctx.home,
                        &super::tick::Action {
                            action: defaults::text("devswarm_sup.rt_action"),
                            target: &target.hash,
                            inputs: json!({"ageCandidates": r.age_candidates, "sizeCandidates": r.size_candidates, "overLimit": r.over_limit}),
                            outcome: if r.ok { defaults::text("devswarm_sup.rt_action_pruned") } else { defaults::text("devswarm_sup.as_action_failed") },
                            reason: "",
                            latency_ms: started.elapsed().as_millis() as u64,
                            now: ctx.now,
                        },
                    );
                }
                result = json!({"ok": r.ok, "hash": r.hash, "tombstoned": r.tombstoned, "ageCandidates": r.age_candidates, "sizeCandidates": r.size_candidates,
                    "overLimit": r.over_limit, "overLimitProtected": r.over_limit_protected, "budgetExhausted": r.budget_exhausted, "batches": r.batches, "legacy": fold});
            }
            Ended::DryRun(v) => result = v,
            Ended::Held(why) => {
                stamp_held(ctx, &target.hash);
                result = json!({"hash": target.hash, "held": why});
            }
        }
    }
    let cap = if dry { Value::Null } else { archive_cap(ctx, runner, s) };
    if !dry {
        write_state(ctx.home, &st);
    }
    json!({"ran": true, "phase": defaults::text("devswarm_sup.rt_phase_armed"), "store": result, "archiveCap": cap, "dryRun": dry, "ms": t0.elapsed().as_millis() as u64})
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

/// The duty: native. A sweep that cannot run is reported in its record (disabled, lock busy), never handed to anyone else.
pub fn duty(ctx: &Ctx, runner: &dyn Runner) -> Value {
    let dry = super::setting(ctx.st, "devswarm_sup.set_dry_run_retention").as_bool().unwrap_or(false);
    json!({"duty": "retention", "outcome": if dry { "dry-run" } else { "ran" }, "detail": sweep(ctx, runner, dry)})
}

#[cfg(test)]
mod tests {
    //! The cases the engine used to hand to Node now answer natively, with Node's own result for each.
    use super::*;
    use crate::meshw::common::Inv;

    fn scratch(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("ah-ret-native-{tag}-{}", std::process::id()));
        crate::discard::harmless(std::fs::remove_dir_all(&d)); // keep: a stale directory of an earlier run of this test
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    const HASH: &str = "abc123";

    fn store(home: &Path, rows: &str) {
        let db = plan::db_path(home, HASH);
        std::fs::create_dir_all(db.parent().unwrap()).unwrap();
        let c = rusqlite::Connection::open(&db).unwrap();
        c.execute_batch(&format!(
            "CREATE TABLE messages (id INTEGER PRIMARY KEY, workspace_id TEXT, ts, seq, needs_reply, is_heartbeat, sender, recipient, mtype, urgency, body, hash, orig_hash, instance_nonce);
             CREATE TABLE broadcast_cursors (workspace_id TEXT, value);
             CREATE TABLE registry (id TEXT, inbox_path TEXT);
             CREATE TABLE cursors (workspace_id TEXT, value);
             {rows}"
        ))
        .unwrap();
    }

    fn with_ctx<T>(home: &Path, f: impl FnOnce(&Ctx) -> T) -> T {
        crate::defaults::init().unwrap();
        let inv = Inv {
            home: home.to_path_buf(),
            write_home: home.to_path_buf(),
            env: Default::default(),
            cwd: "/".into(),
            now: 10_000_000_000,
            stdin: None,
            store_override: None,
        };
        let st = inv.settings();
        let root = PathBuf::from("/");
        let ctx = Ctx { home, root: &root, st: &st, now: 10_000_000_000, engine_pokes: false };
        f(&ctx)
    }

    fn field(v: &OVal, k: &str) -> OVal {
        v.get(k).cloned().unwrap_or(OVal::Null)
    }

    #[test]
    fn an_integer_javascript_cannot_hold_ends_that_store_with_nodes_error_and_the_rest_carry_on() {
        let home = scratch("range");
        store(&home, "INSERT INTO messages VALUES (1,'w1',9007199254740993,1,0,0,'a','b','t',NULL,'one','h1',NULL,NULL);");
        let (ok, v) = with_ctx(&home, |ctx| cli::run(ctx, &crate::dsact::runner::System::configured(), true, Some(HASH)).unwrap());
        assert!(!ok);
        let OVal::Arr(rows) = field(&v, "stores") else { panic!("{}", v.stringify()) };
        assert_eq!(field(&rows[0], "ok"), OVal::Bool(false));
        assert!(matches!(field(&rows[0], "error"), OVal::Str(e) if e.contains("out of range")), "{}", v.stringify());
        crate::discard::harmless(std::fs::remove_dir_all(home)); // keep: cleanup of a scratch directory
    }

    #[test]
    fn a_blob_and_a_number_in_a_body_column_are_read_as_javascript_reads_them() {
        let home = scratch("blob");
        store(
            &home,
            "INSERT INTO messages VALUES (1,'w1',1000,1,0,0,'a','b','t',NULL,x'00ff10','h1',NULL,NULL), (2,'w1',1000,2,0,0,7,'b','t',NULL,42,'h2',NULL,NULL);
             INSERT INTO messages VALUES (3,'broadcast',1000,1,0,0,'a','b','t',NULL,x'0102','h3',NULL,NULL);",
        );
        let p = plan::plan_store(&home, HASH, plan::Rules { days: 30.0, keep: 0 }, 10_000_000_000.0, &[]);
        assert!(p.is_ok(), "{:?}", p.err());
        crate::discard::harmless(std::fs::remove_dir_all(home)); // keep: cleanup of a scratch directory
    }

    #[test]
    fn a_busy_lock_a_disabled_setting_and_an_unknown_store_answer_like_nodes_run() {
        let home = scratch("answers");
        store(&home, "INSERT INTO messages VALUES (1,'w1',1000,1,0,0,'a','b','t',NULL,'one','h1',NULL,NULL);");
        with_ctx(&home, |ctx| {
            let runner = crate::dsact::runner::System::configured();
            // an unknown (but well formed) store: Node's pruneStore returns `skipped: no-store`, ok
            let (ok, v) = cli::run(ctx, &runner, false, Some("nosuchstore")).unwrap();
            assert!(ok, "{}", v.stringify());
            let OVal::Arr(rows) = field(&v, "stores") else { panic!() };
            assert_eq!(field(&rows[0], "skipped"), OVal::Str("no-store".into()));
            // a held lock: `{ok: false, error: 'retention lock busy'}`
            let held = nodelock::acquire(&lock_path(ctx.home), lock_params()).unwrap();
            let (ok, v) = cli::run(ctx, &runner, false, None).unwrap();
            held.release();
            assert!(!ok);
            assert_eq!(field(&v, "error"), OVal::Str("retention lock busy".into()));
        });
        crate::discard::harmless(std::fs::remove_dir_all(home)); // keep: cleanup of a scratch directory
    }

    #[test]
    fn a_state_whose_stores_is_an_array_reads_as_no_entries() {
        let home = scratch("state");
        let p = state_path(&home);
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(&p, r#"{"stores":[1,2],"holds":[3],"phase":"armed"}"#).unwrap();
        crate::defaults::init().unwrap();
        let st = read_state(&home);
        assert!(matches!(st.get("stores"), Some(OVal::Obj(o)) if o.is_empty()));
        assert!(matches!(st.get("holds"), Some(OVal::Obj(o)) if o.is_empty()));
        crate::discard::harmless(std::fs::remove_dir_all(home)); // keep: cleanup of a scratch directory
    }
}
