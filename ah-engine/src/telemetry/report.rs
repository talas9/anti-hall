//! The telemetry reports (D78, D77): `telemetry summary`, `telemetry events`, and the NET section of `impact`.
//!
//! Each report reads what was flushed to the databases and, when it runs inside the daemon, adds what the recorder holds
//! that has not been flushed yet, so a live report is current. Without a daemon it reads the databases only, and says so:
//! it then lacks at most the last `telemetry.flush_ms` of data.
// Discard triage (E3): every `.ok()` / `unwrap_or_default()` in this file is a deliberate keep, for these reasons:
// - text that does not parse or decode is the absent value (Node Number()/JSON.parse catch parity)
// - an absent field is the empty value
// A failure that must be seen goes through `crate::discard` instead.

use super::event::{DAY_MS, Event, Extras, Fields, Kind, day_of};
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

/// The events of `kind` in the last `days` days, flushed and not yet flushed, oldest first, at most `telemetry.summary_event_limit`.
fn kind_events(tel: Option<&TelDb>, rec: Option<&Recorder>, kind: Kind, days: u64, now_ms: u64) -> Vec<Event> {
    let since = now_ms.saturating_sub(days * DAY_MS);
    let limit = defaults::num("telemetry.summary_event_limit") as usize;
    let mut ev = tel.map(|t| t.events(kind.name(), since, limit)).unwrap_or_default();
    if let Some(r) = rec {
        ev.extend(r.pending_events().into_iter().filter(|e| e.kind == kind && e.ts_ms >= since));
    }
    ev.sort_by_key(|e| e.ts_ms);
    let skip = ev.len().saturating_sub(limit);
    ev.into_iter().skip(skip).collect()
}

fn fields_of(e: &Event) -> Option<&Fields> {
    match &e.extras {
        Extras::Fields(f) => Some(f),
        Extras::Jev(j) => Some(&j.more),
        _ => None,
    }
}

fn bump(m: &mut Map<String, Value>, key: &str) {
    add(m, key, 1);
}

/// `telemetry summary`'s per-kind detail: what the Jev calls, state-writing commands, model calls and daemon health snapshots
/// of the window said. The counters (`by_hook`) already carry every kind's count, outcomes and latency; these sections add the
/// numbers the counters do not hold (cost, items changed, tokens, readings).
fn detail_sections(tel: Option<&TelDb>, rec: Option<&Recorder>, days: u64, now_ms: u64) -> Value {
    // jev: per integration
    let mut jev: BTreeMap<String, Map<String, Value>> = BTreeMap::new();
    let (mut j_calls, mut j_cache, mut j_err, mut j_open, mut j_cost) = (0u64, 0u64, 0u64, 0u64, 0u64);
    for e in kind_events(tel, rec, Kind::Jev, days, now_ms) {
        let Extras::Jev(j) = &e.extras else { continue };
        let slot = jev.entry(j.integration.as_str().to_string()).or_default();
        let (backend, breaker) = (j.more.get_tok("backend").unwrap_or(""), j.more.get_tok("breaker").unwrap_or(""));
        let failed = matches!(e.o, super::event::Outcome::Error | super::event::Outcome::Timeout);
        add(slot, "calls", 1);
        add(slot, "cost_uc", j.cost_uc);
        add(slot, "ms_sum", e.ms as u64);
        let max = slot.get("ms_max").and_then(Value::as_u64).unwrap_or(0).max(e.ms as u64);
        slot.insert("ms_max".into(), json!(max));
        let verdicts = slot.entry("verdicts").or_insert_with(|| json!({}));
        if let Some(m) = verdicts.as_object_mut() {
            bump(m, j.verdict.as_str());
        }
        let modes = slot.entry("modes").or_insert_with(|| json!({}));
        if let Some(m) = modes.as_object_mut() {
            bump(m, j.mode.as_str());
        }
        if backend == "cache" {
            add(slot, "cache_hits", 1);
            j_cache += 1;
        }
        if failed {
            add(slot, "errors", 1);
            j_err += 1;
        }
        if breaker == "open" {
            add(slot, "breaker_open", 1);
            j_open += 1;
        }
        j_calls += 1;
        j_cost += j.cost_uc;
    }
    let jev_by: Map<String, Value> = jev
        .into_iter()
        .map(|(k, mut m)| {
            let calls = m.get("calls").and_then(Value::as_u64).unwrap_or(0);
            let sum = m.remove("ms_sum").and_then(|v| v.as_u64()).unwrap_or(0);
            m.insert("mean_ms".into(), json!(sum.checked_div(calls).unwrap_or(0)));
            (k, Value::Object(m))
        })
        .collect();
    // cmd: per command
    let mut cmd: BTreeMap<String, Map<String, Value>> = BTreeMap::new();
    for e in kind_events(tel, rec, Kind::Cmd, days, now_ms) {
        let slot = cmd.entry(e.h.as_str().to_string()).or_default();
        add(slot, "runs", 1);
        add(slot, "ms_total", e.ms as u64);
        if e.o == super::event::Outcome::Error {
            add(slot, "errors", 1);
        }
        add(slot, "items", fields_of(&e).and_then(|f| f.get_num("items")).unwrap_or(0));
    }
    // model: per backend and model alias
    let mut model: BTreeMap<String, Map<String, Value>> = BTreeMap::new();
    for e in kind_events(tel, rec, Kind::Model, days, now_ms) {
        let slot = model.entry(format!("{}/{}", e.h, e.e)).or_default();
        add(slot, "calls", 1);
        add(slot, "ms_total", e.ms as u64);
        if e.o != super::event::Outcome::Allow {
            add(slot, "errors", 1);
        }
        add(slot, "tokens_in", fields_of(&e).and_then(|f| f.get_num("tokens_in")).unwrap_or(0));
        add(slot, "tokens_out", fields_of(&e).and_then(|f| f.get_num("tokens_out")).unwrap_or(0));
    }
    // daemon: the newest snapshot
    let snaps = kind_events(tel, rec, Kind::Daemon, days, now_ms);
    let latest = snaps.last().map(|e| {
        let mut m = Map::new();
        m.insert("ts_ms".into(), json!(e.ts_ms));
        if let Some(f) = fields_of(e) {
            f.put_json(&mut m);
        }
        Value::Object(m)
    });
    json!({
        "jev": {"calls": j_calls, "cache_hits": j_cache, "errors": j_err, "breaker_open": j_open, "cost_uc": j_cost, "by_integration": jev_by},
        "cmd": cmd,
        "model": model,
        "daemon": {"snapshots": snaps.len(), "latest": latest},
    })
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
        "detail": detail_sections(tel, rec, days, now_ms),
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

    /// A fixed moment so the report is the same text on every run.
    const NOW: u64 = 1_790_000_000_000;

    fn at(mut e: Event, back_s: u64) -> Event {
        e.ts_ms = NOW - back_s * 1000;
        e
    }

    #[test]
    fn the_summary_covers_node_hooks_jev_commands_model_calls_and_daemon_health_snapshot() {
        use super::super::emit::{self, JevCall, ModelCall, NodeRun};
        use super::super::event::Outcome;
        let rec = Recorder::from_defaults();
        rec.record(Kind::Hook, "hook", "PreToolUse", Outcome::Allow, 800, 0);
        let node = |id, o, micros, out_bytes, exit, fate| {
            at(emit::node_run(&NodeRun { id, event: "PreToolUse", outcome: o, micros, out_bytes, err_bytes: 0, exit, fate }), 600)
        };
        rec.event(node("git-guard", Outcome::Allow, 21_000, 0, Some(0), "ran"));
        rec.event(node("git-guard", Outcome::Block, 34_000, 120, Some(2), "ran"));
        rec.event(node("edit-guard", Outcome::Timeout, 5_000_000, 0, None, "timeout"));
        let jev = |verdict, o, ms, cost_uc, backend, breaker, error| {
            at(
                emit::jev_call(&JevCall {
                    integration: "speculation",
                    mode: "on",
                    verdict,
                    outcome: o,
                    conf_pm: Some(940),
                    ms,
                    cost_uc,
                    backend,
                    breaker,
                    error,
                }),
                300,
            )
        };
        rec.event(jev("added", Outcome::Advise, 410, 85, "jev", "closed", None));
        rec.event(jev("none", Outcome::Allow, 0, 0, "cache", "closed", None));
        rec.event(jev("no-answer", Outcome::Error, 1200, 0, "baseline-only", "open", Some("http-500")));
        rec.event(at(emit::command_run("migrate", "-", 0, 48_000, 2), 120));
        rec.event(at(emit::command_run("config", "heal", 1, 9_000, 0), 90));
        rec.event(at(
            emit::model_call(&ModelCall {
                backend: "codex",
                model: "sonnet",
                purpose: "judge",
                outcome: Outcome::Allow,
                micros: 2_300_000,
                tokens_in: Some(900),
                tokens_out: Some(60),
            }),
            60,
        ));
        rec.event(at(
            emit::daemon_snapshot(false, &[("rss_kb", 88_000), ("rss_cap_kb", 400_000), ("restarts", 0), ("workers", 4), ("busy", 1), ("queue_depth", 0)]),
            30,
        ));
        rec.event(at(
            emit::daemon_snapshot(
                true,
                &[("rss_kb", 91_500), ("rss_cap_kb", 400_000), ("restarts", 1), ("workers", 4), ("busy", 3), ("queue_depth", 2), ("saturated", 1)],
            ),
            5,
        ));
        let v = summary_json(None, Some(&rec), 7, NOW);
        insta::assert_snapshot!("summary_with_coverage_telemetry", serde_json::to_string_pretty(&v).unwrap());
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
