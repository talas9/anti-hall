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

// ---- R-idle (guards.idleRule, plan v2 section 4): the open-task Stop blocks skip tasks that are not idle and name the exact ids ----

/// One task of an R-idle transcript.
struct IdleTask {
    id: u32,
    subject: &'static str,
    description: &'static str,
    status: &'static str,
    owner: Option<&'static str>,
    blocked_on: Option<&'static str>,
}

fn idle_task(id: u32, subject: &'static str, status: &'static str) -> IdleTask {
    IdleTask { id, subject, description: "", status, owner: None, blocked_on: None }
}

/// A transcript holding `tasks` (created, then set to their status/owner/blockedOn) and one background `Agent` launch per
/// `(description, name)` of `agents` that never finishes (so the scan shows it running).
fn idle_transcript(tasks: &[IdleTask], agents: &[(&str, Option<&str>)]) -> String {
    use serde_json::json;
    let mut out = String::new();
    let ts = "2999-01-01T00:00:00.000Z";
    for t in tasks {
        let n = t.id;
        let create = json!({"type": "assistant", "message": {"id": format!("m{n}"), "role": "assistant", "content": [{"type": "tool_use", "id": format!("c{n}"), "name": "TaskCreate", "input": {"subject": t.subject, "description": t.description}}]}, "timestamp": ts});
        let result = json!({"type": "user", "message": {"role": "user", "content": [{"type": "tool_result", "tool_use_id": format!("c{n}"), "content": format!("Task #{n} created successfully: {}", t.subject)}]}, "timestamp": ts});
        let mut input = json!({"taskId": n.to_string(), "status": t.status});
        if let Some(o) = t.owner {
            input["owner"] = json!(o);
        }
        if let Some(b) = t.blocked_on {
            input["metadata"] = json!({"blockedOn": b});
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

/// Stop through the dispatcher for `transcript`, with the R-idle switch `on` or off; returns the decoded block reason, or `None` when
/// the Stop was not blocked.
fn idle_stop(name: &str, transcript: &str, on: bool, mode: Option<&str>) -> Option<String> {
    let w = World::new(name);
    std::fs::create_dir_all(w.path("home/.anti-hall")).unwrap();
    std::fs::write(w.path("t.jsonl"), transcript).unwrap();
    let mut p = serde_json::json!({"hook_event_name": "Stop", "session_id": "s1", "cwd": w.path("proj"), "transcript_path": w.path("t.jsonl")});
    if let Some(m) = mode {
        p["permission_mode"] = m.into();
    }
    let env: Vec<(&str, &str)> = if on { vec![("ANTIHALL_IDLE_RULE", "1")] } else { vec![] };
    let (code, out, err) = stop_run_env(&w, "task-guard", &p.to_string(), &env);
    assert_eq!(code, 0, "the engine answers; the Node hook must not run: {err}");
    assert_stdout_is_json_or_empty(&out, name);
    if out.trim().is_empty() {
        return None;
    }
    let v: serde_json::Value = serde_json::from_str(out.trim()).unwrap();
    (v["decision"] == "block").then(|| v["reason"].as_str().unwrap().to_string())
}

#[test]
fn idle_rule_off_keeps_the_earlier_block_text_and_on_names_the_ids_and_the_clearing_step() {
    let t = idle_transcript(&[idle_task(7, "build the thing", "in_progress"), idle_task(9, "write the docs", "in_progress")], &[]);
    let off = idle_stop("ir-off", &t, false, None).expect("today an unowned open task blocks");
    assert!(off.contains("open tasks remain unfinished") && !off.contains("#7"), "off: the earlier text, no ids: {off}");
    let on = idle_stop("ir-on", &t, true, None).expect("the same idle tasks still block with the switch on");
    assert!(on.contains("#7") && on.contains("#9"), "on: the exact ids: {on}");
    assert!(on.contains("blockedOn") && on.contains("description"), "on: the step that clears it (spawn an agent naming the id, or mark it blocked): {on}");
    assert!(!on.contains("open tasks remain unfinished"), "on: the new text: {on}");
}

#[test]
fn idle_rule_idle_block_names_the_dispatchable_ids_and_the_step() {
    let t = idle_transcript(&[idle_task(21, "[P1] port the check", "pending"), idle_task(22, "[P1] port the other check", "pending")], &[]);
    let on = idle_stop("ir-idle-on", &t, true, None).expect("two pending tasks and no agent: the idle block");
    assert!(on.contains("#21") && on.contains("#22") && on.contains("no live agent"), "{on}");
    assert!(on.contains("blockedOn"), "the clearing step: {on}");
}

/// The reported false positive: an open task whose agent is attached (the agent's description names it, or it is the task's owner) is not idle.
#[test]
fn idle_rule_skips_a_task_with_a_live_agent_attached() {
    // an agent whose description names the task
    let by_ref = idle_transcript(&[idle_task(361, "[P1] measure the baseline", "in_progress")], &[("#361 measure the baseline", None)]);
    assert!(idle_stop("ir-ref-off", &by_ref, false, None).is_some(), "today the generic block fires on it (the reported false positive)");
    assert!(idle_stop("ir-ref-on", &by_ref, true, None).is_none(), "on: an agent that names #361 attends it");
    // the task's owner is a running named agent
    let mut owned = idle_task(362, "[P1] port the wake", "in_progress");
    owned.owner = Some("wake-worker");
    let by_owner = idle_transcript(&[owned], &[("port the wake", Some("wake-worker"))]);
    assert!(idle_stop("ir-owner-on", &by_owner, true, None).is_none(), "on: a live owner agent attends it");
    // the twin: an agent that names ANOTHER task leaves #363 idle
    let other = idle_transcript(&[idle_task(363, "[P1] unattended", "in_progress")], &[("#364 something else", None)]);
    let still = idle_stop("ir-other-on", &other, true, None).expect("an agent naming another task does not attend #363");
    assert!(still.contains("#363"), "{still}");
}

#[test]
fn idle_rule_skips_tasks_that_are_parked_blocked_or_waiting_with_a_reason_and_names_only_the_idle_ones() {
    let mut blocked_on = idle_task(31, "[P1] a", "in_progress");
    blocked_on.blocked_on = Some("waiting on the CI run");
    let mut parked = idle_task(32, "[P1] b", "in_progress");
    parked.description = "PARKED: the owner has not decided the schema yet";
    let mut waiting = idle_task(33, "[P1] c", "in_progress");
    waiting.description = "Blocked on baseline run, waiting for load < 15";
    let mut clock = idle_task(34, "[P1] d", "in_progress");
    clock.description = "retry after 14:30 when the quota resets";
    let all_parked = idle_transcript(&[blocked_on, parked, waiting, clock], &[]);
    assert!(idle_stop("ir-parked-off", &all_parked, false, None).is_some(), "today every one of them blocks the Stop");
    assert!(idle_stop("ir-parked-on", &all_parked, true, None).is_none(), "on: every remaining task is parked/blocked/waiting with a reason");
    // a bare BLOCKED gives no reason: it stays idle; the parked one is left out of the list
    let mut bare = idle_task(41, "[P1] bare", "in_progress");
    bare.description = "BLOCKED";
    let mut ok = idle_task(42, "[P1] parked", "in_progress");
    ok.description = "blocked: waiting for the owner to approve";
    let mixed = idle_transcript(&[bare, ok], &[]);
    let r = idle_stop("ir-mixed-on", &mixed, true, None).expect("a bare BLOCKED still fires");
    assert!(r.contains("#41") && !r.contains("#42"), "only the idle task is named: {r}");
}

#[test]
fn idle_rule_is_quiet_in_plan_mode_and_blocks_the_same_tasks_outside_it() {
    let t = idle_transcript(&[idle_task(51, "[P1] plan target", "in_progress")], &[]);
    assert!(idle_stop("ir-plan-on", &t, true, Some("plan")).is_none(), "on: plan mode is quiet");
    assert!(idle_stop("ir-plan-off", &t, false, Some("plan")).is_some(), "off: unchanged, plan mode blocks as before");
    assert!(idle_stop("ir-default-on", &t, true, Some("default")).is_some(), "the twin: the same task outside plan mode blocks");
}

/// Review P1: an agent whose LAUNCH NAME (not its description) names the tasks attends them, for pending tasks too.
#[test]
fn idle_rule_skips_pending_tasks_named_by_an_agent_launch_name() {
    let tasks = || vec![idle_task(1, "[P1] first", "pending"), idle_task(2, "[P1] second", "pending")];
    let by_name = idle_transcript(&tasks(), &[("work on these tasks", Some("#1-#2-worker"))]);
    assert!(idle_stop("ir-name-on", &by_name, true, None).is_none(), "on: the launch name references #1 and #2");
    let by_desc = idle_transcript(&tasks(), &[("#1 #2 work on these tasks", None)]);
    assert!(idle_stop("ir-desc-on", &by_desc, true, None).is_none(), "on: the description references #1 and #2");
    // the twin: a launch name that names other tasks leaves them idle
    let other = idle_transcript(&tasks(), &[("work on these tasks", Some("#8-#9-worker"))]);
    let still = idle_stop("ir-name-other-on", &other, true, None).expect("a name naming other tasks does not attend #1 and #2");
    assert!(still.contains("#1") && still.contains("#2"), "{still}");
}

/// Review P2: actionable work that merely mentions a retry, or says "not blocked", is not parked or clock-waiting.
#[test]
fn idle_rule_does_not_treat_actionable_text_as_clock_waiting_or_blocked() {
    for (i, desc) in ["Implement retry after 2 minutes", "not blocked: implement the feature", "Unblocked: implement the feature"].iter().enumerate() {
        let mut t = idle_task(61, "[P1] real work", "in_progress");
        t.description = desc;
        let r = idle_stop(&format!("ir-fp-{i}"), &idle_transcript(&[t], &[]), true, None);
        assert!(r.is_some_and(|r| r.contains("#61")), "{desc:?} is actionable and must still fire");
    }
    // the twins: real clock waits and real parked markers still skip
    for (i, desc) in ["wait 5 minutes then recheck", "Blocked: waiting for CI", "[PARKED: owner undecided]"].iter().enumerate() {
        let mut t = idle_task(62, "[P1] waiting work", "in_progress");
        t.description = desc;
        assert!(idle_stop(&format!("ir-tw-{i}"), &idle_transcript(&[t], &[]), true, None).is_none(), "{desc:?} is a stated wait");
    }
}

// ---- #390: the task snapshot through two real Stops ----

/// `bytes` of transcript lines that name no task, appended to `path`.
fn snap_pad(path: &Path, bytes: usize) {
    let one =
        format!("{}\n", serde_json::json!({"type": "assistant", "message": {"role": "assistant", "content": [{"type": "text", "text": "x".repeat(900)}]}}));
    let mut f = std::fs::OpenOptions::new().append(true).open(path).unwrap();
    for _ in 0..bytes / one.len() + 1 {
        f.write_all(one.as_bytes()).unwrap();
    }
}

/// One Stop of session `s1` over `t.jsonl` of `w` with the R-idle switch on; the decoded block reason, or `None` when it passed.
fn snap_stop(w: &World) -> Option<String> {
    snap_stop_mode(w, None)
}

/// [`snap_stop`] in permission mode `mode`. Plan mode is quiet under R-idle, so a Stop there files the snapshot without announcing the
/// open set (a later Stop is not held back as "the same set twice").
fn snap_stop_mode(w: &World, mode: Option<&str>) -> Option<String> {
    let mut p = serde_json::json!({"hook_event_name": "Stop", "session_id": "s1", "cwd": w.path("proj"), "transcript_path": w.path("t.jsonl")});
    if let Some(m) = mode {
        p["permission_mode"] = m.into();
    }
    let (code, out, err) = stop_run_env(w, "task-guard", &p.to_string(), &[("ANTIHALL_IDLE_RULE", "1")]);
    assert_eq!(code, 0, "the engine answers; the Node hook must not run: {err}");
    assert_stdout_is_json_or_empty(&out, "snap_stop");
    if out.trim().is_empty() {
        return None;
    }
    let v: serde_json::Value = serde_json::from_str(out.trim()).unwrap();
    (v["decision"] == "block").then(|| v["reason"].as_str().unwrap().to_string())
}

/// The overnight shape through the real dispatcher: two idle tasks are announced by one Stop, a burst of transcript lines then pushes
/// their creates out of the tail window, and a later Stop that sees only the finishing of one of them must still name the other.
#[test]
fn snapshot_keeps_every_open_task_in_the_idle_block_after_the_creates_leave_the_tail() {
    let w = World::new("snap-stop");
    std::fs::create_dir_all(w.path("home/.anti-hall")).unwrap();
    let head = idle_transcript(&[idle_task(21, "[P1] port the check", "pending"), idle_task(22, "[P1] port the other check", "pending")], &[]);
    std::fs::write(w.path("t.jsonl"), &head).unwrap();
    let first = snap_stop(&w).expect("the first Stop sees both idle tasks");
    assert!(first.contains("#21") && first.contains("#22"), "{first}");
    assert!(snap_stop(&w).is_none(), "the same set is not announced twice");
    snap_pad(&w.path("t.jsonl"), 1_700_000);
    let update = serde_json::json!({"type": "assistant", "message": {"id": "u21", "role": "assistant", "content": [{"type": "tool_use", "id": "t21b", "name": "TaskUpdate", "input": {"taskId": "21", "status": "completed"}}]}, "timestamp": "2999-01-01T00:00:01.000Z"});
    let mut f = std::fs::OpenOptions::new().append(true).open(w.path("t.jsonl")).unwrap();
    writeln!(f, "{update}").unwrap();
    let second = snap_stop(&w).expect("the changed set is announced: the idle block on the second Stop");
    assert!(second.contains("#22") && !second.contains("#21"), "task #22 left the tail window but is still open, #21 is finished: {second}");
    let dir = w.path("home/.anti-hall/ah-engine/task-snapshots");
    // the kernel lock's file (#407) stays beside the snapshot and is no snapshot
    let names: Vec<String> = std::fs::read_dir(&dir).unwrap().flatten().map(|e| e.file_name().to_string_lossy().into_owned()).collect();
    assert_eq!(names.iter().filter(|n| n.ends_with(".json")).count(), 1, "one snapshot file under the isolated home: {names:?}");
    assert_eq!(names.iter().filter(|n| n.ends_with(".flock")).count(), 1, "and the persistent lock file: {names:?}");
}

/// A deleted task must not come back from the snapshot (the reviewer's repro): the tail ends with a `TaskGet` of #41 answered "not
/// found" and the finishing of #42, so nothing is open and the Stop passes; a Stop that still named #41 would re-announce a task that
/// no longer exists.
#[test]
fn snapshot_does_not_bring_back_a_task_the_tail_found_deleted() {
    let w = World::new("snap-deleted");
    std::fs::create_dir_all(w.path("home/.anti-hall")).unwrap();
    let head = idle_transcript(&[idle_task(41, "[P1] a task that is deleted", "pending"), idle_task(42, "[P1] a task that is finished", "pending")], &[]);
    std::fs::write(w.path("t.jsonl"), &head).unwrap();
    let first = snap_stop(&w).expect("the first Stop sees both idle tasks");
    assert!(first.contains("#41") && first.contains("#42"), "{first}");
    snap_pad(&w.path("t.jsonl"), 1_700_000);
    let get = serde_json::json!({"type": "assistant", "message": {"id": "g41", "role": "assistant", "content": [{"type": "tool_use", "id": "tg41", "name": "TaskGet", "input": {"taskId": "41"}}]}, "timestamp": "2999-01-01T00:00:01.000Z"});
    let gone = serde_json::json!({"type": "user", "message": {"role": "user", "content": [{"type": "tool_result", "tool_use_id": "tg41", "content": "Task #41 not found"}]}, "timestamp": "2999-01-01T00:00:02.000Z"});
    let done = serde_json::json!({"type": "assistant", "message": {"id": "u42", "role": "assistant", "content": [{"type": "tool_use", "id": "t42b", "name": "TaskUpdate", "input": {"taskId": "42", "status": "completed"}}]}, "timestamp": "2999-01-01T00:00:03.000Z"});
    let mut f = std::fs::OpenOptions::new().append(true).open(w.path("t.jsonl")).unwrap();
    writeln!(f, "{get}\n{gone}\n{done}").unwrap();
    let second = snap_stop(&w);
    assert!(second.is_none(), "task #41 was found deleted and #42 is finished: nothing is open, got {second:?}");
}

/// A `TaskUpdate` setting task `n` to `status`, appended to `t.jsonl` of `w`.
fn snap_update(w: &World, n: u32, status: &str) {
    let u = serde_json::json!({"type": "assistant", "message": {"id": format!("gu{n}"), "role": "assistant", "content": [{"type": "tool_use", "id": format!("tgu{n}"), "name": "TaskUpdate", "input": {"taskId": n.to_string(), "status": status}}]}, "timestamp": "2999-01-01T00:00:03.000Z"});
    let mut f = std::fs::OpenOptions::new().append(true).open(w.path("t.jsonl")).unwrap();
    writeln!(f, "{u}").unwrap();
}

/// The review's stale-block repro (#390 round 4): the snapshot was written by the Stop that announced the open tasks, the tasks were then
/// finished with no hook running, and a burst of lines pushed both the finishing and the creates out of the tail window. The
/// finishing sits in the gap between the snapshot's size and the tail's start; the rebuild must read it, not block on the stale list.
#[test]
fn snapshot_reads_the_gap_so_a_completion_the_tail_never_shows_does_not_leave_a_stale_block() {
    let w = World::new("snap-gap-done");
    std::fs::create_dir_all(w.path("home/.anti-hall")).unwrap();
    let head = idle_transcript(&[idle_task(1, "[P1] first", "pending"), idle_task(2, "[P1] second", "pending")], &[]);
    std::fs::write(w.path("t.jsonl"), &head).unwrap();
    assert!(snap_stop_mode(&w, Some("plan")).is_none(), "plan mode is quiet but the rebuild files the snapshot");
    snap_update(&w, 1, "completed");
    snap_update(&w, 2, "completed");
    snap_pad(&w.path("t.jsonl"), 1_800_000);
    let second = snap_stop(&w);
    assert!(second.is_none(), "both tasks were completed inside the gap: nothing is open, got {second:?}");
}

/// The twin: the gap holds the finishing of #1 only, so #2 is a true open task the tail cannot see and is still named.
#[test]
fn snapshot_reads_the_gap_and_still_names_the_open_task_the_tail_cannot_see() {
    let w = World::new("snap-gap-open");
    std::fs::create_dir_all(w.path("home/.anti-hall")).unwrap();
    let head = idle_transcript(&[idle_task(1, "[P1] first", "pending"), idle_task(2, "[P1] second", "pending")], &[]);
    std::fs::write(w.path("t.jsonl"), &head).unwrap();
    assert!(snap_stop_mode(&w, Some("plan")).is_none());
    snap_update(&w, 1, "completed");
    snap_pad(&w.path("t.jsonl"), 1_800_000);
    let second = snap_stop(&w).expect("#2 is open and its create left the tail: still blocked");
    assert!(second.contains("#2") && !second.contains("#1"), "{second}");
}

/// A gap over `taskstate.snapshot_gap_max_bytes` cannot be read: the evidence is uncertain, so the stale snapshot is not trusted and the
/// Stop does not block on snapshot-only tasks (fail-open), never a wrong permanent block.
#[test]
fn snapshot_with_an_unreadable_gap_fails_open_instead_of_blocking_on_a_stale_list() {
    let w = World::new("snap-gap-big");
    std::fs::create_dir_all(w.path("home/.anti-hall")).unwrap();
    settings_json(&w, r#"{"taskstate":{"snapshot_gap_max_bytes":1000}}"#);
    let head = idle_transcript(&[idle_task(1, "[P1] first", "pending"), idle_task(2, "[P1] second", "pending")], &[]);
    std::fs::write(w.path("t.jsonl"), &head).unwrap();
    assert!(snap_stop_mode(&w, Some("plan")).is_none());
    snap_update(&w, 1, "completed");
    snap_update(&w, 2, "completed");
    snap_pad(&w.path("t.jsonl"), 1_800_000);
    let second = snap_stop(&w);
    assert!(second.is_none(), "the gap is over the cap: the stale snapshot must not block, got {second:?}");
}

/// Switch parity (#390 round 4): `taskstate.snapshot_enabled` set false by the owner's settings file reaches the script (the switch is read
/// with `ah.cfgLive`; `ah.cfg` answers the shipped value only). Off, the answer is the tail alone: no snapshot file, and the list that left the tail is not brought back.
#[test]
fn snapshot_switch_off_in_the_owners_settings_is_the_tail_alone() {
    let run = |off: bool| {
        let w = World::new(if off { "snap-off" } else { "snap-on" });
        std::fs::create_dir_all(w.path("home/.anti-hall")).unwrap();
        if off {
            settings_json(&w, r#"{"taskstate":{"snapshot_enabled":false}}"#);
        }
        let head = idle_transcript(&[idle_task(21, "[P1] a", "pending"), idle_task(22, "[P1] b", "pending")], &[]);
        std::fs::write(w.path("t.jsonl"), &head).unwrap();
        snap_stop(&w);
        snap_pad(&w.path("t.jsonl"), 1_700_000);
        snap_update(&w, 21, "completed");
        let second = snap_stop(&w);
        (second, w.path("home/.anti-hall/ah-engine/task-snapshots").exists())
    };
    let (on, on_dir) = run(false);
    assert!(on_dir && on.is_some_and(|r| r.contains("#22")), "on: the snapshot keeps #22");
    let (off, off_dir) = run(true);
    assert!(!off_dir, "off: no snapshot file is written");
    assert!(off.is_none(), "off: the tail alone sees only the finishing of #21, as before the snapshot: {off:?}");
}

// ---- the nudge ladder (nudges.enabled, ANTIHALL_NUDGES) next to a task-guard whose own block cap lets the Stop pass ----

/// [`enforce_stop`] with extra environment for the one `ah-engine hook --event Stop` call.
fn enforce_stop_env(w: &World, rows: &[(&str, &str)], env: &[(&str, &str)]) -> String {
    std::fs::write(w.path("t.jsonl"), task_list(rows)).unwrap();
    let payload = serde_json::json!({"hook_event_name": "Stop", "session_id": "s1", "cwd": w.path("proj"), "transcript_path": w.path("t.jsonl")}).to_string();
    let (code, out, err) = stop_run_env(w, "task-guard", &payload, env);
    assert_eq!(code, 0, "the engine answers; the Node hook must not run: {err}");
    out
}

#[test]
fn the_ladder_adds_no_block_to_a_stop_a_capped_task_guard_let_pass() {
    let on = [("ANTIHALL_NUDGES", "1")];
    let w = World::new("ladder-capped");
    let rows = [("T-3 [Owner/blocked] wait", "pending")];
    // the open-task block counts as a fire of idle_open_tasks (P0): its ladder block is due, but this Stop is already blocked
    let open = enforce_stop_env(&w, &rows, &on);
    assert!(open.contains("\"decision\":\"block\"") && !open.contains("Required next"), "task-guard's own block, no stacked ladder block: {open}");
    let state = std::fs::read_to_string(w.path("state/nudge-ladder/s1.json")).expect("the ladder kept its state");
    assert!(state.contains("idle_open_tasks") && state.contains("\"pending\":true"), "the ladder block is held: {state}");
    for n in 1..=2 {
        let o = enforce_stop_env(&w, &rows, &on);
        assert!(o.contains("P0-P3") && !o.contains("Required next"), "block {n}: {o}");
    }
    // task-guard's cap is reached and it lets the Stop pass: the held ladder block must not turn that into a block
    let capped = enforce_stop_env(&w, &rows, &on);
    assert!(!capped.contains("block") && !capped.contains("Required next"), "the cap is reached: the Stop passes: {capped}");
}

#[test]
fn with_the_ladder_off_nothing_is_kept_or_added() {
    let w = World::new("ladder-off");
    let rows = [("T-3 [Owner/blocked] wait", "pending")];
    let open = enforce_stop_env(&w, &rows, &[("ANTIHALL_NUDGES", "0")]); // forced off: the shipped default may flip
    assert!(open.contains("\"decision\":\"block\"") && !open.contains("Required next"), "{open}");
    assert!(!w.path("state/nudge-ladder").exists(), "the switch is off: no ladder state is written");
}

/// One `UserPromptSubmit` through the dispatcher (every Node hook of the event a no-op), with the ladder switch given.
fn prompt_run_env(w: &World, payload: &str, env: &[(&str, &str)]) -> String {
    let map: serde_json::Map<String, serde_json::Value> = ids_for("UserPromptSubmit", "").iter().map(|id| (id.clone(), "true".into())).collect();
    let map_path = w.path("prompt-map.json");
    std::fs::write(&map_path, serde_json::json!({ "UserPromptSubmit": map }).to_string()).unwrap();
    let mut c = Command::new(env!("CARGO_BIN_EXE_ah-engine"));
    c.args(["hook", "--event", "UserPromptSubmit", "--fallback-map"])
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
    assert_eq!(o.status.code(), Some(0), "{}", String::from_utf8_lossy(&o.stderr));
    String::from_utf8_lossy(&o.stdout).into_owned()
}

/// One stalled-agent reminder row in the session's reminder queue (the text the tracker writes).
fn queue_stalled_reminder(w: &World, id: &str) {
    let dir = w.path("home/.anti-hall/agent-tracker/reminders");
    std::fs::create_dir_all(&dir).unwrap();
    let text = "agent tracker: subagent w1 is STALLED: no observable change (transcript, tool calls, commits, files) for 16m (running 40m). Last progress: \"a\". Message it, stop it, or re-dispatch it with a narrower brief.";
    let row = serde_json::json!({"id": id, "signal": "stalled", "agent": "w1", "text": text});
    let mut f = std::fs::OpenOptions::new().create(true).append(true).open(dir.join("s1.ndjson")).unwrap();
    writeln!(f, "{row}").unwrap();
}

#[test]
fn a_held_stall_escalation_adds_no_block_to_a_stop_a_capped_task_guard_let_pass() {
    let on = [("ANTIHALL_NUDGES", "1")];
    let w = World::new("ladder-capped-other-kind");
    let rows = [("T-3 [Owner/blocked] wait", "pending")];
    std::fs::write(w.path("t.jsonl"), task_list(&rows)).unwrap();
    let prompt = serde_json::json!({"hook_event_name": "UserPromptSubmit", "session_id": "s1", "cwd": w.path("proj"), "transcript_path": w.path("t.jsonl"), "prompt": "go"}).to_string();
    queue_stalled_reminder(&w, "r0");
    let first = prompt_run_env(&w, &prompt, &on);
    assert!(first.contains("anti-hall agent tracker:"), "the tracker's reminder reaches the prompt (the digest cut keeps its header): {first}");
    let open = enforce_stop_env(&w, &rows, &on);
    assert!(open.contains("\"decision\":\"block\"") && !open.contains("Required next"), "task-guard's own block, no stacked ladder block: {open}");
    queue_stalled_reminder(&w, "r1");
    prompt_run_env(&w, &prompt, &on);
    let state = std::fs::read_to_string(w.path("state/nudge-ladder/s1.json")).expect("the ladder kept its state");
    assert!(state.contains("stalled_agents") && state.contains("\"pending\":true"), "the stall escalation is due and held: {state}");
    for n in 1..=2 {
        let o = enforce_stop_env(&w, &rows, &on);
        assert!(o.contains("P0-P3") && !o.contains("Required next"), "block {n}: {o}");
    }
    // task-guard's cap is reached and it lets the Stop pass: a held block of ANOTHER kind must not turn that into a block
    let capped = enforce_stop_env(&w, &rows, &on);
    assert!(!capped.contains("block") && !capped.contains("Required next"), "the cap is reached: the Stop passes: {capped}");
    let off = World::new("ladder-capped-other-kind-off");
    queue_stalled_reminder(&off, "r0");
    std::fs::write(off.path("t.jsonl"), task_list(&rows)).unwrap();
    assert!(
        !prompt_run_env(&off, &prompt.replace(&w.path("proj").to_string_lossy().to_string(), &off.path("proj").to_string_lossy()), &[("ANTIHALL_NUDGES", "0")])
            .contains("Required next")
    );
    assert!(!off.path("state/nudge-ladder").exists(), "the switch is off: no ladder state is written");
}

// ---- the ladder as a state machine: the guard's pass is absolute, a resolved fact clears its entry (class fix, GH #518) ----

/// The tracker's persisted state with one child `w1` of session `s1`; `stalled` says whether its `stalled` signal is up. `None` writes
/// no state file at all (the tracker never ran or its file is gone).
fn tracker_state(w: &World, stalled: Option<bool>) {
    let path = w.path("home/.anti-hall/agent-tracker/state.json");
    let Some(stalled) = stalled else {
        ah_engine::discard::harmless(std::fs::remove_file(&path));
        return;
    };
    let mut st = ah_engine::agents::State::default();
    let mut a = ah_engine::agents::Agent { id: "w1".into(), kind: "subagent".into(), parent: "s1".into(), ..Default::default() };
    if stalled {
        a.flags.insert("stalled".into(), ah_engine::agents::Flag::default());
    }
    st.agents.insert("w1".into(), a);
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(path, serde_json::to_string(&st).unwrap()).unwrap();
}

fn ladder_state(w: &World) -> String {
    std::fs::read_to_string(w.path("state/nudge-ladder/s1.json")).unwrap_or_default()
}

fn stalled_prompt(w: &World, rows: &[(&str, &str)]) -> String {
    std::fs::write(w.path("t.jsonl"), task_list(rows)).unwrap();
    serde_json::json!({"hook_event_name": "UserPromptSubmit", "session_id": "s1", "cwd": w.path("proj"), "transcript_path": w.path("t.jsonl"), "prompt": "go"})
        .to_string()
}

/// Two stalled reminders delivered (the stall kind escalates at its second fire) and the session's tasks written.
fn two_stall_fires(w: &World, rows: &[(&str, &str)], on: &[(&str, &str)]) {
    let prompt = stalled_prompt(w, rows);
    queue_stalled_reminder(w, "r0");
    prompt_run_env(w, &prompt, on);
    enforce_stop_env(w, rows, on); // a Stop ends the turn: the next reminder is a new fire
    queue_stalled_reminder(w, "r1");
    prompt_run_env(w, &prompt, on);
}

const ON: [(&str, &str); 1] = [("ANTIHALL_NUDGES", "1")];

#[test]
fn the_guards_cap_is_absolute_no_count_of_permitted_stops_turns_a_held_stall_into_a_block() {
    // finding 1: the hold used to expire after `held_pass_stops` permitted Stops and the pending stall escalation then blocked a Stop
    // that task-guard's cap still permitted
    let w = World::new("ladder-cap-absolute");
    let rows = [("T-3 [Owner/blocked] wait", "pending")];
    tracker_state(&w, Some(true)); // the stall is real: only the guard's pass keeps the ladder from blocking
    two_stall_fires(&w, &rows, &ON);
    assert!(ladder_state(&w).contains("stalled_agents|w1"), "the stall escalation is due: {}", ladder_state(&w));
    let mut passes = 0;
    for n in 1..=16 {
        let o = enforce_stop_env(&w, &rows, &ON);
        if !o.contains("P0-P3") && !o.contains("\"decision\":\"block\"") {
            passes += 1;
        }
        assert!(!o.contains("Required next"), "Stop {n}: the ladder never blocks a Stop task-guard's cap permits: {o}");
    }
    assert!(passes >= 10, "the cap was reached and kept passing ({passes} passes)");
}

#[test]
fn a_resolved_stall_clears_its_entry_and_can_no_longer_block_a_stop() {
    // finding 2: the tracker's state says the agent is no longer stalled, but the reminder was delivered earlier
    let w = World::new("ladder-stall-resolved");
    let empty: [(&str, &str); 0] = [];
    tracker_state(&w, Some(true));
    two_stall_fires(&w, &empty, &ON);
    assert!(ladder_state(&w).contains("stalled_agents|w1") && ladder_state(&w).contains("\"pending\":true"), "due: {}", ladder_state(&w));
    tracker_state(&w, Some(false)); // the agent made progress: the stall is over
    let o = enforce_stop_env(&w, &empty, &ON);
    assert!(!o.contains("Required next") && !o.contains("\"decision\""), "a resolved stall blocks nothing: {o}");
    assert!(!ladder_state(&w).contains("stalled_agents"), "and its entry is gone: {}", ladder_state(&w));
}

#[test]
fn a_stall_that_is_still_up_blocks_the_stop_once_the_guard_holds_nothing() {
    // the positive control of the two tests above: the same flow with the stall still up does block, so the ladder is not just muted
    let w = World::new("ladder-stall-up");
    let empty: [(&str, &str); 0] = [];
    tracker_state(&w, Some(true));
    two_stall_fires(&w, &empty, &ON);
    let o = enforce_stop_env(&w, &empty, &ON);
    assert!(o.contains("Required next") && o.contains("message the stalled agent"), "{o}");
    let again = enforce_stop_env(&w, &empty, &ON);
    assert!(!again.contains("Required next"), "shown once, not again at the next Stop: {again}");
}

#[test]
fn a_stall_whose_fact_cannot_be_read_blocks_nothing_and_stays_owed() {
    let w = World::new("ladder-stall-unreadable");
    let empty: [(&str, &str); 0] = [];
    tracker_state(&w, Some(true));
    two_stall_fires(&w, &empty, &ON);
    tracker_state(&w, None); // the tracker's state is gone
    let o = enforce_stop_env(&w, &empty, &ON);
    assert!(!o.contains("Required next"), "an unverifiable stall is no block: {o}");
    assert!(ladder_state(&w).contains("\"pending\":true"), "it stays owed: {}", ladder_state(&w));
    tracker_state(&w, Some(true)); // readable again, still stalled
    assert!(enforce_stop_env(&w, &empty, &ON).contains("Required next"), "and is shown once it can be verified");
}

#[test]
fn the_guards_hold_ends_when_its_tasks_are_done_not_after_a_count_of_stops() {
    let w = World::new("ladder-hold-ends");
    let open = [("T-3 [Owner/blocked] wait", "pending")];
    let done = [("T-3 [Owner/blocked] wait", "completed")];
    tracker_state(&w, Some(true));
    two_stall_fires(&w, &open, &ON); // task-guard blocked the first Stop: it has a mark
    for _ in 0..3 {
        enforce_stop_env(&w, &open, &ON); // its cap is reached
    }
    assert!(!enforce_stop_env(&w, &open, &ON).contains("Required next"), "held while the task is open");
    let o = enforce_stop_env(&w, &done, &ON); // the task is done: the guard has nothing left to hold
    assert!(o.contains("Required next"), "the stall escalation is shown once the guard's condition is gone: {o}");
}

#[test]
fn with_the_ladder_forced_off_a_stall_is_never_kept_or_blocked() {
    let off = [("ANTIHALL_NUDGES", "0")];
    let w = World::new("ladder-forced-off");
    let empty: [(&str, &str); 0] = [];
    tracker_state(&w, Some(true));
    two_stall_fires(&w, &empty, &off);
    let o = enforce_stop_env(&w, &empty, &off);
    assert!(!o.contains("Required next"), "{o}");
    assert!(!w.path("state/nudge-ladder").exists(), "the switch is off: no ladder state is written");
}

// ---- the ladder as a state machine over per-agent entries and the guard's own record (class fix round 3, GH #518) ----

/// The tracker's persisted state: each `(id, parent, signals up)` an agent of session `s1` (a parent of `s1` is a child of the session,
/// any other parent makes a grandchild).
fn tracker_agents(w: &World, agents: &[(&str, &str, &[&str])]) {
    let mut st = ah_engine::agents::State::default();
    for (id, parent, flags) in agents {
        let mut a = ah_engine::agents::Agent { id: (*id).into(), kind: "subagent".into(), parent: (*parent).into(), ..Default::default() };
        for f in *flags {
            a.flags.insert((*f).into(), ah_engine::agents::Flag::default());
        }
        st.agents.insert((*id).into(), a);
    }
    let path = w.path("home/.anti-hall/agent-tracker/state.json");
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(path, serde_json::to_string(&st).unwrap()).unwrap();
}

/// One reminder row about `agent` in the session's queue. `named` false writes a row that names no agent.
fn queue_reminder(w: &World, id: &str, agent: &str, named: bool) {
    let dir = w.path("home/.anti-hall/agent-tracker/reminders");
    std::fs::create_dir_all(&dir).unwrap();
    let text = format!(
        "agent tracker: subagent {agent} is STALLED: no observable change (transcript, tool calls, commits, files) for 16m. Message it, stop it, or re-dispatch it with a narrower brief."
    );
    let mut row = serde_json::json!({"id": id, "signal": "stalled", "text": text});
    if named {
        row["agent"] = agent.into();
    }
    let mut f = std::fs::OpenOptions::new().create(true).append(true).open(dir.join("s1.ndjson")).unwrap();
    writeln!(f, "{row}").unwrap();
}

fn settings_json(w: &World, body: &str) {
    std::fs::create_dir_all(w.path("home/.anti-hall")).unwrap();
    std::fs::write(w.path("home/.anti-hall/settings.json"), body).unwrap();
}

const OPEN: [(&str, &str); 1] = [("T-3 [Owner/blocked] wait", "pending")];
const DONE: [(&str, &str); 1] = [("T-3 [Owner/blocked] wait", "completed")];
const OFF: [(&str, &str); 1] = [("ANTIHALL_NUDGES", "0")];

/// Stop until task-guard's own blocks are spent (the idle block, then the priority-tag blocks): the number of Stops that blocked.
fn run_to_the_cap(w: &World, rows: &[(&str, &str)], env: &[(&str, &str)]) -> usize {
    let blocks = (0..8).filter(|_| enforce_stop_env(w, rows, env).contains("\"decision\":\"block\"")).count();
    assert_eq!(blocks, 3, "task-guard blocks the idle set once and the priority tag twice, then lets the Stop pass");
    blocks
}

/// `n` stalled-reminder deliveries about `agents` (one prompt each, a Stop in between ends the turn): the escalation of each is due
/// after the second.
fn remind_twice(w: &World, rows: &[(&str, &str)], agents: &[&str], env: &[(&str, &str)]) {
    let prompt = stalled_prompt(w, rows);
    for (round, ids) in [("r0", "a"), ("r1", "b")] {
        for agent in agents {
            queue_reminder(w, &format!("{round}{ids}{agent}"), agent, true);
        }
        prompt_run_env(w, &prompt, env);
        if round == "r0" {
            enforce_stop_env(w, rows, env);
        }
    }
}

fn required_next(out: &str) -> bool {
    out.contains("Required next")
}

#[test]
fn a_pending_stall_never_blocks_a_stop_task_guards_cap_lets_pass_with_the_idle_kind_switched_off() {
    // round 2 finding 1: with the kind off the ladder keeps no history of task-guard, yet the cap still decides the Stop
    let w = World::new("l3-kind-off");
    settings_json(&w, r#"{"nudges":{"kinds":{"idle_open_tasks":"off"}}}"#);
    tracker_agents(&w, &[("w1", "s1", &["stalled"])]);
    run_to_the_cap(&w, &OPEN, &ON);
    remind_twice(&w, &OPEN, &["w1"], &ON);
    assert!(ladder_state(&w).contains("stalled_agents|w1") && ladder_state(&w).contains("\"pending\":true"), "due: {}", ladder_state(&w));
    for n in 1..=12 {
        let o = enforce_stop_env(&w, &OPEN, &ON);
        assert!(!required_next(&o) && !o.contains("\"decision\""), "Stop {n}: the cap permits it: {o}");
    }
    assert!(enforce_stop_env(&w, &DONE, &ON).contains("Required next"), "positive control: with the tasks done the guard holds nothing and the stall is shown");
}

#[test]
fn a_pending_stall_never_blocks_a_stop_a_cap_reached_before_the_ladder_was_enabled_lets_pass() {
    // round 2 finding 1, second path: the ladder never saw task-guard block
    let w = World::new("l3-late-enable");
    tracker_agents(&w, &[("w1", "s1", &["stalled"])]);
    run_to_the_cap(&w, &OPEN, &OFF);
    assert!(!w.path("state/nudge-ladder").exists(), "the ladder was off: it kept nothing");
    remind_twice(&w, &OPEN, &["w1"], &ON);
    for n in 1..=12 {
        let o = enforce_stop_env(&w, &OPEN, &ON);
        assert!(!required_next(&o) && !o.contains("\"decision\""), "Stop {n}: {o}");
    }
    assert!(enforce_stop_env(&w, &DONE, &ON).contains("Required next"), "positive control");
}

#[test]
fn the_guards_own_record_holds_after_the_ladders_state_is_lost() {
    let w = World::new("l3-state-lost");
    tracker_agents(&w, &[("w1", "s1", &["stalled"])]);
    run_to_the_cap(&w, &OPEN, &ON);
    ah_engine::discard::harmless(std::fs::remove_dir_all(w.path("state/nudge-ladder"))); // pruned, or the session's file was removed
    remind_twice(&w, &OPEN, &["w1"], &ON);
    for n in 1..=6 {
        let o = enforce_stop_env(&w, &OPEN, &ON);
        assert!(!required_next(&o) && !o.contains("\"decision\""), "Stop {n}: {o}");
    }
}

#[test]
fn a_guard_that_is_switched_off_holds_nothing_even_with_its_old_record_on_disk() {
    let w = World::new("l3-guard-off");
    tracker_agents(&w, &[("w1", "s1", &["stalled"])]);
    run_to_the_cap(&w, &OPEN, &ON);
    remind_twice(&w, &OPEN, &["w1"], &ON);
    assert!(!required_next(&enforce_stop_env(&w, &OPEN, &ON)), "held while task-guard is on");
    settings_json(&w, r#"{"guards":{"taskGuard":false}}"#);
    assert!(required_next(&enforce_stop_env(&w, &OPEN, &ON)), "task-guard is off: it permits nothing, so nothing is contradicted");
}

#[test]
fn the_cap_holds_with_both_task_guard_block_kinds_counted_in_total() {
    // N Stops: task-guard's three blocks, then the ladder adds none: the blocks of the whole run are exactly task-guard's
    let w = World::new("l3-total");
    tracker_agents(&w, &[("w1", "s1", &["stalled"])]);
    let prompt = stalled_prompt(&w, &OPEN);
    let mut blocks = 0;
    for n in 0..20 {
        if n == 1 || n == 3 {
            queue_reminder(&w, &format!("r{n}"), "w1", true);
            prompt_run_env(&w, &prompt, &ON);
        }
        let o = enforce_stop_env(&w, &OPEN, &ON);
        blocks += usize::from(o.contains("\"decision\":\"block\""));
        assert!(!required_next(&o), "Stop {n}: {o}");
    }
    assert_eq!(blocks, 3, "exactly task-guard's own three blocks over 20 Stops");
}

#[test]
fn a_stop_hook_active_stop_never_carries_a_ladder_block_even_when_nothing_holds_it() {
    let w = World::new("l3-active");
    tracker_agents(&w, &[("w1", "s1", &["stalled"])]);
    let empty: [(&str, &str); 0] = [];
    remind_twice(&w, &empty, &["w1"], &ON);
    std::fs::write(w.path("t.jsonl"), task_list(&empty)).unwrap();
    let active = serde_json::json!({"hook_event_name": "Stop", "session_id": "s1", "stop_hook_active": true, "cwd": w.path("proj"), "transcript_path": w.path("t.jsonl")}).to_string();
    let (code, out, _) = stop_run_env(&w, "task-guard", &active, &ON);
    assert_eq!((code, required_next(&out)), (0, false), "{out}");
    assert!(ladder_state(&w).contains("\"pending\":true"), "held for the next Stop: {}", ladder_state(&w));
    assert!(required_next(&enforce_stop_env(&w, &empty, &ON)), "and shown at the next one that may carry it");
}

#[test]
fn a_resolved_workers_escalation_does_not_survive_through_another_worker() {
    // round 2 finding 2: w1 was reminded twice and has since recovered; w2 stalls and has had no reminder
    let w = World::new("l3-w1-w2");
    let empty: [(&str, &str); 0] = [];
    tracker_agents(&w, &[("w1", "s1", &["stalled"])]);
    remind_twice(&w, &empty, &["w1"], &ON);
    assert!(ladder_state(&w).contains("stalled_agents|w1"), "{}", ladder_state(&w));
    tracker_agents(&w, &[("w1", "s1", &[]), ("w2", "s1", &["stalled"])]);
    let o = enforce_stop_env(&w, &empty, &ON);
    assert!(!required_next(&o) && !o.contains("\"decision\""), "w2 has had no reminder: {o}");
    assert!(!ladder_state(&w).contains("stalled_agents"), "and w1's entry is gone: {}", ladder_state(&w));
    let again = enforce_stop_env(&w, &empty, &ON);
    assert!(!required_next(&again), "and stays gone: {again}");
}

#[test]
fn a_worker_that_is_finished_dead_or_gone_ends_its_escalation_whatever_its_flags_say() {
    for how in ["finished", "dead", "gone"] {
        let w = World::new(&format!("l3-{how}"));
        let empty: [(&str, &str); 0] = [];
        tracker_agents(&w, &[("w1", "s1", &["stalled"])]);
        remind_twice(&w, &empty, &["w1"], &ON);
        let path = w.path("home/.anti-hall/agent-tracker/state.json");
        let mut st: ah_engine::agents::State = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        let a = st.agents.get_mut("w1").unwrap();
        match how {
            "finished" => a.finished = true,
            "dead" => a.dead = true,
            _ => a.gone = true,
        }
        std::fs::write(&path, serde_json::to_string(&st).unwrap()).unwrap();
        assert!(!required_next(&enforce_stop_env(&w, &empty, &ON)), "{how}: its stale flag blocks nothing");
        assert!(!ladder_state(&w).contains("stalled_agents"), "{how}: {}", ladder_state(&w));
    }
}

#[test]
fn two_workers_reminded_once_each_do_not_escalate_and_the_one_reminded_twice_does() {
    let w = World::new("l3-once-each");
    let empty: [(&str, &str); 0] = [];
    tracker_agents(&w, &[("w1", "s1", &["stalled"]), ("w2", "s1", &["stalled"])]);
    let prompt = stalled_prompt(&w, &empty);
    queue_reminder(&w, "a1", "w1", true);
    queue_reminder(&w, "a2", "w2", true);
    prompt_run_env(&w, &prompt, &ON);
    assert!(!required_next(&enforce_stop_env(&w, &empty, &ON)), "one reminder each: neither is due");
    queue_reminder(&w, "b1", "w1", true);
    prompt_run_env(&w, &prompt, &ON);
    let st = ladder_state(&w);
    assert!(st.contains("stalled_agents|w1") && st.contains("stalled_agents|w2"), "each worker has its own entry: {st}");
    let o = enforce_stop_env(&w, &empty, &ON);
    assert!(required_next(&o) && o.contains("Shown 2x"), "w1 was reminded twice: {o}");
}

#[test]
fn a_worker_that_recovers_and_stalls_again_starts_counting_from_one() {
    let w = World::new("l3-restall");
    let empty: [(&str, &str); 0] = [];
    tracker_agents(&w, &[("w1", "s1", &["stalled"])]);
    remind_twice(&w, &empty, &["w1"], &ON);
    tracker_agents(&w, &[("w1", "s1", &[])]);
    assert!(!required_next(&enforce_stop_env(&w, &empty, &ON)), "recovered");
    tracker_agents(&w, &[("w1", "s1", &["stalled"])]);
    queue_reminder(&w, "c0", "w1", true);
    prompt_run_env(&w, &stalled_prompt(&w, &empty), &ON);
    assert!(!required_next(&enforce_stop_env(&w, &empty, &ON)), "one reminder of the new stall: not due");
}

#[test]
fn a_stall_still_up_blocks_when_another_worker_that_was_also_reminded_twice_has_recovered() {
    let w = World::new("l3-other-recovers");
    let empty: [(&str, &str); 0] = [];
    tracker_agents(&w, &[("w1", "s1", &["stalled"]), ("w2", "s1", &["stalled"])]);
    remind_twice(&w, &empty, &["w1", "w2"], &ON);
    tracker_agents(&w, &[("w1", "s1", &["stalled"]), ("w2", "s1", &[])]);
    let o = enforce_stop_env(&w, &empty, &ON);
    assert!(required_next(&o), "w1 is still stalled and was reminded twice: {o}");
    let st = ladder_state(&w);
    assert!(!st.contains("stalled_agents|w2") && st.contains("stalled_agents|w1"), "{st}");
}

#[test]
fn a_grandchild_is_a_subject_too() {
    let w = World::new("l3-grandchild");
    let empty: [(&str, &str); 0] = [];
    tracker_agents(&w, &[("w1", "s1", &[]), ("w3", "w1", &["stalled"])]);
    remind_twice(&w, &empty, &["w3"], &ON);
    assert!(required_next(&enforce_stop_env(&w, &empty, &ON)), "a stalled grandchild of the session escalates");
    let w2 = World::new("l3-grandchild-done");
    tracker_agents(&w2, &[("w1", "s1", &[]), ("w3", "w1", &["stalled"])]);
    remind_twice(&w2, &empty, &["w3"], &ON);
    tracker_agents(&w2, &[("w1", "s1", &["stalled"]), ("w3", "w1", &[])]);
    assert!(!required_next(&enforce_stop_env(&w2, &empty, &ON)), "the grandchild recovered; its parent stalling is not its escalation");
}

#[test]
fn a_reminder_that_names_no_worker_is_not_counted_and_blocks_nothing() {
    let w = World::new("l3-unnamed");
    let empty: [(&str, &str); 0] = [];
    tracker_agents(&w, &[("w1", "s1", &["stalled"])]);
    let prompt = stalled_prompt(&w, &empty);
    for n in 0..4 {
        queue_reminder(&w, &format!("n{n}"), "w1", false);
        prompt_run_env(&w, &prompt, &ON);
        let o = enforce_stop_env(&w, &empty, &ON);
        assert!(!required_next(&o), "Stop {n}: {o}");
    }
    assert!(!ladder_state(&w).contains("stalled_agents"), "{}", ladder_state(&w));
}

// ---- the ladder never blocks a Stop task-guard's cap permits, whichever store holds the open tasks (class fix round 4, GH #518) ----
//
// task-guard reads Claude Code's own task store first and the transcript only when the session has no readable store. The ladder
// must read the same list, or it takes a list the guard still sees as open for "done" and lifts the hold over the guard's cap.

/// Where the Stop's `transcript_path` points.
#[derive(Clone, Copy)]
enum Tx {
    /// A transcript that creates these tasks (subject, status).
    Rows(&'static [(&'static str, &'static str)]),
    /// A path no file is at.
    Missing,
    /// No `transcript_path` in the payload.
    Omitted,
    /// A transcript that creates these tasks and then runs on for this many bytes of other conversation: the creates are further back
    /// than the tasklist gate's scan window and inside task-guard's tail.
    Deep(&'static [(&'static str, &'static str)], usize),
}

const NO_ROWS: Tx = Tx::Rows(&[]);

fn tx_payload(w: &World, event: &str, tx: Tx) -> serde_json::Value {
    let mut p = serde_json::json!({"hook_event_name": event, "session_id": "s1", "cwd": w.path("proj")});
    match tx {
        Tx::Rows(rows) => {
            std::fs::write(w.path("t.jsonl"), task_list(rows)).unwrap();
            p["transcript_path"] = w.path("t.jsonl").to_string_lossy().into_owned().into();
        }
        Tx::Deep(rows, pad) => {
            let filler = serde_json::json!({"type": "user", "message": {"role": "user", "content": "x".repeat(900)}}).to_string();
            let mut body = task_list(rows);
            while body.len() < pad {
                body.push_str(&filler);
                body.push('\n');
            }
            std::fs::write(w.path("t.jsonl"), body).unwrap();
            p["transcript_path"] = w.path("t.jsonl").to_string_lossy().into_owned().into();
        }
        Tx::Missing => p["transcript_path"] = w.path("no-such-transcript.jsonl").to_string_lossy().into_owned().into(),
        Tx::Omitted => {}
    }
    p
}

fn stop_tx(w: &World, tx: Tx) -> String {
    let (code, out, err) = stop_run_env(w, "task-guard", &tx_payload(w, "Stop", tx).to_string(), &ON);
    assert_eq!(code, 0, "the engine answers; the Node hook must not run: {err}");
    out
}

fn prompt_tx(w: &World, tx: Tx) {
    let mut p = tx_payload(w, "UserPromptSubmit", tx);
    p["prompt"] = "go".into();
    prompt_run_env(w, &p.to_string(), &ON);
}

/// A task file in the session's store directory `dir` (`<home>/.claude/tasks/<dir>/<file>`).
fn store_put(w: &World, dir: &str, file: &str, body: &str) {
    let d = w.path("home/.claude/tasks").join(dir);
    std::fs::create_dir_all(&d).unwrap();
    std::fs::write(d.join(file), body).unwrap();
}

fn store_task(w: &World, dir: &str, n: u32, status: &str) {
    let rec =
        serde_json::json!({"id": n.to_string(), "subject": "T-3 [Owner/blocked] wait", "description": "d", "status": status, "blocks": [], "blockedBy": []});
    store_put(w, dir, &format!("{n}.json"), &rec.to_string());
}

/// The whole flow: task-guard blocks until its cap is spent (`first` transcript), a stall escalation falls due, and every Stop after
/// that (`later` transcript) passes with no ladder block for as long as the store holds an open task; then `finish` ends the tasks
/// and the stall is shown (the positive control: the ladder is not just muted).
fn the_ladder_leaves_a_capped_stop_alone(name: &str, first: Tx, later: Tx, seed: impl Fn(&World), finish: impl Fn(&World)) {
    the_ladder_leaves_a_capped_stop_alone_then(name, first, later, later, seed, finish);
}

/// [`the_ladder_leaves_a_capped_stop_alone`] with the transcript of the control Stop (after `finish`) given.
fn the_ladder_leaves_a_capped_stop_alone_then(name: &str, first: Tx, later: Tx, control: Tx, seed: impl Fn(&World), finish: impl Fn(&World)) {
    let w = World::new(name);
    tracker_agents(&w, &[("w1", "s1", &["stalled"])]);
    seed(&w);
    let blocks = (0..8).filter(|_| stop_tx(&w, first).contains("\"decision\":\"block\"")).count();
    assert_eq!(blocks, 3, "{name}: task-guard blocks the idle set once and the priority tag twice, then its cap lets the Stop pass");
    for (round, id) in ["a", "b"].iter().enumerate() {
        queue_reminder(&w, &format!("r{id}"), "w1", true);
        prompt_tx(&w, first);
        if round == 0 {
            stop_tx(&w, first); // the turn ends: the next reminder is a new fire
        }
    }
    assert!(ladder_state(&w).contains("stalled_agents|w1") && ladder_state(&w).contains("\"pending\":true"), "{name}: due: {}", ladder_state(&w));
    for n in 1..=12 {
        let o = stop_tx(&w, later);
        assert!(!required_next(&o) && !o.contains("\"decision\""), "{name}: Stop {n}: the cap permits it and the ladder adds nothing: {o}");
    }
    finish(&w);
    let o = stop_tx(&w, control);
    assert!(required_next(&o), "{name}: positive control, the tasks are done and the stall is shown: {o}");
}

fn finish_store(dir: &'static str) -> impl Fn(&World) {
    move |w| store_task(w, dir, 1, "completed")
}

#[test]
fn the_cap_holds_when_the_open_task_is_only_in_the_task_store_and_the_transcript_is_empty() {
    // review round 2, A1
    the_ladder_leaves_a_capped_stop_alone("s4-a1", NO_ROWS, NO_ROWS, |w| store_task(w, "session-s1", 1, "pending"), finish_store("session-s1"));
}

#[test]
fn the_cap_holds_when_the_store_says_open_and_the_transcript_says_completed() {
    // review round 2, A2: the store is the list, an old transcript tail disagrees with it
    let done: Tx = Tx::Rows(&[("T-3 [Owner/blocked] wait", "completed")]);
    the_ladder_leaves_a_capped_stop_alone("s4-a2", done, done, |w| store_task(w, "session-s1", 1, "pending"), finish_store("session-s1"));
}

#[test]
fn the_cap_holds_when_the_transcript_file_is_gone_and_the_store_still_has_the_task() {
    the_ladder_leaves_a_capped_stop_alone("s4-missing", NO_ROWS, Tx::Missing, |w| store_task(w, "session-s1", 1, "pending"), finish_store("session-s1"));
}

#[test]
fn the_cap_holds_when_the_stop_payload_names_no_transcript() {
    the_ladder_leaves_a_capped_stop_alone("s4-omitted", NO_ROWS, Tx::Omitted, |w| store_task(w, "session-s1", 1, "pending"), finish_store("session-s1"));
}

#[test]
fn the_cap_holds_for_a_store_kept_under_the_full_session_id() {
    // the second candidate directory name (`{sid}`) of taskstate.store_dir_names
    the_ladder_leaves_a_capped_stop_alone("s4-sid-dir", NO_ROWS, NO_ROWS, |w| store_task(w, "s1", 1, "pending"), finish_store("s1"));
}

#[test]
fn the_cap_holds_for_a_status_in_any_letter_case() {
    the_ladder_leaves_a_capped_stop_alone(
        "s4-case",
        NO_ROWS,
        NO_ROWS,
        |w| store_task(w, "session-s1", 1, "Pending"),
        |w| store_task(w, "session-s1", 1, "COMPLETED"),
    );
}

#[test]
fn the_cap_holds_when_one_of_several_store_tasks_is_open() {
    the_ladder_leaves_a_capped_stop_alone(
        "s4-mixed",
        NO_ROWS,
        NO_ROWS,
        |w| {
            store_task(w, "session-s1", 1, "completed");
            store_task(w, "session-s1", 2, "pending");
            store_task(w, "session-s1", 3, "cancelled");
        },
        |w| store_task(w, "session-s1", 2, "completed"),
    );
}

#[test]
fn the_cap_holds_when_the_store_has_files_that_are_not_tasks_next_to_the_open_one() {
    the_ladder_leaves_a_capped_stop_alone(
        "s4-junk",
        NO_ROWS,
        NO_ROWS,
        |w| {
            store_task(w, "session-s1", 1, "pending");
            store_put(w, "session-s1", "2.json", "{not json");
            store_put(w, "session-s1", "3.json", r#"{"id":"3","subject":"x","status":7}"#);
            store_put(w, "session-s1", "4.json", "[1,2]");
            store_put(w, "session-s1", ".lock", "");
            store_put(w, "session-s1", ".highwatermark", "9");
            store_put(w, "session-s1", "5.json.tmp", r#"{"id":"5","subject":"x","status":"completed"}"#);
        },
        finish_store("session-s1"),
    );
}

#[test]
fn the_cap_holds_for_a_store_task_with_a_numeric_id() {
    the_ladder_leaves_a_capped_stop_alone(
        "s4-numeric",
        NO_ROWS,
        NO_ROWS,
        |w| store_put(w, "session-s1", "1.json", r#"{"id":1,"subject":"T-3 [Owner/blocked] wait","status":"pending"}"#),
        |w| store_put(w, "session-s1", "1.json", r#"{"id":1,"subject":"T-3 [Owner/blocked] wait","status":"completed"}"#),
    );
}

#[test]
fn a_stall_is_shown_when_the_stores_tasks_are_all_done_even_if_the_transcript_still_lists_one_open() {
    // the store is the list: a transcript task the store lacks (or has completed) is not open
    let w = World::new("s4-store-done");
    tracker_agents(&w, &[("w1", "s1", &["stalled"])]);
    store_task(&w, "session-s1", 1, "completed");
    let open: Tx = Tx::Rows(&[("T-3 [Owner/blocked] wait", "pending")]);
    for (round, id) in ["a", "b"].iter().enumerate() {
        queue_reminder(&w, &format!("r{id}"), "w1", true);
        prompt_tx(&w, open);
        if round == 0 {
            stop_tx(&w, open);
        }
    }
    let o = stop_tx(&w, open);
    assert!(required_next(&o), "nothing holds the Stop and the stall is real: {o}");
}

#[test]
fn another_sessions_store_holds_nothing_here() {
    let w = World::new("s4-other-session");
    tracker_agents(&w, &[("w1", "s1", &["stalled"])]);
    store_task(&w, "session-zzzzzzzz", 1, "pending");
    store_task(&w, "other", 1, "pending");
    for (round, id) in ["a", "b"].iter().enumerate() {
        queue_reminder(&w, &format!("r{id}"), "w1", true);
        prompt_tx(&w, NO_ROWS);
        if round == 0 {
            stop_tx(&w, NO_ROWS);
        }
    }
    assert!(required_next(&stop_tx(&w, NO_ROWS)), "the session has no open task of its own");
}

const DEEP: usize = 700 * 1024;
const ONE_OPEN: &[(&str, &str)] = &[("T-3 [Owner/blocked] wait", "pending")];
const ONE_DONE: &[(&str, &str)] = &[("T-3 [Owner/blocked] wait", "completed")];

#[test]
fn the_cap_holds_when_the_open_task_was_created_further_back_than_the_tasklist_gates_window() {
    // no store: the list is the transcript's, read over task-guard's tail (1.5 MiB), not over the tasklist gate's scan window (512 KiB)
    the_ladder_leaves_a_capped_stop_alone_then("s4-deep", Tx::Deep(ONE_OPEN, DEEP), Tx::Deep(ONE_OPEN, DEEP), Tx::Deep(ONE_DONE, DEEP), |_| {}, |_| {});
}

#[test]
fn the_cap_holds_for_a_task_only_the_transcript_knows_when_the_tasks_are_in_progress() {
    const IN_PROGRESS: &[(&str, &str)] = &[("T-3 [Owner/blocked] wait", "in_progress")];
    the_ladder_leaves_a_capped_stop_alone_then("s4-inprog", Tx::Rows(IN_PROGRESS), Tx::Rows(IN_PROGRESS), Tx::Rows(ONE_DONE), |_| {}, |_| {});
}

#[test]
fn the_stall_block_names_the_stalled_worker_its_stall_kind_and_the_clearing_step() {
    // BUILDER rule: a block text names its fact and its clearing step. Two reminders separated by a Stop, then a Stop.
    let w = World::new("ladder-block-names-fact");
    let empty: [(&str, &str); 0] = [];
    tracker_state(&w, Some(true));
    two_stall_fires(&w, &empty, &ON);
    let o = enforce_stop_env(&w, &empty, &ON);
    let want = "{\"decision\":\"block\",\"reason\":\"\u{26d4} Required next: message the stalled agent, stop it, or re-dispatch it with a narrower brief \
(seen: agent tracker: subagent w1 is STALLED: no observable change (transcript, tool calls, commits, files) for 16m (running 40m)).\\n\
Shown 2x with no change: this Stop is blocked until it is done or the stall is acknowledged; the block is shown once, then the cap lets a later Stop pass.\"}";
    assert_eq!(o.trim(), want, "the block names the worker, how it stalled and what clears it");
    let again = enforce_stop_env(&w, &empty, &ON);
    assert!(!again.contains("Required next"), "the next Stop passes, as the text says: {again}");
}

#[test]
fn with_the_ladder_off_the_two_reminders_then_stop_output_is_the_base_output() {
    let off = [("ANTIHALL_NUDGES", "0")];
    let w = World::new("ladder-names-fact-off");
    let base = World::new("ladder-names-fact-base");
    let empty: [(&str, &str); 0] = [];
    for x in [&w, &base] {
        tracker_state(x, Some(true));
    }
    two_stall_fires(&w, &empty, &off);
    two_stall_fires(&base, &empty, &[]);
    assert_eq!(enforce_stop_env(&w, &empty, &off), enforce_stop_env(&base, &empty, &[]), "switch off equals the base output");
    assert!(!w.path("state/nudge-ladder").exists());
}
