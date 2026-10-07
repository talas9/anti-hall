//! A JSON value that keeps what JavaScript's `JSON.parse` / `JSON.stringify` pair keeps: the order of an object's keys
//! (`serde_json::Value` sorts them) and the way a number is written.
//!
//! Why this exists: the session-maintenance hooks read a small state file, change one field and write the whole object
//! back (`Object.assign({}, cache, {lastAdvised: key})` then `JSON.stringify`). The Node and the Rust writer share those
//! files, so the Rust one must leave every other field where Node put it and print numbers the way Node does.
//!
//! Known limit (the same one the Node store has): an object key that is an array index (`"0"`, `"12"`) is ordered first
//! in JavaScript; this type keeps file order. The state files never use such keys.
use serde::de::{Deserialize, Deserializer, MapAccess, SeqAccess, Visitor};
use std::fmt;

/// A JSON value with ordered objects.
#[derive(Debug, Clone, PartialEq)]
pub enum J {
    /// `null`.
    Null,
    /// `true` or `false`.
    Bool(bool),
    /// A number; JavaScript has one number type, so this is an `f64`.
    Num(f64),
    /// A string.
    Str(String),
    /// An array.
    Arr(Vec<J>),
    /// An object, in key order of first appearance (a repeated key keeps its first position and its last value).
    Obj(Vec<(String, J)>),
}

/// What reading JSON text gave.
#[derive(Debug, Clone, PartialEq)]
pub enum Parsed {
    /// The text is JSON and this is its value.
    Ok(J),
    /// The text is not JSON (JavaScript's `JSON.parse` throws too).
    Bad,
    /// The text is something this parser may judge differently from `JSON.parse` (a lone surrogate escape, a number
    /// out of range, nesting past the parser's limit): the caller defers to the Node hook.
    Unsure,
}

struct Vis;

impl<'de> Visitor<'de> for Vis {
    type Value = J;

    fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("any JSON value")
    }
    fn visit_unit<E>(self) -> Result<J, E> {
        Ok(J::Null)
    }
    fn visit_none<E>(self) -> Result<J, E> {
        Ok(J::Null)
    }
    fn visit_bool<E>(self, v: bool) -> Result<J, E> {
        Ok(J::Bool(v))
    }
    fn visit_i64<E>(self, v: i64) -> Result<J, E> {
        Ok(J::Num(v as f64))
    }
    fn visit_u64<E>(self, v: u64) -> Result<J, E> {
        Ok(J::Num(v as f64))
    }
    fn visit_f64<E>(self, v: f64) -> Result<J, E> {
        Ok(J::Num(v))
    }
    fn visit_str<E>(self, v: &str) -> Result<J, E> {
        Ok(J::Str(v.to_string()))
    }
    fn visit_string<E>(self, v: String) -> Result<J, E> {
        Ok(J::Str(v))
    }
    fn visit_seq<A: SeqAccess<'de>>(self, mut a: A) -> Result<J, A::Error> {
        let mut out = Vec::new();
        while let Some(v) = a.next_element::<J>()? {
            out.push(v);
        }
        Ok(J::Arr(out))
    }
    fn visit_map<A: MapAccess<'de>>(self, mut a: A) -> Result<J, A::Error> {
        let mut out: Vec<(String, J)> = Vec::new();
        while let Some((k, v)) = a.next_entry::<String, J>()? {
            match out.iter_mut().find(|(ek, _)| *ek == k) {
                Some(slot) => slot.1 = v,
                None => out.push((k, v)),
            }
        }
        Ok(J::Obj(out))
    }
}

impl<'de> Deserialize<'de> for J {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<J, D::Error> {
        d.deserialize_any(Vis)
    }
}

/// `JSON.parse(text)`.
pub fn parse(text: &str) -> Parsed {
    match serde_json::from_str::<J>(text) {
        Ok(v) => Parsed::Ok(v),
        Err(e) => {
            let m = e.to_string();
            if m.contains("surrogate") || m.contains("recursion limit") || m.contains("out of range") { Parsed::Unsure } else { Parsed::Bad }
        }
    }
}

/// `String(n)` for a finite number, exactly as ECMAScript's `Number::toString` writes it.
pub fn js_num(n: f64) -> String {
    if n == 0.0 {
        return "0".into();
    }
    if !n.is_finite() {
        return if n.is_nan() {
            "NaN".into()
        } else if n > 0.0 {
            "Infinity".into()
        } else {
            "-Infinity".into()
        };
    }
    let sign = if n < 0.0 { "-" } else { "" };
    // `{:e}` writes the shortest digits that read back as the same number, like `d.ddde<exp>`.
    let sci = format!("{:e}", n.abs());
    let (mant, exp) = sci.split_once('e').unwrap_or((sci.as_str(), "0"));
    let digits: String = mant.chars().filter(|c| *c != '.').collect();
    let e: i32 = exp.parse().unwrap_or(0);
    let k = digits.len() as i32;
    let point = e + 1; // the decimal point sits after this many digits
    let body = if k <= point && point <= 21 {
        format!("{digits}{}", "0".repeat((point - k) as usize))
    } else if 0 < point && point <= 21 {
        format!("{}.{}", &digits[..point as usize], &digits[point as usize..])
    } else if -6 < point && point <= 0 {
        format!("0.{}{digits}", "0".repeat((-point) as usize))
    } else {
        let x = point - 1;
        let xs = format!("{}{}", if x < 0 { "-" } else { "+" }, x.abs());
        if k == 1 { format!("{digits}e{xs}") } else { format!("{}.{}e{xs}", &digits[..1], &digits[1..]) }
    };
    format!("{sign}{body}")
}

impl J {
    /// The field `key` of an object.
    pub fn get(&self, key: &str) -> Option<&J> {
        match self {
            J::Obj(o) => o.iter().find(|(k, _)| k == key).map(|(_, v)| v),
            _ => None,
        }
    }

    /// The string, if this is one.
    pub fn as_str(&self) -> Option<&str> {
        match self {
            J::Str(s) => Some(s),
            _ => None,
        }
    }

    /// The number, if this is a finite one (`Number.isFinite`, which is false for any non-number).
    pub fn finite(&self) -> Option<f64> {
        match self {
            J::Num(n) if n.is_finite() => Some(*n),
            _ => None,
        }
    }

    /// True for an object (not an array, not null).
    pub fn is_obj(&self) -> bool {
        matches!(self, J::Obj(_))
    }

    /// Set `key` to `v`: an existing key keeps its place, a new one goes last (what assigning a property does).
    pub fn set(&mut self, key: &str, v: J) {
        if let J::Obj(o) = self {
            match o.iter_mut().find(|(k, _)| k == key) {
                Some(slot) => slot.1 = v,
                None => o.push((key.to_string(), v)),
            }
        }
    }

    /// `JSON.stringify(self)`.
    pub fn stringify(&self) -> String {
        let mut out = String::new();
        self.write(&mut out);
        out
    }

    fn write(&self, out: &mut String) {
        match self {
            J::Null => out.push_str("null"),
            J::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
            J::Num(n) => out.push_str(&if n.is_finite() { js_num(*n) } else { "null".to_string() }),
            J::Str(s) => out.push_str(&serde_json::to_string(s).unwrap_or_else(|_| "\"\"".into())),
            J::Arr(a) => {
                out.push('[');
                for (i, v) in a.iter().enumerate() {
                    if i > 0 {
                        out.push(',');
                    }
                    v.write(out);
                }
                out.push(']');
            }
            J::Obj(o) => {
                out.push('{');
                for (i, (k, v)) in o.iter().enumerate() {
                    if i > 0 {
                        out.push(',');
                    }
                    out.push_str(&serde_json::to_string(k).unwrap_or_else(|_| "\"\"".into()));
                    out.push(':');
                    v.write(out);
                }
                out.push('}');
            }
        }
    }
}

/// An object from (key, value) pairs.
pub fn obj(pairs: Vec<(&str, J)>) -> J {
    J::Obj(pairs.into_iter().map(|(k, v)| (k.to_string(), v)).collect())
}
