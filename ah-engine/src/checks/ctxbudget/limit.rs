//! `limit-conserve-inject` (UserPromptSubmit): ports the quiet case of `hooks/limit-conserve-inject.js` with
//! `hooks/limit-conserve.js` `isConserving`.
//!
//! Conservation is active when the mode is `on`, or when `auto` and a usage bucket of the OMC cache is at or over the
//! threshold. Then the Node hook builds the directive, checks the account-switch state file (which it also writes) and
//! asks emit-dedupe whether to send it (which writes too), so an active conservation defers. Everything else prints the
//! empty context line.
use super::setting::get;
use super::{Jf, judge_child, now_ms, read_json, settings_of, ups_empty};
use crate::checks::Verdict;
use crate::checks::guardkit::settings::is_skipped;
use crate::defaults;
use crate::reqenv::RequestEnv;
use serde_json::Value;

/// `new Date(s).getTime()` for the ISO 8601 form with a `T`, seconds and a `Z` or numeric offset (the form every usage
/// cache carries). `None` for any other text, which JavaScript's lenient parser may or may not accept, so the caller defers.
///
/// A day past the end of its month rolls over, as V8 does ("2026-02-30" is March 2).
pub fn iso_ms(s: &str) -> Option<f64> {
    let b = s.as_bytes();
    let digits = |from: usize, n: usize| -> Option<i64> {
        let part = b.get(from..from + n)?;
        part.iter().all(u8::is_ascii_digit).then(|| part.iter().fold(0i64, |a, d| a * 10 + i64::from(d - b'0')))
    };
    let sep = |at: usize, c: u8| b.get(at) == Some(&c);
    if !(sep(4, b'-') && sep(7, b'-') && sep(10, b'T') && sep(13, b':') && sep(16, b':')) {
        return None;
    }
    let (y, mo, d, h, mi, sec) = (digits(0, 4)?, digits(5, 2)?, digits(8, 2)?, digits(11, 2)?, digits(14, 2)?, digits(17, 2)?);
    if !(1..=12).contains(&mo) || !(1..=31).contains(&d) || h > 23 || mi > 59 || sec > 59 {
        return None;
    }
    let mut at = 19;
    let mut frac_ms = 0i64;
    if sep(at, b'.') {
        let n = b[at + 1..].iter().take_while(|c| c.is_ascii_digit()).count();
        if n == 0 {
            return None;
        }
        let first3: Vec<u8> = b[at + 1..at + 1 + n].iter().copied().chain(std::iter::repeat(b'0')).take(3).collect();
        frac_ms = first3.iter().fold(0i64, |a, d| a * 10 + i64::from(d - b'0'));
        at += 1 + n;
    }
    let offset_min = match b.get(at) {
        Some(b'Z') if at + 1 == b.len() => 0,
        Some(sign @ (b'+' | b'-')) if at + 6 == b.len() && sep(at + 3, b':') => {
            let (oh, om) = (digits(at + 1, 2)?, digits(at + 4, 2)?);
            if oh > 23 || om > 59 {
                return None;
            }
            let m = oh * 60 + om;
            if *sign == b'+' { m } else { -m }
        }
        _ => return None,
    };
    // days from the civil date (proleptic Gregorian), the day of month added afterwards so that it rolls over
    let (yy, mm) = if mo <= 2 { (y - 1, mo + 9) } else { (y, mo - 3) };
    let era = yy.div_euclid(400);
    let yoe = yy - era * 400;
    let doy = (153 * mm + 2) / 5;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146_097 + doe - 719_468 + (d - 1);
    let secs = days * 86_400 + h * 3600 + mi * 60 + sec - offset_min * 60;
    Some((secs * 1000 + frac_ms) as f64)
}

/// `effectivePct`: a bucket whose reset time has passed counts as 0, and so does one with no usable reset time in a
/// snapshot older than the bound. `Err` when the reset text is not in the form [`iso_ms`] reads.
fn effective(pct: Option<&Value>, resets_at: Option<&Value>, ts: f64, now: f64) -> Result<f64, ()> {
    match resets_at.and_then(Value::as_str).filter(|s| !s.is_empty()) {
        Some(s) => {
            if iso_ms(s).ok_or(())? < now {
                return Ok(0.0);
            }
        }
        None if ts > 0.0 && now - ts > defaults::num("ctxbudget.usage_max_stale_ms") as f64 => return Ok(0.0),
        None => {}
    }
    Ok(pct.and_then(Value::as_f64).unwrap_or(0.0))
}

/// The check's decision on one payload.
pub fn decide(_p: &Value, env: &RequestEnv) -> Verdict {
    if judge_child(env) {
        return Verdict::Allow;
    }
    let Some(st) = settings_of(env) else { return Verdict::Defer };
    if is_skipped(&st, defaults::text("ctxbudget.skip_limit_conserve")) {
        return ups_empty();
    }
    match get(&st, defaults::raw("ctxbudget.set_limit_mode")) {
        super::setting::Sv::Str(m) if m == "on" => return Verdict::Defer,
        super::setting::Sv::Str(m) if m == "off" => return ups_empty(),
        _ => {}
    }
    let threshold = get(&st, defaults::raw("ctxbudget.set_limit_threshold")).num();
    let parsed = match read_json(&format!("{}/{}", st.home, defaults::text("ctxbudget.usage_cache"))) {
        Jf::Ok(v) => v,
        Jf::Bad => return ups_empty(),
        Jf::Hazard => return Verdict::Defer,
    };
    let Some(d) = parsed.get("data").filter(|d| d.is_object() || d.is_array()) else { return ups_empty() };
    let ts = parsed.get("timestamp").and_then(Value::as_f64).unwrap_or(0.0);
    let now = now_ms();
    for (pct, resets) in [("fiveHourPercent", "fiveHourResetsAt"), ("weeklyPercent", "weeklyResetsAt"), ("sonnetWeeklyPercent", "sonnetWeeklyResetsAt")] {
        match effective(d.get(pct), d.get(resets), ts, now) {
            Ok(v) if v >= threshold => return Verdict::Defer,
            Ok(_) => {}
            Err(()) => return Verdict::Defer,
        }
    }
    ups_empty()
}

super::check_impl!(LimitConserveInject, "limit-conserve-inject", "ctxbudget.summary_limit_conserve", decide);
