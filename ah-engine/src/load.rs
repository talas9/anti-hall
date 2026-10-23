//! Request load seen by the daemon: does a call ever wait for another one?
//!
//! Every call served by a worker is sampled once: how long it waited between accept and the start of its processing, how long
//! the processing took, how many requests were in flight (queued plus being served) when it was accepted, which event it
//! was, which session it belonged to and, for a Stop, how many transcript bytes the checks scanned. Samples are folded into
//! one bucket per minute; only the newest `load.minutes_kept` buckets are kept, and each bucket is bounded (a capped set of
//! sessions, a capped set of events, fixed latency buckets), so the memory this uses does not grow with traffic.
//!
//! The report (`status --json` -> `load`) and the saturation flag come from the same buckets: a call that waited longer than
//! `load.saturation_wait_ms` marks the minute saturated, and `saturated` is true while a saturated minute is inside
//! `load.saturation_window_minutes`.
use crate::defaults;
use serde_json::{Value, json};
use std::cell::Cell;
use std::collections::{BTreeMap, HashSet, VecDeque};
use std::sync::Mutex;

/// One counted event a check noted: metric, label name, label value.
type Note = (&'static str, &'static str, &'static str);

thread_local! {
    static SCAN_BYTES: Cell<u64> = const { Cell::new(0) };
    static CHECK_SCAN_BYTES: Cell<u64> = const { Cell::new(0) };
    static CHECK_CPU_US: Cell<u64> = const { Cell::new(0) };
    static CHECK_MEM: Cell<Option<crate::mem::Delta>> = const { Cell::new(None) };
    static NOTES: std::cell::RefCell<Vec<Note>> = const { std::cell::RefCell::new(Vec::new()) };
    static TRANSCRIPT_SIZE: Cell<Option<u64>> = const { Cell::new(None) };
}

/// A check scanned `bytes` of a transcript on this thread (a tail reader calls it); the worker adds it to the request's sample
/// and the check that is running gets it too (see [`take_check_scan`]).
pub fn note_scan(bytes: u64) {
    SCAN_BYTES.with(|c| c.set(c.get().saturating_add(bytes)));
    CHECK_SCAN_BYTES.with(|c| c.set(c.get().saturating_add(bytes)));
}

/// The bytes scanned on this thread since the last call, and reset: what the check that just finished read. The request total
/// ([`take_scan`]) is not affected.
pub fn take_check_scan() -> u64 {
    CHECK_SCAN_BYTES.with(Cell::take)
}

/// The CPU the check that just ran spent on this thread, in microseconds (the dispatcher notes it as the check finishes).
pub fn note_check_cpu(us: u64) {
    CHECK_CPU_US.with(|c| c.set(us));
}

/// The CPU noted for the check that just finished, and reset.
pub fn take_check_cpu() -> u64 {
    CHECK_CPU_US.with(Cell::take)
}

/// The memory the check that just ran allocated (`None` when it was not measured), noted by [`crate::checks::run_env_guarded`] as the
/// check finishes.
pub fn note_check_mem(d: Option<crate::mem::Delta>) {
    CHECK_MEM.with(|c| c.set(d));
}

/// The memory noted for the check that just finished, and reset.
pub fn take_check_mem() -> Option<crate::mem::Delta> {
    CHECK_MEM.with(Cell::take)
}

/// A check on this thread saw one `metric` event labelled `label` = `value` (for instance a kept-walk hit, or the reason it
/// missed); the observer counts it when the check finishes. Bounded per check: the notes past the cap are dropped.
pub fn note_count(metric: &'static str, label: &'static str, value: &'static str) {
    NOTES.with(|n| {
        let mut n = n.borrow_mut();
        if n.len() < defaults::num("load.notes_cap") as usize {
            n.push((metric, label, value));
        }
    });
}

/// The counts noted on this thread since the last call, and reset.
pub fn take_counts() -> Vec<Note> {
    NOTES.with(|n| std::mem::take(&mut *n.borrow_mut()))
}

/// The size of the transcript the request on this thread names (`None` when it names none or the file cannot be read).
pub fn set_transcript_size(size: Option<u64>) {
    TRANSCRIPT_SIZE.with(|c| c.set(size));
}

/// The transcript size noted for the request in progress.
pub fn transcript_size() -> Option<u64> {
    TRANSCRIPT_SIZE.with(Cell::get)
}

/// The label of the size bucket `size` falls in (`load.size_buckets_bytes` gives the upper bounds; `load.size_label_*` the names).
pub fn size_bucket(size: Option<u64>) -> String {
    let Some(size) = size else { return defaults::text("load.size_label_unknown").to_string() };
    let bounds = defaults::raw("load.size_buckets_bytes")
        .as_array()
        .unwrap_or_default()
        .iter()
        .filter_map(|v| v.as_integer())
        .map(|n| n.max(0) as u64)
        .collect::<Vec<_>>();
    let labels = defaults::raw("load.size_labels").as_array().unwrap_or_default().iter().filter_map(|v| v.as_str().map(str::to_string)).collect::<Vec<_>>();
    let i = bounds.iter().position(|b| size <= *b).unwrap_or(bounds.len());
    labels.get(i).cloned().unwrap_or_else(|| defaults::text("load.size_label_unknown").to_string())
}

thread_local! {
    static REQUEST: std::cell::RefCell<(String, Option<String>)> = const { std::cell::RefCell::new((String::new(), None)) };
}

/// The request being served on this thread is a `event` call of `session` (the dispatcher knows both once it has read the
/// payload; the worker reads them back for the sample).
pub fn note_request(event: &str, session: Option<&str>) {
    REQUEST.with(|r| *r.borrow_mut() = (event.to_string(), session.map(str::to_string)));
}

/// The event noted on this thread for the request in progress (not reset).
pub fn peek_event() -> String {
    REQUEST.with(|r| r.borrow().0.clone())
}

/// The event and session noted on this thread, and reset.
pub fn take_request() -> (String, Option<String>) {
    REQUEST.with(|r| std::mem::take(&mut *r.borrow_mut()))
}

/// The bytes scanned on this thread since the last call, and reset.
pub fn take_scan() -> u64 {
    CHECK_SCAN_BYTES.with(Cell::take);
    NOTES.with(|n| n.borrow_mut().clear());
    TRANSCRIPT_SIZE.with(|c| c.set(None));
    SCAN_BYTES.with(Cell::take)
}

/// One served call.
#[derive(Debug, Clone, Default)]
pub struct Sample {
    /// When the call finished, ms since the epoch.
    pub at_ms: u64,
    /// Accept to start of processing.
    pub wait_us: u64,
    /// Processing time.
    pub proc_us: u64,
    /// Requests queued or being served when this one was accepted (itself not counted).
    pub in_flight: u64,
    /// The hook event (empty for a control request).
    pub event: String,
    /// The session id, when the request carried one.
    pub session: Option<String>,
    /// Transcript bytes the checks scanned.
    pub scan_bytes: u64,
}

#[derive(Default)]
struct Minute {
    start_min: u64,
    calls: u64,
    peak_in_flight: u64,
    max_wait_us: u64,
    waited: u64,
    saturated: u64,
    proc_hist: Vec<u64>,
    events: BTreeMap<String, u64>,
    events_over: u64,
    sessions: HashSet<u64>,
    sessions_over: u64,
    stops: u64,
    stop_proc_us: u64,
    stop_max_proc_us: u64,
    stop_scan_bytes: u64,
}

fn bounds() -> Vec<u64> {
    defaults::raw("load.proc_buckets_us").as_array().unwrap_or_default().iter().filter_map(|v| v.as_integer()).map(|n| n.max(0) as u64).collect()
}

fn p95(hist: &[u64], bounds: &[u64]) -> u64 {
    let total: u64 = hist.iter().sum();
    if total == 0 {
        return 0;
    }
    let want = (total * 95).div_ceil(100);
    let mut seen = 0;
    for (i, n) in hist.iter().enumerate() {
        seen += n;
        if seen >= want {
            // the last bucket is open-ended: report its lower edge
            return bounds.get(i).copied().unwrap_or_else(|| bounds.last().copied().unwrap_or(0));
        }
    }
    bounds.last().copied().unwrap_or(0)
}

impl Minute {
    fn view(&self, bounds: &[u64]) -> Value {
        let sessions_cap = defaults::num("load.sessions_cap");
        json!({
            "minute_start_ms": self.start_min * 60_000,
            "calls": self.calls,
            "peak_in_flight": self.peak_in_flight,
            "max_wait_us": self.max_wait_us,
            "calls_over_wait_threshold": self.saturated,
            "calls_that_waited": self.waited,
            "p95_proc_us": p95(&self.proc_hist, bounds),
            "events": self.events,
            "events_other": self.events_over,
            "sessions": self.sessions.len() as u64 + self.sessions_over,
            "sessions_capped_at": sessions_cap,
            "stops": {"n": self.stops, "proc_us_total": self.stop_proc_us, "proc_us_max": self.stop_max_proc_us, "transcript_bytes_scanned": self.stop_scan_bytes},
        })
    }
}

/// The rolling window of per-minute buckets.
#[derive(Default)]
pub struct Load {
    minutes: Mutex<VecDeque<Minute>>,
}

impl Load {
    /// An empty window.
    pub fn new() -> Load {
        Load::default()
    }

    /// Fold one served call in.
    pub fn record(&self, s: &Sample) {
        let bounds = bounds();
        let minute = s.at_ms / 60_000;
        let mut g = self.minutes.lock().unwrap_or_else(|e| e.into_inner());
        if g.back().is_none_or(|m| m.start_min != minute) {
            g.push_back(Minute { start_min: minute, proc_hist: vec![0; bounds.len() + 1], ..Minute::default() });
            while g.len() as u64 > defaults::num("load.minutes_kept").max(1) {
                g.pop_front();
            }
        }
        let Some(m) = g.back_mut() else { return };
        m.calls += 1;
        m.peak_in_flight = m.peak_in_flight.max(s.in_flight + 1);
        m.max_wait_us = m.max_wait_us.max(s.wait_us);
        m.waited += u64::from(s.wait_us > defaults::num("load.wait_noise_us"));
        m.saturated += u64::from(s.wait_us > defaults::num("load.saturation_wait_ms") * 1000);
        let at = bounds.iter().position(|b| s.proc_us <= *b).unwrap_or(bounds.len());
        if let Some(slot) = m.proc_hist.get_mut(at) {
            *slot += 1;
        }
        if !s.event.is_empty() {
            if m.events.contains_key(&s.event) || (m.events.len() as u64) < defaults::num("load.events_cap") {
                *m.events.entry(s.event.clone()).or_insert(0) += 1;
            } else {
                m.events_over += 1;
            }
        }
        if let Some(id) = &s.session {
            if (m.sessions.len() as u64) < defaults::num("load.sessions_cap") {
                m.sessions.insert(crate::health::fnv(id));
            } else if !m.sessions.contains(&crate::health::fnv(id)) {
                m.sessions_over += 1;
            }
        }
        if s.event == "Stop" {
            m.stops += 1;
            m.stop_proc_us += s.proc_us;
            m.stop_max_proc_us = m.stop_max_proc_us.max(s.proc_us);
            m.stop_scan_bytes += s.scan_bytes;
        }
    }

    /// The window as JSON: totals, the saturation flag and the newest buckets.
    pub fn report(&self, now_ms: u64) -> Value {
        let bounds = bounds();
        let g = self.minutes.lock().unwrap_or_else(|e| e.into_inner());
        let window = defaults::num("load.saturation_window_minutes");
        let floor = (now_ms / 1000 / 60).saturating_sub(window);
        let saturated_minutes = g.iter().filter(|m| m.start_min >= floor && m.saturated > 0).count();
        json!({
            "saturated": saturated_minutes > 0,
            "saturation_wait_ms": defaults::num("load.saturation_wait_ms"),
            "saturated_minutes_in_window": saturated_minutes,
            "window_minutes": window,
            "calls": g.iter().map(|m| m.calls).sum::<u64>(),
            "peak_in_flight": g.iter().map(|m| m.peak_in_flight).max().unwrap_or(0),
            "max_wait_us": g.iter().map(|m| m.max_wait_us).max().unwrap_or(0),
            "minutes_kept": g.len(),
            "minutes": g.iter().map(|m| m.view(&bounds)).collect::<Vec<_>>(),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn s(at_ms: u64, wait_us: u64, proc_us: u64, event: &str, session: &str) -> Sample {
        Sample { at_ms, wait_us, proc_us, in_flight: 1, event: event.into(), session: Some(session.into()), scan_bytes: 0 }
    }

    #[test]
    fn a_check_gets_the_bytes_it_scanned_and_the_request_total_still_counts_them() {
        take_scan();
        note_scan(10);
        note_scan(5);
        assert_eq!(take_check_scan(), 15, "the check that just ran read 15");
        assert_eq!(take_check_scan(), 0, "and the next one starts at zero");
        note_scan(7);
        assert_eq!(take_scan(), 22, "the request total is not reset by a check taking its share");
        assert_eq!(take_check_scan(), 0, "a new request starts every check at zero");
    }

    #[test]
    fn counted_notes_are_handed_over_once_and_are_bounded() {
        take_scan();
        note_count("agent_scan_kept", "result", "hit");
        note_count("agent_scan_kept_miss", "reason", "gen");
        assert_eq!(take_counts(), vec![("agent_scan_kept", "result", "hit"), ("agent_scan_kept_miss", "reason", "gen")]);
        assert!(take_counts().is_empty());
        for _ in 0..(defaults::num("load.notes_cap") + 10) {
            note_count("agent_scan_kept", "result", "hit");
        }
        assert_eq!(take_counts().len() as u64, defaults::num("load.notes_cap"));
        note_count("agent_scan_kept", "result", "hit");
        take_scan();
        assert!(take_counts().is_empty(), "a new request drops what the last one left");
    }

    #[test]
    fn a_transcript_size_falls_in_the_named_class() {
        let kb = 1024;
        assert_eq!(size_bucket(None), defaults::text("load.size_label_unknown"));
        assert_eq!(size_bucket(Some(10 * kb)), "lt200k");
        assert_eq!(size_bucket(Some(200 * kb)), "lt200k", "an edge belongs to the lower class");
        assert_eq!(size_bucket(Some(200 * kb + 1)), "lt1m");
        assert_eq!(size_bucket(Some(5 * kb * kb)), "lt10m");
        assert_eq!(size_bucket(Some(50 * kb * kb)), "lt100m");
        assert_eq!(size_bucket(Some(300 * kb * kb)), "ge100m");
    }

    #[test]
    fn a_minute_counts_calls_events_sessions_and_the_slowest_wait() {
        let l = Load::new();
        l.record(&s(60_000, 10, 500, "PreToolUse", "a"));
        l.record(&s(61_000, 30, 900, "PreToolUse", "b"));
        l.record(&s(62_000, 0, 100, "Stop", "a"));
        let r = l.report(62_000);
        let m = &r["minutes"][0];
        assert_eq!(
            (m["calls"].as_u64(), m["sessions"].as_u64(), m["max_wait_us"].as_u64(), m["peak_in_flight"].as_u64()),
            (Some(3), Some(2), Some(30), Some(2))
        );
        assert_eq!(m["events"]["PreToolUse"], 2);
        assert_eq!(m["stops"]["n"], 1);
    }

    #[test]
    fn a_wait_over_the_threshold_flags_saturation_and_it_clears_with_the_window() {
        let l = Load::new();
        let over = defaults::num("load.saturation_wait_ms") * 1000 + 1;
        l.record(&s(60_000, over, 10, "Stop", "a"));
        assert_eq!(l.report(60_000)["saturated"], true);
        let later = 60_000 + (defaults::num("load.saturation_window_minutes") + 2) * 60_000;
        assert_eq!(l.report(later)["saturated"], false, "an old saturated minute no longer counts");
    }

    #[test]
    fn memory_is_bounded_by_the_minutes_kept_and_the_session_cap() {
        let l = Load::new();
        let keep = defaults::num("load.minutes_kept");
        let cap = defaults::num("load.sessions_cap");
        for min in 0..keep + 10 {
            for i in 0..cap + 50 {
                l.record(&s(min * 60_000, 0, 10, "Pre", &format!("s{i}")));
            }
        }
        let r = l.report((keep + 10) * 60_000);
        assert_eq!(r["minutes_kept"].as_u64(), Some(keep));
        assert_eq!(r["minutes"][0]["sessions"].as_u64(), Some(cap + 50), "sessions past the cap are counted, not stored");
    }

    #[test]
    fn p95_is_the_upper_bound_of_the_bucket_holding_the_95th_percentile() {
        let l = Load::new();
        for _ in 0..94 {
            l.record(&s(0, 0, 50, "x", "a"));
        }
        for _ in 0..6 {
            l.record(&s(0, 0, 40_000, "x", "a"));
        }
        assert_eq!(l.report(0)["minutes"][0]["p95_proc_us"].as_u64(), Some(50_000));
    }

    #[test]
    fn scan_bytes_are_per_thread_and_reset_when_taken() {
        note_scan(10);
        note_scan(5);
        assert_eq!(take_scan(), 15);
        assert_eq!(take_scan(), 0);
    }
}
