//! The part of `devswarm.js roster` that reads a child's session transcript: `childBusyState` (companion/lib/devswarm-idle.js)
//! as `rosterHints` calls it, reduced to the one question the row asks, "is the child waiting on a human".
//!
//! Node reads the last `tail_bytes` of the transcript (dropping the first, cut line when the file is longer), walks the entries
//! in order and splits them into turns (`classifyTranscript`); the last turn, when still open, is searched backwards for a tool
//! call that has no result anywhere in the window. A human-wait tool (a question, a plan approval) left open means the child
//! waits; so does any other unresolved tool call when the transcript has not been written for the fresh window. The row then
//! carries `waiting-on-human: <question>`.
//!
//! The same read here is one bounded pass: the window is read once from the file, each line is parsed straight into only the
//! fields the turn walk looks at (everything else is skipped by the parser, never built), and nothing but the last turn's tool
//! calls and the set of answered call ids is kept. Anything this walk cannot settle exactly as JavaScript would (a number the
//! parser rejects, an id that is an array, a timestamp in a form it does not recognise and no other entry gives one) is handed
//! to Node.
//!
//! Every limit, marker and text is a plugin setting (`devswarm_cli.rr_tr_*`).
use crate::checks::jsport::num::to_js_string;
use crate::checks::guardkit::text::{collapse_ws, js_trim, js_trim_start, lossy_owned, slice_utf16};
use crate::defaults;
use crate::meshw::extverbs::tpl;
use crate::meshw::ident::{R, defer};
use serde::de::{Deserialize, Deserializer, IgnoredAny, MapAccess, SeqAccess, Visitor};
use serde_json::Value;
use std::collections::HashSet;
use std::fmt;
use std::io::{Read, Seek, SeekFrom};
use std::os::unix::fs::MetadataExt;
use std::path::Path;

fn key(k: &str) -> &'static str {
    defaults::text(k)
}

// ---------------------------------------------------------------------------------------------------------------------
// the lax JSON the walk reads
// ---------------------------------------------------------------------------------------------------------------------

/// A JSON value reduced to what the walk compares: scalars as they are, containers only as "a container".
enum Sc {
    Null,
    Bool(bool),
    Num(f64),
    Str(String),
    Arr,
    Obj,
}

impl Sc {
    fn str(&self) -> Option<&str> {
        match self {
            Sc::Str(s) => Some(s),
            _ => None,
        }
    }
    /// JavaScript truthiness.
    fn truthy(&self) -> bool {
        match self {
            Sc::Null => false,
            Sc::Bool(b) => *b,
            Sc::Num(n) => *n != 0.0 && !n.is_nan(),
            Sc::Str(s) => !s.is_empty(),
            Sc::Arr | Sc::Obj => true,
        }
    }
    /// `String(x)`; an array (its text is its elements') is not reproduced.
    fn js_string(&self) -> Result<String, ()> {
        match self {
            Sc::Null => Ok("null".into()),
            Sc::Bool(b) => Ok(b.to_string()),
            Sc::Num(n) => Ok(to_js_string(*n)),
            Sc::Str(s) => Ok(s.clone()),
            Sc::Obj => Ok("[object Object]".into()),
            Sc::Arr => Err(()),
        }
    }
}

fn is_ty(v: &Option<Sc>, want: &str) -> bool {
    v.as_ref().and_then(Sc::str) == Some(want)
}

struct ScVisitor;

impl<'de> Visitor<'de> for ScVisitor {
    type Value = Sc;
    fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
        f.write_str(key("devswarm_cli.rr_tr_expecting"))
    }
    fn visit_bool<E>(self, v: bool) -> Result<Sc, E> {
        Ok(Sc::Bool(v))
    }
    fn visit_i64<E>(self, v: i64) -> Result<Sc, E> {
        Ok(Sc::Num(v as f64))
    }
    fn visit_u64<E>(self, v: u64) -> Result<Sc, E> {
        Ok(Sc::Num(v as f64))
    }
    fn visit_f64<E>(self, v: f64) -> Result<Sc, E> {
        Ok(Sc::Num(v))
    }
    fn visit_str<E>(self, v: &str) -> Result<Sc, E> {
        Ok(Sc::Str(v.to_string()))
    }
    fn visit_string<E>(self, v: String) -> Result<Sc, E> {
        Ok(Sc::Str(v))
    }
    fn visit_unit<E>(self) -> Result<Sc, E> {
        Ok(Sc::Null)
    }
    fn visit_seq<A: SeqAccess<'de>>(self, mut a: A) -> Result<Sc, A::Error> {
        while a.next_element::<IgnoredAny>()?.is_some() {}
        Ok(Sc::Arr)
    }
    fn visit_map<A: MapAccess<'de>>(self, mut m: A) -> Result<Sc, A::Error> {
        while m.next_key::<IgnoredAny>()?.is_some() {
            m.next_value::<IgnoredAny>()?;
        }
        Ok(Sc::Obj)
    }
}

impl<'de> Deserialize<'de> for Sc {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Sc, D::Error> {
        d.deserialize_any(ScVisitor)
    }
}

/// One element of a `content` array. Only objects carry fields; anything else reads as a block with none (`b.type` of a
/// string, a number or an array is `undefined`).
struct Blk {
    ty: Option<Sc>,
    tool_use_id: Option<Sc>,
    text: Option<Sc>,
    id: Option<Sc>,
    name: Option<Sc>,
    /// The truncated question of an unresolved human-wait tool call (`Err`: the cut falls inside a surrogate pair).
    question: Result<Option<String>, ()>,
}

impl Default for Blk {
    fn default() -> Blk {
        Blk { ty: None, tool_use_id: None, text: None, id: None, name: None, question: Ok(None) }
    }
}

struct BlkVisitor;

impl<'de> Visitor<'de> for BlkVisitor {
    type Value = Blk;
    fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
        f.write_str(key("devswarm_cli.rr_tr_expecting"))
    }
    fn visit_bool<E>(self, _: bool) -> Result<Blk, E> {
        Ok(Blk::default())
    }
    fn visit_i64<E>(self, _: i64) -> Result<Blk, E> {
        Ok(Blk::default())
    }
    fn visit_u64<E>(self, _: u64) -> Result<Blk, E> {
        Ok(Blk::default())
    }
    fn visit_f64<E>(self, _: f64) -> Result<Blk, E> {
        Ok(Blk::default())
    }
    fn visit_str<E>(self, _: &str) -> Result<Blk, E> {
        Ok(Blk::default())
    }
    fn visit_unit<E>(self) -> Result<Blk, E> {
        Ok(Blk::default())
    }
    fn visit_seq<A: SeqAccess<'de>>(self, mut a: A) -> Result<Blk, A::Error> {
        while a.next_element::<IgnoredAny>()?.is_some() {}
        Ok(Blk::default())
    }
    fn visit_map<A: MapAccess<'de>>(self, mut m: A) -> Result<Blk, A::Error> {
        let mut b = Blk::default();
        let mut input: Option<Value> = None;
        while let Some(k) = m.next_key::<String>()? {
            match k.as_str() {
                "type" => b.ty = Some(m.next_value()?),
                "tool_use_id" => b.tool_use_id = Some(m.next_value()?),
                "text" => b.text = Some(m.next_value()?),
                "id" => b.id = Some(m.next_value()?),
                "name" => b.name = Some(m.next_value()?),
                // only a human-wait tool call's input is ever read, and the name may follow it, so it is kept until the
                // block ends
                "input" => input = Some(m.next_value()?),
                _ => {
                    m.next_value::<IgnoredAny>()?;
                }
            }
        }
        if is_ty(&b.ty, key("devswarm_cli.rr_tr_block_tool_use"))
            && let Some(name) = b.name.as_ref().and_then(Sc::str)
            && defaults::list("devswarm_cli.rr_tr_wait_tools").contains(&name)
        {
            b.question = extract_question(name, input.as_ref());
        }
        Ok(b)
    }
}

impl<'de> Deserialize<'de> for Blk {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Blk, D::Error> {
        d.deserialize_any(BlkVisitor)
    }
}

/// `message.content`: a string, an array of blocks, or something else.
enum Content {
    Str(String),
    Arr(Vec<Blk>),
    Other,
}

struct ContentVisitor;

impl<'de> Visitor<'de> for ContentVisitor {
    type Value = Content;
    fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
        f.write_str(key("devswarm_cli.rr_tr_expecting"))
    }
    fn visit_bool<E>(self, _: bool) -> Result<Content, E> {
        Ok(Content::Other)
    }
    fn visit_i64<E>(self, _: i64) -> Result<Content, E> {
        Ok(Content::Other)
    }
    fn visit_u64<E>(self, _: u64) -> Result<Content, E> {
        Ok(Content::Other)
    }
    fn visit_f64<E>(self, _: f64) -> Result<Content, E> {
        Ok(Content::Other)
    }
    fn visit_str<E>(self, v: &str) -> Result<Content, E> {
        Ok(Content::Str(v.to_string()))
    }
    fn visit_string<E>(self, v: String) -> Result<Content, E> {
        Ok(Content::Str(v))
    }
    fn visit_unit<E>(self) -> Result<Content, E> {
        Ok(Content::Other)
    }
    fn visit_seq<A: SeqAccess<'de>>(self, mut a: A) -> Result<Content, A::Error> {
        let mut v = Vec::new();
        while let Some(b) = a.next_element::<Blk>()? {
            v.push(b);
        }
        Ok(Content::Arr(v))
    }
    fn visit_map<A: MapAccess<'de>>(self, mut m: A) -> Result<Content, A::Error> {
        while m.next_key::<IgnoredAny>()?.is_some() {
            m.next_value::<IgnoredAny>()?;
        }
        Ok(Content::Other)
    }
}

impl<'de> Deserialize<'de> for Content {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Content, D::Error> {
        d.deserialize_any(ContentVisitor)
    }
}

/// `entry.message`: only its `content` is read.
struct Message(Option<Content>);

struct MessageVisitor;

impl<'de> Visitor<'de> for MessageVisitor {
    type Value = Message;
    fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
        f.write_str(key("devswarm_cli.rr_tr_expecting"))
    }
    fn visit_bool<E>(self, _: bool) -> Result<Message, E> {
        Ok(Message(None))
    }
    fn visit_i64<E>(self, _: i64) -> Result<Message, E> {
        Ok(Message(None))
    }
    fn visit_u64<E>(self, _: u64) -> Result<Message, E> {
        Ok(Message(None))
    }
    fn visit_f64<E>(self, _: f64) -> Result<Message, E> {
        Ok(Message(None))
    }
    fn visit_str<E>(self, _: &str) -> Result<Message, E> {
        Ok(Message(None))
    }
    fn visit_unit<E>(self) -> Result<Message, E> {
        Ok(Message(None))
    }
    fn visit_seq<A: SeqAccess<'de>>(self, mut a: A) -> Result<Message, A::Error> {
        while a.next_element::<IgnoredAny>()?.is_some() {}
        Ok(Message(None))
    }
    fn visit_map<A: MapAccess<'de>>(self, mut m: A) -> Result<Message, A::Error> {
        let mut c = None;
        while let Some(k) = m.next_key::<String>()? {
            if k == "content" {
                c = Some(m.next_value::<Content>()?);
            } else {
                m.next_value::<IgnoredAny>()?;
            }
        }
        Ok(Message(c))
    }
}

impl<'de> Deserialize<'de> for Message {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Message, D::Error> {
        d.deserialize_any(MessageVisitor)
    }
}

/// One transcript line.
#[derive(Default)]
struct Entry {
    ty: Option<Sc>,
    subtype: Option<Sc>,
    side: Option<Sc>,
    meta: Option<Sc>,
    ts: Option<Sc>,
    message: Option<Message>,
}

struct EntryVisitor;

macro_rules! scalar_entry {
    ($($f:ident: $t:ty),*) => { $(fn $f<E>(self, _: $t) -> Result<Entry, E> { Ok(Entry::default()) })* };
}

impl<'de> Visitor<'de> for EntryVisitor {
    type Value = Entry;
    fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
        f.write_str(key("devswarm_cli.rr_tr_expecting"))
    }
    scalar_entry!(visit_bool: bool, visit_i64: i64, visit_u64: u64, visit_f64: f64, visit_str: &str);
    fn visit_unit<E>(self) -> Result<Entry, E> {
        Ok(Entry::default())
    }
    fn visit_seq<A: SeqAccess<'de>>(self, mut a: A) -> Result<Entry, A::Error> {
        while a.next_element::<IgnoredAny>()?.is_some() {}
        Ok(Entry::default())
    }
    fn visit_map<A: MapAccess<'de>>(self, mut m: A) -> Result<Entry, A::Error> {
        let mut e = Entry::default();
        while let Some(k) = m.next_key::<String>()? {
            match k.as_str() {
                "type" => e.ty = Some(m.next_value()?),
                "subtype" => e.subtype = Some(m.next_value()?),
                "isSidechain" => e.side = Some(m.next_value()?),
                "isMeta" => e.meta = Some(m.next_value()?),
                "timestamp" => e.ts = Some(m.next_value()?),
                "message" => e.message = Some(m.next_value()?),
                _ => {
                    m.next_value::<IgnoredAny>()?;
                }
            }
        }
        Ok(e)
    }
}

impl<'de> Deserialize<'de> for Entry {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Entry, D::Error> {
        d.deserialize_any(EntryVisitor)
    }
}

// ---------------------------------------------------------------------------------------------------------------------
// the question of an open human-wait tool call
// ---------------------------------------------------------------------------------------------------------------------

/// `truncateQuestionText`: whitespace collapsed and trimmed, cut to `rr_tr_question_len` UTF-16 units with the ellipsis; `Err`
/// when the cut would split a surrogate pair.
fn truncate_question(s: Option<&str>) -> Result<Option<String>, ()> {
    let t = js_trim(&collapse_ws(s.unwrap_or(""))).to_string();
    if t.is_empty() {
        return Ok(None);
    }
    let max = defaults::num("devswarm_cli.rr_tr_question_len") as usize;
    if t.encode_utf16().count() <= max {
        return Ok(Some(t));
    }
    match slice_utf16(&t, max - 1) {
        Some(head) => Ok(Some(format!("{head}{}", key("devswarm_cli.ellipsis")))),
        None => Err(()),
    }
}

/// `extractQuestionText(tu)` then `truncateQuestionText`: the first `questions[0].question`, else `question`, of an
/// AskUserQuestion input; the `plan` of an ExitPlanMode input.
fn extract_question(name: &str, input: Option<&Value>) -> Result<Option<String>, ()> {
    let Some(Value::Object(o)) = input else { return Ok(None) };
    let tools = defaults::list("devswarm_cli.rr_tr_wait_tools");
    let raw: Option<&str> = if tools.first() == Some(&name) {
        let first = match o.get(key("devswarm_cli.rr_tr_questions_field")) {
            Some(Value::Array(a)) if !a.is_empty() => a[0].get(key("devswarm_cli.rr_tr_question_field")).and_then(Value::as_str),
            _ => None,
        };
        first.or_else(|| o.get(key("devswarm_cli.rr_tr_question_field")).and_then(Value::as_str))
    } else if tools.get(1) == Some(&name) {
        o.get(key("devswarm_cli.rr_tr_plan_field")).and_then(Value::as_str)
    } else {
        None
    };
    truncate_question(raw)
}

// ---------------------------------------------------------------------------------------------------------------------
// the walk
// ---------------------------------------------------------------------------------------------------------------------

/// A strict stamp (`rr_tr_iso_pattern`) that `Date.parse` certainly reads.
fn is_iso(re: &regex::Regex, s: &str) -> bool {
    re.is_match(s)
}

struct Tool {
    id: Option<Sc>,
    name: Option<Sc>,
    question: Result<Option<String>, ()>,
}

#[derive(Default)]
struct Turn {
    tools: Vec<Tool>,
    closed: bool,
}

/// The settings the per-entry walk compares with, read once per call.
struct Keys {
    iso: regex::Regex,
    tool_use: &'static str,
    tool_result: &'static str,
    text: &'static str,
    fire: &'static str,
    types: Vec<&'static str>,
    close: Vec<&'static str>,
}

struct Walk {
    k: Keys,
    cur: Option<Turn>,
    cron: bool,
    answered: HashSet<String>,
    finite_ts: bool,
    odd_ts: bool,
}

/// `promptText(entry)`: the text a user prompt gives `wakeTrigger`; `None` is null.
fn prompt_text(c: &Content, k: &Keys) -> R<Option<String>> {
    match c {
        Content::Str(s) => Ok(Some(s.clone())),
        Content::Arr(bs) => {
            if bs.iter().any(|b| is_ty(&b.ty, k.tool_result)) {
                return Ok(None);
            }
            let Some(t) = bs.iter().find(|b| is_ty(&b.ty, k.text)) else {
                return Ok(Some(String::new()));
            };
            Ok(Some(match &t.text {
                None => String::new(),
                Some(v) if !v.truthy() => String::new(),
                Some(Sc::Str(s)) => s.clone(),
                // `String(x)` of a number, true or an object can never begin like a notification or a hook prompt
                Some(Sc::Arr) => return defer("prompt-text-array"),
                Some(_) => key("devswarm_cli.rr_tr_inert_text").to_string(),
            }))
        }
        Content::Other => Ok(None),
    }
}

/// `wakeTrigger(text, false)`.
fn wakes(text: &str) -> bool {
    let t = js_trim_start(text);
    if t.starts_with(key("devswarm_cli.rr_tr_notification_tag")) {
        let lower = t.to_ascii_lowercase();
        return defaults::list("devswarm_cli.rr_tr_wake_words").iter().any(|w| lower.contains(w));
    }
    t.starts_with(key("devswarm_cli.rr_tr_stop_prefix"))
}

impl Walk {
    fn open(&mut self) {
        self.cur = Some(Turn::default());
    }

    fn apply(&mut self, e: Entry) -> R<()> {
        if e.side.as_ref().is_some_and(Sc::truthy) {
            return Ok(());
        }
        match &e.ts {
            Some(Sc::Str(s)) if is_iso(&self.k.iso, s) => self.finite_ts = true,
            Some(Sc::Str(s)) if s.is_empty() => {}
            Some(Sc::Null) | None => {}
            Some(_) => self.odd_ts = true,
        }
        let ty = e.ty.as_ref().and_then(Sc::str);
        let (t_sys, t_user, t_asst) = (self.k.types.first().copied(), self.k.types.get(1).copied(), self.k.types.get(2).copied());
        let content = e.message.as_ref().and_then(|m| m.0.as_ref());
        if ty == t_sys {
            let sub = e.subtype.as_ref().and_then(Sc::str);
            if sub == Some(self.k.fire) {
                self.cron = true;
            } else if sub.is_some_and(|s| self.k.close.contains(&s))
                && let Some(t) = &mut self.cur
            {
                t.closed = true;
            }
        } else if ty == t_user {
            if let Some(Content::Arr(bs)) = content {
                for b in bs {
                    if is_ty(&b.ty, self.k.tool_result)
                        && let Some(id) = b.tool_use_id.as_ref().filter(|v| !matches!(v, Sc::Null))
                    {
                        match id.js_string() {
                            Ok(s) => {
                                self.answered.insert(s);
                            }
                            Err(()) => return defer("tool-use-id-type"),
                        }
                    }
                }
            }
            let p = match content {
                Some(c) => prompt_text(c, &self.k)?,
                None => None,
            };
            let meta = e.meta.as_ref().is_some_and(Sc::truthy);
            match p {
                Some(_) if !meta => {
                    self.cron = false;
                    self.open();
                }
                Some(t) if self.cron || wakes(&t) => {
                    self.cron = false;
                    self.open();
                }
                _ => {
                    let t = self.cur.get_or_insert_with(Turn::default);
                    t.closed = false;
                }
            }
        } else if ty == t_asst {
            let t = self.cur.get_or_insert_with(Turn::default);
            if let Some(Content::Arr(bs)) = content {
                for b in bs {
                    if is_ty(&b.ty, self.k.tool_use) {
                        t.tools.push(Tool { id: clone_sc(&b.id), name: clone_sc(&b.name), question: b.question.clone() });
                    }
                }
            }
            t.closed = false;
        }
        Ok(())
    }
}

fn clone_sc(v: &Option<Sc>) -> Option<Sc> {
    v.as_ref().map(|s| match s {
        Sc::Null => Sc::Null,
        Sc::Bool(b) => Sc::Bool(*b),
        Sc::Num(n) => Sc::Num(*n),
        Sc::Str(s) => Sc::Str(s.clone()),
        Sc::Arr => Sc::Arr,
        Sc::Obj => Sc::Obj,
    })
}

/// `String(tu.name || '')`.
fn tool_name(v: &Option<Sc>) -> R<String> {
    match v {
        None => Ok(String::new()),
        Some(s) if !s.truthy() => Ok(String::new()),
        Some(s) => s.js_string().or_else(|()| defer("tool-name-array")),
    }
}

/// What the window says: the unresolved tool call of the last open turn, if any.
struct Open {
    tool: String,
    question: Option<String>,
}

/// The bounded read of the tail window: `None` when the transcript is missing, unreadable or yields no text.
fn read_window(file: &Path, tail: u64) -> Option<(String, f64)> {
    let mut f = std::fs::File::open(file).ok()?;
    let m = f.metadata().ok()?;
    if !m.is_file() {
        return None;
    }
    let size = m.len();
    let start = size.saturating_sub(tail);
    f.seek(SeekFrom::Start(start)).ok()?;
    let mut buf = Vec::with_capacity((size - start) as usize);
    f.take(size - start).read_to_end(&mut buf).ok()?;
    let mtime = m.mtime() as f64 * 1000.0 + m.mtime_nsec() as f64 / 1e6;
    let from = if start > 0 {
        let nl = buf.iter().position(|&c| c == b'\n')?;
        nl + 1
    } else {
        0
    };
    buf.drain(..from);
    if buf.is_empty() {
        return None;
    }
    Some((lossy_owned(buf), mtime))
}

/// The roster hint of a child whose transcript is `file`, at `now` (ms): `Some` text when it waits on a human.
pub fn waiting_hint(file: &Path, now: f64) -> R<Option<String>> {
    let Some((text, mtime)) = read_window(file, defaults::num("devswarm_cli.rr_tr_tail_bytes")) else { return Ok(None) };
    let Ok(iso) = regex::Regex::new(key("devswarm_cli.rr_tr_iso_pattern")) else { return defer("iso-pattern") };
    let k = Keys {
        iso,
        tool_use: key("devswarm_cli.rr_tr_block_tool_use"),
        tool_result: key("devswarm_cli.rr_tr_block_tool_result"),
        text: key("devswarm_cli.rr_tr_block_text"),
        fire: key("devswarm_cli.rr_tr_subtype_fire"),
        types: defaults::list("devswarm_cli.rr_tr_types"),
        close: defaults::list("devswarm_cli.rr_tr_subtypes_close"),
    };
    let mut w = Walk { k, cur: None, cron: false, answered: HashSet::new(), finite_ts: false, odd_ts: false };
    for line in text.split('\n') {
        if line.is_empty() {
            continue;
        }
        match serde_json::from_str::<Entry>(line) {
            Ok(e) => w.apply(e)?,
            Err(err) => {
                let msg = err.to_string();
                if defaults::list("devswarm_cli.rr_tr_defer_errors").iter().any(|m| msg.contains(m)) {
                    return defer("transcript-json");
                }
            }
        }
    }
    if !w.finite_ts {
        // no entry has a time: Node cannot tell and reports nothing; an unrecognised form of time it might have read
        return if w.odd_ts { defer("transcript-timestamp") } else { Ok(None) };
    }
    let open = match &w.cur {
        Some(t) if !t.closed => {
            let mut found = None;
            for tu in t.tools.iter().rev() {
                let id = match tu.id.as_ref().filter(|v| !matches!(v, Sc::Null)) {
                    Some(v) => match v.js_string() {
                        Ok(s) => Some(s),
                        Err(()) => return defer("tool-id-type"),
                    },
                    None => None,
                };
                if id.as_deref().is_some_and(|i| !i.is_empty() && !w.answered.contains(i)) {
                    let question = tu.question.clone().or_else(|()| defer("surrogate-cut"))?;
                    found = Some(Open { tool: tool_name(&tu.name)?, question });
                    break;
                }
            }
            found
        }
        _ => None,
    };
    let Some(open) = open.filter(|o| !o.tool.is_empty()) else { return Ok(None) };
    let age = now - mtime;
    let fresh = age <= defaults::num("devswarm_cli.rr_tr_fresh_ms") as f64 && age >= -(defaults::num("devswarm_cli.rr_tr_future_skew_ms") as f64);
    let human = defaults::list("devswarm_cli.rr_tr_wait_tools").contains(&open.tool.as_str());
    if !(human || !fresh) {
        return Ok(None);
    }
    Ok(Some(match open.question {
        Some(q) => tpl("devswarm_cli.rr_hint_waiting_q", &[("question", &q)]),
        None => key("devswarm_cli.rr_hint_waiting").to_string(),
    }))
}
