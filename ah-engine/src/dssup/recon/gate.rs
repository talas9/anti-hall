//! The apply gate: the planners decide, the engine's applier writes each unit to the real home, each under its own lock with its
//! preconditions re-checked. There is no Node comparison any more (the non-acting Node witness is gone): the native result of
//! every job is logged to `devswarm_recon.witness_file` (units, how each ended) and counted.
use super::apply::{self, Env};
use super::{Hooks, Unit, UnitEnd};
use crate::defaults;
use crate::dsact::runner::Runner;
use crate::dssup::tick::Ctx;
use serde_json::{Value, json};

/// The inputs of a job.
pub use super::Scope;

/// One job: what it touches, the units to apply, and the calls that name its work.
pub struct Job {
    /// A name for the log.
    pub label: String,
    /// What the job touches.
    pub scope: Scope,
    /// The engine's units, in the order Node's calls perform them.
    pub units: Vec<Unit>,
    /// The Node calls (`{"fn": name, "args": {..}}`), in order.
    pub calls: Vec<Value>,
    /// For each call, the value the engine says the work returns (`None`: none).
    pub expect: Vec<Option<Value>>,
}

/// What the gate says about a job.
#[derive(Debug, Clone, PartialEq)]
pub enum Verdict {
    /// The native plan was applied: how each unit ended is in [`Outcome::ends`].
    Agreed,
}

/// The result of a gated job.
#[derive(Debug, Clone, PartialEq)]
pub struct Outcome {
    /// How each unit ended on the real home, in unit order.
    pub ends: Vec<UnitEnd>,
    /// What the gate said.
    pub verdict: Verdict,
}

fn record(ctx: &Ctx, job: &Job, ends: &[UnitEnd]) {
    let applied = ends.iter().filter(|e| **e == UnitEnd::Applied).count();
    let rec = json!({"ts": ctx.now, "job": job.label, "units": job.units.len(), "applied": applied, "native": true});
    crate::dsact::exec::append_line(&ctx.home.join(defaults::text("devswarm_recon.witness_file")), &rec);
}

/// Apply the job to the real home, unit by unit. A unit that cannot apply ends `Deferred` or `Failed` (nothing half written: the
/// applier re-checks its preconditions under the unit's lock) and the next pass finds it again.
pub fn run(ctx: &Ctx, _runner: &dyn Runner, job: &Job, hooks: &Hooks) -> Outcome {
    if job.calls.is_empty() {
        // a job that names no call has nothing to apply
        return Outcome { ends: job.units.iter().map(|_| UnitEnd::Applied).collect(), verdict: Verdict::Agreed };
    }
    let env = Env { home: ctx.home, now: ctx.now, st: ctx.st, log_dir: None };
    let ends: Vec<UnitEnd> = job.units.iter().map(|u| apply::unit(&env, u, hooks)).collect();
    record(ctx, job, &ends);
    Outcome { ends, verdict: Verdict::Agreed }
}
