//! #462 cohort counters: check calls by the session's rule-digest state (`rule_digest_calls`, for blocks per 100 matching calls
//! with the digest on versus off) and whether the next call of a check after it blocked was blocked again
//! (`rule_retry_compliant`). The state is in memory, bounded by `guard_rules.cohort_track_max`: a session the daemon did not
//! see start (it started before a restart) is not counted. Label values: `guard_rules.cohort_labels`.
use super::event::Outcome;
use crate::defaults;
use std::collections::{HashMap, HashSet};
use std::sync::Mutex;

#[derive(Default)]
struct Track {
    /// session -> whether the digest was injected at its start
    digest: HashMap<String, bool>,
    /// (session, check) pairs whose last call blocked, waiting for their retry
    pending: HashSet<(String, String)>,
}

static TRACK: Mutex<Option<Track>> = Mutex::new(None);

/// Count one finished check call of `session` with `outcome`.
pub fn observe(check: &str, session: &str, outcome: Outcome) {
    if session.is_empty() {
        return;
    }
    let max = defaults::num("guard_rules.cohort_track_max") as usize;
    let labels = defaults::raw("guard_rules.cohort_labels");
    let mut g = TRACK.lock().unwrap_or_else(|e| e.into_inner());
    let t = g.get_or_insert_with(Track::default);
    if check == defaults::text("guard_rules.digest_check") {
        if t.digest.len() < max || t.digest.contains_key(session) {
            t.digest.insert(session.to_string(), outcome == Outcome::Advise);
        }
        return;
    }
    if let Some(on) = t.digest.get(session) {
        crate::metrics::bump("rule_digest_calls", &[("state", labels.str_field(if *on { "on" } else { "off" })), ("outcome", outcome.name())]);
    }
    let key = (session.to_string(), check.to_string());
    let result = match outcome {
        Outcome::Block => "repeat",
        Outcome::Allow | Outcome::Advise => "compliant",
        _ => return, // a deferred, failed or timed-out call is no answer of the check: the retry is still pending
    };
    if t.pending.remove(&key) {
        crate::metrics::bump("rule_retry_compliant", &[("check", check), ("result", labels.str_field(result))]);
    }
    if outcome == Outcome::Block && t.pending.len() < max {
        t.pending.insert(key);
    }
}
