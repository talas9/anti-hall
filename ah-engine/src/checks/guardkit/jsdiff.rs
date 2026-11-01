//! The one answer to "could JavaScript read this JSON where `serde_json` cannot?".
//!
//! `serde_json` rejects a few documents that `JSON.parse` accepts: a lone surrogate escape (what `JSON.stringify` itself emits for a
//! cut-off astral character), a number outside the f64 range (`1e400`, or an integer literal of 309 or more digits, which JavaScript
//! reads as `Infinity`) and nesting past the 128-level recursion limit. A file like that is NOT absent or invalid for Node: Node reads
//! it and acts. An engine check that treated it as absent would decide differently from Node (a silent allow where Node blocks, a
//! missing advisory), so every engine read of a file Node also reads asks this helper first and DEFERS to Node when it says yes.
//! Any other parse error is one JavaScript has too, so the file is missing/invalid for both.
use serde_json::Value;

/// True when `txt` is rejected by `serde_json` for a reason `JSON.parse` does not share.
pub fn js_reads_differently_str(txt: &str) -> bool {
    match serde_json::from_str::<Value>(txt) {
        Ok(_) => false,
        Err(e) => {
            let m = e.to_string();
            m.contains("out of range")
                || m.contains("recursion limit")
                || m.contains("surrogate")
                || m.contains("hex escape")
                || m.contains("unicode code point")
        }
    }
}

/// Parse `txt` as `JSON.parse` does where `serde_json` cannot: a lone surrogate escape becomes U+FFFD, a number outside the f64 range
/// becomes the largest finite one of its sign (JavaScript's Infinity cannot be held in a [`Value`]), nesting past serde's 128 levels
/// is read to `taskstate.js_parse_max_depth`. The shape (keys, types, array lengths) is what JavaScript sees; only those three values differ.
/// `None`: not one of those classes, or past that depth: the caller decides what an unreadable line means.
pub fn parse_as_js(txt: &str) -> Option<Value> {
    if let Ok(v) = serde_json::from_str::<Value>(txt) {
        return Some(v);
    }
    if !js_reads_differently_str(txt) {
        return None;
    }
    let fixed = repair_for_serde(txt)?;
    let mut de = serde_json::Deserializer::from_str(&fixed);
    de.disable_recursion_limit();
    let v = <Value as serde::Deserialize>::deserialize(&mut de).ok()?;
    de.end().ok()?;
    Some(v)
}

/// `txt` with each lone surrogate escape and each out-of-range number replaced (see [`parse_as_js`]); `None` past `taskstate.js_parse_max_depth`.
fn repair_for_serde(txt: &str) -> Option<String> {
    let max_depth = crate::defaults::num("taskstate.js_parse_max_depth") as usize;
    let b = txt.as_bytes();
    let (mut out, mut i, mut depth) = (String::with_capacity(txt.len()), 0usize, 0usize);
    let hex4 = |at: usize| -> Option<u32> { b.get(at..at + 4).and_then(|h| std::str::from_utf8(h).ok()).and_then(|h| u32::from_str_radix(h, 16).ok()) };
    let mut in_str = false;
    while i < b.len() {
        let c = b[i];
        if in_str {
            match c {
                b'"' => {
                    in_str = false;
                    out.push('"');
                    i += 1;
                }
                b'\\' if b.get(i + 1) == Some(&b'u') => match hex4(i + 2) {
                    Some(hi @ 0xD800..=0xDBFF)
                        if b.get(i + 6) == Some(&b'\\') && b.get(i + 7) == Some(&b'u') && matches!(hex4(i + 8), Some(0xDC00..=0xDFFF)) =>
                    {
                        out.push_str(&txt[i..i + 12]);
                        let _ = hi;
                        i += 12;
                    }
                    Some(0xD800..=0xDFFF) => {
                        out.push_str("\\ufffd");
                        i += 6;
                    }
                    _ => {
                        out.push_str(&txt[i..(i + 2).min(txt.len())]);
                        i += 2;
                    }
                },
                b'\\' => {
                    let end = (i + 2).min(b.len());
                    out.push_str(txt.get(i..end).unwrap_or("\\"));
                    i = end;
                }
                _ => {
                    let ch = txt[i..].chars().next()?;
                    out.push(ch);
                    i += ch.len_utf8();
                }
            }
            continue;
        }
        match c {
            b'"' => {
                in_str = true;
                out.push('"');
                i += 1;
            }
            b'[' | b'{' => {
                depth += 1;
                if depth > max_depth {
                    return None;
                }
                out.push(c as char);
                i += 1;
            }
            b']' | b'}' => {
                depth = depth.saturating_sub(1);
                out.push(c as char);
                i += 1;
            }
            b'-' | b'0'..=b'9' => {
                let start = i;
                while i < b.len() && matches!(b[i], b'-' | b'+' | b'.' | b'e' | b'E' | b'0'..=b'9') {
                    i += 1;
                }
                let tok = &txt[start..i];
                match tok.parse::<f64>() {
                    Ok(f) if f.is_infinite() => out.push_str(if f < 0.0 { "-1.7976931348623157e308" } else { "1.7976931348623157e308" }),
                    _ => out.push_str(tok),
                }
            }
            _ => {
                let ch = txt[i..].chars().next()?;
                out.push(ch);
                i += ch.len_utf8();
            }
        }
    }
    Some(out)
}

/// A SETTINGS file read the way JavaScript reads it for one class only: each number outside the f64 range (JavaScript's `Infinity`, which no
/// setting accepts) becomes `null`, so only that key is invalid (every reader treats `null` as "not set" and falls to the next source, the
/// default at the end) and the rest of the file still counts (#569). Returns the value and how many numbers were replaced. `None` when the text
/// still does not parse for serde: a lone surrogate escape or nesting past serde's limit stays "readable only by JavaScript"
/// ([`js_reads_differently_str`]), which the caller handles with the failure policy.
pub fn parse_settings_as_js(txt: &str) -> Option<(Value, usize)> {
    if let Ok(v) = serde_json::from_str::<Value>(txt) {
        return Some((v, 0));
    }
    let (fixed, replaced) = null_out_of_range_numbers(txt);
    if replaced == 0 {
        return None;
    }
    serde_json::from_str::<Value>(&fixed).ok().map(|v| (v, replaced))
}

/// `txt` with every number token outside the f64 range (outside strings) written as `null`, and how many there were.
fn null_out_of_range_numbers(txt: &str) -> (String, usize) {
    let char_at = |at: usize| txt.get(at..).and_then(|s| s.chars().next());
    let (mut out, mut i, mut replaced, mut in_str) = (String::with_capacity(txt.len()), 0usize, 0usize, false);
    while let Some(ch) = char_at(i) {
        let w = ch.len_utf8();
        if in_str {
            // copy the escape pair or the character whole, so a multi-byte character is never split
            let n = if ch == '\\' { w + char_at(i + w).map_or(0, char::len_utf8) } else { w };
            out.push_str(txt.get(i..i + n).unwrap_or(""));
            if ch == '"' {
                in_str = false;
            }
            i += n;
        } else if ch == '"' {
            in_str = true;
            out.push('"');
            i += w;
        } else if ch == '-' || ch.is_ascii_digit() {
            let start = i;
            while char_at(i).is_some_and(|c| c.is_ascii_digit() || matches!(c, '-' | '+' | '.' | 'e' | 'E')) {
                i += 1;
            }
            let tok = txt.get(start..i).unwrap_or("");
            // only a token that is a JSON number can overflow: Rust's f64 parser also reads `01e400`, which JavaScript rejects
            if is_json_number(tok) && tok.parse::<f64>().is_ok_and(f64::is_infinite) {
                replaced += 1;
                out.push_str("null");
            } else {
                out.push_str(tok);
            }
        } else {
            out.push(ch);
            i += w;
        }
    }
    (out, replaced)
}

/// True when `tok` is a number by the JSON grammar: `-? (0 | [1-9][0-9]*) (. [0-9]+)? ([eE] [+-]? [0-9]+)?`, nothing before or after.
fn is_json_number(tok: &str) -> bool {
    let digits = |s: &str| s.bytes().take_while(u8::is_ascii_digit).count();
    let rest = tok.strip_prefix('-').unwrap_or(tok);
    let int = digits(rest);
    let Some(after_int) = rest.get(int..) else { return false };
    if int == 0 || (int > 1 && rest.starts_with('0')) {
        return false;
    }
    let after_frac = match after_int.strip_prefix('.') {
        Some(f) if digits(f) > 0 => f.get(digits(f)..).unwrap_or("!"),
        Some(_) => return false,
        None => after_int,
    };
    match after_frac.strip_prefix(['e', 'E']) {
        Some(e) => {
            let e = e.strip_prefix(['+', '-']).unwrap_or(e);
            digits(e) > 0 && e.get(digits(e)..).is_some_and(str::is_empty)
        }
        None => after_frac.is_empty(),
    }
}

/// [`js_reads_differently_str`] on file bytes, decoded as Node decodes them (UTF-8, bad bytes replaced).
pub fn js_reads_differently(bytes: &[u8]) -> bool {
    js_reads_differently_str(&String::from_utf8_lossy(bytes))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_class_is_caught() {
        let deep = format!("{}{}", "[".repeat(200), "]".repeat(200));
        let big_int = format!("{{\"x\":1{}}}", "0".repeat(400));
        for (name, doc) in [
            ("exponent overflow", "{\"x\":1e400}".to_string()),
            ("309+ digit integer", big_int),
            ("lone high surrogate", "{\"x\":\"\\ud800\"}".to_string()),
            ("lone low surrogate", "{\"x\":\"\\udc00\"}".to_string()),
            ("nesting past 128", deep),
        ] {
            assert!(js_reads_differently(doc.as_bytes()), "{name}");
        }
    }

    #[test]
    fn a_settings_file_with_an_overflowing_number_reads_with_only_that_key_null() {
        let big_int = format!("1{}", "0".repeat(400));
        for bad in ["1e400", "-1e400", big_int.as_str()] {
            let (v, n) = parse_settings_as_js(&format!("{{\"a\":{{\"x\":{bad},\"y\":5}},\"s\":\"1e400 \\\" é\",\"flag\":true}}")).unwrap();
            assert_eq!((n, &v["a"]["x"], &v["a"]["y"], &v["flag"]), (1, &Value::Null, &Value::from(5), &Value::Bool(true)), "{bad}");
            assert_eq!(v["s"], "1e400 \" é", "a number-looking string is left alone");
        }
        assert_eq!(parse_settings_as_js("{\"x\":1e300}").unwrap().1, 0);
        assert!(parse_settings_as_js("{not json").is_none());
        // the other classes stay unreadable here (the caller applies the failure policy): a lone surrogate, nesting past serde's limit
        assert!(parse_settings_as_js("{\"x\":1e400,\"s\":\"\\ud800\"}").is_none());
        let deep = format!("{{\"x\":1e400,\"d\":{}1{}}}", "[".repeat(200), "]".repeat(200));
        assert!(parse_settings_as_js(&deep).is_none());
    }

    #[test]
    fn a_token_that_is_not_a_json_number_is_never_read_as_an_overflowing_one() {
        // `01e400` parses in Rust's f64 parser (to infinity) but is not JSON: the document stays invalid, never "valid with a null" (#569 review)
        for bad in ["01e400", "-01e400", "00", "1e", "1e+", "1.e400", "1e400-", "1e400e5", "1e400.5", "-", "--1e400"] {
            let doc = format!("{{\"safe\":false,\"x\":{bad}}}");
            assert!(parse_settings_as_js(&doc).is_none(), "{bad}");
            // an overflowing number next to it does not launder it either
            let doc = format!("{{\"a\":1e400,\"x\":{bad}}}");
            assert!(parse_settings_as_js(&doc).is_none(), "{bad} beside a real overflow");
        }
        for ok in ["0", "-0", "0.5", "1E400", "1e+400", "1e-400", "-1.5e+400", "123456789e2"] {
            assert!(is_json_number(ok), "{ok}");
        }
    }

    #[test]
    fn ordinary_documents_are_not() {
        for doc in ["{\"x\":1e300}", "{\"x\":\"\\ud83d\\ude00\"}", "{\"a\":[1,2]}", "{not json", "", "{\"x\":1,}"] {
            assert!(!js_reads_differently(doc.as_bytes()), "{doc}");
        }
    }
}
