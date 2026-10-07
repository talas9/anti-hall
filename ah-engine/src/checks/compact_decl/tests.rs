//! Unit tests of the compact-declaration-guard check. The full Node-vs-engine comparison is
//! `parity/run-compact-declaration-guard.js`.
use super::*;
use serde_json::json;
use std::collections::HashMap;

fn home(tag: &str) -> String {
    let d = std::env::temp_dir().join(format!("ah-cd-{tag}-{}", std::process::id()));
    crate::discard::harmless(std::fs::remove_dir_all(&d));
    std::fs::create_dir_all(d.join(".anti-hall")).unwrap();
    d.to_string_lossy().to_string()
}

fn settings(h: &str) -> Settings {
    Settings { home: h.to_string(), env: HashMap::new() }
}

fn transcript(h: &str, name: &str, lines: &[String]) -> String {
    let p = format!("{h}/{name}.jsonl");
    std::fs::write(&p, lines.join("\n")).unwrap();
    p
}

fn user(t: &str) -> String {
    json!({"type": "user", "message": {"role": "user", "content": t}}).to_string()
}

fn asst(t: &str) -> String {
    json!({"type": "assistant", "message": {"role": "assistant", "content": [{"type": "text", "text": t}]}}).to_string()
}

fn call(tool: &str, input: Value, tp: &str) -> Value {
    json!({"tool_name": tool, "cwd": "/work/proj", "transcript_path": tp, "tool_input": input})
}

#[test]
fn bash_work_follows_the_node_patterns() {
    for c in [
        "git commit -am x",
        "git push origin dev",
        "git tag v1",
        "gh pr merge 3",
        "sed -i s/a/b/ f",
        "npm install",
        "cd x && rm -rf y",
        "echo hi > out.txt",
        "echo hi >> out.txt",
        "make",
        "(cp a b)",
        "ls | tee f",
        "patch -p1 < x",
    ] {
        assert!(bash_is_work(c), "{c}");
    }
    for c in ["ls", "git status", "echo \"git push\"", "echo 'rm -rf x'", "cat f 2>&1", "cmd >&2", "echo x 1>&2", "git log", "format x", "x=a\nswarm"] {
        assert!(!bash_is_work(c), "{c}");
    }
}

#[test]
fn redirects_that_duplicate_a_descriptor_are_not_file_writes() {
    for (s, want) in [
        ("a > b", true),
        ("a >> b", true),
        ("a 2> b", false),
        ("a >&2", false),
        ("a 2>&1", false),
        ("a>b", true),
        ("a >>&2", true),
        ("1>f", false),
        ("a &>f", false),
        (">f", true),
    ] {
        assert_eq!(has_file_redirect(s), want, "{s}");
    }
}

#[test]
fn quoted_text_is_blanked_before_matching() {
    assert_eq!(neutralize_quoted("echo \"a b\" 'c' d"), format!("echo{}d", " ".repeat(11)));
    assert_eq!(neutralize_quoted("x \"unclosed rm"), format!("x{}", " ".repeat(13)));
    assert_eq!(neutralize_quoted("a \"q\\\"r\" b"), format!("a{}b", " ".repeat(8)));
}

#[test]
fn handover_files_are_exempt_resolved_against_the_cwd() {
    let p = |tool: &str, fp: &str, cwd: Option<&str>| {
        let mut v = json!({"tool_name": tool, "tool_input": {"file_path": fp}});
        if let Some(c) = cwd {
            v["cwd"] = json!(c);
        }
        v
    };
    assert_eq!(is_handover_edit(&p("Write", ".anti-hall/handovers/h.md", Some("/w"))), Some(true));
    assert_eq!(is_handover_edit(&p("Write", "/w/.anti-hall/handovers/a/b.md", None)), Some(true));
    assert_eq!(is_handover_edit(&p("Write", ".anti-hall/handovers/../h.md", Some("/w"))), Some(false));
    assert_eq!(is_handover_edit(&p("Write", ".anti-hall/handovers-x/h.md", Some("/w"))), Some(false));
    assert_eq!(is_handover_edit(&p("Write", ".anti-hall/handovers", Some("/w"))), Some(false));
    assert_eq!(is_handover_edit(&p("Write", ".anti-hall/handovers/h.md", None)), None, "a relative path needs the cwd");
    assert_eq!(is_handover_edit(&p("Write", ".anti-hall/handovers/h.md", Some("rel"))), None);
}

#[test]
fn only_work_with_a_possible_declaration_in_the_turn_is_deferred() {
    let h = home("flow");
    let st = settings(&h);
    let declared = transcript(&h, "declared", &[user("go"), asst("done"), asst("\u{2705} SAFE TO COMPACT")]);
    let plain = transcript(&h, "plain", &[user("go"), asst("all fine, this is safe code")]);
    let reset = transcript(&h, "reset", &[asst("SAFE TO COMPACT"), user("next")]);
    assert_eq!(decide(&call("Write", json!({"file_path": "a.js"}), &declared), &st), Some(Verdict::Defer));
    assert_eq!(decide(&call("Bash", json!({"command": "git commit -am x"}), &declared), &st), Some(Verdict::Defer));
    assert!(decide(&call("Bash", json!({"command": "ls"}), &declared), &st).is_none(), "read-only is not new work");
    assert!(decide(&call("Read", json!({"file_path": "a"}), &declared), &st).is_none());
    assert!(decide(&call("Write", json!({"file_path": "/w/.anti-hall/handovers/h.md"}), &declared), &st).is_none(), "refreshing the handover is exempt");
    assert_eq!(decide(&call("Agent", json!({}), &plain), &st), Some(Verdict::Defer), "the word safe is only a possible declaration");
    assert!(decide(&call("Agent", json!({}), &reset), &st).is_none(), "a real user message starts a new turn");
}

#[test]
fn injected_entries_do_not_reset_the_turn_but_real_prompts_do() {
    let h = home("reset");
    let st = settings(&h);
    let not_reset = [
        "<task-notification>x</task-notification>",
        "<local-command-stdout>x</local-command-stdout>",
        "<system-reminder>r</system-reminder>",
        "<command-name>/compact</command-name>",
        "   ",
    ];
    for (i, t) in not_reset.iter().enumerate() {
        let tp = transcript(&h, &format!("n{i}"), &[asst("SAFE TO COMPACT"), user(t)]);
        assert_eq!(decide(&call("Write", json!({"file_path": "a"}), &tp), &st), Some(Verdict::Defer), "{t}");
    }
    let tp = transcript(&h, "real", &[asst("SAFE TO COMPACT"), user("<system-reminder>r</system-reminder>now do this")]);
    assert!(decide(&call("Write", json!({"file_path": "a"}), &tp), &st).is_none());
}

#[test]
fn codex_rollout_entries_are_classified() {
    let h = home("codex");
    let st = settings(&h);
    let asst_cx = |t: &str| {
        json!({"type": "response_item", "payload": {"type": "message", "role": "assistant", "content": [{"type": "output_text", "text": t}]}}).to_string()
    };
    let user_cx = |t: &str| json!({"type": "event_msg", "payload": {"type": "user_message", "message": t}}).to_string();
    let tp = transcript(&h, "cx1", &[user_cx("go"), asst_cx("SAFE TO COMPACT")]);
    assert_eq!(decide(&call("Write", json!({"file_path": "a"}), &tp), &st), Some(Verdict::Defer));
    let tp = transcript(&h, "cx2", &[asst_cx("SAFE TO COMPACT"), user_cx("next")]);
    assert!(decide(&call("Write", json!({"file_path": "a"}), &tp), &st).is_none());
}

#[test]
fn escapes_and_damaged_lines_are_never_guessed() {
    let h = home("damage");
    let st = settings(&h);
    let escaped = transcript(&h, "esc", &[r#"{"type":"assistant","message":{"content":[{"type":"text","text":"safe to compact"}]}}"#.to_string()]);
    assert_eq!(decide(&call("Write", json!({"file_path": "a"}), &escaped), &st), Some(Verdict::Defer), "an escape can spell the word");
    let lone = transcript(&h, "lone", &[user("go"), r#"{"type":"assistant","message":{"content":[{"type":"text","text":"x \ud83d y"}]}}"#.to_string()]);
    assert_eq!(decide(&call("Write", json!({"file_path": "a"}), &lone), &st), Some(Verdict::Defer), "serde rejects a lone surrogate, Node accepts it");
    let bad = transcript(&h, "bad", &[user("go"), "{not json".to_string(), asst("fine")]);
    assert!(decide(&call("Write", json!({"file_path": "a"}), &bad), &st).is_none());
}

#[test]
fn a_declaration_beyond_the_tail_is_not_seen() {
    let h = home("tail");
    let st = settings(&h);
    let filler: Vec<String> = (0..4000).map(|i| asst(&format!("filler {i} {}", "x".repeat(400)))).collect();
    let mut start = vec![user("go"), asst("SAFE TO COMPACT")];
    start.extend(filler.clone());
    let tp = transcript(&h, "big-start", &start);
    assert!(decide(&call("Write", json!({"file_path": "a"}), &tp), &st).is_none(), "only the last 1.5 MB is read");
    let mut end = filler;
    end.push(asst("SAFE TO COMPACT"));
    let tp = transcript(&h, "big-end", &end);
    assert_eq!(decide(&call("Write", json!({"file_path": "a"}), &tp), &st), Some(Verdict::Defer));
}

#[test]
fn missing_empty_relative_and_skipped_cases_allow_or_defer_like_node() {
    let h = home("misc");
    let st = settings(&h);
    assert!(decide(&call("Write", json!({"file_path": "a"}), &format!("{h}/missing.jsonl")), &st).is_none());
    let empty = transcript(&h, "empty", &[]);
    assert!(decide(&call("Write", json!({"file_path": "a"}), &empty), &st).is_none());
    assert!(decide(&json!({"tool_name": "Write", "tool_input": {"file_path": "a"}}), &st).is_none(), "no transcript path");
    assert_eq!(decide(&call("Write", json!({"file_path": "a"}), "t/x.jsonl"), &st), Some(Verdict::Defer), "a relative path is relative to Node's directory");
    let mut sub = call("Write", json!({"file_path": "a"}), &empty);
    sub["agent_id"] = json!("a1");
    assert!(decide(&sub, &st).is_none());
    std::fs::write(format!("{h}/.anti-hall/settings.json"), r#"{"guards":{"compactDeclarationGuard":false}}"#).unwrap();
    let declared = transcript(&h, "d", &[asst("SAFE TO COMPACT")]);
    assert!(decide(&call("Write", json!({"file_path": "a"}), &declared), &st).is_none(), "the switch is off");
}

#[test]
fn run_without_the_payload_defers() {
    let ti = json!({"file_path": "a.js"});
    let s = Subject { event: "PreToolUse", tool: Some("Write"), cwd: None, tool_input: &ti, prompt: None };
    assert_eq!(CompactDeclarationGuard.run(&s, &Value::Null), Some(Verdict::Defer));
}

/// Review P2: a line serde rejects only for a number out of range (JS reads a 400-digit integer as Infinity and parses the
/// line) that holds the safe word must defer to Node, never be skipped as "invalid for both".
#[test]
fn a_rejected_line_holding_the_safe_word_defers() {
    let h = home("bigint");
    let st = settings(&h);
    let digits = "9".repeat(400);
    let big = format!(r#"{{"type":"assistant","n":{digits},"message":{{"content":[{{"type":"text","text":"SAFE TO COMPACT"}}]}}}}"#);
    assert!(serde_json::from_str::<Value>(&big).is_err(), "the premise: serde rejects the literal");
    let tp = transcript(&h, "big", &[user("go"), big]);
    assert_eq!(decide(&call("Write", json!({"file_path": "a"}), &tp), &st), Some(Verdict::Defer));
    let upper = transcript(
        &h,
        "bigl",
        &[user("go"), format!(r#"{{"type":"assistant","n":{digits},"message":{{"content":[{{"type":"text","text":"is it Safe?"}}]}}}}"#)],
    );
    assert_eq!(decide(&call("Write", json!({"file_path": "a"}), &upper), &st), Some(Verdict::Defer), "any case");
    let no_word =
        transcript(&h, "bign", &[user("go"), format!(r#"{{"type":"assistant","n":{digits},"message":{{"content":[{{"type":"text","text":"fine"}}]}}}}"#)]);
    assert!(decide(&call("Write", json!({"file_path": "a"}), &no_word), &st).is_none(), "a rejected line without the word cannot declare");
}
