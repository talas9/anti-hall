//! The action audit (feature 10): one read-only view of what the acting features did. It joins the action ledger
//! (`dsact.ledger`: keys, attempts, in-doubt keys), the witness comparison (`dsact.shadow`) and the telemetry `act` / `mistake`
//! events every acting feature emits (schema: `telemetry.fields`, documented in docs/AH-ENGINE.md) into per-feature action
//! counts, success rate, refusals by reason and mistake rate. Nothing is written. Thresholds and word lists are plugin config
//! (`devswarm_act.audit_*`); the functions here are pure over parsed rows so fixtures can test them.
use super::exec::Report;
use super::ledger::Word;
use crate::defaults;
use crate::telemetry::emit::ActRec;
use crate::telemetry::event::Outcome;
use serde_json::{Map, Value, json};
use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;

/// The telemetry record of a finished action report (the outcome words map to telemetry outcomes in `devswarm_act.audit_outcomes`).
pub fn act_rec(r: &Report, latency_ms: u64) -> ActRec<'_> {
    let map = defaults::raw("devswarm_act.audit_outcomes");
    let word = r.word.text();
    let outcome = map.as_table().into_iter().flatten().find(|(_, l)| l.strings().contains(&word)).and_then(|(o, _)| Outcome::parse(o)).unwrap_or(Outcome::Skip);
    let reason = if r.word == Word::Done { "" } else { word };
    ActRec { feature: &r.kind, action: &r.kind, outcome, latency_ms, target: &r.id, inputs: "", reason, action_id: &r.key }
}

fn lines(path: &Path) -> Vec<Value> {
    std::fs::read_to_string(path).unwrap_or_default().lines().filter_map(|l| serde_json::from_str(l).ok()).collect() // keep: an absent or torn file reads as no rows
}

fn s<'a>(v: &'a Value, k: &str) -> &'a str {
    v.get(k).and_then(Value::as_str).unwrap_or_default()
}

fn rate(num: u64, den: u64) -> Value {
    if den == 0 { Value::Null } else { json!((num as f64 / den as f64 * 10000.0).round() / 10000.0) }
}

#[derive(Default)]
struct Feat {
    runs: u64,
    ok: u64,
    err: u64,
    timeout: u64,
    block: u64,
    skip: u64,
    refusals: BTreeMap<String, u64>,
    ms: Vec<u64>,
    ids: BTreeSet<String>,
    mistaken: BTreeSet<String>,
    mistakes: u64,
}

fn pct(ms: &[u64], q: f64) -> Value {
    if ms.is_empty() {
        return Value::Null;
    }
    let mut v = ms.to_vec();
    v.sort_unstable();
    json!(v[((v.len() - 1) as f64 * q).round() as usize])
}

/// The per-feature table from telemetry `act` and `mistake` event rows (the `events` array of `telemetry events`).
pub fn features(acts: &[Value], mistakes: &[Value]) -> Value {
    let mut by: BTreeMap<String, Feat> = BTreeMap::new();
    for e in acts {
        let f = by.entry(s(e, "h").to_string()).or_default();
        f.runs += 1;
        match s(e, "o") {
            "allow" => f.ok += 1,
            "error" => f.err += 1,
            "timeout" => f.timeout += 1,
            "block" => {
                f.block += 1;
                *f.refusals.entry(s(e, "reason").to_string()).or_default() += 1;
            }
            _ => f.skip += 1,
        }
        f.ms.push(e.get("ms").and_then(Value::as_u64).unwrap_or(0));
        f.ids.insert(s(e, "action_id").to_string());
    }
    let mut orphan = 0u64;
    for m in mistakes {
        let id = s(m, "action_id").to_string();
        let known = by.values().any(|x| x.ids.contains(&id));
        let f = by.entry(s(m, "h").to_string()).or_default();
        f.mistakes += 1;
        if known {
            f.mistaken.insert(id);
        } else {
            orphan += 1;
        }
    }
    let mut out = Map::new();
    for (name, f) in &by {
        let finished = f.ok + f.err + f.timeout;
        out.insert(
            name.clone(),
            json!({"runs": f.runs, "done": f.ok, "failed": f.err, "timeout": f.timeout, "refused": f.block, "skipped": f.skip,
                "successRate": rate(f.ok, finished), "refusalsByReason": f.refusals,
                "mistakes": f.mistakes, "mistakenActions": f.mistaken.len(), "mistakeRate": rate(f.mistaken.len() as u64, f.ok),
                "latencyMs": {"p50": pct(&f.ms, 0.5), "p95": pct(&f.ms, 0.95)}}),
        );
    }
    json!({"byFeature": out, "orphanMistakes": orphan})
}

/// The ledger rows since `since_ms`: outcomes per kind, and the keys that started and never finished (effect in doubt).
pub fn ledger_summary(rows: &[Value], since_ms: i64) -> Value {
    let started = Word::Started.text();
    let mut kinds: BTreeMap<String, BTreeMap<String, u64>> = BTreeMap::new();
    let mut open: BTreeMap<String, i64> = BTreeMap::new();
    for r in rows {
        let ts = r.get("ts").and_then(Value::as_i64).unwrap_or(0);
        let (key, w) = (s(r, "key"), s(r, "outcome"));
        if w == started {
            open.insert(key.to_string(), ts);
        } else {
            open.remove(key);
        }
        if ts >= since_ms {
            *kinds.entry(s(r, "kind").to_string()).or_default().entry(w.to_string()).or_default() += 1;
        }
    }
    let in_doubt: Vec<Value> = open.iter().map(|(k, t)| json!({"key": k, "startedMs": t})).collect();
    json!({"rows": rows.len(), "byKind": kinds, "inDoubt": in_doubt})
}

/// The witness comparison rows since `since_ms`: agreements, mismatches and the latest mismatching triggers.
pub fn shadow_summary(rows: &[Value], since_ms: i64) -> Value {
    let cur: Vec<&Value> = rows.iter().filter(|r| r.get("ts").and_then(Value::as_i64).unwrap_or(0) >= since_ms).collect();
    let agree = cur.iter().filter(|r| r.get("match").and_then(Value::as_bool) == Some(true)).count();
    let last: Vec<Value> = cur
        .iter()
        .filter(|r| r.get("match").and_then(Value::as_bool) != Some(true))
        .rev()
        .take(defaults::num("devswarm_act.audit_mismatch_top") as usize)
        .map(|r| json!({"trigger": s(r, "trigger"), "onlyEngine": r["onlyEngine"], "onlyNode": r["onlyNode"]}))
        .collect();
    json!({"comparisons": cur.len(), "agree": agree, "mismatch": cur.len() - agree, "agreementRate": rate(agree as u64, cur.len() as u64), "recentMismatches": last})
}

/// The whole audit of the state directory `dir` for the last `days` days. Telemetry rows come from `act_events` / `mistake_events`.
pub fn build(dir: &Path, now_ms: i64, days: u64, act_events: &[Value], mistake_events: &[Value]) -> Value {
    let since = now_ms - (days as i64) * 86_400_000;
    let ledger = lines(&dir.join(defaults::text("devswarm_act.ledger_file")));
    let shadow = lines(&dir.join(defaults::text("devswarm_act.shadow_file")));
    let mut v = features(act_events, mistake_events);
    v["window"] = json!({"days": days, "sinceMs": since});
    v["ledger"] = ledger_summary(&ledger, since);
    v["witness"] = shadow_summary(&shadow, since);
    v
}

/// Read the telemetry rows (`act`, `mistake`) from hot.db and build the audit of the engine state directory.
pub fn collect(dir: &Path, now_ms: i64, days: u64) -> Value {
    let tel = crate::telemetry::cli::open_existing();
    let limit = defaults::num("devswarm_act.audit_event_limit") as usize;
    let rows = |kind: &str| -> Vec<Value> {
        let r = crate::telemetry::report::events_json(tel.as_ref(), None, kind, days, limit, now_ms as u64);
        r.get("events").and_then(Value::as_array).cloned().unwrap_or_default()
    };
    build(dir, now_ms, days, &rows("act"), &rows("mistake"))
}

/// Whether the audit holds anything to show.
pub fn has_data(a: &Value) -> bool {
    a["byFeature"].as_object().is_some_and(|m| !m.is_empty())
        || a["ledger"]["rows"].as_u64().unwrap_or(0) > 0
        || a["witness"]["comparisons"].as_u64().unwrap_or(0) > 0
}

/// Findings for the doctor: `(level, text)` with level `ok` or `warn`, judged by the `devswarm_act.audit_*_warn_pct` limits.
pub fn findings(a: &Value) -> Vec<(&'static str, String)> {
    let (fw, mw) = (defaults::num("devswarm_act.audit_failure_warn_pct") as f64, defaults::num("devswarm_act.audit_mistake_warn_pct") as f64);
    let mut out = Vec::new();
    for (name, f) in a["byFeature"].as_object().into_iter().flatten() {
        let (succ, mis) = (f["successRate"].as_f64(), f["mistakeRate"].as_f64());
        let bad = succ.is_some_and(|r| (1.0 - r) * 100.0 > fw) || mis.is_some_and(|r| r * 100.0 > mw);
        let text = defaults::render(
            "devswarm_act.msg_audit_feature",
            &[
                ("feature", name),
                ("runs", &f["runs"]),
                ("done", &f["done"]),
                ("failed", &f["failed"]),
                ("refused", &f["refused"]),
                ("mistakes", &f["mistakenActions"]),
            ],
        );
        out.push((if bad { "warn" } else { "ok" }, text));
    }
    let doubt = a["ledger"]["inDoubt"].as_array().map_or(0, Vec::len);
    if doubt > 0 {
        out.push(("warn", defaults::render("devswarm_act.msg_audit_in_doubt", &[("n", &doubt)])));
    }
    let w = &a["witness"];
    if w["mismatch"].as_u64().unwrap_or(0) > 0 {
        out.push(("warn", defaults::render("devswarm_act.msg_audit_witness", &[("mismatch", &w["mismatch"]), ("n", &w["comparisons"])])));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn act(h: &str, o: &str, id: &str, reason: &str, ms: u64) -> Value {
        json!({"k": "act", "h": h, "e": h, "o": o, "ms": ms, "action_id": id, "reason": reason})
    }

    #[test]
    fn counts_success_refusals_by_reason_and_mistake_rate_per_feature() {
        let acts = [
            act("auto-archive", "allow", "k1", "", 10),
            act("auto-archive", "allow", "k2", "", 30),
            act("auto-archive", "error", "k3", "failed", 20),
            act("auto-archive", "block", "k4", "stale", 1),
            act("auto-archive", "block", "k5", "stale", 1),
            act("auto-archive", "block", "k6", "refused", 1),
            act("poke", "allow", "p1", "", 5),
        ];
        let mistakes =
            [json!({"h": "auto-archive", "action_id": "k2"}), json!({"h": "auto-archive", "action_id": "k2"}), json!({"h": "poke", "action_id": "nope"})];
        let f = features(&acts, &mistakes);
        let a = &f["byFeature"]["auto-archive"];
        assert_eq!((a["runs"].as_u64(), a["done"].as_u64(), a["failed"].as_u64(), a["refused"].as_u64()), (Some(6), Some(2), Some(1), Some(3)));
        assert_eq!(a["successRate"].as_f64(), Some(0.6667));
        assert_eq!(a["refusalsByReason"], json!({"stale": 2, "refused": 1}));
        assert_eq!((a["mistakes"].as_u64(), a["mistakenActions"].as_u64(), a["mistakeRate"].as_f64()), (Some(2), Some(1), Some(0.5)));
        assert_eq!(a["latencyMs"]["p50"].as_u64(), Some(10));
        assert_eq!(f["orphanMistakes"].as_u64(), Some(1), "a mistake whose action is unknown is counted, not dropped");
        assert_eq!(f["byFeature"]["poke"]["mistakeRate"].as_f64(), Some(0.0));
    }

    #[test]
    fn ledger_finds_keys_that_started_and_never_finished() {
        let rows = [
            json!({"ts": 10, "key": "a", "kind": "archive", "outcome": "started"}),
            json!({"ts": 11, "key": "a", "kind": "archive", "outcome": "done"}),
            json!({"ts": 12, "key": "b", "kind": "archive", "outcome": "started"}),
        ];
        let l = ledger_summary(&rows, 0);
        assert_eq!(l["inDoubt"], json!([{"key": "b", "startedMs": 12}]));
        assert_eq!(l["byKind"]["archive"]["done"].as_u64(), Some(1));
        assert_eq!(ledger_summary(&rows, 12)["byKind"]["archive"]["started"].as_u64(), Some(1), "the window cuts older rows");
    }

    #[test]
    fn witness_agreement_and_recent_mismatches() {
        let rows = [
            json!({"ts": 5, "trigger": "t1", "match": true}),
            json!({"ts": 6, "trigger": "t2", "match": false, "onlyEngine": [["workspace", "archive", "x"]], "onlyNode": []}),
        ];
        let w = shadow_summary(&rows, 0);
        assert_eq!((w["comparisons"].as_u64(), w["agree"].as_u64(), w["mismatch"].as_u64()), (Some(2), Some(1), Some(1)));
        assert_eq!(w["recentMismatches"][0]["trigger"], "t2");
    }

    #[test]
    fn build_reads_fixture_files_and_the_doctor_findings_flag_trouble() {
        let d = std::env::temp_dir().join(format!("ah-audit-{}", std::process::id()));
        std::fs::create_dir_all(&d).unwrap();
        std::fs::write(d.join(defaults::text("devswarm_act.ledger_file")), "{\"ts\":100,\"key\":\"z\",\"kind\":\"poke\",\"outcome\":\"started\"}\nnot json\n")
            .unwrap();
        let acts: Vec<Value> = (0..5).map(|i| act("f", if i < 3 { "allow" } else { "error" }, &format!("k{i}"), "", 1)).collect();
        let a = build(&d, 200, 1, &acts, &[]);
        assert!(has_data(&a));
        let f = findings(&a);
        assert!(f.iter().any(|(l, t)| *l == "warn" && t.starts_with("f:")), "{f:?}");
        assert!(f.iter().any(|(l, t)| *l == "warn" && t.contains("never finished")), "{f:?}");
        assert!(!has_data(&build(&d.join("none"), 200, 1, &[], &[])));
    }

    #[test]
    fn a_report_maps_to_the_shared_act_schema() {
        let r = Report {
            kind: "auto-archive".into(),
            id: "ws1".into(),
            key: "auto-archive:ws1:abc".into(),
            word: Word::Refused,
            detail: Value::Null,
            inputs: Value::Null,
            latency_ms: 0,
        };
        let rec = act_rec(&r, 7);
        assert_eq!((rec.outcome, rec.reason, rec.feature, rec.action_id), (Outcome::Block, "refused", "auto-archive", "auto-archive:ws1:abc"));
        let ev = crate::telemetry::emit::act_call(&rec);
        let back = crate::telemetry::event::Event::from_json(&ev.to_json()).unwrap();
        assert_eq!(back, ev, "the event survives its own JSON form");
        let done = Report { word: Word::Done, ..r };
        assert_eq!(act_rec(&done, 1).outcome, Outcome::Allow);
    }
}
