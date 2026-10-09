//! Unit tests of the turn reading behind the `turnText` host primitive. The check built on it is the plugin script
//! `compact-declaration-guard.js`, whose golden corpus is `tests/golden/compact-declaration-guard.jsonl`.
use super::*;
use serde_json::json;

fn user(t: &str) -> String {
    json!({"type": "user", "message": {"role": "user", "content": t}}).to_string()
}

fn asst(t: &str) -> String {
    json!({"type": "assistant", "message": {"role": "assistant", "content": [{"type": "text", "text": t}]}}).to_string()
}

fn texts(lines: &[String]) -> Option<Vec<String>> {
    turn_texts(lines)
}

#[test]
fn injected_entries_do_not_reset_the_turn_but_real_prompts_do() {
    for t in ["<task-notification>x</task-notification>", "<local-command-stdout>x</local-command-stdout>", "<system-reminder>r</system-reminder>", "<command-name>/compact</command-name>", "   "] {
        assert_eq!(texts(&[asst("SAFE TO COMPACT"), user(t)]), Some(vec!["SAFE TO COMPACT".to_string()]), "{t}");
    }
    assert_eq!(texts(&[asst("SAFE TO COMPACT"), user("<system-reminder>r</system-reminder>now do this")]), Some(vec![]));
}

#[test]
fn codex_rollout_entries_are_classified() {
    let asst_cx = |t: &str| json!({"type": "response_item", "payload": {"type": "message", "role": "assistant", "content": [{"type": "output_text", "text": t}]}}).to_string();
    let user_cx = |t: &str| json!({"type": "event_msg", "payload": {"type": "user_message", "message": t}}).to_string();
    assert_eq!(texts(&[user_cx("go"), asst_cx("SAFE TO COMPACT")]), Some(vec!["SAFE TO COMPACT".to_string()]));
    assert_eq!(texts(&[asst_cx("SAFE TO COMPACT"), user_cx("next")]), Some(vec![]));
}

#[test]
fn a_line_only_javascript_reads_is_never_guessed() {
    assert!(texts(&[r#"{"type":"assistant","message":{"content":[{"type":"text","text":"x \ud83d y"}]}}"#.to_string()]).is_none(), "serde rejects a lone surrogate, Node accepts it");
    assert_eq!(texts(&[user("go"), "{not json".to_string(), asst("fine")]), Some(vec!["fine".to_string()]));
}

#[test]
fn the_tail_drops_a_partial_first_line_and_a_missing_file_has_none() {
    let d = std::env::temp_dir().join(format!("ah-cd-tail-{}", std::process::id()));
    crate::discard::harmless(std::fs::remove_dir_all(&d)); // keep: cleanup that raced; an absent dir is the goal state
    std::fs::create_dir_all(&d).unwrap();
    let f = d.join("t.jsonl");
    std::fs::write(&f, "aaaa\nbbbb\ncccc").unwrap();
    assert_eq!(read_tail(f.to_str().unwrap(), 100), Some(vec!["aaaa".into(), "bbbb".into(), "cccc".into()]));
    // a window that does not reach the start of the file always drops its first line (it may be a partial one), as Node's tail reader does
    assert_eq!(read_tail(f.to_str().unwrap(), 9), Some(vec!["cccc".into()]));
    assert_eq!(read_tail(f.to_str().unwrap(), 11), Some(vec!["bbbb".into(), "cccc".into()]));
    assert!(read_tail(d.join("missing").to_str().unwrap(), 9).is_none());
    assert!(contains_ci(b"it is Safe to", b"SAFE") && !contains_ci(b"abc", b""));
    crate::discard::harmless(std::fs::remove_dir_all(&d)); // keep: cleanup that raced; an absent dir is the goal state
}
