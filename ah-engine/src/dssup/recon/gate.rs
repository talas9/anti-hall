//! The witness gate: nothing the planners decided touches the real home until Node, running its own function on a scratch mirror,
//! ends in exactly the state the engine's op list produces on another scratch mirror.
//!
//! One gate run is one Node process for the whole job (a dispatcher snippet from the plugin's defaults runs each recorded call
//! in order, with `Date.now` pinned to the engine's clock and the log directory pointed into the mirror) and one pass of the
//! engine's applier over a second mirror. The two post-states are normalised ([`super::norm`]) and compared, and so are the
//! values the calls returned. On equality the same units are applied to the real home, each under its own lock with its
//! preconditions re-checked; on any difference nothing is applied and every unit is handed back to Node.
//!
//! Node itself is never given the real home: its writes land in the scratch mirror only (the scratch HOME and the redirected
//! log directory keep every file it touches inside it). If Node cannot run at all, nothing is applied: the engine is never
//! weaker than Node, and an unwitnessed decision is not applied.
use super::apply::{self, Env};
use super::{Hooks, Unit, UnitEnd};
use crate::dsact::runner::Runner;
use crate::dssup::tick::Ctx;
use crate::defaults;
use serde_json::{Value, json};
use std::path::PathBuf;

/// The inputs of a job, mirrored for both sides.
pub use super::Scope;

/// One job: what to mirror, the units to apply, and the Node calls that must reach the same state.
pub struct Job {
    /// A name for the witness log.
    pub label: String,
    /// What the mirrors hold.
    pub scope: Scope,
    /// The engine's units, in the order Node's calls perform them.
    pub units: Vec<Unit>,
    /// The Node calls (`{"fn": name, "args": {..}}`), in order.
    pub calls: Vec<Value>,
    /// For each call, the value the engine says Node's function returns (`None`: not compared).
    pub expect: Vec<Option<Value>>,
}

/// What the witness found.
#[derive(Debug, Clone, PartialEq)]
pub enum Verdict {
    /// Node and the engine ended in the same state with the same return values.
    Agreed,
    /// They differ; the texts say where (first differences only).
    Mismatch(Vec<String>),
    /// Node could not run (missing, timed out, unparsable answer): the decision is unwitnessed.
    NodeUnavailable(String),
    /// A mirror could not be built or the engine's own pass over it failed.
    MirrorFailed(String),
}

/// The result of a gated job.
#[derive(Debug, Clone, PartialEq)]
pub struct Outcome {
    /// How each unit ended on the real home, in unit order.
    pub ends: Vec<UnitEnd>,
    /// What the witness said.
    pub verdict: Verdict,
}

fn deferred(job: &Job, why: &str, verdict: Verdict) -> Outcome {
    Outcome { ends: job.units.iter().map(|_| UnitEnd::Deferred(why.to_string())).collect(), verdict }
}

fn scratch_dir(ctx: &Ctx, label: &str) -> PathBuf {
    ctx.home.join(defaults::text("devswarm_sup.witness_dir")).join(format!("{}{label}-{}-{}", defaults::text("devswarm_recon.scratch_prefix"), ctx.now, std::process::id()))
}

fn run_node(ctx: &Ctx, runner: &dyn Runner, home: &std::path::Path, calls: &[Value]) -> Result<Vec<Value>, String> {
    let sctx = Ctx { home, ..ctx.clone() };
    let now = ctx.now.to_string();
    let payload = Value::Array(calls.to_vec()).to_string();
    let r = crate::dssup::tick::node(
        runner,
        &sctx,
        defaults::text("devswarm_recon.node_snippet"),
        &[&now, &payload],
        defaults::num("devswarm_recon.node_timeout_ms"),
    );
    if !r.ok {
        return Err(r.error.clone().unwrap_or_else(|| r.stderr.chars().take(defaults::num("devswarm_sup.detail_chars") as usize).collect()));
    }
    let last = r.stdout.lines().rev().find(|l| !l.trim().is_empty()).unwrap_or_default();
    match serde_json::from_str::<Value>(last) {
        Ok(Value::Array(a)) if a.len() == calls.len() => Ok(a),
        _ => Err(defaults::text("devswarm_recon.why_node_answer").to_string()),
    }
}

fn record(ctx: &Ctx, job: &Job, verdict: &Verdict) {
    let (matched, detail) = match verdict {
        Verdict::Agreed => (json!(true), Value::Null),
        Verdict::Mismatch(d) => (json!(false), json!(d.iter().take(defaults::num("devswarm_recon.witness_diffs") as usize).collect::<Vec<_>>())),
        Verdict::NodeUnavailable(w) | Verdict::MirrorFailed(w) => (Value::Null, json!(w)),
    };
    let rec = json!({"ts": ctx.now, "job": job.label, "units": job.units.len(), "match": matched, "detail": detail});
    crate::dsact::exec::append_line(&ctx.home.join(defaults::text("devswarm_recon.witness_file")), &rec);
}

/// Witness the job and, only if Node and the engine agree, apply it to the real home.
pub fn run(ctx: &Ctx, runner: &dyn Runner, job: &Job, hooks: &Hooks) -> Outcome {
    if job.calls.is_empty() {
        return Outcome { ends: job.units.iter().map(|_| UnitEnd::Applied).collect(), verdict: Verdict::Agreed };
    }
    let scratch = scratch_dir(ctx, &job.label);
    let (m_node, m_eng) = (scratch.join(defaults::text("devswarm_recon.mirror_node")), scratch.join(defaults::text("devswarm_recon.mirror_eng")));
    let verdict = witness(ctx, runner, job, &m_node, &m_eng);
    record(ctx, job, &verdict);
    crate::discard::harmless(std::fs::remove_dir_all(&scratch)); // keep: the engine's own scratch mirrors, never user data
    match verdict {
        Verdict::Agreed => {
            let env = Env { home: ctx.home, now: ctx.now, st: ctx.st, log_dir: None };
            Outcome { ends: job.units.iter().map(|u| apply::unit(&env, u, hooks)).collect(), verdict }
        }
        Verdict::Mismatch(_) => deferred(job, defaults::text("devswarm_recon.why_mismatch"), verdict),
        Verdict::NodeUnavailable(_) => deferred(job, defaults::text("devswarm_recon.why_node_unavailable"), verdict),
        Verdict::MirrorFailed(_) => deferred(job, defaults::text("devswarm_recon.why_mirror"), verdict),
    }
}

fn witness(ctx: &Ctx, runner: &dyn Runner, job: &Job, m_node: &std::path::Path, m_eng: &std::path::Path) -> Verdict {
    for m in [m_node, m_eng] {
        if let Err(e) = super::mirror::make(ctx.home, m, &job.scope) {
            return Verdict::MirrorFailed(e);
        }
    }
    let theirs = match run_node(ctx, runner, m_node, &job.calls) {
        Ok(v) => v,
        Err(e) => return Verdict::NodeUnavailable(e),
    };
    let log_dir = m_eng.join(defaults::text("mesh_write.dir_anti_hall")).join(defaults::text("mesh_write.dir_logs"));
    let env = Env { home: m_eng, now: ctx.now, st: ctx.st, log_dir: Some(log_dir) };
    for u in &job.units {
        match apply::unit(&env, u, &Hooks::none()) {
            UnitEnd::Applied => {}
            UnitEnd::Deferred(w) | UnitEnd::Failed(w) => return Verdict::MirrorFailed(format!("{}: {w}", u.label)),
        }
    }
    let mut diffs = super::norm::diff(&super::norm::dump_masked(m_node), &super::norm::dump_masked(m_eng));
    for (i, want) in job.expect.iter().enumerate() {
        if let Some(w) = want
            && theirs.get(i) != Some(w)
        {
            let got = theirs.get(i).map_or_else(|| defaults::text("devswarm_recon.msg_nothing").to_string(), Value::to_string);
            diffs.push(defaults::render("devswarm_recon.msg_call_differs", &[("i", &i), ("got", &got), ("want", w)]));
        }
    }
    if diffs.is_empty() { Verdict::Agreed } else { Verdict::Mismatch(diffs) }
}
