//! The send, roster and shared-helper files of the mesh CLI answer every case themselves: nothing in them hands a verb to Node,
//! because Node is no longer on the live path and a deferral there is an exit-69 failure for the agent that ran the verb
//! (2026-10-23, #171). The test counts the `defer("...")` call sites outside the test modules of each file; the count may not
//! rise, and the allow-list below is the whole of what remains, each with the reason it is not Node's to answer.
#![allow(clippy::unwrap_used, clippy::expect_used)] // a test crate: a panic is the failure report, and E2 exempts tests

use std::path::Path;

/// `(file, allowed call sites, why)`.
/// Nothing is allowed: a FIFO, socket or device read as a mesh file is the verb's own refusal (`not-a-regular-file`).
const ALLOWED: &[(&str, usize, &str)] = &[];

const FILES: &[&str] = &["send.rs", "rosterrows.rs", "roster.rs", "rostertail.rs", "common.rs", "ident.rs"];

fn production_part(text: &str) -> &str {
    text.split("#[cfg(test)]").next().unwrap_or(text)
}

fn call_sites(text: &str) -> usize {
    production_part(text).lines().filter(|l| !l.trim_start().starts_with("//")).filter(|l| l.contains("defer(") && !l.contains("fn defer")).count()
}

#[test]
fn the_mesh_send_roster_and_helper_files_never_hand_a_verb_to_node() {
    let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("src").join("meshw");
    for file in FILES {
        let text = std::fs::read_to_string(dir.join(file)).unwrap();
        let allowed = ALLOWED.iter().find(|(f, ..)| f == file).map_or(0, |(_, n, _)| *n);
        let found = call_sites(&text);
        assert!(
            found <= allowed,
            "{file} has {found} `defer(` call sites, {allowed} allowed: answer the case natively (port Node's behaviour, or refuse cleanly with a reason in TOML text); a deferral is an exit-69 failure for the agent"
        );
    }
}
