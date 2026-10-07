use super::*;
use serde_json::json;

fn st(home: &str) -> Settings {
    Settings { home: home.into(), env: Default::default() }
}

#[test]
fn no_transcript_path_does_nothing() {
    for p in [json!({}), json!(null), json!({"transcript_path": ""}), json!({"transcript_path": 5})] {
        assert_eq!(decide(&p, &st("/nonexistent-home")), Verdict::Allow, "{p}");
    }
}

#[test]
fn plan_mode_prints_the_advisory_and_never_blocks() {
    let p = json!({"permission_mode": "Plan", "transcript_path": "/x"});
    match decide(&p, &st("/h")) {
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
