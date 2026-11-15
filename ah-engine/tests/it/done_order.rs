//! Completed-task orders (GH #762): a completed task left in the session list is ordered deleted (PostToolUse on completion, then
//! UserPromptSubmit past guards.doneOrderAfterMin on the done_order.steps_min schedule, and at Stop only with handover.taskListEnforce =
//! block). Each test runs the real check in a scratch HOME with a task store and a done-order record whose ages it seeds.
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

    /// The `advisory` counters of `ah-engine status --json` in the scratch state directory (no daemon: read from the counter journal).
    fn advisory_counters(&self) -> Value {
        let plugin = Path::new(env!("CARGO_MANIFEST_DIR")).join("../plugins/anti-hall");
        let o = Command::new(env!("CARGO_BIN_EXE_ah-engine"))
            .args(["status", "--json"])
            .env_clear()
            .env("PATH", std::env::var("PATH").unwrap_or_default())
            .env("HOME", self.home())
            .env("AH_ENGINE_DIR", self.dir.join("state"))
            .env("AH_ENGINE_NOSPAWN", "1")
            .env("AH_ENGINE_PLUGIN_ROOT", &plugin)
            .env("CLAUDE_PLUGIN_ROOT", &plugin)
            .env("ANTIHALL_INGEST_DRY_RUN", "1")
            .current_dir(&self.dir)
            .output()
            .unwrap();
        let v: Value = serde_json::from_slice(&o.stdout).unwrap_or_else(|e| panic!("status --json: {e}: {}", String::from_utf8_lossy(&o.stdout)));
        v["advisory"].clone()
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        ah_engine::discard::harmless(std::fs::remove_dir_all(&self.dir));
    }
}

fn now_ms() -> u128 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis()
}

const MIN: u128 = 60_000;

impl Scratch {
    fn record_path(&self) -> PathBuf {
        self.home().join(format!(".anti-hall/done-orders/done-{SID}.json"))
    }

    /// Seed the completed-task record: task `id` first seen done `age_min` minutes ago, ordered `count` times, last `last_min` minutes ago.
    fn seed(&self, id: &str, age_min: u128, count: u32, last_min: u128) {
        let now = now_ms();
        let rec = json!({"ids": {id: {"first": (now - age_min * MIN) as u64, "count": count, "lastAt": (now - last_min * MIN) as u64}}});
        std::fs::create_dir_all(self.record_path().parent().unwrap()).unwrap();
        std::fs::write(self.record_path(), rec.to_string()).unwrap();
    }

    fn enforce_block(&self) {
        std::fs::write(self.home().join(".anti-hall/settings.json"), r#"{"handover":{"taskListEnforce":"block"}}"#).unwrap();
    }

    fn prompt(&self, tr: &Path) -> String {
        let p = json!({"hook_event_name": "UserPromptSubmit", "session_id": SID, "cwd": self.dir.join("proj"), "transcript_path": tr, "prompt": "continue"});
        self.check("task-tracker", &p, &[])
    }

    fn task_update(&self, tr: &Path, status: &str) -> String {
        let p = json!({"hook_event_name": "PostToolUse", "tool_name": "TaskUpdate", "session_id": SID, "cwd": self.dir.join("proj"), "transcript_path": tr, "tool_input": {"taskId": "1", "status": status}});
        self.check("tasklist-hygiene", &p, &[])
    }
}

fn stop(s: &Scratch, tr: &Path) -> Value {
    json!({"hook_event_name": "Stop", "session_id": SID, "cwd": s.dir.join("proj"), "transcript_path": tr})
}

const ORDER: &str = "Do now: 1 completed task(s) still listed: TaskUpdate status=deleted #1";

#[test]
fn a_completed_task_older_than_the_age_is_ordered_deleted_at_the_prompt() {
    let s = Scratch::new("do-old");
    s.store(&["completed", "pending"]);
    let tr = s.transcript("completed");
    s.seed("1", 11, 0, 0);
    let out = s.prompt(&tr);
    assert!(out.contains(ORDER), "a task done for 11 min (age 10) gets the order: {out}");
}

#[test]
fn a_completed_task_inside_the_age_is_not_ordered_at_the_prompt() {
    let s = Scratch::new("do-young");
    s.store(&["completed", "pending"]);
    let tr = s.transcript("completed");
    s.seed("1", 2, 0, 0);
    let out = s.prompt(&tr);
    assert!(!out.contains("Do now"), "a task done 2 min ago is not ordered yet: {out}");
}

#[test]
fn the_completion_line_is_an_order_not_a_tip() {
    let s = Scratch::new("do-fresh");
    s.store(&["completed", "pending"]);
    let tr = s.transcript("completed");
    let out = s.task_update(&tr, "completed");
    assert!(out.contains("Do now: task #1 is done"), "the PostToolUse line is the order form: {out}");
    assert!(out.contains("TaskUpdate status=deleted #1"), "it names the delete: {out}");
    assert!(!out.contains("💡"), "no tip icon: {out}");
}

#[test]
fn after_the_delete_there_is_no_further_order_and_it_counts_as_followed() {
    let s = Scratch::new("do-followed");
    std::fs::create_dir_all(s.dir.join("state")).unwrap();
    s.store(&["completed", "pending"]);
    let tr = s.transcript("completed");
    s.seed("1", 30, 1, 0);
    let out = s.task_update(&tr, "deleted");
    assert!(!out.contains("Do now"), "the delete itself is not ordered again: {out}");
    std::fs::remove_file(s.home().join(".claude/tasks/session-0a1b2c3d/1.json")).unwrap();
    let out = s.prompt(&tr);
    assert!(!out.contains("Do now"), "the task is gone: no order at the next prompt: {out}");
    let rec = std::fs::read_to_string(s.record_path()).unwrap();
    assert!(!rec.contains("\"1\""), "the record dropped the deleted task: {rec}");
    let adv = s.advisory_counters();
    assert_eq!(adv["tasklist_hygiene"]["followed"], 1, "an ordered task that was deleted counts as followed: {adv}");
}

#[test]
fn the_order_repeats_only_on_the_schedule() {
    let s = Scratch::new("do-interval");
    std::fs::create_dir_all(s.dir.join("state")).unwrap();
    s.store(&["completed", "pending"]);
    let tr = s.transcript("completed");
    s.seed("1", 40, 1, 1); // ordered once, 1 min ago; the next step is 10 min
    let out = s.prompt(&tr);
    assert!(!out.contains("Do now"), "inside the interval: no order: {out}");
    s.seed("1", 40, 1, 11);
    let out = s.prompt(&tr);
    assert!(out.contains(ORDER), "past the interval: the order repeats: {out}");
    let again = s.prompt(&tr);
    assert!(!again.contains("Do now"), "and not again on the very next prompt: {again}");
    s.seed("1", 400, 6, 600); // at the cap
    let capped = s.prompt(&tr);
    assert!(!capped.contains("Do now"), "after done_order.max_orders the task is left alone: {capped}");
    let adv = s.advisory_counters();
    assert_eq!(adv["tasklist_hygiene"]["order_emitted"], 1, "one order was emitted: {adv}");
    assert!(adv["tasklist_hygiene"]["completed_lingering"].as_u64().unwrap_or(0) >= 1, "the lingering task is counted: {adv}");
}

#[test]
fn at_stop_the_order_blocks_only_with_the_enforce_switch_on_block() {
    let s = Scratch::new("do-stop");
    s.store(&["completed"]);
    let tr = s.transcript("completed");
    s.seed("1", 11, 0, 0);
    let out = s.check("task-guard", &stop(&s, &tr), &[]);
    assert!(!out.contains("Do now"), "default enforce (advisory): the Stop is not blocked for a lingering task: {out}");
    s.enforce_block();
    let out = s.check("task-guard", &stop(&s, &tr), &[]);
    assert!(out.contains("\"decision\":\"block\"") && out.contains(ORDER), "enforce = block: the Stop is blocked with the order: {out}");
    let again = s.check("task-guard", &stop(&s, &tr), &[]);
    assert!(!again.contains("Do now"), "the next Stop inside the interval is not blocked again: {again}");
}

impl Scratch {
    /// A named shared list (`CLAUDE_CODE_TASK_LIST_ID`): task `n` of `statuses`, owned by `owner` when it is not empty.
    fn named_list(&self, list: &str, tasks: &[(&str, &str)]) {
        let dir = self.home().join(".claude/tasks").join(list);
        std::fs::create_dir_all(&dir).unwrap();
        for (i, (st, owner)) in tasks.iter().enumerate() {
            let n = i + 1;
            let rec = json!({"id": n.to_string(), "subject": format!("shared task {n}"), "description": "d", "status": st, "owner": owner, "blocks": [], "blockedBy": []});
            std::fs::write(dir.join(format!("{n}.json")), rec.to_string()).unwrap();
        }
    }

    fn task_update_env(&self, tr: &Path, env: &[(&str, &str)]) -> String {
        let p = json!({"hook_event_name": "PostToolUse", "tool_name": "TaskUpdate", "session_id": SID, "cwd": self.dir.join("proj"), "transcript_path": tr, "tool_input": {"taskId": "1", "status": "completed"}});
        self.check("tasklist-hygiene", &p, env)
    }

    fn prompt_env(&self, tr: &Path, env: &[(&str, &str)]) -> String {
        let p = json!({"hook_event_name": "UserPromptSubmit", "session_id": SID, "cwd": self.dir.join("proj"), "transcript_path": tr, "prompt": "continue"});
        self.check("task-tracker", &p, env)
    }
}

#[test]
fn a_private_completed_id_never_orders_the_delete_of_a_teammates_pending_task_in_the_shared_list() {
    let s = Scratch::new("do-shared");
    s.store(&["completed"]); // the session's own session-<8> list: a stale completed #1
    s.named_list("team-a", &[("pending", "mate")]); // the list the harness writes: a teammate's pending #1
    let tr = s.transcript("completed");
    s.seed("1", 30, 0, 0);
    let out = s.prompt_env(&tr, &[("CLAUDE_CODE_TASK_LIST_ID", "team-a")]);
    assert!(!out.contains("Do now"), "#1 of the shared list is pending and another owner's: no delete order: {out}");
}

#[test]
fn in_a_shared_list_a_completed_task_another_owner_holds_is_not_ordered_but_an_unowned_one_is() {
    let s = Scratch::new("do-shared-owner");
    s.named_list("team-a", &[("completed", "mate"), ("completed", "")]);
    let tr = s.transcript("completed");
    let now = now_ms();
    let rec = json!({"ids": {"team-a/1": {"first": (now - 30 * MIN) as u64, "count": 0, "lastAt": 0}, "team-a/2": {"first": (now - 30 * MIN) as u64, "count": 0, "lastAt": 0}}});
    std::fs::create_dir_all(s.record_path().parent().unwrap()).unwrap();
    std::fs::write(s.record_path(), rec.to_string()).unwrap();
    let out = s.prompt_env(&tr, &[("CLAUDE_CODE_TASK_LIST_ID", "team-a")]);
    assert!(out.contains("1 completed task(s) still listed: TaskUpdate status=deleted #2"), "only the unowned #2 is ordered: {out}");
    assert!(!out.contains("#1"), "the teammate's #1 is not named: {out}");
}

#[test]
fn a_named_list_id_with_no_store_directory_is_ambiguous_and_orders_nothing() {
    let s = Scratch::new("do-ambiguous");
    s.store(&["completed"]);
    let tr = s.transcript("completed");
    s.seed("1", 30, 0, 0);
    let out = s.prompt_env(&tr, &[("CLAUDE_CODE_TASK_LIST_ID", "no-such-list")]);
    assert!(!out.contains("Do now"), "which list the harness writes is unknown: no order: {out}");
}

#[test]
fn the_completion_line_in_a_shared_list_skips_a_task_another_owner_holds() {
    let s = Scratch::new("do-fresh-foreign");
    s.named_list("team-a", &[("completed", "mate")]);
    let tr = s.transcript("completed");
    let out = s.task_update_env(&tr, &[("CLAUDE_CODE_TASK_LIST_ID", "team-a")]);
    assert!(!out.contains("status=deleted"), "a teammate's task is never ordered deleted at completion: {out}");
    assert!(!s.record_path().exists(), "no record is started for it");
}

#[test]
fn the_completion_line_in_a_shared_list_orders_an_unowned_task() {
    let s = Scratch::new("do-fresh-unowned");
    s.named_list("team-a", &[("completed", "")]);
    let tr = s.transcript("completed");
    let out = s.task_update_env(&tr, &[("CLAUDE_CODE_TASK_LIST_ID", "team-a")]);
    assert!(out.contains("TaskUpdate status=deleted #1"), "an unowned task of the shared list is ordered: {out}");
}

#[test]
fn the_completion_line_with_an_ambiguous_list_orders_nothing() {
    let s = Scratch::new("do-fresh-ambiguous");
    s.store(&["completed"]);
    let tr = s.transcript("completed");
    let out = s.task_update_env(&tr, &[("CLAUDE_CODE_TASK_LIST_ID", "no-such-list")]);
    assert!(!out.contains("status=deleted"), "the named list has no directory: which list is written is unknown: {out}");
}

#[test]
fn an_unreadable_file_in_the_named_list_orders_nothing_and_never_falls_back_to_the_transcript() {
    let s = Scratch::new("do-unreadable");
    s.named_list("team-a", &[]);
    std::fs::write(s.home().join(".claude/tasks/team-a/1.json"), "{not json").unwrap();
    let tr = s.transcript("completed"); // the transcript alone would name #1 as completed and unowned
    let now = now_ms();
    let rec = json!({"ids": {"team-a/1": {"first": (now - 30 * MIN) as u64, "count": 0, "lastAt": 0}}});
    std::fs::create_dir_all(s.record_path().parent().unwrap()).unwrap();
    std::fs::write(s.record_path(), rec.to_string()).unwrap();
    let out = s.prompt_env(&tr, &[("CLAUDE_CODE_TASK_LIST_ID", "team-a")]);
    assert!(!out.contains("Do now"), "an unreadable list file: the list is unknown, no order from the transcript: {out}");
}

#[test]
fn the_record_is_bounded_to_max_entries() {
    let s = Scratch::new("do-bound");
    std::fs::create_dir_all(s.dir.join("state")).unwrap();
    let n = 230usize;
    let statuses = vec!["completed"; n];
    s.store(&statuses);
    let tr = s.transcript("completed");
    let now = now_ms();
    let ids: serde_json::Map<String, Value> =
        (1..=n).map(|i| (i.to_string(), json!({"first": (now - 400 * MIN) as u64, "count": 6, "lastAt": (now - 300 * MIN) as u64 + i as u64}))).collect();
    std::fs::create_dir_all(s.record_path().parent().unwrap()).unwrap();
    std::fs::write(s.record_path(), json!({"ids": ids}).to_string()).unwrap();
    s.task_update(&tr, "completed"); // a write: #1 is recorded fresh
    let rec: Value = serde_json::from_str(&std::fs::read_to_string(s.record_path()).unwrap()).unwrap();
    assert!(rec["ids"].as_object().unwrap().len() <= 200, "the record is capped at done_order.max_entries: {}", rec["ids"].as_object().unwrap().len());
}
