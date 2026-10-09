//! The transcript reading the `turnText` host primitive (and the scripted `compact-declaration-guard` through it) stands on: the tail of a
//! transcript the way `hooks/lib/transcript-tail.js` reads it (the last 1.5 MB, first partial line dropped) and the current turn's
//! assistant text rebuilt with the turn rules of `hooks/lib/compact-advice.js` (`classify`, `readTurn`). Facts only: the check itself,
//! with its work detection and its answer, is the plugin script `engine/logic/compact-declaration-guard.js`.
//!
//! A transcript line the engine's JSON parser rejects and Node's might accept (a lone surrogate escape, nesting beyond the configured
//! depth, an exponent beyond the number range) makes the primitive answer "not sure", and the script then defers.
// Discard triage (E3): every `.ok()` / `unwrap_or_default()` in this file is a deliberate keep, for these reasons:
// - an unreadable optional file is the same as an absent one (fail-open, as Node's try/catch)
// A failure that must be seen goes through `crate::discard` instead.

use crate::checks::guardkit::jsre;
use crate::checks::guardkit::text::{is_js_space, js_trim};
use crate::defaults;
use regex::Regex;
use serde_json::Value;
use std::io::{Read, Seek, SeekFrom};

#[cfg(test)]
mod tests;

/// The compiled patterns, built once from the defaults.
struct Pats {
    not_typed: Regex,
    notify: Regex,
    compact_cmd: Regex,
}

fn pats() -> &'static Pats {
    static P: crate::defaults::Cache<Pats> = crate::defaults::Cache::new();
    P.get_or_init(|| Pats {
        not_typed: jsre::compile(defaults::text("compact_decl.not_typed"), false),
        notify: jsre::compile(defaults::text("compact_decl.notify"), false),
        compact_cmd: jsre::compile(defaults::text("compact_decl.compact_command"), false),
    })
}

/// The last `max` bytes of the file as lines, the possibly partial first line dropped when the file is larger. `None`
/// when the file is missing, empty or unreadable.
///
/// Mirrors `lib/transcript-tail.js` `readTail`.
pub(crate) fn read_tail(path: &str, max: u64) -> Option<Vec<String>> {
    let mut f = std::fs::File::open(path).ok()?;
    let size = f.metadata().ok()?.len();
    if size == 0 {
        return None;
    }
    let n = size.min(max);
    f.seek(SeekFrom::Start(size - n)).ok()?;
    let mut buf = vec![0u8; n as usize];
    let mut got = 0usize;
    while got < buf.len() {
        match f.read(&mut buf[got..]) {
            Ok(0) => break,
            Ok(k) => got += k,
            Err(_) => return None,
        }
    }
    let text = String::from_utf8_lossy(&buf[..got]);
    let mut lines: Vec<String> = text.split('\n').map(str::to_string).collect();
    if size > n {
        lines.remove(0);
    }
    Some(lines)
}

/// ASCII-case-insensitive substring test on bytes.
pub(crate) fn contains_ci(hay: &[u8], needle: &[u8]) -> bool {
    !needle.is_empty() && hay.windows(needle.len()).any(|w| w.eq_ignore_ascii_case(needle))
}

/// What one transcript line does to the current turn.
enum Step {
    /// A real user message: starts a new turn.
    NewTurn,
    /// Assistant text, in order.
    Text(Vec<String>),
    /// Anything else (tool calls and results, notifications, compact boundaries, entries that are not messages).
    Other,
}

/// `textOfBlocks(content, types)`: a string content as is; an array's text blocks of the given types, joined with a newline.
fn text_of_blocks(content: Option<&Value>, types: &[&str]) -> String {
    match content {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Array(a)) => a
            .iter()
            .filter(|b| b.get("type").and_then(Value::as_str).is_some_and(|t| types.contains(&t)) && b.get("text").is_some_and(Value::is_string))
            .filter_map(|b| b.get("text").and_then(Value::as_str))
            .collect::<Vec<_>>()
            .join("\n"),
        _ => String::new(),
    }
}

/// Mirrors the `isMeta`/`isCompactSummary` truthiness tests (a JSON value that is not false, 0, null or "").
fn truthy(v: Option<&Value>) -> bool {
    match v {
        None | Some(Value::Null) => false,
        Some(Value::Bool(b)) => *b,
        Some(Value::Number(n)) => n.as_f64().is_some_and(|f| f != 0.0),
        Some(Value::String(s)) => !s.is_empty(),
        Some(_) => true,
    }
}

/// The text left after the leading system-reminder blocks a hook may have injected before the real prompt.
///
/// Mirrors the `LEADING_REMINDERS_RE` replace in `compact-advice.js` `classify`.
fn strip_leading_reminders(txt: &str) -> &str {
    let tags = defaults::raw("compact_decl.reminder_tags");
    let (open, close) = (tags.str_field("open"), tags.str_field("close"));
    let mut rest = txt;
    loop {
        let after_ws = rest.trim_start_matches(is_js_space);
        let Some(inner) = after_ws.strip_prefix(open) else { break };
        let Some(end) = inner.find(close) else { break };
        rest = &inner[end + close.len()..];
    }
    rest
}

/// Classify one transcript entry.
///
/// Mirrors `compact-advice.js` `classify` (only what decides turn text).
fn classify(e: &Value) -> Step {
    let p = pats();
    let ty = e.get("type").and_then(Value::as_str);
    if ty == Some("system") && e.get("subtype").and_then(Value::as_str) == Some("compact_boundary") {
        return Step::Other;
    }
    if e.get("isSidechain") == Some(&Value::Bool(true)) {
        return Step::Other;
    }
    let message = e.get("message").filter(|m| truthy(Some(m)));
    if let (Some("user"), Some(m)) = (ty, message) {
        if truthy(e.get("isMeta")) || truthy(e.get("isCompactSummary")) {
            return Step::Other;
        }
        let content = m.get("content");
        if content.and_then(Value::as_array).is_some_and(|a| a.iter().any(|b| b.get("type").and_then(Value::as_str) == Some("tool_result"))) {
            return Step::Other;
        }
        let txt = text_of_blocks(content, &["text"]);
        if p.notify.is_match(&txt) {
            return Step::Other;
        }
        let typed = strip_leading_reminders(&txt);
        if js_trim(typed).is_empty() || p.not_typed.is_match(typed) || p.compact_cmd.is_match(typed) {
            return Step::Other;
        }
        return Step::NewTurn;
    }
    if let (Some("assistant"), Some(m)) = (ty, message) {
        let texts: Vec<String> = match m.get("content") {
            Some(Value::Array(blocks)) => blocks
                .iter()
                .filter(|b| b.get("type").and_then(Value::as_str) == Some("text"))
                .filter_map(|b| b.get("text").and_then(Value::as_str))
                .filter(|t| !js_trim(t).is_empty())
                .map(str::to_string)
                .collect(),
            Some(Value::String(s)) if !js_trim(s).is_empty() => vec![s.clone()],
            _ => Vec::new(),
        };
        return if texts.is_empty() { Step::Other } else { Step::Text(texts) };
    }
    // Codex rollout entries
    let Some(pl) = e.get("payload").filter(|v| v.is_object()) else { return Step::Other };
    match ty {
        Some("event_msg") => {
            let msg = pl.get("message").and_then(Value::as_str);
            if pl.get("type").and_then(Value::as_str) == Some("user_message") && msg.is_some_and(|m| !js_trim(m).is_empty() && !p.not_typed.is_match(m)) {
                Step::NewTurn
            } else {
                Step::Other
            }
        }
        Some("response_item") => {
            if pl.get("type").and_then(Value::as_str) == Some("message") && pl.get("role").and_then(Value::as_str) == Some("assistant") {
                let txt = text_of_blocks(pl.get("content"), &defaults::list("compact_decl.codex_text_types"));
                return if js_trim(&txt).is_empty() { Step::Other } else { Step::Text(vec![txt]) };
            }
            Step::Other
        }
        _ => Step::Other,
    }
}

/// How deeply a JSON text nests (brackets outside strings).
pub(crate) fn json_depth(line: &str) -> usize {
    let (mut depth, mut max, mut in_str, mut esc) = (0usize, 0usize, false, false);
    for c in line.chars() {
        if in_str {
            if esc {
                esc = false;
            } else if c == '\\' {
                esc = true;
            } else if c == '"' {
                in_str = false;
            }
            continue;
        }
        match c {
            '"' => in_str = true,
            '[' | '{' => {
                depth += 1;
                max = max.max(depth);
            }
            ']' | '}' => depth = depth.saturating_sub(1),
            _ => {}
        }
    }
    max
}

/// The assistant text of the current turn, one part per text block, in order. `None` when a line could not be handled
/// exactly.
///
/// Mirrors `compact-advice.js` `readTurn` (the turn text only).
pub(crate) fn turn_texts(lines: &[String]) -> Option<Vec<String>> {
    let word = defaults::text("compact_decl.safe_word").as_bytes();
    let mut parts: Vec<String> = Vec::new();
    for line in lines.iter().filter(|l| !l.is_empty()) {
        let e: Value = match serde_json::from_str(line) {
            Ok(v) => v,
            Err(_) => {
                // Node might parse what serde rejects: a lone surrogate escape, nesting past serde's limit, a number out
                // of range (an exponent or an integer literal of 309+ digits; JS reads it as Infinity, `jsdiff`). A rejected line that holds the safe word could
                // carry the declaration, so it defers whatever the reason; one without it cannot change the answer.
                if contains_ci(line.as_bytes(), word)
                    || line.contains("\\u")
                    || json_depth(line) > defaults::num("compact_decl.deep_json_depth") as usize
                    || crate::checks::guardkit::jsdiff::js_reads_differently_str(line)
                {
                    return None;
                }
                continue;
            }
        };
        if !e.is_object() && !e.is_array() {
            continue;
        }
        match classify(&e) {
            Step::NewTurn => parts.clear(),
            Step::Text(t) => parts.extend(t),
            Step::Other => {}
        }
    }
    Some(parts)
}
