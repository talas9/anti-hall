//! Unit tests of the coordinator-work-guard check. The full Node-vs-engine comparison is
//! `parity/run-coordinator-work-guard.js`.
use super::*;
use serde_json::json;

fn bash(extra: Value) -> Value {
    let mut p = json!({"hook_event_name": "PreToolUse", "tool_name": "Bash", "session_id": "s1", "tool_input": {"command": "git commit -am x"}});
    for (k, v) in extra.as_object().unwrap() {
        p[k] = v.clone();
    }
    p
}

#[test]
fn calls_that_are_not_bash_or_have_no_session_say_nothing() {
    assert!(decide(&json!({"tool_name": "Edit", "session_id": "s"})).is_none());
    assert!(decide(&bash(json!({"session_id": "   "}))).is_none());
    assert!(decide(&bash(json!({"session_id": 5}))).is_none());
    assert!(decide(&json!([1])).is_none());
    assert!(decide(&json!(null)).is_none());
}

#[test]
fn a_subagent_marker_in_the_payload_proves_it_is_not_the_main_thread() {
    assert!(decide(&bash(json!({"agent_id": "a1"}))).is_none());
    assert!(decide(&bash(json!({"agent_type": "Explore"}))).is_none());
    assert!(decide(&bash(json!({"agent_id": 7}))).is_none());
    assert!(decide(&bash(json!({"agent_id": {}}))).is_none(), "an object is truthy");
}

#[test]
fn falsy_markers_prove_nothing_on_a_claude_payload_but_count_on_a_codex_one() {
    for v in [json!(""), json!(0), json!(false), json!(null)] {
        assert_eq!(decide(&bash(json!({"agent_id": v}))), Some(Verdict::Defer), "{v}");
    }
    let codex = |extra: Value| {
        bash(json!({"turn_id": "t", "model": "gpt-5.5"})).as_object().unwrap().iter().chain(extra.as_object().unwrap().iter()).fold(
            json!({}),
            |mut acc, (k, v)| {
                acc[k] = v.clone();
                acc
            },
        )
    };
    assert!(decide(&codex(json!({"agent_id": ""}))).is_none(), "present and non-null counts on Codex");
    assert_eq!(decide(&codex(json!({"agent_id": null}))), Some(Verdict::Defer));
    assert_eq!(decide(&codex(json!({}))), Some(Verdict::Defer));
}

#[test]
fn the_main_thread_defers_to_the_node_guard_which_owns_the_window() {
    assert_eq!(decide(&bash(json!({}))), Some(Verdict::Defer));
    assert_eq!(decide(&bash(json!({"hook_event_name": "PostToolUse"}))), Some(Verdict::Defer));
}

#[test]
fn run_without_the_payload_defers_for_bash() {
    let ti = json!({"command": "ls"});
    let s = |tool| Subject { event: "PreToolUse", tool, cwd: None, tool_input: &ti, prompt: None };
    assert_eq!(CoordinatorWorkGuard.run(&s(Some("Bash")), &Value::Null), Some(Verdict::Defer));
    assert!(CoordinatorWorkGuard.run(&s(Some("Read")), &Value::Null).is_none());
}

// ---- the PostToolUse pass (post.rs). The full Node-vs-engine comparison is `tests/node_parity` (the Rust Node-parity test).
mod post_pass {
    use super::super::post::{decide_post, provably_not_work};
    use super::*;
    use crate::checks::git::util::Settings;
    use crate::checks::guardkit::text::js_trim;
    use crate::reqenv::RequestEnv;

    struct Fx {
        home: String,
        root: String,
        env: RequestEnv,
        st: Settings,
    }

    fn fx(tag: &str, extra: &[(&str, &str)]) -> Fx {
        let d = std::env::temp_dir().join(format!("ah-cwp-{tag}-{}", std::process::id()));
        crate::discard::harmless(std::fs::remove_dir_all(&d));
        let home = d.join("home");
        let root = d.join("plugin");
        std::fs::create_dir_all(home.join(".anti-hall")).unwrap();
        std::fs::create_dir_all(root.join(".claude-plugin")).unwrap();
        std::fs::write(root.join(".claude-plugin/plugin.json"), r#"{"name":"x","version":"9.8.7"}"#).unwrap();
        let mut pairs: Vec<(String, String)> = vec![("HOME".into(), home.to_string_lossy().to_string()), ("CLAUDE_CODE_ENTRYPOINT".into(), "cli".into())];
        pairs.extend(extra.iter().map(|(k, v)| (k.to_string(), v.to_string())));
        let env = RequestEnv::from_pairs(pairs);
        let st = Settings::from_env(&env);
        Fx { home: home.to_string_lossy().to_string(), root: root.to_string_lossy().to_string(), env, st }
    }

    fn post(sid: &str, cmd: &str, id: &str) -> Value {
        json!({"hook_event_name": "PostToolUse", "tool_name": "Bash", "session_id": sid, "tool_use_id": id, "tool_input": {"command": cmd}})
    }

    fn run(f: &Fx, p: &Value) -> Option<Verdict> {
        decide_post(p, &f.st, &f.env, &f.root)
    }

    fn win(f: &Fx, sid: &str) -> String {
        std::fs::read_to_string(format!("{}/.anti-hall/coordinator-work-session-{sid}.json", f.home)).unwrap_or_default()
    }

    fn seed(f: &Fx, sid: &str, body: &str) {
        std::fs::write(format!("{}/.anti-hall/coordinator-work-session-{sid}.json", f.home), body).unwrap();
    }

    #[test]
    fn provably_read_only_commands_and_nothing_else_are_not_work() {
        for c in
            ["ls", "ls -la", "git status", "git log --oneline | wc -l", "pwd && ls; git diff", "cat a.txt | head -20", "which node\nwhoami", "grep -r foo src"]
        {
            assert!(provably_not_work(c), "{c}");
        }
        for c in [
            "",
            "  ",
            "git commit -m x",
            "git diff --output=x",
            "git log -o x",
            "ls > out",
            "ls $(pwd)",
            "ls *.js",
            "echo hi",
            "FOO=1 ls",
            "ls &",
            "git push",
            "ls é",
            &format!("ls {}", "a".repeat(5000)),
        ] {
            assert!(!provably_not_work(c), "{c}");
        }
    }

    #[test]
    fn a_stored_pre_verdict_is_reused_and_the_window_file_has_the_node_bytes() {
        let f = fx("stored", &[]);
        seed(
            &f,
            "s1",
            r#"{"v":1,"version":"0.1.0","firstTs":5,"ts":[],"armed":true,"calls":0,"work":0,"blocks":0,"lastBlockAt":0,"skippedWouldBlock":0,"pre":[{"id":"p1","work":true,"blockable":true},{"id":"p2","work":false,"blockable":false}]}"#,
        );
        // the command text says "ls" but the stored verdict says work: the stored verdict wins (the script may be gone by Post time)
        assert_eq!(run(&f, &post("s1", "ls", "p1")), Some(Verdict::Allow));
        let w = win(&f, "s1");
        assert!(w.starts_with(r#"{"v":1,"version":"0.1.0","firstTs":5,"ts":[17"#), "{w}");
        assert!(
            w.contains(
                r#"],"armed":true,"calls":1,"work":1,"blocks":0,"lastBlockAt":0,"skippedWouldBlock":0,"pre":[{"id":"p2","work":false,"blockable":false}]}"#
            ),
            "{w}"
        );
        // a stored "not work" verdict records a call that is not work, whatever the command is
        assert_eq!(run(&f, &post("s1", "git commit -m x", "p2")), Some(Verdict::Allow));
        assert!(win(&f, "s1").contains(r#""calls":2,"work":1,"#) && win(&f, "s1").ends_with(r#""pre":[]}"#), "{}", win(&f, "s1"));
    }

    #[test]
    fn a_call_the_engine_cannot_classify_goes_to_node_and_records_nothing() {
        let f = fx("defer", &[]);
        assert_eq!(run(&f, &post("s2", "git commit -m x", "none")), Some(Verdict::Defer));
        assert_eq!(run(&f, &post("s2", "git commit -m x", "")), Some(Verdict::Defer));
        assert!(win(&f, "s2").is_empty(), "nothing is written before the call is decided");
        // a command that is provably not work needs no stored verdict, and a new window file carries the manifest version
        assert_eq!(run(&f, &post("s2", "git status", "x")), Some(Verdict::Allow));
        assert!(win(&f, "s2").starts_with(r#"{"v":1,"version":"9.8.7","firstTs":1"#), "{}", win(&f, "s2"));
    }

    #[test]
    fn a_nudge_is_said_once_per_crossing_and_counted_in_the_metrics_and_the_trips_log() {
        let f = fx("nudge", &[("ANTIHALL_COORDINATOR_WORK_NUDGE_AT", "2"), ("ANTIHALL_COORDINATOR_WORK_BLOCK_AT", "5")]);
        let ver = r#""version":"0.1.0""#;
        seed(
            &f,
            "s3",
            &format!(
                r#"{{"v":1,{ver},"firstTs":5,"ts":[],"armed":true,"calls":0,"work":0,"blocks":0,"lastBlockAt":0,"skippedWouldBlock":0,"pre":[{{"id":"a","work":true,"blockable":true}},{{"id":"b","work":true,"blockable":true}},{{"id":"c","work":true,"blockable":true}}]}}"#
            ),
        );
        assert_eq!(run(&f, &post("s3", "x", "a")), Some(Verdict::Allow));
        let Some(Verdict::Advisory(j)) = run(&f, &post("s3", "x", "b")) else { panic!("the second work call crosses the threshold") };
        assert_eq!(
            j,
            "{\"hookSpecificOutput\":{\"hookEventName\":\"PostToolUse\",\"additionalContext\":\"\u{26a0}\u{fe0f} anti-hall \u{b7} coordinator-work-guard: 2 state-changing calls in the main thread within 10 min.\\nDo instead: delegate the rest to a subagent now; call 5 in the window is blocked.\"}}"
        );
        assert_eq!(run(&f, &post("s3", "x", "c")), Some(Verdict::Allow), "disarmed until the count falls below the threshold again");
        let m = std::fs::read_to_string(format!("{}/.anti-hall/coordinator-work-metrics.json", f.home)).unwrap();
        assert_eq!(m, r#"{"v":1,"nudges":1,"blocks":0,"byVersion":{}}"#);
        let t = std::fs::read_to_string(format!("{}/.anti-hall/coordinator-work-trips.log", f.home)).unwrap();
        assert!(t.starts_with(r#"{"ts":"20"#) && t.trim_end().ends_with(r#"Z","event":"nudge","count":2}"#), "{t}");
        // skipped by name: the call is recorded, nothing is said or counted
        let g = fx("nudge-skip", &[("ANTIHALL_COORDINATOR_WORK_NUDGE_AT", "1")]);
        let future = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis() + 3_600_000;
        std::fs::write(format!("{}/.anti-hall/skip.json", g.home), format!("{{\"coordinator-work-guard\":{future}}}")).unwrap();
        seed(
            &g,
            "s",
            &format!(
                r#"{{"v":1,{ver},"firstTs":5,"ts":[],"armed":true,"calls":0,"work":0,"blocks":0,"lastBlockAt":0,"skippedWouldBlock":0,"pre":[{{"id":"a","work":true,"blockable":true}}]}}"#
            ),
        );
        assert_eq!(run(&g, &post("s", "x", "a")), Some(Verdict::Allow));
        assert!(!std::path::Path::new(&format!("{}/.anti-hall/coordinator-work-metrics.json", g.home)).exists());
    }

    #[test]
    fn who_is_the_main_thread_and_the_switches_decide_whether_anything_is_recorded() {
        let f = fx("who", &[]);
        let mut p = post("w", "git status", "i");
        p["agent_id"] = json!("a1");
        assert!(run(&f, &p).is_none(), "a subagent is not the main thread");
        assert!(run(&f, &json!({"tool_name": "Edit", "session_id": "w"})).is_none());
        assert!(run(&f, &post("  ", "git status", "i")).is_none());
        for (ep, recorded) in [("cli", true), ("vscode", true), ("terminal_ide_x", true), ("agent_tool", false), ("sdk", false), ("", false)] {
            let g = fx(&format!("ep-{ep}"), &[("CLAUDE_CODE_ENTRYPOINT", ep)]);
            let r = run(&g, &post("e", "git status", "i"));
            assert_eq!(r.is_some(), recorded, "{ep}");
        }
        for extra in [("ANTIHALL_COMMAND_GUARD", "off"), ("ANTIHALL_COORDINATOR_WORK_WINDOW_MINUTES", "0")] {
            assert!(run(&fx("sw", &[extra]), &post("e", "git status", "i")).is_none(), "{extra:?}");
        }
    }

    #[test]
    fn a_lock_held_by_someone_else_hands_the_call_to_node_and_an_old_one_is_taken_over() {
        let f = fx("lock", &[("ANTIHALL_TEST_HOME_ISOLATED", "1"), ("ANTIHALL_COORDINATOR_WORK_LOCK_WAIT_MS", "20")]);
        let lock = format!("{}/.anti-hall/coordinator-work-session-l.json.lock", f.home);
        let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis();
        std::fs::write(&lock, format!(r#"{{"pid":{},"host":"h","ts":{},"token":"t"}}"#, std::process::id(), now + 3_600_000)).unwrap();
        assert_eq!(run(&f, &post("l", "git status", "i")), Some(Verdict::Defer));
        assert!(win(&f, "l").is_empty());
        std::fs::write(&lock, format!(r#"{{"pid":999999,"host":"h","ts":{},"token":"t"}}"#, now - 60_000)).unwrap();
        assert_eq!(run(&f, &post("l", "git status", "i")), Some(Verdict::Allow));
        assert!(!win(&f, "l").is_empty() && !std::path::Path::new(&lock).exists(), "the abandoned lock was taken over and released");
    }

    #[test]
    fn stale_window_files_are_folded_into_the_metrics_once_per_window() {
        let f = fx("fold", &[]);
        let d = format!("{}/.anti-hall", f.home);
        let old = |name: &str, body: &str| {
            let p = format!("{d}/{name}");
            std::fs::write(&p, body).unwrap();
            let t = std::time::SystemTime::now() - std::time::Duration::from_secs(10 * 24 * 3600);
            std::fs::File::options().write(true).open(&p).unwrap().set_modified(t).unwrap();
        };
        old(
            "coordinator-work-session-b.json",
            r#"{"v":1,"version":"0.2.0","firstTs":5,"ts":[],"armed":true,"calls":7,"work":7,"blocks":4,"lastBlockAt":0,"skippedWouldBlock":0,"pre":[]}"#,
        );
        old("coordinator-work-session-a.json", r#"{"version":"0.1.0","calls":5,"work":3,"blocks":1,"skippedWouldBlock":2}"#);
        old("coordinator-work-session-c.json", "{not json");
        assert_eq!(run(&f, &post("fresh", "git status", "i")), Some(Verdict::Allow));
        assert_eq!(
            std::fs::read_to_string(format!("{d}/coordinator-work-metrics.json")).unwrap(),
            r#"{"v":1,"nudges":0,"blocks":0,"byVersion":{"0.1.0":{"sessions":1,"calls":5,"work":3,"blocks":1,"skippedWouldBlock":2},"0.2.0":{"sessions":1,"calls":7,"work":7,"blocks":4,"skippedWouldBlock":0},"unknown":{"sessions":1,"calls":0,"work":0,"blocks":0,"skippedWouldBlock":0}},"maxSessionBlocks":4}"#,
            "folded in name order (a, b, c), the corrupt one as an unknown-version empty window"
        );
        for n in ["a", "b", "c"] {
            assert!(!std::path::Path::new(&format!("{d}/coordinator-work-session-{n}.json")).exists(), "{n} was folded away");
        }
        assert!(std::path::Path::new(&format!("{d}/.coordinator-work-fold-stamp.json")).exists());
        // within the throttle window nothing more is folded
        old("coordinator-work-session-z.json", "{}");
        run(&f, &post("fresh", "git status", "j"));
        assert!(std::path::Path::new(&format!("{d}/coordinator-work-session-z.json")).exists());
        assert_eq!(js_trim(" x "), "x");
    }
}
