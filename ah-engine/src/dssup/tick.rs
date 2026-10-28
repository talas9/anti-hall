//! One tick of the supervisor duties (the scheduler job `devswarm_supervisor`). Order, guards and gates mirror Node's `main()`:
//! the guard first (a running Node supervisor means stand down), then log rotation, then under the shared sweep lock each duty of
//! `devswarm_sup.duties` in order, each bounded by the tick's budget. Every duty is native; a step it cannot decide is `held`
//! ([`held`]), a duty named in `devswarm_sup.duties_off` is `disabled`. A failed duty never stops the next.
// Discard triage (E3): every `.ok()` / `unwrap_or_default()` in this module is a deliberate keep, for these reasons:
// - an unreadable state file is an absent one (Node's try/catch): the duty is due
// - worker output that is not JSON is kept as text
use super::{Owner, node_logs, setting};
use crate::checks::git::util::Settings;
use crate::checks::guardkit::nodelock;
use crate::defaults::{self, V};
use crate::dsact::runner::{RunResult, Runner};
use serde_json::{Value, json};
use std::path::Path;

/// What one tick needs besides the runner.
#[derive(Clone)]
pub struct Ctx<'a> {
    /// The home directory.
    pub home: &'a Path,
    /// The plugin root (the Node functions are loaded from it).
    pub root: &'a Path,
    /// The settings tiers (environment and `settings.json` of `home`).
    pub st: &'a Settings,
    /// The clock, epoch ms.
    pub now: i64,
    /// Whether the engine owns poke and escalate (Node's poke step is then switched off in the liveness sweep).
    pub engine_pokes: bool,
}

fn now_ms() -> i64 {
    crate::health::now_ms() as i64
}

fn duty(name: &str) -> &'static V {
    defaults::raw(&format!("devswarm_sup.duty.{name}"))
}

/// A step the native path cannot decide this time. The hand-back to Node is gone: the step is counted at `site` as `native_unable`,
/// nothing is written or launched, and the record says `held` with the reason; the next tick or pass tries it again.
pub fn held(site: &str, why: &str) -> Value {
    crate::obs::counters::handback_why(crate::obs::counters::Handback::Abandoned, site, why);
    json!({"held": why})
}

/// Node's `lastRunAt` of a state file (`{"lastRunAt": <ms>}`), 0 when absent or unreadable.
pub fn last_run_at(home: &Path, state: &str) -> i64 {
    std::fs::read_to_string(super::root(home).join(state))
        .ok()
        .and_then(|t| serde_json::from_str::<Value>(&t).ok())
        .and_then(|v| v.get("lastRunAt").and_then(Value::as_f64))
        .map_or(0, |f| f as i64)
}

/// Why a duty is not due, or `None` when it is.
pub fn not_due(ctx: &Ctx, d: &V) -> Option<String> {
    if d.str_field("gate") != "cooldown" {
        return None;
    }
    let off = setting(ctx.st, d.str_field("mode")).as_str().is_some_and(|m| m == "off");
    if off {
        return Some(defaults::text("devswarm_sup.msg_disabled").into());
    }
    let sec = setting(ctx.st, d.str_field("sec")).as_i64().unwrap_or(0);
    let last = last_run_at(ctx.home, d.str_field("state"));
    (last != 0 && ctx.now - last < sec * 1000).then(|| defaults::text("devswarm_sup.msg_cooldown").into())
}

fn rotate_one(path: &Path, threshold: u64) -> Value {
    let Ok(md) = std::fs::metadata(path) else { return json!({"rotated": false, "size": 0, "reason": defaults::text("devswarm_sup.reason_no_log")}) };
    if md.len() <= threshold {
        return json!({"rotated": false, "size": md.len(), "reason": defaults::text("devswarm_sup.reason_under")});
    }
    let mut backup = path.as_os_str().to_os_string();
    backup.push(defaults::text("devswarm_sup.log_backup_suffix"));
    let backup = std::path::PathBuf::from(backup);
    crate::discard::harmless(std::fs::remove_file(&backup)); // keep: an absent backup is fine, at most one prior generation is kept
    match std::fs::rename(path, &backup) {
        Ok(()) => json!({"rotated": true, "size": md.len(), "reason": defaults::render("devswarm_sup.reason_rotated", &[("backup", &backup.display())])}),
        Err(e) => json!({"rotated": false, "size": 0, "reason": defaults::render("devswarm_sup.reason_rotate_failed", &[("err", &e)])}),
    }
}

/// The native duty: rotate the supervisor's log, the engine's own tick log and the supervision event log. The supervisor's own bounded logs only.
pub fn log_rotate(ctx: &Ctx) -> Value {
    let threshold = setting(ctx.st, "devswarm_sup.set_log_rotate_bytes").as_u64().unwrap_or(u64::MAX);
    let engine = ctx.home.join(defaults::text("devswarm_sup.engine_log"));
    json!({"supervisor": rotate_one(&node_logs(ctx.home)[0], threshold), "engine": rotate_one(&engine, threshold), "supervision": super::suplog::rotate_if_needed(ctx.home)})
}

fn lock_params() -> nodelock::Params {
    nodelock::Params { stale_ms: defaults::num("devswarm_sup.lock_stale_ms"), wait_ms: 0, steal_dead: true, ..nodelock::Params::swarm() }
}

/// The sweep lock path (Node's file).
pub fn lock_path(home: &Path) -> String {
    super::root(home).join(defaults::text("devswarm_sup.lock_file")).to_string_lossy().into_owned()
}

/// The record of a duty that is switched off, naming why (the outcome the accounting counts as `disabled`).
fn off(name: &str, why: &str) -> Value {
    json!({"duty": name, "outcome": "disabled", "reason": why})
}

/// One duty: its gate, then its native work. A duty named in `devswarm_sup.duties_off` (the diagnostic switch) does nothing and says so.
pub fn run_duty(name: &str, ctx: &Ctx, runner: &dyn Runner) -> Value {
    let d = duty(name);
    if defaults::list("devswarm_sup.duties_off").contains(&name) {
        return off(name, defaults::text("devswarm_sup.msg_duty_off"));
    }
    if let Some(why) = not_due(ctx, d) {
        // a mode of `off` is a switched-off duty; a cool-down that has not passed is a duty that is simply not due
        return if why == defaults::text("devswarm_sup.msg_disabled") {
            off(name, &why)
        } else {
            json!({"duty": name, "outcome": "skipped", "gate": "cooldown", "reason": why})
        };
    }
    if !super::supervisor_enabled(ctx.st) {
        return off(name, defaults::text("devswarm_sup.msg_disabled"));
    }
    match name {
        "log_rotate" => json!({"duty": name, "outcome": "ran", "detail": log_rotate(ctx)}),
        "housekeeping" => json!({"duty": name, "outcome": "ran", "detail": super::housekeep::run(ctx)}),
        "verdicts" => super::liveness::duty(ctx, runner),
        "deferred" => super::deferred::duty(ctx, runner),
        "retention" => super::retention::duty(ctx, runner),
        "app_sync" => super::appsync::duty(ctx, runner),
        "reconcile" if super::recon::sweep::engine_mode() => super::recon::sweep::duty(ctx, runner, &super::recon::Hooks::none()),
        "reconcile" => off(name, defaults::text("devswarm_sup.msg_duty_off")),
        _ => off(name, defaults::text("devswarm_sup.msg_duty_unknown")),
    }
}

/// [`run_duty`] with the duty's wall time and this thread's CPU time (ms) added to its record as `ms` and `cpuMs`. A gated duty
/// whose inputs did not change since its last run is not run (see [`super::gate`]): its record says so.
fn timed_duty(name: &str, ctx: &Ctx, runner: &dyn Runner) -> Value {
    let (t, cpu) = (std::time::Instant::now(), crate::limits::thread_cpu_us());
    let sig = super::gate::signature(name, ctx);
    let mut rec = match super::gate::skip(ctx.home, name, sig, ctx.now) {
        Some(why) => json!({"duty": name, "outcome": "skipped", "reason": why, "gate": "inputs-unchanged"}),
        None => {
            let rec = run_duty(name, ctx, runner);
            if super::gate::quiet(name, &rec) {
                super::gate::remember(ctx.home, name, sig, ctx.now);
            }
            rec
        }
    };
    let ms = t.elapsed().as_millis() as u64;
    crate::obs::counters::account_record("duty", name, &rec, crate::limits::thread_cpu_us().saturating_sub(cpu), t.elapsed().as_micros() as u64);
    emit_act(
        ctx.home,
        &defaults::render("devswarm_sup.act_duty", &[("duty", &name)]),
        "",
        rec["outcome"].as_str().unwrap_or_default(),
        rec["gate"].as_str().unwrap_or_default(),
        ms,
        "",
    );
    if let Some(o) = rec.as_object_mut() {
        o.insert("ms".into(), json!(ms));
        o.insert("cpuMs".into(), json!(crate::limits::thread_cpu_us().saturating_sub(cpu) / 1000));
    }
    rec
}

/// One tick. `owner` is the configured mode; `off` runs nothing (counted as a disabled tick). Where DevSwarm is absent nothing is read or written.
pub fn run(ctx: &Ctx, owner: Owner, runner: &dyn Runner) -> Value {
    if owner != Owner::Engine {
        crate::obs::counters::account("duty", defaults::text("devswarm_sup.tick_name"), crate::obs::counters::Outcome::Disabled, 0, 0);
        return json!({"ran": false, "reason": "off", "why": defaults::text("devswarm_sup.msg_witness")});
    }
    let env: std::collections::HashMap<String, String> = ctx.st.env.clone();
    let d = crate::devswarm_rt::detect(ctx.home, &env);
    if d.app_db.is_none() && !d.descriptors {
        return json!({"ran": false, "reason": "inert", "why": defaults::text("devswarm_sup.msg_inert")});
    }
    if let Some(age) = super::node_running(ctx.home, ctx.now) {
        return json!({"ran": false, "reason": "node-running", "ageMs": age,
            "why": defaults::render("devswarm_sup.msg_guard", &[("age", &(age / 1000))])});
    }
    let started = now_ms();
    let budget = defaults::num("devswarm_sup.tick_budget_ms") as i64;
    let mut out = Vec::new();
    let names = defaults::list("devswarm_sup.duties");
    // Node rotates its log before it takes the lock; the other duties run under it
    let (first, rest) = names.split_first().map_or((None, &[][..]), |(f, r)| (Some(*f), r));
    if let Some(f) = first {
        out.push(timed_duty(f, ctx, runner));
    }
    let Some(held) = nodelock::acquire(&lock_path(ctx.home), lock_params()) else {
        return json!({"ran": false, "reason": "locked", "why": defaults::text("devswarm_sup.msg_locked"), "duties": out});
    };
    for name in rest {
        if now_ms() - started > budget {
            out.push(json!({"duty": name, "outcome": "skipped", "reason": defaults::text("devswarm_sup.msg_budget")}));
            continue;
        }
        out.push(timed_duty(name, ctx, runner));
    }
    held.release();
    let rec = json!({"ts": ctx.now, "ran": true, "duties": out});
    crate::dsact::exec::append_line(&ctx.home.join(defaults::text("devswarm_sup.engine_log")), &rec);
    rec
}

/// After an engine escalation: the one-time notice to the parent (Primary), native (`notifyParentEscalation`: a store message with
/// the hash `escalate:<id>:<staleSince>`, parked and retried by the liveness sweep when the Primary is not registered). The
/// result carries the delivery status as JSON on stdout; `ok` is false only when no notice could be built.
pub fn notify_escalation(_runner: &dyn Runner, home: &Path, _root: &Path, st: &Settings, id: &str) -> RunResult {
    let now = now_ms();
    let t0 = std::time::Instant::now();
    let desc = super::liveness::read_descriptors(home).into_iter().find(|d| d.id == id);
    let wt = desc.as_ref().and_then(|d| d.raw.get(defaults::text("mesh_write.field_worktree_path"))).and_then(|v| match v {
        crate::checks::guardkit::ojson::OVal::Str(s) => Some(s.clone()),
        _ => None,
    });
    let since = super::verdict::path(home, id)
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|t| serde_json::from_str::<Value>(&t).ok())
        .and_then(|v| v.get(defaults::list("devswarm_sup.lv_keys")[2]).and_then(Value::as_f64));
    let r = match wt {
        None => Err(defaults::text("devswarm_sup.esc_why_no_descriptor").to_string()),
        Some(wt) => super::verdict::notify_parent(home, &st.env, &wt, id, since, now),
    };
    let (outcome, reason) = match &r {
        Ok(d) => (d.status.to_string(), String::new()),
        Err(why) => (defaults::text("devswarm_sup.esc_skipped").to_string(), why.clone()),
    };
    record_action(
        home,
        &Action {
            action: defaults::text("devswarm_sup.esc_action"),
            target: id,
            inputs: json!({"staleSince": since}),
            outcome: &outcome,
            reason: &reason,
            latency_ms: t0.elapsed().as_millis() as u64,
            now,
        },
    );
    RunResult { ok: r.is_ok(), stdout: json!({"notified": r.is_ok(), "status": outcome, "why": reason}).to_string(), ..RunResult::default() }
}

// ---- action ledger and telemetry (every acting supervisor step is measured) ---------------------------------------------------

/// One action the supervisor took (or declined), for the action ledger and telemetry.
pub struct Action<'a> {
    /// The action word (`devswarm_sup.esc_action`, ...).
    pub action: &'a str,
    /// What it acted on (a workspace id, a store hash).
    pub target: &'a str,
    /// The decision inputs.
    pub inputs: Value,
    /// The outcome word.
    pub outcome: &'a str,
    /// Why, when it did not act.
    pub reason: &'a str,
    /// Wall time.
    pub latency_ms: u64,
    /// The clock, epoch ms.
    pub now: i64,
}

/// The id of an action: `<action>:<target>:<now>`.
pub fn action_id(action: &str, target: &str, now: i64) -> String {
    format!("{action}:{target}:{now}")
}

/// One telemetry event. For the process's own home it goes the usual way (the daemon's recorder, else the inbox); for any other
/// home (a scratch home) it goes to the inbox under that home, so a run on a scratch home never writes the real state.
fn emit_event(home: &Path, ev: crate::telemetry::event::Event) {
    if crate::defaults::env_var("home").is_some_and(|h| Path::new(&h) == home) {
        crate::telemetry::emit::event(ev);
    } else {
        let inbox = home.join(defaults::text("paths.base_dir")).join(defaults::text("paths.state_dir")).join(defaults::text("files.telemetry_inbox"));
        crate::telemetry::emit::append_to(&inbox, &[ev]);
    }
}

/// The telemetry outcome of an outcome word: a success word is Allow, a refusal word Block, a not-applicable word Skip, and any
/// other (a notice that had to be parked, a write that failed, a duty that failed) Error.
fn act_outcome(word: &str) -> crate::telemetry::event::Outcome {
    use crate::telemetry::event::Outcome;
    let is = |key: &str| defaults::list(key).contains(&word);
    if is("devswarm_sup.action_success") {
        Outcome::Allow
    } else if is("devswarm_sup.act_block_outcomes") {
        Outcome::Block
    } else if is("devswarm_sup.act_skip_outcomes") {
        Outcome::Skip
    } else {
        Outcome::Error
    }
}

/// One supervisor `act` telemetry event (the shared act schema, feature `devswarm_sup.action_feature`).
pub fn emit_act(home: &Path, action: &str, target: &str, outcome: &str, reason: &str, latency_ms: u64, action_id: &str) {
    let tok = crate::actlog::token;
    let rec = crate::telemetry::emit::ActRec {
        feature: &tok(defaults::text("devswarm_sup.action_feature")),
        action: &tok(action),
        outcome: act_outcome(outcome),
        latency_ms,
        target: &tok(target),
        inputs: "",
        reason: &tok(reason),
        action_id: &tok(action_id),
    };
    emit_event(home, crate::telemetry::emit::act_call(&rec));
}

/// One supervisor `mistake` telemetry event about `action` (a wrong decision found later: a witness that disagrees, an escalated
/// workspace that turned out to be live). `reason` is a stable word, never text.
pub fn emit_mistake(home: &Path, action: &str, target: &str, reason: &str, action_id: &str) {
    let tok = crate::actlog::token;
    let rec = crate::telemetry::emit::ActRec {
        feature: &tok(defaults::text("devswarm_sup.action_feature")),
        action: &tok(action),
        outcome: crate::telemetry::event::Outcome::Advise,
        latency_ms: 0,
        target: &tok(target),
        inputs: "",
        reason: &tok(reason),
        action_id: &tok(action_id),
    };
    emit_event(home, crate::telemetry::emit::mistake_call(&rec));
}

/// Record one action: a line of the action ledger (`devswarm_sup.action_log`) and a telemetry `act` event (an outcome outside
/// `devswarm_sup.action_success` counts as an error, or a skip / block per `act_skip_outcomes` / `act_block_outcomes`). Returns
/// the action id.
pub fn record_action(home: &Path, a: &Action) -> String {
    let id = action_id(a.action, a.target, a.now);
    crate::dsact::exec::append_line(
        &home.join(defaults::text("devswarm_sup.action_log")),
        &json!({"ts": a.now, "kind": defaults::text("devswarm_sup.action_kind"), "feature": defaults::text("devswarm_sup.action_feature"), "action": a.action,
            "target": a.target, "inputs": a.inputs, "outcome": a.outcome, "reason": a.reason, "latency_ms": a.latency_ms, "action_id": id}),
    );
    emit_act(home, a.action, a.target, a.outcome, a.reason, a.latency_ms, &id);
    id
}

/// Record a mistake signal for an earlier action (`action_id`): a ledger line of kind `devswarm_sup.mistake_kind` and a telemetry
/// `mistake` event.
pub fn record_mistake(home: &Path, action: &str, action_id: &str, why: &str, now: i64) {
    crate::dsact::exec::append_line(
        &home.join(defaults::text("devswarm_sup.action_log")),
        &json!({"ts": now, "kind": defaults::text("devswarm_sup.mistake_kind"), "feature": defaults::text("devswarm_sup.action_feature"), "action": action,
            "action_id": action_id, "reason": why}),
    );
    emit_mistake(home, action, "", why, action_id);
}

/// The newest action line of the ledger for `target` with one of `actions`: `(action, action_id)`.
pub fn last_action(home: &Path, actions: &[&str], target: &str) -> Option<(String, String)> {
    let text = std::fs::read_to_string(home.join(defaults::text("devswarm_sup.action_log"))).ok()?;
    text.lines().rev().filter_map(|l| serde_json::from_str::<Value>(l).ok()).find_map(|v| {
        let action = v.get("action").and_then(Value::as_str)?;
        let ok = v.get("kind").and_then(Value::as_str) == Some(defaults::text("devswarm_sup.action_kind"))
            && actions.contains(&action)
            && v.get("target").and_then(Value::as_str) == Some(target);
        ok.then(|| (action.to_string(), v.get("action_id").and_then(Value::as_str).unwrap_or_default().to_string()))
    })
}
