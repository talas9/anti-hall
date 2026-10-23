//! End to end, on the real binary in a scratch HOME and state directory (never the user's daemon): a daemon whose process total
//! stays over `mem.global_hard_bytes` for `mem.global_restart_after_s` drains and exits on its own, and the event log records why.
//! The plugin is a scratch copy whose `mem.toml` has the two limits lowered (the tunables are plugin files, so tuning is an edit,
//! not a rebuild); the resident-set cap is switched off so only the memory registry can end this daemon.
#![allow(clippy::unwrap_used, clippy::expect_used)] // a test crate: a panic is the failure report, and E2 exempts tests

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

fn copy_dir(from: &Path, to: &Path) {
    std::fs::create_dir_all(to).unwrap();
    for e in std::fs::read_dir(from).unwrap().flatten() {
        let (src, dst) = (e.path(), to.join(e.file_name()));
        if src.is_dir() {
            copy_dir(&src, &dst);
        } else {
            std::fs::copy(&src, &dst).unwrap();
        }
    }
}

fn lower(plugin: &Path, dir: &str) {
    let p = plugin.join("engine").join(dir).join("mem.toml");
    let text = std::fs::read_to_string(&p).unwrap();
    let text = text
        .replace("value = 125829120", "value = 1048576") // mem.global_hard_bytes
        .replace("value = 100663296", "value = 1048576") // mem.global_soft_bytes
        .replace("value = 60\nmin = 1\nunit = \"s\"", "value = 1\nmin = 1\nunit = \"s\""); // mem.global_restart_after_s
    assert!(text.contains("value = 1\nmin = 1\nunit = \"s\""), "restart_after_s was not lowered");
    std::fs::write(p, text).unwrap();
}

#[test]
fn a_daemon_over_the_global_hard_limit_for_too_long_restarts_cleanly_and_says_why() {
    let root: PathBuf = std::env::temp_dir().join(format!("ahd-memrestart-{}", std::process::id()));
    std::fs::remove_dir_all(&root).ok(); // our own scratch directory from a crashed earlier run
    let plugin = root.join("plugin");
    copy_dir(&Path::new(env!("CARGO_MANIFEST_DIR")).join("../plugins/anti-hall"), &plugin);
    lower(&plugin, "defaults");
    lower(&plugin, "defaults.pristine");
    let (home, state) = (root.join("home"), root.join("state"));
    std::fs::create_dir_all(&home).unwrap();
    let mut child = Command::new(env!("CARGO_BIN_EXE_ah-engine"))
        .arg("serve")
        .env_clear()
        .env("PATH", std::env::var("PATH").unwrap_or_default())
        .env("HOME", &home)
        .env("AH_ENGINE_DIR", &state)
        .env("AH_ENGINE_VERSION", "mem-restart-e2e")
        .env("CLAUDE_PLUGIN_ROOT", &plugin)
        .env("AH_ENGINE_PLUGIN_ROOT", &plugin)
        .env("ANTIHALL_INGEST_DRY_RUN", "1")
        .env("AH_ENGINE_RSS_CHECK_MS", "200")
        .env("AH_ENGINE_RSS_CAP_KB", "0")
        .current_dir(&root)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    let start = Instant::now();
    let exited = loop {
        if let Some(s) = child.try_wait().unwrap() {
            break Some(s);
        }
        if start.elapsed() > Duration::from_secs(30) {
            break None;
        }
        std::thread::sleep(Duration::from_millis(100));
    };
    if exited.is_none() {
        child.kill().ok();
        child.wait().ok();
    }
    let log = std::fs::read_to_string(state.join("ah-engine.log")).unwrap_or_default();
    std::fs::remove_dir_all(&root).ok(); // our own scratch directory
    assert!(exited.is_some(), "the daemon did not restart itself within 30 s; log:\n{log}");
    assert!(log.contains("memory\thard"), "no hard-limit line in the log:\n{log}");
    assert!(log.contains("memory\trestart"), "no restart request in the log:\n{log}");
    assert!(log.contains("stayed over its hard memory limit"), "the reason is not recorded:\n{log}");
    assert!(log.contains("exit\tclean"), "the daemon did not exit cleanly:\n{log}");
}
