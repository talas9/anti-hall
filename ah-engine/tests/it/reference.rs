//! D50: the generated reference is committed and cannot drift. `REFERENCE.md` must equal what
//! `ah-engine docs --format md` prints; when a command, setting, metric, impact kind, check or error code changes,
//! regenerate it (`cargo run -q -- docs --format md > REFERENCE.md`) in the same commit.
#![allow(clippy::unwrap_used, clippy::expect_used)] // a test crate: a panic is the failure report, and E2 exempts tests

#[test]
fn committed_reference_matches_the_generated_one() {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("REFERENCE.md");
    let committed = std::fs::read_to_string(&path).unwrap_or_default();
    let generated = ah_engine::docs::markdown();
    assert!(
        committed == generated,
        "REFERENCE.md is out of date: run `cargo run -q -- docs --format md > REFERENCE.md` and commit it ({} bytes committed, {} generated)",
        committed.len(),
        generated.len()
    );
}
