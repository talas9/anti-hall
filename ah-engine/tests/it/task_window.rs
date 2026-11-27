//! The task window (GH #982): at most guards.taskWindowSize active tasks plus one backlog line, the full list in a per-session store,
//! and the list rules enforced when a task is created or changed (tasklist-hygiene, PreToolUse/PostToolUse on TaskCreate/TaskUpdate).
//! Each test runs the real check in a scratch HOME and project, with a harness task store as the live list.
#![allow(clippy::unwrap_used, clippy::expect_used)] // a test crate: a panic is the failure report, and E2 exempts tests

use serde_json::{Value, json};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

const SID: &str = "0a1b2c3d-1111-2222-3333-444455556666";
const OLD: &str = "9f8e7d6c-aaaa-bbbb-cccc-ddddeeeeffff";

struct Scratch {
    dir: PathBuf,
}

impl Scratch {
    fn new(tag: &str) -> Scratch {
        let dir = PathBuf::from(env!("CARGO_TARGET_TMPDIR")).join(format!("tw-{tag}-{}", std::process::id()));
        ah_engine::discard::harmless(std::fs::remove_dir_all(&dir));
        std::fs::create_dir_all(dir.join("home/.anti-hall")).unwrap();
        std::fs::create_dir_all(dir.join("proj/.git")).unwrap();
        let s = Scratch { dir };
        std::fs::write(s.transcript(), format!("{}\n", json!({"type": "user", "message": {"role": "user", "content": "go"}}))).unwrap();
        s
    }

    fn home(&self) -> PathBuf {
        self.dir.join("home")
    }

    fn proj(&self) -> PathBuf {
        self.dir.join("proj")
    }

    fn transcript(&self) -> PathBuf {
        self.dir.join("t.jsonl")
    }

    /// The live list: one harness task file per (id, subject, status, owner).
    fn live(&self, tasks: &[(&str, &str, &str, &str)]) {
        let store = self.home().join(".claude/tasks/session-0a1b2c3d");
        std::fs::create_dir_all(&store).unwrap();
        for (id, subject, status, owner) in tasks {
            let rec = json!({"id": id, "subject": subject, "description": "d", "status": status, "owner": owner, "blocks": [], "blockedBy": []});
            std::fs::write(store.join(format!("{id}.json")), rec.to_string()).unwrap();
        }
    }

    fn store_path(&self, sid: &str) -> PathBuf {
        self.proj().join(format!(".anti-hall/tasks/store/{sid}.json"))
    }

    fn store(&self) -> Value {
        serde_json::from_str(&std::fs::read_to_string(self.store_path(SID)).unwrap()).unwrap()
    }

    /// A store file for session `sid` with (n, p, title, state) items.
    fn seed_store(&self, sid: &str, items: &[(u32, u32, &str, &str)]) {
        let tasks: Vec<Value> = items.iter().map(|(n, p, t, st)| json!({"n": n, "p": p, "title": t, "state": st, "id": "", "owner": "", "blockedOn": "", "at": 1})).collect();
        let v = json!({"format": 1, "session": sid, "from": "", "resumed": false, "tasks": tasks});
        std::fs::create_dir_all(self.store_path(sid).parent().unwrap()).unwrap();
        std::fs::write(self.store_path(sid), v.to_string()).unwrap();
    }

    /// The SessionStart resume marker of this session, pointing at the predecessor's handover.
    fn resumed_from(&self, old: &str) -> PathBuf {
        let dir = self.proj().join(format!(".anti-hall/handovers/2026-11-27/{old}"));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("HANDOVER.md");
        std::fs::write(&file, "# Handover\n").unwrap();
        let marker = json!({"handoverFile": file, "ts": 1});
        std::fs::write(self.home().join(format!(".anti-hall/handover-resume-state-{SID}.json")), marker.to_string()).unwrap();
        dir
    }

    fn run(&self, payload: &Value, env: &[(&str, &str)]) -> String {
        let plugin = Path::new(env!("CARGO_MANIFEST_DIR")).join("../plugins/anti-hall");
        let mut c = Command::new(env!("CARGO_BIN_EXE_ah-engine"));
        c.args(["check", "tasklist-hygiene"])
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

    fn payload(&self, event: &str, tool: &str, input: Value) -> Value {
        json!({"hook_event_name": event, "tool_name": tool, "session_id": SID, "cwd": self.proj(), "transcript_path": self.transcript(), "tool_input": input})
    }

    fn create(&self, subject: &str) -> String {
        self.run(&self.payload("PreToolUse", "TaskCreate", json!({"subject": subject, "description": "d"})), &[])
    }

    fn update(&self, input: Value) -> String {
        self.run(&self.payload("PreToolUse", "TaskUpdate", input), &[])
    }

    fn post_update(&self, input: Value) -> String {
        self.run(&self.payload("PostToolUse", "TaskUpdate", input), &[])
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        ah_engine::discard::harmless(std::fs::remove_dir_all(&self.dir));
    }
}

fn blocked(out: &str) -> bool {
    out.contains("\"decision\":\"block\"")
}

fn item(store: &Value, n: u64) -> Value {
    store["tasks"].as_array().unwrap().iter().find(|t| t["n"] == n).cloned().unwrap_or(Value::Null)
}

fn five_live(s: &Scratch) {
    s.live(&[
        ("1", "T-1 [P0] Ship the release", "in_progress", "main"),
        ("2", "T-2 [P0] Fix the deploy", "pending", ""),
        ("3", "T-3 [P1] Review the plan", "pending", ""),
        ("4", "T-4 [P1] Docs sweep", "pending", ""),
        ("5", "T-5 [P2] CPU profile", "pending", ""),
    ]);
}

/// The incident: a fresh session resumed from a handover rebuilt its list from memory (unformatted, unsorted, the saved window
/// missing). Both the unformatted create and a formatted one that skips the saved window are refused.
#[test]
fn a_fresh_rebuild_that_ignores_the_saved_store_is_blocked() {
    let s = Scratch::new("incident");
    s.resumed_from(OLD);
    s.seed_store(OLD, &[(3, 0, "Owner ask: release notes", "window"), (7, 1, "Wire the reaper", "window"), (9, 2, "Old idea", "backlog")]);
    let out = s.create("Fix the login bug");
    assert!(blocked(&out), "unformatted create refused: {out}");
    assert!(out.contains("T-10 [P<0-3>] Fix the login bug"), "names the expected form with the next free number: {out}");
    let out = s.create("T-10 [P1] Fix the login bug");
    assert!(blocked(&out) && out.contains("T-3 [P0] Owner ask: release notes"), "drift: load the saved window first: {out}");
    let st = s.store();
    assert_eq!(st["from"], OLD, "the predecessor's store was adopted");
    assert_eq!(item(&st, 10)["state"], "backlog", "the new request is kept, not lost");
    assert!(!blocked(&s.create("T-3 [P0] Owner ask: release notes")), "loading a saved window task passes");
}

/// The incident as it really was: the predecessor left only a markdown snapshot in its state file. Creates are refused until
/// tasks-reconcile imports it.
#[test]
fn a_resumed_markdown_snapshot_blocks_creates_until_reconciled() {
    let s = Scratch::new("import");
    let dir = s.resumed_from(OLD);
    std::fs::write(dir.join("state.md"), "# State\n\n## Task list snapshot\n| id | subject | status | priority | blocked-by |\n|---|---|---|---|---|\n| 1 | Ship it | pending | P0 | |\n\n## Commands\n").unwrap();
    let out = s.create("T-1 [P0] Ship it");
    assert!(blocked(&out) && out.contains("tasks-reconcile"), "import ordered: {out}");
    assert!(!s.store_path(SID).exists(), "nothing written before the import");
    // once the session has its own store (the reconcile wrote it), the snapshot no longer blocks
    s.seed_store(SID, &[(1, 0, "Ship it", "window")]);
    assert!(!blocked(&s.create("T-1 [P0] Ship it")), "after the import the saved task loads");
}

#[test]
fn a_full_window_saves_the_task_to_the_backlog_and_blocks() {
    let s = Scratch::new("full");
    five_live(&s);
    let out = s.create("T-20 [P2] Later thing");
    assert!(blocked(&out) && out.contains("window full (5/5)"), "{out}");
    assert_eq!(item(&s.store(), 20)["state"], "backlog");
    // a retried identical create saves nothing twice
    assert!(blocked(&s.create("T-20 [P2] Later thing")));
    let n = s.store()["tasks"].as_array().unwrap().iter().filter(|t| t["n"] == 20).count();
    assert_eq!(n, 1, "idempotent save");
    // the backlog line is not a window task: it may always be created
    assert!(!blocked(&s.create("T-∞ Backlog: 1 more (1 P2) · next: T-20 [P2] Later thing · run /anti-hall:tasks-reconcile")));
}

#[test]
fn parallel_creates_cannot_overfill_the_window() {
    let s = Scratch::new("race");
    let outs: Vec<String> = std::thread::scope(|sc| {
        let hs: Vec<_> = (1..=7).map(|n| { let s = &s; sc.spawn(move || s.create(&format!("T-{n} [P1] Task {n}"))) }).collect();
        hs.into_iter().map(|h| h.join().unwrap()).collect()
    });
    let refused = outs.iter().filter(|o| blocked(o)).count();
    assert_eq!(refused, 2, "5 slots, 7 parallel creates: {outs:?}");
    let reserved = s.store()["tasks"].as_array().unwrap().iter().filter(|t| t["state"] == "window").count();
    assert_eq!(reserved, 5);
}

#[test]
fn a_taken_number_is_refused_with_the_next_free_one() {
    let s = Scratch::new("dup");
    s.live(&[("1", "T-3 [P1] Review the plan", "pending", "")]);
    let out = s.create("T-3 [P1] Something else");
    assert!(blocked(&out) && out.contains("T-4 [P1] Something else"), "{out}");
}

#[test]
fn a_backlog_task_of_higher_priority_is_pulled_first() {
    let s = Scratch::new("order");
    s.live(&[("1", "T-1 [P1] One", "pending", "")]);
    s.seed_store(SID, &[(1, 1, "One", "window"), (7, 0, "Urgent ask", "backlog")]);
    let out = s.create("T-30 [P2] Nice to have");
    assert!(blocked(&out) && out.contains("T-7 [P0] Urgent ask"), "{out}");
    assert!(!blocked(&s.create("T-7 [P0] Urgent ask")));
}

#[test]
fn an_in_progress_task_needs_an_owner() {
    let s = Scratch::new("owner");
    s.live(&[("1", "T-1 [P1] One", "pending", "")]);
    let out = s.update(json!({"taskId": "1", "status": "in_progress"}));
    assert!(blocked(&out) && out.contains("owner="), "{out}");
    assert!(!blocked(&s.update(json!({"taskId": "1", "status": "in_progress", "owner": "lane-a"}))));
}

#[test]
fn a_blocked_task_is_saved_to_the_backlog_and_ordered_out_of_the_window() {
    let s = Scratch::new("blocked");
    s.live(&[("1", "T-1 [P1] One", "pending", ""), ("2", "T-2 [P0] Two", "pending", "")]);
    let out = s.update(json!({"taskId": "1", "metadata": {"blockedOn": "owner decision on the API"}}));
    assert!(blocked(&out) && out.contains("taskId=1 status=deleted"), "{out}");
    let it = item(&s.store(), 1);
    assert_eq!(it["state"], "blocked");
    assert_eq!(it["blockedOn"], "owner decision on the API");
    // the delete it orders is never refused, and keeps the saved task in the backlog
    assert!(!blocked(&s.update(json!({"taskId": "1", "status": "deleted"}))));
    s.post_update(json!({"taskId": "1", "status": "deleted"}));
    assert_eq!(item(&s.store(), 1)["state"], "blocked");
}

/// An existing list (legacy subjects, over the window) never deadlocks: finishing, deleting and status changes pass; only creates
/// are refused, with the order to reconcile.
#[test]
fn a_legacy_list_over_the_window_never_deadlocks() {
    let s = Scratch::new("legacy");
    let tasks: Vec<(String, String)> = (1..=15).map(|i| (i.to_string(), format!("Legacy task number {i}"))).collect();
    let rows: Vec<(&str, &str, &str, &str)> = tasks.iter().map(|(i, t)| (i.as_str(), t.as_str(), "pending", "")).collect();
    s.live(&rows);
    assert!(!blocked(&s.update(json!({"taskId": "1", "status": "completed"}))));
    assert!(!blocked(&s.update(json!({"taskId": "2", "status": "deleted"}))));
    assert!(!blocked(&s.update(json!({"taskId": "3", "status": "pending"}))));
    let out = s.create("T-16 [P1] New ask");
    assert!(blocked(&out) && out.contains("tasks-reconcile"), "{out}");
}

#[test]
fn a_freed_slot_with_a_waiting_backlog_orders_reconcile() {
    let s = Scratch::new("slot");
    s.live(&[("1", "T-1 [P1] One", "pending", "")]);
    s.seed_store(SID, &[(9, 0, "Next up", "backlog")]);
    s.post_update(json!({"taskId": "1", "status": "pending"})); // syncs T-1 into the store with its id
    std::fs::remove_file(s.home().join(".claude/tasks/session-0a1b2c3d/1.json")).unwrap();
    let out = s.post_update(json!({"taskId": "1", "status": "deleted"}));
    assert!(out.contains("tasks-reconcile") && out.contains("T-9 [P0] Next up"), "{out}");
    assert_eq!(item(&s.store(), 1)["state"], "dropped", "kept, never deleted");
}

#[test]
fn the_switch_off_restores_the_old_answers() {
    let s = Scratch::new("off");
    let out = s.run(&s.payload("PreToolUse", "TaskCreate", json!({"subject": "anything goes"})), &[("ANTIHALL_TASK_WINDOW", "0")]);
    assert!(!blocked(&out), "{out}");
}

/// The skills state the rules exactly as the config does (both ports), so the guard and the skills cannot drift.
#[test]
fn the_skills_hold_the_configured_rules_text() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../plugins/anti-hall");
    let cfg: toml::Value = toml::from_str(&std::fs::read_to_string(root.join("engine/defaults/task_guards.toml")).unwrap()).unwrap();
    let rules = cfg["task_window"]["skill_rules"]["value"].as_str().unwrap();
    for f in ["skills/tasks-reconcile/SKILL.md", "skills/handover/SKILL.md", "codex/skills/anti-hall-tasks-reconcile/SKILL.md", "codex/skills/anti-hall-handover/SKILL.md"] {
        let body = std::fs::read_to_string(root.join(f)).unwrap_or_else(|e| panic!("{f}: {e}"));
        assert!(body.contains(rules), "{f} must hold task_window.skill_rules verbatim");
    }
}
