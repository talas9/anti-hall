//! The part of `devswarm.js roster` that reads a child's session transcript: `childBusyState`
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
//! calls and the set of answered call ids is kept. A line the parser rejects but JavaScript reads (a lone surrogate escape, a number
//! past the range of a double, nesting past the parser's limit) is read after a repair that changes only that part; an array
//! where a text is expected is read as the text `String()` gives it; an entry time is read by `Date.parse`'s rules.
//!
//! Every limit, marker and text is a plugin setting (`devswarm_cli.rr_tr_*`).
use crate::checks::guardkit::text::{collapse_ws, js_trim, js_trim_start, lossy_owned};
use crate::checks::jsport::num::to_js_string;
use crate::defaults;
use crate::meshw::extverbs::tpl;
use crate::meshw::ident::R;
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
    /// An array, as the text `String(array)` gives (its elements joined with commas, null as nothing).
    Arr(String),
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
            Sc::Arr(_) | Sc::Obj => true,
        }
    }
    /// `String(x)`.
    fn js_string(&self) -> String {
        match self {
            Sc::Null => "null".into(),
            Sc::Bool(b) => b.to_string(),
            Sc::Num(n) => to_js_string(*n),
            Sc::Str(s) => s.clone(),
            Sc::Obj => "[object Object]".into(),
            Sc::Arr(text) => text.clone(),
        }
    }
    /// How an element reads inside `Array.prototype.join`: null as nothing.
    fn joined(&self) -> String {
        if matches!(self, Sc::Null) { String::new() } else { self.js_string() }
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
        let mut parts: Vec<String> = Vec::new();
        while let Some(el) = a.next_element::<Sc>()? {
            parts.push(el.joined());
        }
        Ok(Sc::Arr(parts.join(",")))
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
    /// The truncated question of an unresolved human-wait tool call.
    question: Option<String>,
    /// `isMailboxTool(block)` of a tool call.
    mailbox: bool,
}

impl Default for Blk {
    fn default() -> Blk {
        Blk { ty: None, tool_use_id: None, text: None, id: None, name: None, question: None, mailbox: false }
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
        if is_ty(&b.ty, key("devswarm_cli.rr_tr_block_tool_use")) {
            let name = match &b.name {
                Some(n) if n.truthy() => n.js_string(),
                _ => String::new(),
            };
            b.mailbox = super::mboxtool::is_mailbox_tool(&name, input.as_ref());
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

/// `truncateQuestionText`: whitespace collapsed and trimmed, cut to `rr_tr_question_len` UTF-16 units with the ellipsis. A cut inside a
/// surrogate pair leaves JavaScript a lone surrogate, which text here cannot hold: it reads as the replacement character.
fn truncate_question(s: Option<&str>) -> Option<String> {
    let t = js_trim(&collapse_ws(s.unwrap_or(""))).to_string();
    if t.is_empty() {
        return None;
    }
    let max = defaults::num("devswarm_cli.rr_tr_question_len") as usize;
    if t.encode_utf16().count() <= max {
        return Some(t);
    }
    let head: Vec<u16> = t.encode_utf16().take(max - 1).collect();
    Some(format!("{}{}", String::from_utf16_lossy(&head), key("devswarm_cli.ellipsis")))
}

/// `extractQuestionText(tu)` then `truncateQuestionText`: the first `questions[0].question`, else `question`, of an
/// AskUserQuestion input; the `plan` of an ExitPlanMode input.
fn extract_question(name: &str, input: Option<&Value>) -> Option<String> {
    let Some(Value::Object(o)) = input else { return None };
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

/// `Number.isFinite(Date.parse(e.timestamp))`: the strict stamp (`rr_tr_iso_pattern`) certainly reads; any other text is `Date.parse`'s
/// to read (`jsport::date`), and one whose reading is not reproduced counts as no time (the row then carries no hint, as when the
/// transcript has no time at all).
fn entry_time_is_finite(k: &Keys, ts: &Sc) -> bool {
    use crate::checks::jsport::date::{Parsed, parse};
    let text = ts.js_string();
    if k.iso.as_ref().is_some_and(|re| re.is_match(&text)) {
        return true;
    }
    matches!(parse(&text), Parsed::Ms(ms) if ms.is_finite())
}

/// `line` with what only JavaScript's `JSON.parse` accepts repaired, parsed without the depth limit: a lone surrogate escape reads as
/// the replacement character, a number past the range of a double as a very large one. `None` for a line nested past
/// `rr_tr_max_depth` (no real transcript nests so far) or that still does not parse.
fn parse_repaired(line: &str) -> Option<Entry> {
    use serde::Deserialize as _;
    let mut out = String::with_capacity(line.len());
    let b = line.as_bytes();
    let (mut i, mut depth, mut deepest) = (0usize, 0usize, 0usize);
    let hex4 = |at: usize| -> Option<u32> { u32::from_str_radix(line.get(at..at + 4)?, 16).ok() };
    while i < b.len() {
        match b[i] {
            b'"' => {
                out.push('"');
                i += 1;
                while i < b.len() && b[i] != b'"' {
                    if b[i] == b'\\' && i + 1 < b.len() {
                        if b[i + 1] == b'u' {
                            let cp = hex4(i + 2);
                            let low_follows = |at: usize| line.get(at..at + 2) == Some("\\u") && hex4(at + 2).is_some_and(|c| (0xDC00..0xE000).contains(&c));
                            match cp {
                                Some(c) if (0xD800..0xDC00).contains(&c) && low_follows(i + 6) => {
                                    out.push_str(&line[i..i + 12]);
                                    i += 12;
                                }
                                Some(c) if (0xD800..0xE000).contains(&c) => {
                                    out.push_str(key("devswarm_cli.rr_tr_lone_surrogate"));
                                    i += 6;
                                }
                                _ => {
                                    out.push_str(&line[i..(i + 2).min(line.len())]);
                                    i += 2;
                                }
                            }
                        } else {
                            // an escaped character (an escaped quote included) is copied as it is, whatever it is
                            let end = (i + 2..=line.len().min(i + 5)).find(|e| line.is_char_boundary(*e)).unwrap_or(line.len());
                            out.push_str(&line[i..end]);
                            i = end;
                        }
                    } else {
                        let end = (i + 1..=line.len()).find(|e| line.is_char_boundary(*e)).unwrap_or(line.len());
                        out.push_str(&line[i..end]);
                        i = end;
                    }
                }
                if i < b.len() {
                    out.push('"');
                    i += 1;
                }
            }
            b'{' | b'[' => {
                depth += 1;
                deepest = deepest.max(depth);
                out.push(b[i] as char);
                i += 1;
            }
            b'}' | b']' => {
                depth = depth.saturating_sub(1);
                out.push(b[i] as char);
                i += 1;
            }
            c if c == b'-' || c.is_ascii_digit() => {
                let start = i;
                while i < b.len() && (b[i].is_ascii_digit() || matches!(b[i], b'+' | b'-' | b'.' | b'e' | b'E')) {
                    i += 1;
                }
                let token = &line[start..i];
                match token.parse::<f64>() {
                    Ok(n) if n.is_infinite() => {
                        if token.starts_with('-') {
                            out.push('-');
                        }
                        out.push_str(key("devswarm_cli.rr_tr_big_number"));
                    }
                    _ => out.push_str(token),
                }
            }
            _ => {
                let end = (i + 1..=line.len()).find(|e| line.is_char_boundary(*e)).unwrap_or(line.len());
                out.push_str(&line[i..end]);
                i = end;
            }
        }
    }
    if deepest > defaults::num("devswarm_cli.rr_tr_max_depth") as usize {
        return None;
    }
    let mut de = serde_json::Deserializer::from_str(&out);
    de.disable_recursion_limit();
    let e = Entry::deserialize(&mut de).ok()?;
    de.end().ok()?;
    Some(e)
}

struct Tool {
    id: Option<Sc>,
    name: Option<Sc>,
    question: Option<String>,
    mailbox: bool,
}

#[derive(Default)]
struct Turn {
    tools: Vec<Tool>,
    closed: bool,
    /// A prompt opened the turn (an orphan turn, whose prompt fell before the window, has none).
    prompted: bool,
    /// The opening prompt was the child's own wake (a cron fire, a mailbox-wake notification, a stop-hook feedback).
    wake: bool,
}

/// The settings the per-entry walk compares with, read once per call.
struct Keys {
    /// The strict form of an entry time that certainly parses (a fast path; `None` when the pattern does not compile).
    iso: Option<regex::Regex>,
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
}

/// `promptText(entry)`: the text a user prompt gives `wakeTrigger`; `None` is null.
fn prompt_text(c: &Content, k: &Keys) -> Option<String> {
    match c {
        Content::Str(s) => Some(s.clone()),
        Content::Arr(bs) => {
            if bs.iter().any(|b| is_ty(&b.ty, k.tool_result)) {
                return None;
            }
            let Some(t) = bs.iter().find(|b| is_ty(&b.ty, k.text)) else {
                return Some(String::new());
            };
            Some(match &t.text {
                None => String::new(),
                Some(v) if !v.truthy() => String::new(),
                Some(Sc::Str(s)) => s.clone(),
                // `String(array)` begins like its first element
                Some(Sc::Arr(text)) => text.clone(),
                // `String(x)` of a number, true or an object can never begin like a notification or a hook prompt
                Some(_) => key("devswarm_cli.rr_tr_inert_text").to_string(),
            })
        }
        Content::Other => None,
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
    fn open(&mut self, wake: bool) {
        self.cur = Some(Turn { prompted: true, wake, ..Turn::default() });
    }

    fn apply(&mut self, e: Entry) {
        if e.side.as_ref().is_some_and(Sc::truthy) {
            return;
        }
        if e.ts.as_ref().is_some_and(|ts| entry_time_is_finite(&self.k, ts)) {
            self.finite_ts = true;
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
                        self.answered.insert(id.js_string());
                    }
                }
            }
            let p = content.and_then(|c| prompt_text(c, &self.k));
            let meta = e.meta.as_ref().is_some_and(Sc::truthy);
            match p {
                Some(t) if !meta => {
                    self.cron = false;
                    // a human prompt is real work; only a notification that is the mailbox wake is a wake
                    let wake = js_trim_start(&t).starts_with(key("devswarm_cli.rr_tr_notification_tag")) && wakes(&t);
                    self.open(wake);
                }
                Some(t) if self.cron || wakes(&t) => {
                    self.cron = false;
                    self.open(true);
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
                        t.tools.push(Tool { id: clone_sc(&b.id), name: clone_sc(&b.name), question: b.question.clone(), mailbox: b.mailbox });
                    }
                }
            }
            t.closed = false;
        }
    }
}

fn clone_sc(v: &Option<Sc>) -> Option<Sc> {
    v.as_ref().map(|s| match s {
        Sc::Null => Sc::Null,
        Sc::Bool(b) => Sc::Bool(*b),
        Sc::Num(n) => Sc::Num(*n),
        Sc::Str(s) => Sc::Str(s.clone()),
        Sc::Arr(text) => Sc::Arr(text.clone()),
        Sc::Obj => Sc::Obj,
    })
}

/// `String(tu.name || '')`.
fn tool_name(v: &Option<Sc>) -> String {
    match v {
        Some(s) if s.truthy() => s.js_string(),
        _ => String::new(),
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

/// `realActivity`'s way to the transcript of a child (id, worktree and session all set): `None` when the heartbeat of the child
/// names another session (Node then knows nothing of this one); otherwise the session's transcript file under the project
/// directory of the worktree. Anything JavaScript would read differently defers.
pub fn transcript_file(home: &Path, id: &str, wt: &str, session: &str) -> R<Option<std::path::PathBuf>> {
    let beat = if crate::meshw::idlock::is_safe_id(id) {
        let p = crate::meshw::idlock::devswarm_root(home).join(key("mesh_write.dir_heartbeats")).join(format!("{id}{}", key("mesh_write.json_suffix")));
        std::fs::read(p).ok().and_then(|b| crate::checks::guardkit::ojson::OVal::parse(&String::from_utf8_lossy(&b)))
    } else {
        None
    };
    if let Some(theirs) = beat.as_ref().and_then(|b| b.get(key("mesh_write.field_session_id")))
        && theirs.truthy()
    {
        // `String(beat.sessionId)`
        if crate::meshw::ident::js_to_string(theirs) != session {
            return Ok(None);
        }
    }
    let from = key("devswarm_sup.lv_encode_chars");
    let encoded: String = wt.chars().map(|c| if from.contains(c) { key("devswarm_sup.lv_encode_to").to_string() } else { c.to_string() }).collect();
    // `path.join(projectDir, session + '.jsonl')`: the join normalizes, so a session with a separator or `..` lands where Node's does
    let joined = format!(
        "{}/{}/{}/{encoded}/{session}{}",
        home.display(),
        key("mesh_write.claude_dir"),
        key("devswarm_sup.lv_projects_dir"),
        key("devswarm_sup.lv_transcript_ext")
    );
    Ok(Some(std::path::PathBuf::from(crate::checks::git::util::posix_normalize(&joined))))
}

/// What one pass over the window found: the walk, and the transcript's modification time (ms).
struct Scan {
    w: Walk,
    mtime: f64,
}

/// The bounded pass over the transcript `file`: `None` when Node reports nothing (a missing, unreadable or empty file; no entry
/// with a time).
fn scan(file: &Path) -> R<Option<Scan>> {
    let Some((text, mtime)) = read_window(file, defaults::num("devswarm_cli.rr_tr_tail_bytes")) else { return Ok(None) };
    let k = Keys {
        iso: regex::Regex::new(key("devswarm_cli.rr_tr_iso_pattern")).ok(),
        tool_use: key("devswarm_cli.rr_tr_block_tool_use"),
        tool_result: key("devswarm_cli.rr_tr_block_tool_result"),
        text: key("devswarm_cli.rr_tr_block_text"),
        fire: key("devswarm_cli.rr_tr_subtype_fire"),
        types: defaults::list("devswarm_cli.rr_tr_types"),
        close: defaults::list("devswarm_cli.rr_tr_subtypes_close"),
    };
    let mut w = Walk { k, cur: None, cron: false, answered: HashSet::new(), finite_ts: false };
    for line in text.split('\n') {
        if line.is_empty() {
            continue;
        }
        match serde_json::from_str::<Entry>(line) {
            Ok(e) => w.apply(e),
            Err(err) => {
                // a line JavaScript's parser reads but this one rejects is read after the repair; any other failure is a line
                // `JSON.parse` throws on too: skipped
                let msg = err.to_string();
                if defaults::list("devswarm_cli.rr_tr_defer_errors").iter().any(|m| msg.contains(m)) {
                    match parse_repaired(line) {
                        Some(e) => w.apply(e),
                        None => crate::metrics::bump(key("devswarm_cli.rr_tr_metric_skipped"), &[]),
                    }
                }
            }
        }
    }
    // no entry has a time: Node reports nothing
    if !w.finite_ts {
        return Ok(None);
    }
    Ok(Some(Scan { w, mtime }))
}

/// The unresolved tool call of the last turn, when that turn is still open.
fn open_tool(w: &Walk) -> R<Option<Open>> {
    let open = match &w.cur {
        Some(t) if !t.closed => {
            let mut found = None;
            for tu in t.tools.iter().rev() {
                let id = tu.id.as_ref().filter(|v| !matches!(v, Sc::Null)).map(Sc::js_string);
                if id.as_deref().is_some_and(|i| !i.is_empty() && !w.answered.contains(i)) {
                    found = Some(Open { tool: tool_name(&tu.name), question: tu.question.clone() });
                    break;
                }
            }
            found
        }
        _ => None,
    };
    Ok(open.filter(|o| !o.tool.is_empty()))
}

fn is_fresh(now: f64, mtime: f64, fresh_ms: f64) -> bool {
    let age = now - mtime;
    age <= fresh_ms && age >= -(defaults::num("devswarm_cli.rr_tr_future_skew_ms") as f64)
}

/// The roster hint of a child whose transcript is `file`, at `now` (ms): `Some` text when it waits on a human.
pub fn waiting_hint(file: &Path, now: f64) -> R<Option<String>> {
    let Some(sc) = scan(file)? else { return Ok(None) };
    let Some(open) = open_tool(&sc.w)? else { return Ok(None) };
    let fresh = is_fresh(now, sc.mtime, defaults::num("devswarm_cli.rr_tr_fresh_ms") as f64);
    let human = defaults::list("devswarm_cli.rr_tr_wait_tools").contains(&open.tool.as_str());
    if !(human || !fresh) {
        return Ok(None);
    }
    Ok(Some(match open.question {
        Some(q) => tpl("devswarm_cli.rr_hint_waiting_q", &[("question", &q)]),
        None => key("devswarm_cli.rr_hint_waiting").to_string(),
    }))
}

/// `childBusyState` for a transcript that exists: busy (a fresh transcript whose last turn is real work), waiting on a human
/// (with the question preview). Not busy and not waiting for everything Node cannot tell (the unknown cases).
pub struct Busy {
    /// The transcript is fresh and its last turn is real work.
    pub busy: bool,
    /// The last turn is open on a human-wait tool, or on any unresolved tool call in a transcript gone quiet.
    pub waiting: bool,
    /// The preview of the unresolved question (only meaningful with `waiting`).
    pub question: Option<String>,
    /// The transcript was read (it exists and holds entries): "not busy" is then a fact, not just the unknown cases.
    pub seen: bool,
}

/// `childBusyState(desc, home, { now, freshMs })` from `realActivity` on: the transcript `file` at `now`, fresh within `fresh_ms`.
pub fn busy_state(file: &Path, now: f64, fresh_ms: f64) -> R<Busy> {
    let none = Busy { busy: false, waiting: false, question: None, seen: false };
    let Some(sc) = scan(file)? else { return Ok(none) };
    let none = Busy { seen: true, ..none };
    let open = open_tool(&sc.w)?;
    let fresh = is_fresh(now, sc.mtime, fresh_ms);
    if let Some(o) = &open
        && (defaults::list("devswarm_cli.rr_tr_wait_tools").contains(&o.tool.as_str()) || !fresh)
    {
        return Ok(Busy { busy: false, waiting: true, question: o.question.clone(), seen: true });
    }
    if !fresh {
        return Ok(none);
    }
    // the last turn is real work unless it is a ping: a wake (or, with its prompt before the window, any turn) whose every call
    // is mailbox-class
    let Some(t) = &sc.w.cur else { return Ok(none) };
    let ping = if t.prompted { t.wake && all_mailbox(t)? } else { !t.tools.is_empty() && all_mailbox(t)? };
    Ok(Busy { busy: !ping, waiting: false, question: None, seen: true })
}

fn all_mailbox(t: &Turn) -> R<bool> {
    Ok(t.tools.iter().all(|tool| tool.mailbox))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn transcript(tag: &str, lines: &[&str]) -> std::path::PathBuf {
        let d = std::env::temp_dir().join(format!("ah-tail-{tag}-{}", std::process::id()));
        crate::discard::harmless(std::fs::remove_dir_all(&d)); // keep: a stale directory of an earlier run of this test
        std::fs::create_dir_all(&d).unwrap();
        let f = d.join("t.jsonl");
        std::fs::write(&f, lines.join("\n") + "\n").unwrap();
        f
    }

    const PROMPT: &str = r#"{"type":"user","timestamp":"2026-10-30T10:00:00.000Z","message":{"role":"user","content":"go"}}"#;
    const NOW: f64 = 1_793_354_401_000.0; // 2026-10-30T10:00:01Z

    fn ask(extra: &str) -> String {
        format!(
            r#"{{"type":"assistant","timestamp":"2026-10-30T10:00:01.000Z","message":{{"content":[{{"type":"tool_use","id":"toolu_1","name":"AskUserQuestion","input":{{"question":"{extra}"}}}}]}}}}"#
        )
    }

    /// A day after the 28th is not in the strict stamp form, but `Date.parse` reads it: the child waiting on a question is shown.
    #[test]
    fn an_entry_time_after_the_28th_is_read_like_any_other() {
        let f = transcript("day30", &[PROMPT, &ask("Which one?")]);
        assert_eq!(waiting_hint(&f, NOW).unwrap().as_deref(), Some("waiting-on-human: Which one?"));
    }

    /// A lone surrogate escape, a number past the range of a double and an array where a text or an id is expected are all lines
    /// JavaScript reads; none hands the roster to Node.
    #[test]
    fn lines_only_javascript_reads_are_read() {
        let lone = ask(r"hi \ud800 there");
        let f = transcript("lone", &[PROMPT, &lone]);
        let hint = waiting_hint(&f, NOW).unwrap().unwrap();
        assert!(hint.starts_with("waiting-on-human: hi ") && hint.ends_with(" there"), "{hint}");
        let big = r#"{"type":"system","subtype":"x","timestamp":"2026-10-30T10:00:00.500Z","n":1e999}"#;
        let f = transcript("big", &[PROMPT, big, &ask("still read")]);
        assert_eq!(waiting_hint(&f, NOW).unwrap().as_deref(), Some("waiting-on-human: still read"));
        // a tool call id that is an array, answered by a result whose id is the same array
        let array_id = r#"{"type":"assistant","timestamp":"2026-10-30T10:00:01.000Z","message":{"content":[{"type":"tool_use","id":["a","b"],"name":"AskUserQuestion","input":{"question":"q"}}]}}"#;
        let answered = r#"{"type":"user","timestamp":"2026-10-30T10:00:02.000Z","message":{"content":[{"type":"tool_result","tool_use_id":["a","b"]}]}}"#;
        let f = transcript("arrid", &[PROMPT, array_id]);
        assert!(waiting_hint(&f, NOW).unwrap().is_some());
        let f = transcript("arrans", &[PROMPT, array_id, answered]);
        assert!(waiting_hint(&f, NOW).unwrap().is_none(), "the result answers the call");
    }

    /// The preview is cut at 120 UTF-16 units; a cut inside an emoji reads as the replacement character, not as a handover.
    #[test]
    fn a_cut_inside_a_surrogate_pair_reads_as_the_replacement_character() {
        let text = format!("{}\u{1F600} end", "a".repeat(118));
        let f = transcript("cut", &[PROMPT, &ask(&text)]);
        let hint = waiting_hint(&f, NOW).unwrap().unwrap();
        assert!(hint.ends_with("\u{fffd}\u{2026}"), "{hint}");
    }

    /// `path.join` normalizes: a session id with a separator or `..` reaches the file Node reads, no deferral.
    #[test]
    fn a_session_id_with_a_separator_reaches_the_file_node_reads() {
        let home = std::env::temp_dir();
        let p = transcript_file(&home, "id", "/w/x", "../other/s1").unwrap().unwrap();
        assert!(p.ends_with("other/s1.jsonl"), "{}", p.display());
        assert!(!p.to_string_lossy().contains(".."), "{}", p.display());
    }

    #[test]
    fn the_strict_time_pattern_compiles() {
        assert!(regex::Regex::new(key("devswarm_cli.rr_tr_iso_pattern")).is_ok());
    }
}
