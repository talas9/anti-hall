//! The parity harness knob `AH_ENGINE_SCRIPT_CUT_AT_DEADLINE`: with it at 0 a scripted check is never cut at its request's client
//! deadline (the dispatch neither skips a check past it nor interrupts one in flight); at the default it is. This file holds one
//! test, so setting the variable cannot reach another test of the process.
#![allow(clippy::unwrap_used, clippy::expect_used)] // a test crate: a panic is the failure report

const KNOB: &str = "AH_ENGINE_SCRIPT_CUT_AT_DEADLINE";

#[test]
fn the_cut_knob_switches_the_deadline_cut_of_scripted_checks() {
    // SAFETY: the only test in this process, so nothing reads the environment concurrently.
    unsafe { std::env::remove_var(KNOB) };
    assert!(ah_engine::script::cut_at_deadline("switch-notice", "UserPromptSubmit"), "cut at the deadline by default");
    // SAFETY: as above.
    unsafe { std::env::set_var(KNOB, "0") };
    assert!(!ah_engine::script::cut_at_deadline("switch-notice", "UserPromptSubmit"), "the knob at 0 turns the cut off");
    assert!(!ah_engine::script::cut_at_deadline("switch-notice", "SessionStart"));
    // SAFETY: as above.
    unsafe { std::env::set_var(KNOB, "1") };
    assert!(ah_engine::script::cut_at_deadline("switch-notice", "UserPromptSubmit"), "and 1 turns it back on");
}
