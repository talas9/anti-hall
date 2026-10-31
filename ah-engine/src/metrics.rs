//! Built-in metrics (D51): counters, gauges and latency histograms, in memory and bounded.
//!
//! Every metric name is registered in `defaults/telemetry.toml` (`metric.<name>`), so the generated reference lists
//! it and a test catches a name nobody registered. A series is a metric name plus its label values; the number of
//! series per metric is capped so a label with unbounded values (a path, a session id) cannot grow memory.
// Discard triage (E3): every `.ok()` / `unwrap_or_default()` in this file is a deliberate keep, for these reasons:
// - an absent field is the empty value
// A failure that must be seen goes through `crate::discard` instead.

use crate::defaults;
use serde_json::{Map, Value, json};
use std::collections::BTreeMap;

/// A latency histogram with the fixed buckets from `telemetry.latency_buckets_us`.
#[derive(Debug, Clone, Default)]
struct Hist {
    /// Count per bucket; the last entry counts values above the largest bound.
    buckets: Vec<u64>,
    count: u64,
    sum: u64,
    max: u64,
}

impl Hist {
    fn observe(&mut self, bounds: &[u64], v: u64) {
        if self.buckets.is_empty() {
            self.buckets = vec![0; bounds.len() + 1];
        }
        let i = bounds.iter().position(|b| v <= *b).unwrap_or(bounds.len());
        self.buckets[i] += 1;
        self.count += 1;
        self.sum += v;
        self.max = self.max.max(v);
    }

    /// Upper bound of the bucket holding rank `q` (0..1); values above the last bound report the observed maximum.
    fn quantile(&self, bounds: &[u64], q: f64) -> u64 {
        if self.count == 0 {
            return 0;
        }
        let rank = ((self.count as f64) * q).ceil().max(1.0) as u64;
        let mut seen = 0;
        for (i, c) in self.buckets.iter().enumerate() {
            seen += c;
            if seen >= rank {
                return bounds.get(i).copied().unwrap_or(self.max);
            }
        }
        self.max
    }
}

/// The registry of live series.
#[derive(Debug, Default)]
pub struct Metrics {
    counters: BTreeMap<String, u64>,
    gauges: BTreeMap<String, f64>,
    hists: BTreeMap<String, Hist>,
    series_per_metric: BTreeMap<String, usize>,
    /// Per metric, the series past `telemetry.max_series` that kept their `telemetry.overflow_keep_labels` value.
    kept_per_metric: BTreeMap<String, usize>,
}

/// Series key: `name` then `|label=value` pairs in label order.
fn series(name: &str, labels: &[(&str, &str)]) -> String {
    let mut k = name.to_string();
    for (l, v) in labels {
        k.push('|');
        k.push_str(l);
        k.push('=');
        k.push_str(v);
    }
    k
}

/// The latency histogram bucket bounds (`telemetry.latency_buckets_us`).
fn bucket_bounds() -> Vec<u64> {
    defaults::raw("telemetry.latency_buckets_us").as_array().unwrap_or_default().iter().filter_map(defaults::V::as_integer).map(|v| v.max(0) as u64).collect()
}

/// The byte histogram bucket bounds (`telemetry.byte_buckets_bytes`).
fn byte_bounds() -> Vec<u64> {
    defaults::raw("telemetry.byte_buckets_bytes").as_array().unwrap_or_default().iter().filter_map(defaults::V::as_integer).map(|v| v.max(0) as u64).collect()
}

/// True when the registered metric `name` counts bytes (unit `bytes`): its histogram uses the byte buckets, not the latency ones.
fn is_byte_metric(name: &str) -> bool {
    let key = format!("metric.{name}");
    defaults::has(&key) && defaults::raw(&key).str_field("unit") == defaults::text("telemetry.byte_unit")
}

/// The bucket bounds of the histogram `name`.
fn bounds_for(name: &str) -> Vec<u64> {
    if is_byte_metric(name) { byte_bounds() } else { bucket_bounds() }
}

/// True when `name` is a registered metric.
pub fn is_registered(name: &str) -> bool {
    defaults::has(&format!("metric.{name}"))
}

/// Counts bumped by code that holds no `Metrics` (resolvers, discovery): series key -> (name, labels, count). The daemon moves them
/// into its registry whenever it reads or snapshots the metrics ([`drain_pending`]).
type Pending = BTreeMap<String, (String, Vec<(String, String)>, u64)>;
static PENDING: std::sync::Mutex<Pending> = std::sync::Mutex::new(BTreeMap::new());

#[cfg(test)]
thread_local! {
    static THIS_THREAD: std::sync::Mutex<BTreeMap<String, u64>> = const { std::sync::Mutex::new(BTreeMap::new()) };
}

/// Test only: what the calling thread bumped for one series (the process-wide pending table is shared by parallel tests).
#[cfg(test)]
pub(crate) fn bumped_on_this_thread(name: &str, labels: &[(&str, &str)]) -> u64 {
    THIS_THREAD.with(|t| t.lock().unwrap_or_else(|e| e.into_inner()).get(&series(name, labels)).copied().unwrap_or(0))
}

/// Add one to the counter `name` from code that has no `Metrics` at hand. A name nobody registered is ignored (a test catches it),
/// and so is a new series once `telemetry.max_series` are waiting, so the table stays bounded between two drains.
pub fn bump(name: &str, labels: &[(&str, &str)]) {
    bump_by(name, labels, 1);
}

/// Add `by` to the counter `name` from code that has no `Metrics` at hand ([`bump`] with a count; the same bounds); `0` adds nothing.
pub fn bump_by(name: &str, labels: &[(&str, &str)], by: u64) {
    if by == 0 || !is_registered(name) {
        return;
    }
    let key = series(name, labels);
    #[cfg(test)]
    THIS_THREAD.with(|t| *t.lock().unwrap_or_else(|e| e.into_inner()).entry(key.clone()).or_insert(0) += by);
    let mut g = PENDING.lock().unwrap_or_else(|e| e.into_inner());
    // a metric with its own series cap may fill the pending map up to it (its counts are not dropped at the global cap)
    let room = defaults::raw("telemetry.max_series_by_metric").get(name).and_then(defaults::V::as_integer).map_or(0, |c| c.max(0) as usize);
    if !g.contains_key(&key) && g.len() >= (defaults::num("telemetry.max_series") as usize).max(room) {
        return;
    }
    g.entry(key).or_insert_with(|| (name.to_string(), labels.iter().map(|(l, v)| (l.to_string(), v.to_string())).collect(), 0)).2 += by;
}

/// Whether the telemetry of the recent fixes (config cache, newest-tail reads, served requests, SIGINT drains) is on (`recent_tel.enabled`).
pub fn recent_on() -> bool {
    defaults::num("recent_tel.enabled") != 0
}

/// Move the counts [`bump`] gathered into `m`.
pub fn drain_pending(m: &mut Metrics) {
    let taken = std::mem::take(&mut *PENDING.lock().unwrap_or_else(|e| e.into_inner()));
    for (name, labels, n) in taken.into_values() {
        let l: Vec<(&str, &str)> = labels.iter().map(|(a, b)| (a.as_str(), b.as_str())).collect();
        m.add(&name, &l, n);
    }
}

impl Metrics {
    /// Resolve the series key, collapsing label values into the overflow series once a metric has too many.
    fn key(&mut self, name: &str, labels: &[(&str, &str)], exists: bool) -> String {
        let k = series(name, labels);
        if exists || labels.is_empty() {
            return k;
        }
        let cap = defaults::raw("telemetry.max_series_by_metric")
            .get(name)
            .and_then(defaults::V::as_integer)
            .map_or(defaults::num("telemetry.max_series") as usize, |c| c.max(1) as usize);
        let n = self.series_per_metric.entry(name.to_string()).or_insert(0);
        if *n >= cap {
            let over = defaults::text("telemetry.overflow_label");
            // a metric with its own keep list (`telemetry.overflow_keep_by_metric`) folds only the labels outside it, whatever the count of
            // series that keep a value: those are bounded by checks x stage words, and no count of the metric may be lost
            if let Some(own) = defaults::raw("telemetry.overflow_keep_by_metric").get(name).map(defaults::V::strings) {
                let partial: Vec<(&str, &str)> = labels.iter().map(|(l, v)| (*l, if own.contains(l) { *v } else { over })).collect();
                return series(name, &partial);
            }
            // past the cap the labels that name WHO (`telemetry.overflow_keep_labels`, e.g. the check) stay and the others collapse, so
            // a per-check cost stays visible; those series are bounded in turn by `telemetry.max_series_kept`
            let keep = defaults::list("telemetry.overflow_keep_labels");
            if labels.iter().any(|(l, _)| keep.contains(l)) {
                let partial: Vec<(&str, &str)> = labels.iter().map(|(l, v)| (*l, if keep.contains(l) { *v } else { over })).collect();
                let pk = series(name, &partial);
                if self.counters.contains_key(&pk) || self.hists.contains_key(&pk) {
                    return pk;
                }
                let kept = self.kept_per_metric.entry(name.to_string()).or_insert(0);
                if *kept < defaults::num("telemetry.max_series_kept") as usize {
                    *kept += 1;
                    return pk;
                }
            }
            let collapsed: Vec<(&str, &str)> = labels.iter().map(|(l, _)| (*l, over)).collect();
            return series(name, &collapsed);
        }
        *n += 1;
        k
    }

    /// Add `by` to a counter.
    pub fn add(&mut self, name: &str, labels: &[(&str, &str)], by: u64) {
        let exists = self.counters.contains_key(&series(name, labels));
        let k = self.key(name, labels, exists);
        *self.counters.entry(k).or_insert(0) += by;
    }

    /// Add one to a counter.
    pub fn inc(&mut self, name: &str, labels: &[(&str, &str)]) {
        self.add(name, labels, 1);
    }

    /// Set a gauge.
    pub fn set(&mut self, name: &str, value: f64) {
        self.gauges.insert(name.to_string(), value);
    }

    /// Record one observation (microseconds) in a histogram.
    pub fn observe(&mut self, name: &str, labels: &[(&str, &str)], micros: u64) {
        let bounds: Vec<u64> = bounds_for(name);
        let exists = self.hists.contains_key(&series(name, labels));
        let k = self.key(name, labels, exists);
        self.hists.entry(k).or_default().observe(&bounds, micros);
    }

    /// Record one observation (bytes) in a histogram registered with unit `bytes` (the same as [`Metrics::observe`]; the name picks
    /// the byte buckets).
    pub fn observe_bytes(&mut self, name: &str, labels: &[(&str, &str)], bytes: u64) {
        self.observe(name, labels, bytes);
    }

    /// A counter's value (0 when never incremented).
    pub fn counter(&self, name: &str, labels: &[(&str, &str)]) -> u64 {
        self.counters.get(&series(name, labels)).copied().unwrap_or(0)
    }

    /// The sum of a counter over all label values.
    pub fn counter_total(&self, name: &str) -> u64 {
        let prefix = format!("{name}|");
        self.counters.iter().filter(|(k, _)| *k == name || k.starts_with(&prefix)).map(|(_, v)| *v).sum()
    }

    /// The counters and histograms as JSON, for a snapshot in storage (D51). Gauges are live readings and are not kept.
    pub fn export(&self) -> Value {
        let hists: Map<String, Value> =
            self.hists.iter().map(|(k, h)| (k.clone(), json!({"buckets": h.buckets, "count": h.count, "sum": h.sum, "max": h.max}))).collect();
        json!({"counters": self.counters, "histograms": hists})
    }

    /// Load a snapshot made by [`Metrics::export`]: its counters and histograms become the starting values. A histogram
    /// whose bucket count no longer matches `telemetry.latency_buckets_us` is skipped (its buckets would be misread).
    pub fn import(&mut self, v: &Value) {
        if let Some(c) = v.get("counters").and_then(Value::as_object) {
            for (k, n) in c {
                if let Some(n) = n.as_u64() {
                    self.track(k);
                    self.counters.insert(k.clone(), n);
                }
            }
        }
        if let Some(h) = v.get("histograms").and_then(Value::as_object) {
            for (k, x) in h {
                let buckets: Vec<u64> = x.get("buckets").and_then(Value::as_array).map(|a| a.iter().filter_map(Value::as_u64).collect()).unwrap_or_default();
                if buckets.len() != bounds_for(k.split('|').next().unwrap_or("")).len() + 1 {
                    continue;
                }
                let n = |f: &str| x.get(f).and_then(Value::as_u64).unwrap_or(0);
                self.track(k);
                self.hists.insert(k.clone(), Hist { buckets, count: n("count"), sum: n("sum"), max: n("max") });
            }
        }
    }

    /// Count a series loaded from a snapshot against its metric's series cap.
    fn track(&mut self, key: &str) {
        if key.contains('|') && !self.counters.contains_key(key) && !self.hists.contains_key(key) {
            let name = key.split('|').next().unwrap_or("").to_string();
            *self.series_per_metric.entry(name).or_insert(0) += 1;
        }
    }

    /// Everything as JSON, optionally only series whose `check` label equals `check`.
    pub fn snapshot(&self, check: &str) -> Value {
        let wanted = |k: &str| check.is_empty() || k.contains(&format!("|check={check}"));
        let parse = |k: &str| -> (String, Map<String, Value>) {
            let mut it = k.split('|');
            let name = it.next().unwrap_or("").to_string();
            let labels = it.filter_map(|kv| kv.split_once('=')).map(|(l, v)| (l.to_string(), json!(v))).collect();
            (name, labels)
        };
        let counters: Vec<Value> = self
            .counters
            .iter()
            .filter(|(k, _)| wanted(k))
            .map(|(k, v)| {
                let (name, labels) = parse(k);
                json!({"name": name, "labels": labels, "value": v})
            })
            .collect();
        let gauges: Vec<Value> = if check.is_empty() { self.gauges.iter().map(|(k, v)| json!({"name": k, "value": v})).collect() } else { vec![] };
        let histograms: Vec<Value> = self
            .hists
            .iter()
            .filter(|(k, _)| wanted(k))
            .map(|(k, h)| {
                let (name, labels) = parse(k);
                let bounds = bounds_for(&name);
                let mean = h.sum.checked_div(h.count).unwrap_or(0);
                if is_byte_metric(&name) {
                    return json!({
                        "name": name, "labels": labels, "count": h.count, "mean_bytes": mean, "max_bytes": h.max,
                        "p50_bytes": h.quantile(&bounds, 0.50), "p95_bytes": h.quantile(&bounds, 0.95), "p99_bytes": h.quantile(&bounds, 0.99),
                        "quantile_note": defaults::text("msg.metrics_quantile_note"),
                    });
                }
                json!({
                    "name": name, "labels": labels, "count": h.count, "mean_us": mean, "max_us": h.max,
                    "p50_us": h.quantile(&bounds, 0.50), "p95_us": h.quantile(&bounds, 0.95), "p99_us": h.quantile(&bounds, 0.99),
                    "quantile_note": defaults::text("msg.metrics_quantile_note"),
                })
            })
            .collect();
        json!({"counters": counters, "gauges": gauges, "histograms": histograms})
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn counters_labels_and_totals() {
        let mut m = Metrics::default();
        m.inc("check_calls", &[("check", "git")]);
        m.inc("check_calls", &[("check", "git")]);
        m.inc("check_calls", &[("check", "other")]);
        assert_eq!(m.counter("check_calls", &[("check", "git")]), 2);
        assert_eq!(m.counter_total("check_calls"), 3);
        assert_eq!(m.counter("check_calls", &[("check", "none")]), 0);
    }

    #[test]
    fn histogram_quantiles_are_bucket_upper_bounds() {
        let mut m = Metrics::default();
        for v in [50, 60, 70, 80, 90, 120, 130, 140, 150, 9000] {
            m.observe("check_latency_us", &[("check", "git")], v);
        }
        let s = m.snapshot("");
        let h = &s["histograms"][0];
        assert_eq!(h["count"], 10);
        assert_eq!(h["p50_us"], 100, "the fifth of ten values (90us) sits in the <=100 bucket");
        assert_eq!(h["p95_us"], 10000, "the tenth value (9000us) sits in the <=10000 bucket");
        assert_eq!(h["p99_us"], 10000);
        assert_eq!(h["max_us"], 9000);
    }

    #[test]
    fn byte_histograms_use_the_byte_buckets_and_survive_a_snapshot_round_trip() {
        let mut m = Metrics::default();
        for v in [1000, 5000, 3 * 1024 * 1024] {
            m.observe_bytes("check_mem_peak_bytes", &[("check", "git")], v);
        }
        m.observe("check_latency_us", &[("check", "git")], 300);
        let s = m.snapshot("");
        let h = s["histograms"].as_array().unwrap().iter().find(|h| h["name"] == "check_mem_peak_bytes").unwrap().clone();
        assert_eq!((h["count"].as_u64(), h["max_bytes"].as_u64()), (Some(3), Some(3 * 1024 * 1024)));
        assert_eq!(h["p50_bytes"], 16384, "5000 B sits in the <=16384 byte bucket");
        assert_eq!(h["p99_bytes"], 4194304, "3 MiB sits in the <=4 MiB bucket");
        let mut back = Metrics::default();
        back.import(&m.export());
        assert_eq!(back.snapshot(""), s, "both histogram families come back from storage with their own bucket counts");
    }

    #[test]
    fn a_label_with_unbounded_values_cannot_grow_memory() {
        let mut m = Metrics::default();
        for i in 0..10_000 {
            m.inc("check_calls", &[("check", &format!("c{i}"))]);
        }
        let cap = defaults::num("telemetry.max_series") as usize + defaults::num("telemetry.max_series_kept") as usize;
        assert!(m.counters.len() <= cap + 1, "{} series", m.counters.len());
        assert_eq!(m.counter_total("check_calls"), 10_000, "overflow is still counted");
    }

    #[test]
    fn past_the_cap_the_check_name_stays_and_only_the_other_labels_collapse() {
        let mut m = Metrics::default();
        let cap = defaults::num("telemetry.max_series") as usize;
        let sizes = ["lt64k", "lt1m", "lt16m", "ge16m", "unknown"];
        let checks = cap + 60; // more distinct checks than the cap: the pre-fix code folded the overflow into one `other`
        for i in 0..checks {
            for (j, sz) in sizes.iter().enumerate() {
                m.add("check_bytes_read", &[("check", &format!("c{i}")), ("size", sz)], 1000 + j as u64);
            }
        }
        let last = format!("c{}", checks - 1);
        assert!(
            m.counters.keys().any(|k| k.contains(&format!("check={last}|"))),
            "the last check (past the cap) still has its own series: {:?}",
            m.counters.keys().filter(|k| k.contains("other")).take(3).collect::<Vec<_>>()
        );
        let total: u64 = (0..sizes.len() as u64).map(|j| 1000 + j).sum::<u64>() * checks as u64;
        assert_eq!(m.counter_total("check_bytes_read"), total, "nothing is lost, only coarser");
        assert!(m.counters.len() <= cap + defaults::num("telemetry.max_series_kept") as usize + 1, "{} series", m.counters.len());
        // a label that is not a check name (a path-like value) is still folded at the cap
        let mut n = Metrics::default();
        for i in 0..10_000 {
            n.inc("check_calls", &[("check", &format!("c{i}"))]);
        }
        assert!(n.counters.len() <= cap + defaults::num("telemetry.max_series_kept") as usize + 1, "the kept series are bounded too: {}", n.counters.len());
        assert_eq!(n.counter_total("check_calls"), 10_000);
    }

    #[test]
    fn export_and_import_round_trip_counters_and_histograms() {
        let mut m = Metrics::default();
        m.inc("check_calls", &[("check", "git")]);
        m.add("requests", &[], 41);
        m.observe("check_latency_us", &[("check", "git")], 300);
        m.set("rss_kb", 9.0);
        let mut n = Metrics::default();
        n.import(&m.export());
        assert_eq!(n.counter("check_calls", &[("check", "git")]), 1);
        assert_eq!(n.counter_total("requests"), 41);
        assert_eq!(n.snapshot("")["histograms"][0]["count"], 1);
        assert_eq!(n.snapshot("")["gauges"].as_array().unwrap().len(), 0, "gauges are live readings, not restored");
        n.inc("requests", &[]);
        assert_eq!(n.counter_total("requests"), 42, "counting continues from the snapshot");
        let mut bad = m.export();
        bad["histograms"]["check_latency_us|check=git"]["buckets"] = json!([1, 2]);
        let mut o = Metrics::default();
        o.import(&bad);
        assert_eq!(o.snapshot("")["histograms"].as_array().unwrap().len(), 0, "a histogram with other buckets is skipped");
    }

    #[test]
    fn snapshot_can_be_filtered_by_check() {
        let mut m = Metrics::default();
        m.inc("check_calls", &[("check", "git")]);
        m.inc("check_calls", &[("check", "other")]);
        m.inc("requests", &[]);
        let s = m.snapshot("git");
        assert_eq!(s["counters"].as_array().unwrap().len(), 1);
    }
}
