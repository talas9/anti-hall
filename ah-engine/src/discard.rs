//! Deliberate discards of fallible results (E3: never lose a failure silently).
//!
//! Every place that cannot act on an error says so through one of these, so a bare `let _ =` never hides a decision:
//! - [`harmless`]: the failure changes nothing (a cleanup that raced, a closed pipe, a thread that already ended). The
//!   call site says why in a comment.
//! - [`logged`], [`logged_ok`], [`logged_or_default`], [`note`]: the operation is best-effort (the engine fails open), but
//!   a lost write or read is a fact an operator needs, so one reason-coded line goes to the event log. Repeats of the same
//!   reason inside `discard.log_interval_ms` are dropped, so a failing disk cannot flood the log.
use crate::{defaults, health};
use std::collections::HashMap;
use std::fmt::Display;
use std::sync::Mutex;
use std::time::Instant;

/// Event-log kind of every line this module writes; the reason code is the line's code.
const KIND: &str = "discard";

static LAST: Mutex<Option<HashMap<&'static str, Instant>>> = Mutex::new(None);

/// Drop a result whose failure is harmless. Use it instead of `let _ =` and put the reason in a comment beside the call.
pub fn harmless<T, E>(_result: Result<T, E>) {}

/// Record `detail` under `code`, at most once per `discard.log_interval_ms` per code. The set of codes is the set of call
/// sites (string literals), so the table is bounded.
pub fn note(code: &'static str, detail: &str) {
    let window = defaults::millis("discard.log_interval_ms");
    {
        let mut g = LAST.lock().unwrap_or_else(|e| e.into_inner());
        let map = g.get_or_insert_with(HashMap::new);
        let now = Instant::now();
        if map.get(code).is_some_and(|t| now.duration_since(*t) < window) {
            return;
        }
        map.insert(code, now);
    }
    emit(code, detail);
}

#[cfg(not(test))]
fn emit(code: &str, detail: &str) {
    health::log_event(KIND, code, detail);
}

// Unit tests never write to the real event log (it lives under the user's home): they capture the lines instead.
#[cfg(test)]
thread_local! {
    static CAPTURED: std::cell::RefCell<Vec<(String, String)>> = const { std::cell::RefCell::new(Vec::new()) };
}

/// The lines this thread's tests have logged so far (test builds only).
#[cfg(test)]
pub(crate) fn captured() -> Vec<(String, String)> {
    CAPTURED.with(|c| c.borrow().clone())
}

#[cfg(test)]
fn emit(code: &str, detail: &str) {
    let _ = (KIND, health::log_event as fn(&str, &str, &str));
    CAPTURED.with(|c| c.borrow_mut().push((code.to_string(), detail.to_string())));
}

/// A best-effort operation whose failure is logged under `code` and otherwise ignored.
pub fn logged<T, E: Display>(code: &'static str, result: Result<T, E>) {
    if let Err(e) = result {
        note(code, &e.to_string());
    }
}

/// `result.ok()` that logs the failure under `code`.
pub fn logged_ok<T, E: Display>(code: &'static str, result: Result<T, E>) -> Option<T> {
    match result {
        Ok(v) => Some(v),
        Err(e) => {
            note(code, &e.to_string());
            None
        }
    }
}

/// `result.unwrap_or_default()` that logs the failure under `code`.
pub fn logged_or_default<T: Default, E: Display>(code: &'static str, result: Result<T, E>) -> T {
    logged_ok(code, result).unwrap_or_default()
}

/// Method form of [`logged_ok`] / [`logged_or_default`], so a long `Result` chain keeps its shape.
pub trait Logged<T, E> {
    /// `.ok()` that logs the failure under `code`.
    fn ok_logged(self, code: &'static str) -> Option<T>;
    /// `.unwrap_or_default()` that logs the failure under `code`.
    fn or_default_logged(self, code: &'static str) -> T
    where
        T: Default;
}

impl<T, E: Display> Logged<T, E> for Result<T, E> {
    fn ok_logged(self, code: &'static str) -> Option<T> {
        logged_ok(code, self)
    }

    fn or_default_logged(self, code: &'static str) -> T
    where
        T: Default,
    {
        logged_or_default(code, self)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn values_pass_through_and_a_failure_is_logged_once_with_its_code_and_text() {
        assert_eq!(logged_ok("t_ok", Ok::<_, String>(3)), Some(3));
        assert!(captured().is_empty(), "a success logs nothing");
        assert_eq!(Err::<i32, _>("boom").ok_logged("t_a"), None);
        assert_eq!(Err::<i32, _>("bang").or_default_logged("t_b"), 0);
        logged("t_c", Err::<(), _>("crash"));
        harmless(Err::<(), _>("silent"));
        assert_eq!(captured(), vec![("t_a".to_string(), "boom".to_string()), ("t_b".to_string(), "bang".to_string()), ("t_c".to_string(), "crash".to_string())]);
    }

    #[test]
    fn one_code_is_rate_limited_to_the_window_and_other_codes_are_not() {
        assert!(defaults::millis("discard.log_interval_ms") > std::time::Duration::ZERO);
        note("t_rate", "first");
        note("t_rate", "second");
        note("t_rate_other", "third");
        let lines: Vec<String> = captured().into_iter().filter(|(c, _)| c.starts_with("t_rate")).map(|(c, d)| format!("{c}:{d}")).collect();
        assert_eq!(lines, vec!["t_rate:first", "t_rate_other:third"]);
    }
}
