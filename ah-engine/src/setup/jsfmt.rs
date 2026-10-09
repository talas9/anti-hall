//! JavaScript output formatting the helper scripts rely on: `JSON.stringify(value, null, 2)`, UTF-16 string lengths and
//! slices (`String.prototype.length`, `slice`, `padEnd`), `parseInt`, and `Number.prototype.toFixed(2)`.
use crate::checks::jsport::json::{J, quote, stringify};

/// `JSON.stringify(v, null, 2)`.
pub fn pretty(v: &J) -> String {
    let mut out = String::new();
    write(v, 0, &mut out);
    out
}

fn write(v: &J, depth: usize, out: &mut String) {
    let pad = "  ".repeat(depth + 1);
    let close = "  ".repeat(depth);
    match v {
        J::Arr(a) if !a.is_empty() => {
            out.push_str("[\n");
            for (i, x) in a.iter().enumerate() {
                out.push_str(&pad);
                write(x, depth + 1, out);
                out.push_str(if i + 1 < a.len() { ",\n" } else { "\n" });
            }
            out.push_str(&close);
            out.push(']');
        }
        J::Obj(o) if !o.is_empty() => {
            out.push_str("{\n");
            for (i, (k, x)) in o.iter().enumerate() {
                out.push_str(&pad);
                out.push_str(&quote(k));
                out.push_str(": ");
                write(x, depth + 1, out);
                out.push_str(if i + 1 < o.len() { ",\n" } else { "\n" });
            }
            out.push_str(&close);
            out.push('}');
        }
        other => out.push_str(&stringify(other)),
    }
}

/// `String(v)` for a JSON value (arrays join their elements with commas, objects read `[object Object]`).
pub(crate) fn js_string(v: &J) -> String {
    match v {
        J::Null => "null".into(),
        J::Bool(b) => b.to_string(),
        J::Num(n) => crate::checks::jsport::num::to_js_string(*n),
        J::Str(s) => s.clone(),
        J::Arr(a) => a.iter().map(|x| if matches!(x, J::Null) { String::new() } else { js_string(x) }).collect::<Vec<_>>().join(","),
        J::Obj(_) => "[object Object]".into(),
    }
}

/// An object from (key, value) pairs in the order given.
pub fn obj(pairs: Vec<(&str, J)>) -> J {
    J::Obj(pairs.into_iter().map(|(k, v)| (k.to_string(), v)).collect())
}

/// `s.length` (UTF-16 code units).
pub fn len16(s: &str) -> usize {
    s.encode_utf16().count()
}

/// `s.slice(from, to)` for non-negative bounds (UTF-16 units; a cut surrogate pair becomes U+FFFD, as it does when Node
/// writes the lone surrogate out as UTF-8).
pub fn slice16(s: &str, from: usize, to: usize) -> String {
    let u: Vec<u16> = s.encode_utf16().collect();
    let to = to.min(u.len());
    let from = from.min(to);
    String::from_utf16_lossy(&u[from..to])
}

/// `s.slice(-n)`: the last `n` units.
pub fn tail16(s: &str, n: usize) -> String {
    let len = len16(s);
    slice16(s, len.saturating_sub(n), len)
}

/// `s.padEnd(width)` with spaces.
pub fn pad_end(s: &str, width: usize) -> String {
    let len = len16(s);
    if len >= width { s.to_string() } else { format!("{s}{}", " ".repeat(width - len)) }
}

/// `parseInt(s, 10)`: leading white space, an optional sign, then digits; `None` for NaN.
pub fn parse_int(s: &str) -> Option<f64> {
    let t = crate::jev::js_trim(s);
    let (neg, digits) = match t.strip_prefix('-') {
        Some(r) => (true, r),
        None => (false, t.strip_prefix('+').unwrap_or(t)),
    };
    let run: String = digits.chars().take_while(char::is_ascii_digit).collect();
    if run.is_empty() {
        return None;
    }
    let n: f64 = run.parse().ok()?;
    Some(if neg { -n } else { n })
}

/// `n.toFixed(2)` for a finite number: the exact decimal expansion rounded half up (Rust rounds an exact tie to even).
pub fn to_fixed2(n: f64) -> String {
    let neg = n < 0.0;
    let exact = format!("{:.80}", n.abs());
    let (int, frac) = exact.split_once('.').unwrap_or((&exact, ""));
    let mut digits: Vec<u8> = format!("{int}{}", &frac[..2]).bytes().map(|b| b - b'0').collect();
    if frac.as_bytes().get(2).is_some_and(|d| *d >= b'5') {
        let mut i = digits.len();
        loop {
            if i == 0 {
                digits.insert(0, 1);
                break;
            }
            i -= 1;
            if digits[i] == 9 {
                digits[i] = 0;
            } else {
                digits[i] += 1;
                break;
            }
        }
    }
    let s: String = digits.iter().map(|d| char::from(b'0' + d)).collect();
    let (ip, fp) = s.split_at(s.len() - 2);
    format!("{}{ip}.{fp}", if neg { "-" } else { "" })
}

/// The members of the plain object at `v`, as `Object.keys` lists them (empty for anything else).
pub fn keys(v: &J) -> Vec<String> {
    match v {
        J::Obj(o) => o.iter().map(|(k, _)| k.clone()).collect(),
        _ => Vec::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pretty_matches_json_stringify_with_two_spaces() {
        let v = obj(vec![("a", J::Arr(vec![])), ("b", obj(vec![])), ("c", J::Arr(vec![J::Num(1.0), J::Null, obj(vec![("d", J::Str("x\"y".into()))])]))]);
        assert_eq!(pretty(&v), "{\n  \"a\": [],\n  \"b\": {},\n  \"c\": [\n    1,\n    null,\n    {\n      \"d\": \"x\\\"y\"\n    }\n  ]\n}");
    }

    #[test]
    fn to_fixed_rounds_a_tie_up_like_javascript() {
        assert_eq!(to_fixed2(0.125), "0.13");
        assert_eq!(to_fixed2(12.345), "12.35");
        assert_eq!(to_fixed2(1.005), "1.00");
        assert_eq!(to_fixed2(-0.5), "-0.50");
        assert_eq!(to_fixed2(99.995), "100.00");
        assert_eq!(to_fixed2(0.0), "0.00");
        assert_eq!(to_fixed2(5.0), "5.00");
    }

    #[test]
    fn parse_int_reads_the_leading_digits() {
        assert_eq!(parse_int(" 12abc"), Some(12.0));
        assert_eq!(parse_int("-5"), Some(-5.0));
        assert_eq!(parse_int("abc"), None);
        assert_eq!(parse_int("2.9"), Some(2.0));
    }
}
