//! `lead_waiting_on_done` (GH #958): a lead session (main or workspace) whose turn ended, with nothing running and nothing armed, while
//! teammates it started are finished and still hold work for it (an open task they own, or a result that arrived after its last word).
//! It is the tick's own signal: it needs no prompt, so an idle lead hears it through the wake feed. Thresholds and texts are config
//! (`nudges.lead_wait`, `msg.agent_lead_waiting*`); the escalation from advice to order is the number of earlier reminders.
use super::compliance::{self, Task};
use super::signals::{Raised, state_of};
use super::{Agent, Env, State, lim, state_name};
use crate::defaults::{self, V};

fn num(t: &V, k: &str) -> u64 {
    t.get(k).and_then(V::as_integer).unwrap_or(0).max(0) as u64
}

/// Evidence: the finished teammates; text: their names, joined.
pub(super) fn raised(env: &Env, a: &Agent, st: &State, tasks: &[Task], now: u64) -> Option<Raised> {
    let c = defaults::raw("nudges.lead_wait");
    if !compliance::watched(env, a) || a.running || a.last_output_ms == 0 || compliance::covered(a, now) {
        return None;
    }
    let idle = now.saturating_sub(a.last_output_ms);
    if idle < num(c, "min_ms") || idle > lim("active_window_ms") {
        return None;
    }
    let states: Vec<&str> = c.get("states").map(V::strings).unwrap_or_default().into_iter().map(state_name).collect();
    let kids: Vec<&Agent> = st.agents.values().filter(|s| super::is_child(s) && s.parent == a.id && !s.dead).collect();
    if kids.iter().any(|s| super::signals::running(s)) {
        return None; // real cover: a teammate is still working
    }
    let closed = defaults::raw("nudges.idle_wake").get("closed_statuses").map(V::strings).unwrap_or_default();
    let mut names: Vec<String> = kids
        .iter()
        .filter(|s| states.contains(&state_of(s)))
        .filter(|s| s.last_output_ms > a.last_output_ms || tasks.iter().any(|t| !closed.contains(&t.status.as_str()) && !t.owner.is_empty() && (t.owner == s.name || t.owner == s.id)))
        .map(|s| if s.name.is_empty() { s.id.clone() } else { s.name.clone() })
        .collect();
    names.sort();
    names.dedup();
    if names.is_empty() {
        return None;
    }
    Some((names.len() as u64, names.iter().take(num(c, "shown") as usize).cloned().collect::<Vec<_>>().join(c.str_field("joiner"))))
}

/// The reminder text: advice first, the order once `order_after` reminders went out and were ignored.
pub(super) fn text(a: &Agent, evidence: u64, agents: &str, idle_ms: u64) -> String {
    let c = defaults::raw("nudges.lead_wait");
    let sent = a.sent_log.iter().filter(|(s, _)| s == "lead_waiting_on_done").count() as u64;
    let key = if sent >= num(c, "order_after") { "msg.agent_lead_waiting_order" } else { "msg.agent_lead_waiting" };
    defaults::render(key, &[("agents", &agents), ("n", &evidence), ("idle", &super::sinks::age(idle_ms)), ("sent", &sent)])
}
