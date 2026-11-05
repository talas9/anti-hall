//! GH #516 part 2: every nudge kind of the severity table driven by its hook's REAL message (the shipped script on a scratch HOME,
//! a golden case or an inline one) through the ladder: the ladder counts it and blocks a Stop. A kind whose hook text never
//! matches, or whose hook's own dedupe reads as the condition cleared, fails here.
use super::golden;
use crate::dispatch::combine::HookResult;
use crate::dispatch::ladder::{self, Kind};
use crate::dispatch::native::{Answer, answer_of};
use serde_json::{Value, json};
use std::path::PathBuf;

fn result(check: &str, id: &str, l: &golden::Laid) -> HookResult {
    let v = golden::run_case(check, l, 1).unwrap_or_else(|| panic!("{check}: no shipped script"));
    match answer_of(id, v) {
        Answer::Decided(r, _) => r,
        Answer::Defer => HookResult::quiet(id),
    }
}

fn state_dir(tag: &str) -> PathBuf {
    let d = std::env::temp_dir().join(format!("ah-ladder-kinds-{tag}-{}", std::process::id()));
    crate::discard::harmless(std::fs::remove_dir_all(&d)); // keep: cleanup of a scratch directory
    d
}

fn all() -> Vec<Kind> {
    ladder::kinds(&serde_json::Map::new())
}

fn action(kind: &str) -> String {
    all().into_iter().find(|k| k.name == kind).unwrap_or_else(|| panic!("kind {kind} in nudges.kinds")).action
}

/// Run the laid case once per turn on the same home (so the hook's own dedupe and gates act as they do live), then a Stop; a hook
/// of the Stop runs on the Stop itself. `between(turn)` may change the home before a turn. Returns (turn of the first ladder block,
/// its reason, fires the hook gave).
fn drive(kind: &str, check: &str, id: &str, l: &golden::Laid, turns: usize, between: &dyn Fn(usize)) -> (Option<(usize, String)>, usize) {
    let dir = state_dir(kind);
    let ks = all();
    let k = ks.iter().find(|k| k.name == kind).unwrap();
    let mut fires = 0;
    for t in 0..turns {
        between(t);
        let r = result(check, id, l);
        if matches!(ladder::observe(k, std::slice::from_ref(&r)), ladder::Seen::Fired(_)) {
            fires += 1;
        }
        let on_stop = l.event == "Stop";
        if !on_stop {
            assert!(ladder::run_in(&dir, &l.event, &l.payload, &ks, std::slice::from_ref(&r)).is_none(), "only a Stop carries a ladder block");
        }
        let stop = if on_stop { vec![r] } else { Vec::new() };
        let mut b = ladder::run_in(&dir, "Stop", &l.payload, &ks, &stop);
        if b.is_none() && on_stop {
            b = ladder::run_in(&dir, "Stop", &l.payload, &ks, &[]); // a Stop the hook blocked holds the ladder block to the next
        }
        if let Some(b) = b {
            let reason = serde_json::from_str::<Value>(&b.out).unwrap()["reason"].as_str().unwrap().to_string();
            assert!(reason.contains(&action(kind)), "{kind}: the block names its action: {reason}");
            return (Some((t, reason)), fires);
        }
    }
    (None, fires)
}

fn golden_case(check: &str, pick: &dyn Fn(&Value) -> bool) -> Value {
    golden::load(check).into_iter().find(|c| pick(c)).unwrap_or_else(|| panic!("{check}: no such golden case"))
}

fn inline(event: &str, payload: Value, files: Value) -> Value {
    json!({"env": {"ANTIHALL_TEST_ISOLATION": "1", "HOME": "{HOME}"}, "event": event, "files": files, "payload": payload, "expect": {"v": "allow"}, "n": "inline"})
}

fn text_has(c: &Value, s: &str) -> bool {
    c["expect"].to_string().contains(s)
}

#[test]
fn finished_agents_counts_each_real_idle_sweep_state_and_escalates_though_the_sweep_shows_a_state_once() {
    let cases: Vec<Value> = golden::load("idle-agent-sweep").into_iter().filter(|c| c["expect"]["v"] == "advisory" && text_has(c, "finished agent")).collect();
    // the sweep shows one unchanged state once (emit-dedupe): 60 turns of the same state are one fire, never a quiet reset
    let l = golden::lay(&cases[0]);
    let (b, fires) = drive("finished_agents", "idle-agent-sweep", "idle-agent-sweep", &l, 60, &|_| {});
    assert!(b.is_none() && fires == 1, "one state, one fire: {fires}");
    // three distinct idle states (more finished agents left running) escalate at the third
    let (dir, ks) = (state_dir("finished-distinct"), all());
    let mut blocked = None;
    for (t, c) in cases.iter().take(3).enumerate() {
        let l = golden::lay(c);
        let r = result("idle-agent-sweep", "idle-agent-sweep", &l);
        assert!(ladder::run_in(&dir, &l.event, &cases[0]["payload"], &ks, &[r]).is_none());
        if let Some(b) = ladder::run_in(&dir, "Stop", &cases[0]["payload"], &ks, &[]) {
            blocked.get_or_insert((t, b.out));
        }
    }
    let (t, out) = blocked.expect("escalated after three fires");
    assert!(t == 2 && out.contains(&action("finished_agents")), "{t}: {out}");
}

#[test]
fn orchestration_inline_blocks_at_the_real_coordinator_workload_advisory() {
    let c = golden_case("coordinator-work-guard", &|c| c["event"] == "PostToolUse" && c["expect"]["v"] == "advisory");
    let l = golden::repeat_of(&c);
    let laid = golden::lay(&c);
    for _ in 1..l {
        result("coordinator-work-guard", "coordinator-work-guard:post", &laid);
    }
    let (b, _) = drive("orchestration_inline", "coordinator-work-guard", "coordinator-work-guard:post", &laid, 1, &|_| {});
    assert!(b.is_some_and(|(t, r)| t == 0 && r.contains("coordinator workload")), "P0 at first fire");
}

#[test]
fn model_routing_counts_the_real_routing_deny_and_blocks_the_stop() {
    let c = golden_case("model-routing", &|c| text_has(c, "routine execution was assigned to a flagship model"));
    let l = golden::lay(&c);
    let (b, _) = drive("model_routing", "model-routing", "model-routing-guard", &l, 1, &|_| {});
    assert!(b.is_some_and(|(t, r)| t == 0 && r.contains("flagship")), "P0 at first fire");
}

#[test]
fn model_routing_does_not_count_an_exempt_or_unrelated_note() {
    let k = all().into_iter().find(|k| k.name == "model_routing").unwrap();
    let note = defaults_text("model_routing.msg_handover_what");
    let r = HookResult { id: "model-routing-guard".into(), code: Some(0), out: json!({"systemMessage": note}).to_string(), err: String::new() };
    assert_eq!(ladder::observe(&k, &[r]), ladder::Seen::Quiet, "the handover tip is not a routing violation");
}

fn defaults_text(k: &str) -> String {
    crate::defaults::text(k).to_string()
}

#[test]
fn idle_open_tasks_counts_the_real_task_guard_stop_block() {
    let c = golden_case("task-guard", &|c| text_has(c, "open tasks have no agent working on them"));
    let l = golden::lay(&c);
    let (b, _) = drive("idle_open_tasks", "task-guard", "task-guard", &l, 1, &|_| {});
    assert!(b.is_some_and(|(_, r)| r.contains("open tasks have no agent")), "counted and blocked at the next Stop");
}

fn swarm_files(n: usize) -> Value {
    let mut out = String::new();
    for i in 0..n {
        let (tu, id) = (format!("toolu_{i}"), format!("a{i:015x}"));
        let call = json!({"type": "assistant", "message": {"content": [{"type": "tool_use", "id": tu, "name": "Agent", "input": {"description": format!("lane {i}"), "subagent_type": "Explore"}}]}});
        let res = json!({"type": "user", "message": {"content": [{"type": "tool_result", "tool_use_id": tu,
            "content": format!("Async agent launched successfully.\nagentId: {id} (internal ID - do not mention to user)\noutput_file: /tmp/x/{id}.output")}]}});
        out.push_str(&format!("{call}\n{res}\n"));
    }
    json!({"t.jsonl": out})
}

#[test]
fn agent_cap_counts_the_real_cap_deny_not_the_shared_tree_note() {
    let p = json!({"hook_event_name": "PreToolUse", "tool_name": "Agent", "tool_input": {"subagent_type": "Explore", "prompt": "x"}, "session_id": "cap-s", "transcript_path": "{HOME}/t.jsonl", "cwd": "{HOME}"});
    let l = golden::lay(&inline("PreToolUse", p, swarm_files(6)));
    let r = result("swarm-guard", "swarm-guard", &l);
    assert!(crate::dispatch::combine::blocks(&r), "6 running agents at the default cap of 6: the spawn is denied: {r:?}");
    let (b, _) = drive("agent_cap", "swarm-guard", "swarm-guard", &l, 1, &|_| {});
    assert!(b.is_some_and(|(t, r)| t == 0 && r.contains("agents are running")), "P0 at first fire");
    let k = all().into_iter().find(|k| k.name == "agent_cap").unwrap();
    let note = HookResult {
        id: "swarm-guard".into(),
        code: Some(0),
        out: json!({"systemMessage": defaults_text("swarm_guard.msg_shared_what")}).to_string(),
        err: String::new(),
    };
    assert_eq!(ladder::observe(&k, &[note]), ladder::Seen::Quiet, "the shared-tree note is not the cap");
}

#[test]
fn completed_tasks_counts_the_real_task_done_line_and_escalates() {
    let p = json!({"hook_event_name": "PostToolUse", "tool_name": "TaskUpdate", "tool_input": {"taskId": "3", "status": "completed"}, "session_id": "th-s", "cwd": "{HOME}", "transcript_path": "{HOME}/t.jsonl"});
    let l = golden::lay(&inline("PostToolUse", p, json!({"t.jsonl": ""})));
    let (b, fires) = drive("completed_tasks", "tasklist-hygiene", "tasklist-hygiene:post", &l, 6, &|_| {});
    assert!(b.is_some_and(|(_, r)| r.contains("done: delegate")), "escalated after its fires ({fires})");
}

/// Queue one tracker reminder row (the text the tracker renders) for the session the hook delivers to.
fn reminder_home(sig: &str, text: &str) -> golden::Laid {
    let p = json!({"hook_event_name": "UserPromptSubmit", "prompt": "go", "session_id": "rem-s", "cwd": "{HOME}"});
    let row = json!({"id": "r0", "signal": sig, "agent": "w1", "text": text});
    golden::lay(&inline("UserPromptSubmit", p, json!({".anti-hall/agent-tracker/reminders/rem-s.ndjson": format!("{row}\n")})))
}

fn agent_reminder_kind(kind: &str, sig: &str, text: String) {
    let l = reminder_home(sig, &text);
    let q = std::path::Path::new(&l.home).join(".anti-hall/agent-tracker/reminders/rem-s.ndjson");
    let add = |t: usize| {
        if t > 0 {
            let row = json!({"id": format!("r{t}"), "signal": sig, "agent": "w1", "text": text});
            let mut body = std::fs::read_to_string(&q).unwrap();
            body.push_str(&format!("{row}\n"));
            std::fs::write(&q, body).unwrap();
        }
    };
    let (b, fires) = drive(kind, "agent-reminders", "agent-reminders", &l, 6, &add);
    assert!(b.is_some(), "{kind}: never blocked ({fires} fires)");
    assert!(fires >= 1, "{kind}: the delivered reminder is a fire");
}

fn render(k: &str, vars: &[(&str, &dyn std::fmt::Display)]) -> String {
    crate::defaults::render(k, vars)
}

#[test]
fn stuck_agents_counts_the_real_hung_and_false_claim_reminders() {
    agent_reminder_kind("stuck_agents", "hung", render("msg.agent_hung", &[("agent", &"w1"), ("kind", &"subagent"), ("idle", &"25m"), ("tool", &"Bash")]));
    agent_reminder_kind("stuck_agents", "false_claim", render("msg.agent_false_claim", &[("agent", &"w1"), ("idle", &"6m"), ("line", &"\"still running\"")]));
}

#[test]
fn stalled_agents_counts_the_real_stalled_reminder() {
    let t = render("msg.agent_stalled", &[("agent", &"w1"), ("kind", &"subagent"), ("what", &"x"), ("idle", &"16m"), ("age", &"40m"), ("lines", &"\"a\"")]);
    agent_reminder_kind("stalled_agents", "stalled", t);
}

#[test]
fn idle_open_tasks_counts_the_real_idle_reminders() {
    agent_reminder_kind("idle_open_tasks", "idle_no_agents", render("msg.agent_idle_no_agents", &[("n", &2), ("idle", &"11m"), ("tasks", &"a, b")]));
    agent_reminder_kind(
        "idle_open_tasks",
        "idle_open_task",
        render("msg.agent_idle_open_task", &[("agent", &"w1"), ("kind", &"subagent"), ("idle", &"11m"), ("task", &"t")]),
    );
}

#[test]
fn parallel_dispatch_counts_the_real_underparallel_reminder() {
    let t = render("msg.agent_underparallel", &[("n", &2), ("items", &"a; b"), ("running", &1), ("cap", &6)]);
    agent_reminder_kind("parallel_dispatch", "underparallel", t);
}

#[test]
fn an_unrelated_tracker_reminder_is_no_stuck_or_stalled_fire() {
    let t = render("msg.agent_watched_exit", &[("agent", &"w1"), ("kind", &"subagent"), ("count", &1), ("task", &"t")]);
    let l = reminder_home("watched_exit", &t);
    let r = result("agent-reminders", "agent-reminders", &l);
    for k in all().iter().filter(|k| k.hooks.iter().any(|h| h == "agent-reminders")) {
        assert_eq!(ladder::observe(k, std::slice::from_ref(&r)), ladder::Seen::Quiet, "{}: a background exit notice is not its condition", k.name);
    }
}
