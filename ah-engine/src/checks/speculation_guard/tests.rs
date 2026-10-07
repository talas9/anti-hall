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
    assert_eq!((p.last_blocked.as_str(), p.blocks, p.pending), ("h1", 2.0, Some(("h1".to_string(), "regex".to_string()))));
    let p = w("b.json", "12345678");
    assert_eq!((p.last_blocked.as_str(), p.blocks, p.pending), ("12345678", 0.0, None));
    let p = w("c.json", "3f2a9c");
    assert_eq!((p.last_blocked.as_str(), p.pending), ("", None));
    let p = w("d.json", r#"{"hash":5,"blocks":"3"}"#);
    assert_eq!((p.last_blocked.as_str(), p.blocks), ("", 0.0));
    assert!(read_prior(&d.join("missing.json")).is_ok());
    assert!(std::fs::write(d.join("e.json"), r#"{"7":1}"#).is_ok() && read_prior(&d.join("e.json")).is_err());
}

#[test]
fn a_hedge_under_a_plan_or_expectation_frame_is_framed_and_a_plain_one_is_not() {
    let framed = |t: &str| {
        let (_, at) = find_speculation_hit(t).expect("a hedge");
        is_framed_hit(t, at)
    };
    assert!(framed("Should be blocked: X probably fails"), "frame label on the hit's own line");
    assert!(framed("## Expected\nthe build probably passes"), "a heading frames what is under it");
    assert!(framed("1. plan: it probably works"));
    assert!(framed("it probably works (unverified)"), "inline frame");
    assert!(framed("it probably works, not yet measured"));
    assert!(!framed("It is probably fine."));
    assert!(!framed("## Results\nit is probably fine"), "a heading that is not a frame label");
    assert!(framed("Expected: x\nit is probably fine"), "the label line directly above frames it");
    // as in Node, the empty string left by the newline before the hit's own line counts as the first blank line, so one
    // blank line between the label and the hit already ends the section
    assert!(!framed("Expected: x\n\nit is probably fine"));
}

mod jev {
    use super::super::*;
    use crate::jev::testkit::{install_scripted, log_rows, ok};
    use serde_json::json;

    const ON: [(&str, &str); 2] = [("ANTIHALL_JEV", "1"), ("CLAUDE_PLUGIN_OPTION_JEV_VERCEL_API_KEY", "vk")];

    fn home(tag: &str) -> std::path::PathBuf {
        let d = std::env::temp_dir().join(format!("ah-sg-jev-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    fn env(h: &std::path::Path, extra: &[(&str, &str)]) -> RequestEnv {
        let mut pairs = vec![("HOME".to_string(), h.to_string_lossy().into_owned())];
        pairs.extend(extra.iter().map(|(k, v)| (k.to_string(), v.to_string())));
        RequestEnv::from_pairs(pairs)
    }

    fn payload(h: &std::path::Path, reply: &str, session: &str) -> Value {
        let t = h.join("t.jsonl");
        std::fs::write(&t, "{}\n").unwrap();
        json!({"transcript_path": t.to_string_lossy(), "session_id": session, "last_assistant_message": reply, "cwd": "/work/proj"})
    }

    fn judge(h: &std::path::Path) -> Vec<Value> {
        std::fs::read_to_string(h.join(".anti-hall/logs/jev-judge.ndjson")).unwrap_or_default().lines().map(|l| serde_json::from_str(l).unwrap()).collect()
    }

    fn blocked(v: &Verdict) -> bool {
        matches!(v, Verdict::Exact(e) if e.out.contains("\"decision\":\"block\""))
    }

    #[test]
    fn a_confident_speculative_answer_adds_a_block_the_regex_would_not_make_and_is_logged() {
        let h = home("add");
        let (_, fake) = install_scripted(&h, &ON, vec![ok(200, r#"{"answers":{"decision":{"noul":0.97}}}"#)]);
        let v = decide(&payload(&h, "All done, it works.", "s1"), &env(&h, &ON)).unwrap();
        assert!(blocked(&v), "Jev added the block");
        let Verdict::Exact(e) = v else { unreachable!() };
        assert!(e.out.contains("asserts a cause or outcome without citing evidence"));
        assert_eq!(fake.seen.lock().unwrap().len(), 1);
        let rows = log_rows(&h);
        assert_eq!((rows.len(), &rows[0]["id"], &rows[0]["mode"], &rows[0]["final"], &rows[0]["compare"], &rows[0]["sessionId"]), (1, &json!("speculation"), &json!("on"), &json!(true), &json!(false), &json!("s1")));
        let j = judge(&h);
        assert_eq!((j.len(), &j[0]["backend"], &j[0]["reason"], &j[0]["verdict"], &j[0]["regexVerdict"]), (1, &json!("jev"), &json!("confident"), &json!("block"), &json!(false)));
        let state = std::fs::read_to_string(h.join(".anti-hall/speculation-guard-state-s1.json")).unwrap();
        assert!(state.contains("\"source\":\"jev\""), "{state}");
    }

    #[test]
    fn a_confident_not_speculative_answer_never_removes_the_regex_block() {
        let h = home("keep");
        install_scripted(&h, &ON, vec![ok(200, r#"{"answers":{"decision":{"noul":0.02}}}"#)]);
        let v = decide(&payload(&h, "It is probably fine.", "s2"), &env(&h, &ON)).unwrap();
        assert!(blocked(&v));
        let j = judge(&h);
        assert_eq!((&j[0]["backend"], &j[0]["reason"], &j[0]["verdict"], &j[0]["regexVerdict"]), (&json!("jev\u{2192}regex"), &json!("confident-allow-untrusted"), &json!("block"), &json!(true)));
    }

    #[test]
    fn a_failed_ask_falls_back_to_the_regex_and_says_why() {
        let h = home("fail");
        install_scripted(&h, &ON, vec![]); // every request fails
        let v = decide(&payload(&h, "All done.", "s3"), &env(&h, &ON)).unwrap();
        assert_eq!(v, Verdict::Allow);
        let j = judge(&h);
        assert_eq!((&j[0]["backend"], &j[0]["verdict"], &j[0]["confidence"]), (&json!("jev\u{2192}regex"), &json!("allow"), &Value::Null));
        assert!(j[0]["reason"].is_string() && j[0]["ms"].is_number());
    }

    #[test]
    fn a_loop_safe_stop_asks_nothing_and_logs_loop_safe() {
        let h = home("loop");
        let (_, fake) = install_scripted(&h, &ON, vec![]);
        let reply = "It is probably fine.";
        std::fs::create_dir_all(h.join(".anti-hall")).unwrap();
        std::fs::write(h.join(".anti-hall/speculation-guard-state-s4.json"), format!("{{\"hash\":\"{}\",\"blocks\":1,\"pending\":null}}", sha1_hex(reply))).unwrap();
        assert_eq!(decide(&payload(&h, reply, "s4"), &env(&h, &ON)).unwrap(), Verdict::Allow);
        assert!(fake.seen.lock().unwrap().is_empty());
        assert_eq!(judge(&h)[0]["reason"], json!("loop-safe"));
    }

    #[test]
    fn a_framed_hit_is_asked_once_more_and_in_shadow_the_block_stands() {
        let h = home("framed");
        let (_, fake) = install_scripted(&h, &ON, vec![ok(200, r#"{"answers":{"decision":{"noul":0.01}}}"#), ok(200, r#"{"answers":{"decision":{"noul":0.01}}}"#)]);
        let v = decide(&payload(&h, "Should be blocked: X probably fails", "s5"), &env(&h, &ON)).unwrap();
        assert!(blocked(&v), "speculationFramed is shadow by default: the block stands");
        assert_eq!(fake.seen.lock().unwrap().len(), 2, "the speculation ask and the framed ask");
        let rows = log_rows(&h);
        assert_eq!((&rows[0]["id"], &rows[1]["id"], &rows[1]["base"], &rows[1]["mode"]), (&json!("speculation"), &json!("speculationFramed"), &json!(true), &json!("shadow")));
        assert!(judge(&h).iter().any(|e| e["event"] == "trigger" && e["id"] == "speculationFramed"));
    }

    #[test]
    fn the_stop_after_a_block_reports_its_outcome_and_clears_the_pending_record() {
        let h = home("outcome");
        install_scripted(&h, &[("ANTIHALL_JEV", "0")], vec![]);
        std::fs::create_dir_all(h.join(".anti-hall")).unwrap();
        let state = h.join(".anti-hall/speculation-guard-state-s6.json");
        std::fs::write(&state, r#"{"hash":"old","blocks":1,"pending":{"h":"abc","source":"regex"}}"#).unwrap();
        let off = [("ANTIHALL_JEV", "0")];
        assert_eq!(decide(&payload(&h, "I haven't checked yet.", "s6"), &env(&h, &off)).unwrap(), Verdict::Allow);
        let rows = log_rows(&h);
        assert_eq!((rows.len(), &rows[0]["type"], &rows[0]["id"], &rows[0]["h"], &rows[0]["outcome"], &rows[0]["source"]), (1, &json!("outcome"), &json!("speculation"), &json!("abc"), &json!("evidence-added"), &json!("regex")));
        assert_eq!(std::fs::read_to_string(&state).unwrap(), r#"{"hash":"old","blocks":1,"pending":null}"#);
    }

    #[test]
    fn without_the_reply_in_the_payload_a_jev_run_is_node_s_and_inference_check_with_jev_defers() {
        let h = home("defer");
        install_scripted(&h, &ON, vec![]);
        let t = h.join("t.jsonl");
        std::fs::write(&t, "{\"type\":\"assistant\",\"message\":{\"role\":\"assistant\",\"content\":[{\"type\":\"text\",\"text\":\"all done\"}]}}\n").unwrap();
        let p = json!({"transcript_path": t.to_string_lossy(), "session_id": "s7"});
        assert!(decide(&p, &env(&h, &ON)).is_err());
        let mut inf = ON.to_vec();
        inf.push(("ANTIHALL_INFERENCE_CHECK", "1"));
        assert!(decide(&payload(&h, "all done", "s8"), &env(&h, &inf)).is_err());
        assert!(judge(&h).is_empty() && log_rows(&h).is_empty(), "a deferral leaves no trace");
    }
}
