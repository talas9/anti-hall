//! Dashboard actions on one agent: ask it for progress through the reminder and wake route, and read its heartbeat.
//!
//! `request_progress` queues one reminder in the agent's session queue (the `agent-reminders` check puts it in front of the agent at
//! its next prompt or tool call) and, when a live `agents wake-watch` covers the session, a wake row too, so an idle session is
//! woken. These are the tracker's own sinks: there is no second way to reach an agent. `heartbeat` only reads.
use super::sinks::{Reminder, SessionQueue, Sink, WakeFeed, key_of, wake_armed};
use super::{Env, pth};
use crate::defaults;
use serde_json::{Value, json};

fn env() -> Result<Env, String> {
    Env::current().ok_or_else(|| defaults::text("node.msg_no_env").to_string())
}

/// Queue a progress request for `session` (the dashboard's own text, or `text` when given).
pub fn request_progress(session: &str, text: Option<&str>) -> Result<Value, String> {
    let env = env()?;
    let r = Reminder {
        id: format!("{}-{}-{}", key_of(session), defaults::text("node.progress_signal"), env.now_ms),
        ts: env.now_ms,
        signal: defaults::text("node.progress_signal").to_string(),
        agent: session.to_string(),
        text: text.filter(|t| !t.is_empty()).unwrap_or(defaults::text("node.progress_text")).to_string(),
    };
    SessionQueue.deliver(&env, session, &r)?;
    let woken = wake_armed(&env, session);
    if woken {
        WakeFeed.deliver(&env, session, &r)?;
    }
    Ok(json!({"session": session, "queued": true, "wake_row": woken, "backlog": SessionQueue.backlog(&env, session)}))
}

/// What is known of `session` without waking it: whether the host still lists its process, its wake stamp, its reminder backlog,
/// and the heartbeat file of an agent that writes one.
pub fn heartbeat(session: &str) -> Result<Value, String> {
    let env = env()?;
    let live = super::live::registry(&env).and_then(|all| all.into_iter().find(|s| s.id == session));
    let stamp_age = crate::checks::agent_scan::mtime_ms(&WakeFeed::stamp(&env, session)).map(|m| env.now_ms.saturating_sub(m as u64));
    let fields = defaults::raw("agent_tracker.devswarm_fields");
    let hb = env.base().join(pth("heartbeats")).join(format!("{}{}", key_of(session), pth("json_ext")));
    let hb = std::fs::read_to_string(&hb).ok().and_then(|t| serde_json::from_str::<Value>(&t).ok()).map(|v| {
        let ts = v.get(fields.str_field("hb_ts")).and_then(Value::as_u64).unwrap_or(0);
        json!({"ts": ts, "age_ms": env.now_ms.saturating_sub(ts), "status": v.get(fields.str_field("hb_status")).cloned().unwrap_or(Value::Null),
            "step": v.get(fields.str_field("hb_step")).cloned().unwrap_or(Value::Null)})
    });
    Ok(json!({"session": session, "live": live.is_some(), "pid": live.as_ref().map(|s| s.pid), "status": live.as_ref().map(|s| s.status.clone()),
        "wake_armed": wake_armed(&env, session), "wake_stamp_age_ms": stamp_age, "backlog": SessionQueue.backlog(&env, session), "heartbeat": hb}))
}
