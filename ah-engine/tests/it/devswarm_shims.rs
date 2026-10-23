//! The stable DevSwarm launchers are POSIX-sh shims the engine writes itself: no `node` in their text, and they run the engine's
//! `mesh` verb with no `node` on the PATH.
#![allow(clippy::unwrap_used, clippy::expect_used)] // a test crate: a panic is the failure report, and E2 exempts tests

use ah_engine::checks::devswarm_role::text::{engine_cli, engine_watcher, install_shims, shim_source};
use std::path::Path;
use std::process::Command;

const BIN: &str = env!("CARGO_BIN_EXE_ah-engine");

fn plugin() -> std::path::PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap().join("plugins/anti-hall")
}

#[test]
fn the_shims_have_no_node_and_run_the_engine_mesh_verb_without_node_on_the_path() {
    let home = std::env::temp_dir().join(format!("ah-shims-{}", std::process::id()));
    std::fs::remove_dir_all(&home).ok();
    std::fs::create_dir_all(home.join(".anti-hall/ah-engine/bin")).unwrap();
    std::os::unix::fs::symlink(BIN, home.join(".anti-hall/ah-engine/bin/ah-engine")).unwrap();
    let h = home.to_string_lossy().into_owned();

    for watcher in [false, true] {
        let src = shim_source(watcher, &h);
        assert!(!src.contains("node"), "the shim text names node: {src}");
        assert!(src.starts_with("#!/bin/sh\n"), "{src}");
    }
    assert_eq!(install_shims(&home).unwrap(), 2);
    assert_eq!(install_shims(&home).unwrap(), 0, "idempotent: nothing is rewritten when the files are current");
    assert_eq!(engine_cli(&h), format!("{h}/.anti-hall/bin/devswarm.js"));
    assert_eq!(engine_watcher(&h), format!("{h}/.anti-hall/bin/wake-watch.js"));

    // /bin only: no node anywhere on the PATH
    let out = Command::new(engine_cli(&h))
        .arg("workspaces")
        .env_clear()
        .env("PATH", "/usr/bin:/bin")
        .env("HOME", &home)
        .env("AH_ENGINE_DIR", home.join("state"))
        .env("AH_ENGINE_PLUGIN_ROOT", plugin())
        .env("AH_ENGINE_NOSPAWN", "1")
        .current_dir(&home)
        .output()
        .unwrap();
    let (so, se) = (String::from_utf8_lossy(&out.stdout), String::from_utf8_lossy(&out.stderr));
    assert!(!se.contains("node: command not found") && !se.contains("env: node"), "the shim reached for node: {se}");
    assert!(out.status.code().is_some(), "the shim ran to an exit code: {so} {se}");
    eprintln!("mesh workspaces via the shim: code {:?}\n{so}{se}", out.status.code());

    // the command the guards print as their override (`<shim> skip <guard>`) runs with no node on the PATH, exits 0 and records the skip
    let out = Command::new(engine_cli(&h))
        .args(["skip", "edit-guard"])
        .env_clear()
        .env("PATH", "/usr/bin:/bin")
        .env("HOME", &home)
        .env("AH_ENGINE_DIR", home.join("state"))
        .env("AH_ENGINE_PLUGIN_ROOT", plugin())
        .env("AH_ENGINE_NOSPAWN", "1")
        .current_dir(&home)
        .output()
        .unwrap();
    let (so, se) = (String::from_utf8_lossy(&out.stdout), String::from_utf8_lossy(&out.stderr));
    assert_eq!(out.status.code(), Some(0), "the printed skip command runs: {so} {se}");
    let skip = std::fs::read_to_string(home.join(".anti-hall/skip.json")).unwrap_or_default();
    assert!(skip.contains("edit-guard"), "the skip is recorded: {skip:?} {so} {se}");
}
