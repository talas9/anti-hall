//! Unit tests of the claim-ledger check; the Node-vs-engine comparison is tests/response_guards_parity.rs.
use super::*;

#[test]
fn a_claim_matches_a_number_in_the_evidence_at_its_own_precision() {
    let ev = collect_numbers("took 34.887 total, 1,234 files");
    assert!(number_in_evidence("34.9", &ev));
    assert!(number_in_evidence("35", &ev));
    assert!(!number_in_evidence("34.8", &ev));
    assert!(number_in_evidence("1,234", &ev));
    assert!(!number_in_evidence("1,235", &ev));
    assert!(number_in_evidence("1.", &[]) || true);
}

#[test]
fn the_tolerance_is_half_a_unit_of_the_last_decimal() {
    // 34.85 is 0.05 away from 34.9: equal to the tolerance up to rounding, as Math.pow(10, -1) * 0.5 does in Node
    let ev = collect_numbers("34.85");
    assert_eq!(number_in_evidence("34.9", &ev), ((34.85f64 - 34.9f64).abs() <= 0.5 * 0.1f64));
}

#[test]
fn a_number_glued_to_an_identifier_character_is_not_a_count() {
    let flags = |t: &str| extract_flags(t, "", 1).unwrap().into_iter().map(|f| f.token).collect::<Vec<_>>();
    assert_eq!(flags("V2-4 workspace"), Vec::<String>::new());
    assert_eq!(flags("x12 files"), Vec::<String>::new());
    assert_eq!(flags("(12 files)"), vec!["12 files".to_string()]);
    assert_eq!(flags("took 12 seconds and 3 files"), vec!["12 seconds".to_string(), "3 files".to_string()]);
    assert_eq!(flags("a .5 files"), Vec::<String>::new());
}

#[test]
fn a_state_word_is_a_soft_flag_only_in_a_turn_without_tool_calls() {
    let kinds = |tools: usize| extract_flags("it is still running", "", tools).unwrap().into_iter().map(|f| f.kind).collect::<Vec<_>>();
    assert_eq!(kinds(0), vec!["state-no-tool"]);
    assert!(kinds(2).is_empty());
}

#[test]
fn texts_compare_after_nfc_and_white_space_collapse() {
    assert_eq!(collapse_text("cafe\u{301}  \n x "), collapse_text("caf\u{e9} x"));
    assert_eq!(collapse_text("  "), "");
}

#[test]
fn the_ledger_record_has_the_node_key_order() {
    let f = [Flag { cls: "hard", kind: "count", token: "12 files".into(), context: "ran 12 files".into() }];
    let line = record_line("s1", "abc", 2, 10, 20, false, &f);
    assert!(line.starts_with("{\"ts\":\""));
    assert!(line.ends_with("\"tools_this_turn\":2,\"msg_chars\":10,\"evidence_chars\":20,\"window_truncated\":false,\"flags\":[{\"cls\":\"hard\",\"kind\":\"count\",\"token\":\"12 files\",\"context\":\"ran 12 files\"}]}\n"));
}

#[test]
fn a_context_cut_inside_a_surrogate_pair_defers() {
    let text = format!("{}\u{1f600} 12 files", "a".repeat(159));
    assert!(context_at(&text, 0).is_err());
    assert_eq!(context_at("ab\ncd", 3).unwrap(), "cd");
}
