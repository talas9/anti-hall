//! `ah-engine agents wake-watch [--auto]`: the wake Monitor of a session. The host runs it as a Monitor (armed at SessionStart by the
//! plugin's monitor entry): every line it prints on stdout is an event delivered to the session, so a session that went idle is woken
//! when the tracker queues a wake row for it (an agent idle with an open task, a looping or burning agent, a watched process that
//! ended). It only stats and reads one file of its own session while quiet: no tokens, no commands.
//!
//! The tracker writes the rows ([`super::sinks::WakeFeed`]); this process only reads them, prints each once, and renews a stamp that
//! tells the tracker the session can be woken (the `monitor_unarmed` signal reads it). Everything it says, waits and names is config.
use super::sinks::WakeFeed;
use super::{Env, lim, pth};
use crate::cli::Parsed;
use crate::defaults;
use serde_json::Value;
use std::io::Write;
use std::path::Path;
use std::time::Duration;

fn setting_num(key: &str) -> u64 {
    defaults::num(key).max(1)
}

/// The session this watcher belongs to: the first of the configured variables that is set.
fn session(env: &Env) -> Option<String> {
    defaults::list("agent_tracker.wake_session_env")
        .into_iter()
        .filter_map(|v| env.settings.env.get(v).cloned())
        .find(|s| !s.trim().is_empty())
        .or_else(|| session_from_tree(env, std::process::id()))
}

/// A Monitor's shell carries no session variable: walk up from `start` (at most `wake_walk_depth` parents) to the process the host
/// registered for a session and take its session id.
pub(crate) fn session_from_tree(env: &Env, start: u32) -> Option<String> {
    let sessions = super::live::registry(env)?;
    let mut pid = start;
    for _ in 0..=defaults::num("agent_tracker.wake_walk_depth") {
        if let Some(s) = sessions.iter().find(|s| s.pid == pid) {
            return Some(s.id.clone());
        }
        pid = crate::procid::parent(pid).filter(|p| *p > 1)?;
    }
    None
}

fn parent_gone(start: i32) -> bool {
    if start <= 0 {
        return false;
    }
    // SAFETY: getppid(2) takes no arguments and cannot fail.
    let cur = unsafe { libc::getppid() };
    cur != start || cur == 1
}

fn stamp(path: &Path, now: u64) {
    if let Some(d) = path.parent() {
        crate::discard::harmless(std::fs::create_dir_all(d)); // keep: the write below reports a missing directory
    }
    let body = serde_json::json!({"pid": std::process::id(), "ts": now}).to_string();
    crate::discard::harmless(crate::atomic::write(path, body)); // keep: a missed stamp only makes the next tick re-stamp
}

/// Another live watcher already holds a fresh stamp for this session.
fn held_elsewhere(env: &Env, path: &Path) -> bool {
    let fresh = crate::checks::agent_scan::mtime_ms(path).is_some_and(|m| env.now_ms.saturating_sub(m as u64) <= lim("stale_lock_ms"));
    let pid = std::fs::read_to_string(path).ok().and_then(|t| serde_json::from_str::<Value>(&t).ok()).and_then(|v| v["pid"].as_u64());
    fresh && pid.is_some_and(|p| p as u32 != std::process::id() && crate::health::pid_alive(p as u32))
}

fn emit(line: &str) {
    let mut out = std::io::stdout().lock();
    crate::discard::harmless(out.write_all(format!("{line}\n").as_bytes())); // keep: a closed pipe ends the parent check, not the loop
    crate::discard::harmless(out.flush()); // keep: same
}

/// New complete rows of the feed since `offset`; returns the lines to print and the new offset.
fn drain(feed: &Path, offset: u64) -> (Vec<String>, u64) {
    let Ok(t) = std::fs::read(feed) else { return (Vec::new(), offset) };
    let len = t.len() as u64;
    if len < offset {
        return (Vec::new(), 0);
    }
    let tail = &t[offset as usize..];
    let end = tail.iter().rposition(|b| *b == b'\n').map_or(0, |i| i + 1);
    let lines = String::from_utf8_lossy(&tail[..end])
        .lines()
        .filter_map(|l| serde_json::from_str::<Value>(l).ok())
        .filter_map(|v| v["text"].as_str().map(|t| defaults::render("msg.agent_wake_line", &[("text", &t)])))
        .collect();
    (lines, offset + end as u64)
}

/// Run the watcher until the process that started it is gone. Returns the exit code.
pub(crate) fn run(p: &Parsed) -> i32 {
    let auto = p.rest.iter().any(|a| a == defaults::text("agent_tracker.wake_flag_auto"));
    let Some(env) = Env::current() else { return 0 };
    let refuse = |why: &str| {
        if !auto {
            emit(&defaults::render("msg.agent_wake_refused", &[("reason", &why)]));
        }
        0
    };
    if !env.switch("agent_tracker.setting") || !env.switch("agent_tracker.wake_setting") {
        return refuse(defaults::text("msg.agent_wake_reason_off"));
    }
    let Some(sid) = session(&env) else { return refuse(defaults::text("msg.agent_wake_reason_no_session")) };
    let armed = WakeFeed::stamp(&env, &sid);
    if held_elsewhere(&env, &armed) {
        return refuse(defaults::text("msg.agent_wake_reason_held"));
    }
    // SAFETY: getppid(2) takes no arguments and cannot fail.
    let start_ppid = unsafe { libc::getppid() };
    let poll = Duration::from_millis(setting_num("agent_tracker.wake_poll_ms"));
    pump(&env, &sid, poll, &mut |l| emit(l), &|| parent_gone(start_ppid));
    0
}

/// The loop of the watcher: renew the stamp, print each new row of the session's feed once, stop when `stop` says so. Rows from before
/// the watcher armed are not replayed (the reminder queue still delivers them at the next turn).
pub(crate) fn pump(env: &Env, sid: &str, poll: Duration, out: &mut dyn FnMut(&str), stop: &dyn Fn() -> bool) {
    let (feed, armed) = (WakeFeed::file(env, sid), WakeFeed::stamp(env, sid));
    let mut offset = std::fs::metadata(&feed).map(|m| m.len()).unwrap_or(0);
    let every = setting_num("agent_tracker.wake_stamp_ms");
    let mut last_stamp = 0u64;
    loop {
        let now = crate::health::now_ms();
        if now.saturating_sub(last_stamp) >= every {
            stamp(&armed, now);
            last_stamp = now;
        }
        let (lines, next) = drain(&feed, offset);
        lines.iter().for_each(|l| out(l));
        if next != offset {
            offset = next;
            let mut cur = feed.clone().into_os_string();
            cur.push(pth("cursor_ext"));
            crate::discard::harmless(crate::atomic::write_styled(
                cur,
                drain_count(&feed, offset).to_string(),
                crate::atomic::Style { skip_sync: true, ..Default::default() },
            )); // keep: only delays the compaction of the feed
        }
        if stop() {
            crate::discard::harmless(std::fs::remove_file(&armed)); // keep: a stale stamp expires on its own
            return;
        }
        std::thread::sleep(poll);
    }
}

/// Lines in the feed up to `offset` (the cursor file counts rows, like the reminder queue's).
fn drain_count(feed: &Path, offset: u64) -> u64 {
    std::fs::read(feed).map(|t| t[..(offset as usize).min(t.len())].iter().filter(|b| **b == b'\n').count() as u64).unwrap_or(0)
}
