//! JavaScript value semantics the prompt-emission checks must reproduce byte for byte: an insertion-ordered JSON value
//! (`JSON.parse` then `JSON.stringify` of a state file), `Number.prototype.toString`, `Number(string)`, `Date.parse` of an
//! ISO timestamp, and a parse of transcript lines that survives the lone-surrogate escapes JavaScript accepts.
//!
//! Why not `serde_json::Value`: its object is key-sorted, while the Node hooks write state files in insertion order
//! (integer-like keys first). A Rust port that re-sorted another hook's entries would change a file Node still reads.
//! Anything this module cannot decide the way V8 does is reported as unsupported, and the caller defers to Node.
use serde::de::{Deserialize, Deserializer, MapAccess, SeqAccess, Visitor};
use serde_json::Value;
use std::fmt;

/// A JSON value with insertion-ordered objects.
#[derive(Debug, Clone, PartialEq)]
pub enum Js {
    /// `null`.
    Null,
    /// A boolean.
    Bool(bool),
    /// A number (JavaScript has only doubles).
    Num(f64),
    /// A string.
    Str(String),
    /// An array.
    Arr(Vec<Js>),
    /// An object, keys in insertion order, unique.
    Obj(Vec<(String, Js)>),
}

struct JsVisitor;

impl<'de> Visitor<'de> for JsVisitor {
    type Value = Js;

    fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("a JSON value")
    }
    fn visit_unit<E>(self) -> Result<Js, E> {
        Ok(Js::Null)
    }
    fn visit_bool<E>(self, v: bool) -> Result<Js, E> {
        Ok(Js::Bool(v))
    }
    fn visit_u64<E>(self, v: u64) -> Result<Js, E> {
        Ok(Js::Num(v as f64))
    }
    fn visit_i64<E>(self, v: i64) -> Result<Js, E> {
        Ok(Js::Num(v as f64))
    }
    fn visit_f64<E>(self, v: f64) -> Result<Js, E> {
        Ok(Js::Num(v))
    }
    fn visit_str<E>(self, v: &str) -> Result<Js, E> {
        Ok(Js::Str(v.to_string()))
    }
    fn visit_string<E>(self, v: String) -> Result<Js, E> {
        Ok(Js::Str(v))
    }
    fn visit_seq<A: SeqAccess<'de>>(self, mut a: A) -> Result<Js, A::Error> {
        let mut v = Vec::new();
        while let Some(x) = a.next_element::<Js>()? {
            v.push(x);
        }
        Ok(Js::Arr(v))
    }
    fn visit_map<A: MapAccess<'de>>(self, mut a: A) -> Result<Js, A::Error> {
        let mut v: Vec<(String, Js)> = Vec::new();
        while let Some((k, x)) = a.next_entry::<String, Js>()? {
            // `JSON.parse` of a duplicate key keeps the first position and takes the last value.
            match v.iter_mut().find(|(n, _)| *n == k) {
                Some(slot) => slot.1 = x,
                None => v.push((k, x)),
            }
        }
        Ok(Js::Obj(v))
    }
}

impl<'de> Deserialize<'de> for Js {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Js, D::Error> {
        d.deserialize_any(JsVisitor)
    }
}

impl Js {
    /// Parse JSON text. `None` when serde rejects it; JavaScript might still accept the text (a lone surrogate escape, a
    /// number out of range, nesting past serde's limit), so a caller that cannot tell must defer rather than call it invalid.
    pub fn parse(text: &str) -> Option<Js> {
        serde_json::from_str::<Js>(text).ok()
    }

    /// The property `key` of an object.
    pub fn get(&self, key: &str) -> Option<&Js> {
        match self {
            Js::Obj(v) => v.iter().find(|(k, _)| k == key).map(|(_, x)| x),
            _ => None,
        }
    }

    /// Set a property: replace in place, or append.
    pub fn set(&mut self, key: &str, val: Js) {
        if let Js::Obj(v) = self {
            match v.iter_mut().find(|(k, _)| k == key) {
                Some(slot) => slot.1 = val,
                None => v.push((key.to_string(), val)),
            }
        }
    }

    /// The string, if this is one.
    pub fn as_str(&self) -> Option<&str> {
        match self {
            Js::Str(s) => Some(s),
            _ => None,
        }
    }

    /// The number, if this is one.
    pub fn as_f64(&self) -> Option<f64> {
        match self {
            Js::Num(n) => Some(*n),
            _ => None,
        }
    }

    /// `JSON.stringify(value)` for the values state files hold.
    pub fn stringify(&self) -> String {
        let mut out = String::new();
        self.write(&mut out);
        out
    }

    fn write(&self, out: &mut String) {
        match self {
            Js::Null => out.push_str("null"),
            Js::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
            Js::Num(n) if n.is_finite() => out.push_str(&number_to_string(*n)),
            Js::Num(_) => out.push_str("null"),
            Js::Str(s) => quote(s, out),
            Js::Arr(v) => {
                out.push('[');
                for (i, x) in v.iter().enumerate() {
                    if i > 0 {
                        out.push(',');
                    }
                    x.write(out);
                }
                out.push(']');
            }
            Js::Obj(v) => {
                out.push('{');
                let mut first = true;
                for (k, x) in ordered(v) {
                    if !first {
                        out.push(',');
                    }
                    first = false;
                    quote(k, out);
                    out.push(':');
                    x.write(out);
                }
                out.push('}');
            }
        }
    }
}

/// The own-property order of a JavaScript object: array-index keys ascending, then the rest in insertion order.
fn ordered(v: &[(String, Js)]) -> Vec<(&String, &Js)> {
    let mut idx: Vec<(u32, &String, &Js)> = Vec::new();
    let mut rest: Vec<(&String, &Js)> = Vec::new();
    for (k, x) in v {
        match array_index(k) {
            Some(i) => idx.push((i, k, x)),
            None => rest.push((k, x)),
        }
    }
    idx.sort_by_key(|(i, _, _)| *i);
    idx.into_iter().map(|(_, k, x)| (k, x)).chain(rest).collect()
}

/// A canonical array index: decimal digits, no leading zero, at most 2^32 - 2.
fn array_index(k: &str) -> Option<u32> {
    let b = k.as_bytes();
    if b.is_empty() || b.len() > 10 || !b.iter().all(u8::is_ascii_digit) || (b.len() > 1 && b[0] == b'0') {
        return None;
    }
    k.parse::<u64>().ok().filter(|n| *n <= 4_294_967_294).map(|n| n as u32)
}

/// `JSON.stringify` of a string (well-formed: no lone surrogates exist in a Rust string).
pub fn quote(s: &str, out: &mut String) {
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\u{8}' => out.push_str("\\b"),
            '\u{c}' => out.push_str("\\f"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
}

/// `String(n)` for a double (ECMAScript `Number::toString`, radix 10).
pub fn number_to_string(x: f64) -> String {
    if x.is_nan() {
        return "NaN".into();
    }
    if x == 0.0 {
        return "0".into();
    }
    if x.is_infinite() {
        return if x < 0.0 { "-Infinity".into() } else { "Infinity".into() };
    }
    let sign = if x < 0.0 { "-" } else { "" };
    let sci = format!("{:e}", x.abs());
    let (mant, exp) = sci.split_once('e').unwrap_or((&sci, "0"));
    let digits: String = mant.chars().filter(|c| *c != '.').collect();
    let n = exp.parse::<i32>().unwrap_or(0) + 1;
    let k = digits.len() as i32;
    let body = if k <= n && n <= 21 {
        format!("{digits}{}", "0".repeat((n - k) as usize))
    } else if 0 < n && n <= 21 {
        format!("{}.{}", &digits[..n as usize], &digits[n as usize..])
    } else if -6 < n && n <= 0 {
        format!("0.{}{digits}", "0".repeat((-n) as usize))
    } else {
        let e = n - 1;
        let es = if e < 0 { format!("-{}", -e) } else { format!("+{e}") };
        if k == 1 { format!("{digits}e{es}") } else { format!("{}.{}e{es}", &digits[..1], &digits[1..]) }
    };
    format!("{sign}{body}")
}

/// `Number(s)` after the string has been trimmed: NaN when the text is not a numeric literal. Covers decimal literals,
/// `Infinity`, and the `0x` / `0o` / `0b` forms.
pub fn to_number(s: &str) -> f64 {
    if s.is_empty() {
        return 0.0;
    }
    let b = s.as_bytes();
    if b.len() > 2 && b[0] == b'0' {
        let radix = match b[1] {
            b'x' | b'X' => 16,
            b'o' | b'O' => 8,
            b'b' | b'B' => 2,
            _ => 0,
        };
        if radix != 0 {
            let mut v = 0.0f64;
            for &c in &b[2..] {
                match (c as char).to_digit(radix) {
                    Some(d) => v = v * radix as f64 + d as f64,
                    None => return f64::NAN,
                }
            }
            return v;
        }
    }
    let (neg, rest) = match b[0] {
        b'+' => (false, &s[1..]),
        b'-' => (true, &s[1..]),
        _ => (false, s),
    };
    if rest == "Infinity" {
        return if neg { f64::NEG_INFINITY } else { f64::INFINITY };
    }
    // StrDecimalLiteral: digits [. digits] | . digits, then an optional exponent.
    let rb = rest.as_bytes();
    let mut i = 0;
    let int_start = i;
    while i < rb.len() && rb[i].is_ascii_digit() {
        i += 1;
    }
    let int_digits = i - int_start;
    let mut frac_digits = 0;
    if i < rb.len() && rb[i] == b'.' {
        i += 1;
        let fs = i;
        while i < rb.len() && rb[i].is_ascii_digit() {
            i += 1;
        }
        frac_digits = i - fs;
    }
    if int_digits + frac_digits == 0 {
        return f64::NAN;
    }
    if i < rb.len() && (rb[i] == b'e' || rb[i] == b'E') {
        i += 1;
        if i < rb.len() && (rb[i] == b'+' || rb[i] == b'-') {
            i += 1;
        }
        let es = i;
        while i < rb.len() && rb[i].is_ascii_digit() {
            i += 1;
        }
        if i == es {
            return f64::NAN;
        }
    }
    if i != rb.len() {
        return f64::NAN;
    }
    match rest.parse::<f64>() {
        Ok(v) => {
            if neg {
                -v
            } else {
                v
            }
        }
        Err(_) => f64::NAN,
    }
}

/// What `Date.parse` makes of a string.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum DateParse {
    /// Milliseconds since the epoch.
    Ms(f64),
    /// V8 answers NaN.
    Nan,
    /// Not the strict ISO form this module decides; V8's legacy parser (or the local time zone) may accept it, so the
    /// caller defers to Node.
    Unsupported,
}

/// `Date.parse(s)` for `YYYY-MM-DDTHH:mm:ss[.fff]` with `Z` or a `+hh:mm` offset, the only form the host writes.
pub fn date_parse(s: &str) -> DateParse {
    let b = s.as_bytes();
    let digits = |from: usize, n: usize| -> Option<i64> {
        let part = b.get(from..from + n)?;
        part.iter().all(u8::is_ascii_digit).then(|| part.iter().fold(0i64, |a, d| a * 10 + (d - b'0') as i64))
    };
    let shape = (|| {
        let y = digits(0, 4)?;
        (b.get(4) == Some(&b'-')).then_some(())?;
        let mo = digits(5, 2)?;
        (b.get(7) == Some(&b'-') && b.get(10) == Some(&b'T')).then_some(())?;
        let d = digits(8, 2)?;
        let h = digits(11, 2)?;
        (b.get(13) == Some(&b':') && b.get(16) == Some(&b':')).then_some(())?;
        let mi = digits(14, 2)?;
        let se = digits(17, 2)?;
        let mut at = 19;
        let mut ms = 0i64;
        if b.get(at) == Some(&b'.') {
            at += 1;
            let fs = at;
            while b.get(at).is_some_and(u8::is_ascii_digit) {
                at += 1;
            }
            if at == fs {
                return None;
            }
            let frac = &b[fs..at];
            for i in 0..3 {
                ms = ms * 10 + frac.get(i).map_or(0, |d| (d - b'0') as i64);
            }
        }
        let off = match b.get(at) {
            Some(b'Z') if at + 1 == b.len() => 0,
            Some(&sg) if (sg == b'+' || sg == b'-') && at + 6 == b.len() && b.get(at + 3) == Some(&b':') => {
                let oh = digits(at + 1, 2)?;
                let om = digits(at + 4, 2)?;
                if oh > 23 || om > 59 {
                    return Some(DateParse::Nan);
                }
                (oh * 60 + om) * if sg == b'-' { -1 } else { 1 }
            }
            _ => return None,
        };
        if !(1..=12).contains(&mo) || !(1..=31).contains(&d) || h > 24 || mi > 59 || se > 59 || (h == 24 && (mi != 0 || se != 0 || ms != 0)) {
            return Some(DateParse::Nan);
        }
        let days = days_from_civil(y, mo, 1) + (d - 1);
        let total = ((days * 24 + h) * 60 + mi - off) * 60 + se;
        Some(DateParse::Ms((total * 1000 + ms) as f64))
    })();
    shape.unwrap_or(DateParse::Unsupported)
}

/// Days from 1970-01-01 to a proleptic Gregorian date (Howard Hinnant's algorithm).
fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let doy = (153 * (if m > 2 { m - 3 } else { m + 9 }) + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

/// Replace every lone-surrogate `\uD800`-`\uDFFF` escape with `�`, leaving valid pairs alone. JavaScript's
/// `JSON.parse` accepts a lone surrogate and serde does not; every later use of such a string here (a hash, an equality)
/// treats it as U+FFFD already, so the substitution does not change a decision.
pub fn fix_lone_surrogates(text: &str) -> std::borrow::Cow<'_, str> {
    if !text.contains("\\u") {
        return std::borrow::Cow::Borrowed(text);
    }
    let b = text.as_bytes();
    let hex4 = |at: usize| -> Option<u32> {
        let h = text.get(at..at + 4)?;
        u32::from_str_radix(h, 16).ok().filter(|_| h.bytes().all(|c| c.is_ascii_hexdigit()))
    };
    let mut out = String::with_capacity(text.len());
    let (mut i, mut changed) = (0usize, false);
    let mut last = 0usize;
    while i < b.len() {
        if b[i] != b'\\' {
            i += 1;
            continue;
        }
        if b.get(i + 1) == Some(&b'u')
            && let Some(cp) = hex4(i + 2)
        {
            if (0xD800..0xDC00).contains(&cp) {
                let low = b.get(i + 6) == Some(&b'\\') && b.get(i + 7) == Some(&b'u') && hex4(i + 8).is_some_and(|l| (0xDC00..0xE000).contains(&l));
                if low {
                    i += 12;
                    continue;
                }
                out.push_str(&text[last..i]);
                out.push_str("\\uFFFD");
                changed = true;
                i += 6;
                last = i;
                continue;
            }
            if (0xDC00..0xE000).contains(&cp) {
                out.push_str(&text[last..i]);
                out.push_str("\\uFFFD");
                changed = true;
                i += 6;
                last = i;
                continue;
            }
            i += 6;
            continue;
        }
        i += 2; // any other escape: skip the escaped character so `\\u` is not read as `\u`
    }
    if !changed {
        return std::borrow::Cow::Borrowed(text);
    }
    out.push_str(&text[last..]);
    std::borrow::Cow::Owned(out)
}

/// Parse one transcript line the way `JSON.parse` would, or `None` when serde (even after the lone-surrogate repair)
/// rejects it. `None` is not proof the line is invalid: the caller decides whether that is safe to skip.
pub fn parse_line(line: &str) -> Option<serde_json::Value> {
    if let Ok(v) = serde_json::from_str::<serde_json::Value>(line) {
        return Some(v);
    }
    match fix_lone_surrogates(line) {
        std::borrow::Cow::Owned(fixed) => serde_json::from_str::<serde_json::Value>(&fixed).ok(),
        std::borrow::Cow::Borrowed(_) => None,
    }
}

/// `String(x)` for a JSON value (arrays join with a comma and print null as empty).
pub fn js_to_string(v: &Value) -> String {
    match v {
        Value::Null => "null".into(),
        Value::Bool(b) => b.to_string(),
        Value::Number(n) => number_to_string(n.as_f64().unwrap_or(f64::NAN)),
        Value::String(s) => s.clone(),
        Value::Array(a) => a.iter().map(|x| if x.is_null() { String::new() } else { js_to_string(x) }).collect::<Vec<_>>().join(","),
        Value::Object(_) => "[object Object]".into(),
    }
}

#[cfg(test)]
mod tests;
