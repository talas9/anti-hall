//! One tick of the supervisor duties (the scheduler job `devswarm_supervisor`). Order, guards and gates mirror Node's `main()`:
//! the guard first (a running Node supervisor means stand down), then log rotation, then under the shared sweep lock each duty of
//! `devswarm_sup.duties` in order, each bounded by its own timeout and the tick's budget. A failed duty never stops the next.
// Discard triage (E3): every `.ok()` / `unwrap_or_default()` in this module is a deliberate keep, for these reasons:
// - an unreadable state file is an absent one (Node's try/catch): the duty is due
// - worker output that is not JSON is kept as text
use super::{Owner, node_logs, setting};
use crate::checks::git::util::Settings;
use crate::checks::guardkit::nodelock;
use crate::defaults::{self, V};
use crate::dsact::runner::{RunResult, RunSpec, Runner};
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

pub(super) fn cut(s: &str) -> String {
    s.chars().take(defaults::num("devswarm_sup.detail_chars") as usize).collect()
}

/// The worker's last output line as JSON, else its text.
pub(super) fn parse(out: &str) -> Value {
    let last = out.lines().rev().find(|l| !l.trim().is_empty()).unwrap_or_default();
    serde_json::from_str(last).unwrap_or_else(|_| Value::String(cut(out)))
}

/// Run a Node snippet bounded. `extra` follow the plugin root and the home directory.
pub fn node(runner: &dyn Runner, ctx: &Ctx, snippet: &str, extra: &[&str], timeout_ms: u64) -> RunResult {
    let mut args: Vec<String> = defaults::list("devswarm_sup.node_args").iter().map(|a| (*a).to_string()).collect();
    args.push(snippet.to_string());
    args.push(ctx.root.to_string_lossy().into_owned());
    args.push(ctx.home.to_string_lossy().into_owned());
    args.extend(extra.iter().map(|a| (*a).to_string()));
    runner.run(&RunSpec { bin: Some(defaults::text("devswarm_sup.node_bin").to_string()), args, cwd: None, timeout_ms, ..RunSpec::default() })
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

/// The native duty: rotate the supervisor's log and the engine's own tick log. The supervisor's own bounded logs only.
pub fn log_rotate(ctx: &Ctx) -> Value {
    let threshold = setting(ctx.st, "devswarm_sup.set_log_rotate_bytes").as_u64().unwrap_or(u64::MAX);
    let engine = ctx.home.join(defaults::text("devswarm_sup.engine_log"));
    json!({"supervisor": rotate_one(&node_logs(ctx.home)[0], threshold), "engine": rotate_one(&engine, threshold)})
}

fn lock_params() -> nodelock::Params {
    nodelock::Params { stale_ms: defaults::num("devswarm_sup.lock_stale_ms"), wait_ms: 0, steal_dead: true, ..nodelock::Params::swarm() }
}

/// The sweep lock path (Node's file).
pub fn lock_path(home: &Path) -> String {
    super::root(home).join(defaults::text("devswarm_sup.lock_file")).to_string_lossy().into_owned()
}

/// Whether `name` runs natively this tick: a native duty always does, a node-kind duty with a native implementation does unless the
/// rollback list `devswarm_sup.node_duties` names it.
fn runs_native(name: &str, d: &V) -> bool {
    d.str_field("kind") == "native" || (d.get("native").and_then(V::as_bool) == Some(true) && !defaults::list("devswarm_sup.node_duties").contains(&name))
}

/// The witness mirror of a duty's inputs, taken before the engine acts (`None`: not due, off, or nothing to compare).
fn prepare_witness(name: &str, ctx: &Ctx) -> Option<super::witness::Job> {
    if !super::witness::due(ctx, name) {
        return None;
    }
    match name {
        "log_rotate" => super::witness::prepare_log_rotate(ctx),
        "housekeeping" => super::housekeep::witness_prepare(ctx),
        _ => None,
    }
}

/// One duty: its gate, then its work (native, or Node's function in a bounded subprocess). Returns the duty's record and, for a
/// native duty that is due for a comparison, the witness job to finish AFTER the sweep lock is released.
pub fn run_duty_w(name: &str, ctx: &Ctx, runner: &dyn Runner) -> (Value, Option<super::witness::Job>) {
    let d = duty(name);
    if let Some(why) = not_due(ctx, d) {
        return (json!({"duty": name, "outcome": "skipped", "reason": why}), None);
    }
    if runs_native(name, d) {
        if !super::supervisor_enabled(ctx.st) {
            return (json!({"duty": name, "outcome": "skipped", "reason": defaults::text("devswarm_sup.msg_disabled")}), None);
        }
        let job = prepare_witness(name, ctx);
        let detail = match name {
            "log_rotate" => log_rotate(ctx),
            "housekeeping" => super::housekeep::run(ctx),
            _ => return (json!({"duty": name, "outcome": "skipped", "reason": defaults::text("devswarm_sup.msg_disabled")}), None),
        };
        return (json!({"duty": name, "outcome": "ran", "detail": detail}), job);
    }
    let owner = if ctx.engine_pokes { defaults::text("devswarm_sup.owner_engine") } else { defaults::text("devswarm_sup.owner_node") };
    let timeout = d.get("timeout_ms").and_then(V::as_integer).unwrap_or(0).max(1) as u64;
    let r = node(runner, ctx, d.str_field("snippet"), &[owner], timeout);
    let rec = if r.ok {
        json!({"duty": name, "outcome": "ran", "detail": parse(&r.stdout)})
    } else {
        let why = r.error.clone().unwrap_or_else(|| if r.missing { defaults::text("devswarm_sup.msg_no_node").into() } else { cut(&r.stderr) });
        json!({"duty": name, "outcome": "failed", "error": why, "status": r.status, "timedOut": r.timed_out})
    };
    (rec, None)
}

/// [`run_duty_w`] with the witness comparison finished at once (no lock to wait for).
pub fn run_duty(name: &str, ctx: &Ctx, runner: &dyn Runner) -> Value {
    let (rec, job) = run_duty_w(name, ctx, runner);
    if let Some(j) = job {
        super::witness::finish(j, ctx, runner, &rec);
    }
    rec
}

/// One tick. `owner` is the configured mode; a witness runs nothing. Where DevSwarm is absent nothing is read or written.
pub fn run(ctx: &Ctx, owner: Owner, runner: &dyn Runner) -> Value {
    if owner != Owner::Engine {
        return json!({"ran": false, "reason": "witness", "why": defaults::text("devswarm_sup.msg_witness")});
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
    let mut jobs: Vec<(usize, super::witness::Job)> = Vec::new();
    if let Some(f) = first {
        let (rec, job) = run_duty_w(f, ctx, runner);
        out.push(rec);
        jobs.extend(job.map(|j| (out.len() - 1, j)));
    }
    let Some(held) = nodelock::acquire(&lock_path(ctx.home), lock_params()) else {
        return json!({"ran": false, "reason": "locked", "why": defaults::text("devswarm_sup.msg_locked"), "duties": out});
    };
    for name in rest {
        if now_ms() - started > budget {
            out.push(json!({"duty": name, "outcome": "skipped", "reason": defaults::text("devswarm_sup.msg_budget")}));
            continue;
        }
        let (rec, job) = run_duty_w(name, ctx, runner);
        out.push(rec);
        jobs.extend(job.map(|j| (out.len() - 1, j)));
    }
    held.release();
    // the Node witnesses run after the lock is released: they work on scratch copies and never need it
    for (i, job) in jobs {
        let verdict = super::witness::finish(job, ctx, runner, &out[i]);
        out[i]["witness"] = json!({"match": verdict["match"]});
    }
    let rec = json!({"ts": ctx.now, "ran": true, "duties": out});
    crate::dsact::exec::append_line(&ctx.home.join(defaults::text("devswarm_sup.engine_log")), &rec);
    rec
}

/// After an engine escalation: the one-time notice to the parent (Primary), by Node's own function (store message with the
/// hash `escalate:<id>:<staleSince>`, parked and retried by the liveness sweep when the Primary is not registered).
pub fn notify_escalation(runner: &dyn Runner, home: &Path, root: &Path, st: &Settings, id: &str) -> RunResult {
    let ctx = Ctx { home, root, st, now: now_ms(), engine_pokes: true };
    node(runner, &ctx, defaults::text("devswarm_sup.notify_escalation"), &[id], defaults::num("devswarm_sup.notify_timeout_ms"))
}
