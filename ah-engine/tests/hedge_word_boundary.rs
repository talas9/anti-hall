//! Regression for hedge substrings (#722), using the shipped scripts and real regex host.
#![allow(clippy::unwrap_used, clippy::expect_used)]
use ah_engine::{checks::Verdict, reqenv::RequestEnv, script};
use serde_json::json;

fn merge(text: &str, codex: bool) -> bool {
    let record = if codex {
        json!({"type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":text}]}})
    } else {
        json!({"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":text}]}})
    };
    merge_records(&[record])
}

fn merge_records(records: &[serde_json::Value]) -> bool {
    let home = std::env::temp_dir().join(format!("ah-hedge-records-{}-{:?}", std::process::id(), std::thread::current().id()));
    std::fs::create_dir_all(&home).unwrap();
    let tp = home.join("transcript.jsonl");
    let transcript = records.iter().map(|record| format!("{record}\n")).collect::<String>();
    std::fs::write(&tp, transcript).unwrap();
    let env = RequestEnv::from_pairs([("HOME".to_string(), home.to_string_lossy().into_owned()), ("ANTIHALL_MERGE_GATE".to_string(), "1".to_string())]);
    let got = script::run_forced("merge-gate", &json!({"tool_input":{"command":"gh pr merge"},"transcript_path":tp}), &json!({}), "PreToolUse", &env)
        .expect("shipped script")
        .expect("script verdict");
    // keep: scratch test directory only
    std::fs::remove_dir_all(home).unwrap();
    match got {
        Verdict::Allow => false,
        Verdict::Exact(e) if e.code == 2 => true,
        other => {
            assert!(matches!(other, Verdict::Allow), "unexpected verdict: {other:?}");
            false
        }
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
merge_case!(underscore_suffix, "first pass_key", true);
merge_case!(first_pass, "This is a first pass.", true);
merge_case!(hyphen_first_pass, "This is a first-pass.", true);
merge_case!(needs_review, "This needs review.", true);

#[test]
fn speculation_unicode_boundaries() {
    for text in ["éprobably", "probably界", "probably\u{301}", "probably٢"] {
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

merge_case!(markdown_italic_underscore, "_first pass_", true);
merge_case!(markdown_bold_underscore, "__first pass__", true);
merge_case!(markdown_italic_star, "*first pass*", true);
merge_case!(markdown_bold_star, "**first pass**", true);
merge_case!(markdown_code, "`first pass`", true);
merge_case!(markdown_strike, "~~first pass~~", true);
merge_case!(markdown_link, "[first pass](x)", true);
merge_case!(newline_phrase, "first\npass", true);
merge_case!(double_space_phrase, "first  pass", true);
merge_case!(astral_letter_prefix, "𐐀first pass", false);
merge_case!(astral_letter_suffix, "first pass𐐀", false);
merge_case!(astral_symbol_boundary, "😀first pass😀", true);

// Count the text that crosses the regex-test bridge, independent of machine timing.
// The shipped helper runs unchanged in QuickJS; only its host calls are instrumented.
#[test]
fn boundary_marshaling_is_linear() {
    let rt = rquickjs::Runtime::new().unwrap();
    let ctx = rquickjs::Context::full(&rt).unwrap();
    let source = include_str!("../../plugins/anti-hall/engine/logic/lib/68-reply.js");
    ctx.with(|ctx| {
        ctx.eval::<(), _>(
            r#"
            var marshaled = 0;
            var ah = {cfg: function () { return ''; }, re: {
                test: function (src, flags, text) { marshaled += text.length; return false; },
                findAll: function (src, flags, text) {
                    var re = new RegExp(src, 'g' + flags), hit, out = [];
                    while ((hit = re.exec(text)) !== null) out.push([hit.index, hit.index + hit[0].length]);
                    return out;
                }
            }};
        "#,
        )
        .unwrap();
        ctx.eval::<(), _>(source).unwrap();
        let mut measurements = Vec::new();
        for len in [12_000, 24_000, 48_000] {
            let text = " first passx".repeat(len / 12);
            ctx.globals().set("input", text).unwrap();
            let chars: usize = ctx.eval("marshaled = 0; rp.wordHits('first pass', 'i', input); marshaled;").unwrap();
            println!("{len} input chars: {chars} boundary chars marshaled");
            measurements.push((len, chars));
        }
        assert!(measurements.iter().all(|(len, chars)| chars <= len), "boundary work must stay linear: {measurements:?}");
    });
}

#[test]
fn codex_event_only_reply_and_duplicate() {
    let event = json!({"type":"event_msg","payload":{"type":"agent_message","message":"first pass"}});
    let response = json!({"type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"first pass"}]}});
    assert!(merge_records(std::slice::from_ref(&event)));
    let transcript = format!("{event}\n{response}\n");
    assert_eq!(script::call_fn("merge-gate", "readRecords", &json!(transcript)), Some(json!([{"k":"a","t":"first pass"}])));
    assert!(merge_records(&[event.clone(), response]));
    let resolved = json!({"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"owner approved"}]}});
    assert!(!merge_records(&[event, resolved]));
}

#[test]
fn codex_event_only_stop_reply() {
    let home = std::env::temp_dir().join(format!("ah-hedge-stop-{}", std::process::id()));
    std::fs::create_dir_all(&home).unwrap();
    let tp = home.join("transcript.jsonl");
    let event = json!({"type":"event_msg","payload":{"type":"agent_message","message":"This probably works."}});
    std::fs::write(&tp, format!("{event}\n")).unwrap();
    let env = RequestEnv::from_pairs([("HOME", home.to_str().unwrap())]);
    let verdict = script::run_forced("speculation-guard", &json!({"session_id":"event-only","transcript_path":tp}), &json!({}), "Stop", &env)
        .expect("shipped script")
        .expect("script verdict");
    let blocked = match &verdict {
        Verdict::Block(_) => true,
        Verdict::Exact(e) => serde_json::from_str::<serde_json::Value>(&e.out).is_ok_and(|v| v["decision"] == "block"),
        _ => false,
    };
    assert!(blocked, "{verdict:?}");
    // keep: scratch test directory only
    std::fs::remove_dir_all(home).unwrap();
}
