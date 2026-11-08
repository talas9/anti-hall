//! The strict task-list rules (GH #682) through the real dispatcher (`ah-engine hook --event <Event> --host claude`): the engine writes
//! a finished task's Cause/Fix/Verified ledger entry itself, and a Stop of the session that owns the list is held to four rules, each with
//! its own tier (`guards.taskStrict*`, block by default), in ONE block. Scratch HOME only; a hook call's daemon is reaped by `common::reap`.
#![allow(clippy::unwrap_used, clippy::expect_used)] // a test crate: a panic is the failure report, and E2 exempts tests

use crate::common;

use serde_json::{Value, json};
use std::io::Write;
use std::path::PathBuf;
use std::process::{Command, Stdio};

/// The strict message's check name (pair_rule.strict_guard_name).
const NAME: &str = "task list: ";

struct World {
    dir: PathBuf,
    env: std::cell::RefCell<Vec<(String, String)>>,
}

impl World {
    fn new(name: &str) -> World {
        let dir = std::env::temp_dir().join(format!("ah-tstrict-{name}-{}", std::process::id()));
        ah_engine::discard::harmless(std::fs::remove_dir_all(&dir));
        std::fs::create_dir_all(dir.join("home/.anti-hall")).unwrap();
        std::fs::create_dir_all(dir.join("proj/.git")).unwrap();
        World { dir, env: std::cell::RefCell::new(Vec::new()) }
    }

    fn path(&self, rel: &str) -> PathBuf {
        self.dir.join(rel)
    }

    fn set(&self, k: &str, v: &str) {
        self.env.borrow_mut().push((k.into(), v.into()));
    }

    fn hook(&self, event: &str, tool: &str, payload: &Value) -> (i32, String, String) {
        let p = json!({"hook_event_name": event, "tool_name": tool});
        let ids: Vec<String> =
            ah_engine::dispatch::table::select("claude", event, &p, if tool.is_empty() { None } else { Some(tool) }).into_iter().map(|e| e.id).collect();
        let map: serde_json::Map<String, Value> = ids.iter().map(|id| (id.clone(), "true".into())).collect();
        let map_path = self.path("map.json");
        std::fs::write(&map_path, json!({ event: map }).to_string()).unwrap();
        let mut c = Command::new(env!("CARGO_BIN_EXE_ah-engine"));
        c.args(["hook", "--event", event, "--host", "claude"]);
        if !tool.is_empty() {
            c.args(["--tool", tool]);
        }
        c.arg("--fallback-map")
            .arg(&map_path)
            .env_clear()
            .env("PATH", std::env::var("PATH").unwrap_or_default())
            .env("HOME", self.path("home"))
            .env("AH_ENGINE_DIR", self.path("state"))
            .env("AH_ENGINE_VERSION", "tstrict-e2e")
            .env("AH_ENGINE_DISPATCH_IN_PROCESS", "1")
            .env("CLAUDE_PLUGIN_ROOT", &self.dir)
            .env("ANTIHALL_PAIR_RULE", "1")
            .env("ANTIHALL_MAX_CONCURRENT_AGENTS", "0")
            .current_dir(&self.dir)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        for (k, v) in self.env.borrow().iter() {
            c.env(k, v);
        }
        let mut ch = c.spawn().unwrap();
        ch.stdin.take().unwrap().write_all(payload.to_string().as_bytes()).unwrap();
        let o = ch.wait_with_output().unwrap();
        (o.status.code().unwrap_or(-1), String::from_utf8_lossy(&o.stdout).into_owned(), String::from_utf8_lossy(&o.stderr).into_owned())
    }

    /// The agent tracker's proof that the transcript's agents `descriptions` are live (as r_pair_e2e's `track`).
    fn track(&self, descriptions: &[&str]) {
        let home = self.path("home");
        let mut st = ah_engine::agents::State::default();
        for (i, d) in descriptions.iter().enumerate() {
            let id = format!("a{:015x}", i + 1);
            let rel = format!(".claude/projects/p/s1/subagents/agent-{id}.jsonl");
            std::fs::create_dir_all(home.join(&rel).parent().unwrap()).unwrap();
            std::fs::write(home.join(&rel), format!("{}\n", json!({"type": "assistant", "message": {"content": [{"type": "text", "text": "working"}]}})))
                .unwrap();
            let a = ah_engine::agents::Agent {
                id: id.clone(),
                kind: "subagent".into(),
                parent: "s1".into(),
                name: (*d).into(),
                cwd: home.to_string_lossy().into_owned(),
                path: home.join(rel).to_string_lossy().into_owned(),
                ..Default::default()
            };
            st.agents.insert(id, a);
        }
        std::fs::create_dir_all(home.join(".anti-hall/agent-tracker")).unwrap();
        std::fs::write(home.join(".anti-hall/agent-tracker/state.json"), serde_json::to_string(&st).unwrap()).unwrap();
    }

    fn stop(&self, t: &str, extra: Value) -> (i32, String, String) {
        std::fs::write(self.path("t.jsonl"), t).unwrap();
        let mut p = json!({"hook_event_name": "Stop", "session_id": "s1", "cwd": self.path("proj"), "transcript_path": self.path("t.jsonl")});
        for (k, v) in extra.as_object().cloned().unwrap_or_default() {
            p[k] = v;
        }
        self.hook("Stop", "", &p)
    }

    fn post_update(&self, t: &str, input: Value) -> (i32, String, String) {
        std::fs::write(self.path("t.jsonl"), t).unwrap();
        let p = json!({"hook_event_name": "PostToolUse", "session_id": "s1", "cwd": self.path("proj"), "transcript_path": self.path("t.jsonl"),
            "tool_name": "TaskUpdate", "tool_input": input, "tool_response": {"success": true}});
        self.hook("PostToolUse", "TaskUpdate", &p)
    }

    /// Every ledger file of the session, joined.
    fn ledger(&self) -> String {
        let mut out = String::new();
        for d in std::fs::read_dir(self.path("proj/.anti-hall/history")).into_iter().flatten().flatten() {
            if let Ok(t) = std::fs::read_to_string(d.path().join("s1.md")) {
                out.push_str(&t);
            }
        }
        out
    }
}

impl Drop for World {
    fn drop(&mut self) {
        common::reap(&self.path("state"), || {});
        ah_engine::discard::harmless(std::fs::remove_dir_all(&self.dir));
    }
}

/// One task: id, status, owner, metadata of its create.
struct T {
    id: u32,
    status: &'static str,
    owner: Option<&'static str>,
    meta: Value,
}

fn task(id: u32, status: &'static str, owner: Option<&'static str>) -> T {
    T { id, status, owner, meta: Value::Null }
}

fn transcript(tasks: &[T], agents: &[(&str, Option<&str>)]) -> String {
    let ts = "2999-01-01T00:00:00.000Z";
    let mut out = String::new();
    for t in tasks {
        let n = t.id;
        let mut cin = json!({"subject": format!("task {n}"), "description": format!("did thing {n}")});
        if !t.meta.is_null() {
            cin["metadata"] = t.meta.clone();
        }
        let create = json!({"type": "assistant", "message": {"id": format!("m{n}"), "role": "assistant", "content": [{"type": "tool_use", "id": format!("c{n}"), "name": "TaskCreate", "input": cin}]}, "timestamp": ts});
        let result = json!({"type": "user", "message": {"role": "user", "content": [{"type": "tool_result", "tool_use_id": format!("c{n}"), "content": format!("Task #{n} created successfully: task {n}")}]}, "timestamp": ts});
        let mut input = json!({"taskId": n.to_string(), "status": t.status});
        if let Some(o) = t.owner {
            input["owner"] = json!(o);
        }
        let update = json!({"type": "assistant", "message": {"id": format!("u{n}"), "role": "assistant", "content": [{"type": "tool_use", "id": format!("t{n}"), "name": "TaskUpdate", "input": input}]}, "timestamp": ts});
        out.push_str(&format!("{create}\n{result}\n{update}\n"));
    }
    for (i, (description, name)) in agents.iter().enumerate() {
        let agent = format!("a{:015x}", i + 1);
        let mut input = json!({"description": description, "prompt": "p", "run_in_background": true});
        if let Some(n) = name {
            input["name"] = json!(n);
        }
        let launch = json!({"type": "assistant", "message": {"role": "assistant", "content": [{"type": "tool_use", "id": format!("toolu_ag{i}"), "name": "Agent", "input": input}]}, "timestamp": ts});
        let text = format!(
            "Async agent launched successfully. (internal metadata)\nagentId: {agent} (internal ID)\nThe agent is working in the background.\noutput_file: /tmp/x/{agent}.output\n"
        );
        let res = json!({"type": "user", "message": {"role": "user", "content": [{"tool_use_id": format!("toolu_ag{i}"), "type": "tool_result", "content": [{"type": "text", "text": text}]}]}, "timestamp": ts});
        out.push_str(&format!("{launch}\n{res}\n"));
    }
    out
}

/// The Stop was blocked by the strict rules.
fn blocked(o: &(i32, String, String)) -> bool {
    let v: Value = serde_json::from_str(o.1.trim()).unwrap_or(Value::Null);
    v["decision"] == "block" && v["reason"].as_str().is_some_and(|r| r.contains(NAME))
}

fn waits() -> Value {
    json!({"blockedOn": "owner review"})
}

// ---- rule `ledger` and the auto-ledger --------------------------------------------------------------------------------------------------

#[test]
fn auto_ledger_writes_the_entry_on_completed() {
    let w = World::new("auto-post");
    let t = transcript(&[task(3, "in_progress", Some("main"))], &[]);
    let o = w.post_update(&t, json!({"taskId": "3", "status": "completed", "metadata": {"verified": "cargo test task_strict 9/9"}}));
    let l = w.ledger();
    assert!(l.contains("### Task #3: task 3"), "the engine wrote the entry: {l:?} {o:?}");
    assert!(l.contains("- Fix: did thing 3") && l.contains("- Verified: cargo test task_strict 9/9"), "{l:?}");
    assert!(o.1.contains("TaskUpdate") && o.1.contains("deleted"), "names the delete call: {o:?}");
    assert!(!o.1.contains("delegate its"), "no agent tokens asked for the entry: {o:?}");
    // a second completion of the same task writes nothing new
    w.post_update(&t, json!({"taskId": "3", "status": "completed"}));
    assert_eq!(w.ledger().matches("### Task #3:").count(), 1, "one entry per task: {}", w.ledger());
}

#[test]
fn ledger_rule_backfills_at_stop_and_blocks_only_when_it_cannot() {
    let w = World::new("ledger-stop");
    let t = transcript(&[task(4, "completed", None)], &[]);
    let o = w.stop(&t, json!({}));
    assert!(w.ledger().contains("### Task #4: task 4"), "the Stop wrote the missing entry: {o:?}");
    assert!(!o.1.contains("#4 completed, no ledger entry"), "an entry the engine wrote is not an item: {o:?}");
    let w2 = World::new("ledger-stop-off");
    w2.set("ANTIHALL_TASK_AUTO_LEDGER", "0");
    let o2 = w2.stop(&t, json!({}));
    assert!(blocked(&o2) && o2.1.contains("#4 completed, no ledger entry"), "auto-ledger off: the missing entry blocks: {o2:?}");
    assert!(o2.1.contains("Do now: ") && o2.1.contains("status: \\\"deleted\\\""), "with the exact call: {o2:?}");
}

// ---- rule `owner` ------------------------------------------------------------------------------------------------------------------------

#[test]
fn owner_rule_blocks_in_progress_without_owner() {
    let w = World::new("owner-none");
    let o = w.stop(&transcript(&[task(1, "in_progress", None)], &[]), json!({}));
    assert!(blocked(&o) && o.1.contains("#1 in_progress, no owner"), "{o:?}");
    assert!(o.1.contains("Do now: TaskUpdate({taskId: \\\"1\\\", owner: "), "the exact call: {o:?}");
}

#[test]
fn owner_rule_blocks_an_owner_that_is_no_live_agent() {
    let w = World::new("owner-dead");
    let o = w.stop(&transcript(&[task(2, "in_progress", Some("ghost-worker"))], &[]), json!({}));
    assert!(blocked(&o) && o.1.contains("#2 in_progress, owner \\\"ghost-worker\\\" not a live agent"), "{o:?}");
    // a live tracked agent of that name, and the coordinator itself, pass
    let w2 = World::new("owner-live");
    w2.track(&["port the wake"]);
    let o2 = w2.stop(&transcript(&[task(2, "in_progress", Some("wake-worker"))], &[("port the wake", Some("wake-worker"))]), json!({}));
    assert!(!o2.1.contains("not a live agent") && !o2.1.contains("no owner"), "{o2:?}");
    let o3 = w2.stop(&transcript(&[task(2, "in_progress", Some("main"))], &[]), json!({}));
    assert!(!o3.1.contains("#2 in_progress"), "the coordinator owner is the session itself: {o3:?}");
}

// ---- rule `blocked_on` -------------------------------------------------------------------------------------------------------------------

#[test]
fn blocked_on_rule_blocks_pending_without_reason() {
    let w = World::new("blocked-on");
    let o = w.stop(&transcript(&[task(5, "pending", None)], &[]), json!({}));
    assert!(blocked(&o) && o.1.contains("#5 pending, no blockedOn"), "{o:?}");
    assert!(o.1.contains("TaskUpdate({taskId: \\\"5\\\", metadata: {blockedOn: "), "the exact call: {o:?}");
    let ok = T { id: 5, status: "pending", owner: None, meta: waits() };
    let o2 = w.stop(&transcript(&[ok], &[]), json!({}));
    assert!(!o2.1.contains("#5 pending"), "a pending task with its reason passes: {o2:?}");
}

// ---- rule `agent_task` (R-pair F2) and its tier ------------------------------------------------------------------------------------------

#[test]
fn agent_task_rule_has_its_own_tier() {
    let w = World::new("agent-tier");
    w.track(&["port the wake"]);
    let t = transcript(&[T { id: 1, status: "pending", owner: Some("someone"), meta: waits() }], &[("port the wake", Some("wake-worker"))]);
    let o = w.stop(&t, json!({}));
    assert!(o.1.contains("\"decision\":\"block\"") && o.1.contains("agent \\\"wake-worker\\\" owns no task"), "block tier (default): {o:?}");
    w.set("ANTIHALL_TASK_STRICT_AGENT_TASK", "advise");
    let a = w.stop(&t, json!({}));
    assert!(!a.1.contains("\"decision\":\"block\""), "advise tier: the Stop goes on: {a:?}");
    assert!(a.1.contains("additionalContext") && a.1.contains("owns no task"), "advise tier: Stop context the model reads: {a:?}");
}

// ---- tiers, one block per turn, scope ---------------------------------------------------------------------------------------------------

#[test]
fn advise_tier_never_blocks() {
    let w = World::new("advise");
    for k in ["ANTIHALL_TASK_STRICT_OWNER", "ANTIHALL_TASK_STRICT_BLOCKED_ON"] {
        w.set(k, "advise");
    }
    let o = w.stop(&transcript(&[task(1, "in_progress", None), task(2, "pending", None)], &[]), json!({}));
    assert!(!blocked(&o), "every item is advise tier: {o:?}");
    assert!(o.1.contains("#1 in_progress, no owner") && o.1.contains("#2 pending, no blockedOn"), "the note names them: {o:?}");
}

#[test]
fn many_items_make_one_block() {
    let w = World::new("one-block");
    let tasks = [
        task(1, "in_progress", None),
        task(2, "pending", None),
        task(3, "pending", None),
        task(4, "in_progress", Some("ghost")),
        task(5, "pending", None),
        task(6, "pending", None),
    ];
    let o = w.stop(&transcript(&tasks, &[]), json!({}));
    assert!(blocked(&o), "{o:?}");
    assert_eq!(o.1.matches(NAME).count(), 1, "one strict block for all items: {o:?}");
    assert!(o.1.contains("(+2 more)") && o.1.contains("all calls: "), "the rest are counted and saved: {o:?}");
}

#[test]
fn a_subagent_or_teammate_is_never_held() {
    let w = World::new("subagent");
    let t = transcript(&[task(1, "in_progress", None), task(2, "pending", None)], &[]);
    assert!(blocked(&w.stop(&t, json!({}))), "the twin: the main session is held");
    let o = w.stop(&t, json!({"agent_id": "a0000000000000aa", "agent_type": "reviewer"}));
    assert!(!o.1.contains(NAME) && !o.2.contains(NAME), "an agent payload is not the list's owner: {o:?}");
}
