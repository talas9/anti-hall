//! `Date` behavior of the Node hooks: `Date.now()`, `toISOString()`, local calendar date, and the part of `Date.parse`
//! whose result is certain.
//!
//! V8's legacy date parser accepts a very wide, partly surprising set of strings. This module recognizes only shapes it
//! can reproduce exactly (ISO 8601 with a full date, and `Mon D, YYYY [H:MM[:SS] [AM|PM]] [UTC|GMT|Z]`) and strings that
//! cannot be a date at all (no digit); every other string is [`Parsed::Unknown`], which makes the check defer.
// Discard triage (E3): every `.ok()` / `unwrap_or_default()` in this file is a deliberate keep, for these reasons:
// - an unset or non-UTF-8 variable is an unset one
// - text that does not parse or decode is the absent value (Node Number()/JSON.parse catch parity)
// A failure that must be seen goes through `crate::discard` instead.

use crate::defaults;
use crate::reqenv::RequestEnv;
use std::cell::Cell;

thread_local! {
    static ZONE_OK: Cell<bool> = const { Cell::new(false) };
}

/// This process's own `TZ`, for tests that need a request carrying the zone they run in.
pub fn process_zone() -> Option<String> {
    std::env::var(defaults::text("codex_handover.tz_var")).ok()
}

/// Proof, for the length of one check, that the local time zone of this process is the one the hook ran in.
///
/// Local calendar dates and zone-less date strings depend on the time zone. The engine process has its own zone, the
/// hook its own; they agree when the request's `TZ` is the process's `TZ` (both unset means the machine's zone, which
/// is shared). Without a guard, or when they differ, every local conversion is refused and the check defers to Node.
pub struct ZoneGuard(bool);

impl ZoneGuard {
    /// Compare the request's `TZ` with this process's and hold the answer until the guard is dropped.
    pub fn new(env: &RequestEnv) -> ZoneGuard {
        let name = defaults::text("codex_handover.tz_var");
        let ok = env.get(name).map(str::to_string) == process_zone();
        ZoneGuard(ZONE_OK.with(|z| z.replace(ok)))
    }
}

impl Drop for ZoneGuard {
    fn drop(&mut self) {
        ZONE_OK.with(|z| z.set(self.0));
    }
}

fn zone_ok() -> bool {
    ZONE_OK.with(Cell::get)
}

/// The result of parsing a date string.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Parsed {
    /// Milliseconds since the epoch.
    Ms(f64),
    /// `NaN`: not a date.
    Nan,
    /// A string whose V8 result is not reproduced here.
    Unknown,
}

/// `Date.now()`.
pub fn now_ms() -> f64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0.0, |d| d.as_millis() as f64)
}

/// Days since 1970-01-01 of a proleptic Gregorian date (month 1..=12, any day, which may overflow the month).
pub fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let mp = (m + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146097 + doe - 719468
}

/// The civil date of a day count.
pub fn civil_from_days(z: i64) -> (i64, i64, i64) {
    let z = z + 719468;
    let era = if z >= 0 { z } else { z - 146096 } / 146097;
    let doe = z - era * 146097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    (if m <= 2 { y + 1 } else { y }, m, d)
}

fn days_in_month(y: i64, m: i64) -> i64 {
    match m {
        2 if (y % 4 == 0 && y % 100 != 0) || y % 400 == 0 => 29,
        2 => 28,
        4 | 6 | 9 | 11 => 30,
        _ => 31,
    }
}

/// `new Date(ms).toISOString()`; `None` when JavaScript would throw (a time outside the Date range, or NaN).
pub fn to_iso(ms: f64) -> Option<String> {
    if !ms.is_finite() || ms.abs() > defaults::num("codex_handover.date_max_ms") as f64 {
        return None;
    }
    let t = ms.trunc() as i64;
    let days = t.div_euclid(86_400_000);
    let rem = t.rem_euclid(86_400_000);
    let (y, m, d) = civil_from_days(days);
    let year = if (0..=9999).contains(&y) { format!("{y:04}") } else { format!("{}{:06}", if y < 0 { '-' } else { '+' }, y.abs()) };
    Some(format!("{year}-{m:02}-{d:02}T{:02}:{:02}:{:02}.{:03}Z", rem / 3_600_000, rem / 60_000 % 60, rem / 1000 % 60, rem % 1000))
}

/// The local calendar date `YYYY-MM-DD` of `ms` (what `getFullYear()`, `getMonth()` and `getDate()` give), by the
/// process's own time zone.
pub fn local_ymd(ms: f64) -> Option<String> {
    if !zone_ok() {
        return None;
    }
    let secs = (ms / 1000.0).floor() as libc::time_t;
    // SAFETY: an all-zero `tm` is a valid value (integers and a null `tm_zone`); `localtime_r` fills it below.
    let mut tm: libc::tm = unsafe { std::mem::zeroed() };
    // SAFETY: `secs` is a plain integer and `tm` a writable struct of the right type.
    let ok = unsafe { !libc::localtime_r(&secs, &mut tm).is_null() };
    ok.then(|| format!("{:04}-{:02}-{:02}", tm.tm_year + 1900, tm.tm_mon + 1, tm.tm_mday))
}

/// Milliseconds of a LOCAL wall-clock time, or `None` when it falls in a daylight-saving gap or overlap (where V8's
/// choice is not reproduced here).
fn local_to_ms(y: i64, mo: i64, d: i64, h: i64, mi: i64, s: i64) -> Option<f64> {
    if !zone_ok() || !(1971..=2200).contains(&y) {
        return None;
    }
    let tm = |isdst: i32| {
        // SAFETY: an all-zero struct tm is a valid value (null zone pointer, zero offset); the fields set below are the
        // ones mktime reads.
        let mut t: libc::tm = unsafe { std::mem::zeroed() };
        t.tm_sec = s as i32;
        t.tm_min = mi as i32;
        t.tm_hour = h as i32;
        t.tm_mday = d as i32;
        t.tm_mon = (mo - 1) as i32;
        t.tm_year = (y - 1900) as i32;
        t.tm_isdst = isdst;
        t
    };
    let one = |isdst: i32| -> Option<i64> {
        let mut t = tm(isdst);
        // SAFETY: `t` is a fully initialized struct tm.
        let secs = unsafe { libc::mktime(&mut t) };
        if secs == -1 {
            return None;
        }
        // The wall clock must read back as asked: a skipped time is normalized to another one.
        // SAFETY: an all-zero `tm` is a valid value (integers and a null `tm_zone`); `localtime_r` fills it below.
        let mut back: libc::tm = unsafe { std::mem::zeroed() };
        // SAFETY: valid pointers to a time_t and a tm.
        unsafe { libc::localtime_r(&secs, &mut back) };
        let same = back.tm_year == (y - 1900) as i32
            && back.tm_mon == (mo - 1) as i32
            && back.tm_mday == d as i32
            && back.tm_hour == h as i32
            && back.tm_min == mi as i32
            && back.tm_sec == s as i32;
        same.then_some(secs as i64)
    };
    // Both readings of an overlapped time must not exist: ask for standard and for daylight time.
    match (one(0), one(1)) {
        (Some(a), Some(b)) if a == b => Some(a as f64 * 1000.0),
        (Some(a), None) | (None, Some(a)) => Some(a as f64 * 1000.0),
        _ => None,
    }
}

fn month_of(tok: &str) -> Option<i64> {
    let l = tok.to_ascii_lowercase();
    let names = defaults::list("codex_handover.months");
    names.iter().position(|n| l == *n || (l.len() == 3 && n.starts_with(l.as_str()))).map(|i| i as i64 + 1)
}

fn is_weekday(tok: &str) -> bool {
    let l = tok.to_ascii_lowercase();
    defaults::list("codex_handover.weekdays").iter().any(|n| l == *n || (l.len() == 3 && n.starts_with(l.as_str())))
}

fn all_digits(s: &str, min: usize, max: usize) -> bool {
    (min..=max).contains(&s.len()) && s.bytes().all(|b| b.is_ascii_digit())
}

/// ISO 8601 as the ECMAScript date-time string format defines it.
fn parse_iso(s: &str) -> Parsed {
    let b = s.as_bytes();
    let (neg_year, mut i, ylen) = match b.first() {
        Some(b'+') | Some(b'-') => (b[0] == b'-', 1usize, 6usize),
        _ => (false, 0usize, 4usize),
    };
    if b.len() < i + ylen + 6 || !all_digits(&s[i..i + ylen], ylen, ylen) {
        return Parsed::Unknown;
    }
    let mut y: i64 = s[i..i + ylen].parse().unwrap_or(0);
    if neg_year {
        if y == 0 {
            return Parsed::Unknown; // -000000 is not a valid year
        }
        y = -y;
    }
    i += ylen;
    let field = |at: usize, sep: u8| -> Option<i64> {
        (b.get(at) == Some(&sep) && all_digits(s.get(at + 1..at + 3)?, 2, 2)).then(|| s[at + 1..at + 3].parse().unwrap_or(-1))
    };
    let (Some(mo), Some(d)) = (field(i, b'-'), field(i + 3, b'-')) else { return Parsed::Unknown };
    if !(1..=12).contains(&mo) || d < 1 || d > days_in_month(y, mo) {
        return Parsed::Unknown;
    }
    i += 6;
    let date_ms = |h: i64, mi: i64, sec: i64, ms: i64| (days_from_civil(y, mo, d) * 86_400_000 + h * 3_600_000 + mi * 60_000 + sec * 1000 + ms) as f64;
    if i == b.len() {
        return Parsed::Ms(date_ms(0, 0, 0, 0));
    }
    if b[i] != b'T' {
        return Parsed::Unknown;
    }
    let (Some(h), Some(mi)) = (field(i, b'T'), field(i + 3, b':')) else { return Parsed::Unknown };
    i += 6;
    let (mut sec, mut ms) = (0, 0);
    if b.get(i) == Some(&b':') {
        let Some(sv) = field(i, b':') else { return Parsed::Unknown };
        sec = sv;
        i += 3;
        if b.get(i) == Some(&b'.') {
            let st = i + 1;
            let mut e = st;
            while e < b.len() && b[e].is_ascii_digit() {
                e += 1;
            }
            if e == st {
                return Parsed::Unknown;
            }
            let frac = &s[st..e];
            ms = format!("{:0<3}", &frac[..frac.len().min(3)]).parse().unwrap_or(0);
            i = e;
        }
    }
    if h > 23 || mi > 59 || sec > 59 {
        return Parsed::Unknown;
    }
    let offset = match &s[i..] {
        "" => None,
        "Z" => Some(0),
        z if z.len() == 6
            && (z.starts_with('+') || z.starts_with('-'))
            && z.as_bytes()[3] == b':'
            && all_digits(&z[1..3], 2, 2)
            && all_digits(&z[4..6], 2, 2) =>
        {
            let (oh, om): (i64, i64) = (z[1..3].parse().unwrap_or(99), z[4..6].parse().unwrap_or(99));
            if oh > 23 || om > 59 {
                return Parsed::Unknown;
            }
            let v = oh * 60 + om;
            Some(if z.starts_with('-') { -v } else { v })
        }
        _ => return Parsed::Unknown,
    };
    match offset {
        Some(o) => Parsed::Ms(date_ms(h, mi, sec, ms) - (o * 60_000) as f64),
        None => local_to_ms(y, mo, d, h, mi, sec).map_or(Parsed::Unknown, |m| Parsed::Ms(m + ms as f64)),
    }
}

/// `Mon D, YYYY [H:MM[:SS] [AM|PM]] [UTC|GMT|Z]`, optionally led by a weekday name.
fn parse_legacy(s: &str) -> Parsed {
    let toks: Vec<&str> = s.split([' ', ',']).filter(|t| !t.is_empty()).collect();
    let mut it = toks.iter().copied().peekable();
    if it.peek().is_some_and(|t| is_weekday(t)) {
        it.next();
    }
    let Some(mo) = it.next().and_then(month_of) else { return Parsed::Unknown };
    let Some(d) = it.next().filter(|t| all_digits(t, 1, 2)).and_then(|t| t.parse::<i64>().ok()) else { return Parsed::Unknown };
    let Some(y) = it.next().filter(|t| all_digits(t, 4, 4)).and_then(|t| t.parse::<i64>().ok()) else { return Parsed::Unknown };
    if !(1..=31).contains(&d) {
        return Parsed::Unknown;
    }
    let (mut h, mut mi, mut sec) = (0i64, 0i64, 0i64);
    let mut meridiem: Option<bool> = None;
    if it.peek().is_some_and(|t| t.contains(':')) {
        let t = it.next().unwrap_or("");
        let parts: Vec<&str> = t.split(':').collect();
        if !(2..=3).contains(&parts.len()) || !all_digits(parts[0], 1, 2) || !all_digits(parts[1], 2, 2) || parts.get(2).is_some_and(|p| !all_digits(p, 2, 2)) {
            return Parsed::Unknown;
        }
        h = parts[0].parse().unwrap_or(99);
        mi = parts[1].parse().unwrap_or(99);
        sec = parts.get(2).map_or(0, |p| p.parse().unwrap_or(99));
        if mi > 59 || sec > 59 {
            return Parsed::Unknown;
        }
        if let Some(t) = it.peek().copied()
            && (t.eq_ignore_ascii_case("am") || t.eq_ignore_ascii_case("pm"))
        {
            meridiem = Some(t.eq_ignore_ascii_case("pm"));
            it.next();
        }
        match meridiem {
            Some(pm) => {
                if !(1..=12).contains(&h) {
                    return Parsed::Unknown;
                }
                h = h % 12 + if pm { 12 } else { 0 };
            }
            None if h > 23 => return Parsed::Unknown,
            None => {}
        }
    }
    let mut utc = false;
    if let Some(t) = it.peek().copied()
        && defaults::list("codex_handover.utc_words").iter().any(|z| t.eq_ignore_ascii_case(z))
    {
        utc = true;
        it.next();
    }
    if it.next().is_some() {
        return Parsed::Unknown;
    }
    let days = days_from_civil(y, mo, d);
    // Day overflow past the month's end (Feb 31) rolls into the next month in V8; the roll is reproduced by the day count.
    let wall = |days: i64| days * 86_400_000 + h * 3_600_000 + mi * 60_000 + sec * 1000;
    if utc {
        return Parsed::Ms(wall(days) as f64);
    }
    let (ry, rm, rd) = civil_from_days(days);
    local_to_ms(ry, rm, rd, h, mi, sec).map_or(Parsed::Unknown, Parsed::Ms)
}

/// `Date.parse(s)` where the result is certain; see the module docs.
pub fn parse(s: &str) -> Parsed {
    if !s.bytes().any(|b| b.is_ascii_digit()) {
        return Parsed::Nan;
    }
    if s.starts_with(|c: char| c.is_ascii_digit()) || s.starts_with(['+', '-']) {
        return parse_iso(s);
    }
    parse_legacy(s)
}
