//! Unit tests of the output-verify-guard check; the Node-vs-engine comparison is tests/response_guards_parity.rs.
use super::*;
use serde_json::json;

fn hit(list: &str, text: &str) -> Option<String> {
    let p = pats();
    first_match(if list == "fail" { &p.fail } else { &p.pass }, text, false)
}

#[test]
fn a_zero_count_is_not_a_failure_but_a_later_non_zero_count_is() {
    assert_eq!(hit("fail", "test result: ok. 5 passed; 0 failed; 0 ignored"), None);
    assert_eq!(hit("fail", "0 failed, then 4 failed").as_deref(), Some("4 failed"));
    assert_eq!(hit("pass", "0 passed").as_deref(), None);
    assert_eq!(hit("pass", "8 PASSED").as_deref(), Some("8 PASSED"));
}

#[test]
fn line_start_patterns_only_match_after_a_line_terminator() {
    assert_eq!(hit("pass", "ok  \tpkg\t0.1s").as_deref(), Some("ok  \tpkg"));
    assert_eq!(hit("pass", "x ok  pkg"), None);
    assert_eq!(hit("pass", "a\nok b").as_deref(), Some("ok b"));
    assert_eq!(hit("pass", "a\u{2028}ok b").as_deref(), Some("ok b"));
    assert_eq!(hit("fail", "FAIL\tpkg").as_deref(), Some("FAIL\tpkg").map(|_| "FAIL").or(Some("FAIL")));
}

#[test]
fn only_a_command_that_starts_with_a_test_runner_counts() {
    for yes in
        ["npm test", "npm run test", "FOO=1 pytest -q", "/usr/bin/pytest", "cd a && go test ./...", "make; cargo test", "dart test", "node test", "cargo build"]
    {
        assert!(is_test_runner_command(yes), "{yes}");
    }
    for no in ["grep PASS FAIL src/foo.js", "npm install", "node app.js", "", "  ", "echo go test", "go", "npm run", "node --test"] {
        assert!(!is_test_runner_command(no), "{no}");
    }
}

#[test]
fn the_exit_code_comes_from_a_numeric_field_first_then_from_the_text() {
    let p = json!({"tool_response": {"stdout": "exit code: 9", "exit_code": 2}});
    assert_eq!(structured_exit(&p), Some(2.0));
    assert_eq!(structured_exit(&json!({"tool_response": "x"})), None);
    assert_eq!(exit_first("done, exit_code=-1"), Some(-1.0));
    assert_eq!(exit_first("EXIT CODE : 3"), Some(3.0));
    assert_eq!(exit_first("nothing"), None);
}

#[test]
fn key_order_matters_only_when_two_leaves_disagree() {
    let agree = json!({"stdout": "2 failed 8 passed", "stderr": "2 failed"});
    assert!(!order_matters(&agree, true));
    let differ = json!({"stdout": "2 failed", "stderr": "5 failed"});
    assert!(order_matters(&differ, true));
    let one_leaf = json!({"stdout": "2 failed and 5 failed", "n": 1});
    assert!(!order_matters(&one_leaf, true));
}

#[test]
fn the_blob_is_cut_to_head_and_tail_over_the_cap() {
    let payload = json!({"tool_response": format!("{}X{}", "a".repeat(150_000), "b".repeat(150_000))});
    let b = build_blob(&payload).unwrap();
    assert_eq!(utf16_len(&b.blob), 100_000 * 2 + defaults::text("output_verify.truncation_marker").len());
    assert!(!b.blob.contains('X'));
}

#[test]
fn a_cut_that_would_split_a_surrogate_pair_defers() {
    let payload = json!({"tool_response": format!("a{}", "\u{1f600}".repeat(100_000))});
    assert!(build_blob(&payload).is_err());
    let aligned = json!({"tool_response": "\u{1f600}".repeat(100_001)});
    assert!(build_blob(&aligned).is_ok());
}

#[test]
fn the_check_answers_only_post_tool_use() {
    let env = RequestEnv::from_pairs([("HOME", "/nonexistent-home")]);
    let p = json!({"tool_name": "Bash", "tool_input": {"command": "npm test"}, "tool_response": "x"});
    let null = Value::Null;
    let s = Subject { event: "PreToolUse", tool: Some("Bash"), cwd: None, tool_input: &null, prompt: None };
    assert!(OutputVerifyGuard.run_env(&s, &p, &Value::Null, &env).is_none());
}

mod jev_shadow {
    use super::*;
    use crate::jev::testkit::{install_scripted, log_rows, ok};

    fn home(tag: &str) -> std::path::PathBuf {
        let d = std::env::temp_dir().join(format!("ah-ov-jev-{tag}-{}", std::process::id()));
        crate::discard::harmless(std::fs::remove_dir_all(&d));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    fn env(h: &std::path::Path, extra: &[(&str, &str)]) -> RequestEnv {
        let mut pairs = vec![("HOME".to_string(), h.to_string_lossy().into_owned())];
        pairs.extend(extra.iter().map(|(k, v)| (k.to_string(), v.to_string())));
        RequestEnv::from_pairs(pairs)
    }

    const ON: [(&str, &str); 2] = [("ANTIHALL_JEV", "1"), ("CLAUDE_PLUGIN_OPTION_JEV_VERCEL_API_KEY", "vk")];

    fn payload(out: &str) -> Value {
        json!({"tool_name":"Bash","tool_input":{"command":"npm test"},"tool_response":{"stdout":out},"session_id":"sv"})
    }

    #[test]
    fn a_test_runner_output_is_asked_with_the_regex_verdict_as_baseline_and_the_advisory_is_unchanged() {
        let h = home("on");
        let (jev, fake) = install_scripted(&h, &ON, vec![ok(200, r#"{"answers":{"decision":{"noul":0.9}}}"#)]);
        let v = decide(&payload("Tests: 3 passed, 2 failed"), &env(&h, &ON)).unwrap();
        assert!(matches!(v, Verdict::Exact(_)), "the advisory is still emitted");
        assert!(jev.drain(std::time::Duration::from_secs(5)));
        let seen = fake.seen.lock().unwrap();
        assert_eq!(seen.len(), 1);
        let body: Value = serde_json::from_str(seen[0].2.as_ref().unwrap()).unwrap();
        assert!(body["state"].as_str().unwrap().contains("3 passed"));
        let rows = log_rows(&h);
        assert_eq!(
            (rows.len(), &rows[0]["id"], &rows[0]["base"], &rows[0]["mode"], &rows[0]["sessionId"]),
            (1, &json!("outputVerifyGuard"), &json!(true), &json!("shadow"), &json!("sv"))
        );
    }

    #[test]
    fn an_off_integration_logs_the_off_row_and_a_clean_run_is_asked_with_baseline_false() {
        let h = home("off");
        let off = [("ANTIHALL_JEV", "0")];
        let (jev, fake) = install_scripted(&h, &off, vec![]);
        assert_eq!(decide(&payload("Tests: 5 passed"), &env(&h, &off)).unwrap(), Verdict::Allow);
        assert!(jev.drain(std::time::Duration::from_secs(5)));
        assert!(fake.seen.lock().unwrap().is_empty());
        let rows = log_rows(&h);
        assert_eq!((rows.len(), &rows[0]["mode"], &rows[0]["base"]), (1, &json!("off"), &json!(false)));
    }
}
