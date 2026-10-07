//! Node-versus-engine parity of the four context-budget checks: runs `parity/run-ctxbudget.js` (the corpus of hand-written
//! scenarios and settings fuzz; the real-transcript windows are left to the manual run) against the real binary and the real
//! Node hooks, and requires zero mismatches. Skipped where Node or the plugin's hooks are not available (the engine can
//! be built outside the monorepo).
#![allow(clippy::unwrap_used, clippy::expect_used)] // a test crate: a panic is the failure report, and E2 exempts tests

use std::path::PathBuf;
use std::process::Command;

#[test]
fn the_engine_answers_exactly_what_the_node_hooks_do_and_defers_whatever_they_write_or_say() {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let hooks = root.join("../plugins/anti-hall/hooks");
    if !hooks.join("auto-handover.js").exists() || Command::new("node").arg("--version").output().is_err() {
        eprintln!("skipped: no Node or no plugin hooks next to the engine");
        return;
    }
    let out = Command::new("node")
        .arg(root.join("parity/run-ctxbudget.js"))
        .args(["--engine", env!("CARGO_BIN_EXE_ah-engine"), "--real", "0", "--conc", "6", "--hooks"])
        .arg(&hooks)
        .output()
        .unwrap();
    let text = String::from_utf8_lossy(&out.stdout);
    assert!(out.status.success(), "parity mismatches:\n{text}\n{}", String::from_utf8_lossy(&out.stderr));
    for hook in ["limit-conserve-inject", "auto-handover", "auto-handover-pause-nag", "compact-advice-guard"] {
        let line = text.lines().find(|l| l.starts_with(&format!("{hook}:"))).unwrap_or_else(|| panic!("no result for {hook}:\n{text}"));
        let n: usize = line.split("scenarios=").nth(1).and_then(|s| s.split_whitespace().next()).and_then(|s| s.parse().ok()).unwrap_or(0);
        assert!(n >= 30, "{hook}: only {n} scenarios");
    }
}
