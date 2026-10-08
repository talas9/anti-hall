use super::*;
use serde_json::json;

fn st(home: &str) -> Settings {
    Settings { home: home.into(), env: Default::default() }
}

#[test]
fn a_payload_without_a_transcript_path_does_nothing() {
    for p in [json!({}), json!(null), json!({"transcript_path": ""}), json!({"transcript_path": 5})] {
        assert_eq!(decide(&p, &st("/nonexistent-home")), Verdict::Allow, "{p}");
    }
}

#[test]
fn an_unreadable_transcript_is_an_empty_task_list() {
    let p = json!({"transcript_path": "/nonexistent/transcript.jsonl", "session_id": "s"});
    assert_eq!(decide(&p, &st("/nonexistent-home")), Verdict::Allow);
}

#[test]
fn one_line_cuts_like_javascript_and_refuses_a_split_pair() {
    assert_eq!(demand::one_line("  a\tb\u{7}c  ", 60), Ok("a b c".to_string()));
    assert_eq!(demand::one_line("abcdef  ghi", 8), Ok("abcdef g…".to_string()));
    assert_eq!(demand::one_line(&format!("{}\u{1f600}", "y".repeat(3)), 4), Err(Unsure));
}

#[test]
fn a_label_numbers_a_numeric_task_and_strips_a_priority_prefix() {
    let mut t = crate::checks::taskstate::Task::unseen("3");
    t.content = "P1: ship it".into();
    assert_eq!(demand::label(&t), Ok("#3 \"ship it\"".to_string()));
    t.content = "3".into();
    assert_eq!(demand::label(&t), Ok("#3".to_string()));
    let mut named = crate::checks::taskstate::Task::unseen("todo item");
    named.content = "todo item".into();
    assert_eq!(demand::label(&named), Ok("\"todo item\"".to_string()));
}

#[test]
fn a_task_clock_takes_the_create_time_only_when_it_is_later_and_never_guesses() {
    use crate::checks::taskstate::Since;
    // `if (!(existing >= rec)) existing = rec`
    assert_eq!(Since::Ms(5.0).merge_create(Since::Ms(3.0)), Since::Ms(5.0));
    assert_eq!(Since::Ms(3.0).merge_create(Since::Ms(5.0)), Since::Ms(5.0));
    assert_eq!(Since::Unknown.merge_create(Since::Ms(5.0)), Since::Ms(5.0));
    assert_eq!(Since::Ms(5.0).merge_create(Since::Unknown), Since::Ms(5.0));
    assert_eq!(Since::Ms(5.0).merge_create(Since::Unsure), Since::Unsure);
    assert!(Since::Unsure.value().is_err());
}
