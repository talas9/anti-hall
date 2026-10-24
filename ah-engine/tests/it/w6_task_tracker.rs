//! W6: transcript growth alone no longer re-sends the whole task-list directive ("capture EVERY user request") on every prompt. In a
//! session whose transcript grows past the growth threshold each turn it was sent 463 times; now growth re-sends it only once the
//! minimum gap since the last full directive has passed. Engine alone: the narrowing is intentional.
#![allow(clippy::unwrap_used, clippy::expect_used)] // a test crate: a panic is the failure report, and E2 exempts tests

use serde_json::{Value, json};
use std::io::Write;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::time::{SystemTime, UNIX_EPOCH};

fn plugin() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../plugins/anti-hall")
}

/// The additional context the task tracker puts in front of the model for one prompt of session `s1`.
fn context(tag: &str, last_full_ago_ms: u64) -> String {
    let dir = PathBuf::from(env!("CARGO_TARGET_TMPDIR")).join(format!("w6-tt-{tag}-{}", std::process::id()));
    ah_engine::discard::harmless(std::fs::remove_dir_all(&dir));
    let home = dir.join("home");
    std::fs::create_dir_all(home.join(".anti-hall")).unwrap();
    std::fs::create_dir_all(home.join("proj")).unwrap();
    let now = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_millis() as u64;
    // the last full directive was sent `last_full_ago_ms` ago, when the transcript was 10 bytes; it now holds 300 KB
    std::fs::write(home.join(".anti-hall/task-tracker-s1.json"), format!("{{\"lastFull\":{},\"lastFullSize\":10}}", now - last_full_ago_ms)).unwrap();
    let transcript = home.join("t.jsonl");
    std::fs::write(&transcript, "x".repeat(300_000)).unwrap();
    let payload = json!({"hook_event_name": "UserPromptSubmit", "session_id": "s1", "prompt": "please do the thing", "cwd": home.join("proj"), "transcript_path": transcript});
    let mut c = Command::new(env!("CARGO_BIN_EXE_ah-engine"));
    c.args(["check", "task-tracker"])
        .env_clear()
        .env("PATH", std::env::var("PATH").unwrap_or_default())
        .env("HOME", &home)
        .env("ANTIHALL_INGEST_DRY_RUN", "1")
        .env("AH_ENGINE_DIR", dir.join("state"))
        .env("AH_ENGINE_NOSPAWN", "1")
        .env("AH_ENGINE_PLUGIN_ROOT", plugin())
        .env("CLAUDE_PLUGIN_ROOT", plugin())
        .current_dir(&dir)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut ch = c.spawn().unwrap();
    ch.stdin.take().unwrap().write_all(payload.to_string().as_bytes()).unwrap();
    let o = ch.wait_with_output().unwrap();
    assert_eq!(o.status.code(), Some(0), "{}", String::from_utf8_lossy(&o.stderr));
    let out = String::from_utf8_lossy(&o.stdout).into_owned();
    ah_engine::discard::harmless(std::fs::remove_dir_all(&dir));
    if out.trim().is_empty() {
        return String::new();
    }
    let v: Value = serde_json::from_str(out.trim()).unwrap_or_else(|e| panic!("not JSON ({e}): {out}"));
    v.pointer("/hookSpecificOutput/additionalContext").and_then(Value::as_str).unwrap_or("").to_string()
}

const FULL: &str = "task tracker: requests need tracking before work starts.";

#[test]
fn growth_alone_resends_the_full_directive_only_after_the_minimum_gap() {
    let soon = context("soon", 60_000);
    assert!(!soon.contains(FULL), "a full directive one minute ago: growth alone must not re-send it: {soon}");
    let later = context("later", 2 * 3_600_000);
    assert!(later.contains(FULL), "two hours on (inside the window) the growth re-sends it: {later}");
}
