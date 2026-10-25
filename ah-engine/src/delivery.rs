//! The delivery ledger (#312): what each check DECIDED, what reached the agent (DELIVERED) and what the agent did about it
//! (COMPLIED), counted per check.
//!
//! * decided: the check answered with a message or a block (a quiet allow is not counted). Counted when the answer is made.
//! * delivered: the daemon wrote the reply that carries the answer, in time, to the hook client (an answer lost to shedding, a
//!   deadline, a CPU cut or a client that left is counted instead as `delivery_lost` with its reason).
//! * complied: the agent's reaction. A check with a row in `delivery.react` is armed when its answer is delivered; the next
//!   `delivery.react_window_calls` tool calls of the session are watched, and a call to one of the row's tools within them is
//!   `complied`, none within them (or within `delivery.react_window_ms`) is `ignored`. A check without a row has no compliance
//!   figure: its reaction is not measurable from tool calls.
//!
//! State is in memory, bounded (`delivery.pending_sessions_max`, `delivery.pending_per_session_max`), and costs one hash lookup per
//! tool call of a session that has something armed. Nothing here is a decision: the ledger never changes an answer.
use crate::defaults;
use crate::telemetry::Telemetry;
use std::cell::RefCell;
use std::collections::HashMap;
use std::sync::Mutex;

thread_local! {
    /// (session, check) of every answer with a message or a block that this thread's request produced.
    static DECIDED: RefCell<Vec<(String, String)>> = const { RefCell::new(Vec::new()) };
}

/// One armed check of a session.
struct Armed {
    check: String,
    calls: u64,
    since_ms: u64,
}

static PENDING: Mutex<Option<HashMap<String, Vec<Armed>>>> = Mutex::new(None);

fn stage(t: &Telemetry, check: &str, which: &str) {
    t.with_metrics(|m| m.inc("delivery_stage", &[("check", check), ("stage", defaults::text(which))]));
}

/// A check answered with a message or a block while this thread served a request.
pub fn decided(t: &Telemetry, session: &str, check: &str) {
    stage(t, check, "delivery.stage_decided");
    DECIDED.with(|d| d.borrow_mut().push((session.to_string(), check.to_string())));
}

/// The request ended: the answers it produced are delivered when `delivered` (the reply was written and the client still
/// waited), else lost for the reason `delivery.reason_undelivered`. Delivered answers of checks with a `delivery.react` row are armed.
pub fn settle(t: &Telemetry, delivered: bool) {
    let answers = DECIDED.with(|d| std::mem::take(&mut *d.borrow_mut()));
    for (session, check) in answers {
        if !delivered {
            t.with_metrics(|m| m.inc("delivery_lost", &[("check", check.as_str()), ("reason", defaults::text("delivery.reason_undelivered"))]));
            continue;
        }
        stage(t, &check, "delivery.stage_delivered");
        arm(&session, &check);
    }
}

fn react_tools(check: &str) -> Option<Vec<&'static str>> {
    defaults::raw("delivery.react").get(check).map(defaults::V::strings)
}

fn arm(session: &str, check: &str) {
    if session.is_empty() || defaults::num("delivery.react_window_calls") == 0 || react_tools(check).is_none() {
        return;
    }
    let mut g = PENDING.lock().unwrap_or_else(|e| e.into_inner());
    let map = g.get_or_insert_with(HashMap::new);
    if !map.contains_key(session) && map.len() >= defaults::num("delivery.pending_sessions_max") as usize {
        // bounded: the session whose oldest armed check is the oldest makes room (its unobserved checks are not counted either way)
        let oldest = map.iter().min_by_key(|(_, v)| v.iter().map(|a| a.since_ms).min().unwrap_or(0)).map(|(k, _)| k.clone());
        if let Some(k) = oldest {
            map.remove(&k);
        }
    }
    let list = map.entry(session.to_string()).or_default();
    if list.iter().any(|a| a.check == check) {
        return; // one open question per check: its window is already running
    }
    if list.len() < defaults::num("delivery.pending_per_session_max") as usize {
        list.push(Armed { check: check.to_string(), calls: 0, since_ms: crate::health::now_ms() });
    }
}

/// A tool call of `session` is about to be judged: every armed check of the session either sees its reaction (`tool` is one of its
/// tools), runs out of window, or waits for the next call.
pub fn observe_tool(t: &Telemetry, session: &str, tool: &str) {
    if session.is_empty() {
        return;
    }
    let mut g = PENDING.lock().unwrap_or_else(|e| e.into_inner());
    let Some(list) = g.as_mut().and_then(|m| m.get_mut(session)) else { return };
    let (window, max_age) = (defaults::num("delivery.react_window_calls"), defaults::num("delivery.react_window_ms"));
    let now = crate::health::now_ms();
    let mut results: Vec<(String, &'static str)> = Vec::new();
    list.retain_mut(|a| {
        a.calls += 1;
        let hit = react_tools(&a.check).is_some_and(|ts| ts.contains(&tool));
        let spent = a.calls >= window || now.saturating_sub(a.since_ms) > max_age;
        if hit {
            results.push((a.check.clone(), "delivery.stage_complied"));
        } else if spent {
            results.push((a.check.clone(), "delivery.stage_ignored"));
        }
        !(hit || spent)
    });
    let empty = list.is_empty();
    if empty && let Some(m) = g.as_mut() {
        m.remove(session);
    }
    drop(g);
    for (check, which) in results {
        stage(t, &check, which);
    }
}

/// One check's counts of every stage.
#[derive(Default)]
struct Row {
    decided: u64,
    delivered: u64,
    complied: u64,
    ignored: u64,
    shed: u64,
    lost: u64,
}

/// The ledger as `status` shows it: per check the counts of every stage (a stage never reached is 0; `complied` and `ignored` are
/// `null` for a check with no `delivery.react` row), and the spills per event.
pub fn status(t: &Telemetry) -> serde_json::Value {
    use serde_json::{Map, Value, json};
    let snap = t.with_metrics(|m| m.snapshot(""));
    let (decided, delivered, complied, ignored) = (
        defaults::text("delivery.stage_decided"),
        defaults::text("delivery.stage_delivered"),
        defaults::text("delivery.stage_complied"),
        defaults::text("delivery.stage_ignored"),
    );
    let shed = defaults::text("delivery.reason_shed");
    let mut checks: std::collections::BTreeMap<String, Row> = std::collections::BTreeMap::new();
    let mut spills = Map::new();
    let mut pinned_spills = 0u64;
    let counters = snap.get("counters").and_then(Value::as_array).cloned().unwrap_or_default();
    for c in &counters {
        let label = |k: &str| c.get("labels").and_then(|l| l.get(k)).and_then(Value::as_str).unwrap_or_default().to_string();
        let n = c.get("value").and_then(Value::as_u64).unwrap_or(0);
        match c.get("name").and_then(Value::as_str).unwrap_or_default() {
            "delivery_stage" => {
                let s = label("stage");
                let slot = [decided, delivered, complied, ignored].iter().position(|w| *w == s);
                let row = checks.entry(label("check")).or_default();
                match slot {
                    Some(0) => row.decided += n,
                    Some(1) => row.delivered += n,
                    Some(2) => row.complied += n,
                    Some(3) => row.ignored += n,
                    _ => {}
                }
            }
            "delivery_lost" => {
                let shed_reason = label("reason") == shed;
                let row = checks.entry(label("check")).or_default();
                if shed_reason {
                    row.shed += n;
                } else {
                    row.lost += n;
                }
            }
            "context_spills" => {
                let e = spills.entry(label("event")).or_insert_with(|| json!(0));
                *e = json!(e.as_u64().unwrap_or(0) + n);
            }
            "context_spill_pinned" => pinned_spills += n,
            _ => {}
        }
    }
    let never: Vec<&str> = defaults::raw("diagnostics.shed_never").as_table().map(|t| t.iter().map(|(k, _)| *k).collect()).unwrap_or_default();
    let mut essential_shed = 0u64;
    let rows: Map<String, Value> = checks
        .into_iter()
        .map(|(check, r)| {
            let measured = react_tools(&check).is_some();
            let (dec, del, com, ign, shd, lost) = (r.decided, r.delivered, r.complied, r.ignored, r.shed, r.lost);
            if never.contains(&check.as_str()) {
                essential_shed += shd;
            }
            let row = json!({
                "decided": dec, "delivered": del,
                "complied": if measured { json!(com) } else { Value::Null },
                "ignored": if measured { json!(ign) } else { Value::Null },
                "shed": shd, "lost": lost,
            });
            (check, row)
        })
        .collect();
    json!({ "per_check": rows, "essential_shed": essential_shed, "spills_by_event": spills, "pinned_spills": pinned_spills })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn count(t: &Telemetry, check: &str, which: &str) -> u64 {
        t.with_metrics(|m| m.counter("delivery_stage", &[("check", check), ("stage", defaults::text(which))]))
    }

    #[test]
    fn a_delivered_answer_is_armed_and_the_reaction_within_the_window_is_complied() {
        let t = Telemetry::new();
        decided(&t, "s-react", "task-tracker");
        settle(&t, true);
        assert_eq!((count(&t, "task-tracker", "delivery.stage_decided"), count(&t, "task-tracker", "delivery.stage_delivered")), (1, 1));
        observe_tool(&t, "s-react", "Bash");
        assert_eq!(count(&t, "task-tracker", "delivery.stage_complied"), 0, "an unrelated tool is not a reaction");
        observe_tool(&t, "s-react", "TaskUpdate");
        assert_eq!(count(&t, "task-tracker", "delivery.stage_complied"), 1);
        observe_tool(&t, "s-react", "TaskUpdate");
        assert_eq!(count(&t, "task-tracker", "delivery.stage_complied"), 1, "counted once per delivery");
    }

    #[test]
    fn no_reaction_inside_the_window_is_ignored_and_an_undelivered_answer_is_lost_not_delivered() {
        let t = Telemetry::new();
        decided(&t, "s-ign", "task-tracker");
        settle(&t, true);
        for _ in 0..defaults::num("delivery.react_window_calls") {
            observe_tool(&t, "s-ign", "Bash");
        }
        assert_eq!((count(&t, "task-tracker", "delivery.stage_ignored"), count(&t, "task-tracker", "delivery.stage_complied")), (1, 0));
        decided(&t, "s-lost", "task-tracker");
        settle(&t, false);
        assert_eq!(count(&t, "task-tracker", "delivery.stage_delivered"), 1, "only the first delivery counts");
        let lost = t.with_metrics(|m| m.counter("delivery_lost", &[("check", "task-tracker"), ("reason", defaults::text("delivery.reason_undelivered"))]));
        assert_eq!(lost, 1);
    }

    #[test]
    fn status_shows_the_stages_per_check_and_null_compliance_for_a_check_without_a_reaction_row() {
        let t = Telemetry::new();
        decided(&t, "s-st", "version-alert");
        settle(&t, true);
        let s = status(&t);
        assert_eq!(s["per_check"]["version-alert"]["decided"], 1);
        assert_eq!(s["per_check"]["version-alert"]["delivered"], 1);
        assert!(s["per_check"]["version-alert"]["complied"].is_null());
    }

    #[test]
    fn the_essential_reminders_are_never_shed_and_their_grace_stays_under_the_cap() {
        for c in ["task-tracker", "tasklist-guard", "devswarm-parent-inbox", "devswarm-child-gate", "verify-first"] {
            assert!(defaults::raw("diagnostics.shed_never").get(c).is_some(), "{c} must be in diagnostics.shed_never");
            let grace = defaults::raw("diagnostics.deadline_grace_ms").get(c).and_then(|v| v.as_integer()).unwrap_or(0) as u64;
            assert!(grace > 0 && grace <= defaults::num("diagnostics.deadline_grace_cap_ms") + 100, "{c} has a deadline grace");
        }
    }
}
