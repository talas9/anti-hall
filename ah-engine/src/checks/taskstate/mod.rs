//! The task fact model: the task list reconstructed from a transcript tail, as the Node hooks do it.
//!
//! Two Node reconstructions exist and differ in small ways, so both are ported side by side ([`Variant`]):
//! `task-guard.js` `parseTasksFromFile` (also what `tasklist-guard.js` relies on for its own scan) and
//! `lib/task-state.js` `reconstructTasks` (task-tracker, dispatch-tier). [`parse::reconstruct`] mirrors both,
//! [`backfill::backfill`] mirrors `lib/task-subject-backfill.js`, and [`unknown`] mirrors `unknownNote` plus the
//! state-file sweep it triggers.
//!
//! Exactness rule: every JSON field the Node code reads with `||`, `String(x)` or `.toLowerCase()` is read through
//! [`crate::checks::taskkit::jsval`]; a value on which JavaScript would behave differently from this code, or throw,
//! makes the whole call [`Unsure`] and the Node hook decides (D74). A task map is only ever answered from when every
//! record in the window was understood.
pub mod backfill;
pub mod parse;
pub mod tail;
pub mod unknown;

#[cfg(test)]
mod tests;

use crate::checks::taskkit::jsval::{R, Unsure, not_nullish, scalar_string, truthy};
use crate::defaults;
use serde_json::Value;
use std::collections::HashMap;

pub use crate::checks::taskkit::jsval::Unsure as Defer;

/// Which Node reconstruction to mirror.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Variant {
    /// `task-guard.js` `parseTasksFromFile`.
    Guard,
    /// `lib/task-state.js` `reconstructTasks`.
    State,
}

/// The fields of a task still to be recovered from before the window (Node `unknown`).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Unknown {
    /// The status is not known.
    pub status: bool,
    /// The owner is not known.
    pub owner: bool,
    /// The blockers are not known.
    pub blocked_by: bool,
    /// The blockedOn marker is not known.
    pub blocked_on: bool,
}

impl Unknown {
    /// A task seen only through an update: everything is still to be recovered.
    pub fn all() -> Unknown {
        Unknown { status: true, owner: true, blocked_by: true, blocked_on: true }
    }

    /// Any flag set.
    pub fn any(&self) -> bool {
        self.status || self.owner || self.blocked_by || self.blocked_on
    }
}

/// One reconstructed task.
#[derive(Clone, Debug, PartialEq)]
pub struct Task {
    /// The id (a map key).
    pub id: String,
    /// The subject (`String(content)`).
    pub content: String,
    /// The description (the state variant only; empty otherwise).
    pub description: String,
    /// The status; `None` is JavaScript's `undefined` (unknown).
    pub status: Option<String>,
    /// The trimmed owner, empty when unowned.
    pub owner: String,
    /// The ids this task waits on.
    pub blocked_by: Vec<String>,
    /// The `blockedOn` marker; `None` is `undefined`, `Some(Null)` is an explicit `null`.
    pub blocked_on: Option<Value>,
    /// The priority label (`P0`, `low`, ...), when one was set (only the tasklist scan keeps it).
    pub priority: Option<String>,
    /// A TaskUpdate carried a subject (the state variant).
    pub subject_updated: bool,
    /// Fields still to be recovered.
    pub unknown: Option<Unknown>,
    /// The block state could not be established (set by the backfill).
    pub block_unknown: bool,
}

impl Task {
    /// `unseenTask(id)`: a task first seen through an update.
    pub fn unseen(id: &str) -> Task {
        Task {
            id: id.to_string(),
            content: id.to_string(),
            description: String::new(),
            status: None,
            owner: String::new(),
            blocked_by: Vec::new(),
            blocked_on: None,
            priority: None,
            subject_updated: false,
            unknown: Some(Unknown::all()),
            block_unknown: false,
        }
    }

    /// The status in lowercase, empty when unknown (`(t.status || '').toLowerCase()`).
    pub fn status_lc(&self) -> String {
        self.status.as_deref().unwrap_or("").to_lowercase()
    }

    /// `isOpenTask`: a known pending or in-progress status.
    pub fn is_open(&self) -> bool {
        let s = self.status_lc();
        defaults::list("taskstate.open_statuses").contains(&s.as_str())
    }

    /// The blockedOn marker as the owner-blocked test reads it: a string trimmed and lowercased, else empty.
    pub fn blocked_on_text(&self) -> String {
        match &self.blocked_on {
            Some(Value::String(s)) => crate::checks::guardkit::text::js_trim(s).to_lowercase(),
            _ => String::new(),
        }
    }
}

/// An insertion-ordered map of tasks (JavaScript `Map`: replacing a key keeps its place, delete then set moves it last).
#[derive(Clone, Debug, Default)]
pub struct TaskMap {
    order: Vec<String>,
    map: HashMap<String, Task>,
}

impl TaskMap {
    /// The task under `key`.
    pub fn get(&self, key: &str) -> Option<&Task> {
        self.map.get(key)
    }

    /// The task under `key`, mutably.
    pub fn get_mut(&mut self, key: &str) -> Option<&mut Task> {
        self.map.get_mut(key)
    }

    /// `map.set(key, t)`.
    pub fn set(&mut self, key: &str, t: Task) {
        if self.map.insert(key.to_string(), t).is_none() {
            self.order.push(key.to_string());
        }
    }

    /// `map.delete(key)`.
    pub fn delete(&mut self, key: &str) {
        if self.map.remove(key).is_some() {
            self.order.retain(|k| k != key);
        }
    }

    /// `map.clear()`.
    pub fn clear(&mut self) {
        self.order.clear();
        self.map.clear();
    }

    /// The number of tasks.
    pub fn len(&self) -> usize {
        self.order.len()
    }

    /// True when there are no tasks.
    pub fn is_empty(&self) -> bool {
        self.order.is_empty()
    }

    /// The keys in insertion order.
    pub fn keys(&self) -> impl Iterator<Item = &String> {
        self.order.iter()
    }

    /// The tasks in insertion order.
    pub fn values(&self) -> impl Iterator<Item = &Task> {
        self.order.iter().filter_map(|k| self.map.get(k))
    }

    /// The tasks in insertion order, mutably (the order is not changed).
    pub fn values_mut(&mut self) -> Vec<&mut Task> {
        let order = self.order.clone();
        let mut by_key: HashMap<&str, &mut Task> = self.map.iter_mut().map(|(k, v)| (k.as_str(), v)).collect();
        order.iter().filter_map(|k| by_key.remove(k.as_str())).collect()
    }

    /// `maxNumericKey(map)`: the highest all-digit key, 0 when there is none.
    pub fn max_numeric_key(&self) -> f64 {
        self.order.iter().filter(|k| is_digits(k)).map(|k| number_of_digits(k)).fold(0.0, f64::max)
    }
}

/// `/^\d+$/.test(s)` for an ASCII digit run.
pub fn is_digits(s: &str) -> bool {
    !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit())
}

/// `Number(s)` for an all-digit string.
pub fn number_of_digits(s: &str) -> f64 {
    s.parse::<f64>().unwrap_or(f64::INFINITY)
}

/// `normOwner(o)`: a string trimmed, anything else empty.
pub fn norm_owner(v: Option<&Value>) -> String {
    match v {
        Some(Value::String(s)) => crate::checks::guardkit::text::js_trim(s).to_string(),
        _ => String::new(),
    }
}

/// `normBlockedBy(b)`: an array of ids as strings (nulls dropped), a lone string or number as a one-element list, else
/// none.
pub fn norm_blocked_by(v: Option<&Value>) -> R<Vec<String>> {
    match v {
        Some(Value::Array(a)) => a.iter().filter(|x| !x.is_null()).map(scalar_string).collect(),
        Some(x @ (Value::String(_) | Value::Number(_))) => Ok(vec![scalar_string(x)?]),
        _ => Ok(Vec::new()),
    }
}

/// `blockedByAfterUpdate(existing, inp, norm)`: a full replacement or the incremental `addBlockedBy`.
pub fn blocked_by_after_update(existing: &[String], inp: &Value) -> R<Vec<String>> {
    let mut out = match crate::checks::taskkit::jsval::get(inp, "blockedBy") {
        Some(b) => norm_blocked_by(Some(b))?,
        None => existing.to_vec(),
    };
    if let Some(add) = crate::checks::taskkit::jsval::get(inp, "addBlockedBy") {
        for id in norm_blocked_by(Some(add))? {
            if !out.contains(&id) {
                out.push(id);
            }
        }
    }
    Ok(out)
}

/// A status field read with `||`: `None` when falsy, the string when truthy; a truthy non-string is [`Unsure`] (the Node
/// code would call `.toLowerCase()` on it and throw).
pub fn truthy_status(v: Option<&Value>) -> R<Option<String>> {
    match v {
        Some(x) if truthy(x) => match x {
            Value::String(s) => Ok(Some(s.clone())),
            _ => Err(Unsure),
        },
        _ => Ok(None),
    }
}

/// `inp.blockedOn` or `inp.metadata.blockedOn` as the TaskCreate record reads it:
/// `(inp.metadata != null && inp.metadata.blockedOn != null) ? inp.metadata.blockedOn : inp.blockedOn`.
pub fn create_blocked_on(inp: &Value) -> Option<Value> {
    use crate::checks::taskkit::jsval::get;
    let meta = get(inp, "metadata").filter(|m| !m.is_null());
    match meta.and_then(|m| get(m, "blockedOn")).filter(|b| !b.is_null()) {
        Some(b) => Some(b.clone()),
        None => get(inp, "blockedOn").cloned(),
    }
}

/// True when `inp.blockedOn !== undefined || (inp.metadata != null && inp.metadata.blockedOn !== undefined)`.
pub fn has_blocked_on_update(inp: &Value) -> bool {
    use crate::checks::taskkit::jsval::get;
    get(inp, "blockedOn").is_some() || get(inp, "metadata").filter(|m| !m.is_null()).and_then(|m| get(m, "blockedOn")).is_some()
}

/// `(inp.metadata != null && inp.metadata.blockedOn != null) ? inp.metadata.blockedOn : inp.blockedOn` for an update.
pub fn update_blocked_on(inp: &Value) -> Option<Value> {
    create_blocked_on(inp)
}

/// True when the value is neither `undefined` nor `null`.
pub fn present(v: Option<&Value>) -> bool {
    not_nullish(v)
}
