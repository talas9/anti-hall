//! R-pair (`task-pair-guard`, switch `guards.pairRule`, GH #589) through the real dispatcher (`ah-engine hook --event <Event> --host claude`):
//! real hook payloads in, the real output text out. The switch defaults to on; a test says off with `ANTIHALL_PAIR_RULE=0`. The engine's other
//! checks run too, so a test asks whether the R-pair text is in the output, never whether the output is empty.
#![allow(clippy::unwrap_used, clippy::expect_used)] // a test crate: a panic is the failure report, and E2 exempts tests

use crate::common;

use std::io::Write;
use std::path::PathBuf;
use std::process::{Command, Stdio};

/// The guard's visible name in a message prefix (`guardkit.plain_names` has no entry for it, so the id with spaces).
const GUARD: &str = "task pair guard";

struct World {
    dir: PathBuf,
}

impl World {
    fn new(name: &str) -> World {
        let dir = std::env::temp_dir().join(format!("ah-rpair-{name}-{}", std::process::id()));
        ah_engine::discard::harmless(std::fs::remove_dir_all(&dir));
        std::fs::create_dir_all(dir.join("home/.anti-hall")).unwrap();
        std::fs::create_dir_all(dir.join("proj/.git")).unwrap();
        World { dir }
    }

    fn path(&self, rel: &str) -> PathBuf {
        self.dir.join(rel)
    }

    /// One `hook --event <event> --host <host>` call with `payload`; every other hook of the event is mapped to a successful no-op.
    /// Returns (exit code, stdout, stderr).
    fn hook(&self, event: &str, tool: &str, host: &str, payload: &serde_json::Value, on: bool) -> (i32, String, String) {
        let p = serde_json::json!({"hook_event_name": event, "tool_name": tool});
        let ids: Vec<String> =
            ah_engine::dispatch::table::select(host, event, &p, if tool.is_empty() { None } else { Some(tool) }).into_iter().map(|e| e.id).collect();
        let map: serde_json::Map<String, serde_json::Value> = ids.iter().map(|id| (id.clone(), "true".into())).collect();
        let map_path = self.path("map.json");
        std::fs::write(&map_path, serde_json::json!({ event: map }).to_string()).unwrap();
        let mut c = Command::new(env!("CARGO_BIN_EXE_ah-engine"));
        c.args(["hook", "--event", event, "--host", host]);
        if !tool.is_empty() {
            c.args(["--tool", tool]);
        }
        c.arg("--fallback-map")
            .arg(&map_path)
            .env_clear()
            .env("PATH", std::env::var("PATH").unwrap_or_default())
            .env("HOME", self.path("home"))
            .env("AH_ENGINE_DIR", self.path("state"))
            .env("AH_ENGINE_VERSION", "rpair-e2e")
            .env("AH_ENGINE_DISPATCH_IN_PROCESS", "1")
            .env("CLAUDE_PLUGIN_ROOT", &self.dir)
            .current_dir(&self.dir)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        // the switch defaults to on: an "off" case forces it off explicitly
        c.env("ANTIHALL_PAIR_RULE", if on { "1" } else { "0" });
        let mut ch = c.spawn().unwrap();
        ch.stdin.take().unwrap().write_all(payload.to_string().as_bytes()).unwrap();
        let o = ch.wait_with_output().unwrap();
        (o.status.code().unwrap_or(-1), String::from_utf8_lossy(&o.stdout).into_owned(), String::from_utf8_lossy(&o.stderr).into_owned())
    }

    /// The tracker's proof that the agents of `transcript(.., agents)` are live: a fresh subagent transcript each and a retained tracker row
    /// for it (agent `i` of the transcript has the id `a{i+1:015x}` and the tracker name = its description). Without it the liveness is unknown.
    fn track(&self, descriptions: &[&str]) {
        let home = self.path("home");
        let mut st = ah_engine::agents::State::default();
        for (i, d) in descriptions.iter().enumerate() {
            let id = format!("a{:015x}", i + 1);
            let rel = format!(".claude/projects/p/s1/subagents/agent-{id}.jsonl");
            std::fs::create_dir_all(home.join(&rel).parent().unwrap()).unwrap();
            std::fs::write(
                home.join(&rel),
                format!("{}\n", serde_json::json!({"type": "assistant", "message": {"content": [{"type": "text", "text": "working"}]}})),
            )
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

    /// An `Agent` PreToolUse payload; `name` None leaves the field out.
    fn pre(&self, name: Option<&str>, on: bool) -> (i32, String, String) {
        let mut input = serde_json::json!({"description": "port the wake", "prompt": "do it", "run_in_background": true});
        if let Some(n) = name {
            input["name"] = n.into();
        }
        let p = serde_json::json!({"hook_event_name": "PreToolUse", "session_id": "s1", "cwd": self.path("proj"), "tool_name": "Agent", "tool_input": input});
        self.hook("PreToolUse", "Agent", "claude", &p, on)
    }

    /// A PostToolUse payload of an `Agent` call named `name` over the transcript `t` (written first).
    fn post(&self, name: &str, t: &str, on: bool) -> (i32, String, String) {
        std::fs::write(self.path("t.jsonl"), t).unwrap();
        let p = serde_json::json!({"hook_event_name": "PostToolUse", "session_id": "s1", "cwd": self.path("proj"), "transcript_path": self.path("t.jsonl"),
            "tool_name": "Agent", "tool_input": {"description": "port the wake", "prompt": "do it", "name": name, "run_in_background": true},
            "tool_response": {"status": "async_launched", "agentId": "a000000000000001"}});
        self.hook("PostToolUse", "Agent", "claude", &p, on)
    }

    /// A Stop payload over the transcript `t` (written first); `extra` fields are merged into the payload.
    fn stop(&self, t: &str, on: bool, extra: serde_json::Value) -> (i32, String, String) {
        std::fs::write(self.path("t.jsonl"), t).unwrap();
        let mut p = serde_json::json!({"hook_event_name": "Stop", "session_id": "s1", "cwd": self.path("proj"), "transcript_path": self.path("t.jsonl")});
        for (k, v) in extra.as_object().cloned().unwrap_or_default() {
            p[k] = v;
        }
        self.hook("Stop", "", "claude", &p, on)
    }
}

impl Drop for World {
    fn drop(&mut self) {
        common::reap(&self.path("state"), || {}); // a daemon a hook call started never outlives the test
        ah_engine::discard::harmless(std::fs::remove_dir_all(&self.dir));
    }
}

/// One task of a transcript.
struct T {
    id: u32,
    status: &'static str,
    owner: Option<&'static str>,
}

/// A transcript holding `tasks` (created, then set to their status/owner) and one background `Agent` launch per `(description, name)` of
/// `agents` that never finishes, so the scan shows it running.
fn transcript(tasks: &[T], agents: &[(&str, Option<&str>)]) -> String {
    use serde_json::json;
    let ts = "2999-01-01T00:00:00.000Z";
    let mut out = String::new();
    for t in tasks {
        let n = t.id;
        let create = json!({"type": "assistant", "message": {"id": format!("m{n}"), "role": "assistant", "content": [{"type": "tool_use", "id": format!("c{n}"), "name": "TaskCreate", "input": {"subject": format!("[P1] task {n}"), "description": ""}}]}, "timestamp": ts});
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

fn task(id: u32, status: &'static str, owner: Option<&'static str>) -> T {
    T { id, status, owner }
}

/// The R-pair text is in the output (stdout or stderr).
fn pair_text(o: &(i32, String, String)) -> bool {
    o.1.contains(GUARD) || o.2.contains(GUARD)
}

#[test]
fn pre_unnamed_spawn_is_denied() {
    let w = World::new("pre-deny");
    for name in [None, Some(""), Some("  "), Some("x")] {
        let o = w.pre(name, true);
        assert_eq!(o.0, 2, "{name:?}: the spawn is denied: {o:?}");
        assert!(o.1.contains(GUARD) && o.1.contains("has no name"), "{name:?}: names the fact: {o:?}");
        assert!(o.1.contains("add name: \\\"<short-name>\\\" to the Agent call"), "{name:?}: names the step that clears it: {o:?}");
    }
}

#[test]
fn pre_named_spawn_is_allowed() {
    let w = World::new("pre-ok");
    let o = w.pre(Some("wake-worker"), true);
    assert!(!pair_text(&o), "a named spawn is not R-pair's: {o:?}");
    assert_ne!(o.0, 2, "{o:?}");
}

#[test]
fn pre_switch_off_is_silent_and_counts_unnamed() {
    // the counter is checked in script::tests (pair_rule_counters); here the end to end answer: nothing is printed
    let w = World::new("pre-off");
    let o = w.pre(None, false);
    assert!(!pair_text(&o), "switch off: nothing printed: {o:?}");
    assert_ne!(o.0, 2, "{o:?}");
}

#[test]
fn post_unpaired_named_agent_gets_the_pair_advisory() {
    let w = World::new("post-unpaired");
    let t = transcript(&[task(1, "in_progress", None), task(2, "in_progress", Some("someone-else"))], &[("port the wake", Some("wake-worker"))]);
    let o = w.post("wake-worker", &t, true);
    assert!(o.1.contains(GUARD) && o.1.contains("agent \\\"wake-worker\\\" is running but no open task names it as owner"), "{o:?}");
    assert!(o.1.contains("owner \\\"wake-worker\\\""), "names the step: {o:?}");
    let off = w.post("wake-worker", &t, false);
    assert!(!pair_text(&off), "switch off: silent: {off:?}");
}

#[test]
fn post_paired_agent_is_silent() {
    let w = World::new("post-paired");
    let t = transcript(&[task(1, "in_progress", Some("Wake-Worker"))], &[("port the wake", Some("wake-worker"))]);
    let o = w.post("wake-worker", &t, true);
    assert!(!pair_text(&o), "an open task owned by the name (case-insensitive) pairs it: {o:?}");
}

#[test]
fn stop_live_named_agent_without_task_blocks_and_names_it() {
    let w = World::new("stop-f2");
    w.track(&["port the wake"]);
    let t = transcript(&[task(1, "in_progress", Some("someone-else"))], &[("port the wake", Some("wake-worker"))]);
    let o = w.stop(&t, true, serde_json::json!({}));
    assert!(o.1.contains(GUARD) && o.1.contains("agent \\\"wake-worker\\\" owns no task"), "names the agent: {o:?}");
    assert!(
        o.1.contains("TaskCreate (not TaskUpdate) a task per agent, owner = full name"),
        "names the step that gives the agent a task, on the visible line: {o:?}"
    );
    assert!(!o.1.contains("follow the saved instructions"), "the step is short enough to be shown, not replaced by a pointer: {o:?}");
}

#[test]
fn stop_task_owned_by_description_asks_for_the_launch_name() {
    let w = World::new("stop-f3");
    w.track(&["port the wake"]);
    let t = transcript(&[task(5, "in_progress", Some("port the wake"))], &[("port the wake", Some("wake-worker"))]);
    let o = w.stop(&t, true, serde_json::json!({}));
    assert!(
        o.1.contains(GUARD) && o.1.contains("#5 owner \\\"port the wake\\\" -> \\\"wake-worker\\\""),
        "names the task, its owner and the launch name: {o:?}"
    );
    assert!(!o.1.contains(" no task"), "the agent is attended by that task, so no F2 item: {o:?}");
}

#[test]
fn stop_all_paired_allows() {
    let w = World::new("stop-clean");
    w.track(&["port the wake"]);
    let t = transcript(&[task(1, "in_progress", Some("wake-worker"))], &[("port the wake", Some("wake-worker"))]);
    let o = w.stop(&t, true, serde_json::json!({}));
    assert!(!pair_text(&o), "every live named agent owns an open task: {o:?}");
}

#[test]
fn stop_hook_active_allows() {
    let w = World::new("stop-active");
    w.track(&["port the wake"]);
    let t = transcript(&[task(1, "in_progress", Some("someone-else"))], &[("port the wake", Some("wake-worker"))]);
    assert!(pair_text(&w.stop(&t, true, serde_json::json!({}))), "the twin: without the flag the same Stop is blocked");
    let o = w.stop(&t, true, serde_json::json!({"stop_hook_active": true}));
    assert!(!pair_text(&o), "a Stop the host re-fires after a block is let through: {o:?}");
}

#[test]
fn unowned_open_task_is_left_to_task_guard() {
    let w = World::new("unowned");
    let t = transcript(&[task(1, "in_progress", None)], &[]);
    let o = w.stop(&t, true, serde_json::json!({}));
    assert!(!pair_text(&o), "an open task with no owner and no agent is task-guard's fact: {o:?}");
    let named_idle = transcript(&[task(2, "in_progress", Some("nobody"))], &[]);
    assert!(!pair_text(&w.stop(&named_idle, true, serde_json::json!({}))), "an owner that names no live agent is task-guard's too");
}

#[test]
fn subagent_payload_is_silent() {
    let w = World::new("subagent");
    w.track(&["port the wake"]);
    let t = transcript(&[task(1, "in_progress", Some("someone-else"))], &[("port the wake", Some("wake-worker"))]);
    let o = w.stop(&t, true, serde_json::json!({"agent_id": "ag-1", "agent_type": "general-purpose"}));
    assert!(!pair_text(&o), "a worker's Stop is not R-pair's: {o:?}");
    let mut input = serde_json::json!({"description": "d", "prompt": "p"});
    input["name"] = "".into();
    let p = serde_json::json!({"hook_event_name": "PreToolUse", "session_id": "s1", "cwd": w.path("proj"), "tool_name": "Agent", "tool_input": input, "agent_id": "ag-1"});
    let pre = w.hook("PreToolUse", "Agent", "claude", &p, true);
    assert!(!pair_text(&pre), "a worker's unnamed spawn is left to the nested-spawn guard: {pre:?}");
}

#[test]
fn codex_host_is_silent() {
    let w = World::new("codex");
    w.track(&["port the wake"]);
    let t = transcript(&[task(1, "in_progress", Some("someone-else"))], &[("port the wake", Some("wake-worker"))]);
    std::fs::write(w.path("t.jsonl"), &t).unwrap();
    let p = serde_json::json!({"hook_event_name": "Stop", "session_id": "s1", "cwd": w.path("proj"), "transcript_path": w.path("t.jsonl"), "turn_id": "t-1", "model": "gpt-5"});
    let o = w.hook("Stop", "", "codex", &p, true);
    assert!(!pair_text(&o), "Codex has no owner field: {o:?}");
}

#[test]
fn switch_off_stop_is_silent_and_counts_observed() {
    // the counter is checked in script::tests (pair_rule_counters); here the end to end answer: nothing is printed
    let w = World::new("stop-off");
    w.track(&["port the wake"]);
    let t = transcript(&[task(1, "in_progress", Some("someone-else"))], &[("port the wake", Some("wake-worker"))]);
    let o = w.stop(&t, false, serde_json::json!({}));
    assert!(!pair_text(&o), "switch off: nothing printed: {o:?}");
}

#[test]
fn stop_pending_task_owned_by_description_is_not_a_bypass() {
    // review fix: a loose description match used to suppress F2 while F3 only reads in-progress tasks, so a pending task escaped both
    let w = World::new("stop-pending-loose");
    w.track(&["port the wake"]);
    let t = transcript(&[task(1, "pending", Some("port the wake"))], &[("port the wake", Some("wake-worker"))]);
    let o = w.stop(&t, true, serde_json::json!({}));
    assert!(o.1.contains(GUARD) && o.1.contains("agent \\\"wake-worker\\\" owns no task"), "the pending task does not pair the agent: {o:?}");
    let off = w.stop(&t, false, serde_json::json!({}));
    assert!(!pair_text(&off), "switch off: nothing printed: {off:?}");
}

#[test]
fn stop_agent_named_main_pairs_with_the_task_owned_main() {
    // review fix: the coordinator-owner filter ran before the exact pairing, so an agent literally named "main" was reported unpaired
    let w = World::new("stop-main");
    w.track(&["port the wake"]);
    let t = transcript(&[task(1, "in_progress", Some("main"))], &[("port the wake", Some("main"))]);
    let o = w.stop(&t, true, serde_json::json!({}));
    assert!(!pair_text(&o), "owner main equals the launch name main: {o:?}");
}

#[test]
fn post_unreadable_transcript_is_suppressed() {
    // review fix: no task store and no readable transcript is missing evidence, not "no open task names the agent"
    let w = World::new("post-unreadable");
    let t = transcript(&[task(1, "in_progress", Some("someone-else"))], &[("port the wake", Some("wake-worker"))]);
    let twin = w.post("wake-worker", &t, true);
    assert!(pair_text(&twin), "the twin: a readable transcript with no owner match gets the advisory: {twin:?}");
    let p = serde_json::json!({"hook_event_name": "PostToolUse", "session_id": "s1", "cwd": w.path("proj"), "transcript_path": w.path("missing.jsonl"),
        "tool_name": "Agent", "tool_input": {"description": "port the wake", "prompt": "do it", "name": "wake-worker", "run_in_background": true},
        "tool_response": {"status": "async_launched", "agentId": "a000000000000001"}});
    let o = w.hook("PostToolUse", "Agent", "claude", &p, true);
    assert!(!pair_text(&o), "an unreadable transcript is missing evidence: {o:?}");
}

#[test]
fn stop_two_live_agents_with_one_name_pair_with_two_tasks_of_that_owner() {
    // class fix: pairing is by name as a multiset; the second agent of a name used to be reported as owning no task, a block that
    // setting the owner to "worker" (what the task already had) could not clear
    let w = World::new("stop-dup-names");
    w.track(&["first job", "second job"]);
    let agents = [("first job", Some("worker")), ("second job", Some("worker"))];
    let two = transcript(&[task(1, "in_progress", Some("worker")), task(2, "in_progress", Some("worker"))], &agents);
    let o = w.stop(&two, true, serde_json::json!({}));
    assert!(!pair_text(&o), "two tasks owned 'worker' pair with the two live agents named 'worker': {o:?}");
    // the twin: one task for two agents of the name leaves one agent without a task, and the block names a step that clears it
    let one = transcript(&[task(1, "in_progress", Some("worker"))], &agents);
    let o = w.stop(&one, true, serde_json::json!({}));
    assert!(o.1.contains(GUARD) && o.1.contains("1 of the agents named \\\"worker\\\" own no task"), "one agent is left without a task: {o:?}");
    assert!(o.1.contains("TaskCreate"), "a new task is what clears it (the one task already has that owner): {o:?}");
    let fixed = transcript(&[task(1, "in_progress", Some("worker")), task(2, "in_progress", Some("worker"))], &agents);
    assert!(!pair_text(&w.stop(&fixed, true, serde_json::json!({}))), "TaskCreate owner=worker clears it");
    // more tasks than agents of the name is not a pairing fact
    let surplus = transcript(&[task(1, "pending", Some("worker")), task(2, "pending", Some("worker")), task(3, "pending", Some("worker"))], &agents);
    assert!(!pair_text(&w.stop(&surplus, true, serde_json::json!({}))), "a surplus of tasks is not an unpaired agent");
}

#[test]
fn stop_three_agents_of_one_name_with_one_task_names_how_many_are_left() {
    let w = World::new("stop-dup-three");
    w.track(&["a job", "b job", "c job"]);
    let t = transcript(&[task(1, "in_progress", Some("worker"))], &[("a job", Some("worker")), ("b job", Some("worker")), ("c job", Some("worker"))]);
    let o = w.stop(&t, true, serde_json::json!({}));
    assert!(o.1.contains("2 of the agents named \\\"worker\\\" own no task"), "{o:?}");
}

#[test]
fn stop_loose_owner_attends_the_surplus_agent_of_a_shared_name() {
    let w = World::new("stop-dup-loose");
    w.track(&["first job", "second job"]);
    let agents = [("first job", Some("worker")), ("second job", Some("worker"))];
    let t = transcript(&[task(1, "in_progress", Some("worker")), task(2, "in_progress", Some("second job"))], &agents);
    let o = w.stop(&t, true, serde_json::json!({}));
    assert!(o.1.contains("#2 owner \\\"second job\\\" -> \\\"worker\\\""), "the description owner is asked for the launch name: {o:?}");
    assert!(!o.1.contains(" no task"), "and it attends the second agent, so no agent item: {o:?}");
}

#[test]
fn stop_agent_names_that_are_object_keys_never_crash_the_guard() {
    // review finding: a plain-object name map threw on `__proto__` and `constructor` (a "guard could not run" notice instead of pairing, and the
    // same with the switch off, where the base prints nothing)
    for name in ["__proto__", "constructor"] {
        let w = World::new(&format!("stop-key-{name}"));
        w.track(&["job 1"]);
        let agents = [("job 1", Some(name))];
        let none = transcript(&[], &agents);
        let on = w.stop(&none, true, serde_json::json!({}));
        assert!(on.1.contains(GUARD) && on.1.contains(&format!("agent \\\"{name}\\\" owns no task")), "{name}: blocks and names the agent: {on:?}");
        assert!(!on.1.contains("could not run"), "{name}: the guard ran: {on:?}");
        let off = w.stop(&none, false, serde_json::json!({}));
        assert!(!off.1.contains("could not run") && !pair_text(&off), "{name}: switch off prints nothing: {off:?}");
        let owned = transcript(&[task(1, "in_progress", Some(if name == "constructor" { "constructor" } else { "__proto__" }))], &agents);
        let ok = w.stop(&owned, true, serde_json::json!({}));
        assert!(!pair_text(&ok) && !ok.1.contains("could not run"), "{name}: paired by its own name: {ok:?}");
        let ok_off = w.stop(&owned, false, serde_json::json!({}));
        assert!(!ok_off.1.contains("could not run"), "{name}: paired, switch off: {ok_off:?}");
        // the Post advisory compares names too
        let post = w.post(name, &none, true);
        assert!(!post.1.contains("could not run") && !post.2.contains("could not run"), "{name}: post ran: {post:?}");
    }
}

#[test]
fn stop_missing_task_slot_names_the_step_that_creates_the_task() {
    // review finding: one task owned 'reviewer-2' for two agents named 'reviewer-2' blocked with "TaskUpdate owner", which cannot clear it
    let w = World::new("stop-slot");
    w.track(&["job 1", "job 2"]);
    let agents = [("job 1", Some("reviewer-2")), ("job 2", Some("reviewer-2"))];
    let o = w.stop(&transcript(&[task(1, "in_progress", Some("reviewer-2"))], &agents), true, serde_json::json!({}));
    assert!(
        o.1.contains(GUARD) && o.1.contains("TaskCreate (not TaskUpdate) a task per agent, owner = full name"),
        "the visible block text says to create a task owned by the agent's full name: {o:?}"
    );
    assert!(o.1.contains("reviewer-2"), "the listed item names reviewer-2: {o:?}");
    assert!(!o.1.contains("TaskUpdate a task per listed agent"), "the old update-first instruction is gone: {o:?}");
    // switch off: the same input is the base (empty) output
    let off = w.stop(&transcript(&[task(1, "in_progress", Some("reviewer-2"))], &agents), false, serde_json::json!({}));
    assert!(!pair_text(&off) && off.1.is_empty(), "switch off equals base: {off:?}");
    // zero tasks and one live agent: same
    let w = World::new("stop-slot-zero");
    w.track(&["job 1"]);
    let o = w.stop(&transcript(&[], &[("job 1", Some("fresh-worker"))]), true, serde_json::json!({}));
    assert!(o.1.contains(GUARD) && o.1.contains("TaskCreate"), "{o:?}");
    // the step, done: a second task of the name clears it
    let w = World::new("stop-slot-done");
    w.track(&["job 1", "job 2"]);
    let done = transcript(&[task(1, "in_progress", Some("reviewer-2")), task(2, "in_progress", Some("reviewer-2"))], &agents);
    assert!(!pair_text(&w.stop(&done, true, serde_json::json!({}))), "the second task clears it");
}

#[test]
fn pre_a_name_of_control_characters_or_white_space_is_no_name() {
    // a name no task owner can ever equal (only control characters and white space) is an unnamed spawn, like a missing one
    let w = World::new("pre-ctl-name");
    for name in ["\u{1}\u{1}", "\t\t", "   ", "\n\n"] {
        let o = w.pre(Some(name), true);
        assert!(o.0 == 2 && (o.1.contains("has no name") || o.2.contains("has no name")), "{name:?} is denied as unnamed: {o:?}");
    }
    let o = w.pre(Some("wake\u{1}worker"), true);
    assert!(!pair_text(&o), "a name with a control character inside is still a name: {o:?}");
}

/// The saved details of the guard (its file name carries the session, which the check does not pass), concatenated.
fn saved_details(w: &World) -> String {
    let mut out = String::new();
    for e in std::fs::read_dir(w.path("home/.anti-hall/block-details")).into_iter().flatten().flatten() {
        if e.file_name().to_string_lossy().starts_with("task-pair-guard") {
            out.push_str(&std::fs::read_to_string(e.path()).unwrap_or_default());
        }
    }
    out
}

#[test]
fn stop_long_launch_name_is_never_the_cut_name_a_step_asks_for() {
    // review finding: the block asked for owner "delta-diagnostics-mainta…" (the visible line cuts a long name), and setting exactly that left Stop blocked
    let w = World::new("stop-long-name");
    let long = "delta-diagnostics-maintainer-omega";
    w.track(&["inspect module delta-diagnostics"]);
    let agents = [("inspect module delta-diagnostics", Some(long))];
    let o = w.stop(&transcript(&[task(1, "in_progress", Some("inspect module"))], &agents), true, serde_json::json!({}));
    assert!(o.1.contains(GUARD), "blocks: {o:?}");
    assert!(o.1.contains("saved details") && o.1.contains("details:"), "the step points at the whole name: {o:?}");
    assert!(!o.1.contains("owner=\\\"delta-diagnostics-mainta"), "no step carries the cut name: {o:?}");
    let saved = saved_details(&w);
    assert!(saved.contains(&format!("TaskUpdate #1 owner=\"{long}\"")), "the saved details hold the whole name in the step: {saved}");
    // the step, done with the name the saved details hold, clears it; the cut name as the owner would not
    let cut = w.stop(&transcript(&[task(1, "in_progress", Some("delta-diagnostics-mainta\u{2026}"))], &agents), true, serde_json::json!({}));
    assert!(pair_text(&cut), "the twin: the cut name is not the launch name: {cut:?}");
    let ok = w.stop(&transcript(&[task(1, "in_progress", Some(long))], &agents), true, serde_json::json!({}));
    assert!(!pair_text(&ok), "the whole name clears it: {ok:?}");
    // the same input with the switch off prints nothing
    let off = w.stop(&transcript(&[task(1, "in_progress", Some("inspect module"))], &agents), false, serde_json::json!({}));
    assert!(!pair_text(&off), "{off:?}");
}

#[test]
fn post_advisory_step_carries_the_whole_name_or_points_at_it() {
    let long = "delta-diagnostics-maintainer-omega";
    // a name the line shows whole: the step has it
    let w = World::new("post-name-exact");
    let t = transcript(&[task(1, "in_progress", Some("someone-else"))], &[("port the wake", Some("wake-worker"))]);
    let o = w.post("wake-worker", &t, true);
    assert!(pair_text(&o) && o.1.contains("owner \\\"wake-worker\\\""), "the step names the agent whole: {o:?}");
    assert!(!o.1.contains("details:"), "an exact name needs no pointer: {o:?}");
    // a long name: the step is the pointer, the saved details hold the whole name, and that name pairs
    let w = World::new("post-name-long");
    let t = transcript(&[task(1, "in_progress", Some("someone-else"))], &[("port the wake", Some(long))]);
    let o = w.post(long, &t, true);
    assert!(pair_text(&o) && o.1.contains("details:"), "the step points at the saved details: {o:?}");
    assert!(!o.1.contains("delta-diagnostics-maintainer-omega\\\"."), "{o:?}");
    assert!(saved_details(&w).contains(&format!("owner \"{long}\"")), "the whole name is in the saved details: {}", saved_details(&w));
    let t = transcript(&[task(1, "in_progress", Some(long))], &[("port the wake", Some(long))]);
    assert!(!pair_text(&w.post(long, &t, true)), "the whole name pairs");
    // a name the message cleaning would change (a backtick): same
    let w = World::new("post-name-tick");
    let t = transcript(&[task(1, "in_progress", Some("someone-else"))], &[("port the wake", Some("wake`worker"))]);
    let o = w.post("wake`worker", &t, true);
    assert!(pair_text(&o) && o.1.contains("details:"), "{o:?}");
    assert!(saved_details(&w).contains("owner \"wake`worker\""), "{}", saved_details(&w));
}
