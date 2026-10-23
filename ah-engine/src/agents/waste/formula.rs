//! The waste formula: pure functions over a small input struct, so the scoring is testable without an agent or a clock.
//!
//! `score = (ktokens / (outcome + eps)) * (1 + w_reread*reread) * (1 + w_repeat*repeat) * (1 + w_poll*poll) * (1 + w_wait*wait)
//! * (1 + w_fail*fail)`, divided by the relief of a read-heavy role. Every weight comes from `agent_waste.toml`.
use crate::defaults::{self, V};

/// What one agent did over the window.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Input {
    /// Tokens spent (cache reads discounted).
    pub tokens: u64,
    /// Weighted outcome units gained (commit, finished step, passing check, new file).
    pub outcome: u64,
    /// Tool calls in the window.
    pub calls: u64,
    /// Share (0 to 1) of reads that repeat a read already made in the window.
    pub reread: f64,
    /// Share of non-edit calls that repeat an identical earlier call.
    pub repeat: f64,
    /// Share of calls that poll (sleep, status checks, listing loops).
    pub poll: f64,
    /// Share of the window spent blocked on a lock or a background task.
    pub wait: f64,
    /// Failed commands in the window.
    pub failed: u64,
    /// Share of calls that only look (read, search, git log, status checks): investigation, not churn.
    pub readonly: f64,
}

/// The weights and thresholds, read from the plugin's TOML.
#[derive(Debug, Clone, PartialEq)]
pub struct Params {
    /// The epsilon of the formula, in outcome units.
    pub eps: f64,
    /// Weight of the re-read ratio.
    pub reread: f64,
    /// Weight of the repeat ratio.
    pub repeat: f64,
    /// Weight of the polling ratio.
    pub poll: f64,
    /// Weight of the wait share.
    pub wait: f64,
    /// Weight of the failing streak.
    pub fail: f64,
    /// Failed commands at which the failing factor is full.
    pub fail_cap: f64,
    /// Divisor for read-heavy roles.
    pub relief: f64,
    /// Fraction of the score taken off when every call only looks (scaled by the read-only share).
    pub readonly: f64,
    /// Tokens below which nothing is wasted.
    pub min_tokens: u64,
    /// Soft threshold.
    pub soft: f64,
    /// Hard threshold.
    pub hard: f64,
}

fn lim(k: &str) -> i64 {
    defaults::raw("agent_waste.limits").get(k).and_then(V::as_integer).unwrap_or(0)
}
fn mult(k: &str) -> f64 {
    defaults::raw("agent_waste.multipliers").get(k).and_then(V::as_integer).unwrap_or(0) as f64 / 100.0
}

impl Params {
    /// The shipped (or tuned) parameters.
    pub fn load() -> Params {
        let th = defaults::raw("agent_waste.thresholds");
        let t = |k: &str| th.get(k).and_then(V::as_integer).unwrap_or(0) as f64;
        let div = defaults::raw("agent_waste.relief").get("divisor_pct").and_then(V::as_integer).unwrap_or(0).max(1) as f64 / crate::agents::fmtn("pct") as f64;
        Params {
            eps: lim("eps_pct").max(1) as f64 / 100.0,
            reread: mult("reread"),
            repeat: mult("repeat"),
            poll: mult("poll"),
            wait: mult("wait"),
            fail: mult("fail"),
            fail_cap: lim("fail_cap").max(1) as f64,
            relief: div,
            readonly: lim("readonly_pct").clamp(0, 100) as f64 / 100.0,
            min_tokens: lim("min_tokens").max(0) as u64,
            soft: t("soft"),
            hard: t("hard"),
        }
    }
}

/// How bad a score is.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum Level {
    /// Under the soft threshold.
    Ok,
    /// Over the soft threshold.
    Soft,
    /// Over the hard threshold.
    Hard,
}

/// The waste score of `i`, in thousands of tokens per outcome unit. `read_heavy` lowers it for roles expected to read a lot.
pub fn score(i: &Input, p: &Params, read_heavy: bool) -> f64 {
    if i.tokens < p.min_tokens {
        return 0.0;
    }
    let base = (i.tokens as f64 / 1000.0) / (i.outcome as f64 + p.eps);
    let fail = (i.failed as f64 / p.fail_cap).min(1.0);
    let m = (1.0 + p.reread * i.reread.clamp(0.0, 1.0))
        * (1.0 + p.repeat * i.repeat.clamp(0.0, 1.0))
        * (1.0 + p.poll * i.poll.clamp(0.0, 1.0))
        * (1.0 + p.wait * i.wait.clamp(0.0, 1.0))
        * (1.0 + p.fail * fail);
    let s = base * m * (1.0 - p.readonly * i.readonly.clamp(0.0, 1.0));
    if read_heavy { s / p.relief } else { s }
}

/// The level of a score against the soft and hard thresholds.
pub fn level(score: f64, p: &Params) -> Level {
    if score >= p.hard {
        Level::Hard
    } else if score >= p.soft {
        Level::Soft
    } else {
        Level::Ok
    }
}

/// True when the agent's name marks a read-heavy role (reviewer, explorer, auditor ...).
pub fn read_heavy(name: &str) -> bool {
    let n = name.to_lowercase();
    defaults::raw("agent_waste.relief").get("names").map(V::strings).unwrap_or_default().iter().any(|w| n.contains(w))
}
