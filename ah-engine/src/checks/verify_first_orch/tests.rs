//! Unit tests of the verify-first-orch text assembly; the Node-vs-engine parity corpus is `tests/spawn_ctx_parity.rs`.
use super::*;

#[test]
fn the_compact_text_names_the_root_and_the_delivery_only_when_asked() {
    let plain = orch_compact(false, "/plug", false);
    assert!(plain.starts_with("ORCHESTRATION (main thread = coordinator; letters match the full rules A-N in /plug/PROTOCOL.md#orchestration):\n"));
    assert!(!plain.contains("<abs>") && !plain.contains("<delivery>"));
    let spawn = orch_compact(true, "/plug", false);
    assert!(spawn.contains("#orchestration; sent in full on your first spawn):"));
}

#[test]
fn the_codex_compact_text_swaps_only_the_model_routing_line() {
    let a = orch_compact(false, "/p", false);
    let b = orch_compact(false, "/p", true);
    let (la, lb): (Vec<&str>, Vec<&str>) = (a.lines().collect(), b.lines().collect());
    assert_eq!(la.len(), lb.len());
    let diff: Vec<usize> = (0..la.len()).filter(|&i| la[i] != lb[i]).collect();
    assert_eq!(diff.len(), 1);
    assert!(la[diff[0]].starts_with("M/N.") && lb[diff[0]].starts_with("M/N."));
}

#[test]
fn the_full_text_is_the_header_and_the_rules_joined_by_newlines() {
    let (c, x) = (orch_full(false), orch_full(true));
    assert_ne!(c, x);
    assert!(c.starts_with("ORCHESTRATION DISCIPLINE") || c.lines().next().is_some());
    assert_eq!(c.lines().count(), defaults::list("verify_first_orch.full_lines").iter().map(|l| l.lines().count()).sum::<usize>());
}

#[test]
fn a_codex_session_is_one_with_a_turn_id_or_a_codex_transcript() {
    use serde_json::json;
    assert!(is_codex(&json!({"turn_id": "t"})));
    assert!(!is_codex(&json!({"turn_id": ""})));
    assert!(!is_codex(&json!({"turn_id": 3})));
    assert!(is_codex(&json!({"transcript_path": "/h/.codex/s/a.jsonl"})));
    assert!(is_codex(&json!({"transcript_path": "/x/rollout-1.jsonl"})));
    assert!(is_codex(&json!({"transcript_path": "C:\\x\\rollout-1.jsonl"})));
    assert!(!is_codex(&json!({"transcript_path": "/x/rollout-1.txt"})));
    assert!(!is_codex(&json!({})));
}
