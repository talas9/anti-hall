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

/// One UserPromptSubmit of session `s1` in `home` (kept between calls) over a transcript of three tasks, two of them completed, with the
/// prune threshold at 1; returns the additional context the model would get.
fn prune_context(home: &std::path::Path, dir: &std::path::Path) -> String {
    let mut t = String::new();
    for n in 1..=3 {
        t += &format!(
            "{}\n",
            json!({"type": "assistant", "message": {"id": format!("c{n}"), "role": "assistant", "content": [{"type": "tool_use", "id": format!("c{n}"), "name": "TaskCreate", "input": {"subject": format!("t{n}")}}]}})
        );
        t += &format!(
            "{}\n",
            json!({"type": "user", "message": {"role": "user", "content": [{"type": "tool_result", "tool_use_id": format!("c{n}"), "content": format!("Task #{n} created successfully: t{n}")}]}})
        );
    }
    for n in 1..=2 {
        t += &format!(
            "{}\n",
            json!({"type": "assistant", "message": {"id": format!("u{n}"), "role": "assistant", "content": [{"type": "tool_use", "id": format!("u{n}"), "name": "TaskUpdate", "input": {"taskId": n.to_string(), "status": "completed"}}]}})
        );
    }
    let transcript = home.join("t.jsonl");
    std::fs::write(&transcript, t).unwrap();
    prompt_context(home, dir, "s1", &transcript, "1")
}

/// One UserPromptSubmit of session `sid` over `transcript`, the prune threshold at `prune_after`; the additional context.
fn prompt_context(home: &std::path::Path, dir: &std::path::Path, sid: &str, transcript: &std::path::Path, prune_after: &str) -> String {
    let payload = json!({"hook_event_name": "UserPromptSubmit", "session_id": sid, "prompt": "next", "cwd": home.join("proj"), "transcript_path": transcript});
    let mut c = Command::new(env!("CARGO_BIN_EXE_ah-engine"));
    c.args(["check", "task-tracker"])
        .env_clear()
        .env("PATH", std::env::var("PATH").unwrap_or_default())
        .env("HOME", home)
        .env("ANTIHALL_INGEST_DRY_RUN", "1")
        .env("ANTIHALL_PRUNE_COMPLETED_TASKS_AFTER", prune_after)
        .env("AH_ENGINE_DIR", dir.join("state"))
        .env("AH_ENGINE_NOSPAWN", "1")
        .env("AH_ENGINE_PLUGIN_ROOT", plugin())
        .env("CLAUDE_PLUGIN_ROOT", plugin())
        .current_dir(dir)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut ch = c.spawn().unwrap();
    ch.stdin.take().unwrap().write_all(payload.to_string().as_bytes()).unwrap();
    let o = ch.wait_with_output().unwrap();
    assert_eq!(o.status.code(), Some(0), "{}", String::from_utf8_lossy(&o.stderr));
    let out = String::from_utf8_lossy(&o.stdout).into_owned();
    if out.trim().is_empty() {
        return String::new();
    }
    let v: Value = serde_json::from_str(out.trim()).unwrap_or_else(|e| panic!("not JSON ({e}): {out}"));
    v.pointer("/hookSpecificOutput/additionalContext").and_then(Value::as_str).unwrap_or("").to_string()
}

#[test]
fn the_prune_advisory_reaches_the_model_on_the_prompt_once_per_list_change() {
    let dir = PathBuf::from(env!("CARGO_TARGET_TMPDIR")).join(format!("w6-prune-{}", std::process::id()));
    ah_engine::discard::harmless(std::fs::remove_dir_all(&dir));
    let home = dir.join("home");
    std::fs::create_dir_all(home.join(".anti-hall")).unwrap();
    std::fs::create_dir_all(home.join("proj")).unwrap();
    let first = prune_context(&home, &dir);
    let second = prune_context(&home, &dir);
    ah_engine::discard::harmless(std::fs::remove_dir_all(&dir));
    assert!(first.contains("2 completed/cancelled tasks (> 1)"), "the prune advisory must be model-visible context on the prompt: {first}");
    assert!(!second.contains("completed/cancelled tasks ("), "an unchanged list must not repeat it: {second}");
}

/// A long session: Claude Code's own task store (`~/.claude/tasks/session-<first 8 of the id>/N.json`) holds 11 completed tasks, one pending and one
/// in progress, but the last `taskstate.tail_bytes` of the transcript hold no TaskCreate and one TaskUpdate. The transcript
/// reconstruction cannot see the other tasks, so the prune advisory and the open-task line never fired; the store is the source.
#[test]
fn a_long_session_whose_transcript_tail_lacks_the_creates_reads_its_list_from_the_task_store() {
    let dir = PathBuf::from(env!("CARGO_TARGET_TMPDIR")).join(format!("w6-long-{}", std::process::id()));
    ah_engine::discard::harmless(std::fs::remove_dir_all(&dir));
    let home = dir.join("home");
    std::fs::create_dir_all(home.join(".anti-hall")).unwrap();
    std::fs::create_dir_all(home.join("proj")).unwrap();
    let sid = "0a1b2c3d-1111-2222-3333-444455556666";
    let store = home.join(".claude/tasks/session-0a1b2c3d");
    std::fs::create_dir_all(&store).unwrap();
    for n in 1..=13 {
        let status = match n {
            13 => "in_progress",
            12 => "pending",
            _ => "completed",
        };
        let rec = json!({"id": n.to_string(), "subject": format!("long task {n}"), "description": "d", "status": status, "blocks": [], "blockedBy": []});
        std::fs::write(store.join(format!("{n}.json")), rec.to_string()).unwrap();
    }
    let mut t = String::new();
    for n in 1..=13 {
        t += &format!(
            "{}\n{}\n",
            json!({"type": "assistant", "message": {"id": format!("c{n}"), "role": "assistant", "content": [{"type": "tool_use", "id": format!("c{n}"), "name": "TaskCreate", "input": {"subject": format!("long task {n}")}}]}}),
            json!({"type": "user", "message": {"role": "user", "content": [{"type": "tool_result", "tool_use_id": format!("c{n}"), "content": format!("Task #{n} created successfully: long task {n}")}]}})
        );
    }
    // far more than the tail window of filler, then a single update of the last task
    let filler = json!({"type": "assistant", "message": {"id": "f", "role": "assistant", "content": [{"type": "text", "text": "x".repeat(4096)}]}}).to_string();
    for _ in 0..500 {
        t += &filler;
        t.push('\n');
    }
    t += &format!(
        "{}\n",
        json!({"type": "assistant", "message": {"id": "u13", "role": "assistant", "content": [{"type": "tool_use", "id": "u13", "name": "TaskUpdate", "input": {"taskId": "13", "status": "in_progress"}}]}})
    );
    let transcript = home.join("long.jsonl");
    std::fs::write(&transcript, t).unwrap();
    assert!(std::fs::metadata(&transcript).unwrap().len() > 1_572_864 + 100_000, "the creates must lie outside the tail window");
    let ctx = prompt_context(&home, &dir, sid, &transcript, "10");
    ah_engine::discard::harmless(std::fs::remove_dir_all(&dir));
    assert!(ctx.contains("11 completed/cancelled tasks (> 10)"), "the prune advisory must count the store's done tasks: {ctx}");
    assert!(ctx.contains("open tasks: 2"), "the open-task line must count the pending task the tail never mentions: {ctx}");
}

/// The prompt digest (#338 item 2, `inject_gate.digest_hooks`) keeps one headline per advisory inline and spills the rest to a file the
/// model has to open. The prune advisory used to trail the tracker's generic reminder, so it was always in the spilled part: produced
/// correctly, never seen. Through the real dispatcher, with the digest threshold at its minimum (the verify-first reminder speaks too), the INLINE
/// part (before the spill pointer) must carry it.
#[test]
fn the_prune_advisory_survives_the_prompt_digest_inline() {
    let dir = PathBuf::from(env!("CARGO_TARGET_TMPDIR")).join(format!("w6-digest-{}", std::process::id()));
    ah_engine::discard::harmless(std::fs::remove_dir_all(&dir));
    let home = dir.join("home");
    std::fs::create_dir_all(home.join(".anti-hall")).unwrap();
    std::fs::create_dir_all(home.join("proj")).unwrap();
    let mut t = String::new();
    for n in 1..=13 {
        t += &format!(
            "{}\n{}\n",
            json!({"type": "assistant", "message": {"id": format!("c{n}"), "role": "assistant", "content": [{"type": "tool_use", "id": format!("c{n}"), "name": "TaskCreate", "input": {"subject": format!("task {n}")}}]}}),
            json!({"type": "user", "message": {"role": "user", "content": [{"type": "tool_result", "tool_use_id": format!("c{n}"), "content": format!("Task #{n} created successfully: task {n}")}]}})
        );
    }
    for n in 1..=12 {
        t += &format!(
            "{}\n",
            json!({"type": "assistant", "message": {"id": format!("u{n}"), "role": "assistant", "content": [{"type": "tool_use", "id": format!("u{n}"), "name": "TaskUpdate", "input": {"taskId": n.to_string(), "status": "completed"}}]}})
        );
    }
    let transcript = home.join("t.jsonl");
    std::fs::write(&transcript, t).unwrap();
    let map = dir.join("map.json");
    std::fs::write(&map, "{}").unwrap();
    let sid = "d1d1d1d1-0000-4000-8000-000000000001";
    let payload = json!({"hook_event_name": "UserPromptSubmit", "session_id": sid, "prompt": "next", "cwd": home.join("proj"), "transcript_path": transcript});
    let mut c = Command::new(env!("CARGO_BIN_EXE_ah-engine"));
    c.args(["hook", "--event", "UserPromptSubmit", "--fallback-map", map.to_str().unwrap()])
        .env_clear()
        .env("PATH", std::env::var("PATH").unwrap_or_default())
        .env("HOME", &home)
        .env("ANTIHALL_INGEST_DRY_RUN", "1")
        .env("ANTIHALL_PRUNE_COMPLETED_TASKS_AFTER", "10")
        .env("ANTIHALL_PROMPT_DIGEST_MIN", "2") // the verify-first reminder and the tracker are two digestible advisories
        .env("AH_ENGINE_DIR", dir.join("state"))
        .env("AH_ENGINE_NOSPAWN", "1")
        .env("AH_ENGINE_DISPATCH_IN_PROCESS", "1")
        .env("AH_ENGINE_PLUGIN_ROOT", plugin())
        .env("CLAUDE_PLUGIN_ROOT", plugin())
        .current_dir(&dir)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut ch = c.spawn().unwrap();
    ch.stdin.take().unwrap().write_all(payload.to_string().as_bytes()).unwrap();
    let o = ch.wait_with_output().unwrap();
    ah_engine::discard::harmless(std::fs::remove_dir_all(&dir));
    let out = String::from_utf8_lossy(&o.stdout).into_owned();
    let v: Value = serde_json::from_str(out.trim()).unwrap_or_else(|e| panic!("not JSON ({e}): {out} / {}", String::from_utf8_lossy(&o.stderr)));
    let ctx = v.pointer("/hookSpecificOutput/additionalContext").and_then(Value::as_str).unwrap_or("").to_string();
    assert!(ctx.contains("(full text: "), "the stand-ins must make the digest spill, else this test proves nothing: {ctx}");
    let inline = ctx.split("(full text: ").next().unwrap_or("");
    assert!(inline.contains("12 completed/cancelled tasks (> 10)"), "the prune advisory must be in the inline digest, not only the spill file: {ctx}");
}
