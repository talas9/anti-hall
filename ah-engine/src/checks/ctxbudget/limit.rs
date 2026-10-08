//! `limit-conserve-inject` (UserPromptSubmit): a port of `hooks/limit-conserve-inject.js` with `hooks/limit-conserve.js`
//! `isConserving`.
//!
//! Conservation is active when the mode is `on`, or when `auto` and a usage bucket of the OMC cache is at or over the
//! threshold and the account-switch guard does not hold the reading stale. Then the directive is built and emit-dedupe
//! decides whether to send it this turn; everything else prints the empty context line. The account-switch state file
//! (`~/.anti-hall/limit-conserve-account.json`) is read and written as Node does (a plain write, no temporary file).
//!
//! Every case the engine cannot settle exactly defers before anything is written: a reset time JavaScript's lenient
//! date parser might read differently, a non-text reset value, a state file only Node's parser accepts, a relative
//! transcript path. One deferral can come after the account-switch write, from emit-dedupe; that write is idempotent (the
//! Node hook then finds the very state it would have written itself and writes nothing), so the end state is Node's.
use super::setting::get;
use super::{Jf, judge_child, now_ms, read_json, settings_of, ups_empty};
use crate::checks::Verdict;
use crate::checks::emit_dedupe::{self, Opts};
use crate::checks::git::util::Settings;
use crate::checks::guardkit::msg::{self, Kind, Parts};
use crate::checks::guardkit::settings::is_skipped;
use crate::checks::replykit::json::{js_number, quote};
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

/// A JavaScript truthiness test of a JSON value.
fn truthy(v: Option<&Value>) -> bool {
    match v {
        None | Some(Value::Null) => false,
        Some(Value::Bool(b)) => *b,
        Some(Value::Number(n)) => n.as_f64().is_some_and(|f| f != 0.0),
        Some(Value::String(s)) => !s.is_empty(),
        Some(_) => true,
    }
}

/// An active conservation: the reason and the earliest reset time of the tripped buckets.
struct Active {
    reason: String,
    resets_at: Option<String>,
}

/// The three home-derived files of `pathsFor`.
fn path_of(st: &Settings, key: &str) -> String {
    format!("{}/{}", st.home, defaults::text(key))
}

/// `fs.statSync(file).mtimeMs`: seconds times 1000 plus nanoseconds over 1e6, as Node computes it. `None` when the file
/// cannot be stat'ed; `Err` for a time before the epoch (not reproduced here).
fn mtime_ms(path: &str) -> Result<Option<f64>, ()> {
    let Ok(m) = std::fs::metadata(path).and_then(|m| m.modified()) else { return Ok(None) };
    let d = m.duration_since(std::time::UNIX_EPOCH).map_err(|_| ())?;
    Ok(Some(d.as_secs() as f64 * 1000.0 + f64::from(d.subsec_nanos()) / 1e6))
}

/// `writeAccountState`: best effort, a plain write after creating the directory.
fn write_account(path: &str, user: &str, mtime: Option<f64>) {
    let body = msg::render(
        "ctxbudget.lc_account_json",
        &[("user", &quote(user)), ("mtime", &mtime.map_or_else(|| defaults::text("ctxbudget.json_null").to_string(), js_number))],
    );
    let p = std::path::Path::new(path);
    let ok = p.parent().is_none_or(|d| std::fs::create_dir_all(d).is_ok()) && crate::atomic::write(p, body).is_ok();
    if !ok {
        crate::discard::note("limit_conserve_account_write", "");
    }
}

/// `isAccountSwitchStale`: true when the logged-in account changed and the usage cache has not been refreshed since.
/// Writes the account state where Node does. `Err` (before any write) when a file needs the Node parser.
fn account_switch_stale(st: &Settings) -> Result<bool, ()> {
    if get(st, defaults::raw("ctxbudget.set_limit_account_check")) == super::setting::Sv::Bool(false) {
        return Ok(false);
    }
    let user = match read_json(&path_of(st, "ctxbudget.claude_json")) {
        Jf::Ok(v) => v.get("userID").and_then(Value::as_str).map(str::to_string),
        Jf::Bad => None,
        Jf::Hazard => return Err(()),
    };
    let Some(user) = user else { return Ok(false) };
    let account = path_of(st, "ctxbudget.account_state");
    let stored = match read_json(&account) {
        Jf::Ok(v) => match (v.get("userID").and_then(Value::as_str), v.get("usageCacheMtime").and_then(Value::as_f64)) {
            (Some(u), Some(m)) if v.is_object() || v.is_array() => Some((u.to_string(), m)),
            _ => None,
        },
        Jf::Bad => None,
        Jf::Hazard => return Err(()),
    };
    let mtime = mtime_ms(&path_of(st, "ctxbudget.usage_cache"))?;
    let Some((stored_user, stored_mtime)) = stored else {
        write_account(&account, &user, mtime);
        return Ok(false);
    };
    if stored_user != user {
        if mtime.is_some_and(|m| m <= stored_mtime) {
            return Ok(true);
        }
        write_account(&account, &user, mtime);
        return Ok(false);
    }
    if let Some(m) = mtime
        && m != stored_mtime
    {
        write_account(&account, &user, Some(m));
    }
    Ok(false)
}

/// `isConserving().active` with its reason and reset time. `Err` = defer, always before any write; `hold` is a deferral
/// the caller needs whenever conservation may be active.
fn conserving(st: &Settings, hold: bool) -> Result<Option<Active>, ()> {
    match get(st, defaults::raw("ctxbudget.set_limit_mode")) {
        super::setting::Sv::Str(m) if m == "on" && hold => return Err(()),
        super::setting::Sv::Str(m) if m == "on" => {
            return Ok(Some(Active { reason: defaults::text("ctxbudget.lc_reason_manual").to_string(), resets_at: None }));
        }
        super::setting::Sv::Str(m) if m == "off" => return Ok(None),
        _ => {}
    }
    let threshold = get(st, defaults::raw("ctxbudget.set_limit_threshold")).num();
    let parsed = match read_json(&path_of(st, "ctxbudget.usage_cache")) {
        Jf::Ok(v) => v,
        Jf::Bad => return Ok(None),
        Jf::Hazard => return Err(()),
    };
    let Some(d) = parsed.get("data").filter(|d| d.is_object() || d.is_array()) else { return Ok(None) };
    let ts = parsed.get("timestamp").and_then(Value::as_f64).unwrap_or(0.0);
    let now = now_ms();
    let (pcts, resets, names) =
        (defaults::list("ctxbudget.lc_bucket_pct"), defaults::list("ctxbudget.lc_bucket_resets"), defaults::list("ctxbudget.lc_bucket_trip"));
    let mut trips = Vec::new();
    let mut candidates: Vec<(f64, String)> = Vec::new();
    for ((pct, reset), name) in pcts.iter().zip(&resets).zip(&names) {
        if effective(d.get(*pct), d.get(*reset), ts, now)? < threshold {
            continue;
        }
        trips.push(*name);
        let r = d.get(*reset);
        if truthy(r) {
            // a reset that is not text reaches the directive through String(); not reproduced here
            let s = r.and_then(Value::as_str).ok_or(())?;
            candidates.push((iso_ms(s).ok_or(())?, s.to_string()));
        }
    }
    if !trips.is_empty() && hold {
        return Err(());
    }
    if trips.is_empty() || account_switch_stale(st)? {
        return Ok(None);
    }
    candidates.sort_by(|a, b| a.0.total_cmp(&b.0));
    Ok(Some(Active { reason: trips.join("+"), resets_at: candidates.into_iter().next().map(|c| c.1) }))
}

/// `buildDirective(state)`.
fn directive(a: &Active) -> String {
    let resets = match &a.resets_at {
        Some(r) => msg::render("ctxbudget.lc_resets_at", &[("at", r)]),
        None => defaults::text("ctxbudget.lc_resets_next").to_string(),
    };
    let what = msg::render("ctxbudget.lc_what", &[("reason", &a.reason)]);
    let instead = format!("{}{resets} {}", defaults::text("ctxbudget.lc_instead"), defaults::text("ctxbudget.lc_downshift"));
    msg::message(
        Kind::Warn,
        defaults::text("ctxbudget.lc_guard"),
        &Parts { what: &what, why: defaults::text("ctxbudget.lc_why"), instead: &instead, ..Parts::default() },
    )
}

/// The check's decision on one payload.
pub fn decide(p: &Value, env: &RequestEnv) -> Verdict {
    if judge_child(env) {
        return Verdict::Allow;
    }
    let Some(st) = settings_of(env) else { return Verdict::Defer };
    if is_skipped(&st, defaults::text("ctxbudget.skip_limit_conserve")) {
        return ups_empty();
    }
    // `typeof payload.transcript_path === 'string'`; a relative one is Node's to resolve (emit-dedupe reads it), which
    // is settled before any write
    let transcript = p.get("transcript_path").and_then(Value::as_str).filter(|s| !s.is_empty());
    let relative = transcript.is_some_and(|t| !t.starts_with('/'));
    let active = match conserving(&st, relative) {
        Ok(Some(a)) => a,
        Ok(None) => return ups_empty(),
        Err(()) => return Verdict::Defer,
    };
    let text = directive(&active);
    let emit = match p.get("session_id").and_then(Value::as_str) {
        Some(sid) => emit_dedupe::should_emit(
            &st,
            &Opts {
                session_id: sid,
                key: defaults::text("ctxbudget.lc_dedupe_key"),
                content: &text,
                transcript_path: transcript,
                keepalive: defaults::num("ctxbudget.lc_keepalive_turns") as f64,
                normalize: &|t| t.to_string(),
            },
        ),
        None => Ok(true),
    };
    match emit {
        Ok(true) => Verdict::Exact(crate::checks::Exact { code: 0, out: msg::render("ctxbudget.ups_line", &[("text", &quote(&text))]), err: String::new() }),
        Ok(false) => ups_empty(),
        Err(emit_dedupe::Defer) => Verdict::Defer,
    }
}

super::check_impl!(LimitConserveInject, "limit-conserve-inject", "ctxbudget.summary_limit_conserve", decide);
