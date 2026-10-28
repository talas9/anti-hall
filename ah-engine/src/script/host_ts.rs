//! Transcript primitives of D88 batch 7 (generic, no rules): readings of a transcript that a script cannot do for itself inside
//! its time limit, bounded by a window and exact where JavaScript would be (a line only JavaScript reads, or a relative path,
//! answers `{"unsure":true}` and the script defers). They return facts; the script decides. Installed by [`install`] from
//! [`super::host::install`]; the `ah.transcript.*` shape is built from them by `engine/logic/lib/00-ah.js`.
//!
//! | raw function | what it does |
//! |---|---|
//! | `reNumbers(src, flags, text, strip)` | the distinct finite numbers the matches of a regex spell, sorted ascending (`strip`: characters removed from a match before it is read as a number, such as thousands separators): see [`re_numbers`] |
//! | `transcriptEvidence(path, window)` | the text evidence of the last `window` bytes of a transcript, record by record, in order: see [`evidence`] |
//! | `transcriptEvidenceWalk(path, window, payload)` | the claim ledger's walk of that evidence done in the engine (merge of one message's text, payload skip, join): small facts back, the two big texts kept: see [`super::evidence_walk::evidence_walk`] |
//! | `transcriptWalkHas(which, needle)` | is `needle` in the evidence (`"evidence"`) or the evidence with the last reply (`"withLast"`) of this thread's last walk: see [`super::evidence_walk::walk_has`] |
//! | `transcriptWalkNumbers(which, src, flags, strip)` | `reNumbers` over that text: see [`super::evidence_walk::walk_numbers`] |
//! | `toolUseScan(path, window, needles, keys)` | the tasklist guard's tool uses of the lines of the last `window` bytes that hold a needle, cut down to `[name, file_path, command]` per entry, in order: see [`super::tool_use_scan::tool_use_scan`] |
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

pub(super) fn unsure() -> String {
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
    let w = window_bytes(window);
    // a transcript followed by earlier calls answers by reading only what was appended since (and the same bytes as below)
    if let Some(answer) = super::evidence_cache::cached(path, w) {
        return answer;
    }
    evidence_uncached(path, w)
}

/// One evidence item: `kind` is `p`, `r`, `a`, `i` or `t` (see [`evidence`]); `id` is the message id of a `t` item.
#[derive(Clone)]
pub(super) struct Item {
    pub kind: char,
    pub text: String,
    pub id: Option<String>,
}

impl Item {
    /// The item as the compact JSON array [`evidence`] answers with: `["p","text"]`, `["t","text","id"|null]`.
    pub(super) fn json(&self) -> String {
        let k = self.kind.to_string();
        if self.kind == 't' { json!([k, self.text, self.id]).to_string() } else { json!([k, self.text]).to_string() }
    }

    /// Bytes the item holds in memory (text plus the fixed part), for the caches' weight.
    pub(super) fn weight(&self) -> usize {
        self.text.len() + self.id.as_ref().map_or(0, String::len) + std::mem::size_of::<Item>()
    }
}

/// What one transcript line adds to the evidence: its items and the characters of text they hold.
pub(super) struct LineEv {
    pub items: Vec<Item>,
    /// The bytes of text the items hold (the sum the `transcript.evidence_max_chars` cap is read against).
    pub chars: usize,
}

/// The items of a line as compact JSON, comma separated with no brackets (the form [`answer`] joins).
pub(super) fn items_json(items: &[Item]) -> String {
    items.iter().map(Item::json).collect::<Vec<_>>().join(",")
}

/// The window `evidence` reads for a requested size: the request (or the cap when it is not a positive number), at most the cap.
pub(super) fn window_bytes(window: f64) -> u64 {
    let cap = defaults::num("transcript.evidence_max_bytes");
    if window.is_finite() && window > 0.0 { (window as u64).min(cap) } else { cap }
}

/// The evidence of one line (no trailing `\r`): `Ok(None)` when it adds nothing, `Err(())` when only JavaScript can read it
/// exactly (the whole call is then unsure).
pub(super) fn line_items(line: &str) -> Result<Option<LineEv>, ()> {
    let e = match parse_line(line) {
        Err(_) => return Err(()),
        Ok(None) => return Ok(None),
        Ok(Some(e)) => e,
    };
    if !e.is_object() && !e.is_array() {
        return Ok(None);
    }
    let mut items: Vec<Item> = Vec::new();
    let mut chars = 0usize;
    let mut push = |kind: char, text: String, id: Option<String>| {
        chars += text.len();
        items.push(Item { kind, text, id });
    };
    let message = prop(&e, "message").filter(|m| truthy(m));
    let role_v = prop(&e, "type").filter(|t| truthy(t)).or_else(|| message.and_then(|m| prop(m, "role")));
    let role = role_v.and_then(Value::as_str).unwrap_or("");
    let content = if message.is_some() { message.and_then(|m| prop(m, "content")) } else { prop(&e, "content") };
    let blocks: &[Value] = content.and_then(Value::as_array).map_or(&[], Vec::as_slice);
    if role == defaults::text("transcript.ev_role_user") {
        let results: Vec<&Value> =
            blocks.iter().filter(|b| truthy(b) && prop(b, "type").and_then(Value::as_str) == Some(defaults::text("transcript.ev_type_tool_result"))).collect();
        if results.is_empty() {
            push('p', as_text(content), None);
        } else {
            for r in &results {
                push('r', as_text(prop(r, "content")), None);
            }
            if let Some(u) = prop(&e, "toolUseResult") {
                push('r', as_text(Some(u)), None);
            }
        }
    } else if role == defaults::text("transcript.ev_role_attachment") {
        push('a', as_text(prop(&e, "attachment")), None);
    } else if role == defaults::text("transcript.ev_role_assistant") {
        for b in blocks {
            if truthy(b) && prop(b, "type").and_then(Value::as_str) == Some(defaults::text("transcript.ev_type_tool_use")) {
                push('i', as_text(prop(b, "input")), None);
            }
        }
        let text = text_blocks(content);
        if !js_trim(&text).is_empty() {
            let id = message.and_then(|m| prop(m, "id")).and_then(Value::as_str).map(str::to_string);
            push('t', text, id);
        }
    }
    Ok(Some(LineEv { items, chars }))
}

/// `evidence` read straight from the file: the last `w` bytes, every line, no memory of earlier calls.
pub(super) fn evidence_uncached(path: &str, w: u64) -> String {
    let Some(tail) = read_window(path, w) else { return "null".into() };
    let mut items: Vec<String> = Vec::new();
    let mut chars = 0usize;
    for line in tail_lines(&tail) {
        match line_items(line) {
            Err(()) => return unsure(),
            Ok(None) => continue,
            Ok(Some(l)) => {
                chars += l.chars;
                if !l.items.is_empty() {
                    items.push(items_json(&l.items));
                }
            }
        }
        if chars as f64 > defaults::num("transcript.evidence_max_chars") as f64 {
            return unsure();
        }
    }
    answer(&items, tail.truncated)
}

/// The answer text: `{"items":[...],"truncated":bool}` (the keys in the order a JSON object map prints them).
pub(super) fn answer<S: AsRef<str>>(items: &[S], truncated: bool) -> String {
    let mut out = String::with_capacity(items.iter().map(|i| i.as_ref().len() + 1).sum::<usize>());
    out.push_str("{\"items\":[");
    for (i, it) in items.iter().enumerate() {
        if i > 0 {
            out.push(',');
        }
        out.push_str(it.as_ref());
    }
    out.push_str("],\"truncated\":");
    out.push_str(if truncated { "true" } else { "false" });
    out.push('}');
    out
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
    super::evidence_walk::install(c, h)?;
    super::tool_use_scan::install(c, h)?;
    h.set("transcriptTeammates", Function::new(c.clone(), |p: String, t: f64| teammates(&p, t))?)?;
    h.set("transcriptCodexAgents", Function::new(c.clone(), |p: String, t: f64| codex_agents(&p, t))?)?;
    Ok(())
}

/// The reader as it was before the per-line split and the kept lines, verbatim, so the tests can show that today's answer is
/// byte-for-byte the one it gave.
#[cfg(test)]
pub(in crate::script) mod reference {
    use super::*;

    pub(in crate::script) fn evidence_v0(path: &str, window: f64) -> String {
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
}
