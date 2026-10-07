//! Unit tests of the speculation-guard check; the Node-vs-engine comparison is tests/response_guards_parity.rs.
use super::*;

#[test]
fn a_hedge_is_found_and_reported_as_written() {
    assert_eq!(find_speculation_marker("It is PROBABLY fine.").as_deref(), Some("PROBABLY"));
    assert_eq!(find_speculation_marker("I'd guess so").as_deref(), Some("I'd guess"));
    assert_eq!(find_speculation_marker("improbably unlikely"), None);
    assert_eq!(find_speculation_marker("it must be fine").as_deref(), Some("must be"));
}

#[test]
fn a_must_be_that_states_a_duty_is_not_a_guess_but_the_next_one_is_judged_on_its_own() {
    assert_eq!(find_speculation_marker("The build must be tested first."), None);
    assert_eq!(find_speculation_marker("Requirement: it should be fast."), None);
    assert_eq!(find_speculation_marker("- ac: it should be fast"), None);
    assert_eq!(find_speculation_marker("per the spec: it should be fast").as_deref(), Some("should be"));
    assert_eq!(find_speculation_marker("It must be measured. It should be fine.").as_deref(), Some("should be"));
    assert_eq!(find_speculation_marker("It must be\n   verified"), None);
}

#[test]
fn an_acknowledgment_is_case_insensitive_except_the_file_line_citation() {
    assert!(has_acknowledgment("I HAVEN'T CHECKED"));
    assert!(has_acknowledgment("see main.js:42"));
    assert!(has_acknowledgment("see MAIN.JS:42"));
    assert!(!has_acknowledgment("see main.js"));
}

#[test]
fn the_obligation_window_counts_utf16_units_and_never_splits_a_character() {
    assert_eq!(window("abc", 40), "abc");
    assert_eq!(window(&"\u{1f600}".repeat(30), 40), "\u{1f600}".repeat(20));
    assert_eq!(window(&"\u{1f600}".repeat(30), 41), "\u{1f600}".repeat(20));
}

#[test]
fn a_legacy_state_file_is_read_like_node_reads_it() {
    let d = std::env::temp_dir().join(format!("ah-sg-state-{}", std::process::id()));
    std::fs::create_dir_all(&d).unwrap();
    let w = |name: &str, body: &str| {
        let p = d.join(name);
        std::fs::write(&p, body).unwrap();
        read_prior(&p).unwrap()
    };
    let p = w("a.json", r#"{"hash":"h1","blocks":2,"pending":{"h":"h1","source":"regex"}}"#);
    assert_eq!((p.last_blocked.as_str(), p.blocks, p.pending), ("h1", 2.0, true));
    let p = w("b.json", "12345678");
    assert_eq!((p.last_blocked.as_str(), p.blocks, p.pending), ("12345678", 0.0, false));
    let p = w("c.json", "3f2a9c");
    assert_eq!((p.last_blocked.as_str(), p.pending), ("", false));
    let p = w("d.json", r#"{"hash":5,"blocks":"3"}"#);
    assert_eq!((p.last_blocked.as_str(), p.blocks), ("", 0.0));
    assert!(read_prior(&d.join("missing.json")).is_ok());
    assert!(std::fs::write(d.join("e.json"), r#"{"7":1}"#).is_ok() && read_prior(&d.join("e.json")).is_err());
}
