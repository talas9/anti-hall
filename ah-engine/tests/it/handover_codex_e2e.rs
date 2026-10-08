//! The handover and Codex checks answered through the real dispatcher (`ah-engine hook --event <Event>`), in process and
//! through the daemon: the table entry's Node command is replaced by one that prints `NODE-RAN`, so each test proves the
//! built-in check answered (the output holds the check's text, never the marker) and that what it wrote is where Node
//! would have written it. Every test uses its own HOME and state directory and reaps any daemon it starts.
#![allow(clippy::unwrap_used, clippy::expect_used)] // a test crate: a panic is the failure report, and E2 exempts tests

use crate::common;

use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

struct Env {
    dir: PathBuf,
}

impl Env {
    fn new(name: &str) -> Env {
        let dir = std::env::temp_dir().join(format!("ahd-hc-{name}-{}", std::process::id()));
        ah_engine::discard::harmless(std::fs::remove_dir_all(&dir));
        std::fs::create_dir_all(dir.join("home/.anti-hall")).unwrap();
        // the verify-first SessionStart texts (a native check of their own) would push the joined context of a `compact`
        // start past the 10000 inline cap; these tests are about the handover and Codex checks only
        std::fs::write(dir.join("home/.anti-hall/settings.json"), r#"{"context":{"verifyFirstSession":false,"verifyFirstOrchestration":false}}"#).unwrap();
        Env { dir }
    }

    fn state(&self) -> PathBuf {
        self.dir.join("state")
    }

    /// A fallback map for `event`: the entry `id` prints the marker, every other entry succeeds silently.
    fn map(&self, event: &str, id: &str) -> PathBuf {
        let m: serde_json::Map<String, serde_json::Value> = ah_engine::dispatch::table::entries("claude", event)
            .into_iter()
            .map(|e| (e.id.clone(), if e.id == id { "echo NODE-RAN" } else { "true" }.into()))
            .collect();
        let p = self.dir.join(format!("{event}-map.json"));
        std::fs::write(&p, serde_json::json!({ event: m }).to_string()).unwrap();
        p
    }

    fn run(&self, event: &str, id: &str, in_process: bool, payload: &str, extra: &[(&str, &str)]) -> (i32, String, String) {
        let map = self.map(event, id);
        let mut c = Command::new(env!("CARGO_BIN_EXE_ah-engine"));
        c.args(["hook", "--event", event, "--fallback-map", map.to_str().unwrap()])
            .env_clear()
            .env("PATH", std::env::var("PATH").unwrap_or_default())
            .env("HOME", self.dir.join("home"))
            .env("TMPDIR", self.dir.join("tmp"))
            .env("AH_ENGINE_DIR", self.state())
            .env("AH_ENGINE_VERSION", "handover-codex-e2e")
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

    /// Run through the daemon until it answers (the first call starts it and is answered by Node, D5).
    fn run_daemon(&self, event: &str, id: &str, payload: &str, extra: &[(&str, &str)]) -> (i32, String, String) {
        let mut last = (0, String::new(), String::new());
        for _ in 0..80 {
            last = self.run(event, id, false, payload, extra);
            if !last.1.contains("NODE-RAN") {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(50));
        }
        last
    }

    fn stop(&self) {
        let st = self.state();
        common::reap(&st, || {
            ah_engine::discard::harmless(
                Command::new(env!("CARGO_BIN_EXE_ah-engine")).arg("stop").env("AH_ENGINE_DIR", &st).env("HOME", self.dir.join("home")).output(),
            );
        });
    }

    fn write(&self, rel: &str, text: &str) -> PathBuf {
        let p = self.dir.join(rel);
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(&p, text).unwrap();
        p
    }
}

impl Drop for Env {
    fn drop(&mut self) {
        self.stop(); // also on a panic: the daemon a test started never outlives it (its dir goes only afterwards)
        ah_engine::discard::harmless(std::fs::remove_dir_all(&self.dir));
    }
}

fn git(dir: &Path, args: &[&str]) {
    let o = Command::new("git")
        .args(args)
        .current_dir(dir)
        .env("GIT_AUTHOR_NAME", "t")
        .env("GIT_AUTHOR_EMAIL", "t@t")
        .env("GIT_COMMITTER_NAME", "t")
        .env("GIT_COMMITTER_EMAIL", "t@t")
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .output()
        .unwrap();
    assert!(o.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&o.stderr));
}

fn repo(e: &Env) -> PathBuf {
    let r = e.dir.join("repo");
    std::fs::create_dir_all(&r).unwrap();
    git(&r, &["init", "-q", "-b", "main"]);
    std::fs::write(r.join("a.js"), "x").unwrap();
    git(&r, &["add", "-A"]);
    git(&r, &["commit", "-q", "-m", "init"]);
    std::fs::canonicalize(r).unwrap()
}

#[test]
fn codex_quota_detect_answers_a_codex_rescue_result_in_process_and_through_the_daemon() {
    let e = Env::new("quota");
    let p = serde_json::json!({"session_id": "s", "cwd": e.dir, "hook_event_name": "PostToolUse", "tool_name": "Agent", "tool_input": {"subagent_type": "codex:codex-rescue"}, "tool_response": "out of quota until 2030-10-08T12:00:00Z."}).to_string();
    let (code, out, err) = e.run("PostToolUse", "codex-quota-detect", true, &p, &[]);
    assert_eq!((code, err.as_str()), (0, ""));
    assert!(
        out.starts_with("{\"hookSpecificOutput\":{\"hookEventName\":\"PostToolUse\",\"additionalContext\":\"\\u26a0")
            || out.contains("codex:codex-rescue reported quota exhaustion"),
        "{out}"
    );
    assert!(!out.contains("NODE-RAN"), "{out}");
    let state = std::fs::read_to_string(e.dir.join("home/.anti-hall/codex-availability.json")).unwrap();
    assert!(state.contains("\"until\":1917691200000"), "{state}");
    // through the daemon
    ah_engine::discard::harmless(std::fs::remove_file(e.dir.join("home/.anti-hall/codex-availability.json")));
    let (code, out, _) = e.run_daemon("PostToolUse", "codex-quota-detect", &p, &[]);
    e.stop();
    assert_eq!(code, 0);
    assert!(out.contains("codex:codex-rescue reported quota exhaustion") && !out.contains("NODE-RAN"), "{out}");
    assert!(e.dir.join("home/.anti-hall/codex-availability.json").exists(), "the daemon wrote the record in the request's home");
}

#[test]
fn codex_availability_answers_a_session_start() {
    let e = Env::new("avail");
    e.write("bin/codex", "#!/bin/sh\n");
    std::fs::set_permissions(e.dir.join("bin/codex"), std::os::unix::fs::PermissionsExt::from_mode(0o755)).unwrap();
    let path = format!("{}:/usr/bin:/bin", e.dir.join("bin").display());
    let p = serde_json::json!({"session_id": "s", "cwd": e.dir, "hook_event_name": "SessionStart", "source": "startup"}).to_string();
    let (code, out, err) = e.run("SessionStart", "codex-availability", true, &p, &[("PATH", &path)]);
    assert_eq!((code, err.as_str()), (0, ""));
    assert!(out.contains("Codex binary detected on PATH") && !out.contains("NODE-RAN"), "{out}");
    let state: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(e.dir.join("home/.anti-hall/codex-availability.json")).unwrap()).unwrap();
    assert_eq!((state["available"].clone(), state["source"].clone()), (serde_json::json!(true), serde_json::json!("path-probe")));
    let (_, out, _) = e.run_daemon("SessionStart", "codex-availability", &p, &[("PATH", &path)]);
    e.stop();
    assert!(out.contains("Codex binary detected on PATH") && !out.contains("NODE-RAN"), "{out}");
}

#[test]
fn handover_resume_points_at_the_newest_handover() {
    let e = Env::new("resume");
    let r = repo(&e);
    let day = {
        let o = Command::new("date").arg("+%F").output().unwrap();
        String::from_utf8_lossy(&o.stdout).trim().to_string()
    };
    let h = r.join(format!(".anti-hall/handovers/{day}/sess-1/HANDOVER.md"));
    std::fs::create_dir_all(h.parent().unwrap()).unwrap();
    std::fs::write(&h, "# H\n").unwrap();
    let p = serde_json::json!({"session_id": "sess-1", "cwd": r, "hook_event_name": "SessionStart", "source": "compact"}).to_string();
    let (code, out, err) = e.run("SessionStart", "handover-resume", true, &p, &[]);
    assert_eq!((code, err.as_str()), (0, ""));
    assert!(out.contains("A session handover was found for this continuation") && out.contains(&*h.to_string_lossy()) && !out.contains("NODE-RAN"), "{out}");
    assert!(e.dir.join("home/.anti-hall/handover-resume-state-sess-1.json").exists());
    let (_, out, _) = e.run_daemon("SessionStart", "handover-resume", &p, &[]);
    e.stop();
    assert!(out.contains("A session handover was found for this continuation") && !out.contains("NODE-RAN"), "{out}");
}

#[test]
fn precompact_snapshot_writes_its_file_and_prints_nothing() {
    let e = Env::new("precompact");
    let r = repo(&e);
    let tp = e.write("t.jsonl", "{\"type\":\"user\",\"message\":{\"content\":\"keep this rule\"}}\n");
    let p = serde_json::json!({"session_id": "sess-1", "cwd": r, "transcript_path": tp, "hook_event_name": "PreCompact", "trigger": "manual"}).to_string();
    let (code, out, err) = e.run("PreCompact", "precompact-snapshot", true, &p, &[]);
    assert_eq!((code, out.as_str(), err.as_str()), (0, "", ""));
    let found = |dir: &Path| -> Vec<PathBuf> { walk(dir).into_iter().filter(|f| f.file_name().is_some_and(|n| n == "PRECOMPACT-1.md")).collect() };
    let files = found(&r.join(".anti-hall/handovers"));
    assert_eq!(files.len(), 1, "{files:?}");
    let text = std::fs::read_to_string(&files[0]).unwrap();
    assert!(text.contains("(trigger: manual)") && text.contains("keep this rule"), "{text}");
    let (_, out, _) = e.run_daemon("PreCompact", "precompact-snapshot", &p, &[]);
    e.stop();
    assert!(!out.contains("NODE-RAN"), "{out}");
    assert_eq!(
        walk(&r.join(".anti-hall/handovers")).into_iter().filter(|f| f.to_string_lossy().contains("PRECOMPACT-")).count(),
        2,
        "the daemon numbered the second snapshot"
    );
}

fn walk(dir: &Path) -> Vec<PathBuf> {
    let mut out = Vec::new();
    for e in std::fs::read_dir(dir).into_iter().flatten().flatten() {
        let p = e.path();
        if p.is_dir() {
            out.extend(walk(&p));
        } else {
            out.push(p);
        }
    }
    out
}

#[test]
fn codex_nudge_blocks_a_stop_once_with_the_decision_json() {
    let e = Env::new("nudge");
    let r = repo(&e);
    let enc: String = r.to_string_lossy().chars().map(|c| if c.is_ascii_alphanumeric() { c } else { '-' }).collect();
    let lines: Vec<String> = (0..4).map(|i| serde_json::json!({"type": "assistant", "message": {"content": [{"type": "tool_use", "name": "Edit", "input": {"file_path": r.join(format!("f{i}.js"))}}]}}).to_string()).collect();
    let tp = e.write(&format!("home/.claude/projects/{enc}/sess-1.jsonl"), &(lines.join("\n") + "\n"));
    let p = serde_json::json!({"session_id": "sess-1", "cwd": r, "transcript_path": tp, "hook_event_name": "Stop", "stop_hook_active": false}).to_string();
    let (code, out, err) = e.run("Stop", "codex-nudge", true, &p, &[]);
    assert_eq!((code, err.as_str()), (0, ""));
    let v: serde_json::Value = serde_json::from_str(out.trim()).unwrap_or_else(|_| panic!("{out}"));
    assert_eq!(v["decision"], "block");
    assert!(v["reason"].as_str().unwrap().contains("this session made 4 substantial code edit(s) across 4 file(s) (f0.js, f1.js, f2.js, …)"), "{out}");
    // the same file set is not nudged again
    let (code, out, _) = e.run("Stop", "codex-nudge", true, &p, &[]);
    assert_eq!((code, out.as_str()), (0, ""));
    e.stop();
}
