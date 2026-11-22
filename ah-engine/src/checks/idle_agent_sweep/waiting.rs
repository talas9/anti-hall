//! The teammates a transcript tail shows idle while they wait on their own background work (GH #744): the part of the
//! `idle-agent-sweep` script that used to walk the tail's lines in JavaScript on every prompt (JSON.parse and four regex tests over
//! each of hundreds of kilobytes of tool lines) and now runs here, from per-line facts the shared incremental view keeps between
//! calls (#953), so a call digests only the bytes appended since the last one.
//!
//! One line's effects ([`WLine`]) are free of the lines before it; [`state_of`] applies them in order, exactly as the script did:
//! an idle report names a teammate unless it was ended since, a spawn clears the ended mark and records the id TaskStop takes, a
//! "No task found" answer or a TaskStop call ends the teammate it names, and a SendMessage or TaskStop call re-tasks the ones it
//! names. The script then keeps those idle past `idle_order.waiting_after_min` and not past `idle_sweep.stale_minutes`.
use crate::checks::guardkit::jsre;
use crate::checks::guardkit::jsval::{DateParse, date_parse, parse_line};
use crate::defaults;
use regex::Regex;
use serde_json::Value;
use std::sync::Arc;

struct Res {
    idle_json: Regex,
    retask: Regex,
    stop: Regex,
    gone: Regex,
    task_id: Regex,
}

fn res() -> Arc<Res> {
    static R: crate::defaults::Cache<Res> = crate::defaults::Cache::new();
    R.get_or_init(|| {
        let c = |k: &str| jsre::compile(defaults::text(k), false);
        Res { idle_json: c("idle_order.re_idle_json"), retask: c("idle_order.re_retask"), stop: c("idle_order.re_stop"), gone: c("idle_order.re_gone"), task_id: c("idle_order.re_task_id") }
    })
}

/// One effect of a line, in the order the script applied them.
#[derive(Debug, Clone)]
enum Op {
    /// An idle report: who, when (finite), the reason (`""` when it gave none).
    Idle { from: String, ms: f64, reason: String },
    /// A spawn result: the teammate and the id TaskStop takes for it, when the result carried one.
    Spawn { name: String, stop_id: Option<String> },
    /// A "No task found" answer naming this id.
    Gone(String),
    /// A TaskStop call naming this task id.
    Stop(String),
    /// A SendMessage or TaskStop call (`stop`: a TaskStop one): the line, to be searched for the names it re-tasks.
    Retask { stop: bool, raw: Arc<str> },
}

/// What one line contributes (free of the lines before it).
#[derive(Debug, Clone)]
pub struct WLine {
    ops: Vec<Op>,
    /// A timestamp only JavaScript reads exactly: the whole answer is unknown.
    unsure: bool,
}

impl WLine {
    /// Roughly the bytes the line's facts hold, for the view's memory accounting.
    pub fn weight(&self) -> usize {
        std::mem::size_of::<Self>()
            + self
                .ops
                .iter()
                .map(|o| {
                    std::mem::size_of::<Op>()
                        + match o {
                            Op::Idle { from, reason, .. } => from.len() + reason.len(),
                            Op::Spawn { name, stop_id } => name.len() + stop_id.as_ref().map_or(0, String::len),
                            Op::Gone(s) | Op::Stop(s) => s.len(),
                            Op::Retask { raw, .. } => raw.len(),
                        }
                })
                .sum::<usize>()
    }
}

fn utf16_len(s: &str) -> usize {
    s.encode_utf16().count()
}

/// The facts of one transcript line (`None`: the script reads nothing from it).
pub fn digest_line(raw: &str) -> Option<WLine> {
    if utf16_len(raw) > defaults::num("idle_order.line_max") as usize {
        return None;
    }
    let r = res();
    let tag = defaults::text("idle_order.idle_marker");
    let mut ops: Vec<Op> = Vec::new();
    if raw.contains(tag) {
        let content = parse_line(raw).and_then(|e| e.get("message").and_then(|m| m.get("content")).and_then(Value::as_str).map(str::to_string)).unwrap_or_default();
        let o = r.idle_json.find(&content).and_then(|m| parse_line(m.as_str()));
        if let Some(o) = o
            && o.get("type").and_then(Value::as_str) == Some(tag)
            && let Some(from) = o.get("from").and_then(Value::as_str)
        {
            let ms = match o.get("timestamp").and_then(Value::as_str) {
                Some(s) => match date_parse(s) {
                    DateParse::Ms(ms) => ms,
                    DateParse::Nan => f64::NAN,
                    DateParse::Unsupported => return Some(WLine { ops: Vec::new(), unsure: true }),
                },
                None => f64::NAN,
            };
            if ms.is_finite() {
                ops.push(Op::Idle { from: from.to_string(), ms, reason: o.get("idleReason").and_then(Value::as_str).unwrap_or("").to_string() });
            }
        }
        return (!ops.is_empty()).then_some(WLine { ops, unsure: false });
    }
    let spawn_tag = defaults::text("idle_sweep.spawned_status");
    if raw.contains(spawn_tag)
        && let Some(rec) = parse_line(raw)
        && rec.is_object()
        && let Some(res) = rec.get(defaults::text("idle_order.spawn_result_field"))
        && res.is_object()
        && res.get("status").and_then(Value::as_str) == Some(spawn_tag)
        && let Some(name) = res.get(defaults::text("idle_order.spawn_name_field")).and_then(Value::as_str)
    {
        let stop_id = res.get(defaults::text("idle_order.spawn_id_field")).and_then(Value::as_str).filter(|s| !s.is_empty()).map(str::to_string);
        ops.push(Op::Spawn { name: name.to_string(), stop_id });
    }
    if let Some(c) = r.gone.captures(raw)
        && let Some(id) = c.get(1)
    {
        ops.push(Op::Gone(id.as_str().to_string()));
    }
    let stop = r.stop.is_match(raw);
    if stop && let Some(c) = r.task_id.captures(raw) {
        ops.push(Op::Stop(c[1].to_string()));
    }
    if r.retask.is_match(raw) {
        ops.push(Op::Retask { stop, raw: Arc::from(raw) });
    }
    (!ops.is_empty()).then_some(WLine { ops, unsure: false })
}

/// What the replay leaves.
pub struct State {
    /// The teammates still idle, in the order the script's object held them: name, when it went idle, the reason it gave.
    pub idle: Vec<(String, f64, String)>,
    /// The ids TaskStop takes, by teammate name (the ones passed in, then the ones the spawns in the window recorded).
    pub stop_ids: Vec<(String, String)>,
}

/// An insertion-ordered map of the few teammates a session has (a plain object in the script).
fn set<V>(v: &mut Vec<(String, V)>, k: &str, val: V) {
    match v.iter_mut().find(|(n, _)| n == k) {
        Some(slot) => slot.1 = val,
        None => v.push((k.to_string(), val)),
    }
}

/// The teammate a stop's (or a "No task found" answer's) id names: the name whose TaskStop id it is, else the part before the last
/// `idle_sweep.stop_id_sep` of a `name@session-xxxx` id (its spawn is outside the window), else the id itself (a bare name).
fn stop_name(ids: &[(String, String)], id: &str) -> String {
    if let Some((n, _)) = ids.iter().find(|(_, v)| v == id) {
        return n.clone();
    }
    match id.rfind(defaults::text("idle_sweep.stop_id_sep")) {
        Some(at) if at > 0 => id[..at].to_string(),
        _ => id.to_string(),
    }
}

/// The lines' facts applied oldest first. `None`: a timestamp only JavaScript reads exactly (the scan is unknown).
pub fn state_of<'a>(lines: impl IntoIterator<Item = &'a WLine>, initial_stop_ids: Vec<(String, String)>) -> Option<State> {
    let mut idle: Vec<(String, (f64, String))> = Vec::new();
    let mut ended: Vec<String> = Vec::new();
    let mut ids = initial_stop_ids;
    for line in lines {
        if line.unsure {
            return None;
        }
        for op in &line.ops {
            match op {
                Op::Idle { from, ms, reason } => {
                    if !ended.contains(from) {
                        set(&mut idle, from, (*ms, reason.clone()));
                    }
                }
                Op::Spawn { name, stop_id } => {
                    ended.retain(|n| n != name);
                    if let Some(s) = stop_id {
                        set(&mut ids, name, s.clone());
                    }
                }
                Op::Gone(id) | Op::Stop(id) => {
                    let n = stop_name(&ids, id);
                    if !ended.contains(&n) {
                        ended.push(n.clone());
                    }
                    idle.retain(|(k, _)| *k != n);
                }
                Op::Retask { stop, raw } => {
                    let quoted = |n: &str| raw.contains(&format!("\"{n}\""));
                    if !stop {
                        ended.retain(|n| !quoted(n));
                    }
                    idle.retain(|(n, _)| !quoted(n));
                }
            }
        }
    }
    Some(State { idle: idle.into_iter().map(|(n, (ms, r))| (n, ms, r)).collect(), stop_ids: ids })
}
