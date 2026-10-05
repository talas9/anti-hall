//! Built-in metrics (D51): counters, gauges and latency histograms, in memory and bounded.
//!
//! Every metric name is registered in `defaults/telemetry.toml` (`metric.<name>`), so the generated reference lists
//! it and a test catches a name nobody registered. A series is a metric name plus its label values; the number of
//! series per metric is capped so a label with unbounded values (a path, a session id) cannot grow memory.
use crate::defaults;
use serde_json::{json, Map, Value};
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

/// True when `name` is a registered metric.
pub fn is_registered(name: &str) -> bool {
    defaults::has(&format!("metric.{name}"))
}

impl Metrics {
    /// Resolve the series key, collapsing label values into the overflow series once a metric has too many.
    fn key(&mut self, name: &str, labels: &[(&str, &str)], exists: bool) -> String {
        let k = series(name, labels);
        if exists || labels.is_empty() {
            return k;
        }
        let n = self.series_per_metric.entry(name.to_string()).or_insert(0);
        if *n >= defaults::num("telemetry.max_series") as usize {
            let over = defaults::text("telemetry.overflow_label");
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
        let bounds: Vec<u64> = bucket_bounds();
        let exists = self.hists.contains_key(&series(name, labels));
        let k = self.key(name, labels, exists);
        self.hists.entry(k).or_default().observe(&bounds, micros);
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
        let want = bucket_bounds().len() + 1;
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
                if buckets.len() != want {
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
        let bounds: Vec<u64> = bucket_bounds();
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
                json!({
                    "name": name, "labels": labels, "count": h.count, "mean_us": h.sum.checked_div(h.count).unwrap_or(0), "max_us": h.max,
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
    fn a_label_with_unbounded_values_cannot_grow_memory() {
        let mut m = Metrics::default();
        for i in 0..10_000 {
            m.inc("check_calls", &[("check", &format!("c{i}"))]);
        }
        let cap = defaults::num("telemetry.max_series") as usize;
        assert!(m.counters.len() <= cap + 1, "{} series", m.counters.len());
        assert_eq!(m.counter_total("check_calls"), 10_000, "overflow is still counted");
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
