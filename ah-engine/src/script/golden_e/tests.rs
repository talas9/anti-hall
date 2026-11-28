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
        let d = crate::testtmp::path(format!("ah-cl-jev-{tag}-{}", std::process::id()));
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

#[test]
fn session_end_mcp_reaper_script_matches_the_compiled_port() {
    golden_report("session-end-mcp-reaper", 12);
}

/// The GitHub realtime rules (`engine/logic/rules/gh-rt.js`) give the answers the compiled rules gave, over a frozen corpus of
/// summaries, statuses, status pairs (edges), edge texts, statusline pieces and polling cadences.
#[test]
fn gh_rt_rules_script_matches_the_compiled_rules() {
    let cases = super::golden::load("gh-rt-rules");
    assert!(cases.len() > 1500, "a corpus of real size: {}", cases.len());
    let (mut bad, mut kinds) = (Vec::new(), std::collections::BTreeSet::new());
    for c in &cases {
        let f = c["fn"].as_str().unwrap();
        kinds.insert(f.to_string());
        let got = crate::script::call_fn("rules/gh-rt", f, &c["args"]);
        if got.as_ref() != Some(&c["expect"]) {
            bad.push(format!("{} {f}: args {} expect {} got {got:?}", c["n"], c["args"], c["expect"]));
        }
    }
    assert!(bad.is_empty(), "{} of {} cases differ, first:\n{}", bad.len(), cases.len(), bad.iter().take(8).cloned().collect::<Vec<_>>().join("\n"));
    assert_eq!(kinds.len(), 10, "every rule is in the corpus: {kinds:?}");
}

/// #972 wave 2 (item 7): the devswarm-comms label for the coordinator address ("main") is shown once per session and agent, not on
/// every message, and without the banned tip icon; a block for a workspace target is never deduplicated (true positive).
mod devswarm_comms_label_once {
    use crate::script::golden;
    use serde_json::{Value, json};

    fn case(to: &str, repeat: u64, agent: Option<&str>) -> Value {
        let mut payload = json!({"hook_event_name": "PreToolUse", "session_id": "s1", "tool_name": "SendMessage", "tool_input": {"to": to, "message": "m"}});
        if let Some(a) = agent {
            payload["agent_id"] = json!(a);
        }
        json!({
            "env": {"DEVSWARM_REPO_ID": "r1", "HOME": "{HOME}"}, "event": "PreToolUse", "n": "972-w2-7", "repeat": repeat,
            "files": {".claude/sessions/100.json": "{\"cwd\":\"{HOME}/.devswarm/repos/r/ws1\",\"name\":\"worker\",\"sessionId\":\"x\"}"},
            "opts": {"plugin_root": "{PLUGIN}"}, "payload": payload, "expect": {"v": "allow"}
        })
    }

    fn run(c: &Value) -> Value {
        let l = golden::lay(c);
        let got = golden::run_case("devswarm-comms-guard", &l, golden::repeat_of(c)).expect("shipped script");
        golden::verdict_json(&got, &l)
    }

    #[test]
    fn the_main_label_shows_once_per_session_and_agent_without_the_tip_icon() {
        let first = run(&case("main", 1, None));
        assert_eq!(first["v"], "advisory", "the first message to main is labelled: {first}");
        let t = first["text"].as_str().unwrap_or_default();
        assert!(t.contains("points back to this session") && !t.contains('\u{1F4A1}'), "label text without the tip icon: {t}");
        assert_eq!(run(&case("main", 2, None)), json!({"v": "allow"}), "the second message to main in the same session is not labelled");
        // a teammate of the same session is another agent: it gets the label once too
        assert_eq!(run(&case("main", 1, Some("a1"))).get("v").and_then(Value::as_str), Some("advisory"), "first message of the teammate");
        assert_eq!(run(&case("main", 2, Some("a1"))), json!({"v": "allow"}), "second message of the teammate");
    }

    #[test]
    fn a_workspace_target_is_blocked_every_time() {
        for r in [1, 3] {
            let got = run(&case("worker", r, None));
            assert_eq!(got["v"], "exact", "run {r}: the workspace block is never deduplicated: {got}");
        }
    }
}
