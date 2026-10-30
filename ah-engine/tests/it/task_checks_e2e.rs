//! The task checks through the real dispatcher (`ah-engine hook --event <Event>`, in-process): a check that answers must
//! make the Node hook unnecessary, so each Node hook is replaced by a command that fails loudly and the test proves the
//! answer came from the engine and that its file effects are on disk.
#![allow(clippy::unwrap_used, clippy::expect_used)] // a test crate: a panic is the failure report, and E2 exempts tests

use crate::common;

use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

struct World {
    dir: PathBuf,
}

impl World {
    fn new(name: &str) -> World {
        let dir = std::env::temp_dir().join(format!("ah-task-e2e-{name}-{}", std::process::id()));
        ah_engine::discard::harmless(std::fs::remove_dir_all(&dir));
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
        common::reap(&self.dir.join("state"), || {}); // a daemon a hook call started never outlives the test
        ah_engine::discard::harmless(std::fs::remove_dir_all(&self.dir));
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
    assert_eq!(code, 0, "a relative cwd is answered by the engine itself; nothing is handed to the Node hook (exit 99)");
}

/// Every Node hook of `event` that matches `tool`, as ids, so a test can replace all of them.
fn ids_for(event: &str, tool: &str) -> Vec<String> {
    let p = serde_json::json!({"hook_event_name": event, "tool_name": tool});
    ah_engine::dispatch::table::select("claude", event, &p, Some(tool)).into_iter().map(|e| e.id).collect()
}

#[test]
fn dispatch_tier_does_nothing_while_jev_is_off_answers_when_it_is_on_and_defers_input_it_cannot_read() {
    let w = World::new("tier");
    let payload = serde_json::json!({"hook_event_name": "PostToolUse", "tool_name": "TaskCreate", "session_id": "s", "cwd": w.path("proj"), "tool_input": {"subject": "x"}}).to_string();
    let ids = ids_for("PostToolUse", "TaskCreate");
    assert!(ids.iter().any(|i| i == "dispatch-tier"), "{ids:?}");
    // Every other matching hook is mapped to a successful no-op; dispatch-tier alone is mapped to exit 99.
    let map: serde_json::Map<String, serde_json::Value> =
        ids.iter().map(|id| (id.clone(), if id == "dispatch-tier" { "exit 99" } else { "true" }.into())).collect();
    let map_path = w.path("map.json");
    std::fs::write(&map_path, serde_json::json!({ "PostToolUse": map }).to_string()).unwrap();
    let odd = serde_json::json!({"hook_event_name": "PostToolUse", "tool_name": "TaskCreate", "session_id": "s", "cwd": w.path("proj"), "tool_input": {"subject": {"x": 1}}}).to_string();
    for (jev, want, payload) in [(None, 0, &payload), (Some("1"), 0, &payload), (Some("1"), 0, &odd)] {
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
        if jev.is_some() && want == 0 {
            assert!(w.path("home").join(".anti-hall/dispatch-tier-state.json").exists(), "the check wrote the request marker itself");
        }
    }
}

/// A Stop run through the dispatcher with every Stop hook of the event mapped to a no-op, except `only`, which is mapped to
/// exit 99: a result of 99 proves the check deferred to its Node hook, 0 that the engine answered.
fn stop_run(w: &World, only: &str, payload: &str) -> (i32, String) {
    let (code, out, _) = stop_run_env(w, only, payload, &[]);
    (code, out)
}

/// [`stop_run`] with extra environment variables, returning stderr too.
fn stop_run_env(w: &World, only: &str, payload: &str, env: &[(&str, &str)]) -> (i32, String, String) {
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
        .envs(env.iter().copied())
        .current_dir(&w.dir)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut ch = c.spawn().unwrap();
    ch.stdin.take().unwrap().write_all(payload.as_bytes()).unwrap();
    let o = ch.wait_with_output().unwrap();
    (o.status.code().unwrap_or(-1), String::from_utf8_lossy(&o.stdout).into_owned(), String::from_utf8_lossy(&o.stderr).into_owned())
}

fn task_lines(status: &str) -> String {
    let create = serde_json::json!({"type": "assistant", "message": {"id": "m1", "role": "assistant", "content": [{"type": "tool_use", "id": "tu1", "name": "TaskCreate", "input": {"subject": "do it"}}]}});
    let result = serde_json::json!({"type": "user", "message": {"role": "user", "content": [{"type": "tool_result", "tool_use_id": "tu1", "content": "Task #1 created successfully: do it"}]}});
    let update = serde_json::json!({"type": "assistant", "message": {"id": "m2", "role": "assistant", "content": [{"type": "tool_use", "id": "tu2", "name": "TaskUpdate", "input": {"taskId": "1", "status": status}}]}});
    format!("{create}\n{result}\n{update}\n")
}

#[test]
fn task_guard_answers_a_stop_with_nothing_open_and_blocks_one_with_an_open_task() {
    let w = World::new("task-guard");
    let state_file = w.path("home/.anti-hall/last-stop-taskset-s1");
    std::fs::create_dir_all(w.path("home/.anti-hall")).unwrap();
    // an open task: the native fire path (lane stop) answers the block itself (exit 0 + JSON block), so the mapped Node
    // hook (exit 99) never runs, and the loop state is written
    for (status, want, state_kept) in [("completed", 0, false), ("pending", 0, true)] {
        std::fs::write(w.path("t.jsonl"), task_lines(status)).unwrap();
        std::fs::write(&state_file, "{}").unwrap();
        let payload =
            serde_json::json!({"hook_event_name": "Stop", "session_id": "s1", "cwd": w.path("proj"), "transcript_path": w.path("t.jsonl")}).to_string();
        let (code, out) = stop_run(&w, "task-guard", &payload);
        assert_eq!(code, want, "{status}");
        assert_eq!(out.contains("\"decision\":\"block\""), state_kept, "{status}: blocks exactly when a task is open: {out}");
        assert_eq!(state_file.exists(), state_kept, "{status}: the loop state file");
    }
}

/// #237: a transcript line `JSON.parse` reads and serde does not (here an escaped lone surrogate in an unrelated assistant text) must
/// not turn the open tasks of the transcript into "no tasks": Node still blocks the Stop.
#[test]
fn a_line_only_javascript_can_parse_does_not_hide_an_open_task_from_the_stop_guard() {
    let w = World::new("task-guard-js-line");
    std::fs::create_dir_all(w.path("home/.anti-hall")).unwrap();
    let odd = "{\"type\":\"assistant\",\"message\":{\"id\":\"o\",\"role\":\"assistant\",\"content\":[{\"type\":\"text\",\"text\":\"cut \\ud83d here\"}]}}\n";
    assert!(serde_json::from_str::<serde_json::Value>(odd).is_err(), "the fixture must be a line serde rejects");
    std::fs::write(w.path("t.jsonl"), format!("{}{odd}", task_lines("pending"))).unwrap();
    let payload = serde_json::json!({"hook_event_name": "Stop", "session_id": "s1", "cwd": w.path("proj"), "transcript_path": w.path("t.jsonl")}).to_string();
    let (code, out) = stop_run(&w, "task-guard", &payload);
    assert_eq!(code, 0);
    assert!(out.contains("\"decision\":\"block\""), "the open task still blocks: {out}");
}

/// #238: a valid budget file the engine cannot read exactly (over the script read cap) is never replaced by a partial map of this
/// check's own bucket: the other hooks' counts in it survive, and the Stop fails open as for any budget that cannot be persisted.
#[test]
fn the_stop_budget_never_overwrites_a_valid_file_it_could_not_read_exactly() {
    let w = World::new("task-guard-big-budget");
    let dir = w.path("home/.anti-hall/devswarm/stop-policy");
    std::fs::create_dir_all(&dir).unwrap();
    let big = format!("{{\"other|child-gate|inbox\":{{\"count\":2,\"lastAt\":1}}}}{}", " ".repeat(4_300_000));
    std::fs::write(dir.join("s1.json"), &big).unwrap();
    std::fs::write(w.path("t.jsonl"), task_lines("pending")).unwrap();
    let payload =
        serde_json::json!({"hook_event_name": "Stop", "session_id": "s1", "prompt_id": "p1", "cwd": w.path("proj"), "transcript_path": w.path("t.jsonl")})
            .to_string();
    let (code, out, _) = stop_run_env(&w, "task-guard", &payload, &[("ANTIHALL_STOP_NAG_BUDGET", "1")]);
    assert_eq!(code, 0);
    assert!(!out.contains("\"decision\":\"block\""), "a budget that cannot be updated exactly fails open: {out}");
    assert_eq!(std::fs::read_to_string(dir.join("s1.json")).unwrap(), big, "the file was rewritten");
}

/// stdout is nothing or one JSON object: the host reads anything else as plain text (a block next to a note is lost) and the
/// dispatcher cannot merge plain text with another Stop hook's JSON (`dispatch_conflict`).
fn assert_stdout_is_json_or_empty(out: &str, what: &str) {
    let t = out.trim();
    assert!(t.is_empty() || serde_json::from_str::<serde_json::Map<String, serde_json::Value>>(t).is_ok(), "{what}: stdout is not one JSON object: {out:?}");
}

#[test]
fn task_guard_advisories_never_share_stdout_with_the_answer() {
    let w = World::new("task-guard-advisory");
    std::fs::create_dir_all(w.path("home/.anti-hall/agents")).unwrap();
    let payload = serde_json::json!({"hook_event_name": "Stop", "session_id": "s1", "cwd": w.path("proj"), "transcript_path": w.path("t.jsonl")}).to_string();
    // live agents and an open task: the step-aside advisory goes to stderr, stdout stays empty
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis() as u64;
    std::fs::write(w.path("home/.anti-hall/agents/a.json"), format!("{{\"ts\": {}}}", now - 60_000)).unwrap();
    std::fs::write(w.path("t.jsonl"), task_lines("in_progress")).unwrap();
    let (code, out, err) = stop_run_env(&w, "task-guard", &payload, &[]);
    assert_eq!(code, 0, "answered by the engine");
    assert_stdout_is_json_or_empty(&out, "live agents");
    assert!(err.contains("[task-guard] open tasks remain but live agents are active"), "the advisory is kept on stderr: {err:?}");
    // a block with many done tasks: stdout is exactly the block, and no prune note rides the Stop
    std::fs::remove_file(w.path("home/.anti-hall/agents/a.json")).unwrap();
    let line = |v: serde_json::Value| format!("{v}\n");
    let mut t = String::new();
    for n in 1..=3 {
        t += &line(
            serde_json::json!({"type": "assistant", "message": {"id": format!("c{n}"), "role": "assistant", "content": [{"type": "tool_use", "id": format!("c{n}"), "name": "TaskCreate", "input": {"subject": format!("t{n}")}}]}}),
        );
        t += &line(
            serde_json::json!({"type": "user", "message": {"role": "user", "content": [{"type": "tool_result", "tool_use_id": format!("c{n}"), "content": format!("Task #{n} created successfully: t{n}")}]}}),
        );
    }
    for n in 1..=2 {
        t += &line(
            serde_json::json!({"type": "assistant", "message": {"id": format!("u{n}"), "role": "assistant", "content": [{"type": "tool_use", "id": format!("u{n}"), "name": "TaskUpdate", "input": {"taskId": n.to_string(), "status": "completed"}}]}}),
        );
    }
    std::fs::write(w.path("t.jsonl"), t).unwrap();
    let (code, out, err) = stop_run_env(&w, "task-guard", &payload, &[("ANTIHALL_PRUNE_COMPLETED_TASKS_AFTER", "1")]);
    assert_eq!(code, 0, "answered by the engine");
    assert_stdout_is_json_or_empty(&out, "prune advisory + block");
    assert!(out.contains("\"decision\":\"block\""), "the block reaches the host: {out:?}");
    assert!(
        !err.contains("completed tasks (limit"),
        "the prune advisory moved to the UserPromptSubmit task tracker (a Stop stderr never reaches the model): {err:?}"
    );
}

#[test]
fn tasklist_guard_advisories_never_share_stdout_with_the_answer() {
    let w = World::new("tasklist-guard-advisory");
    let cwd = std::fs::canonicalize(w.path("proj")).unwrap();
    let edit = |n: u32| serde_json::json!({"type": "assistant", "timestamp": "2026-10-06T08:00:00.000Z", "message": {"id": format!("m{n}"), "role": "assistant", "content": [{"type": "tool_use", "id": format!("t{n}"), "name": "Edit", "input": {"file_path": format!("/p/f{n}.js")}}]}});
    std::fs::write(w.path("t.jsonl"), format!("{}\n{}\n{}\n", edit(1), edit(2), edit(3))).unwrap();
    // plan mode: the advisory goes to stderr, stdout stays empty
    let payload =
        serde_json::json!({"hook_event_name": "Stop", "session_id": "s1", "cwd": cwd, "transcript_path": w.path("t.jsonl"), "permission_mode": "plan"})
            .to_string();
    let (code, out, err) = stop_run_env(&w, "tasklist-guard", &payload, &[]);
    assert_eq!(code, 0, "answered by the engine");
    assert_stdout_is_json_or_empty(&out, "plan mode");
    assert!(err.contains("[tasklist-guard] PLAN MODE"), "the advisory is kept on stderr: {err:?}");
    // an OMC autonomous loop in place of a block: the step-aside line goes to stderr, stdout stays empty
    std::fs::create_dir_all(w.path("proj/.claude")).unwrap();
    std::fs::write(w.path("proj/.claude/settings.local.json"), r#"{"enabledPlugins": {"oh-my-claudecode@omc": true}}"#).unwrap();
    std::fs::create_dir_all(w.path("proj/.omc/state")).unwrap();
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis() as u64;
    std::fs::write(w.path("proj/.omc/state/team-state.json"), format!("{{\"active\": true, \"started_at\": {}}}", now - 1000)).unwrap();
    let payload = serde_json::json!({"hook_event_name": "Stop", "session_id": "s1", "cwd": cwd, "transcript_path": w.path("t.jsonl")}).to_string();
    let (code, out, err) = stop_run_env(&w, "tasklist-guard", &payload, &[]);
    assert_eq!(code, 0, "answered by the engine");
    assert_stdout_is_json_or_empty(&out, "OMC loop");
    assert!(err.contains("[tasklist-guard] OMC autonomous loop active"), "the step-aside line is kept on stderr: {err:?}");
}

/// Hook calls that arrive while no daemon runs (the first event of a session, or any event during a daemon restart): the call
/// that starts the daemon and every call that finds it being started must wait for its answer. Each used to answer nothing (an
/// empty exit 0), so a block on a guard event was lost. N concurrent cold calls of a blocking Stop and a blocking PreToolUse,
/// every Node hook mapped to a non-blocking `exit 99`: every one must block, which only the daemon's answer can do.
#[test]
fn concurrent_cold_calls_on_guard_events_all_block() {
    let w = World::new("cold-race");
    std::fs::create_dir_all(w.path("home/.anti-hall")).unwrap();
    std::fs::create_dir_all(w.path("state")).unwrap();
    // a debug daemon under a loaded test machine starts slower than the shipped wait (and this call has no launcher whose slow window
    // it must fit in); the race itself does not depend on either bound
    std::fs::write(w.path("state/config.toml"), "[client]\ncold_guard_wait_ms = 10000\n").unwrap();
    std::fs::write(w.path("t.jsonl"), task_lines("pending")).unwrap();
    // one session per Stop call: task-guard blocks a session's task set once, then stays quiet for the same set
    let stop = |i: usize| {
        serde_json::json!({"hook_event_name": "Stop", "session_id": format!("s{i}"), "cwd": w.path("proj"), "transcript_path": w.path("t.jsonl")}).to_string()
    };
    let push = serde_json::json!({"hook_event_name": "PreToolUse", "session_id": "p1", "cwd": w.path("proj"), "tool_name": "Bash",
        "tool_input": {"command": "git push --force origin main"}, "transcript_path": w.path("t.jsonl")})
    .to_string();
    let map = serde_json::json!({
        "Stop": ids_for("Stop", "").into_iter().map(|id| (id, serde_json::Value::from("exit 99"))).collect::<serde_json::Map<_, _>>(),
        "PreToolUse": ids_for("PreToolUse", "Bash").into_iter().map(|id| (id, serde_json::Value::from("exit 99"))).collect::<serde_json::Map<_, _>>(),
    });
    let map_path = w.path("cold-map.json");
    std::fs::write(&map_path, map.to_string()).unwrap();
    const N: usize = 4;
    let mut kids = Vec::new();
    for i in 0..2 * N {
        let (event, tool, payload) = if i % 2 == 0 { ("Stop", None, stop(i)) } else { ("PreToolUse", Some("Bash"), push.clone()) };
        let mut c = Command::new(env!("CARGO_BIN_EXE_ah-engine"));
        c.args(["hook", "--event", event]);
        if let Some(t) = tool {
            c.args(["--tool", t]);
        }
        c.arg("--fallback-map")
            .arg(&map_path)
            .env_clear()
            .env("PATH", std::env::var("PATH").unwrap_or_default())
            .env("HOME", w.path("home"))
            .env("AH_ENGINE_DIR", w.path("state"))
            .env("AH_ENGINE_VERSION", "task-e2e")
            .env("AH_ENGINE_SLOW_FALLBACK_MAX_MS", "15000")
            .env("CLAUDE_PLUGIN_ROOT", &w.dir)
            .current_dir(&w.dir)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        let mut ch = c.spawn().unwrap();
        ch.stdin.take().unwrap().write_all(payload.as_bytes()).unwrap();
        kids.push((event, ch));
    }
    for (event, ch) in kids {
        let o = ch.wait_with_output().unwrap();
        let (code, out) = (o.status.code().unwrap_or(-1), String::from_utf8_lossy(&o.stdout).into_owned());
        let blocked = code == 2 || out.contains("\"decision\":\"block\"") || out.contains("\"permissionDecision\":\"deny\"");
        assert!(blocked, "{event}: a cold call must not lose the block: code {code}, stdout {out:?}, stderr {:?}", String::from_utf8_lossy(&o.stderr));
    }
}

/// The other side of the cold-start contract: with spawning disabled no daemon is starting, so a guard call does not wait for one: it
/// keeps the unavailable contract (fail open, run no hook, print nothing), unlike the starting daemon above, which every call waits for.
#[test]
fn a_cold_guard_call_with_spawning_disabled_fails_open_without_waiting_or_running_hooks() {
    let w = World::new("cold-nospawn");
    std::fs::create_dir_all(w.path("home/.anti-hall")).unwrap();
    std::fs::write(w.path("t.jsonl"), task_lines("pending")).unwrap();
    let marker = w.path("hook-ran");
    let run = format!("touch '{}'; exit 99", marker.display());
    let map =
        serde_json::json!({ "Stop": ids_for("Stop", "").into_iter().map(|id| (id, serde_json::Value::from(run.clone()))).collect::<serde_json::Map<_, _>>() });
    let map_path = w.path("nospawn-map.json");
    std::fs::write(&map_path, map.to_string()).unwrap();
    let payload = serde_json::json!({"hook_event_name": "Stop", "session_id": "s1", "cwd": w.path("proj"), "transcript_path": w.path("t.jsonl")}).to_string();
    let mut c = Command::new(env!("CARGO_BIN_EXE_ah-engine"));
    c.args(["hook", "--event", "Stop", "--fallback-map"])
        .arg(&map_path)
        .env_clear()
        .env("PATH", std::env::var("PATH").unwrap_or_default())
        .env("HOME", w.path("home"))
        .env("AH_ENGINE_DIR", w.path("state"))
        .env("AH_ENGINE_VERSION", "task-e2e")
        .env("AH_ENGINE_NOSPAWN", "1")
        .env("CLAUDE_PLUGIN_ROOT", &w.dir)
        .current_dir(&w.dir)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut ch = c.spawn().unwrap();
    ch.stdin.take().unwrap().write_all(payload.as_bytes()).unwrap();
    let o = ch.wait_with_output().unwrap();
    assert_eq!(o.status.code(), Some(0), "no daemon is starting: the guard call fails open");
    assert!(o.stdout.is_empty(), "nothing printed: {:?}", String::from_utf8_lossy(&o.stdout));
    assert!(!marker.exists(), "no hook runs on an unavailable daemon");
}

#[test]
fn tasklist_guard_answers_a_quiet_stop_with_its_file_effects_and_answers_a_block() {
    let w = World::new("tasklist-guard");
    let cwd = std::fs::canonicalize(w.path("proj")).unwrap();
    std::fs::write(w.path("t.jsonl"), "").unwrap();
    let payload = serde_json::json!({"hook_event_name": "Stop", "session_id": "s1", "cwd": cwd, "transcript_path": w.path("t.jsonl")}).to_string();
    assert_eq!(stop_run(&w, "tasklist-guard", &payload).0, 0, "a session with no work is trivial");
    let day = std::fs::read_dir(w.path("proj/.anti-hall/progress")).unwrap().filter_map(Result::ok).next().expect("the progress directory is made").path();
    assert!(day.is_dir());
    // three file-changing actions with no task activity: Node blocks, and the native fire path (lane stop) answers that block
    // itself (exit 0 + JSON block) instead of handing the Stop over
    let edit = |n: u32| serde_json::json!({"type": "assistant", "timestamp": "2026-10-06T08:00:00.000Z", "message": {"id": format!("m{n}"), "role": "assistant", "content": [{"type": "tool_use", "id": format!("t{n}"), "name": "Edit", "input": {"file_path": format!("/p/f{n}.js")}}]}});
    std::fs::write(w.path("t2.jsonl"), format!("{}\n{}\n{}\n", edit(1), edit(2), edit(3))).unwrap();
    let payload = serde_json::json!({"hook_event_name": "Stop", "session_id": "s1", "cwd": cwd, "transcript_path": w.path("t2.jsonl")}).to_string();
    let (code, out) = stop_run(&w, "tasklist-guard", &payload);
    assert_eq!(code, 0, "answered by the engine, the Node hook (exit 99) never ran");
    assert!(out.contains("\"decision\":\"block\""), "the engine's answer is the block: {out}");
}

/// #242: a repository nested inside another one (not a submodule) is its own project: Node keeps the progress ledger in it and blocks three
/// untracked edits there. The cheap root resolver leaves the nested case to the full one; an unclassified root must never read as
/// "the progress file is fresh".
#[test]
fn tasklist_guard_blocks_in_a_repository_nested_inside_another_one() {
    let w = World::new("tasklist-guard-nested");
    let git = |dir: &std::path::Path| {
        std::fs::create_dir_all(dir).unwrap();
        let o = Command::new("git").arg("-C").arg(dir).args(["init", "-q", "-b", "main"]).output().unwrap();
        assert!(o.status.success(), "{}", String::from_utf8_lossy(&o.stderr));
    };
    ah_engine::discard::harmless(std::fs::remove_dir_all(w.path("proj/.git"))); // the fixture's placeholder
    git(&w.path("proj"));
    git(&w.path("proj/inner"));
    let cwd = std::fs::canonicalize(w.path("proj/inner")).unwrap();
    let edit = |n: u32| serde_json::json!({"type": "assistant", "timestamp": "2026-10-06T08:00:00.000Z", "message": {"id": format!("m{n}"), "role": "assistant", "content": [{"type": "tool_use", "id": format!("t{n}"), "name": "Edit", "input": {"file_path": format!("/p/f{n}.js")}}]}});
    // tasks are tracked (all done), so only a stale progress file can block: that is judged in the nested repository's own ledger
    std::fs::write(w.path("t.jsonl"), format!("{}{}\n{}\n{}\n", task_lines("completed"), edit(1), edit(2), edit(3))).unwrap();
    let payload = serde_json::json!({"hook_event_name": "Stop", "session_id": "s1", "cwd": cwd, "transcript_path": w.path("t.jsonl")}).to_string();
    let (code, out) = stop_run(&w, "tasklist-guard", &payload);
    assert_eq!(code, 0);
    assert!(out.contains("\"decision\":\"block\""), "three edits and no fresh progress file in a nested repository still block: {out}");
    assert!(w.path("proj/inner/.anti-hall/progress").is_dir(), "the progress ledger is the nested repository's own");
    assert!(!w.path("proj/.anti-hall/progress").exists(), "the outer repository's ledger is not used");
}

/// A transcript bigger than the tasklist guard's window is read by the host (`ah.transcript.toolUseScan`): the tool uses inside the
/// window count exactly as they do when the whole transcript fits, and the ones before it are out of sight.
#[test]
fn tasklist_guard_counts_the_work_inside_a_window_smaller_than_the_transcript() {
    let w = World::new("tasklist-guard-window");
    let cwd = std::fs::canonicalize(w.path("proj")).unwrap();
    let edit = |n: u32| serde_json::json!({"type": "assistant", "timestamp": "2026-10-06T08:00:00.000Z", "message": {"id": format!("m{n}"), "role": "assistant", "content": [{"type": "tool_use", "id": format!("t{n}"), "name": "Edit", "input": {"file_path": format!("/p/f{n}.js")}}]}});
    let filler = serde_json::json!({"type": "user", "message": {"role": "user", "content": "x".repeat(1000)}}).to_string();
    let pad: String = (0..700).map(|_| format!("{filler}\n")).collect(); // ~700 KB, past the 512 KiB window
    assert!(pad.len() > 600_000);
    let payload = |f: &str| serde_json::json!({"hook_event_name": "Stop", "session_id": "s1", "cwd": cwd, "transcript_path": w.path(f)}).to_string();
    // the three edits sit inside the window: the block of the small transcript
    std::fs::write(w.path("in.jsonl"), format!("{pad}{}\n{}\n{}\n", edit(1), edit(2), edit(3))).unwrap();
    let (code, out) = stop_run(&w, "tasklist-guard", &payload("in.jsonl"));
    assert_eq!(code, 0);
    assert!(out.contains("\"decision\":\"block\""), "work inside the window is counted: {out}");
    // the same edits before the window: no work is seen, no block
    std::fs::write(w.path("out.jsonl"), format!("{}\n{}\n{}\n{pad}", edit(1), edit(2), edit(3))).unwrap();
    let (code, out) = stop_run(&w, "tasklist-guard", &payload("out.jsonl"));
    assert_eq!(code, 0);
    assert!(!out.contains("\"decision\":\"block\""), "work before the window is not counted: {out}");
}

/// A transcript with one task per `(subject, status)`: created, then set to its status.
fn task_list(rows: &[(&str, &str)]) -> String {
    let mut out = String::new();
    for (i, (subject, status)) in rows.iter().enumerate() {
        let n = i + 1;
        let create = serde_json::json!({"type": "assistant", "message": {"id": format!("m{n}"), "role": "assistant", "content": [{"type": "tool_use", "id": format!("c{n}"), "name": "TaskCreate", "input": {"subject": subject}}]}});
        let result = serde_json::json!({"type": "user", "message": {"role": "user", "content": [{"type": "tool_result", "tool_use_id": format!("c{n}"), "content": format!("Task #{n} created successfully: {subject}")}]}});
        let update = serde_json::json!({"type": "assistant", "message": {"id": format!("u{n}"), "role": "assistant", "content": [{"type": "tool_use", "id": format!("t{n}"), "name": "TaskUpdate", "input": {"taskId": n.to_string(), "status": status}}]}});
        out.push_str(&format!("{create}\n{result}\n{update}\n"));
    }
    out
}

fn enforce_stop(w: &World, rows: &[(&str, &str)], advisory_shown: bool) -> String {
    std::fs::write(w.path("t.jsonl"), task_list(rows)).unwrap();
    std::fs::create_dir_all(w.path("home/.anti-hall")).unwrap();
    let adv = w.path("home/.anti-hall/advisory-state-s1.json");
    if advisory_shown {
        std::fs::write(&adv, r#"{"kinds":{"task_guard_prune":{"n":1,"seen":0,"hash":"x","t":1,"fb":0}}}"#).unwrap();
    } else {
        ah_engine::discard::harmless(std::fs::remove_file(&adv)); // a state a previous call of the same world left behind is not "never shown"
    }
    let payload = serde_json::json!({"hook_event_name": "Stop", "session_id": "s1", "cwd": w.path("proj"), "transcript_path": w.path("t.jsonl")}).to_string();
    let (code, out, err) = stop_run_env(w, "task-guard", &payload, &[]);
    assert_eq!(code, 0, "the engine answers; the Node hook must not run: {err}");
    out
}

#[test]
fn an_ignored_prune_advisory_blocks_the_stop_up_to_the_cap_then_lets_it_through() {
    let w = World::new("prune-block");
    let done: Vec<(&str, &str)> = (0..12).map(|_| ("[P2] old", "completed")).collect();
    let first = enforce_stop(&w, &done, true);
    assert!(first.contains("\"decision\":\"block\"") && first.contains("12 completed tasks"), "{first}");
    let second = enforce_stop(&w, &done, true);
    assert!(second.contains("\"decision\":\"block\""), "cap 2: the second block is made: {second}");
    let third = enforce_stop(&w, &done, true);
    assert!(!third.contains("\"decision\":\"block\""), "the cap is reached: the Stop passes: {third}");
}

#[test]
fn the_prune_block_is_silent_under_the_limit_and_before_the_advisory_was_shown() {
    let w = World::new("prune-quiet");
    let few: Vec<(&str, &str)> = (0..2).map(|_| ("[P2] old", "completed")).collect();
    assert!(!enforce_stop(&w, &few, true).contains("block"), "under the limit");
    let many: Vec<(&str, &str)> = (0..12).map(|_| ("[P2] old", "completed")).collect();
    assert!(!enforce_stop(&w, &many, false).contains("block"), "the advisory was never shown");
    // the twin: the very same list and session DOES block once the advisory was shown, so the two silences above are the guard's decision
    assert!(enforce_stop(&w, &many, true).contains("12 completed tasks"), "the guard ran and blocks over the limit");
}

#[test]
fn a_free_text_priority_tag_blocks_the_stop_capped_and_p0_to_p3_pass() {
    let w = World::new("prio-block");
    let ok = enforce_stop(&w, &[("T-1 [P2] fine", "completed"), ("T-2 [p1] fine", "completed")], false);
    assert!(!ok.contains("block"), "P0-P3 (any case) and finished tasks pass: {ok}");
    // an open task draws the open-task block first; the same set is not blocked twice, so the priority check speaks on the retry
    let rows = [("T-3 [Owner/blocked] wait", "pending")];
    let open = enforce_stop(&w, &rows, false);
    assert!(open.contains("\"decision\":\"block\"") && !open.contains("P0-P3"), "{open}");
    for n in 1..=2 {
        let o = enforce_stop(&w, &rows, false);
        assert!(o.contains("P0-P3") && o.contains("[Owner/blocked]"), "block {n}: {o}");
    }
    let capped = enforce_stop(&w, &rows, false);
    assert!(!capped.contains("block"), "the cap is reached: the Stop passes: {capped}");
    let good = enforce_stop(&w, &[("T-3 [P1] Owner/blocked wait", "pending")], false);
    assert!(!good.contains("P0-P3"), "a P-tag with the label in the text is not flagged: {good}");
}

// ---- task-hook false positives: #459 #460 #461 #467 #468 ----

/// One hook event through the dispatcher with every hook of the event mapped to a no-op except `only` (exit 99 = deferred to Node).
/// Several calls of one world share its home, so advisory state carries over like in a session.
fn event_run(w: &World, event: &str, tool: &str, only: &str, payload: &serde_json::Value, env: &[(&str, &str)]) -> (i32, String, String) {
    let ids = ids_for(event, tool);
    assert!(ids.iter().any(|i| i == only), "{only} not in {ids:?}");
    let map: serde_json::Map<String, serde_json::Value> = ids.iter().map(|id| (id.clone(), if id == only { "exit 99" } else { "true" }.into())).collect();
    let map_path = w.path("event-map.json");
    std::fs::write(&map_path, serde_json::json!({ event: map }).to_string()).unwrap();
    let mut c = Command::new(env!("CARGO_BIN_EXE_ah-engine"));
    c.args(["hook", "--event", event]);
    if !tool.is_empty() {
        c.args(["--tool", tool]);
    }
    c.arg("--fallback-map")
        .arg(&map_path)
        .env_clear()
        .env("PATH", std::env::var("PATH").unwrap_or_default())
        .env("HOME", w.path("home"))
        .env("AH_ENGINE_DIR", w.path("state"))
        .env("AH_ENGINE_VERSION", "task-e2e")
        .env("AH_ENGINE_DISPATCH_IN_PROCESS", "1")
        .env("CLAUDE_PLUGIN_ROOT", &w.dir)
        .envs(env.iter().copied())
        .current_dir(&w.dir)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut ch = c.spawn().unwrap();
    ch.stdin.take().unwrap().write_all(payload.to_string().as_bytes()).unwrap();
    let o = ch.wait_with_output().unwrap();
    (o.status.code().unwrap_or(-1), String::from_utf8_lossy(&o.stdout).into_owned(), String::from_utf8_lossy(&o.stderr).into_owned())
}

fn bash_use(n: u32, cmd: &str) -> String {
    serde_json::json!({"type": "assistant", "timestamp": "2026-10-06T08:00:00.000Z", "message": {"id": format!("b{n}"), "role": "assistant", "content": [{"type": "tool_use", "id": format!("bt{n}"), "name": "Bash", "input": {"command": cmd}}]}}).to_string()
}

fn edit_use(n: u32) -> String {
    serde_json::json!({"type": "assistant", "timestamp": "2026-10-06T08:00:00.000Z", "message": {"id": format!("e{n}"), "role": "assistant", "content": [{"type": "tool_use", "id": format!("et{n}"), "name": "Edit", "input": {"file_path": format!("/p/f{n}.js")}}]}}).to_string()
}

/// #459: commands that only touch /tmp, /private/tmp or /var/tmp are scratch even when TMPDIR points elsewhere (macOS), and the
/// progress block states the no-heredoc rule in its own text.
#[test]
fn tasklist_guard_ignores_system_temp_commands_and_states_the_heredoc_rule() {
    let w = World::new("fp459");
    let cwd = std::fs::canonicalize(w.path("proj")).unwrap();
    let payload = |f: &str| serde_json::json!({"hook_event_name": "Stop", "session_id": "s1", "cwd": cwd, "transcript_path": w.path(f)});
    let run = |f: &str| {
        let (code, out, _) = event_run(&w, "Stop", "", "tasklist-guard", &payload(f), &[("TMPDIR", "/var/folders/zz/T")]);
        assert_eq!(code, 0);
        out
    };
    let scratch = [
        bash_use(1, "echo '{}' > /tmp/status.json"),
        bash_use(2, "cat > /private/tmp/note.txt <<'EOF'\nprogress\nEOF"),
        bash_use(3, "cp /tmp/status.json /var/tmp/status.bak"),
    ];
    std::fs::write(w.path("scratch.jsonl"), scratch.join("\n") + "\n").unwrap();
    assert!(!run("scratch.jsonl").contains("\"decision\":\"block\""), "scratch/tmp commands are not changed files");
    // the twin: the same number of project edits blocks, so the silence above is the temp exclusion and not a quiet guard
    std::fs::write(w.path("edits.jsonl"), format!("{}\n{}\n{}\n", edit_use(1), edit_use(2), edit_use(3))).unwrap();
    assert!(run("edits.jsonl").contains("\"decision\":\"block\""), "project edits still block");
    // tasks exist, the progress file does not: the Stop text itself carries the rule, not only the details file
    std::fs::write(w.path("tracked.jsonl"), format!("{}{}\n{}\n{}\n", task_list(&[("T-1 [P1] work", "in_progress")]), edit_use(1), edit_use(2), edit_use(3))).unwrap();
    let out = run("tracked.jsonl");
    assert!(out.contains("progress is missing or stale") && out.contains("heredoc"), "the Stop text states the heredoc rule: {out}");
}

/// #460: a research-shaped brief that also changes state (commit, build, settings, restore) is not nudged toward Explore.
#[test]
fn model_routing_does_not_nudge_explore_for_a_brief_that_mutates_state() {
    let w = World::new("fp460");
    let spawn = |prompt: &str| {
        serde_json::json!({"hook_event_name": "PreToolUse", "tool_name": "Agent", "session_id": "s1", "cwd": w.path("proj"),
            "tool_input": {"description": "probe", "prompt": prompt, "subagent_type": "general-purpose", "model": "sonnet"}})
    };
    let run = |prompt: &str| event_run(&w, "PreToolUse", "Agent", "model-routing-guard", &spawn(prompt), &[]).1;
    let ro = run("Investigate which modules import the parser and list them. Read only.");
    assert!(ro.contains("Explore"), "a read-only research brief is still nudged: {ro}");
    for brief in [
        "Investigate the device status, change the device settings to the test profile, then restore them afterwards.",
        "Investigate why the build fails: run cargo build and cargo test in the clone and report the result.",
        "Find the regression and commit the fix, then push the branch.",
        "Research the flaky case, deploy to staging and check the live probe.",
    ] {
        let out = run(brief);
        assert!(!out.contains("Explore"), "mutating brief {brief:?} must not be nudged: {out}");
    }
}

/// #460 (a)+(b): the advisor review rule and the deploy floor weigh the task's own verb, not a quoted word.
#[test]
fn review_and_deploy_classifiers_weigh_the_tasks_own_verbs() {
    let w = World::new("fp460b");
    let user = r#"{"type":"user","message":{"role":"user","content":"go"}}"#;
    let advisor = r#"{"type":"assistant","message":{"role":"assistant","model":"claude-sonnet-5-5","content":[{"type":"server_tool_use","name":"advisor","input":{}}]}}"#;
    std::fs::write(w.path("a.jsonl"), format!("{user}\n{advisor}\n")).unwrap();
    let run = |desc: &str, prompt: &str, model: &str| {
        let p = serde_json::json!({"hook_event_name": "PreToolUse", "tool_name": "Agent", "session_id": "s1", "cwd": w.path("proj"), "transcript_path": w.path("a.jsonl"),
            "tool_input": {"description": desc, "prompt": prompt, "subagent_type": "general-purpose", "model": model}});
        let w2 = World::new(&format!("fp460b-{}", desc.len()));
        std::fs::copy(w.path("a.jsonl"), w2.path("a.jsonl")).unwrap();
        let mut p = p;
        p["transcript_path"] = serde_json::json!(w2.path("a.jsonl"));
        let r = event_run(&w2, "PreToolUse", "Agent", "model-routing-guard", &p, &[]);
        format!("{}|{}", r.0, r.1)
    };
    assert!(run("Review the diff", "check it", "sonnet").starts_with("2|"), "twin: a real review on sonnet is blocked");
    assert_eq!(run("Fix the 5 findings the Codex review found", "fix them, run tests, commit", "sonnet"), "0|", "an implementation spawn quoting a review passes");
    let twin = run("Deploy to production with the secrets", "run the production deploy using the secrets", "haiku");
    assert!(twin.len() > 3, "twin: a real deploy on haiku is flagged: {twin}");
    assert_eq!(run("Append ledger entry", "Append one line to the production deploy ledger and add a section to the progress file; secrets rotation was done earlier.", "haiku"), "0|", "bookkeeping on haiku passes");
}

/// #461: a pending task that waits on the owner (any T-<n> [P] prefix, or an owner-gated marker) is not idle work.
#[test]
fn the_idle_stop_check_ignores_tasks_blocked_on_the_owner() {
    // one world per Stop: the per-prompt block budget would otherwise hide the later calls
    let stop = |n: u32, subject: &str| enforce_stop(&World::new(&format!("fp461-{n}")), &[(subject, "pending")], false);
    let idle = stop(0, "T-4 [P1] build the parser");
    assert!(idle.contains("no agent working"), "the twin: a plain pending task is idle: {idle}");
    for (n, subject) in ["T-4 [P1] OWNER: approve the flash", "T-5 [P2] needs owner decision on pricing", "T-6 [P1] hardware off limits - owner-gated"].iter().enumerate() {
        let out = stop(n as u32 + 1, subject);
        assert!(!out.contains("no agent working"), "owner-blocked {subject:?} is not idle: {out}");
    }
}

/// #467: the over-long-subject advisory fires on every breach (two different subjects of one length are two breaches) for both tools,
/// and a subject that is not `T-<n> [P] title` gets the shape advisory.
#[test]
fn the_subject_advisory_fires_per_breach_on_both_tools_and_checks_the_title_shape() {
    let w = World::new("fp467");
    let call = |tool: &str, subject: &str| {
        let input = if tool == "TaskCreate" { serde_json::json!({"subject": subject}) } else { serde_json::json!({"taskId": "1", "subject": subject}) };
        let p = serde_json::json!({"hook_event_name": "PostToolUse", "tool_name": tool, "session_id": "s1", "cwd": w.path("proj"), "tool_input": input});
        event_run(&w, "PostToolUse", tool, "tasklist-hygiene:post", &p, &[]).1
    };
    let a = format!("T-1 [P1] {}", "a".repeat(100));
    let b = format!("T-2 [P1] {}", "b".repeat(100));
    assert_eq!(a.len(), b.len());
    for (tool, s) in [("TaskCreate", &a), ("TaskCreate", &b), ("TaskUpdate", &a), ("TaskUpdate", &b)] {
        assert!(call(tool, s).contains("chars (max"), "{tool}: every over-long subject gets the advisory");
    }
    assert!(call("TaskCreate", "fix the parser").contains("T-<n> [P0-P3] title"), "an untagged subject gets the shape advisory");
    assert!(!call("TaskCreate", "T-9 [P2] fix the parser").contains("T-<n>"), "a well-shaped short subject is quiet");
}

/// #468: deleting a task that is not completed is denied (id and rule named); a completed one is allowed.
#[test]
fn an_open_task_cannot_be_deleted_and_the_tracker_nudge_quotes_the_request() {
    let w = World::new("fp468");
    std::fs::write(w.path("t.jsonl"), task_list(&[("T-1 [P1] open work", "pending"), ("T-2 [P1] done work", "completed")])).unwrap();
    let del = |id: &str| {
        let p = serde_json::json!({"hook_event_name": "PreToolUse", "tool_name": "TaskUpdate", "session_id": "s1", "cwd": w.path("proj"),
            "transcript_path": w.path("t.jsonl"), "tool_input": {"taskId": id, "status": "deleted"}});
        event_run(&w, "PreToolUse", "TaskUpdate", "tasklist-hygiene", &p, &[])
    };
    let (code, out, _) = del("1");
    assert_eq!(code, 2, "deleting an open task is denied: {out}");
    assert!(out.contains("task 1") && out.contains("not completed"), "the denial names the task and states the rule: {out}");
    assert_eq!(del("2").0, 0, "a completed task may be deleted");
    // the tracker nudge names the request it is about
    let prompt = serde_json::json!({"hook_event_name": "UserPromptSubmit", "session_id": "s1", "cwd": w.path("proj"), "prompt": "please rotate the signing key and update the docs"});
    let (_, out, _) = event_run(&w, "UserPromptSubmit", "", "task-tracker", &prompt, &[]);
    assert!(out.contains("rotate the signing key"), "the nudge quotes the untracked request: {out}");
}
