//! JSON that keeps what `JSON.parse` / `JSON.stringify` keep: the order of object keys (insertion order, with
//! integer-like keys first in ascending order, as JavaScript objects enumerate them) and JavaScript's number text.
//!
//! Why: the guards rewrite state files that other hooks also write. `serde_json::Value` sorts object keys, so a
//! read-modify-write through it would reorder keys the Node guard keeps in order and the file would differ byte for byte
//! from the one Node writes.
// Discard triage (E3): every `.ok()` / `unwrap_or_default()` in this file is a deliberate keep, for these reasons:
// - text that does not parse or decode is the absent value (Node Number()/JSON.parse catch parity)
// - serializing a string cannot fail
// A failure that must be seen goes through `crate::discard` instead.

use serde::de::{Deserialize, Deserializer, MapAccess, SeqAccess, Visitor};
use std::fmt;

/// A JSON value with ordered objects.
#[derive(Debug, Clone, PartialEq)]
pub enum OVal {
    /// `null`.
    Null,
    /// `true` or `false`.
    Bool(bool),
    /// Any number, as the double JavaScript would hold.
    Num(f64),
    /// A string.
    Str(String),
    /// An array.
    Arr(Vec<OVal>),
    /// An object, in insertion order.
    Obj(Vec<(String, OVal)>),
}

impl OVal {
    /// `JSON.parse(text)`; `None` when it throws.
    pub fn parse(text: &str) -> Option<OVal> {
        serde_json::from_str::<OVal>(text).ok()
    }

    /// `obj[key]` for an object (`None` for any other value or a missing key).
    pub fn get(&self, key: &str) -> Option<&OVal> {
        match self {
            OVal::Obj(v) => v.iter().find(|(k, _)| k == key).map(|(_, x)| x),
            _ => None,
        }
    }

    /// `obj[key] = val` on an object: replaces in place or appends. No effect on other values.
    pub fn set(&mut self, key: &str, val: OVal) {
        if let OVal::Obj(v) = self {
            match v.iter_mut().find(|(k, _)| k == key) {
                Some(slot) => slot.1 = val,
                None => v.push((key.to_string(), val)),
            }
        }
    }

    /// JavaScript truthiness.
    pub fn truthy(&self) -> bool {
        match self {
            OVal::Null => false,
            OVal::Bool(b) => *b,
            OVal::Num(n) => *n != 0.0 && !n.is_nan(),
            OVal::Str(s) => !s.is_empty(),
            OVal::Arr(_) | OVal::Obj(_) => true,
        }
    }

    /// `JSON.stringify(value)` (compact).
    pub fn stringify(&self) -> String {
        let mut out = String::new();
        self.write(&mut out);
        out
    }

    fn write(&self, out: &mut String) {
        match self {
            OVal::Null => out.push_str("null"),
            OVal::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
            OVal::Num(n) => out.push_str(&js_number_text(*n)),
            OVal::Str(s) => out.push_str(&serde_json::to_string(s).unwrap_or_default()),
            OVal::Arr(a) => {
                out.push('[');
                for (i, x) in a.iter().enumerate() {
                    if i > 0 {
                        out.push(',');
                    }
                    x.write(out);
                }
                out.push(']');
            }
            OVal::Obj(o) => {
                // integer-like keys ascending first, then the rest in insertion order
                let mut idx: Vec<(u32, &(String, OVal))> = o.iter().filter_map(|e| array_index(&e.0).map(|n| (n, e))).collect();
                idx.sort_by_key(|(n, _)| *n);
                let rest = o.iter().filter(|e| array_index(&e.0).is_none());
                out.push('{');
                for (i, e) in idx.into_iter().map(|(_, e)| e).chain(rest).enumerate() {
                    if i > 0 {
                        out.push(',');
                    }
                    out.push_str(&serde_json::to_string(&e.0).unwrap_or_default());
                    out.push(':');
                    e.1.write(out);
                }
                out.push('}');
            }
        }
    }
}

/// A canonical array index (`"0"`, `"17"`, not `"01"`, at most 2^32 - 2): the keys a JavaScript object lists first.
fn array_index(k: &str) -> Option<u32> {
    if k.is_empty() || k.len() > 10 || !k.bytes().all(|b| b.is_ascii_digit()) || (k.len() > 1 && k.starts_with('0')) {
        return None;
    }
    k.parse::<u64>().ok().filter(|n| *n < 4_294_967_295).map(|n| n as u32)
}

/// `String(n)` for a finite number.
pub fn js_number_text(n: f64) -> String {
    if n == 0.0 || !n.is_finite() {
        return if n.is_nan() {
            "NaN".into()
        } else if n.is_infinite() {
            if n > 0.0 { "Infinity".into() } else { "-Infinity".into() }
        } else {
            "0".into()
        };
    }
    let (digits, exp) = shortest_digits(n);
    let (k, point) = (digits.len() as i32, exp + 1);
    let sign = if n < 0.0 { "-" } else { "" };
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

/// The shortest digits that read back as `n` and the decimal exponent of the first one, chosen as ECMAScript's `Number::toString`
/// chooses: among the shortest candidates the one closest to the value and, when two are equally close (the value lies exactly
/// halfway), the even one. Rust's shortest formatting rounds such a tie up, which prints `...4063` where JavaScript prints `...4062`.
fn shortest_digits(n: f64) -> (String, i32) {
    let e = format!("{:e}", n.abs());
    let (m, x) = e.split_once('e').unwrap_or((&e, "0"));
    let exp: i32 = x.parse().unwrap_or(0);
    let digits: String = m.chars().filter(char::is_ascii_digit).collect();
    let k = digits.len();
    // cheap test first: a halfway tie has a last digit 5 when rounded to one more digit than the shortest form
    if !format!("{:.*e}", k, n.abs()).split_once('e').is_some_and(|(m, _)| m.ends_with('5')) {
        return (digits, exp);
    }
    // the exact decimal expansion of the double (at most ~770 significant digits)
    let exact = format!("{:.800e}", n.abs());
    let (em, _) = exact.split_once('e').unwrap_or((&exact, "0"));
    let all: String = em.chars().filter(char::is_ascii_digit).collect();
    let all = all.trim_end_matches('0');
    if all.len() == k + 1 && all.ends_with('5') {
        let lo = &all[..k];
        let last = lo.as_bytes()[k - 1] - b'0';
        if last.is_multiple_of(2) && lo != digits {
            return (lo.to_string(), exp);
        }
        if !last.is_multiple_of(2) && lo == digits && !lo.bytes().all(|b| b == b'9') {
            let hi = lo.parse::<u128>().ok().map(|v| (v + 1).to_string());
            if let Some(hi) = hi.filter(|h| h.len() == k) {
                return (hi, exp);
            }
        }
    }
    (digits, exp)
}

struct V;

impl<'de> Visitor<'de> for V {
    type Value = OVal;

    fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("any JSON value")
    }

    fn visit_bool<E>(self, v: bool) -> Result<OVal, E> {
        Ok(OVal::Bool(v))
    }

    fn visit_i64<E>(self, v: i64) -> Result<OVal, E> {
        Ok(OVal::Num(v as f64))
    }

    fn visit_u64<E>(self, v: u64) -> Result<OVal, E> {
        Ok(OVal::Num(v as f64))
    }

    fn visit_f64<E>(self, v: f64) -> Result<OVal, E> {
        Ok(OVal::Num(v))
    }

    fn visit_str<E>(self, v: &str) -> Result<OVal, E> {
        Ok(OVal::Str(v.to_string()))
    }

    fn visit_string<E>(self, v: String) -> Result<OVal, E> {
        Ok(OVal::Str(v))
    }

    fn visit_unit<E>(self) -> Result<OVal, E> {
        Ok(OVal::Null)
    }

    fn visit_none<E>(self) -> Result<OVal, E> {
        Ok(OVal::Null)
    }

    fn visit_seq<A: SeqAccess<'de>>(self, mut a: A) -> Result<OVal, A::Error> {
        let mut v = Vec::new();
        while let Some(x) = a.next_element::<OVal>()? {
            v.push(x);
        }
        Ok(OVal::Arr(v))
    }

    fn visit_map<A: MapAccess<'de>>(self, mut m: A) -> Result<OVal, A::Error> {
        let mut v: Vec<(String, OVal)> = Vec::new();
        while let Some((k, x)) = m.next_entry::<String, OVal>()? {
            // a repeated key keeps its first position and takes the last value, as a JavaScript object does
            match v.iter_mut().find(|(e, _)| *e == k) {
                Some(slot) => slot.1 = x,
                None => v.push((k, x)),
            }
        }
        Ok(OVal::Obj(v))
    }
}

impl<'de> Deserialize<'de> for OVal {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<OVal, D::Error> {
        d.deserialize_any(V)
    }
}
