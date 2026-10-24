//! The other commands a host or the OS runs: the shipped hooks.json of both hosts, the status line the installer writes,
//! the monitors (monitors.json), and the daemon's own scheduled work.

use crate::expected;
use crate::harness::{DAEMON_TAG, Seen, World, cfg_int, cfg_list, note};

use std::time::Duration;

fn js_in(command: &str, w: &World) -> Option<String> {
    let root = w.plugin.display().to_string();
    command
        .split(|c: char| c.is_whitespace() || c == '"' || c == '\'')
        .find(|t| [".js", ".mjs", ".cjs"].iter().any(|e| t.ends_with(e)))
        .map(|t| t.replace("${CLAUDE_PLUGIN_ROOT}", "").replace("${PLUGIN_ROOT}", "").replace(&root, "").trim_start_matches('/').to_string())
}

/// The commands the hosts run for hooks (hooks.json of both ports) start no Node: the thin trigger only.
#[test]
fn hooks_json_starts_no_node() {
    let list = expected::load();
    let w = World::new("hooks-json");
    let node = regex::Regex::new(r"(^|[\s/;&|])node(\s|$)").unwrap();
    let mut seen = Seen::new();
    let mut commands = 0;
    for (host, rel) in [("claude", "hooks/hooks.json"), ("codex", "codex/hooks/hooks.json")] {
        let v: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(w.plugin.join(rel)).unwrap()).unwrap();
        let mut stack = vec![&v];
        while let Some(x) = stack.pop() {
            match x {
                serde_json::Value::Object(m) => {
                    if let Some(c) = m.get("command").and_then(|c| c.as_str()) {
                        commands += 1;
                        if node.is_match(c) || js_in(c, &w).is_some() {
                            note(&mut seen, &format!("hooks-json/{host}"), &js_in(c, &w).unwrap_or_else(|| c.to_string()), rel);
                        }
                    }
                    stack.extend(m.values());
                }
                serde_json::Value::Array(a) => stack.extend(a.iter()),
                _ => {}
            }
        }
    }
    assert!(commands > 0, "no hook commands found in either hooks.json");
    let problems = expected::compare(&list, "hooks-json/", &seen);
    expected::finish("hooks-json", serde_json::json!({"commands": commands, "node_paths": expected::seen_json(&seen)}), &problems);
}

/// The status line installer is retired: it succeeds without Node and leaves no `statusLine.command` behind.
#[test]
fn statusline_installer_is_retired_without_node() {
    let list = expected::load();
    let mut w = World::new("statusline");
    w.start_daemon();
    let timeout = Duration::from_secs(cfg_int(&w.cfg, "timeouts", "callsite_s"));
    let mut seen = Seen::new();
    let mut problems = Vec::new();

    // `ah-hook install-statusline ...` replaces itself with the engine (ah-launcher/tests/cli.rs): the engine, as the thin client runs it
    let mut cmd = w.command(&w.engine, "statusline/install");
    cmd.args(cfg_list(&w.cfg, "statusline", "install_args")).env("AH_ENGINE_PLUGIN_ROOT", &w.plugin);
    let inst = w.run(cmd, None, timeout);
    if inst.code != Some(0) {
        problems.push(format!("the status line installer exited {:?}: {}", inst.code, inst.stderr.trim()));
    }
    let settings: serde_json::Value =
        std::fs::read_to_string(w.home.join(".claude").join("settings.json")).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default();
    let command = settings["statusLine"]["command"].as_str().map(str::to_string);
    match &command {
        None => {}
        Some(c) => {
            if let Some(js) = js_in(c, &w) {
                // the command still names a Node script the launcher falls back to
                note(&mut seen, "statusline/command", &js, "settings.json");
            }
            problems.push(format!("the retired installer still wrote statusLine.command: {c}"));
        }
    }
    w.settle();
    for step in ["statusline/install"] {
        for h in w.hits_of(step) {
            note(&mut seen, step, &w.script_key(&h.argv), step);
        }
    }
    problems.extend(expected::compare(&list, "statusline/", &seen));
    let report = serde_json::json!({"command": command, "install_exit": inst.code, "node_paths": expected::seen_json(&seen)});
    expected::finish("statusline", report, &problems);
}

/// The monitors the plugin declares (monitors.json) start no Node: each runs for a moment and is stopped.
#[test]
fn monitors_run_without_node() {
    let list = expected::load();
    let mut w = World::new("monitors");
    w.start_daemon();
    let run_for = Duration::from_secs(cfg_int(&w.cfg, "timeouts", "monitor_s"));
    let v: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(w.plugin.join("monitors").join("monitors.json")).unwrap()).unwrap();
    let mut seen = Seen::new();
    let mut rows = Vec::new();
    for m in v.as_array().unwrap() {
        let name = m["name"].as_str().unwrap();
        let command = m["command"].as_str().unwrap();
        let surface = format!("monitor/{name}");
        if let Some(js) = js_in(command, &w) {
            // the command names a Node script the launcher falls back to
            note(&mut seen, &surface, &format!("fallback:{js}"), name);
        }
        let mut cmd = w.command("/bin/sh", &surface);
        cmd.arg("-c").arg(command);
        let o = w.run(cmd, None, run_for);
        rows.push(serde_json::json!({"name": name, "exit": o.code, "stopped": o.timed_out, "stderr": o.stderr.chars().take(300).collect::<String>()}));
    }
    w.settle();
    for m in v.as_array().unwrap() {
        let surface = format!("monitor/{}", m["name"].as_str().unwrap());
        for h in w.hits_of(&surface) {
            note(&mut seen, &surface, &w.script_key(&h.argv), &surface);
        }
    }
    let problems = expected::compare(&list, "monitor/", &seen);
    expected::finish("monitors", serde_json::json!({"monitors": rows, "node_paths": expected::seen_json(&seen)}), &problems);
}

/// The daemon's own work (its scheduler, as `schedule list` shows it) starts no Node. A scheduled duty runs on its own clock,
/// so entries of this surface are `optional` when they are timing-dependent.
#[test]
fn the_daemon_starts_no_node() {
    let list = expected::load();
    let mut w = World::new("daemon");
    w.start_daemon();
    let timeout = Duration::from_secs(cfg_int(&w.cfg, "timeouts", "callsite_s"));
    let mut cmd = w.command(&w.engine, "daemon/schedule-list");
    cmd.args(["schedule", "list"]);
    let o = w.run(cmd, None, timeout);
    // give the scheduler a few of its ticks
    std::thread::sleep(Duration::from_secs(cfg_int(&w.cfg, "timeouts", "monitor_s")));
    w.settle();
    let mut seen = Seen::new();
    for tag in ["daemon/schedule-list", DAEMON_TAG] {
        for h in w.hits_of(tag) {
            note(&mut seen, "daemon", &w.script_key(&h.argv), tag);
        }
    }
    let mut problems = expected::compare(&list, "daemon", &seen);
    if o.code != Some(0) {
        problems.push(format!("`ah-engine schedule list` exited {:?}: {}", o.code, o.stderr.trim()));
    }
    expected::finish("daemon", serde_json::json!({"schedule": o.stdout, "node_paths": expected::seen_json(&seen)}), &problems);
}
