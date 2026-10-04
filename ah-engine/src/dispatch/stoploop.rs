//! The Stop-loop guard (D74): a Stop or SubagentStop that exits 2 tells the host to keep the agent going, so a dispatcher
//! that fails closed there on a state it cannot repair (plugin root unset, a hook that cannot spawn) would keep the agent
//! from ever finishing. Mirrors the `stop_hook_active` check of the Node Stop hooks (`devswarm-child-gate.js`,
//! `compact-advice-guard.js`), and adds a per-session cap on consecutive fail-closed blocks.
//!
//! The payload flag is the host's own "a Stop hook already blocked this turn" signal. The cap (`dispatch.stop_block_cap`)
//! covers the payloads that cannot carry it (unreadable, cut off) and a host that does not set it. The count lives in a
//! file per session under the state dir, because every Stop is a new process.
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

fn counter(payload: Option<&Value>, event: &str) -> PathBuf {
    let sid = payload.and_then(|p| p.get("session_id")).and_then(Value::as_str).unwrap_or("");
    let mut key: String = sid.chars().filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_').take(64).collect();
    if key.is_empty() {
        key = defaults::text("dispatch.stop_unknown_session").to_string();
    }
    crate::paths::dir().join(defaults::text("dispatch.stop_state_dir")).join(format!("{event}-{key}"))
}

/// A fail-closed `event` is about to block: decide whether it may. The payload's `stop_hook_active` true fails open; so
/// does a count of consecutive blocks at the cap (it stays open until the guards run fine again), or a count that cannot be recorded (an unbounded loop is worse).
pub fn judge(event: &str, payload: Option<&Value>, why: &str) -> Verdict {
    if payload.and_then(|p| p.get("stop_hook_active")).and_then(Value::as_bool) == Some(true) {
        return Verdict::Open(defaults::render("dispatch.msg_stop_active", &[("event", &event), ("why", &why)]));
    }
    let path = counter(payload, event);
    let cap = defaults::num("dispatch.stop_block_cap");
    let seen: u64 = std::fs::read_to_string(&path).ok().and_then(|t| t.trim().parse().ok()).unwrap_or(0);
    if seen >= cap {
        return Verdict::Open(defaults::render("dispatch.msg_stop_capped", &[("event", &event), ("cap", &cap), ("why", &why)]));
    }
    let recorded = path.parent().is_some_and(|d| crate::limits::ensure_private_dir(d).is_ok()) && std::fs::write(&path, (seen + 1).to_string()).is_ok();
    if recorded {
        Verdict::Block
    } else {
        Verdict::Open(defaults::render("dispatch.msg_stop_uncounted", &[("event", &event), ("why", &why)]))
    }
}

/// The guards ran fine for `event`: the run of consecutive blocks is over.
pub fn reset(event: &str, payload: Option<&Value>) {
    if is_stop_event(event) {
        let _ = std::fs::remove_file(counter(payload, event));
    }
}
