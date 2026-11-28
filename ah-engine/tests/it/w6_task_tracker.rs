//! W6 / #958: the whole task-list directive ("capture EVERY user request") goes out once per context epoch (the first prompt of a
//! session, and the first one after a context loss), never on a clock window or on transcript growth; the short reminder speaks only on
//! evidence (a substantive prompt while no task is open). Engine alone: the narrowing is intentional.
#![allow(clippy::unwrap_used, clippy::expect_used)] // a test crate: a panic is the failure report, and E2 exempts tests

use serde_json::{Value, json};
use std::io::Write;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::time::{SystemTime, UNIX_EPOCH};

fn plugin() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../plugins/anti-hall")
}

/// What one prompt of session `s1` looks like to the tracker: when the last full directive was sent, when the context was last lost
/// (the SessionStart reset marker), the prompt, and the transcript.
struct Case<'a> {
    last_full_ago_ms: u64,
    reset_ago_ms: Option<u64>,
    prompt: &'a str,
    transcript: String,
}

/// A transcript that parses (one user line) and holds no task.
fn no_tasks() -> String {
    format!("{}\n", json!({"type": "user", "message": {"role": "user", "content": "hello"}}))
}

/// A transcript with one open task.
fn one_open_task() -> String {
    format!(
        "{}\n{}\n",
        json!({"type": "assistant", "message": {"id": "c1", "role": "assistant", "content": [{"type": "tool_use", "id": "c1", "name": "TaskCreate", "input": {"subject": "t1"}}]}}),
        json!({"type": "user", "message": {"role": "user", "content": [{"type": "tool_result", "tool_use_id": "c1", "content": "Task #1 created successfully: t1"}]}})
    )
}

/// The additional context the task tracker puts in front of the model for one prompt of session `s1`.
fn context(tag: &str, c: &Case) -> String {
    let dir = PathBuf::from(env!("CARGO_TARGET_TMPDIR")).join(format!("w6-tt-{tag}-{}", std::process::id()));
    ah_engine::discard::harmless(std::fs::remove_dir_all(&dir));
    let home = dir.join("home");
    std::fs::create_dir_all(home.join(".anti-hall/emit-dedupe")).unwrap();
    std::fs::create_dir_all(home.join("proj")).unwrap();
    let now = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_millis() as u64;
    std::fs::write(home.join(".anti-hall/task-tracker-s1.json"), format!("{{\"lastFull\":{},\"lastFullSize\":10}}", now - c.last_full_ago_ms)).unwrap();
    if let Some(ago) = c.reset_ago_ms {
        let at = now - ago;
        std::fs::write(home.join(".anti-hall/emit-dedupe/dedupe-s1.json"), format!("{{\"__reset\":{{\"resetAt\":{at},\"lastSeenAt\":{at}}}}}")).unwrap();
    }
    let transcript = home.join("t.jsonl");
    std::fs::write(&transcript, &c.transcript).unwrap();
    let payload = json!({"hook_event_name": "UserPromptSubmit", "session_id": "s1", "prompt": c.prompt, "cwd": home.join("proj"), "transcript_path": transcript});
    let mut c = Command::new(env!("CARGO_BIN_EXE_ah-engine"));
    c.args(["check", "task-tracker"])
        .env_clear()
        .env("PATH", std::env::var("PATH").unwrap_or_default())
        .env("HOME", &home)
        .env("ANTIHALL_INGEST_DRY_RUN", "1")
        .env("ANTIHALL_TASK_TRACKER_TERSE", "0") // the earlier wording these assertions read: the terse wording ships on
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
const SHORT: &str = "capture every request as a priority-sorted task";
const LONG_PROMPT: &str = "please refactor the billing export so it streams rows instead of loading them";
const HOUR: u64 = 3_600_000;

#[test]
fn the_full_directive_is_sent_once_per_context_epoch_not_on_a_timer_or_growth() {
    // sent 7 hours ago (past the old 6 h window), the transcript grown since: no new epoch, so nothing is re-sent
    let c = Case { last_full_ago_ms: 7 * HOUR, reset_ago_ms: None, prompt: LONG_PROMPT, transcript: one_open_task() + &"x".repeat(300_000) };
    let same = context("same", &c);
    assert!(!same.contains(FULL), "the same context epoch: the directive is not re-sent: {same}");
    // the context was lost 1 h ago (the SessionStart reset marker), after the directive: the new epoch gets it once
    let c = Case { last_full_ago_ms: 2 * HOUR, reset_ago_ms: Some(HOUR), prompt: LONG_PROMPT, transcript: one_open_task() };
    let again = context("again", &c);
    assert!(again.contains(FULL), "a context loss after the last directive: it is sent again: {again}");
    // the reset is OLDER than the directive: the directive already belongs to this epoch
    let c = Case { last_full_ago_ms: HOUR, reset_ago_ms: Some(2 * HOUR), prompt: LONG_PROMPT, transcript: one_open_task() };
    assert!(!context("older", &c).contains(FULL), "a reset older than the last directive is no new epoch");
}

#[test]
fn a_compliant_prompt_gets_no_compliance_line_and_an_untracked_request_gets_the_reminder() {
    // a task is open: the work is tracked, nothing to say (no short reminder, no open-tasks line, no DISPATCH NOW)
    let tracked = Case { last_full_ago_ms: HOUR, reset_ago_ms: None, prompt: LONG_PROMPT, transcript: one_open_task() };
    let out = context("tracked", &tracked);
    assert!(out.is_empty(), "a compliant prompt is met with silence: {out}");
    // a short follow-up with no task open is no request either
    let short = Case { last_full_ago_ms: HOUR, reset_ago_ms: None, prompt: "yes do it", transcript: no_tasks() };
    assert!(context("short", &short).is_empty(), "a short follow-up is silent");
    // a substantive prompt while no task is open: the evidence of an untracked request
    let untracked = Case { last_full_ago_ms: HOUR, reset_ago_ms: None, prompt: LONG_PROMPT, transcript: no_tasks() };
    let out = context("untracked", &untracked);
    assert!(out.contains(SHORT), "a substantive prompt with no task open gets the reminder: {out}");
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
        .env("ANTIHALL_TASK_TRACKER_TERSE", "0") // the earlier wording these assertions read: the terse wording ships on
        .env("ANTIHALL_PRUNE_COMPLETED_TASKS_AFTER", prune_after)
        .env("ANTIHALL_TASK_TRACKER_LINES", "1") // the open-tasks line is off by default (#958); these assertions read it
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
    assert!(first.contains("delete your 2 completed tasks (limit 1)"), "the prune advisory must be model-visible context on the prompt: {first}");
    assert!(!second.contains("completed tasks (limit"), "an unchanged list must not repeat it: {second}");
    let line = first.lines().find(|l| l.contains("delete your 2 completed tasks (limit 1)")).expect("the prune line");
    assert!(first.contains("not user data"), "the prune advisory must say task entries are not user data: {line}");
    assert!(first.contains("REQUIRED NOW"), "the prune advisory must be phrased as required: {line}");
    assert!(first.contains(".anti-hall/history/<date>/<session>.md"), "the prune advisory must name the ledger path: {first}");
    assert!(line.chars().count() < 150, "the first line of the prune advisory must stay under the 150-char digest cut: {} chars: {line}", line.chars().count());
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
    assert!(ctx.contains("delete your 11 completed tasks (limit 10)"), "the prune advisory must count the store's done tasks: {ctx}");
    assert!(ctx.contains("open tasks: 2"), "the open-task line must count the pending task the tail never mentions: {ctx}");
}

/// The prompt digest (#338 item 2, `inject_gate.digest_hooks`) keeps one headline per advisory inline and spills the rest to a file the
/// model has to open. The prune advisory used to trail the tracker's generic reminder, so it was always in the spilled part: produced
/// correctly, never seen. Through the real dispatcher, with the digest threshold at its minimum (the limit-conservation directive speaks too), the INLINE
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
        .env("ANTIHALL_TASK_TRACKER_TERSE", "0") // the earlier wording these assertions read: the terse wording ships on
        .env("ANTIHALL_PRUNE_COMPLETED_TASKS_AFTER", "10")
        .env("ANTIHALL_LIMIT_CONSERVE", "on") // the conservation directive and the tracker are two digestible advisories
        .env("ANTIHALL_PROMPT_DIGEST_MIN", "2")
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
    assert!(inline.contains("delete your 12 completed tasks (limit 10)"), "the prune advisory must be in the inline digest, not only the spill file: {ctx}");
}
