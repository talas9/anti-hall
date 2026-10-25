//! JavaScript string behaviour the operator ports need: UTF-16 lengths and slices, the default `localeCompare` for the text
//! the tools sort, and `parseSemver`. A case the port cannot reproduce exactly is an [`Defer`]: the command writes nothing and
//! leaves the work to the Node tool.
use crate::checks::guardkit::text::js_trim;
use crate::defaults;
use std::cmp::Ordering;

/// The Node tool must answer: the input needs behaviour this port does not reproduce.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Defer;

/// `s.length`.
pub fn len16(s: &str) -> usize {
    s.encode_utf16().count()
}

/// `a.localeCompare(b)` with the default (root) collation, for the printable ASCII text the tools sort: punctuation and
/// symbols in the shipped order, then digits, then letters ignoring case; ties are broken by case with lower case first.
/// `Err` for any other character (control or non-ASCII), whose weight this port does not carry.
pub fn locale_compare(a: &str, b: &str) -> Result<Ordering, Defer> {
    let symbols = defaults::text("defect.collation_symbols");
    let rank = |c: char| -> Result<u32, Defer> {
        if let Some(i) = symbols.chars().position(|s| s == c) {
            return Ok(i as u32);
        }
        match c {
            '0'..='9' => Ok(1000 + c as u32 - '0' as u32),
            'a'..='z' => Ok(2000 + c as u32 - 'a' as u32),
            'A'..='Z' => Ok(2000 + c as u32 - 'A' as u32),
            _ => Err(Defer),
        }
    };
    let ra: Vec<u32> = a.chars().map(rank).collect::<Result<_, _>>()?;
    let rb: Vec<u32> = b.chars().map(rank).collect::<Result<_, _>>()?;
    match ra.cmp(&rb) {
        Ordering::Equal => {}
        other => return Ok(other),
    }
    for (x, y) in a.chars().zip(b.chars()) {
        if x != y {
            // same primary weight, different case: lower case sorts first
            return Ok(if x.is_ascii_lowercase() { Ordering::Less } else { Ordering::Greater });
        }
    }
    Ok(Ordering::Equal)
}

/// `parseSemver(v)`: `[major, minor, patch]` of `v?MAJOR.MINOR(.PATCH)?` (trimmed), else `None`.
pub fn parse_semver(v: &str) -> Option<[f64; 3]> {
    let t = js_trim(v);
    let t = t.strip_prefix('v').unwrap_or(t);
    let parts: Vec<&str> = t.split('.').collect();
    if !(2..=3).contains(&parts.len()) || parts.iter().any(|p| p.is_empty() || !p.bytes().all(|b| b.is_ascii_digit())) {
        return None;
    }
    let n = |i: usize| -> Option<f64> { parts.get(i).map_or(Some(0.0), |p| p.parse::<f64>().ok().filter(|x| x.is_finite())) };
    Some([n(0)?, n(1)?, n(2)?])
}

/// `cmpSemver(a, b)`: -1, 0 or 1, `None` when either side does not parse.
pub fn cmp_semver(a: &str, b: &str) -> Option<i32> {
    let (pa, pb) = (parse_semver(a)?, parse_semver(b)?);
    for i in 0..3 {
        if pa[i] != pb[i] {
            return Some(if pa[i] < pb[i] { -1 } else { 1 });
        }
    }
    Some(0)
}
