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

#[test]
fn codex_scripts_match_the_compiled_ports() {
    golden_report("codex-availability", 12);
    golden_report("codex-quota-detect", 12);
    golden_report("codex-nudge", 12);
}

/// The behaviors of the Codex nudge a corpus cannot pin: the Jev consult in each mode, the pruning of old state, a scratchpad inside the
/// work tree, a transcript line only JavaScript can read.
mod codex_nudge {
    use crate::checks::Verdict;
    use crate::checks::jsport::testkit::{Sandbox, git};
    use crate::jev::testkit::{install_scripted, log_rows, ok};
    use serde_json::{Value, json};
    use std::path::PathBuf;

    const SID: &str = "sess-1";
    const JEV_ON: [(&str, &str); 2] = [("ANTIHALL_JEV", "1"), ("CLAUDE_PLUGIN_OPTION_JEV_VERCEL_API_KEY", "vk")];

    struct Nudge {
        sb: Sandbox,
        repo: PathBuf,
        transcript: PathBuf,
    }

    fn nudge_box(tag: &str) -> Nudge {
        let sb = Sandbox::new(tag);
        let repo = sb.root.join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        git(&repo, &["init", "-q", "-b", "main"]);
        std::fs::write(repo.join("a.js"), "x").unwrap();
        git(&repo, &["add", "-A"]);
        git(&repo, &["commit", "-q", "-m", "init"]);
        let repo = std::fs::canonicalize(repo).unwrap();
        let enc: String = repo.to_string_lossy().chars().map(|c| if c.is_ascii_alphanumeric() { c } else { '-' }).collect();
        let transcript = sb.root.join(format!("home/.claude/projects/{enc}/{SID}.jsonl"));
        Nudge { sb, repo, transcript }
    }

    impl Nudge {
        fn transcript(&self, tools: &[Value]) {
            let lines: Vec<String> = tools.iter().map(|t| json!({"type": "assistant", "message": {"content": [t]}}).to_string()).collect();
            std::fs::create_dir_all(self.transcript.parent().unwrap()).unwrap();
            std::fs::write(&self.transcript, lines.join("\n") + "\n").unwrap();
        }
        fn edit(&self, rel: &str) -> Value {
            json!({"type": "tool_use", "name": "Edit", "input": {"file_path": self.repo.join(rel).to_string_lossy()}})
        }
        fn edits(&self, n: usize) -> Vec<Value> {
            (0..n).map(|i| self.edit(&format!("f{i}.js"))).collect()
        }
        fn payload(&self) -> Value {
            json!({"hook_event_name": "Stop", "session_id": SID, "cwd": self.repo.to_string_lossy(), "transcript_path": self.transcript.to_string_lossy()})
        }
        fn run(&self, extra: &[(&str, &str)]) -> Option<Option<Verdict>> {
            crate::script::run_forced("codex-nudge", &self.payload(), &Value::Null, "Stop", &self.sb.env(extra))
        }
        fn nudged(&self, extra: &[(&str, &str)]) -> bool {
            matches!(self.run(extra), Some(Some(Verdict::Advisory(_))))
        }
        fn silent(&self, extra: &[(&str, &str)]) -> bool {
            matches!(self.run(extra), Some(Some(Verdict::Allow)))
        }
    }

    fn trivial(p: f64) -> String {
        format!(r#"{{"answers":{{"decision":{{"noul":{p}}}}}}}"#)
    }

    #[test]
    fn the_nudge_consults_jev_in_every_mode() {
        // off (Jev disabled): the nudge stands and the off row is written
        let n = nudge_box("nudge-jev-off");
        n.transcript(&n.edits(4));
        let home = n.sb.root.join("home");
        let (jev, fake) = install_scripted(&home, &[], vec![]);
        assert!(n.nudged(&[]));
        assert!(jev.drain(std::time::Duration::from_secs(5)));
        let rows = log_rows(&home);
        assert_eq!((rows.len(), rows[0]["id"].clone(), rows[0]["mode"].clone()), (1, json!("codexNudgeSubstantial"), json!("off")));
        assert!(fake.seen.lock().unwrap().is_empty());
        // shadow: asked, logged, the nudge stands even for a confident "trivial"
        let n = nudge_box("nudge-jev-shadow");
        n.transcript(&n.edits(4));
        let home = n.sb.root.join("home");
        let (jev, fake) = install_scripted(&home, &JEV_ON, vec![ok(200, &trivial(0.03))]);
        assert!(n.nudged(&JEV_ON));
        assert!(jev.drain(std::time::Duration::from_secs(5)));
        let rows = log_rows(&home);
        assert_eq!((rows.len(), rows[0]["mode"].clone(), rows[0]["jev"].clone(), rows[0]["final"].clone()), (1, json!("shadow"), json!(false), json!(true)));
        let seen = fake.seen.lock().unwrap();
        assert_eq!(seen.len(), 1);
        let body = seen[0].2.as_deref().unwrap();
        assert!(body.contains("files: f0.js, f1.js, f2.js, f3.js") && body.contains("edits: 4"), "{body}");
        drop(seen);
        // on: a confident "trivial" skips the nudge (and spends no state)
        let n = nudge_box("nudge-jev-on");
        n.transcript(&n.edits(4));
        let home = n.sb.root.join("home");
        n.sb.write("home/.anti-hall/settings.json", r#"{"jevIntegrations":{"codexNudgeSubstantial":"on"}}"#);
        let (_jev, _fake) = install_scripted(&home, &JEV_ON, vec![ok(200, &trivial(0.03))]);
        assert!(n.silent(&JEV_ON), "a confident trivial verdict skips the nudge");
        let rows = log_rows(&home);
        assert_eq!((rows.len(), rows[0]["mode"].clone(), rows[0]["final"].clone(), rows[0]["changed"].clone()), (1, json!("on"), json!(false), json!("relaxed")));
        assert!(!home.join(format!(".anti-hall/codex-nudge-state-{SID}.json")).exists());
        // on, and the call fails: today's verdict (nudge)
        let n = nudge_box("nudge-jev-on-fail");
        n.transcript(&n.edits(4));
        let home = n.sb.root.join("home");
        n.sb.write("home/.anti-hall/settings.json", r#"{"jevIntegrations":{"codexNudgeSubstantial":"on"}}"#);
        let (_jev, _fake) = install_scripted(&home, &JEV_ON, vec![]);
        assert!(n.nudged(&JEV_ON), "fail-open to nudging");
    }

    #[test]
    fn old_state_of_other_sessions_is_pruned_once_per_window_and_never_the_live_one() {
        let n = nudge_box("nudge-prune");
        n.transcript(&n.edits(4));
        for (name, age_days) in [("old", 10u64), ("fresh", 1), (SID, 30)] {
            let rel = format!("home/.anti-hall/codex-nudge-state-{name}.json");
            n.sb.write(&rel, "{}");
            n.sb.age(&rel, age_days * 86400);
        }
        n.sb.write("home/.anti-hall/other-file.json", "{}");
        n.sb.age("home/.anti-hall/other-file.json", 30 * 86400);
        assert!(n.nudged(&[]));
        let has = |rel: &str| n.sb.root.join(rel).exists();
        assert!(!has("home/.anti-hall/codex-nudge-state-old.json"));
        assert!(has("home/.anti-hall/codex-nudge-state-fresh.json"));
        assert!(has("home/.anti-hall/other-file.json"));
        assert!(has("home/.anti-hall/.prune-stamp-codex-nudge-state.json"));
        // a recent stamp throttles the next sweep
        n.sb.write("home/.anti-hall/codex-nudge-state-old2.json", "{}");
        n.sb.age("home/.anti-hall/codex-nudge-state-old2.json", 10 * 86400);
        n.transcript(&n.edits(5));
        assert!(n.nudged(&[]));
        assert!(has("home/.anti-hall/codex-nudge-state-old2.json"));
    }

    #[test]
    fn a_transcript_line_javascript_reads_and_serde_does_not_is_decided_by_the_script() {
        let n = nudge_box("nudge-lone");
        let line = r#"{"type":"tool_use","name":"Edit","input":{"file_path":"/x/\ud83d.js"}}"#;
        std::fs::create_dir_all(n.transcript.parent().unwrap()).unwrap();
        std::fs::write(&n.transcript, format!("{line}\n")).unwrap();
        assert!(!n.nudged(&[]), "one edit, outside the work tree: nothing to say");
    }

    #[test]
    fn a_scratchpad_inside_the_worktree_is_still_excluded() {
        let n = nudge_box("nudge-scratch-inside");
        let tmp = n.repo.join("tmpx");
        let enc: String = n.repo.to_string_lossy().chars().map(|c| if c.is_ascii_alphanumeric() { c } else { '-' }).collect();
        let scratch = tmp.join(format!("claude-{}/{enc}/{SID}/scratchpad", crate::checks::jsport::home::uid()));
        let mut t = n.edits(2);
        for i in 0..3 {
            t.push(json!({"type": "tool_use", "name": "Edit", "input": {"file_path": scratch.join(format!("s{i}.py")).to_string_lossy()}}));
        }
        n.transcript(&t);
        let env = [("TMPDIR", tmp.to_str().unwrap())];
        assert!(n.silent(&env), "the scratchpad edits do not count even inside the worktree");
        assert!(n.nudged(&[]), "without that TMPDIR they are ordinary edits");
    }
}

#[test]
fn coordinator_work_guard_script_matches_the_compiled_port() {
    golden_report("coordinator-work-guard", 12);
}

#[test]
fn command_script_matches_the_compiled_port() {
    golden_report("command", 12);
}
