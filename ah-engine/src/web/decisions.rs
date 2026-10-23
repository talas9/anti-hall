//! `CTL decisions since=<seq> [check=<name>]`: a sampled ring of the latest check decisions, for the dashboard's pipeline view.
//!
//! One row per check run (every `decisions.sample_n`th): event, check, decision, the id of the rule that named the check, the check's
//! wall time and the bytes it injects into the model's context. The ring holds `decisions.ring` rows and overwrites the oldest; a row
//! has a sequence number, so a reader asks for the rows after the last one it saw. One push is a short lock and two small strings.
use crate::checks::Verdict;
use crate::defaults;
use serde_json::{Value, json};
use std::collections::VecDeque;
use std::sync::Mutex;
use std::sync::atomic::{AtomicU64, Ordering::Relaxed};

struct Row {
    seq: u64,
    ts_ms: u64,
    event: String,
    check: String,
    decision: &'static str,
    rule: String,
    us: u64,
    injected: u64,
}

static RING: Mutex<VecDeque<Row>> = Mutex::new(VecDeque::new());
static SEQ: AtomicU64 = AtomicU64::new(0);
static CALLS: AtomicU64 = AtomicU64::new(0);

fn injected(v: &Verdict) -> u64 {
    match v {
        Verdict::Advisory(s) => s.len() as u64,
        Verdict::Exact(x) if x.code == 0 => x.out.len() as u64,
        Verdict::Routed(inner, _) => injected(inner),
        _ => 0,
    }
}

/// Record one check decision (the daemon's observer calls it for every check that ran).
pub fn push(event: &str, check: &str, rule: &str, verdict: &Verdict, us: u64) {
    if !defaults::has("decisions.ring") || !CALLS.fetch_add(1, Relaxed).is_multiple_of(defaults::num("decisions.sample_n").max(1)) {
        return;
    }
    let cap = defaults::num("decisions.ring").max(1) as usize;
    let row = Row {
        seq: SEQ.fetch_add(1, Relaxed) + 1,
        ts_ms: crate::health::now_ms(),
        event: event.to_string(),
        check: check.to_string(),
        decision: crate::telemetry::decision_name(verdict),
        rule: rule.to_string(),
        us,
        injected: injected(verdict),
    };
    let mut r = RING.lock().unwrap_or_else(|e| e.into_inner());
    while r.len() >= cap {
        r.pop_front();
    }
    r.push_back(row);
}

/// `CTL decisions`: the rows with a sequence above `since`, oldest first, at most `decisions.page`.
pub fn snapshot(args: &str) -> Value {
    let want = |k: &str| args.split_whitespace().find_map(|a| a.strip_prefix(k).map(str::to_string));
    let since: u64 = want("since=").and_then(|v| v.parse().ok()).unwrap_or(0);
    let check = want("check=");
    let r = RING.lock().unwrap_or_else(|e| e.into_inner());
    let rows: Vec<Value> = r
        .iter()
        .filter(|x| x.seq > since && check.as_deref().is_none_or(|c| x.check == c))
        .take(defaults::num("decisions.page") as usize)
        .map(|x| json!({"seq": x.seq, "ts_ms": x.ts_ms, "event": x.event, "check": x.check, "decision": x.decision, "rule": x.rule, "us": x.us, "injected_bytes": x.injected}))
        .collect();
    json!({"rows": rows, "last_seq": SEQ.load(Relaxed), "ring": defaults::num("decisions.ring")})
}
