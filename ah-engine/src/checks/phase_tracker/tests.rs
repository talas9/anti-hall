//! Unit tests of the phase-tracker pieces; the Node-vs-engine parity corpus is `tests/spawn_ctx_parity.rs`.
use super::*;
use serde_json::json;

#[test]
fn parse_int_reads_a_leading_integer_the_way_javascript_does() {
    for (s, want) in [
        ("123 tag", Some(123.0)),
        ("  42", Some(42.0)),
        ("\u{a0}\u{feff}7x", Some(7.0)),
        ("-5 x", Some(-5.0)),
        ("+9", Some(9.0)),
        ("12abc", Some(12.0)),
        ("1e5", Some(1.0)),
        ("0x10", Some(0.0)),
        ("3.9", Some(3.0)),
        ("", None),
        ("abc", None),
        ("-", None),
        ("+-1", None),
    ] {
        assert_eq!(js_parse_int(s), want, "{s:?}");
    }
    assert_eq!(js_parse_int(&"9".repeat(400)), None, "past the largest double it is Infinity, which is not finite");
    assert!(js_parse_int("9999999999999999999999").is_some());
}

#[test]
fn the_session_tag_prefers_the_session_then_a_hash_of_the_directory() {
    assert_eq!(session_tag(&json!({"session_id": "  abc!d  "})).as_deref(), Some("abcd"));
    assert_eq!(
        session_tag(&json!({"session_id": "!!!", "cwd": "/a"})).as_deref(),
        Some("unknown"),
        "a session id that sanitizes away does not fall back to the directory"
    );
    assert_eq!(session_tag(&json!({"session_id": "  ", "cwd": "/a"})).as_deref(), Some("cwd-2256c6ac80d3"), "SHA-1 of /a, first 12 hex digits");
    assert_eq!(session_tag(&json!({"workspace": {"current_dir": "/a"}})).as_deref(), Some("cwd-2256c6ac80d3"));
    assert_eq!(session_tag(&json!({})).as_deref(), Some("unknown"));
    assert_eq!(session_tag(&json!({"session_id": "x".repeat(100)})).map(|s| s.len()), Some(64));
    assert_eq!(session_tag(&json!({"cwd": 5})), None, "a directory that is not a string defers");
}

#[test]
fn the_log_keeps_recent_lines_of_every_session_and_adds_one() {
    let now = 1_700_000_000_000f64;
    let old = format!("{} keep\n{} gone\njunk\n{}\n", now - 1000.0, now - 400_000.0, now + 5.0);
    let got = next_log(old.as_bytes(), now, "me");
    assert_eq!(got, format!("{} keep\n{}\n{} me\n", now - 1000.0, now + 5.0, now));
    assert_eq!(next_log(b"", now, "t"), format!("{} t\n", now));
}
