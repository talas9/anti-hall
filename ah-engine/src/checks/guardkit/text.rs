//! JavaScript string semantics the guards depend on: what counts as white space, `trim`, `replace(/\s+/g, ' ')` and
//! `slice` (which counts UTF-16 units, not characters).
// Discard triage (E3): every `.ok()` / `unwrap_or_default()` in this file is a deliberate keep, for these reasons:
// - an absent field is the empty value
// A failure that must be seen goes through `crate::discard` instead.

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

/// `Buffer.toString('utf8')` of an owned buffer: the same text as `String::from_utf8_lossy(&b).into_owned()`, but a buffer that
/// is already valid UTF-8 (the usual case) is adopted, not copied. A 16 MB transcript read used to peak at twice its size.
pub fn lossy_owned(b: Vec<u8>) -> String {
    match String::from_utf8(b) {
        Ok(s) => s,
        Err(e) => String::from_utf8_lossy(e.as_bytes()).into_owned(),
    }
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
    if n == n.trunc() && n.abs() < 1e21 { format!("{}", n as i128) } else { format!("{n}") }
}

/// `Number(s)` for a JavaScript string: white space trimmed, empty is 0, `0x`/`0o`/`0b` prefixes, `Infinity`, decimal and
/// exponent forms; anything else is NaN.
pub fn js_number_of_str(s: &str) -> f64 {
    let t = js_trim(s);
    if t.is_empty() {
        return 0.0;
    }
    let prefix = t.get(..2).map(str::to_ascii_lowercase);
    let radix = match prefix.as_deref() {
        Some("0x") => 16,
        Some("0o") => 8,
        Some("0b") => 2,
        _ => 0,
    };
    if radix != 0 {
        let digits = &t[2..];
        return if digits.is_empty() || !digits.chars().all(|c| c.is_ascii_alphanumeric()) {
            f64::NAN
        } else {
            u64::from_str_radix(digits, radix).map_or(f64::NAN, |n| n as f64)
        };
    }
    match t {
        "Infinity" | "+Infinity" => return f64::INFINITY,
        "-Infinity" => return f64::NEG_INFINITY,
        _ => {}
    }
    // Rust also parses "inf", "nan" and "infinity"; JavaScript does not.
    if !t.chars().all(|c| c.is_ascii_digit() || matches!(c, '+' | '-' | '.' | 'e' | 'E')) {
        return f64::NAN;
    }
    t.parse::<f64>().unwrap_or(f64::NAN)
}

/// `Number(v)` for a JSON value (arrays go through their `String()` form, as JavaScript does).
pub fn js_number(v: &serde_json::Value) -> f64 {
    match v {
        serde_json::Value::Null => 0.0,
        serde_json::Value::Bool(b) => f64::from(u8::from(*b)),
        serde_json::Value::Number(n) => n.as_f64().unwrap_or(f64::NAN),
        serde_json::Value::String(s) => js_number_of_str(s),
        serde_json::Value::Array(_) => js_number_of_str(&js_string_coerce(v)),
        serde_json::Value::Object(_) => f64::NAN,
    }
}

/// `x | 0` (ToInt32) for a JSON value.
pub fn js_to_int32(v: &serde_json::Value) -> i64 {
    let n = js_number(v);
    if !n.is_finite() {
        return 0;
    }
    let m = n.trunc().rem_euclid(4_294_967_296.0) as i64;
    if m >= 2_147_483_648 { m - 4_294_967_296 } else { m }
}

/// `String(v)` for any JSON value (`null` in an array is an empty element, as in `Array.prototype.join`).
pub fn js_string_coerce(v: &serde_json::Value) -> String {
    match v {
        serde_json::Value::Array(a) => a.iter().map(|x| if x.is_null() { String::new() } else { js_string_coerce(x) }).collect::<Vec<_>>().join(","),
        serde_json::Value::Object(_) => "[object Object]".to_string(),
        other => js_string_of(other).unwrap_or_default(),
    }
}

/// JavaScript truthiness of an optional JSON value (`undefined`, `null`, `false`, `0`, `NaN`, `""` are falsy).
pub fn js_truthy(v: Option<&serde_json::Value>) -> bool {
    match v {
        None | Some(serde_json::Value::Null) => false,
        Some(serde_json::Value::Bool(b)) => *b,
        Some(serde_json::Value::Number(n)) => n.as_f64().is_some_and(|f| f != 0.0 && !f.is_nan()),
        Some(serde_json::Value::String(s)) => !s.is_empty(),
        Some(_) => true,
    }
}

/// `String.prototype.trimStart`.
pub fn js_trim_start(s: &str) -> &str {
    s.trim_start_matches(is_js_space)
}

/// `String.prototype.trimEnd`.
pub fn js_trim_end(s: &str) -> &str {
    s.trim_end_matches(is_js_space)
}
