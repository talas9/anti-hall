//! An insertion-ordered JSON value for the state files these hooks merge into, with `JSON.parse` and
//! `JSON.stringify` semantics (key order, number formatting, duplicate keys).
//!
//! `serde_json::Value` keeps keys sorted, so a read-merge-write through it would reorder a file the Node hook keeps in
//! insertion order. This one does not.
use super::num::to_js_string;

/// One JSON value; an object keeps its keys in the order `JSON.parse` would create them.
#[derive(Debug, Clone, PartialEq)]
pub enum J {
    /// `null`.
    Null,
    /// `true` or `false`.
    Bool(bool),
    /// A number, as the double JavaScript holds.
    Num(f64),
    /// A string.
    Str(String),
    /// An array.
    Arr(Vec<J>),
    /// An object: keys in insertion order, a repeated key keeping the position of its first appearance.
    Obj(Vec<(String, J)>),
}

/// Why a text did not become a value.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Fail {
    /// Not JSON: `JSON.parse` throws too.
    Invalid,
    /// JSON that JavaScript reads but this parser does not reproduce (a lone surrogate escape, nesting past the limit):
    /// the caller defers to Node.
    Unsupported,
}

struct P<'a> {
    s: &'a [u8],
    i: usize,
    max_depth: usize,
}

impl P<'_> {
    fn ws(&mut self) {
        while self.i < self.s.len() && matches!(self.s[self.i], b' ' | b'\t' | b'\n' | b'\r') {
            self.i += 1;
        }
    }

    fn value(&mut self, depth: usize) -> Result<J, Fail> {
        if depth > self.max_depth {
            return Err(Fail::Unsupported);
        }
        self.ws();
        let Some(&c) = self.s.get(self.i) else { return Err(Fail::Invalid) };
        match c {
            b'{' => {
                self.i += 1;
                let mut out: Vec<(String, J)> = Vec::new();
                self.ws();
                if self.s.get(self.i) == Some(&b'}') {
                    self.i += 1;
                    return Ok(J::Obj(out));
                }
                loop {
                    self.ws();
                    if self.s.get(self.i) != Some(&b'"') {
                        return Err(Fail::Invalid);
                    }
                    let k = self.string()?;
                    self.ws();
                    if self.s.get(self.i) != Some(&b':') {
                        return Err(Fail::Invalid);
                    }
                    self.i += 1;
                    let v = self.value(depth + 1)?;
                    match out.iter_mut().find(|(ek, _)| *ek == k) {
                        Some(slot) => slot.1 = v,
                        None => out.push((k, v)),
                    }
                    self.ws();
                    match self.s.get(self.i) {
                        Some(b',') => self.i += 1,
                        Some(b'}') => {
                            self.i += 1;
                            return Ok(J::Obj(out));
                        }
                        _ => return Err(Fail::Invalid),
                    }
                }
            }
            b'[' => {
                self.i += 1;
                let mut out = Vec::new();
                self.ws();
                if self.s.get(self.i) == Some(&b']') {
                    self.i += 1;
                    return Ok(J::Arr(out));
                }
                loop {
                    out.push(self.value(depth + 1)?);
                    self.ws();
                    match self.s.get(self.i) {
                        Some(b',') => self.i += 1,
                        Some(b']') => {
                            self.i += 1;
                            return Ok(J::Arr(out));
                        }
                        _ => return Err(Fail::Invalid),
                    }
                }
            }
            b'"' => Ok(J::Str(self.string()?)),
            b't' => self.word(b"true", J::Bool(true)),
            b'f' => self.word(b"false", J::Bool(false)),
            b'n' => self.word(b"null", J::Null),
            b'-' | b'0'..=b'9' => self.number(),
            _ => Err(Fail::Invalid),
        }
    }

    fn word(&mut self, w: &[u8], v: J) -> Result<J, Fail> {
        if self.s[self.i..].starts_with(w) {
            self.i += w.len();
            Ok(v)
        } else {
            Err(Fail::Invalid)
        }
    }

    fn number(&mut self) -> Result<J, Fail> {
        let st = self.i;
        if self.s[self.i] == b'-' {
            self.i += 1;
        }
        let digits = |p: &mut P| {
            let a = p.i;
            while p.i < p.s.len() && p.s[p.i].is_ascii_digit() {
                p.i += 1;
            }
            p.i - a
        };
        match self.s.get(self.i) {
            Some(b'0') => self.i += 1,
            Some(b'1'..=b'9') => {
                digits(self);
            }
            _ => return Err(Fail::Invalid),
        }
        if self.s.get(self.i) == Some(&b'.') {
            self.i += 1;
            if digits(self) == 0 {
                return Err(Fail::Invalid);
            }
        }
        if matches!(self.s.get(self.i), Some(b'e' | b'E')) {
            self.i += 1;
            if matches!(self.s.get(self.i), Some(b'+' | b'-')) {
                self.i += 1;
            }
            if digits(self) == 0 {
                return Err(Fail::Invalid);
            }
        }
        let t = std::str::from_utf8(&self.s[st..self.i]).map_err(|_| Fail::Invalid)?;
        t.parse::<f64>().map(J::Num).map_err(|_| Fail::Invalid)
    }

    fn hex4(&mut self) -> Result<u32, Fail> {
        let h = self.s.get(self.i..self.i + 4).ok_or(Fail::Invalid)?;
        let t = std::str::from_utf8(h).map_err(|_| Fail::Invalid)?;
        if !t.bytes().all(|b| b.is_ascii_hexdigit()) {
            return Err(Fail::Invalid);
        }
        self.i += 4;
        u32::from_str_radix(t, 16).map_err(|_| Fail::Invalid)
    }

    fn string(&mut self) -> Result<String, Fail> {
        self.i += 1;
        let mut out: Vec<u8> = Vec::new();
        loop {
            let Some(&c) = self.s.get(self.i) else { return Err(Fail::Invalid) };
            self.i += 1;
            match c {
                b'"' => return String::from_utf8(out).map_err(|_| Fail::Invalid),
                b'\\' => {
                    let Some(&e) = self.s.get(self.i) else { return Err(Fail::Invalid) };
                    self.i += 1;
                    match e {
                        b'"' => out.push(b'"'),
                        b'\\' => out.push(b'\\'),
                        b'/' => out.push(b'/'),
                        b'b' => out.push(8),
                        b'f' => out.push(12),
                        b'n' => out.push(b'\n'),
                        b'r' => out.push(b'\r'),
                        b't' => out.push(b'\t'),
                        b'u' => {
                            let u = self.hex4()?;
                            let ch = if (0xD800..0xDC00).contains(&u) {
                                if self.s.get(self.i) == Some(&b'\\') && self.s.get(self.i + 1) == Some(&b'u') {
                                    self.i += 2;
                                    let lo = self.hex4()?;
                                    if !(0xDC00..0xE000).contains(&lo) {
                                        return Err(Fail::Unsupported);
                                    }
                                    char::from_u32(0x10000 + ((u - 0xD800) << 10) + (lo - 0xDC00))
                                } else {
                                    return Err(Fail::Unsupported);
                                }
                            } else if (0xDC00..0xE000).contains(&u) {
                                return Err(Fail::Unsupported);
                            } else {
                                char::from_u32(u)
                            };
                            let ch = ch.ok_or(Fail::Unsupported)?;
                            let mut b = [0u8; 4];
                            out.extend_from_slice(ch.encode_utf8(&mut b).as_bytes());
                        }
                        _ => return Err(Fail::Invalid),
                    }
                }
                0..=0x1f => return Err(Fail::Invalid),
                _ => out.push(c),
            }
        }
    }
}

/// A property name JavaScript treats as an array index: its canonical decimal form below 2^32 - 1.
fn is_index_key(k: &str) -> Option<u64> {
    let ok = k == "0" || (k.starts_with(|c: char| ('1'..='9').contains(&c)) && k.bytes().all(|b| b.is_ascii_digit()));
    ok.then(|| k.parse::<u64>().ok()).flatten().filter(|n| *n < u32::MAX as u64)
}

/// An object whose integer-like keys come first in ascending order, then the rest in insertion order: the order
/// JavaScript enumerates the properties of the object `JSON.parse` builds.
fn js_order(o: Vec<(String, J)>) -> Vec<(String, J)> {
    if !o.iter().any(|(k, _)| is_index_key(k).is_some()) {
        return o;
    }
    let (mut idx, rest): (Vec<_>, Vec<_>) = o.into_iter().partition(|(k, _)| is_index_key(k).is_some());
    idx.sort_by_key(|(k, _)| is_index_key(k));
    idx.into_iter().chain(rest).collect()
}

fn order_all(v: J) -> J {
    match v {
        J::Obj(o) => J::Obj(js_order(o.into_iter().map(|(k, x)| (k, order_all(x))).collect())),
        J::Arr(a) => J::Arr(a.into_iter().map(order_all).collect()),
        other => other,
    }
}

/// `JSON.parse(text)`. The nesting limit is a parameter because it is a tunable of the caller.
pub fn parse(text: &str, max_depth: usize) -> Result<J, Fail> {
    let mut p = P { s: text.as_bytes(), i: 0, max_depth };
    let v = p.value(0)?;
    p.ws();
    if p.i != p.s.len() {
        return Err(Fail::Invalid);
    }
    Ok(order_all(v))
}

/// A string as `JSON.stringify` writes it.
pub fn quote(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
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
    out
}

/// `JSON.stringify(value)` with no spacing.
pub fn stringify(v: &J) -> String {
    match v {
        J::Null => "null".into(),
        J::Bool(b) => b.to_string(),
        J::Num(n) => {
            if n.is_finite() {
                to_js_string(*n)
            } else {
                "null".into()
            }
        }
        J::Str(s) => quote(s),
        J::Arr(a) => format!("[{}]", a.iter().map(stringify).collect::<Vec<_>>().join(",")),
        J::Obj(o) => format!("{{{}}}", o.iter().map(|(k, v)| format!("{}:{}", quote(k), stringify(v))).collect::<Vec<_>>().join(",")),
    }
}

impl J {
    /// The member `key` of an object.
    pub fn get(&self, key: &str) -> Option<&J> {
        match self {
            J::Obj(o) => o.iter().find(|(k, _)| k == key).map(|(_, v)| v),
            _ => None,
        }
    }

    /// Set a member the way `Object.assign` does: replace in place when present, else append.
    pub fn set(&mut self, key: &str, v: J) {
        if let J::Obj(o) = self {
            match o.iter_mut().find(|(k, _)| k == key) {
                Some(slot) => slot.1 = v,
                None => o.push((key.to_string(), v)),
            }
        }
    }
}
