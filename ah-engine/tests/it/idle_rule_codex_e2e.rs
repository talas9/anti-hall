//! R-idle (`task-guard`, switch `guards.idleRule`) against a Codex Stop payload (#574): the Codex Stop table runs `task-guard`,
//! but the check reads its tasks from Claude's `TaskCreate`/`TaskUpdate`/`TodoWrite` transcript lines only. A Codex rollout keeps
//! its plan in `update_plan` calls, so nothing is read and the guard answers `allow` for every Codex task state. These tests record
//! that answer (the gap, named in docs/TASK-WORK.md) through the real dispatcher with `--host codex`, and the class tests pin the
//! fail-safe edges around it. The rollouts are synthetic, in the shape `agent_nudge.codex_turn` describes; no real Codex file is read.
#![allow(clippy::unwrap_used, clippy::expect_used)] // a test crate: a panic is the failure report, and E2 exempts tests

use serde_json::json;
use std::io::Write;
use std::path::PathBuf;
use std::process::{Command, Stdio};

struct World {
    dir: PathBuf,
}

impl World {
    fn new(name: &str) -> World {
        let dir = std::env::temp_dir().join(format!("ah-idlecodex-{name}-{}", std::process::id()));
        ah_engine::discard::harmless(std::fs::remove_dir_all(&dir));
        std::fs::create_dir_all(dir.join("home/.anti-hall")).unwrap();
        std::fs::create_dir_all(dir.join("proj/.git")).unwrap();
        World { dir }
    }

    fn path(&self, rel: &str) -> PathBuf {
        self.dir.join(rel)
    }

    /// `hook --event Stop --host codex` with every other Stop hook of the Codex table mapped to a no-op and `task-guard` mapped to
    /// exit 99 (a 99 proves a deferral to Node, 0 that the engine answered). Returns (code, stdout, stderr).
    fn stop(&self, payload: &str, env: &[(&str, &str)]) -> (i32, String, String) {
        let probe = json!({"hook_event_name": "Stop"});
        let ids: Vec<String> = ah_engine::dispatch::table::select("codex", "Stop", &probe, None).into_iter().map(|e| e.id).collect();
        assert!(ids.iter().any(|i| i == "task-guard"), "task-guard is in the Codex Stop table: {ids:?}");
        let map: serde_json::Map<String, serde_json::Value> =
            ids.iter().map(|id| (id.clone(), if id == "task-guard" { "exit 99" } else { "true" }.into())).collect();
        let map_path = self.path("stop-map.json");
        std::fs::write(&map_path, json!({ "Stop": map }).to_string()).unwrap();
        let mut c = Command::new(env!("CARGO_BIN_EXE_ah-engine"));
        c.args(["hook", "--event", "Stop", "--host", "codex", "--fallback-map"])
            .arg(&map_path)
            .env_clear()
            .env("PATH", std::env::var("PATH").unwrap_or_default())
            .env("HOME", self.path("home"))
            .env("AH_ENGINE_DIR", self.path("state"))
            .env("AH_ENGINE_VERSION", "idle-codex-e2e")
            .env("AH_ENGINE_DISPATCH_IN_PROCESS", "1")
            .env("CLAUDE_PLUGIN_ROOT", &self.dir)
            .envs(env.iter().copied())
            .current_dir(&self.dir)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        let mut ch = c.spawn().unwrap();
        ch.stdin.take().unwrap().write_all(payload.as_bytes()).unwrap();
        let o = ch.wait_with_output().unwrap();
        (o.status.code().unwrap_or(-1), String::from_utf8_lossy(&o.stdout).into_owned(), String::from_utf8_lossy(&o.stderr).into_owned())
    }
}

impl Drop for World {
    fn drop(&mut self) {
        crate::common::reap(&self.path("state"), || {}); // a daemon a hook call started never outlives the test
        ah_engine::discard::harmless(std::fs::remove_dir_all(&self.dir));
    }
}

const TS: &str = "2999-01-01T00:00:00.000Z";

/// A Codex Stop payload: no `tool_name`, but a `turn_id` and a `model` (what `task-guard` reads as Codex).
fn codex_payload(w: &World, transcript: &str) -> serde_json::Value {
    json!({"hook_event_name": "Stop", "session_id": "s1", "turn_id": "turn-1", "model": "gpt-5", "cwd": w.path("proj"), "transcript_path": transcript, "stop_hook_active": false})
}

/// One `update_plan` call of a Codex rollout, with the plan's `(step, status)` rows.
fn plan_line(rows: &[(&str, &str)]) -> String {
    let plan: Vec<serde_json::Value> = rows.iter().map(|(s, st)| json!({"step": s, "status": st})).collect();
    let args = json!({"plan": plan}).to_string();
    json!({"timestamp": TS, "type": "response_item", "payload": {"type": "function_call", "name": "update_plan", "arguments": args, "call_id": "call_1"}})
        .to_string()
}

fn message_line(text: &str) -> String {
    json!({"timestamp": TS, "type": "response_item", "payload": {"type": "message", "role": "assistant", "content": [{"type": "output_text", "text": text}]}})
        .to_string()
}

/// A Claude-shaped open task (what the guard DOES read): created, then set to `status`.
fn claude_task(n: u32, subject: &str, status: &str) -> String {
    let create = json!({"type": "assistant", "message": {"id": format!("m{n}"), "role": "assistant", "content": [{"type": "tool_use", "id": format!("c{n}"), "name": "TaskCreate", "input": {"subject": subject, "description": ""}}]}, "timestamp": TS});
    let result = json!({"type": "user", "message": {"role": "user", "content": [{"type": "tool_result", "tool_use_id": format!("c{n}"), "content": format!("Task #{n} created successfully: {subject}")}]}, "timestamp": TS});
    let update = json!({"type": "assistant", "message": {"id": format!("u{n}"), "role": "assistant", "content": [{"type": "tool_use", "id": format!("t{n}"), "name": "TaskUpdate", "input": {"taskId": n.to_string(), "status": status}}]}, "timestamp": TS});
    format!("{create}\n{result}\n{update}\n")
}

/// Run one Stop for `body` written as the transcript, with the R-idle switch on.
fn observe(name: &str, body: &str, mutate: impl FnOnce(&mut serde_json::Value)) -> (i32, String, String) {
    let w = World::new(name);
    std::fs::write(w.path("rollout.jsonl"), body).unwrap();
    let mut p = codex_payload(&w, w.path("rollout.jsonl").to_str().unwrap());
    mutate(&mut p);
    w.stop(&p.to_string(), &[("ANTIHALL_IDLE_RULE", "1")])
}

fn assert_quiet(r: &(i32, String, String), what: &str) {
    assert_eq!((r.0, r.1.trim(), r.2.trim()), (0, "", ""), "{what}: the engine answers allow, silently: {r:?}");
}

// ---- the three #574 states: attended, parked, bare idle ----

#[test]
fn idle_rule_codex_attended_plan_step_is_quiet() {
    let body = format!("{}\n{}\n", message_line("spawning a worker for step 1"), plan_line(&[("#1 port the check", "in_progress")]));
    assert_quiet(&observe("attended", &body, |_| {}), "an in-progress step with a worker named in the rollout");
}

#[test]
fn idle_rule_codex_parked_plan_step_is_quiet() {
    let body = format!("{}\n", plan_line(&[("PARKED: waiting for the owner to approve the schema", "in_progress"), ("blocked on the CI run", "pending")]));
    assert_quiet(&observe("parked", &body, |_| {}), "parked steps");
}

#[test]
fn idle_rule_codex_bare_idle_plan_step_is_quiet_too_which_is_the_gap() {
    // A bare idle step ("BLOCKED" with no reason, a pending step nobody works on) fires on Claude (task_checks_e2e idle_rule_*). On
    // Codex nothing reads `update_plan`, so it does not: gap named, Codex has no task-list reader.
    let body = format!("{}\n", plan_line(&[("BLOCKED", "in_progress"), ("[P1] port the other check", "pending")]));
    assert_quiet(&observe("bare", &body, |_| {}), "a bare idle plan step");
}

// ---- the counterpart: the same Codex payload with Claude-shaped task lines IS read, and the Codex update text is used ----

#[test]
fn idle_rule_codex_payload_with_claude_task_lines_blocks_with_the_codex_update_text() {
    let r = observe("claude-lines", &claude_task(7, "[P1] build the thing", "in_progress"), |_| {});
    assert_eq!(r.0, 0, "{r:?}");
    let v: serde_json::Value = serde_json::from_str(r.1.trim()).unwrap_or_else(|e| panic!("one JSON object expected: {e}: {r:?}"));
    assert_eq!(v["decision"], "block", "{r:?}");
    let reason = v["reason"].as_str().unwrap();
    assert!(reason.contains("#7"), "the idle rule names the id: {reason}");
    assert!(reason.contains("update your task list"), "the Codex update text (task_guard.update_codex), not the Claude one: {reason}");
    assert!(!reason.contains("TaskUpdate"), "{reason}");
}

// ---- class tests: payload and rollout variants, fail-safe edges ----

#[test]
fn idle_rule_codex_class_payload_detection_variants() {
    let lines = claude_task(1, "[P1] open work", "in_progress");
    // detected as Codex by apply_patch, or by turn_id + model: Codex text
    for (i, mutate) in [
        Box::new(|p: &mut serde_json::Value| {
            p["tool_name"] = "apply_patch".into();
            p.as_object_mut().unwrap().remove("turn_id");
            p.as_object_mut().unwrap().remove("model");
        }) as Box<dyn FnOnce(&mut serde_json::Value)>,
        Box::new(|_| {}),
    ]
    .into_iter()
    .enumerate()
    {
        let r = observe(&format!("det-{i}"), &lines, mutate);
        assert!(r.1.contains("update your task list") && !r.1.contains("TaskUpdate"), "variant {i} reads as Codex: {r:?}");
    }
    // not Codex: an empty model, an empty turn_id, a non-string turn_id, only a model: the Claude text
    for (i, mutate) in [
        Box::new(|p: &mut serde_json::Value| p["model"] = "".into()) as Box<dyn FnOnce(&mut serde_json::Value)>,
        Box::new(|p| p["turn_id"] = "".into()),
        Box::new(|p| p["turn_id"] = json!(7)),
        Box::new(|p| {
            p.as_object_mut().unwrap().remove("turn_id");
        }),
    ]
    .into_iter()
    .enumerate()
    {
        let r = observe(&format!("notdet-{i}"), &lines, mutate);
        assert!(r.1.contains("TaskUpdate") && !r.1.contains("update your task list"), "variant {i} is not Codex: {r:?}");
    }
}

#[test]
fn idle_rule_codex_class_plan_variants_are_all_quiet() {
    let cases: Vec<(&str, String)> = vec![
        ("dup", format!("{0}\n{0}\n{0}\n", plan_line(&[("#1 a", "in_progress")]))),
        (
            "reordered",
            format!("{}\n{}\n", plan_line(&[("#2 b", "pending"), ("#1 a", "in_progress")]), plan_line(&[("#1 a", "completed"), ("#2 b", "in_progress")])),
        ),
        ("unicode", format!("{}\n", plan_line(&[("\u{202e}\u{4e2d}\u{6587} \u{1f680} step\u{a0}one", "in_progress")]))),
        ("whitespace", format!("   {}   \n\n\t\n{}\n", plan_line(&[("  ", "pending")]), plan_line(&[("", "in_progress")]))),
        ("crlf", format!("{}\r\n{}\r\n", plan_line(&[("a", "pending")]), message_line("working"))),
        ("bom", format!("\u{feff}{}\n", plan_line(&[("a", "in_progress")]))),
        ("huge-step", format!("{}\n", plan_line(&[(&"x".repeat(100_000), "in_progress")]))),
        ("many-steps", {
            let rows: Vec<(String, &str)> = (0..300).map(|i| (format!("#{i} step"), "pending")).collect();
            let refs: Vec<(&str, &str)> = rows.iter().map(|(s, st)| (s.as_str(), *st)).collect();
            format!("{}\n", plan_line(&refs))
        }),
        ("nested-args", {
            // arguments as a nested object instead of a JSON string, and a plan nested one level deeper
            let a = json!({"timestamp": TS, "type": "response_item", "payload": {"type": "function_call", "name": "update_plan", "arguments": {"plan": [{"step": "a", "status": "in_progress"}]}}});
            let b = json!({"timestamp": TS, "type": "response_item", "payload": {"type": "function_call", "name": "update_plan", "arguments": json!({"outer": {"plan": [{"step": "b", "status": "pending"}]}}).to_string()}});
            format!("{a}\n{b}\n")
        }),
        (
            "truncated-tail",
            format!(
                "{}\n{{\"timestamp\":\"{TS}\",\"type\":\"response_item\",\"payload\":{{\"type\":\"function_call\",\"name\":\"update_pl",
                plan_line(&[("a", "in_progress")])
            ),
        ),
        ("garbage", "not json\n{\"a\":\n[1,2\n\u{0}\u{0}\n".to_string()),
        ("empty-file", String::new()),
    ];
    for (name, body) in cases {
        assert_quiet(&observe(&format!("pv-{name}"), &body, |_| {}), name);
    }
}

#[test]
fn idle_rule_codex_class_transcript_path_edges_are_quiet_and_never_defer_to_node() {
    let w = World::new("paths");
    std::fs::create_dir_all(w.path("adir")).unwrap();
    let mut bad: Vec<(&str, serde_json::Value)> = vec![
        ("missing", json!(w.path("nope.jsonl").to_str().unwrap())),
        ("directory", json!(w.path("adir").to_str().unwrap())),
        ("empty-string", json!("")),
        ("null", serde_json::Value::Null),
        ("number", json!(5)),
        ("array", json!(["a"])),
        ("relative", json!("rollout.jsonl")),
    ];
    bad.push(("nul-in-path", json!("a\u{0}b")));
    for (name, v) in bad {
        let mut p = codex_payload(&w, "x");
        p["transcript_path"] = v;
        let r = w.stop(&p.to_string(), &[("ANTIHALL_IDLE_RULE", "1")]);
        assert_quiet(&r, name);
    }
    // no transcript_path key at all, and a payload that is not an object
    let mut p = codex_payload(&w, "x");
    p.as_object_mut().unwrap().remove("transcript_path");
    assert_quiet(&w.stop(&p.to_string(), &[("ANTIHALL_IDLE_RULE", "1")]), "no key");
    for raw in ["null", "[]", "\"Stop\"", "{}", ""] {
        let r = w.stop(raw, &[("ANTIHALL_IDLE_RULE", "1")]);
        assert_eq!(r.0, 0, "payload {raw:?} must not fail the Stop or defer to Node: {r:?}");
        assert!(!r.1.contains("\"block\""), "payload {raw:?} must not block: {r:?}");
    }
}

#[test]
fn idle_rule_codex_class_a_quiet_answer_repeats_without_ever_blocking() {
    // the guard blocks nothing on a Codex plan, so repeated Stops (more than the 3 blocks a loop guard would allow) stay quiet
    let w = World::new("repeat");
    std::fs::write(w.path("rollout.jsonl"), format!("{}\n", plan_line(&[("#1 a", "in_progress")]))).unwrap();
    for hook_active in [false, true] {
        for i in 0..5 {
            let mut p = codex_payload(&w, w.path("rollout.jsonl").to_str().unwrap());
            p["stop_hook_active"] = hook_active.into();
            assert_quiet(&w.stop(&p.to_string(), &[("ANTIHALL_IDLE_RULE", "1")]), &format!("repeat {i} active={hook_active}"));
        }
    }
}

#[test]
fn idle_rule_codex_class_the_switch_off_and_on_agree_on_a_codex_plan() {
    let body = format!("{}\n", plan_line(&[("BLOCKED", "in_progress")]));
    let w = World::new("switch");
    std::fs::write(w.path("rollout.jsonl"), &body).unwrap();
    let p = codex_payload(&w, w.path("rollout.jsonl").to_str().unwrap()).to_string();
    let off = w.stop(&p, &[("ANTIHALL_IDLE_RULE", "0")]);
    let on = w.stop(&p, &[("ANTIHALL_IDLE_RULE", "1")]);
    let unset = w.stop(&p, &[]);
    assert_quiet(&off, "off");
    assert_eq!(off, on, "the switch changes nothing on a Codex plan");
    assert_eq!(off, unset);
}

#[test]
fn idle_rule_codex_class_claude_lines_in_a_rollout_with_duplicates_name_each_task_once() {
    // a mixed file (Codex plan lines plus Claude task lines, the shape of a session moved between hosts): the Claude lines are read,
    // the plan lines are ignored, and a task created twice with the same id is listed once
    let body =
        format!("{}\n{}{}", plan_line(&[("#9 not read", "pending")]), claude_task(3, "[P1] one", "in_progress"), claude_task(3, "[P1] one", "in_progress"));
    let r = observe("mixed", &body, |_| {});
    let v: serde_json::Value = serde_json::from_str(r.1.trim()).unwrap_or_else(|e| panic!("{e}: {r:?}"));
    let reason = v["reason"].as_str().unwrap();
    assert!(reason.contains("#3") && !reason.contains("#9"), "{reason}");
    assert!(reason.contains("1 open tasks"), "listed once: {reason}");
}

#[test]
fn idle_rule_codex_class_a_blocking_codex_stop_repeats_only_while_the_tasks_are_unchanged() {
    // Claude-shaped tasks on a Codex payload do block; the block is the guard's own repeat limit, and it must stop blocking after it
    // (a loop that blocks forever would trap the session). Count the blocks over many identical Stops.
    let w = World::new("loop");
    std::fs::write(w.path("rollout.jsonl"), claude_task(5, "[P1] stuck", "in_progress")).unwrap();
    let p = codex_payload(&w, w.path("rollout.jsonl").to_str().unwrap()).to_string();
    let mut blocks = 0;
    for _ in 0..8 {
        let r = w.stop(&p, &[("ANTIHALL_IDLE_RULE", "1")]);
        assert_eq!(r.0, 0, "{r:?}");
        if r.1.contains("\"block\"") {
            blocks += 1;
        }
    }
    assert!((1..=3).contains(&blocks), "blocks over 8 identical Stops: {blocks}");
}
