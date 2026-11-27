//! GH #845 phase 0: the wall time of each stage of one mesh send, so the cost of a send under load is measured per stage before
//! the send path is rewritten. The timer is per thread and off unless [`begin`] armed it (the mesh CLI front arms it for `send`), so a stage timed from code that also runs elsewhere (the native wake, from `agents send` or the
//! daemon) records nothing there. [`finish`] queues one telemetry event per stage (kind `cmd`, name `<stage_event_prefix><label>`,
//! whose report gives p50/p95/p99) and returns the times for the shadow-log line.
use crate::defaults;
use std::cell::RefCell;
use std::time::Instant;

thread_local! {
    /// `None`: the timer is off. `Some`: (label, microseconds) per stage, in first-seen order, a repeated stage summed.
    static STAGES: RefCell<Option<Vec<(String, u64)>>> = const { RefCell::new(None) };
}

/// The label of stage `key` (`mesh_wake.stage_labels`); an unknown key is its own label.
fn label(key: &str) -> String {
    let l = defaults::raw("mesh_wake.stage_labels").str_field(key);
    if l.is_empty() { key.to_string() } else { l.to_string() }
}

/// Arm the timer on this thread; any earlier record is dropped.
pub fn begin() {
    STAGES.with(|s| *s.borrow_mut() = Some(Vec::new()));
}

/// Add `micros` to stage `key` when the timer is armed.
pub fn add(key: &str, micros: u64) {
    STAGES.with(|s| {
        if let Some(v) = s.borrow_mut().as_mut() {
            let l = label(key);
            match v.iter_mut().find(|(n, _)| *n == l) {
                Some((_, m)) => *m += micros,
                None => v.push((l, micros)),
            }
        }
    });
}

/// Add the time since `t` to stage `key` when the timer is armed (for a stage whose code has early returns).
pub fn since(key: &str, t: Instant) {
    if armed() {
        add(key, t.elapsed().as_micros().min(u128::from(u64::MAX)) as u64);
    }
}

/// Run `f`, timing it as stage `key` when the timer is armed.
pub fn time<T>(key: &str, f: impl FnOnce() -> T) -> T {
    if !armed() {
        return f();
    }
    let t = Instant::now();
    let r = f();
    add(key, t.elapsed().as_micros().min(u128::from(u64::MAX)) as u64);
    r
}

/// Whether the timer is armed on this thread.
pub fn armed() -> bool {
    STAGES.with(|s| s.borrow().is_some())
}

/// Disarm the timer and take what it recorded: (label, microseconds) per stage.
pub fn take() -> Vec<(String, u64)> {
    STAGES.with(|s| s.borrow_mut().take()).unwrap_or_default()
}

/// Disarm the timer, queue one telemetry event per stage (sub-label `verb`) and flush them, and return the stage times in
/// milliseconds (three decimals) for the shadow log; `None` when nothing was timed.
pub fn finish(verb: &str) -> Option<serde_json::Value> {
    let v = take();
    if v.is_empty() {
        return None;
    }
    for ev in events(verb, &v) {
        crate::telemetry::emit::queue(ev);
    }
    crate::telemetry::emit::flush();
    Some(as_json(&v))
}

/// One `cmd` telemetry event per stage: name `<stage_event_prefix><label>`, sub-label `verb`, the stage's time as its latency.
fn events(verb: &str, v: &[(String, u64)]) -> Vec<crate::telemetry::event::Event> {
    let prefix = defaults::text("mesh_wake.stage_event_prefix");
    v.iter().map(|(l, us)| crate::telemetry::emit::command_run(&format!("{prefix}{l}"), verb, 0, *us, 0)).collect()
}

/// The stage times as `{label: milliseconds}`.
fn as_json(v: &[(String, u64)]) -> serde_json::Value {
    serde_json::Value::Object(v.iter().map(|(l, us)| (l.clone(), serde_json::json!((*us as f64) / 1000.0))).collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_unarmed_timer_records_nothing() {
        let _ = take();
        assert_eq!(time("summary", || 7), 7);
        assert!(take().is_empty());
        assert!(finish("send").is_none());
    }

    #[test]
    fn a_send_records_each_stage_under_its_configured_label_and_sums_repeats() {
        begin("send");
        assert!(armed());
        add("summary", 1500);
        add("insert", 200);
        add("summary", 500);
        let got = take();
        let want_summary = defaults::raw("mesh_wake.stage_labels").str_field("summary").to_string();
        assert_eq!(got[0], (want_summary, 2000));
        assert_eq!(got.len(), 2);
        assert!(!armed());
    }

    #[test]
    fn finish_returns_milliseconds_and_disarms() {
        begin("send");
        add("total", 4_000_000);
        add("readback", 1234);
        let v = finish("send").expect("stages");
        let total = defaults::raw("mesh_wake.stage_labels").str_field("total");
        assert_eq!(v[total], serde_json::json!(4000.0));
        assert!(!armed());
    }

    #[test]
    fn one_cmd_event_per_stage_named_by_the_configured_prefix() {
        let v = vec![("summary".to_string(), 2500u64), ("insert".to_string(), 900)];
        let evs = events("send", &v);
        assert_eq!(evs.len(), 2);
        let prefix = defaults::text("mesh_wake.stage_event_prefix");
        assert_eq!(evs[0].h.as_str(), crate::telemetry::event::Token::sanitize(&format!("{prefix}summary")).as_str());
        assert_eq!(evs[0].ms, 3); // 2500 us rounded up to whole milliseconds
        assert_eq!(evs[0].kind, crate::telemetry::event::Kind::Cmd);
    }
}
