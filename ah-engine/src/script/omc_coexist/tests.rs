//! GH #981: coexistence with OMC / OMX instruction text and plugins.

use crate::checks::Verdict;
use crate::reqenv::RequestEnv;
use serde_json::{json, Value};

fn home(tag: &str) -> String {
    let d = crate::tmpsweep::scratch("ah-omc-", tag); // removed when the test process exits
    std::fs::create_dir_all(d.join(".anti-hall/logic")).unwrap();
    d.to_string_lossy().to_string()
}

fn run(check: &str, ev: &str, payload: Value, envs: &[(&str, &str)]) -> (i32, String) {
    let h = payload["cwd"].as_str().unwrap_or("").to_string();
    let mut pairs = vec![("HOME".to_string(), h)];
    pairs.extend(envs.iter().map(|(k, v)| (k.to_string(), v.to_string())));
    match super::run_forced(check, &payload, &Value::Null, ev, &RequestEnv::from_pairs(pairs)) {
        Some(Some(Verdict::Exact(x))) => (x.code, x.out),
        Some(Some(Verdict::Advisory(a))) => (0, a),
        Some(Some(Verdict::Block(b))) => (2, b),
        Some(Some(Verdict::Allow)) => (0, String::new()),
        other => (0, format!("{other:?}")),
    }
}

fn write(h: &str, file: &str) -> Value {
    json!({"hook_event_name": "PreToolUse", "tool_name": "Write", "tool_input": {"file_path": file, "content": "# handover\n"}, "cwd": h, "session_id": "s1"})
}

/// The date the edit guard names: the local calendar date (`ho.localDate`), the UTC date only when the zone can not be read.
fn today() -> String {
    let now = crate::checks::taskkit::time::now_ms();
    crate::checks::jsport::date::local_ymd(now as f64).unwrap_or_else(|| crate::checks::taskkit::time::iso(now)[..10].to_string())
}

mod handover_redirect {
    use super::*;

    /// The reported case: the main thread wrote its handover to `.omc/handoffs/` (allowlisted as `.omc/**`) and nothing fired.
    #[test]
    fn a_new_handover_under_omc_handoffs_is_blocked_with_the_exact_session_path() {
        let h = home("ho-omc");
        let file = format!("{h}/.omc/handoffs/HANDOVER-2026-11-27-primary.md");
        let (code, out) = run("edit-guard", "PreToolUse", write(&h, &file), &[]);
        assert_eq!(code, 2, "{out}");
        let want = format!("Do instead: write it yourself at .anti-hall/handovers/{}/s1/HANDOVER.md.", today());
        assert!(out.contains(&want), "names the exact path {want}: {out}");
        // relative paths and a subagent too
        let mut sub = write(&h, ".omc/handoffs/notes.md");
        sub["agent_id"] = json!("a1");
        assert_eq!(run("edit-guard", "PreToolUse", sub, &[]).0, 2, "every agent");
        // a HANDOVER*.md anywhere else outside .anti-hall/handovers (here: an allowlisted .claude/ folder)
        assert_eq!(run("edit-guard", "PreToolUse", write(&h, &format!("{h}/.claude/HANDOVER.md")), &[]).0, 2);
        // the switch off: the old behaviour (.omc/** is on the coordinator allowlist)
        let (code, out) = run("edit-guard", "PreToolUse", write(&h, &file), &[("ANTIHALL_HANDOVER_REDIRECT", "0")]);
        assert_eq!(code, 0, "switched off: allowed as before: {out}");
    }

    #[test]
    fn the_own_folder_an_existing_file_and_an_enabled_omc_are_left_alone() {
        let h = home("ho-keep");
        let own = format!("{h}/.anti-hall/handovers/{}/s1/HANDOVER.md", today());
        assert_eq!(run("edit-guard", "PreToolUse", write(&h, &own), &[]).0, 0, "anti-hall's own folder");
        let file = format!("{h}/.omc/handoffs/stage-plan.md");
        std::fs::create_dir_all(format!("{h}/.omc/handoffs")).unwrap();
        std::fs::write(&file, "x").unwrap();
        assert_eq!(run("edit-guard", "PreToolUse", write(&h, &file), &[]).0, 0, "an existing file stays editable");
        std::fs::remove_file(&file).unwrap();
        std::fs::create_dir_all(format!("{h}/.claude")).unwrap();
        std::fs::write(format!("{h}/.claude/settings.json"), json!({"enabledPlugins": {"oh-my-claudecode@omc": true}}).to_string()).unwrap();
        let (code, out) = run("edit-guard", "PreToolUse", write(&h, &file), &[]);
        assert_eq!(code, 0, "OMC enabled: its own stage hand-off folder is its business: {out}");
        // ... but a HANDOVER*.md (no owner) is still redirected
        assert_eq!(run("edit-guard", "PreToolUse", write(&h, &format!("{h}/.omc/handoffs/HANDOVER.md")), &[]).0, 2);
    }

    /// The Bash route: a heredoc into `.omc/handoffs/` is no notes write any more.
    #[test]
    fn a_bash_write_of_a_new_foreign_handover_is_not_a_notes_write() {
        let h = home("ho-bash");
        let cmd = format!("cat > {h}/.omc/handoffs/HANDOVER-x.md <<'EOF'\nstate\nEOF");
        let p = json!({"hook_event_name": "PreToolUse", "tool_name": "Bash", "tool_input": {"command": cmd}, "cwd": h, "session_id": "s1"});
        let (code, out) = run("command", "PreToolUse", p, &[]);
        assert_eq!(code, 2, "{out}");
        let ok = json!({"hook_event_name": "PreToolUse", "tool_name": "Bash", "tool_input": {"command": format!("cat > {h}/.omc/notepad.md <<'EOF'\nx\nEOF")}, "cwd": h, "session_id": "s1"});
        assert_eq!(run("command", "PreToolUse", ok, &[]).0, 0, "other .omc notes stay allowed");
    }
}

mod handover_hint {
    use super::*;

    fn ups(h: &str, prompt: &str, envs: &[(&str, &str)]) -> String {
        let p = json!({"hook_event_name": "UserPromptSubmit", "session_id": "s1", "cwd": h, "prompt": prompt});
        run("auto-handover", "UserPromptSubmit", p, envs).1
    }

    /// The reported prompt: "write a comprehensive handover" without the skill loaded.
    #[test]
    fn a_plain_words_handover_request_gets_the_skill_and_the_exact_path() {
        let h = home("hint");
        let o = ups(&h, "write a comprehensive handover", &[]);
        let want = format!(".anti-hall/handovers/{}/s1/HANDOVER.md", today());
        assert!(o.contains(&want) && o.contains("/anti-hall:handover"), "{o}");
        for quiet in ["please continue", "how does the handover index work?", "/anti-hall:handover"] {
            let q = ups(&h, quiet, &[]);
            assert!(!q.contains("Handover asked"), "{quiet}: {q}");
        }
        assert!(!ups(&h, "write a handover", &[("ANTIHALL_AUTO_HANDOVER_PROMPT_HINT", "0")]).contains("Handover asked"), "switched off");
    }
}

mod wrapper_scripts {
    use super::*;

    /// The context in which the main-thread heavy-command gate blocks: a DevSwarm checkout (as tests/it/fw1_command.rs sets it up).
    const DEVSWARM: [(&str, &str); 4] =
        [("CLAUDE_CODE_ENTRYPOINT", "cli"), ("DEVSWARM_REPO_ID", "r1"), ("DEVSWARM_SOURCE_BRANCH", "feat"), ("ANTIHALL_INGEST_DRY_RUN", "1")];

    fn bash_env(h: &str, cmd: &str, env: &[(&str, &str)]) -> (i32, String) {
        let p = json!({"hook_event_name": "PreToolUse", "tool_name": "Bash", "tool_input": {"command": cmd}, "cwd": h, "session_id": "s1"});
        let all: Vec<(&str, &str)> = DEVSWARM.iter().chain(env.iter()).copied().collect();
        run("command", "PreToolUse", p, &all)
    }

    fn bash(h: &str, cmd: &str) -> (i32, String) {
        bash_env(h, cmd, &[])
    }

    fn script(h: &str, name: &str, body: &str) {
        std::fs::create_dir_all(format!("{h}/.git")).unwrap();
        std::fs::write(format!("{h}/.git/HEAD"), "ref: refs/heads/main\n").unwrap();
        std::fs::create_dir_all(format!("{h}/bin")).unwrap();
        std::fs::write(format!("{h}/bin/{name}"), body).unwrap();
    }

    /// The reported block: `bash bin/deploy-skyfb.sh ... | tail -25` was "a heavy command (pytest)": pytest appears only in the script's
    /// comments ("(pytest exit 2," opened a segment whose verb was pytest).
    #[test]
    fn a_word_in_a_comment_of_a_wrapped_script_is_no_command() {
        let h = home("wrap-comment");
        script(&h, "run.sh", "#!/usr/bin/env bash\n# the old step aborted collection outright (pytest exit 2,\n#   jest; cargo test\necho ok\n");
        let (code, out) = bash(&h, "bash bin/run.sh --only a 2>&1 | tail -25");
        assert_eq!(code, 0, "{out}");
        script(&h, "run.sh", "#!/usr/bin/env bash\n# a note\npytest -q tests/\n");
        let (code, out) = bash(&h, "bash bin/run.sh 2>&1 | tail -25");
        assert_eq!(code, 2, "a real test step still makes the wrapper heavy: {out}");
        assert!(out.contains("pytest"), "{out}");
    }

    /// A deploy script runs in the main thread: judged as written, whatever test or build step its body holds; the switch restores #547.
    #[test]
    fn a_deploy_script_is_judged_as_written() {
        let h = home("wrap-deploy");
        script(&h, "deploy-skyfb.sh", "#!/usr/bin/env bash\npytest -q tests/\necho deployed\n");
        let cmd = "bash bin/deploy-skyfb.sh --only functions:a 2>&1 | tail -25";
        let (code, out) = bash(&h, cmd);
        assert_eq!(code, 0, "{out}");
        let (code, out) = bash_env(&h, cmd, &[("ANTIHALL_COMMAND_DEPLOY_SCRIPTS_AS_WRITTEN", "0")]);
        assert_eq!(code, 2, "switched off: judged by the body (#547): {out}");
    }
}

mod questions {
    use super::*;

    /// `config explain guards.denyChildQuestions` reported "not a known setting": explain only knew TOML keys. It now resolves a
    /// settings.json key through its descriptor and shows the value the checks read.
    #[test]
    fn config_explain_resolves_a_switch_through_its_descriptor() {
        let h = home("explain");
        let v = crate::cfgstore::explain_descriptor("guards.denyChildQuestions", &RequestEnv::from_pairs([("HOME", h.as_str())])).expect("a known switch");
        assert_eq!(v["value"], json!(true), "{v}");
        assert_eq!(v["descriptor"], json!("ask_guard.child_deny_setting"), "{v}");
        assert_eq!(v["source"], json!("default"), "{v}");
        let off = crate::cfgstore::explain_descriptor(
            "guards.denyChildQuestions",
            &RequestEnv::from_pairs([("HOME", h.as_str()), ("ANTIHALL_DENY_CHILD_QUESTIONS", "0")]),
        )
        .unwrap();
        assert_eq!((off["value"].clone(), off["source"].clone()), (json!(false), json!("env")), "{off}");
        std::fs::write(format!("{h}/.anti-hall/settings.json"), json!({"guards": {"denyChildQuestions": false}}).to_string()).unwrap();
        let file = crate::cfgstore::explain_descriptor("guards.denyChildQuestions", &RequestEnv::from_pairs([("HOME", h.as_str())])).unwrap();
        assert_eq!((file["value"].clone(), file["source"].clone()), (json!(false), json!("settings")), "{file}");
        assert!(crate::cfgstore::explain_descriptor("guards.noSuchSwitch", &RequestEnv::from_pairs([("HOME", h.as_str())])).is_none());
    }

    /// ask_guard.child_deny is live: a DevSwarm child's AskUserQuestion is refused by default.
    #[test]
    fn a_workspace_child_question_is_denied_by_default() {
        let h = home("child-ask");
        let p = json!({"hook_event_name": "PreToolUse", "tool_name": "AskUserQuestion", "tool_input": {"questions": [{"question": "Which one?"}]}, "cwd": h, "session_id": "s1"});
        let (code, out) = run("ask-guard", "PreToolUse", p.clone(), &[("DEVSWARM_SOURCE_BRANCH", "main")]);
        assert_eq!(code, 2, "{out}");
        assert_eq!(run("ask-guard", "PreToolUse", p, &[("DEVSWARM_SOURCE_BRANCH", "main"), ("ANTIHALL_DENY_CHILD_QUESTIONS", "0")]).0, 0);
    }

    fn stop(h: &str, reply: &str) -> String {
        let p = json!({"hook_event_name": "Stop", "session_id": "s1", "cwd": h, "transcript_path": format!("{h}/t.jsonl"), "last_assistant_message": reply});
        run("afk-mode", "Stop", p, &[]).1
    }

    /// A coordinator under the owner's no-stop order (no AFK flag) ended on "Want me to X?": nothing held it, since the question hold
    /// ran only with the AFK flag. Offers that do not end on a question mark are held too.
    #[test]
    fn a_trailing_offer_is_held_under_a_no_stop_order_and_under_afk() {
        let h = home("offer");
        let ups = json!({"hook_event_name": "UserPromptSubmit", "session_id": "s1", "cwd": h, "transcript_path": format!("{h}/t.jsonl"), "prompt": "no stopping until the plan is done"});
        run("afk-mode", "UserPromptSubmit", ups, &[]);
        let o = stop(&h, "Fixed the parser.\n\nWant me to also open the PR?");
        assert!(o.contains("\"decision\":\"block\"") && o.contains("Do instead: do it now and report the result"), "{o}");
        let o = stop(&h, "All green.\nLet me know if you want me to deploy it.");
        assert!(o.contains("offering work"), "no question mark: {o}");
        assert!(stop(&h, "Want me to deploy?").is_empty(), "capped at afk.question_max_holds");
        let plain = home("offer-plain");
        assert!(stop(&plain, "Want me to also open the PR?").is_empty(), "no AFK and no no-stop order: an owner who is here may be asked");
        // AFK on
        let afk = home("offer-afk");
        let on = json!({"hook_event_name": "UserPromptSubmit", "session_id": "s1", "cwd": afk, "transcript_path": format!("{afk}/t.jsonl"), "prompt": "afk"});
        run("afk-mode", "UserPromptSubmit", on, &[]);
        let o = stop(&afk, "Done.\nIf you'd like, I can also update the docs.");
        assert!(o.contains("offering work"), "{o}");
    }
}

mod usage_source {
    use super::*;

    fn ups(h: &str, envs: &[(&str, &str)]) -> String {
        let p = json!({"hook_event_name": "UserPromptSubmit", "session_id": "lc1", "cwd": h, "prompt": "go on"});
        let mut all = vec![("ANTIHALL_LIMIT_THRESHOLD", "60")];
        all.extend_from_slice(envs);
        run("limit-conserve-inject", "UserPromptSubmit", p, &all).1
    }

    fn omc_cache(h: &str, age_ms: i64, weekly: u32) {
        let now = crate::checks::taskkit::time::now_ms();
        let reset = crate::checks::taskkit::time::iso((now + 3 * 86_400_000) as _);
        std::fs::create_dir_all(format!("{h}/.claude/plugins/oh-my-claudecode")).unwrap();
        let body = json!({"timestamp": now - age_ms, "data": {"weeklyPercent": weekly, "weeklyResetsAt": reset}});
        std::fs::write(format!("{h}/.claude/plugins/oh-my-claudecode/.usage-cache-anthropic.json"), body.to_string()).unwrap();
    }

    /// The reported case: an OMC usage cache nothing refreshes (2 days old) said weekly 70% with its reset days ahead, and limit
    /// conservation acted on it. A stale snapshot is unknown now, whatever its reset time.
    #[test]
    fn a_stale_usage_cache_with_a_future_reset_is_not_acted_on() {
        let stale = home("usage-stale");
        omc_cache(&stale, 2 * 86_400_000, 70);
        assert!(!ups(&stale, &[]).contains("limit conservation is active"), "stale: unknown");
        let fresh = home("usage-fresh");
        omc_cache(&fresh, 60_000, 70);
        assert!(ups(&fresh, &[]).contains("limit conservation is active"), "a fresh reading still acts");
    }

    /// limitConserve.usageSource: auto takes the fresher of the statusline snapshot and the OMC cache; omc-cache ignores the snapshot.
    #[test]
    fn the_statusline_snapshot_is_a_usage_source() {
        let now = crate::checks::taskkit::time::now_ms();
        let snap = |h: &str| {
            std::fs::write(format!("{h}/.anti-hall/usage-statusline.json"), json!({"timestamp": now, "source": "statusline", "data": {"weeklyPercent": 90}}).to_string()).unwrap();
        };
        let auto = home("usage-auto");
        omc_cache(&auto, 2 * 86_400_000, 10);
        snap(&auto);
        assert!(ups(&auto, &[]).contains("limit conservation is active"), "auto: the fresh statusline snapshot");
        let omc_only = home("usage-omc-only");
        omc_cache(&omc_only, 2 * 86_400_000, 10);
        snap(&omc_only);
        assert!(!ups(&omc_only, &[("ANTIHALL_LIMIT_USAGE_SOURCE", "omc-cache")]).contains("limit conservation is active"));
    }
}

mod omc_loop_and_compact {
    use super::*;

    fn context(h: &str, used: u64) -> String {
        let tr = format!("{h}/t.jsonl");
        let line = json!({"type": "assistant", "message": {"usage": {"input_tokens": 10, "cache_creation_input_tokens": used, "cache_read_input_tokens": 0}, "content": [{"type": "text", "text": "x"}]}});
        std::fs::write(&tr, format!("{line}\n")).unwrap();
        tr
    }

    fn omc_on(h: &str) {
        std::fs::create_dir_all(format!("{h}/.claude")).unwrap();
        std::fs::write(format!("{h}/.claude/settings.json"), json!({"enabledPlugins": {"oh-my-claudecode@omc": true}}).to_string()).unwrap();
    }

    fn omc_loop(h: &str) {
        std::fs::create_dir_all(format!("{h}/.omc/state")).unwrap();
        let now = crate::checks::taskkit::time::iso(crate::checks::taskkit::time::now_ms());
        std::fs::write(format!("{h}/.omc/state/ralph-state.json"), json!({"active": true, "last_checked_at": now, "session_id": "s1"}).to_string()).unwrap();
    }

    fn ups(h: &str, tr: &str) -> String {
        std::fs::write(format!("{h}/.anti-hall/settings.json"), json!({"autoHandover": {"pct": 85}}).to_string()).unwrap();
        let p = json!({"hook_event_name": "UserPromptSubmit", "session_id": "s1", "cwd": h, "transcript_path": tr, "prompt": "go on"});
        run("auto-handover", "UserPromptSubmit", p, &[("ANTIHALL_CONTEXT_WINDOW_TOKENS", "200000")]).1
    }

    /// An OMC autonomous loop drives the session: no stopping-point advice against it (as task-guard defers to the loop).
    #[test]
    fn an_active_omc_loop_keeps_the_context_checks_quiet() {
        let plain = home("loop-off");
        let fire = ups(&plain, &context(&plain, 180_000));
        assert!(fire.contains("/compact") || fire.contains("stopping point") || fire.contains("handover"), "without a loop the fire speaks: {fire}");
        let looped = home("loop-on");
        omc_on(&looped);
        omc_loop(&looped);
        let quiet = ups(&looped, &context(&looped, 180_000));
        assert!(!quiet.contains("/compact") && !quiet.contains("stopping point"), "{quiet}");
        assert_ne!(fire, quiet);
    }

    fn stop(h: &str, tr: &str, envs: &[(&str, &str)]) -> (i32, String) {
        let p = json!({"hook_event_name": "Stop", "session_id": "s1", "cwd": h, "transcript_path": tr, "last_assistant_message": "Context is at 80%. You should run /compact now before we continue."});
        let mut all = vec![("ANTIHALL_CONTEXT_WINDOW_TOKENS", "200000")];
        all.extend_from_slice(envs);
        run("compact-advice-guard", "Stop", p, &all)
    }

    /// OMC's context guard orders /compact from 75%; anti-hall blocked compact advice below 83% (93 minus 10): contrary orders for one
    /// Stop. With OMC enabled and the context in its band, compact-advice-guard defers.
    #[test]
    fn compact_advice_defers_to_omc_s_context_guard() {
        let alone = home("ca-alone");
        let (code, out) = stop(&alone, &context(&alone, 160_000), &[]);
        assert!(out.contains("\"decision\":\"block\""), "anti-hall alone blocks the advice at 80%: {code} {out}");
        let with = home("ca-omc");
        omc_on(&with);
        let (_, out) = stop(&with, &context(&with, 160_000), &[]);
        assert!(!out.contains("\"decision\":\"block\""), "OMC orders /compact at 80%: {out}");
        let off = home("ca-omc-off");
        omc_on(&off);
        let (_, out) = stop(&off, &context(&off, 160_000), &[("ANTIHALL_COMPACT_ADVICE_DEFER_TO_OMC", "0")]);
        assert!(out.contains("\"decision\":\"block\""), "switched off: {out}");
    }
}
