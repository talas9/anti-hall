//! The weekly funnel report (B4, plan v2 section 6): the time window of `telemetry funnel` / `telemetry report`, and the latency and
//! failure sections that sit beside the funnel.
//!
//! Nothing here records anything. A window is the end snapshot less the start snapshot, where both are the metrics snapshots the
//! engine already stores (`telemetry.rollups`; every snapshot holds the counters AND the latency histograms), so a histogram's
//! window is a bucket-wise difference. The start is the last snapshot of its rollup bucket at or before the asked start, so the
//! window can begin up to one bucket early; the report prints the real start (`baseline_ms`) and how far it is from the asked one.
//!
//! The report is a pure read and every figure it cannot prove is marked: [`Diff`] compares the two snapshots once (per counter series,
//! per histogram bucket) and a series that went down or vanished is a reset, a series it cannot compare is a mismatch; both mark the
//! check they belong to `partial` in the funnel, latency and failure sections and make the window incomplete. Input parsing and the
//! arithmetic are checked and bounded (no panic, no loop over years, no unchecked `u64` sum, no float in a rank).
//! Every unit, list, switch and text comes from the plugin's TOML (`delivery.report_*`).
// Discard triage (E3): every `.ok()` / `unwrap_or_default()` in this file is a deliberate keep, for these reasons:
// - an absent field is the empty value
// A failure that must be seen goes through `crate::discard` instead.

use crate::defaults;
use serde_json::{Map, Value, json};
use std::cell::Cell;
use std::collections::{BTreeMap, BTreeSet};

/// The window asked for, in absolute milliseconds. `from` `None` is lifetime; `to` `None` is now.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Span {
    /// The start (epoch ms); `None` is lifetime.
    pub from_ms: Option<u64>,
    /// The end (epoch ms); `None` is now.
    pub to_ms: Option<u64>,
}

/// Whether the report switch (`delivery.report_enabled`) is on.
pub fn enabled() -> bool {
    defaults::num("delivery.report_enabled") != 0
}

fn unit_ms(unit: &str) -> u64 {
    defaults::raw("delivery.report_window_units").get(unit).and_then(defaults::V::as_integer).and_then(|v| u64::try_from(v).ok()).unwrap_or(0)
}

fn units_list() -> String {
    defaults::raw("delivery.report_window_units").as_table().map(|t| t.iter().map(|(k, _)| *k).collect::<Vec<_>>().join(", ")).unwrap_or_default()
}

/// Input that is empty, non-ASCII or longer than `delivery.report_input_max_len` is never a window or a time.
fn bounded(s: &str) -> bool {
    !s.is_empty() && s.len() <= defaults::num("delivery.report_input_max_len") as usize && s.is_ascii()
}

/// A window length such as `6h`, `90m`, `7d` or a bare number (`delivery.report_bare_unit`) in ms; `None` when it is neither, is 0, or
/// does not fit.
pub fn parse_duration_ms(s: &str) -> Option<u64> {
    let s = s.trim();
    if !bounded(s) {
        return None;
    }
    let digits = s.bytes().take_while(u8::is_ascii_digit).count();
    let (num, unit) = s.split_at(digits);
    let n: u64 = num.parse().ok()?;
    let per = unit_ms(if unit.is_empty() { defaults::text("delivery.report_bare_unit") } else { unit });
    if per == 0 || n == 0 {
        return None;
    }
    n.checked_mul(per)
}

fn is_leap(y: i64) -> bool {
    (y % 4 == 0 && y % 100 != 0) || y % 400 == 0
}

fn days_in_month(y: i64, m: i64) -> Option<i64> {
    Some(match m {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 if is_leap(y) => 29,
        2 => 28,
        _ => return None,
    })
}

/// Days from 0001-01-01 to a civil date (no loop over years; at most 11 months are added); `None` for a month outside 1 ..= 12.
fn ordinal_days(y: i64, m: i64, d: i64) -> Option<i64> {
    let months = (1..m).map(|mm| days_in_month(y, mm)).sum::<Option<i64>>()?;
    let _ = days_in_month(y, m)?;
    let before = y.checked_sub(1)?;
    before.checked_mul(365)?.checked_add(before / 4)?.checked_sub(before / 100)?.checked_add(before / 400)?.checked_add(months)?.checked_add(d - 1)
}

/// Days since the epoch (1 January of `delivery.report_epoch_year`) of a civil date, `None` for an impossible one or a year outside
/// `delivery.report_epoch_year` ..= `delivery.report_max_year`.
fn days_from_civil(y: i64, m: i64, d: i64) -> Option<i64> {
    let (epoch, last) = (i64::try_from(defaults::num("delivery.report_epoch_year")).ok()?, i64::try_from(defaults::num("delivery.report_max_year")).ok()?);
    if !(epoch..=last).contains(&y) || !(1..=days_in_month(y, m)?).contains(&d) {
        return None;
    }
    ordinal_days(y, m, d)?.checked_sub(ordinal_days(epoch, 1, 1)?)
}

/// The first millisecond after the last year a time may name (`delivery.report_max_year`): every parsed time is below it.
fn time_limit_ms() -> Option<u64> {
    let last = i64::try_from(defaults::num("delivery.report_max_year")).ok()?;
    let epoch = i64::try_from(defaults::num("delivery.report_epoch_year")).ok()?;
    let days = ordinal_days(last.checked_add(1)?, 1, 1)?.checked_sub(ordinal_days(epoch, 1, 1)?)?;
    u64::try_from(days).ok()?.checked_mul(unit_ms("d"))
}

/// A field of exactly `width` ASCII digits.
fn field(s: &str, width: usize) -> Option<i64> {
    if s.len() != width || !s.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    s.parse().ok()
}

/// An absolute time in epoch ms: epoch seconds or milliseconds (a number of `delivery.report_epoch_ms_digits` or more digits is ms), or
/// RFC 3339 (`2026-11-01T09:30:00Z`, `...+04:00`; a date alone is midnight UTC; no zone means UTC). Every field has its fixed width,
/// the offset is within a day, the year is within `delivery.report_epoch_year` ..= `delivery.report_max_year`, and the input is ASCII
/// of at most `delivery.report_input_max_len` bytes; anything else is `None`.
pub fn parse_time_ms(s: &str) -> Option<u64> {
    let s = s.trim();
    if !bounded(s) {
        return None;
    }
    let limit = time_limit_ms()?;
    if s.bytes().all(|b| b.is_ascii_digit()) {
        let n: u64 = s.parse().ok()?;
        let ms = if s.len() >= defaults::num("delivery.report_epoch_ms_digits") as usize { n } else { n.checked_mul(unit_ms("s"))? };
        return (ms < limit).then_some(ms);
    }
    let (date, time) = match s.split_once('T') {
        Some((d, t)) => (d, Some(t)),
        None => (s, None),
    };
    // the clock's limits come from the unit table: hours in a day, minutes in an hour, seconds in a minute (a leap second is the 60th)
    let per = |big: &str, small: &str| i64::try_from(unit_ms(big).checked_div(unit_ms(small))?).ok();
    let (hours, minutes, seconds) = (per("d", "h")?, per("h", "m")?, per("m", "s")?);
    let dp: Vec<&str> = date.split('-').collect();
    let [y, m, d] = dp.as_slice() else { return None };
    let mut secs = days_from_civil(field(y, 4)?, field(m, 2)?, field(d, 2)?)?.checked_mul(86_400)?;
    let mut ms = 0i64;
    if let Some(t) = time {
        let (clock, off) = if let Some(c) = t.strip_suffix('Z') {
            (c, 0)
        } else if let Some(i) = t.find(['+', '-']) {
            let sign = if t.as_bytes()[i] == b'-' { -1 } else { 1 };
            let (hh, mm) = t[i + 1..].split_once(':')?;
            let (hh, mm) = (field(hh, 2)?, field(mm, 2)?);
            if hh >= hours || mm >= minutes {
                return None;
            }
            (&t[..i], sign * (hh * 3600 + mm * 60))
        } else {
            (t, 0)
        };
        let parts: Vec<&str> = clock.split(':').collect();
        let (h, mi, sec) = match parts.as_slice() {
            [h, mi] => (*h, *mi, "00"),
            [h, mi, sec] => (*h, *mi, *sec),
            _ => return None,
        };
        let (whole, frac) = match sec.split_once('.') {
            Some((w, f)) if !f.is_empty() && f.bytes().all(|b| b.is_ascii_digit()) => (w, f),
            Some(_) => return None,
            None => (sec, ""),
        };
        let (h, mi, sc) = (field(h, 2)?, field(mi, 2)?, field(whole, 2)?);
        if h >= hours || mi >= minutes || sc > seconds {
            return None;
        }
        if !frac.is_empty() {
            ms = format!("{frac:0<3}")[..3].parse().ok()?;
        }
        secs = secs.checked_add(h * 3600 + mi * 60 + sc)?.checked_sub(off)?;
    }
    let total = u64::try_from(secs).ok()?.checked_mul(unit_ms("s"))?.checked_add(u64::try_from(ms).ok()?)?;
    (total < limit).then_some(total)
}

/// The window asked for by `--since` (or the older `--window`), `--from` and `--to`, against `now`. All empty is lifetime.
pub fn resolve_span(since: &str, from: &str, to: &str, now: u64) -> Result<Span, String> {
    let bad = |why: &str| defaults::render("delivery.report_bad_range", &[("why", &why)]);
    if !since.trim().is_empty() && !from.trim().is_empty() {
        return Err(bad(defaults::text("delivery.report_why_both")));
    }
    let time = |flag: &str, v: &str| -> Result<Option<u64>, String> {
        if v.trim().is_empty() {
            return Ok(None);
        }
        parse_time_ms(v).map(Some).ok_or_else(|| defaults::render("delivery.report_bad_time", &[("flag", &flag), ("value", &v)]))
    };
    let from_ms = if since.trim().is_empty() {
        time("--from", from)?
    } else {
        let d =
            parse_duration_ms(since).ok_or_else(|| defaults::render("delivery.report_bad_window", &[("window", &since.trim()), ("units", &units_list())]))?;
        Some(now.saturating_sub(d))
    };
    let to_ms = time("--to", to)?.filter(|t| *t < now);
    if let Some(f) = from_ms {
        if f > now {
            return Err(bad(defaults::text("delivery.report_why_future")));
        }
        if to_ms.is_some_and(|t| f >= t) {
            return Err(bad(defaults::text("delivery.report_why_order")));
        }
    }
    Ok(Span { from_ms, to_ms })
}

/// The finest rollup resolution (`telemetry.rollups`) that still keeps a snapshot as old as `age_ms`; the coarsest when none does.
pub fn pick_resolution(age_ms: u64) -> Option<&'static str> {
    let mut all = crate::storage::resolutions();
    all.sort_by_key(|r| r.1);
    all.iter().find(|r| r.2 >= age_ms).or(all.last()).map(|r| r.0)
}

/// Split a series key `name|l=v|l=v` into its name and labels.
pub fn parse_key(k: &str) -> (&str, BTreeMap<&str, &str>) {
    let mut it = k.split('|');
    let name = it.next().unwrap_or("");
    (name, it.filter_map(|kv| kv.split_once('=')).collect())
}

/// A counter's window figure: end less start; when the end is below the start the counter restarted, so the end value stands and the
/// second answer is true.
pub fn delta(end: u64, start: u64) -> (u64, bool) {
    if end >= start { (end - start, false) } else { (end, true) }
}

/// One histogram of a snapshot: buckets, count, max.
struct Hist {
    buckets: Vec<u64>,
    count: u64,
    max: u64,
}

/// The counters of a snapshot and how many series could not be read (a value that is not a count).
fn read_counters(snap: &Value) -> (BTreeMap<String, u64>, usize) {
    let Some(m) = snap.get("counters").and_then(Value::as_object) else { return (BTreeMap::new(), 0) };
    let (mut ok, mut bad) = (BTreeMap::new(), 0);
    for (k, v) in m {
        match v.as_u64() {
            Some(n) => {
                ok.insert(k.clone(), n);
            }
            None => bad += 1,
        }
    }
    (ok, bad)
}

/// The histograms of a snapshot and how many series could not be read (buckets or count that are not counts).
fn read_hists(snap: &Value) -> (BTreeMap<String, Hist>, usize) {
    let Some(m) = snap.get("histograms").and_then(Value::as_object) else { return (BTreeMap::new(), 0) };
    let (mut out, mut bad) = (BTreeMap::new(), 0);
    for (k, x) in m {
        let buckets: Option<Vec<u64>> = x.get("buckets").and_then(Value::as_array).and_then(|a| a.iter().map(Value::as_u64).collect());
        match (buckets, x.get("count").and_then(Value::as_u64)) {
            (Some(buckets), Some(count)) => {
                out.insert(k.clone(), Hist { buckets, count, max: x.get("max").and_then(Value::as_u64).unwrap_or(0) });
            }
            _ => bad += 1,
        }
    }
    (out, bad)
}

/// One counter series of a window: its figure is end less start, or the end value when the series restarted (`reset`).
#[derive(Debug, Clone)]
pub struct Series {
    /// The metric name.
    pub name: String,
    /// Its labels.
    pub labels: BTreeMap<String, String>,
    /// The window figure.
    pub value: u64,
    /// The series went down between the two snapshots, so the figure is the end value, not a difference.
    pub reset: bool,
}

/// One histogram of a window, bucket by bucket.
#[derive(Debug, Clone)]
pub struct HistWin {
    /// The window's count per bucket (the end buckets whole when the series restarted or could not be compared).
    pub buckets: Vec<u64>,
    /// The end snapshot's largest value.
    pub max: u64,
    /// True when `max` was seen inside the window (it grew, or there is no start to compare with).
    pub max_new: bool,
}

/// The window between two snapshots, computed once for every section of a report: every counter series and every histogram bucket
/// is compared with its start value. A series that went down (a counter, or any one bucket or the count of a histogram), or that the
/// start has and the end lost, is a RESET: it is counted in `resets` and the check it belongs to is `partial`, so every figure derived
/// from it is marked. A histogram whose bucket layout differs, or a value that is not a count, is `mismatched` and marks its check the
/// same way. All sums are checked: past `u64` they stop at the maximum and `saturated` is set.
#[derive(Debug, Default)]
pub struct Diff {
    /// The end snapshot's counter series.
    pub series: Vec<Series>,
    /// The end snapshot's histograms, by series key.
    pub hists: BTreeMap<String, HistWin>,
    /// Series that went down or vanished between the snapshots.
    pub resets: usize,
    /// Series that could not be compared (a different bucket layout, or a value that is not a count).
    pub mismatched: usize,
    /// The checks (label `check`) with a reset or mismatched series: every figure of theirs is partial.
    pub partial_checks: BTreeSet<String>,
    /// The metric names with a reset or mismatched series (label-free engine counters included).
    pub partial_names: BTreeSet<String>,
    saturated: Cell<bool>,
}

impl Diff {
    /// The window of `end` less `start`; no start is the lifetime figures.
    pub fn new(end: &Value, start: Option<&Value>) -> Diff {
        let mut d = Diff::default();
        let (ec, eu) = read_counters(end);
        let (sc, su) = start.map(read_counters).unwrap_or_default();
        d.mismatched += eu + su;
        for (k, v) in &ec {
            let (value, reset) = match sc.get(k) {
                Some(s) => delta(*v, *s),
                None => (*v, false),
            };
            let (name, labels) = parse_key(k);
            if reset {
                d.resets += 1;
                d.mark(k);
            }
            d.series.push(Series { name: name.to_string(), labels: labels.into_iter().map(|(a, b)| (a.to_string(), b.to_string())).collect(), value, reset });
        }
        for k in sc.keys().filter(|k| !ec.contains_key(*k)) {
            d.resets += 1;
            d.mark(k);
        }
        let (eh, ehu) = read_hists(end);
        let (sh, shu) = start.map(read_hists).unwrap_or_default();
        d.mismatched += ehu + shu;
        for (k, h) in &eh {
            let (name, _) = parse_key(k);
            let layout = crate::metrics::bounds_for(name).len() + 1 == h.buckets.len();
            let (buckets, max_new) = match sh.get(k) {
                Some(b) if !layout || b.buckets.len() != h.buckets.len() => {
                    d.mismatched += 1;
                    d.mark(k);
                    (h.buckets.clone(), true)
                }
                Some(b) if h.count < b.count || h.buckets.iter().zip(&b.buckets).any(|(x, y)| x < y) => {
                    d.resets += 1;
                    d.mark(k);
                    (h.buckets.clone(), true)
                }
                Some(b) => (h.buckets.iter().zip(&b.buckets).map(|(x, y)| x - y).collect(), h.max > b.max),
                None if !layout => {
                    d.mismatched += 1;
                    d.mark(k);
                    (h.buckets.clone(), true)
                }
                None => (h.buckets.clone(), true),
            };
            d.hists.insert(k.clone(), HistWin { buckets, max: h.max, max_new });
        }
        for k in sh.keys().filter(|k| !eh.contains_key(*k)) {
            d.resets += 1;
            d.mark(k);
        }
        d
    }

    fn mark(&mut self, key: &str) {
        let (name, labels) = parse_key(key);
        self.partial_names.insert(name.to_string());
        if let Some(c) = labels.get("check") {
            self.partial_checks.insert((*c).to_string());
        }
    }

    /// True when a figure of `check` cannot be proven (one of its series restarted or could not be compared).
    pub fn is_partial(&self, check: &str) -> bool {
        self.partial_checks.contains(check)
    }

    /// True when the whole window is provable: no reset, no mismatch, no sum stopped at the maximum.
    pub fn clean(&self) -> bool {
        self.resets == 0 && self.mismatched == 0 && !self.saturated.get()
    }

    /// True when a sum stopped at `u64::MAX`.
    pub fn saturated(&self) -> bool {
        self.saturated.get()
    }

    /// `a + b`, stopping at `u64::MAX` and remembering that it did.
    pub fn add(&self, a: u64, b: u64) -> u64 {
        a.checked_add(b).unwrap_or_else(|| {
            self.saturated.set(true);
            u64::MAX
        })
    }
}

/// Milliseconds with three decimals; `null` above what a JSON number holds exactly.
fn ms(us: u64) -> Value {
    if us > (1u64 << f64::MANTISSA_DIGITS) { Value::Null } else { json!((us as f64) / 1000.0) }
}

/// The per-check latency of the window: `check_latency_us` of the window, bucket by bucket. Quantiles are the upper bound of their
/// bucket (`null` above the last bound; integer rank arithmetic); `max_ms` is the largest value seen only when it grew inside the
/// window (`max_exact`), otherwise the upper bound of the highest bucket the window used. A row is `partial` when a series of its
/// check restarted or could not be compared.
pub fn latency(d: &Diff) -> Value {
    let bounds = crate::metrics::bounds_for("check_latency_us");
    let mut rows: BTreeMap<String, Value> = BTreeMap::new();
    for (key, h) in &d.hists {
        let (name, labels) = parse_key(key);
        if name != "check_latency_us" || h.buckets.len() != bounds.len() + 1 {
            continue;
        }
        let Some(check) = labels.get("check") else { continue };
        let count = h.buckets.iter().fold(0u64, |a, n| d.add(a, *n));
        if count == 0 {
            continue;
        }
        let q = |p: u64| crate::telemetry::report::quantile(&h.buckets, &bounds, p).map_or(Value::Null, ms);
        let top = h.buckets.iter().rposition(|n| *n > 0).unwrap_or(0);
        let (max, exact) = match (top < bounds.len(), h.max_new) {
            (_, true) => (Some(h.max), true),
            (true, false) => (Some(bounds[top]), false),
            (false, false) => (None, false),
        };
        rows.insert(
            (*check).to_string(),
            json!({ "check": check, "count": count, "p50_ms": q(500), "p95_ms": q(950), "max_ms": max.map_or(Value::Null, ms), "max_exact": exact, "partial": d.is_partial(check) }),
        );
    }
    let over = bounds.last().copied().unwrap_or(0);
    json!({ "unit": "ms", "over_ms": ms(over), "note": defaults::text("delivery.report_latency_note"), "rows": rows.into_values().collect::<Vec<_>>() })
}

/// The reasons of `delivery.report_*_reason_keys`, as the words `fail_open` is counted under.
fn reason_words(list: &str) -> Vec<&'static str> {
    defaults::list(list).into_iter().map(defaults::text).collect()
}

/// The failure section of the window: per check the fail-opens by reason (`fail_open`), which of them are timeouts and which are
/// failures, the check's runs (`check_calls`), and the engine-wide error counters (`delivery.report_engine_counters`) plus the
/// answers dropped by reason. A reporting-only reason (`fail_open.reporting_reasons`: the verdict applied, only its delivery failed) is
/// kept apart and not in `total`. A row is `partial` when a series of its check restarted; `engine_partial` names the engine counters
/// that did, `answers_dropped_partial` says the dropped counts did.
pub fn failures(d: &Diff) -> Value {
    let (timeouts, fails) = (reason_words("delivery.report_timeout_reason_keys"), reason_words("delivery.report_failure_reason_keys"));
    let mut checks: BTreeMap<String, Map<String, Value>> = BTreeMap::new();
    let mut engine: BTreeMap<String, u64> = BTreeMap::new();
    let mut dropped: BTreeMap<String, u64> = BTreeMap::new();
    let wanted = defaults::list("delivery.report_engine_counters");
    let get = |row: &Map<String, Value>, k: &str| row.get(k).and_then(Value::as_u64).unwrap_or(0);
    for s in &d.series {
        let cur = s.value;
        if cur == 0 {
            continue;
        }
        match s.name.as_str() {
            "fail_open" => {
                let (Some(reason), Some(check)) = (s.labels.get("reason"), s.labels.get("check")) else { continue };
                let row = checks.entry(check.clone()).or_default();
                let by = row.entry("fail_open_by_reason").or_insert_with(|| json!({}));
                by[reason.as_str()] = json!(d.add(by.get(reason.as_str()).and_then(Value::as_u64).unwrap_or(0), cur));
                let reporting = crate::failopen::is_reporting(reason);
                let slot = if reporting { "reporting_only" } else { "fail_open" };
                let total = d.add(get(row, slot), cur);
                row.insert(slot.into(), json!(total));
                if !reporting {
                    for (class, list) in [("timeouts", &timeouts), ("failures", &fails)] {
                        if list.contains(&reason.as_str()) {
                            let t = d.add(get(row, class), cur);
                            row.insert(class.into(), json!(t));
                        }
                    }
                }
            }
            "check_calls" => {
                if let Some(check) = s.labels.get("check") {
                    checks.entry(check.clone()).or_default().insert("runs".into(), json!(cur));
                }
            }
            "answers_dropped" => {
                if let Some(reason) = s.labels.get("reason") {
                    let e = dropped.entry(reason.clone()).or_insert(0);
                    *e = d.add(*e, cur);
                }
            }
            n if s.labels.is_empty() && wanted.contains(&n) => {
                engine.insert(n.to_string(), cur);
            }
            _ => {}
        }
    }
    let rows: Vec<Value> = checks
        .into_iter()
        .filter(|(_, r)| r.contains_key("fail_open") || r.contains_key("reporting_only"))
        .map(|(check, mut r)| {
            for k in ["fail_open", "timeouts", "failures", "runs"] {
                r.entry(k).or_insert(json!(0));
            }
            r.insert("partial".into(), json!(d.is_partial(&check)));
            r.insert("check".into(), json!(check));
            Value::Object(r)
        })
        .collect();
    let totals = rows.iter().filter_map(|r| r["fail_open"].as_u64()).fold(0u64, |a, n| d.add(a, n));
    let engine_partial: Vec<&str> = wanted.iter().copied().filter(|n| d.partial_names.contains(*n)).collect();
    let dropped_partial = d.partial_names.contains("answers_dropped");
    let partial = dropped_partial || !engine_partial.is_empty() || rows.iter().any(|r| r["partial"] == true);
    json!({
        "rows": rows, "fail_open_total": totals, "engine": engine, "answers_dropped": dropped,
        "partial": partial, "engine_partial": engine_partial, "answers_dropped_partial": dropped_partial,
    })
}

fn n(v: &Value) -> String {
    match v {
        Value::Null => "-".into(),
        Value::String(t) => t.clone(),
        Value::Number(x) if x.is_f64() => format!("{}", x.as_f64().unwrap_or(0.0)),
        other => other.as_u64().map_or_else(|| other.to_string(), |x| x.to_string()),
    }
}

fn pad(rows: Vec<Vec<String>>) -> Vec<String> {
    let cols = rows.iter().map(Vec::len).max().unwrap_or(0);
    let widths: Vec<usize> = (0..cols).map(|c| rows.iter().map(|r| r.get(c).map_or(0, |s| s.chars().count())).max().unwrap_or(0)).collect();
    rows.iter().map(|r| r.iter().enumerate().map(|(i, s)| format!("{s:<w$}", w = widths[i])).collect::<Vec<_>>().join("  ").trim_end().to_string()).collect()
}

/// `key=count` pairs of a JSON object, in key order.
fn pairs(v: &Value) -> String {
    v.as_object().map(|o| o.iter().map(|(k, x)| format!("{k}={}", n(x))).collect::<Vec<_>>().join(" ")).unwrap_or_default()
}

/// The text form of a report body (`telemetry report` without `--json`): the window line, then one table per section, then the
/// output channels, the fail-open reasons and the engine counters that the JSON carries. A figure marked `partial` carries
/// `delivery.report_partial_mark` and the legend closes the report.
pub fn table(v: &Value) -> String {
    let titles = defaults::raw("delivery.report_table_titles");
    let title = |k: &str| titles.get(k).and_then(defaults::V::as_str).unwrap_or(k).to_string();
    let mark = defaults::text("delivery.report_partial_mark");
    let cap = defaults::num("delivery.report_rows_max") as usize;
    let mut out = Vec::new();
    let mut any_partial = false;
    let w = &v["funnel"]["window"];
    let stamp = |k: &str| w.get(k).and_then(Value::as_u64).map_or("-".to_string(), |x| x.to_string());
    out.push(defaults::render(
        "delivery.report_window_line",
        &[("title", &title("window")), ("start", &stamp("baseline_ms")), ("end", &stamp("end_ms")), ("from", &stamp("from_ms")), ("to", &stamp("to_ms"))],
    ));
    for k in ["note"].iter().chain(&["notes"]) {
        if let Some(a) = w.get(*k).and_then(Value::as_array) {
            out.extend(a.iter().filter_map(Value::as_str).map(|s| format!("  {s}")));
        } else if let Some(s) = w.get(*k).and_then(Value::as_str).filter(|s| !s.is_empty()) {
            out.push(format!("  {s}"));
        }
    }
    let section = |out: &mut Vec<String>, name: &str, head: Vec<String>, body: Vec<Vec<String>>| {
        out.push(String::new());
        out.push(title(name));
        let total = body.len();
        let mut rows = vec![head];
        rows.extend(body.into_iter().take(cap));
        out.extend(pad(rows).into_iter().map(|l| format!("  {l}")));
        if total > cap {
            out.push(format!("  {}", defaults::render("delivery.report_more_rows", &[("n", &(total - cap))])));
        }
    };
    let lines = |out: &mut Vec<String>, name: &str, body: Vec<String>| {
        if body.is_empty() {
            return;
        }
        out.push(String::new());
        out.push(title(name));
        let total = body.len();
        out.extend(body.into_iter().take(cap).map(|l| format!("  {l}")));
        if total > cap {
            out.push(format!("  {}", defaults::render("delivery.report_more_rows", &[("n", &(total - cap))])));
        }
    };
    let by: Vec<String> = v["funnel"]["by"].as_array().map(|a| a.iter().filter_map(Value::as_str).map(str::to_string).collect()).unwrap_or_default();
    if let Some(rows) = v["funnel"]["rows"].as_array() {
        let stages: Vec<&str> = defaults::list("delivery.report_stages");
        let mut head = vec!["check".to_string()];
        head.extend(by.clone());
        head.extend(stages.iter().map(|s| (*s).to_string()));
        head.push("acted_on_rate".into());
        let body = rows
            .iter()
            .map(|r| {
                let flag = r["partial"] == true;
                any_partial |= flag;
                let mut line = vec![format!("{}{}", n(&r["check"]), if flag { mark } else { "" })];
                line.extend(by.iter().map(|d| n(&r[d.as_str()])));
                line.extend(stages.iter().map(|s| n(&r[*s])));
                line.push(n(&r["acted_on_rate"]));
                line
            })
            .collect();
        section(&mut out, "funnel", head, body);
        let chans = rows
            .iter()
            .filter(|r| r["channels"].as_object().is_some_and(|c| !c.is_empty()))
            .map(|r| {
                let mut row = vec![n(&r["check"])];
                row.extend(by.iter().map(|d| n(&r[d.as_str()])));
                defaults::render("delivery.report_channels_line", &[("row", &row.join("/")), ("channels", &pairs(&r["channels"]))])
            })
            .collect();
        lines(&mut out, "channels", chans);
    }
    if let Some(rows) = v["latency"]["rows"].as_array() {
        let head: Vec<String> = defaults::list("delivery.report_latency_cols").into_iter().map(str::to_string).collect();
        let body = rows
            .iter()
            .map(|r| {
                let flag = r["partial"] == true;
                any_partial |= flag;
                head.iter()
                    .enumerate()
                    .map(|(i, k)| {
                        let cell = if k == "max_ms" && r["max_exact"] != true { format!("<={}", n(&r[k.as_str()])) } else { n(&r[k.as_str()]) };
                        if i == 0 && flag { format!("{cell}{mark}") } else { cell }
                    })
                    .collect()
            })
            .collect();
        section(&mut out, "latency", head, body);
        out.push(format!("  {}", v["latency"]["note"].as_str().unwrap_or("")));
    }
    if let Some(rows) = v["failures"]["rows"].as_array() {
        let cols = defaults::list("delivery.report_failure_cols");
        let head: Vec<String> = cols.iter().map(|c| (*c).to_string()).collect();
        let body = rows
            .iter()
            .map(|r| {
                let flag = r["partial"] == true;
                any_partial |= flag;
                cols.iter().enumerate().map(|(i, k)| if i == 0 && flag { format!("{}{mark}", n(&r[*k])) } else { n(&r[*k]) }).collect()
            })
            .collect();
        section(&mut out, "failures", head, body);
        let reasons = rows
            .iter()
            .filter(|r| r["fail_open_by_reason"].as_object().is_some_and(|c| !c.is_empty()))
            .map(|r| defaults::render("delivery.report_reasons_line", &[("check", &n(&r["check"])), ("reasons", &pairs(&r["fail_open_by_reason"]))]))
            .collect();
        lines(&mut out, "reasons", reasons);
        if let Some(e) = v["failures"]["engine"].as_object().filter(|e| !e.is_empty()) {
            let all = Value::Object(e.clone());
            out.push(format!("  {}", defaults::render("delivery.report_engine_line", &[("counters", &pairs(&all))])));
        }
        if let Some(e) = v["failures"]["answers_dropped"].as_object().filter(|e| !e.is_empty()) {
            let all = Value::Object(e.clone());
            out.push(format!("  {}", defaults::render("delivery.report_dropped_line", &[("counters", &pairs(&all))])));
        }
        any_partial |= v["failures"]["partial"] == true;
    }
    if any_partial {
        out.push(String::new());
        out.push(defaults::render("delivery.report_partial_legend", &[("mark", &mark)]));
    }
    out.join("\n") + "\n"
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn durations_take_the_configured_units_and_a_bare_number_is_days() {
        assert_eq!(parse_duration_ms("6h"), Some(6 * 3_600_000));
        assert_eq!(parse_duration_ms("90m"), Some(5_400_000));
        assert_eq!(parse_duration_ms("7"), Some(7 * 86_400_000));
        assert_eq!(parse_duration_ms("1w"), Some(604_800_000));
        assert_eq!(parse_duration_ms("0d"), None);
        assert_eq!(parse_duration_ms("soon"), None);
        assert_eq!(parse_duration_ms("5x"), None);
    }

    #[test]
    fn absolute_times_are_epoch_seconds_or_ms_or_rfc3339() {
        assert_eq!(parse_time_ms("1762000000"), Some(1_762_000_000_000));
        assert_eq!(parse_time_ms("1762000000123"), Some(1_762_000_000_123));
        assert_eq!(parse_time_ms("1970-01-02"), Some(86_400_000));
        assert_eq!(parse_time_ms("2026-11-01T00:00:00Z"), Some(1_793_491_200_000));
        assert_eq!(parse_time_ms("2026-11-01T04:00:00+04:00"), Some(1_793_491_200_000));
        assert_eq!(parse_time_ms("2026-11-01T00:00:00.5Z"), Some(1_793_491_200_500));
        assert_eq!(parse_time_ms("2026-02-30"), None);
        assert_eq!(parse_time_ms("2026-13-01"), None);
        assert_eq!(parse_time_ms("yesterday"), None);
    }

    #[test]
    fn a_time_that_is_malformed_oversized_or_not_ascii_is_refused_without_a_panic_or_a_loop() {
        // review P2: UTF-8 slicing panicked, +99:99 and a garbage fraction were accepted, a huge year looped over every year
        for bad in [
            "2026-11-01T00:00:00.\u{e9}\u{e9}Z",
            "2026-11-01T00:00:00+99:99",
            "2026-11-01T00:00:00+04:60",
            "2026-11-01T00:00:00.123garbageZ",
            "2026-11-01T00:00:00.Z",
            "9223372036854775807-01-01",
            "99999-01-01",
            "10000-01-01",
            "2026-1-1",
            "2026-11-01T24:00:00Z",
            "2026-11-01T00:00:00+0400",
            "\u{e9}026-11-01",
            "18446744073709551616",
            "99999999999999999999999",
        ] {
            assert_eq!(parse_time_ms(bad), None, "{bad}");
        }
        assert_eq!(parse_time_ms("2026-11-01T00:00:00.123456Z"), Some(1_793_491_200_123), "more fraction digits than ms are cut");
        assert_eq!(parse_time_ms("9999-12-31T23:59:59Z"), Some(253_402_300_799_000));
        assert_eq!(parse_time_ms(&"1".repeat(defaults::num("delivery.report_input_max_len") as usize + 1)), None, "past the length cap");
        assert_eq!(parse_duration_ms("18446744073709551615d"), None, "a window that does not fit u64 ms is refused, not capped");
        assert_eq!(parse_duration_ms("\u{e9}"), None);
    }

    #[test]
    fn a_span_refuses_two_starts_a_future_start_and_an_inverted_range() {
        let now = 1_793_500_000_000;
        assert_eq!(resolve_span("", "", "", now).unwrap(), Span { from_ms: None, to_ms: None });
        assert_eq!(resolve_span("2h", "", "", now).unwrap().from_ms, Some(now - 7_200_000));
        assert!(resolve_span("2h", "1793000000", "", now).unwrap_err().contains("not both"));
        assert!(resolve_span("", "1793600000", "", now).unwrap_err().contains("future"));
        assert!(resolve_span("", "1793400000", "1793300000", now).unwrap_err().contains("earlier"));
        assert!(resolve_span("", "tomorrow", "", now).unwrap_err().contains("--from"));
        assert!(resolve_span("6x", "", "", now).unwrap_err().contains("6x"));
        // a --to in the future is the same as no --to: the live counters are the end
        assert_eq!(resolve_span("", "1793400", "1793600000", now).unwrap().to_ms, None);
    }

    #[test]
    fn the_finest_resolution_that_keeps_the_start_is_chosen() {
        assert_eq!(pick_resolution(3_600_000), Some("minute"));
        assert_eq!(pick_resolution(86_400_000), Some("minute"));
        assert_eq!(pick_resolution(86_400_001), Some("hour"));
        assert_eq!(pick_resolution(90 * 86_400_000), Some("hour"), "older than any: the coarsest");
    }

    fn snap(h: &[(&str, &[u64], u64)], c: &[(&str, u64)]) -> Value {
        let hs: Map<String, Value> =
            h.iter().map(|(k, b, max)| ((*k).to_string(), json!({"buckets": b, "count": b.iter().sum::<u64>(), "sum": 0, "max": max}))).collect();
        let cs: Map<String, Value> = c.iter().map(|(k, v)| ((*k).to_string(), json!(v))).collect();
        json!({"histograms": hs, "counters": cs})
    }

    #[test]
    fn a_latency_window_is_the_bucket_difference_with_exact_or_bounded_max() {
        let n = crate::metrics::bounds_for("check_latency_us").len() + 1;
        let mut start = vec![0u64; n];
        start[0] = 10; // 10 runs in the first bucket before the window
        let mut end = start.clone();
        end[3] = 4; // 4 runs in the 1000 us bucket inside it
        end[9] = 1; // one in the 1 s bucket
        let key = "check_latency_us|check=swarm-guard";
        let (s, e) = (snap(&[(key, &start, 90)], &[]), snap(&[(key, &end, 90)], &[]));
        let v = latency(&Diff::new(&e, Some(&s)));
        let r = &v["rows"][0];
        assert_eq!((r["check"].as_str(), r["count"].as_u64()), (Some("swarm-guard"), Some(5)));
        assert_eq!(r["partial"], false, "control: nothing restarted");
        assert_eq!(r["p50_ms"], json!(1.0), "rank 3 of 5 sits in the 1000 us bucket");
        assert_eq!(r["p95_ms"], json!(1000.0), "rank 5 sits in the 1 s bucket");
        assert_eq!((r["max_ms"].clone(), r["max_exact"].clone()), (json!(1000.0), json!(false)), "the max did not grow: the bucket bound, marked inexact");
        // a max that grew inside the window is exact, and the overflow bucket gives a null quantile
        let mut over = end.clone();
        over[n - 1] = 2;
        let e2 = snap(&[(key, &over, 2_500_000)], &[]);
        let r2 = &latency(&Diff::new(&e2, Some(&s)))["rows"][0];
        assert_eq!((r2["max_ms"].clone(), r2["max_exact"].clone()), (json!(2500.0), json!(true)));
        assert_eq!(r2["p95_ms"], Value::Null, "above the last bound");
        // no start: lifetime; a check with no run in the window has no row; a restarted histogram (end below start) counts whole
        assert_eq!(latency(&Diff::new(&e, None))["rows"][0]["count"], 15);
        assert!(latency(&Diff::new(&s, Some(&s)))["rows"].as_array().unwrap().is_empty());
        assert_eq!(latency(&Diff::new(&s, Some(&e)))["rows"][0]["count"], 10);
        assert_eq!(Diff::new(&s, Some(&e)).resets, 1);
        assert_eq!(Diff::new(&e, Some(&s)).resets, 0);
    }

    #[test]
    fn failures_split_fail_opens_into_timeouts_failures_and_reporting_only_per_check() {
        let c = |pairs: &[(&str, u64)]| snap(&[], pairs);
        let start = c(&[("fail_open|check=swarm-guard|reason=deadline_cut", 2), ("requests", 100)]);
        let end = c(&[
            ("fail_open|check=swarm-guard|reason=deadline_cut", 5),
            ("fail_open|check=swarm-guard|reason=script_timeout", 1),
            ("fail_open|check=swarm-guard|reason=internal_error", 1),
            ("fail_open|check=swarm-guard|reason=busy", 2),
            ("fail_open|check=git|reason=undelivered_verdict", 4),
            ("check_calls|check=swarm-guard", 40),
            ("requests", 150),
            ("errors", 3),
            ("answers_dropped|event=PreToolUse|kind=guard|reason=hard_deadline", 6),
        ]);
        let v = failures(&Diff::new(&end, Some(&start)));
        let sg = v["rows"].as_array().unwrap().iter().find(|r| r["check"] == "swarm-guard").unwrap().clone();
        assert_eq!(
            (sg["fail_open"].as_u64(), sg["timeouts"].as_u64(), sg["failures"].as_u64(), sg["runs"].as_u64()),
            (Some(7), Some(4), Some(1), Some(40)),
            "deadline_cut 5-2 + script_timeout 1 = 4 timeouts; internal_error is a failure; busy only counts in fail_open: {sg}"
        );
        assert_eq!(sg["fail_open_by_reason"]["busy"], 2);
        let git = v["rows"].as_array().unwrap().iter().find(|r| r["check"] == "git").unwrap().clone();
        assert_eq!((git["fail_open"].as_u64(), git["reporting_only"].as_u64()), (Some(0), Some(4)), "reporting-only reasons are apart: {git}");
        assert_eq!((v["engine"]["requests"].as_u64(), v["engine"]["errors"].as_u64()), (Some(50), Some(3)));
        assert_eq!(v["answers_dropped"]["hard_deadline"], 6);
        assert_eq!(v["fail_open_total"], 7);
    }

    #[test]
    fn a_histogram_bucket_that_went_down_is_a_reset_and_every_figure_of_its_check_is_partial() {
        // review P1: start [10, 0, ..] count 10 / check_calls 10, end [0, 11, ..] count 11 / check_calls 11
        let n = crate::metrics::bounds_for("check_latency_us").len() + 1;
        let (mut a, mut b) = (vec![0u64; n], vec![0u64; n]);
        a[0] = 10;
        b[1] = 11;
        let key = "check_latency_us|check=swarm-guard";
        let other = "check_latency_us|check=git";
        let mut start = snap(&[(key, &a, 5), (other, &a, 5)], &[("check_calls|check=swarm-guard", 10), ("fail_open|check=swarm-guard|reason=deadline_cut", 1)]);
        let mut end = snap(&[(key, &b, 5), (other, &a, 5)], &[("check_calls|check=swarm-guard", 11), ("fail_open|check=swarm-guard|reason=deadline_cut", 2)]);
        let d = Diff::new(&end, Some(&start));
        assert_eq!((d.resets, d.mismatched), (1, 0), "the count went UP (10 to 11) but a bucket went down: still a reset");
        assert!(d.is_partial("swarm-guard") && !d.is_partial("git"), "only the check with the reset is partial");
        assert!(!d.clean());
        let l = latency(&d);
        let rows = l["rows"].as_array().unwrap();
        assert_eq!(rows.iter().find(|r| r["check"] == "swarm-guard").unwrap()["partial"], true, "{l}");
        assert_eq!(rows.iter().find(|r| r["check"] == "git").map(|r| r["partial"].clone()), None, "control: git has no window count");
        let f = failures(&d);
        let row = &f["rows"][0];
        assert_eq!(
            (row["runs"].as_u64(), row["partial"].clone()),
            (Some(1), json!(true)),
            "runs 1 against latency 11: flagged, not presented as complete: {f}"
        );
        assert_eq!(f["partial"], true);
        // a bucket down while the count is up, and the reverse (count down, buckets up), are both resets
        start["histograms"][key]["count"] = json!(100);
        end["histograms"][key]["buckets"] = json!(a);
        assert_eq!(Diff::new(&end, Some(&start)).resets, 1, "count 10 below 100");
        // the series set differs: a series the end lost is a reset, a new one is not
        let lost = snap(&[], &[("check_calls|check=gone", 4)]);
        let d = Diff::new(&lost, Some(&snap(&[], &[("check_calls|check=other", 4)])));
        assert!(d.resets == 1 && d.is_partial("other"), "{d:?}");
        let fresh = Diff::new(&snap(&[], &[("check_calls|check=new", 4)]), Some(&snap(&[], &[])));
        assert!(fresh.clean(), "a series that first appears inside the window is normal growth");
        // a bucket layout that differs, or a value that is not a count, cannot be compared
        let short = snap(&[(key, &a[..3], 1)], &[]);
        let d = Diff::new(&snap(&[(key, &a, 1)], &[]), Some(&short));
        assert!(d.mismatched == 1 && d.is_partial("swarm-guard") && !d.clean());
        let d = Diff::new(&json!({"counters": {"requests": -1}}), None);
        assert_eq!(d.mismatched, 1);
    }

    #[test]
    fn sums_stop_at_the_maximum_and_say_so_and_ms_does_not_round_a_huge_value() {
        let d = Diff::new(&snap(&[], &[("fail_open|check=a|reason=busy", u64::MAX), ("fail_open|check=a|reason=deadline_cut", u64::MAX)]), None);
        let f = failures(&d);
        assert_eq!(f["fail_open_total"], u64::MAX);
        assert!(d.saturated() && !d.clean());
        assert_eq!(ms(1u64 << 60), Value::Null, "past what a JSON number holds exactly");
        assert_eq!(ms(2500), json!(2.5));
    }
}
