//! Escalation and action for stuck agents (task #207): a flag the coordinator has not handled is taken to the owner, and an agent
//! that stays stuck is stopped, by the means its kind allows.
//!
//! The reminder routes queue a flag for the coordinator (the session that launched the agent). When that session has no live process
//! the queue is never read, and when it is live but does nothing the flag stays up for hours. So, for the signals listed in
//! `agent_tracker.escalate` and agents that are not Primaries (the main session and a DevSwarm Primary may run for hours):
//! - **escalate**, once per spell: the flag is up `after_ms`, or the coordinator has no live process, so a wake row and a queued
//!   reminder go to the owner's session (the coordinator itself when it is live and its wake-watch is armed, else the newest live main
//!   session with an armed wake-watch); the owner notices file also gets it when no such session exists or `agents.ownerNotify` is on.
//! - **act**, once per spell, while `agents.actOnStuck` is on (default on): the flag is up `act_after_ms`. A Codex session is sent
//!   SIGTERM by the pid that holds its rollout file open, re-checked right before; a DevSwarm workspace is asked to stop with the
//!   `agents send --stop-request` path; a subagent or teammate (no process of its own) is named to its live coordinator with a stop
//!   request. Nothing is killed without a pid match and nothing by name.
//!
//! Every limit, kind, word and text is in `engine/defaults/agent_tracker.toml`.
use super::ctl::{self, Send};
use super::signals::{base, rec};
use super::sinks::{OwnerNotices, Reminder, SessionQueue, Sink, WakeFeed, age, wake_armed};
use super::{Agent, Env, State, kind_name};
use crate::defaults::{self, V};
use crate::telemetry::event::Outcome;

fn cfg() -> &'static V {
    defaults::raw("agent_tracker.escalate")
}
fn num(k: &str) -> u64 {
    cfg().get(k).and_then(V::as_integer).unwrap_or(0).max(0) as u64
}
fn list(k: &str) -> Vec<&'static str> {
    cfg().get(k).map(V::strings).unwrap_or_default()
}
fn word(k: &str) -> &'static str {
    defaults::raw("agent_tracker.escalate_words").str_field(k)
}

/// A Primary: exempt from the duration limits (the main session, or a DevSwarm Primary's workspace session).
fn primary(a: &Agent) -> bool {
    list("exempt_kinds").contains(&a.kind.as_str()) || a.ws.as_ref().is_some_and(|w| w.id.starts_with(defaults::text("agent_tracker.primary_prefix")))
}

/// The session that launched the agent, when it is tracked.
fn coordinator<'a>(st: &'a State, a: &Agent) -> Option<&'a Agent> {
    (super::is_child(a) && a.parent != a.id).then(|| st.agents.get(&a.parent)).flatten()
}

/// The owner's wake channel: the coordinator when it is live and armed, else the newest live main session with an armed wake-watch.
fn owner_session(env: &Env, st: &State, a: &Agent) -> Option<String> {
    let reachable = |m: &Agent| m.id != a.id && super::sources::proc_live(m) && wake_armed(env, &m.id);
    if let Some(c) = coordinator(st, a).filter(|c| reachable(c)) {
        return Some(c.id.clone());
    }
    st.agents.values().filter(|m| m.kind == kind_name("main") && reachable(m)).max_by_key(|m| m.last_output_ms).map(|m| m.id.clone())
}

fn reminder(a: &Agent, sig: &str, now: u64, text: String) -> Reminder {
    Reminder { id: format!("{:x}", crate::health::fnv(&format!("{}{sig}{now}{}", a.id, word("class")))), ts: now, signal: sig.into(), agent: a.id.clone(), text }
}

/// The one-shot Codex process that holds the rollout open: only a command that names a one-shot run (`term_cmds`) qualifies, since a
/// shared Codex server holds many sessions' rollouts open and is never signalled. `None` unless exactly one such pid matches.
fn codex_pid(a: &Agent) -> Option<u32> {
    let cmds = list("term_cmds");
    let table = super::procs::snapshot();
    let pids: std::collections::BTreeSet<u32> = super::procs::openers(&a.path)
        .into_iter()
        .filter(|o| table.iter().find(|q| q.pid == o.pid).is_some_and(|q| cmds.iter().any(|c| q.cmd.contains(c))))
        .map(|o| o.pid)
        .collect();
    let host = ctl::session_pids();
    (pids.len() == 1).then(|| pids.into_iter().next()).flatten().filter(|p| !host.contains(p) && *p != std::process::id())
}

/// SIGTERM the Codex run's process after re-reading that the same pid still holds the rollout open.
fn stop_codex(a: &Agent) -> Option<u32> {
    let pid = codex_pid(a)?;
    let still = codex_pid(a) == Some(pid);
    // SAFETY: kill(2) with a pid re-verified to hold this rollout open, SIGTERM only; no memory is touched.
    (still && unsafe { libc::kill(pid as libc::pid_t, libc::SIGTERM) } == 0).then_some(pid)
}

/// The action for an agent stuck past `act_after_ms`: the sentence that says what was done, and the telemetry word.
fn act(st: &State, a: &Agent) -> (String, &'static str) {
    if a.kind == kind_name("codex") {
        return match stop_codex(a) {
            Some(pid) => (defaults::render("msg.agent_act_codex", &[("pid", &pid)]), word("act_term")),
            None => (defaults::text("msg.agent_act_none").to_string(), word("act_none")),
        };
    }
    if a.kind == kind_name("workspace") {
        return match ctl::send(&a.id, Send::Stop) {
            Ok(_) => (defaults::text("msg.agent_act_workspace").to_string(), word("act_stop_request")),
            Err(_) => (defaults::text("msg.agent_act_none").to_string(), word("act_none")),
        };
    }
    match coordinator(st, a).filter(|c| super::sources::proc_live(c)) {
        Some(c) => {
            let ask = defaults::render("msg.agent_act_child_request", &[("agent", &a.id), ("name", &a.name)]);
            match ctl::send(&c.id, Send::Message(&ask)) {
                Ok(_) => (defaults::render("msg.agent_act_child", &[("parent", &c.id)]), word("act_stop_request")),
                Err(_) => (defaults::text("msg.agent_act_none").to_string(), word("act_none")),
            }
        }
        None => (defaults::text("msg.agent_act_none").to_string(), word("act_none")),
    }
}

/// A one-shot Codex run that went quiet past `codex_hung_ms` without a terminal record (the tracker already lists it done by its
/// quiet rule) but whose process still holds the rollout open is hung: stop it by pid, once, and tell the owner. A run with no such
/// process ended without its record and is left alone.
fn codex_pass(env: &Env, st: &mut State, acting: bool) {
    let now = env.now_ms;
    let limit = num("codex_hung_ms");
    let ids: Vec<String> = st
        .agents
        .values()
        .filter(|a| a.kind == kind_name("codex") && a.codex_exec && !a.codex_terminal && a.acted_at == 0 && limit > 0 && now.saturating_sub(a.last_output_ms) >= limit)
        .map(|a| a.id.clone())
        .collect();
    for id in ids {
        let Some(a) = st.agents.get(&id).cloned() else { continue };
        if let Some(m) = st.agents.get_mut(&id) {
            m.acted_at = now;
        }
        if codex_pid(&a).is_none() {
            continue;
        }
        let (done, act_word) = if acting { act(st, &a) } else { (String::new(), "") };
        let sig = word("codex_signal");
        let name = if a.name.is_empty() { a.id.as_str() } else { a.name.as_str() };
        let text = defaults::render(
            "msg.agent_escalate",
            &[("kind", &a.kind), ("agent", &name), ("signal", &sig), ("age", &age(now.saturating_sub(a.last_output_ms))), ("parent", &a.cwd), ("why", &word("why_codex_quiet")), ("action", &done)],
        );
        let r = reminder(&a, sig, now, text);
        let owner = owner_session(env, st, &a);
        let mut sent = false;
        if let Some(k) = &owner {
            sent |= WakeFeed.deliver(env, k, &r).is_ok();
        }
        if owner.is_none() || env.switch("agent_tracker.owner_setting") {
            sent |= OwnerNotices.deliver(env, "", &r).is_ok();
        }
        rec(env, word("class"), word("acted"), if sent { Outcome::Advise } else { Outcome::Skip }, base(&a).tok("source", sig).tok("action", act_word));
    }
}

/// One pass over the flagged agents (after the reminders of this tick were queued).
pub(crate) fn tick(env: &Env, st: &mut State) {
    if !env.act || !env.switch("agent_tracker.remind_setting") {
        return;
    }
    let now = env.now_ms;
    codex_pass(env, st, env.switch("agent_tracker.act_setting"));
    let signals = list("signals");
    let acting = env.switch("agent_tracker.act_setting");
    let ids: Vec<String> = st.agents.iter().filter(|(_, a)| !primary(a) && a.flags.keys().any(|k| signals.contains(&k.as_str()))).map(|(k, _)| k.clone()).collect();
    for id in ids {
        let Some(a) = st.agents.get(&id).cloned() else { continue };
        for (sig, f) in a.flags.iter().filter(|(k, _)| signals.contains(&k.as_str())) {
            let up = now.saturating_sub(f.since);
            let down = super::is_child(&a) && !coordinator(st, &a).is_some_and(super::sources::proc_live);
            let escalate = f.escalated_at == 0 && (down || up >= num("after_ms"));
            let action = acting && f.acted_at == 0 && up >= num("act_after_ms");
            if !escalate && !action {
                continue;
            }
            let (done, act_word) = if action { act(st, &a) } else { (String::new(), "") };
            let why = if down {
                word("why_parent_down")
            } else if f.delivered_at == 0 {
                word("why_undelivered")
            } else {
                word("why_unhandled")
            };
            let name = if a.name.is_empty() { a.id.as_str() } else { a.name.as_str() };
            let text = defaults::render(
                "msg.agent_escalate",
                &[("kind", &a.kind), ("agent", &name), ("signal", sig), ("age", &age(up)), ("parent", &a.parent), ("why", &why), ("action", &done)],
            );
            let r = reminder(&a, sig, now, text);
            let owner = owner_session(env, st, &a);
            let mut sent = false;
            if let Some(k) = &owner {
                sent |= WakeFeed.deliver(env, k, &r).is_ok();
                sent |= SessionQueue.deliver(env, k, &r).is_ok();
            }
            if owner.is_none() || env.switch("agent_tracker.owner_setting") {
                sent |= OwnerNotices.deliver(env, "", &r).is_ok();
            }
            let fields = base(&a).tok("source", sig).tok("result", why).tok("action", act_word).tok("channel", owner.as_deref().map_or(super::chan("owner_file"), |_| super::chan("wake")));
            rec(env, word("class"), if action { word("acted") } else { word("escalated") }, if sent { Outcome::Advise } else { Outcome::Skip }, fields);
            if let Some(m) = st.agents.get_mut(&id).and_then(|m| m.flags.get_mut(sig.as_str())) {
                if m.escalated_at == 0 {
                    m.escalated_at = now;
                }
                if action {
                    m.acted_at = now;
                }
            }
        }
    }
}
