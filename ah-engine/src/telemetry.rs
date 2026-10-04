//! What the daemon observes about itself: metrics (D51) and impact events (D52), behind one handle.
//!
//! The hook path calls [`Telemetry::observe_check`], [`Telemetry::observe_rule`] and [`Telemetry::fallback`]; the
//! `metrics`, `impact` and `status` commands read the same handle. Every lock is held only for the update itself and
//! never across I/O (D9).
use crate::checks::Verdict;
use crate::defaults;
use crate::metrics::Metrics;
use crate::rules::Action;
use crate::storage::{ImpactEvent, ImpactFilter, MemStore, Store};
use serde_json::{json, Value};
use std::sync::Mutex;

/// Metrics plus the impact ledger.
pub struct Telemetry {
    metrics: Mutex<Metrics>,
    store: Box<dyn Store>,
}

fn lk<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

/// Hashed project key for impact events: the path is never stored, only a short stable hash of it.
pub fn project_hash(project_key: &str) -> String {
    let h = format!("{:016x}", crate::health::fnv(project_key));
    h[..(defaults::num("telemetry.project_key_len") as usize).min(h.len())].to_string()
}

fn now_ms() -> u64 {
    crate::health::now_ms()
}

/// The decision name of a verdict, as used in metric labels and impact reasons.
pub fn decision_name(v: &Verdict) -> &'static str {
    match v {
        Verdict::Allow => "allow",
        Verdict::Block(_) => "block",
        Verdict::Advisory(_) => "advisory",
        Verdict::Defer => "defer",
    }
}

impl Telemetry {
    /// A telemetry handle with the in-memory store sized from the defaults.
    pub fn new() -> Telemetry {
        let store = MemStore::new(
            defaults::num("telemetry.max_events") as usize,
            defaults::num("telemetry.max_series") as usize * 4,
            defaults::text("telemetry.overflow_label"),
        );
        Telemetry::with_store(Box::new(store))
    }

    /// A telemetry handle recording impact events in `store` (the daemon passes the SQLite store, D52).
    pub fn with_store(store: Box<dyn Store>) -> Telemetry {
        Telemetry { metrics: Mutex::new(Metrics::default()), store }
    }

    /// Count one request of any type.
    pub fn request(&self) {
        lk(&self.metrics).inc("requests", &[]);
    }

    /// Run `f` on the metrics registry.
    pub fn with_metrics<R>(&self, f: impl FnOnce(&mut Metrics) -> R) -> R {
        f(&mut lk(&self.metrics))
    }

    /// Record one impact event.
    pub fn impact(&self, kind: &str, check: &str, reason: &str, project: &str) {
        self.store.record_impact(ImpactEvent { ts_ms: now_ms(), kind: kind.into(), check: check.into(), reason: reason.into(), project: project.into() });
    }

    /// A built-in check finished: count the run, time it, and record the impact of a block or advisory.
    pub fn observe_check(&self, check: &str, rule_id: &str, verdict: &Verdict, micros: u64, project: &str) {
        let decision = decision_name(verdict);
        {
            let mut m = lk(&self.metrics);
            m.inc("check_calls", &[("check", check)]);
            m.inc("check_decisions", &[("check", check), ("decision", decision)]);
            m.observe("check_latency_us", &[("check", check)], micros);
        }
        match verdict {
            Verdict::Block(_) => self.impact("block", check, rule_id, project),
            Verdict::Advisory(_) => self.impact("advisory", check, rule_id, project),
            Verdict::Defer => self.impact("fallback", check, "defer", project),
            Verdict::Allow => {}
        }
    }

    /// A regex rule matched.
    pub fn observe_rule(&self, rule_id: &str, action: Action, project: &str) {
        let (name, kind) = match action {
            Action::Deny => ("deny", "block"),
            Action::Warn => ("warn", "warning"),
            Action::Context => ("context", "context"),
        };
        lk(&self.metrics).inc("rule_hits", &[("action", name)]);
        self.impact(kind, "", rule_id, project);
    }

    /// A hook request finished: count it by event and time it.
    pub fn observe_hook(&self, event: &str, micros: u64) {
        let mut m = lk(&self.metrics);
        m.inc("hook_calls", &[("event", event)]);
        m.observe("hook_latency_us", &[("event", event)], micros);
    }

    /// The engine could not answer and the client will run the Node hook.
    pub fn fallback(&self, reason: &str, project: &str) {
        self.impact("fallback", "", reason, project);
    }

    /// The `metrics` command's body: all series, optionally for one check, with the live gauges refreshed.
    pub fn metrics_json(&self, check: &str, gauges: &[(&str, f64)]) -> Value {
        let mut m = lk(&self.metrics);
        for (n, v) in gauges {
            m.set(n, *v);
        }
        json!({"running": true, "persisted": false, "note": defaults::text("telemetry.not_persisted_note"), "metrics": m.snapshot(check)})
    }

    /// The `impact` command's body.
    pub fn impact_json(&self, filter: &ImpactFilter, recent: usize) -> Value {
        crate::impact::summary(&*self.store, filter, recent)
    }

    /// Headline counts for `status`.
    pub fn headline(&self) -> Value {
        let all = self.store.impact_counts(&ImpactFilter::default());
        let total = |kind: &str| all.iter().filter(|c| c.kind == kind).map(|c| c.count).sum::<u64>();
        let m = lk(&self.metrics);
        json!({
            "requests": m.counter_total("requests"),
            "check_runs": m.counter_total("check_calls"),
            "blocks": total("block"),
            "warnings": total("warning"),
            "context_injected": total("context"),
            "advisories": total("advisory"),
            "fallbacks": total("fallback"),
        })
    }
}

impl Default for Telemetry {
    fn default() -> Self {
        Telemetry::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_blocking_check_run_is_counted_timed_and_recorded() {
        let t = Telemetry::new();
        t.observe_check("git", "git-guard", &Verdict::Block("x".into()), 400, "abc");
        t.observe_check("git", "git-guard", &Verdict::Allow, 100, "abc");
        let h = t.headline();
        assert_eq!(h["blocks"], 1);
        assert_eq!(h["check_runs"], 2);
        let imp = t.impact_json(&ImpactFilter::default(), 10);
        assert_eq!(imp["total"], 1);
        assert_eq!(imp["by_kind"]["block"], 1);
        assert_eq!(imp["blocks_by_reason"]["git-guard"], 1);
    }

    #[test]
    fn project_keys_are_hashed_and_short() {
        let a = project_hash("/home/someone/secret-project");
        assert_eq!(a.len(), defaults::num("telemetry.project_key_len") as usize);
        assert!(!a.contains("secret"));
        assert_eq!(a, project_hash("/home/someone/secret-project"));
        assert_ne!(a, project_hash("/other"));
    }

    #[test]
    fn rule_hits_map_to_impact_kinds() {
        let t = Telemetry::new();
        t.observe_rule("r1", Action::Deny, "p");
        t.observe_rule("r2", Action::Warn, "p");
        t.observe_rule("r3", Action::Context, "p");
        let imp = t.impact_json(&ImpactFilter::default(), 10);
        assert_eq!(imp["by_kind"]["block"], 1);
        assert_eq!(imp["by_kind"]["warning"], 1);
        assert_eq!(imp["by_kind"]["context"], 1);
    }
}
