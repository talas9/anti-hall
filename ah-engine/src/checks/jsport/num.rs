//! JavaScript number formatting and parsing.

/// `String(n)` for a double (ECMAScript `Number::toString`, radix 10).
pub fn to_js_string(x: f64) -> String {
    if x.is_nan() {
        return "NaN".into();
    }
    if x == 0.0 {
        return "0".into();
    }
    if x.is_infinite() {
        return if x < 0.0 { "-Infinity".into() } else { "Infinity".into() };
    }
    let neg = x < 0.0;
    // Rust prints the shortest digits that round-trip, as `d.ddde<exp>`; JavaScript lays the same digits out differently.
    let sci = format!("{:e}", x.abs());
    let (mant, exp) = sci.split_once('e').unwrap_or((&sci, "0"));
    let e: i32 = exp.parse().unwrap_or(0);
    let digits: String = mant.chars().filter(|c| *c != '.').collect();
    let k = digits.len() as i32;
    let n = e + 1;
    let body = if k <= n && n <= 21 {
        format!("{digits}{}", "0".repeat((n - k) as usize))
    } else if 0 < n && n <= 21 {
        format!("{}.{}", &digits[..n as usize], &digits[n as usize..])
    } else if -6 < n && n <= 0 {
        format!("0.{}{digits}", "0".repeat((-n) as usize))
    } else {
        let sign = if n - 1 < 0 { '-' } else { '+' };
        let ex = (n - 1).abs();
        if k == 1 { format!("{digits}e{sign}{ex}") } else { format!("{}.{}e{sign}{ex}", &digits[..1], &digits[1..]) }
    };
    if neg { format!("-{body}") } else { body }
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
