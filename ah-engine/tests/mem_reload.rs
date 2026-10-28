//! Memory held across config reloads: a daemon that re-reads the plugin's defaults 50 times must not grow by a copy of the
//! whole defaults set per reload (root cause of the live footprint step at a defaults edit, 2026-10-15).
//!
//! One real daemon on a scratch HOME and a scratch copy of the plugin (never the installed one or the live engine).
#![allow(clippy::unwrap_used, clippy::expect_used)] // a test crate: a panic is the failure report, and E2 exempts tests
#![allow(clippy::panic, clippy::unreachable)] // integration tests: a panic is the failure report; production crates deny these in Cargo.toml
mod common;

use serde_json::Value;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

const BIN: &str = env!("CARGO_BIN_EXE_ah-engine");

fn nanos() -> u128 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()
}

fn cmd(root: &Path, state: &Path, plugin: &Path) -> Command {
    let mut c = Command::new(BIN);
    c.env("HOME", root.join("home")).env("AH_ENGINE_DIR", state).env("AH_ENGINE_PLUGIN_ROOT", plugin).env("AH_ENGINE_NOSPAWN", "1");
    c
}

/// Run a verb; a read-only one (`status`) is retried while the daemon is busy with a reload and the control client gives up on it.
fn run(root: &Path, state: &Path, plugin: &Path, args: &[&str]) -> (i32, String) {
    let tries = if args[0] == "status" { 20 } else { 1 };
    let mut last = (-1, String::new());
    for _ in 0..tries {
        let o = cmd(root, state, plugin).args(args).output().unwrap();
        last = (o.status.code().unwrap_or(-1), String::from_utf8_lossy(&o.stdout).into_owned());
        if last.0 == 0 {
            break;
        }
        std::thread::sleep(Duration::from_millis(250));
    }
    last
}

/// (bytes the `defaults_leak` holder reports, kilobytes of counted heap). The heap figure is the lowest of a few samples a moment
/// apart: a request in flight (this one included) and the interpreter's garbage move it by more than one reload keeps.
fn held(root: &Path, state: &Path, plugin: &Path) -> (u64, u64) {
    let (mut leak, mut heap) = (0, u64::MAX);
    for i in 0..5 {
        if i > 0 {
            std::thread::sleep(Duration::from_millis(400));
        }
        let (code, out) = run(root, state, plugin, &["status", "--memory", "--json"]);
        assert_eq!(code, 0, "status --memory: {out}");
        let v: Value = serde_json::from_str(&out).unwrap();
        let m = &v["memory"];
        leak = m["budgets"]["holders"].as_array().unwrap().iter().find(|h| h["name"] == "defaults_leak").unwrap()["bytes"].as_u64().unwrap();
        heap = heap.min(m["heap_live_kb"].as_u64().unwrap());
    }
    (leak, heap)
}

fn wait_for(what: &str, mut f: impl FnMut() -> bool) {
    let t = Instant::now();
    while t.elapsed() < Duration::from_secs(180) {
        if f() {
            return;
        }
        std::thread::sleep(Duration::from_millis(25));
    }
    panic!("timed out waiting for {what}");
}

fn version(root: &Path, state: &Path, plugin: &Path) -> u64 {
    let (_, out) = run(root, state, plugin, &["status", "--json"]);
    serde_json::from_str::<Value>(&out).ok().and_then(|v| v["config"]["version"].as_u64()).unwrap_or(0)
}

/// Edit the defaults, ask the daemon to re-read (its own watcher may get there first) and wait until the config version says it
/// did. A debug build can take longer to reload than the control client waits for a reply (the reload still completes), so the
/// reply is not what is checked.
fn edited_and_reloaded(root: &Path, state: &Path, plugin: &Path, v: u64) {
    let before = version(root, state, plugin);
    edit(plugin, v);
    run(root, state, plugin, &["ctl", "reload"]);
    wait_for("the reload to be applied", || version(root, state, plugin) > before);
}

/// Set `script.gc_every_calls` to `v` in the scratch plugin's editable defaults (an edit that changes exactly one entry).
fn edit(plugin: &Path, v: u64) {
    let f = plugin.join("engine/defaults/script.toml");
    let text = std::fs::read_to_string(&f).unwrap();
    let mut out = String::new();
    let mut inside = false;
    for line in text.lines() {
        if line.starts_with('[') {
            inside = line == "[script.gc_every_calls]";
        }
        if inside && line.starts_with("value = ") {
            out.push_str(&format!("value = {v}\n"));
        } else {
            out.push_str(line);
            out.push('\n');
        }
    }
    std::fs::write(f, out).unwrap();
}

// The heap cap (8 KB per reload) is a release-build figure: measured on 88db1bd6 at load ~23, a debug build grows 32-33 KB per
// reload (the memory branch's own tip too, so not a merge effect) and a release build 2 KB. Run it with `cargo test --release`.
#[test]
#[cfg_attr(debug_assertions, ignore = "the heap cap is a release-build figure; run with --release")]
fn fifty_defaults_reloads_do_not_keep_a_copy_of_the_defaults_each() {
    let b: toml::Table = std::fs::read_to_string(Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/budgets.toml")).unwrap().parse().unwrap();
    let b = &b["mem_reload"];
    let n = |k: &str| b[k].as_integer().unwrap() as u64;
    let (reloads, warmup, leak_cap, heap_cap) = (n("reloads"), n("warmup"), n("leak_bytes_per_reload"), n("heap_kb_per_reload"));

    let root = common::TempDir::at(std::env::temp_dir().join(format!("ah-mem-reload-{}-{}", std::process::id(), nanos())));
    let state: PathBuf = root.join("state");
    std::fs::create_dir_all(root.join("home")).unwrap();
    std::fs::create_dir_all(&state).unwrap();
    let plugin = root.join("plugin");
    let src = Path::new(env!("CARGO_MANIFEST_DIR")).join("../plugins/anti-hall");
    let cp = Command::new("cp").arg("-R").arg(&src).arg(&plugin).status().unwrap();
    assert!(cp.success(), "copy the plugin");
    // a debug build on a loaded machine can take longer than the shipped control deadline (1.5 s) to answer during a reload
    let engine_toml = plugin.join("engine/defaults/engine.toml");
    let text = std::fs::read_to_string(&engine_toml).unwrap();
    let (head, tail) = text.split_once("[client.ctl_timeout_ms]").unwrap();
    let tail = tail.replacen("value = 1500", "value = 60000", 1);
    std::fs::write(&engine_toml, format!("{head}[client.ctl_timeout_ms]{tail}")).unwrap();

    // the allocator tuning the client hands a daemon it spawns (`daemon.malloc_conf`), read from the plugin copy like the client does
    let shipped: toml::Table = std::fs::read_to_string(plugin.join("engine/defaults/engine.toml")).unwrap().parse().unwrap();
    let conf = shipped["daemon"]["malloc_conf"]["value"].as_str().unwrap().to_string();
    // a debug build on a loaded machine must not be killed by the stall and stuck watchdogs while it reloads
    std::fs::write(state.join("config.toml"), "[daemon]\nstall_ms = 600000\nstuck_ms = 600000\n").unwrap();
    let mut child = cmd(&root, &state, &plugin)
        .env("_RJEM_MALLOC_CONF", conf)
        .arg("serve")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    struct Stop<'a>(&'a Path, &'a mut std::process::Child);
    impl Drop for Stop<'_> {
        fn drop(&mut self) {
            common::stop_child(&ah_engine::paths::socket_in(self.0), self.1);
        }
    }
    let _stop = Stop(&state, &mut child);
    wait_for("daemon ping", || run(&root, &state, &plugin, &["ctl", "ping"]).0 == 0);

    let mut v = 2000;
    for _ in 0..warmup {
        v += 1;
        edited_and_reloaded(&root, &state, &plugin, v);
    }
    let (leak0, heap0) = held(&root, &state, &plugin);
    for _ in 0..reloads {
        v += 1;
        edited_and_reloaded(&root, &state, &plugin, v);
    }
    let (leak1, heap1) = held(&root, &state, &plugin);
    let (leak_per, heap_per) = ((leak1 - leak0) / reloads, heap1.saturating_sub(heap0) / reloads);
    eprintln!("RELOAD x{reloads}: defaults_leak +{leak_per} B/reload (cap {leak_cap}), counted heap +{heap_per} KB/reload (cap {heap_cap})");
    assert!(leak_per <= leak_cap, "defaults_leak grew {leak_per} B per reload (cap {leak_cap}): each reload keeps more than what the edit changed");
    assert!(heap_per <= heap_cap, "the counted heap grew {heap_per} KB per reload (cap {heap_cap})");
}
