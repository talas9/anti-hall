//! D87: the files the plugin ships are generated from the dispatch table (`defaults/dispatch.toml`), and a committed file
//! that differs from the generator's output by one byte fails here. Per host: the thin `hooks.json` (one entry per event, no
//! matcher), the per-hook registry the Node readers use and the thin client's fallback list. (The fallback map, event -> entry id
//! -> Node command, is the hand-kept source of the Node commands, not generated.) Regenerate with
//! `cargo run --bin ah-gen-fallback-list -- --repo ..` (or print one with `ah-engine gen-hooks --host <h> --kind <k>`).
#![allow(clippy::unwrap_used, clippy::expect_used)] // a test crate: a panic is the failure report, and E2 exempts tests

use ah_engine::dispatch::table;
use ah_engine::{defaults, hooksgen};
use serde_json::Value;
use std::path::PathBuf;

fn repo() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..")
}

fn files(host: &str) -> Vec<(&'static str, &'static str)> {
    defaults::raw("dispatch.generated_files").get(host).and_then(|h| h.as_table()).unwrap().iter().map(|(k, v)| (*k, v.as_str().unwrap())).collect()
}

#[test]
fn every_committed_generated_file_equals_the_generators_output_byte_for_byte() {
    for host in table::hosts() {
        let kinds = files(host);
        assert_eq!(kinds.len(), 3, "{host}: hooks, registry and list are generated (the map is hand-kept)");
        for (kind, rel) in kinds {
            let want = hooksgen::render(host, kind).unwrap();
            let got = std::fs::read_to_string(repo().join(rel)).unwrap_or_else(|e| panic!("{rel}: {e}"));
            if want != got {
                let line =
                    want.lines().zip(got.lines()).position(|(w, g)| w != g).map(|n| n + 1).unwrap_or_else(|| want.lines().count().min(got.lines().count()) + 1);
                panic!(
                    "{host} {kind}: {rel} differs from `ah-engine gen-hooks --host {host} --kind {kind}` at line {line}; run ah-gen-fallback-list --repo .."
                );
            }
        }
    }
}

fn thin_events(rel: &str) -> Vec<(String, Value)> {
    let v: Value = serde_json::from_str(&std::fs::read_to_string(repo().join(rel)).unwrap()).unwrap();
    v["hooks"].as_object().unwrap().iter().map(|(k, v)| (k.clone(), v.clone())).collect()
}

#[test]
fn the_shipped_hooks_json_is_one_matcherless_wrapper_call_per_event() {
    for host in table::hosts() {
        let rel = files(host).into_iter().find(|(k, _)| *k == "hooks").unwrap().1;
        let evs = thin_events(rel);
        let mut want: Vec<&str> = hooksgen::events(host);
        want.sort();
        // the JSON object is read key-sorted, so compare as sets
        assert_eq!(evs.iter().map(|(k, _)| k.as_str()).collect::<Vec<_>>(), want, "{host}: the events of {rel}");
        for (ev, groups) in &evs {
            let groups = groups.as_array().unwrap();
            assert_eq!(groups.len(), 1, "{host} {ev}");
            assert!(groups[0].get("matcher").is_none(), "{host} {ev}: the engine matches, the host does not");
            let hs = groups[0]["hooks"].as_array().unwrap();
            assert_eq!(hs.len(), 1, "{host} {ev}");
            let cmd = hs[0]["command"].as_str().unwrap();
            assert_eq!(cmd, hooksgen::thin_command(host, ev), "{host} {ev}: the command is hooks_form.template filled in");
            assert!(!cmd.contains("ah-hook.sh") && cmd.contains("exec sh ") && cmd.contains("/hooks/install.sh\" "), "{host} {ev}: direct form, install.sh fallback: {cmd}");
        }
        // D87 exception: no thin trigger for events whose hook replaces the operation
        assert!(!evs.iter().any(|(k, _)| k.starts_with("Worktree")), "{host}: Worktree* events get no trigger");
    }
}

#[test]
fn the_codex_thin_file_passes_the_host_to_the_wrapper_and_claudes_does_not() {
    let claude = std::fs::read_to_string(repo().join(files("claude").into_iter().find(|(k, _)| *k == "hooks").unwrap().1)).unwrap();
    let codex = std::fs::read_to_string(repo().join(files("codex").into_iter().find(|(k, _)| *k == "hooks").unwrap().1)).unwrap();
    assert!(!claude.contains("--host") && claude.contains("${CLAUDE_PLUGIN_ROOT}"));
    assert!(codex.contains("--host codex") && codex.contains("${PLUGIN_ROOT}") && !codex.contains("CLAUDE_PLUGIN_ROOT"));
}

/// Prevention: the plugin ships exactly ONE shell file (hooks/install.sh); a second one is a regression of the thin-client design.
#[test]
fn the_plugin_ships_exactly_one_shell_file() {
    fn walk(dir: &std::path::Path, out: &mut Vec<PathBuf>) {
        for e in std::fs::read_dir(dir).unwrap().flatten() {
            let p = e.path();
            if p.is_dir() {
                walk(&p, out);
            } else if p.extension().is_some_and(|x| x == "sh") {
                out.push(p);
            }
        }
    }
    let root = repo().join("plugins/anti-hall");
    let mut found = Vec::new();
    walk(&root, &mut found);
    let rel: Vec<String> = found.iter().map(|p| p.strip_prefix(&root).unwrap().display().to_string()).collect();
    assert_eq!(rel, vec!["hooks/install.sh".to_string()], "the shell files of the plugin");
    // and no hook script without an extension either: every file of hooks/ is data or the installer
    let mut names: Vec<String> = std::fs::read_dir(root.join("hooks")).unwrap().flatten().map(|e| e.file_name().to_string_lossy().into_owned()).collect();
    names.sort();
    assert_eq!(names, vec!["hooks.json", "hooks.registry.json", "install.sh"], "hooks/ holds the two generated files and the installer");
}

/// Prevention: no table row carries Node text; the commands live in the Node backup plugin's map, and every row is answered by a
/// built-in check or has a command there.
#[test]
fn every_table_row_has_a_check_or_a_command_in_the_map_and_the_table_holds_no_node_text() {
    for host in table::hosts() {
        let map: Value = serde_json::from_str(&std::fs::read_to_string(repo().join("plugins/anti-hall-node/hooks").join(if host == "codex" { "ah-fallback.codex.map.json" } else { "ah-fallback.map.json" })).unwrap()).unwrap();
        for ev in table::events(host) {
            for e in table::entries(host, ev) {
                let in_map = map[ev][&e.id].as_str().is_some_and(|c| !c.is_empty());
                assert!(e.check.is_some() || in_map, "{host} {ev} {}: neither a built-in check nor a command in the map", e.id);
                if e.check.is_some() && !in_map {
                    assert!(e.command.is_empty(), "{host} {ev} {}: an engine-only entry has no command", e.id);
                }
            }
        }
    }
    let raw = std::fs::read_to_string(repo().join("plugins/anti-hall/engine/defaults/dispatch.toml")).unwrap();
    assert!(!raw.lines().any(|l| l.trim_start().starts_with("{ id = ") && l.contains("command =")), "dispatch.toml rows carry no command");
}
