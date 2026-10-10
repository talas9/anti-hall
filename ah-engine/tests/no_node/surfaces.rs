//! The other commands a host or the OS runs: the shipped hooks.json of both hosts, the status line the installer writes,
//! the monitors (monitors.json), and the daemon's own scheduled work.

use crate::expected;
use crate::harness::{DAEMON_TAG, Seen, World, cfg_int, cfg_list, cfg_str, note};

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

/// The status line: the installer (as the skill runs it) writes `statusLine.command`; that command renders within its
/// deadline with no Node, and names no Node script to fall back to.
#[test]
fn statusline_installs_and_renders_without_node() {
    let list = expected::load();
    let mut w = World::new("statusline");
    w.start_daemon();
    let timeout = Duration::from_secs(cfg_int(&w.cfg, "timeouts", "callsite_s"));
    let deadline = Duration::from_secs(cfg_int(&w.cfg, "timeouts", "statusline_s"));
    let mut seen = Seen::new();
    let mut problems = Vec::new();

    let mut cmd = w.command("/bin/sh", "statusline/install");
    cmd.arg(w.plugin.join("scripts").join("ah-run.sh")).args(cfg_list(&w.cfg, "statusline", "install_args"));
    let inst = w.run(cmd, None, timeout);
    if inst.code != Some(0) {
        problems.push(format!("the status line installer exited {:?}: {}", inst.code, inst.stderr.trim()));
    }
    let settings: serde_json::Value =
        std::fs::read_to_string(w.home.join(".claude").join("settings.json")).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default();
    let command = settings["statusLine"]["command"].as_str().map(str::to_string);
    let mut render = serde_json::Value::Null;
    match &command {
        None => problems.push("the installer wrote no statusLine.command into the scratch ~/.claude/settings.json".to_string()),
        Some(c) => {
            if let Some(js) = js_in(c, &w) {
                // the command still names a Node script the launcher falls back to
                note(&mut seen, "statusline/command", &js, "settings.json");
            }
            let session = w.subst(&cfg_str(&w.cfg, "statusline", "session"));
            let mut cmd = w.command("/bin/sh", "statusline/render");
            cmd.arg("-c").arg(c);
            let o = w.run(cmd, Some(&session), deadline);
            if o.timed_out || o.code != Some(0) || o.stdout.trim().is_empty() {
                problems.push(format!(
                    "the status line did not render within {deadline:?}: exit {:?}, timed out {}, stdout {:?}, stderr {:?}",
                    o.code,
                    o.timed_out,
                    o.stdout.trim(),
                    o.stderr.trim()
                ));
            }
            render = serde_json::json!({"exit": o.code, "ms": o.elapsed_ms, "stdout": o.stdout, "stderr": o.stderr});
        }
    }
    w.settle();
    for step in ["statusline/install", "statusline/render"] {
        for h in w.hits_of(step) {
            note(&mut seen, step, &w.script_key(&h.argv), step);
        }
    }
    problems.extend(expected::compare(&list, "statusline/", &seen));
    let report = serde_json::json!({"command": command, "install_exit": inst.code, "render": render, "node_paths": expected::seen_json(&seen)});
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
