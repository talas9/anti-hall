//! Nudges (task #207): when a child agent looks unhealthy, its DIRECT parent is asked, in plain words, whether to do something
//! about it, and the engine tracks what the parent did.
//!
//! - **Who:** a subagent's or teammate's launching session, a DevSwarm workspace's Primary, a Codex run's launching session. A
//!   parent that is missing or not live is walked past to the nearest live ancestor (the nudge says so); with none left the
//!   nudge goes to the owner's channel (`escalate`). Never a broadcast. Primaries are never nudged about.
//! - **When:** only on unhealthy evidence: a trigger signal is up (`agent_nudge.triggers`; waste only with real tokens) and the
//!   `agentHealth` judge (Jev ladder haiku -> sonnet, fail-open to the rule) does not call the child legitimately busy. A dead
//!   child gets one notice, no question.
//! - **Answer:** one verb, `ah-engine agents nudge <child> stop | msg "<text>" | snooze <min> ["reason"] | other "<reason>"`,
//!   or prose (classified by `nudgeReply`, fail-open = no answer). A snooze or other reason is rated by `nudgeReason`; an
//!   implausible one gets the shortest snooze.
//! - **Outcome**, verified from the tracker's own facts: acted_stopped, acted_progress, finished, said_not_done (said stop, still
//!   running after the window), ignored (no answer and no change: reminded on the cadence, escalated after a count), snoozed,
//!   escalated, child_died.
//!
//! Each nudge is kept in the tracker state (open ones by child, closed ones in a bounded log) and every transition is a telemetry
//! event (class `nudge`); `query nudges` and `query nudge_rollup` read them. Every window, cap, word and text is in
//! `engine/defaults/agent_nudge.toml`.
use super::escalate;
use super::signals::{base, rec, state_of};
use super::sinks::{self, OwnerNotices, Reminder, SessionQueue, Sink, WakeFeed, age, wake_armed};
use super::{Agent, Env, State, kind_name, state_name};
use crate::cli::Parsed;
use crate::defaults::{self, V};
use crate::telemetry::event::{Fields, Outcome};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

/// One nudge about one child.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct Nudge {
    /// The nudge id.
    pub id: String,
    /// The short token the parent starts its answer with (unique among open nudges).
    pub ref_id: String,
    /// The child agent's id.
    pub child: String,
    /// The child's name (its description), as the nudge shows it.
    pub child_name: String,
    /// The child's kind word (subagent, teammate, workspace, codex).
    pub child_kind: String,
    /// The child's direct parent (empty when it could not be told).
    pub direct_parent: String,
    /// Where the nudge goes: the direct parent, or the nearest live ancestor when `walked`.
    pub parent: String,
    /// The kind of the session the nudge goes to.
    pub parent_kind: String,
    /// The direct parent was not live, so the nudge went further up.
    pub walked: bool,
    /// The owner session (or the notices file) the nudge was escalated to.
    pub escalated_to: String,
    /// When it was escalated (0 = not).
    pub escalated_at: u64,
    /// The trigger kind: hung, idle, loop, waste, dead.
    pub trigger: String,
    /// The tracker signal that raised it.
    pub signal: String,
    /// Evidence: how long the child has run.
    pub ev_dur_ms: u64,
    /// Evidence: the child's input plus output tokens.
    pub ev_tokens: u64,
    /// Evidence: minutes since its last output.
    pub ev_idle_min: u64,
    /// Evidence: the call or step it is on.
    pub ev_step: String,
    /// Evidence: its progress units.
    pub ev_outcomes: u64,
    /// Evidence, in the plain words the nudge carries.
    pub ev_text: String,
    /// The agentHealth verdict (empty when none).
    pub health: String,
    /// The ladder rung that gave it.
    pub health_tier: String,
    /// Whether the verdict agreed with the rule (unhealthy).
    pub health_agree: Option<bool>,
    /// When the first nudge was sent.
    pub sent_at: u64,
    /// When the last nudge or reminder was sent.
    pub last_sent: u64,
    /// When the parent's hook or wake-watch first delivered it (0 = not yet).
    pub delivered_at: u64,
    /// The session key that delivered row names.
    pub delivered_to: String,
    /// How it was sent (queue, wake, notices).
    pub path: String,
    /// Nudges sent, the first included.
    pub reminders: u64,
    /// The answer as given: stop, msg, snooze, other or prose.
    pub answer: String,
    /// The class the current answer counts as (empty while none is pending).
    pub answer_class: String,
    /// Where the current answer came from: verb, tool (a matched tool call), prose (a matched reply); empty while none.
    pub answer_source: String,
    /// The newest parent turn already matched against this nudge (turns at or before it are not read again).
    pub turns_from: u64,
    /// When the current answer came.
    pub answer_at: u64,
    /// When the first answer came.
    pub first_answer_at: u64,
    /// The parent's reason or message text.
    pub reason: String,
    /// The nudgeReason verdict on the reason.
    pub reason_plausible: Option<bool>,
    /// Minutes of the last snooze granted.
    pub snooze_min: u64,
    /// Snoozes taken.
    pub snoozes: u64,
    /// No reminder before this time.
    pub snooze_until: u64,
    /// Reminders that found no answer and no change.
    pub ignored: u64,
    /// Times the parent said stop and the child was still running after the window.
    pub said_not_done: u64,
    /// The verified outcome (empty while open).
    pub outcome: String,
    /// When it was resolved.
    pub outcome_at: u64,
    /// The child's tokens when the nudge was sent.
    pub tokens_at_sent: u64,
    /// Tokens the child spent between the nudge and its resolution.
    pub tokens_after: u64,
    /// The child's last output when the nudge (or the last answer) came: newer output is progress.
    pub out_mark: u64,
    /// When the stop action ran after an escalation (0 = not).
    pub acted_at: u64,
    /// The text of the last nudge or reminder sent to the parent (the queue fallback of a wake-only delivery sends it again).
    pub last_text: String,
    /// When the last delivery row naming this nudge was recorded (0 = none yet).
    pub last_delivered_at: u64,
    /// When a wake-only delivery was repeated in the reminder queue because no delivery was recorded in time (0 = not).
    pub fallback_at: u64,
}

/// A snooze kept per child and trigger, outside the nudge it was given to: it holds a re-raised condition until it runs out and its
/// count carries over to the next nudge about the same condition.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct Snooze {
    /// No nudge about the condition before this time.
    pub until: u64,
    /// Snoozes taken for this child and trigger.
    pub snoozes: u64,
    /// Minutes of the last one.
    pub min: u64,
    /// Re-raises the snooze held back.
    pub held: u64,
}

fn snooze_key(child: &str, trigger: &str) -> String {
    format!("{child}|{trigger}")
}

fn lim(k: &str) -> u64 {
    defaults::raw("agent_nudge.limits").get(k).and_then(V::as_integer).unwrap_or(0).max(0) as u64
}
fn word(k: &str) -> &'static str {
    defaults::raw("agent_nudge.words").str_field(k)
}
fn ans(k: &str) -> &'static str {
    defaults::raw("agent_nudge.answers").str_field(k)
}
fn src(k: &str) -> &'static str {
    defaults::raw("agent_nudge.sources").str_field(k)
}
fn out(k: &str) -> &'static str {
    defaults::raw("agent_nudge.outcomes").str_field(k)
}
fn trigger_of(sig: &str) -> Option<&'static str> {
    defaults::raw("agent_nudge.triggers").get(sig).and_then(V::as_str)
}
fn kind_word(a: &Agent) -> &'static str {
    let k = defaults::raw("agent_nudge.kind_words");
    k.get(&a.kind).and_then(V::as_str).unwrap_or(k.str_field("other"))
}

/// Whether the nudge loop owns this signal for this agent (the plain reminder routes then stay quiet about it).
pub(crate) fn owns(env: &Env, a: &Agent, sig: &str) -> bool {
    env.switch("agent_nudge.setting") && trigger_of(sig).is_some() && !escalate::primary(a) && a.kind != kind_name("heartbeat")
}

/// Tokens as k/M (`agent_nudge.units`).
fn tokens(n: u64) -> String {
    let u = defaults::raw("agent_nudge.units");
    let (m, k) = (u.get("m").and_then(V::as_integer).unwrap_or(1).max(1) as u64, u.get("k").and_then(V::as_integer).unwrap_or(1).max(1) as u64);
    if n >= m { format!("{:.1}{}", n as f64 / m as f64, u.str_field("m_word")) } else { format!("{}{}", n / k, u.str_field("k_word")) }
}

fn live(st: &State, id: &str) -> bool {
    st.agents.get(id).is_some_and(|p| super::sources::proc_live(p) && !p.dead)
}

/// The Primary session of a DevSwarm workspace: the parent partition of its worktree, then that descriptor's session.
fn primary_of(env: &Env, a: &Agent) -> Option<String> {
    let pid = crate::dssup::liveness::parent_id(&a.cwd).ok().flatten()?;
    let f = defaults::raw("agent_tracker.devswarm_fields");
    let p = env.base().join(super::pth("devswarm")).join(super::pth("workspaces")).join(format!("{pid}{}", super::pth("json_ext")));
    super::sources::json_of(&p)?.get(f.str_field("session")).and_then(Value::as_str).map(str::to_string)
}

/// The direct parent of `a` (a session id), when it can be told.
fn direct_parent(env: &Env, st: &State, a: &Agent) -> Option<String> {
    if super::is_child(a) {
        return (a.parent != a.id && !a.parent.is_empty()).then(|| a.parent.clone());
    }
    if a.kind == kind_name("workspace") {
        return primary_of(env, a);
    }
    if a.kind == kind_name("codex") {
        return escalate::codex_parent(env, a);
    }
    let _ = st;
    None
}

/// The live session a nudge about `a` goes to: its direct parent, else the nearest live ancestor (walked), else none.
fn target(env: &Env, st: &State, a: &Agent) -> (String, Option<String>, bool) {
    let direct = direct_parent(env, st, a).unwrap_or_default();
    let mut cur = direct.clone();
    for step in 0..=lim("walk_max") {
        if cur.is_empty() {
            break;
        }
        if live(st, &cur) {
            return (direct, Some(cur), step > 0);
        }
        cur = match st.agents.get(&cur) {
            Some(p) => direct_parent(env, st, p).unwrap_or_default(),
            None => String::new(),
        };
    }
    let walked = !direct.is_empty();
    (direct, None, walked)
}

fn ev(n: &Nudge) -> Fields {
    Fields::new()
        .tok("agent", &n.child)
        .tok("akind", &n.child_kind)
        .tok("nudge", &n.id)
        .tok("parent", &n.parent)
        .tok("trigger", &n.trigger)
        .tok("answer", &n.answer_class)
        .tok("answer_source", if n.answer_source.is_empty() { src("none") } else { &n.answer_source })
        .tok("outcome", &n.outcome)
        .tok("path", &n.path)
        .tok("health", &n.health)
        .tok("tier", &n.health_tier)
        .num("agree", n.health_agree.map_or(0, |b| if b { 1 } else { 2 }))
        .num("reminders", n.reminders)
        .num("ignored", n.ignored)
        .num("snoozes", n.snoozes)
        .num("snooze_min", n.snooze_min)
        .num("escalated", u64::from(n.escalated_at > 0))
        .num("walked", u64::from(n.walked))
        .num("delivered", u64::from(n.delivered_at > 0))
        .num("tokens", n.ev_tokens)
        .num("idle_min", n.ev_idle_min)
        .num("tokens_after", n.tokens_after)
        .num("ans_s", if n.first_answer_at > 0 { n.first_answer_at.saturating_sub(n.sent_at) / super::fmtn("ms_per_s") } else { 0 })
        .num("act_s", if n.outcome_at > 0 { n.outcome_at.saturating_sub(n.sent_at) / super::fmtn("ms_per_s") } else { 0 })
}

fn emit(env: &Env, event: &str, n: &Nudge) {
    rec(env, word("class"), event, Outcome::Advise, ev(n));
}

fn answer_line(n: &Nudge) -> String {
    defaults::render("msg.agent_nudge_answer", &[("cmd", &defaults::text("agent_nudge.cmd")), ("child", &n.child), ("ref", &n.ref_id)])
}

/// Put `text` in front of session `to`: its reminder queue (its hook delivers it at its next turn) and, while a wake-watch covers
/// it, its wake feed (so an idle session wakes). Returns the path word.
fn send_to(env: &Env, to: &str, n: &Nudge, text: String) -> String {
    let r = Reminder { id: format!("{}-{}", n.id, n.reminders), ts: env.now_ms, signal: word("signal").into(), agent: n.child.clone(), text };
    let mut path = Vec::new();
    // a session a wake-watch covers gets the nudge on its wake feed alone (it reaches an active session too), so it is seen once; the
    // reminder queue is the fallback when no wake line was delivered in time (`follow`) and the road for a session nothing watches
    let armed = wake_armed(env, to);
    if (!armed || !env.switch("agent_nudge.once_setting")) && SessionQueue.deliver(env, to, &r).is_ok() {
        path.push(word("path_queue"));
    }
    if armed && WakeFeed.deliver(env, to, &r).is_ok() {
        path.push(word("path_wake"));
    }
    path.join(word("path_join"))
}

/// The owner's channel: the newest live armed main session of the child's own project, else the owner notices file. Returns (where, path).
/// The project of an agent: the repo key of its working directory (the launcher's when it has none) by the one canonical resolver.
fn project_key(st: &State, a: &Agent) -> Option<String> {
    let cwd = if a.cwd.is_empty() { st.agents.get(&a.parent).map(|p| p.cwd.clone()).unwrap_or_default() } else { a.cwd.clone() };
    crate::meshw::ident::repo_key_for_worktree(&cwd).ok().flatten()
}

/// The newest live armed main session in the same project as the nudge's child (never `n.parent`); none when the child's project
/// cannot be told. A session of another project is never a target.
fn owner_in_project(env: &Env, st: &State, n: &Nudge) -> Option<String> {
    let want = project_key(st, st.agents.get(&n.child)?)?;
    let mut cands: Vec<&Agent> = st
        .agents
        .values()
        .filter(|m| (m.kind == kind_name("main") || escalate::primary(m)) && m.id != n.parent && super::sources::proc_live(m) && wake_armed(env, &m.id))
        .collect();
    cands.sort_by_key(|m| std::cmp::Reverse(m.last_output_ms));
    cands.into_iter().find(|m| project_key(st, m).as_deref() == Some(want.as_str())).map(|m| m.id.clone())
}

fn to_owner(env: &Env, st: &State, n: &Nudge, text: String) -> (String, String) {
    match owner_in_project(env, st, n) {
        Some(k) => {
            let p = send_to(env, &k, n, text);
            (k, p)
        }
        None => {
            let r = Reminder { id: format!("{}-{}", n.id, n.reminders), ts: env.now_ms, signal: word("signal").into(), agent: n.child.clone(), text };
            crate::discard::harmless(OwnerNotices.deliver(env, "", &r)); // keep: the event below records the escalation either way
            (word("owner_file").to_string(), word("path_notices").to_string())
        }
    }
}

fn escalate_now(env: &Env, st: &State, n: &mut Nudge, why: &str) {
    if n.escalated_at > 0 {
        return;
    }
    let text = defaults::render(
        "msg.agent_nudge_escalate",
        &[("kind", &n.child_kind), ("name", &n.child_name), ("parent", &n.parent), ("evidence", &n.ev_text), ("why", &why), ("answer", &answer_line(n))],
    );
    let (to, _) = to_owner(env, st, n, text);
    n.escalated_to = to;
    n.escalated_at = env.now_ms;
    emit(env, word("ev_escalated"), n);
}

/// The evidence of an unhealthy child, in plain words.
fn evidence(a: &Agent, sig: &str, f: &super::Flag, now: u64, why: &str) -> (String, u64, u64, String) {
    let ef = defaults::raw("agent_nudge.evidence_fmt");
    let min_ms = super::fmtn("ms_per_s") * 60;
    let idle_min = now.saturating_sub(a.last_output_ms) / min_ms;
    let step = a.pending.values().min_by_key(|p| p.ts).map(|p| format!("{} {}", p.name, p.label)).unwrap_or_else(|| f.text.clone());
    let step = super::cap(&step, lim("step_cap"));
    let spent = super::signals::tokens_since_outcome(a, now);
    let mut parts = Vec::new();
    if idle_min >= lim("idle_min_show") {
        parts.push(defaults::fill(ef.str_field("idle"), &[("min", &idle_min)]));
    }
    if !step.is_empty() && trigger_of(sig) != Some(defaults::raw("agent_nudge.triggers").str_field("agent_waste")) {
        parts.push(defaults::fill(ef.str_field("stuck"), &[("step", &step)]));
    }
    if spent > 0 && a.progress == f.base_progress {
        parts.push(defaults::fill(ef.str_field("waste"), &[("tokens", &tokens(spent))]));
    }
    if super::signals::waiting_on_ci(a) {
        parts.push(ef.str_field("ci_wait").to_string());
    }
    if !why.is_empty() {
        parts.push(why.to_string());
    }
    (parts.join(ef.str_field("join")), idle_min, spent, step)
}

/// What the outcomes line says of the owner: when they last spoke to this session, empty when not within the window.
fn owner_text(a: &Agent, now: u64) -> String {
    if a.owner_ms == 0 || now.saturating_sub(a.owner_ms) >= crate::agents::lim("owner_active_ms") {
        return String::new();
    }
    defaults::fill(defaults::raw("agent_nudge.evidence_fmt").str_field("owner"), &[("min", &(now.saturating_sub(a.owner_ms) / (super::fmtn("ms_per_s") * 60)))])
}

fn health_req(a: &Agent, now: u64) -> Value {
    let calls: Vec<String> = a.recent.iter().rev().take(lim("health_calls") as usize).rev().map(|r| super::cap(&r.1, lim("step_cap"))).collect();
    let goal: Vec<String> = [a.name.as_str(), a.step.as_str()].iter().filter(|s| !s.is_empty()).map(|s| super::cap(s, lim("step_cap"))).collect();
    let mut signals: Vec<String> = a.flags.iter().map(|(k, f)| format!("{k}: {}", super::cap(&f.text, lim("step_cap")))).collect();
    if super::signals::waiting_on_ci(a) {
        signals.push(defaults::raw("agent_nudge.evidence_fmt").str_field("ci_wait").to_string());
    }
    json!({
        "id": defaults::text("agent_nudge.health_integration"), "child": a.id, "dur": age(now.saturating_sub(super::started_ms(a))),
        "facts": {"tool_calls": calls.len()},
        "sections": {"goal": goal, "tool_calls": calls, "outcomes": [defaults::render("agent_nudge.outcomes_line", &[("commits", &a.commits), ("steps", &a.steps_done), ("checks", &a.tests_pass), ("files", &a.files.len()), ("reports", &a.reports), ("owner", &owner_text(a, now))])], "signals": signals},
        "blocking": false,
    })
}

/// A new nudge for every unhealthy child that has none open.
fn open_new(env: &Env, st: &mut State, budget: &mut u64) {
    let now = env.now_ms;
    let mut ids: Vec<(String, &'static str)> = Vec::new();
    let mut held: Vec<String> = Vec::new();
    let hold_snooze = env.switch("agent_nudge.snooze_setting");
    for a in st.agents.values() {
        if escalate::primary(a)
            || a.dead
            || st.nudges.contains_key(&a.id)
            || st.nudge_hold.get(&a.id).is_some_and(|t| *t > now)
            || super::signals::owner_active(env, a, now)
        {
            continue;
        }
        // a snooze still running for this child and trigger holds the re-raised condition: no new nudge (and no new ref) about it
        let snoozed = |trig: &str| hold_snooze && st.nudge_snooze.get(&snooze_key(&a.id, trig)).is_some_and(|s| s.until > now);
        let codex_hung = a.kind == kind_name("codex")
            && a.codex_exec
            && !a.codex_terminal
            && escalate::num("codex_hung_ms") > 0
            && now.saturating_sub(a.last_output_ms) >= escalate::num("codex_hung_ms");
        if codex_hung {
            let t = defaults::raw("agent_nudge.triggers").str_field("codex_hung");
            if snoozed(t) {
                held.push(snooze_key(&a.id, t));
            } else {
                ids.push((a.id.clone(), t));
            }
            continue;
        }
        if state_of(a) != state_name("running") {
            continue;
        }
        // the first trigger signal in the tracker's signal order (hung before waste)
        if let Some(t) = super::defaults_signals().iter().filter(|s| a.flags.contains_key(**s)).find_map(|s| trigger_of(s)) {
            if snoozed(t) {
                held.push(snooze_key(&a.id, t));
            } else {
                ids.push((a.id.clone(), t));
            }
        }
    }
    for k in held {
        if let Some(s) = st.nudge_snooze.get_mut(&k) {
            s.held += 1;
            if s.held == 1 {
                let (child, trig) = k.split_once('|').unwrap_or((&k, ""));
                rec(env, word("class"), word("ev_snooze_held"), Outcome::Advise, Fields::new().tok("agent", child).tok("trigger", trig).num("snoozes", s.snoozes).num("snooze_min", s.min));
            }
        }
    }
    for (id, trig) in ids {
        let Some(a) = st.agents.get(&id).cloned() else { continue };
        if a.kind == kind_name("codex") && escalate::codex_pid(&a).is_none() {
            st.nudge_hold.insert(id.clone(), now + lim("health_recheck_ms")); // no live one-shot process: nothing is hung
            continue;
        }
        let sig = super::defaults_signals().into_iter().find(|s| a.flags.contains_key(*s) && trigger_of(s) == Some(trig)).unwrap_or_default().to_string();
        let flag = a.flags.get(&sig).cloned().unwrap_or_default();
        // agentHealth: the judge decides when it can; busy holds the nudge for a re-check, anything else (or no verdict) nudges
        let (mut health, mut tier, mut agree, mut why) = (String::new(), String::new(), None, String::new());
        if *budget > 0 && env.switch("agent_nudge.setting") {
            *budget -= 1;
            let o = crate::jev::evidence::evaluate(&env.home, &crate::jev::Env::process(), &health_req(&a, now));
            if let Some(l) = o.label.clone().filter(|_| o.actionable) {
                let busy = l == defaults::text("agent_nudge.health_busy");
                agree = Some(!busy);
                health.clone_from(&l);
                tier.clone_from(&o.tier);
                why = defaults::fill(
                    defaults::raw("agent_nudge.evidence_fmt").str_field("judge"),
                    &[("label", &l), ("ref", &o.evidence_ref.clone().unwrap_or_default())],
                );
                rec(
                    env,
                    word("class"),
                    word("ev_health"),
                    Outcome::Advise,
                    base(&a).tok("health", &l).tok("tier", &o.tier).num("agree", if busy { 2 } else { 1 }).num("escalated", u64::from(o.escalated)),
                );
                if busy {
                    st.nudge_hold.insert(id.clone(), now + lim("health_recheck_ms"));
                    continue;
                }
            }
        }
        let (ev_text, idle_min, _, step) = evidence(&a, &sig, &flag, now, &why);
        let (direct, to, walked) = target(env, st, &a);
        let mut n = Nudge {
            id: format!("{:x}", crate::health::fnv(&format!("{}{now}", a.id))),
            ref_id: new_ref(st, &a.id, now),
            child: a.id.clone(),
            child_name: if a.name.is_empty() { a.id.clone() } else { super::cap(&a.name, lim("name_cap")) },
            child_kind: kind_word(&a).into(),
            direct_parent: direct.clone(),
            parent: to.clone().unwrap_or_default(),
            parent_kind: to.as_ref().and_then(|p| st.agents.get(p)).map(|p| p.kind.clone()).unwrap_or_default(),
            walked,
            trigger: trig.into(),
            signal: sig.clone(),
            ev_dur_ms: now.saturating_sub(super::started_ms(&a)),
            ev_tokens: super::signals::total_spent(&a),
            ev_idle_min: idle_min,
            ev_step: step,
            ev_outcomes: a.progress,
            ev_text,
            health,
            health_tier: tier,
            health_agree: agree,
            sent_at: now,
            last_sent: now,
            reminders: 1,
            // a snooze already taken for this child and trigger counts toward the escalation limit
            snoozes: st.nudge_snooze.get(&snooze_key(&a.id, trig)).filter(|_| hold_snooze).map_or(0, |s| s.snoozes),
            tokens_at_sent: super::signals::total_spent(&a),
            out_mark: a.last_output_ms,
            ..Nudge::default()
        };
        let note = if walked {
            defaults::render(
                "msg.agent_nudge_walked",
                &[("direct", &if direct.is_empty() { defaults::text("agent_nudge.unknown_parent").to_string() } else { direct.clone() })],
            )
        } else {
            String::new()
        };
        let text = defaults::render(
            "msg.agent_nudge",
            &[
                ("kind", &n.child_kind),
                ("name", &n.child_name),
                ("dur", &age(n.ev_dur_ms)),
                ("tokens", &tokens(n.ev_tokens)),
                ("evidence", &n.ev_text),
                ("walked", &note),
                ("answer", &answer_line(&n)),
            ],
        );
        n.last_text.clone_from(&text);
        match to {
            Some(p) => n.path = send_to(env, &p, &n, text),
            None => escalate_now(env, st, &mut n, defaults::text("agent_nudge.why_no_parent")),
        }
        emit(env, word("ev_sent"), &n);
        st.nudges.insert(id, n);
    }
}

fn close(env: &Env, st: &mut State, child: &str, outcome: &str) {
    let Some(mut n) = st.nudges.remove(child) else { return };
    let now = env.now_ms;
    n.outcome = outcome.into();
    n.outcome_at = now;
    n.tokens_after = st.agents.get(child).map_or(0, |a| super::signals::total_spent(a).saturating_sub(n.tokens_at_sent));
    emit(env, word("ev_resolved"), &n);
    // the child is over (or was stopped): its snoozes go with it; one that only made progress keeps them for the next spell
    if [out("finished"), out("child_died"), out("acted_stopped")].contains(&outcome) {
        st.nudge_snooze.retain(|k, _| k.split_once('|').is_none_or(|(c, _)| c != child));
    }
    st.nudge_log.push(n);
    let max = lim("log_max") as usize;
    if st.nudge_log.len() > max {
        st.nudge_log.drain(..st.nudge_log.len() - max);
    }
}

/// Follow every open nudge: verify, resolve, remind, escalate, act.
fn follow(env: &Env, st: &mut State) {
    let now = env.now_ms;
    let ids: Vec<String> = st.nudges.keys().cloned().collect();
    for id in ids {
        let Some(mut n) = st.nudges.get(&id).cloned() else { continue };
        let a = st.agents.get(&id).cloned();
        let stopped_word = ans("stop");
        let said_stop = n.answer_class == stopped_word || n.answer_class == ans("acted");
        let Some(a) = a else {
            close(env, st, &id, if said_stop { out("acted_stopped") } else { out("child_died") });
            continue;
        };
        if a.dead {
            close(env, st, &id, if said_stop { out("acted_stopped") } else { out("child_died") });
            continue;
        }
        let running = state_of(&a) == state_name("running") || (a.kind == kind_name("codex") && escalate::codex_pid(&a).is_some());
        if !running {
            close(env, st, &id, if said_stop { out("acted_stopped") } else { out("finished") });
            continue;
        }
        let unhealthy = a.flags.keys().any(|k| trigger_of(k).is_some()) || a.kind == kind_name("codex");
        if !unhealthy && a.last_output_ms > n.out_mark {
            close(env, st, &id, out("acted_progress"));
            continue;
        }
        let window = lim("window_ms");
        // a stop that did not happen, or a message that brought no output, falls back to reminding
        if said_stop && now.saturating_sub(n.answer_at) >= window {
            n.said_not_done += 1;
            n.outcome = out("said_not_done").into();
            emit(env, word("ev_said_not_done"), &n);
            n.answer_class.clear();
        } else if n.answer_class == ans("msg") && now.saturating_sub(n.answer_at) >= window {
            n.answer_class.clear();
        }
        // a wake-only delivery that no wake line confirmed in time is put in the reminder queue too (never after a recorded delivery)
        if env.switch("agent_nudge.once_setting")
            && n.path == word("path_wake")
            && n.last_delivered_at < n.last_sent
            && n.fallback_at < n.last_sent
            && !n.last_text.is_empty()
            && now.saturating_sub(n.last_sent) >= lim("wake_fallback_ms")
            && live(st, &n.parent)
        {
            let r = Reminder { id: format!("{}-{}-q", n.id, n.reminders), ts: now, signal: word("signal").into(), agent: n.child.clone(), text: n.last_text.clone() };
            if SessionQueue.deliver(env, &n.parent, &r).is_ok() {
                n.fallback_at = now;
                n.path = [n.path.as_str(), word("path_queue")].join(word("path_join"));
            }
        }
        let snoozed = n.snooze_until > now;
        if !snoozed && n.answer_class.is_empty() && now.saturating_sub(n.last_sent) >= lim("cadence_ms") {
            // a reminder after an expired snooze is not an ignored one
            if n.snooze_until == 0 {
                n.ignored += 1;
                emit(env, word("ev_ignored"), &n);
            }
            n.snooze_until = 0;
            if n.ignored >= lim("ignored_escalate") {
                escalate_now(env, st, &mut n, defaults::text("agent_nudge.why_ignored"));
            }
            if n.reminders >= lim("max_reminders") {
                st.nudges.insert(id.clone(), n);
                close(env, st, &id, out("ignored"));
                continue;
            }
            n.reminders += 1;
            n.last_sent = now;
            let text = defaults::render(
                "msg.agent_nudge_repeat",
                &[("n", &n.reminders), ("kind", &n.child_kind), ("name", &n.child_name), ("evidence", &n.ev_text), ("answer", &answer_line(&n))],
            );
            n.last_text.clone_from(&text);
            if live(st, &n.parent) {
                n.path = send_to(env, &n.parent.clone(), &n, text);
            } else {
                let (direct, to, walked) = target(env, st, &a);
                (n.direct_parent, n.walked) = (direct, walked);
                match to {
                    Some(p) => {
                        n.parent.clone_from(&p);
                        n.path = send_to(env, &p, &n, text);
                    }
                    None => escalate_now(env, st, &mut n, defaults::text("agent_nudge.why_no_parent")),
                }
            }
            emit(env, word("ev_reminded"), &n);
        }
        if n.escalated_at > 0 && n.acted_at == 0 && env.switch("agent_tracker.act_setting") && now.saturating_sub(n.sent_at) >= escalate::num("act_after_ms") {
            let (done, act_word) = escalate::act(st, &a, &n.parent);
            n.acted_at = now;
            let text = defaults::render("msg.agent_nudge_acted", &[("kind", &n.child_kind), ("name", &n.child_name), ("action", &done)]);
            to_owner(env, st, &n, text);
            rec(env, word("class"), word("ev_acted"), Outcome::Advise, ev(&n).tok("action", act_word));
        }
        st.nudges.insert(id, n);
    }
}

/// One notice to the direct parent (or nearest live ancestor in the child's project) of a child that just died. No question. A death
/// older than `dead_fresh_ms` is only recorded (telemetry), never announced; the fresh ones of one target are batched past
/// `dead_per_target` into a single summary line.
fn dead_notices(env: &Env, st: &mut State) {
    let now = env.now_ms;
    let ids: Vec<String> = st
        .agents
        .values()
        .filter(|a| a.dead && !a.dead_noticed && !escalate::primary(a) && now.saturating_sub(a.last_output_ms) <= lim("dead_notice_window_ms"))
        .map(|a| a.id.clone())
        .collect();
    // (target session or empty for the owner file) -> the nudges of this tick
    let mut groups: std::collections::BTreeMap<String, Vec<(Nudge, String)>> = std::collections::BTreeMap::new();
    for id in ids {
        let Some(a) = st.agents.get(&id).cloned() else { continue };
        let (direct, to, walked) = target(env, st, &a);
        let to = to.filter(|p| st.agents.get(p).is_none_or(|t| !walked || project_key(st, t).is_none() || project_key(st, t) == project_key(st, &a)));
        let why = if a.path.is_empty() || std::path::Path::new(&a.path).exists() {
            defaults::text("agent_nudge.dead_silent")
        } else {
            defaults::text("agent_nudge.dead_gone")
        };
        let n = Nudge {
            id: format!("{:x}", crate::health::fnv(&format!("{id}{now}dead"))),
            child: id.clone(),
            child_name: if a.name.is_empty() { a.id.clone() } else { super::cap(&a.name, lim("name_cap")) },
            child_kind: kind_word(&a).into(),
            direct_parent: direct,
            parent: to.clone().unwrap_or_default(),
            walked,
            trigger: word("trigger_dead").into(),
            sent_at: now,
            reminders: 1,
            outcome: out("child_died").into(),
            outcome_at: now,
            ..Nudge::default()
        };
        if let Some(m) = st.agents.get_mut(&id) {
            m.dead_noticed = true;
        }
        let since = now.saturating_sub(a.last_output_ms);
        if since > lim("dead_fresh_ms") {
            emit(env, word("ev_dead"), &n); // an old death: recorded, not announced
            st.nudge_log.push(n);
            continue;
        }
        let text = defaults::render("msg.agent_nudge_dead", &[("kind", &n.child_kind), ("name", &n.child_name), ("when", &age(since)), ("why", &why)]);
        groups.entry(to.unwrap_or_default()).or_default().push((n, text));
    }
    for (_, group) in groups {
        let cap = lim("dead_per_target") as usize;
        let batch = group.len() > cap;
        let summary = batch.then(|| {
            let a = st.agents.get(&group[0].0.child);
            let project = a
                .map(|a| {
                    if a.cwd.is_empty() {
                        a.id.clone()
                    } else {
                        std::path::Path::new(&a.cwd).file_name().map_or(a.cwd.clone(), |f| f.to_string_lossy().into_owned())
                    }
                })
                .unwrap_or_default();
            defaults::render("msg.agent_nudge_dead_batch", &[("n", &group.len()), ("project", &project)])
        });
        let mut path = String::new();
        for (i, (mut n, text)) in group.into_iter().enumerate() {
            if batch && i > 0 {
                n.path.clone_from(&path); // carried by the summary
            } else {
                let body = summary.clone().unwrap_or(text);
                n.path = if n.parent.is_empty() { to_owner(env, st, &n, body).1 } else { send_to(env, &n.parent.clone(), &n, body) };
                path.clone_from(&n.path);
            }
            emit(env, word("ev_dead"), &n);
            st.nudge_log.push(n);
        }
    }
}

/// The answers the verb appended since the last tick.
fn take_answers(env: &Env, st: &mut State) {
    let Ok(t) = std::fs::read_to_string(env.dir().join(defaults::raw("agent_nudge.paths").str_field("answers"))) else { return };
    let all: Vec<&str> = t.lines().collect();
    let from = (st.nudge_answer_lines as usize).min(all.len());
    for l in all.iter().skip(from).take(lim("answers_max") as usize) {
        st.nudge_answer_lines += 1;
        let Ok(v) = serde_json::from_str::<Value>(l) else { continue };
        let child = v["child"].as_str().unwrap_or("");
        let key = st
            .nudges
            .keys()
            .find(|k| *k == child)
            .cloned()
            .or_else(|| st.nudges.iter().find(|(_, n)| !n.ref_id.is_empty() && n.ref_id.eq_ignore_ascii_case(child)).map(|(k, _)| k.clone()))
            .or_else(|| st.nudges.iter().find(|(_, n)| n.child_name == child).map(|(k, _)| k.clone()));
        let Some(key) = key else { continue };
        let (class, text) = (v["answer"].as_str().unwrap_or("").to_string(), v["text"].as_str().unwrap_or("").to_string());
        record(env, st, &key, class, text, v["min"].as_u64().unwrap_or(0), src("verb"));
    }
}

/// Take one answer for the nudge about `key`: `class` is an answer word, or the prose word (classified by the nudgeReply judge, no
/// verdict = no answer). `source` says where it came from (verb, tool, prose).
fn record(env: &Env, st: &mut State, key: &str, mut class: String, text: String, asked_min: u64, source: &str) {
    let now = env.now_ms;
    let Some(mut n) = st.nudges.get(key).cloned() else { return };
    let key = key.to_string();
    let a = st.agents.get(&key).cloned().unwrap_or_default();
    n.answer = class.clone();
    if class == ans("prose") {
        let req = json!({"id": defaults::text("agent_nudge.reply_integration"), "child": key, "facts": {}, "sections": {"reply": [text], "child": [n.child_name, n.ev_text]}, "blocking": false});
        let o = crate::jev::evidence::evaluate(&env.home, &crate::jev::Env::process(), &req);
        class = o.label.filter(|_| o.actionable).unwrap_or_default();
        n.reason.clone_from(&text);
    }
    if class.is_empty() {
        emit(env, word("ev_answered"), &n);
        st.nudges.insert(key, n);
        return; // an unclassified reply counts as no answer
    }
    n.answer_class.clone_from(&class);
    n.answer_source = source.to_string();
    n.answer_at = now;
    if n.first_answer_at == 0 {
        n.first_answer_at = now;
    }
    n.out_mark = a.last_output_ms;
    if class == ans("msg") {
        n.reason.clone_from(&text);
    }
    if class == ans("snooze") || class == ans("other") {
        if class == ans("other") || !text.is_empty() {
            n.reason.clone_from(&text);
        }
        let asked = Some(asked_min).filter(|m| *m > 0 && class == ans("snooze")).unwrap_or(lim("snooze_default_min"));
        let mut min = asked.clamp(lim("snooze_min_min"), lim("snooze_max_min"));
        if !n.reason.is_empty() {
            let calls: Vec<String> = a.recent.iter().rev().take(lim("health_calls") as usize).rev().map(|r| super::cap(&r.1, lim("step_cap"))).collect();
            let req = json!({"id": defaults::text("agent_nudge.reason_integration"), "child": key, "facts": {"tool_calls": calls.len()}, "sections": {"reason": [n.reason], "tool_calls": calls, "signals": [n.ev_text]}, "blocking": false});
            let o = crate::jev::evidence::evaluate(&env.home, &crate::jev::Env::process(), &req);
            if let Some(l) = o.label.filter(|_| o.actionable) {
                let ok = l == defaults::text("agent_nudge.reason_plausible");
                n.reason_plausible = Some(ok);
                if !ok {
                    min = lim("snooze_min_min");
                }
            }
        }
        n.snooze_min = min;
        n.snoozes += 1;
        n.snooze_until = now + min * super::fmtn("ms_per_s") * 60;
        if env.switch("agent_nudge.snooze_setting") && !n.trigger.is_empty() {
            let s = st.nudge_snooze.entry(snooze_key(&n.child, &n.trigger)).or_default();
            (s.until, s.snoozes, s.min, s.held) = (n.snooze_until, n.snoozes, min, 0);
        }
        n.last_sent = now;
        n.answer_class.clear(); // a snooze ends in a reminder, not a verification
        n.outcome = out("snoozed").into();
        if n.snoozes >= lim("snoozes_escalate") {
            escalate_now(env, st, &mut n, defaults::text("agent_nudge.why_snoozed"));
        }
    }
    emit(env, word("ev_answered"), &n);
    st.nudges.insert(key, n);
}

/// The parents of open nudges are watched: their transcript reads keep the turns after the nudge (`facts::line`); an agent no open
/// nudge names stops being watched and drops its turns.
fn watch_parents(st: &mut State) {
    let parents: std::collections::HashSet<String> = st.nudges.values().map(|n| n.parent.clone()).collect();
    for a in st.agents.values_mut() {
        a.watch = parents.contains(&a.id);
        if !a.watch {
            a.turns.clear();
            if a.kind == kind_name("codex") {
                a.offset = 0; // a Codex rollout is read for turns from `offset` only while watched
            }
        }
    }
}

/// A short token for a new nudge: `limits.ref_len` characters of `agent_nudge.ref_alphabet`, unique among the open nudges.
fn new_ref(st: &State, child: &str, now: u64) -> String {
    let alpha: Vec<char> = defaults::text("agent_nudge.ref_alphabet").chars().collect();
    if alpha.is_empty() {
        return String::new();
    }
    for salt in 0..lim("ref_tries") {
        let mut h = crate::health::fnv(&format!("{child}{now}{salt}"));
        let r: String = (0..lim("ref_len"))
            .map(|_| {
                let c = alpha[(h % alpha.len() as u64) as usize];
                h /= alpha.len() as u64;
                c
            })
            .collect();
        if !st.nudges.values().any(|o| o.ref_id == r) {
            return r;
        }
    }
    String::new()
}

/// Parse a reply that starts with the nudge's ref: the text after the ref is `stop`, `msg <text>`, `snooze [N] [reason]` or `other
/// <reason>` (no model), or free words (returned as the prose word for the nudgeReply judge). Returns (class, text, minutes).
fn parse_ref_reply(after: &str) -> (String, String, u64) {
    let rest = after.trim_start_matches(|c: char| c.is_whitespace() || ":-,.;".contains(c)).trim();
    let (first, tail) = rest.split_once(char::is_whitespace).unwrap_or((rest, ""));
    let (first, tail) = (first.trim_matches(|c: char| !c.is_alphanumeric()).to_lowercase(), tail.trim());
    if first == ans("stop") {
        return (first, String::new(), 0);
    }
    if first == ans("msg") && !tail.is_empty() {
        return (first, tail.to_string(), 0);
    }
    if first == ans("snooze") {
        let (num, reason) = tail.split_once(char::is_whitespace).unwrap_or((tail, ""));
        return match num.parse::<u64>() {
            Ok(m) => (first, reason.trim_start_matches(|c: char| c.is_whitespace() || "-:,.".contains(c) || c == '\u{2014}').to_string(), m),
            Err(_) => (first, tail.to_string(), 0),
        };
    }
    if first == ans("other") && !tail.is_empty() {
        return (first, tail.to_string(), 0);
    }
    (ans("prose").to_string(), rest.to_string(), 0)
}

/// Where the text after the nudge's ref starts, when the ref stands as a whole token: at the start of the text or after a character
/// that is not a letter or digit, and followed by `:`, whitespace or the end.
fn ref_end(text: &str, tag: &str) -> Option<usize> {
    let (b, n) = (text.as_bytes(), tag.len());
    if n == 0 || b.len() < n {
        return None;
    }
    (0..=b.len() - n).find_map(|i| {
        let hit = b[i..i + n].eq_ignore_ascii_case(tag.as_bytes()) && text.is_char_boundary(i) && text.is_char_boundary(i + n);
        // only a hit on char boundaries may be sliced; slicing a non-hit byte offset inside a multi-byte char (e.g. an en dash) panics
        if !hit {
            return None;
        }
        let before = text[..i].chars().next_back().is_none_or(|c| !c.is_alphanumeric());
        let after = text[i + n..].chars().next().is_none_or(|c| c == ':' || c.is_whitespace());
        (before && after).then_some(i + n)
    })
}

fn match_words(k: &str) -> Vec<String> {
    defaults::raw("agent_nudge.match").get(k).map(V::strings).unwrap_or_default().into_iter().map(|w| w.to_lowercase()).collect()
}

/// Whether free text names the child: its id, or its name when the name is long enough to be unambiguous.
fn names_child(n: &Nudge, text: &str) -> bool {
    let t = text.to_lowercase();
    let (id, name) = (n.child.to_lowercase(), n.child_name.to_lowercase());
    (!id.is_empty() && t.contains(&id)) || (name.chars().count() >= lim("match_name_min") as usize && t.contains(&name))
}

/// The answer a recorded tool turn gives about the child: stop (TaskStop, KillShell, `agents stop`), msg (SendMessage, `agents send`),
/// acted (a spawn that replaces it). A tool turn is `<tool>\t<value>\t<value>...` (see `facts::turn`); the child is matched on id, name
/// or label as a whole value, or inside a command.
fn tool_answer(n: &Nudge, turn: &str) -> Option<&'static str> {
    let mut parts = turn.split('\t');
    let tool = parts.next()?.to_lowercase();
    let vals: Vec<&str> = parts.collect();
    let (id, name) = (n.child.to_lowercase(), n.child_name.to_lowercase());
    let whole = |v: &str| {
        let v = v.to_lowercase();
        !v.is_empty() && (v == id || v == name || (v.chars().count() >= lim("match_id_prefix_min") as usize && id.starts_with(&v)))
    };
    let in_tools = |k: &str| match_words(k).contains(&tool);
    if in_tools("shell_tools") {
        let cmd = vals.join(" ");
        if !names_child(n, &cmd) {
            return None;
        }
        let lc = cmd.to_lowercase();
        let has = |k: &str| defaults::text(&format!("agent_nudge.match_{k}")).to_lowercase();
        return if lc.contains(&has("stop_cmd")) {
            Some(ans("stop"))
        } else if lc.contains(&has("send_cmd")) {
            Some(ans("msg"))
        } else {
            None
        };
    }
    if in_tools("stop_tools") && vals.iter().any(|v| whole(v)) {
        return Some(ans("stop"));
    }
    if in_tools("msg_tools") && vals.iter().any(|v| whole(v)) {
        return Some(ans("msg"));
    }
    if in_tools("spawn_tools") && vals.iter().any(|v| whole(v) || (id.len() >= lim("match_id_prefix_min") as usize && v.to_lowercase().contains(&id))) {
        return Some(ans("acted"));
    }
    None
}

/// Match the parent's turns after the nudge was delivered to the nudge: a tool call that stops, messages or replaces the child (no
/// model), else a reply that mentions it (classified by nudgeReply). The verb is handled first (`take_answers`); a nudge with an
/// answer pending takes none here.
fn take_turns(env: &Env, st: &mut State) {
    let mut budget = lim("prose_per_tick");
    let ids: Vec<String> = st.nudges.keys().cloned().collect();
    let refs = match_words("ref_words");
    for id in ids {
        let Some(n) = st.nudges.get(&id).cloned() else { continue };
        if n.delivered_at == 0 || !n.answer_class.is_empty() || n.snooze_until > env.now_ms {
            continue;
        }
        // a parent not watched yet (a nudge that went further up, or one open before the watch existed): read its turns since the
        // delivery straight from the part of its transcript the tracker already consumed
        if let Some(p) = st.agents.get_mut(&n.parent).filter(|p| !p.watch) {
            p.watch = true;
            super::facts::replay_turns(p, n.delivered_at);
        }
        let Some(parent) = st.agents.get(&n.parent) else { continue };
        let from = n.delivered_at.max(n.turns_from);
        let new: Vec<(u64, String, String)> = parent.turns.iter().filter(|t| t.0 > from).cloned().collect();
        let Some(newest) = new.iter().map(|t| t.0).max() else { continue };
        if let Some(n) = st.nudges.get_mut(&id) {
            n.turns_from = newest;
        }
        let tag = n.ref_id.to_lowercase();
        let tagged = new.iter().rev().filter(|t| t.1 == defaults::text("agent_nudge.match_text_kind")).find_map(|t| {
            let after = ref_end(&t.2, &tag)?;
            Some(parse_ref_reply(&t.2[after..]))
        });
        if let Some((class, text, min)) = tagged
            && (class != ans("prose") || budget > 0)
        {
            if class == ans("prose") {
                budget -= 1;
            }
            record(env, st, &id, class, super::cap(&text, lim("reason_cap")), min, src("ref"));
            continue;
        }
        let tool = new
            .iter()
            .filter(|t| t.1 == defaults::text("agent_nudge.match_tool_kind"))
            .find_map(|t| tool_answer(&n, &t.2).map(|c| (c, t.2.replace('\t', " "))));
        if let Some((class, text)) = tool {
            record(env, st, &id, class.into(), super::cap(&text, lim("reason_cap")), 0, src("tool"));
            continue;
        }
        // a reply that does not name the child still counts when this parent has just this one nudge open
        let alone = st.nudges.values().filter(|o| o.parent == n.parent).count() == 1;
        let prose = new.iter().rev().filter(|t| t.1 == defaults::text("agent_nudge.match_text_kind")).find(|t| {
            let l = t.2.to_lowercase();
            names_child(&n, &t.2) || (alone && refs.iter().any(|w| l.contains(w.as_str())))
        });
        if let Some(t) = prose.filter(|_| budget > 0) {
            budget -= 1;
            record(env, st, &id, ans("prose").into(), super::cap(&t.2, lim("reason_cap")), 0, src("prose"));
        }
    }
}

/// Stamp `delivered_at` / `delivered_to` of the nudge a delivered row names.
pub(crate) fn delivered(st: &mut State, v: &Value, ts: u64) -> bool {
    if v["signal"].as_str() != Some(word("signal")) {
        return false;
    }
    if let Some(n) = v["agent"].as_str().and_then(|c| st.nudges.get_mut(c)) {
        n.last_delivered_at = n.last_delivered_at.max(ts);
        if n.delivered_at == 0 {
            n.delivered_at = ts;
            n.delivered_to = v["key"].as_str().unwrap_or("").to_string();
        }
    }
    true
}

/// The tracker signal a nudge delivery row stands for: the row carries the nudge's own signal word, the flag it answers is the child's
/// trigger signal of that nudge. `None` for any other row (the row's own signal names its flag).
pub(crate) fn flag_signal(st: &State, v: &Value) -> Option<String> {
    if v["signal"].as_str() != Some(word("signal")) {
        return None;
    }
    v["agent"].as_str().and_then(|c| st.nudges.get(c)).map(|n| n.signal.clone()).filter(|s| !s.is_empty())
}

/// One nudge pass, after the signals of this tick.
pub(crate) fn tick(env: &Env, st: &mut State) {
    if !env.act || !env.switch("agent_nudge.setting") {
        return;
    }
    take_answers(env, st);
    take_turns(env, st);
    follow(env, st);
    dead_notices(env, st);
    let mut budget = lim("health_per_tick");
    open_new(env, st, &mut budget);
    watch_parents(st);
    let now = env.now_ms;
    st.nudge_hold.retain(|_, t| *t > now);
    let forget = lim("snooze_forget_ms");
    let agents = &st.agents;
    st.nudge_snooze.retain(|k, s| now < s.until.saturating_add(forget) && k.split_once('|').is_some_and(|(c, _)| agents.contains_key(c)));
}

// ---- the answer verb and the data API -------------------------------------------------------------------------

/// A snooze of `asked` minutes inside the configured range: the minutes given, and the message key that says it was changed (none
/// when the value was in range).
pub(super) fn clamp_snooze(asked: u64) -> (u64, Option<&'static str>) {
    let (lo, hi) = (lim("snooze_min_min"), lim("snooze_max_min"));
    let given = asked.clamp(lo, hi);
    let key = if asked > hi {
        Some("msg.agent_nudge_snooze_clamped")
    } else if asked < lo {
        Some("msg.agent_nudge_snooze_floor")
    } else {
        None
    };
    (given, key)
}

/// `ah-engine agents nudge <child> stop | msg "<text>" | snooze <min> ["reason"] | other "<reason>" | <prose>`.
pub fn run_answer(p: &Parsed) -> i32 {
    let Some(env) = Env::current() else { return 64 };
    let args: Vec<&str> = p.rest.iter().skip(1).map(String::as_str).collect();
    let usage = || {
        println!("{}", defaults::render("msg.agent_nudge_usage", &[("cmd", &defaults::text("agent_nudge.cmd"))]));
        64
    };
    let Some((child, rest)) = args.split_first() else { return usage() };
    let Some((first, tail)) = rest.split_first() else { return usage() };
    let joined = tail.join(" ");
    let (answer, text, min) = match *first {
        w if w == ans("stop") => (w, String::new(), 0),
        w if w == ans("msg") => (w, joined, 0),
        w if w == ans("snooze") => {
            let m = tail.first().and_then(|t| t.parse::<u64>().ok()).unwrap_or(0);
            (w, tail.iter().skip(usize::from(m > 0)).copied().collect::<Vec<_>>().join(" "), m)
        }
        w if w == ans("other") => {
            if joined.trim().is_empty() {
                println!("{}", defaults::text("msg.agent_nudge_need_reason"));
                return 64;
            }
            (w, joined, 0)
        }
        _ => (ans("prose"), rest.join(" "), 0),
    };
    // a snooze outside the configured range is clamped here, where the owner can be told; a value is never recorded silently
    let (asked, mut note) = (min, String::new());
    let mut min = min;
    if answer == ans("snooze") && min > 0 {
        let (given, key) = clamp_snooze(asked);
        min = given;
        if let Some(key) = key {
            note = defaults::render(key, &[("child", child), ("min", &min), ("max", &lim("snooze_max_min")), ("asked", &asked)]);
        }
    }
    let mut row = json!({"ts": env.now_ms, "child": child, "answer": answer, "text": super::cap(&text, lim("reason_cap")), "min": min});
    if !note.is_empty() {
        row["asked"] = json!(asked);
        row["clamped"] = json!(true);
    }
    match sinks::append(&env.dir().join(defaults::raw("agent_nudge.paths").str_field("answers")), &row) {
        Ok(()) => {
            let said = defaults::render("msg.agent_nudge_recorded", &[("child", child), ("answer", &answer)]);
            println!("{}", if p.json { row.to_string() } else if note.is_empty() { said } else { format!("{said}\n{note}") });
            0
        }
        Err(e) => {
            eprintln!("{e}");
            1
        }
    }
}

fn row(n: &Nudge) -> Value {
    serde_json::to_value(n).unwrap_or(Value::Null)
}

fn median(mut v: Vec<u64>) -> Option<u64> {
    v.sort_unstable();
    (!v.is_empty()).then(|| v[v.len() / 2])
}

/// The roll-up of the nudges sent at or after `since`.
fn rollup(all: &[&Nudge], since: u64) -> Value {
    let ns: Vec<&&Nudge> = all.iter().filter(|n| n.sent_at >= since && n.trigger != word("trigger_dead")).collect();
    let total = ns.len() as u64;
    let pct = |c: usize| (c as u64 * super::fmtn("pct")).checked_div(total).unwrap_or(0);
    let acted = [out("acted_stopped"), out("acted_progress"), out("finished")];
    let count = |f: &dyn Fn(&Nudge) -> bool| ns.iter().filter(|n| f(n)).count();
    let mut by_trigger = serde_json::Map::new();
    for n in &ns {
        let e = by_trigger.entry(n.trigger.clone()).or_insert(json!(0));
        *e = json!(e.as_u64().unwrap_or(0) + 1);
    }
    let mut ignorers: std::collections::BTreeMap<&str, u64> = std::collections::BTreeMap::new();
    for n in &ns {
        *ignorers.entry(n.parent.as_str()).or_default() += n.ignored;
    }
    let mut top: Vec<(&str, u64)> = ignorers.into_iter().filter(|(_, c)| *c > 0).collect();
    top.sort_by_key(|(_, c)| std::cmp::Reverse(*c));
    top.truncate(lim("top_parents") as usize);
    let by_source: serde_json::Map<String, Value> = [src("verb"), src("ref"), src("tool"), src("prose"), src("none")]
        .iter()
        .map(|k| ((*k).to_string(), json!(count(&|n| if n.answer_source.is_empty() { *k == src("none") } else { n.answer_source == *k }))))
        .collect();
    let resolved_acted = |n: &Nudge| acted.contains(&n.outcome.as_str());
    json!({
        "since_ms": since, "sent": total, "by_trigger": by_trigger,
        "acted_pct": pct(count(&resolved_acted)),
        "said_not_done_pct": pct(count(&|n| n.said_not_done > 0)),
        "snoozed_pct": pct(count(&|n| n.snoozes > 0 && n.reason.is_empty())),
        "other_pct": pct(count(&|n| n.snoozes > 0 && !n.reason.is_empty())),
        "ignored_pct": pct(count(&|n| n.ignored > 0 && n.first_answer_at == 0)),
        "escalated_pct": pct(count(&|n| n.escalated_at > 0)),
        "by_answer_source": by_source,
        "open": count(&|n| n.outcome_at == 0),
        "median_answer_s": median(ns.iter().filter(|n| n.first_answer_at > 0).map(|n| (n.first_answer_at - n.sent_at) / super::fmtn("ms_per_s")).collect()),
        "median_act_s": median(ns.iter().filter(|n| resolved_acted(n)).map(|n| n.outcome_at.saturating_sub(n.sent_at) / super::fmtn("ms_per_s")).collect()),
        "tokens_after_acted": ns.iter().filter(|n| resolved_acted(n)).map(|n| n.tokens_after).sum::<u64>(),
        "tokens_after_not_acted": ns.iter().filter(|n| n.outcome_at > 0 && !resolved_acted(n)).map(|n| n.tokens_after).sum::<u64>(),
        "top_ignoring_parents": top.iter().map(|(p, c)| json!({"parent": p, "ignored": c})).collect::<Vec<_>>(),
    })
}

/// The document of `query nudges` / `query nudge_rollup`: every kept nudge (open first) and the roll-ups (today, and since the
/// daemon started when it runs).
pub fn document() -> Value {
    let Some(env) = Env::current() else { return json!({"nudges": []}) };
    let st = super::load_state(&env);
    let all: Vec<&Nudge> = st.nudges.values().chain(st.nudge_log.iter().rev()).collect();
    let day = super::fmtn("day_ms");
    let started = crate::client::status_value()
        .get(defaults::text("agent_nudge.daemon_uptime_key"))
        .and_then(Value::as_u64)
        .map(|up| env.now_ms.saturating_sub(up * super::fmtn("ms_per_s")));
    let windowed = |w: &str, since: u64| {
        let mut r = rollup(&all, since);
        r["window"] = json!(w);
        r
    };
    let mut rollups = vec![windowed(word("window_today"), env.now_ms / day * day)];
    if let Some(s) = started {
        rollups.push(windowed(word("window_daemon"), s));
    }
    json!({"nudges": all.iter().map(|n| row(n)).collect::<Vec<_>>(), "rollup": rollups})
}
