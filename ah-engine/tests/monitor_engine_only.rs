//! The DevSwarm wake-watch monitor (monitors/monitors.json) runs the engine and nothing else: every engine exit is the
//! watcher's own and is passed on, and with no engine installed nothing starts in its place. Scratch HOME and a fake plugin
//! root with stub programs, so neither the real engine nor the user's home is touched.
#![allow(clippy::unwrap_used, clippy::expect_used)] // a test crate: a panic is the failure report
#![allow(clippy::panic, clippy::unreachable)] // integration tests: a panic is the failure report; production crates deny these in Cargo.toml

use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::Command;

fn monitor_command() -> String {
    let p = Path::new(env!("CARGO_MANIFEST_DIR")).join("../plugins/anti-hall/monitors/monitors.json");
    let v: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(p).unwrap()).unwrap();
    let m = v.as_array().unwrap().iter().find(|m| m["name"] == "devswarm-wake-watch").expect("the wake-watch monitor");
    m["command"].as_str().unwrap().to_string()
}

fn script(path: &Path, body: &str) {
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(path, format!("#!/bin/sh\n{body}\n")).unwrap();
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755)).unwrap();
}

struct Run {
    code: Option<i32>,
    out: String,
}

/// Run the monitor command with a stub engine (`engine_body`, absent when None) and a stub installer that must never run.
fn run(tag: &str, engine_body: Option<&str>) -> Run {
    let root: PathBuf = std::env::temp_dir().join(format!("ah-monfb-{tag}-{}", std::process::id()));
    std::fs::remove_dir_all(&root).ok();
    let home = root.join("home");
    let plugin = root.join("plugin");
    std::fs::create_dir_all(&home).unwrap();
    if let Some(b) = engine_body {
        script(&home.join(".anti-hall/ah-engine/bin/ah-engine"), b);
    }
    script(&plugin.join("hooks/install.sh"), "echo \"LAUNCHER $*\"");
    script(&plugin.join("companion/lib/devswarm-wake-watch.js"), "echo NODE-WATCHER");
    let o = Command::new("/bin/sh")
        .arg("-c")
        .arg(monitor_command())
        .env_clear()
        .env("PATH", "/usr/bin:/bin")
        .env("HOME", &home)
        .env("CLAUDE_PLUGIN_ROOT", &plugin)
        .output()
        .unwrap();
    let r = Run { code: o.status.code(), out: String::from_utf8_lossy(&o.stdout).to_string() };
    std::fs::remove_dir_all(&root).ok();
    r
}

#[test]
fn every_engine_exit_is_the_watchers_own_and_no_launcher_or_node_runs() {
    for (tag, body, code) in
        [("e75", "exit 75", 75), ("e70", "exit 70", 70), ("e127", "exit 127", 127), ("e0", "echo WATCH; exit 0", 0), ("e3", "echo WATCH; exit 3", 3)]
    {
        let r = run(tag, Some(body));
        assert_eq!(r.code, Some(code), "{tag}: {}", r.out);
        assert!(!r.out.contains("LAUNCHER") && !r.out.contains("NODE-WATCHER"), "{tag}: nothing else runs: {}", r.out);
    }
}

#[test]
fn a_missing_engine_starts_nothing_in_its_place() {
    let r = run("missing", None);
    assert_ne!(r.code, Some(0), "{}", r.out);
    assert!(!r.out.contains("LAUNCHER") && !r.out.contains("NODE-WATCHER"), "{}", r.out);
}

#[test]
fn engine_receives_the_wake_watch_arguments_and_plugin_root() {
    let r = run("args", Some("echo \"$AH_ENGINE_PLUGIN_ROOT|$*\"; exit 0"));
    assert!(r.out.trim().ends_with("/plugin|devswarm wake-watch --auto"), "{}", r.out);
}
