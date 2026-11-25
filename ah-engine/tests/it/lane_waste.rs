//! GH #270: `lane-test-guard` (PreToolUse on Bash, subagents only, Claude and Codex; engine-only) blocks suite-scale test commands
//! a lane agent runs while it waits on the shared build lock, and lets `cargo check` and a filtered single-module test through.
//! `queued-wait-guard` (same shape) blocks a build or test command started with run_in_background and a long sleep or poll loop.
//! The tables below are the decision record. Tests run under a scratch HOME.
#![allow(clippy::unwrap_used, clippy::expect_used)] // a test crate: a panic is the failure report, and E2 exempts tests

use serde_json::{Value, json};
use std::io::Write;
use std::path::PathBuf;
use std::process::{Command, Stdio};

fn plugin() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../plugins/anti-hall")
}

pub(crate) fn run(argv: &[&str], extra: &[(&str, &str)], stdin: &str) -> (i32, String, String) {
    let dir = PathBuf::from(env!("CARGO_TARGET_TMPDIR")).join(format!("lanewaste-{}", std::process::id()));
    std::fs::create_dir_all(dir.join("home")).unwrap();
    let mut c = Command::new(env!("CARGO_BIN_EXE_ah-engine"));
    c.args(argv)
        .env_clear()
        .env("PATH", std::env::var("PATH").unwrap_or_default())
        .env("HOME", dir.join("home"))
        .env("AH_ENGINE_DIR", dir.join("state"))
        .env("AH_ENGINE_NOSPAWN", "1")
        .env("AH_ENGINE_PLUGIN_ROOT", plugin())
        .current_dir(&dir)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    c.envs(extra.iter().copied());
    let mut ch = c.spawn().unwrap();
    ch.stdin.take().unwrap().write_all(stdin.as_bytes()).unwrap();
    let o = ch.wait_with_output().unwrap();
    (o.status.code().unwrap_or(-1), String::from_utf8_lossy(&o.stdout).to_string(), String::from_utf8_lossy(&o.stderr).to_string())
}

/// One Bash tool call from the caller `who` ("main", "subagent", "codex", "codex-subagent").
fn payload(cmd: &str, who: &str) -> Value {
    let mut p = json!({"session_id": "s1", "cwd": "/tmp", "hook_event_name": "PreToolUse", "tool_name": "Bash", "tool_input": {"command": cmd}});
    let extra = match who {
        "subagent" => json!({"agent_id": "a1", "agent_type": "general-purpose"}),
        "codex" => json!({"turn_id": "t1", "model": "gpt"}),
        "codex-subagent" => json!({"turn_id": "t1", "model": "gpt", "agent_id": "a1", "agent_type": "worker"}),
        _ => json!({}),
    };
    for (k, v) in extra.as_object().unwrap() {
        p[k] = v.clone();
    }
    p
}

fn test_guard(cmd: &str, who: &str, env_pairs: &[(&str, &str)]) -> (i32, String, String) {
    run(&["check", "lane-test-guard"], env_pairs, &payload(cmd, who).to_string())
}

/// (command, None = allowed, Some(label named in the block)).
fn suite_table() -> Vec<(&'static str, Option<&'static str>)> {
    vec![
        ("cargo test", Some("cargo test")),
        ("cargo test --workspace", Some("cargo test")),
        ("cargo test -p ah-engine", Some("cargo test")),
        ("cargo test -j4", Some("cargo test")),
        ("cargo test --workspace foo", Some("cargo test")),
        ("cargo test --all", Some("cargo test")),
        ("cargo +nightly test", Some("cargo test")),
        ("cargo nextest run", Some("cargo nextest")),
        ("cargo nextest run --no-fail-fast", Some("cargo nextest")),
        ("CARGO_TARGET_DIR=/x lockf /x/l nice -n 10 cargo test -j4", Some("cargo test")),
        ("cd ah-engine && cargo test", Some("cargo test")),
        ("sh -c 'cargo test'", Some("cargo test")),
        ("node --test", None), // lock-free runner: allowed while guards.laneTestLockBoundOnly is on (#621)
        ("node --test tests/", None),
        ("./test.sh", Some("test.sh")),
        ("bash ah-engine/test.sh", None), // a script run through an interpreter is out of reach
        ("ah-engine/test.sh", Some("test.sh")),
        ("make test", Some("make test")),
        ("npm test", None),
        ("pnpm run test", None),
        ("pytest", None),
        ("flutter test", None),
        ("./a7-replay.sh", Some("replay or soak runner")),
        ("soak-run.sh --hours 2", Some("replay or soak runner")),
        // allowed: a build check, a filtered single-module test, text that merely names a runner
        ("cargo check", None),
        ("cargo check --tests -j4", None),
        ("CARGO_TARGET_DIR=/x lockf /x/l nice -n 10 cargo check -j4 --lib", None),
        ("cargo test checks::lane_test::", None),
        ("cargo test lane_test -- --nocapture", None),
        ("cargo test --test lane_waste", None),
        ("cargo test -p ah-engine lane_test", None),
        ("cargo test -- lane_test", None),
        ("cargo nextest run lane_test", None),
        ("cargo nextest run -E 'test(lane_test)'", None),
        ("cargo test --no-run", None),
        ("cargo nextest list", None),
        ("node --test tests/hooks/x.test.js", None),
        ("git commit -m 'run cargo test later'", None),
        ("echo cargo test", None),
        ("git status", None),
        ("ls ah-engine", None),
    ]
}

#[test]
fn the_decision_table_holds_for_a_subagent_on_both_hosts() {
    for who in ["subagent", "codex-subagent"] {
        for (cmd, want) in suite_table() {
            let (code, out, _) = test_guard(cmd, who, &[]);
            match want {
                None => assert_eq!(code, 0, "{who}: {cmd} must be allowed: {out}"),
                Some(label) => {
                    assert_eq!(code, 2, "{who}: {cmd} must be blocked");
                    assert!(out.contains(&format!("({label})")), "{who}: {cmd}: {out}");
                }
            }
        }
    }
}

/// #621: with guards.laneTestLockBoundOnly off every suite-scale runner is blocked as before; a lock-bound runner is blocked either way.
#[test]
fn lock_bound_only_off_blocks_the_lock_free_runners_too() {
    let off = [("ANTIHALL_LANE_TEST_LOCK_BOUND_ONLY", "0")];
    for (cmd, label) in [("node --test", "node --test"), ("npm test", "npm test"), ("pytest", "pytest"), ("flutter test", "flutter test")] {
        let (code, out, _) = test_guard(cmd, "subagent", &off);
        assert_eq!(code, 2, "{cmd} must be blocked with the switch off");
        assert!(out.contains(&format!("({label})")), "{cmd}: {out}");
        assert_eq!(test_guard(cmd, "subagent", &[]).0, 0, "{cmd} allowed by default");
    }
    for cmd in ["cargo test", "cargo nextest run", "make test", "./test.sh"] {
        assert_eq!(test_guard(cmd, "subagent", &[]).0, 2, "{cmd}: lock-bound stays blocked by default");
    }
    assert_eq!(test_guard("cargo test", "subagent", &off).0, 2);
}

#[test]
fn the_main_session_and_a_codex_main_seat_are_never_judged() {
    for who in ["main", "codex"] {
        for cmd in ["cargo test", "cargo test --workspace", "node --test", "./test.sh"] {
            assert_eq!(test_guard(cmd, who, &[]).0, 0, "{who}: {cmd}");
        }
    }
}

#[test]
fn a_block_uses_the_standard_message_and_reaches_both_hosts_channels() {
    let (code, out, err) = test_guard("cargo test --workspace", "subagent", &[]);
    assert_eq!(code, 2);
    let v: Value = serde_json::from_str(out.trim()).unwrap();
    assert_eq!(v["decision"], "block");
    let reason = v["reason"].as_str().unwrap();
    assert_eq!(err.trim(), reason, "stderr carries the same reason (Codex honors exit 2 only with it there)");
    assert!(reason.starts_with("⛔ test run check: a helper cannot run this full suite (cargo test): cargo test --workspace"), "{reason}");
    assert!(reason.contains("Run a build check or one allowed module test, then report the result."), "{reason}");
    assert_eq!(reason.lines().count(), 2);
}

#[test]
fn the_guard_is_a_setting_an_allow_switch_and_a_skip() {
    assert_eq!(test_guard("cargo test", "subagent", &[("ANTIHALL_LANE_TEST_GUARD", "0")]).0, 0, "guards.laneTestGuard off");
    assert_eq!(test_guard("cargo test", "subagent", &[("ANTIHALL_ALLOW_TEST_SUITES", "1")]).0, 0, "guards.allowTestSuites on");
    assert_eq!(test_guard("cargo test", "subagent", &[("ANTIHALL_ALLOW_TEST_SUITES", "0")]).0, 2);
    assert_eq!(test_guard("cargo test", "subagent", &[]).0, 2, "default on");
}

#[test]
fn a_command_that_fails_to_parse_is_allowed_not_blocked() {
    for cmd in ["", "   ", "echo 'unterminated", "echo \"$(", "<<", "a | | b ;; c", "`"] {
        assert_eq!(test_guard(cmd, "subagent", &[]).0, 0, "{cmd:?}");
    }
    let mut p = payload("", "subagent");
    p["tool_input"] = json!({});
    assert_eq!(run(&["check", "lane-test-guard"], &[], &p.to_string()).0, 0, "no command: nothing to judge");
}

#[test]
fn the_guard_is_wired_for_both_hosts_and_both_orchestration_ports() {
    use ah_engine::dispatch::table as t;
    let has = |host: &str, id: &str| t::entries(host, "PreToolUse").iter().any(|e| e.id == id);
    assert!(has("claude", "lane-test-guard") && has("codex", "lane-test-guard"));
    for rel in ["hooks/hooks.registry.json", "codex/hooks/hooks.registry.json"] {
        let text = std::fs::read_to_string(plugin().join(rel)).unwrap();
        assert!(text.contains("lane-test-guard") && text.contains("ah-hook"), "{rel} routes the guard to the native client");
    }
    assert!(!plugin().join("hooks/lane-test-guard").exists(), "the native guard needs no fallback no-op");
    let schema = std::fs::read_to_string(plugin().join("../anti-hall-node/hooks/lib/settings-schema.js")).unwrap();
    assert!(schema.contains("key: 'laneTestGuard'") && schema.contains("ANTIHALL_LANE_TEST_GUARD"), "guards.laneTestGuard is a registered setting");
    assert!(schema.contains("key: 'allowTestSuites'") && schema.contains("ANTIHALL_ALLOW_TEST_SUITES"), "guards.allowTestSuites is a registered setting");
}

// ---- queued-wait-guard ------------------------------------------------------------------------------------

/// One Bash tool call, optionally started with run_in_background, from the caller `who`.
fn wait_guard(cmd: &str, who: &str, background: bool, env_pairs: &[(&str, &str)]) -> (i32, String, String) {
    let mut p = payload(cmd, who);
    if background {
        p["tool_input"]["run_in_background"] = json!(true);
    }
    run(&["check", "queued-wait-guard"], env_pairs, &p.to_string())
}

/// (command, started in the background, None = allowed, Some(text of the block heading)).
fn wait_table() -> Vec<(&'static str, bool, Option<&'static str>)> {
    const BG: &str = "cannot start this build or test in the background";
    vec![
        ("cargo test", true, Some(BG)),
        ("cargo check -j4", true, Some(BG)),
        ("CARGO_TARGET_DIR=/x lockf /x/l nice -n 10 cargo check -j4", true, Some(BG)),
        ("npm run build", true, Some(BG)),
        ("node --test tests/", true, Some(BG)),
        ("./build.sh", true, Some(BG)),
        ("make", true, Some(BG)),
        ("sh -c 'cargo build'", true, Some(BG)),
        // the same commands in the foreground wait for free
        ("cargo test", false, None),
        ("CARGO_TARGET_DIR=/x lockf /x/l nice -n 10 cargo check -j4", false, None),
        ("npm run build", false, None),
        // a background command that is not heavy
        ("tail -f /tmp/x.log", true, None),
        ("git status", true, None),
        ("echo cargo test", true, None),
        // sleeps
        ("sleep 60", false, Some("wait is too long (60s; limit 30s)")),
        ("sleep 1m", false, Some("wait is too long (60s; limit 30s)")),
        ("sleep 31", false, Some("wait is too long (31s")),
        ("sleep 30", false, None),
        ("sleep 5", false, None),
        ("sleep 0.5", false, None),
        ("cargo check && sleep 120", false, Some("wait is too long (120s")),
        ("until [ -f /tmp/done ]; do sleep 30; done", false, Some("poll loop waits too long (30s per round; limit 5s)")),
        ("while true; do ls; sleep 10; done", false, Some("poll loop waits too long (10s per round")),
        ("for i in 1 2 3; do sleep 6; done", false, Some("poll loop waits too long (6s per round")),
        ("until [ -f /tmp/done ]; do sleep 5; done", false, None),
        ("until [ -f /tmp/done ]; do sleep 2; done", false, None),
        ("sleep 20; echo hi", false, None),
        ("echo 'sleep 600'", false, None),
        ("git commit -m 'no sleep 600 here'", false, None),
        ("sleep", false, None),
        // round 6: an operand that does not parse is an unbounded wait (fail closed); no operand at all is not a wait
        ("sleep abc", false, Some("wait is too long (unbounded")),
        ("sleep $N", false, Some("wait is too long (unbounded")),
        ("sleep infinity", false, Some("wait is too long (unbounded")),
        ("sleep 60>/dev/null", false, Some("wait is too long (60s")),
        ("sleep 60 >/dev/null", false, Some("wait is too long (60s")),
        ("sleep 60&>/dev/null", false, Some("wait is too long (60s")),
        ("sleep 60<x", false, Some("wait is too long (60s")),
        ("sleep 1m>/dev/null", false, Some("wait is too long (60s")),
        ("sleep 60 2>&1", false, Some("wait is too long (60s")),
        ("sleep 60 2>/dev/null", false, Some("wait is too long (60s")),
        ("while true; do sleep 60>/dev/null; done", false, Some("poll loop waits too long (60s")),
        ("while true; do sleep $N; done", false, Some("poll loop waits too long (unbounded")),
        ("sleep 5>/dev/null", false, None),
        ("sleep 5 >/dev/null 2>&1", false, None),
        ("sleep 0.5>/dev/null", false, None),
        ("sleep 2>/dev/null 5", false, None),
        ("timeout 100 sleep $N", false, None),
        // round 7: forms coreutils/BSD sleep accept are not unbounded
        ("sleep .5", false, None),
        ("sleep .1", false, None),
        ("sleep -- 0.5", false, None),
        ("sleep 5.", false, None),
        ("sleep 1 2", false, None),
        ("sleep .1m", false, None),
        ("sleep 1e1", false, None),
        ("sleep 1m 1", false, Some("wait is too long (61s")),
    ]
}

#[test]
fn the_wait_table_holds_for_a_subagent_on_both_hosts() {
    for who in ["subagent", "codex-subagent"] {
        for (cmd, bg, want) in wait_table() {
            let (code, out, _) = wait_guard(cmd, who, bg, &[]);
            match want {
                None => assert_eq!(code, 0, "{who}: {cmd} (background {bg}) must be allowed: {out}"),
                Some(text) => {
                    assert_eq!(code, 2, "{who}: {cmd} (background {bg}) must be blocked");
                    assert!(out.contains(text), "{who}: {cmd}: {out}");
                }
            }
        }
    }
}

#[test]
fn the_main_session_may_wait_and_background() {
    for who in ["main", "codex"] {
        assert_eq!(wait_guard("cargo test", who, true, &[]).0, 0, "{who}: background build");
        assert_eq!(wait_guard("sleep 600", who, false, &[]).0, 0, "{who}: sleep");
    }
}

#[test]
fn a_wait_block_names_the_foreground_remedy_and_reaches_both_channels() {
    let (code, out, err) = wait_guard("cargo check", "subagent", true, &[]);
    assert_eq!(code, 2);
    let v: Value = serde_json::from_str(out.trim()).unwrap();
    let reason = v["reason"].as_str().unwrap();
    assert_eq!(err.trim(), reason);
    assert!(reason.starts_with("⛔ waiting check: a helper cannot start this build or test in the background: cargo check"), "{reason}");
    assert!(reason.contains("Run the command in the foreground under the shared lock."), "{reason}");
    assert_eq!(reason.lines().count(), 2);
    let (_, out, _) = wait_guard("sleep 99", "subagent", false, &[]);
    assert!(out.contains("SendMessage lead"), "{out}");
    assert!(!out.contains("End the turn and wait"), "an idle helper is not woken by a notification: {out}");
}

// A subagent that is blocked must keep a path to its result (GH #755): a bounded watch within the limit, or a message to its lead.
const WATCH_170: &str = "timeout 170 bash -c 'until gh pr checks --required; do sleep 20; done'";

#[test]
fn a_bounded_watch_within_the_limit_is_allowed_for_a_subagent() {
    for who in ["subagent", "codex-subagent"] {
        for cmd in [
            WATCH_170,
            "timeout 170 gh pr checks 12 --watch",
            "gh pr checks 12 --watch",
            "timeout 540 gh run watch 99",
            "timeout 3m gh pr checks --watch",
            "timeout -k 5 170 bash -c 'while ! test -f /tmp/done; do sleep 10; done'",
            "timeout 100 sleep 100",
        ] {
            let (code, out, _) = wait_guard(cmd, who, false, &[]);
            assert_eq!(code, 0, "{who}: {cmd} must be allowed: {out}");
        }
    }
}

// A timeout bounds a wait only when it wraps the whole wait (PR 760 review): not one iteration of a loop, not a disabled limit,
// not work detached from the script the timeout wraps.
#[test]
fn a_timeout_that_does_not_bound_the_whole_wait_does_not_allow_it() {
    for cmd in [
        "while true; do timeout 5 sleep 60; done",
        "until false; do timeout 5 sleep 60; done",
        "while true; do timeout 5 bash -c 'sleep 60'; done",
        "timeout 0 sleep 99999",
        "timeout 0s sleep 99999",
        "timeout 0m sleep 99999",
        "timeout 0.0 sleep 99999",
        "timeout 1h sleep 100",
        "timeout 540 bash -c 'sleep 99999 &'",
        "timeout 540 bash -c 'nohup sleep 99999'",
        "timeout 540 bash -c 'setsid sleep 99999'",
        "timeout 540 bash -c 'while true; do sleep 60; done &'",
        "timeout 540 bash -c '( while true; do sleep 60; done ) &'",
        "timeout 540 bash -c '( sleep 99999 ) &'",
        "timeout 540 bash -c '{ while true; do sleep 60; done; } &'",
        "timeout 540 bash -c '{ sleep 99999; } &'",
        "timeout -s 0 540 sleep 99999",
        "timeout --signal=0 540 sleep 99999",
        "timeout --signal 0 540 sleep 99999",
        "timeout -s CONT 540 sleep 99999",
        "timeout -s STOP 540 sleep 99999",
        "timeout -s0 540 sleep 99999",
        "timeout 540 bash -c 'echo <(while true; do sleep 60; done)'",
        "timeout 540 bash -c 'cat <(sleep 99999)'",
        "timeout 540 bash -c 'tee >(sleep 99999) </dev/null'",
        "timeout 540 cat <(sleep 99999)",
        "timeout 540 bash -c 'coproc sleep 99999'",
        "timeout 540 bash -c 'coproc { sleep 99999; }'",
        "timeout 540 bash -c 'coproc NAME { while true; do sleep 60; done; }'",
        "timeout 540 bash -c 'coproc NAME ( sleep 99999 )'",
        "timeout -s CONT -k 0 540 sleep 99999",
        "timeout --signal=0 --kill-after=0 540 sleep 99999",
        "timeout -s CONT -k 99999 540 sleep 99999",
        "timeout -s 0 -k abc 540 sleep 99999",
        "timeout 540 eval 'sleep 99999 &'",
        "timeout 540 eval 'nohup sleep 99999'",
        // round 4: fail closed on a detach token anywhere in the text, any nesting depth
        "timeout 540 bash -c \"sh -c 'sleep 99999' &\"",
        "timeout 540 bash -c \"bash -c \\\"sh -c 'sleep 99999' &\\\"\"",
        "timeout 540 eval \"eval 'sleep 99999 &'\"",
        "timeout -s0 -k30 0 sleep 99999",
        "timeout -s 0 -k 30 0 sleep 99999",
        "timeout --signal=0 --kill-after=30 0s sleep 99999",
        "if true; then coproc sleep 99999; fi; timeout 540 sleep 100",
        "timeout 540 bash -c 'if true; then coproc sleep 99999; fi'",
        "timeout 540 bash -c 'cat <(echo \")\"; sleep 99999)'",
        "timeout 540 bash -c 'echo <(echo \")\" ) ; sleep 99999 &'",
        "timeout 540 bash -c \"se''tsid sleep 99999\"",
        "timeout 540 bash -c 'sleep 99999 & wait'",
        "timeout 540 bash -c 'disown; sleep 100'",
        // round 5: a redirection must not hide the sleep's duration from a detach check
        "timeout 540 bash -c 'sleep 60 >/dev/null 2>&1 &'",
        "timeout 540 bash -c 'sleep 60 &>/dev/null &'",
        "timeout 540 bash -c 'sleep 60 > /dev/null &'",
        "timeout 540 bash -c 'sleep 5 2>&1 & echo; sleep 60 >/dev/null'",
        "timeout 540 su -c 'sleep 99999 &' nobody",
        // round 6: an unreadable duration under a detach is unbounded
        "timeout 540 bash -c 'sleep $N &'",
        "timeout 540 bash -c 'sleep 60>/dev/null &'",
        "timeout 540 bash -c 'sleep infinity &'",
    ] {
        let (code, out, _) = wait_guard(cmd, "subagent", false, &[]);
        assert_eq!(code, 2, "{cmd} must be blocked: {out}");
    }
    for cmd in [
        "timeout 540 bash -c 'while true; do sleep 5; done'",
        "timeout 9m sleep 100",
        "timeout 540 gh pr checks --watch",
        "timeout -k 5 540 gh pr checks --watch",
        "timeout --foreground 540 gh pr checks --watch",
        "timeout -s KILL 540 sleep 100",
        "timeout -s 0 -k 5 540 sleep 100",
        "timeout 540 bash -c '( sleep 100 )'",
        "timeout 540 bash -c '{ sleep 100; }'",
        "timeout 540 bash -c '(sleep 100) && echo ok'",
        "timeout -s 0 -k 5 540 gh pr checks --watch",
        "timeout 540 eval 'sleep 100'",
        "timeout 540 gh pr checks --watch 2>&1",
        "timeout 540 bash -c 'a=1 && sleep 100'",
        "timeout 540 bash -c 'sleep 100 2>&1 | cat'",
        // round 5: a detach token outside the timeout-wrapped segment, or quoted text that is no script, is inert
        "gh api 'x?a=1&b=2' && timeout 540 sleep 60",
        "timeout 540 sleep 60 && grep 'a&b' f",
        "timeout 540 gh pr checks --watch | grep 'a & b'",
        "timeout 540 gh pr checks --watch | jq '.a & .b'",
        "timeout 540 gh pr checks --watch; cat nohup.out setsid.log",
        "cat nohup.out && timeout 540 sleep 60",
        "ls /tmp/setsid-dir/disown.txt && timeout 540 sleep 60",
        "echo hi & timeout 540 sleep 60",
        "timeout 540 sleep 60 && nohup true",
        "timeout 540 grep -r 'nohup|setsid|disown' src",
        "timeout 540 gh api 'x?a=1&b=2' --jq '.a'",
    ] {
        let (code, out, _) = wait_guard(cmd, "subagent", false, &[]);
        assert_eq!(code, 0, "{cmd}: {out}");
    }
}

#[test]
fn an_unbounded_wait_is_blocked_with_a_bounded_watch_or_message_the_lead() {
    for cmd in ["while true; do sleep 60; done", "until [ -f /tmp/done ]; do sleep 30; done", "sleep 170"] {
        let (code, out, err) = wait_guard(cmd, "subagent", false, &[]);
        assert_eq!(code, 2, "{cmd}");
        assert!(out.contains("timeout 240 gh pr checks --watch"), "{cmd}: {out}");
        assert!(out.contains("SendMessage lead \\\"waiting on <X>; wake me when done\\\""), "{cmd}: {out}");
        assert!(!out.contains("End the turn and wait") && !err.contains("End the turn and wait"), "{cmd}: {out}");
    }
}

#[test]
fn an_over_limit_bounded_wait_is_blocked_with_the_message_the_lead_instruction() {
    for cmd in
        ["timeout 900 gh pr checks --watch", "timeout 541 gh run watch 1", "timeout 10m bash -c 'until true; do sleep 10; done'", "timeout 600 sleep 600"]
    {
        let (code, out, _) = wait_guard(cmd, "subagent", false, &[]);
        assert_eq!(code, 2, "{cmd} must be blocked");
        assert!(out.contains("over the limit") && out.contains("limit 540s"), "{cmd}: {out}");
        assert!(out.contains("SendMessage lead"), "{cmd}: {out}");
        assert!(!out.contains("End the turn and wait"), "{cmd}: {out}");
    }
}

#[test]
fn the_main_session_keeps_its_unbounded_waits() {
    for cmd in ["timeout 900 gh pr checks --watch", "while true; do sleep 60; done"] {
        assert_eq!(wait_guard(cmd, "main", false, &[]).0, 0, "{cmd}");
    }
}

#[test]
fn the_wait_guard_is_a_setting() {
    assert_eq!(wait_guard("sleep 99", "subagent", false, &[("ANTIHALL_QUEUED_WAIT_GUARD", "0")]).0, 0, "guards.queuedWaitGuard off");
    assert_eq!(wait_guard("sleep 99", "subagent", false, &[]).0, 2, "default on");
    let mut p = payload("", "subagent");
    p["tool_input"] = json!({});
    assert_eq!(run(&["check", "queued-wait-guard"], &[], &p.to_string()).0, 0, "no command: nothing to judge");
}

#[test]
fn the_wait_guard_is_wired_for_both_hosts_and_both_orchestration_ports() {
    use ah_engine::dispatch::table as t;
    let has = |host: &str, id: &str| t::entries(host, "PreToolUse").iter().any(|e| e.id == id);
    assert!(has("claude", "queued-wait-guard") && has("codex", "queued-wait-guard"));
    for rel in ["hooks/hooks.registry.json", "codex/hooks/hooks.registry.json"] {
        let text = std::fs::read_to_string(plugin().join(rel)).unwrap();
        assert!(text.contains("queued-wait-guard") && text.contains("ah-hook"), "{rel} routes the guard to the native client");
    }
    assert!(!plugin().join("hooks/queued-wait-guard").exists(), "the native guard needs no fallback no-op");
    let schema = std::fs::read_to_string(plugin().join("../anti-hall-node/hooks/lib/settings-schema.js")).unwrap();
    assert!(schema.contains("key: 'queuedWaitGuard'") && schema.contains("ANTIHALL_QUEUED_WAIT_GUARD"), "guards.queuedWaitGuard is a registered setting");
}

// ---- wide-search-guard depth bound (#623) ---------------------------------------------------------------

fn wide_guard(cmd: &str, who: &str, env_pairs: &[(&str, &str)]) -> (i32, String, String) {
    run(&["check", "wide-search-guard"], env_pairs, &payload(cmd, who).to_string())
}

#[test]
fn a_depth_limited_whole_disk_search_is_allowed_and_an_unbounded_one_blocked() {
    let allow = [
        "find ~ -maxdepth 4 -iname x",
        "find ~ -iname x -maxdepth 2",
        "bfs / -maxdepth 1 -name x",
        "bfs ~ -maxdepth 3 -name x",
        "find . -maxdepth 4 -name x",
        "find ~ -maxdepth 9 -maxdepth 2 -name x", // the last depth flag wins
        "rg -d 9 -d 1 foo ~",
        "rg --max-depth=2 foo /Users",
        "rg --max-depth 2 foo ~",
        "fd -d 3 x ~",
        "fd --max-depth 1 x /Volumes",
        "find ~ -maxdepth 0 -name x",
        "find /private -maxdepth 1 -name x",
        "rg -d 2 foo .",
        "fd -d 3 x .",
        "fd -d 1 -td x ~", // -td is --type d: the d is a value, the depth is 1
        "rg -d 2 -n -i foo .",
        "fd -d 3 -t f x .",
        "find . -maxdepth 2 -name '*.rs'",
        "rg -d 1 -ni -g '*.rs' -A 2 foo ~", // allow-listed flags with their values, and a cluster of value-less ones
        "fd -d 1 -HI -e rs x ~",
    ];
    let block = [
        "find ~ -iname x",
        "find ~ -maxdepth 5 -iname x",
        "find / -name x",
        "rg foo ~",
        "fd x ~",
        "fd -d 9 x ~",
        "find ~ -maxdepth abc -name x",
        "find / -maxdepth 1 -maxdepth 64 -name x", // the last depth flag wins
        "rg -d 1 -d 99 foo ~",
        "rg -d 1 -d99 foo ~",
        "rg -d 1 -d=99 foo ~",
        "rg -d 1 -nd99 foo ~",
        "rg -d 1 -nd 99 foo ~",
        "rg -d 1 --maxdepth 99 foo ~",
        "fd -d 1 -d9 x ~",
        "fd -d 1 -Hd9 x ~",
        "fd -d 1 --maxdepth 9 x ~",
        "find /System/Volumes/Data -maxdepth 3 -name x",
        "find /private -maxdepth 3 -name x",
        "find / -exec find {} -maxdepth 1 \\;",
        "find / -maxdepth 1 -exec grep -r foo {} +",
        "rg -e -d 1 ~", // -d is the pattern, 1 and ~ are paths
        "rg --regexp -d 1 ~",
        "rg --regexp=-d 1 ~",
        "rg -e-d 1 ~",
        "rg -g -d 1 foo ~",           // -d is the glob
        "rg foo ~ -- -d 1",           // nothing after `--` is a flag
        "find / -maxdepth 3 -name x", // a lower limit applies from `/`
        "fd -d 1 x ~ -x grep -r foo",
        "find ~ -path '*/src/*' -prune -name x", // a -prune/-path limit is not a depth bound
        // round 4: the bound is an allowlist, so a flag the guard does not know voids it
        "rg --context-separator -d 1 foo ~",
        "rg --field-match-separator -d 1 foo ~",
        "rg --field-context-separator -d 1 foo ~",
        "rg -d 1 --field-match-separator -d foo ~", // the separator swallows `-d`: foo is the pattern, ~ the path
        "rg -d 1 --pre cat foo ~",
        "fd -d 1 x ~ -xwc",
        "fd -d 1 x ~ --exec=wc",
        "fd -d 1 x ~ --exec wc",
        "find ~ -fprintf -maxdepth 1",
        "find ~ -maxdepth 1 -fprint out",
        "rg -d 1 --glob=x foo ~",           // an `=` form that is not listed
        "rg -d 1 -nZ foo ~",                // a cluster with an unknown letter
        "find ~ -maxdepth 1 -name x stray", // a word after the expression that no flag takes
        "fd --base-directory / x",
        "fd --base-directory=/ x",
        "fd --search-path / x",
        "fd --search-path=/ x",
        "fd -d 1 --search-path / x",
        "fdfind --search-path / x",
    ];
    for who in ["main", "subagent", "codex"] {
        for cmd in allow {
            assert_eq!(wide_guard(cmd, who, &[]).0, 0, "{who}: {cmd} must be allowed");
        }
        for cmd in block {
            assert_eq!(wide_guard(cmd, who, &[]).0, 2, "{who}: {cmd} must be blocked");
        }
    }
}

#[test]
fn the_depth_bound_is_a_setting() {
    assert_eq!(wide_guard("find ~ -maxdepth 4 -iname x", "main", &[("ANTIHALL_WIDE_SEARCH_DEPTH_BOUND", "0")]).0, 2, "guards.wideSearchDepthBound off");
    assert_eq!(wide_guard("find ~ -maxdepth 4 -iname x", "main", &[]).0, 0, "default on");
    assert_eq!(wide_guard("find ~ -maxdepth 4 -iname x", "main", &[("ANTIHALL_ALLOW_WIDE_SEARCH", "0")]).0, 0);
}

#[test]
fn the_worker_text_and_the_wait_guard_share_one_limit() {
    // Both texts render the part length from cache_wait.split_s (GH #884: a wait must stay inside the prompt-cache window): the WORKER line carries a placeholder, never the number.
    let toml = std::fs::read_to_string(plugin().join("engine/defaults/verify_first.toml")).unwrap();
    let worker = toml.split("[verify_first.worker]").nth(1).unwrap().split("\n[").next().unwrap();
    assert!(worker.contains("{max}") && !worker.contains("240"), "the WORKER text must render the limit, not repeat it: {worker}");
    let start = json!({"session_id": "s1", "cwd": "/tmp", "hook_event_name": "SubagentStart", "agent_id": "a1", "agent_type": "general-purpose"});
    let (code, out, _) = run(&["check", "verify-first-subagent"], &[], &start.to_string());
    assert_eq!(code, 0, "{out}");
    assert!(out.contains("within 240s") && out.contains("timeout 240 gh pr checks --watch"), "WORKER text: {out}");
    assert!(out.contains("SendMessage your lead") && out.contains("wake me when done"), "WORKER text: {out}");
    assert!(!out.contains("run long commands in the foreground or poll"), "the old advice is gone: {out}");
    let (_, block, _) = wait_guard("while true; do sleep 60; done", "subagent", false, &[]);
    assert!(block.contains("timeout 240 gh pr checks --watch") && block.contains("wake me when done"), "guard text: {block}");
}


// ---- cache-ttl-wait-guard (GH #884) -----------------------------------------------------------------------------------

/// One tool call of `tool` with `input` from the caller `who`, judged by cache-ttl-wait-guard.
fn cache_guard(tool: &str, input: Value, who: &str, env_pairs: &[(&str, &str)]) -> (i32, String, String) {
    let mut p = payload("", who);
    p["tool_name"] = json!(tool);
    p["tool_input"] = input;
    run(&["check", "cache-ttl-wait-guard"], env_pairs, &p.to_string())
}

fn bash_call(cmd: &str) -> Value {
    json!({"command": cmd})
}

fn bash_call_timeout(cmd: &str, ms: u64) -> Value {
    json!({"command": cmd, "timeout": ms})
}

/// (tool input, whether the call is ordered to split). The limit is 270 s, the part length 240 s.
fn cache_table() -> Vec<(&'static str, Value, bool)> {
    vec![
        ("plain sleep over the limit", bash_call("sleep 300"), true),
        ("sleep with a unit", bash_call("sleep 5m"), true),
        ("sleep operands are summed", bash_call("sleep 200 100"), true),
        ("endless sleep", bash_call("sleep infinity"), true),
        ("sleep of a variable", bash_call("sleep $N"), true),
        ("sleep just over", bash_call("sleep 271"), true),
        ("sleep at the limit", bash_call("sleep 270"), false),
        ("short sleep", bash_call("sleep 200"), false),
        ("sleep in a chain, each short", bash_call("sleep 100 && echo a && sleep 100"), false),
        ("sleep under a smaller timeout", bash_call("timeout 200 sleep 999"), false),
        ("sleep under a larger timeout", bash_call("timeout 540 sleep 999"), true),
        ("watch under a long timeout", bash_call("timeout 540 gh pr checks --watch"), true),
        ("watch under a short timeout", bash_call("timeout 240 gh pr checks --watch"), false),
        ("watch with no bound", bash_call("gh pr checks --watch"), false),
        ("watch bounded by the tool timeout", bash_call_timeout("gh run watch 99", 600_000), true),
        ("watch inside the tool timeout", bash_call_timeout("gh run watch 99", 200_000), false),
        ("poll loop bounded by a long tool timeout", bash_call_timeout("until gh pr checks --required; do sleep 20; done", 600_000), true),
        ("poll loop with a short tool timeout", bash_call_timeout("until gh pr checks --required; do sleep 20; done", 120_000), false),
        ("poll loop with no bound", bash_call("until gh pr checks --required; do sleep 20; done"), false),
        ("a for loop over a list is bounded by its list", bash_call_timeout("for i in 1 2 3; do curl -s x; sleep 2; done", 600_000), false),
        ("a long sleep inside a for loop", bash_call("for i in 1 2; do sleep 300; done"), true),
        ("a while poll loop bounded by a long tool timeout", bash_call_timeout("while ! curl -s x; do sleep 5; done", 600_000), true),
        ("poll loop under a long timeout wrapper", bash_call("timeout 540 bash -c 'until gh pr checks --required; do sleep 20; done'"), true),
        ("a build with a long tool timeout is no wait", bash_call_timeout("cargo build", 600_000), false),
        ("a read-only command", bash_call("git status"), false),
        ("a background sleep returns at once", json!({"command": "sleep 600", "run_in_background": true}), false),
    ]
}

#[test]
fn the_cache_wait_table_orders_the_split_and_never_blocks() {
    for who in ["main", "subagent", "codex", "codex-subagent"] {
        for (name, input, ordered) in cache_table() {
            let (code, out, err) = cache_guard("Bash", input.clone(), who, &[]);
            assert_eq!(code, 0, "{who}: {name}: an order is an advisory, never a block: {out}{err}");
            if ordered {
                let v: Value = serde_json::from_str(out.trim()).unwrap_or_else(|e| panic!("{who}: {name}: {e}: {out}"));
                let ctx = v["hookSpecificOutput"]["additionalContext"].as_str().unwrap_or_default();
                assert_eq!(v["hookSpecificOutput"]["hookEventName"], "PreToolUse", "{who}: {name}");
                assert!(ctx.contains("cache limit") && ctx.contains("240s or less"), "{who}: {name}: {ctx}");
                assert!(v.get("decision").is_none(), "{who}: {name}: never a block");
            } else {
                assert!(out.trim().is_empty(), "{who}: {name}: must be silent: {out}");
            }
        }
    }
}

#[test]
fn a_tool_deadline_over_the_limit_is_ordered_for_monitor_and_task_output() {
    for (tool, field) in [("Monitor", "timeout_ms"), ("TaskOutput", "timeout")] {
        let over = cache_guard(tool, json!({"command": "tail -f x", field: 600_000}), "main", &[]);
        assert_eq!(over.0, 0);
        assert!(over.1.contains(&format!("{tool} waits up to 600s")) && over.1.contains("240s or less"), "{tool}: {}", over.1);
        let under = cache_guard(tool, json!({"command": "tail -f x", field: 240_000}), "main", &[]);
        assert!(under.1.trim().is_empty(), "{tool}: a deadline inside the limit is silent: {}", under.1);
        let none = cache_guard(tool, json!({"command": "tail -f x"}), "main", &[]);
        assert!(none.1.trim().is_empty(), "{tool}: no deadline, no order");
    }
    let persistent = cache_guard("Monitor", json!({"command": "tail -f x", "timeout_ms": 3_600_000, "persistent": true}), "main", &[]);
    assert!(persistent.1.trim().is_empty(), "a persistent monitor wakes by event, it is no single wait: {}", persistent.1);
    assert!(cache_guard("Read", json!({"file_path": "/x", "timeout": 600_000}), "main", &[]).1.trim().is_empty(), "only the listed tools are judged");
}

/// GH #965: the wake-watch re-arm lines ask for a Monitor of `agent_tracker.wake_timeout_ms` (30 min) running the engine's own watcher;
/// the guard must not order that Monitor split (the two instructions contradicted each other on every re-arm). Every configured
/// watcher command is exempt, read from the config itself so a changed command cannot drift past the exemption. Any other long Monitor
/// is still ordered (true positive), and so is any command that is not plainly the watcher: a wrapper, an assignment, a substitution,
/// a chain, a pipe or another redirection (review P1-1).
#[test]
fn the_engine_wake_watch_monitor_is_exempt_and_every_other_long_monitor_is_still_ordered() {
    let cfg = |k: &str| ah_engine::defaults::text(k).to_string();
    let timeout = ah_engine::defaults::num("agent_tracker.wake_timeout_ms");
    assert!(timeout > ah_engine::defaults::num("cache_wait.limit_s") * 1000, "the re-arm timeout is past the cache limit: the exemption is what reconciles them");
    let ordered = |cmd: &str| {
        let (code, out, err) = cache_guard("Monitor", json!({"command": cmd, "timeout_ms": timeout}), "main", &[]);
        assert_eq!(code, 0, "{cmd}: never a block: {out}{err}");
        out.contains("240s or less")
    };
    let mut watchers = vec![cfg("agent_tracker.wake_command_agents"), cfg("agent_tracker.wake_command")];
    watchers.push("$HOME/.anti-hall/ah-engine/bin/ah-engine agents wake-watch --auto".into()); // the same watcher, written another way
    for w in &watchers {
        assert!(!ordered(w), "the engine's own wake watcher is exempt: {w}");
    }
    for cmd in [
        "gh pr checks 12 --watch",
        "tail -f build.log",
        "~/.anti-hall/ah-engine/bin/ah-engine agents status --json", // the engine binary, not the watcher verb
        "~/.anti-hall/ah-engine/bin/ah-engine agents wake-watch --auto; sleep 1800", // the watcher plus a real wait
        "echo agents wake-watch --auto",                                               // only mentions it
        "~/.anti-hall/ah-engine/bin/ah-engine agents wake-watch extra",               // a non-option word after the verb
        // review P1-1: a wrapper, an assignment, a substitution, a chain, a pipe, a background or another redirection hides a wait
        "TOKEN=$(sleep 1800) ah-engine agents wake-watch",
        "flock -w 1800 x ah-engine agents wake-watch",
        "timeout 1800 ah-engine agents wake-watch --auto",
        "env A=1 ah-engine agents wake-watch --auto",
        "nice -n 10 ah-engine agents wake-watch --auto",
        "A=1 ah-engine agents wake-watch --auto",
        "ah-engine agents wake-watch --auto $(sleep 1800)",
        "ah-engine agents wake-watch --auto `sleep 1800`",
        "ah-engine agents wake-watch --auto | cat",
        "ah-engine agents wake-watch --auto && sleep 1800",
        "ah-engine agents wake-watch --auto &",
        "ah-engine agents wake-watch --auto < /tmp/fifo",
        "ah-engine agents wake-watch --auto >/tmp/x",
        // review round 2 P1-4: at most one prefix
        "exec exec \"$HOME/.anti-hall/ah-engine/bin/ah-engine\" agents wake-watch --auto",
        // review round 2 P1-3: only the engine's own program path, not any file called ah-engine (nor a bare name looked up in PATH)
        "/tmp/x/ah-engine agents wake-watch --auto",
        "~/elsewhere/ah-engine agents wake-watch --auto",
        "ah-engine devswarm wake-watch --auto",
        // review round 3 P1-B: single quotes keep `~` and `$HOME` literal, as the shell does: that path is no engine path
        "'~/.anti-hall/ah-engine/bin/ah-engine' agents wake-watch --auto",
        "'$HOME/.anti-hall/ah-engine/bin/ah-engine' agents wake-watch --auto",
        "\"~/.anti-hall/ah-engine/bin/ah-engine\" agents wake-watch --auto",
        // review round 4 P1-2: an escape or ANSI-C quoting is not the plain command
        "\"$HOME/\\.anti-hall/ah-engine/bin/ah-engine\" agents wake-watch",
        "$'$HOME/.anti-hall/ah-engine/bin/ah-engine' agents wake-watch",
        "\"$HOME/.anti-hall/ah-engine/bin/ah engine\" agents wake-watch",
    ] {
        assert!(ordered(cmd), "a long non-watcher Monitor is still ordered split: {cmd}");
    }
    // only the listed tools are exempt: a Bash call running the watcher under a long tool timeout is judged as a Bash call
    assert!(cache_guard("Bash", bash_call(&watchers[0]), "main", &[]).1.trim().is_empty(), "a Bash watcher holds no sleep or watch");
}

/// GH #965: EVERY command the engine tells a session to run as its wake-watch Monitor is exempt, as the engine renders it for the
/// session's home: the re-arm lines (agent_tracker.wake_command*), the spawn wake-path hint (devswarm_cli.sp_wake_watcher), the
/// watcher shim command (`{bin} {wverb}`: the stale-build line, the post-update arm text, the role texts) and the re-verify hint's
/// Monitor command (devswarm_role.pg_wake_watch). A hint that named a bare `ah-engine` or a shell variable brought the split order back.
#[test]
fn every_configured_rearm_and_hint_command_is_exempt() {
    use ah_engine::defaults::{render, text};
    let home = PathBuf::from(env!("CARGO_TARGET_TMPDIR")).join(format!("lanewaste-{}", std::process::id())).join("home");
    let home = home.to_string_lossy().into_owned();
    let bin = render("devswarm_role.engine_bin", &[("home", &home)]);
    let wverb = text("devswarm_role.watcher_verb");
    let hint = render("devswarm_role.pg_wake_watch", &[("watcher", &format!("\"{bin}\"")), ("wverb", &wverb)]);
    let hint_mon = hint.split_once("Monitor` on `").map(|x| x.1).and_then(|x| x.split_once('`')).map(|x| x.0.to_string()).unwrap_or_default();
    assert!(hint_mon.contains(&bin) && !hint_mon.contains('$'), "the re-verify hint names the path itself: {hint}");
    let cmds = [
        text("agent_tracker.wake_command_agents").to_string(),
        text("agent_tracker.wake_command").to_string(),
        text("devswarm_cli.sp_wake_watcher").to_string(),
        format!("{bin} {wverb}"),
        hint_mon,
    ];
    let timeout = ah_engine::defaults::num("agent_tracker.wake_timeout_ms");
    for c in &cmds {
        let (code, out, err) = cache_guard("Monitor", json!({"command": c, "timeout_ms": timeout}), "main", &[]);
        assert_eq!(code, 0, "{c}: {err}");
        assert!(out.trim().is_empty(), "the engine's own watcher command is exempt: {c}: {out}");
    }
}

/// GH #965: the DevSwarm re-arm text renders the configured timeout (it held a literal 1800000 before).
#[test]
fn the_devswarm_rearm_text_carries_the_configured_timeout() {
    let raw = ah_engine::defaults::text("msg.agent_monitor_unarmed_devswarm");
    assert!(raw.contains("{timeout}") && !raw.contains("1800000"), "{raw}");
}

#[test]
fn the_cache_wait_limits_are_settings_and_the_guard_is_a_switch() {
    let ordered = |cmd: &str, env_pairs: &[(&str, &str)]| !cache_guard("Bash", bash_call(cmd), "main", env_pairs).1.trim().is_empty();
    assert!(ordered("sleep 300", &[]));
    assert!(!ordered("sleep 300", &[("ANTIHALL_CACHE_WAIT_GUARD", "0")]), "guards.cacheWaitGuard off");
    // a sleep of a variable and a long one are both unbounded or long: the order names how it reads
    let (_, out, _) = cache_guard("Bash", bash_call("sleep infinity"), "main", &[]);
    assert!(out.contains("an unbounded time"), "{out}");
    let (_, out, _) = cache_guard("Bash", bash_call("sleep 300"), "main", &[]);
    assert!(out.contains("up to 300s") && out.contains("270s cache limit") && out.contains("sleep 300"), "{out}");
    let p = json!({"session_id": "s1", "cwd": "/tmp", "hook_event_name": "PreToolUse", "tool_name": "Bash", "tool_input": {}});
    assert_eq!(run(&["check", "cache-ttl-wait-guard"], &[], &p.to_string()).1.trim(), "", "no command: nothing to judge");
}

#[test]
fn the_cache_wait_guard_is_wired_for_both_hosts_and_both_orchestration_ports() {
    use ah_engine::dispatch::table as t;
    let has = |host: &str, tool: &str| t::select(host, "PreToolUse", &json!({"tool_name": tool}), None).iter().any(|e| e.id == "cache-ttl-wait-guard");
    assert!(has("claude", "Bash") && has("claude", "Monitor") && has("claude", "TaskOutput") && has("codex", "Bash"));
    assert!(!has("claude", "Read") && !has("codex", "Monitor"), "Codex has no Monitor or TaskOutput");
    for rel in ["hooks/hooks.registry.json", "codex/hooks/hooks.registry.json"] {
        let text = std::fs::read_to_string(plugin().join(rel)).unwrap();
        assert!(text.contains("cache-ttl-wait-guard") && text.contains("ah-hook"), "{rel} routes the guard to the native client");
    }
    assert!(!plugin().join("hooks/cache-ttl-wait-guard").exists(), "the native guard needs no fallback no-op");
    let schema = std::fs::read_to_string(plugin().join("../anti-hall-node/hooks/lib/settings-schema.js")).unwrap();
    assert!(schema.contains("key: 'cacheWaitGuard'") && schema.contains("ANTIHALL_CACHE_WAIT_GUARD"), "guards.cacheWaitGuard is a registered setting");
    let nudges = std::fs::read_to_string(plugin().join("engine/defaults/nudges.toml")).unwrap();
    assert!(nudges.contains("cache_wait = { class = \"escalate\", hooks = [\"cache-ttl-wait-guard\"]"), "repeats climb the nudge ladder");
}

#[test]
fn the_part_length_is_one_key_for_the_order_the_worker_line_and_the_wait_block() {
    let start = json!({"session_id": "s-split", "cwd": "/tmp", "hook_event_name": "SubagentStart", "agent_id": "a-split", "agent_type": "general-purpose"});
    let (_, worker, _) = run(&["check", "verify-first-subagent"], &[], &start.to_string());
    assert!(worker.contains("within 240s"), "the WORKER line must not tell an agent to wait longer than the guard allows: {worker}");
    let (_, block, _) = wait_guard("timeout 600 gh pr checks --watch", "subagent", false, &[]);
    assert!(block.contains("Use 240s or less"), "the queued-wait remedy asks for the same part length: {block}");
}
