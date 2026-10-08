//! The Stop-loop guard (D74): a Stop or SubagentStop that exits 2 tells the host to keep the agent going, so a dispatcher
//! that fails closed there on a state it cannot repair (plugin root unset, a hook that cannot spawn) would keep the agent
//! from ever finishing. Mirrors the `stop_hook_active` check of the Node Stop hooks (`devswarm-child-gate.js`,
//! `compact-advice-guard.js`), and adds a per-session cap on consecutive fail-closed blocks.
//!
//! The payload flag is the host's own "a Stop hook already blocked this turn" signal. The cap (`dispatch.stop_block_cap`)
//! covers the payloads that cannot carry it (unreadable, cut off) and a host that does not set it. The count lives in a
//! file per session under the state dir, because every Stop is a new process.
// Discard triage (E3): every `.ok()` / `unwrap_or_default()` in this file is a deliberate keep, for these reasons:
// - an unreadable optional file is the same as an absent one (fail-open, as Node's try/catch)
// A failure that must be seen goes through `crate::discard` instead.

use crate::defaults;
use serde_json::Value;
use std::path::PathBuf;

/// What a fail-closed Stop or SubagentStop does.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Verdict {
    /// Block (exit 2).
    Block,
    /// Fail open (exit 0) with this note on stderr.
    Open(String),
}

/// True for an event that must not block forever (`dispatch.stop_events`).
pub fn is_stop_event(event: &str) -> bool {
    defaults::list("dispatch.stop_events").contains(&event)
}

fn safe(payload: Option<&Value>, field: &str) -> String {
    let v = payload.and_then(|p| p.get(field)).and_then(Value::as_str).unwrap_or("");
    v.chars().filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_').take(defaults::num("dispatch.stop_id_max_chars") as usize).collect()
}

fn dir() -> PathBuf {
    crate::paths::dir().join(defaults::text("dispatch.stop_state_dir"))
}

/// The counter file: one per event, session and (for a SubagentStop) agent, so one looping agent's cap is not restarted
/// by another's healthy run. A payload that names no session shares the `dispatch.stop_unknown_session` key.
fn counter(payload: Option<&Value>, event: &str) -> PathBuf {
    // The ids may hold `-` and `_` (see `safe`), so a `-` join can make two different (session, agent) pairs one file name:
    // "a-b" + "c" and "a" + "b-c". `.` is outside the allowed set, so it separates the parts without ambiguity, and a
    // payload with no session is tagged `u` (the shared `dispatch.stop_unknown_session` key) where a named one is tagged `s`.
    let session = safe(payload, "session_id");
    let mut name = if session.is_empty() { format!("{event}.u.{}", defaults::text("dispatch.stop_unknown_session")) } else { format!("{event}.s.{session}") };
    let agent = safe(payload, "agent_id");
    if !agent.is_empty() {
        name = format!("{name}.a.{agent}");
    }
    dir().join(name)
}

/// Remove the counter files not touched for `dispatch.stop_state_max_age_days` (sessions that ended while blocked).
fn prune() {
    let max = std::time::Duration::from_secs(defaults::num("dispatch.stop_state_max_age_days") * 86_400);
    let Ok(rd) = std::fs::read_dir(dir()) else { return };
    for e in rd.flatten() {
        let old = e.metadata().and_then(|m| m.modified()).ok().and_then(|t| t.elapsed().ok()).is_some_and(|age| age > max);
        // a `.lock` file is the mutex of its counter: unlinking it while a judge holds it lets a second judge lock a fresh inode and count unserialized
        let is_lock = e.file_name().to_string_lossy().ends_with(defaults::text("paths.lock_suffix"));
        if old && !is_lock && e.file_type().is_ok_and(|t| t.is_file()) {
            crate::discard::harmless(std::fs::remove_file(e.path())); // keep: cleanup that raced; an absent file is the goal state
        }
    }
}

/// Take an exclusive lock through `try_lock`, retrying an interrupted call (EINTR); any other error is a lock that is not held.
fn lock_ex(mut try_lock: impl FnMut() -> std::io::Result<()>) -> bool {
    loop {
        match try_lock() {
            Ok(()) => return true,
            Err(e) if e.kind() == std::io::ErrorKind::Interrupted => {}
            Err(_) => return false,
        }
    }
}

/// A fail-closed `event` is about to block: decide whether it may. The payload's `stop_hook_active` true fails open; so
/// does a count of consecutive blocks at the cap (it stays open until the guards run fine again), or a count that cannot be recorded (an unbounded loop is worse).
pub fn judge(event: &str, payload: Option<&Value>, why: &str) -> Verdict {
    if payload.and_then(|p| p.get("stop_hook_active")).and_then(Value::as_bool) == Some(true) {
        return Verdict::Open(defaults::render("dispatch.msg_stop_active", &[("event", &event), ("why", &why)]));
    }
    prune();
    let path = counter(payload, event);
    let cap = defaults::num("dispatch.stop_block_cap");
    // two Stops of one session at once must not both read n and write n+1 (review finding 11): the read-increment-write
    // runs under an exclusive lock on the counter's lock file; the count is replaced atomically
    let lock = path
        .parent()
        .filter(|d| crate::limits::ensure_private_dir(d).is_ok())
        .and_then(|_| std::fs::OpenOptions::new().create(true).truncate(false).write(true).open(crate::paths::lock_for(&path)).ok());
    // SAFETY: the descriptor belongs to `lock`, which outlives the call; flock takes only it and a flag.
    let _held = lock.as_ref().is_some_and(|f| lock_ex(|| if unsafe { libc::flock(std::os::unix::io::AsRawFd::as_raw_fd(f), libc::LOCK_EX) } == 0 { Ok(()) } else { Err(std::io::Error::last_os_error()) }));
    let seen: u64 = std::fs::read_to_string(&path).ok().and_then(|t| t.trim().parse().ok()).unwrap_or(0);
    if seen >= cap {
        return Verdict::Open(defaults::render("dispatch.msg_stop_capped", &[("event", &event), ("cap", &cap), ("why", &why)]));
    }
    // a lock that could not be taken does not allow the Stop: the count is still kept (unserialized, so a race may undercount
    // by one, which only errs toward the cap); only a count that cannot be written opens
    let recorded = crate::atomic::write(&path, (seen + 1).to_string()).is_ok();
    if recorded { Verdict::Block } else { Verdict::Open(defaults::render("dispatch.msg_stop_uncounted", &[("event", &event), ("why", &why)])) }
}

/// The guards ran fine for `event`: the run of consecutive blocks is over.
/// A payload-less block counts under the shared unknown key, so a healthy run clears that one too.
pub fn reset(event: &str, payload: Option<&Value>) {
    if is_stop_event(event) {
        crate::discard::harmless(std::fs::remove_file(counter(payload, event))); // keep: cleanup that raced; an absent file is the goal state
        crate::discard::harmless(std::fs::remove_file(counter(None, event))); // keep: cleanup that raced; an absent file is the goal state
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn concurrent_stops_of_one_session_count_every_block_once() {
        // review finding 11: the read-increment-write was unlocked, so two Stops at once could both write n+1
        let p = json!({"session_id": format!("race{}", std::process::id())});
        let blocks: usize = std::thread::scope(|sc| {
            let hs: Vec<_> = (0..8).map(|_| sc.spawn(|| judge("Stop", Some(&p), "why") == Verdict::Block)).collect();
            hs.into_iter().map(|h| usize::from(h.join().unwrap())).sum()
        });
        let cap = defaults::num("dispatch.stop_block_cap") as usize;
        assert_eq!(blocks, cap.min(8), "every block up to the cap, no more");
        let seen: usize = std::fs::read_to_string(counter(Some(&p), "Stop")).unwrap().trim().parse().unwrap();
        assert_eq!(seen, blocks, "the counter holds exactly the blocks given");
        reset("Stop", Some(&p));
    }

    #[test]
    fn an_interrupted_lock_is_retried_and_a_failed_one_still_counts() {
        // P2-4: EINTR read as "uncounted" and allowed the Stop
        let mut n = 0;
        assert!(lock_ex(|| {
            n += 1;
            if n < 4 { Err(std::io::Error::from_raw_os_error(libc::EINTR)) } else { Ok(()) }
        }));
        assert_eq!(n, 4);
        assert!(!lock_ex(|| Err(std::io::Error::from_raw_os_error(libc::EBADF))));
    }

    #[test]
    fn prune_keeps_lock_files_and_removes_old_counters() {
        let p = json!({"session_id": format!("prune{}", std::process::id())});
        let c = counter(Some(&p), "Stop");
        std::fs::create_dir_all(c.parent().unwrap()).unwrap();
        let l = crate::paths::lock_for(&c);
        std::fs::write(&c, "1").unwrap();
        std::fs::write(&l, "").unwrap();
        let old = std::time::SystemTime::now() - std::time::Duration::from_secs((defaults::num("dispatch.stop_state_max_age_days") + 1) * 86_400);
        for f in [&c, &l] {
            std::fs::File::options().write(true).open(f).unwrap().set_modified(old).unwrap();
        }
        prune();
        assert!(l.exists(), "an old lock file is a live mutex, not a stale counter");
        assert!(!c.exists());
        crate::discard::harmless(std::fs::remove_file(&l));
    }

    #[test]
    fn counter_names_cannot_collide_across_ids_that_hold_hyphens() {
        let a = counter(Some(&json!({"session_id": "a-b", "agent_id": "c"})), "SubagentStop");
        let b = counter(Some(&json!({"session_id": "a", "agent_id": "b-c"})), "SubagentStop");
        assert_ne!(a, b, "two different (session, agent) pairs");
        let x = counter(Some(&json!({"session_id": "a-b"})), "Stop");
        let y = counter(Some(&json!({"session_id": "a", "agent_id": "b"})), "Stop");
        assert_ne!(x, y, "a session and a session with an agent");
    }

    #[test]
    fn a_payload_without_a_session_never_shares_a_counter_with_a_session_of_the_same_name() {
        let none = counter(Some(&json!({})), "Stop");
        let named = counter(Some(&json!({"session_id": defaults::text("dispatch.stop_unknown_session")})), "Stop");
        assert_ne!(none, named);
        assert_eq!(none, counter(None, "Stop"), "an unreadable payload shares the unknown counter");
    }
}
