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

pub use crate::metrics::why;

/// One counter of a snapshot: its value (0 when it is not a count) and, when it cannot be trusted as it is, the [`why`] word.
struct Cv {
    v: u64,
    flag: Option<&'static str>,
}

/// One histogram of a snapshot, checked (see [`crate::metrics::check_hist`]).
enum Hv {
    Ok { buckets: Vec<u64>, count: u64, max: u64, saturated: bool },
    Bad(&'static str),
}

/// The counters of a snapshot, each checked (nothing is skipped or coerced: a value that is not a count is kept as flagged), and
/// whether the `counters` section had the wrong shape.
fn read_counters(snap: &Value) -> (BTreeMap<String, Cv>, bool) {
    let section = snap.get("counters");
    let Some(m) = section.and_then(Value::as_object) else { return (BTreeMap::new(), section.is_some()) };
    let out = m
        .iter()
        .map(|(k, v)| {
            let cv = match v.as_u64() {
                Some(n) => Cv { v: n, flag: (n == u64::MAX).then_some(why::saturated()) },
                None => Cv { v: 0, flag: Some(why::invalid()) },
            };
            (k.clone(), cv)
        })
        .collect();
    (out, false)
}

/// The histograms of a snapshot, each checked against the layout of its metric, and whether the section had the wrong shape.
fn read_hists(snap: &Value) -> (BTreeMap<String, Hv>, bool) {
    let section = snap.get("histograms");
    let Some(m) = section.and_then(Value::as_object) else { return (BTreeMap::new(), section.is_some()) };
    let out = m
        .iter()
        .map(|(k, x)| {
            let hv = match crate::metrics::check_hist(parse_key(k).0, x) {
                Ok((buckets, count, max, saturated)) => Hv::Ok { buckets, count, max, saturated },
                Err(why) => Hv::Bad(why),
            };
            (k.clone(), hv)
        })
        .collect();
    (out, false)
}

/// The series the engine refused when it restored a snapshot (`rejected`), by key and reason.
fn read_rejected(snap: &Value) -> Vec<(String, &'static str)> {
    let Some(m) = snap.get("rejected").and_then(Value::as_object) else { return Vec::new() };
    m.keys().map(|k| (k.clone(), why::rejected())).collect()
}

/// One counter series of a window: its figure is end less start, or the end value when the series restarted (`reset`).
#[derive(Debug, Clone)]
pub struct Series {
    /// The metric name.
    pub name: String,
    /// Its labels.
    pub labels: BTreeMap<String, String>,
    /// The window figure (0 when a side could not be read; see `flag`).
    pub value: u64,
    /// The series went down between the two snapshots, so the figure is the end value, not a difference.
    pub reset: bool,
    /// Why the figure cannot be proven (a [`why`] word), when it cannot: the row of its check is partial.
    pub flag: Option<&'static str>,
}

/// One histogram of a window, bucket by bucket.
#[derive(Debug, Clone)]
pub struct HistWin {
    /// The window's count per bucket (the end buckets whole when the series restarted); empty when `flag` says it cannot be read.
    pub buckets: Vec<u64>,
    /// The end snapshot's largest value.
    pub max: u64,
    /// True when `max` was seen inside the window (it grew, or there is no start to compare with).
    pub max_new: bool,
    /// Why the window cannot be proven (a [`why`] word). With `usable` false there is no figure at all.
    pub flag: Option<&'static str>,
    /// False when a side of the series could not be read or the series vanished: no bucket is shown for it.
    pub usable: bool,
}

/// The window between two snapshots, computed once for every section of a report. Every counter series and every histogram of both
/// snapshots is CHECKED when read (a value that is not a count, a bucket layout other than the supported one, a count that is not the
/// total of its buckets, a value at the largest `u64`, a series the restore refused) and then compared once. Nothing is dropped or
/// coerced: a series that fails any of this, went down (a RESET), or is on one side only (VANISHED) marks its check `partial` with the
/// reason ([`Diff::reasons_of`]) in the funnel, latency and failure sections, and makes the window incomplete. A snapshot that is not
/// the stored shape marks every check. All sums are checked: past `u64` they stop at the maximum and `saturated` is set.
#[derive(Debug, Default)]
pub struct Diff {
    /// The end snapshot's counter series (and the flagged ones of either side).
    pub series: Vec<Series>,
    /// The histograms, by series key.
    pub hists: BTreeMap<String, HistWin>,
    /// Series that went down or vanished between the snapshots.
    pub resets: usize,
    /// Series that could not be compared (a value that is not a count, another bucket layout, a count that is not its buckets' total).
    pub mismatched: usize,
    /// Series at the largest count.
    pub saturated_series: usize,
    /// The checks (label `check`) with a flagged series: every figure of theirs is partial.
    pub partial_checks: BTreeSet<String>,
    /// Per check, why it is partial.
    pub partial_reasons: BTreeMap<String, BTreeSet<&'static str>>,
    /// The metric names with a flagged series (label-free engine counters included), with the reasons.
    pub partial_names: BTreeMap<String, BTreeSet<&'static str>>,
    /// Reasons that touch every figure (a snapshot that is not the stored shape).
    pub global: BTreeSet<&'static str>,
    saturated: Cell<bool>,
}

impl Diff {
    /// The window of `end` less `start`; no start is the lifetime figures.
    pub fn new(end: &Value, start: Option<&Value>) -> Diff {
        let mut d = Diff::default();
        // a snapshot that is not an object, or whose sections are not objects, cannot be read at all: every figure is unproven
        let shape_bad = |v: &Value| !v.is_object();
        if shape_bad(end) || start.is_some_and(shape_bad) {
            d.global.insert(why::unreadable());
            d.mismatched += 1;
        }
        let (ec, ec_bad) = read_counters(end);
        let (sc, sc_bad) = start.map(read_counters).unwrap_or_default();
        let (eh, eh_bad) = read_hists(end);
        let (sh, sh_bad) = start.map(read_hists).unwrap_or_default();
        for bad in [ec_bad, sc_bad, eh_bad, sh_bad] {
            if bad {
                d.global.insert(why::unreadable());
                d.mismatched += 1;
            }
        }
        for (k, e) in &ec {
            let s = sc.get(k);
            let (value, reset) = match s {
                Some(s) if s.flag != Some(why::invalid()) && e.flag != Some(why::invalid()) => delta(e.v, s.v),
                _ => (e.v, false),
            };
            let mut flag: Option<&'static str> = None;
            for f in [e.flag, s.and_then(|s| s.flag)].into_iter().flatten() {
                if flag != Some(f) {
                    d.flagged(k, f);
                }
                flag = flag.or(Some(f));
            }
            if reset {
                d.resets += 1;
                d.mark(k, why::reset());
                flag = flag.or(Some(why::reset()));
            }
            let (name, labels) = parse_key(k);
            d.series.push(Series {
                name: name.to_string(),
                labels: labels.into_iter().map(|(a, b)| (a.to_string(), b.to_string())).collect(),
                value,
                reset,
                flag,
            });
        }
        for (k, s) in sc.iter().filter(|(k, _)| !ec.contains_key(*k)) {
            let flag = match s.flag {
                Some(f) => {
                    d.flagged(k, f);
                    f
                }
                None => {
                    d.resets += 1;
                    d.mark(k, why::vanished());
                    why::vanished()
                }
            };
            d.push_gone(k, flag);
        }
        for (k, e) in &eh {
            let s = sh.get(k);
            let win = match (e, s) {
                (Hv::Bad(w), _) => {
                    let w = *w;
                    d.flagged(k, w);
                    HistWin { buckets: Vec::new(), max: 0, max_new: false, flag: Some(w), usable: false }
                }
                (Hv::Ok { .. }, Some(Hv::Bad(w))) => {
                    let w = *w;
                    d.flagged(k, w);
                    HistWin { buckets: Vec::new(), max: 0, max_new: false, flag: Some(w), usable: false }
                }
                (Hv::Ok { buckets, count, max, saturated }, other) => {
                    let mut flag = None;
                    if *saturated {
                        d.flagged(k, why::saturated());
                        flag = Some(why::saturated());
                    }
                    let (win, max_new) = match other {
                        Some(Hv::Ok { buckets: b, count: bc, max: bm, saturated: bs }) => {
                            if *bs && flag.is_none() {
                                d.flagged(k, why::saturated());
                                flag = Some(why::saturated());
                            }
                            if count < bc || buckets.iter().zip(b).any(|(x, y)| x < y) {
                                d.resets += 1;
                                d.mark(k, why::reset());
                                flag = flag.or(Some(why::reset()));
                                (buckets.clone(), true)
                            } else {
                                (buckets.iter().zip(b).map(|(x, y)| x - y).collect(), max > bm)
                            }
                        }
                        _ => (buckets.clone(), true),
                    };
                    HistWin { buckets: win, max: *max, max_new, flag, usable: true }
                }
            };
            d.hists.insert(k.clone(), win);
        }
        for (k, s) in sh.iter().filter(|(k, _)| !eh.contains_key(*k)) {
            let w = match s {
                Hv::Bad(w) => {
                    d.flagged(k, w);
                    *w
                }
                Hv::Ok { .. } => {
                    d.resets += 1;
                    d.mark(k, why::vanished());
                    why::vanished()
                }
            };
            d.hists.insert(k.clone(), HistWin { buckets: Vec::new(), max: 0, max_new: false, flag: Some(w), usable: false });
        }
        // series the engine refused when it restored the end snapshot's predecessor
        for (k, w) in read_rejected(end) {
            if ec.contains_key(&k) || eh.contains_key(&k) {
                continue;
            }
            d.flagged(&k, w);
            d.push_gone(&k, w);
            if crate::metrics::is_registered(parse_key(&k).0) && defaults::raw(&format!("metric.{}", parse_key(&k).0)).str_field("kind") == "histogram" {
                d.hists.insert(k, HistWin { buckets: Vec::new(), max: 0, max_new: false, flag: Some(w), usable: false });
            }
        }
        d
    }

    /// A series that has no figure of its own in the window (gone, or refused): a row for its check, value 0, flagged.
    fn push_gone(&mut self, key: &str, flag: &'static str) {
        let (name, labels) = parse_key(key);
        self.series.push(Series {
            name: name.to_string(),
            labels: labels.into_iter().map(|(a, b)| (a.to_string(), b.to_string())).collect(),
            value: 0,
            reset: flag == why::vanished(),
            flag: Some(flag),
        });
    }

    /// Count a flagged series (by what is wrong with it) and mark its check.
    fn flagged(&mut self, key: &str, reason: &'static str) {
        if reason == why::saturated() {
            self.saturated_series += 1;
        } else {
            self.mismatched += 1;
        }
        self.mark(key, reason);
    }

    fn mark(&mut self, key: &str, reason: &'static str) {
        let (name, labels) = parse_key(key);
        self.partial_names.entry(name.to_string()).or_default().insert(reason);
        if let Some(c) = labels.get("check") {
            self.partial_checks.insert((*c).to_string());
            self.partial_reasons.entry((*c).to_string()).or_default().insert(reason);
        }
    }

    /// True when a figure of `check` cannot be proven (one of its series restarted, vanished, was refused or could not be compared,
    /// or a snapshot was unreadable).
    pub fn is_partial(&self, check: &str) -> bool {
        !self.global.is_empty() || self.partial_checks.contains(check)
    }

    /// Why `check` is partial (sorted; empty when it is not).
    pub fn reasons_of(&self, check: &str) -> Vec<&'static str> {
        let mut r: BTreeSet<&'static str> = self.global.clone();
        if let Some(own) = self.partial_reasons.get(check) {
            r.extend(own);
        }
        r.into_iter().collect()
    }

    /// True when the whole window is provable: no reset, no mismatch, no saturated series or sum.
    pub fn clean(&self) -> bool {
        self.resets == 0 && self.mismatched == 0 && !self.saturated() && self.global.is_empty()
    }

    /// True when a series or a sum reached the largest count.
    pub fn saturated(&self) -> bool {
        self.saturated.get() || self.saturated_series > 0
    }

    /// `a + b`, stopping at `u64::MAX` and remembering that it did.
    pub fn add(&self, a: u64, b: u64) -> u64 {
        a.checked_add(b).unwrap_or_else(|| {
            self.saturated.set(true);
            u64::MAX
        })
    }

    /// [`Diff::add`] that also sets `row` when the sum stopped at the maximum: the row it belongs to is partial.
    pub fn add_row(&self, a: u64, b: u64, row: &mut bool) -> u64 {
        a.checked_add(b).unwrap_or_else(|| {
            *row = true;
            self.saturated.set(true);
            u64::MAX
        })
    }
}

/// Milliseconds with three decimals; `null` above what a JSON number holds exactly.
fn ms(us: u64) -> Value {
    if us > (1u64 << f64::MANTISSA_DIGITS) { Value::Null } else { json!((us as f64) / 1000.0) }
}

/// The partial reasons of a row of `check` as the words of its report (sorted); `sat` adds the saturated sum of the row itself.
pub fn reason_words_of(d: &Diff, check: &str, sat: bool) -> Vec<&'static str> {
    let mut r = d.reasons_of(check);
    if sat && !r.contains(&why::saturated()) {
        r.push(why::saturated());
        r.sort_unstable();
    }
    r
}

/// The per-check latency of the window: `check_latency_us` of the window, bucket by bucket. Quantiles are the upper bound of their
/// bucket (`null` above the last bound; integer rank arithmetic); `max_ms` is the largest value seen only when it grew inside the
/// window (`max_exact`), otherwise the upper bound of the highest bucket the window used. A row is `partial` (with `partial_reasons`)
/// when a series of its check restarted, vanished, was refused or could not be compared; a histogram that cannot be read (its bucket
/// layout is not the supported one, its count is not its buckets' total, a side is missing) is a row with NO figures and `partial`,
/// never an absent row.
pub fn latency(d: &Diff) -> Value {
    let bounds = crate::metrics::bounds_for("check_latency_us");
    let mut rows: BTreeMap<String, Value> = BTreeMap::new();
    for (key, h) in &d.hists {
        let (name, labels) = parse_key(key);
        if name != "check_latency_us" {
            continue;
        }
        let Some(check) = labels.get("check") else { continue };
        if !h.usable {
            rows.insert(
                (*check).to_string(),
                json!({
                    "check": check, "count": Value::Null, "p50_ms": Value::Null, "p95_ms": Value::Null, "max_ms": Value::Null, "max_exact": false,
                    "partial": true, "partial_reasons": reason_words_of(d, check, false),
                }),
            );
            continue;
        }
        let mut sat = false;
        let count = h.buckets.iter().fold(0u64, |a, n| d.add_row(a, *n, &mut sat));
        if count == 0 && !d.is_partial(check) {
            continue;
        }
        let q = |p: u64| crate::telemetry::report::quantile(&h.buckets, &bounds, p).map_or(Value::Null, ms);
        let top = h.buckets.iter().rposition(|n| *n > 0).unwrap_or(0);
        let (max, exact) = match (top < bounds.len(), h.max_new) {
            (_, true) => (Some(h.max), true),
            (true, false) => (Some(bounds[top]), false),
            (false, false) => (None, false),
        };
        let partial = d.is_partial(check) || sat || h.flag.is_some();
        let mut reasons = reason_words_of(d, check, sat);
        if let Some(f) = h.flag.filter(|f| !reasons.contains(f)) {
            reasons.push(f);
            reasons.sort_unstable();
        }
        // a saturated count or bucket has no honest quantile
        let figs = !(sat || h.flag == Some(why::saturated()));
        rows.insert(
            (*check).to_string(),
            json!({
                "check": check, "count": count, "p50_ms": if figs { q(500) } else { Value::Null }, "p95_ms": if figs { q(950) } else { Value::Null },
                "max_ms": max.map_or(Value::Null, ms), "max_exact": exact, "partial": partial, "partial_reasons": reasons,
            }),
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
/// kept apart and not in `total`. A row is `partial` (with `partial_reasons`) when a series of its check restarted, vanished, was refused,
/// could not be compared or a sum of the row reached the maximum; a check with a flagged series always has a row. `engine_partial` names
/// the engine counters that were flagged, `answers_dropped_partial` says the dropped counts were.
pub fn failures(d: &Diff) -> Value {
    let (timeouts, fails) = (reason_words("delivery.report_timeout_reason_keys"), reason_words("delivery.report_failure_reason_keys"));
    let mut checks: BTreeMap<String, Map<String, Value>> = BTreeMap::new();
    let mut sat_checks: BTreeSet<String> = BTreeSet::new();
    let mut engine: BTreeMap<String, u64> = BTreeMap::new();
    let mut dropped: BTreeMap<String, u64> = BTreeMap::new();
    let wanted = defaults::list("delivery.report_engine_counters");
    let get = |row: &Map<String, Value>, k: &str| row.get(k).and_then(Value::as_u64).unwrap_or(0);
    for s in &d.series {
        let cur = s.value;
        if cur == 0 && s.flag.is_none() {
            continue;
        }
        match s.name.as_str() {
            "fail_open" => {
                let Some(check) = s.labels.get("check") else { continue };
                let row = checks.entry(check.clone()).or_default();
                let Some(reason) = s.labels.get("reason") else { continue };
                let mut sat = false;
                let by = row.entry("fail_open_by_reason").or_insert_with(|| json!({}));
                by[reason.as_str()] = json!(d.add_row(by.get(reason.as_str()).and_then(Value::as_u64).unwrap_or(0), cur, &mut sat));
                let reporting = crate::failopen::is_reporting(reason);
                let slot = if reporting { "reporting_only" } else { "fail_open" };
                let total = d.add_row(get(row, slot), cur, &mut sat);
                row.insert(slot.into(), json!(total));
                if !reporting {
                    for (class, list) in [("timeouts", &timeouts), ("failures", &fails)] {
                        if list.contains(&reason.as_str()) {
                            let t = d.add_row(get(row, class), cur, &mut sat);
                            row.insert(class.into(), json!(t));
                        }
                    }
                }
                if sat {
                    sat_checks.insert(check.clone());
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
        .filter(|(c, r)| r.contains_key("fail_open") || r.contains_key("reporting_only") || d.is_partial(c))
        .map(|(check, mut r)| {
            for k in ["fail_open", "timeouts", "failures", "runs"] {
                r.entry(k).or_insert(json!(0));
            }
            let sat = sat_checks.contains(&check);
            r.insert("partial".into(), json!(d.is_partial(&check) || sat));
            r.insert("partial_reasons".into(), json!(reason_words_of(d, &check, sat)));
            r.insert("check".into(), json!(check));
            Value::Object(r)
        })
        .collect();
    let mut total_sat = false;
    let totals = rows.iter().filter_map(|r| r["fail_open"].as_u64()).fold(0u64, |a, n| d.add_row(a, n, &mut total_sat));
    let engine_partial: Vec<&str> = wanted.iter().copied().filter(|n| d.partial_names.contains_key(*n)).collect();
    let dropped_partial = d.partial_names.contains_key("answers_dropped");
    let partial = dropped_partial || total_sat || !d.global.is_empty() || !engine_partial.is_empty() || rows.iter().any(|r| r["partial"] == true);
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
        let mut big = a.clone();
        big[0] = 100;
        start = snap(&[(key, &big, 5)], &[]);
        end = snap(&[(key, &a, 5)], &[]);
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

    #[test]
    fn a_series_that_is_refused_vanished_or_unreadable_marks_its_check_with_the_reason_and_an_unreadable_snapshot_marks_every_check() {
        let n = crate::metrics::bounds_for("check_latency_us").len() + 1;
        let key = "check_latency_us|check=alpha";
        // 11 buckets totalling 30 with count 500: refused as inconsistent, its latency row has no figures but exists
        let mut b = vec![0u64; n];
        b[0] = 30;
        let mut end = snap(&[], &[("check_calls|check=beta", 4), ("check_calls|check=gamma", u64::MAX)]);
        end["histograms"] = json!({ key: {"buckets": b, "count": 500, "sum": 0, "max": 1} });
        let start = snap(&[], &[("check_calls|check=beta", 1), ("check_calls|check=delta", 2)]);
        let d = Diff::new(&end, Some(&start));
        assert_eq!(d.partial_checks.iter().map(String::as_str).collect::<Vec<_>>(), ["alpha", "delta", "gamma"], "{d:?}");
        assert_eq!(d.reasons_of("alpha"), [why::inconsistent()]);
        assert_eq!(d.reasons_of("delta"), [why::vanished()]);
        assert_eq!(d.reasons_of("gamma"), [why::saturated()]);
        assert!(d.reasons_of("beta").is_empty() && !d.is_partial("beta"), "control: a check with only valid series");
        let row = &latency(&d)["rows"][0];
        assert_eq!((row["check"].as_str(), row["partial"].clone(), row["count"].clone()), (Some("alpha"), json!(true), Value::Null), "{row}");
        // a snapshot that is not the stored shape marks every check
        let d = Diff::new(&json!({"counters": [1, 2]}), Some(&start));
        assert!(d.is_partial("anything") && d.reasons_of("anything") == [why::unreadable()] && !d.clean());
        assert!(!Diff::new(&Value::Null, None).clean());
        // a series the restore refused is carried in `rejected` and flagged in the next window
        let mut carried = snap(&[], &[("check_calls|check=beta", 4)]);
        carried["rejected"] = json!({ key: "layout" });
        let d = Diff::new(&carried, Some(&snap(&[], &[("check_calls|check=beta", 1)])));
        assert_eq!(d.reasons_of("alpha"), [why::rejected()]);
        assert_eq!(latency(&d)["rows"][0]["partial"], true);
    }
}
