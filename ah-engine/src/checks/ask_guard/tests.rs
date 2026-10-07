//! Unit tests of the ask_guard check (parity with the Node hook is in tests/agent_controls_parity.rs).
use super::*;

fn env(pairs: &[(&str, &str)]) -> RequestEnv {
    RequestEnv::from_pairs(pairs.iter().map(|(k, v)| (k.to_string(), v.to_string())))
}

fn home(tag: &str) -> String {
    let d = std::env::temp_dir().join(format!("ah-askg-{tag}-{}", std::process::id()));
    crate::discard::harmless(std::fs::remove_dir_all(&d));
    std::fs::create_dir_all(d.join(".anti-hall")).unwrap();
    d.to_string_lossy().to_string()
}

fn ask(header: &str) -> Value {
    serde_json::json!({"tool_name": "AskUserQuestion", "tool_input": {"questions": [{"header": header, "question": "q"}]}})
}

#[test]
fn off_is_silent_and_block_needs_a_marker() {
    let h = home("block");
    let off = decide(&ask("h"), &env(&[("HOME", &h), ("ANTIHALL_QUESTION_AGENTS_NOTE", "off")]));
    assert_eq!(off, Verdict::Allow);
    let e = env(&[("HOME", &h), ("ANTIHALL_NO_BLOCKING_QUESTIONS", "block")]);
    let Verdict::Exact(x) = decide(&ask("h"), &e) else { panic!("a plain question must block") };
    assert_eq!(x.code, 2);
    assert!(x.out.starts_with("{\"decision\":\"block\",\"reason\":\"") && x.out.ends_with("\"}\n") && x.err.is_empty());
    assert_eq!(decide(&ask("DESTRUCTIVE: x"), &e), Verdict::Allow);
    assert!(std::fs::read_to_string(format!("{h}/.anti-hall/logs/ask-guard.ndjson")).unwrap().contains("\"marker\":\"DESTRUCTIVE\""));
}

#[test]
fn a_request_without_home_defers() {
    assert_eq!(decide(&ask("h"), &env(&[("ANTIHALL_NO_BLOCKING_QUESTIONS", "block")])), Verdict::Defer);
}

#[test]
fn the_child_text_is_added_only_for_a_nonblank_branch() {
    let h = home("child");
    let adv = |branch: &str| match decide(&ask("h"), &env(&[("HOME", &h), ("ANTIHALL_NO_BLOCKING_QUESTIONS", "advise"), ("DEVSWARM_SOURCE_BRANCH", branch)])) {
        Verdict::Advisory(j) => j,
        v => panic!("{v:?}"),
    };
    assert!(adv("feat/x").contains("Child workspace: send the question to your parent"));
    assert!(!adv(" \u{a0}").contains("Child workspace"));
}
