//! The facts one session keeps: what a parsed line contributes, each carrying its line's start offset.
//!
//! A query names a window (the last `w` bytes) and a cut mode, and is answered from the facts whose offset lies inside it:
//! [`Cut::DropFirst`] is what `readTail` does (the first piece after `size - w` is dropped, whole line or not) and
//! [`Cut::Exact`] keeps a line that starts exactly at the window start. That gives each old reader a byte-exact twin.
//!
//! Byte accounting is explicit: [`Fact::bytes`] is a fixed record size (`transcript.fact_fixed_bytes`) plus the capacity of
//! every string and the estimated size of every JSON value the fact owns, so the per-session and global budgets mean what
//! they say.
use super::record::{Assistant, Notification, Prompt, TaskEvent, TaskStatus, ToolUse};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{HashMap, VecDeque};

/// Which part of a window a reader keeps.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Cut {
    /// `readTail`: the first piece after `size - w` is dropped, so a line starting exactly at the window start is dropped too.
    DropFirst,
    /// A line that starts exactly at the window start is kept.
    Exact,
}

impl Cut {
    /// Is a line starting at `off` inside the window that starts at `start`?
    pub fn keeps(self, off: u64, start: u64) -> bool {
        match self {
            Cut::DropFirst => start == 0 || off > start,
            Cut::Exact => off >= start,
        }
    }
}

/// What a line contributed.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub enum FactKind {
    /// A typed user prompt (the newest is `lastUserPrompt`).
    Prompt(Prompt),
    /// An assistant reply, extracted without repeating text.
    Assistant(Assistant),
    /// An assistant reply as the legacy extraction returns it.
    AssistantLegacy(Assistant),
    /// A use of any tool.
    ToolUse(ToolUse),
    /// A use or a result of one of `transcript.task_tools`.
    Task(TaskEvent),
    /// A task-notification block.
    Notification(Notification),
    /// A `task_status` attachment.
    TaskStatus(TaskStatus),
    /// A compaction boundary.
    Boundary,
}

/// One fact and where its line sits.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Fact {
    /// Offset of the line's first byte.
    pub off: u64,
    /// What it says.
    pub kind: FactKind,
}

/// Bytes a JSON value occupies, estimated (strings by length, containers by their entries).
pub fn value_bytes(v: &Value) -> usize {
    let word = std::mem::size_of::<usize>();
    match v {
        Value::String(s) => s.capacity() + word,
        Value::Array(a) => a.iter().map(value_bytes).sum::<usize>() + word * (a.capacity() + 1),
        Value::Object(m) => m.iter().map(|(k, v)| k.len() + value_bytes(v) + word).sum::<usize>() + word,
        _ => word,
    }
}

fn opt_str(s: &Option<String>) -> usize {
    s.as_ref().map_or(0, String::capacity)
}

fn tool_use_bytes(u: &ToolUse) -> usize {
    opt_str(&u.id) + u.name.capacity() + value_bytes(&u.input) + opt_str(&u.msg_id)
}

impl Fact {
    /// Bytes this fact holds; `fixed` is `transcript.fact_fixed_bytes`.
    pub fn bytes(&self, fixed: usize) -> usize {
        fixed
            + match &self.kind {
                FactKind::Prompt(p) => p.text.capacity(),
                FactKind::Assistant(a) | FactKind::AssistantLegacy(a) => a.text.capacity(),
                FactKind::ToolUse(u) => tool_use_bytes(u),
                FactKind::Task(TaskEvent::Use(u)) => tool_use_bytes(u),
                FactKind::Task(TaskEvent::Result { tool_use_id, text, .. }) => tool_use_id.capacity() + text.capacity(),
                FactKind::Notification(n) => opt_str(&n.task_id) + opt_str(&n.status) + opt_str(&n.idle_task_id) + opt_str(&n.idle_tool_use_id),
                FactKind::TaskStatus(t) => t.task_id.capacity() + t.status.capacity() + t.output_file.capacity() + t.description.capacity(),
                FactKind::Boundary => 0,
            }
    }
}

/// What the store knows about one task, merged across the uses of the task tools (it outlives the facts that said it).
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct TaskRow {
    /// `subject`, when a create or update set it.
    pub subject: Option<String>,
    /// `status`, as last set.
    pub status: Option<String>,
    /// `owner`, as last set.
    pub owner: Option<String>,
    /// `addBlockedBy` ids seen.
    pub blocked_by: Vec<String>,
    /// Offset of the line that last changed the row.
    pub off: u64,
}

/// What the store knows about one agent (a launch, and whether a notification ended it).
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct AgentRow {
    /// Offset of the line that launched it, when seen.
    pub launched_at: Option<u64>,
    /// A terminal notification ended it.
    pub terminal: bool,
    /// The last status a notification carried.
    pub status: Option<String>,
    /// Offset of the line that last changed the row.
    pub off: u64,
}

impl TaskRow {
    /// Bytes this row holds.
    pub fn bytes(&self) -> usize {
        std::mem::size_of::<TaskRow>()
            + opt_str(&self.subject)
            + opt_str(&self.status)
            + opt_str(&self.owner)
            + self.blocked_by.iter().map(String::capacity).sum::<usize>()
    }
}

impl AgentRow {
    /// Bytes this row holds.
    pub fn bytes(&self) -> usize {
        std::mem::size_of::<AgentRow>() + opt_str(&self.status)
    }
}

/// A map capped by entry count that forgets its oldest-inserted key first. Touching a key does not renew it, so the map is
/// bounded by `cap` whatever the access pattern.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct FifoMap<V> {
    map: HashMap<String, V>,
    order: VecDeque<String>,
}

impl<V> FifoMap<V> {
    /// An empty map.
    pub fn new() -> FifoMap<V> {
        FifoMap { map: HashMap::new(), order: VecDeque::new() }
    }

    /// The row of `key`.
    pub fn get(&self, key: &str) -> Option<&V> {
        self.map.get(key)
    }

    /// The row of `key`, inserted as `make()` when absent. Returns the evicted rows when the cap was passed.
    pub fn upsert(&mut self, key: &str, cap: usize, make: impl FnOnce() -> V, change: impl FnOnce(&mut V)) -> Vec<V> {
        let mut gone = Vec::new();
        if !self.map.contains_key(key) {
            self.map.insert(key.to_string(), make());
            self.order.push_back(key.to_string());
            while self.order.len() > cap.max(1) {
                if let Some(old) = self.order.pop_front()
                    && let Some(v) = self.map.remove(&old)
                {
                    gone.push(v);
                }
            }
        }
        if let Some(v) = self.map.get_mut(key) {
            change(v);
        }
        gone
    }

    /// Forget the oldest key; the row it had.
    pub fn pop_oldest(&mut self) -> Option<(String, V)> {
        let k = self.order.pop_front()?;
        self.map.remove(&k).map(|v| (k, v))
    }

    /// Remove `key`.
    pub fn remove(&mut self, key: &str) -> Option<V> {
        let v = self.map.remove(key)?;
        self.order.retain(|k| k != key);
        Some(v)
    }

    /// How many keys are held.
    pub fn len(&self) -> usize {
        self.map.len()
    }

    /// True when empty.
    pub fn is_empty(&self) -> bool {
        self.map.is_empty()
    }

    /// Keys with their rows, oldest first.
    pub fn iter(&self) -> impl Iterator<Item = (&String, &V)> {
        self.order.iter().filter_map(|k| self.map.get(k).map(|v| (k, v)))
    }

    /// Bytes of the keys (rows are counted by the caller).
    pub fn key_bytes(&self) -> usize {
        self.order.iter().map(|k| k.capacity() + std::mem::size_of::<String>() * 2).sum()
    }
}
