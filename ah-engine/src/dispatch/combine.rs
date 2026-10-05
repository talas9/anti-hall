//! Combining the results of one event's hook entries into the one answer a single hook process can give (D58).
//!
//! The host runs separate hooks in parallel and reads each one's output on its own (Claude Code and Codex hook docs,
//! quoted in `defaults/dispatch.toml`). One process has one exit code and one stdout, so the dispatcher answers as
//! follows, in `hooks.json` order:
//!
//! 1. **A block wins.** The first entry that exited 2 is the answer, byte for byte (exit 2 blocks and no JSON can
//!    override it). Failing that, the first entry whose JSON blocks (`dispatch.blocking_decisions`) is the answer.
//! 2. **One answer passes through.** When exactly one entry printed anything or exited non-zero, its output, stderr
//!    and exit code are the answer, byte for byte.
//! 3. **Several answers merge.** Each stdout must be a JSON object. Their fields are merged in order of first
//!    appearance: `additionalContext` values are joined (`dispatch.context_joiner`), `systemMessage` values are
//!    joined (`dispatch.message_joiner`), the strongest `permissionDecision` wins (`dispatch.decision_precedence`)
//!    with its own reason, and any other field must be equal everywhere it appears. stderr is concatenated.
//! 4. **Anything else is a conflict** (plain-text stdout next to another answer, a non-zero exit next to another
//!    answer, or two different values for one field): the dispatcher cannot express it, so it defers the whole call
//!    rather than guess.
//!
//! Key order and string escaping follow `JSON.stringify` (keys in order of first appearance), so the merged line
//! is byte-identical to what the reference combiner in `parity/dispatch-lib.js` builds from the separate Node hooks.
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
    Outcome { out, code: 0, err }
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

/// Combine the results of one event's entries, given in table order.
pub fn combine(results: &[HookResult]) -> Combined {
    if let Some(r) = results.iter().find(|r| r.code == Some(2)) {
        return verbatim(r);
    }
    if let Some(r) = results.iter().find(|r| r.code.is_some() && json_blocks(&r.out)) {
        return verbatim(r);
    }
    let active: Vec<&HookResult> = results.iter().filter(|r| r.active()).collect();
    match active.len() {
        0 => return Combined::Answer(Outcome { out: String::new(), code: 0, err: String::new() }),
        1 => return verbatim(active[0]),
        _ => {}
    }
    merge(&active, false)
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
            CTX => Some((k, Ordered::Str(contexts.join(ctx_join)))),
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
    fn the_first_exit_two_wins_byte_for_byte() {
        let o = ans(combine(&[
            r("a", 0, "{\"hookSpecificOutput\":{\"hookEventName\":\"PreToolUse\",\"additionalContext\":\"x\"}}\n", ""),
            r("b", 2, "{\"decision\":\"block\",\"reason\":\"B\"}\n", "B\n"),
            r("c", 2, "", "C\n"),
        ]));
        assert_eq!(o, Outcome { code: 2, out: "{\"decision\":\"block\",\"reason\":\"B\"}\n".into(), err: "B\n".into() });
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
