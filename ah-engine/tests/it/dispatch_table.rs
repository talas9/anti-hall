//! D58, D87: the dispatch table in `defaults/dispatch.toml` is the hand-maintained table of record. These tests check the
//! table itself: every entry has a Node command to fall back to and names a real check (D74), entry ids are unique within an
//! event, and the model-routing entries stay scoped. That the plugin's committed `hooks.json` files, registries and fallback
//! lists equal what the table generates is `tests/hooks_files.rs`.
#![allow(clippy::unwrap_used, clippy::expect_used)] // a test crate: a panic is the failure report, and E2 exempts tests

use ah_engine::dispatch::table;

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
