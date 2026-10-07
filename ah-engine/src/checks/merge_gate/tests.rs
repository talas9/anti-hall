//! Unit tests of the merge-gate check. The full Node-vs-engine comparison is `parity/run-merge-gate.js`.
use super::*;
use serde_json::json;
use std::collections::HashMap;

fn settings(home: &str, on: bool) -> Settings {
    let mut env = HashMap::new();
    if on {
        env.insert("ANTIHALL_MERGE_GATE".to_string(), "1".to_string());
    }
    Settings { home: home.to_string(), env }
}

fn dir(tag: &str) -> String {
    let d = std::env::temp_dir().join(format!("ah-mg-{tag}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&d);
    std::fs::create_dir_all(d.join(".anti-hall")).unwrap();
    d.to_string_lossy().to_string()
}

fn assistant(text: &str) -> String {
    json!({"type": "assistant", "message": {"content": [{"type": "text", "text": text}]}}).to_string()
}

fn payload(cmd: &str, tp: Option<&str>) -> Value {
    let mut p = json!({"tool_name": "Bash", "tool_input": {"command": cmd}});
    if let Some(t) = tp {
        p["transcript_path"] = json!(t);
    }
    p
}

#[test]
fn auto_merge_shapes_match_the_node_scan() {
    for c in [
        "gh pr merge 5",
        "gh pr review 3 --approve",
        "git merge --no-ff main",
        "git merge --ff-only origin/main",
        "FOO=1 BAR=2 gh pr merge 2",
        "cd x && gh pr merge 9",
        "cat <<EOF\ngh pr merge 1\nEOF",
        "hivecontrol workspace merge-into-source",
        "hivecontrol workspace merge-from-source x",
        "gh\u{a0}pr\u{a0}merge 4",
    ] {
        assert!(is_auto_merge(c), "{c:?}");
    }
    for c in ["echo gh pr merge 5", "git merge feature", "git merge --no-ff feature", "gh pr view 3", "gh pr review 3 --comment", "gh", "git merge", "", "GH pr merge 1", "gh pr 'merge' 1"] {
        assert!(!is_auto_merge(c), "{c:?}");
    }
}

#[test]
fn the_gate_is_off_by_default_and_a_skip_allows() {
    let d = dir("off");
    let t = format!("{d}/t.jsonl");
    std::fs::write(&t, assistant("do not merge")).unwrap();
    assert_eq!(decide(&payload("gh pr merge 1", Some(&t)), &settings(&d, false)), Verdict::Allow);
    std::fs::write(format!("{d}/.anti-hall/skip.json"), format!("{{\"merge-gate\": {}}}", u64::MAX as f64)).unwrap();
    assert_eq!(decide(&payload("gh pr merge 1", Some(&t)), &settings(&d, true)), Verdict::Allow);
}

#[test]
fn a_hedge_in_the_assistant_text_defers_and_everything_else_is_allowed() {
    let d = dir("hedge");
    let st = settings(&d, true);
    let t = format!("{d}/t.jsonl");
    std::fs::write(&t, format!("{}\n", assistant("this is a First-Pass"))).unwrap();
    assert_eq!(decide(&payload("gh pr merge 1", Some(&t)), &st), Verdict::Defer);
    assert_eq!(decide(&payload("git status", Some(&t)), &st), Verdict::Allow, "not an auto-merge command");
    std::fs::write(&t, format!("{}\n", assistant("all done"))).unwrap();
    assert_eq!(decide(&payload("gh pr merge 1", Some(&t)), &st), Verdict::Allow);
    assert_eq!(decide(&payload("gh pr merge 1", None), &st), Verdict::Allow, "no transcript");
    assert_eq!(decide(&payload("gh pr merge 1", Some(&format!("{d}/missing.jsonl"))), &st), Verdict::Allow, "unreadable transcript");
    assert_eq!(decide(&payload("gh pr merge 1", Some("rel/t.jsonl")), &st), Verdict::Defer, "a relative path is Node's to resolve");
}

#[test]
fn a_line_the_engine_cannot_parse_defers_and_a_user_hedge_does_not_count() {
    let d = dir("bad");
    let st = settings(&d, true);
    let t = format!("{d}/t.jsonl");
    std::fs::write(&t, "{broken\n").unwrap();
    assert_eq!(decide(&payload("gh pr merge 1", Some(&t)), &st), Verdict::Defer);
    std::fs::write(&t, format!("{}\n", json!({"type": "user", "message": {"content": "pending review"}}))).unwrap();
    assert_eq!(decide(&payload("gh pr merge 1", Some(&t)), &st), Verdict::Allow);
}

#[test]
fn only_the_window_at_the_end_of_the_transcript_is_read() {
    let d = dir("window");
    let st = settings(&d, true);
    let t = format!("{d}/t.jsonl");
    let filler = assistant(&"y".repeat(400));
    let mut body = format!("{}\n", assistant("pending review"));
    for _ in 0..400 {
        body.push_str(&filler);
        body.push('\n');
    }
    std::fs::write(&t, &body).unwrap();
    assert_eq!(decide(&payload("gh pr merge 1", Some(&t)), &st), Verdict::Allow, "the hedge is before the window");
}

#[test]
fn every_hedge_phrase_is_found_in_any_case() {
    for h in defaults::list("merge_gate.hedge_phrases") {
        assert!(has_hedge(&h.to_uppercase()), "{h}");
    }
    assert!(has_hedge("First-Pass") && has_hedge("first pass") && has_hedge("NOT PIXEL PERFECT"));
    assert!(!has_hedge("first_pass") && !has_hedge("pending  review"));
}
