//! Where a reminder goes. Each channel is a [`Sink`]; the tick picks them by route and never reaches an agent any other way.
//!
//! * [`SessionQueue`] appends to the queue file of a session or subagent; the scripted check `agent-reminders` puts the new lines in
//!   front of that agent at its next UserPromptSubmit or PostToolUse and records the delivery.
//! * [`MeshOutbox`] is the DevSwarm seam: it appends a nudge row for the workspace. The mesh action layer (the writer of the
//!   existing mesh nudge) takes the rows from there; the tracker has no second way to poke a workspace.
//! * [`OwnerNotices`] appends a notice for the owner.
use super::{Env, fmtn, lim, pth};
use serde_json::{Value, json};
use std::io::Write;
use std::path::PathBuf;

/// One reminder or advisory.
#[derive(Debug, Clone)]
pub struct Reminder {
    /// A stable id (agent, signal, time).
    pub id: String,
    /// When it was queued.
    pub ts: u64,
    /// The signal it is about.
    pub signal: String,
    /// The agent it is about.
    pub agent: String,
    /// What it says.
    pub text: String,
}

/// A delivery channel.
pub trait Sink {
    /// The channel name used in telemetry and the status table.
    fn channel(&self) -> &'static str;
    /// Hand the reminder to `target` (a session or subagent id, a workspace id, or empty for the owner).
    fn deliver(&self, env: &Env, target: &str, r: &Reminder) -> Result<(), String>;
    /// Reminders queued for `target` and not yet taken (0 when the channel cannot tell).
    fn backlog(&self, _env: &Env, _target: &str) -> u64 {
        0
    }
    /// Whether a reminder of `signal` about `agent` is already queued for `target` and not yet taken (false when the channel cannot
    /// tell): the same notice is never queued twice in front of one prompt.
    fn has_pending(&self, _env: &Env, _target: &str, _signal: &str, _agent: &str) -> bool {
        false
    }
}

pub(super) fn append(path: &PathBuf, row: &Value) -> Result<(), String> {
    if let Some(d) = path.parent() {
        std::fs::create_dir_all(d).map_err(|e| e.to_string())?;
    }
    let mut f = std::fs::OpenOptions::new().create(true).append(true).open(path).map_err(|e| e.to_string())?;
    f.write_all(format!("{row}\n").as_bytes()).map_err(|e| e.to_string())
}

fn row(r: &Reminder) -> Value {
    json!({"id": r.id, "ts": r.ts, "signal": r.signal, "agent": r.agent, "text": r.text})
}

/// The queue-file key of an agent or session id: the characters the scripted check also keeps, cut to the same length.
pub(crate) fn key_of(id: &str) -> String {
    let max = crate::defaults::num("agent_reminders.key_max") as usize;
    id.chars().take(max).map(|c| if c.is_ascii_alphanumeric() || c == '.' || c == '_' || c == '-' { c } else { '_' }).collect()
}

/// The per-agent queue read by the `agent-reminders` check.
pub struct SessionQueue;

impl SessionQueue {
    pub(crate) fn file(env: &Env, target: &str) -> PathBuf {
        env.dir().join(pth("reminders")).join(format!("{}{}", key_of(target), pth("queue_ext")))
    }
}

fn lines_in(p: &PathBuf) -> u64 {
    std::fs::read_to_string(p).map(|t| t.lines().count() as u64).unwrap_or(0)
}

impl Sink for SessionQueue {
    fn channel(&self) -> &'static str {
        super::chan("session")
    }
    fn deliver(&self, env: &Env, target: &str, r: &Reminder) -> Result<(), String> {
        append(&Self::file(env, target), &row(r))
    }
    fn backlog(&self, env: &Env, target: &str) -> u64 {
        let q = Self::file(env, target);
        let mut cur = q.clone().into_os_string();
        cur.push(pth("cursor_ext"));
        let taken: u64 = std::fs::read_to_string(PathBuf::from(cur)).ok().and_then(|t| t.trim().parse().ok()).unwrap_or(0);
        lines_in(&q).saturating_sub(taken)
    }
    fn has_pending(&self, env: &Env, target: &str, signal: &str, agent: &str) -> bool {
        let q = Self::file(env, target);
        let mut cur = q.clone().into_os_string();
        cur.push(pth("cursor_ext"));
        let taken: usize = std::fs::read_to_string(PathBuf::from(cur)).ok().and_then(|t| t.trim().parse().ok()).unwrap_or(0);
        let text = std::fs::read_to_string(&q).unwrap_or_default();
        text.lines().skip(taken).filter_map(|l| serde_json::from_str::<Value>(l).ok()).any(|v| v["signal"] == signal && v["agent"] == agent)
    }
}

/// The wake feed of a session: the file `agents wake-watch` (a Monitor armed at session start) tails, so a row here wakes the session
/// even while it is idle. The row carries the same text as the queued reminder.
pub struct WakeFeed;

impl WakeFeed {
    pub(crate) fn file(env: &Env, target: &str) -> PathBuf {
        env.dir().join(pth("wake")).join(format!("{}{}", key_of(target), pth("queue_ext")))
    }
    /// The stamp a live watcher renews: its age says whether the session can be woken.
    pub(crate) fn stamp(env: &Env, target: &str) -> PathBuf {
        env.dir().join(pth("wake")).join(format!("{}{}", key_of(target), pth("armed_ext")))
    }
}

/// Whether a live `agents wake-watch` covers the session: its stamp was renewed within `stale_lock_ms`.
pub(crate) fn wake_armed(env: &Env, session: &str) -> bool {
    crate::checks::agent_scan::mtime_ms(&WakeFeed::stamp(env, session)).is_some_and(|m| env.now_ms.saturating_sub(m as u64) <= lim("stale_lock_ms"))
}

impl Sink for WakeFeed {
    fn channel(&self) -> &'static str {
        super::chan("wake")
    }
    fn deliver(&self, env: &Env, target: &str, r: &Reminder) -> Result<(), String> {
        append(&Self::file(env, target), &row(r))
    }
}

/// The DevSwarm seam: nudge rows for the mesh action layer.
pub struct MeshOutbox {
    /// Address the workspace's parent instead of the workspace itself.
    pub to_parent: bool,
}

impl Sink for MeshOutbox {
    fn channel(&self) -> &'static str {
        super::chan("mesh")
    }
    fn deliver(&self, env: &Env, target: &str, r: &Reminder) -> Result<(), String> {
        let mut v = row(r);
        v["workspace"] = json!(target);
        v["to_parent"] = json!(self.to_parent);
        append(&env.dir().join(pth("outbox")), &v)
    }
}

/// Notices for the owner.
pub struct OwnerNotices;

impl Sink for OwnerNotices {
    fn channel(&self) -> &'static str {
        super::chan("owner_file")
    }
    fn deliver(&self, env: &Env, _target: &str, r: &Reminder) -> Result<(), String> {
        append(&env.dir().join(pth("notices")), &row(r))
    }
}

/// Remove queue files that were fully taken a while ago.
pub(crate) fn compact(env: &Env) {
    for d in ["reminders", "wake"] {
        compact_dir(env, &env.dir().join(pth(d)));
    }
}

fn compact_dir(env: &Env, dir: &PathBuf) {
    let Ok(rd) = std::fs::read_dir(dir) else { return };
    for e in rd.flatten() {
        let p = e.path();
        if !p.to_string_lossy().ends_with(pth("queue_ext")) {
            continue;
        }
        let mut cur = p.clone().into_os_string();
        cur.push(pth("cursor_ext"));
        let cur = PathBuf::from(cur);
        let taken: u64 = std::fs::read_to_string(&cur).ok().and_then(|t| t.trim().parse().ok()).unwrap_or(0);
        let old = crate::checks::agent_scan::mtime_ms(&p).is_some_and(|m| env.now_ms.saturating_sub(m as u64) > lim("queue_keep_ms"));
        if old && taken >= lines_in(&p) {
            crate::discard::harmless(std::fs::remove_file(&p)); // keep: a leftover file is tried again next tick
            crate::discard::harmless(std::fs::remove_file(&cur)); // keep: same
        }
    }
}

/// A token count for a message: the largest step that fits, with the configured suffix (995687 -> `995k`, 1500000 -> `1.5M`).
pub(crate) fn count(n: u64) -> String {
    let fmt = crate::defaults::raw("agent_tracker.fmt");
    let steps = fmt
        .get("count_steps")
        .and_then(crate::defaults::V::as_array)
        .map(|a| a.iter().filter_map(crate::defaults::V::as_integer).collect::<Vec<_>>())
        .unwrap_or_default();
    let names = fmt.get("count_units").map(crate::defaults::V::strings).unwrap_or_default();
    let i = steps.iter().rposition(|u| n >= (*u).max(1) as u64).unwrap_or(0);
    let step = steps.get(i).copied().unwrap_or(1).max(1) as u64;
    let tenths = n * 10 / step;
    let (units, frac) = (tenths / 10, tenths % 10);
    let decimal_below = fmt.get("count_decimal_below_tenths").and_then(crate::defaults::V::as_integer).unwrap_or(0).max(0) as u64;
    let whole = if tenths < decimal_below && frac != 0 { format!("{units}.{frac}") } else { units.to_string() };
    format!("{whole}{}", names.get(i).copied().unwrap_or(""))
}

/// Age text: the largest unit that fits, with the configured suffixes.
pub(crate) fn age(ms: u64) -> String {
    let units = super::sources::unit_ms();
    let names = crate::defaults::raw("agent_tracker.fmt").get("ago_units").map(crate::defaults::V::strings).unwrap_or_default();
    let i = units.iter().rposition(|u| ms >= *u).unwrap_or(0);
    format!("{}{}", ms / units.get(i).copied().unwrap_or_else(|| fmtn("ms_per_s")), names.get(i).copied().unwrap_or(""))
}
