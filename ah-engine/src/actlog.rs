//! The action log: what every ACTING feature did, refused or got wrong, so a mistake is measurable.
//!
//! One NDJSON file in the engine state directory (`actions.file`). Three kinds of line:
//! * `action`: a feature took (or refused, or failed) an action: feature, action, target, the value of each decision input,
//!   the outcome (`ok` / `refused` / `failed`), the reason and the latency;
//! * `mistake`: a signal, found later, that an action was wrong (a nudge changed nothing, a merge was reverted, ...), linked to
//!   its action by feature + action + target;
//! * `followup`: the result of a check made some time after an action (so the report knows how many were verified).
//!
//! Writers are the features themselves (`dswire` for the stall nudges, `ghrt` for the merge-readiness notice and the auto-merge);
//! the reader is `ah-engine telemetry actions [feature]`. Settings are in `defaults/actions.toml`. Nothing here deletes: a log
//! that grows too large is renamed aside.
// Discard triage (E3): every `.ok()` / `unwrap_or_default()` in this module is a deliberate keep, for these reasons:
// - an absent or unreadable log or follow-up file is an empty one: the report counts nothing, the next write starts it
// - a line that is not JSON is skipped: a torn tail line must not hide the lines before it
use crate::defaults;
use serde_json::{Map, Value, json};
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};

/// One action a feature took (or refused, or failed to take).
pub struct Action<'a> {
    /// The feature (`stall`, `merge_ready`).
    pub feature: &'a str,
    /// The action (`poke`, `escalate`, `notify`, `merge`).
    pub action: &'a str,
    /// What it acted on: the workspace id, or `slug#number@sha`.
    pub target: &'a str,
    /// The value of each condition the decision used.
    pub inputs: Value,
    /// `ok`, `refused` or `failed`.
    pub outcome: &'a str,
    /// Why (the refusal or failure; empty for ok).
    pub reason: &'a str,
    /// How long the action took, milliseconds.
    pub latency_ms: u64,
}

fn log_path(dir: &Path) -> PathBuf {
    dir.join(defaults::text("actions.file"))
}

fn followups_path(dir: &Path, feature: &str) -> PathBuf {
    let safe: String = feature.chars().filter(|c| c.is_ascii_alphanumeric() || *c == '_').collect();
    dir.join(defaults::text("actions.followups_file").replace("{feature}", &safe))
}

fn append(dir: &Path, rec: &Value) {
    let path = log_path(dir);
    let big = std::fs::metadata(&path).map(|m| m.len() > defaults::num("actions.rotate_bytes")).unwrap_or(false);
    if big {
        let name = defaults::text("actions.file");
        let (stem, ext) = name.rsplit_once('.').unwrap_or((name, ""));
        let aside = dir.join(format!("{stem}.{}.{ext}", crate::health::now_ms()));
        crate::discard::logged("actlog_rotate", std::fs::rename(&path, aside));
    }
    crate::dsact::exec::append_line(&path, rec);
}

/// A value made safe for a telemetry field: only the characters of `actions.token_chars` besides letters and digits, at most
/// `actions.token_max` of them.
pub fn token(s: &str) -> String {
    let extra = defaults::text("actions.token_chars");
    s.chars().filter(|c| c.is_ascii_alphanumeric() || extra.contains(*c)).take(defaults::num("actions.token_max") as usize).collect()
}

/// Record an action.
pub fn record(dir: &Path, a: &Action, now: u64) {
    append(
        dir,
        &json!({"t": "action", "ts": now, "feature": a.feature, "action": a.action, "target": a.target, "inputs": a.inputs, "outcome": a.outcome, "reason": a.reason, "latency_ms": a.latency_ms}),
    );
}

/// Record a mistake signal for an action.
pub fn mistake(dir: &Path, feature: &str, action: &str, target: &str, kind: &str, detail: &str, now: u64) {
    // the shared telemetry schema (kind `mistake`); the matching `act` event is emitted where the action runs (dsact for pokes)
    let tok = token;
    crate::telemetry::emit::mistake(&crate::telemetry::emit::ActRec {
        feature: &tok(feature), action: &tok(action), outcome: crate::telemetry::event::Outcome::Advise, latency_ms: 0, target: &tok(target), inputs: "", reason: &tok(kind), action_id: "",
    });
    append(dir, &json!({"t": "mistake", "ts": now, "feature": feature, "action": action, "target": target, "kind": kind, "detail": detail}));
}

fn followup_load(dir: &Path, feature: &str) -> Vec<Value> {
    std::fs::read_to_string(followups_path(dir, feature)).ok().and_then(|t| serde_json::from_str::<Vec<Value>>(&t).ok()).unwrap_or_default()
}

fn followup_save(dir: &Path, feature: &str, all: &[Value]) {
    crate::dsact::exec::write_atomic(&followups_path(dir, feature), &Value::Array(all.to_vec()).to_string());
}

/// Schedule a check of `action` on `target` for `due_ms`; `ctx` is whatever the check needs later. One pending follow-up per
/// (action, target): a second is ignored.
pub fn followup_add(dir: &Path, feature: &str, action: &str, target: &str, due_ms: u64, ctx: Value, now: u64) {
    let mut all = followup_load(dir, feature);
    if all.iter().any(|f| f["action"] == action && f["target"] == target) {
        return;
    }
    all.push(json!({"action": action, "target": target, "due_ms": due_ms, "added_ms": now, "ctx": ctx}));
    let cap = defaults::num("actions.followup_cap") as usize;
    while all.len() > cap {
        let old = all.remove(0);
        append(dir, &json!({"t": "followup", "ts": now, "feature": feature, "action": old["action"], "target": old["target"], "result": "expired"}));
    }
    followup_save(dir, feature, &all);
}

/// The follow-ups of `feature` whose time has come.
pub fn followups_due(dir: &Path, feature: &str, now: u64) -> Vec<Value> {
    followup_load(dir, feature).into_iter().filter(|f| f["due_ms"].as_u64().unwrap_or(0) <= now).collect()
}

/// Finish a follow-up: `result` is `clean`, `mistake`, `unknown` or `expired`; it is logged and the follow-up removed. With
/// `retry_ms` the follow-up is moved to a later time instead (nothing is logged).
pub fn followup_done(dir: &Path, feature: &str, action: &str, target: &str, result: &str, retry_ms: Option<u64>, now: u64) {
    let mut all = followup_load(dir, feature);
    match retry_ms {
        Some(t) => {
            for f in all.iter_mut().filter(|f| f["action"] == action && f["target"] == target) {
                f["due_ms"] = json!(t);
            }
        }
        None => {
            all.retain(|f| !(f["action"] == action && f["target"] == target));
            append(dir, &json!({"t": "followup", "ts": now, "feature": feature, "action": action, "target": target, "result": result}));
        }
    }
    followup_save(dir, feature, &all);
}

fn tail(path: &Path, max: u64) -> String {
    let Ok(mut f) = std::fs::File::open(path) else { return String::new() };
    let len = f.metadata().map(|m| m.len()).unwrap_or(0);
    let start = len.saturating_sub(max);
    if f.seek(SeekFrom::Start(start)).is_err() {
        return String::new();
    }
    let mut buf = Vec::new();
    crate::discard::logged("actlog_read", f.take(max).read_to_end(&mut buf));
    let text = String::from_utf8_lossy(&buf).into_owned();
    if start > 0 { text.split_once('\n').map(|(_, rest)| rest.to_string()).unwrap_or_default() } else { text }
}

fn rate(n: u64, d: u64) -> Value {
    if d == 0 {
        return Value::Null;
    }
    let p = 10f64.powi(defaults::num("actions.report_digits") as i32);
    json!(((n as f64 / d as f64) * p).round() / p)
}

/// The report: per feature, the action counts by outcome, the success rate, the mistakes by kind and the mistake rate, from the
/// log lines newer than `window_ms` (0 = all). `only` restricts it to one feature. Pure over the log file.
///
/// * `success_rate` = ok / (ok + failed): of the actions that ran, how many worked. A refusal (a precondition no longer held at
///   the live re-check) is the safety net working and is counted on its own.
/// * `mistake_rate` = distinct (action, target) with a mistake signal / ok actions.
pub fn report(dir: &Path, only: Option<&str>, now: u64, window_ms: u64) -> Value {
    let text = tail(&log_path(dir), defaults::num("actions.read_bytes"));
    let since = if window_ms == 0 { 0 } else { now.saturating_sub(window_ms) };
    struct F {
        by_action: Map<String, Value>,
        ok: u64,
        refused: u64,
        failed: u64,
        mistakes: std::collections::BTreeSet<(String, String)>,
        by_kind: Map<String, Value>,
        verified: u64,
        mistaken_followups: u64,
        latency_sum: u64,
        latency_n: u64,
        latency_max: u64,
    }
    let mut feats: std::collections::BTreeMap<String, F> = std::collections::BTreeMap::new();
    for name in defaults::raw("actions.features").as_table().map(|t| t.iter().map(|(k, _)| k.to_string()).collect::<Vec<_>>()).unwrap_or_default() {
        feats.insert(name, F { by_action: Map::new(), ok: 0, refused: 0, failed: 0, mistakes: Default::default(), by_kind: Map::new(), verified: 0, mistaken_followups: 0, latency_sum: 0, latency_n: 0, latency_max: 0 });
    }
    for line in text.lines() {
        let Ok(r) = serde_json::from_str::<Value>(line) else { continue };
        if r["ts"].as_u64().unwrap_or(0) < since {
            continue;
        }
        let feature = r["feature"].as_str().unwrap_or("").to_string();
        if feature.is_empty() || only.is_some_and(|o| o != feature) {
            continue;
        }
        let f = feats.entry(feature).or_insert_with(|| F {
            by_action: Map::new(),
            ok: 0,
            refused: 0,
            failed: 0,
            mistakes: Default::default(),
            by_kind: Map::new(),
            verified: 0,
            mistaken_followups: 0,
            latency_sum: 0,
            latency_n: 0,
            latency_max: 0,
        });
        let action = r["action"].as_str().unwrap_or("").to_string();
        match r["t"].as_str() {
            Some("action") => {
                let outcome = r["outcome"].as_str().unwrap_or("");
                match outcome {
                    "ok" => f.ok += 1,
                    "refused" => f.refused += 1,
                    _ => f.failed += 1,
                }
                let e = f.by_action.entry(action).or_insert_with(|| json!({"ok": 0, "refused": 0, "failed": 0}));
                let key = if outcome == "ok" || outcome == "refused" { outcome } else { "failed" };
                e[key] = json!(e[key].as_u64().unwrap_or(0) + 1);
                if let Some(l) = r["latency_ms"].as_u64() {
                    f.latency_sum += l;
                    f.latency_n += 1;
                    f.latency_max = f.latency_max.max(l);
                }
            }
            Some("mistake") => {
                f.mistakes.insert((action, r["target"].as_str().unwrap_or("").to_string()));
                let k = r["kind"].as_str().unwrap_or("unknown").to_string();
                let n = f.by_kind.get(&k).and_then(Value::as_u64).unwrap_or(0) + 1;
                f.by_kind.insert(k, json!(n));
            }
            Some("followup") => match r["result"].as_str() {
                Some("clean") => f.verified += 1,
                Some("mistake") => {
                    f.verified += 1;
                    f.mistaken_followups += 1;
                }
                _ => {}
            },
            _ => {}
        }
    }
    let mut out = Map::new();
    for (name, f) in feats {
        let pending = followup_load(dir, &name).len();
        out.insert(
            name,
            json!({
                "actions": f.ok + f.refused + f.failed, "ok": f.ok, "refused": f.refused, "failed": f.failed,
                "success_rate": rate(f.ok, f.ok + f.failed),
                "by_action": f.by_action,
                "mistakes": f.mistakes.len(), "mistakes_by_kind": f.by_kind, "mistake_rate": rate(f.mistakes.len() as u64, f.ok),
                "followups_verified": f.verified, "followups_pending": pending,
                "latency_ms": {"avg": if f.latency_n > 0 { json!(f.latency_sum / f.latency_n) } else { Value::Null }, "max": f.latency_max},
            }),
        );
    }
    json!({"window_ms": window_ms, "features": out})
}

/// `ah-engine telemetry actions [feature] [--window <ms>] [--mistake <feature> <action> <target> <kind> [detail]]`. The
/// `--mistake` form lets the owner (or a tool) record a mistake signal the engine cannot see itself, such as an escalation the
/// owner dismissed.
pub fn run_cli(rest: &[String]) -> (Value, i32) {
    let dir = crate::paths::dir();
    let now = crate::health::now_ms();
    if let Some(i) = rest.iter().position(|a| a == "--mistake") {
        let a: Vec<&str> = rest[i + 1..].iter().map(String::as_str).collect();
        if a.len() < 4 {
            return (json!({"error": defaults::text("actions.msg_mistake_usage")}), 64);
        }
        mistake(&dir, a[0], a[1], a[2], a[3], a.get(4).copied().unwrap_or(""), now);
        return (json!({"recorded": {"feature": a[0], "action": a[1], "target": a[2], "kind": a[3]}}), 0);
    }
    let feature = rest.iter().skip(1).find(|a| !a.starts_with("--")).map(String::as_str);
    let window = rest.iter().position(|a| a == "--window").and_then(|i| rest.get(i + 1)).and_then(|v| v.parse::<u64>().ok()).unwrap_or_else(|| defaults::num("actions.window_ms"));
    (report(&dir, feature, now, window), 0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("ah-actlog-{name}-{}", std::process::id()));
        crate::discard::harmless(std::fs::remove_dir_all(&d)); // keep: a leftover scratch dir of a crashed run
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    fn act<'a>(feature: &'a str, action: &'a str, target: &'a str, outcome: &'a str) -> Action<'a> {
        Action { feature, action, target, inputs: json!({"stale": true}), outcome, reason: "", latency_ms: 40 }
    }

    #[test]
    fn the_report_counts_outcomes_rates_and_mistakes_per_feature() {
        let d = scratch("report");
        for t in ["a", "b", "c", "d"] {
            record(&d, &act("stall", "poke", t, "ok"), 1000);
        }
        record(&d, &act("stall", "poke", "e", "refused"), 1000);
        record(&d, &act("stall", "escalate", "f", "failed"), 1000);
        mistake(&d, "stall", "poke", "a", "nudge_no_change", "no new activity", 2000);
        mistake(&d, "stall", "poke", "a", "nudge_no_change", "again", 2100); // the same action twice is one mistake
        mistake(&d, "stall", "poke", "b", "escalation_dismissed", "owner", 2200);
        record(&d, &act("merge_ready", "merge", "o/r#1@abc", "ok"), 1000);
        let r = report(&d, None, 3000, 0);
        let s = &r["features"]["stall"];
        assert_eq!((s["actions"].clone(), s["ok"].clone(), s["refused"].clone(), s["failed"].clone()), (json!(6), json!(4), json!(1), json!(1)));
        assert_eq!(s["success_rate"], json!(0.8)); // 4 ok of the 5 that ran
        assert_eq!(s["mistakes"], json!(2));
        assert_eq!(s["mistake_rate"], json!(0.5)); // 2 of 4 ok actions
        assert_eq!(s["mistakes_by_kind"]["nudge_no_change"], json!(2));
        assert_eq!(s["by_action"]["poke"]["ok"], json!(4));
        assert_eq!(r["features"]["merge_ready"]["ok"], json!(1));
        let only = report(&d, Some("merge_ready"), 3000, 0);
        assert!(only["features"].get("stall").is_none() || only["features"]["stall"]["actions"] == json!(0));
        let windowed = report(&d, Some("stall"), 5000, 2500); // only the lines from ts 2500 on
        assert_eq!(windowed["features"]["stall"]["actions"], json!(0));
    }

    #[test]
    fn a_follow_up_is_due_once_its_time_comes_and_is_logged_when_done() {
        let d = scratch("followup");
        followup_add(&d, "stall", "poke", "ws1", 5000, json!({"last": 10}), 1000);
        followup_add(&d, "stall", "poke", "ws1", 9000, json!({}), 1000); // the same (action, target) is not scheduled twice
        assert!(followups_due(&d, "stall", 4999).is_empty());
        let due = followups_due(&d, "stall", 5000);
        assert_eq!(due.len(), 1);
        assert_eq!(due[0]["ctx"]["last"], json!(10));
        followup_done(&d, "stall", "poke", "ws1", "clean", Some(8000), 5000); // moved, nothing logged
        assert!(followups_due(&d, "stall", 7999).is_empty());
        followup_done(&d, "stall", "poke", "ws1", "mistake", None, 8000);
        assert!(followups_due(&d, "stall", 99999).is_empty());
        let r = report(&d, Some("stall"), 9000, 0);
        assert_eq!((r["features"]["stall"]["followups_verified"].clone(), r["features"]["stall"]["followups_pending"].clone()), (json!(1), json!(0)));
    }

    #[test]
    fn a_log_over_its_size_is_renamed_aside_never_deleted() {
        let d = scratch("rotate");
        std::fs::write(log_path(&d), "x".repeat(defaults::num("actions.rotate_bytes") as usize + 1)).unwrap();
        record(&d, &act("stall", "poke", "a", "ok"), 1);
        let names: Vec<String> = std::fs::read_dir(&d).unwrap().flatten().map(|e| e.file_name().to_string_lossy().into_owned()).collect();
        assert!(names.iter().any(|n| n.starts_with("actions.") && n != "actions.ndjson"), "{names:?}");
        assert_eq!(std::fs::read_to_string(log_path(&d)).unwrap().lines().count(), 1);
    }

    #[test]
    fn a_torn_line_does_not_hide_the_ones_before_it() {
        let d = scratch("torn");
        record(&d, &act("stall", "poke", "a", "ok"), 10);
        std::fs::OpenOptions::new().append(true).open(log_path(&d)).unwrap();
        crate::dsact::exec::append_line(&log_path(&d), &json!("not an object"));
        let r = report(&d, Some("stall"), 20, 0);
        assert_eq!(r["features"]["stall"]["ok"], json!(1));
    }
}
