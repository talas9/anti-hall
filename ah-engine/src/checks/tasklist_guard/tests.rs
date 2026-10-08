use super::*;
use serde_json::json;

fn st(home: &str) -> Settings {
    Settings { home: home.into(), env: Default::default() }
}

#[test]
fn no_transcript_path_does_nothing() {
    for p in [json!({}), json!(null), json!({"transcript_path": ""}), json!({"transcript_path": 5})] {
        assert_eq!(decide(&p, &st("/nonexistent-home"), ""), Verdict::Allow, "{p}");
    }
}

#[test]
fn plan_mode_prints_the_advisory_and_never_blocks() {
    let p = json!({"permission_mode": "Plan", "transcript_path": "/x"});
    match decide(&p, &st("/h"), "") {
        Verdict::Exact(x) => {
            assert_eq!(x.code, 0);
            assert!(x.out.starts_with("[tasklist-guard] PLAN MODE") && x.out.ends_with(".\n"), "{:?}", x.out);
        }
        v => panic!("{v:?}"),
    }
}

#[test]
fn the_reason_is_sanitized_like_node() {
    // Expected values computed with Node: sanitizeReason of tasklist-guard.js.
    assert_eq!(sanitize_reason("a\u{0}b\tc  d \n e\n\n f ").as_deref(), Some("a b c d\ne\n\nf"));
    assert_eq!(sanitize_reason("  x\u{7f}y  ").as_deref(), Some("x y"));
    let long = "y".repeat(2500);
    let cut = sanitize_reason(&long).unwrap();
    assert_eq!(cut.chars().count(), 2001);
    assert!(cut.ends_with('…'));
    // a cut through a surrogate pair is not ours to make
    assert_eq!(sanitize_reason(&format!("{}😀", "z".repeat(1999))), None);
}

#[test]
fn a_task_line_only_javascript_can_parse_is_unsure_not_skipped() {
    let line = r#"{"type":"assistant","message":{"content":[{"type":"tool_use","name":"TaskCreate","input":{"x":1e400}}]}}"#;
    assert!(scan::has_task_activity_in_text(line).is_err());
    assert_eq!(scan::has_task_activity_in_text("TaskCreate {oops").ok(), Some(false));
}

#[test]
fn the_resume_nudge_stamp_lands_only_when_its_reply_is_delivered() {
    // P2 follow-up of P1-2: the once-only stamp was written before the reply, so a nudge the client never received was lost for good
    let home = std::env::temp_dir().join(format!("ah-tl-stamp-{}", std::process::id()));
    let base = home.join(defaults::text("paths.base_dir"));
    std::fs::create_dir_all(&base).unwrap();
    let handover = home.join("handover.md");
    std::fs::write(&handover, "not verified").unwrap();
    let marker = base.join(format!("{}s1.json", defaults::text("tasklist_guard.resume_marker_prefix")));
    std::fs::write(&marker, json!({"handoverFile": handover.to_str().unwrap()}).to_string()).unwrap();
    let fired = base.join(format!("{}s1.json", defaults::text("tasklist_guard.resume_nudged_prefix")));
    let h = home.to_str().unwrap();
    crate::deadline::begin(std::time::Instant::now());
    assert!(check_resume_verification(h, "s1", 100, 0.0).unwrap().is_some());
    assert!(!fired.exists(), "staged, not stamped, before the reply");
    crate::deadline::settle_staged(false); // the reply could not be written
    crate::deadline::end();
    assert!(!fired.exists(), "an undelivered nudge stays unsent: the next Stop sends it");
    crate::deadline::begin(std::time::Instant::now());
    assert!(check_resume_verification(h, "s1", 100, 0.0).unwrap().is_some());
    crate::deadline::settle_staged(true);
    crate::deadline::end();
    assert!(fired.exists(), "a delivered nudge is stamped once");
    assert!(check_resume_verification(h, "s1", 100, 0.0).unwrap().is_none());
    crate::discard::harmless(std::fs::remove_dir_all(&home));
}
