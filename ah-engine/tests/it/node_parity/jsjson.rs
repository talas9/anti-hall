//! An order-preserving JSON value that parses and prints the way JavaScript's `JSON.parse` / `JSON.stringify` do (member
//! order: array-index keys first and ascending, then insertion order; the last duplicate wins at the first one's position;
//! numbers through a double and `Number.prototype.toString`; a lone surrogate escape survives as `\udXXX`). The parity lanes
//! normalize files with it so that two outputs compare equal exactly when the JavaScript runners they replace compared them
//! equal, key order included. `serde_json` cannot do this without its `preserve_order` feature, which the engine does not use.
#![allow(dead_code)]

#[derive(Clone, Debug, PartialEq)]
pub(crate) enum J {
    Null,
    Bool(bool),
    Num(f64),
    Str(String),
    Arr(Vec<J>),
    Obj(Vec<(String, J)>),
}

/// A lone surrogate code unit is kept as a scalar in the last private-use block so a `String` can hold it.
const LONE_BASE: u32 = 0x10_F800;

struct P<'a> {
    s: &'a str,
    b: &'a [u8],
    i: usize,
    depth: usize,
}

impl P<'_> {
    fn ws(&mut self) {
        while self.i < self.b.len() && matches!(self.b[self.i], b' ' | b'\t' | b'\n' | b'\r') {
            self.i += 1;
        }
    }
    fn eat(&mut self, c: u8) -> Option<()> {
        (self.b.get(self.i) == Some(&c)).then(|| self.i += 1)
    }
    fn lit(&mut self, s: &str, v: J) -> Option<J> {
        if self.b[self.i..].starts_with(s.as_bytes()) {
            self.i += s.len();
            Some(v)
        } else {
            None
        }
    }
    fn value(&mut self) -> Option<J> {
        self.depth += 1;
        if self.depth > 4000 {
            return None;
        }
        self.ws();
        let v = match self.b.get(self.i)? {
            b'n' => self.lit("null", J::Null),
            b't' => self.lit("true", J::Bool(true)),
            b'f' => self.lit("false", J::Bool(false)),
            b'"' => self.string().map(J::Str),
            b'[' => {
                self.i += 1;
                let mut a = Vec::new();
                self.ws();
                if self.eat(b']').is_some() {
                    Some(J::Arr(a))
                } else {
                    loop {
                        a.push(self.value()?);
                        self.ws();
                        if self.eat(b',').is_some() {
                            continue;
                        }
                        self.eat(b']')?;
                        break Some(J::Arr(a));
                    }
                }
            }
            b'{' => {
                self.i += 1;
                let mut o: Vec<(String, J)> = Vec::new();
                self.ws();
                if self.eat(b'}').is_some() {
                    Some(J::Obj(o))
                } else {
                    loop {
                        self.ws();
                        let k = self.string()?;
                        self.ws();
                        self.eat(b':')?;
                        let v = self.value()?;
                        match o.iter_mut().find(|(n, _)| *n == k) {
                            Some(e) => e.1 = v,
                            None => o.push((k, v)),
                        }
                        self.ws();
                        if self.eat(b',').is_some() {
                            continue;
                        }
                        self.eat(b'}')?;
                        break Some(J::Obj(o));
                    }
                }
            }
            b'-' | b'0'..=b'9' => self.number(),
            _ => None,
        };
        self.depth -= 1;
        v
    }
    fn number(&mut self) -> Option<J> {
        let s = self.i;
        self.eat(b'-');
        match self.b.get(self.i)? {
            b'0' => self.i += 1,
            b'1'..=b'9' => {
                while self.b.get(self.i).is_some_and(u8::is_ascii_digit) {
                    self.i += 1;
                }
            }
            _ => return None,
        }
        if self.eat(b'.').is_some() {
            let d = self.i;
            while self.b.get(self.i).is_some_and(u8::is_ascii_digit) {
                self.i += 1;
            }
            if self.i == d {
                return None;
            }
        }
        if matches!(self.b.get(self.i), Some(b'e' | b'E')) {
            self.i += 1;
            if matches!(self.b.get(self.i), Some(b'+' | b'-')) {
                self.i += 1;
            }
            let d = self.i;
            while self.b.get(self.i).is_some_and(u8::is_ascii_digit) {
                self.i += 1;
            }
            if self.i == d {
                return None;
            }
        }
        std::str::from_utf8(&self.b[s..self.i]).ok()?.parse::<f64>().ok().map(J::Num)
    }
    fn hex4(&mut self) -> Option<u32> {
        let h = std::str::from_utf8(self.b.get(self.i..self.i + 4)?).ok()?;
        if !h.bytes().all(|c| c.is_ascii_hexdigit()) {
            return None;
        }
        self.i += 4;
        u32::from_str_radix(h, 16).ok()
    }
    fn string(&mut self) -> Option<String> {
        self.eat(b'"')?;
        let mut out = String::new();
        loop {
            let c = *self.b.get(self.i)?;
            match c {
                b'"' => {
                    self.i += 1;
                    return Some(out);
                }
                b'\\' => {
                    self.i += 1;
                    let e = *self.b.get(self.i)?;
                    self.i += 1;
                    match e {
                        b'"' => out.push('"'),
                        b'\\' => out.push('\\'),
                        b'/' => out.push('/'),
                        b'b' => out.push('\u{8}'),
                        b'f' => out.push('\u{c}'),
                        b'n' => out.push('\n'),
                        b'r' => out.push('\r'),
                        b't' => out.push('\t'),
                        b'u' => {
                            let u = self.hex4()?;
                            if (0xD800..0xDC00).contains(&u) && self.b[self.i..].starts_with(b"\\u") {
                                let save = self.i;
                                self.i += 2;
                                match self.hex4() {
                                    Some(lo) if (0xDC00..0xE000).contains(&lo) => {
                                        out.push(char::from_u32(0x10000 + ((u - 0xD800) << 10) + (lo - 0xDC00))?);
                                        continue;
                                    }
                                    _ => self.i = save,
                                }
                            }
                            if (0xD800..0xE000).contains(&u) {
                                out.push(char::from_u32(LONE_BASE + (u - 0xD800))?);
                            } else {
                                out.push(char::from_u32(u)?);
                            }
                        }
                        _ => return None,
                    }
                }
                0..=0x1f => return None,
                _ => {
                    let ch = self.s[self.i..].chars().next()?;
                    out.push(ch);
                    self.i += ch.len_utf8();
                }
            }
        }
    }
}

/// `JSON.parse(text)`, or `None` where JavaScript would throw.
pub(crate) fn parse(text: &str) -> Option<J> {
    let mut p = P { s: text, b: text.as_bytes(), i: 0, depth: 0 };
    let v = p.value()?;
    p.ws();
    (p.i == p.b.len()).then_some(v)
}

/// `Number.prototype.toString` for a finite double.
pub(crate) fn js_number(n: f64) -> String {
    if n == 0.0 {
        return "0".into();
    }
    if !n.is_finite() {
        return "null".into();
    }
    let neg = n < 0.0;
    let a = n.abs();
    // shortest digits and the decimal exponent, from Rust's `{:e}` (shortest round-trip)
    let e = format!("{a:e}");
    let (mant, exp) = e.split_once('e').expect("exponent form");
    let digits: String = mant.chars().filter(|c| *c != '.').collect();
    let exp: i32 = exp.parse().expect("exponent");
    let k = digits.len() as i32;
    let n10 = exp + 1; // the position of the decimal point relative to the digits
    let body = if k <= n10 && n10 <= 21 {
        format!("{digits}{}", "0".repeat((n10 - k) as usize))
    } else if 0 < n10 && n10 <= 21 {
        format!("{}.{}", &digits[..n10 as usize], &digits[n10 as usize..])
    } else if -6 < n10 && n10 <= 0 {
        format!("0.{}{digits}", "0".repeat((-n10) as usize))
    } else {
        let e = n10 - 1;
        let sign = if e < 0 { '-' } else { '+' };
        if k == 1 { format!("{digits}e{sign}{}", e.abs()) } else { format!("{}.{}e{sign}{}", &digits[..1], &digits[1..], e.abs()) }
    };
    if neg { format!("-{body}") } else { body }
}

fn quote(s: &str, out: &mut String) {
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
            c if (LONE_BASE..LONE_BASE + 0x800).contains(&(c as u32)) => out.push_str(&format!("\\u{:04x}", 0xD800 + (c as u32 - LONE_BASE))),
            c => out.push(c),
        }
    }
    out.push('"');
}

fn is_index(k: &str) -> Option<u32> {
    let n: u32 = k.parse().ok()?;
    (n != u32::MAX && n.to_string() == k).then_some(n)
}

/// `JSON.stringify(v)`.
pub(crate) fn stringify(v: &J) -> String {
    let mut out = String::new();
    write(v, &mut out);
    out
}

fn write(v: &J, out: &mut String) {
    match v {
        J::Null => out.push_str("null"),
        J::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
        J::Num(n) => out.push_str(&js_number(*n)),
        J::Str(s) => quote(s, out),
        J::Arr(a) => {
            out.push('[');
            for (i, x) in a.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                write(x, out);
            }
            out.push(']');
        }
        J::Obj(o) => {
            let mut idx: Vec<(u32, &(String, J))> = o.iter().filter_map(|e| is_index(&e.0).map(|n| (n, e))).collect();
            idx.sort_by_key(|(n, _)| *n);
            let rest = o.iter().filter(|e| is_index(&e.0).is_none());
            out.push('{');
            for (i, e) in idx.into_iter().map(|(_, e)| e).chain(rest).enumerate() {
                if i > 0 {
                    out.push(',');
                }
                quote(&e.0, out);
                out.push(':');
                write(&e.1, out);
            }
            out.push('}');
        }
    }
}

// ---- builders: object literals in source order, as the JavaScript runners wrote them --------------------------------------

impl J {
    pub(crate) fn text(&self) -> String {
        stringify(self)
    }
    /// `obj[k] = v` (an existing key keeps its place).
    pub(crate) fn set(&mut self, k: &str, v: J) {
        if let J::Obj(o) = self {
            match o.iter_mut().find(|(n, _)| n == k) {
                Some(e) => e.1 = v,
                None => o.push((k.to_string(), v)),
            }
        }
    }
    /// `delete obj[k]`
    pub(crate) fn remove(&mut self, k: &str) {
        if let J::Obj(o) = self {
            o.retain(|(n, _)| n != k);
        }
    }
    pub(crate) fn get(&self, k: &str) -> Option<&J> {
        match self {
            J::Obj(o) => o.iter().find(|(n, _)| n == k).map(|(_, v)| v),
            _ => None,
        }
    }
}

pub(crate) fn o(pairs: Vec<(&str, J)>) -> J {
    J::Obj(pairs.into_iter().map(|(k, v)| (k.to_string(), v)).collect())
}
pub(crate) fn s(x: &str) -> J {
    J::Str(x.to_string())
}
pub(crate) fn n(x: f64) -> J {
    J::Num(x)
}
pub(crate) fn a(v: Vec<J>) -> J {
    J::Arr(v)
}

impl From<&str> for J {
    fn from(x: &str) -> J {
        J::Str(x.to_string())
    }
}
impl From<String> for J {
    fn from(x: String) -> J {
        J::Str(x)
    }
}
impl From<&String> for J {
    fn from(x: &String) -> J {
        J::Str(x.clone())
    }
}
impl From<f64> for J {
    fn from(x: f64) -> J {
        J::Num(x)
    }
}
impl From<i32> for J {
    fn from(x: i32) -> J {
        J::Num(f64::from(x))
    }
}
impl From<i64> for J {
    fn from(x: i64) -> J {
        J::Num(x as f64)
    }
}
impl From<usize> for J {
    fn from(x: usize) -> J {
        J::Num(x as f64)
    }
}
impl From<bool> for J {
    fn from(x: bool) -> J {
        J::Bool(x)
    }
}
impl From<Vec<J>> for J {
    fn from(x: Vec<J>) -> J {
        J::Arr(x)
    }
}

/// An object literal in source order: `jo! { "a": 1, "b": "x" }` (each value goes through `J::from`).
macro_rules! jo {
    ($($k:literal : $v:expr),* $(,)?) => { $crate::node_parity::jsjson::J::Obj(vec![$(($k.to_string(), $crate::node_parity::jsjson::J::from($v))),*]) };
}
/// An array literal: `ja![1, "x", jo! {}]`.
macro_rules! ja {
    ($($v:expr),* $(,)?) => { $crate::node_parity::jsjson::J::Arr(vec![$($crate::node_parity::jsjson::J::from($v)),*]) };
}

/// Map every string (and key) of a value.
pub(crate) fn map_strings(j: J, f: &dyn Fn(&str) -> String) -> J {
    match j {
        J::Str(s) => J::Str(f(&s)),
        J::Arr(a) => J::Arr(a.into_iter().map(|x| map_strings(x, f)).collect()),
        J::Obj(o) => J::Obj(o.into_iter().map(|(k, v)| (f(&k), map_strings(v, f))).collect()),
        other => other,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn numbers_print_like_javascript() {
        assert_eq!(js_number(1e21), "1e+21");
        assert_eq!(js_number(1.5e-7), "1.5e-7");
        assert_eq!(js_number(12345678901234567890.0), "12345678901234567000");
        assert_eq!(js_number(-0.0), "0");
        assert_eq!(js_number(0.1), "0.1");
        assert_eq!(js_number(1000.0), "1000");
        assert_eq!(js_number(123.456), "123.456");
        assert_eq!(js_number(0.000001), "0.000001");
        assert_eq!(js_number(1e-7), "1e-7");
    }

    #[test]
    fn integer_keys_move_first_and_duplicates_keep_their_first_position() {
        let v = parse("{\"b\":1,\"10\":2,\"2\":3,\"a\":4,\"b\":5,\"01\":6}").expect("valid");
        assert_eq!(stringify(&v), "{\"2\":3,\"10\":2,\"b\":5,\"a\":4,\"01\":6}");
    }

    #[test]
    fn a_lone_surrogate_survives_and_a_pair_joins() {
        let v = parse("{\"a\":\"\\ud83d\",\"b\":\"\\ud83d\\ude00\"}").expect("valid");
        assert_eq!(stringify(&v), "{\"a\":\"\\ud83d\",\"b\":\"\u{1f600}\"}");
    }

    #[test]
    fn what_javascript_rejects_is_rejected() {
        assert!(parse("{\"a\":1,}").is_none());
        assert!(parse("\u{feff}{}").is_none());
        assert!(parse("{").is_none());
        assert!(parse("1e").is_none());
        assert!(parse("[1,2]x").is_none());
    }
}
