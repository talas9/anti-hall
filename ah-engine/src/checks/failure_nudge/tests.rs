//! Unit tests of the failure-root-cause-nudge check. The full Node-vs-engine comparison is
//! `tests/node_parity` (the Rust Node-parity test); these pin the behaviours that run without a Node install.
use super::expected::{exit_code_of, is_expected_nonzero, is_harness_refusal, split_top};
use super::*;
use serde_json::json;
use std::collections::HashMap;

fn settings(home: &str) -> Settings {
    Settings { home: home.to_string(), env: HashMap::new() }
}

fn tmp_home(tag: &str) -> String {
    let d = std::env::temp_dir().join(format!("ah-frn-{tag}-{}", std::process::id()));
    crate::discard::harmless(std::fs::remove_dir_all(&d));
    std::fs::create_dir_all(d.join(".anti-hall")).unwrap();
    d.to_string_lossy().to_string()
}

fn failure(sid: &str, cmd: &str, err: &str) -> Value {
    json!({"hook_event_name": "PostToolUseFailure", "tool_name": "Bash", "session_id": sid, "tool_input": {"command": cmd}, "error": err})
}

fn text(v: Option<Verdict>) -> Option<String> {
    match v {
        Some(Verdict::Advisory(j)) => Some(j),
        None => None,
        other => panic!("unexpected verdict {other:?}"),
    }
}

#[test]
fn predicates_that_exit_one_are_expected_and_everything_unclear_is_not() {
    let one = "Exit code 1\n";
    for c in [
        "grep -q foo file",
        "test -f /nonexistent",
        "[ -d /x ]",
        "git diff --quiet",
        "git -C /r merge-base --is-ancestor a b",
        "command -v node",
        "cat f | grep x",
        "echo hi && grep x f",
        "echo a; grep x f",
        "FOO=1 env grep x f",
        "grep a f 2>/dev/null",
        "a \\\n| grep x",
    ] {
        assert!(is_expected_nonzero(c, one), "{c}");
    }
    for c in [
        "npm test",
        "git diff",
        "grep a f || echo no",
        "if grep a f; then echo y; fi",
        "set -e; grep a f",
        "grep a f &",
        "cat <<EOF\nx\nEOF",
        "echo $(grep a f)",
        "grep a f | wc -l",
        "(grep a f)",
        "! grep a f",
        "echo 'unbalanced",
        "grep a f && npm test",
        "",
    ] {
        assert!(!is_expected_nonzero(c, one), "{c}");
    }
    // only exactly exit code 1 counts
    for e in ["Exit code 2\n", "Exit code 0", "Exit code 10", "Exit code 1abc", "", "exit code 1"] {
        assert!(!is_expected_nonzero("grep a f", e), "{e:?}");
    }
    assert!(is_expected_nonzero("grep a f", "Exit code 01\n") && is_expected_nonzero("grep a f", "  Exit code 1"));
    assert_eq!(exit_code_of("Exit code 007 x").as_deref(), Some("7"));
    assert!(is_harness_refusal("This agent is isolated in the worktree /x") && !is_harness_refusal("This workspace is isolated in the worktree"));
}

#[test]
fn split_top_ignores_quoted_and_nested_separators() {
    assert_eq!(split_top("a;b", &[";"]).unwrap(), ["a", "b"]);
    assert_eq!(split_top("a ';' b;c", &[";"]).unwrap(), ["a ';' b", "c"]);
    assert_eq!(split_top("a $(b;c) d;e", &[";"]).unwrap(), ["a $(b;c) d", "e"]);
    // Node opens a depth at `$(` inside double quotes and never closes it there (the quote branch swallows the `)`), so the
    // separator after it is not top-level: kept as it is, expected value computed with the Node function
    assert_eq!(split_top("a \"x;$(y;z)\" ;b", &[";"]).unwrap(), ["a \"x;$(y;z)\" ;b"]);
    assert_eq!(split_top("a|&b|c", &["|&", "|"]).unwrap(), ["a", "b", "c"]);
    assert!(split_top("echo 'open", &[";"]).is_none());
}

#[test]
fn the_advisory_has_the_node_bytes_and_a_failed_command_is_shown_cut() {
    let home = tmp_home("bytes");
    let st = settings(&home);
    let out = text(decide(&failure("s", "  npm   test\n", "Exit code 2"), &st)).expect("nudge");
    assert_eq!(
        out,
        "{\"hookSpecificOutput\":{\"hookEventName\":\"PostToolUseFailure\",\"additionalContext\":\"\u{1f4a1} anti-hall \u{b7} root-cause: this command failed (`npm test`).\\nDo instead: before retrying or patching, trace WHY it failed (see /anti-hall:root-cause) rather than guessing a fix from the symptom.\"}}"
    );
    let long = text(decide(&failure("s", &"x".repeat(100), "Exit code 2"), &st)).unwrap();
    assert!(long.contains(&format!("(`{}\u{2026}`)", "x".repeat(80))), "{long}");
    let none = text(decide(&failure("s", "", "Exit code 2"), &st)).unwrap();
    assert!(none.contains("this command failed.\\n"), "{none}");
    // a cut inside a surrogate pair cannot be represented: defer to Node
    let cmd = format!("{}\u{1F600}tail", "a".repeat(79));
    assert_eq!(decide(&failure("s", &cmd, "Exit code 2"), &st), Some(Verdict::Defer));
}

#[test]
fn only_bash_failures_that_are_real_get_a_nudge() {
    let home = tmp_home("filter");
    let st = settings(&home);
    assert!(decide(&json!({"tool_name": "Edit", "tool_input": {"command": "x"}}), &st).is_none());
    assert!(decide(&json!([1]), &st).is_none());
    assert!(decide(&failure("s", "grep a f", "Exit code 1\n"), &st).is_none(), "expected exit 1");
    assert!(decide(&failure("s", "false", "This session is isolated in the worktree x"), &st).is_none(), "harness refusal");
    let mut interrupted = failure("s", "false", "Exit code 130");
    interrupted["is_interrupt"] = json!(true);
    assert!(decide(&interrupted, &st).is_none());
    assert!(decide(&failure("s", "false", "Exit code 2"), &st).is_some());
}

fn transcript(home: &str, name: &str, body: &str) -> String {
    let p = format!("{home}/{name}");
    std::fs::write(&p, body).unwrap();
    p
}

#[test]
fn one_nudge_per_turn_per_session_and_a_new_prompt_starts_a_new_turn() {
    let home = tmp_home("turn");
    let st = settings(&home);
    let t1 =
        transcript(&home, "t1.jsonl", "{\"type\":\"user\",\"uuid\":\"u1\",\"message\":{\"content\":\"first\"}}\n{\"type\":\"assistant\",\"uuid\":\"a1\"}\n");
    let t2 = transcript(
        &home,
        "t2.jsonl",
        "{\"type\":\"user\",\"uuid\":\"u1\",\"message\":{\"content\":\"first\"}}\n{\"type\":\"user\",\"uuid\":\"u2\",\"message\":{\"content\":[{\"type\":\"text\",\"text\":\"second\"}]}}\n{\"type\":\"user\",\"uuid\":\"u3\",\"message\":{\"content\":[{\"type\":\"tool_result\"}]}}\n{\"type\":\"user\",\"uuid\":\"u4\",\"message\":{\"content\":\"<system-reminder>x</system-reminder>\"}}\n",
    );
    let with = |sid: &str, tp: &str| {
        let mut p = failure(sid, "false", "Exit code 2");
        p["transcript_path"] = json!(tp);
        p
    };
    assert!(decide(&with("s", &t1), &st).is_some());
    assert!(decide(&with("s", &t1), &st).is_none(), "second in the same turn");
    assert!(decide(&with("other", &t1), &st).is_some(), "another session");
    assert!(decide(&with("s", &t2), &st).is_some(), "the newest human prompt (u2) is a new turn; the tool result and injected entry are not prompts");
    assert!(decide(&with("s", &t2), &st).is_none());
    // the state is the Node file, with the Node bytes
    assert_eq!(
        std::fs::read_to_string(format!("{home}/.anti-hall/turn-gate/tg-s.json")).unwrap(),
        r#"{"failure-root-cause-nudge|main":{"turn":"u2","sigs":[""]}}"#
    );
    // a subagent's turn is its whole run
    let mut sub = with("s", &t1);
    sub["agent_id"] = json!("ag1");
    assert!(decide(&sub, &st).is_some() && decide(&sub, &st).is_none());
    // a turn that cannot be told never suppresses
    assert!(decide(&failure("s", "false", "Exit code 2"), &st).is_some() && decide(&failure("s", "false", "Exit code 2"), &st).is_some());
}

#[test]
fn state_files_of_an_unexpected_shape_behave_as_node_does() {
    let home = tmp_home("shapes");
    let st = settings(&home);
    let t = transcript(&home, "t.jsonl", "{\"type\":\"user\",\"uuid\":\"u1\",\"message\":{\"content\":\"p\"}}\n");
    let dir = format!("{home}/.anti-hall/turn-gate");
    std::fs::create_dir_all(&dir).unwrap();
    let mk = |sid: &str| {
        let mut p = failure(sid, "false", "Exit code 2");
        p["transcript_path"] = json!(t);
        p
    };
    // (state text, file after the first call: None = untouched)
    for (name, body, after) in [
        ("corrupt", "{nope", Some(r#"{"failure-root-cause-nudge|main":{"turn":"u1","sigs":[""]}}"#)),
        ("arr", "[1,2]", Some("[1,2]")),
        ("num", "5", None),
        ("str", "\"x\"", None),
        ("zero", "0", Some(r#"{"failure-root-cause-nudge|main":{"turn":"u1","sigs":[""]}}"#)),
        ("nul", "null", Some(r#"{"failure-root-cause-nudge|main":{"turn":"u1","sigs":[""]}}"#)),
        (
            "keys",
            r#"{"z":1,"10":2,"2":3,"a":{"y":1,"b":2}}"#,
            Some(r#"{"2":3,"10":2,"z":1,"a":{"y":1,"b":2},"failure-root-cause-nudge|main":{"turn":"u1","sigs":[""]}}"#),
        ),
    ] {
        let path = format!("{dir}/tg-{name}.json");
        std::fs::write(&path, body).unwrap();
        assert!(decide(&mk(name), &st).is_some(), "{name}: the first nudge is shown");
        let now = std::fs::read_to_string(&path).unwrap();
        assert_eq!(now, after.unwrap_or(body), "{name}");
    }
}

#[test]
fn switches_and_skip_silence_it() {
    let home = tmp_home("switch");
    let on = settings(&home);
    assert!(decide(&failure("s", "false", "Exit code 2"), &on).is_some());
    std::fs::write(format!("{home}/.anti-hall/settings.json"), r#"{"guards":{"failureRootCauseNudge":false}}"#).unwrap();
    assert!(decide(&failure("s", "false", "Exit code 2"), &settings(&home)).is_none());
    std::fs::write(format!("{home}/.anti-hall/settings.json"), r#"{"guards":{"failureNudgeFilter":false}}"#).unwrap();
    assert!(decide(&failure("s", "grep a f", "Exit code 1\n"), &settings(&home)).is_some(), "filter off nudges on every non-zero exit");
    std::fs::write(format!("{home}/.anti-hall/settings.json"), "{}").unwrap();
    let future = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis() + 3_600_000;
    std::fs::write(format!("{home}/.anti-hall/skip.json"), format!("{{\"failure-root-cause-nudge\":{future}}}")).unwrap();
    assert!(decide(&failure("s", "false", "Exit code 2"), &settings(&home)).is_none());
}

#[test]
fn no_home_defers_only_when_the_turn_gate_would_need_it() {
    let none = settings("");
    assert_eq!(decide(&failure("s", "false", "Exit code 2"), &none), Some(Verdict::Defer));
    assert!(decide(&failure("s", "grep a f", "Exit code 1\n"), &none).is_none(), "an expected exit needs no state");
    let mut nosid = failure("s", "false", "Exit code 2");
    nosid.as_object_mut().unwrap().remove("session_id");
    assert!(text(decide(&nosid, &none)).is_some(), "no session id: never gated");
}
