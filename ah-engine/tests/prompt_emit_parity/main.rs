//! Node-vs-engine parity for the prompt-emission checks: `verify-first`, `idle-agent-sweep` and `emit-dedupe-reset`.
//!
//! Every scenario runs the real Node hook and the engine's `ah-engine check <name>` against the same isolated home, in
//! turn, from the same starting state, and compares exit code, stdout bytes, stderr bytes and every file under the home
//! afterwards (the emit-dedupe state parsed and re-written with insertion order kept, timestamps near the run's clock
//! normalized). When the engine defers (`AHFALLBACK`), the Node hook then runs on the engine's home, which is what the
//! hook client does, so a deferral that had already written state would show up as a divergence.
//!
//! The scenario lists are in `verify_first.rs`, `idle.rs` and `reset.rs`; `harness.rs` runs them.
mod harness;
mod idle;
mod reset;
mod verify_first;

use harness::{Report, Scn};

fn run_corpus(name: &str, scenarios: Vec<Scn>, min_scenarios: usize, min_handled: usize) -> Report {
    assert!(scenarios.len() >= min_scenarios, "{name}: corpus too small ({} < {min_scenarios})", scenarios.len());
    let r = harness::run_all(name, scenarios);
    eprintln!("{name}: scenarios={} steps={} handled-by-engine={} deferred-to-node={} divergences={}", r.scenarios, r.steps, r.handled, r.deferred, r.divergences.len());
    assert!(r.divergences.is_empty(), "{name}: {} divergences, first:\n{}", r.divergences.len(), r.divergences.iter().take(12).cloned().collect::<Vec<_>>().join("\n---\n"));
    assert!(r.handled >= min_handled, "{name}: the engine handled only {} steps (< {min_handled}): a corpus the engine defers is not a parity test", r.handled);
    r
}

#[test]
fn verify_first_matches_node() {
    run_corpus("verify-first", verify_first::scenarios(), 120, 150);
}

#[test]
fn idle_agent_sweep_matches_node() {
    run_corpus("idle-agent-sweep", idle::scenarios(), 60, 60);
}

#[test]
fn emit_dedupe_reset_matches_node() {
    run_corpus("emit-dedupe-reset", reset::scenarios(), 40, 30);
}
