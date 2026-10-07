//! The telemetry reports (D78, D77): `telemetry summary`, `telemetry events`, and the NET section of `impact`.
//!
//! Each report reads what was flushed to the databases and, when it runs inside the daemon, adds what the recorder holds
//! that has not been flushed yet, so a live report is current. Without a daemon it reads the databases only, and says so:
//! it then lacks at most the last `telemetry.flush_ms` of data.
// Discard triage (E3): every `.ok()` / `unwrap_or_default()` in this file is a deliberate keep, for these reasons:
// - text that does not parse or decode is the absent value (Node Number()/JSON.parse catch parity)
// - an absent field is the empty value
// A failure that must be seen goes through `crate::discard` instead.

use super::event::{DAY_MS, Extras, day_of};
use super::persist::{DayRow, TelDb};
use super::recorder::{Delta, Recorder};
use super::rollup::merge_days;
use super::route::{NetInput, PriceTable, net};
use crate::defaults;
use serde_json::{Map, Value, json};
use std::collections::BTreeMap;

/// A window like `7d`, `36h` or `14` (days) as whole days (at least 1); `None` when it is not one of those shapes.
pub fn parse_window(s: &str) -> Option<u64> {
    let s = s.trim();
    if s.is_empty() {
        return None;
    }
    let (num, unit) = match s.strip_suffix('d') {
        Some(n) => (n, 24),
        None => match s.strip_suffix('h') {
            Some(n) => (n, 1),
            None => (s, 24),
        },
    };
    let n: u64 = num.parse().ok()?;
    Some((n * unit).div_ceil(24).max(1))
}

/// The window in days: the requested one, else `telemetry.default_window_days`.
pub fn window_days(requested: &str) -> u64 {
    parse_window(requested).unwrap_or_else(|| defaults::num("telemetry.default_window_days"))
}

/// The upper bound of the bucket holding rank `q` of `hist`; `None` when it falls in the overflow bucket (above the
/// largest bound) or there is nothing recorded.
pub fn quantile(hist: &[u64], bounds: &[u64], q: f64) -> Option<u64> {
    let total: u64 = hist.iter().sum();
    if total == 0 {
        return None;
    }
    let rank = ((total as f64) * q).ceil().max(1.0) as u64;
    let mut seen = 0;
    for (i, c) in hist.iter().enumerate() {
        seen += c;
        if seen >= rank {
            return bounds.get(i).copied();
        }
    }
    None
}

/// Counter rows of the last `days` days (hot and archive merged), plus what the recorder has not flushed yet (counted
/// in today's row).
fn window_rows(tel: Option<&TelDb>, rec: Option<&Recorder>, days: u64, now_ms: u64) -> Vec<DayRow> {
    let today = day_of(now_ms);
    let from = today - days as i64 + 1;
    let mut rows = tel.map(|t| merge_days(t.counts(from, today), t.daily(from, today))).unwrap_or_default();
    if let Some(r) = rec {
        for d in r.pending_deltas() {
            match rows.iter_mut().find(|x| x.day == today && x.delta.k == d.k && x.delta.h == d.h && x.delta.e == d.e && x.delta.o == d.o) {
                Some(x) => x.delta.merge(&d),
                None => rows.push(DayRow { day: today, delta: d }),
            }
        }
    }
    rows
}

/// Bytes injected into model context by hooks in `rows` (the whole-hook rows; per-check `ib` is attribution, not an addition).
fn hook_injected(rows: &[DayRow]) -> u64 {
    rows.iter().filter(|r| r.delta.k == "hook").map(|r| r.delta.ib_sum).sum()
}

fn add(m: &mut Map<String, Value>, key: &str, by: u64) {
    let cur = m.get(key).and_then(Value::as_u64).unwrap_or(0);
    m.insert(key.to_string(), json!(cur + by));
}

/// The `telemetry summary` report for the last `days` days.
pub fn summary_json(tel: Option<&TelDb>, rec: Option<&Recorder>, days: u64, now_ms: u64) -> Value {
    let rows = window_rows(tel, rec, days, now_ms);
    let bounds = super::persist::defaults_bounds();
    let (mut by_outcome, mut by_kind) = (Map::new(), Map::new());
    let mut by_check: BTreeMap<(String, String), Delta> = BTreeMap::new();
    let mut total = 0;
    for r in &rows {
        total += r.delta.n;
        add(&mut by_outcome, &r.delta.o, r.delta.n);
        add(&mut by_kind, &r.delta.k, r.delta.n);
        let slot = by_check.entry((r.delta.k.clone(), r.delta.h.clone())).or_insert_with(|| Delta {
            k: r.delta.k.clone(),
            h: r.delta.h.clone(),
            e: String::new(),
            o: String::new(),
            n: 0,
            us_sum: 0,
            ib_sum: 0,
            hist: vec![],
        });
        slot.merge(&r.delta);
    }
    let mut outcomes_of: BTreeMap<(String, String), Map<String, Value>> = BTreeMap::new();
    for r in &rows {
        add(outcomes_of.entry((r.delta.k.clone(), r.delta.h.clone())).or_default(), &r.delta.o, r.delta.n);
    }
    let by_hook: Vec<Value> = by_check
        .iter()
        .map(|((k, h), d)| {
            json!({
                "k": k, "h": h, "n": d.n, "outcomes": outcomes_of.get(&(k.clone(), h.clone())), "injected_bytes": d.ib_sum,
                "mean_us": d.us_sum.checked_div(d.n).unwrap_or(0),
                "p50_us": quantile(&d.hist, &bounds, 0.5), "p95_us": quantile(&d.hist, &bounds, 0.95), "p99_us": quantile(&d.hist, &bounds, 0.99),
            })
        })
        .collect();
    let drops = rec.map(|r| r.drops());
    json!({
        "window": {"days": days, "from_day": day_of(now_ms) - days as i64 + 1, "to_day": day_of(now_ms)},
        "persisted": tel.is_some(),
        "live": rec.is_some(),
        "note": defaults::render("msg.tel_loss_window", &[("flush_ms", &defaults::num("telemetry.flush_ms"))]),
        "invocations": total,
        "injected_bytes": hook_injected(&rows),
        "by_outcome": by_outcome,
        "by_kind": by_kind,
        "by_hook": by_hook,
        "latency_note": defaults::text("msg.metrics_quantile_note"),
        "dropped": drops.map(|d| json!({"slots": d.slots, "ring": d.ring})),
        "events_held": tel.map(|t| t.held_events()),
    })
}

/// The `telemetry events` report: the newest events of `kind` (empty: any) in the last `days` days, flushed and not yet
/// flushed, at most `limit`, oldest first.
pub fn events_json(tel: Option<&TelDb>, rec: Option<&Recorder>, kind: &str, days: u64, limit: usize, now_ms: u64) -> Value {
    let since = now_ms.saturating_sub(days * DAY_MS);
    let mut ev = tel.map(|t| t.events(kind, since, limit)).unwrap_or_default();
    if let Some(r) = rec {
        ev.extend(r.pending_events().into_iter().filter(|e| (kind.is_empty() || e.kind.name() == kind) && e.ts_ms >= since));
    }
    ev.sort_by_key(|e| e.ts_ms);
    let skip = ev.len().saturating_sub(limit);
    let events: Vec<Value> = ev.into_iter().skip(skip).map(|e| e.to_json()).collect();
    json!({"window": {"days": days}, "kind": kind, "count": events.len(), "events": events})
}

/// The NET section of `impact` for the last `days` days: routing saved and spent up in both directions, minus the spenders.
pub fn net_json(tel: Option<&TelDb>, rec: Option<&Recorder>, days: u64, now_ms: u64) -> Value {
    let since = now_ms.saturating_sub(days * DAY_MS);
    let mut events = tel.map(|t| t.impact_events(since)).unwrap_or_default();
    if let Some(r) = rec {
        events.extend(r.pending_events().into_iter().filter(|e| matches!(e.extras, Extras::Route(_) | Extras::Spawn(_) | Extras::Jev(_)) && e.ts_ms >= since));
    }
    let rows = window_rows(tel, rec, days, now_ms);
    let prices = PriceTable::from_defaults();
    let mut v = net(&NetInput {
        events: &events,
        injected_bytes: hook_injected(&rows),
        prices: &prices,
        link_window_ms: defaults::num("telemetry.link_window_s") * 1000,
        bytes_per_token: defaults::num("telemetry.bytes_per_token"),
    });
    v["window"] = json!({"days": days});
    v
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn windows_parse_in_days_and_hours() {
        assert_eq!(parse_window("7d"), Some(7));
        assert_eq!(parse_window("36h"), Some(2));
        assert_eq!(parse_window("1h"), Some(1));
        assert_eq!(parse_window("14"), Some(14));
        assert_eq!(parse_window("soon"), None);
        assert_eq!(parse_window(""), None);
        assert_eq!(window_days("bogus"), defaults::num("telemetry.default_window_days"));
    }

    #[test]
    fn quantiles_are_bucket_upper_bounds_and_null_above_the_last() {
        let b = [100, 1000];
        assert_eq!(quantile(&[9, 1, 0], &b, 0.5), Some(100));
        assert_eq!(quantile(&[9, 1, 0], &b, 0.95), Some(1000));
        assert_eq!(quantile(&[0, 0, 5], &b, 0.5), None);
        assert_eq!(quantile(&[0, 0, 0], &b, 0.5), None);
    }
}
