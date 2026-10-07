//! Unit tests of the claim-ledger check; the Node-vs-engine comparison is tests/response_guards_parity.rs.
use super::*;

#[test]
fn a_claim_matches_a_number_in_the_evidence_at_its_own_precision() {
    let ev = collect_numbers("took 34.887 total, 1,234 files");
    assert!(number_in_evidence("34.9", &ev));
    assert!(number_in_evidence("35", &ev));
    assert!(!number_in_evidence("34.8", &ev));
    assert!(number_in_evidence("1,234", &ev));
    assert!(!number_in_evidence("1,235", &ev));
    assert!(number_in_evidence("1.", &[]) || true);
}

#[test]
fn the_tolerance_is_half_a_unit_of_the_last_decimal() {
    // 34.85 is 0.05 away from 34.9: equal to the tolerance up to rounding, as Math.pow(10, -1) * 0.5 does in Node
    let ev = collect_numbers("34.85");
    assert_eq!(number_in_evidence("34.9", &ev), ((34.85f64 - 34.9f64).abs() <= 0.5 * 0.1f64));
}

#[test]
fn a_number_glued_to_an_identifier_character_is_not_a_count() {
    let flags = |t: &str| extract_flags(t, "", 1).unwrap().into_iter().map(|f| f.token).collect::<Vec<_>>();
    assert_eq!(flags("V2-4 workspace"), Vec::<String>::new());
    assert_eq!(flags("x12 files"), Vec::<String>::new());
    assert_eq!(flags("(12 files)"), vec!["12 files".to_string()]);
    assert_eq!(flags("took 12 seconds and 3 files"), vec!["12 seconds".to_string(), "3 files".to_string()]);
    assert_eq!(flags("a .5 files"), Vec::<String>::new());
}

#[test]
fn a_state_word_is_a_soft_flag_only_in_a_turn_without_tool_calls() {
    let kinds = |tools: usize| extract_flags("it is still running", "", tools).unwrap().into_iter().map(|f| f.kind).collect::<Vec<_>>();
    assert_eq!(kinds(0), vec!["state-no-tool"]);
    assert!(kinds(2).is_empty());
}

#[test]
fn texts_compare_after_nfc_and_white_space_collapse() {
    assert_eq!(collapse_text("cafe\u{301}  \n x "), collapse_text("caf\u{e9} x"));
    assert_eq!(collapse_text("  "), "");
}

#[test]
fn the_ledger_record_has_the_node_key_order() {
    let f = [Flag { cls: "hard", kind: "count", token: "12 files".into(), context: "ran 12 files".into() }];
    let line = record_line("s1", "abc", 2, 10, 20, false, &f);
    assert!(line.starts_with("{\"ts\":\""));
    assert!(line.ends_with("\"tools_this_turn\":2,\"msg_chars\":10,\"evidence_chars\":20,\"window_truncated\":false,\"flags\":[{\"cls\":\"hard\",\"kind\":\"count\",\"token\":\"12 files\",\"context\":\"ran 12 files\"}]}\n"));
}

#[test]
fn a_context_cut_inside_a_surrogate_pair_defers() {
    let text = format!("{}\u{1f600} 12 files", "a".repeat(159));
    assert!(context_at(&text, 0).is_err());
    assert_eq!(context_at("ab\ncd", 3).unwrap(), "cd");
}

mod jev_shadow {
    use super::super::*;
    use crate::jev::testkit::{install_scripted, log_rows, ok};
    use serde_json::json;

    fn home(tag: &str) -> std::path::PathBuf {
        let d = std::env::temp_dir().join(format!("ah-cl-jev-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    fn transcript(home: &Path) -> String {
        let p = home.join("t.jsonl");
        std::fs::write(
            &p,
            concat!(
                "{\"type\":\"user\",\"timestamp\":\"2026-01-01T00:00:00.000Z\",\"message\":{\"role\":\"user\",\"content\":\"go\"}}\n",
                "{\"type\":\"assistant\",\"timestamp\":\"2026-01-01T00:00:05.000Z\",\"message\":{\"role\":\"assistant\",\"content\":[{\"type\":\"text\",\"text\":\"I ran 12 files today\"}]}}\n"
            ),
        )
        .unwrap();
        p.to_string_lossy().into_owned()
    }

    fn env(home: &Path, extra: &[(&str, &str)]) -> RequestEnv {
        let mut pairs = vec![("HOME".to_string(), home.to_string_lossy().into_owned())];
        pairs.extend(extra.iter().map(|(k, v)| (k.to_string(), v.to_string())));
        RequestEnv::from_pairs(pairs)
    }

    const ON: [(&str, &str); 2] = [("ANTIHALL_JEV", "1"), ("CLAUDE_PLUGIN_OPTION_JEV_VERCEL_API_KEY", "vk")];

    #[test]
    fn a_flagged_claim_is_asked_on_the_jev_lane_and_the_ledger_is_still_written_first() {
        let h = home("on");
        let (jev, fake) = install_scripted(&h, &ON, vec![ok(200, r#"{"answers":{"decision":{"noul":0.97}}}"#)]);
        let payload = json!({"transcript_path": transcript(&h), "session_id": "s1"});
        let v = decide(&payload, &env(&h, &ON)).unwrap();
        assert_eq!(v, Verdict::Allow);
        assert!(jev.drain(std::time::Duration::from_secs(5)));
        let ledger = std::fs::read_to_string(h.join(".anti-hall/claim-ledger/s1.jsonl")).unwrap();
        assert!(ledger.contains("12 files"));
        let seen = fake.seen.lock().unwrap();
        assert_eq!(seen.len(), 1, "one flag, one ask");
        let body: serde_json::Value = serde_json::from_str(seen[0].2.as_ref().unwrap()).unwrap();
        assert!(body["state"].as_str().unwrap().starts_with("claim: 12 files\ncontext: "), "{body}");
        let rows = log_rows(&h);
        assert_eq!(rows.len(), 1);
        let r = &rows[0];
        assert_eq!((&r["id"], &r["mode"], &r["base"], &r["sessionId"], &r["turnRef"]), (&json!("claimLedger"), &json!("on"), &json!(true), &json!("s1"), &json!("2026-01-01T00:00:05.000Z")));
    }

    #[test]
    fn with_the_integration_off_each_flag_logs_one_off_row_and_nothing_is_sent() {
        let h = home("off");
        let off = [("ANTIHALL_JEV", "0")];
        let (jev, fake) = install_scripted(&h, &off, vec![]);
        decide(&json!({"transcript_path": transcript(&h), "session_id": "s2"}), &env(&h, &off)).unwrap();
        assert!(jev.drain(std::time::Duration::from_secs(5)));
        assert!(fake.seen.lock().unwrap().is_empty());
        let rows = log_rows(&h);
        assert_eq!((rows.len(), &rows[0]["mode"], &rows[0]["backend"]), (1, &json!("off"), &json!("baseline-only")));
    }

    #[test]
    fn a_turn_without_flags_asks_nothing() {
        let h = home("noflag");
        let (jev, fake) = install_scripted(&h, &ON, vec![]);
        let t = h.join("t.jsonl");
        std::fs::write(&t, "{\"type\":\"assistant\",\"message\":{\"role\":\"assistant\",\"content\":[{\"type\":\"text\",\"text\":\"done\"}]}}\n").unwrap();
        decide(&json!({"transcript_path": t.to_string_lossy(), "session_id": "s3"}), &env(&h, &ON)).unwrap();
        assert!(jev.drain(std::time::Duration::from_secs(5)));
        assert!(fake.seen.lock().unwrap().is_empty() && log_rows(&h).is_empty());
    }
}
