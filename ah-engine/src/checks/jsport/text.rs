//! JavaScript string behavior beyond what `guardkit::text` already has.
use super::num::to_js_string;
use serde_json::Value;

/// The length of `s` in UTF-16 units (`s.length`).
pub fn len16(s: &str) -> usize {
    s.chars().map(char::len_utf16).sum()
}

/// `s.slice(0, n)` written to a UTF-8 file or pipe: a cut through a surrogate pair leaves a lone surrogate in
/// JavaScript, which UTF-8 encoding turns into U+FFFD, so the same happens here.
pub fn slice16_lossy(s: &str, n: usize) -> String {
    let mut units = 0usize;
    let mut out = String::new();
    for c in s.chars() {
        let w = c.len_utf16();
        if units + w > n {
            if units < n {
                out.push('\u{FFFD}');
            }
            return out;
        }
        units += w;
        out.push(c);
    }
    out
}

/// Order two strings the way `Array.prototype.sort()` does by default: by UTF-16 code unit.
pub fn cmp16(a: &str, b: &str) -> std::cmp::Ordering {
    a.encode_utf16().cmp(b.encode_utf16())
}

/// `String(x)` for a parsed JSON value (objects print as `[object Object]`, arrays join their elements with commas,
/// `null` inside an array is empty).
pub fn js_string(v: &Value) -> String {
    match v {
        Value::Null => "null".into(),
        Value::Bool(b) => b.to_string(),
        Value::Number(n) => to_js_string(n.as_f64().unwrap_or(f64::NAN)),
        Value::String(s) => s.clone(),
        Value::Array(a) => a.iter().map(|e| if e.is_null() { String::new() } else { js_string(e) }).collect::<Vec<_>>().join(","),
        Value::Object(_) => "[object Object]".into(),
    }
}

/// JavaScript truthiness of a JSON value.
pub fn truthy(v: Option<&Value>) -> bool {
    match v {
        None | Some(Value::Null) => false,
        Some(Value::Bool(b)) => *b,
        Some(Value::Number(n)) => n.as_f64().is_some_and(|f| f != 0.0 && !f.is_nan()),
        Some(Value::String(s)) => !s.is_empty(),
        Some(_) => true,
    }
}

/// `obj[key]` for a value that may not be an object: `None` unless it is an object holding the key.
pub fn member<'a>(v: &'a Value, key: &str) -> Option<&'a Value> {
    v.as_object().and_then(|o| o.get(key))
}

/// A string member, `None` for any other type.
pub fn str_member<'a>(v: &'a Value, key: &str) -> Option<&'a str> {
    member(v, key).and_then(Value::as_str)
}

/// `payload.key` where JavaScript would use `a || b || c` over string-or-other values: the first truthy member.
pub fn first_truthy<'a>(v: &'a Value, keys: &[&str]) -> Option<&'a Value> {
    keys.iter().find_map(|k| member(v, k).filter(|x| truthy(Some(x))))
}

/// The session id as the Node hooks turn it into a file-name part (`tasklist-guard.js` `sanitizeSessionId`): every
/// character outside letters, digits, underscore and hyphen is removed, and an empty result is the unknown-session word.
pub fn sanitize_session(raw: &str, unknown: &str) -> String {
    let safe: String = raw.chars().filter(|c| c.is_ascii_alphanumeric() || *c == '_' || *c == '-').collect();
    if safe.is_empty() { unknown.to_string() } else { safe }
}

/// Lowercase hexadecimal SHA-1 of `data` (`crypto.createHash('sha1')`); the hooks use it for non-secret identifiers only.
///
/// The single copy in the engine; every other module re-exports or calls this one.
pub fn sha1_hex(data: impl AsRef<[u8]>) -> String {
    let d = ring::digest::digest(&ring::digest::SHA1_FOR_LEGACY_USE_ONLY, data.as_ref());
    d.as_ref().iter().map(|b| format!("{b:02x}")).collect()
}

/// `s.replace(/[^A-Za-z0-9_.-]/g, '_')`: every UTF-16 unit outside the set becomes one underscore (an astral character is
/// two units, so two underscores).
pub fn safe_name(s: &str) -> String {
    let mut out = String::new();
    for c in s.chars() {
        if c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | '-') {
            out.push(c);
        } else {
            for _ in 0..c.len_utf16() {
                out.push('_');
            }
        }
    }
    out
}

/// `s.replace(/[^A-Za-z0-9]/g, '-')`, by UTF-16 unit.
pub fn dash_name(s: &str) -> String {
    let mut out = String::new();
    for c in s.chars() {
        if c.is_ascii_alphanumeric() {
            out.push(c);
        } else {
            for _ in 0..c.len_utf16() {
                out.push('-');
            }
        }
    }
    out
}

/// A transcript line Node would parse but the engine's parser cannot; the caller defers.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Unparsed;

/// `JSON.parse(line)` for a transcript line, on the engine's parser: `Ok(None)` when Node would also reject the line;
/// `Err(Unparsed)` when Node would accept something the engine's parser rejects (a lone surrogate escape, nesting past its
/// limit, a number out of range), so the caller defers.
pub fn parse_line(line: &str) -> Result<Option<Value>, Unparsed> {
    match serde_json::from_str::<Value>(line) {
        Ok(v) => Ok(Some(v)),
        Err(e) => {
            let msg = e.to_string();
            let lone = line.as_bytes().windows(3).any(|w| w[0] == b'\\' && w[1] == b'u' && matches!(w[2], b'd' | b'D'));
            if msg.starts_with(crate::defaults::text("codex_handover.serde_recursion_msg"))
                || msg.starts_with(crate::defaults::text("codex_handover.serde_range_msg"))
                || lone
            {
                Err(Unparsed)
            } else {
                Ok(None)
            }
        }
    }
}

/// The first member among `keys` that is a non-empty string (`(typeof a === 'string' && a) || (typeof b === 'string' && b) || ''`).
pub fn first_str<'a>(v: &'a Value, keys: &[&str]) -> &'a str {
    keys.iter().find_map(|k| str_member(v, k).filter(|s| !s.is_empty())).unwrap_or("")
}

/// `String(raw || '')`: the string form of a value, empty for a falsy one.
pub fn string_or_empty(v: Option<&Value>) -> String {
    match v {
        Some(x) if truthy(Some(x)) => js_string(x),
        _ => String::new(),
    }
}
