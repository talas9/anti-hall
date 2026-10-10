//! The DevSwarm wake-watch monitor (monitors/monitors.json) keeps its Node fallback until the runtime cutover (v1.0 lane L17):
//! when the engine answers "leave this to Node" (75), cannot load its defaults (70) or is not runnable (126/127), the command
//! hands over to the launcher `scripts/ah-run.sh`, which runs the Node watcher; any other engine exit is the watcher's own and
//! is passed on without a fallback. Scratch HOME and a fake plugin root with stub programs, so neither the real engine nor the
//! user's home is touched.
#![allow(clippy::unwrap_used, clippy::expect_used)] // a test crate: a panic is the failure report

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

/// Run the monitor command with a stub engine (`engine_body`, absent when None) and a stub launcher that prints what it got.
fn run(tag: &str, engine_body: Option<&str>) -> Run {
    let root: PathBuf = std::env::temp_dir().join(format!("ah-monfb-{tag}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    let home = root.join("home");
    let plugin = root.join("plugin");
    std::fs::create_dir_all(&home).unwrap();
    if let Some(b) = engine_body {
        script(&home.join(".anti-hall/ah-engine/bin/ah-engine"), b);
    }
    script(&plugin.join("scripts/ah-run.sh"), "echo \"LAUNCHER $*\"");
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
    let _ = std::fs::remove_dir_all(&root);
    r
}

#[test]
fn engine_exit_75_falls_back_to_the_launcher() {
    let r = run("e75", Some("exit 75"));
    assert_eq!(r.code, Some(0), "{}", r.out);
    assert!(r.out.contains("LAUNCHER devswarm wake-watch -- ") && r.out.contains("companion/lib/devswarm-wake-watch.js --auto"), "{}", r.out);
}

#[test]
fn engine_not_loadable_or_not_runnable_falls_back_too() {
    for (tag, body) in [("e70", Some("exit 70")), ("e127", Some("exit 127")), ("missing", None)] {
        let r = run(tag, body);
        assert!(r.out.contains("LAUNCHER devswarm wake-watch"), "{tag}: {} (exit {:?})", r.out, r.code);
    }
}

#[test]
fn engine_own_exit_is_passed_on_without_a_fallback() {
    let r = run("e0", Some("echo WATCH; exit 0"));
    assert_eq!((r.code, r.out.trim()), (Some(0), "WATCH"), "a clean end is not retried in Node");
    let r = run("e3", Some("echo WATCH; exit 3"));
    assert_eq!((r.code, r.out.trim()), (Some(3), "WATCH"), "the watcher's own failure code is kept");
}

#[test]
fn engine_receives_the_wake_watch_arguments_and_plugin_root() {
    let r = run("args", Some("echo \"$AH_ENGINE_PLUGIN_ROOT|$*\"; exit 0"));
    assert!(r.out.trim().ends_with("/plugin|devswarm wake-watch --auto"), "{}", r.out);
}
