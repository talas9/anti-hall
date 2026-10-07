//! The prompt-emission checks through the real dispatcher: `ah-engine hook --event UserPromptSubmit` and `SessionStart`
//! with the Node hooks replaced by shell commands (`--fallback-map`), in process and through the daemon. It shows that the
//! payload digest, the request environment and the isolated state reach the checks the way the CLI form
//! (`ah-engine check`, which the Node parity test uses) gives them, and that a deferral runs the Node hook.
#![allow(clippy::unwrap_used, clippy::expect_used)] // a test crate: a panic is the failure report, and E2 exempts tests

mod common;

use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

/// The context a UserPromptSubmit answer delivers: the `additionalContext` of its JSON, or the raw text. The context-budget
/// checks answer a quiet turn natively with an empty context, so the stand-in Node hook's plain text arrives wrapped.
fn ctx(out: &str) -> String {
    serde_json::from_str::<serde_json::Value>(out.trim_end())
        .ok()
        .and_then(|v| v["hookSpecificOutput"]["additionalContext"].as_str().map(str::to_string))
        .unwrap_or_else(|| out.to_string())
}

const NODE_MARK: &str = "printf 'NODE-RAN'";

struct Env {
    dir: PathBuf,
}

impl Env {
    fn new(name: &str) -> Env {
        let dir = std::env::temp_dir().join(format!("ahd-pe-{name}-{}", std::process::id()));
        ah_engine::discard::harmless(std::fs::remove_dir_all(&dir));
        std::fs::create_dir_all(dir.join("home")).unwrap();
        Env { dir }
    }

    fn home(&self) -> PathBuf {
        self.dir.join("home")
    }

    fn state(&self) -> PathBuf {
        self.dir.join("state")
    }

    /// A map that makes every Node hook of `event` print nothing, except `marked`, which prints `NODE-RAN`.
    fn map(&self, event: &str, marked: &str) -> PathBuf {
        let ids: Vec<String> = ah_engine::dispatch::table::entries("claude", event).into_iter().map(|x| x.id).collect();
        let m: serde_json::Map<String, serde_json::Value> = ids.iter().map(|id| (id.clone(), if id == marked { NODE_MARK } else { "true" }.into())).collect();
        let p = self.dir.join(format!("{event}-map.json"));
        std::fs::write(&p, serde_json::json!({ event: m }).to_string()).unwrap();
        p
    }

    fn run(&self, args: &[&str], in_process: bool, payload: &str, extra: &[(&str, &str)]) -> (i32, String, String) {
        let mut c = Command::new(env!("CARGO_BIN_EXE_ah-engine"));
        c.args(args)
            .env_clear()
            .env("PATH", std::env::var("PATH").unwrap_or_default())
            .env("HOME", self.home())
            .env("AH_ENGINE_DIR", self.state())
            .env("AH_ENGINE_VERSION", "prompt-emit-dispatch")
            .env("AH_ENGINE_DISPATCH_IN_PROCESS", if in_process { "1" } else { "0" })
            .env("CLAUDE_PLUGIN_ROOT", &self.dir)
            .current_dir(&self.dir)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        c.envs(extra.iter().copied());
        let mut ch = c.spawn().unwrap();
        ch.stdin.take().unwrap().write_all(payload.as_bytes()).unwrap();
        let o = ch.wait_with_output().unwrap();
        (o.status.code().unwrap_or(-1), String::from_utf8_lossy(&o.stdout).to_string(), String::from_utf8_lossy(&o.stderr).to_string())
    }

    /// Keep asking until the daemon (not the Node fallback) answers: the first daemon call starts it and answers through Node.
    fn until_daemon_answers(&self, args: &[&str], payload: &str, extra: &[(&str, &str)]) -> (i32, String, String) {
        let mut last = (0, String::new(), String::new());
        for _ in 0..80 {
            last = self.run(args, false, payload, extra);
            if !last.1.contains("NODE-RAN") {
                return last;
            }
            std::thread::sleep(std::time::Duration::from_millis(50));
        }
        last
    }

    fn stop(&self) {
        let st = self.state();
        common::reap(&st, || {
            ah_engine::discard::harmless(Command::new(env!("CARGO_BIN_EXE_ah-engine")).arg("stop").env("AH_ENGINE_DIR", &st).env("HOME", self.home()).output());
        });
    }
}

impl Drop for Env {
    fn drop(&mut self) {
        ah_engine::discard::harmless(std::fs::remove_dir_all(&self.dir));
    }
}

fn ups(session: &str, prompt: &str, transcript: Option<&Path>) -> String {
    let mut p = serde_json::json!({"session_id": session, "cwd": "/tmp", "hook_event_name": "UserPromptSubmit", "prompt": prompt});
    if let Some(t) = transcript {
        p["transcript_path"] = t.to_string_lossy().to_string().into();
    }
    p.to_string()
}

/// The one-shot form (`ah-engine check`) of the same payload, on a home of its own.
fn check_form(name: &str, check: &str, payload: &str, extra: &[(&str, &str)]) -> String {
    let e = Env::new(name);
    let mut c = Command::new(env!("CARGO_BIN_EXE_ah-engine"));
    c.args(["check", check])
        .env_clear()
        .env("PATH", std::env::var("PATH").unwrap_or_default())
        .env("HOME", e.home())
        .env("AH_ENGINE_DIR", e.state())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    c.envs(extra.iter().copied());
    let mut ch = c.spawn().unwrap();
    ch.stdin.take().unwrap().write_all(payload.as_bytes()).unwrap();
    String::from_utf8_lossy(&ch.wait_with_output().unwrap().stdout).to_string()
}

#[test]
fn verify_first_through_the_dispatcher_picks_the_line_the_digest_of_the_raw_bytes_picks() {
    for in_process in [true, false] {
        let e = Env::new(if in_process { "vf-inproc" } else { "vf-daemon" });
        let map = e.map("UserPromptSubmit", "verify-first");
        let args = ["hook", "--event", "UserPromptSubmit", "--fallback-map", map.to_str().unwrap()];
        // many payloads, so every rotating line is exercised: a digest that were not forwarded would give one line for all
        let mut seen = std::collections::BTreeSet::new();
        for i in 0..60 {
            let p = ups(&format!("s{i}"), &format!("prompt {i}"), None);
            let (code, out, err) = if in_process { e.run(&args, true, &p, &[]) } else { e.until_daemon_answers(&args, &p, &[]) };
            assert_eq!((code, err.as_str()), (0, ""), "{out}");
            let want = check_form(&format!("vf-check-{in_process}-{i}"), "verify-first", &p, &[]);
            assert!(!want.is_empty() && want.contains("VERIFY-FIRST: "), "{want}");
            assert_eq!(out, want, "payload {i}, in_process={in_process}");
            seen.insert(out);
        }
        assert!(seen.len() >= 15, "the rotation must reach most of its lines, got {}", seen.len());
        e.stop();
    }
}

#[test]
fn verify_first_defers_to_the_node_hook_when_the_session_could_be_a_devswarm_primary() {
    let e = Env::new("vf-primary");
    let map = e.map("UserPromptSubmit", "verify-first");
    let args = ["hook", "--event", "UserPromptSubmit", "--fallback-map", map.to_str().unwrap()];
    let p = ups("sp", "x", None);
    let (code, out, _) = e.run(&args, true, &p, &[("DEVSWARM_REPO_ID", "r1")]);
    assert_eq!(code, 0);
    assert_eq!(ctx(&out), "NODE-RAN", "a possible Primary is the Node hook's");
    let (_, out, _) = e.run(&args, true, &p, &[("DEVSWARM_REPO_ID", "r1"), ("DEVSWARM_SOURCE_BRANCH", "feature")]);
    assert!(out.contains("VERIFY-FIRST: ") && !out.contains("NODE-RAN"), "a child workspace is answered by the engine: {out}");
    assert!(e.home().join(".anti-hall/emit-dedupe/dedupe-sp.json").exists());
}

#[test]
fn a_deferred_verify_first_wrote_no_state_before_deferring() {
    let e = Env::new("vf-nostate");
    let map = e.map("UserPromptSubmit", "verify-first");
    let args = ["hook", "--event", "UserPromptSubmit", "--fallback-map", map.to_str().unwrap()];
    // a relative transcript path is something only Node resolves
    let p = serde_json::json!({"session_id": "ns", "cwd": "/tmp", "hook_event_name": "UserPromptSubmit", "prompt": "x", "transcript_path": "rel/t.jsonl"})
        .to_string();
    let (_, out, _) = e.run(&args, true, &p, &[]);
    assert_eq!(ctx(&out), "NODE-RAN");
    assert!(!e.home().join(".anti-hall/emit-dedupe").exists(), "the deferral must come before any write");
}

#[test]
fn session_start_marks_the_context_loss_through_the_dispatcher() {
    for in_process in [true, false] {
        let e = Env::new(if in_process { "reset-inproc" } else { "reset-daemon" });
        let map = e.map("SessionStart", "none");
        let args = ["hook", "--event", "SessionStart", "--fallback-map", map.to_str().unwrap()];
        let p = serde_json::json!({"session_id": "rs", "cwd": "/tmp", "hook_event_name": "SessionStart", "source": "compact"}).to_string();
        let file = e.home().join(".anti-hall/emit-dedupe/dedupe-rs.json");
        // through the daemon the first call is the Node fallback (the shell map: nothing written), later ones are the check's
        for _ in 0..80 {
            let (code, out, err) = e.run(&args, in_process, &p, &[]);
            // the other SessionStart checks (verify-first-full, verify-first-orch, ...) answer with their own context: only the exit
            // and stderr are asserted here, the reset is proven by the state file below
            assert_eq!((code, err.as_str()), (0, ""), "{out}");
            if file.exists() {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(50));
        }
        let text = std::fs::read_to_string(&file).unwrap_or_default();
        assert!(text.starts_with("{\"__reset\":{\"resetAt\":") && text.contains("\"lastSeenAt\":"), "{text}");
        e.stop();
    }
}

#[test]
fn idle_agent_sweep_through_the_dispatcher_reads_the_request_environment() {
    let e = Env::new("idle");
    let t0 = 1_790_000_000_000u64;
    let iso = |ms: u64| {
        let s = ms / 1000;
        let (days, sod) = (s / 86400, s % 86400);
        // 2026-09-21 is day 20_717 of the epoch for this fixed clock; only the order of the two timestamps matters here
        format!("{:04}-{:02}-{:02}T{:02}:{:02}:{:02}.000Z", 2026, 9, 1 + (days - 20_697), sod / 3600, sod % 3600 / 60, sod % 60)
    };
    let (spawn_at, idle_at) = (t0 - 3_600_000, t0 - 1_800_000);
    let transcript = e.dir.join("t.jsonl");
    let lines = [
        serde_json::json!({"type":"assistant","timestamp":iso(spawn_at - 1000),"message":{"content":[{"type":"tool_use","id":"toolu_1","name":"Agent","input":{}}]}}),
        serde_json::json!({"type":"user","timestamp":iso(spawn_at),"toolUseResult":{"status":"teammate_spawned","name":"zed","agent_id":"zed@team"},"message":{"content":[{"type":"tool_result","tool_use_id":"toolu_1","content":"s"}]}}),
        serde_json::json!({"type":"user","timestamp":iso(idle_at),"message":{"content":format!("Another Claude session sent a message:\n<teammate-message teammate_id=\"zed\">\n{{\"type\":\"idle_notification\",\"from\":\"zed\",\"timestamp\":\"{}\",\"idleReason\":\"available\"}}\n</teammate-message>", iso(idle_at))}}),
    ];
    std::fs::write(&transcript, lines.iter().map(|l| format!("{l}\n")).collect::<String>()).unwrap();
    let map = e.map("UserPromptSubmit", "idle-agent-sweep");
    let args = ["hook", "--event", "UserPromptSubmit", "--fallback-map", map.to_str().unwrap()];
    let p = ups("is", "go on", Some(&transcript));
    let now = t0.to_string();
    let extra = [("ANTIHALL_TEST_ISOLATION", "1"), ("ANTIHALL_TEST_NOW_MS", now.as_str())];
    let (code, out, err) = e.run(&args, true, &p, &extra);
    assert_eq!((code, err.as_str()), (0, ""));
    assert!(out.contains("1 finished agent is idle and not stopped: zed (30m)") && !out.contains("NODE-RAN"), "{out}");
    // the request environment carries the clock: without it the same transcript is 'long ago' in a different way
    // the dispatcher joins the verify-first line and the sweep advisory in table order, as the host joins two hooks
    let want = check_form("idle-check", "idle-agent-sweep", &p, &extra);
    let advisory: serde_json::Value = serde_json::from_str(want.trim_end()).unwrap();
    let advisory = advisory["hookSpecificOutput"]["additionalContext"].as_str().unwrap();
    let joined: serde_json::Value = serde_json::from_str(out.trim_end()).unwrap();
    let joined = joined["hookSpecificOutput"]["additionalContext"].as_str().unwrap();
    assert!(joined.starts_with("VERIFY-FIRST: ") && joined.ends_with(&format!("\n\n{advisory}")), "{joined}");
    // the same prompt again is the same block, still undelivered: both are suppressed
    let (_, again, _) = e.run(&args, true, &p, &extra);
    assert_eq!(ctx(&again), "", "the dedupe state of the first call must hold");
}
