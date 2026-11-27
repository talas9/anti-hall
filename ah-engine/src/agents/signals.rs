//! The signals, the flags that follow them, the reminders they cause and the outcomes that measure whether reminders work.
//!
//! A signal is a fact about an agent over a window (silent, repeating, spending without progress, off its step, a stale heartbeat, no
//! wake path armed). A flag is a signal that stays up across ticks. A reminder is queued once a flag has stayed up `confirm_ticks`
//! ticks, subject to a per-signal cooldown, a daily cap, a per-tick cap and the size of the agent's undelivered queue. When a flag
//! clears, its outcome is recorded: recovered after a reminder (with how long it took), or a false positive (it cleared on its own
//! while the agent made progress). A reminded flag still up after the outcome window is recorded as not recovered. Nothing here
//! stops an agent: escalation to the owner and the stop actions are in `escalate`.
use super::compliance::{self, Task};
use super::facts::words;
use super::sinks::{self, MeshOutbox, OwnerNotices, Reminder, SessionQueue, Sink, WakeFeed, age};
use super::{Agent, Env, Flag, Sample, State, cap, chan, defaults_signals, fmtn, kind_name, lim, pth, state_name};
use crate::defaults::{self, V};
use crate::telemetry::emit::{self, AgentRec};
use crate::telemetry::event::{Fields, Outcome};
use std::collections::{BTreeMap, BTreeSet};

/// A raised signal: the number it tripped on and the words it carries.
pub(crate) type Raised = (u64, String);

/// The state of an agent as the tracker reads it.
pub(crate) fn state_of(a: &Agent) -> &'static str {
    let host = |k: &str| {
        ["agent_tracker.claude_cli", "agent_tracker.registry"]
            .iter()
            .any(|t| defaults::raw(t).get(k).map(V::strings).unwrap_or_default().contains(&a.host.as_str()))
    };
    if a.kind == kind_name("heartbeat") {
        return if a.flags.contains_key("heartbeat_stale") { state_name("stale") } else { state_name("running") };
    }
    if a.dead {
        return state_name("dead");
    }
    if a.gone || a.finished {
        return state_name("done");
    }
    if !a.host.is_empty() {
        if host("waiting") || host("blocked") {
            return state_name("waiting");
        }
        // the host says busy while any shell of the session runs (a wake-watch Monitor runs for the whole session), so a session whose
        // transcript ended its turn with no tool call open is idle, whatever the host's word
        if host("busy") && (a.running || !a.pending.is_empty()) {
            return state_name("running");
        }
    }
    match (a.running, super::is_child(a)) {
        (true, _) => state_name("running"),
        (false, true) => state_name("done"),
        (false, false) => state_name("waiting"),
    }
}

pub(super) fn running(a: &Agent) -> bool {
    state_of(a) == state_name("running")
}

fn label(a: &Agent) -> String {
    let n = if a.name.is_empty() { &a.id } else { &a.name };
    n.chars().take(super::fmtn("name_max") as usize).collect()
}

// ---- sampling -----------------------------------------------------------------------------------------------

fn sample(a: &mut Agent, now: u64) {
    super::facts::episode_sync(a, now); // the burn episode starts at the last hard outcome (PR #472)
    if a.samples.last().is_none_or(|p| p.progress != a.progress) {
        (a.progress_at, a.progress_spent) = (now, total_spent(a)); // an outcome since the last sample (or the first sight): the runtime clock restarts
    }
    a.samples.push(Sample { t: now, tin: a.tin, tout: a.tout, tcr: a.tcr, tcw: a.tcw, tools: a.tools, progress: a.progress });
    let keep = now.saturating_sub(lim("waste_window_ms") * 2);
    a.samples.retain(|s| s.t >= keep);
    let max = lim("samples_max") as usize;
    if a.samples.len() > max {
        a.samples.drain(..a.samples.len() - max);
    }
}

// ---- the signals --------------------------------------------------------------------------------------------

fn hung(a: &Agent, now: u64) -> Option<Raised> {
    if !running(a) || a.last_output_ms == 0 {
        return None;
    }
    let limit = if a.pending.is_empty() { lim("hung_ms") } else { lim("hung_pending_ms") };
    let idle = now.saturating_sub(a.last_output_ms);
    if idle <= limit {
        return None;
    }
    let tool = a
        .pending
        .values()
        .min_by_key(|p| p.ts)
        .map(|p| format!("{} {}", p.name, p.label))
        .or_else(|| a.recent.last().map(|r| r.1.clone()))
        .unwrap_or_else(|| defaults::render("msg.agent_no_tool", &[]));
    Some((idle / fmtn("ms_per_s"), tool))
}

fn looping(a: &Agent) -> Option<Raised> {
    if !running(a) {
        return None;
    }
    // only calls close together in time repeat in a loop; the same poll every few minutes is not one
    let newest = a.recent.iter().map(|r| r.3).max().unwrap_or(0).max(a.errs.iter().map(|e| e.2).max().unwrap_or(0));
    let from = newest.saturating_sub(lim("loop_span_ms"));
    let mut counts: BTreeMap<&str, (u64, &str, bool)> = BTreeMap::new();
    for (sig, lab, edit, _) in a.recent.iter().filter(|r| r.3 >= from) {
        let e = counts.entry(sig.as_str()).or_insert((0, lab.as_str(), *edit));
        e.0 += 1;
    }
    for (n, lab, edit) in counts.values() {
        if *n >= if *edit { lim("loop_edit_repeats") } else { lim("loop_repeats") } {
            return Some((*n, lab.to_string()));
        }
    }
    let mut errs: BTreeMap<u64, (u64, &str)> = BTreeMap::new();
    for (h, lab, _) in a.errs.iter().filter(|e| e.2 >= from) {
        errs.entry(*h).or_insert((0, lab.as_str())).0 += 1;
    }
    errs.values().find(|(n, _)| *n >= lim("error_repeats")).map(|(n, lab)| (*n, lab.to_string()))
}

/// Whether the owner has talked to this session lately (a main or workspace session whose owner's last message is within
/// `limits.owner_active_ms`): such a session is not wasting tokens, the owner is steering it (agents.nudgeOwnerActive).
pub(crate) fn owner_active(env: &Env, a: &Agent, now: u64) -> bool {
    a.owner_ms > 0 && now.saturating_sub(a.owner_ms) < lim("owner_active_ms") && !super::is_child(a) && env.switch("agent_tracker.owner_active_setting")
}

fn token_waste(env: &Env, a: &Agent, now: u64) -> Option<Raised> {
    if !running(a) || owner_active(env, a, now) {
        return None;
    }
    let from = now.saturating_sub(lim("waste_window_ms"));
    let base = a.samples.iter().find(|s| s.t >= from)?;
    let cur = a.samples.last()?;
    if cur.t.saturating_sub(base.t) < lim("waste_min_span_ms") {
        return None;
    }
    let tokens = spent(base, cur);
    (tokens >= lim("waste_min_tokens") && cur.progress - base.progress <= lim("waste_max_progress")).then(|| (tokens, String::new()))
}

/// The tokens spent between two samples (cache reads count `cache_read_pct` percent).
fn spent(base: &Sample, cur: &Sample) -> u64 {
    (cur.tin - base.tin) + (cur.tout - base.tout) + (cur.tcw - base.tcw) + (cur.tcr - base.tcr) * lim("cache_read_pct") / fmtn("pct")
}

/// Everything the agent has spent, counted the way the burn and waste figures count (cache reads at their configured share), so the
/// total a nudge shows never reads smaller than the part of it spent with no outcome.
pub(crate) fn total_spent(a: &Agent) -> u64 {
    a.tin + a.tout + a.tcw + a.tcr * lim("cache_read_pct") / fmtn("pct")
}

/// Whether the agent's latest calls wait on CI (a `ci_wait` command among the last `ci_wait_calls`).
pub(crate) fn waiting_on_ci(a: &Agent) -> bool {
    let Some(re) = defaults::raw("agent_tracker.patterns")
        .get("ci_wait")
        .and_then(V::as_str)
        .and_then(|s| regex::RegexBuilder::new(s).case_insensitive(true).build().ok())
    else {
        return false;
    };
    a.recent.iter().rev().take(lim("ci_wait_calls") as usize).any(|r| re.is_match(&r.1))
}

/// Whether `ts` is an age of at most `span` ms at `now`. A stamp later than `now` has no age: it is NOT within any span (a skewed or
/// rewound clock must never make evidence look current for ever).
pub(crate) fn age_within(now: u64, ts: u64, span: u64) -> bool {
    now.checked_sub(ts).is_some_and(|d| d <= span)
}

/// Whether any stamp the stall exemptions read stands later than `now`: a CI call, a background CI or build task, a call in flight, the
/// CPU move or the quiet-window and repeat-line starts. They are ignored (never exempt, restart their window), and a tick that met one is
/// counted `future_ts_ignored`.
fn future_stamp(a: &Agent, now: u64) -> bool {
    let mut tasks = a.bg_ci.iter().chain(a.bg_builds.iter()).filter_map(|id| a.bg_ids.get(id));
    a.recent.iter().any(|r| r.3 > now)
        || tasks.any(|t| *t > now)
        || a.pending.values().any(|p| p.ts > now)
        || a.stall_cpu_at > now
        || a.stall_since > now
        || a.said_since > now
}

/// Whether the agent waits on CI NOW (the stall exemption, #518 review round): a background command that checks or watches CI and has
/// no end notice yet (`bg_ci`), started within `ci_wait_max_ms`; or a CI command issued within `ci_wait_fresh_ms`, where CI calls no
/// further apart than that make one wait and the wait began within `ci_wait_max_ms`. A CI command in the call history is no wait. The
/// ring of recent calls is bounded: when it holds the whole window before the wait's first call it proves the start, and when it is
/// full and does not, the start was cut off, so the wait counts as past the longest (it errs toward flagging). A window or a longest
/// wait of 0 turns the exemption off.
pub(crate) fn ci_wait_current(a: &Agent, now: u64) -> bool {
    let c = defaults::raw("nudges.stall_limits");
    let (fresh, max) = (num(c, "ci_wait_fresh_ms"), num(c, "ci_wait_max_ms"));
    if fresh == 0 || max == 0 {
        return false;
    }
    if a.bg_ci.iter().any(|id| a.bg_ids.get(id).is_some_and(|t| age_within(now, *t, max))) {
        return true;
    }
    let Some(re) = defaults::raw("agent_tracker.patterns")
        .get("ci_wait")
        .and_then(V::as_str)
        .and_then(|s| regex::RegexBuilder::new(s).case_insensitive(true).build().ok())
    else {
        return false;
    };
    // a stamp later than `now` (clock skew, a rewound clock) has no age: it is no evidence of a wait that is current
    let mut hits: Vec<u64> = a.recent.iter().filter(|r| r.3 <= now && re.is_match(&r.1)).map(|r| r.3).collect();
    hits.sort_unstable_by(|x, y| y.cmp(x));
    let Some(newest) = hits.first().copied() else { return false };
    if now.saturating_sub(newest) > fresh {
        return false;
    }
    let mut start = newest;
    for t in hits.iter().skip(1) {
        if start.saturating_sub(*t) > fresh {
            break;
        }
        start = *t;
    }
    let oldest = a.recent.iter().map(|r| r.3).filter(|t| *t <= now).min().unwrap_or(start);
    let cut = a.recent.len() as u64 >= lim("loop_window") && oldest >= start.saturating_sub(fresh);
    !cut && now.saturating_sub(start) <= max
}

/// Tokens spent since the agent's last outcome (a commit, finished step, passing test or new file), looking back at most one
/// waste window. An outcome moves the start forward, so the count (and the breaker) resets when the agent produces one.
pub(crate) fn tokens_since_outcome(a: &Agent, now: u64) -> u64 {
    let from = now.saturating_sub(lim("waste_window_ms"));
    let Some(cur) = a.samples.last() else { return 0 };
    let start = a.samples.iter().rev().take_while(|s| s.t >= from && s.progress == cur.progress).last();
    start.map_or(0, |b| spent(b, cur))
}

/// The burn breaker: tokens spent since the last outcome reached the soft band (`burn_soft`: warn) or the hard line (`burn_hard`:
/// the agent's tool calls are blocked by the `burn-breaker` check except commit, push, status and its report).
fn burn(env: &Env, a: &Agent, now: u64, soft: bool) -> Option<Raised> {
    if !running(a) || a.kind == kind_name("heartbeat") || !env.switch("burn.sw") {
        return None;
    }
    let (lo, hi) = (defaults::num("burn.soft_tokens_no_outcome"), defaults::num("burn.hard_tokens_no_outcome"));
    let t = tokens_since_outcome(a, now);
    let hit = if soft { lo > 0 && t >= lo && (hi == 0 || t < hi) } else { hi > 0 && t >= hi };
    hit.then(|| (t, String::new()))
}

/// Mirror the hard flag into the small marker file the `burn-breaker` check reads on every tool call (one file per agent key, so
/// the hot path never parses the tracker state). Removed when the flag is down; a stale one expires by `burn.marker_ttl_ms`.
fn mark_breaker(env: &Env, a: &Agent, burn: Option<&Raised>) {
    if !env.act {
        return;
    }
    let dir = env.dir().join(defaults::text("burn.marker_dir"));
    let file = dir.join(format!("{}{}", sinks::key_of(&a.id), defaults::text("burn.marker_ext")));
    // the hard condition that holds now: the token line first, else the waste sensor's hard mark (its score is NOT a token count)
    let body = match (burn, super::waste::is_hard(a)) {
        (Some((tokens, _)), _) => {
            Some(serde_json::json!({ "ts": env.now_ms, "agent": a.id, "source": "burn", "tokens": tokens, "tokens_text": sinks::count(*tokens) }))
        }
        (None, true) => {
            let tokens = super::waste::window_tokens(a, env.now_ms);
            Some(serde_json::json!({
                "ts": env.now_ms, "agent": a.id, "source": "waste", "tokens": tokens, "tokens_text": sinks::count(tokens),
                "score": a.waste.score as u64, "hard": super::waste::hard_line(), "reason": a.waste.reason,
            }))
        }
        (None, false) => None,
    };
    // GH #458: a build still in flight, or a recent soft outcome within the cap, holds off the pause; the hard flag and its nudge stay.
    // Counted per held tick by reason.
    let doubt = defaults::raw("burn.doubt");
    let body = match (body, hold_reason(a, env.now_ms)) {
        (Some(_), Some(reason)) => {
            crate::metrics::bump(doubt.str_field("metric"), &[(doubt.str_field("label"), reason)]);
            None
        }
        (b, _) => b,
    };
    match body {
        Some(body) => {
            if std::fs::create_dir_all(&dir).is_ok() {
                crate::discard::harmless(crate::atomic::write(&file, body.to_string())); // keep: the marker is a cache of the flag; the next tick rewrites it
            }
        }
        None => {
            if file.exists() {
                crate::discard::harmless(std::fs::remove_file(&file)); // keep: an absent marker is the goal state
            }
        }
    }
}

/// Whether a call of a doubt class (burn.doubt.classes: a build) is still in flight: the agent waits on work, not burning tokens.
/// Why the pause is held off now, if it is: `building` (burn.doubt: a build still in flight) or `soft` (a soft outcome within
/// burn.soft_hold.hold_ms). Either holds only inside a live burn episode (PR #472): the episode starts at the last hard outcome and is
/// spent once it has had more than cap events (soft outcomes and build launches) or lasted episode_ms; then the pause fires whatever
/// follows, until a hard outcome starts a new episode, so a polling loop or an endless chain of builds of any pace is paused.
pub(crate) fn hold_reason(a: &Agent, now: u64) -> Option<&'static str> {
    let doubt = defaults::raw("burn.doubt");
    let sh = defaults::raw("burn.soft_hold");
    let n = |k: &str| sh.get(k).and_then(V::as_integer).unwrap_or(0).max(0) as u64;
    let (base, start, count) = a.soft_episode;
    let live = base == a.progress && start > 0 && now.saturating_sub(start) <= n("episode_ms") && count <= n("cap");
    if !live {
        return None;
    }
    if building(a, now) {
        return Some(doubt.str_field("building"));
    }
    let last = a.soft_ts.iter().max().copied().unwrap_or(0);
    (last >= now.saturating_sub(n("hold_ms"))).then(|| doubt.str_field("soft"))
}

/// A background build counts while its task has no end notice; both bounded by burn.doubt.max_ms.
pub(crate) fn building(a: &Agent, now: u64) -> bool {
    let doubt = defaults::raw("burn.doubt");
    let classes = doubt.get("classes").map(V::strings).unwrap_or_default();
    let from = now.saturating_sub(doubt.get("max_ms").and_then(V::as_integer).unwrap_or(0).max(0) as u64);
    a.pending.values().any(|p| p.ts >= from && classes.iter().any(|c| *c == p.class))
        || a.bg_builds.iter().any(|id| a.bg_ids.get(id).is_some_and(|t| *t >= from))
}

/// [`building`] for the stall exemption: the same background build or call in flight, but a stamp later than `now` is no build in flight.
fn building_now(a: &Agent, now: u64) -> bool {
    let doubt = defaults::raw("burn.doubt");
    let classes = doubt.get("classes").map(V::strings).unwrap_or_default();
    let max = doubt.get("max_ms").and_then(V::as_integer).unwrap_or(0).max(0) as u64;
    a.pending.values().any(|p| age_within(now, p.ts, max) && classes.iter().any(|c| *c == p.class))
        || a.bg_builds.iter().any(|id| a.bg_ids.get(id).is_some_and(|t| age_within(now, *t, max)))
}

/// Remove markers older than `burn.marker_ttl_ms` (an agent that left the state without clearing its flag).
fn sweep_markers(env: &Env) {
    let dir = env.dir().join(defaults::text("burn.marker_dir"));
    let ttl = std::time::Duration::from_millis(defaults::num("burn.marker_ttl_ms"));
    let Ok(rd) = std::fs::read_dir(&dir) else { return };
    for e in rd.flatten() {
        let old = e.metadata().and_then(|m| m.modified()).ok().and_then(|t| t.elapsed().ok()).is_some_and(|age| age > ttl);
        if old {
            crate::discard::harmless(std::fs::remove_file(e.path())); // keep: cleanup that raced; an absent file is the goal state
        }
    }
}

fn drift(a: &Agent, st: &State, tasks: &[Task]) -> Option<Raised> {
    if a.step.is_empty() || a.step_events < lim("drift_min_events") {
        return None;
    }
    // the step is a task of the list: its CURRENT subject is the step (a task renamed since is judged by its new words), and a task
    // another tracked agent owns is that agent's work, not this session's declared step (#972 class 27: the coordinator was told it
    // drifted from a lane's task, quoting the subject from before a rename)
    let task = (!a.step_task.is_empty()).then(|| tasks.iter().find(|t| t.id == a.step_task)).flatten();
    if let Some(t) = task
        && !t.owner.is_empty()
        && st.agents.values().any(|o| o.id != a.id && (o.name == t.owner || o.id == t.owner))
    {
        crate::metrics::bump("agent_signal_exempt", &[("signal", "drift"), ("reason", "step_owned_elsewhere")]);
        return None;
    }
    let step_text = task.map(|t| super::cap(&t.subject, lim("text_cap"))).filter(|s| !s.is_empty()).unwrap_or_else(|| a.step.clone());
    let step: BTreeSet<String> = words(&step_text).into_iter().collect();
    if (step.len() as u64) < lim("drift_min_step_words") {
        return None;
    }
    // the work is compared with the declared step AND the agent's own task description (a stale step text, or one worded differently
    // from the files and commands it works on, is not drift while the work belongs to the task it was given)
    let goal: BTreeSet<String> = step.iter().cloned().chain(words(&a.name)).collect();
    let work: BTreeSet<&String> = a.work.iter().collect();
    let hit = goal.iter().filter(|w| work.contains(w)).count() as u64;
    let pct = hit * fmtn("pct") / goal.len() as u64;
    (pct <= lim("drift_max_overlap_pct") && hit < lim("drift_min_hits")).then(|| (pct, step_text))
}

fn heartbeat_stale(a: &Agent, now: u64) -> Option<Raised> {
    if a.kind != kind_name("heartbeat") {
        return None;
    }
    let old = now.saturating_sub(a.hb_ts);
    (old >= lim("heartbeat_stale_ms")).then(|| (old / fmtn("ms_per_s"), a.hb_step.clone()))
}

/// A subagent or workspace that finished its turn with a task still open and has said nothing for `idle_open_ms`: nobody is told, so it
/// sits. Raised once per idle spell; it clears the moment the agent works again.
fn idle_open_task(a: &Agent, st: &State, tasks: &[Task], now: u64) -> Option<Raised> {
    if (!super::is_child(a) && a.kind != kind_name("workspace")) || a.gone || !a.open || a.running || a.last_output_ms == 0 {
        return None;
    }
    // a Primary is the owner's own session: nobody re-tasks or stops it, so "re-task it or stop it" has no reader (#972 class 27, the
    // stall rule of GH #962 item 5)
    if a.ws.as_ref().is_some_and(|w| w.primary) {
        crate::metrics::bump("agent_signal_exempt", &[("signal", "idle_open_task"), ("reason", "primary")]);
        return None;
    }
    let idle = now.saturating_sub(a.last_output_ms);
    // a task inside a live bounded hold is waiting on something stated, not idle (GH #959); the task list is read only this late
    (idle >= lim("idle_open_ms") && idle <= lim("active_window_ms") && !compliance::idle_work_held(a, st, tasks, now))
        .then(|| (idle / fmtn("ms_per_s"), a.step.clone()))
}

/// Only a complete transcript can establish no work. Partial scans and rescue wrappers never raise this signal.
/// A subagent that is known to have finished (it said so, or its task ended) and spoke at all, without making a single tool call: it did nothing, whatever its last message says ("Done"). Raised once,
/// so the parent is told not to take the report for a result. `agent_tracker.no_work.max_tools` is the most tool calls that still count.
fn no_work(a: &Agent) -> Option<Raised> {
    if !super::is_child(a)
        || !(a.finished || a.gone)
        || a.dead
        || a.tout == 0
        || !a.transcript_complete
        || a.partial
        || a.codex_rescue
        || a.tools > defaults::raw("agent_tracker.no_work").get("max_tools").and_then(V::as_integer).unwrap_or(0).max(0) as u64
    {
        return None;
    }
    Some((a.tools, String::new()))
}

/// The no-work evidence state, including unknown for any incomplete scan.
pub(crate) fn no_work_state(a: &Agent) -> &'static str {
    let key = if a.codex_rescue {
        "excluded"
    } else if a.partial || !a.transcript_complete {
        "unknown"
    } else if no_work(a).is_some() {
        "no_work"
    } else {
        "clear"
    };
    defaults::raw("agent_tracker.no_work_states").str_field(key)
}

/// A background shell task the agent started has ended (a test run, a soak, a build): the session that waits for it is told once.
fn watched_exit(a: &Agent, now: u64) -> Option<Raised> {
    let fresh: Vec<&(String, u64)> = a.exited.iter().filter(|(_, t)| now.saturating_sub(*t) <= lim("exit_keep_ms")).collect();
    let last = fresh.last()?;
    Some((fresh.len() as u64, last.0.clone()))
}

/// Whether the wake watcher applies to this agent at all: a live main or workspace session. Codex has no Monitor tool (its kind is
/// `codex`, so it is never asked to arm one: it keeps its cron and hooks).
fn watcher_session(a: &Agent) -> bool {
    (a.kind == kind_name("main") || a.kind == kind_name("workspace")) && !a.gone
}

/// The wake watcher is switched off (agents.wakeWatch=false): said once per session, never silently (signal `monitor_off`).
fn monitor_off(env: &Env, a: &Agent) -> Option<Raised> {
    (watcher_session(a) && !wake_switch(env, a)).then(|| (0, String::new()))
}

/// The wake-watch switch that governs this session: a DevSwarm workspace follows devswarm.wakeWatch, a main session agents.wakeWatch.
fn wake_switch(env: &Env, a: &Agent) -> bool {
    env.switch(wake_switch_key(a))
}

/// The defaults key of the switch entry that governs this session's wake-watch.
fn wake_switch_key(a: &Agent) -> &'static str {
    if a.kind == kind_name("workspace") { "agent_tracker.wake_setting_devswarm" } else { "agent_tracker.wake_setting" }
}

/// A live session whose wake watcher is down. The harness starts the watcher once and a Monitor lives at most 30 minutes, so a dead one
/// stays dead; this is what tells the session to re-arm it. Silent while the watcher's stamp is fresh (or a Monitor the session armed
/// itself is still within its timeout), while the switch is off (`monitor_off` speaks then), and during the start-up grace.
fn monitor_unarmed(env: &Env, a: &Agent, st: &State, now: u64) -> Option<Raised> {
    if !watcher_session(a) || !wake_switch(env, a) {
        return None;
    }
    if a.first_seen > 0 && now.saturating_sub(a.first_seen) < lim("monitor_grace_ms") {
        return None;
    }
    if let Some(Some(armed)) = a.ws.as_ref().map(|w| w.armed) {
        return (!armed && !a.gone).then(|| (0, a.ws.as_ref().map(|w| w.id.clone()).unwrap_or_default()));
    }
    if (a.kind == kind_name("main") || a.ws.is_some()) && sinks::wake_armed(env, &a.id) {
        return None;
    }
    // live children: running ones, and idle ones still holding an open task (the row that wakes this session); a finished, dead or gone
    // child is nothing to watch
    let subs =
        st.agents.values().filter(|s| super::is_child(s) && s.parent == a.id && (running(s) || (s.open && !s.gone && !s.dead && !s.finished))).count() as u64;
    let shells = a.bg_bash.iter().filter(|t| now.saturating_sub(**t) <= lim("bg_bash_ms")).count() as u64;
    let bg = subs + shells;
    if bg < lim("monitor_min_bg") && now > a.armed_until {
        // #614: nothing to watch (no live subagent, no running background shell), so nothing is lost without a watcher and the line
        // would only ask for an action the session has no use for
        if env.act {
            crate::metrics::bump("monitor_nag_suppressed", &[("reason", "no_live_child")]);
        }
        return None;
    }
    (now > a.armed_until).then(|| {
        let armed = if a.armed_at == 0 {
            defaults::render("msg.agent_armed_never", &[])
        } else {
            defaults::render("msg.agent_armed_lapsed", &[("ago", &age(now - a.armed_at))])
        };
        (bg, armed)
    })
}

/// `watcher_missing` (owner rule: every main and workspace session keeps a wake Monitor armed, no exemption): the session has had no
/// live wake-watch for `nudges.watcher.missing_ms`. Unlike `monitor_unarmed` it ignores whether anything is running. The clock starts
/// at the latest of the first sighting, the expiry of the armed stamp and the end of a Monitor the session armed itself, so every
/// exemption is bounded. Evidence: seconds without a watcher.
fn watcher_missing(env: &Env, a: &Agent, now: u64) -> Option<Raised> {
    if !watcher_session(a) || !wake_switch(env, a) || a.first_seen == 0 || a.ws.as_ref().is_some_and(|w| w.armed == Some(true)) {
        return None;
    }
    let stamp_end = crate::checks::agent_scan::mtime_ms(&sinks::WakeFeed::stamp(env, &a.id)).map_or(0, |m| m as u64 + lim("stale_lock_ms"));
    let since = a.first_seen.max(stamp_end).max(a.armed_until);
    let gone = now.saturating_sub(since);
    (gone >= defaults::raw("nudges.watcher").get("missing_ms").and_then(V::as_integer).unwrap_or(0).max(0) as u64).then_some((gone / fmtn("ms_per_s"), String::new()))
}

/// The reminder text of `watcher_missing`: advice first, the order once `order_after` reminders went out unanswered.
fn watcher_text(a: &Agent, evidence: u64) -> String {
    let w = defaults::raw("nudges.watcher");
    let sent = a.sent_log.iter().filter(|(s, _)| s == "watcher_missing").count() as u64;
    let key = if sent >= w.get("order_after").and_then(V::as_integer).unwrap_or(0).max(0) as u64 { "msg.agent_watcher_missing_order" } else { "msg.agent_watcher_missing" };
    let command = if a.ws.is_some() { defaults::text("agent_tracker.wake_command") } else { defaults::text("agent_tracker.wake_command_agents") };
    defaults::render(key, &[("command", &command), ("timeout", &defaults::num("agent_tracker.wake_timeout_ms")), ("missing", &age(evidence * fmtn("ms_per_s"))), ("sent", &sent)])
}

// ---- nudge signals (GH #515, #517, #518): every threshold, list and text is in nudges.toml / agent_tracker.toml ----------------

fn num(t: &V, k: &str) -> u64 {
    t.get(k).and_then(V::as_integer).unwrap_or(0).max(0) as u64
}

fn metric(step: &str) {
    let m = defaults::raw("nudges.metric");
    crate::metrics::bump(m.str_field("name"), &[(m.str_field("label"), m.str_field(step))]);
}

/// Whether the CPU of a process tree moved by at least `step` ms since its baseline (`None`: nothing to compare yet, so no). A
/// step of 0 turns the term off.
pub(crate) fn cpu_moved(base: Option<u64>, cur: u64, step: u64) -> bool {
    step > 0 && base.is_some_and(|b| b.abs_diff(cur) >= step)
}

fn exempt(reason: &str) {
    let m = defaults::raw("nudges.stall_exempt");
    crate::metrics::bump(m.str_field("name"), &[(m.str_field("label"), m.str_field(reason))]);
}

/// The CPU term of the stall sample (#535): an agent whose process tree below `root` used CPU is working, whatever its transcript
/// shows. Read only once the agent was quiet for `cpu_probe_pct` percent of `quiet_ms` (a healthy tick never spawns `ps`), and the
/// table is read at most once per tick (`table`). A rise of `cpu_step_ms` restarts the quiet window.
///
/// `shared`: the tree is a parent's, read for an agent with no pid of its own, and another running agent below the same parent reads it
/// too. Its CPU cannot be told apart, and one agent's work must not restart the quiet window of two, so nobody is credited with it: the
/// table is not read, the baseline is dropped (a later lone reading seeds a fresh one) and the tick is counted `cpu_shared`.
pub(crate) fn cpu_probe(env: &Env, a: &mut Agent, root: u32, shared: bool, table: &mut Option<Vec<super::procs::Proc>>, now: u64) {
    if root == 0 || !(super::is_child(a) || a.kind == kind_name("workspace")) {
        return;
    }
    let c = defaults::raw("nudges.stall_limits");
    let (quiet, step) = (num(c, "quiet_ms"), num(c, "cpu_step_ms"));
    let after = quiet.saturating_mul(num(c, "cpu_probe_pct")) / fmtn("pct").max(1);
    if quiet == 0 || step == 0 || now.saturating_sub(a.stall_since) < after {
        return;
    }
    if shared {
        a.stall_cpu = None;
        if env.act {
            metric("cpu_shared");
        }
        return;
    }
    let t = table.get_or_insert_with(super::procs::snapshot);
    if t.is_empty() {
        if env.act {
            exempt("cpu_unread"); // `ps` gave nothing: the term is silent, the quiet window stands
        }
        return;
    }
    let kids: Vec<_> = super::procs::tree(t, root).into_iter().filter(|q| q.pid != root).collect();
    let cur = super::procs::cpu_of(&kids).0;
    if cpu_moved(a.stall_cpu, cur, step) {
        (a.stall_cpu, a.stall_cpu_at, a.stall_since) = (Some(cur), now, now);
        if env.act {
            exempt("cpu");
        }
    } else if a.stall_cpu.is_none() {
        a.stall_cpu = Some(cur);
    }
}

/// Per agent, the pid whose process tree is its CPU (its own session, else its parent's; 0: unknown) and whether that tree is shared:
/// the agent has no pid of its own and another running child or workspace stands below the same parent, so the parent's tree holds the
/// work of more than one of them (an agent with a pid of its own sits inside it too). Computed once per tick, before any agent is
/// evaluated, so the answer does not depend on the order the agents are taken in.
pub(crate) fn probe_roots(st: &State) -> BTreeMap<String, (u32, bool)> {
    let parent_pid = |a: &Agent| st.agents.get(&a.parent).map_or(0, |p| p.pid);
    let live = |a: &Agent| (super::is_child(a) || a.kind == kind_name("workspace")) && running(a);
    let mut below: BTreeMap<u32, u64> = BTreeMap::new();
    for a in st.agents.values().filter(|a| live(a)) {
        *below.entry(parent_pid(a)).or_default() += 1;
    }
    st.agents
        .iter()
        .map(|(id, a)| {
            let root = if a.pid != 0 { (a.pid, false) } else { (parent_pid(a), parent_pid(a) != 0 && below.get(&parent_pid(a)).copied().unwrap_or(0) > 1) };
            (id.clone(), root)
        })
        .collect()
}

/// The stall sample: the observable fingerprint and since when it holds (only while the agent runs). `root` is [`probe_roots`]'s answer.
fn stall_sample(env: &Env, a: &mut Agent, root: (u32, bool), table: &mut Option<Vec<super::procs::Proc>>, now: u64) {
    if !env.switch("agent_tracker.stall_sw") || !running(a) {
        (a.stall_since, a.stall_cpu, a.stall_cpu_at) = (0, None, 0);
        return;
    }
    if future_stamp(a, now) {
        // a stamp from the future (clock skew, a rewound clock) has no age: the windows it starts restart now, the CPU credit is
        // dropped, and the exemptions ignore the rest (`ci_wait_current`, `building_now`)
        if env.act {
            exempt("future_ts_ignored");
        }
        a.stall_since = a.stall_since.min(now);
        a.said_since = a.said_since.min(now);
        if a.stall_cpu_at > now {
            (a.stall_cpu, a.stall_cpu_at) = (None, 0);
        }
    }
    let obs = vec![a.offset, a.tools, a.commits, a.changes, a.progress, a.edits, a.said_since];
    if a.stall_obs != obs || a.stall_since == 0 {
        a.stall_obs = obs;
        a.stall_since = now;
        (a.stall_cpu, a.stall_cpu_at) = (None, 0); // progress: the CPU used while it worked is no part of the next quiet stretch
    }
    cpu_probe(env, a, root.0, root.1, table, now);
    if env.act {
        metric("sampled");
    }
}

/// A running child agent with no call in flight and not hung, whose observable state did not change for `quiet_ms`, or whose
/// progress line repeated with no outcome for `repeat_ms`. Evidence: the seconds; text: the nudges.stall_words key. A Primary (the
/// owner's own session, read as a workspace-kind row in a DevSwarm checkout) is no dispatched worker: nobody can re-dispatch it, so it
/// is never STALLED (GH #962). Only the watcher's own classification (`ws.primary`) exempts: neither the escalation's `exempt_kinds`
/// (exempting a kind from the stop action must not silence the stall signal for that kind) nor a `primary-` id prefix (a child may keep
/// a legacy `primary-<hash>` id after migration); a Primary known only by its prefix gets the base behaviour, noise rather than silence.
fn stalled(env: &Env, a: &Agent, now: u64) -> Option<Raised> {
    if !(super::is_child(a) || a.kind == kind_name("workspace"))
        || a.ws.as_ref().is_some_and(|w| w.primary)
        || !env.switch("agent_tracker.stall_sw")
        || !running(a)
        || !a.pending.is_empty()
    {
        return None;
    }
    if a.stall_since == 0 || hung(a, now).is_some() {
        return None;
    }
    let c = defaults::raw("nudges.stall_limits");
    let quiet = now.saturating_sub(a.stall_since);
    let rep = if a.said_since > 0 && a.progress == a.said_progress { now.saturating_sub(a.said_since) } else { 0 };
    let (what, idle) = if num(c, "quiet_ms") > 0 && quiet >= num(c, "quiet_ms") {
        ("quiet", quiet)
    } else if num(c, "repeat_ms") > 0 && rep >= num(c, "repeat_ms") {
        ("repeat", rep)
    } else {
        return None;
    };
    // work the transcript does not show: a build or CI wait in flight, or CPU used within the quiet window (#518 FP rubric)
    let busy = if building_now(a, now) {
        Some("building")
    } else if ci_wait_current(a, now) {
        Some("ci_wait")
    } else if a.stall_cpu_at > 0 && now.checked_sub(a.stall_cpu_at).is_some_and(|d| d < num(c, "quiet_ms")) {
        Some("cpu")
    } else if a.armed_until > now {
        // a Monitor, cron or wakeup it armed will wake it: a stated, bounded wait (#972 class 27: STALLED while the session waited on its
        // own scheduled check). A bare background shell still exempts nothing (only a build or CI watch does, above).
        Some("wake_armed")
    } else {
        None
    };
    if let Some(reason) = busy {
        if env.act {
            exempt(reason);
        }
        return None;
    }
    if env.act {
        metric("stalled");
    }
    Some((idle / fmtn("ms_per_s"), what.to_string()))
}

fn running_children(st: &State, a: &Agent) -> u64 {
    st.agents.values().filter(|s| super::is_child(s) && s.parent == a.id && running(s)).count() as u64
}

/// A main session idle for `idle_ms` past its turn: the idle time, or None.
fn main_idle(a: &Agent, now: u64, idle_ms: u64) -> Option<u64> {
    if (a.kind != kind_name("main") && a.kind != kind_name("workspace")) || a.gone || a.running || a.last_output_ms == 0 {
        return None;
    }
    let idle = now.saturating_sub(a.last_output_ms);
    (idle >= idle_ms && idle <= lim("active_window_ms")).then_some(idle)
}

fn joined(items: &[String], shown: u64, joiner: &str) -> String {
    items.iter().take(shown as usize).cloned().collect::<Vec<_>>().join(joiner)
}

/// GH #515: open unblocked unassigned tasks and no agent running for `idle_ms`. Evidence: the task count; text: their subjects.
fn idle_no_agents(env: &Env, a: &Agent, st: &State, tasks: &[Task], now: u64) -> Option<Raised> {
    let c = defaults::raw("nudges.idle_wake");
    if !env.switch("agent_tracker.idle_wake_sw") || main_idle(a, now, num(c, "idle_ms")).is_none() || running_children(st, a) > 0 || compliance::covered(a, now)
    {
        return None;
    }
    let open: Vec<String> = compliance::dispatchable(tasks, st, a, now).iter().map(|t| t.subject.clone()).collect();
    if open.is_empty() {
        return None;
    }
    if env.act {
        metric("idle_wake");
    }
    Some((open.len() as u64, joined(&open, num(c, "tasks_shown"), c.str_field("joiner"))))
}

/// GH #515: an idle child whose last line claims running or background work, with no call in flight, no build or background shell
/// and no output for `claim_ms`. Evidence: the idle seconds; text: the line.
fn false_claim(env: &Env, a: &Agent, now: u64) -> Option<Raised> {
    // a finished, stopped or dead child claims nothing any more (#972 class 1)
    if !super::is_child(a) || !env.switch("agent_tracker.idle_wake_sw") || a.running || a.gone || a.finished || a.dead || a.last_output_ms == 0 {
        return None;
    }
    let line = a.said.last()?;
    let low = line.to_lowercase();
    if !defaults::list("nudges.idle_wake_claims").iter().any(|p| low.contains(&p.to_lowercase())) {
        return None;
    }
    if env.act {
        metric("claim_checked");
    }
    let idle = now.saturating_sub(a.last_output_ms);
    let shell = a.bg_bash.iter().any(|t| *t >= a.last_output_ms && now.saturating_sub(*t) <= lim("bg_bash_ms"));
    if idle < num(defaults::raw("nudges.idle_wake"), "claim_ms") || idle > lim("active_window_ms") || !a.pending.is_empty() || building(a, now) || shell {
        return None;
    }
    if env.act {
        metric("claim_flagged");
    }
    Some((idle / fmtn("ms_per_s"), line.clone()))
}

/// The bullet lines that follow a line holding a gap phrase in `reply` (at most `gap_lines_max`).
fn gap_items(reply: &str) -> Vec<String> {
    let c = defaults::raw("nudges.parallel_limits");
    let phrases = defaults::list("nudges.parallel_gap_phrases");
    let marks = c.get("number_marks").map(V::strings).unwrap_or_default();
    let bullet = |t: &str| -> Option<String> {
        let first = t.chars().next()?;
        if c.str_field("bullet_chars").contains(first) {
            return Some(t.get(first.len_utf8()..).unwrap_or("").trim().to_string());
        }
        let digits = t.chars().take_while(char::is_ascii_digit).count();
        (digits > 0).then(|| marks.iter().find_map(|m| t.get(digits..).and_then(|r| r.strip_prefix(*m))).map(|r| r.trim().to_string())).flatten()
    };
    let (mut out, mut on) = (Vec::new(), false);
    for l in reply.lines().map(str::trim) {
        if phrases.iter().any(|p| l.to_lowercase().contains(&p.to_lowercase())) {
            on = true;
            continue;
        }
        if !on || l.is_empty() {
            continue;
        }
        match bullet(l) {
            Some(i) if !i.is_empty() && (out.len() as u64) < num(c, "gap_lines_max") => out.push(i.chars().take(num(c, "item_chars") as usize).collect()),
            Some(_) => {}
            None => on = false,
        }
    }
    out
}

/// GH #517: an idle main session with fewer running agents than the cap and open items: unassigned tasks while an agent runs
/// (none running is idle_no_agents), or gap lines of its last reply no task subject covers. Text: running, cap and items, tab-joined.
fn underparallel(env: &Env, a: &Agent, st: &State, tasks: &[Task], now: u64) -> Option<Raised> {
    let c = defaults::raw("nudges.parallel_limits");
    if !env.switch("agent_tracker.parallel_sw") || main_idle(a, now, num(c, "idle_ms")).is_none() || compliance::covered(a, now) {
        return None;
    }
    let cap = crate::checks::guardkit::settings::get_num(&env.settings, defaults::raw("spawn_ceiling.max_concurrent_setting")).max(0.0) as u64;
    let run = running_children(st, a);
    if cap > 0 && run >= cap {
        return None;
    }
    let mut items: Vec<String> = if run > 0 { compliance::dispatchable(tasks, st, a, now).iter().map(|t| t.subject.clone()).collect() } else { Vec::new() };
    let covered = |g: &str| {
        let g = g.to_lowercase();
        tasks.iter().any(|t| {
            let s = t.subject.to_lowercase();
            !s.is_empty() && (s.contains(&g) || g.contains(&s))
        })
    };
    items.extend(gap_items(&a.last_reply).into_iter().filter(|g| !covered(g)));
    if items.is_empty() {
        return None;
    }
    if env.act {
        metric("parallel");
    }
    let cap_text = if cap == 0 { c.str_field("no_cap").to_string() } else { cap.to_string() };
    Some((items.len() as u64, format!("{run}\t{cap_text}\t{}", joined(&items, num(c, "items_shown"), c.str_field("joiner")))))
}

/// `tasks`: the list the reader signals see (empty while all of them are off); `all`: the whole list, for the hold exemption of
/// idle_open_task, which reads the hold clocks kept whatever the switches say.
fn raise(env: &Env, a: &Agent, st: &State, tasks: &[Task], all: &[Task], now: u64) -> BTreeMap<&'static str, Raised> {
    let mut out = BTreeMap::new();
    for s in defaults_signals() {
        let r = match s {
            "hung" => hung(a, now),
            "looping" => looping(a),
            "token_waste" => token_waste(env, a, now),
            "burn_soft" => burn(env, a, now, true),
            "burn_hard" => burn(env, a, now, false),
            "agent_waste" => super::waste::raised(a),
            "drift" => drift(a, st, all),
            "heartbeat_stale" => heartbeat_stale(a, now),
            "monitor_unarmed" => monitor_unarmed(env, a, st, now),
            "monitor_off" => monitor_off(env, a),
            "watcher_missing" => watcher_missing(env, a, now),
            "idle_open_task" => idle_open_task(a, st, all, now),
            "watched_exit" => watched_exit(a, now),
            "no_work" => no_work(a),
            "stalled" => stalled(env, a, now),
            "idle_no_agents" => idle_no_agents(env, a, st, tasks, now),
            "false_claim" => false_claim(env, a, now),
            "underparallel" => underparallel(env, a, st, tasks, now),
            "stale_list" => compliance::stale_list(env, a, tasks),
            "untracked_request" => compliance::untracked_request(env, a),
            "inprogress_waiting" => compliance::inprogress_waiting(env, a, tasks, now),
            "lead_waiting_on_done" => super::lead_wait::raised(env, a, st, tasks, now),
            "hold_expired" => compliance::hold_expired(env, a, tasks, now),
            _ => None,
        };
        if let Some(r) = r {
            out.insert(s, r);
        }
    }
    out
}

// ---- telemetry ----------------------------------------------------------------------------------------------

pub(crate) fn base(a: &Agent) -> Fields {
    Fields::new().tok("agent", &a.id).tok("akind", &a.kind).tok("state", state_of(a))
}

pub(crate) fn rec(env: &Env, class: &str, name: &str, outcome: Outcome, fields: Fields) {
    if env.act {
        emit::event(emit::agent_call(AgentRec { class, name, outcome, fields }));
    }
}

fn series(env: &Env, a: &mut Agent) {
    if !env.act || env.now_ms.saturating_sub(a.last_series) < lim("series_every_ms") {
        return;
    }
    a.last_series = env.now_ms;
    let f = base(a)
        .num("tin", a.tin)
        .num("tout", a.tout)
        .num("tcr", a.tcr)
        .num("tcw", a.tcw)
        .num("tools", a.tools)
        .num("progress", a.progress)
        .num("flagged", u64::from(!a.flags.is_empty()))
        .num("idle_s", env.now_ms.saturating_sub(a.last_output_ms) / fmtn("ms_per_s"))
        .tok("source", &a.source);
    rec(env, "series", &a.kind, Outcome::Allow, f);
    let row = serde_json::json!({"t": env.now_ms, "agent": a.id, "kind": a.kind, "state": state_of(a), "tin": a.tin, "tout": a.tout, "tcr": a.tcr, "tcw": a.tcw, "tools": a.tools, "progress": a.progress, "flagged": a.flags.keys().collect::<Vec<_>>()});
    let path = env.dir().join(pth("series"));
    if let Some(d) = path.parent() {
        crate::discard::harmless(std::fs::create_dir_all(d)); // keep: the append below reports a missing directory
    }
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(&path) {
        use std::io::Write;
        crate::discard::harmless(f.write_all(format!("{row}\n").as_bytes())); // keep: a series line lost to a full disk is only a gap
    }
}

fn trim_series(env: &Env) {
    let path = env.dir().join(pth("series"));
    let Ok(t) = std::fs::read_to_string(&path) else { return };
    if t.len() as u64 <= lim("series_max_bytes") {
        return;
    }
    let cutoff = env.now_ms.saturating_sub(lim("series_retention_ms"));
    let mut keep: Vec<&str> =
        t.lines().filter(|l| serde_json::from_str::<serde_json::Value>(l).ok().and_then(|v| v["t"].as_u64()).is_some_and(|x| x >= cutoff)).collect();
    if keep.iter().map(|l| l.len() as u64 + 1).sum::<u64>() > lim("series_max_bytes") {
        keep.drain(..keep.len() / 2);
    }
    crate::discard::harmless(crate::atomic::write(&path, keep.join("\n") + "\n")); // keep: the next tick trims again
}

// ---- reminders ----------------------------------------------------------------------------------------------

#[derive(Debug, PartialEq)]
pub(super) enum Target {
    Session(String),
    Wake(String),
    Mesh { ws: String, to_parent: bool },
    Owner,
}

fn text_for(a: &Agent, sig: &str, f: &Flag, now: u64) -> String {
    let who = label(a);
    let kind: &str = &a.kind;
    let t = match sig {
        "hung" => defaults::render("msg.agent_hung", &[("agent", &who), ("kind", &kind), ("idle", &age(f.evidence * fmtn("ms_per_s"))), ("tool", &f.text)]),
        "looping" => defaults::render("msg.agent_looping", &[("agent", &who), ("kind", &kind), ("count", &f.evidence), ("what", &f.text)]),
        "token_waste" => defaults::render(
            "msg.agent_token_waste",
            &[("agent", &who), ("kind", &kind), ("tokens", &sinks::count(f.evidence)), ("window", &age(lim("waste_window_ms")))],
        ),
        "burn_soft" => defaults::render(
            "burn.msg_soft",
            &[("agent", &who), ("kind", &kind), ("tokens", &sinks::count(f.evidence)), ("window", &age(lim("waste_window_ms")))],
        ),
        "burn_hard" => defaults::render(
            if hold_reason(a, a.samples.last().map_or(f.since, |x| x.t)).is_some() { "burn.msg_hard_withheld" } else { "burn.msg_hard" },
            &[("agent", &who), ("kind", &kind), ("tokens", &sinks::count(f.evidence)), ("window", &age(lim("waste_window_ms")))],
        ),
        "agent_waste" => super::waste::text(&who, a, f.evidence, &f.text),
        "drift" => defaults::render("msg.agent_drift", &[("agent", &who), ("step", &f.text), ("overlap", &f.evidence)]),
        "heartbeat_stale" => defaults::render("msg.agent_heartbeat_stale", &[("agent", &who), ("age", &age(f.evidence * fmtn("ms_per_s"))), ("step", &f.text)]),
        "idle_open_task" => {
            defaults::render("msg.agent_idle_open_task", &[("agent", &who), ("kind", &kind), ("idle", &age(f.evidence * fmtn("ms_per_s"))), ("task", &f.text)])
        }
        "watched_exit" => defaults::render("msg.agent_watched_exit", &[("agent", &who), ("kind", &kind), ("count", &f.evidence), ("task", &f.text)]),
        "no_work" => defaults::render("msg.agent_no_work", &[("agent", &who), ("kind", &kind), ("tools", &f.evidence)]),
        "stalled" => {
            let c = defaults::raw("nudges.stall_limits");
            let shown: Vec<String> =
                a.said.iter().rev().take(num(c, "lines_shown") as usize).rev().map(|l| c.str_field("quote").replace("{line}", l)).collect();
            let lines = if shown.is_empty() { c.str_field("none").to_string() } else { shown.join(c.str_field("joiner")) };
            defaults::render(
                "msg.agent_stalled",
                &[
                    ("agent", &who),
                    ("kind", &kind),
                    ("what", &defaults::raw("nudges.stall_words").str_field(&f.text)),
                    ("idle", &age(f.evidence * fmtn("ms_per_s"))),
                    ("age", &age(a.seen.saturating_sub(a.first_seen))),
                    ("lines", &lines),
                ],
            )
        }
        "idle_no_agents" => {
            defaults::render("msg.agent_idle_no_agents", &[("n", &f.evidence), ("idle", &age(f.since.saturating_sub(a.last_output_ms))), ("tasks", &f.text)])
        }
        "false_claim" => {
            let line = defaults::raw("nudges.stall_limits").str_field("quote").replace("{line}", &f.text);
            defaults::render("msg.agent_false_claim", &[("agent", &who), ("idle", &age(f.evidence * fmtn("ms_per_s"))), ("line", &line)])
        }
        "underparallel" => {
            let mut parts = f.text.splitn(3, '\t');
            let (run, cap, items) = (parts.next().unwrap_or(""), parts.next().unwrap_or(""), parts.next().unwrap_or(""));
            defaults::render("msg.agent_underparallel", &[("n", &f.evidence), ("items", &items), ("running", &run), ("cap", &cap)])
        }
        "stale_list" => defaults::render("msg.agent_stale_list", &[("n", &f.evidence), ("tasks", &f.text)]),
        "untracked_request" => defaults::render("msg.agent_untracked_request", &[("n", &f.evidence)]),
        "inprogress_waiting" => defaults::render("msg.agent_inprogress_waiting", &[("tasks", &f.text), ("idle", &age(f.evidence * fmtn("ms_per_s")))]),
        "lead_waiting_on_done" => super::lead_wait::text(a, f.evidence, &f.text, a.seen.saturating_sub(a.last_output_ms)),
        "hold_expired" => compliance::hold_render(a, now).0,
        "watcher_missing" => watcher_text(a, f.evidence),
        "monitor_off" => {
            let e = defaults::raw(wake_switch_key(a));
            defaults::render("msg.agent_monitor_off", &[("setting", &format!("{}.{}", e.str_field("section"), e.str_field("key")))])
        }
        _ if a.ws.as_ref().is_some_and(|w| w.armed == Some(false)) => {
            defaults::render(
                "msg.agent_monitor_unarmed_devswarm",
                &[("command", &defaults::text("agent_tracker.wake_command")), ("timeout", &defaults::num("agent_tracker.wake_timeout_ms"))],
            )
        }
        _ => defaults::render(
            "msg.agent_monitor_unarmed",
            &[("command", &defaults::text("agent_tracker.wake_command_agents")), ("timeout", &defaults::num("agent_tracker.wake_timeout_ms"))],
        ),
    };
    capped(&t)
}

/// A reminder text under `agent_tracker.spam.max_text`.
fn capped(t: &str) -> String {
    cap(t, defaults::raw("agent_tracker.spam").get("max_text").and_then(V::as_integer).unwrap_or(0).max(0) as u64)
}

/// The configured route targets: name -> (whose queue it addresses, which sink delivers). A new target is a row in
/// `agent_tracker.targets`; only a new kind of sink needs code.
/// The session a heartbeat belongs to: its file is named by the writer's session key (`agents heartbeat`); a followed subagent reports
/// to its parent. `None` for a writer the tracker does not follow (a stale or foreign file): nobody is told.
pub(super) fn heartbeat_owner(st: &State, stem: &str) -> Option<String> {
    st.agents
        .values()
        .find(|m| m.kind != kind_name("heartbeat") && super::sinks::key_of(&m.id) == stem)
        .map(|m| if super::is_child(m) { m.parent.clone() } else { m.id.clone() })
}

pub(super) fn targets(env: &Env, st: &State, a: &Agent, sig: &str) -> Vec<Target> {
    let routes = defaults::raw("agent_tracker.routes").get(sig).map(V::strings).unwrap_or_default();
    let table = defaults::raw("agent_tracker.targets");
    let mut out = Vec::new();
    for r in routes {
        let Some(row) = table.get(r) else { continue };
        let (to, via) = (row.str_field("to"), row.str_field("via"));
        if via == chan("owner_file") {
            if env.switch("agent_tracker.owner_setting") {
                out.push(Target::Owner);
            }
            continue;
        }
        let wake = via == chan("wake");
        if to == chan("self") {
            match &a.ws {
                Some(w) if !wake => {
                    // a workspace is also a session: its own hook delivers the queue, the mesh row is for the action layer
                    out.push(Target::Session(a.id.clone()));
                    out.push(Target::Mesh { ws: w.id.clone(), to_parent: false });
                }
                _ => out.push(if wake { Target::Wake(a.id.clone()) } else { Target::Session(a.id.clone()) }),
            }
        } else if to == chan("coordinator") {
            let session = match (&a.ws, a.kind.as_str()) {
                (Some(_), _) => None,
                (None, _) if super::is_child(a) => Some(a.parent.clone()),
                (None, k) if k == kind_name("heartbeat") && env.switch("agent_nudge.scope_setting") => heartbeat_owner(st, &a.name),
                (None, k) if k == kind_name("heartbeat") => {
                    st.agents.values().filter(|m| m.kind == kind_name("main")).max_by_key(|m| m.last_output_ms).map(|m| m.id.clone())
                }
                _ => Some(a.id.clone()),
            };
            match (session, &a.ws) {
                (Some(k), _) if wake => out.push(Target::Wake(k)),
                (Some(k), _) => out.push(Target::Session(k)),
                (None, Some(w)) if !wake => out.push(Target::Mesh { ws: w.id.clone(), to_parent: true }),
                // a workspace's own signal about itself (its background task ended, it idles on an open task) also reaches the workspace
                // through its own wake feed: the mesh row goes to its parent only, so the lead itself heard nothing (2026-11-23 incident)
                (None, Some(_)) if wake && !super::is_child(a) && defaults::list("agent_tracker.workspace_self_wake").contains(&sig) => {
                    out.push(Target::Wake(a.id.clone()));
                }
                _ => {}
            }
        }
    }
    out
}

/// Whether a delivery to `t` reached the flagged session itself: its own queue or wake feed, or its own workspace's mesh row. The
/// fallback to a parent or Primary and the owner notices told someone else (GH #959).
pub(super) fn own_target(a: &Agent, t: &Target) -> bool {
    match t {
        Target::Session(k) | Target::Wake(k) => *k == a.id,
        Target::Mesh { ws, to_parent } => !*to_parent && a.ws.as_ref().is_some_and(|w| w.id == *ws),
        Target::Owner => false,
    }
}

/// Where a flag goes when its own routes reach nobody: the direct parent or nearest live ancestor (a workspace's Primary), by wake feed
/// and session queue; failing that the owner notices file (while it is on).
fn fallback_targets(env: &Env, st: &State, a: &Agent) -> Vec<Target> {
    match super::nudge::fallback_session(env, st, a) {
        Some(k) => vec![Target::Wake(k.clone()), Target::Session(k)],
        None if env.switch("agent_tracker.owner_setting") => vec![Target::Owner],
        None => Vec::new(),
    }
}

/// Count and log, once per raised flag, that it could not be delivered along its own routes.
fn mark_undeliverable(a: &mut Agent, sig: &str, why: &str) {
    if let Some(f) = a.flags.get_mut(sig)
        && !f.undeliverable
    {
        f.undeliverable = true;
        compliance::undeliverable(sig, why);
    }
}

fn remind(env: &Env, st: &mut State, a: &mut Agent, sig: &str, queued: &mut u64, force: bool) {
    // an unhealthy child is the nudge loop's: one question to its direct parent, never a broadcast (unless the loop never opened one:
    // `force`, from the undelivered watchdog)
    if !env.act || !env.switch("agent_tracker.remind_setting") {
        return;
    }
    // the nudge loop's question goes to the parent; the flagged session still hears its own signal on its own wake feed
    let own_only = !force && super::nudge::owns(env, a, sig);
    if own_only && !(watcher_session(a) && sinks::wake_armed(env, &a.id)) {
        return;
    }
    let now = env.now_ms;
    // a snooze its parent gave this child (`agents nudge <child> snooze`) holds every reminder about the child, not only the nudge
    // loop's own (#972 class 1: a snoozed teammate's false_claim fired again within the hour)
    if super::is_child(a) && super::nudge::snoozed(env, st, a, now) {
        compliance::suppressed_any(sig, "snoozed");
        return;
    }
    let cd = defaults::raw("agent_tracker.cooldowns").get(sig);
    let cool = cd.and_then(|c| c.get("cooldown_ms")).and_then(V::as_integer).unwrap_or(0).max(0) as u64;
    let per_day = cd.and_then(|c| c.get("max_per_day")).and_then(V::as_integer).unwrap_or(0).max(0) as u64;
    let spam = |k: &str| defaults::raw("agent_tracker.spam").get(k).and_then(V::as_integer).unwrap_or(0).max(0) as u64;
    let day = fmtn("day_ms");
    a.sent_log.retain(|(_, t)| now.saturating_sub(*t) < day);
    let once = cd.and_then(|c| c.get("once")).and_then(V::as_bool).unwrap_or(false);
    let step_hash = crate::health::fnv(&a.step);
    let already_once = once && a.flags.get(sig).is_some_and(|f| f.reminded_at > 0);
    let drift_same_step = sig == "drift" && lim("drift_once_per_step") > 0 && a.drift_step == step_hash;
    let why = if already_once || drift_same_step {
        Some("once")
    } else if a.last_sent.get(sig).is_some_and(|t| now.saturating_sub(*t) < cool) {
        Some("cooldown")
    } else if per_day > 0 && a.sent_log.iter().filter(|(s, _)| s == sig).count() as u64 >= per_day {
        Some("cap")
    } else if *queued >= spam("max_per_tick") {
        Some("tick_cap")
    } else {
        None
    };
    let Some(flag) = a.flags.get(sig).cloned() else { return };
    // a heartbeat row reaches only the session that wrote it, and only when it names a step
    if why.is_none() && a.kind == kind_name("heartbeat") && env.switch("agent_nudge.scope_setting") {
        let ws = defaults::raw("agent_tracker.wake_scope");
        let drop = if a.hb_step.trim().is_empty() {
            Some(ws.str_field("empty_step"))
        } else if heartbeat_owner(st, &a.name).is_none() {
            Some(ws.str_field("foreign_agent"))
        } else {
            None
        };
        if let Some(r) = drop {
            rec(env, ws.str_field("class"), ws.str_field("dropped"), Outcome::Skip, base(a).tok("signal", sig).tok("reason", r));
            crate::metrics::bump("agent_wake_dropped", &[("reason", r)]);
            a.last_sent.insert(sig.to_string(), now);
            return;
        }
    }
    let mut tg = if own_only { Vec::new() } else { targets(env, st, a, sig) };
    // owner rule: EVERY signal about a session reaches that session's own wake feed while its watcher is armed; parent and Primary
    // copies are additional, never instead (the 2026-11-23 workspace heard nothing while its Monitor was armed all night)
    if watcher_session(a) && !tg.iter().any(|t| matches!(t, Target::Wake(k) if *k == a.id)) && sinks::wake_armed(env, &a.id) {
        tg.push(Target::Wake(a.id.clone()));
    }
    if tg.is_empty() && !own_only {
        mark_undeliverable(a, sig, "no_route");
        tg = fallback_targets(env, st, a);
    }
    let (mut sent, mut failed, mut fell_back) = (0, 0, false);
    // deliveries that reached the flagged session itself; one text for every target, and for hold_expired the holds it lists
    let mut to_session = 0;
    let (text, hold_listed) = if sig == "hold_expired" {
        let (t, listed) = compliance::hold_render(a, now);
        (capped(&t), listed)
    } else {
        (text_for(a, sig, &flag, now), Vec::new())
    };
    // a hold reminder that lists no task tells the session nothing: never sent, so it neither counts nor starts the cooldown
    if sig == "hold_expired" && hold_listed.is_empty() {
        return;
    }
    loop {
        for t in &tg {
            // per target: a full session queue must not hold back the wake row, which is the one path that reaches an idle session
            let mut held = why;
            let (sink, key): (Box<dyn Sink>, String) = match t {
                Target::Session(k) => (Box::new(SessionQueue), k.clone()),
                Target::Wake(k) => (Box::new(WakeFeed), k.clone()),
                Target::Mesh { ws, to_parent } => (Box::new(MeshOutbox { to_parent: *to_parent }), ws.clone()),
                Target::Owner => (Box::new(OwnerNotices), String::new()),
            };
            if held.is_none() && sink.backlog(env, &key) >= spam("max_pending") {
                held = Some("pending");
            }
            if held.is_none() && sink.has_pending(env, &key, sig, &a.id) {
                held = Some("pending");
            }
            let f = base(a).tok("channel", sink.channel()).tok("result", held.unwrap_or("queued")).num("evidence", flag.evidence);
            if let Some(h) = held {
                let quiet = a.last_sent.get(&format!("held:{sig}")).is_some_and(|t| now.saturating_sub(*t) < cool.max(1));
                if !quiet {
                    rec(env, "reminder", sig, Outcome::Skip, f.tok("source", h));
                    compliance::suppressed(sig, h);
                    st.day(env).suppressed += 1;
                    a.last_sent.insert(format!("held:{sig}"), now);
                }
                continue;
            }
            let r = Reminder {
                id: format!("{:x}", crate::health::fnv(&format!("{}{sig}{now}", a.id))),
                ts: now,
                signal: sig.into(),
                agent: a.id.clone(),
                text: text.clone(),
            };
            match sink.deliver(env, &key, &r) {
                Ok(()) => {
                    if matches!(t, Target::Wake(_)) {
                        compliance::delivered(sig, "delivered_wake");
                    }
                    if own_target(a, t) {
                        to_session += 1;
                    }
                    rec(env, "reminder", sig, Outcome::Advise, f);
                    sent += 1;
                }
                Err(e) => {
                    crate::health::log_event("agents", "queue_write", &e);
                    failed += 1;
                }
            }
        }
        if sent == 0 && failed > 0 {
            mark_undeliverable(a, sig, "write_failed");
            if !fell_back {
                fell_back = true;
                failed = 0;
                tg = fallback_targets(env, st, a);
                if !tg.is_empty() {
                    continue;
                }
            }
        }
        break;
    }
    if sent > 0 {
        compliance::fired(sig);
        st.day(env).queued += 1;
        *queued += 1;
        a.last_sent.insert(sig.into(), now);
        a.sent_log.push((sig.into(), now));
        // only a reminder that reached the session's own target counts or confirms (a fallback to the Primary or the owner told someone
        // else), and only for the holds its text lists (GH #959)
        if sig == "hold_expired" && to_session > 0 {
            compliance::hold_sent(a, &hold_listed, now);
        }
        if sig == "drift" {
            a.drift_step = step_hash;
        }
        if sig == "monitor_unarmed" {
            crate::metrics::bump("monitor_rearm_prompted", &[]);
        }
        if let Some(f) = a.flags.get_mut(sig)
            && f.reminded_at == 0
        {
            f.reminded_at = now;
        }
    }
}

/// Why a flag cleared (`nudges.compliance_outcomes` clear_*): the session acted; the condition went (the agent finished, died or
/// resumed); it went quiet past the tracked window (expired); it was never delivered; or nothing explains it (counted, never silent).
fn clear_reason(env: &Env, a: &Agent, f: &Flag) -> &'static str {
    let o = defaults::raw("nudges.compliance_outcomes");
    let key = if a.task_calls > f.base_task_calls || a.progress >= f.base_progress + lim("fp_min_progress") {
        "clear_acted"
    } else if a.gone || a.dead || a.finished || a.running {
        "clear_gone"
    } else if env.now_ms.saturating_sub(a.last_output_ms) > lim("active_window_ms") {
        "clear_expired"
    } else if f.reminded_at == 0 && f.delivered_at == 0 {
        "clear_undelivered"
    } else {
        "clear_unexplained"
    };
    o.str_field(key)
}

fn resolve(env: &Env, st: &mut State, a: &Agent, sig: &str, f: &Flag) {
    let now = env.now_ms;
    let why = clear_reason(env, a, f);
    compliance::cleared_why(sig, why);
    if why == defaults::raw("nudges.compliance_outcomes").str_field("clear_undelivered") {
        crate::health::log_event("agents", "cleared_undelivered", sig);
    }
    if f.reminded_at > 0 {
        compliance::cleared(sig, a.task_calls > f.base_task_calls);
        let lat = now.saturating_sub(f.reminded_at) / fmtn("ms_per_s");
        rec(env, "outcome", "recovered", Outcome::Allow, base(a).tok("source", sig).num("recovered", 1).num("lat_s", lat));
        if sig == "monitor_unarmed" {
            crate::metrics::bump("monitor_rearmed", &[]);
        }
        st.day(env).recovered += 1;
    } else if a.progress >= f.base_progress + lim("fp_min_progress") {
        rec(env, "outcome", "false_positive", Outcome::Allow, base(a).tok("source", sig).num("fp", 1));
        st.day(env).false_positives += 1;
    } else {
        rec(env, "outcome", "cleared", Outcome::Allow, base(a).tok("source", sig));
    }
}

fn apply(env: &Env, st: &mut State, a: &mut Agent, raised: BTreeMap<&'static str, Raised>, queued: &mut u64) {
    let now = env.now_ms;
    for sig in defaults_signals() {
        match (raised.get(sig), a.flags.contains_key(sig)) {
            (Some((ev, text)), false) => {
                let f = Flag {
                    since: now,
                    evidence: *ev,
                    text: text.clone(),
                    ticks: 1,
                    base_progress: a.progress,
                    base_tokens: a.tin + a.tout,
                    base_task_calls: a.task_calls,
                    ..Flag::default()
                };
                rec(
                    env,
                    "signal",
                    sig,
                    Outcome::Advise,
                    base(a).num("evidence", *ev).num("idle_s", now.saturating_sub(a.last_output_ms) / fmtn("ms_per_s")).tok("source", &a.source),
                );
                if env.act {
                    st.day(env).signals += 1;
                    if sig == "monitor_unarmed" {
                        let reason = if a.ws.is_some() { "workspace_lock" } else { "no_stamp" };
                        crate::metrics::bump("monitor_unarmed", &[("kind", a.kind.as_str()), ("reason", reason)]);
                    }
                }
                a.flags.insert(sig.into(), f);
            }
            (Some((ev, text)), true) => {
                if let Some(f) = a.flags.get_mut(sig) {
                    f.ticks += 1;
                    f.evidence = *ev;
                    f.text.clone_from(text);
                }
            }
            (None, true) => {
                if let Some(f) = a.flags.remove(sig)
                    && env.act
                {
                    resolve(env, st, a, sig, &f);
                }
                continue;
            }
            (None, false) => continue,
        }
        let Some(f) = a.flags.get(sig).cloned() else { continue };
        let confirm = defaults::raw("agent_tracker.cooldowns").get(sig).and_then(|c| c.get("confirm_ticks")).and_then(V::as_integer);
        if f.ticks >= confirm.map_or(lim("confirm_ticks"), |c| c.max(0) as u64) {
            remind(env, st, a, sig, queued, false);
        }
        // a flag the nudge loop owns but never acted on (no reminder, no delivery, no open nudge, no snooze) is not left to sit
        if let Some(f) = a.flags.get(sig)
            && f.reminded_at == 0
            && f.delivered_at == 0
            && now.saturating_sub(f.since) >= lim("undelivered_ms")
            && super::nudge::owns(env, a, sig)
            && !st.nudges.contains_key(&a.id)
            && !super::nudge::snoozed(env, st, a, now)
        {
            mark_undeliverable(a, sig, "undelivered_watchdog");
            remind(env, st, a, sig, queued, true);
        }
        if let Some(f) = a.flags.get_mut(sig)
            && f.reminded_at > 0
            && !f.timed_out
            && now.saturating_sub(f.reminded_at) > lim("outcome_timeout_ms")
        {
            f.timed_out = true;
            rec(env, "outcome", "unrecovered", Outcome::Allow, base(a).tok("source", sig));
            if env.act {
                st.day(env).unrecovered += 1;
            }
        }
    }
}

/// Read the rows the hook check appended to the delivered file since the last tick.
fn take_deliveries(env: &Env, st: &mut State) {
    let Ok(t) = std::fs::read_to_string(env.dir().join(pth("delivered"))) else { return };
    let all: Vec<&str> = t.lines().collect();
    let from = (st.delivered_lines as usize).min(all.len());
    for l in all.iter().skip(from).take(lim("delivered_max") as usize) {
        st.delivered_lines += 1;
        let Ok(v) = serde_json::from_str::<serde_json::Value>(l) else { continue };
        let (agent, sig, ts) = (v["agent"].as_str().unwrap_or(""), v["signal"].as_str().unwrap_or(""), v["ts"].as_u64().unwrap_or(env.now_ms));
        super::nudge::delivered(st, &v, ts);
        if v["channel"].as_str().unwrap_or(chan("session")) == chan("session") {
            compliance::delivered(sig, "delivered_hook");
        }
        // a nudge row names the nudge, not the flag: the flag it answers is the child's trigger signal (#207: those flags stayed at 0)
        let flag = super::nudge::flag_signal(st, &v).unwrap_or_else(|| sig.to_string());
        let lat = st.agents.get_mut(agent).and_then(|a| a.flags.get_mut(flag.as_str())).map(|f| {
            f.delivered_at = ts;
            f.delivered_to = v["key"].as_str().unwrap_or("").to_string();
            ts.saturating_sub(if f.reminded_at > 0 { f.reminded_at } else { f.since }) / fmtn("ms_per_s")
        });
        if env.act {
            st.day(env).delivered += 1;
            emit::event(emit::agent_call(AgentRec {
                class: "delivery",
                name: sig,
                outcome: Outcome::Advise,
                fields: Fields::new().tok("agent", agent).tok("channel", v["channel"].as_str().unwrap_or(chan("session"))).num("lat_s", lat.unwrap_or(0)),
            }));
        }
    }
}

/// One evaluation pass over every agent.
pub(crate) fn evaluate_all(env: &Env, st: &mut State) {
    let now = env.now_ms;
    take_deliveries(env, st);
    let mut queued = 0;
    let mut judge_budget = super::waste::judge_budget();
    let ids: Vec<String> = st.agents.keys().cloned().collect();
    let roots = probe_roots(st);
    let mut procs_table: Option<Vec<super::procs::Proc>> = None; // the process table, read at most once a tick and only when a quiet agent needs it
    for id in ids {
        let Some(mut a) = st.agents.remove(&id) else { continue };
        let prev = a.samples.last().map(|s| s.tin + s.tout).unwrap_or(a.tin + a.tout);
        super::waste::note_head(env, &mut a);
        sample(&mut a, now);
        let root = roots.get(&id).copied().unwrap_or((0, false));
        stall_sample(env, &mut a, root, &mut procs_table, now);
        super::waste::update(env, &mut a, &mut judge_budget);
        let all = compliance::load_all(env, &a);
        let tasks: &[Task] = if compliance::readers_on(env) { &all } else { &[] };
        compliance::update_waiting(env, &mut a, st, tasks, now);
        compliance::update_held(env, &mut a, &all, now);
        let raised = raise(env, &a, st, tasks, &all, now);
        mark_breaker(env, &a, raised.get("burn_hard"));
        apply(env, st, &mut a, raised, &mut queued);
        if env.act && !a.flags.is_empty() {
            st.day(env).burned += (a.tin + a.tout).saturating_sub(prev);
        }
        series(env, &mut a);
        st.agents.insert(id, a);
    }
    super::nudge::tick(env, st);
    super::lockwatch::tick(env, st);
    let keep = lim("day_retention");
    let today = now / fmtn("day_ms");
    st.days.retain(|d, _| d.parse::<u64>().is_ok_and(|d| today.saturating_sub(d) <= keep));
    if env.act {
        sinks::compact(env);
        sweep_markers(env);
        trim_series(env);
    }
}

#[cfg(test)]
pub(super) fn stalled_for_tests(env: &Env, a: &Agent, now: u64) -> Option<Raised> {
    stalled(env, a, now)
}

#[cfg(test)]
pub(super) fn drift_for_tests(a: &Agent, st: &State, tasks: &[Task]) -> Option<Raised> {
    drift(a, st, tasks)
}

#[cfg(test)]
pub(super) fn idle_open_task_for_tests(a: &Agent, st: &State, now: u64) -> Option<Raised> {
    idle_open_task(a, st, &[], now)
}
