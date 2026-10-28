//! The transcript-turn helpers behind the `compact-declaration-guard` script (D88) and the context-budget checks: the tail
//! reader, the current turn's assistant text, the JSON depth test. The decision itself (is this call new work, may the turn
//! hold a declaration) is `engine/logic/compact-declaration-guard.js`; this module keeps only the generic primitives the
//! script host exposes (`ah.transcript.turnText`).
//!
//! Mirrors `hooks/lib/transcript-tail.js` and `hooks/lib/compact-advice.js` (`classify`, `readTurn`).
// Discard triage (E3): every `.ok()` / `unwrap_or_default()` in this file is a deliberate keep, for these reasons:
// - an unreadable optional file is the same as an absent one (fail-open, as Node's try/catch)
// A failure that must be seen goes through `crate::discard` instead.

use crate::checks::guardkit::jsre;
use crate::checks::guardkit::text::{is_js_space, js_trim};
use crate::defaults;
use regex::Regex;
use serde_json::Value;
use std::io::{Read, Seek, SeekFrom};

/// The compiled patterns, built once from the defaults.
struct Pats {
    not_typed: Regex,
    notify: Regex,
    compact_cmd: Regex,
}

fn pats() -> std::sync::Arc<Pats> {
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
    crate::load::note_scan(n);
    let mut buf = vec![0u8; n as usize];
    let mut got = 0usize;
    while got < buf.len() {
        match buf.get_mut(got..).map_or(Ok(0), |rest| f.read(rest)) {
            Ok(0) => break,
            Ok(k) => got += k,
            Err(_) => return None,
        }
    }
    let text = String::from_utf8_lossy(buf.get(..got).unwrap_or_default());
    let mut lines: Vec<String> = text.split('\n').map(str::to_string).collect();
    if size > n {
        lines.remove(0);
    }
    Some(lines)
}

/// ASCII-case-insensitive substring test on bytes.
pub(crate) fn contains_ci(hay: &[u8], needle: &[u8]) -> bool {
    // the candidates are the places where the first byte of the needle occurs in either case (a vectorised search); the rest of the
    // needle is compared there. A scan that compared every window of a 1.5 MB window byte by byte was a third of the call.
    let Some((&first, rest)) = needle.split_first() else { return false };
    let (lo, up) = (first.to_ascii_lowercase(), first.to_ascii_uppercase());
    let mut from = 0;
    while let Some(at) = memchr::memchr2(lo, up, hay.get(from..).unwrap_or_default()) {
        let start = from + at;
        if hay.get(start + 1..start + needle.len()).is_some_and(|tail| tail.eq_ignore_ascii_case(rest)) {
            return true;
        }
        from = start + 1;
    }
    false
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
        rest = inner.get(end + close.len()..).unwrap_or_default();
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
/// Mirrors `compact-advice.js` `readTurn` (the turn text only). The turn is what follows the LAST real prompt, and a prompt clears
/// whatever came before it, so the lines are read from the end and the walk stops at that prompt: nothing earlier can change the
/// answer, and a transcript window is mostly earlier turns (the walk used to parse all of it, about 3 ms of a 4 ms call on a 1.5 MB
/// window). A line the parser rejects and that could hold the declaration still defers, wherever it is in the turn; one BEFORE the
/// last prompt no longer does, because Node's fold forgets it at that prompt as well.
pub(crate) fn turn_texts(lines: &[String]) -> Option<Vec<String>> {
    let word = defaults::text("compact_decl.safe_word").as_bytes();
    // the text of each line of the turn, newest line first
    let mut newest_first: Vec<Vec<String>> = Vec::new();
    for line in lines.iter().rev().filter(|l| !l.is_empty()) {
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
            Step::NewTurn => break,
            Step::Text(t) => newest_first.push(t),
            Step::Other => {}
        }
    }
    Some(newest_first.into_iter().rev().flatten().collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn user(t: &str) -> String {
        json!({"type": "user", "message": {"role": "user", "content": t}}).to_string()
    }

    fn assistant(t: &str) -> String {
        json!({"type": "assistant", "message": {"role": "assistant", "content": [{"type": "text", "text": t}]}}).to_string()
    }

    fn tool_result() -> String {
        json!({"type": "user", "message": {"role": "user", "content": [{"type": "tool_result", "content": "ok"}]}}).to_string()
    }

    /// The forward fold the reverse scan replaces: every line is read, a new turn clears what came before it.
    fn forward(lines: &[String]) -> Option<Vec<String>> {
        let word = defaults::text("compact_decl.safe_word").as_bytes();
        let mut parts: Vec<String> = Vec::new();
        for line in lines.iter().filter(|l| !l.is_empty()) {
            let e: Value = match serde_json::from_str(line) {
                Ok(v) => v,
                Err(_) => {
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

    fn init() {
        crate::defaults::init().expect("defaults");
    }

    /// The turn text is what follows the last real prompt, so a line before that prompt is never read: the answer cannot depend on
    /// it (the fold clears at the prompt), and reading it was most of the cost of a call on a long transcript.
    #[test]
    fn lines_before_the_last_prompt_are_not_read() {
        init();
        let word = defaults::text("compact_decl.safe_word");
        // a line the parser rejects and that holds the word: a fold from the start gives up on it ...
        let torn = format!("{{\"type\":\"assistant\",\"message\": {word} torn");
        let lines = vec![torn, user("first"), assistant("old"), user("second"), tool_result(), assistant("new one"), assistant("new two")];
        assert_eq!(forward(&lines), None, "the forward fold reads the torn line");
        // ... the turn after `second` does not contain it, so the answer is the turn's own text
        assert_eq!(turn_texts(&lines), Some(vec!["new one".to_string(), "new two".to_string()]));
    }

    /// A line the parser rejects INSIDE the current turn still defers (it may hold the declaration).
    #[test]
    fn a_torn_line_inside_the_turn_still_defers() {
        init();
        let word = defaults::text("compact_decl.safe_word");
        let torn = format!("{{\"type\":\"assistant\",\"message\": {word} torn");
        let lines = vec![user("p"), assistant("a"), torn, assistant("b")];
        assert_eq!(turn_texts(&lines), None);
        assert_eq!(turn_texts(&lines), forward(&lines));
        // one that cannot hold it is skipped, as before
        let lines = vec![user("p"), assistant("a"), "not json at all".to_string(), assistant("b")];
        assert_eq!(turn_texts(&lines), Some(vec!["a".to_string(), "b".to_string()]));
    }

    /// The same answer as the forward fold on windows where no unreadable line sits before the last prompt.
    #[test]
    fn it_agrees_with_the_forward_fold_on_generated_windows() {
        init();
        let mut seed = 0x2545_f491_4f6c_dd1du64;
        let mut next = move |n: u64| {
            seed ^= seed << 13;
            seed ^= seed >> 7;
            seed ^= seed << 17;
            seed % n
        };
        for _ in 0..400 {
            let mut lines = Vec::new();
            for i in 0..(next(14) as usize) {
                lines.push(match next(8) {
                    0 | 1 => user(&format!("prompt {i}")),
                    2 | 3 => assistant(&format!("text {i}")),
                    4 => tool_result(),
                    5 => String::new(),
                    6 => json!({"type": "system", "subtype": "compact_boundary"}).to_string(),
                    _ => json!({"type": "attachment", "n": i}).to_string(),
                });
            }
            assert_eq!(turn_texts(&lines), forward(&lines), "{lines:?}");
        }
    }

    #[test]
    fn contains_ci_agrees_with_a_plain_scan() {
        let naive = |hay: &[u8], needle: &[u8]| !needle.is_empty() && hay.windows(needle.len()).any(|w| w.eq_ignore_ascii_case(needle));
        let hays: [&[u8]; 8] = [b"", b"s", b"SAFE", b"a safe b", b"unSAfe", b"sa", b"xxsafxxSaFe", "caf\u{e9} SAFE".as_bytes()];
        for h in hays {
            for n in [&b"safe"[..], b"", b"s", b"SAFE", b"e", b"zz"] {
                assert_eq!(contains_ci(h, n), naive(h, n), "{h:?} {n:?}");
            }
        }
    }
}
