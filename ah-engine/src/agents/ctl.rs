//! Dashboard access to the agent tracker: the document for `CTL agents`, and the actions on one agent (`agents send`).
//!
//! `send` queues one reminder in the agent's session queue (the `agent-reminders` check puts it in front of the agent at its next
//! prompt or tool call) and, when a live `agents wake-watch` covers the session, a wake row too, so an idle session is woken. These
//! are the tracker's own sinks: there is no second way to reach an agent, and nothing here kills one. `heartbeat` only reads.
use super::sinks::{Reminder, SessionQueue, Sink, WakeFeed, key_of, wake_armed};
use super::{Env, State, load_state, pth};
use crate::cli::Parsed;
use crate::defaults;
use serde_json::{Value, json};
use std::time::UNIX_EPOCH;

fn env() -> Result<Env, String> {
    Env::current().ok_or_else(|| defaults::text("act.msg_no_env").to_string())
}

/// What `agents send` puts in the queue.
pub enum Send<'a> {
    /// Ask for a short status.
    Progress,
    /// Ask the agent to stop by itself.
    Stop,
    /// A free message.
    Message(&'a str),
}

/// Queue `what` for `session`, and a wake row when a watcher is armed.
pub fn send(session: &str, what: Send<'_>) -> Result<Value, String> {
    let env = env()?;
    let (signal, text) = match what {
        Send::Progress => (defaults::text("act.progress_signal"), defaults::text("agent_tracker.progress_request_text")),
        Send::Stop => (defaults::text("act.stop_signal"), defaults::text("agent_tracker.stop_request_text")),
        Send::Message(t) => (defaults::text("act.message_signal"), t),
    };
    let r = Reminder { id: format!("{}-{signal}-{}", key_of(session), env.now_ms), ts: env.now_ms, signal: signal.to_string(), agent: session.to_string(), text: text.to_string() };
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

/// The pids of the Claude and Codex sessions the host lists: processes the dashboard never signals.
pub fn session_pids() -> Vec<u32> {
    env().ok().and_then(|e| super::live::registry(&e)).map(|v| v.into_iter().map(|s| s.pid).collect()).unwrap_or_default()
}

/// The tracker revision: the state file's modified time and size. The scheduled tick rewrites the file, so the revision moves exactly
/// when the tracker learned something; reading it costs one `stat`.
fn rev(env: &Env) -> String {
    let m = std::fs::metadata(env.dir().join(pth("state"))).ok();
    let ms = m.as_ref().and_then(|m| m.modified().ok()).and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map_or(0, |d| d.as_millis());
    format!("{ms}-{}", m.map_or(0, |m| m.len()))
}

/// `CTL agents [since=<rev>] [agent=<id>]`: the status document of the last tick plus `rev`; `since` equal to the current revision
/// answers `{"unchanged": true}`. With `agent=`, the rows are that agent's and the document adds its reminder `backlog`.
pub fn document(since: Option<&str>, agent: Option<&str>) -> Value {
    let Ok(env) = env() else { return json!({"error": defaults::text("act.msg_no_env")}) };
    let rev = rev(&env);
    if since == Some(rev.as_str()) {
        return json!({"unchanged": true, "rev": rev});
    }
    let st: State = load_state(&env);
    let mut doc = super::status::document(&env, &st, &super::sources::Listing::default());
    doc["rev"] = json!(rev);
    if let Some(id) = agent {
        if let Some(rows) = doc["agents"].as_array_mut() {
            rows.retain(|r| r["agent"] == json!(id));
            for r in rows.iter_mut() {
                r["backlog"] = json!(SessionQueue.backlog(&env, id));
            }
        }
    } else if let Some(rows) = doc["agents"].as_array_mut() {
        for r in rows.iter_mut() {
            let first = st.agents.get(r["agent"].as_str().unwrap_or("")).map_or(0, |a| a.first_seen);
            r["started_ms"] = json!(first);
        }
    }
    doc
}

/// `ah-engine agents send <id> [--progress-request|--ping|--stop-request|--text <message>]`.
pub fn run_send(p: &Parsed) -> i32 {
    let (progress, ping, stop, text_flag) = (defaults::text("act.flag_progress"), defaults::text("act.flag_ping"), defaults::text("act.flag_stop"), defaults::text("act.flag_text"));
    let (mut id, mut text, mut it) = (None, None, p.rest.iter().skip(1));
    while let Some(a) = it.next() {
        if a == text_flag {
            text = it.next().cloned();
        } else if !a.starts_with("--") && id.is_none() {
            id = Some(a.clone());
        }
    }
    let has = |f: &str| p.rest.iter().any(|a| a == f);
    let Some(id) = id else {
        println!("{}", defaults::text("act.msg_send_usage"));
        return 64;
    };
    let (action, done) = if has(ping) {
        ("ping", heartbeat(&id))
    } else if has(stop) {
        ("stop-request", send(&id, Send::Stop))
    } else if let Some(t) = text.as_deref().filter(|_| !has(progress)) {
        ("message", send(&id, Send::Message(t)))
    } else {
        ("progress-request", send(&id, Send::Progress))
    };
    crate::web::actions::finish(p, "agent", action, &id, false, done.map_err(|e| (false, e)))
}

/// The transcript file the tracker follows for agent `id` (from the last tick's state), when it has one.
pub fn transcript_path(id: &str) -> Option<String> {
    let env = env().ok()?;
    load_state(&env).agents.get(id).map(|a| a.path.clone()).filter(|p| !p.is_empty())
}
