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
