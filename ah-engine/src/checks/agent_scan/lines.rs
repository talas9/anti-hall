//! The agent scan on the transcript store: what each line contributes to the walk, digested once when the store reads the line,
//! and replayed for any window the store covers.
//!
//! [`Walk::line_flagged`] reads a line in two kinds of steps: steps that depend only on the line (its JSON, its timestamp, the
//! texts of its blocks and what the agent-scan patterns find in them) and steps that depend on what the walk has seen before (is
//! the call a result answers inside the window, which teammates were spawned, which agents are launched). [`digest`] does the
//! first kind when the store folds a line in and keeps the outcome as an [`ALine`]; [`AgentState::replay`] does the second kind
//! over the lines of a window, building the very [`Walk`] a fresh scan of that window builds, and [`super::finish`] answers from it.
//!
//! * **Call resolution at read time.** A result is matched to its call when the store reads it (the open calls are kept until
//!   answered, bounded by `transcript.agent_open_calls_max`; answered ones by `transcript.agent_answered_calls_max`). The digest
//!   keeps the call's offset, so the replay knows whether the call lies inside the window.
//! * **No result text is kept.** A result that answers an ordinary call (the bulk of a transcript) leaves only a [`Span`]
//!   (its offset, its call's offset, a hash of the call id). When a window starts between a call and its result, the replay
//!   reads that one line again and digests it as a fresh scan sees it (the call unseen). The text of a result the safety net
//!   may search is read again from its offset when [`super::finish`] asks for it.
//! * **Bounded.** The digests of the last `transcript.agent_horizon_bytes` are kept, within `transcript.agent_budget_bytes`;
//!   whatever is dropped raises the agent coverage mark, and a window starting before it is answered by a fresh scan.
use super::{
    Other, Rec, Stop, TeamInfo, ToolUse, Walk, date_parse, extract_text_refs, in_list, is_queued_result, is_terminal_status, js_to_string, lower_contains,
    parse_inbox_send, parse_json, parse_resume, pats, prefilter, prop, sprop, trim_start, truthy,
};
use crate::checks::guardkit::text::js_trim;
use crate::defaults;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{HashMap, VecDeque};
use std::sync::Arc;

/// A time as the walk holds it (NaN included), stored by its bits so NaN survives a snapshot.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Ts(pub f64);

impl Serialize for Ts {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_u64(self.0.to_bits())
    }
}

impl<'de> Deserialize<'de> for Ts {
    fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Ts, D::Error> {
        Ok(Ts(f64::from_bits(u64::deserialize(d)?)))
    }
}

/// An answer the line gives, or the mark that reaching it raises [`super::Unsupported`].
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub enum Got<T> {
    /// What the step found.
    Ok(T),
    /// Reaching this step makes the scan one only JavaScript can make.
    Unsupported,
}

impl<T> Got<T> {
    fn of(r: super::Res<T>) -> Got<T> {
        match r {
            Ok(v) => Got::Ok(v),
            Err(_) => Got::Unsupported,
        }
    }
    fn res(self) -> super::Res<T> {
        match self {
            Got::Ok(v) => Ok(v),
            Got::Unsupported => Err(super::Unsupported),
        }
    }
}

mod arc_value {
    //! `Option<Arc<Value>>` through serde (the `rc` feature is not enabled).
    use serde::{Deserialize, Deserializer, Serialize, Serializer};
    use serde_json::Value;
    use std::sync::Arc;
    pub fn serialize<S: Serializer>(v: &Option<Arc<Value>>, s: S) -> Result<S::Ok, S::Error> {
        v.as_deref().serialize(s)
    }
    pub fn deserialize<'de, D: Deserializer<'de>>(d: D) -> Result<Option<Arc<Value>>, D::Error> {
        Ok(Option::<Value>::deserialize(d)?.map(Arc::new))
    }
}

/// The call a result answers, as the store saw it when it read the result.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CallRef {
    /// Offset of the line that made the call.
    pub off: u64,
    /// The tool's name.
    pub name: Option<String>,
    /// The call's input, kept only for a launch or a delivery call while the walk would still hold it.
    #[serde(with = "arc_value")]
    pub input: Option<Arc<Value>>,
}

/// A call the store has read and not forgotten.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
struct CallEntry {
    off: u64,
    name: Option<String>,
    #[serde(with = "arc_value")]
    input: Option<Arc<Value>>,
    /// An answer of it was read past as not delivery evidence (the walk's `dropped_ids`).
    dropped: bool,
}

/// The calls the store matches results to: the open ones (no answer read yet) and the most recently answered ones.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Calls {
    open: HashMap<String, CallEntry>,
    open_order: VecDeque<(u64, String)>,
    answered: HashMap<String, CallEntry>,
    answered_order: VecDeque<(u64, String)>,
    /// Bytes of the entries, kept as they change.
    #[serde(skip)]
    bytes: usize,
}

/// Bytes one entry holds: `transcript.agent_call_bytes` for the record and its order slot, plus its id twice, its name and its input.
fn entry_bytes(id: &str, e: &CallEntry) -> usize {
    defaults::num("transcript.agent_call_bytes") as usize
        + id.len() * 2
        + e.name.as_ref().map_or(0, String::len)
        + e.input.as_deref().map_or(0, crate::transcript::facts::value_bytes)
}

impl Calls {
    fn get(&self, id: &str) -> Option<&CallEntry> {
        self.open.get(id).or_else(|| self.answered.get(id))
    }

    /// Count the entries again (after a snapshot load).
    fn recount(&mut self) {
        self.bytes = self.open.iter().chain(self.answered.iter()).map(|(k, v)| entry_bytes(k, v)).sum();
    }

    fn put_open(&mut self, id: &str, e: CallEntry) {
        self.bytes += entry_bytes(id, &e);
        self.open_order.push_back((e.off, id.to_string()));
        if let Some(old) = self.open.insert(id.to_string(), e) {
            self.bytes = self.bytes.saturating_sub(entry_bytes(id, &old));
        }
    }

    fn put_answered(&mut self, id: &str, e: CallEntry) {
        self.bytes += entry_bytes(id, &e);
        self.answered_order.push_back((e.off, id.to_string()));
        if let Some(old) = self.answered.insert(id.to_string(), e) {
            self.bytes = self.bytes.saturating_sub(entry_bytes(id, &old));
        }
    }

    fn take_open(&mut self, id: &str) -> Option<CallEntry> {
        let e = self.open.remove(id)?;
        self.bytes = self.bytes.saturating_sub(entry_bytes(id, &e));
        Some(e)
    }

    fn take_answered(&mut self, id: &str) -> Option<CallEntry> {
        let e = self.answered.remove(id)?;
        self.bytes = self.bytes.saturating_sub(entry_bytes(id, &e));
        Some(e)
    }

    /// Drop the calls made before `limit`; the open calls over `open_max` are dropped too, and the latest offset of those is
    /// returned (a window that holds one cannot be answered: its result would be read as a result of an unseen call).
    fn trim(&mut self, limit: u64, open_max: usize, answered_max: usize) -> Option<u64> {
        let mut lost = None;
        while let Some((off, id)) = self.open_order.front().cloned() {
            let over = self.open.len() > open_max.max(1);
            if off >= limit && !over {
                break;
            }
            self.open_order.pop_front();
            if self.open.get(&id).is_some_and(|e| e.off == off) {
                self.take_open(&id);
                if off >= limit {
                    lost = Some(lost.map_or(off, |l: u64| l.max(off)));
                }
            }
        }
        while let Some((off, id)) = self.answered_order.front().cloned() {
            if off >= limit && self.answered.len() <= answered_max.max(1) {
                break;
            }
            self.answered_order.pop_front();
            if self.answered.get(&id).is_some_and(|e| e.off == off) {
                self.take_answered(&id);
            }
        }
        // the order queues keep stale entries of answered or re-registered calls until they reach the front: compact them
        if self.open_order.len() > self.open.len() + open_max.max(1) {
            let open = &self.open;
            self.open_order.retain(|(off, id)| open.get(id).is_some_and(|e| e.off == *off));
        }
        if self.answered_order.len() > self.answered.len() + answered_max.max(1) {
            let answered = &self.answered;
            self.answered_order.retain(|(off, id)| answered.get(id).is_some_and(|e| e.off == *off));
        }
        lost
    }
}

/// The `task_status` attachment of a line (step a0).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Att {
    task_id: String,
    kind: AttKind,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
enum AttKind {
    /// A running task: adopted when not launched already.
    Running { t: Got<Ts>, output_file: String, description: String, task_type: String, shell_kind: String },
    /// A terminal status.
    Terminal,
    /// Neither.
    Other,
}

/// A teammate report the line may carry (adopted only when the teammate was spawned before it).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Idle {
    id: String,
    /// `Ok(None)`: not a genuine report of that teammate.
    ts: Got<Option<Ts>>,
}

/// A teammate spawn result (taken when the result answers a launch call or an unseen call).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Spawn {
    name: String,
    agent_id: String,
    tuid: Option<String>,
}

/// What one text of a content block may say.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TextF {
    /// Bytes of the text (what the retained-text budget counts).
    len: u64,
    /// It reads as a launch result: the agent id the text names and the output file.
    launch: Option<(Option<String>, String)>,
    resume: Got<Option<(String, bool)>>,
    queued: Got<bool>,
    inbox: Got<Option<String>>,
}

impl TextF {
    fn trivial(&self) -> bool {
        self.launch.is_none() && self.resume == Got::Ok(None) && self.queued == Got::Ok(false) && self.inbox == Got::Ok(None)
    }
}

/// One content block of a user line that the replay needs.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Block {
    /// Position of the block in the line's block list (to read its texts again).
    idx: u32,
    tuid: Option<String>,
    tool_result: bool,
    is_error: bool,
    gone: bool,
    call: Option<CallRef>,
    texts: Vec<TextF>,
}

/// What one line contributes to the walk.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ALine {
    /// Offset of the line's first byte.
    pub off: u64,
    /// Reaching the line raises Unsupported whatever came before.
    err: bool,
    ts: Ts,
    att: Option<Att>,
    /// `(tool_use id, description)` of the Agent calls.
    descs: Vec<(String, String)>,
    /// `(task_id, tool_use id)` of the TaskStop calls.
    stops: Vec<(String, Option<String>)>,
    /// Offsets of earlier calls this line registers again under another name after an answer was dropped.
    conflicts: Vec<u64>,
    /// Ids a terminal notification of the line names.
    notif_terminal: Vec<String>,
    idles: Vec<Idle>,
    spawn: Option<(Spawn, Option<CallRef>)>,
    /// `toolUseResult.agentId`, when it is an agent id.
    sid: Option<String>,
    blocks: Vec<Block>,
}

impl ALine {
    fn new(off: u64) -> ALine {
        ALine {
            off,
            err: false,
            ts: Ts(f64::NAN),
            att: None,
            descs: Vec::new(),
            stops: Vec::new(),
            conflicts: Vec::new(),
            notif_terminal: Vec::new(),
            idles: Vec::new(),
            spawn: None,
            sid: None,
            blocks: Vec::new(),
        }
    }

    fn is_empty(&self) -> bool {
        !self.err
            && self.att.is_none()
            && self.descs.is_empty()
            && self.stops.is_empty()
            && self.conflicts.is_empty()
            && self.notif_terminal.is_empty()
            && self.idles.is_empty()
            && self.spawn.is_none()
            && self.blocks.is_empty()
    }

    /// Bytes this digest holds, estimated (`fixed` per digest plus every record, string and kept input it owns).
    fn bytes(&self, fixed: usize) -> usize {
        use std::mem::size_of;
        let s = |x: &String| x.capacity();
        let os = |x: &Option<String>| x.as_ref().map_or(0, String::capacity);
        let call = |c: &Option<CallRef>| c.as_ref().map_or(0, |c| os(&c.name) + c.input.as_deref().map_or(0, crate::transcript::facts::value_bytes));
        let att = self.att.as_ref().map_or(0, |a| {
            size_of::<Att>()
                + s(&a.task_id)
                + match &a.kind {
                    AttKind::Running { output_file, description, task_type, shell_kind, .. } => s(output_file) + s(description) + s(task_type) + s(shell_kind),
                    _ => 0,
                }
        });
        let text = |t: &TextF| {
            size_of::<TextF>()
                + t.launch.as_ref().map_or(0, |(a, b)| os(a) + s(b))
                + match &t.resume {
                    Got::Ok(Some((a, _))) => s(a),
                    _ => 0,
                }
                + match &t.inbox {
                    Got::Ok(Some(a)) => s(a),
                    _ => 0,
                }
        };
        fixed
            + att
            + self.descs.iter().map(|(a, b)| size_of::<(String, String)>() + s(a) + s(b)).sum::<usize>()
            + self.stops.iter().map(|(a, b)| size_of::<(String, Option<String>)>() + s(a) + os(b)).sum::<usize>()
            + self.conflicts.capacity() * size_of::<u64>()
            + self.notif_terminal.iter().map(|a| size_of::<String>() + s(a)).sum::<usize>()
            + self.idles.iter().map(|i| size_of::<Idle>() + s(&i.id)).sum::<usize>()
            + self.spawn.as_ref().map_or(0, |(sp, c)| size_of::<(Spawn, Option<CallRef>)>() + s(&sp.name) + s(&sp.agent_id) + os(&sp.tuid) + call(c))
            + os(&self.sid)
            + self.blocks.iter().map(|b| size_of::<Block>() + os(&b.tuid) + call(&b.call) + b.texts.iter().map(text).sum::<usize>()).sum::<usize>()
    }
}

/// A result of an ordinary call: nothing of it is kept but where it and its call are.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct Span {
    /// Offset of the result's line.
    pub off: u64,
    /// Offset of the call's line.
    pub call_off: u64,
    /// A hash of the call id.
    pub id: u64,
}

fn id_hash(id: &str) -> u64 {
    id.as_bytes().iter().fold(0xcbf2_9ce4_8422_2325u64, |h, x| (h ^ u64::from(*x)).wrapping_mul(0x0000_0100_0000_01b3))
}

/// How the digest of a line finds the call a result answers.
pub trait Resolve {
    /// The call `id`, or `None` when it was not seen.
    fn call(&mut self, id: &str) -> Option<CallRef>;
    /// The call `id` is answered by this line: `pinned` when its input is read again (a launch, or a retained result), `dropped`
    /// when the answer was read past as not delivery evidence.
    fn answered(&mut self, _id: &str, _pinned: bool, _dropped: bool) {}
    /// A call registered by this line (`input` given for a launch or a delivery tool). Returns the offset of an earlier call this
    /// registers again under another name after one of its answers was dropped.
    fn register(&mut self, _id: &str, _name: Option<&str>, _input: Option<&Value>) -> Option<u64> {
        None
    }
    /// The call is an ordinary one this digest may leave as a [`Span`].
    fn spannable(&self) -> bool {
        false
    }
}

/// Resolution while the store reads the file: the calls it holds, changed as lines are folded in (`commit`), or only read (the
/// unterminated last line).
struct Live<'a> {
    calls: &'a mut Calls,
    off: u64,
    commit: bool,
}

fn keeps_input(name: Option<&str>) -> bool {
    name.is_some_and(|n| in_list("agent_scan.delivery_tools", n) || in_list("agent_scan.launch_tools", n))
}

impl Resolve for Live<'_> {
    fn call(&mut self, id: &str) -> Option<CallRef> {
        self.calls.get(id).map(|e| CallRef { off: e.off, name: e.name.clone(), input: e.input.clone() })
    }
    fn answered(&mut self, id: &str, pinned: bool, dropped: bool) {
        if !self.commit {
            return;
        }
        let e = self.calls.take_open(id).or_else(|| self.calls.take_answered(id));
        if let Some(mut e) = e {
            if !pinned {
                e.input = None;
            }
            e.dropped |= dropped;
            self.calls.put_answered(id, e);
        }
    }
    fn register(&mut self, id: &str, name: Option<&str>, input: Option<&Value>) -> Option<u64> {
        let conflict = self.calls.get(id).filter(|p| p.name.as_deref() != name && p.dropped).map(|p| p.off);
        if self.commit {
            self.calls.take_answered(id);
            let e = CallEntry {
                off: self.off,
                name: name.map(str::to_string),
                input: if keeps_input(name) { input.map(|i| Arc::new(i.clone())) } else { None },
                dropped: false,
            };
            self.calls.put_open(id, e);
        }
        conflict
    }
    fn spannable(&self) -> bool {
        true
    }
}

/// The digest of one line: what the walk takes from it, and the ordinary results it leaves as spans. `None` when the line
/// changes nothing (no prefilter word, not an object, not JSON).
fn digest(raw: &[u8], off: u64, r: &mut dyn Resolve, spans: &mut Vec<Span>) -> Option<ALine> {
    let pre = prefilter();
    let fl = if pre.fast {
        let fl = pre.flags_bytes(raw);
        if !fl.any() {
            return None;
        }
        fl
    } else {
        let s = String::from_utf8_lossy(raw);
        pre.flags_str(js_trim(&s))
    };
    if !fl.any() {
        return None;
    }
    let s = String::from_utf8_lossy(raw);
    let line = js_trim(&s);
    if line.is_empty() {
        return None;
    }
    let mut a = ALine::new(off);
    let entry = match parse_json(line) {
        Err(_) => {
            a.err = true;
            return Some(a);
        }
        Ok(None) => return None,
        Ok(Some(v)) => v,
    };
    if !entry.is_object() {
        return None;
    }
    a.ts = match sprop(&entry, "timestamp") {
        Some(t) => match date_parse(t) {
            Ok(v) => Ts(v),
            Err(_) => {
                a.err = true;
                return Some(a);
            }
        },
        None => Ts(f64::NAN),
    };
    let entry_ts = a.ts.0;

    // (a0)
    if let Some(att) = prop(&entry, "attachment")
        && sprop(att, "type") == Some("task_status")
        && let Some(task_id) = sprop(att, "taskId")
        && !task_id.is_empty()
    {
        let status = prop(att, "status");
        let kind = if status.and_then(Value::as_str) == Some("running") {
            let t = match sprop(&entry, "timestamp") {
                Some(_) => Got::Ok(a.ts),
                None => match sprop(att, "timestamp") {
                    Some(ts) => Got::of(date_parse(ts).map(Ts)),
                    None => Got::Ok(Ts(f64::NAN)),
                },
            };
            AttKind::Running {
                t,
                output_file: sprop(att, "outputFilePath").unwrap_or("").to_string(),
                description: sprop(att, "description").unwrap_or("").to_string(),
                task_type: sprop(att, "taskType").unwrap_or("").to_string(),
                shell_kind: prop(att, "shell").and_then(|sh| sprop(sh, "kind")).unwrap_or("").to_string(),
            }
        } else if is_terminal_status(&status.map_or_else(|| defaults::text("agent_scan.undefined_string").to_string(), js_to_string)) {
            AttKind::Terminal
        } else {
            AttKind::Other
        };
        a.att = Some(Att { task_id: task_id.to_string(), kind });
    }

    let content = prop(&entry, "message").and_then(|m| prop(m, "content"));
    let etype = sprop(&entry, "type");

    if fl.tool_use
        && etype == Some("assistant")
        && let Some(Value::Array(blocks)) = content
    {
        for b in blocks {
            if sprop(b, "type") == Some("tool_use")
                && let Some(id) = sprop(b, "id")
                && let Some(prev) = r.register(id, sprop(b, "name"), prop(b, "input"))
            {
                a.conflicts.push(prev);
            }
        }
    }
    if fl.agent_tu
        && etype == Some("assistant")
        && let Some(Value::Array(blocks)) = content
    {
        for b in blocks {
            if sprop(b, "type") == Some("tool_use")
                && sprop(b, "name") == Some(defaults::text("agent_scan.agent_tool"))
                && let Some(id) = sprop(b, "id")
            {
                let desc = prop(b, "input").and_then(|i| sprop(i, "description")).unwrap_or("");
                if !desc.is_empty() {
                    a.descs.push((id.to_string(), desc.to_string()));
                }
            }
        }
    }
    if fl.taskstop
        && etype == Some("assistant")
        && let Some(Value::Array(blocks)) = content
    {
        for b in blocks {
            if sprop(b, "type") == Some("tool_use")
                && sprop(b, "name") == Some(defaults::text("agent_scan.stop_tool"))
                && let Some(inp) = prop(b, "input")
                && let Some(tid) = sprop(inp, "task_id")
                && !tid.is_empty()
            {
                a.stops.push((tid.to_string(), sprop(b, "id").map(str::to_string)));
            }
        }
    }
    if fl.notif {
        for text in super::notification_texts(&entry) {
            for bm in pats().block.captures_iter(text) {
                let body = bm.get(1).map_or("", |m| m.as_str());
                let tid = pats().task_id.captures(body).and_then(|c| c.get(1).map(|m| m.as_str().to_string()));
                let st = pats().status.captures(body).and_then(|c| c.get(1).map(|m| m.as_str().to_string()));
                if let (Some(t), Some(s)) = (tid, st)
                    && !t.is_empty()
                    && is_terminal_status(&s)
                {
                    a.notif_terminal.push(t);
                }
            }
        }
    }
    if fl.idle {
        a.idles = idle_candidates(&entry, entry_ts);
    }
    if etype != Some("user") {
        return (!a.is_empty()).then_some(a);
    }

    if let Some(tur) = prop(&entry, "toolUseResult")
        && sprop(tur, "status") == Some("teammate_spawned")
        && let Some(name) = sprop(tur, "name")
        && !name.is_empty()
        && let Some(Value::Array(blocks)) = content
        && let Some(tr) = blocks.iter().find(|b| truthy(Some(b)) && sprop(b, "type") == Some("tool_result"))
    {
        let tuid = sprop(tr, "tool_use_id");
        let call = tuid.and_then(|t| r.call(t));
        a.spawn = Some((Spawn { name: name.to_string(), agent_id: sprop(tur, "agent_id").unwrap_or("").to_string(), tuid: tuid.map(str::to_string) }, call));
    }
    a.sid = prop(&entry, "toolUseResult").and_then(|t| sprop(t, "agentId")).filter(|s| pats().hex_id.is_match(s)).map(str::to_string);

    let synthetic;
    let blocks: Vec<&Value> = match content {
        Some(Value::Array(arr)) => arr.iter().collect(),
        other => {
            synthetic = match other {
                Some(c) => serde_json::json!({ "content": c }),
                None => Value::Object(Default::default()),
            };
            vec![&synthetic]
        }
    };
    let spawn_tuid = a.spawn.as_ref().and_then(|(s, _)| s.tuid.clone());
    for (idx, block) in blocks.into_iter().enumerate() {
        if !truthy(Some(block)) {
            continue;
        }
        let tuid = sprop(block, "tool_use_id");
        let block_content = prop(block, "content").unwrap_or(block);
        let is_tool_result = sprop(block, "type") == Some("tool_result");
        let mut texts: Vec<&str> = Vec::new();
        extract_text_refs(block_content, &mut texts);
        if !is_tool_result {
            // only the queued-message check reads these texts, and it is reached for each of them
            if texts.iter().any(|t| is_queued_result(t).is_err()) {
                a.err = true;
            }
            continue;
        }
        let call = tuid.and_then(|t| r.call(t));
        let class = |list: &str| call.as_ref().is_none_or(|c| c.name.as_deref().is_some_and(|n| in_list(list, n)));
        let (launch_c, resume_c, send_c) = (fl.launch && class("agent_scan.launch_tools"), class("agent_scan.resume_tools"), class("agent_scan.send_tools"));
        let delivery = call.as_ref().is_none_or(|c| c.name.as_deref().is_some_and(|n| in_list("agent_scan.delivery_tools", n)));
        let stop = call.as_ref().is_none_or(|c| c.name.as_deref() == Some(defaults::text("agent_scan.stop_tool")));
        let tf: Vec<TextF> = texts
            .iter()
            .map(|t| TextF {
                len: t.len() as u64,
                launch: (launch_c && trim_start(t).starts_with(defaults::text("agent_scan.launch_text"))).then(|| {
                    (
                        pats().agent_id.captures(t).and_then(|c| c.get(1).map(|m| m.as_str().to_string())),
                        pats().output_file.captures(t).and_then(|c| c.get(1).map(|m| m.as_str().to_string())).unwrap_or_default(),
                    )
                }),
                resume: if resume_c { Got::of(parse_resume(t)) } else { Got::Ok(None) },
                queued: Got::of(is_queued_result(t)),
                inbox: if send_c { Got::of(parse_inbox_send(t)) } else { Got::Ok(None) },
            })
            .collect();
        let gone = tuid.is_some() && texts.iter().any(|t| lower_contains(t, defaults::text("agent_scan.stop_gone_text")));
        let is_error = prop(block, "is_error") == Some(&Value::Bool(true));
        // what the walk does with the answer: pin the call (a launch, a retained result) or drop it (an ordinary call)
        let mut pinned = false;
        let mut dropped = false;
        for t in &tf {
            if t.launch.as_ref().is_some_and(|(idm, _)| a.sid.is_some() || idm.is_some()) {
                pinned = true;
            }
            if matches!(t.resume, Got::Ok(Some(_))) || t.queued != Got::Ok(false) || matches!(t.inbox, Got::Ok(Some(_))) || t.resume == Got::Unsupported {
                continue;
            }
            if delivery {
                pinned = true;
            } else {
                dropped = true;
            }
        }
        let ordinary = call.is_some() && !delivery && !stop && tf.iter().all(TextF::trivial) && tuid != spawn_tuid.as_deref();
        if let Some(t) = tuid {
            r.answered(t, pinned, dropped);
        }
        if ordinary
            && r.spannable()
            && let (Some(t), Some(c)) = (tuid, call.as_ref())
        {
            spans.push(Span { off, call_off: c.off, id: id_hash(t) });
            continue;
        }
        // a call whose input no answer reads is not kept with the digest
        let keep_input = tf.iter().any(|t| t.launch.is_some()) || delivery;
        let call = call.map(|mut c| {
            if !keep_input {
                c.input = None;
            }
            c
        });
        a.blocks.push(Block { idx: idx as u32, tuid: tuid.map(str::to_string), tool_result: true, is_error, gone, call, texts: tf });
    }
    (!a.is_empty()).then_some(a)
}

/// `teammateIdles` without the spawned-teammate test (the replay applies it): every candidate report with its outcome.
fn idle_candidates(entry: &Value, entry_ts: f64) -> Vec<Idle> {
    let mut out = Vec::new();
    if sprop(entry, "type") != Some("user") {
        return out;
    }
    let Some(c) = prop(entry, "message").and_then(|m| prop(m, "content")).and_then(Value::as_str) else { return out };
    let prefix = defaults::text("agent_scan.teammate_report_prefix");
    if !c.starts_with(prefix) {
        return out;
    }
    for k in defaults::list("agent_scan.not_a_report_keys") {
        let v = prop(entry, k);
        if k == defaults::text("agent_scan.sidechain_key") {
            if v == Some(&Value::Bool(true)) {
                return out;
            }
        } else if v.is_some() {
            return out;
        }
    }
    let skew = defaults::num("agent_scan.report_future_skew_ms") as f64;
    let mut at = prefix.len();
    at += c[at..].len() - trim_start(&c[at..]).len();
    while let Some(m) = pats().teammate_block.captures(&c[at..]) {
        let (id, body) = (m.get(1).map_or("", |x| x.as_str()), m.get(2).map_or("", |x| x.as_str()));
        at += m.get(0).map_or(0, |x| x.end());
        at += c[at..].len() - trim_start(&c[at..]).len();
        if body.contains('\n') || !body.starts_with('{') {
            continue;
        }
        let ts = (|| -> super::Res<Option<Ts>> {
            let Some(o) = parse_json(body)? else { return Ok(None) };
            if sprop(&o, "type") != Some("idle_notification") || sprop(&o, "from") != Some(id) {
                return Ok(None);
            }
            let inner = match sprop(&o, "timestamp") {
                Some(t) => date_parse(t)?,
                None => f64::NAN,
            };
            if inner.is_finite() && entry_ts.is_finite() && inner > entry_ts + skew {
                return Ok(None);
            }
            Ok(Some(Ts(if inner.is_finite() && entry_ts.is_finite() { inner } else { entry_ts })))
        })();
        out.push(Idle { id: id.to_string(), ts: Got::of(ts) });
    }
    out
}

/// Why the store cannot answer a window (the scan then reads it afresh).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Miss {
    /// The window starts before the agent digests the store holds.
    Coverage,
    /// The settings changed since the digests were made, or the two line caps differ.
    Config,
    /// A line read again is not the line the digest was made from.
    Reread,
}

impl Miss {
    /// The telemetry label.
    pub fn label(self) -> &'static str {
        match self {
            Miss::Coverage => "coverage",
            Miss::Config => "config",
            Miss::Reread => "reread",
        }
    }
}

/// The agent digests of one transcript, kept by its store session.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct AgentState {
    lines: VecDeque<ALine>,
    spans: VecDeque<Span>,
    calls: Calls,
    /// Digest of the unterminated last line (replaced at every refresh), with its spans.
    #[serde(skip)]
    pending: Option<ALine>,
    #[serde(skip)]
    pending_spans: Vec<Span>,
    /// The unterminated last line is over the line cap (the walk degrades on it).
    #[serde(skip)]
    pending_oversize: bool,
    /// A window starting at or after this offset can be answered.
    pub covered_from: u64,
    /// The settings stamp the digests were made under.
    pub stamp: u64,
    /// Bytes of the kept digests and spans (added as they come, recounted at a trim).
    #[serde(skip)]
    kept_bytes: usize,
    /// Bytes of the unterminated last line's digest.
    #[serde(skip)]
    pending_bytes: usize,
}

/// The settings the digests depend on, hashed (cached per defaults generation).
pub fn config_stamp() -> u64 {
    static CACHE: std::sync::Mutex<Option<(u64, u64)>> = std::sync::Mutex::new(None);
    let generation = defaults::generation();
    let mut c = CACHE.lock().unwrap_or_else(|e| e.into_inner());
    if let Some((g, s)) = *c
        && g == generation
    {
        return s;
    }
    let text: String =
        defaults::with_prefix(defaults::text("transcript.agent_stamp_prefix")).iter().map(|e| format!("{}={}\n", e.key, e.value.to_json())).collect();
    let s = id_hash(&text);
    *c = Some((generation, s));
    s
}

impl AgentState {
    /// An empty state that answers no window before `from`.
    pub fn starting_at(from: u64) -> AgentState {
        AgentState { covered_from: from, stamp: config_stamp(), ..AgentState::default() }
    }

    /// Bytes held.
    pub fn bytes(&self) -> usize {
        self.kept_bytes + self.calls.bytes + self.pending_bytes
    }

    /// Recount the bytes held (after a snapshot load, and at every trim).
    pub fn recount(&mut self, fixed: usize) {
        self.kept_bytes = self.lines.iter().map(|l| l.bytes(fixed)).sum::<usize>() + self.spans.len() * std::mem::size_of::<Span>();
        self.calls.recount();
        self.pending_bytes = self.pending.as_ref().map_or(0, |l| l.bytes(fixed)) + self.pending_spans.len() * std::mem::size_of::<Span>();
    }

    /// Fold one line in (`pending`: the unterminated last line, which is digested but changes nothing kept).
    pub fn ingest(&mut self, raw: &[u8], off: u64, pending: bool, fixed: usize) {
        let mut spans = Vec::new();
        let line = digest(raw, off, &mut Live { calls: &mut self.calls, off, commit: !pending }, &mut spans);
        let add = line.as_ref().map_or(0, |l| l.bytes(fixed)) + spans.len() * std::mem::size_of::<Span>();
        if pending {
            self.pending = line;
            self.pending_spans = spans;
            self.pending_bytes = add;
        } else {
            if let Some(l) = line {
                self.lines.push_back(l);
            }
            self.spans.extend(spans);
            self.kept_bytes += add;
        }
    }

    /// Forget the unterminated last line (a refresh is about to read it again).
    pub fn clear_pending(&mut self, oversize: bool) {
        self.pending = None;
        self.pending_spans.clear();
        self.pending_bytes = 0;
        self.pending_oversize = oversize;
    }

    /// Drop what is older than `size - horizon` and, over `budget` bytes, the oldest digests; the coverage mark rises for every loss.
    pub fn trim(&mut self, size: u64, horizon: u64, budget: usize, open_max: usize, answered_max: usize, fixed: usize) {
        let limit = size.saturating_sub(horizon);
        self.covered_from = self.covered_from.max(limit);
        if let Some(lost) = self.calls.trim(limit, open_max, answered_max) {
            self.covered_from = self.covered_from.max(lost + 1);
        }
        while self.lines.front().is_some_and(|l| l.off < limit) {
            self.pop_line(fixed);
        }
        while self.spans.front().is_some_and(|s| s.off < limit) {
            self.pop_span();
        }
        while self.bytes() > budget {
            let off = match (self.lines.front().map(|l| l.off), self.spans.front().map(|s| s.off)) {
                (Some(a), Some(b)) => a.min(b),
                (Some(a), None) => a,
                (None, Some(b)) => b,
                (None, None) => break,
            };
            while self.lines.front().is_some_and(|l| l.off <= off) {
                self.pop_line(fixed);
            }
            while self.spans.front().is_some_and(|s| s.off <= off) {
                self.pop_span();
            }
            self.covered_from = self.covered_from.max(off + 1);
        }
    }

    fn pop_line(&mut self, fixed: usize) {
        if let Some(l) = self.lines.pop_front() {
            self.kept_bytes = self.kept_bytes.saturating_sub(l.bytes(fixed));
        }
    }

    fn pop_span(&mut self) {
        if self.spans.pop_front().is_some() {
            self.kept_bytes = self.kept_bytes.saturating_sub(std::mem::size_of::<Span>());
        }
    }

    /// Lines held, spans held (for tests and telemetry).
    pub fn counts(&self) -> (usize, usize) {
        (self.lines.len(), self.spans.len())
    }

    /// The walk a fresh scan of the window that starts at `s` (lines starting after it; every line when `s` is 0) builds.
    /// `oversize` is the offsets of the lines the store skipped as over the cap; `reread(off)` reads the line at `off` again.
    pub(super) fn replay(&self, s: u64, oversize: &[u64], reread: &mut dyn FnMut(u64) -> Option<Vec<u8>>) -> Result<super::Res<Walk>, Miss> {
        if self.stamp != config_stamp() || defaults::num("agent_scan.max_line_bytes") != defaults::num("transcript.max_line_bytes") {
            return Err(Miss::Config);
        }
        if s < self.covered_from {
            return Err(Miss::Coverage);
        }
        let keeps = |off: u64| s == 0 || off > s;
        if self.pending_oversize || oversize.iter().any(|o| keeps(*o)) {
            crate::load::note_count("agent_scan_degraded", "reader", "store");
            return Ok(Err(super::Unsupported));
        }
        // the lines whose result answers a call made before the window: they are digested again as a fresh scan reads them
        let mut straddled: Vec<u64> = Vec::new();
        let spans = self.spans.iter().chain(self.pending_spans.iter());
        for sp in spans.filter(|sp| keeps(sp.off) && !keeps(sp.call_off)) {
            straddled.push(sp.off);
        }
        let lines: Vec<&ALine> = self.lines.iter().chain(self.pending.iter()).filter(|l| keeps(l.off)).collect();
        for l in &lines {
            let out = l.blocks.iter().filter_map(|b| b.call.as_ref()).chain(l.spawn.as_ref().and_then(|(_, c)| c.as_ref())).any(|c| !keeps(c.off));
            if out {
                straddled.push(l.off);
            }
        }
        straddled.sort_unstable();
        straddled.dedup();
        let mut redone: HashMap<u64, Option<ALine>> = HashMap::new();
        for off in &straddled {
            let Some(raw) = reread(*off) else { return Err(Miss::Reread) };
            let mut by_id: HashMap<String, CallRef> = HashMap::new();
            if let Some(l) = lines.iter().find(|l| l.off == *off) {
                for b in &l.blocks {
                    if let (Some(t), Some(c)) = (&b.tuid, &b.call) {
                        by_id.insert(t.clone(), c.clone());
                    }
                }
                if let Some((sp, Some(c))) = &l.spawn
                    && let Some(t) = &sp.tuid
                {
                    by_id.insert(t.clone(), c.clone());
                }
            }
            let line_spans: Vec<Span> = self.spans.iter().chain(self.pending_spans.iter()).filter(|sp| sp.off == *off).copied().collect();
            let mut w = Window { s, by_id, spans: line_spans };
            let mut ignored = Vec::new();
            let d = digest(&raw, *off, &mut w, &mut ignored);
            redone.insert(*off, d);
        }
        // the replay walks the window's lines in file order: the kept digests, with the ones read again in their place
        let mut order: Vec<u64> = lines.iter().map(|l| l.off).collect();
        order.extend(straddled.iter().copied());
        order.sort_unstable();
        order.dedup();
        let by_off: HashMap<u64, &ALine> = lines.iter().map(|l| (l.off, *l)).collect();
        let mut w = Walk::new();
        for (i, off) in order.iter().enumerate() {
            if i.is_multiple_of(defaults::num("agent_scan.cut_check_lines").max(1) as usize) && crate::deadline::cut_due() {
                return Ok(Err(super::Unsupported));
            }
            let l = match redone.get(off) {
                Some(d) => d.as_ref(),
                None => by_off.get(off).copied(),
            };
            if let Some(l) = l
                && let Err(e) = apply(&mut w, l, &keeps)
            {
                return Ok(Err(e));
            }
        }
        Ok(Ok(w))
    }
}

/// Resolution of a line read again for a window: a call before the window is unseen, any other is what the store resolved.
struct Window {
    s: u64,
    by_id: HashMap<String, CallRef>,
    spans: Vec<Span>,
}

impl Resolve for Window {
    fn call(&mut self, id: &str) -> Option<CallRef> {
        let keeps = |off: u64| self.s == 0 || off > self.s;
        if let Some(c) = self.by_id.get(id) {
            return keeps(c.off).then(|| c.clone());
        }
        let h = id_hash(id);
        // an ordinary call inside the window: the digest leaves its answer as it would (no name reads as no list)
        self.spans.iter().find(|sp| sp.id == h).and_then(|sp| keeps(sp.call_off).then_some(CallRef { off: sp.call_off, name: None, input: None }))
    }
}

/// One digest applied to the walk, as [`Walk::line_flagged`] applies its line (offsets stand for line numbers: only their order is read).
fn apply(w: &mut Walk, l: &ALine, keeps: &dyn Fn(u64) -> bool) -> super::Res<()> {
    if l.err {
        return Err(super::Unsupported);
    }
    let seq = l.off;
    let entry_ts = l.ts.0;
    if let Some(att) = &l.att {
        match &att.kind {
            AttKind::Running { t, output_file, description, task_type, shell_kind } => {
                if !w.launched.has(&att.task_id) {
                    let t = t.clone().res()?.0;
                    w.launched.set(
                        &att.task_id,
                        Rec {
                            adopted: true,
                            output_file: output_file.clone(),
                            description: description.clone(),
                            launched_at_ms: t,
                            tool_use_id: None,
                            resumed_at_ms: None,
                            teammate: false,
                            last_seen_ms: f64::NAN,
                            pending_message: false,
                            task_type: task_type.clone(),
                            shell_kind: shell_kind.clone(),
                            spawn_input: None,
                        },
                    );
                }
            }
            AttKind::Terminal => w.mark_terminal(&att.task_id, seq, entry_ts),
            AttKind::Other => {}
        }
    }
    if l.conflicts.iter().any(|p| keeps(*p)) {
        return Err(super::Unsupported);
    }
    for (id, desc) in &l.descs {
        w.desc_by_tool_use.insert(id.clone(), desc.clone());
    }
    for (tid, tuid) in &l.stops {
        w.stops.push(Stop { id: tid.clone(), seq, tool_use_id: tuid.clone(), ts: entry_ts });
    }
    for t in &l.notif_terminal {
        w.mark_terminal(t, seq, entry_ts);
    }
    let mut idles = Vec::new();
    for i in &l.idles {
        if !w.team_info.has(&i.id) {
            continue;
        }
        if let Some(ts) = i.ts.clone().res()? {
            idles.push((i.id.clone(), ts.0));
        }
    }
    for (id, ts) in idles {
        w.team_event(&id, "idle", ts, seq);
    }
    fn seen<'a>(c: &'a Option<CallRef>, keeps: &dyn Fn(u64) -> bool) -> Option<&'a CallRef> {
        c.as_ref().filter(|c| keeps(c.off))
    }
    if let Some((sp, call)) = &l.spawn {
        let answers = seen(call, keeps).is_none_or(|c| c.name.as_deref().is_some_and(|n| in_list("agent_scan.launch_tools", n)));
        if answers {
            w.team_event(&sp.name, "spawn", entry_ts, seq);
            w.team_info.set(&sp.name, TeamInfo { tool_use_id: sp.tuid.clone(), agent_id: sp.agent_id.clone() });
        }
    }
    for b in &l.blocks {
        let tuid = b.tuid.as_deref();
        if b.tool_result
            && b.is_error
            && let Some(id) = tuid
        {
            w.errored.insert(id);
        }
        if b.tool_result
            && let Some(id) = tuid
        {
            w.answered.insert(id);
        }
        if b.tool_result
            && b.gone
            && let Some(id) = tuid
        {
            w.gone.insert(id);
        }
        let call = seen(&b.call, keeps);
        let answers = |list: &str| call.is_none_or(|c| c.name.as_deref().is_some_and(|n| in_list(list, n)));
        let mut pinned = false;
        for (ti, t) in b.texts.iter().enumerate() {
            if b.tool_result
                && answers("agent_scan.launch_tools")
                && let Some((idm, of)) = &t.launch
                && let Some(id) = l.sid.clone().or_else(|| idm.clone())
            {
                w.launched.set(
                    &id,
                    Rec {
                        adopted: false,
                        output_file: of.clone(),
                        description: String::new(),
                        launched_at_ms: entry_ts,
                        tool_use_id: tuid.map(str::to_string),
                        resumed_at_ms: None,
                        teammate: false,
                        last_seen_ms: f64::NAN,
                        pending_message: false,
                        task_type: String::new(),
                        shell_kind: String::new(),
                        spawn_input: None,
                    },
                );
                pinned = true;
            }
            let resume = if b.tool_result && answers("agent_scan.resume_tools") { t.resume.clone().res()? } else { None };
            if let Some((rid, full)) = resume {
                if full {
                    w.resume_full.insert(rid.clone());
                }
                w.resume_seq.set(&rid, seq);
                if entry_ts.is_finite() {
                    w.resume_ts.insert(rid, entry_ts);
                } else {
                    w.resume_ts.remove(&rid);
                }
                continue;
            }
            if t.queued.clone().res()? {
                continue;
            }
            let inbox = if b.tool_result && answers("agent_scan.send_tools") { t.inbox.clone().res()? } else { None };
            if let Some(name) = inbox {
                w.team_event(&name, "send", entry_ts, seq);
                continue;
            }
            if b.tool_result {
                if let Some(c) = call
                    && !c.name.as_deref().is_some_and(|n| in_list("agent_scan.delivery_tools", n))
                {
                    if let Some(id) = tuid {
                        w.dropped_ids.insert(id);
                    }
                    continue;
                }
                w.other_bytes += t.len;
                if w.other_bytes > defaults::num("agent_scan.retain_bytes") {
                    return Err(super::Unsupported);
                }
                w.others.push(Other {
                    tool_use_id: tuid.map(str::to_string),
                    text: String::new(),
                    seq,
                    ts: entry_ts,
                    off: l.off,
                    at: Some((b.idx, ti as u32, t.len)),
                });
                pinned = true;
            }
        }
        // the inputs `finish` reads: a launch's (spawnInput) and a retained result's call (namesAgent)
        if pinned && let (Some(t), Some(c)) = (tuid, call) {
            w.tool_uses.insert(t, ToolUse { name: c.name.clone(), input: c.input.clone(), off: c.off, used: std::cell::Cell::new(0) });
        }
    }
    Ok(())
}

/// The text a retained result held: its line read again at `o.off`, block `at.0`, text `at.1`, which must be `at.2` bytes long.
pub fn text_at(raw: &[u8], at: (u32, u32, u64)) -> Option<String> {
    let s = String::from_utf8_lossy(raw);
    let entry = parse_json(js_trim(&s)).ok()??;
    let content = prop(&entry, "message").and_then(|m| prop(m, "content"));
    let synthetic;
    let block: &Value = match content {
        Some(Value::Array(arr)) => arr.get(at.0 as usize)?,
        other => {
            synthetic = match other {
                Some(c) => serde_json::json!({ "content": c }),
                None => Value::Object(Default::default()),
            };
            &synthetic
        }
    };
    let mut texts: Vec<&str> = Vec::new();
    extract_text_refs(prop(block, "content").unwrap_or(block), &mut texts);
    let t = texts.get(at.1 as usize)?;
    (t.len() as u64 == at.2).then(|| t.to_string())
}
