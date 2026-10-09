//! Golden parity of the D88 batch-8 checks (lane F): every case of `tests/golden/<check>.jsonl` (frozen from the compiled port before it
//! was removed) through the plugin script, byte for byte, with the files the script wrote compared too. A case whose answer differs on
//! purpose carries a `note`; `parity/run-golden.js` replays the corpus against the Node hook.
use super::tests::golden_report;

#[test]
fn verify_first_script_matches_the_compiled_port() {
    golden_report("verify-first", 12);
}

#[test]
fn verify_first_orch_scripts_match_the_compiled_ports() {
    golden_report("verify-first-orch", 12);
    golden_report("verify-first-orch-codex", 12);
}

#[test]
fn task_tracker_script_matches_the_compiled_port() {
    golden_report("task-tracker", 12);
}

#[test]
fn ship_it_guard_script_matches_the_compiled_port() {
    golden_report("ship-it-guard", 12);
}

#[test]
fn compact_declaration_guard_script_matches_the_compiled_port() {
    golden_report("compact-declaration-guard", 12);
}

#[test]
fn devswarm_prompt_and_gate_scripts_match_the_compiled_ports() {
    for check in ["devswarm-parent-inbox", "devswarm-child-turn", "devswarm-child-gate", "devswarm-parent-reply-tracker", "devswarm-child-drain", "devswarm-child-role", "devswarm-parent-gate", "devswarm-comms-guard"] {
        golden_report(check, 12);
    }
}

#[test]
fn session_gate_scripts_match_the_compiled_ports() {
    for check in ["jev-review-reminder", "jev-weekly-scorecard", "repair-on-reload"] {
        golden_report(check, 12);
    }
}

#[test]
fn task_lifecycle_log_script_matches_the_compiled_port() {
    golden_report("task-lifecycle-log", 12);
}
