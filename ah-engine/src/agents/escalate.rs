//! The owner's channel and the stop actions for stuck agents (task #207), used by the nudge loop (`nudge`).
//!
//! A nudge goes to an agent's direct parent first; only a parent that is not live, or that ignores or keeps snoozing the nudge
//! past its limits, sends it on to the owner's channel (the newest live main session with an armed wake-watch, else the owner
//! notices file). An escalated nudge still open past `agent_tracker.escalate.act_after_ms` runs the action of the child's kind,
//! while `agents.actOnStuck` is on: a one-shot Codex run is sent SIGTERM by the single pid of a one-shot process that holds its
//! rollout open, re-checked right before (a shared Codex server holds many sessions' rollouts and never matches); a DevSwarm
//! workspace gets the `agents send --stop-request` path; a subagent or teammate (no process of its own) is named to its live
//! coordinator with a stop request. Nothing is killed without a pid match and nothing by name. Primaries are never acted on.
//!
//! Every limit, kind, word and text is in `engine/defaults/agent_tracker.toml`.
use super::ctl::{self, Send};
use super::{Agent, Env, State, kind_name};
use crate::defaults::{self, V};

pub(super) fn cfg() -> &'static V {
    defaults::raw("agent_tracker.escalate")
}
pub(super) fn num(k: &str) -> u64 {
    cfg().get(k).and_then(V::as_integer).unwrap_or(0).max(0) as u64
}
fn list(k: &str) -> Vec<&'static str> {
    cfg().get(k).map(V::strings).unwrap_or_default()
}
pub(super) fn word(k: &str) -> &'static str {
    defaults::raw("agent_tracker.escalate_words").str_field(k)
}

/// A Primary: exempt from the duration limits and never nudged about (the main session, or a DevSwarm Primary's session).
pub(super) fn primary(a: &Agent) -> bool {
    list("exempt_kinds").contains(&a.kind.as_str()) || a.ws.as_ref().is_some_and(|w| w.id.starts_with(defaults::text("agent_tracker.primary_prefix")))
}

/// The processes that hold `path` open, with their command lines.
fn holders(path: &str) -> Vec<(u32, String)> {
    let table = super::procs::snapshot();
    super::procs::openers(path).into_iter().filter_map(|o| table.iter().find(|q| q.pid == o.pid).map(|q| (q.pid, q.cmd.clone()))).collect()
}

/// The one-shot Codex process that holds the rollout open: only a command that names a one-shot run (`term_cmds`) qualifies.
/// `None` unless exactly one such pid matches (and it is no host session and not this process).
pub(super) fn codex_pid(a: &Agent) -> Option<u32> {
    let cmds = list("term_cmds");
    let pids: std::collections::BTreeSet<u32> = holders(&a.path).into_iter().filter(|(_, c)| cmds.iter().any(|w| c.contains(w))).map(|(p, _)| p).collect();
    let host = ctl::session_pids();
    (pids.len() == 1).then(|| pids.into_iter().next()).flatten().filter(|p| !host.contains(p) && *p != std::process::id())
}

/// The session that launched a Codex run: walk up from a process holding its rollout to a process the host registry lists.
pub(super) fn codex_parent(env: &Env, a: &Agent) -> Option<String> {
    let sessions = super::live::registry(env)?;
    let depth = defaults::num("agent_tracker.wake_walk_depth");
    for (pid, _) in holders(&a.path) {
        let mut p = pid;
        for _ in 0..depth {
            if let Some(s) = sessions.iter().find(|s| s.pid == p) {
                return Some(s.id.clone());
            }
            p = crate::procid::parent(p)?;
        }
    }
    None
}

/// SIGTERM the Codex run's process after re-reading that the same pid still holds the rollout open.
fn stop_codex(a: &Agent) -> Option<u32> {
    let pid = codex_pid(a)?;
    let still = codex_pid(a) == Some(pid);
    // SAFETY: kill(2) with a pid re-verified to hold this rollout open, SIGTERM only; no memory is touched.
    (still && unsafe { libc::kill(pid as libc::pid_t, libc::SIGTERM) } == 0).then_some(pid)
}

/// The action for a child whose escalated nudge stayed open past `act_after_ms`: the sentence that says what was done, and the
/// telemetry word. `parent` is the live session the nudge went to (empty when none).
pub(super) fn act(st: &State, a: &Agent, parent: &str) -> (String, &'static str) {
    let none = || (defaults::text("msg.agent_act_none").to_string(), word("act_none"));
    if primary(a) {
        return none();
    }
    if a.kind == kind_name("codex") {
        return match stop_codex(a) {
            Some(pid) => (defaults::render("msg.agent_act_codex", &[("pid", &pid)]), word("act_term")),
            None => none(),
        };
    }
    if a.kind == kind_name("workspace") {
        return match ctl::send(&a.id, Send::Stop) {
            Ok(_) => (defaults::text("msg.agent_act_workspace").to_string(), word("act_stop_request")),
            Err(_) => none(),
        };
    }
    match st.agents.get(parent).filter(|c| super::sources::proc_live(c)) {
        Some(c) => {
            let ask = defaults::render("msg.agent_act_child_request", &[("agent", &a.id), ("name", &a.name)]);
            match ctl::send(&c.id, Send::Message(&ask)) {
                Ok(_) => (defaults::render("msg.agent_act_child", &[("parent", &c.id)]), word("act_stop_request")),
                Err(_) => none(),
            }
        }
        None => none(),
    }
}
