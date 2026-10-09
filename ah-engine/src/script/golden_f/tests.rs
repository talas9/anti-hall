//! Golden parity of the D88 batch-8 checks (lane F): every case of `tests/golden/<check>.jsonl` (frozen from the compiled port before it
//! was removed) through the plugin script, byte for byte, with the files the script wrote compared too. A case whose answer differs on
//! purpose carries a `note`; `parity/run-golden.js` replays the corpus against the Node hook.
use super::tests::golden_report;

#[test]
fn verify_first_script_matches_the_compiled_port() {
    golden_report("verify-first", 12);
}

#[test]
fn verify_first_orch_scripts_match_the_compiled_ports() {
    golden_report("verify-first-orch", 12);
    golden_report("verify-first-orch-codex", 12);
}

#[test]
fn task_tracker_script_matches_the_compiled_port() {
    golden_report("task-tracker", 12);
}

#[test]
fn ship_it_guard_script_matches_the_compiled_port() {
    golden_report("ship-it-guard", 12);
}

#[test]
fn compact_declaration_guard_script_matches_the_compiled_port() {
    golden_report("compact-declaration-guard", 12);
}

#[test]
fn devswarm_prompt_and_gate_scripts_match_the_compiled_ports() {
    for check in ["devswarm-parent-inbox", "devswarm-child-turn", "devswarm-child-gate", "devswarm-parent-reply-tracker", "devswarm-child-drain", "devswarm-child-role", "devswarm-parent-gate", "devswarm-comms-guard"] {
        golden_report(check, 12);
    }
}

#[test]
fn session_gate_scripts_match_the_compiled_ports() {
    for check in ["jev-review-reminder", "jev-weekly-scorecard", "repair-on-reload"] {
        golden_report(check, 12);
    }
}

#[test]
fn task_lifecycle_log_script_matches_the_compiled_port() {
    golden_report("task-lifecycle-log", 12);
}

#[test]
fn scan_throttle_and_merge_side_pick_scripts_match_the_compiled_ports() {
    golden_report("scan-throttle", 12);
    golden_report("merge-side-pick", 12);
}

#[test]
fn merge_gate_script_matches_the_compiled_port() {
    golden_report("merge-gate", 12);
}

/// The Jev shadow question of the merge gate: a hedge in the tail is asked on the shared lane without waiting, the gate's answer never depends
/// on it, and a resolved hedge is asked with a false baseline.
mod merge_gate_jev {
    use crate::checks::Verdict;
    use crate::jev::testkit::{install_scripted, log_rows, ok};
    use crate::reqenv::RequestEnv;
    use serde_json::{Value, json};
    use std::path::Path;

    const ON: [(&str, &str); 3] = [("ANTIHALL_JEV", "1"), ("CLAUDE_PLUGIN_OPTION_JEV_VERCEL_API_KEY", "vk"), ("ANTIHALL_MERGE_GATE", "1")];

    fn home(tag: &str) -> std::path::PathBuf {
        let d = std::env::temp_dir().join(format!("ah-mg-jev-{tag}-{}", std::process::id()));
        crate::discard::harmless(std::fs::remove_dir_all(&d)); // keep: cleanup that raced; an absent dir is the goal state
        std::fs::create_dir_all(d.join(".anti-hall")).unwrap();
        d
    }

    fn assistant(text: &str) -> String {
        json!({"type": "assistant", "message": {"content": [{"type": "text", "text": text}]}}).to_string()
    }

    fn run(h: &Path, lines: &[String], sid: &str) -> Option<Option<Verdict>> {
        let t = h.join("t.jsonl");
        std::fs::write(&t, format!("{}\n", lines.join("\n"))).unwrap();
        let mut pairs = vec![("HOME".to_string(), h.to_string_lossy().into_owned())];
        pairs.extend(ON.iter().map(|(k, v)| (k.to_string(), v.to_string())));
        let p = json!({"tool_name": "Bash", "tool_input": {"command": "gh pr merge 1"}, "transcript_path": t.to_string_lossy(), "session_id": sid});
        crate::script::run_forced("merge-gate", &p, &Value::Null, "PreToolUse", &RequestEnv::from_pairs(pairs))
    }

    #[test]
    fn a_hedge_asks_jev_with_the_resolution_verdict_as_baseline_and_the_gate_does_not_wait() {
        let h = home("hedge");
        let (jev, fake) = install_scripted(&h, &ON, vec![ok(200, r#"{"answers":{"decision":{"noul":0.99}}}"#)]);
        let got = run(&h, &[assistant("first-pass only")], "sg");
        assert!(matches!(got, Some(Some(Verdict::Exact(ref e))) if e.code == 2), "shadow never relaxes the block: {got:?}");
        assert!(jev.drain(std::time::Duration::from_secs(5)));
        let seen = fake.seen.lock().unwrap();
        assert_eq!(seen.len(), 1);
        let body: Value = serde_json::from_str(seen[0].2.as_ref().unwrap()).unwrap();
        assert_eq!(body["state"], "first-pass only");
        let rows = log_rows(&h);
        assert_eq!((rows.len(), &rows[0]["id"], &rows[0]["base"], &rows[0]["mode"], &rows[0]["sessionId"]), (1, &json!("mergeGateHedge"), &json!(true), &json!("shadow"), &json!("sg")));
    }

    #[test]
    fn a_resolved_hedge_is_asked_with_baseline_false_and_allowed() {
        let h = home("resolved");
        let (jev, _) = install_scripted(&h, &ON, vec![ok(200, r#"{"answers":{"decision":{"noul":0.1}}}"#)]);
        let user = json!({"type": "user", "message": {"content": "verified against the spec"}}).to_string();
        assert_eq!(run(&h, &[assistant("first-pass only"), user], "sr"), Some(Some(Verdict::Allow)));
        assert!(jev.drain(std::time::Duration::from_secs(5)));
        assert_eq!(log_rows(&h)[0]["base"], json!(false));
    }

    #[test]
    fn no_hedge_asks_nothing() {
        let h = home("none");
        let (jev, fake) = install_scripted(&h, &ON, vec![]);
        assert_eq!(run(&h, &[assistant("all done")], "sn"), Some(Some(Verdict::Allow)));
        assert!(jev.drain(std::time::Duration::from_secs(5)) && fake.seen.lock().unwrap().is_empty() && log_rows(&h).is_empty());
    }
}
