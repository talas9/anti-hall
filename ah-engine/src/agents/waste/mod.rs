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
    /// Progress units at the last evaluation (to see when an outcome lands).
    #[serde(default)]
    pub seen_progress: u64,
    /// When the agent last gained an outcome unit (or started its turn); 0 = not running.
    #[serde(default)]
    pub outcome_at: u64,
    /// The in-flight call whose CPU is being watched.
    #[serde(default)]
    pub cpu_call: String,
    /// Accumulated CPU of its process tree at the last reading, ms.
    #[serde(default)]
    pub cpu_ms: u64,
    /// Instantaneous CPU of that reading, thousandths of a core.
    #[serde(default)]
    pub cpu_pm: u64,
    /// When that reading was taken.
    #[serde(default)]
    pub cpu_at: u64,
    /// The stall signals' reason (empty when neither fires); their level (0 ok, 1 soft, 2 hard) follows.
    #[serde(default)]
    pub stall: String,
    /// The commit HEAD pointed to at the last look (empty = not looked yet), and the own commits and pushes counted then.
    #[serde(default)]
    pub head: String,
    /// Own commits plus pushes at the last look (a change in HEAD with these unchanged was made by someone else).
    #[serde(default)]
    pub seen_commits: u64,
    /// When a commit made by someone else in the agent's worktree last counted as its outcome: the sensor window starts here.
    #[serde(default)]
    pub reset_at: u64,
    /// The level of the stall signals.
    #[serde(default)]
    pub stall_level: u8,
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
fn stall_lim(k: &str) -> u64 {
    defaults::raw("agent_stall.limits").get(k).and_then(V::as_integer).unwrap_or(0).max(0) as u64
}
fn stall_text(k: &str) -> &'static str {
    defaults::raw("agent_stall.texts").str_field(k)
}

/// The time-based signals of one running agent (task #185): `stalled_call` (one tool call in flight for long at near-zero CPU) and
/// `no_outcome_time` (no outcome unit for long, whatever the tokens). Fills `stall` and `stall_level`; the level joins the score's.
fn stall_check(env: &Env, a: &mut Agent) {
    let now = env.now_ms;
    if a.waste.outcome_at == 0 || a.progress > a.waste.seen_progress {
        a.waste.outcome_at = now;
    }
    a.waste.seen_progress = a.progress;
    let hard_x = (stall_lim("hard_factor_pct") as f64).max(100.0) as u64;
    let pct = fmtn("pct");
    let min_ms = fmtn("ms_per_s") * 60;
    let mut parts: Vec<String> = Vec::new();
    let mut level = 0u8;
    let mut rank = |ms: u64, limit: u64, parts: &mut Vec<String>, text: String| {
        if limit == 0 || ms < limit {
            return;
        }
        level = level.max(if ms >= limit * hard_x / pct { 2 } else { 1 });
        parts.push(text);
    };
    // stalled_call: the oldest foreground call that is not exempt
    let exempt = defaults::raw("agent_stall.policy").get("exempt_tools").map(V::strings).unwrap_or_default();
    let call = a
        .pending
        .iter()
        .filter(|(_, p)| !p.bg && !exempt.contains(&p.name.to_lowercase().as_str()))
        .min_by_key(|(_, p)| p.ts)
        .map(|(k, p)| (k.clone(), p.clone()));
    let limit = stall_lim("stalled_call_ms");
    let mut seen_call = String::new();
    if let Some((id, p)) = call.filter(|_| limit > 0) {
        let age = now.saturating_sub(p.ts);
        let mut busy = false;
        let mut cpu_word = stall_text("cpu_unknown");
        if age >= stall_lim("check_after_ms") && a.pid != 0 {
            let table = super::procs::snapshot();
            let kids: Vec<_> = super::procs::tree(&table, a.pid).into_iter().filter(|q| q.pid != a.pid).collect();
            if !kids.is_empty() {
                let cur = super::procs::cpu_of(&kids);
                if a.waste.cpu_call != id {
                    (a.waste.cpu_call, a.waste.cpu_ms, a.waste.cpu_pm, a.waste.cpu_at) = (id.clone(), cur.0, cur.1, now);
                } else if let Some(idle) =
                    super::procs::idle_since((a.waste.cpu_ms, a.waste.cpu_at), cur, now, stall_lim("min_cpu_span_ms"), stall_lim("idle_pm"))
                {
                    busy = !idle;
                    cpu_word = stall_text("cpu_idle");
                    if busy {
                        (a.waste.cpu_ms, a.waste.cpu_pm, a.waste.cpu_at) = (cur.0, cur.1, now);
                    }
                }
                seen_call = id.clone();
            }
        }
        if !busy {
            rank(
                age,
                limit,
                &mut parts,
                defaults::fill(stall_text("stalled_fmt"), &[("label", &super::cap(&p.label, lim("line_cap"))), ("min", &(age / min_ms)), ("cpu", &cpu_word)]),
            );
        }
    }
    if seen_call.is_empty() {
        a.waste.cpu_call.clear();
    }
    // no_outcome_time: a read-heavy role is allowed longer; the main session and Primary have their own (longer) limit
    let base = if pol("hard_kinds").contains(&a.kind.as_str()) { stall_lim("no_outcome_ms") } else { stall_lim("no_outcome_other_ms") };
    let limit = if formula::read_heavy(&a.name) {
        base * defaults::raw("agent_waste.relief").get("divisor_pct").and_then(V::as_integer).unwrap_or(pct as i64).max(0) as u64 / pct
    } else {
        base
    };
    let quiet = now.saturating_sub(a.waste.outcome_at);
    rank(quiet, limit, &mut parts, defaults::fill(stall_text("quiet_fmt"), &[("min", &(quiet / min_ms))]));
    a.waste.stall = parts.join("; ");
    a.waste.stall_level = level;
}

/// The window of one agent as the formula's input, or `None` while there is too little history to judge.
pub fn input_of(a: &Agent, now: u64) -> Option<Input> {
    let from = now.saturating_sub(lim("window_ms")).max(a.waste.reset_at);
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
    let looks = pat("readonly");
    let (reads, polls, repeats, non_edit) = (pat("reads"), pat("poll"), pat("wait"), calls.iter().filter(|c| !c.2).count());
    let starts = |label: &str, set: &[&str]| set.iter().any(|p| label.to_lowercase().starts_with(p));
    let mut seen: BTreeSet<&str> = BTreeSet::new();
    let (mut read_n, mut read_dup, mut dup, mut poll_n, mut wait_n, mut look_n) = (0u64, 0u64, 0u64, 0u64, 0u64, 0u64);
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
        look_n += u64::from(starts(label, &looks));
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
        readonly: ratio(look_n, n),
    })
}

fn reason_of(i: &Input) -> String {
    let p = |x: f64| (x * 100.0).round() as u64;
    defaults::render(
        "agent_waste.reason_fmt",
        &[
            ("tokens_k", &(i.tokens / 1000)),
            ("outcome", &i.outcome),
            ("reread", &p(i.reread)),
            ("repeat", &p(i.repeat)),
            ("poll", &p(i.poll)),
            ("wait", &p(i.wait)),
            ("fail", &i.failed),
        ],
    )
}

/// What the judge is given, compactly: the goal, the last tool calls, the outcomes and the signal values.
fn evidence_of(a: &Agent, i: &Input, score: f64, now: u64) -> serde_json::Value {
    let cap = |s: &str, n: u64| super::cap(s, n);
    let goal = [a.name.as_str(), a.step.as_str()].iter().filter(|s| !s.is_empty()).map(|s| cap(s, lim("goal_cap"))).collect::<Vec<_>>();
    let calls: Vec<String> = a.recent.iter().rev().take(lim("call_cap") as usize).rev().map(|r| cap(&r.1, lim("line_cap"))).collect();
    let outcomes = vec![
        defaults::render("agent_waste.outcome_window", &[("outcome", &i.outcome)]),
        defaults::render(
            "agent_waste.outcome_lifetime",
            &[("commits", &a.commits), ("checks", &a.tests_pass), ("steps", &a.steps_done), ("files", &a.files.len())],
        ),
    ];

    let mut signals = vec![format!("kind {}; score {:.0}; {}", a.kind, score, reason_of(i))];
    if !a.waste.stall.is_empty() {
        signals.push(defaults::fill(stall_text("signals_line"), &[("reason", &a.waste.stall)]));
    }
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
        base(a)
            .tok("kind", &a.kind)
            .tok("phase", &o.phase)
            .tok("verdict", &a.waste.verdict)
            .num("ms", o.ms)
            .num("conf_pct", (a.waste.confidence * 100.0) as u64),
    );
    true
}

/// The commit the worktree at (or above) `cwd` has checked out, read from the git files (no process): HEAD, then the ref it names in
/// the loose refs or packed-refs of the common directory. `None` when there is no repository or the HEAD cannot be read.
fn head_of(cwd: &str) -> Option<String> {
    let spec = defaults::raw("agent_waste.head");
    let mut dir = std::path::Path::new(cwd);
    let gitdir = loop {
        if let Some(g) = crate::dswire::facts::git_dir(&dir.to_string_lossy()) {
            break g;
        }
        dir = dir.parent()?;
    };
    let common = match std::fs::read_to_string(gitdir.join(spec.str_field("commondir"))).ok().map(|t| t.trim().to_string()).filter(|t| !t.is_empty()) {
        Some(rel) => gitdir.join(rel),
        None => gitdir.clone(),
    };
    let head = std::fs::read_to_string(gitdir.join(spec.str_field("head"))).ok()?;
    let head = head.trim();
    let Some(name) = head.strip_prefix(spec.str_field("ref_prefix")) else { return Some(head.to_string()) };
    let name = name.trim();
    if let Ok(t) = std::fs::read_to_string(common.join(name)) {
        return Some(t.trim().to_string());
    }
    let packed = std::fs::read_to_string(common.join(spec.str_field("packed"))).ok()?;
    packed.lines().find_map(|l| l.split_once(' ').filter(|(_, r)| *r == name).map(|(sha, _)| sha.to_string()))
}

/// A commit made by someone else in the agent's own worktree (the coordinator committing for a tripped agent) is the agent's outcome:
/// credit the commit weight, restart the sensor window, and the burn counter and breaker marker clear on this tick (the progress units
/// are in the next sample). Seen as a HEAD change while the agent's own commit and push counts did not move. Called before sampling.
pub(crate) fn note_head(env: &Env, a: &mut Agent) {
    if a.cwd.is_empty() || !env.switch("agent_waste.setting") {
        return;
    }
    let Some(h) = head_of(&a.cwd) else { return };
    let own = a.commits + a.pushes;
    let prev = std::mem::replace(&mut a.waste.head, h.clone());
    let own_before = std::mem::replace(&mut a.waste.seen_commits, own);
    if prev.is_empty() || prev == h || own != own_before {
        return;
    }
    a.progress += defaults::raw("agent_tracker.weights").get("commit").and_then(V::as_integer).unwrap_or(0).max(0) as u64;
    a.commits += 1;
    a.waste.seen_commits += 1;
    a.waste.reset_at = env.now_ms;
    rec(env, word("class"), word("head_outcome"), Outcome::Advise, base(a).tok("kind", &a.kind));
}

/// Evaluate one agent: refresh its mark, ask the judge when due, decide the action. `budget` is the judge calls left this tick.
pub(crate) fn update(env: &Env, a: &mut Agent, budget: &mut u64) {
    let idle = |a: &mut Agent| {
        a.waste.action.clear();
        a.waste.level = 0;
        a.waste.stall.clear();
        a.waste.stall_level = 0;
    };
    if !env.switch("agent_waste.setting") || state_of(a) != state_name("running") {
        a.waste.outcome_at = 0; // the next turn starts the no-outcome clock afresh
        return idle(a);
    }
    stall_check(env, a);
    let stall = match a.waste.stall_level {
        0 => Level::Ok,
        1 => Level::Soft,
        _ => Level::Hard,
    };
    let found = input_of(a, env.now_ms);
    if found.is_none() && stall == Level::Ok {
        return idle(a);
    }
    let measured = found.is_some();
    let i = found.unwrap_or_default();
    let p = Params::load();
    let s = formula::score(&i, &p, formula::read_heavy(&a.name));
    let lvl = formula::level(s, &p).max(stall);
    let before = a.waste.action.clone();
    a.waste.score = s;
    a.waste.level = lvl as u8;
    a.waste.reason = if a.waste.stall.is_empty() { reason_of(&i) } else { format!("{}; {}", reason_of(&i), a.waste.stall) };
    if lvl == Level::Ok {
        a.waste.verdict.clear();
        return idle(a);
    }
    let cooldown = lim("judge_cooldown_ms");
    if env.act && *budget > 0 && env.now_ms.saturating_sub(a.waste.judged_at) >= cooldown && judge(env, a, &i, s) {
        *budget -= 1;
    }
    let fresh = !a.waste.verdict.is_empty() && env.now_ms.saturating_sub(a.waste.judged_at) < cooldown * 2;
    // a time-based stall with (nearly) no tokens spent is a silent agent, which the hung signal covers: it is not waste, and never
    // hard without a spend to show for it
    let spent = measured && i.tokens >= lim("evidence_min_tokens");
    let waste = if fresh {
        spent && pol("waste_verdicts").contains(&a.waste.verdict.as_str())
    } else {
        a.waste.source = word("formula").into();
        a.waste.verdict.clear();
        lvl == Level::Hard && spent
    };
    a.waste.action = match (waste, spent && lvl == Level::Hard && pol("hard_kinds").contains(&a.kind.as_str())) {
        (false, _) => String::new(),
        (true, true) => word("hard").into(),
        (true, false) => word("warn").into(),
    };
    if a.waste.action != before && !a.waste.action.is_empty() {
        rec(
            env,
            word("class"),
            word("fire"),
            Outcome::Advise,
            base(a).tok("kind", &a.kind).tok("action", &a.waste.action).tok("source", &a.waste.source).num("score", s as u64),
        );
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

/// The tokens the sensor counted in the agent's current window (what the score is made of), for the breaker's message.
pub(crate) fn window_tokens(a: &Agent, now: u64) -> u64 {
    input_of(a, now).map_or(0, |i| i.tokens)
}

/// The hard score threshold, for the breaker's message.
pub(crate) fn hard_line() -> u64 {
    formula::Params::load().hard as u64
}

/// The advisory text for a raised signal.
pub(crate) fn text(who: &str, a: &Agent, evidence: u64, stored: &str) -> String {
    let mut parts = stored.splitn(3, '|');
    let (source, verdict, reason) = (parts.next().unwrap_or(""), parts.next().unwrap_or(""), parts.next().unwrap_or(""));
    defaults::render(
        "msg.agent_waste",
        &[
            ("agent", &who),
            ("kind", &a.kind),
            ("score", &evidence),
            ("source", &source),
            ("verdict", &verdict),
            ("window", &super::sinks::age(lim("window_ms"))),
            ("reason", &reason),
        ],
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
