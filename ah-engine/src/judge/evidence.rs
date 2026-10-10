//! The tool evidence and the user request the speculation judge reads, from transcript lines (Claude and Codex shapes).
//!
//! Mirrors `hooks/lib/inference-check.js` `collectEvidence(lines, { raw: true })`, `lastUserPrompt`, `textOf` and
//! `fencedBlocks`. Lines are parsed with [`crate::checks::replykit::json`], which keeps key order, because an object
//! without text is written back with `JSON.stringify`; a line that parser cannot represent exactly is a [`Defer`].
use crate::checks::guardkit::jsre;
use crate::checks::guardkit::text::js_trim;
use crate::checks::jsport::num::to_js_string;
use crate::checks::jsport::text::slice16_lossy;
use crate::checks::replykit::Defer;
use crate::checks::replykit::json::{self, Oj, ParseError};
use crate::defaults;
use regex::Regex;

fn word(name: &str) -> &'static str {
    defaults::raw("judge_evidence.words").str_field(name)
}

fn observe() -> &'static Regex {
    static R: crate::defaults::Cache<Regex> = crate::defaults::Cache::new();
    R.get_or_init(|| jsre::compile(defaults::text("judge_evidence.observe_tools_re"), true))
}

fn prompt_skip() -> &'static Regex {
    static R: crate::defaults::Cache<Regex> = crate::defaults::Cache::new();
    R.get_or_init(|| jsre::compile(defaults::text("judge_evidence.prompt_skip_re"), false))
}

/// `String(v)` of a parsed value (`undefined` is "undefined").
fn js_string(v: Option<&Oj>) -> String {
    match v {
        None => "undefined".to_string(),
        Some(Oj::Null) => "null".to_string(),
        Some(Oj::Bool(b)) => b.to_string(),
        Some(Oj::Num(n)) => to_js_string(*n),
        Some(Oj::Str(s)) => s.clone(),
        Some(Oj::Arr(a)) => a.iter().map(|x| if matches!(x, Oj::Null) { String::new() } else { js_string(Some(x)) }).collect::<Vec<_>>().join(","),
        Some(Oj::Obj(_)) => "[object Object]".to_string(),
    }
}

/// `String(v || '')`.
fn js_string_or_empty(v: Option<&Oj>) -> String {
    match v {
        Some(x) if x.truthy() => js_string(Some(x)),
        _ => String::new(),
    }
}

/// `v != null` (neither `undefined` nor `null`).
fn present(v: Option<&Oj>) -> Option<&Oj> {
    v.filter(|x| !matches!(x, Oj::Null))
}

/// `textOf(v)`.
fn text_of(v: Option<&Oj>) -> String {
    match v {
        None | Some(Oj::Null) => String::new(),
        Some(Oj::Str(s)) => s.clone(),
        Some(Oj::Arr(a)) => a
            .iter()
            .map(|b| if b.is_object_like() { text_of(present(b.get("text")).or_else(|| b.get("content"))) } else { text_of(Some(b)) })
            .collect::<Vec<_>>()
            .join("\n"),
        Some(o @ Oj::Obj(_)) => {
            if let Some(Oj::Str(t)) = o.get("text") {
                return t.clone();
            }
            if let Some(c) = present(o.get("content")) {
                return text_of(Some(c));
            }
            if let Some(Oj::Str(t)) = o.get("output") {
                return t.clone();
            }
            o.stringify()
        }
        Some(x) => js_string(Some(x)),
    }
}

/// `fencedBlocks(s)`: the body of every ```` ``` ```` or `~~~` fenced block, in order (`/(```|~~~)[^\n]*\n([\s\S]*?)\1/g`).
fn fenced_blocks(s: &str) -> Vec<String> {
    let fences = defaults::list("judge_evidence.fences");
    let mut out = Vec::new();
    let mut at = 0usize;
    while at < s.len() {
        let rest = &s[at..];
        let Some((start, fence)) = fences.iter().filter_map(|f| rest.find(f).map(|i| (i, *f))).min_by_key(|(i, _)| *i) else { break };
        let open = at + start;
        let after = open + fence.len();
        let found = s[after..].find('\n').and_then(|nl| {
            let body = after + nl + 1;
            s[body..].find(fence).map(|close| (body, body + close))
        });
        match found {
            Some((body, close)) => {
                out.push(s[body..close].to_string());
                at = close + fence.len();
            }
            // no match from this position: the regex retries one character later
            None => at = open + s[open..].chars().next().map_or(1, char::len_utf8),
        }
    }
    out
}

/// `push(s)` of collectEvidence (raw): the text, cut to `judge_evidence.max_chunk` units, when it is not blank.
fn push(chunks: &mut Vec<String>, t: String) {
    if !js_trim(&t).is_empty() {
        chunks.push(slice16_lossy(&t, defaults::num("judge_evidence.max_chunk") as usize));
    }
}

/// `JSON.parse(line.trim())` of a line starting with `{`; `Ok(None)` for a line Node skips.
fn parse_entry(line: &str) -> Result<Option<Oj>, Defer> {
    let t = js_trim(line);
    if !t.starts_with('{') {
        return Ok(None);
    }
    match json::parse(t) {
        Ok(v) if v.is_object_like() => Ok(Some(v)),
        Ok(_) | Err(ParseError::Invalid) => Ok(None),
        Err(ParseError::Unsure) => Err(Defer),
    }
}

/// `msg` and `role` of a Claude transcript entry: the nested message when it is an object, the role as the first truthy of
/// `e.role`, `msg.role`, `e.type`.
fn msg_and_role(e: &Oj) -> (&Oj, Option<&Oj>) {
    let msg = match e.get("message") {
        Some(m) if m.is_object_like() => m,
        _ => e,
    };
    let role = [e.get("role"), msg.get("role"), e.get("type")].into_iter().flatten().find(|v| v.truthy());
    (msg, role)
}

fn is(v: Option<&Oj>, w: &str) -> bool {
    v.and_then(Oj::as_str) == Some(word(w))
}

/// `collectEvidence(lines, { raw: true })`: the evidence chunks, oldest first.
pub fn collect_evidence(lines: &[&str]) -> Result<Vec<String>, Defer> {
    let mut chunks = Vec::new();
    let tag = defaults::text("judge_evidence.task_notification");
    for line in lines {
        let Some(e) = parse_entry(line)? else { continue };
        // Codex rollout
        if is(e.get("type"), "response_item")
            && let Some(p) = e.get("payload").filter(|p| p.is_object_like())
        {
            let ty = p.get("type");
            if is(ty, "function_call") || is(ty, "custom_tool_call") || is(ty, "local_shell_call") {
                let name = match p.get("name") {
                    Some(n) if n.truthy() => js_string(Some(n)),
                    _ => defaults::text("judge_evidence.default_tool").to_string(),
                };
                if observe().is_match(&name) {
                    let input = present(p.get("arguments")).or_else(|| present(p.get("input"))).or_else(|| p.get("action"));
                    push(&mut chunks, text_of(input));
                }
            } else if js_string_or_empty(ty).ends_with(defaults::text("judge_evidence.output_suffix")) {
                push(&mut chunks, text_of(p.get("output")));
            }
            continue;
        }
        if is(e.get("type"), "event_msg") && e.get("payload").is_some_and(|p| p.truthy() && is(p.get("type"), "user_message")) {
            let message = e.get("payload").and_then(|p| p.get("message"));
            for b in fenced_blocks(&js_string(message)) {
                push(&mut chunks, b);
            }
            continue;
        }
        // Claude transcript
        let (msg, role) = msg_and_role(&e);
        let content = msg.get("content");
        if is(role, "assistant") {
            if let Some(Oj::Arr(blocks)) = content {
                for b in blocks {
                    if b.truthy() && is(b.get("type"), "tool_use") && observe().is_match(&js_string_or_empty(b.get("name"))) {
                        push(&mut chunks, text_of(b.get("input")));
                    }
                }
            }
        } else if is(role, "user") {
            match content {
                Some(Oj::Arr(blocks)) => {
                    for b in blocks.iter().filter(|b| b.is_object_like()) {
                        if is(b.get("type"), "tool_result") {
                            push(&mut chunks, text_of(b.get("content")));
                        } else if is(b.get("type"), "text") {
                            if js_string_or_empty(b.get("text")).contains(tag) {
                                push(&mut chunks, js_string_or_empty(b.get("text")));
                            } else {
                                for f in fenced_blocks(&js_string(b.get("text"))) {
                                    push(&mut chunks, f);
                                }
                            }
                        }
                    }
                }
                Some(Oj::Str(c)) => {
                    if c.contains(tag) {
                        push(&mut chunks, c.clone());
                    } else {
                        for f in fenced_blocks(c) {
                            push(&mut chunks, f);
                        }
                    }
                }
                _ => {}
            }
        }
    }
    Ok(chunks)
}

/// `lastUserPrompt(lines)`: the text of the latest real user prompt, or empty.
pub fn last_user_prompt(lines: &[&str]) -> Result<String, Defer> {
    let mut last = String::new();
    for line in lines {
        let Some(e) = parse_entry(line)? else { continue };
        if is(e.get("type"), "event_msg")
            && let Some(p) = e.get("payload").filter(|p| p.truthy())
            && is(p.get("type"), "user_message")
            && let Some(Oj::Str(m)) = p.get("message")
        {
            last = m.clone();
            continue;
        }
        if e.get("isMeta").is_some_and(Oj::truthy) {
            continue;
        }
        let (msg, role) = msg_and_role(&e);
        if !is(role, "user") {
            continue;
        }
        let text = match msg.get("content") {
            Some(Oj::Str(c)) => c.clone(),
            Some(Oj::Arr(blocks)) if !blocks.iter().any(|b| b.truthy() && is(b.get("type"), "tool_result")) => blocks
                .iter()
                .filter(|b| b.truthy() && is(b.get("type"), "text"))
                .filter_map(|b| b.get("text").and_then(Oj::as_str))
                .collect::<Vec<_>>()
                .join("\n"),
            _ => String::new(),
        };
        if !js_trim(&text).is_empty() && !prompt_skip().is_match(&text) {
            last = text;
        }
    }
    Ok(last)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fenced_blocks_match_the_node_regex() {
        assert_eq!(fenced_blocks("a\n```sh\nls -la\n```\nb ~~~\nx~~~"), vec!["ls -la\n".to_string(), "x".to_string()]);
        assert_eq!(fenced_blocks("```no newline```"), Vec::<String>::new());
        assert_eq!(fenced_blocks("````\nq\n````"), vec!["q\n".to_string()], "the four-backtick line opens at its first three");
        assert_eq!(fenced_blocks("```\nunclosed"), Vec::<String>::new());
    }

    #[test]
    fn text_of_follows_node() {
        let v = |s: &str| json::parse(s).unwrap();
        assert_eq!(text_of(Some(&v(r#"[{"text":"a"},{"content":[{"text":"b"}]},3,null]"#))), "a\nb\n3\n");
        assert_eq!(text_of(Some(&v(r#"{"z":1,"a":{"b":2}}"#))), r#"{"z":1,"a":{"b":2}}"#);
        assert_eq!(text_of(Some(&v(r#"{"text":5,"content":null,"output":"o"}"#))), "o");
    }

    #[test]
    fn evidence_and_prompt_from_a_claude_transcript() {
        let lines = [
            r#"{"type":"user","message":{"role":"user","content":"why is the build slow?"}}"#,
            r#"{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","name":"Bash","input":{"command":"ls"}},{"type":"tool_use","name":"Edit","input":{"x":1}}]}}"#,
            r#"{"type":"user","message":{"role":"user","content":[{"type":"tool_result","content":"total 0"}]}}"#,
            r#"{"type":"user","isMeta":true,"message":{"role":"user","content":"meta"}}"#,
            r#"{"type":"user","message":{"role":"user","content":"<system-reminder>x</system-reminder>"}}"#,
        ];
        assert_eq!(collect_evidence(&lines).unwrap(), vec![r#"{"command":"ls"}"#.to_string(), "total 0".to_string()]);
        assert_eq!(last_user_prompt(&lines).unwrap(), "why is the build slow?");
    }
}
