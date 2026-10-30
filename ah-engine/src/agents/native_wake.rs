//! The native wake of an idle DevSwarm workspace. A mailbox row, a reminder in the session queue or a wake row only reach a session
//! that takes another turn by itself; a workspace that finished its turn and waits for a human (no Monitor or cron armed, or one the host
//! does not deliver to a pane waiting on a prompt) read none of them for hours. The one verb DevSwarm offers that starts a turn in an
//! idle pane is `workspace reactivate-child`: it queues a durable pane-addressed prompt and nudges the runtime to pull it. It is not a
//! message verb (the mesh stays the only message channel), and the prompt it carries only tells the workspace to read its mesh inbox.
//!
//! [`wake`] is called after a mesh `send` to a workspace and by `agents send`. It acts only when the tracker already knows the workspace
//! and reads it as idle; it never kills or archives anything, and a workspace is woken at most once per `cooldown_ms`.
use super::{Env, load_state, signals, state_name};
use crate::defaults::{self, V};
use crate::meshw::hivecontrol;
use serde_json::{Value, json};
use std::collections::HashMap;
use std::path::PathBuf;
use std::time::Duration;

fn num(k: &str) -> u64 {
    defaults::raw("agent_tracker.native_wake").get(k).and_then(V::as_integer).unwrap_or(0).max(0) as u64
}

/// The hivecontrol arguments of one step (`info_args`, `reactivate_args`), from the plugin's agent_tracker.native_wake table.
fn args(k: &str) -> Vec<&'static str> {
    defaults::raw("agent_tracker.native_wake").get(k).map(V::strings).unwrap_or_default()
}

fn stamp_file(env: &Env, id: &str) -> PathBuf {
    let cfg = defaults::raw("agent_tracker.native_wake");
    env.base().join(cfg.str_field("dir")).join(format!("{id}{}", super::pth("json_ext")))
}

fn last_wake(env: &Env, id: &str) -> u64 {
    std::fs::read_to_string(stamp_file(env, id)).ok().and_then(|t| serde_json::from_str::<Value>(&t).ok()).and_then(|v| v["ts"].as_u64()).unwrap_or(0)
}

/// The text a failed call reports: the CLI's own stderr, else its stdout, else the spawn error.
fn why(f: &hivecontrol::Full) -> String {
    let e = f.stderr.trim();
    let e = if e.is_empty() { f.call.raw.trim() } else { e };
    let e = if e.is_empty() { f.call.error.as_str() } else { e };
    super::cap(e, num("text_cap"))
}

/// Wake workspace `who` (its id or its session id) when the tracker reads it as idle. `env` and `cwd` are the caller's: DevSwarm
/// answers `reactivate-child` only for the parent of the workspace, and the CLI finds the caller from its environment. `None`: nothing to
/// do (not a workspace the tracker knows, still working, woken lately, or the switch is off). `Some`: what was attempted.
pub(crate) fn wake(home: &std::path::Path, who: &str, preview: &str, env: &HashMap<String, String>, cwd: Option<&str>) -> Option<Value> {
    let mut tr = Env::current()?;
    tr.home = home.to_path_buf();
    if !tr.switch("agent_tracker.wake_setting") {
        return None;
    }
    let desc = crate::dswire::facts::descriptors(&tr.home).into_iter().find(|d| d.id == who || d.session == who)?;
    let st = load_state(&tr);
    let a = st.agents.get(&desc.session)?;
    let idle_ms = tr.now_ms.saturating_sub(a.last_output_ms);
    if a.dead || a.gone || a.finished || (signals::state_of(a) == state_name("running") && idle_ms < num("idle_ms")) {
        return None;
    }
    if tr.now_ms.saturating_sub(last_wake(&tr, &desc.id)) < num("cooldown_ms") {
        return None;
    }
    // wake only for a real pending delivery: unread mesh mail (wake rows are not counted) or a reminder still queued for the session
    // (an unreadable mail store is not "none": the wake goes ahead)
    let no_mail = crate::devswarm_rt::sources::Probe::unread(&crate::devswarm_rt::sources::FsProbe::new(home, tr.now_ms as i64), &desc.id) == Some(0);
    if no_mail && super::sinks::Sink::backlog(&super::sinks::SessionQueue, &tr, &desc.session) == 0 {
        return None;
    }
    let call = |argv: &[&str]| hivecontrol::call_full(argv, env, cwd, Duration::from_millis(num("timeout_ms")));
    let info = call(&[args("info_args").as_slice(), &[desc.id.as_str()]].concat());
    let branch = serde_json::from_str::<Value>(&info.call.raw).ok().and_then(|v| v["branch"].as_str().map(str::to_string)).filter(|b| !b.is_empty());
    let Some(branch) = branch else {
        return Some(json!({"workspace": desc.id, "woken": false, "step": "info", "error": why(&info)}));
    };
    let prompt = defaults::render(
        "msg.native_wake_prompt",
        &[("prefix", &defaults::text("agent_tracker.wake_prefix")), ("id", &desc.id), ("text", &super::cap(preview, num("text_cap")))],
    );
    let done = call(&[args("reactivate_args").as_slice(), &[branch.as_str(), prompt.as_str()]].concat());
    let woken = done.call.ok;
    if woken {
        let stamp = json!({"ts": tr.now_ms}).to_string();
        let path = stamp_file(&tr, &desc.id);
        if let Some(d) = path.parent() {
            crate::discard::harmless(std::fs::create_dir_all(d)); // keep: the write below reports a missing directory
        }
        crate::discard::harmless(crate::atomic::write(path, stamp)); // keep: a missed stamp only allows an earlier second wake
    }
    let mut out = json!({"workspace": desc.id, "branch": branch, "woken": woken, "idle_ms": idle_ms});
    if woken {
        out["result"] = serde_json::from_str(&done.call.raw).unwrap_or(Value::Null);
    } else {
        out["error"] = json!(why(&done));
    }
    Some(out)
}
