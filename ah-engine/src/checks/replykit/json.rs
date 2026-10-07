//! JavaScript-compatible JSON for the files and payload parts the response guards read and write.
//!
//! `serde_json::Value` sorts object keys and prints numbers its own way, so it cannot reproduce what `JSON.parse` then
//! `JSON.stringify` do to a state file (the key order stays, numbers print the ECMAScript way). [`Oj`] keeps the order of
//! the keys; [`js_number`] and [`quote`] write numbers and strings the way `JSON.stringify` does.
//!
//! What the parser refuses on purpose ([`ParseError::Unsure`]): input `JSON.parse` would accept but a Rust string cannot
//! hold (a lone surrogate escape), keys JavaScript reorders (array indices) and nesting deeper than the stack limit. A
//! caller turns every `Unsure` into a deferral to Node, so it is never a silent difference.
use crate::defaults;
use serde_json::Value;

/// A JSON value whose objects keep the order of their keys.
#[derive(Debug, Clone, PartialEq)]
pub enum Oj {
    /// `null`.
    Null,
    /// `true` or `false`.
    Bool(bool),
    /// A number, as the double JavaScript would hold.
    Num(f64),
    /// A string.
    Str(String),
    /// An array.
    Arr(Vec<Oj>),
    /// An object: keys in the order `JSON.parse` would give them.
    Obj(Vec<(String, Oj)>),
}

/// Why a text did not parse.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ParseError {
    /// `JSON.parse` would throw too.
    Invalid,
    /// `JSON.parse` might accept it but this parser cannot represent the result exactly: the caller defers to Node.
    Unsure,
}

impl Oj {
    /// The value of `key` when this is an object.
    pub fn get(&self, key: &str) -> Option<&Oj> {
        match self {
            Oj::Obj(m) => m.iter().find(|(k, _)| k == key).map(|(_, v)| v),
            _ => None,
        }
    }

    /// The text when this is a string.
    pub fn as_str(&self) -> Option<&str> {
        match self {
            Oj::Str(s) => Some(s),
            _ => None,
        }
    }

    /// JavaScript truthiness.
    pub fn truthy(&self) -> bool {
        match self {
            Oj::Null => false,
            Oj::Bool(b) => *b,
            Oj::Num(n) => *n != 0.0 && !n.is_nan(),
            Oj::Str(s) => !s.is_empty(),
            Oj::Arr(_) | Oj::Obj(_) => true,
        }
    }

    /// True for an object or array (`typeof x === 'object'` and not null).
    pub fn is_object_like(&self) -> bool {
        matches!(self, Oj::Arr(_) | Oj::Obj(_))
    }

    /// `JSON.stringify(self)`.
    pub fn stringify(&self) -> String {
        let mut out = String::new();
        self.write(&mut out);
        out
    }

    fn write(&self, out: &mut String) {
        match self {
            Oj::Null => out.push_str("null"),
            Oj::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
            Oj::Num(n) => out.push_str(&if n.is_finite() { js_number(*n) } else { "null".to_string() }),
            Oj::Str(s) => out.push_str(&quote(s)),
            Oj::Arr(a) => {
                out.push('[');
                for (i, v) in a.iter().enumerate() {
                    if i > 0 {
                        out.push(',');
                    }
                    v.write(out);
                }
                out.push(']');
            }
            Oj::Obj(m) => {
                out.push('{');
                for (i, (k, v)) in m.iter().enumerate() {
                    if i > 0 {
                        out.push(',');
                    }
                    out.push_str(&quote(k));
                    out.push(':');
                    v.write(out);
                }
                out.push('}');
            }
        }
    }
}

/// `JSON.stringify` of a string: quotes, the short escapes, `\u00xx` (lower-case hex) for other control characters,
/// everything else as is (U+2028, U+2029 and DEL are not escaped).
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

/// `String(n)` for a finite double (ECMAScript `Number::toString`): shortest round-trip digits, no exponent between
/// 1e-6 and 1e21, `e+N` / `e-N` outside it, `0` for both zeros.
pub fn js_number(n: f64) -> String {
    if n == 0.0 {
        return "0".to_string();
    }
    let sign = if n < 0.0 { "-" } else { "" };
    let sci = format!("{:e}", n.abs());
    let (mant, exp) = sci.split_once('e').unwrap_or((&sci, "0"));
    let exp: i32 = exp.parse().unwrap_or(0);
    let digits: String = mant.chars().filter(|c| *c != '.').collect();
    let k = digits.len() as i32;
    let point = exp + 1; // the decimal point sits after `point` digits
    let body = if k <= point && point <= 21 {
        format!("{digits}{}", "0".repeat((point - k) as usize))
    } else if 0 < point && point <= 21 {
        format!("{}.{}", &digits[..point as usize], &digits[point as usize..])
    } else if -6 < point && point <= 0 {
        format!("0.{}{digits}", "0".repeat((-point) as usize))
    } else {
        let e = point - 1;
        let es = format!("{}{}", if e < 0 { "-" } else { "+" }, e.abs());
        if k == 1 { format!("{digits}e{es}") } else { format!("{}.{}e{es}", &digits[..1], &digits[1..]) }
    };
    format!("{sign}{body}")
}

/// `JSON.stringify` of a `serde_json::Value`, object keys in the map's (sorted) order. Numbers go through a double, as a
/// JavaScript parse would have made them.
pub fn stringify_value(v: &Value) -> String {
    let mut out = String::new();
    write_value(v, &mut out);
    out
}

fn write_value(v: &Value, out: &mut String) {
    match v {
        Value::Null => out.push_str("null"),
        Value::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
        Value::Number(n) => match n.as_f64().filter(|f| f.is_finite()) {
            Some(f) => out.push_str(&js_number(f)),
            None => out.push_str("null"),
        },
        Value::String(s) => out.push_str(&quote(s)),
        Value::Array(a) => {
            out.push('[');
            for (i, x) in a.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                write_value(x, out);
            }
            out.push(']');
        }
        Value::Object(m) => {
            out.push('{');
            for (i, (k, x)) in m.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                out.push_str(&quote(k));
                out.push(':');
                write_value(x, out);
            }
            out.push('}');
        }
    }
}

/// Parse a JSON text like `JSON.parse`.
pub fn parse(text: &str) -> Result<Oj, ParseError> {
    let mut p = Parser { b: text.as_bytes(), i: 0, depth: 0 };
    p.ws();
    let v = p.value()?;
    p.ws();
    if p.i != p.b.len() {
        return Err(ParseError::Invalid);
    }
    Ok(v)
}

struct Parser<'a> {
    b: &'a [u8],
    i: usize,
    depth: usize,
}

impl Parser<'_> {
    fn ws(&mut self) {
        while self.i < self.b.len() && matches!(self.b[self.i], b' ' | b'\t' | b'\n' | b'\r') {
            self.i += 1;
        }
    }

    fn eat(&mut self, lit: &str) -> bool {
        if self.b[self.i..].starts_with(lit.as_bytes()) {
            self.i += lit.len();
            true
        } else {
            false
        }
    }

    fn value(&mut self) -> Result<Oj, ParseError> {
        let Some(&c) = self.b.get(self.i) else { return Err(ParseError::Invalid) };
        match c {
            b'{' => self.object(),
            b'[' => self.array(),
            b'"' => Ok(Oj::Str(self.string()?)),
            b't' if self.eat("true") => Ok(Oj::Bool(true)),
            b'f' if self.eat("false") => Ok(Oj::Bool(false)),
            b'n' if self.eat("null") => Ok(Oj::Null),
            b'-' | b'0'..=b'9' => self.number(),
            _ => Err(ParseError::Invalid),
        }
    }

    fn enter(&mut self) -> Result<(), ParseError> {
        self.depth += 1;
        if self.depth as u64 > defaults::num("replykit.json_max_depth") { Err(ParseError::Unsure) } else { Ok(()) }
    }

    fn object(&mut self) -> Result<Oj, ParseError> {
        self.enter()?;
        self.i += 1;
        let mut m: Vec<(String, Oj)> = Vec::new();
        self.ws();
        if self.b.get(self.i) == Some(&b'}') {
            self.i += 1;
            self.depth -= 1;
            return Ok(Oj::Obj(m));
        }
        loop {
            self.ws();
            if self.b.get(self.i) != Some(&b'"') {
                return Err(ParseError::Invalid);
            }
            let k = self.string()?;
            if is_array_index(&k) {
                return Err(ParseError::Unsure);
            }
            self.ws();
            if self.b.get(self.i) != Some(&b':') {
                return Err(ParseError::Invalid);
            }
            self.i += 1;
            self.ws();
            let v = self.value()?;
            match m.iter_mut().find(|(ek, _)| *ek == k) {
                Some(slot) => slot.1 = v,
                None => m.push((k, v)),
            }
            self.ws();
            match self.b.get(self.i) {
                Some(b',') => self.i += 1,
                Some(b'}') => {
                    self.i += 1;
                    self.depth -= 1;
                    return Ok(Oj::Obj(m));
                }
                _ => return Err(ParseError::Invalid),
            }
        }
    }

    fn array(&mut self) -> Result<Oj, ParseError> {
        self.enter()?;
        self.i += 1;
        let mut a = Vec::new();
        self.ws();
        if self.b.get(self.i) == Some(&b']') {
            self.i += 1;
            self.depth -= 1;
            return Ok(Oj::Arr(a));
        }
        loop {
            self.ws();
            a.push(self.value()?);
            self.ws();
            match self.b.get(self.i) {
                Some(b',') => self.i += 1,
                Some(b']') => {
                    self.i += 1;
                    self.depth -= 1;
                    return Ok(Oj::Arr(a));
                }
                _ => return Err(ParseError::Invalid),
            }
        }
    }

    fn hex4(&mut self) -> Result<u32, ParseError> {
        let h = self.b.get(self.i..self.i + 4).ok_or(ParseError::Invalid)?;
        let s = std::str::from_utf8(h).map_err(|_| ParseError::Invalid)?;
        if !s.bytes().all(|c| c.is_ascii_hexdigit()) {
            return Err(ParseError::Invalid);
        }
        self.i += 4;
        u32::from_str_radix(s, 16).map_err(|_| ParseError::Invalid)
    }

    fn string(&mut self) -> Result<String, ParseError> {
        self.i += 1;
        let mut out = String::new();
        let mut start = self.i;
        loop {
            let Some(&c) = self.b.get(self.i) else { return Err(ParseError::Invalid) };
            match c {
                b'"' => {
                    out.push_str(std::str::from_utf8(&self.b[start..self.i]).map_err(|_| ParseError::Invalid)?);
                    self.i += 1;
                    return Ok(out);
                }
                0..=0x1f => return Err(ParseError::Invalid),
                b'\\' => {
                    out.push_str(std::str::from_utf8(&self.b[start..self.i]).map_err(|_| ParseError::Invalid)?);
                    self.i += 1;
                    let Some(&e) = self.b.get(self.i) else { return Err(ParseError::Invalid) };
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
                            let hi = self.hex4()?;
                            let ch = if (0xd800..0xdc00).contains(&hi) {
                                if self.b.get(self.i) == Some(&b'\\') && self.b.get(self.i + 1) == Some(&b'u') {
                                    self.i += 2;
                                    let lo = self.hex4()?;
                                    if !(0xdc00..0xe000).contains(&lo) {
                                        return Err(ParseError::Unsure);
                                    }
                                    char::from_u32(0x10000 + ((hi - 0xd800) << 10) + (lo - 0xdc00))
                                } else {
                                    return Err(ParseError::Unsure);
                                }
                            } else if (0xdc00..0xe000).contains(&hi) {
                                return Err(ParseError::Unsure);
                            } else {
                                char::from_u32(hi)
                            };
                            out.push(ch.ok_or(ParseError::Unsure)?);
                        }
                        _ => return Err(ParseError::Invalid),
                    }
                    start = self.i;
                }
                _ => self.i += 1,
            }
        }
    }

    fn number(&mut self) -> Result<Oj, ParseError> {
        let s = self.i;
        if self.b.get(self.i) == Some(&b'-') {
            self.i += 1;
        }
        match self.b.get(self.i) {
            Some(b'0') => self.i += 1,
            Some(b'1'..=b'9') => {
                while self.b.get(self.i).is_some_and(u8::is_ascii_digit) {
                    self.i += 1;
                }
            }
            _ => return Err(ParseError::Invalid),
        }
        if self.b.get(self.i) == Some(&b'.') {
            self.i += 1;
            if !self.b.get(self.i).is_some_and(u8::is_ascii_digit) {
                return Err(ParseError::Invalid);
            }
            while self.b.get(self.i).is_some_and(u8::is_ascii_digit) {
                self.i += 1;
            }
        }
        if matches!(self.b.get(self.i), Some(b'e' | b'E')) {
            self.i += 1;
            if matches!(self.b.get(self.i), Some(b'+' | b'-')) {
                self.i += 1;
            }
            if !self.b.get(self.i).is_some_and(u8::is_ascii_digit) {
                return Err(ParseError::Invalid);
            }
            while self.b.get(self.i).is_some_and(u8::is_ascii_digit) {
                self.i += 1;
            }
        }
        let t = std::str::from_utf8(&self.b[s..self.i]).map_err(|_| ParseError::Invalid)?;
        t.parse::<f64>().map(Oj::Num).map_err(|_| ParseError::Invalid)
    }
}

/// True when JavaScript treats `k` as an array index key (a canonical non-negative integer below 2^32 - 1), which an
/// object lists before its other keys.
fn is_array_index(k: &str) -> bool {
    !k.is_empty() && k.bytes().all(|c| c.is_ascii_digit()) && (k == "0" || !k.starts_with('0')) && k.parse::<u64>().is_ok_and(|n| n < 4_294_967_295)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn numbers_print_the_ecmascript_way() {
        for (n, want) in [
            (0.0, "0"),
            (-0.0, "0"),
            (1.0, "1"),
            (-1.5, "-1.5"),
            (100.0, "100"),
            (1e21, "1e+21"),
            (1e20, "100000000000000000000"),
            (1.5e-7, "1.5e-7"),
            (0.000001, "0.000001"),
            (123456789012345680000.0, "123456789012345680000"),
            (0.1 + 0.2, "0.30000000000000004"),
            (5e-324, "5e-324"),
            (1.7976931348623157e308, "1.7976931348623157e+308"),
        ] {
            assert_eq!(js_number(n), want, "{n:?}");
        }
    }

    #[test]
    fn strings_quote_like_json_stringify() {
        assert_eq!(quote("a\"b\\c\n\t\u{1}\u{7f}\u{2028}é"), "\"a\\\"b\\\\c\\n\\t\\u0001\u{7f}\u{2028}é\"");
    }

    #[test]
    fn objects_keep_key_order_and_duplicates_take_the_last_value_in_the_first_place() {
        let o = parse(r#"{"b":1,"a":2,"b":3}"#).unwrap();
        assert_eq!(o.stringify(), r#"{"b":3,"a":2}"#);
    }

    #[test]
    fn what_json_parse_could_accept_but_we_cannot_hold_is_unsure() {
        assert_eq!(parse(r#""\ud800""#), Err(ParseError::Unsure));
        assert_eq!(parse(r#"{"1":2}"#), Err(ParseError::Unsure));
        assert_eq!(parse("{").unwrap_err(), ParseError::Invalid);
        assert_eq!(parse("[1,]").unwrap_err(), ParseError::Invalid);
        assert_eq!(parse("01").unwrap_err(), ParseError::Invalid);
        assert_eq!(parse("\"a\nb\"").unwrap_err(), ParseError::Invalid);
        assert_eq!(parse(r#""😀""#).unwrap(), Oj::Str("\u{1f600}".into()));
    }

    #[test]
    fn values_stringify_with_sorted_keys_and_ecmascript_numbers() {
        let v: Value = serde_json::from_str(r#"{"b":1.0,"a":[1e21,"x"],"c":null}"#).unwrap();
        assert_eq!(stringify_value(&v), r#"{"a":[1e+21,"x"],"b":1,"c":null}"#);
    }
}
