//! The tool-use scan of the tasklist guard's work count (issue #22): `ah.transcript.toolUseScan` does inside the engine what
//! `tlScanWork` did with every candidate line in QuickJS (parse it, walk the entry for tool uses), and hands the script only the
//! facts its loop reads. The decision (what counts as work, when a timestamp is odd) stays in the script.
//!
//! The lines are the ones `ah.fs.tailLines(path, window, true, needles)` returns (same window, same dropped first line, same
//! `\r` rule). Each is read as the script's loop reads it, in order, and one item comes back per line that matters:
//! * `["u"]`: a line the parser cannot resolve (recorded as uncertain; later lines are still read);
//! * `["n"]`: a line that parses to JSON `null` (the loop answers `quiet`; nothing after it is read);
//! * `[ts, uses]`: an entry; `ts` is its `timestamp` when that is a string, else `null`; `uses` are the tool uses `tlToolUses`
//!   collects (an object with `type: "tool_use"` and a truthy `name`, found by descending the given keys, in that order) cut down
//!   to `[name, file_path, command]` (a string, or `null` when the input does not hold one as a string; a non-string name is `""`).
//!   Only an entry with a string `ts` or at least one use is listed (the loop's timestamp check can defer even with no use).
//!
//! A line that is blank or that JSON rejects is left out (the loop skips it). `null` instead of an array: the file is unreadable.
use super::host_b3::read_tail;
use crate::checks::replykit::io::truthy;
use crate::checks::replykit::transcript::prop;
use crate::checks::taskstate::parse::{Line, parse_line};
use crate::defaults;
use rquickjs::{Ctx, Function, Object};
use serde_json::{Value, json};

/// `[name, file_path, command]` of one tool use.
fn cut(node: &Value) -> Value {
    let name = prop(node, "name").and_then(Value::as_str).unwrap_or("");
    let input = prop(node, "input");
    let text = |k: &str| input.and_then(|i| prop(i, k)).and_then(Value::as_str).map_or(Value::Null, |s| Value::String(s.to_string()));
    json!([name, text("file_path"), text("command")])
}

/// `tlToolUses(node, out)`: the node itself first (when it is a tool use), then each collect key's value in key order (an array's
/// elements one by one, an object itself).
fn collect(node: &Value, keys: &[String], out: &mut Vec<Value>) {
    if !node.is_object() {
        return;
    }
    if prop(node, "type").and_then(Value::as_str) == Some(defaults::text("transcript.ev_type_tool_use")) && prop(node, "name").is_some_and(truthy) {
        out.push(cut(node));
    }
    for k in keys {
        match prop(node, k) {
            Some(Value::Array(items)) => items.iter().for_each(|it| collect(it, keys, out)),
            Some(v) if v.is_object() => collect(v, keys, out),
            _ => {}
        }
    }
}

/// The items of `text` (the tail the host read), as the compact JSON array text.
fn items_of(text: &str, needles: &[String], keys: &[String]) -> String {
    let pieces: Vec<&str> = text.split('\n').collect();
    let last = pieces.len().saturating_sub(1);
    let mut items: Vec<Value> = Vec::new();
    for (i, piece) in pieces.into_iter().enumerate() {
        let line = if i != last { piece.strip_suffix('\r').unwrap_or(piece) } else { piece };
        if !needles.iter().any(|n| line.contains(n.as_str())) {
            continue;
        }
        let e = match parse_line(line) {
            Line::Unsure => {
                items.push(json!(["u"]));
                continue;
            }
            Line::Skip => continue,
            Line::Parsed(e) => e,
        };
        if e.is_null() {
            items.push(json!(["n"]));
            break;
        }
        let ts = prop(&e, "timestamp").filter(|t| t.is_string()).cloned().unwrap_or(Value::Null);
        let mut uses = Vec::new();
        collect(&e, keys, &mut uses);
        if !uses.is_empty() || !ts.is_null() {
            items.push(Value::Array(vec![ts, Value::Array(uses)]));
        }
    }
    Value::Array(items).to_string()
}

/// `toolUseScan(path, window, needles, keys)`: JSON text, see the module doc. A line is read only when it holds one of `needles`
/// (none: no line is).
pub fn tool_use_scan(path: &str, window: f64, needles: &[String], keys: &[String]) -> String {
    match read_tail(path, window.max(0.0) as u64) {
        None => "null".into(),
        Some(text) => items_of(&text, needles, keys),
    }
}

/// Add the scan to `ahHost`.
pub fn install<'a>(c: &Ctx<'a>, h: &Object<'a>) -> rquickjs::Result<()> {
    h.set("toolUseScan", Function::new(c.clone(), |p: String, w: f64, needles: Vec<String>, keys: Vec<String>| tool_use_scan(&p, w, &needles, &keys))?)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn needles() -> Vec<String> {
        ["tool_use", "\\u", "null"].iter().map(|s| s.to_string()).collect()
    }
    fn keys() -> Vec<String> {
        ["message", "content"].iter().map(|s| s.to_string()).collect()
    }
    fn file(tag: &str, text: &str) -> String {
        let p = std::env::temp_dir().join(format!("ah-tus-{tag}-{}", std::process::id()));
        std::fs::write(&p, text).unwrap();
        p.to_string_lossy().into_owned()
    }
    fn scan(text: &str, window: f64) -> Value {
        let p = file("scan", text);
        let r = tool_use_scan(&p, window, &needles(), &keys());
        std::fs::remove_file(&p).ok();
        serde_json::from_str(&r).unwrap()
    }

    #[test]
    fn entries_come_back_in_order_with_their_uses() {
        let t = concat!(
            r#"{"timestamp":"2026-01-01T00:00:00Z","message":{"content":[{"type":"tool_use","name":"Edit","input":{"file_path":"/a","x":1}},{"type":"tool_use","name":"Bash","input":{"command":"ls"}}]}}"#,
            "\n",
            r#"{"timestamp":"2026-01-01T00:00:01Z","type":"null"}"#,
            "\n",
        );
        assert_eq!(scan(t, 1e6), json!([["2026-01-01T00:00:00Z", [["Edit", "/a", null], ["Bash", null, "ls"]]], ["2026-01-01T00:00:01Z", []]]));
    }

    #[test]
    fn collect_keys_are_followed_in_order_nested_and_the_node_comes_first() {
        let t = r#"{"type":"tool_use","name":"A","message":{"content":[{"type":"tool_use","name":"B","content":{"type":"tool_use","name":"C"}},[{"type":"tool_use","name":"skipped"}]],"type":"tool_use","name":"D"},"content":{"type":"tool_use","name":"E"}}"#;
        let names: Vec<String> = scan(t, 1e6)[0][1].as_array().unwrap().iter().map(|u| u[0].as_str().unwrap().to_string()).collect();
        assert_eq!(names, ["A", "D", "B", "C", "E"]);
    }

    #[test]
    fn a_name_that_is_falsy_or_not_a_string_is_handled_like_the_script() {
        let t = concat!(
            r#"{"type":"tool_use","name":"","input":{}}"#,
            "\n",
            r#"{"type":"tool_use","name":7,"input":"s"}"#,
            "\n",
            r#"{"type":"tool_use","name":"Write","input":{"file_path":5,"command":["x"]}}"#,
            "\n",
        );
        assert_eq!(scan(t, 1e6), json!([[null, [["", null, null]]], [null, [["Write", null, null]]]]));
    }

    #[test]
    fn a_non_string_timestamp_is_null_and_an_entry_without_use_or_string_ts_is_left_out() {
        let t = concat!(
            r#"{"timestamp":5,"x":"null"}"#,
            "\n",
            r#"{"timestamp":6,"type":"tool_use","name":"Edit"}"#,
            "\n",
            r#"[1,"null"]"#,
            "\n",
            r#""null""#,
            "\n",
        );
        assert_eq!(scan(t, 1e6), json!([[null, [["Edit", null, null]]]]));
    }

    #[test]
    fn a_null_line_ends_the_list_but_a_js_readable_line_does_not() {
        let t = "{\"timestamp\":\"t\",\"a\":\"null\"}\nnull\n{\"timestamp\":\"later\",\"a\":\"null\"}\n";
        assert_eq!(scan(t, 1e6), json!([["t", []], ["n"]]));
        // A lone surrogate escape uses the shared JavaScript-compatible parser.
        let t = "{\"timestamp\":\"t\",\"a\":\"null\"}\n{\"a\":\"\\ud800\"}\n{\"timestamp\":\"later\",\"a\":\"null\"}\n";
        assert_eq!(scan(t, 1e6), json!([["t", []], ["later", []]]));
    }

    #[test]
    fn invalid_blank_and_unmatched_lines_are_skipped_and_an_escape_line_is_read() {
        let t = concat!(
            "not json null\n",
            "   \n",
            r#"{"timestamp":"t","a":"nothing to see"}"#,
            "\n",
            r#"{"timestamp":"e","type":"tool_use","name":"\u0042ash","input":{"command":"x\u0041"}}"#,
            "\r\n",
        );
        assert_eq!(scan(t, 1e6), json!([["e", [["Bash", null, "xA"]]]]));
    }

    #[test]
    fn the_window_drops_the_cut_first_line() {
        let a = r#"{"timestamp":"a","type":"tool_use","name":"Edit"}"#;
        let b = r#"{"timestamp":"b","type":"tool_use","name":"Bash"}"#;
        let t = format!("{a}\n{b}\n");
        let w = (b.len() + 1 + 5) as f64;
        assert_eq!(scan(&t, w), json!([["b", [["Bash", null, null]]]]));
        assert_eq!(scan(&t, 1e6)[0][0], json!("a"));
    }

    #[test]
    fn a_missing_file_is_null() {
        assert_eq!(tool_use_scan("/nonexistent/ah-tus", 100.0, &needles(), &keys()), "null");
    }
}
