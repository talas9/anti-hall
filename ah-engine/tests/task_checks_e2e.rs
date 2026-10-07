//! The task checks through the real dispatcher (`ah-engine hook --event <Event>`, in-process): a check that answers must
//! make the Node hook unnecessary, so each Node hook is replaced by a command that fails loudly and the test proves the
//! answer came from the engine and that its file effects are on disk.

use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

struct World {
    dir: PathBuf,
}

impl World {
    fn new(name: &str) -> World {
        let dir = std::env::temp_dir().join(format!("ah-task-e2e-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("home")).unwrap();
        std::fs::create_dir_all(dir.join("proj/.git")).unwrap();
        World { dir }
    }

    /// Run `hook --event <event>` with the Node hooks of that event mapped to a command that exits 99.
    fn hook(&self, event: &str, payload: &str, node_ids: &[&str]) -> (i32, String, String) {
        let map: serde_json::Map<String, serde_json::Value> = node_ids.iter().map(|id| (id.to_string(), "exit 99".into())).collect();
        let map_path = self.dir.join("map.json");
        std::fs::write(&map_path, serde_json::json!({ event: map }).to_string()).unwrap();
        let mut c = Command::new(env!("CARGO_BIN_EXE_ah-engine"));
        c.args(["hook", "--event", event, "--fallback-map"])
            .arg(&map_path)
            .env_clear()
            .env("PATH", std::env::var("PATH").unwrap_or_default())
            .env("HOME", self.dir.join("home"))
            .env("AH_ENGINE_DIR", self.dir.join("state"))
            .env("AH_ENGINE_VERSION", "task-e2e")
            .env("AH_ENGINE_DISPATCH_IN_PROCESS", "1")
            .env("CLAUDE_PLUGIN_ROOT", &self.dir)
            .current_dir(&self.dir)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        let mut ch = c.spawn().unwrap();
        ch.stdin.take().unwrap().write_all(payload.as_bytes()).unwrap();
        let o = ch.wait_with_output().unwrap();
        (o.status.code().unwrap_or(-1), String::from_utf8_lossy(&o.stdout).into(), String::from_utf8_lossy(&o.stderr).into())
    }

    fn path(&self, rel: &str) -> PathBuf {
        self.dir.join(rel)
    }
}

impl Drop for World {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

fn read(p: &Path) -> String {
    std::fs::read_to_string(p).unwrap_or_default()
}

#[test]
fn a_task_event_is_logged_by_the_engine_without_running_the_node_hook() {
    let w = World::new("lifecycle");
    let cwd = std::fs::canonicalize(w.path("proj")).unwrap();
    let payload = serde_json::json!({"hook_event_name": "TaskCreated", "session_id": "s-1", "cwd": cwd, "task_id": "4", "task_subject": "do it"}).to_string();
    let (code, out, _) = w.hook("TaskCreated", &payload, &["task-lifecycle-log"]);
    assert_eq!((code, out.as_str()), (0, ""), "the engine answers; the Node hook (exit 99) must not run");
    let day = std::fs::read_dir(w.path("proj/.anti-hall/history")).unwrap().filter_map(Result::ok).find(|e| e.path().is_dir()).unwrap().path();
    let ledger = read(&day.join("s-1.md"));
    assert!(ledger.contains(" · TaskCreated · task_id=4 · do it\n"), "{ledger}");
    assert!(read(&w.path("proj/.anti-hall/history/INDEX.md")).contains("· s-1 · [history](../"));
}

#[test]
fn a_relative_cwd_runs_the_node_hook() {
    let w = World::new("lifecycle-defer");
    let payload = serde_json::json!({"hook_event_name": "TaskCompleted", "session_id": "s", "cwd": "rel", "task_id": "1"}).to_string();
    let (code, ..) = w.hook("TaskCompleted", &payload, &["task-lifecycle-log"]);
    assert_eq!(code, 99, "a deferred check hands the call to the Node hook");
}

/// Every Node hook of `event` that matches `tool`, as ids, so a test can replace all of them.
fn ids_for(event: &str, tool: &str) -> Vec<String> {
    let p = serde_json::json!({"hook_event_name": event, "tool_name": tool});
    ah_engine::dispatch::table::select("claude", event, &p, Some(tool)).into_iter().map(|e| e.id).collect()
}

#[test]
fn dispatch_tier_does_nothing_while_jev_is_off_and_defers_while_it_is_on() {
    let w = World::new("tier");
    let payload = serde_json::json!({"hook_event_name": "PostToolUse", "tool_name": "TaskCreate", "session_id": "s", "cwd": w.path("proj"), "tool_input": {"subject": "x"}}).to_string();
    let ids = ids_for("PostToolUse", "TaskCreate");
    assert!(ids.iter().any(|i| i == "dispatch-tier"), "{ids:?}");
    // Every other matching hook is mapped to a successful no-op; dispatch-tier alone is mapped to exit 99.
    let map: serde_json::Map<String, serde_json::Value> =
        ids.iter().map(|id| (id.clone(), if id == "dispatch-tier" { "exit 99" } else { "true" }.into())).collect();
    let map_path = w.path("map.json");
    std::fs::write(&map_path, serde_json::json!({ "PostToolUse": map }).to_string()).unwrap();
    for (jev, want) in [(None, 0), (Some("1"), 99)] {
        let mut c = Command::new(env!("CARGO_BIN_EXE_ah-engine"));
        c.args(["hook", "--event", "PostToolUse", "--tool", "TaskCreate", "--fallback-map"])
            .arg(&map_path)
            .env_clear()
            .env("PATH", std::env::var("PATH").unwrap_or_default())
            .env("HOME", w.path("home"))
            .env("AH_ENGINE_DIR", w.path("state"))
            .env("AH_ENGINE_VERSION", "task-e2e")
            .env("AH_ENGINE_DISPATCH_IN_PROCESS", "1")
            .env("CLAUDE_PLUGIN_ROOT", &w.dir)
            .current_dir(&w.dir)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        if let Some(v) = jev {
            c.env("ANTIHALL_JEV", v);
        }
        let mut ch = c.spawn().unwrap();
        ch.stdin.take().unwrap().write_all(payload.as_bytes()).unwrap();
        let o = ch.wait_with_output().unwrap();
        assert_eq!(o.status.code(), Some(want), "jev={jev:?}: {}", String::from_utf8_lossy(&o.stderr));
    }
}

/// A Stop run through the dispatcher with every Stop hook of the event mapped to a no-op, except `only`, which is mapped to
/// exit 99: a result of 99 proves the check deferred to its Node hook, 0 that the engine answered.
fn stop_run(w: &World, only: &str, payload: &str) -> i32 {
    let ids = ids_for("Stop", "");
    assert!(ids.iter().any(|i| i == only), "{ids:?}");
    let map: serde_json::Map<String, serde_json::Value> = ids.iter().map(|id| (id.clone(), if id == only { "exit 99" } else { "true" }.into())).collect();
    let map_path = w.path("stop-map.json");
    std::fs::write(&map_path, serde_json::json!({ "Stop": map }).to_string()).unwrap();
    let mut c = Command::new(env!("CARGO_BIN_EXE_ah-engine"));
    c.args(["hook", "--event", "Stop", "--fallback-map"])
        .arg(&map_path)
        .env_clear()
        .env("PATH", std::env::var("PATH").unwrap_or_default())
        .env("HOME", w.path("home"))
        .env("AH_ENGINE_DIR", w.path("state"))
        .env("AH_ENGINE_VERSION", "task-e2e")
        .env("AH_ENGINE_DISPATCH_IN_PROCESS", "1")
        .env("CLAUDE_PLUGIN_ROOT", &w.dir)
        .current_dir(&w.dir)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut ch = c.spawn().unwrap();
    ch.stdin.take().unwrap().write_all(payload.as_bytes()).unwrap();
    ch.wait_with_output().unwrap().status.code().unwrap_or(-1)
}

fn task_lines(status: &str) -> String {
    let create = serde_json::json!({"type": "assistant", "message": {"id": "m1", "role": "assistant", "content": [{"type": "tool_use", "id": "tu1", "name": "TaskCreate", "input": {"subject": "do it"}}]}});
    let result = serde_json::json!({"type": "user", "message": {"role": "user", "content": [{"type": "tool_result", "tool_use_id": "tu1", "content": "Task #1 created successfully: do it"}]}});
    let update = serde_json::json!({"type": "assistant", "message": {"id": "m2", "role": "assistant", "content": [{"type": "tool_use", "id": "tu2", "name": "TaskUpdate", "input": {"taskId": "1", "status": status}}]}});
    format!("{create}\n{result}\n{update}\n")
}

#[test]
fn task_guard_answers_a_stop_with_nothing_open_and_defers_one_with_an_open_task() {
    let w = World::new("task-guard");
    let state_file = w.path("home/.anti-hall/last-stop-taskset-s1");
    std::fs::create_dir_all(w.path("home/.anti-hall")).unwrap();
    for (status, want, state_kept) in [("completed", 0, false), ("pending", 99, true)] {
        std::fs::write(w.path("t.jsonl"), task_lines(status)).unwrap();
        std::fs::write(&state_file, "{}").unwrap();
        let payload =
            serde_json::json!({"hook_event_name": "Stop", "session_id": "s1", "cwd": w.path("proj"), "transcript_path": w.path("t.jsonl")}).to_string();
        assert_eq!(stop_run(&w, "task-guard", &payload), want, "{status}");
        assert_eq!(state_file.exists(), state_kept, "{status}: the loop state file");
    }
}

#[test]
fn tasklist_guard_answers_a_quiet_stop_with_its_file_effects_and_defers_a_block() {
    let w = World::new("tasklist-guard");
    let cwd = std::fs::canonicalize(w.path("proj")).unwrap();
    std::fs::write(w.path("t.jsonl"), "").unwrap();
    let payload = serde_json::json!({"hook_event_name": "Stop", "session_id": "s1", "cwd": cwd, "transcript_path": w.path("t.jsonl")}).to_string();
    assert_eq!(stop_run(&w, "tasklist-guard", &payload), 0, "a session with no work is trivial");
    let day = std::fs::read_dir(w.path("proj/.anti-hall/progress")).unwrap().filter_map(Result::ok).next().expect("the progress directory is made").path();
    assert!(day.is_dir());
    // three file-changing actions with no task activity: Node blocks, so the engine must hand the Stop over
    let edit = |n: u32| serde_json::json!({"type": "assistant", "timestamp": "2026-10-06T08:00:00.000Z", "message": {"id": format!("m{n}"), "role": "assistant", "content": [{"type": "tool_use", "id": format!("t{n}"), "name": "Edit", "input": {"file_path": format!("/p/f{n}.js")}}]}});
    std::fs::write(w.path("t2.jsonl"), format!("{}\n{}\n{}\n", edit(1), edit(2), edit(3))).unwrap();
    let payload = serde_json::json!({"hook_event_name": "Stop", "session_id": "s1", "cwd": cwd, "transcript_path": w.path("t2.jsonl")}).to_string();
    assert_eq!(stop_run(&w, "tasklist-guard", &payload), 99);
}
