//! Storage behind a trait (D19, D22): everything the engine remembers goes through [`Store`].
//!
//! Why a trait now: the planned backend is an embedded SQLite pair (`hot.db`, `archive.db`, D21), and the rest of the
//! engine must not care. This phase ships only [`MemStore`], an in-memory implementation that is bounded and loses its
//! contents when the daemon exits; the storage phase adds the durable one without touching the callers.
use std::collections::{HashMap, VecDeque};

/// One thing the engine did that affected a call (D52). The project is a hashed key, never a path.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ImpactEvent {
    /// When it happened, milliseconds since the Unix epoch.
    pub ts_ms: u64,
    /// Stable kind, one of the registered `impact.*` names.
    pub kind: String,
    /// The check that acted (empty for rule matches and request-level events).
    pub check: String,
    /// The reason code: the rule or check id for a block, the failure class for a fallback.
    pub reason: String,
    /// Hashed project key.
    pub project: String,
}

/// Which events a query wants; an empty field matches everything.
#[derive(Debug, Clone, Default)]
pub struct ImpactFilter {
    /// Only this kind.
    pub kind: String,
    /// Only this hashed project key.
    pub project: String,
}

/// Exact counts of one (kind, check, reason, project) combination.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ImpactCount {
    /// Impact kind.
    pub kind: String,
    /// Check name, possibly empty.
    pub check: String,
    /// Reason code, possibly empty.
    pub reason: String,
    /// Hashed project key.
    pub project: String,
    /// Occurrences.
    pub count: u64,
}

/// What the engine stores. Implementations must be bounded: a store that grows without limit is a bug (D25).
pub trait Store: Send {
    /// Remember one impact event.
    fn record_impact(&mut self, event: ImpactEvent);
    /// Exact counts per combination, filtered.
    fn impact_counts(&self, filter: &ImpactFilter) -> Vec<ImpactCount>;
    /// The most recent events, newest last, filtered, at most `limit`.
    fn recent_impact(&self, filter: &ImpactFilter, limit: usize) -> Vec<ImpactEvent>;
    /// How many events are held right now (not the exact total: see `impact_counts`).
    fn held_events(&self) -> usize;
}

/// The in-memory store: a ring of recent events plus exact per-combination counters.
pub struct MemStore {
    events: VecDeque<ImpactEvent>,
    cap: usize,
    counts: HashMap<(String, String, String, String), u64>,
    max_series: usize,
    overflow: String,
}

impl MemStore {
    /// A store holding at most `cap` events and `max_series` distinct count combinations; combinations beyond that
    /// are counted under `overflow` as their reason, so totals stay exact while memory stays flat.
    pub fn new(cap: usize, max_series: usize, overflow: &str) -> MemStore {
        MemStore { events: VecDeque::new(), cap: cap.max(1), counts: HashMap::new(), max_series: max_series.max(1), overflow: overflow.to_string() }
    }
}

impl Store for MemStore {
    fn record_impact(&mut self, e: ImpactEvent) {
        let mut key = (e.kind.clone(), e.check.clone(), e.reason.clone(), e.project.clone());
        if !self.counts.contains_key(&key) && self.counts.len() >= self.max_series {
            key = (e.kind.clone(), e.check.clone(), self.overflow.clone(), self.overflow.clone());
        }
        *self.counts.entry(key).or_insert(0) += 1;
        if self.events.len() >= self.cap {
            self.events.pop_front();
        }
        self.events.push_back(e);
    }

    fn impact_counts(&self, f: &ImpactFilter) -> Vec<ImpactCount> {
        let mut out: Vec<ImpactCount> = self
            .counts
            .iter()
            .filter(|((k, _, _, p), _)| (f.kind.is_empty() || *k == f.kind) && (f.project.is_empty() || *p == f.project))
            .map(|((kind, check, reason, project), count)| ImpactCount {
                kind: kind.clone(),
                check: check.clone(),
                reason: reason.clone(),
                project: project.clone(),
                count: *count,
            })
            .collect();
        out.sort_by(|a, b| (&a.kind, &a.check, &a.reason, &a.project).cmp(&(&b.kind, &b.check, &b.reason, &b.project)));
        out
    }

    fn recent_impact(&self, f: &ImpactFilter, limit: usize) -> Vec<ImpactEvent> {
        let mut v: Vec<ImpactEvent> = self
            .events
            .iter()
            .rev()
            .filter(|e| (f.kind.is_empty() || e.kind == f.kind) && (f.project.is_empty() || e.project == f.project))
            .take(limit)
            .cloned()
            .collect();
        v.reverse();
        v
    }

    fn held_events(&self) -> usize {
        self.events.len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ev(kind: &str, reason: &str, project: &str) -> ImpactEvent {
        ImpactEvent { ts_ms: 1, kind: kind.into(), check: "git".into(), reason: reason.into(), project: project.into() }
    }

    #[test]
    fn the_ring_is_bounded_but_counts_stay_exact() {
        let mut s = MemStore::new(3, 100, "other");
        for _ in 0..10 {
            s.record_impact(ev("block", "force_push", "p1"));
        }
        assert_eq!(s.held_events(), 3);
        let c = s.impact_counts(&ImpactFilter::default());
        assert_eq!(c.len(), 1);
        assert_eq!(c[0].count, 10, "ten blocks happened even though only three events are held");
    }

    #[test]
    fn series_are_bounded_and_overflow_is_still_counted() {
        let mut s = MemStore::new(10, 2, "other");
        for i in 0..5 {
            s.record_impact(ev("block", &format!("r{i}"), "p"));
        }
        let c = s.impact_counts(&ImpactFilter::default());
        assert!(c.len() <= 3, "two real series plus the overflow series: {c:?}");
        assert_eq!(c.iter().map(|x| x.count).sum::<u64>(), 5);
    }

    #[test]
    fn filters_apply_to_counts_and_events() {
        let mut s = MemStore::new(10, 10, "other");
        s.record_impact(ev("block", "a", "p1"));
        s.record_impact(ev("warning", "b", "p2"));
        let f = ImpactFilter { kind: "warning".into(), project: String::new() };
        assert_eq!(s.impact_counts(&f).len(), 1);
        assert_eq!(s.recent_impact(&f, 5).len(), 1);
        let f = ImpactFilter { kind: String::new(), project: "p1".into() };
        assert_eq!(s.recent_impact(&f, 5)[0].reason, "a");
    }
}
