//! The waste sensor (GH #270): is an agent spending tokens without matching outcomes?
//!
//! It covers every agent kind the tracker follows (main session, subagent, teammate, DevSwarm Primary and workspace, Codex). Per
//! tick it reads the agent's rolling window from what the tracker already records (token samples, progress units, the recent tool
//! calls, pending calls, errors), scores it with [`formula`], and over the soft threshold asks the Jev judge (through the evidence
//! gate, integration `agentWaste`) for a verdict. A confirmed waste verdict, or the formula alone at the hard threshold when the
//! judge cannot answer, sets the agent's [`Mark`] action (`warn` or `hard`) and raises the tracker signal `agent_waste`, which the
//! existing reminder routes deliver. The tracker never stops an agent: `hard` is the mark the burn breaker reads to pause or block.
//! Every weight, threshold, pattern and text is in `engine/defaults/agent_waste.toml`.
pub mod formula;
#[cfg(test)]
mod tests;

use super::signals::{base, rec, state_of};
use super::{Agent, Env, fmtn, state_name};
use crate::defaults::{self, V};
use crate::telemetry::event::Outcome;
use formula::{Input, Level, Params};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::collections::BTreeSet;

/// The last evaluation of one agent, kept on it (also the judge's verdict cache).
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct Mark {
    /// The waste score (thousands of tokens per outcome unit).
    pub score: f64,
    /// 0 = ok, 1 = over the soft threshold, 2 = over the hard one.
    pub level: u8,
    /// The judge's verdict (empty when none is cached).
    pub verdict: String,
    /// The judge's confidence.
    pub confidence: f64,
    /// Who decided: `judge` or `formula`.
    pub source: String,
    /// The one-line reason (the signal values).
    pub reason: String,
    /// When the judge was last asked.
    pub judged_at: u64,
    /// Judge calls made about this agent.
    pub judge_calls: u64,
    /// `warn`, `hard`, or empty.
    pub action: String,
}

fn lim(k: &str) -> u64 {
    defaults::raw("agent_waste.limits").get(k).and_then(V::as_integer).unwrap_or(0).max(0) as u64
}
fn pat(k: &str) -> Vec<&'static str> {
    defaults::raw("agent_waste.patterns").get(k).map(V::strings).unwrap_or_default()
}
fn pol(k: &str) -> Vec<&'static str> {
    defaults::raw("agent_waste.policy").get(k).map(V::strings).unwrap_or_default()
}
fn word(k: &str) -> &'static str {
    defaults::raw("agent_waste.words").str_field(k)
}

/// The window of one agent as the formula's input, or `None` while there is too little history to judge.
pub fn input_of(a: &Agent, now: u64) -> Option<Input> {
    let from = now.saturating_sub(lim("window_ms"));
    let first = a.samples.iter().find(|s| s.t >= from)?;
    let last = a.samples.last()?;
    if last.t.saturating_sub(first.t) < lim("min_span_ms") {
        return None;
    }
    let pct = fmtn("pct");
    let tokens = (last.tin - first.tin) + (last.tout - first.tout) + (last.tcw - first.tcw) + (last.tcr - first.tcr) * lim("cache_read_pct") / pct;
    let calls: Vec<&(String, String, bool, u64)> = a.recent.iter().filter(|r| r.3 >= from).collect();
    let n = calls.len() as u64;
    let trusted = n >= lim("min_calls");
    let (reads, polls, repeats, non_edit) = (pat("reads"), pat("poll"), pat("wait"), calls.iter().filter(|c| !c.2).count());
    let starts = |label: &str, set: &[&str]| set.iter().any(|p| label.to_lowercase().starts_with(p));
    let mut seen: BTreeSet<&str> = BTreeSet::new();
    let (mut read_n, mut read_dup, mut dup, mut poll_n, mut wait_n) = (0u64, 0u64, 0u64, 0u64, 0u64);
    for (sig, label, edit, _) in &calls {
        let again = !seen.insert(sig.as_str());
        if starts(label, &reads) {
            read_n += 1;
            read_dup += u64::from(again);
        }
        if !edit {
            dup += u64::from(again);
        }
        poll_n += u64::from(starts(label, &polls));
        let low = label.to_lowercase();
        wait_n += u64::from(repeats.iter().any(|w| low.contains(w)) || pat("wait_tools").iter().any(|t| low.starts_with(t)));
    }
    let ratio = |x: u64, d: u64| if trusted && d > 0 { x as f64 / d as f64 } else { 0.0 };
    let window = lim("window_ms").max(1);
    let pending: u64 = a.pending.values().map(|p| now.saturating_sub(p.ts.max(from))).sum();
    let wait = (ratio(wait_n, n) + pending as f64 / window as f64).min(1.0);
    Some(Input {
        tokens,
        outcome: last.progress.saturating_sub(first.progress),
        calls: last.tools.saturating_sub(first.tools),
        reread: ratio(read_dup, read_n),
        repeat: ratio(dup, non_edit as u64),
        poll: ratio(poll_n, n),
        wait,
        failed: a.errs.iter().filter(|e| e.2 >= from).count() as u64,
    })
}

fn reason_of(i: &Input) -> String {
    let p = |x: f64| (x * 100.0).round() as u64;
    defaults::render(
        "agent_waste.reason_fmt",
        &[("tokens_k", &(i.tokens / 1000)), ("outcome", &i.outcome), ("reread", &p(i.reread)), ("repeat", &p(i.repeat)), ("poll", &p(i.poll)), ("wait", &p(i.wait)), ("fail", &i.failed)],
    )
}

/// What the judge is given, compactly: the goal, the last tool calls, the outcomes and the signal values.
fn evidence_of(a: &Agent, i: &Input, score: f64, now: u64) -> serde_json::Value {
    let cap = |s: &str, n: u64| super::cap(s, n);
    let goal = [a.name.as_str(), a.step.as_str()].iter().filter(|s| !s.is_empty()).map(|s| cap(s, lim("goal_cap"))).collect::<Vec<_>>();
    let calls: Vec<String> = a.recent.iter().rev().take(lim("call_cap") as usize).rev().map(|r| cap(&r.1, lim("line_cap"))).collect();
    let outcomes = vec![
        format!("window: {} outcome units", i.outcome),
        format!("lifetime: {} commits, {} passing checks, {} steps done, {} files edited", a.commits, a.tests_pass, a.steps_done, a.files.len()),
    ];
    let signals = vec![format!("kind {}; score {:.0}; {}", a.kind, score, reason_of(i))];
    let w = defaults::raw("agent_waste.judge_sections");
    json!({
        "id": "agentWaste",
        "child": a.id,
        "dur": super::sinks::age(lim("window_ms")),
        "facts": {"tool_calls": calls.len(), "tokens_k": i.tokens / 1000, "outcome": i.outcome, "has_goal": !goal.is_empty(), "idle_s": now.saturating_sub(a.last_output_ms) / fmtn("ms_per_s")},
        "sections": {w.str_field("goal"): goal, w.str_field("calls"): calls, w.str_field("outcomes"): outcomes, w.str_field("signals"): signals},
        "blocking": false,
    })
}

/// Ask the judge once; fills the mark's verdict when the answer is actionable. Returns whether a call was made.
fn judge(env: &Env, a: &mut Agent, i: &Input, score: f64) -> bool {
    let req = evidence_of(a, i, score, env.now_ms);
    let o = crate::jev::evidence::evaluate(&env.home, &crate::jev::Env::process(), &req);
    let verdict = o.label.clone().filter(|_| o.actionable).unwrap_or_default();
    a.waste.judged_at = env.now_ms;
    a.waste.judge_calls += 1;
    a.waste.verdict = verdict;
    a.waste.confidence = o.confidence.unwrap_or(0.0);
    a.waste.source = word("judge").into();
    rec(
        env,
        word("class"),
        word("judged"),
        if a.waste.verdict.is_empty() { Outcome::Skip } else { Outcome::Advise },
        base(a).tok("kind", &a.kind).tok("phase", &o.phase).tok("verdict", &a.waste.verdict).num("ms", o.ms).num("conf_pct", (a.waste.confidence * 100.0) as u64),
    );
    true
}

/// Evaluate one agent: refresh its mark, ask the judge when due, decide the action. `budget` is the judge calls left this tick.
pub(crate) fn update(env: &Env, a: &mut Agent, budget: &mut u64) {
    let idle = |a: &mut Agent| {
        a.waste.action.clear();
        a.waste.level = 0;
    };
    if !env.switch("agent_waste.setting") || state_of(a) != state_name("running") {
        return idle(a);
    }
    let Some(i) = input_of(a, env.now_ms) else { return idle(a) };
    let p = Params::load();
    let s = formula::score(&i, &p, formula::read_heavy(&a.name));
    let lvl = formula::level(s, &p);
    let before = a.waste.action.clone();
    a.waste.score = s;
    a.waste.level = lvl as u8;
    a.waste.reason = reason_of(&i);
    if lvl == Level::Ok {
        a.waste.verdict.clear();
        return idle(a);
    }
    let cooldown = lim("judge_cooldown_ms");
    if env.act && *budget > 0 && env.now_ms.saturating_sub(a.waste.judged_at) >= cooldown && judge(env, a, &i, s) {
        *budget -= 1;
    }
    let fresh = !a.waste.verdict.is_empty() && env.now_ms.saturating_sub(a.waste.judged_at) < cooldown * 2;
    let waste = if fresh {
        pol("waste_verdicts").contains(&a.waste.verdict.as_str())
    } else {
        a.waste.source = word("formula").into();
        a.waste.verdict.clear();
        lvl == Level::Hard
    };
    a.waste.action = match (waste, lvl == Level::Hard && pol("hard_kinds").contains(&a.kind.as_str())) {
        (false, _) => String::new(),
        (true, true) => word("hard").into(),
        (true, false) => word("warn").into(),
    };
    if a.waste.action != before && !a.waste.action.is_empty() {
        rec(env, word("class"), word("fire"), Outcome::Advise, base(a).tok("kind", &a.kind).tok("action", &a.waste.action).tok("source", &a.waste.source).num("score", s as u64));
    }
}

/// The tracker signal: raised while the mark carries an action. Evidence = the score, text = `source|verdict|reason`.
pub(crate) fn raised(a: &Agent) -> Option<super::signals::Raised> {
    let m = &a.waste;
    (!m.action.is_empty()).then(|| (m.score as u64, format!("{}|{}|{}", m.source, if m.verdict.is_empty() { word("no_goal") } else { &m.verdict }, m.reason)))
}

/// Whether the mark is at the hard action: the burn breaker blocks the agent exactly as for its own hard flag.
pub(crate) fn is_hard(a: &Agent) -> bool {
    !a.waste.action.is_empty() && a.waste.action == word("hard")
}

/// The advisory text for a raised signal.
pub(crate) fn text(who: &str, a: &Agent, evidence: u64, stored: &str) -> String {
    let mut parts = stored.splitn(3, '|');
    let (source, verdict, reason) = (parts.next().unwrap_or(""), parts.next().unwrap_or(""), parts.next().unwrap_or(""));
    defaults::render(
        "msg.agent_waste",
        &[("agent", &who), ("kind", &a.kind), ("score", &evidence), ("source", &source), ("verdict", &verdict), ("window", &super::sinks::age(lim("window_ms"))), ("reason", &reason)],
    )
}

/// The status cell of an agent: `score/verdict`, or the absent word.
pub(crate) fn cell(a: &Agent) -> String {
    if a.waste.score <= 0.0 {
        return super::fmtc("none").to_string();
    }
    let v = if a.waste.verdict.is_empty() { &a.waste.source } else { &a.waste.verdict };
    format!("{:.0}{}", a.waste.score, if v.is_empty() { String::new() } else { format!("/{v}") })
}

/// Judge calls one tick may make.
pub(crate) fn judge_budget() -> u64 {
    lim("max_judge_per_tick")
}
