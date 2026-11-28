//! The engine's own record of the pokes it made: per workspace, how many, when the last one was, and whether the workspace was
//! escalated (terminal, as in Node's `recovery.js`). Node keeps the same facts in its liveness verdict files; the engine keeps
//! them in its state directory so it never depends on the Node supervisor's files.
// Discard triage (E3): every `.ok()` / `unwrap_or_default()` in this module is a deliberate keep, for these reasons:
// - an unreadable record is an empty one: the workspace is poked from attempt 1 again, which the ledger keys bound
use crate::defaults;
use serde_json::{Map, Value, json};
use std::path::Path;

/// What is recorded for one workspace.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Nudge {
    /// Pokes made.
    pub attempts: u64,
    /// When the last poke was made (epoch ms), `None` before the first.
    pub at: Option<i64>,
    /// Escalated: nothing more is done for it.
    pub escalated: bool,
}

fn file(dir: &Path) -> std::path::PathBuf {
    dir.join(defaults::text("devswarm_wire.nudge_state_file"))
}

fn load(dir: &Path) -> Map<String, Value> {
    std::fs::read_to_string(file(dir)).ok().and_then(|t| serde_json::from_str::<Value>(&t).ok()).and_then(|v| v.as_object().cloned()).unwrap_or_default()
}

/// The record of `id`.
pub fn get(dir: &Path, id: &str) -> Nudge {
    let all = load(dir);
    let e = all.get(id);
    Nudge {
        attempts: e.and_then(|e| e.get("attempts")).and_then(Value::as_u64).unwrap_or(0),
        at: e.and_then(|e| e.get("at")).and_then(Value::as_i64),
        escalated: e.and_then(|e| e.get("escalated")) == Some(&Value::Bool(true)),
    }
}

/// Record a finished poke (attempt `n` at `now`) or an escalation.
pub fn record(dir: &Path, id: &str, poke_attempt: Option<u64>, now: i64) {
    let mut all = load(dir);
    let mut cur = get(dir, id);
    match poke_attempt {
        Some(n) => {
            cur.attempts = cur.attempts.max(n);
            cur.at = Some(now);
        }
        None => cur.escalated = true,
    }
    all.insert(id.to_string(), json!({"attempts": cur.attempts, "at": cur.at, "escalated": cur.escalated}));
    crate::discard::logged("dswire_nudges", crate::atomic::write(file(dir), Value::Object(all).to_string()));
}

/// The poke attempt a finished poke report uses up, if any. A poke that was done uses its attempt. A poke that failed for the whole
/// ledger allowance (the ledger now refuses its key as `Failed`) also uses it: otherwise the same key is chosen on every tick, refused
/// every tick (hundreds of refusals in the actions log), and the workspace is never escalated.
pub fn consumed_attempt(r: &crate::dsact::exec::Report) -> Option<u64> {
    use crate::dsact::ledger::Word;
    let spent = r.word == Word::Done || (r.word == Word::Refused && r.detail.get("state").and_then(Value::as_str).is_some_and(|s| s.starts_with("Failed")));
    spent.then(|| r.key.rsplit(':').next().and_then(|n| n.parse().ok())).flatten()
}

#[cfg(test)]
mod tests {
    use super::consumed_attempt;
    use crate::dsact::exec::Report;
    use crate::dsact::ledger::Word;
    use serde_json::json;

    fn rep(word: Word, detail: serde_json::Value) -> Report {
        Report::new("poke", "ws-1", "poke:ws-1:2", word, detail)
    }

    #[test]
    fn a_done_poke_and_an_exhausted_failing_poke_use_their_attempt() {
        assert_eq!(consumed_attempt(&rep(Word::Done, json!({}))), Some(2));
        let exhausted = json!({"state": "Failed { attempts: 3, last_ms: 5 }"});
        assert_eq!(consumed_attempt(&rep(Word::Refused, exhausted)), Some(2), "the next decision moves on to the next attempt, then to escalation");
    }

    #[test]
    fn other_outcomes_use_nothing() {
        assert_eq!(consumed_attempt(&rep(Word::Failed, json!({}))), None, "a failed run is retried by the ledger first");
        assert_eq!(consumed_attempt(&rep(Word::Refused, json!({"why": "ledger unwritable"}))), None);
        assert_eq!(consumed_attempt(&rep(Word::Skipped, json!({"state": "Done"}))), None);
    }
}
