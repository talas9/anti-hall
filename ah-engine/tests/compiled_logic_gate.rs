//! D88, the v1.0 gate: `compiled_logic_checks_remaining` counts the registry checks whose decision logic is still compiled
//! Rust (not a `Scripted` entry answered by a plugin script). It may only go down: `compiled_logic_ceiling.txt` holds the
//! number reached so far, and lowering it is part of every batch that migrates a check. At 0 every check's logic is an
//! editable plugin script, which is the gate.
#![allow(clippy::unwrap_used, clippy::expect_used)] // a test crate: a panic is the failure report, and E2 exempts tests

use std::path::Path;

fn ceiling() -> usize {
    let text = std::fs::read_to_string(Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/compiled_logic_ceiling.txt")).unwrap();
    text.lines().find(|l| !l.trim().is_empty() && !l.starts_with('#')).unwrap().trim().parse().unwrap()
}

#[test]
fn compiled_logic_checks_remaining_never_goes_up_and_the_ceiling_is_tight() {
    let remaining = ah_engine::checks::compiled_logic_checks_remaining();
    let total = ah_engine::checks::registry().len();
    println!("compiled_logic_checks_remaining = {remaining} of {total}");
    assert!(remaining <= ceiling(), "compiled_logic_checks_remaining is {remaining}, above the ceiling {}: a check lost its script", ceiling());
    assert_eq!(remaining, ceiling(), "the ceiling is stale: lower tests/compiled_logic_ceiling.txt to {remaining}");
}

#[test]
fn every_scripted_check_ships_its_script_and_every_shipped_script_is_registered() {
    let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("../plugins/anti-hall/engine/logic");
    let shipped: std::collections::BTreeSet<String> =
        std::fs::read_dir(&dir).unwrap().flatten().filter_map(|e| e.file_name().to_str().and_then(|n| n.strip_suffix(".js")).map(str::to_string)).collect();
    let registered: std::collections::BTreeSet<String> = ah_engine::checks::registry().iter().map(|c| c.name().to_string()).collect();
    for c in ah_engine::checks::registry().iter().filter(|c| c.scripted()) {
        assert!(shipped.contains(c.name()), "scripted check {} has no engine/logic/{}.js", c.name(), c.name());
    }
    for s in &shipped {
        assert!(registered.contains(s), "engine/logic/{s}.js belongs to no registered check");
    }
}
