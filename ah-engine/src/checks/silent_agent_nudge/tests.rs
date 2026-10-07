//! Unit tests of the silent_agent_nudge check (parity with the Node hook is in tests/agent_controls_parity.rs).
use super::*;

#[test]
fn index_like_keys_are_the_ones_javascript_orders_first() {
    for k in ["0", "7", "42", "4294967294"] {
        assert!(index_like(k), "{k}");
    }
    for k in ["", "01", "-1", "1.5", "t:1", "4294967295", "1e3"] {
        assert!(!index_like(k), "{k}");
    }
}

#[test]
fn state_parsing_follows_the_hook() {
    let s = parse_state(r#"{"nudged":{"t:a":"1","t:b":"2","t:a":"3"},"everNudged":{"s::a":5},"x":1}"#).unwrap();
    assert_eq!(s.nudged.0, vec![("t:a".to_string(), Value::from("3")), ("t:b".to_string(), Value::from("2"))], "a repeated key keeps its first place and its last value");
    assert_eq!(s.ever.0.len(), 1);
    assert_eq!(parse_state("[1]").unwrap(), State::default());
    assert_eq!(parse_state("{oops").unwrap(), State::default());
    assert_eq!(parse_state(r#"{"nudged":null,"everNudged":"x"}"#).unwrap(), State::default());
    assert_eq!(parse_state(r#"{"nudged":[1]}"#), Err(Unsupported));
    assert_eq!(parse_state(r#"{"nudged":{"3":"x"}}"#), Err(Unsupported));
    assert_eq!(parse_state("{\"nudged\":{\"a\":\"\\ud800\"}}"), Err(Unsupported));
}

#[test]
fn the_state_is_written_as_json_stringify_writes_it() {
    let mut n = Pairs::default();
    n.set("t:a", Value::from("1759999999123@r1759999999000"));
    n.set("h:\"q\"", Value::from("é\n"));
    let text = render_state(&n, &[("s1::a".into(), 1759999999999.0)]).unwrap();
    assert_eq!(text, "{\"nudged\":{\"t:a\":\"1759999999123@r1759999999000\",\"h:\\\"q\\\"\":\"é\\n\"},\"everNudged\":{\"s1::a\":1759999999999}}");
    assert_eq!(render_state(&Pairs::default(), &[]).unwrap(), "{\"nudged\":{},\"everNudged\":{}}");
    assert_eq!(render_state(&Pairs::default(), &[("k".into(), 1.5)]), Err(Unsupported));
    let mut bad = Pairs::default();
    bad.set("k", Value::from(5));
    assert_eq!(render_state(&bad, &[]), Err(Unsupported));
}

#[test]
fn number_coercion_is_javascripts() {
    for (v, want) in [
        (Value::Null, 0.0),
        (Value::Bool(true), 1.0),
        (Value::from(5.5), 5.5),
        (Value::from(" 12 "), 12.0),
        (Value::from(""), 0.0),
        (Value::from("0x10"), 16.0),
        (serde_json::json!([7]), 7.0),
        (serde_json::json!([]), 0.0),
    ] {
        assert_eq!(js_number_of(&v), want, "{v}");
    }
    for v in [Value::from("abc"), serde_json::json!({}), serde_json::json!([1, 2]), Value::from("1_0")] {
        assert!(js_number_of(&v).is_nan(), "{v}");
    }
}

#[test]
fn the_judge_child_and_a_missing_home_are_decided_first() {
    let p = serde_json::json!({"hook_event_name": "Stop", "session_id": "s"});
    assert_eq!(decide(&p, &RequestEnv::from_pairs([("ANTIHALL_JUDGE_CHILD", "1")])), Verdict::Allow);
    assert_eq!(decide(&p, &RequestEnv::from_pairs([("ANTIHALL_X", "1")])), Verdict::Defer);
}
