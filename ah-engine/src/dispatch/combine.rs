//! Combining the results of one event's hook entries into the one answer a single hook process can give (D58).
//!
//! The host runs separate hooks in parallel and reads each one's output on its own (Claude Code and Codex hook docs,
//! quoted in `defaults/dispatch.toml`). One process has one exit code and one stdout, so the dispatcher answers as
//! follows, in `hooks.json` order:
//!
//! 1. **A block wins.** One blocking entry (exit 2, or JSON that blocks per `dispatch.blocking_decisions`) is the answer,
//!    byte for byte. Several blocking entries are one block that carries every one of their reasons, in table order, as the
//!    host shows the model each of them (`blocked`); the JSON advisories of the entries that did not block ride along (their
//!    messages and contexts join the block's) only when the block exits 0: on exit 2 the host ignores stdout JSON and reads
//!    stderr alone, so there the advisories (and notes) are carried in the JSON for parity but the host does not read them.
//! 2. **One answer passes through.** When exactly one entry printed anything or exited non-zero, its output, stderr
//!    and exit code are the answer, byte for byte.
//! 3. **Several answers merge.** Each stdout must be a JSON object. Their fields are merged in order of first
//!    appearance: `additionalContext` values are joined (`dispatch.context_joiner`), `systemMessage` values are
//!    joined (`dispatch.message_joiner`), the strongest `permissionDecision` wins (`dispatch.decision_precedence`)
//!    with its own reason, and any other field must be equal everywhere it appears. stderr is concatenated.
//!    An empty `additionalContext` says nothing to the host (it skips an empty one), so an answer never carries one
//!    ([`tidy`]): the field is left out, and an output left with nothing is no output.
//! 4. **Anything else is a conflict** (plain-text stdout next to another answer, a non-zero exit next to another
//!    answer, or two different values for one field): the dispatcher cannot express it, so it defers the whole call
//!    rather than guess.
//!
//! Key order and string escaping follow `JSON.stringify` (keys in order of first appearance), so the merged line
//! is byte-identical to what the reference combiner in `parity/dispatch-lib.js` builds from the separate Node hooks.
// Discard triage (E3): every `.ok()` / `unwrap_or_default()` in this file is a deliberate keep, for these reasons:
// - text that does not parse or decode is the absent value (Node Number()/JSON.parse catch parity)
// A failure that must be seen goes through `crate::discard` instead.

use crate::client::Outcome;
use crate::defaults;
use serde::de::{Deserialize, Deserializer, MapAccess, SeqAccess, Visitor};

/// What one hook entry produced.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HookResult {
    /// The entry's id in the dispatch table.
    pub id: String,
    /// Its exit code; `None` when it did not finish in time or could not start (the host then has no decision).
    pub code: Option<i32>,
    /// Its stdout.
    pub out: String,
    /// Its stderr.
    pub err: String,
}

impl HookResult {
    /// A result that says nothing (an allow).
    pub fn quiet(id: &str) -> HookResult {
        HookResult { id: id.to_string(), code: Some(0), out: String::new(), err: String::new() }
    }

    fn active(&self) -> bool {
        self.code.is_some() && (self.code != Some(0) || !self.out.is_empty() || !self.err.is_empty())
    }
}

/// The combined answer.
#[derive(Debug, PartialEq, Eq)]
pub enum Combined {
    /// One output for the host.
    Answer(Outcome),
    /// The results cannot be expressed as one output; these entries conflict.
    Conflict(Vec<String>),
}

/// A JSON value that keeps object keys in document order (as `JSON.parse` does), so a merge can reproduce
/// `JSON.stringify`'s key order.
#[derive(Debug, Clone, PartialEq)]
pub enum Ordered {
    /// `null`, a boolean or a number: kept as a `serde_json` value.
    Scalar(serde_json::Value),
    /// A string.
    Str(String),
    /// An array.
    List(Vec<Ordered>),
    /// An object, keys in document order (a repeated key keeps its first position and its last value, like JS).
    Obj(Vec<(String, Ordered)>),
}

impl<'de> Deserialize<'de> for Ordered {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Ordered, D::Error> {
        struct V;
        impl<'de> Visitor<'de> for V {
            type Value = Ordered;
            fn expecting(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
                f.write_str("JSON")
            }
            fn visit_unit<E>(self) -> Result<Ordered, E> {
                Ok(Ordered::Scalar(serde_json::Value::Null))
            }
            fn visit_bool<E>(self, b: bool) -> Result<Ordered, E> {
                Ok(Ordered::Scalar(b.into()))
            }
            fn visit_i64<E>(self, n: i64) -> Result<Ordered, E> {
                Ok(Ordered::Scalar(n.into()))
            }
            fn visit_u64<E>(self, n: u64) -> Result<Ordered, E> {
                Ok(Ordered::Scalar(n.into()))
            }
            fn visit_f64<E>(self, n: f64) -> Result<Ordered, E> {
                Ok(Ordered::Scalar(serde_json::Number::from_f64(n).map_or(serde_json::Value::Null, serde_json::Value::Number)))
            }
            fn visit_str<E>(self, s: &str) -> Result<Ordered, E> {
                Ok(Ordered::Str(s.to_string()))
            }
            fn visit_string<E>(self, s: String) -> Result<Ordered, E> {
                Ok(Ordered::Str(s))
            }
            fn visit_seq<A: SeqAccess<'de>>(self, mut a: A) -> Result<Ordered, A::Error> {
                let mut v = Vec::new();
                while let Some(x) = a.next_element()? {
                    v.push(x);
                }
                Ok(Ordered::List(v))
            }
            fn visit_map<A: MapAccess<'de>>(self, mut a: A) -> Result<Ordered, A::Error> {
                let mut v: Vec<(String, Ordered)> = Vec::new();
                while let Some((k, x)) = a.next_entry::<String, Ordered>()? {
                    match v.iter_mut().find(|(e, _)| *e == k) {
                        Some(slot) => slot.1 = x,
                        None => v.push((k, x)),
                    }
                }
                Ok(Ordered::Obj(v))
            }
        }
        d.deserialize_any(V)
    }
}

impl Ordered {
    /// Serialize the way `JSON.stringify` does (no spaces, keys in stored order).
    pub fn to_json(&self) -> String {
        match self {
            Ordered::Scalar(v) => v.to_string(),
            Ordered::Str(s) => serde_json::Value::String(s.clone()).to_string(),
            Ordered::List(a) => format!("[{}]", a.iter().map(Ordered::to_json).collect::<Vec<_>>().join(",")),
            Ordered::Obj(o) => {
                let parts: Vec<String> = o.iter().map(|(k, v)| format!("{}:{}", serde_json::Value::String(k.clone()), v.to_json())).collect();
                format!("{{{}}}", parts.join(","))
            }
        }
    }

    fn get(&self, key: &str) -> Option<&Ordered> {
        match self {
            Ordered::Obj(o) => o.iter().find(|(k, _)| k == key).map(|(_, v)| v),
            _ => None,
        }
    }

    fn as_str(&self) -> Option<&str> {
        match self {
            Ordered::Str(s) => Some(s),
            _ => None,
        }
    }
}

/// Parse a hook's stdout the way the host decides it is JSON: trimmed, it starts with `{` and ends with `}` and
/// parses as an object.
pub fn parse_object(out: &str) -> Option<Ordered> {
    let t = out.trim();
    if !(t.starts_with('{') && t.ends_with('}')) {
        return None;
    }
    let mut de = serde_json::Deserializer::from_str(t);
    let v = Ordered::deserialize(&mut de).ok()?;
    de.end().ok()?;
    matches!(v, Ordered::Obj(_)).then_some(v)
}

/// The `hookSpecificOutput.additionalContext` string of one hook's stdout, when it has one.
pub fn context_of(out: &str) -> Option<String> {
    let v = parse_object(out)?;
    v.get("hookSpecificOutput")?.get("additionalContext")?.as_str().map(str::to_string)
}

/// The results delivered as one answer when [`combine`] found they cannot be expressed exactly (a conflict, or a join the
/// wrapper cannot take), exit 0, nothing silently dropped that the host would have acted on. The host reads a hook's whole
/// stdout as ONE JSON object or as plain text, so two JSON lines printed one after another would be read as text and every
/// decision in them lost. So:
///
/// - the JSON objects among the stdouts of the hooks that exited 0 are merged into one line by the same rules as
///   [`combine`] (strongest `permissionDecision` wins, `additionalContext` and `systemMessage` values joined), except that a
///   field two hooks set to different values keeps the first hook's value instead of being a conflict;
/// - plain-text stdout next to such JSON cannot share the stdout with it. On an event where plain stdout is context for the
///   model (`dispatch.plain_context_events`) it is folded into the merged `additionalContext`, in hook order, so it still
///   reaches the model; on any other event it is appended to stderr;
/// - with no JSON at all, the plain-text stdouts are delivered one after another, each ended with a newline;
/// - the stderr of every hook that finished is kept, in order. Blocks never get here ([`combine`] answers them first).
pub fn sequential(results: &[HookResult], event: &str) -> Outcome {
    let live: Vec<&HookResult> = results.iter().filter(|r| r.code.is_some()).collect();
    let mut err: String = live.iter().map(|r| r.err.as_str()).collect();
    let said: Vec<&HookResult> = live.iter().copied().filter(|r| r.code == Some(0) && !r.out.is_empty()).collect();
    let (json, plain): (Vec<&HookResult>, Vec<&HookResult>) = said.iter().copied().partition(|r| parse_object(&r.out).is_some());
    // plain stdout is model context on these events: make each such text a context of its own, so it joins the JSON ones
    let as_context: Vec<HookResult>;
    let (json, plain) = if !json.is_empty() && !plain.is_empty() && defaults::list("dispatch.plain_context_events").contains(&event) {
        as_context = said
            .iter()
            .map(|r| {
                if parse_object(&r.out).is_some() {
                    return (*r).clone();
                }
                let hso = serde_json::json!({ "hookEventName": event, "additionalContext": r.out.trim_end_matches('\n') });
                HookResult { out: format!("{}\n", serde_json::json!({ "hookSpecificOutput": hso })), ..(*r).clone() }
            })
            .collect();
        (as_context.iter().collect(), Vec::new())
    } else {
        (json, plain)
    };
    let lines = |rs: &[&HookResult]| -> String { rs.iter().map(|r| if r.out.ends_with('\n') { r.out.clone() } else { format!("{}\n", r.out) }).collect() };
    if json.is_empty() {
        return Outcome { out: lines(&plain), code: 0, err };
    }
    let out = match json.as_slice() {
        [one] => lines(&[*one]),
        many => match merge(many, true) {
            Combined::Answer(o) => o.out,
            Combined::Conflict(_) => lines(&many[..1]),
        },
    };
    err.push_str(&lines(&plain));
    Outcome { out: tidy(&out), code: 0, err }
}

/// True when this output blocks through its JSON (`dispatch.blocking_decisions`).
pub(crate) fn json_blocks(out: &str) -> bool {
    let Some(v) = parse_object(out) else { return false };
    let table = defaults::raw("dispatch.blocking_decisions");
    let blocks = |field: &str, val: Option<&Ordered>| val.and_then(Ordered::as_str).is_some_and(|s| table.get(field).is_some_and(|l| l.strings().contains(&s)));
    let field = "permissionDecision";
    blocks("decision", v.get("decision")) || blocks(field, v.get("hookSpecificOutput").and_then(|h| h.get(field)))
}

fn verbatim(r: &HookResult) -> Combined {
    Combined::Answer(Outcome { out: r.out.clone(), code: r.code.unwrap_or(0), err: r.err.clone() })
}

/// `out` without what says nothing to the host (it ignores an empty `additionalContext`): an empty context is left out, then
/// a `hookSpecificOutput` left with only its `hookEventName`, and an object left with no field is no output at all. Any other
/// output is returned as it is, byte for byte.
pub fn tidy(out: &str) -> String {
    let Some(Ordered::Obj(mut top)) = parse_object(out) else { return out.to_string() };
    let Some((_, Ordered::Obj(hso))) = top.iter_mut().find(|(k, _)| k == HSO_KEY) else { return out.to_string() };
    if !hso.iter().any(|(k, v)| k == HSO_CTX && *v == Ordered::Str(String::new())) {
        return out.to_string();
    }
    hso.retain(|(k, _)| k != HSO_CTX);
    if hso.iter().all(|(k, _)| k == HSO_EVENT) {
        top.retain(|(k, _)| k != HSO_KEY);
    }
    if top.is_empty() { String::new() } else { format!("{}\n", Ordered::Obj(top).to_json()) }
}

/// True when this result blocks: exit 2, or a JSON block from a hook that finished.
pub(crate) fn blocks(r: &HookResult) -> bool {
    r.code == Some(2) || (r.code.is_some() && json_blocks(&r.out))
}

const TOP_DECISION: &str = "decision";
const TOP_REASON: &str = "reason";
const TOP_MSG: &str = "systemMessage";
const HSO_KEY: &str = "hookSpecificOutput";
const HSO_REASON: &str = "permissionDecisionReason";
const HSO_CTX: &str = "additionalContext";
const HSO_EVENT: &str = "hookEventName";

/// True when a top-level `decision` value blocks: the block's reason is then the top-level `reason`; any other JSON block is
/// a `hookSpecificOutput` deny, whose reason is its `permissionDecisionReason`.
fn decision_blocks(d: Option<&Ordered>) -> bool {
    let table = defaults::raw("dispatch.blocking_decisions");
    d.and_then(Ordered::as_str).is_some_and(|s| table.get(TOP_DECISION).is_some_and(|l| l.strings().contains(&s)))
}

/// The text the host gives the model for one blocking result: a JSON block's reason (the host takes it over stderr even on
/// exit 2), else the stderr of the exit 2, without its trailing newlines.
fn block_reason(r: &HookResult) -> String {
    let text = match parse_object(&r.out).filter(|_| json_blocks(&r.out)) {
        Some(v) if decision_blocks(v.get(TOP_DECISION)) => v.get(TOP_REASON).and_then(Ordered::as_str).unwrap_or_default().to_string(),
        Some(v) => v.get(HSO_KEY).and_then(|h| h.get(HSO_REASON)).and_then(Ordered::as_str).unwrap_or_default().to_string(),
        None => r.err.clone(),
    };
    text.trim_end_matches('\n').to_string()
}

/// Set `key` in an object: in place when it is there, else at the end.
fn set(obj: &mut Vec<(String, Ordered)>, key: &str, v: Ordered) {
    match obj.iter_mut().find(|(k, _)| k == key) {
        Some(slot) => slot.1 = v,
        None => obj.push((key.to_string(), v)),
    }
}

/// The answer for several blocking results (rule 1 of the module docs). The host runs the hooks separately and gives the
/// model every block's reason (each Stop or SubagentStop block is its own message), so one process must carry them all, in
/// table order, joined with `dispatch.reason_joiner`. A reason is what the host reads: a JSON block's reason (taken over
/// stderr even on exit 2), else the stderr of the exit 2.
///
/// - When a block is JSON, the first such object is the answer, its reason field set to the joined reasons and its
///   `systemMessage` to the joined messages of every block; the exit code is 2 when any block exited 2. On exit 2 the host
///   ignores stdout JSON and reads stderr alone, which is the joined reasons; so the advisories and notes that ride in the JSON
///   take effect only when the block exits 0 (then stderr is the blocks' own stderr). The plain stdout of an exit-2 block cannot share stdout with the JSON; the host does not show it to the model.
/// - Otherwise the answer is exit 2 with the joined reasons on stderr, and the plain stdout of the blocks, in order, on
///   stdout (the host does not read it on exit 2, as for one hook).
///
/// `notes` is the plain stdout of the entries that exited 0 without blocking (a guard's informational line). The host does not
/// give the model such text on an event whose plain stdout is not context (Stop, PreToolUse, ...), so it is kept where it says
/// nothing to the model either: after the blocks' plain stdout on an exit 2 without JSON, else on stderr after the rest, as
/// [`sequential`] moves plain text next to JSON. It is only added when there is some: a lone block stays byte for byte.
fn blocked(blockers: &[&HookResult], advisories: &[&HookResult], notes: &str) -> Combined {
    if let ([one], [], "") = (blockers, advisories, notes) {
        return verbatim(one);
    }
    let reasons: Vec<String> = blockers.iter().map(|r| block_reason(r)).filter(|s| !s.is_empty()).collect();
    let joined = reasons.join(defaults::text("dispatch.reason_joiner"));
    let line = |s: &str| if s.ends_with('\n') { s.to_string() } else { format!("{s}\n") };
    let reasons_err = if joined.is_empty() { String::new() } else { line(&joined) };
    let exit2 = blockers.iter().any(|r| r.code == Some(2));
    let Some(Ordered::Obj(mut top)) = blockers.iter().find(|r| json_blocks(&r.out)).and_then(|r| parse_object(&r.out)) else {
        let plain: String = blockers.iter().filter(|r| !r.out.is_empty() && parse_object(&r.out).is_none()).map(|r| line(&r.out)).collect();
        return Combined::Answer(Outcome { out: plain + notes, code: 2, err: reasons_err });
    };
    if decision_blocks(top.iter().find(|(k, _)| k == TOP_DECISION).map(|(_, v)| v)) {
        set(&mut top, TOP_REASON, Ordered::Str(joined));
    } else if let Some((_, Ordered::Obj(hso))) = top.iter_mut().find(|(k, _)| k == HSO_KEY) {
        set(hso, HSO_REASON, Ordered::Str(joined));
    }
    // The host reads each hook's own answer, so an advisory of a hook that did not block is shown next to the block: its
    // message joins the block's messages, its context joins the block's context (or is added when the block has none).
    let say = |r: &&HookResult, key: &str| parse_object(&r.out).and_then(|o| o.get(key).and_then(|v| v.as_str().map(str::to_string)));
    let mut messages: Vec<String> = blockers.iter().filter_map(|r| say(r, TOP_MSG)).filter(|m| !m.is_empty()).collect();
    messages.extend(advisories.iter().filter_map(|r| say(r, TOP_MSG)).filter(|m| !m.is_empty()));
    // On exit 2 the host reads stderr as the reason the model sees, so a note must never go there; the JSON stays one object,
    // so the notes ride in the system message (shown to the user, not the model).
    if exit2 && !notes.trim().is_empty() {
        messages.push(notes.trim_end_matches('\n').to_string());
    }
    if !messages.is_empty() {
        set(&mut top, TOP_MSG, Ordered::Str(messages.join(defaults::text("dispatch.message_joiner"))));
    }
    let hso_of = |r: &&HookResult| match parse_object(&r.out).and_then(|o| o.get(HSO_KEY).cloned()) {
        Some(Ordered::Obj(h)) => Some(h),
        _ => None,
    };
    let ctx_of = |h: &Vec<(String, Ordered)>| h.iter().find(|(k, _)| k == HSO_CTX).and_then(|(_, v)| v.as_str().map(str::to_string)).unwrap_or_default();
    let extra: Vec<(String, String)> = advisories
        .iter()
        .filter_map(|r| {
            let h = hso_of(r)?;
            let ev = h.iter().find(|(k, _)| k == HSO_EVENT).and_then(|(_, v)| v.as_str().map(str::to_string)).unwrap_or_default();
            Some((ev, ctx_of(&h)))
        })
        .filter(|(_, c)| !c.is_empty())
        .collect();
    if !extra.is_empty() {
        let join = defaults::text("dispatch.context_joiner");
        let adv = extra.iter().map(|(_, c)| c.as_str()).collect::<Vec<_>>().join(join);
        match top.iter_mut().find(|(k, _)| k == HSO_KEY) {
            Some((_, Ordered::Obj(h))) => {
                let have = ctx_of(h);
                set(h, HSO_CTX, Ordered::Str(if have.is_empty() { adv } else { format!("{have}{join}{adv}") }));
            }
            _ => {
                set(&mut top, HSO_KEY, Ordered::Obj(vec![(HSO_EVENT.to_string(), Ordered::Str(extra[0].0.clone())), (HSO_CTX.to_string(), Ordered::Str(adv))]))
            }
        }
    }
    let mut err = if exit2 { reasons_err } else { blockers.iter().map(|r| r.err.as_str()).collect() };
    if !exit2 {
        err.push_str(notes);
    }
    Combined::Answer(Outcome { out: format!("{}\n", Ordered::Obj(top).to_json()), code: if exit2 { 2 } else { 0 }, err })
}

/// Combine the results of one event's entries, given in table order.
pub fn combine(results: &[HookResult]) -> Combined {
    combine_for(results, false)
}

/// [`combine`], with `keep_advisories` for an event whose hooks each give their own answer to the host and whose block must not
/// hide the others' advisories (Stop and SubagentStop, `dispatch.stop_events`).
pub fn combine_for(results: &[HookResult], keep_advisories: bool) -> Combined {
    let blockers: Vec<&HookResult> = results.iter().filter(|r| blocks(r)).collect();
    if !blockers.is_empty() {
        let notes: String = results
            .iter()
            .filter(|r| r.code == Some(0) && !blocks(r) && !r.out.trim().is_empty() && parse_object(&r.out).is_none())
            .map(|r| if r.out.ends_with('\n') { r.out.clone() } else { format!("{}\n", r.out) })
            .collect();
        let advisories: Vec<&HookResult> =
            results.iter().filter(|r| keep_advisories && r.code == Some(0) && !blocks(r) && parse_object(&r.out).is_some()).collect();
        return blocked(&blockers, &advisories, &notes);
    }
    let active: Vec<&HookResult> = results.iter().filter(|r| r.active()).collect();
    let answer = match active.len() {
        0 => return Combined::Answer(Outcome { out: String::new(), code: 0, err: String::new() }),
        1 => verbatim(active[0]),
        _ => merge(&active, false),
    };
    match answer {
        Combined::Answer(mut o) if o.code == 0 => {
            o.out = tidy(&o.out);
            Combined::Answer(o)
        }
        other => other,
    }
}

/// Merge several answers (rule 3 of the module docs); a conflict names the entries involved. `lenient` keeps the first
/// value of a field that two answers set differently instead of reporting a conflict (see [`sequential`]).
fn merge(active: &[&HookResult], lenient: bool) -> Combined {
    const HSO: &str = "hookSpecificOutput";
    const CTX: &str = "additionalContext";
    const MSG: &str = "systemMessage";
    const DEC: &str = "permissionDecision";
    const REASON: &str = "permissionDecisionReason";
    let ids = || active.iter().map(|r| r.id.clone()).collect::<Vec<_>>();
    let precedence = defaults::list("dispatch.decision_precedence");
    let rank = |d: &str| precedence.iter().position(|p| *p == d).unwrap_or(precedence.len());
    let mut top: Vec<(String, Ordered)> = Vec::new();
    let mut hso: Vec<(String, Ordered)> = Vec::new();
    let (mut contexts, mut messages) = (Vec::new(), Vec::new());
    let mut decision: Option<(usize, Ordered, Option<Ordered>)> = None;
    let mut err = String::new();
    // Insert `key` at its first position; a repeat must carry an equal value.
    fn put(lenient: bool, obj: &mut Vec<(String, Ordered)>, key: &str, v: Ordered) -> bool {
        match obj.iter().find(|(k, _)| k == key) {
            Some((_, old)) => lenient || *old == v,
            None => {
                obj.push((key.to_string(), v));
                true
            }
        }
    }
    for r in active {
        if r.code != Some(0) {
            return Combined::Conflict(ids());
        }
        err.push_str(&r.err);
        if r.out.trim().is_empty() {
            continue;
        }
        let Some(Ordered::Obj(fields)) = parse_object(&r.out) else { return Combined::Conflict(ids()) };
        for (k, v) in fields {
            let ok = match (k.as_str(), v) {
                (HSO, Ordered::Obj(inner)) => {
                    // a placeholder at the first position; the merged object replaces it at the end
                    let mut ok = put(lenient, &mut top, HSO, Ordered::Obj(Vec::new()));
                    let reason = inner.iter().find(|(k, _)| k == REASON).map(|(_, v)| v.clone());
                    for (k2, v2) in inner {
                        ok &= match (k2.as_str(), v2) {
                            (CTX, Ordered::Str(s)) => {
                                contexts.push(s);
                                put(lenient, &mut hso, CTX, Ordered::Str(String::new()))
                            }
                            (DEC, Ordered::Str(d)) => {
                                let r = rank(&d);
                                if decision.as_ref().is_none_or(|(best, _, _)| r < *best) {
                                    decision = Some((r, Ordered::Str(d), reason.clone()));
                                }
                                put(lenient, &mut hso, DEC, Ordered::Str(String::new()))
                            }
                            (REASON, _) => put(lenient, &mut hso, REASON, Ordered::Str(String::new())),
                            (k2, v2) => put(lenient, &mut hso, k2, v2),
                        };
                    }
                    ok
                }
                (MSG, Ordered::Str(s)) => {
                    messages.push(s);
                    put(lenient, &mut top, MSG, Ordered::Str(String::new()))
                }
                (k, v) => put(lenient, &mut top, k, v),
            };
            if !ok {
                return Combined::Conflict(ids());
            }
        }
    }
    let (ctx_join, msg_join) = (defaults::text("dispatch.context_joiner"), defaults::text("dispatch.message_joiner"));
    let (dec, reason) = match decision {
        Some((_, d, r)) => (Some(d), r),
        None => (None, None),
    };
    hso = hso
        .into_iter()
        .filter_map(|(k, v)| match k.as_str() {
            // A hook that injects nothing prints an empty context (the context-budget hooks do on every quiet turn); it adds
            // no value, so it adds no joiner either, or a quiet turn would deliver "\n\n" of nothing.
            CTX => Some((k, Ordered::Str(contexts.iter().filter(|c| !c.is_empty()).cloned().collect::<Vec<_>>().join(ctx_join)))),
            DEC => dec.clone().map(|d| (k, d)),
            REASON => reason.clone().map(|r| (k, r)),
            _ => Some((k, v)),
        })
        .collect();
    let top: Vec<(String, Ordered)> = top
        .into_iter()
        .map(|(k, v)| match k.as_str() {
            HSO => (k, Ordered::Obj(hso.clone())),
            MSG => (k, Ordered::Str(messages.join(msg_join))),
            _ => (k, v),
        })
        .collect();
    Combined::Answer(Outcome { out: format!("{}\n", Ordered::Obj(top).to_json()), code: 0, err })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn r(id: &str, code: i32, out: &str, err: &str) -> HookResult {
        HookResult { id: id.into(), code: Some(code), out: out.into(), err: err.into() }
    }
    fn ans(c: Combined) -> Outcome {
        match c {
            Combined::Answer(o) => o,
            Combined::Conflict(ids) => panic!("conflict {ids:?}"),
        }
    }

    #[test]
    fn one_block_wins_byte_for_byte() {
        let o = ans(combine(&[
            r("a", 0, "{\"hookSpecificOutput\":{\"hookEventName\":\"PreToolUse\",\"additionalContext\":\"x\"}}\n", ""),
            r("b", 2, "{\"decision\":\"block\",\"reason\":\"B\"}\n", "B\n"),
            r("c", 0, "", "w\n"),
        ]));
        assert_eq!(o, Outcome { code: 2, out: "{\"decision\":\"block\",\"reason\":\"B\"}\n".into(), err: "B\n".into() });
    }

    #[test]
    fn several_blocks_keep_every_reason_in_table_order() {
        // an exit 2 with a JSON block (the host reads its reason, not stderr) and a plain exit 2 (the host reads stderr)
        let o = ans(combine(&[
            r("a", 0, "{\"hookSpecificOutput\":{\"hookEventName\":\"Stop\",\"additionalContext\":\"x\"}}\n", ""),
            r("b", 2, "{\"decision\":\"block\",\"reason\":\"B\"}\n", "B\n"),
            r("c", 2, "", "C\n"),
        ]));
        assert_eq!(o, Outcome { code: 2, out: "{\"decision\":\"block\",\"reason\":\"B\\n\\nC\"}\n".into(), err: "B\n\nC\n".into() });
        // two plain exit 2: both stderr texts, the plain stdout stays on stdout (the host does not read it on exit 2)
        let o = ans(combine(&[r("a", 2, "out A", "A\n"), r("b", 0, "", ""), r("c", 2, "", "C")]));
        assert_eq!(o, Outcome { code: 2, out: "out A\n".into(), err: "A\n\nC\n".into() });
        // a JSON block first in the table and a plain exit 2 later: exit 2, the JSON keeps its message, every reason in order
        let o = ans(combine(&[r("a", 0, "{\"decision\":\"block\",\"reason\":\"A\",\"systemMessage\":\"mA\"}", "dbg\n"), r("b", 2, "plain B\n", "B\n")]));
        assert_eq!(o, Outcome { code: 2, out: "{\"decision\":\"block\",\"reason\":\"A\\n\\nB\",\"systemMessage\":\"mA\"}\n".into(), err: "A\n\nB\n".into() });
        // two JSON blocks without exit 2: one JSON block, the reasons and messages joined
        let o = ans(combine(&[
            r("a", 0, "{\"decision\":\"block\",\"reason\":\"A\",\"systemMessage\":\"mA\"}\n", ""),
            r("b", 0, "{\"systemMessage\":\"mB\",\"decision\":\"block\",\"reason\":\"B\"}\n", "e\n"),
        ]));
        assert_eq!(o, Outcome { code: 0, out: "{\"decision\":\"block\",\"reason\":\"A\\n\\nB\",\"systemMessage\":\"mA\\nmB\"}\n".into(), err: "e\n".into() });
    }

    #[test]
    fn a_plain_note_next_to_a_block_is_kept_off_the_model_channel() {
        let block = "{\"decision\":\"block\",\"reason\":\"B\"}\n";
        let note = "[task-guard] deferring Stop block.\n";
        // one JSON block: the note goes to stderr (stdout must stay one object)
        let o = ans(combine(&[r("a", 0, note, ""), r("b", 0, block, "e\n")]));
        assert_eq!(o, Outcome { code: 0, out: block.into(), err: format!("e\n{note}") });
        // one plain exit 2: the note follows on stdout, which the host does not read on exit 2; stderr stays the reason
        let o = ans(combine(&[r("a", 0, note, ""), r("b", 2, "", "B\n")]));
        assert_eq!(o, Outcome { code: 2, out: note.into(), err: "B\n".into() });
        // no note: a lone block is byte for byte
        assert_eq!(ans(combine(&[r("a", 0, "", "x\n"), r("b", 2, "o", "B\n")])), Outcome { code: 2, out: "o".into(), err: "B\n".into() });
    }

    #[test]
    fn a_stop_advisory_rides_along_with_a_block_and_a_note_never_reaches_the_reason() {
        let block = "{\"decision\":\"block\",\"reason\":\"B\"}\n";
        let adv = "{\"systemMessage\":\"adv\"}\n";
        // exit 0 JSON block: the advisory's message is kept next to the block
        let o = ans(combine_for(&[r("a", 0, adv, ""), r("b", 0, block, "")], true));
        assert_eq!(o, Outcome { code: 0, out: "{\"decision\":\"block\",\"reason\":\"B\",\"systemMessage\":\"adv\"}\n".into(), err: String::new() });
        // exit 2 JSON block (the host reads stderr as the reason): a plain note must not land on stderr, it joins the message
        let note = "[x] note\n";
        let o = ans(combine(&[r("a", 0, note, ""), r("b", 2, block, "B\n")]));
        assert_eq!(o.err, "B\n", "stderr is the reason and nothing else");
        assert!(o.out.contains("\"systemMessage\":\"[x] note\""), "{}", o.out);
        // an advisory context joins the block's own context
        let ctx = "{\"hookSpecificOutput\":{\"hookEventName\":\"Stop\",\"additionalContext\":\"c1\"}}\n";
        let o = ans(combine_for(&[r("a", 0, ctx, ""), r("b", 0, block, "")], true));
        assert!(o.out.contains("\"additionalContext\":\"c1\""), "{}", o.out);
    }

    #[test]
    fn several_denies_keep_every_reason_in_the_first_deny() {
        let deny = |why: &str| {
            format!("{{\"hookSpecificOutput\":{{\"hookEventName\":\"PreToolUse\",\"permissionDecision\":\"deny\",\"permissionDecisionReason\":\"{why}\"}}}}\n")
        };
        let o = ans(combine(&[r("a", 0, &deny("A"), ""), r("b", 0, "{\"systemMessage\":\"m\"}", ""), r("c", 0, &deny("C"), "")]));
        assert_eq!(o.out, deny("A\\n\\nC"));
        // a deny next to an exit 2: exit 2 decides, its stderr and the deny's reason both reach the model
        let o = ans(combine(&[r("a", 0, &deny("A"), ""), r("b", 2, "", "B\n")]));
        assert_eq!(o, Outcome { code: 2, out: deny("A\\n\\nB"), err: "A\n\nB\n".into() });
    }

    #[test]
    fn a_json_block_without_exit_two_still_wins() {
        let deny = "{\"hookSpecificOutput\":{\"hookEventName\":\"PreToolUse\",\"permissionDecision\":\"deny\",\"permissionDecisionReason\":\"no\"}}\n";
        let o = ans(combine(&[r("a", 0, "{\"systemMessage\":\"m\"}\n", ""), r("b", 0, deny, "")]));
        assert_eq!(o.out, deny);
    }

    #[test]
    fn one_answer_passes_through_and_none_is_silence() {
        assert_eq!(
            ans(combine(&[HookResult::quiet("a"), r("b", 0, "plain text", "e"), HookResult::quiet("c")])),
            Outcome { code: 0, out: "plain text".into(), err: "e".into() }
        );
        assert_eq!(ans(combine(&[HookResult::quiet("a")])), Outcome { code: 0, out: String::new(), err: String::new() });
        let timed_out = HookResult { id: "t".into(), code: None, out: "partial".into(), err: String::new() };
        assert_eq!(ans(combine(&[timed_out])).out, "", "a hook that did not finish has no decision");
    }

    #[test]
    fn several_contexts_join_in_order_and_keep_key_order() {
        let a = "{\"hookSpecificOutput\":{\"hookEventName\":\"PreToolUse\",\"additionalContext\":\"one\"}}\n";
        let b = "{\"systemMessage\":\"s\",\"hookSpecificOutput\":{\"hookEventName\":\"PreToolUse\",\"additionalContext\":\"two \\\"q\\\"\"}}\n";
        let o = ans(combine(&[r("a", 0, a, "x"), r("b", 0, b, "y")]));
        assert_eq!(
            o.out,
            "{\"hookSpecificOutput\":{\"hookEventName\":\"PreToolUse\",\"additionalContext\":\"one\\n\\ntwo \\\"q\\\"\"},\"systemMessage\":\"s\"}\n"
        );
        assert_eq!(o.err, "xy");
    }

    #[test]
    fn a_hook_with_nothing_to_say_adds_no_joiner() {
        let q = "{\"hookSpecificOutput\":{\"hookEventName\":\"UserPromptSubmit\",\"additionalContext\":\"\"}}\n";
        let a = "{\"hookSpecificOutput\":{\"hookEventName\":\"UserPromptSubmit\",\"additionalContext\":\"one\"}}\n";
        assert_eq!(ans(combine(&[r("a", 0, q, ""), r("b", 0, q, "")])).out, "", "all quiet is no output, not an empty context");
        assert_eq!(ans(combine(&[r("a", 0, q, "")])).out, "", "one quiet hook too");
        let m = "{\"systemMessage\":\"m\",\"hookSpecificOutput\":{\"hookEventName\":\"UserPromptSubmit\",\"additionalContext\":\"\"}}\n";
        assert_eq!(ans(combine(&[r("a", 0, m, "")])).out, "{\"systemMessage\":\"m\"}\n", "the other fields stay");
        assert_eq!(ans(combine(&[r("a", 0, q, ""), r("b", 0, a, ""), r("c", 0, q, "")])).out, a, "a quiet hook around a loud one adds nothing");
    }

    #[test]
    fn the_strongest_permission_decision_wins_with_its_reason() {
        let a = "{\"hookSpecificOutput\":{\"hookEventName\":\"PreToolUse\",\"permissionDecision\":\"allow\",\"permissionDecisionReason\":\"ok\"}}";
        let b = "{\"hookSpecificOutput\":{\"hookEventName\":\"PreToolUse\",\"permissionDecision\":\"ask\",\"permissionDecisionReason\":\"sure?\"}}";
        let o = ans(combine(&[r("a", 0, a, ""), r("b", 0, b, "")]));
        assert_eq!(
            o.out,
            "{\"hookSpecificOutput\":{\"hookEventName\":\"PreToolUse\",\"permissionDecision\":\"ask\",\"permissionDecisionReason\":\"sure?\"}}\n"
        );
    }

    #[test]
    fn what_one_output_cannot_say_is_a_conflict() {
        let ctx = "{\"hookSpecificOutput\":{\"hookEventName\":\"PreToolUse\",\"additionalContext\":\"x\"}}";
        assert_eq!(combine(&[r("a", 0, ctx, ""), r("b", 0, "plain", "")]), Combined::Conflict(vec!["a".into(), "b".into()]));
        assert!(matches!(combine(&[r("a", 0, ctx, ""), r("b", 1, "", "boom")]), Combined::Conflict(_)));
        assert!(matches!(combine(&[r("a", 0, "{\"continue\":false}", ""), r("b", 0, "{\"continue\":true}", "")]), Combined::Conflict(_)));
        let other = "{\"hookSpecificOutput\":{\"hookEventName\":\"PostToolUse\",\"additionalContext\":\"y\"}}";
        assert!(matches!(combine(&[r("a", 0, ctx, ""), r("b", 0, other, "")]), Combined::Conflict(_)));
    }

    #[test]
    fn ordered_json_round_trips_like_json_stringify() {
        let t = "{\"b\":1,\"a\":[true,null,\"\\u0001\\n\"],\"c\":{\"z\":-2,\"y\":\"\u{2028}\"}}";
        assert_eq!(parse_object(t).unwrap().to_json(), t);
        assert!(parse_object("[1]").is_none());
        assert!(parse_object("{\"a\":1} trailing").is_none());
    }

    #[test]
    fn a_conflict_is_delivered_one_hook_after_another() {
        let r = |id: &str, code, out: &str, err: &str| HookResult { id: id.into(), code: Some(code), out: out.into(), err: err.into() };
        let rs = [
            r("a", 0, "{\"x\":1}\n", ""),
            r("b", 0, "plain", "w\n"),
            r("c", 1, "ignored", "e\n"),
            HookResult { id: "d".into(), code: None, out: String::new(), err: String::new() },
        ];
        assert!(matches!(combine(&rs), Combined::Conflict(_)));
        // the JSON keeps stdout (the host reads stdout as one object or as text), the plain text moves to stderr
        assert_eq!(sequential(&rs, "PreToolUse"), Outcome { out: "{\"x\":1}\n".into(), code: 0, err: "w\ne\nplain\n".into() });
    }

    #[test]
    fn a_delivery_without_json_prints_the_plain_outputs_one_after_another() {
        let rs = [r("a", 0, "one", ""), r("b", 0, "two\n", "w\n"), r("c", 1, "ignored", "e\n")];
        assert_eq!(sequential(&rs, "PreToolUse"), Outcome { out: "one\ntwo\n".into(), code: 0, err: "w\ne\n".into() });
    }

    #[test]
    fn a_delivery_of_several_json_outputs_is_one_object_with_the_strongest_decision() {
        let a = "{\"systemMessage\":\"one\",\"x\":1,\"hookSpecificOutput\":{\"hookEventName\":\"PreToolUse\",\"additionalContext\":\"A\"}}\n";
        let b = "{\"x\":2,\"hookSpecificOutput\":{\"hookEventName\":\"PreToolUse\",\"permissionDecision\":\"ask\",\"permissionDecisionReason\":\"r\",\"additionalContext\":\"B\"}}\n";
        let o = sequential(&[r("a", 0, a, ""), r("b", 0, b, ""), r("c", 1, "", "boom\n")], "PreToolUse");
        // the two hooks disagree about `x`: the first wins (a strict merge would be a conflict); nothing else is lost
        assert_eq!(
            o.out,
            "{\"systemMessage\":\"one\",\"x\":1,\"hookSpecificOutput\":{\"hookEventName\":\"PreToolUse\",\"additionalContext\":\"A\\n\\nB\",\"permissionDecision\":\"ask\",\"permissionDecisionReason\":\"r\"}}\n"
        );
        assert_eq!((o.code, o.err.as_str()), (0, "boom\n"));
        assert!(parse_object(&o.out).is_some(), "one valid JSON object");
    }

    #[test]
    fn plain_text_next_to_json_on_a_context_event_stays_context() {
        let rs =
            [r("a", 0, "{\"hookSpecificOutput\":{\"hookEventName\":\"UserPromptSubmit\",\"additionalContext\":\"A\"}}\n", ""), r("b", 0, "plain B\n", "w\n")];
        let o = sequential(&rs, "UserPromptSubmit");
        assert_eq!(o.out, "{\"hookSpecificOutput\":{\"hookEventName\":\"UserPromptSubmit\",\"additionalContext\":\"A\\n\\nplain B\"}}\n");
        assert_eq!(o.err, "w\n", "the plain text is not moved to stderr");
        // an event whose plain stdout is not context keeps the old route
        let o = sequential(&rs, "PostToolUse");
        assert!(o.err.ends_with("plain B\n") && o.out.contains("\"A\""));
    }
}
