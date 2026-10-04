//! JavaScript string semantics the guards depend on: what counts as white space, `trim`, `replace(/\s+/g, ' ')` and
//! `slice` (which counts UTF-16 units, not characters).

/// True for what JavaScript treats as white space (`\s`, `String.prototype.trim`): the ECMAScript WhiteSpace and
/// LineTerminator sets. Rust's `char::is_whitespace` differs (it includes U+0085 and lacks U+FEFF), so it is not used.
///
/// Mirrors the ECMAScript `\s` class; the same set is shipped as `guardkit.js_space` for regexes.
pub fn is_js_space(c: char) -> bool {
    matches!(
        c,
        '\t' | '\n' | '\u{b}' | '\u{c}' | '\r' | ' ' | '\u{a0}' | '\u{1680}' | '\u{2000}'
            ..='\u{200a}' | '\u{2028}' | '\u{2029}' | '\u{202f}' | '\u{205f}' | '\u{3000}' | '\u{feff}'
    )
}

/// `String.prototype.trim`.
pub fn js_trim(s: &str) -> &str {
    s.trim_matches(is_js_space)
}

/// `s.replace(/\s+/g, ' ')`: every run of white space becomes one space.
pub fn collapse_ws(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut in_run = false;
    for c in s.chars() {
        if is_js_space(c) {
            if !in_run {
                out.push(' ');
            }
            in_run = true;
        } else {
            in_run = false;
            out.push(c);
        }
    }
    out
}

/// `s.slice(0, n)` where `n` counts UTF-16 units. `None` when the cut would split a surrogate pair: JavaScript would
/// keep a lone surrogate, which a Rust string cannot hold, so the caller defers to the Node guard.
pub fn slice_utf16(s: &str, n: usize) -> Option<String> {
    let mut units = 0usize;
    let mut out = String::new();
    for c in s.chars() {
        let w = c.len_utf16();
        if units + w > n {
            return if units == n { Some(out) } else { None };
        }
        units += w;
        out.push(c);
    }
    Some(out)
}

/// The string a JavaScript `String(x)` would give for a JSON scalar; `None` for arrays and objects (never needed).
pub fn js_string_of(v: &serde_json::Value) -> Option<String> {
    match v {
        serde_json::Value::String(s) => Some(s.clone()),
        serde_json::Value::Bool(b) => Some(b.to_string()),
        serde_json::Value::Null => Some("null".to_string()),
        serde_json::Value::Number(n) => n.as_f64().map(js_number_string),
        _ => None,
    }
}

/// `String(n)` for a finite number: integers print without a fraction, as JavaScript does up to 1e21.
fn js_number_string(n: f64) -> String {
    if n == n.trunc() && n.abs() < 1e21 {
        format!("{}", n as i128)
    } else {
        format!("{n}")
    }
}
