//! Reading assistant text out of a transcript the way the Node Stop hooks do (`collectTextFromEntryLegacy`,
//! `extractLastAssistantTextWith`), including the quirks the verdicts and the stored hashes depend on.
use super::Defer;
use super::io::{Tail, split_lines, truthy};
use crate::checks::guardkit::text::js_trim;
use serde_json::Value;

/// A property of an object value; every other kind of value has none (`"x".content` is `undefined`).
pub fn prop<'a>(v: &'a Value, key: &str) -> Option<&'a Value> {
    v.as_object().and_then(|m| m.get(key))
}

/// `JSON.parse(js_trim(line))` for one transcript line. `Ok(None)` when Node would throw and skip the line; `Err(Defer)`
/// when Node might parse what `serde_json` cannot (a lone surrogate escape, a number beyond the double range, nesting
/// beyond the recursion limit), so the decision is left to Node.
pub fn parse_line(line: &str) -> Result<Option<Value>, Defer> {
    let t = js_trim(line);
    if t.is_empty() {
        return Ok(None);
    }
    parse_text(t)
}

/// `JSON.parse(text)` with no trimming first (the turn gate parses its lines as they are).
pub fn parse_text(t: &str) -> Result<Option<Value>, Defer> {
    match serde_json::from_str::<Value>(t) {
        Ok(v) => Ok(Some(v)),
        Err(e) => {
            let msg = e.to_string();
            if crate::defaults::list("replykit.unsure_parse_errors").iter().any(|m| msg.contains(m)) { Err(Defer) } else { Ok(None) }
        }
    }
}

/// The transcript tail as the Node hooks split it: lines on `\r?\n`, the possibly cut first line dropped.
pub fn tail_lines(tail: &Tail) -> Vec<&str> {
    let mut lines = split_lines(&tail.data);
    if tail.truncated && !lines.is_empty() {
        lines.remove(0);
    }
    lines
}

/// `collectTextFromEntryLegacy(node, mapText)`: the text of a transcript entry, joined with one space, a nested
/// `message` collected again after its parent (so a text can appear twice). `map` is applied to every collected string.
pub fn collect_legacy(node: &Value, map: Option<&dyn Fn(&str) -> String>) -> String {
    if !node.is_object() && !node.is_array() {
        return String::new();
    }
    let f = |s: &str| map.map_or_else(|| s.to_string(), |m| m(s));
    let mut parts: Vec<String> = Vec::new();
    if let Some(Value::String(t)) = prop(node, "text") {
        parts.push(f(t));
    }
    let message = prop(node, "message");
    let direct = prop(node, "content").filter(|c| truthy(c));
    let content: Option<&Value> = direct.or_else(|| match message {
        Some(m) if truthy(m) => prop(m, "content"),
        Some(m) => Some(m),
        None => None,
    });
    match content {
        Some(Value::String(s)) => parts.push(f(s)),
        Some(Value::Array(blocks)) => {
            for b in blocks {
                if !truthy(b) || !(b.is_object() || b.is_array()) {
                    continue;
                }
                if let Some(Value::String(t)) = prop(b, "text") {
                    parts.push(f(t));
                }
            }
        }
        _ => {}
    }
    if let Some(m) = message.filter(|m| truthy(m) && (m.is_object() || m.is_array())) {
        let sub = collect_legacy(m, map);
        if !sub.is_empty() {
            parts.push(sub);
        }
    }
    parts.join(" ")
}

/// `extractLastAssistantTextWith`: the text of the last assistant entry in `lines` that has any. `Err(Defer)` when a
/// line is one Node might parse differently.
pub fn last_assistant_text(lines: &[&str], map: Option<&dyn Fn(&str) -> String>) -> Result<Option<String>, Defer> {
    let mut last: Option<String> = None;
    for line in lines {
        let Some(entry) = parse_line(line)? else { continue };
        // role = entry && (entry.role || (entry.message && entry.message.role))
        let role = match prop(&entry, "role").filter(|r| truthy(r)) {
            Some(r) => Some(r),
            None => prop(&entry, "message").filter(|m| truthy(m)).and_then(|m| prop(m, "role")),
        };
        if role.and_then(Value::as_str) != Some(crate::defaults::text("replykit.role_assistant")) {
            continue;
        }
        let text = collect_legacy(&entry, map);
        if !text.is_empty() {
            last = Some(text);
        }
    }
    Ok(last)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn a_message_text_is_collected_twice_like_the_legacy_collector_does() {
        let e = json!({"message": {"role": "assistant", "content": [{"type": "text", "text": "hi"}]}});
        assert_eq!(collect_legacy(&e, None), "hi hi");
        let e = json!({"role": "assistant", "content": "plain"});
        assert_eq!(collect_legacy(&e, None), "plain");
    }

    #[test]
    fn an_empty_message_string_adds_an_empty_part() {
        let e = json!({"content": "", "message": "", "text": "a"});
        assert_eq!(collect_legacy(&e, None), "a ");
    }

    #[test]
    fn the_last_assistant_entry_with_text_wins() {
        let lines = [r#"{"role":"assistant","content":"one"}"#, r#"{"role":"user","content":"x"}"#, r#"{"message":{"role":"assistant","content":"two"}}"#, "garbage", ""];
        assert_eq!(last_assistant_text(&lines, None).unwrap().as_deref(), Some("two two"));
    }

    #[test]
    fn lone_surrogates_defer() {
        assert_eq!(parse_line(r#"{"a":"\ud800"}"#), Err(Defer));
        assert_eq!(parse_line("not json"), Ok(None));
    }
}
