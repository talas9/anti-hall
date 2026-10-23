//! GH #270: `lane-test-guard` (PreToolUse on Bash, subagents only, Claude and Codex; engine-only) blocks suite-scale test commands
//! a lane agent runs while it waits on the shared build lock, and lets `cargo check` and a filtered single-module test through.
//! The table below is the decision record. Tests run under a scratch HOME.
#![allow(clippy::unwrap_used, clippy::expect_used)] // a test crate: a panic is the failure report, and E2 exempts tests

use serde_json::{Value, json};
use std::io::Write;
use std::path::PathBuf;
use std::process::{Command, Stdio};

fn plugin() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../plugins/anti-hall")
}

fn run(argv: &[&str], extra: &[(&str, &str)], stdin: &str) -> (i32, String, String) {
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
        ("node --test", Some("node --test")),
        ("node --test tests/", Some("node --test")),
        ("./test.sh", Some("test.sh")),
        ("bash ah-engine/test.sh", None), // a script run through an interpreter is out of reach
        ("ah-engine/test.sh", Some("test.sh")),
        ("make test", Some("make test")),
        ("npm test", Some("npm test")),
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
    assert!(reason.starts_with("⛔ anti-hall · lane-test-guard: `cargo test --workspace` is blocked"), "{reason}");
    assert!(reason.contains("run cargo check, commit, verification happens at deploy"), "{reason}");
    assert!(reason.contains("guards.allowTestSuites") && reason.contains("guards.laneTestGuard"), "{reason}");
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
    for rel in ["hooks/hooks.registry.json", "codex/hooks/hooks.registry.json", "hooks/ah-fallback.list", "hooks/ah-fallback.codex.list"] {
        let text = std::fs::read_to_string(plugin().join(rel)).unwrap();
        assert!(text.contains("hooks/lane-test-guard"), "{rel} names the fallback no-op");
    }
    let script = std::fs::read_to_string(plugin().join("hooks/lane-test-guard")).unwrap();
    assert!(script.contains("exit 0"), "the fallback is a no-op");
    let schema = std::fs::read_to_string(plugin().join("../anti-hall-node/hooks/lib/settings-schema.js")).unwrap();
    assert!(schema.contains("key: 'laneTestGuard'") && schema.contains("ANTIHALL_LANE_TEST_GUARD"), "guards.laneTestGuard is a registered setting");
    assert!(schema.contains("key: 'allowTestSuites'") && schema.contains("ANTIHALL_ALLOW_TEST_SUITES"), "guards.allowTestSuites is a registered setting");
}
