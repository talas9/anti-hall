//! The task readers follow the session task store (`~/.claude/tasks/session-<first 8 of the id>/<n>.json`), not a rebuild from the
//! transcript tail. Each test seeds a scratch HOME with a store and a transcript that DISAGREE and asserts the reader's answer is the
//! store's; a control without a store dir proves the transcript is still the fallback.
#![allow(clippy::unwrap_used, clippy::expect_used)] // a test crate: a panic is the failure report, and E2 exempts tests

use serde_json::{Value, json};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

const SID: &str = "0a1b2c3d-1111-2222-3333-444455556666";

struct Scratch {
    dir: PathBuf,
}

impl Scratch {
    fn new(tag: &str) -> Scratch {
        let dir = PathBuf::from(env!("CARGO_TARGET_TMPDIR")).join(format!("trs-{tag}-{}", std::process::id()));
        ah_engine::discard::harmless(std::fs::remove_dir_all(&dir));
        std::fs::create_dir_all(dir.join("home/.anti-hall")).unwrap();
        std::fs::create_dir_all(dir.join("proj/.git")).unwrap();
        Scratch { dir }
    }

    fn home(&self) -> PathBuf {
        self.dir.join("home")
    }

    /// The session's store with one task per status given (ids 1..).
    fn store(&self, statuses: &[&str]) {
        let store = self.home().join(".claude/tasks/session-0a1b2c3d");
        std::fs::create_dir_all(&store).unwrap();
        for (i, st) in statuses.iter().enumerate() {
            let n = i + 1;
            let rec = json!({"id": n.to_string(), "subject": format!("store task {n}"), "description": "d", "status": st, "blocks": [], "blockedBy": []});
            std::fs::write(store.join(format!("{n}.json")), rec.to_string()).unwrap();
        }
    }

    /// A transcript whose reconstruction holds one task (#1) with `status`.
    fn transcript(&self, status: &str) -> PathBuf {
        let t = format!(
            "{}\n{}\n{}\n",
            json!({"type": "assistant", "message": {"id": "m1", "role": "assistant", "content": [{"type": "tool_use", "id": "tu1", "name": "TaskCreate", "input": {"subject": "transcript task"}}]}}),
            json!({"type": "user", "message": {"role": "user", "content": [{"type": "tool_result", "tool_use_id": "tu1", "content": "Task #1 created successfully: transcript task"}]}}),
            json!({"type": "assistant", "message": {"id": "m2", "role": "assistant", "content": [{"type": "tool_use", "id": "tu2", "name": "TaskUpdate", "input": {"taskId": "1", "status": status}}]}}),
        );
        let p = self.dir.join("t.jsonl");
        std::fs::write(&p, t).unwrap();
        p
    }

    /// `ah-engine check <name>` on `payload` in the scratch HOME; stdout.
    fn check(&self, name: &str, payload: &Value, env: &[(&str, &str)]) -> String {
        let plugin = Path::new(env!("CARGO_MANIFEST_DIR")).join("../plugins/anti-hall");
        let mut c = Command::new(env!("CARGO_BIN_EXE_ah-engine"));
        c.args(["check", name])
            .env_clear()
            .env("PATH", std::env::var("PATH").unwrap_or_default())
            .env("HOME", self.home())
            .env("ANTIHALL_INGEST_DRY_RUN", "1")
            .env("AH_ENGINE_DIR", self.dir.join("state"))
            .env("AH_ENGINE_NOSPAWN", "1")
            .env("AH_ENGINE_PLUGIN_ROOT", &plugin)
            .env("CLAUDE_PLUGIN_ROOT", &plugin)
            .envs(env.iter().copied())
            .current_dir(&self.dir)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        let mut ch = c.spawn().unwrap();
        ch.stdin.take().unwrap().write_all(payload.to_string().as_bytes()).unwrap();
        let o = ch.wait_with_output().unwrap();
        format!("{}{}", String::from_utf8_lossy(&o.stdout), String::from_utf8_lossy(&o.stderr))
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        ah_engine::discard::harmless(std::fs::remove_dir_all(&self.dir));
    }
}

fn stop(s: &Scratch, tr: &Path) -> Value {
    json!({"hook_event_name": "Stop", "session_id": SID, "cwd": s.dir.join("proj"), "transcript_path": tr})
}

#[test]
fn task_guard_follows_the_store_when_the_transcript_still_shows_an_open_task() {
    let s = Scratch::new("tg-done");
    s.store(&["completed", "completed"]);
    let tr = s.transcript("pending");
    let out = s.check("task-guard", &stop(&s, &tr), &[]);
    assert!(!out.contains("\"decision\":\"block\""), "every task in the store is done: a stale transcript must not block the Stop: {out}");
}

#[test]
fn task_guard_follows_the_store_when_the_transcript_shows_nothing_open() {
    let s = Scratch::new("tg-open");
    s.store(&["completed", "pending"]);
    let tr = s.transcript("completed");
    let out = s.check("task-guard", &stop(&s, &tr), &[]);
    assert!(out.contains("\"decision\":\"block\""), "a pending task in the store blocks the Stop: {out}");
}

#[test]
fn task_guard_still_reads_the_transcript_when_the_session_has_no_store() {
    let s = Scratch::new("tg-fallback");
    let tr = s.transcript("pending");
    let out = s.check("task-guard", &stop(&s, &tr), &[]);
    assert!(out.contains("\"decision\":\"block\""), "no store dir: the transcript is the fallback: {out}");
}

#[test]
fn tasklist_hygiene_counts_the_open_tasks_of_the_store() {
    let s = Scratch::new("th");
    s.store(&vec!["pending"; 13]);
    let tr = s.transcript("completed");
    let payload = json!({"hook_event_name": "PostToolUse", "tool_name": "TaskCreate", "session_id": SID, "cwd": s.dir.join("proj"), "transcript_path": tr, "tool_input": {"subject": "one more"}});
    let out = s.check("tasklist-hygiene", &payload, &[]);
    assert!(out.contains("14 open tasks (budget 12)"), "13 pending in the store plus the new one: {out}");
}

#[test]
fn compact_advice_guard_counts_the_finished_tasks_of_the_store() {
    let s = Scratch::new("ca");
    s.store(&["completed", "completed", "pending"]);
    let tr = s.transcript("pending");
    std::fs::write(s.home().join(".anti-hall/settings.json"), r#"{"guards":{"compactAdviceGuard":{"a":1}},"autoHandover":{}}"#).unwrap();
    let mut p = stop(&s, &tr);
    p["last_assistant_message"] = json!("safe to compact");
    let out = s.check("compact-advice-guard", &p, &[("ANTIHALL_CONTEXT_WINDOW_TOKENS", "200000"), ("ANTIHALL_TEST_ISOLATION", "1")]);
    assert!(out.contains("\"decision\":\"block\"") && out.contains("the handover is not"), "two finished tasks in the store (the transcript has none): the declaration is over budget: {out}");
}

/// The request marker dispatch-tier writes is keyed by a hash of the task's text. A TaskUpdate that only carries a description is
/// hashed with the subject the list already holds: from the store it must equal the hash of the same update carrying that subject itself.
#[test]
fn dispatch_tier_reads_the_task_text_from_the_store() {
    let marker = |s: &Scratch| -> Vec<String> {
        let state = std::fs::read_to_string(s.home().join(".anti-hall/dispatch-tier-state.json")).unwrap_or_default();
        let v: Value = serde_json::from_str(&state).unwrap_or_else(|e| panic!("no marker ({e}): {state}"));
        v["requested"].as_object().unwrap().keys().cloned().collect()
    };
    let call = |s: &Scratch, input: Value| {
        let tr = s.transcript("pending"); // the transcript knows only task 1, named differently
        let payload = json!({"hook_event_name": "PostToolUse", "tool_name": "TaskUpdate", "session_id": SID, "cwd": s.dir.join("proj"), "transcript_path": tr, "tool_input": input});
        s.check("dispatch-tier", &payload, &[("ANTIHALL_JEV", "1")]);
    };
    let from_store = Scratch::new("dt-store");
    from_store.store(&["pending", "pending"]);
    call(&from_store, json!({"taskId": "2", "description": "new text"}));
    let spelled_out = Scratch::new("dt-literal");
    call(&spelled_out, json!({"taskId": "2", "subject": "store task 2", "description": "new text"}));
    assert_eq!(marker(&from_store), marker(&spelled_out), "task 2 exists only in the store: its subject must come from there");
}

#[test]
fn tasklist_guard_counts_the_in_progress_tasks_of_the_store() {
    let s = Scratch::new("tl");
    s.store(&["in_progress", "in_progress"]);
    let tr = s.dir.join("t.jsonl");
    let edit = |n: u32| json!({"type": "assistant", "timestamp": "2026-10-06T08:00:00.000Z", "message": {"id": format!("m{n}"), "role": "assistant", "content": [{"type": "tool_use", "id": format!("t{n}"), "name": "Edit", "input": {"file_path": format!("/p/f{n}.js")}}]}});
    let create = json!({"type": "assistant", "message": {"id": "c", "role": "assistant", "content": [{"type": "tool_use", "id": "tuc", "name": "TaskCreate", "input": {"subject": "x"}}]}});
    let result = json!({"type": "user", "message": {"role": "user", "content": [{"type": "tool_result", "tool_use_id": "tuc", "content": "Task #1 created successfully: x"}]}});
    let done = json!({"type": "assistant", "message": {"id": "u", "role": "assistant", "content": [{"type": "tool_use", "id": "tuu", "name": "TaskUpdate", "input": {"taskId": "1", "status": "completed"}}]}});
    std::fs::write(&tr, format!("{create}\n{result}\n{done}\n{}\n{}\n{}\n", edit(1), edit(2), edit(3))).unwrap();
    let out = s.check("tasklist-guard", &stop(&s, &tr), &[]);
    assert!(out.contains("2 tasks are marked in progress with no active agent"), "two tasks in progress in the store, all done in the transcript: {out}");
}
