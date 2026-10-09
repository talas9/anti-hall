//! Golden parity of the D88 batch-7 checks: every case of `tests/golden/<check>.jsonl` (frozen from the compiled port before it was
//! removed) through the plugin script, byte for byte, with the files the script wrote compared too. A case whose answer differs on
//! purpose carries a `note`; `parity/run-golden.js` replays the corpus against the Node hook.
use super::tests::golden_report;

#[test]
fn stale_agent_stop_note_script_matches_the_compiled_port() {
    golden_report("stale-agent-stop-note", 12);
}

#[test]
fn claim_ledger_script_matches_the_compiled_port() {
    golden_report("claim-ledger", 12);
}

/// The Jev shadow question of the claim ledger: each flagged claim is asked on the shared lane without waiting, after the ledger is
/// written, with Node's id, question, state, cache key, trust and baseline.
mod claim_ledger_jev {
    use crate::checks::Verdict;
    use crate::jev::testkit::{install_scripted, log_rows, ok};
    use crate::reqenv::RequestEnv;
    use serde_json::{Value, json};
    use std::path::Path;

    fn home(tag: &str) -> std::path::PathBuf {
        let d = std::env::temp_dir().join(format!("ah-cl-jev-{tag}-{}", std::process::id()));
        crate::discard::harmless(std::fs::remove_dir_all(&d)); // keep: cleanup that raced; an absent dir is the goal state
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

    fn run(payload: &Value, e: &RequestEnv) -> Option<Option<Verdict>> {
        crate::script::run_forced("claim-ledger", payload, &Value::Null, "Stop", e)
    }

    const ON: [(&str, &str); 2] = [("ANTIHALL_JEV", "1"), ("CLAUDE_PLUGIN_OPTION_JEV_VERCEL_API_KEY", "vk")];

    #[test]
    fn a_flagged_claim_is_asked_on_the_jev_lane_and_the_ledger_is_still_written_first() {
        let h = home("on");
        let (jev, fake) = install_scripted(&h, &ON, vec![ok(200, r#"{"answers":{"decision":{"noul":0.97}}}"#)]);
        let payload = json!({"transcript_path": transcript(&h), "session_id": "s1"});
        assert_eq!(run(&payload, &env(&h, &ON)), Some(Some(Verdict::Allow)));
        assert!(jev.drain(std::time::Duration::from_secs(5)));
        let ledger = std::fs::read_to_string(h.join(".anti-hall/claim-ledger/s1.jsonl")).unwrap();
        assert!(ledger.contains("12 files"));
        let seen = fake.seen.lock().unwrap();
        assert_eq!(seen.len(), 1, "one flag, one ask");
        let body: Value = serde_json::from_str(seen[0].2.as_ref().unwrap()).unwrap();
        assert!(body["state"].as_str().unwrap().starts_with("claim: 12 files\ncontext: "), "{body}");
        let rows = log_rows(&h);
        assert_eq!(rows.len(), 1);
        let r = &rows[0];
        assert_eq!(
            (&r["id"], &r["mode"], &r["base"], &r["sessionId"], &r["turnRef"]),
            (&json!("claimLedger"), &json!("shadow"), &json!(true), &json!("s1"), &json!("2026-01-01T00:00:05.000Z"))
        );
    }

    #[test]
    fn with_the_integration_off_each_flag_logs_one_off_row_and_nothing_is_sent() {
        let h = home("off");
        let off = [("ANTIHALL_JEV", "0")];
        let (jev, fake) = install_scripted(&h, &off, vec![]);
        run(&json!({"transcript_path": transcript(&h), "session_id": "s2"}), &env(&h, &off));
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
        run(&json!({"transcript_path": t.to_string_lossy(), "session_id": "s3"}), &env(&h, &ON));
        assert!(jev.drain(std::time::Duration::from_secs(5)));
        assert!(fake.seen.lock().unwrap().is_empty() && log_rows(&h).is_empty());
    }
}

#[test]
fn idle_agent_sweep_script_matches_the_compiled_port() {
    golden_report("idle-agent-sweep", 12);
}

#[test]
fn auto_handover_pause_nag_script_matches_the_compiled_port() {
    golden_report("auto-handover-pause-nag", 12);
}

#[test]
fn compact_advice_guard_script_matches_the_compiled_port() {
    golden_report("compact-advice-guard", 12);
}
