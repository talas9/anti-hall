//! Regression for hedge substrings (#722), using the shipped scripts and real regex host.
#![allow(clippy::unwrap_used, clippy::expect_used)]
use ah_engine::{checks::Verdict, reqenv::RequestEnv, script};
use serde_json::json;

fn merge(text: &str, codex: bool) -> bool {
    let home = std::env::temp_dir().join(format!("ah-hedge-boundary-{}-{:?}", std::process::id(), std::thread::current().id()));
    std::fs::create_dir_all(&home).unwrap();
    let tp = home.join("transcript.jsonl");
    let record = if codex {
        json!({"type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":text}]}})
    } else {
        json!({"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":text}]}})
    };
    std::fs::write(&tp, format!("{record}\n")).unwrap();
    let env = RequestEnv::from_pairs([("HOME".to_string(), home.to_string_lossy().into_owned()), ("ANTIHALL_MERGE_GATE".to_string(), "1".to_string())]);
    let got = script::run_forced("merge-gate", &json!({"tool_input":{"command":"gh pr merge"},"transcript_path":tp}), &json!({}), "PreToolUse", &env)
        .expect("shipped script")
        .expect("script verdict");
    // keep: scratch test directory only
    std::fs::remove_dir_all(home).unwrap();
    match got {
        Verdict::Allow => false,
        Verdict::Exact(e) if e.code == 2 => true,
        other => panic!("unexpected verdict: {other:?}"),
    }
}

macro_rules! merge_case {
    ($name:ident, $text:expr, $blocked:expr) => {
        #[test]
        fn $name() {
            assert_eq!(merge($text, false), $blocked, "Claude: {}", $text);
            assert_eq!(merge($text, true), $blocked, "Codex: {}", $text);
        }
    };
}
merge_case!(first_password, "Set the first password.", false);
merge_case!(first_passwords, "Store first passwords securely.", false);
merge_case!(first_passenger, "Board the first-passenger carriage.", false);
merge_case!(unicode_prefix, "éfirst pass", false);
merge_case!(unicode_suffix, "first pass界", false);
merge_case!(combining_suffix, "first pass\u{301}", false);
merge_case!(numeric_suffix, "first pass٢", false);
merge_case!(underscore_suffix, "first pass_key", false);
merge_case!(first_pass, "This is a first pass.", true);
merge_case!(hyphen_first_pass, "This is a first-pass.", true);
merge_case!(needs_review, "This needs review.", true);

#[test]
fn speculation_unicode_boundaries() {
    for text in ["éprobably", "probably界", "probably\u{301}", "probably٢", "probably_key"] {
        assert_eq!(script::call_fn("speculation-guard", "sgHit", &json!(text)), Some(serde_json::Value::Null), "{text}");
    }
    assert!(script::call_fn("speculation-guard", "sgHit", &json!("This probably works.")).unwrap().is_object());
}

#[test]
fn literal_phrase_boundaries_and_offsets() {
    for text in ["épending review", "pending review界", "pending reviews", "needs reviews"] {
        assert!(!merge(text, false), "{text}");
    }
    // Unicode lowercasing can change length; match offsets must remain offsets of the original text.
    assert!(merge("İ pending review.", false));
    assert_eq!(script::call_fn("merge-gate", "lastHedgePhrase", &json!("pending review; first password")), Some(json!("pending review")));
    assert_eq!(script::call_fn("merge-gate", "lastHedgePhrase", &json!("pending review; first-pass")), Some(json!("first-pass")));
}

#[test]
fn claim_evidence_labels_are_whole_words() {
    for (text, blocked) in [("éunverified: tests passed.", true), ("unverified界: tests passed.", true), ("unverified: tests passed.", false)] {
        let home = std::env::temp_dir().join(format!("ah-claim-boundary-{}", std::process::id()));
        std::fs::create_dir_all(&home).unwrap();
        let tp = home.join("transcript.jsonl");
        let user = json!({"type":"user","message":{"role":"user","content":"Check the change."}});
        let assistant = json!({"type":"assistant","message":{"role":"assistant","content":text}});
        std::fs::write(&tp, format!("{user}\n{assistant}\n")).unwrap();
        let env = RequestEnv::from_pairs([("HOME", home.to_str().unwrap())]);
        let got = script::run_forced("claim-evidence-guard", &json!({"last_assistant_message":text,"transcript_path":tp}), &json!({}), "Stop", &env)
            .expect("shipped script")
            .expect("script verdict");
        // keep: scratch test directory only
        std::fs::remove_dir_all(home).unwrap();
        let is_block = match &got {
            Verdict::Block(_) => true,
            Verdict::Exact(e) => serde_json::from_str::<serde_json::Value>(&e.out).is_ok_and(|v| v["decision"] == "block"),
            _ => false,
        };
        assert_eq!(is_block, blocked, "{text}: {got:?}");
    }
}
