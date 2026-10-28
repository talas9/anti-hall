//! Engine-level fail-opens (GitHub #201): every time the engine answers a request without a check's verdict, for a reason that is
//! the engine's (missing config key, deadline cut, script timeout, Jev breaker open, busy, internal error, a verdict the client never
//! confirmed), it is counted as `fail_open{reason,check}`, logged once to the health log, and held in a sliding window so the
//! engine can say "degraded" (status, doctor, a one-line session notice). The limits are `fail_open.*` in the plugin.
//!
//! The engine never blocks a session because of this: the counters and the notice are information, the request has already failed open.
use crate::defaults;
use crate::telemetry::Telemetry;
use std::collections::VecDeque;
use std::sync::Mutex;
use std::time::{Duration, Instant};

/// The sliding windows. Skipped-class fail-opens (a check or verdict really did not apply) drive the degraded state and the notice;
/// reporting-class ones (the verdict applied, only its delivery or telemetry failed) are kept apart so a flood of them can neither
/// flip the state nor push the skipped ones out of the bounded window.
#[derive(Default)]
struct Win {
    skipped: VecDeque<(Instant, String)>,
    reporting: VecDeque<(Instant, String)>,
}

static WINDOW: Mutex<Win> = Mutex::new(Win { skipped: VecDeque::new(), reporting: VecDeque::new() });

/// Fail-opens noted but not yet added to the telemetry counters (a site without a telemetry handle notes here; the daemon
/// drains it after every request and before every status).
static PENDING: Mutex<Vec<(String, String)>> = Mutex::new(Vec::new());

/// The first fail-open noted on each serving thread since its request began: what the reply to an ack-mode client carries.
static REQUEST: Mutex<std::collections::BTreeMap<String, (String, String)>> = Mutex::new(std::collections::BTreeMap::new());

fn thread_key() -> String {
    format!("{:?}", std::thread::current().id())
}

fn requests() -> std::sync::MutexGuard<'static, std::collections::BTreeMap<String, (String, String)>> {
    REQUEST.lock().unwrap_or_else(|e| e.into_inner())
}

/// A request begins on this thread: forget the last one's fail-open.
pub fn begin_request() {
    requests().remove(&thread_key());
}

/// The first fail-open noted on this thread since [`begin_request`].
pub fn take_request() -> Option<(String, String)> {
    requests().remove(&thread_key())
}

/// Add the fail-opens noted so far to the telemetry counters.
pub fn drain_into(t: &Telemetry) {
    let batch = std::mem::take(&mut *PENDING.lock().unwrap_or_else(|e| e.into_inner()));
    if !batch.is_empty() {
        t.with_metrics(|m| {
            for (reason, check) in &batch {
                m.inc("fail_open", &[("reason", reason), ("check", check)]);
            }
        });
    }
}

fn lock() -> std::sync::MutexGuard<'static, Win> {
    WINDOW.lock().unwrap_or_else(|e| e.into_inner())
}

/// Whether `reason` is reporting-only (`fail_open.reporting_reasons`): the verdict applied, the engine only failed to report it.
pub fn is_reporting(reason: &str) -> bool {
    defaults::list("fail_open.reporting_reasons").contains(&reason)
}

/// What a fail-open of `reason` means for the session, from `fail_open.effects` ("reason=text" entries); the default text when the
/// reason has no entry.
pub fn effect(reason: &str) -> String {
    defaults::list("fail_open.effects")
        .into_iter()
        .find_map(|e| e.split_once('=').filter(|(r, _)| *r == reason).map(|(_, t)| t.to_string()))
        .unwrap_or_else(|| defaults::text("fail_open.effect_default").to_string())
}

fn prune(w: &mut VecDeque<(Instant, String)>, now: Instant) {
    let span = Duration::from_secs(defaults::num("fail_open.window_s"));
    while w.front().is_some_and(|(t, _)| now.duration_since(*t) > span) {
        w.pop_front();
    }
}

impl Win {
    /// Record one fail-open in the window of its class. Bounded: a class's window never holds more than twice the hard limit, a flood
    /// past that only moves its oldest out.
    fn push(&mut self, now: Instant, reason: &str) {
        let w = if is_reporting(reason) { &mut self.reporting } else { &mut self.skipped };
        prune(w, now);
        if w.len() as u64 >= defaults::num("fail_open.hard_per_window").saturating_mul(2) {
            w.pop_front();
        }
        w.push_back((now, reason.to_string()));
    }

    /// (skipped count, most frequent skipped reason, reporting count) inside the window.
    fn counts(&mut self, now: Instant) -> (u64, String, u64) {
        prune(&mut self.skipped, now);
        prune(&mut self.reporting, now);
        let mut by: std::collections::BTreeMap<&str, u64> = std::collections::BTreeMap::new();
        for (_, r) in self.skipped.iter() {
            *by.entry(r.as_str()).or_default() += 1;
        }
        let top = by.iter().max_by_key(|(_, n)| **n).map(|(r, _)| (*r).to_string()).unwrap_or_default();
        (self.skipped.len() as u64, top, self.reporting.len() as u64)
    }
}

/// Count and log one fail-open and remember it in the window and for the request in progress on this thread. The counter is added
/// to the telemetry by [`drain_into`], so a site needs no handle.
pub fn note(reason: &str, check: &str, detail: &str) {
    {
        let mut p = PENDING.lock().unwrap_or_else(|e| e.into_inner());
        if (p.len() as u64) < defaults::num("fail_open.pending_max") {
            p.push((reason.to_string(), check.to_string()));
        }
    }
    requests().entry(thread_key()).or_insert_with(|| (reason.to_string(), check.to_string()));
    let max = defaults::num("fail_open.log_detail_max") as usize;
    let detail: String = detail.chars().take(max).collect();
    crate::health::log_event("fail_open", reason, &defaults::render("fail_open.msg_log", &[("check", &check), ("detail", &detail)]));
    lock().push(Instant::now(), reason);
    sync_notice(true);
}

/// The skipped-class window: (count in the window, most frequent reason). Reporting-only reasons are not in it.
pub fn window() -> (u64, String) {
    let (n, top, _) = lock().counts(Instant::now());
    (n, top)
}

/// How many reporting-only fail-opens (verdict applied, delivery or telemetry failed) are inside the window.
pub fn reporting_in_window() -> u64 {
    lock().counts(Instant::now()).2
}

/// `ok`, `degraded` (soft limit) or `failing` (hard limit), by the number of fail-opens inside the window.
pub fn state(n: u64) -> &'static str {
    if n >= defaults::num("fail_open.hard_per_window") {
        defaults::text("fail_open.state_hard")
    } else if n >= defaults::num("fail_open.soft_per_window") {
        defaults::text("fail_open.state_soft")
    } else {
        defaults::text("fail_open.state_ok")
    }
}

/// The one-line session notice while degraded (`None` while ok).
pub fn notice() -> Option<String> {
    let (n, top) = window();
    notice_for(n, &top)
}

fn notice_for(n: u64, top: &str) -> Option<String> {
    (state(n) != defaults::text("fail_open.state_ok")).then(|| {
        defaults::render("fail_open.msg_notice", &[("n", &n), ("window", &defaults::num("fail_open.window_s")), ("top", &top), ("effect", &effect(top))])
    })
}

/// The file that holds the session notice while the engine is degraded (written by the daemon, read by the hook client).
fn notice_path() -> std::path::PathBuf {
    crate::paths::dir().join(defaults::text("fail_open.notice_file"))
}

static NOTICE_ON: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// Keep the notice file in step with the window: present while degraded, gone when the rate is back under the soft limit.
/// Cheap when nothing is degraded (one atomic load).
pub fn sync_notice(just_noted: bool) {
    use std::sync::atomic::Ordering::Relaxed;
    if !just_noted && !NOTICE_ON.load(Relaxed) {
        return;
    }
    match notice() {
        Some(text) => {
            if !NOTICE_ON.swap(true, Relaxed) {
                crate::discard::logged("fail_open_notice_write", crate::atomic::write(notice_path(), text));
            }
        }
        None => {
            if NOTICE_ON.swap(false, Relaxed) {
                crate::discard::harmless(std::fs::remove_file(notice_path())); // keep: an absent notice is the goal state
            }
        }
    }
}

/// Add the one-line degraded notice (once per session) to an answer the engine gave while it is failing open; no file, no change.
pub fn with_notice(raw: &str, event: &str, mut o: crate::client::Outcome) -> crate::client::Outcome {
    if o.code != 0 {
        return o;
    }
    let Ok(text) = std::fs::read_to_string(notice_path()) else { return o };
    let session = serde_json::from_str::<serde_json::Value>(raw).ok().and_then(|p| p["session_id"].as_str().map(str::to_string)).unwrap_or_else(|| "-".into());
    if crate::health::first_in_session(&session, defaults::text("fail_open.notice_tag"))
        && let Some(merged) = crate::health::merge_advisory(event, &o.out, text.trim())
    {
        o.out = merged;
    }
    o
}

/// `status --json` block.
pub fn status(t: &Telemetry) -> serde_json::Value {
    drain_into(t);
    sync_notice(false);
    let (n, top) = window();
    let by = t.with_metrics(|m| m.snapshot("")["counters"].as_array().cloned().unwrap_or_default());
    let by: Vec<_> = by
        .into_iter()
        .filter(|c| c["name"] == "fail_open")
        .map(|c| {
            let reporting = c.pointer("/labels/reason").and_then(serde_json::Value::as_str).is_some_and(is_reporting);
            serde_json::json!({"reason": c["labels"]["reason"], "check": c["labels"]["check"], "count": c["value"], "reporting_only": reporting})
        })
        .collect();
    serde_json::json!({
        "state": state(n), "in_window": n, "window_s": defaults::num("fail_open.window_s"),
        "soft": defaults::num("fail_open.soft_per_window"), "hard": defaults::num("fail_open.hard_per_window"),
        "top_reason": top, "effect": effect(&top), "reporting_in_window": reporting_in_window(), "totals": by,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_notice_rides_one_answer_per_session_and_only_while_the_file_exists() {
        // a session id new to every run: the once-per-session stamp outlives the run in the scratch state dir
        let unique = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_nanos());
        let raw = format!(r#"{{"session_id":"s-notice-{}-{unique}","hook_event_name":"UserPromptSubmit"}}"#, std::process::id());
        let raw = raw.as_str();
        let plain = || crate::client::Outcome { out: String::new(), code: 0, err: String::new() };
        crate::discard::harmless(std::fs::create_dir_all(crate::paths::dir())); // keep: the scratch state dir of this test run
        crate::discard::harmless(std::fs::remove_file(notice_path())); // keep: a leftover of an earlier run
        assert_eq!(with_notice(raw, "UserPromptSubmit", plain()).out, "", "no notice file, no change");
        std::fs::write(notice_path(), "NOTICE-LINE").unwrap();
        let first = with_notice(raw, "UserPromptSubmit", plain());
        assert!(first.out.contains("NOTICE-LINE"), "{}", first.out);
        assert_eq!(with_notice(raw, "UserPromptSubmit", plain()).out, "", "once per session");
        let mut blocked = plain();
        blocked.code = 2;
        assert_eq!(with_notice(r#"{"session_id":"s-other"}"#, "PreToolUse", blocked).out, "", "a block is never decorated");
        crate::discard::harmless(std::fs::remove_file(notice_path())); // keep: cleanup of the scratch file
    }

    /// Feed `reasons` into a private window (never the process-wide one, which other tests also write) and return the state and notice.
    fn assess(reasons: &[&str]) -> (&'static str, Option<String>, u64) {
        let mut w = Win::default();
        let now = Instant::now();
        for r in reasons {
            w.push(now, r);
        }
        let (n, top, reporting) = w.counts(now);
        (state(n), notice_for(n, &top), reporting)
    }

    #[test]
    fn a_burst_of_undelivered_verdicts_is_not_degraded_and_gives_no_skipped_notice() {
        let burst = vec![defaults::text("wire.reason_undelivered"); (defaults::num("fail_open.hard_per_window") * 3) as usize];
        let (st, notice, reporting) = assess(&burst);
        assert_eq!(st, defaults::text("fail_open.state_ok"), "the verdict was applied, only its confirmation was late");
        assert_eq!(notice, None);
        assert!(reporting > 0, "still counted, for status");
    }

    #[test]
    fn a_burst_of_script_timeouts_gives_the_skipped_notice() {
        let burst = vec![defaults::text("fail_open.reason_script_timeout"); defaults::num("fail_open.soft_per_window") as usize];
        let (st, notice, _) = assess(&burst);
        assert_eq!(st, defaults::text("fail_open.state_soft"));
        let text = notice.expect("a notice");
        assert!(text.contains("script_timeout"), "{text}");
        assert!(text.contains(&effect("script_timeout")), "{text}");
    }

    #[test]
    fn a_reporting_flood_neither_flips_the_state_nor_hides_skipped_ones() {
        let mut mixed = vec![defaults::text("wire.reason_undelivered"); (defaults::num("fail_open.hard_per_window") * 4) as usize];
        mixed.extend(vec![defaults::text("fail_open.reason_busy"); defaults::num("fail_open.soft_per_window") as usize]);
        let (st, notice, _) = assess(&mixed);
        assert_eq!(st, defaults::text("fail_open.state_soft"), "only the skipped class counts");
        let text = notice.expect("a notice");
        assert!(text.contains("busy") && !text.contains("undelivered_verdict"), "{text}");
    }

    #[test]
    fn every_recorded_reason_has_a_class_and_an_effect() {
        for k in [
            "fail_open.reason_internal",
            "fail_open.reason_busy",
            "fail_open.reason_deadline",
            "fail_open.reason_script_timeout",
            "fail_open.reason_jev_breaker",
            "fail_open.reason_missing_key",
            "wire.reason_undelivered",
        ] {
            let r = defaults::text(k);
            assert_ne!(effect(r), defaults::text("fail_open.effect_default"), "{r} has no effect text");
        }
        assert!(is_reporting(defaults::text("wire.reason_undelivered")));
        assert!(!is_reporting(defaults::text("fail_open.reason_busy")));
    }

    #[test]
    fn state_follows_the_soft_and_hard_limits() {
        let (soft, hard) = (defaults::num("fail_open.soft_per_window"), defaults::num("fail_open.hard_per_window"));
        assert_eq!(state(0), defaults::text("fail_open.state_ok"));
        assert_eq!(state(soft), defaults::text("fail_open.state_soft"));
        assert_eq!(state(hard), defaults::text("fail_open.state_hard"));
    }
}
