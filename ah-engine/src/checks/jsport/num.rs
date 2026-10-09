//! JavaScript number formatting and parsing.

/// `String(n)` for a double (ECMAScript `Number::toString`, radix 10). The ONE printer: every number-to-text path that must
/// match Node calls this (a test fails on any second formatter).
pub fn to_js_string(n: f64) -> String {
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

/// `Math.round(x)`: the nearest integer, ties toward positive infinity.
pub fn js_round(x: f64) -> f64 {
    if !x.is_finite() {
        return x;
    }
    let f = x.floor();
    if x - f >= 0.5 { f + 1.0 } else { f }
}

/// What `Number(s)` gave.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum JsNum {
    /// A number (possibly infinite).
    Val(f64),
    /// NaN.
    Nan,
    /// The exact value cannot be reproduced here (a radix literal above 2^53); the caller defers to Node.
    Unsure,
}

/// `Number(s)` for a string already trimmed of JavaScript white space.
pub fn parse_js_number(s: &str) -> JsNum {
    if s.is_empty() {
        return JsNum::Val(0.0);
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
            let body = &s[2..];
            if !body.chars().all(|c| c.is_digit(radix)) {
                return JsNum::Nan;
            }
            return match u64::from_str_radix(body, radix) {
                Ok(v) if v <= (1u64 << 53) => JsNum::Val(v as f64),
                _ => JsNum::Unsure,
            };
        }
    }
    let rest = s.strip_prefix(['+', '-']).unwrap_or(s);
    if rest == "Infinity" {
        return JsNum::Val(if s.starts_with('-') { f64::NEG_INFINITY } else { f64::INFINITY });
    }
    // StrDecimalLiteral: digits [. digits] | . digits, then an optional exponent. Rust also accepts `inf` and `nan`,
    // which JavaScript rejects, so the grammar is checked here first.
    let rb = rest.as_bytes();
    let mut i = 0;
    let digits = |i: &mut usize| {
        let st = *i;
        while *i < rb.len() && rb[*i].is_ascii_digit() {
            *i += 1;
        }
        *i - st
    };
    let int = digits(&mut i);
    let mut frac = 0;
    if i < rb.len() && rb[i] == b'.' {
        i += 1;
        frac = digits(&mut i);
    }
    if int == 0 && frac == 0 {
        return JsNum::Nan;
    }
    if i < rb.len() && (rb[i] == b'e' || rb[i] == b'E') {
        i += 1;
        if i < rb.len() && (rb[i] == b'+' || rb[i] == b'-') {
            i += 1;
        }
        if digits(&mut i) == 0 {
            return JsNum::Nan;
        }
    }
    if i != rb.len() {
        return JsNum::Nan;
    }
    s.parse::<f64>().map_or(JsNum::Nan, JsNum::Val)
}
