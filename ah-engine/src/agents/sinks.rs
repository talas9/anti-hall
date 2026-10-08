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
}

fn append(path: &PathBuf, row: &Value) -> Result<(), String> {
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
    fn file(env: &Env, target: &str) -> PathBuf {
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
    let dir = env.dir().join(pth("reminders"));
    let Ok(rd) = std::fs::read_dir(&dir) else { return };
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

/// Age text: the largest unit that fits, with the configured suffixes.
pub(crate) fn age(ms: u64) -> String {
    let units = super::sources::unit_ms();
    let names = crate::defaults::raw("agent_tracker.fmt").get("ago_units").map(crate::defaults::V::strings).unwrap_or_default();
    let i = units.iter().rposition(|u| ms >= *u).unwrap_or(0);
    format!("{}{}", ms / units.get(i).copied().unwrap_or_else(|| fmtn("ms_per_s")), names.get(i).copied().unwrap_or(""))
}
