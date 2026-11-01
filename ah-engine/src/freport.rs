//! The weekly funnel report (B4, plan v2 section 6): the time window of `telemetry funnel` / `telemetry report`, and the latency and
//! failure sections that sit beside the funnel.
//!
//! Nothing here records anything. A window is the end snapshot less the start snapshot, where both are the metrics snapshots the
//! engine already stores (`telemetry.rollups`; every snapshot holds the counters AND the latency histograms), so a histogram's
//! window is a bucket-wise difference. The start is the last snapshot of its rollup bucket at or before the asked start, so the
//! window can begin up to one bucket early; the report prints the real start (`baseline_ms`) and how far it is from the asked one.
//! Every unit, list, switch and text comes from the plugin's TOML (`delivery.report_*`).
// Discard triage (E3): every `.ok()` / `unwrap_or_default()` in this file is a deliberate keep, for these reasons:
// - an absent field is the empty value
// A failure that must be seen goes through `crate::discard` instead.

use crate::defaults;
use serde_json::{Map, Value, json};
use std::collections::BTreeMap;

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
    defaults::raw("delivery.report_window_units").get(unit).and_then(defaults::V::as_integer).unwrap_or(0).max(0) as u64
}

fn units_list() -> String {
    defaults::raw("delivery.report_window_units").as_table().map(|t| t.iter().map(|(k, _)| *k).collect::<Vec<_>>().join(", ")).unwrap_or_default()
}

/// A window length such as `6h`, `90m`, `7d` or a bare number (`delivery.report_bare_unit`) in ms; `None` when it is neither or is 0.
pub fn parse_duration_ms(s: &str) -> Option<u64> {
    let s = s.trim();
    let digits = s.chars().take_while(char::is_ascii_digit).count();
    let (num, unit) = s.split_at(digits);
    let n: u64 = num.parse().ok()?;
    let per = unit_ms(if unit.is_empty() { defaults::text("delivery.report_bare_unit") } else { unit });
    (per > 0 && n > 0).then(|| n.saturating_mul(per))
}

/// Days since 1970-01-01 of a civil date (proleptic Gregorian), `None` for an impossible date.
fn days_from_civil(y: i64, m: i64, d: i64) -> Option<i64> {
    let leap = (y % 4 == 0 && y % 100 != 0) || y % 400 == 0;
    let dim = match m {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 => 28 + i64::from(leap),
        _ => return None,
    };
    if !(1..=dim).contains(&d) {
        return None;
    }
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let doy = (153 * (if m > 2 { m - 3 } else { m + 9 }) + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    Some(era * 146_097 + doe - 719_468)
}

/// An absolute time in epoch ms: epoch seconds or milliseconds (a number of 12 or more digits is ms), or RFC 3339
/// (`2026-11-01T09:30:00Z`, `...+04:00`; a date alone is midnight UTC; no zone means UTC).
pub fn parse_time_ms(s: &str) -> Option<u64> {
    let s = s.trim();
    if !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit()) {
        let n: u64 = s.parse().ok()?;
        return Some(if s.len() >= 12 { n } else { n.saturating_mul(1000) });
    }
    let (date, time) = match s.split_once('T') {
        Some((d, t)) => (d, Some(t)),
        None => (s, None),
    };
    let mut dp = date.split('-');
    let (y, m, d): (i64, i64, i64) = (dp.next()?.parse().ok()?, dp.next()?.parse().ok()?, dp.next()?.parse().ok()?);
    if dp.next().is_some() {
        return None;
    }
    let mut secs = days_from_civil(y, m, d)? * 86_400;
    let mut ms = 0i64;
    if let Some(t) = time {
        let (clock, off) = if let Some(c) = t.strip_suffix('Z') {
            (c, 0)
        } else if let Some(i) = t.rfind(['+', '-']) {
            let sign = if t.as_bytes()[i] == b'-' { -1 } else { 1 };
            let (hh, mm) = t[i + 1..].split_once(':')?;
            (&t[..i], sign * (hh.parse::<i64>().ok()? * 3600 + mm.parse::<i64>().ok()? * 60))
        } else {
            (t, 0)
        };
        let mut cp = clock.split(':');
        let (h, mi): (i64, i64) = (cp.next()?.parse().ok()?, cp.next()?.parse().ok()?);
        let sec = cp.next().unwrap_or("0");
        let (whole, frac) = sec.split_once('.').unwrap_or((sec, ""));
        let sc: i64 = whole.parse().ok()?;
        if cp.next().is_some() || !(0..24).contains(&h) || !(0..60).contains(&mi) || !(0..61).contains(&sc) {
            return None;
        }
        if !frac.is_empty() {
            ms = format!("{frac:0<3}")[..3].parse().ok()?;
        }
        secs += h * 3600 + mi * 60 + sc - off;
    }
    u64::try_from(secs).ok().map(|s| s * 1000 + ms as u64)
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

fn counters(snap: &Value) -> BTreeMap<String, u64> {
    snap.get("counters").and_then(Value::as_object).map(|m| m.iter().filter_map(|(k, v)| Some((k.clone(), v.as_u64()?))).collect()).unwrap_or_default()
}

/// Split a series key `name|l=v|l=v` into its name and labels.
fn parse_key(k: &str) -> (&str, BTreeMap<&str, &str>) {
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

fn hists(snap: &Value) -> BTreeMap<String, Hist> {
    let Some(m) = snap.get("histograms").and_then(Value::as_object) else { return BTreeMap::new() };
    m.iter()
        .filter_map(|(k, x)| {
            let buckets = x.get("buckets")?.as_array()?.iter().filter_map(Value::as_u64).collect();
            Some((k.clone(), Hist { buckets, count: x.get("count")?.as_u64()?, max: x.get("max").and_then(Value::as_u64).unwrap_or(0) }))
        })
        .collect()
}

fn ms(us: u64) -> f64 {
    ((us as f64) / 1000.0 * 1000.0).round() / 1000.0
}

/// Series of `end` that went down against `start` (or that `start` has and `end` lost): the counters restarted inside the window.
pub fn count_resets(end: &Value, start: Option<&Value>) -> usize {
    let Some(start) = start else { return 0 };
    let (e, s) = (counters(end), counters(start));
    let c = s.iter().filter(|(k, v)| e.get(*k).is_none_or(|ev| ev < v)).count();
    let (eh, sh) = (hists(end), hists(start));
    c + sh.iter().filter(|(k, h)| eh.get(*k).is_none_or(|x| x.count < h.count)).count()
}

/// The per-check latency of the window: `check_latency_us` of `end` less that of `start`, bucket by bucket. Quantiles are the upper
/// bound of their bucket (`null` above the last bound); `max_ms` is the largest value seen only when it grew inside the window
/// (`max_exact`), otherwise the upper bound of the highest bucket the window used.
pub fn latency(end: &Value, start: Option<&Value>) -> Value {
    let bounds = crate::metrics::bounds_for("check_latency_us");
    let base = start.map(hists).unwrap_or_default();
    let mut rows: BTreeMap<String, Value> = BTreeMap::new();
    for (key, h) in hists(end) {
        let (name, labels) = parse_key(&key);
        if name != "check_latency_us" || h.buckets.len() != bounds.len() + 1 {
            continue;
        }
        let Some(check) = labels.get("check") else { continue };
        let b = base.get(&key).filter(|b| b.buckets.len() == h.buckets.len() && h.count >= b.count && h.buckets.iter().zip(&b.buckets).all(|(x, y)| x >= y));
        let window: Vec<u64> = h.buckets.iter().enumerate().map(|(i, n)| n - b.map_or(0, |b| b.buckets[i])).collect();
        let count: u64 = window.iter().sum();
        if count == 0 {
            continue;
        }
        let q = |p: f64| crate::telemetry::report::quantile(&window, &bounds, p).map_or(Value::Null, |us| json!(ms(us)));
        let top = window.iter().rposition(|n| *n > 0).unwrap_or(0);
        let grew = b.is_none_or(|b| h.max > b.max);
        let (max, exact) = match (top < bounds.len(), grew) {
            (_, true) => (Some(h.max), true),
            (true, false) => (Some(bounds[top]), false),
            (false, false) => (None, false),
        };
        rows.insert(
            (*check).to_string(),
            json!({ "check": check, "count": count, "p50_ms": q(0.50), "p95_ms": q(0.95), "max_ms": max.map(ms), "max_exact": exact }),
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
/// kept apart and not in `total`.
pub fn failures(end: &Value, start: Option<&Value>) -> Value {
    let base = start.map(counters).unwrap_or_default();
    let (timeouts, fails) = (reason_words("delivery.report_timeout_reason_keys"), reason_words("delivery.report_failure_reason_keys"));
    let mut checks: BTreeMap<String, Map<String, Value>> = BTreeMap::new();
    let mut engine: BTreeMap<String, u64> = BTreeMap::new();
    let mut dropped: BTreeMap<String, u64> = BTreeMap::new();
    let wanted = defaults::list("delivery.report_engine_counters");
    for (key, v) in counters(end) {
        let (cur, _) = delta(v, base.get(&key).copied().unwrap_or(0));
        let (name, labels) = parse_key(&key);
        if cur == 0 {
            continue;
        }
        match name {
            "fail_open" => {
                let (Some(reason), Some(check)) = (labels.get("reason"), labels.get("check")) else { continue };
                let row = checks.entry((*check).to_string()).or_default();
                let n = |row: &Map<String, Value>, k: &str| row.get(k).and_then(Value::as_u64).unwrap_or(0);
                let by = row.entry("fail_open_by_reason").or_insert_with(|| json!({}));
                by[*reason] = json!(by.get(*reason).and_then(Value::as_u64).unwrap_or(0) + cur);
                let slot = if crate::failopen::is_reporting(reason) { "reporting_only" } else { "fail_open" };
                let total = n(row, slot) + cur;
                row.insert(slot.into(), json!(total));
                if !crate::failopen::is_reporting(reason) {
                    for (class, list) in [("timeouts", &timeouts), ("failures", &fails)] {
                        if list.contains(reason) {
                            let t = n(row, class) + cur;
                            row.insert(class.into(), json!(t));
                        }
                    }
                }
            }
            "check_calls" => {
                if let Some(check) = labels.get("check") {
                    checks.entry((*check).to_string()).or_default().insert("runs".into(), json!(cur));
                }
            }
            "answers_dropped" => {
                if let Some(reason) = labels.get("reason") {
                    *dropped.entry((*reason).to_string()).or_insert(0) += cur;
                }
            }
            n if key == n && wanted.contains(&n) => {
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
            r.insert("check".into(), json!(check));
            Value::Object(r)
        })
        .collect();
    let totals: u64 = rows.iter().filter_map(|r| r["fail_open"].as_u64()).sum();
    json!({ "rows": rows, "fail_open_total": totals, "engine": engine, "answers_dropped": dropped })
}

fn n(v: &Value) -> String {
    match v {
        Value::Null => "-".into(),
        Value::Number(x) if x.is_f64() => format!("{}", x.as_f64().unwrap_or(0.0)),
        other => other.as_u64().map_or_else(|| other.to_string(), |x| x.to_string()),
    }
}

fn pad(rows: Vec<Vec<String>>) -> Vec<String> {
    let cols = rows.iter().map(Vec::len).max().unwrap_or(0);
    let widths: Vec<usize> = (0..cols).map(|c| rows.iter().map(|r| r.get(c).map_or(0, |s| s.chars().count())).max().unwrap_or(0)).collect();
    rows.iter().map(|r| r.iter().enumerate().map(|(i, s)| format!("{s:<w$}", w = widths[i])).collect::<Vec<_>>().join("  ").trim_end().to_string()).collect()
}

/// The text form of a report body (`telemetry report` without `--json`): the window line, then one table per section.
pub fn table(v: &Value) -> String {
    let titles = defaults::raw("delivery.report_table_titles");
    let title = |k: &str| titles.get(k).and_then(defaults::V::as_str).unwrap_or(k).to_string();
    let cap = defaults::num("delivery.report_rows_max") as usize;
    let mut out = Vec::new();
    let w = &v["funnel"]["window"];
    let stamp = |k: &str| w.get(k).and_then(Value::as_u64).map_or("-".to_string(), |x| x.to_string());
    out.push(format!("{}: from {} to {} ms (asked from {}, to {})", title("window"), stamp("baseline_ms"), stamp("end_ms"), stamp("from_ms"), stamp("to_ms")));
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
            out.push(format!("  ... {} more rows (see --json)", total - cap));
        }
    };
    if let Some(rows) = v["funnel"]["rows"].as_array() {
        let by: Vec<String> = v["funnel"]["by"].as_array().map(|a| a.iter().filter_map(Value::as_str).map(str::to_string).collect()).unwrap_or_default();
        let stages: Vec<&str> = defaults::list("delivery.report_stages");
        let mut head = vec!["check".to_string()];
        head.extend(by.clone());
        head.extend(stages.iter().map(|s| (*s).to_string()));
        head.push("acted_on_rate".into());
        let body = rows
            .iter()
            .map(|r| {
                let mut line = vec![n(&r["check"])];
                line.extend(by.iter().map(|d| n(&r[d.as_str()])));
                line.extend(stages.iter().map(|s| n(&r[*s])));
                line.push(n(&r["acted_on_rate"]));
                line
            })
            .collect();
        section(&mut out, "funnel", head, body);
    }
    if let Some(rows) = v["latency"]["rows"].as_array() {
        let head = ["check", "count", "p50", "p95", "max"].map(str::to_string).to_vec();
        let body = rows
            .iter()
            .map(|r| {
                let max = if r["max_exact"] == true { n(&r["max_ms"]) } else { format!("<={}", n(&r["max_ms"])) };
                vec![n(&r["check"]), n(&r["count"]), n(&r["p50_ms"]), n(&r["p95_ms"]), max]
            })
            .collect();
        section(&mut out, "latency", head, body);
        out.push(format!("  {}", v["latency"]["note"].as_str().unwrap_or("")));
    }
    if let Some(rows) = v["failures"]["rows"].as_array() {
        let head = ["check", "runs", "fail_open", "timeouts", "failures"].map(str::to_string).to_vec();
        let body = rows.iter().map(|r| ["check", "runs", "fail_open", "timeouts", "failures"].iter().map(|k| n(&r[*k])).collect()).collect();
        section(&mut out, "failures", head, body);
        if let Some(e) = v["failures"]["engine"].as_object().filter(|e| !e.is_empty()) {
            out.push(format!("  engine: {}", e.iter().map(|(k, x)| format!("{k}={}", n(x))).collect::<Vec<_>>().join(" ")));
        }
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
        let v = latency(&e, Some(&s));
        let r = &v["rows"][0];
        assert_eq!((r["check"].as_str(), r["count"].as_u64()), (Some("swarm-guard"), Some(5)));
        assert_eq!(r["p50_ms"], json!(1.0), "rank 3 of 5 sits in the 1000 us bucket");
        assert_eq!(r["p95_ms"], json!(1000.0), "rank 5 sits in the 1 s bucket");
        assert_eq!((r["max_ms"].clone(), r["max_exact"].clone()), (json!(1000.0), json!(false)), "the max did not grow: the bucket bound, marked inexact");
        // a max that grew inside the window is exact, and the overflow bucket gives a null quantile
        let mut over = end.clone();
        over[n - 1] = 2;
        let e2 = snap(&[(key, &over, 2_500_000)], &[]);
        let r2 = &latency(&e2, Some(&s))["rows"][0];
        assert_eq!((r2["max_ms"].clone(), r2["max_exact"].clone()), (json!(2500.0), json!(true)));
        assert_eq!(r2["p95_ms"], Value::Null, "above the last bound");
        // no start: lifetime; a check with no run in the window has no row; a restarted histogram (end below start) counts whole
        assert_eq!(latency(&e, None)["rows"][0]["count"], 15);
        assert!(latency(&s, Some(&s))["rows"].as_array().unwrap().is_empty());
        assert_eq!(latency(&s, Some(&e))["rows"][0]["count"], 10);
        assert_eq!(count_resets(&s, Some(&e)), 1);
        assert_eq!(count_resets(&e, Some(&s)), 0);
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
        let v = failures(&end, Some(&start));
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
}
