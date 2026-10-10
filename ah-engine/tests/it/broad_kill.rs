//! Issue #38: `broad-kill-guard` (PreToolUse on Bash, every agent, Claude and Codex; engine-only) blocks pkill, killall,
//! `kill -9 -1`, `kill 0` and a kill fed by a name or port lookup, and lets a kill of one explicit PID through. The table below is
//! the decision record: every command, who runs it, and whether it is blocked (and as which kind). `pkill -P <pid or $$>` is
//! allowed (a scoped kill of one process's children, parent 1 excluded). Tests run under a scratch HOME.
#![allow(clippy::unwrap_used, clippy::expect_used)] // a test crate: a panic is the failure report, and E2 exempts tests

use serde_json::{Value, json};
use std::io::Write;
use std::path::PathBuf;
use std::process::{Command, Stdio};

fn plugin() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../plugins/anti-hall")
}

fn run(argv: &[&str], extra: &[(&str, &str)], stdin: &str) -> (i32, String, String) {
    let dir = PathBuf::from(env!("CARGO_TARGET_TMPDIR")).join(format!("broadkill-{}", std::process::id()));
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

/// The check on one Bash command from the caller `who` ("main", "subagent", "codex", "codex-subagent"); (exit code, stdout, stderr).
fn guard(cmd: &str, who: &str, env_pairs: &[(&str, &str)]) -> (i32, String, String) {
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
    run(&["check", "broad-kill-guard"], env_pairs, &p.to_string())
}

const PATTERN: &str = "matches a name or pattern";
const EVERYONE: &str = "every process you own";
const LOOKUP: &str = "name or port lookup";

/// (command, None = allowed, Some(text of the kind of block)).
fn table() -> Vec<(&'static str, Option<&'static str>)> {
    vec![
        // name and pattern kills
        ("pkill node", Some(PATTERN)),
        ("pkill -f \"next dev\"", Some(PATTERN)),
        ("pkill -9 -f vite", Some(PATTERN)),
        ("killall node", Some(PATTERN)),
        ("killall -9 node", Some(PATTERN)),
        ("killall5 -9", Some(PATTERN)),
        ("/usr/bin/pkill node", Some(PATTERN)),
        ("sudo pkill node", Some(PATTERN)),
        ("sudo -u root killall node", Some(PATTERN)),
        ("env FOO=1 pkill node", Some(PATTERN)),
        ("FOO=1 pkill node", Some(PATTERN)),
        ("nohup pkill -f x &", Some(PATTERN)),
        ("timeout 5 pkill node", Some(PATTERN)),
        ("echo hi && pkill node", Some(PATTERN)),
        ("cd x; pkill node", Some(PATTERN)),
        ("(pkill node)", Some(PATTERN)),
        ("{ pkill node; }", Some(PATTERN)),
        ("if true; then pkill node; fi", Some(PATTERN)),
        ("bash -c 'pkill node'", Some(PATTERN)),
        ("bash -lc \"killall node\"", Some(PATTERN)),
        ("eval \"pkill node\"", Some(PATTERN)),
        ("echo $(pkill node)", Some(PATTERN)),
        ("sh <<'EOF'\npkill node\nEOF", Some(PATTERN)),
        ("echo node | xargs pkill", Some(PATTERN)),
        ("pkill -P 1 node", Some(PATTERN)),
        ("pkill -P", Some(PATTERN)),
        ("pkill -P abc", Some(PATTERN)),
        ("fuser -k 3000/tcp", Some(PATTERN)),
        ("fuser -km /mnt/x", Some(PATTERN)),
        // everyone
        ("kill -9 -1", Some(EVERYONE)),
        ("kill -KILL -1", Some(EVERYONE)),
        ("kill -s KILL -1", Some(EVERYONE)),
        ("kill -- -1", Some(EVERYONE)),
        ("kill 0", Some(EVERYONE)),
        ("kill -9 0", Some(EVERYONE)),
        ("/bin/kill -9 -1", Some(EVERYONE)),
        ("sudo kill -9 -1", Some(EVERYONE)),
        ("echo 1 | xargs kill -9 -1", Some(EVERYONE)),
        // kills fed by a lookup
        ("kill $(pgrep -f next)", Some(LOOKUP)),
        ("kill -9 $(pgrep node)", Some(LOOKUP)),
        ("kill -9 \"$(lsof -ti:3000)\"", Some(LOOKUP)),
        ("kill `pidof node`", Some(LOOKUP)),
        ("kill -9 $(ps aux | grep node | awk '{print $2}')", Some(LOOKUP)),
        ("pgrep -f next | xargs kill", Some(LOOKUP)),
        ("lsof -ti:3000 | xargs kill -9", Some(LOOKUP)),
        ("pgrep node | xargs -r kill -9", Some(LOOKUP)),
        ("pgrep -f x | xargs -n1 kill", Some(LOOKUP)),
        ("ps aux | grep node | awk '{print $2}' | xargs kill", Some(LOOKUP)),
        ("sudo lsof -ti :8080 | sudo xargs kill -9", Some(LOOKUP)),
        // allowed: one explicit process, or the caller's own children
        ("kill 1234", None),
        ("kill -9 1234", None),
        ("kill -TERM 1234 5678", None),
        ("kill -s TERM 1234", None),
        ("kill -0 1234", None),
        ("kill -l", None),
        ("kill $pid", None),
        ("kill -9 \"$PID\"", None),
        ("kill ${pid}", None),
        ("kill $!", None),
        ("kill %1", None),
        ("kill -- -4242", None),
        ("kill $(cat /tmp/app.pid)", None),
        ("sleep 100 & kill $!", None),
        ("pkill -P $$", None),
        ("pkill -9 -P $$", None),
        ("pkill -P$$", None),
        ("pkill -P 4242", None),
        ("pkill --parent 4242", None),
        ("pkill --parent=4242", None),
        ("pkill -P $BASHPID node", None),
        ("echo 1234 | xargs kill", None),
        ("cat pids.txt | xargs kill", None),
        // allowed: the words appear but nothing runs them
        ("echo pkill node", None),
        ("echo \"pkill node && killall node\" > notes.txt", None),
        ("git commit -m \"stop using pkill node\"", None),
        ("grep -rn pkill .", None),
        ("man killall", None),
        ("which pkill", None),
        ("cat <<EOF\npkill node\nEOF", None),
        ("# pkill node", None),
        ("npm run pkill-node", None),
        ("docker kill web", None),
        ("pgrep -f node", None),
        ("ps aux | grep node", None),
        ("lsof -ti:3000", None),
        ("ls 2>&1", None),
        ("fuser 3000/tcp", None),
    ]
}

#[test]
fn the_decision_table_holds_for_the_main_session_a_subagent_and_both_codex_seats() {
    let cases: Vec<(&str, &str, Option<&str>)> =
        ["main", "subagent", "codex", "codex-subagent"].iter().flat_map(|who| table().into_iter().map(move |(c, w)| (*who, c, w))).collect();
    // one engine process per case: spread them over a few threads so the table stays quick
    let failures: Vec<String> = std::thread::scope(|s| {
        let hs: Vec<_> = cases
            .chunks(cases.len().div_ceil(6))
            .map(|chunk| {
                s.spawn(move || {
                    let mut bad = Vec::new();
                    for (who, cmd, want) in chunk {
                        let (code, out, err) = guard(cmd, who, &[]);
                        match want {
                            None if code != 0 || !out.trim().is_empty() || !err.trim().is_empty() => {
                                bad.push(format!("{who}: `{cmd}` must be allowed silently: {code} {out}{err}"))
                            }
                            Some(kind) if code != 2 || !err.contains(kind) => bad.push(format!("{who}: `{cmd}` must be the `{kind}` block: {code} {out}{err}")),
                            _ => {}
                        }
                    }
                    bad
                })
            })
            .collect();
        hs.into_iter().flat_map(|h| h.join().unwrap()).collect()
    });
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}

#[test]
fn a_block_uses_the_standard_message_and_reaches_both_hosts_channels() {
    let (code, out, err) = guard("pkill -f \"next dev\"", "subagent", &[]);
    assert_eq!(code, 2);
    let v: Value = serde_json::from_str(out.trim()).unwrap();
    assert_eq!(v["decision"], "block");
    let reason = v["reason"].as_str().unwrap();
    assert_eq!(err.trim(), reason, "stderr carries the same reason (Codex honors exit 2 only with it there)");
    assert!(reason.starts_with("⛔ anti-hall · broad-kill-guard: `pkill -f next dev` is blocked"), "{reason}");
    assert!(reason.contains("\nWhy: ") && reason.contains("\nDo instead: kill by PID after checking the process"), "{reason}");
    assert!(reason.contains("pkill -P $$") && reason.contains("guards.broadKill"), "{reason}");
}

#[test]
fn the_guard_is_a_setting_and_a_skip() {
    assert_eq!(guard("pkill node", "main", &[("ANTIHALL_BROAD_KILL", "0")]).0, 0, "guards.broadKill off");
    assert_eq!(guard("pkill node", "main", &[("ANTIHALL_BROAD_KILL", "1")]).0, 2);
    assert_eq!(guard("pkill node", "main", &[]).0, 2, "default on");
}

#[test]
fn a_command_that_fails_to_parse_is_allowed_not_blocked() {
    for cmd in ["", "   ", "echo 'unterminated", "echo \"$(", "kill $(", "<<", "a | | b ;; c", "`"] {
        assert_eq!(guard(cmd, "subagent", &[]).0, 0, "{cmd:?}");
    }
    assert_eq!(guard("pkill node", "main", &[]).0, 2);
    let mut p = json!({"session_id": "s1", "hook_event_name": "PreToolUse", "tool_name": "Bash", "tool_input": {}});
    p["agent_id"] = json!("a1");
    assert_eq!(run(&["check", "broad-kill-guard"], &[], &p.to_string()).0, 0, "no command: nothing to judge");
}

#[test]
fn the_guard_is_wired_for_both_hosts_and_both_orchestration_ports() {
    use ah_engine::dispatch::table as t;
    let has = |host: &str, id: &str| t::entries(host, "PreToolUse").iter().any(|e| e.id == id);
    assert!(has("claude", "broad-kill-guard") && has("codex", "broad-kill-guard"));
    for rel in ["hooks/hooks.registry.json", "codex/hooks/hooks.registry.json", "hooks/ah-fallback.list", "hooks/ah-fallback.codex.list"] {
        let text = std::fs::read_to_string(plugin().join(rel)).unwrap();
        assert!(text.contains("hooks/broad-kill-guard"), "{rel} names the fallback no-op");
    }
    let script = std::fs::read_to_string(plugin().join("hooks/broad-kill-guard")).unwrap();
    assert!(script.contains("exit 0"), "the fallback is a no-op");
    let schema = std::fs::read_to_string(plugin().join("hooks/lib/settings-schema.js")).unwrap();
    assert!(schema.contains("key: 'broadKill'") && schema.contains("ANTIHALL_BROAD_KILL"), "guards.broadKill is a registered setting");
}
