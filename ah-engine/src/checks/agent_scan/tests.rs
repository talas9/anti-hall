//! Unit tests of the transcript agent scan. The line-level behavior is compared with `hooks/lib/agent-scan.js` by
//! `tests/agent_controls_parity.rs`; these pin the JavaScript semantics the scan re-implements by hand. The expected values
//! were computed with Node (`Date.parse`, `Date.prototype.toISOString`, `JSON.parse`).
use super::*;

#[test]
fn date_parse_matches_v8_for_the_forms_a_transcript_carries() {
    let table: &[(&str, f64)] = &[
        ("2026-10-06T12:00:00.000Z", 1791288000000.0),
        ("2026-10-06T12:00:00Z", 1791288000000.0),
        ("2026-10-06T12:00Z", 1791288000000.0),
        ("2026-10-06T12:00:00.1Z", 1791288000100.0),
        ("2026-10-06T12:00:00.12Z", 1791288000120.0),
        ("2026-10-06T12:00:00.12345Z", 1791288000123.0),
        ("2026-10-06T12:00:00.9999Z", 1791288000999.0),
        ("2026-10-06T12:00:00+02:00", 1791280800000.0),
        ("2026-10-06T12:00:00-05:30", 1791307800000.0),
        ("2026-10-06", 1791244800000.0),
        ("2026-02-30T00:00:00Z", 1772409600000.0),
        ("2026-02-31T10:00:00Z", 1772532000000.0),
        ("2026-04-31T00:00:00Z", 1777593600000.0),
        ("2024-02-29T23:59:59.999Z", 1709251199999.0),
        ("1970-01-01T00:00:00.000Z", 0.0),
        ("1969-12-31T23:59:59.999Z", -1.0),
        ("0000-01-01T00:00:00Z", -62167219200000.0),
        ("9999-12-31T23:59:59.999Z", 253402300799999.0),
        ("2000-03-01T00:00:00Z", 951868800000.0),
        ("1900-02-28T00:00:00Z", -2203977600000.0),
        ("2100-03-01T12:00:00.5Z", 4107585600500.0),
    ];
    for (s, want) in table {
        assert_eq!(date_parse(s), Ok(*want), "{s}");
    }
    for s in ["", "garbage", "May", "UTC"] {
        assert!(date_parse(s).unwrap().is_nan(), "{s:?} has no digit, so V8 reads none of it");
    }
}

#[test]
fn date_parse_defers_on_every_form_it_does_not_read_itself() {
    for s in ["2026-10-06T12:00:00", "Oct 6 2026 10:00:00", "1", "2026-10-06 12:00:00Z", "2026-13-01T00:00:00Z", "2026-10-06T24:00:00Z", "2026-10-06t12:00:00z", "+002026-10-06T00:00:00Z", "2026-10-06T12:00:00+0200"] {
        assert_eq!(date_parse(s), Err(Unsupported), "{s}");
    }
}

#[test]
fn iso_utc_matches_to_iso_string() {
    for (ms, want) in [
        (0.0, "1970-01-01T00:00:00.000Z"),
        (1791288000123.0, "2026-10-06T12:00:00.123Z"),
        (-1.0, "1969-12-31T23:59:59.999Z"),
        (1709164799999.0, "2024-02-28T23:59:59.999Z"),
        (253402300799999.0, "9999-12-31T23:59:59.999Z"),
        (-62167219200000.0, "0000-01-01T00:00:00.000Z"),
    ] {
        assert_eq!(iso_utc(ms), want);
    }
    assert_eq!(hhmm(1791288000123.0), "12:00 UTC");
}

#[test]
fn json_that_only_javascript_reads_is_unsupported_and_real_garbage_is_not() {
    // JSON.parse accepts all of these; serde does not.
    for s in [r#"{"a":"\ud800"}"#, r#""\udc00""#, r#"{"a":"\ud800\u0041"}"#, "1e999", &format!("{}1{}", "[".repeat(300), "]".repeat(300))] {
        assert_eq!(parse_json(s), Err(Unsupported), "{s:.40}");
    }
    // JSON.parse throws on these too.
    for s in ["{", "{\"a\":}", "", "tru", "{'a':1}", "[1,]", "01"] {
        assert_eq!(parse_json(s), Ok(None), "{s:?}");
    }
    assert!(matches!(parse_json(r#"{"a":[1,"x",null]}"#), Ok(Some(_))));
}

#[test]
fn extract_texts_follows_every_content_shape() {
    let v = serde_json::json!(["a", {"text": "b", "content": [{"text": "c"}, "d", 5, null]}, {"content": {"content": "e"}}, {"type": "x"}]);
    let mut out = Vec::new();
    extract_texts(&v, &mut out);
    assert_eq!(out, ["a", "b", "c", "d", "e"]);
}

#[test]
fn notification_texts_accept_only_a_real_notice() {
    let n = "<task-notification>\n<task-id>x</task-id>\n</task-notification>";
    let user = |c: Value| serde_json::json!({"type": "user", "message": {"content": c}});
    assert_eq!(notification_texts(&user(Value::String(n.into()))).len(), 1);
    assert_eq!(notification_texts(&user(Value::String(format!("\u{feff}\n {n}")))).len(), 1, "leading JS white space is skipped");
    assert_eq!(notification_texts(&user(Value::String(format!("quoting {n}")))).len(), 0);
    assert_eq!(notification_texts(&user(Value::String(format!("<system-reminder>\n\u{a0}{n}</system-reminder>")))).len(), 1);
    assert_eq!(notification_texts(&user(serde_json::json!([{"type": "text", "text": n}, {"type": "image"}, {"type": "text", "text": 5}]))).len(), 1);
    assert_eq!(notification_texts(&serde_json::json!({"type": "attachment", "attachment": {"prompt": n}})).len(), 1);
    assert_eq!(notification_texts(&serde_json::json!({"type": "queue-operation", "content": n})).len(), 1);
    assert_eq!(notification_texts(&serde_json::json!({"type": "assistant", "message": {"content": n}})).len(), 0);
}

#[test]
fn the_resume_result_is_recognised_only_as_the_harness_writes_it() {
    let id = "a180b191000d7a82e";
    let full = serde_json::json!({"success": true, "message": "Resuming agent a180b19 in the background", "resumedAgentId": id}).to_string();
    assert_eq!(parse_resume(&full), Ok(Some((id.into(), true))));
    assert_eq!(parse_resume("Resuming agent a180b19 (x)"), Ok(Some(("a180b19".into(), false))));
    assert_eq!(parse_resume("  RESUMING   AGENT a180b19"), Ok(Some(("a180b19".into(), false))));
    assert_eq!(parse_resume("it said Resuming agent a180b19"), Ok(None));
    assert_eq!(parse_resume(&serde_json::json!({"success": false, "message": "Resuming agent a180b19"}).to_string()), Ok(None));
    assert_eq!(parse_resume(&serde_json::json!({"success": true, "message": "Message queued"}).to_string()), Ok(None));
    assert_eq!(parse_resume(&serde_json::json!({"success": true, "resumedAgentId": "zz"}).to_string()), Ok(None));
    assert_eq!(parse_resume("{\"success\":true,\"resumedAgentId\":\"\\ud800\"}"), Err(Unsupported));
}

#[test]
fn names_agent_matches_a_full_id_or_a_unique_prefix() {
    let mut launched: OMap<Rec> = OMap::default();
    let rec = || Rec { adopted: false, output_file: String::new(), description: String::new(), launched_at_ms: 0.0, tool_use_id: None, resumed_at_ms: None, teammate: false, last_seen_ms: f64::NAN, pending_message: false };
    launched.set("a1b2c3d4e5f60718", rec());
    launched.set("a1b2c3d4ffffffff", rec());
    launched.set("0123456789abcdef", rec());
    let i = |s: &str| serde_json::json!({"to": s});
    assert_eq!(names_agent(Some(&i("a1b2c3d4e5f60718")), "a1b2c3d4e5f60718", &launched), Ok(true));
    assert_eq!(names_agent(Some(&i("a1b2c3d4e")), "a1b2c3d4e5f60718", &launched), Ok(true), "unique prefix");
    assert_eq!(names_agent(Some(&i("a1b2c3d4")), "a1b2c3d4e5f60718", &launched), Ok(false), "ambiguous prefix");
    assert_eq!(names_agent(Some(&i("0123456")), "0123456789abcdef", &launched), Ok(true));
    assert_eq!(names_agent(Some(&i("012345")), "0123456789abcdef", &launched), Ok(false), "shorter than 7");
    assert_eq!(names_agent(None, "0123456789abcdef", &launched), Ok(false));
    assert_eq!(names_agent(Some(&Value::Null), "0123456789abcdef", &launched), Ok(false));
    assert_eq!(names_agent(Some(&serde_json::json!({"n": 1.5})), "0123456789abcdef", &launched), Err(Unsupported), "a float prints differently in JavaScript");
    assert_eq!(names_agent(Some(&serde_json::json!({"n": 9007199254740993u64})), "x", &launched), Err(Unsupported));
}

#[test]
fn the_home_is_home_and_nothing_else() {
    let e = crate::reqenv::RequestEnv::from_pairs([("HOME", "/h"), ("USERPROFILE", "/u")]);
    assert_eq!(home_dir(&e).as_deref(), Some("/h"));
    assert_eq!(home_dir(&crate::reqenv::RequestEnv::from_pairs([("USERPROFILE", "/u")])), None);
    assert_eq!(home_dir(&crate::reqenv::RequestEnv::from_pairs([("HOME", "")])), None);
}

#[test]
fn path_helpers_follow_node() {
    assert_eq!(dir_of("/a/b/c.jsonl"), "/a/b");
    assert_eq!(dir_of("c.jsonl"), ".");
    assert_eq!(dir_of("/c.jsonl"), "/");
    assert_eq!(base_without_jsonl("/a/b/c.jsonl"), "c");
    assert_eq!(base_without_jsonl("/a/b/.jsonl"), ".jsonl");
    assert_eq!(base_without_jsonl("/a/b/c.txt"), "c.txt");
    assert_eq!(utf16_len("a\u{1F600}é"), 4);
}
