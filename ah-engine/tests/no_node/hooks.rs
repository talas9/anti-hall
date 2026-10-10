//! Every hook event of both hosts, driven through the thin trigger (`hooks/ah-hook.sh <Event> [--host codex]`) exactly as
//! the host runs it, from the payload fixture. The events and matchers come from the generated fallback lists (equal to the
//! dispatch table, tests/it/hooks_files.rs), so a new row or event without a payload fails the coverage test.

use crate::expected;
use crate::harness::{self, Seen, World, cfg_int, note};

use std::collections::BTreeMap;
use std::time::Duration;

/// The wrapper's note when it ran the Node fallback instead of the engine's answer (ah-hook.sh `fallback_note`).
const FALLBACK_NOTE: &str = "anti-hall: engine fallback for ";
/// The wrapper's note when it failed closed (ah-hook.sh `fail_closed`).
const FAIL_CLOSED_NOTE: &str = "anti-hall: fail closed for ";

pub struct Case {
    pub id: String,
    pub host: String,
    pub event: String,
    pub payload: serde_json::Value,
    pub blocks: Option<bool>,
    /// Extra environment of the host process (a DevSwarm workspace sets its own variables).
    pub env: Vec<(String, String)>,
}

pub fn cases() -> Vec<Case> {
    let text = std::fs::read_to_string(harness::here().join("payloads.ndjson")).unwrap();
    let mut ids = std::collections::BTreeSet::new();
    text.lines()
        .filter(|l| !l.trim().is_empty())
        .map(|l| {
            let v: serde_json::Value = serde_json::from_str(l).unwrap_or_else(|e| panic!("payloads.ndjson: {e}: {l}"));
            let c = Case {
                id: v["id"].as_str().unwrap().to_string(),
                host: v["host"].as_str().unwrap().to_string(),
                event: v["event"].as_str().unwrap().to_string(),
                payload: v["payload"].clone(),
                blocks: v["expect"]["blocks"].as_bool(),
                env: v["env"].as_object().map(|m| m.iter().map(|(k, x)| (k.clone(), x.as_str().unwrap().to_string())).collect()).unwrap_or_default(),
            };
            assert!(ids.insert(c.id.clone()), "payloads.ndjson: duplicate id {}", c.id);
            c
        })
        .collect()
}

/// host -> event -> matchers, from the generated fallback list of the host.
pub fn table() -> BTreeMap<String, BTreeMap<String, Vec<String>>> {
    let mut out = BTreeMap::new();
    for (host, file) in [("claude", "ah-fallback.list"), ("codex", "ah-fallback.codex.list")] {
        let text = std::fs::read_to_string(harness::plugin_src().join("hooks").join(file)).unwrap();
        let mut events: BTreeMap<String, Vec<String>> = BTreeMap::new();
        let mut cur = String::new();
        for line in text.lines() {
            if line.is_empty() || line.starts_with('#') {
                continue;
            }
            if let Some(h) = line.strip_prefix('@') {
                cur = h.split('\t').next().unwrap().to_string();
                events.entry(cur.clone()).or_default();
                continue;
            }
            let matcher = line.split('\t').next().unwrap().to_string();
            let m = events.entry(cur.clone()).or_default();
            if !m.contains(&matcher) {
                m.push(matcher);
            }
        }
        out.insert(host.to_string(), events);
    }
    out
}

fn matcher_covered(matcher: &str, tools: &[&str]) -> Vec<String> {
    if matcher.is_empty() || matcher == "*" {
        return Vec::new();
    }
    // a plain alternation names tools: each must have a payload; anything else is a regular expression: one tool must match
    if matcher.chars().all(|c| c.is_ascii_alphanumeric() || "_ |,-".contains(c)) {
        return matcher.split(['|', ',']).map(str::trim).filter(|n| !tools.contains(n)).map(|n| format!("tool `{n}`")).collect();
    }
    let re = regex::Regex::new(matcher).unwrap();
    if tools.iter().any(|t| re.is_match(t)) { Vec::new() } else { vec![format!("matcher `{matcher}`")] }
}

/// Every event and every matcher alternative of both tables has at least one payload; every payload names a known event.
#[test]
fn payloads_cover_every_event_and_matcher() {
    let cases = cases();
    let mut missing = Vec::new();
    for (host, events) in table() {
        for (event, matchers) in &events {
            let tools: Vec<&str> =
                cases.iter().filter(|c| c.host == host && &c.event == event).map(|c| c.payload["tool_name"].as_str().unwrap_or("")).collect();
            if tools.is_empty() {
                missing.push(format!("{host} {event}: no payload"));
                continue;
            }
            for m in matchers {
                for gap in matcher_covered(m, &tools) {
                    missing.push(format!("{host} {event}: no payload for {gap}"));
                }
            }
        }
    }
    let t = table();
    for c in &cases {
        assert!(t.get(&c.host).is_some_and(|e| e.contains_key(&c.event)), "payload {} names an event its host's table does not have", c.id);
    }
    assert!(missing.is_empty(), "the payload fixture misses:\n{}", missing.join("\n"));
}

fn blocks(o: &harness::Outcome) -> bool {
    if o.code == Some(2) {
        return true;
    }
    let Ok(v) = serde_json::from_str::<serde_json::Value>(o.stdout.trim()) else { return false };
    v["decision"] == "block" || v["hookSpecificOutput"]["permissionDecision"] == "deny"
}

fn drive(host: &str) {
    let list = expected::load();
    let mut w = World::new(&format!("hooks-{host}"));
    w.start_daemon();
    let timeout = Duration::from_secs(cfg_int(&w.cfg, "timeouts", "hook_s"));
    let mut seen = Seen::new();
    let mut problems = Vec::new();
    let mut mismatched = Vec::new();
    let mut checked = Vec::new();
    let mut rows = Vec::new();
    let mut fallback_cases: Vec<String> = Vec::new();
    for c in cases().into_iter().filter(|c| c.host == host) {
        let mut payload = serde_json::json!({
            "session_id": format!("no-node-{host}"),
            "transcript_path": w.transcript,
            "cwd": w.project,
            "hook_event_name": c.event,
        });
        for (k, v) in c.payload.as_object().unwrap() {
            payload[k] = v.clone();
        }
        let payload = w.subst(&payload.to_string());
        let mut cmd = w.command("/bin/sh", &c.id);
        cmd.arg(w.plugin.join("hooks").join("ah-hook.sh")).arg(&c.event);
        if host == "codex" {
            cmd.args(["--host", "codex"]).env("PLUGIN_ROOT", &w.plugin);
        }
        cmd.envs(c.env.iter().map(|(k, v)| (k, v)));
        let o = w.run(cmd, Some(&payload), timeout);
        let surface = format!("hook/{host}/{}", c.event);
        let fallback = o.stderr.lines().find(|l| l.starts_with(FALLBACK_NOTE) || l.starts_with(FAIL_CLOSED_NOTE)).map(str::to_string);
        if fallback.is_some() {
            // the engine did not answer the event itself (a timeout or a crash on a loaded machine; a deliberate deferral
            // is answered by the engine and handed to its Node twin from inside): timing-dependent, so the case is counted
            // against `hooks.max_fallback_cases`, not compared with the list (the Node scripts it started vary run to run)
            fallback_cases.push(c.id.clone());
        }
        if o.timed_out {
            problems.push(format!("case `{}` did not finish within {timeout:?}", c.id));
        }
        if let Some(want) = c.blocks {
            checked.push(c.id.clone());
            let got = blocks(&o);
            if got != want {
                mismatched.push((c.id.clone(), format!("expected blocks={want}, got blocks={got} (exit {:?}, stdout {:?})", o.code, o.stdout.trim())));
            }
        }
        rows.push((
            surface,
            c.id.clone(),
            serde_json::json!({
                "case": c.id, "exit": o.code, "ms": o.elapsed_ms, "timed_out": o.timed_out, "fallback": fallback,
                "stdout": o.stdout.chars().take(400).collect::<String>(),
                "stderr": o.stderr.chars().take(400).collect::<String>(),
            }),
        ));
    }
    w.settle();
    let rows: Vec<serde_json::Value> = rows
        .into_iter()
        .map(|(surface, id, mut row)| {
            let node: Vec<String> = w.hits_of(&id).iter().map(|h| w.script_key(&h.argv)).collect();
            if !fallback_cases.contains(&id) {
                for k in &node {
                    note(&mut seen, &surface, k, &id);
                }
            }
            row["node"] = serde_json::json!(node);
            row
        })
        .collect();
    let daemon: Vec<String> = w.hits_of(harness::DAEMON_TAG).iter().map(|h| w.script_key(&h.argv)).collect();
    let max_fallback = usize::try_from(cfg_int(&w.cfg, "hooks", "max_fallback_cases")).unwrap();
    if fallback_cases.len() > max_fallback {
        problems.push(format!(
            "{} case(s) ran the wrapper's Node fallback (limit {max_fallback}, harness.toml hooks.max_fallback_cases): the engine did not answer {fallback_cases:?}; rerun on a quieter machine",
            fallback_cases.len()
        ));
    }
    let prefix = format!("hook/{host}/");
    problems.extend(expected::compare(&list, &prefix, &seen));
    problems.extend(expected::compare_decisions(&list, &format!("{host}/"), &mismatched, &checked));
    let report = serde_json::json!({
        "host": host,
        "cases": rows.len(),
        "cases_with_node": rows.iter().filter(|r| r["node"].as_array().is_some_and(|a| !a.is_empty())).count(),
        "fallback_cases": fallback_cases,
        "cases_with_fallback": rows.iter().filter(|r| !r["fallback"].is_null()).count(),
        "node_paths": expected::seen_json(&seen),
        "daemon_node_starts": daemon,
        "decision_mismatches": mismatched,
        "rows": rows,
    });
    expected::finish(&format!("hooks-{host}"), report, &problems);
}

/// Claude Code: every event of the Claude table through `ah-hook.sh <Event>` with no Node installed.
#[test]
fn claude_hooks_run_without_node() {
    drive("claude");
}

/// Codex: every event of the Codex table through `ah-hook.sh <Event> --host codex` with no Node installed.
#[test]
fn codex_hooks_run_without_node() {
    drive("codex");
}
