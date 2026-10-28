//! #171: a defaults reload that changes one entry keeps the new entry only. The strings the entry shares with its previous
//! copy (key, file, doc, env, unit) are the same allocations, not leaked a second time. Own process: the leak counter is global.
#![allow(clippy::unwrap_used, clippy::expect_used)] // a test crate: a panic is the failure report, and E2 exempts tests
#![allow(clippy::panic, clippy::unreachable)] // integration tests: a panic is the failure report; production crates deny these in Cargo.toml
mod common;
use std::path::Path;
use std::process::Command;

fn set_gc_every_calls(plugin: &Path, v: u64) {
    let f = plugin.join("engine/defaults/script.toml");
    let text = std::fs::read_to_string(&f).unwrap();
    let (mut out, mut inside) = (String::new(), false);
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

#[test]
#[allow(clippy::undocumented_unsafe_blocks)] // test-only env mutation in a single-test process
fn a_changed_integer_entry_leaks_only_its_own_entry_not_a_second_copy_of_its_text() {
    let root = common::TempDir::at(std::env::temp_dir().join(format!("ah-reload-leak-{}", std::process::id())));
    std::fs::create_dir_all(root.join("home")).unwrap();
    std::fs::create_dir_all(root.join("eng")).unwrap();
    let plugin = root.join("plugin");
    let src = Path::new(env!("CARGO_MANIFEST_DIR")).join("../plugins/anti-hall");
    assert!(Command::new("cp").arg("-R").arg(&src).arg(&plugin).status().unwrap().success());
    // FIXME: Audit that the environment access only happens in single-threaded code.
    unsafe {
        std::env::set_var("HOME", root.join("home"));
        std::env::set_var("AH_ENGINE_DIR", root.join("eng"));
        std::env::set_var("AH_ENGINE_PLUGIN_ROOT", &plugin);
    }
    ah_engine::defaults::init().unwrap();
    // warm up: one edit so the first-reload one-offs are not counted
    set_gc_every_calls(&plugin, 2001);
    ah_engine::defaults::reload(None).unwrap();
    let before = ah_engine::mem::leaked_bytes();
    set_gc_every_calls(&plugin, 2002);
    assert!(matches!(ah_engine::defaults::reload(None).unwrap(), ah_engine::defaults::Reloaded::Applied));
    let grew = ah_engine::mem::leaked_bytes() - before;
    let entry = std::mem::size_of::<ah_engine::defaults::Entry>();
    assert!(grew <= entry, "one changed integer entry leaked {grew} B; its own Entry is {entry} B, the rest is a repeated copy of its unchanged text");
    // The dedup set (load.rs SEEN) only ever holds strings that were leaked, so leaked_bytes() moves exactly when it grows:
    // reloads of unchanged defaults add nothing, and re-applying text already seen (flip back and forth) adds no new text.
    let steady = ah_engine::mem::leaked_bytes();
    for _ in 0..50 {
        ah_engine::defaults::reload(None).unwrap();
    }
    assert_eq!(ah_engine::mem::leaked_bytes(), steady, "50 reloads of unchanged defaults must leak nothing");
    for _ in 0..20 {
        for v in [2001, 2002] {
            set_gc_every_calls(&plugin, v);
            ah_engine::defaults::reload(None).unwrap();
        }
    }
    let flip = ah_engine::mem::leaked_bytes() - steady;
    assert!(
        flip <= 40 * entry,
        "40 flips between two already-seen values leaked {flip} B; only the {entry} B Entry per applied reload may grow, never a string"
    );
}
