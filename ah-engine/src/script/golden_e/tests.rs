//! Golden parity of the D88 batch-7 checks: every case of `tests/golden/<check>.jsonl` (frozen from the compiled port before it was
//! removed) through the plugin script, byte for byte, with the files the script wrote compared too. A case whose answer differs on
//! purpose carries a `note`; `parity/run-golden.js` replays the corpus against the Node hook.
use super::tests::golden_report;

#[test]
fn stale_agent_stop_note_script_matches_the_compiled_port() {
    golden_report("stale-agent-stop-note", 12);
}
