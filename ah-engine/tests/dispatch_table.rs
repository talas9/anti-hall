//! D58: the dispatch table in `defaults/dispatch.toml` is exactly the plugin's `hooks.json` (Claude and Codex): the
//! same events, the same entries in the same order, with the same matcher, command and timeout. A change to either
//! `hooks.json` without regenerating the table (`node parity/gen-dispatch.js`) fails here. Also (D74): every entry
//! has a Node command to fall back to, and every built-in check it names is registered. The whole generated part of the
//! file, `check` fields included, is compared with what `parity/gen-dispatch.js` writes now (the harness is Node, so
//! this test needs `node`; a missing `node` fails it, it is not skipped).

use ah_engine::dispatch::table;
use serde_json::Value;
use std::path::PathBuf;

fn hooks_json(rel: &str) -> serde_json::Map<String, Value> {
    let p = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..").join(rel);
    let v: Value = serde_json::from_str(&std::fs::read_to_string(&p).unwrap_or_else(|e| panic!("{}: {e}", p.display()))).unwrap();
    v["hooks"].as_object().unwrap().clone()
}

fn check_host(host: &str, rel: &str) {
    let hooks = hooks_json(rel);
    let mut table_events: Vec<&str> = table::events(host);
    let mut file_events: Vec<&str> = hooks.keys().map(String::as_str).collect();
    table_events.sort();
    file_events.sort();
    assert_eq!(table_events, file_events, "{host}: the dispatch table's events differ from {rel}; run node parity/gen-dispatch.js");
    for (event, groups) in &hooks {
        let mut want = Vec::new();
        for g in groups.as_array().unwrap() {
            let matcher = g.get("matcher").and_then(Value::as_str).unwrap_or("");
            for h in g["hooks"].as_array().unwrap() {
                want.push((matcher.to_string(), h["command"].as_str().unwrap().to_string(), h.get("timeout").and_then(Value::as_u64).unwrap_or(0)));
            }
        }
        let got: Vec<(String, String, u64)> = table::entries(host, event).into_iter().map(|e| (e.matcher, e.command, e.timeout_s)).collect();
        assert_eq!(got, want, "{host} {event}: the dispatch table differs from {rel}; run node parity/gen-dispatch.js");
    }
}

#[test]
fn the_claude_table_is_exactly_hooks_json() {
    check_host("claude", "plugins/anti-hall/hooks/hooks.json");
}

#[test]
fn the_codex_table_is_exactly_hooks_json() {
    check_host("codex", "plugins/anti-hall/codex/hooks/hooks.json");
}

#[test]
fn every_entry_can_fall_back_to_node_and_names_a_real_check() {
    for host in table::hosts() {
        for event in table::events(host) {
            let es = table::entries(host, event);
            let mut ids: Vec<&str> = es.iter().map(|e| e.id.as_str()).collect();
            ids.sort();
            ids.dedup();
            assert_eq!(ids.len(), es.len(), "{host} {event}: entry ids must be unique (they key the fallback map)");
            for e in &es {
                assert!(!e.command.trim().is_empty(), "{host} {event} {}: no Node command to fall back to (D74)", e.id);
                if let Some(c) = &e.check {
                    assert!(ah_engine::checks::get(c).is_some(), "{host} {event} {}: unknown check {c}", e.id);
                }
            }
        }
    }
}

/// The table equals what the generator writes from the two `hooks.json` files right now, entry for entry, so the `check`
/// field (which hooks.json does not carry) cannot drift either.
#[test]
fn the_table_is_exactly_what_the_generator_writes() {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let live = root.join("defaults/dispatch.toml");
    let out = std::env::temp_dir().join(format!("ah-gen-dispatch-{}.toml", std::process::id()));
    std::fs::copy(&live, &out).unwrap();
    let run = std::process::Command::new("node")
        .arg(root.join("parity/gen-dispatch.js"))
        .arg("--out")
        .arg(&out)
        .output()
        .expect("node must be installed to run parity/gen-dispatch.js");
    assert!(run.status.success(), "gen-dispatch.js failed: {}", String::from_utf8_lossy(&run.stderr));
    let (want, got) = (std::fs::read_to_string(&out).unwrap(), std::fs::read_to_string(&live).unwrap());
    let _ = std::fs::remove_file(&out);
    if let Some((n, (w, g))) = want.lines().zip(got.lines()).enumerate().find(|(_, (w, g))| w != g) {
        panic!("defaults/dispatch.toml differs from the generator at line {}:\n  generated: {w}\n  file:      {g}\nrun node parity/gen-dispatch.js", n + 1);
    }
    assert_eq!(
        want.lines().count(),
        got.lines().count(),
        "defaults/dispatch.toml and the generator's output differ in length; run node parity/gen-dispatch.js"
    );
}

/// Every registered check answers at least one entry in some host's table: a check the generator does not list would
/// silently run as its Node hook only. (Codex registers no `scan-throttle` hook, so the test is per check, not per host.)
#[test]
fn every_registered_check_answers_an_entry_somewhere() {
    let named: Vec<String> =
        table::hosts().into_iter().flat_map(|h| table::events(h).into_iter().flat_map(move |ev| table::entries(h, ev))).filter_map(|e| e.check).collect();
    for c in ah_engine::checks::registry() {
        assert!(named.iter().any(|n| n == c.name()), "no table entry names the built-in check {}", c.name());
    }
}

#[test]
fn model_routing_dispatch_entries_stay_scoped_to_agent_and_task() {
    let mut registered_hosts = 0;
    for host in table::hosts() {
        let matchers: Vec<String> =
            table::entries(host, "PreToolUse").into_iter().filter(|e| e.check.as_deref() == Some("model-routing")).map(|e| e.matcher).collect();
        if !matchers.is_empty() {
            registered_hosts += 1;
            assert_eq!(matchers, vec!["Agent".to_string(), "Task".to_string()], "{host}: model-routing must remain registered only for Agent and Task");
        }
    }
    assert!(registered_hosts > 0, "at least one host must register model-routing dispatch entries");
}

#[test]
fn model_routing_dispatch_entries_still_match_only_agent_and_task() {
    for host in table::hosts() {
        let has_model_routing = table::entries(host, "PreToolUse").into_iter().any(|e| e.check.as_deref() == Some("model-routing"));
        for (tool, expected_when_registered) in [
            ("Agent", vec!["model-routing-guard"]),
            ("Task", vec!["model-routing-guard#2"]),
            ("Agent ", Vec::<&str>::new()),
            ("Workflow", Vec::<&str>::new()),
            ("codex:Task", Vec::<&str>::new()),
            ("spawn_agent", Vec::<&str>::new()),
        ] {
            let p = serde_json::json!({"hook_event_name":"PreToolUse","tool_name":tool,"tool_input":{"model":"opus","prompt":"fetch logs"}});
            let got: Vec<String> =
                table::select(host, "PreToolUse", &p, None).into_iter().filter(|e| e.check.as_deref() == Some("model-routing")).map(|e| e.id).collect();
            let expected = if has_model_routing { expected_when_registered } else { Vec::<&str>::new() };
            assert_eq!(got, expected, "{host} {tool:?}");
        }
    }
}
