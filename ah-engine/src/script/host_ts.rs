//! Transcript primitives of D88 batch 7 (generic, no rules): readings of a transcript that a script cannot do for itself inside
//! its time limit, bounded by a window and exact where JavaScript would be (a line only JavaScript reads, or a relative path,
//! answers `{"unsure":true}` and the script defers). They return facts; the script decides. Installed by [`install`] from
//! [`super::host::install`]; the `ah.transcript.*` shape is built from them by `engine/logic/lib/00-ah.js`.
//!
//! | raw function | what it does |
//! |---|---|
//! | `reNumbers(src, flags, text, strip)` | the distinct finite numbers the matches of a regex spell, sorted ascending (`strip`: characters removed from a match before it is read as a number, such as thousands separators): see [`re_numbers`] |
//! | `transcriptEvidence(path, window)` | the text evidence of the last `window` bytes of a transcript, record by record, in order: see [`evidence`] |
//! | `transcriptTeammates(path, tail)` | the named in-process teammates the last `tail` bytes show finished but never stopped, with when each went idle: see [`teammates`] |
//! | `transcriptCodexAgents(path, tail)` | the Codex `multi_agent_v1` agents a rollout tail shows finished but never closed: see [`codex_agents`] |
// Discard triage (E3): every `.ok()` / `unwrap_or_default()` in this file is a deliberate keep, for these reasons:
// - text that does not parse or decode is the absent value (Node Number()/JSON.parse catch parity)
// A failure that must be seen goes through `crate::discard` instead.

use crate::checks::guardkit::text::js_trim;
use crate::checks::replykit::io::{read_window, truthy};
use crate::checks::replykit::json::stringify_value;
use crate::checks::replykit::transcript::{parse_line, prop, tail_lines};
use crate::defaults;
use rquickjs::{Ctx, Function, Object};
use serde_json::{Value, json};

fn unsure() -> String {
    r#"{"unsure":true}"#.into()
}

/// `asText(v)`: strings as they are, nothing for a missing value, the JSON text of anything else.
fn as_text(v: Option<&Value>) -> String {
    match v {
        None | Some(Value::Null) => String::new(),
        Some(Value::String(s)) => s.clone(),
        Some(other) => stringify_value(other),
    }
}

/// `textBlocks(content)`: a string as it is; the text blocks of an array joined with one space; else nothing.
fn text_blocks(content: Option<&Value>) -> String {
    match content {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Array(a)) => a
            .iter()
            .filter(|b| b.is_object() && prop(b, "type").and_then(Value::as_str) == Some(defaults::text("transcript.ev_type_text")))
            .filter_map(|b| prop(b, "text").and_then(Value::as_str))
            .collect::<Vec<_>>()
            .join(" "),
        _ => String::new(),
    }
}

/// `evidence(path, window)`: JSON text. `null` when the transcript cannot be read; `{"unsure":true}` for a relative path, a line
/// JavaScript might read differently, or evidence past `transcript.evidence_max_chars`; else
/// `{"truncated": bool, "items": [[kind, text, id?], ...]}` for the records of the last `window` bytes (capped by
/// `transcript.evidence_max_bytes`; a window that cuts the file drops its first, partial line), in order. `kind` is
/// - `"p"`: a user record that carries no tool result: the text of its content (a string as it is, anything else as JSON);
/// - `"r"`: one tool result of a user record: the text of its content, then (an extra item) the text of the record's
///   `toolUseResult` when it has one;
/// - `"a"`: a hook attachment record: the text of its `attachment`;
/// - `"i"`: one tool call of an assistant record: the text of its `input`;
/// - `"t"`: the assistant text of a record (its text blocks joined with one space), only when not blank, with the message `id`
///   (a string, else `null`) as the third element. A record's `"i"` items come before its `"t"` item.
pub fn evidence(path: &str, window: f64) -> String {
    if !path.starts_with('/') {
        return unsure();
    }
    let cap = defaults::num("transcript.evidence_max_bytes");
    let w = if window.is_finite() && window > 0.0 { (window as u64).min(cap) } else { cap };
    let Some(tail) = read_window(path, w) else { return "null".into() };
    let mut items: Vec<Value> = Vec::new();
    let chars = std::cell::Cell::new(0usize);
    let push = |items: &mut Vec<Value>, v: Value, text: &str| {
        chars.set(chars.get() + text.len());
        items.push(v);
    };
    for line in tail_lines(&tail) {
        let e = match parse_line(line) {
            Err(_) => return unsure(),
            Ok(None) => continue,
            Ok(Some(e)) => e,
        };
        if !e.is_object() && !e.is_array() {
            continue;
        }
        let message = prop(&e, "message").filter(|m| truthy(m));
        let role_v = prop(&e, "type").filter(|t| truthy(t)).or_else(|| message.and_then(|m| prop(m, "role")));
        let role = role_v.and_then(Value::as_str).unwrap_or("");
        let content = if message.is_some() { message.and_then(|m| prop(m, "content")) } else { prop(&e, "content") };
        let blocks: &[Value] = content.and_then(Value::as_array).map_or(&[], Vec::as_slice);
        if role == defaults::text("transcript.ev_role_user") {
            let results: Vec<&Value> = blocks
                .iter()
                .filter(|b| truthy(b) && prop(b, "type").and_then(Value::as_str) == Some(defaults::text("transcript.ev_type_tool_result")))
                .collect();
            if results.is_empty() {
                let t = as_text(content);
                push(&mut items, json!(["p", t]), &t);
            } else {
                for r in &results {
                    let t = as_text(prop(r, "content"));
                    push(&mut items, json!(["r", t]), &t);
                }
                if let Some(u) = prop(&e, "toolUseResult") {
                    let t = as_text(Some(u));
                    push(&mut items, json!(["r", t]), &t);
                }
            }
        } else if role == defaults::text("transcript.ev_role_attachment") {
            let t = as_text(prop(&e, "attachment"));
            push(&mut items, json!(["a", t]), &t);
        } else if role == defaults::text("transcript.ev_role_assistant") {
            for b in blocks {
                if truthy(b) && prop(b, "type").and_then(Value::as_str) == Some(defaults::text("transcript.ev_type_tool_use")) {
                    let t = as_text(prop(b, "input"));
                    push(&mut items, json!(["i", t]), &t);
                }
            }
            let text = text_blocks(content);
            if !js_trim(&text).is_empty() {
                let id = message.and_then(|m| prop(m, "id")).and_then(Value::as_str).map(str::to_string);
                push(&mut items, json!(["t", text, id]), &text);
            }
        }
        if chars.get() as f64 > defaults::num("transcript.evidence_max_chars") as f64 {
            return unsure();
        }
    }
    json!({"truncated": tail.truncated, "items": items}).to_string()
}

/// `teammates(path, tail)`: JSON text. The named in-process teammates the last `tail` bytes of a Claude transcript show finished
/// but never stopped, in the order the scan lists them: `{"teammates":[{"name","idleSinceMs"}]}`; `null` when the file is
/// missing, unreadable or empty; `{"unsure":true}` for a relative path or anything JavaScript might read differently.
pub fn teammates(path: &str, tail: f64) -> String {
    use crate::checks::guardkit::tail::tail_lines;
    if !path.starts_with('/') {
        return unsure();
    }
    let cap = defaults::num("script.tail_max_bytes");
    let n = if tail.is_finite() && tail > 0.0 { (tail as u64).min(cap) } else { cap };
    let Some((lines, _)) = tail_lines(path, n) else { return "null".into() };
    match crate::checks::idle_agent_sweep::scan::finished_teammates(lines) {
        Ok(v) => json!({"teammates": v.iter().map(|f| json!({"name": f.name, "idleSinceMs": f.idle_since_ms})).collect::<Vec<_>>()}).to_string(),
        Err(_) => unsure(),
    }
}

/// `codex_agents(path, tail)`: JSON text. The agents a Codex rollout tail shows finished but never closed, in the order the
/// rollout first spawned them: `{"agents":[{"id","label","idleSinceMs"}]}`; `null` and `{"unsure":true}` as [`teammates`].
pub fn codex_agents(path: &str, tail: f64) -> String {
    use crate::checks::guardkit::tail::tail_lines;
    if !path.starts_with('/') {
        return unsure();
    }
    let cap = defaults::num("script.tail_max_bytes");
    let n = if tail.is_finite() && tail > 0.0 { (tail as u64).min(cap) } else { cap };
    let Some((lines, _)) = tail_lines(path, n) else { return "null".into() };
    match crate::checks::idle_agent_sweep::codex::finished(lines) {
        Ok(v) => json!({"agents": v.iter().map(|a| json!({"id": a.id, "label": a.label, "idleSinceMs": a.idle_since_ms})).collect::<Vec<_>>()}).to_string(),
        Err(_) => unsure(),
    }
}

/// `re_numbers(src, flags, text, strip)`: JSON text, an array of the distinct finite numbers that the matches of `src` (with `flags`,
/// as `reTest`) in `text` spell once the characters of `strip` are removed from each match, sorted ascending. A match that does not
/// read as a finite number is left out. A script that must test many claims against the numbers of megabytes of text gets them
/// once, as a sorted list it can bisect, instead of walking the text itself.
pub fn re_numbers(src: &str, flags: &str, text: &str, strip: &str) -> rquickjs::Result<String> {
    let mut nums = super::host::with_re(src, flags, |re| {
        re.find_iter(text)
            .filter_map(|m| {
                let s: String = m.as_str().chars().filter(|c| !strip.contains(*c)).collect();
                s.parse::<f64>().ok().filter(|n| n.is_finite())
            })
            .collect::<Vec<f64>>()
    })?;
    nums.sort_by(f64::total_cmp);
    nums.dedup();
    Ok(serde_json::to_string(&nums).unwrap_or_else(|_| "[]".into()))
}

/// Add the transcript functions to `ahHost`.
pub fn install<'a>(c: &Ctx<'a>, h: &Object<'a>) -> rquickjs::Result<()> {
    h.set("reNumbers", Function::new(c.clone(), |src: String, flags: String, text: String, strip: String| re_numbers(&src, &flags, &text, &strip))?)?;
    h.set("transcriptEvidence", Function::new(c.clone(), |p: String, w: f64| evidence(&p, w))?)?;
    h.set("transcriptTeammates", Function::new(c.clone(), |p: String, t: f64| teammates(&p, t))?)?;
    h.set("transcriptCodexAgents", Function::new(c.clone(), |p: String, t: f64| codex_agents(&p, t))?)?;
    Ok(())
}
