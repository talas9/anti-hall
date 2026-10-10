//! Tests of the agent tracker on fixture transcripts: a normal agent, a hung one, a looping one, a token burner with no commits, a
//! drifting one, a subagent, DevSwarm workspaces (and none), the cooldowns, the outcomes and the hook-side delivery.
use super::*;
use crate::reqenv::RequestEnv;
use crate::telemetry::emit;
use serde_json::{Value, json};
use std::collections::HashMap;
use std::io::Write;
use std::path::{Path, PathBuf};

const MIN: u64 = 60_000;

fn home(tag: &str) -> PathBuf {
    let d = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("target").join("test-agents").join(format!("{tag}-{}", std::process::id()));
    crate::discard::harmless(std::fs::remove_dir_all(&d)); // keep: cleanup that raced; an absent dir is the goal state
    std::fs::create_dir_all(d.join(".claude/projects/p")).unwrap();
    d
}

fn now0() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis() as u64
}

fn env(h: &Path, now: u64) -> Env {
    Env {
        home: h.to_path_buf(),
        now_ms: now,
        plugin_root: None,
        use_cli: false,
        settings: Settings { home: h.to_string_lossy().to_string(), env: HashMap::new() },
        act: true,
    }
}

fn iso(ms: u64) -> String {
    crate::checks::agent_scan::iso_utc(ms as f64)
}

fn sess(h: &Path, id: &str) -> PathBuf {
    h.join(".claude/projects/p").join(format!("{id}.jsonl"))
}

fn write(p: &Path, lines: &[String]) {
    std::fs::create_dir_all(p.parent().unwrap()).unwrap();
    std::fs::write(p, lines.join("\n") + "\n").unwrap();
}

fn append(p: &Path, lines: &[String]) {
    let mut f = std::fs::OpenOptions::new().append(true).open(p).unwrap();
    writeln!(f, "{}", lines.join("\n")).unwrap();
}

fn prompt(ts: u64, cwd: &str) -> String {
    json!({"type": "user", "timestamp": iso(ts), "cwd": cwd, "message": {"role": "user", "content": "go"}}).to_string()
}

/// An assistant line. `stop` is the stop_reason (None while the turn goes on).
fn asst(ts: u64, mid: &str, tin: u64, tout: u64, blocks: Value, stop: Option<&str>) -> String {
    json!({"type": "assistant", "timestamp": iso(ts), "message": {"id": mid, "role": "assistant", "stop_reason": stop, "content": blocks,
        "usage": {"input_tokens": tin, "output_tokens": tout, "cache_read_input_tokens": 0, "cache_creation_input_tokens": 0}}})
    .to_string()
}

fn tool(ts: u64, mid: &str, tin: u64, id: &str, name: &str, input: Value) -> String {
    asst(ts, mid, tin, 10, json!([{"type": "tool_use", "id": id, "name": name, "input": input}]), None)
}

fn result(ts: u64, id: &str, text: &str, err: bool) -> String {
    json!({"type": "user", "timestamp": iso(ts), "message": {"role": "user", "content": [{"type": "tool_result", "tool_use_id": id, "content": text, "is_error": err}]}}).to_string()
}

fn agent<'a>(st: &'a State, id: &str) -> &'a Agent {
    st.agents.get(id).unwrap_or_else(|| panic!("no agent {id}; have {:?}", st.agents.keys().collect::<Vec<_>>()))
}

fn queue(h: &Path, key: &str) -> Vec<Value> {
    let p = h.join(".anti-hall/agent-tracker/reminders").join(format!("{key}.ndjson"));
    std::fs::read_to_string(p).map(|t| t.lines().map(|l| serde_json::from_str(l).unwrap()).collect()).unwrap_or_default()
}

fn ticks(h: &Path, st: &mut State, at: &[u64]) {
    for n in at {
        tick(&env(h, *n), st);
    }
}

// ---- a normal agent -----------------------------------------------------------------------------------------

#[test]
fn a_normal_agent_is_counted_once_and_raises_nothing() {
    let h = home("normal");
    let n = now0();
    let p = sess(&h, "s1");
    let dup = asst(n - 2 * MIN, "m3", 7, 3, json!([{"type": "text", "text": "done"}]), Some("end_turn"));
    write(
        &p,
        &[
            prompt(n - 9 * MIN, "/w"),
            tool(n - 8 * MIN, "m1", 100, "u1", "Edit", json!({"file_path": "/w/a.rs"})),
            result(n - 7 * MIN, "u1", "ok", false),
            tool(n - 6 * MIN, "m2", 200, "u2", "Bash", json!({"command": "git commit -m x"})),
            result(n - 5 * MIN, "u2", "ok", false),
            dup.clone(),
            dup,
        ],
    );
    let mut st = State::default();
    ticks(&h, &mut st, &[n, n + MIN]);
    let a = agent(&st, "s1");
    assert_eq!((a.tin, a.tout, a.tools, a.edits, a.commits), (307, 23, 2, 1, 1), "the repeated message is counted once");
    assert_eq!(a.progress, weight("file") + weight("commit"));
    assert!(a.flags.is_empty(), "{:?}", a.flags);
    assert_eq!(state::of(a), state_name("waiting"));
    assert!(queue(&h, "s1").is_empty());
    assert_eq!(a.samples.len(), 2, "a series sample per tick");
}

mod state {
    pub fn of(a: &super::Agent) -> &'static str {
        super::signals::state_of(a)
    }
}

// ---- hung ---------------------------------------------------------------------------------------------------

#[test]
fn a_silent_running_agent_is_hung_and_reminded_after_it_stays_hung() {
    let h = home("hung");
    let n = now0();
    write(&sess(&h, "s1"), &[prompt(n - 30 * MIN, "/w"), asst(n - 25 * MIN, "m1", 5, 5, json!([{"type": "text", "text": "working"}]), None)]);
    let mut st = State::default();
    ticks(&h, &mut st, &[n]);
    let f = agent(&st, "s1").flags.get("hung").expect("hung after 25 silent minutes");
    assert!(f.evidence >= 25 * 60, "idle seconds in the evidence: {}", f.evidence);
    assert!(queue(&h, "s1").is_empty(), "confirm_ticks: not on the first tick");
    ticks(&h, &mut st, &[n + MIN]);
    let q = queue(&h, "s1");
    assert_eq!(q.len(), 1, "queued once the flag held for confirm_ticks");
    assert!(q[0]["text"].as_str().unwrap().contains("no output"), "{q:?}");
    assert_eq!(q[0]["signal"], "hung");
}

#[test]
fn a_long_unanswered_tool_call_is_not_hung_until_the_pending_limit() {
    let h = home("pending");
    let n = now0();
    write(&sess(&h, "s1"), &[prompt(n - 31 * MIN, "/w"), tool(n - 30 * MIN, "m1", 5, "u1", "Bash", json!({"command": "cargo build"}))]);
    let mut st = State::default();
    ticks(&h, &mut st, &[n]);
    assert!(agent(&st, "s1").flags.is_empty(), "30 minutes with a build running is legitimate");
    ticks(&h, &mut st, &[n + 20 * MIN]);
    let f = agent(&st, "s1").flags.get("hung").expect("hung past hung_pending_ms");
    assert!(f.text.contains("cargo build"), "the evidence names the call: {}", f.text);
}

#[test]
fn a_finished_turn_waits_and_is_never_hung() {
    let h = home("waiting");
    let n = now0();
    write(&sess(&h, "s1"), &[prompt(n - 200 * MIN, "/w"), asst(n - 199 * MIN, "m1", 5, 5, json!([{"type": "text", "text": "done"}]), Some("end_turn"))]);
    let mut st = State::default();
    ticks(&h, &mut st, &[n, n + MIN]);
    assert!(agent(&st, "s1").flags.is_empty());
}

// ---- looping ------------------------------------------------------------------------------------------------

#[test]
fn the_same_failing_command_over_and_over_is_a_loop() {
    let h = home("loop");
    let n = now0();
    let mut l = vec![prompt(n - 20 * MIN, "/w")];
    for i in 0..6u64 {
        let id = format!("u{i}");
        l.push(tool(n - (19 - i) * MIN, &format!("m{i}"), 50, &id, "Bash", json!({"command": "cargo test -p demo"})));
        l.push(result(n - (19 - i) * MIN + 1000, &id, "error[E0308]: mismatched types", true));
    }
    write(&sess(&h, "s1"), &l);
    let mut st = State::default();
    ticks(&h, &mut st, &[n]);
    let f = agent(&st, "s1").flags.get("looping").expect("looping");
    assert!(f.evidence >= lim("loop_repeats"), "{}", f.evidence);
    assert!(f.text.contains("cargo test"), "{}", f.text);
}

#[test]
fn varied_commands_are_not_a_loop() {
    let h = home("noloop");
    let n = now0();
    let mut l = vec![prompt(n - 20 * MIN, "/w")];
    for i in 0..8u64 {
        l.push(tool(n - (19 - i) * MIN, &format!("m{i}"), 50, &format!("u{i}"), "Bash", json!({"command": format!("ls dir{i}")})));
    }
    write(&sess(&h, "s1"), &l);
    let mut st = State::default();
    ticks(&h, &mut st, &[n]);
    assert!(!agent(&st, "s1").flags.contains_key("looping"));
}

// ---- token waste --------------------------------------------------------------------------------------------

#[test]
fn heavy_spend_with_no_progress_is_token_waste_and_a_commit_clears_it() {
    let h = home("waste");
    let n = now0();
    let p = sess(&h, "s1");
    write(&p, &[prompt(n - 2 * MIN, "/w"), asst(n - MIN, "m0", 1000, 10, json!([{"type": "text", "text": "thinking"}]), None)]);
    let mut st = State::default();
    ticks(&h, &mut st, &[n]);
    append(&p, &[asst(n + 19 * MIN, "m1", 700_000, 10, json!([{"type": "text", "text": "still thinking"}]), None)]);
    ticks(&h, &mut st, &[n + 20 * MIN]);
    let f = agent(&st, "s1").flags.get("token_waste").expect("token_waste");
    assert!(f.evidence >= lim("waste_min_tokens"), "{}", f.evidence);
    // the same spend with a commit in the window is progress, not waste
    let h2 = home("waste-ok");
    let p2 = sess(&h2, "s1");
    write(&p2, &[prompt(n - 2 * MIN, "/w"), asst(n - MIN, "m0", 1000, 10, json!([{"type": "text", "text": "thinking"}]), None)]);
    let mut st2 = State::default();
    ticks(&h2, &mut st2, &[n]);
    append(&p2, &[tool(n + 18 * MIN, "m1", 700_000, "u1", "Bash", json!({"command": "git commit -m done"})), result(n + 19 * MIN, "u1", "ok", false)]);
    ticks(&h2, &mut st2, &[n + 20 * MIN]);
    assert!(!agent(&st2, "s1").flags.contains_key("token_waste"));
}

// ---- drift --------------------------------------------------------------------------------------------------

fn drift_lines(n: u64, path: &str) -> Vec<String> {
    let mut l = vec![
        prompt(n - 30 * MIN, "/w"),
        tool(
            n - 29 * MIN,
            "t0",
            5,
            "td",
            "TodoWrite",
            json!({"todos": [{"content": "x", "activeForm": "Implementing battery gauge widget rendering", "status": "in_progress"}]}),
        ),
    ];
    for i in 0..9u64 {
        l.push(tool(n - (28 - i) * MIN, &format!("m{i}"), 5, &format!("u{i}"), "Edit", json!({"file_path": format!("{path}{i}.rs")})));
    }
    l
}

#[test]
fn work_unrelated_to_the_declared_step_is_drift_and_names_the_step() {
    let h = home("drift");
    let n = now0();
    write(&sess(&h, "s1"), &drift_lines(n, "/w/src/billing/invoice_export_"));
    let mut st = State::default();
    ticks(&h, &mut st, &[n, n + MIN]);
    let a = agent(&st, "s1");
    assert!(a.flags.contains_key("drift"), "{:?} step={:?}", a.flags, a.step);
    let q = queue(&h, "s1");
    assert!(q[0]["text"].as_str().unwrap().contains("Implementing battery gauge widget rendering"), "the correction names the step: {q:?}");
}

#[test]
fn work_that_matches_the_step_is_not_drift() {
    let h = home("ondrift");
    let n = now0();
    write(&sess(&h, "s1"), &drift_lines(n, "/w/src/battery/gauge_widget_"));
    let mut st = State::default();
    ticks(&h, &mut st, &[n]);
    assert!(!agent(&st, "s1").flags.contains_key("drift"));
}

// ---- subagents ----------------------------------------------------------------------------------------------

#[test]
fn a_hung_subagent_is_reported_to_the_session_that_launched_it() {
    let h = home("sub");
    let n = now0();
    write(&sess(&h, "parent"), &[prompt(n - 30 * MIN, "/w"), asst(n - MIN, "p1", 5, 5, json!([{"type": "text", "text": "waiting"}]), Some("end_turn"))]);
    let dir = h.join(".claude/projects/p/parent/subagents");
    write(&dir.join("agent-abc.jsonl"), &[prompt(n - 40 * MIN, "/w"), asst(n - 35 * MIN, "s1", 5, 5, json!([{"type": "text", "text": "x"}]), None)]);
    std::fs::write(dir.join("agent-abc.meta.json"), r#"{"description":"Identify skipped tests"}"#).unwrap();
    let mut st = State::default();
    ticks(&h, &mut st, &[n, n + MIN]);
    let a = agent(&st, "abc");
    assert_eq!((a.kind.as_str(), a.parent.as_str(), a.name.as_str()), ("subagent", "parent", "Identify skipped tests"));
    let q: Vec<Value> = queue(&h, "parent").into_iter().filter(|r| r["signal"] == "hung").collect();
    assert_eq!(q.len(), 1, "the advisory goes to the coordinator, naming the agent with its evidence");
    assert!(q[0]["text"].as_str().unwrap().contains("Identify skipped tests"), "{q:?}");
    assert!(queue(&h, "abc").is_empty(), "hung is not routed to the hung agent itself");
}

fn notice(ts: u64, id: &str, status: &str) -> String {
    let body = format!("<task-notification>\n<task-id>{id}</task-id>\n<status>{status}</status>\n</task-notification>");
    json!({"type": "user", "timestamp": iso(ts), "message": {"role": "user", "content": body}}).to_string()
}

#[test]
fn a_stopped_subagent_is_done_not_hung_and_a_live_one_still_is() {
    let h = home("stopped");
    let n = now0();
    write(&sess(&h, "parent"), &[prompt(n - 60 * MIN, "/w"), notice(n - 30 * MIN, "abc", "killed")]);
    let dir = h.join(".claude/projects/p/parent/subagents");
    for id in ["abc", "def"] {
        write(
            &dir.join(format!("agent-{id}.jsonl")),
            &[prompt(n - 70 * MIN, "/w"), asst(n - 65 * MIN, "s1", 5, 5, json!([{"type": "text", "text": "x"}]), None)],
        );
    }
    let mut st = State::default();
    ticks(&h, &mut st, &[n, n + MIN, n + 2 * MIN]);
    assert_eq!(signals::state_of(agent(&st, "abc")), "done", "a killed agent is done");
    assert_eq!(signals::state_of(agent(&st, "def")), "running", "an agent nothing ended is still tracked as running");
    let hung: Vec<Value> = queue(&h, "parent").into_iter().filter(|r| r["signal"] == "hung").collect();
    assert!(hung.iter().all(|r| !r["text"].as_str().unwrap().contains("abc")), "no hung reminder about the stopped agent: {hung:?}");
    assert!(hung.iter().any(|r| r["text"].as_str().unwrap().contains("def")), "the true positive still fires: {hung:?}");
}

// ---- wake paths ---------------------------------------------------------------------------------------------

fn parent_with_bg(h: &Path, n: u64, arm: Option<Value>) {
    let mut l = vec![prompt(n - 10 * MIN, "/w"), asst(n - 9 * MIN, "p0", 5, 5, json!([{"type": "text", "text": "launching"}]), None)];
    if let Some(input) = arm {
        l.push(tool(n - 8 * MIN, "p1", 5, "mon", "Monitor", input));
    }
    write(&sess(h, "parent"), &l);
    write(
        &h.join(".claude/projects/p/parent/subagents/agent-bg1.jsonl"),
        &[prompt(n - 5 * MIN, "/w"), asst(n - MIN, "b1", 5, 5, json!([{"type": "text", "text": "running"}]), None)],
    );
}

#[test]
fn background_work_with_no_wake_path_gets_an_arm_reminder() {
    let h = home("unarmed");
    let n = now0();
    parent_with_bg(&h, n, None);
    let mut st = State::default();
    ticks(&h, &mut st, &[n, n + MIN]);
    let f = agent(&st, "parent").flags.get("monitor_unarmed").expect("monitor_unarmed");
    assert_eq!(f.evidence, 1);
    let q = queue(&h, "parent");
    assert!(q.iter().any(|r| r["text"].as_str().unwrap().contains("Monitor")), "{q:?}");
}

#[test]
fn an_armed_monitor_keeps_the_reminder_quiet() {
    let h = home("armed");
    let n = now0();
    parent_with_bg(&h, n, Some(json!({"command": "tail -f out", "persistent": true})));
    let mut st = State::default();
    ticks(&h, &mut st, &[n, n + MIN]);
    assert!(!agent(&st, "parent").flags.contains_key("monitor_unarmed"));
}

// ---- DevSwarm -----------------------------------------------------------------------------------------------

fn devswarm(h: &Path, n: u64, lock_ts: Option<u64>) {
    let d = h.join(".anti-hall/devswarm");
    write(
        &h.join(".claude/projects/p/sessW.jsonl"),
        &[prompt(n - 5 * MIN, "/wt/x"), asst(n - MIN, "w1", 5, 5, json!([{"type": "text", "text": "on it"}]), Some("end_turn"))],
    );
    std::fs::create_dir_all(d.join("workspaces")).unwrap();
    std::fs::create_dir_all(d.join("plans")).unwrap();
    std::fs::create_dir_all(d.join("locks")).unwrap();
    std::fs::write(d.join("workspaces/ws1.json"), r#"{"id":"ws1","sessionId":"sessW","worktreePath":"/wt/x"}"#).unwrap();
    std::fs::write(
        d.join("plans/primary-1.json"),
        r#"{"worktreePath":"/wt/x","steps":[{"n":1,"text":"Add the gauge","status":"done"},{"n":2,"text":"Wire telemetry export","status":"doing","ts":5}]}"#,
    )
    .unwrap();
    if let Some(ts) = lock_ts {
        std::fs::write(d.join("locks/wake-watch-ws1.lock"), json!({"ts": ts, "pid": std::process::id()}).to_string()).unwrap();
    }
}

fn outbox(h: &Path) -> Vec<Value> {
    std::fs::read_to_string(h.join(".anti-hall/agent-tracker/mesh-outbox.ndjson"))
        .map(|t| t.lines().map(|l| serde_json::from_str(l).unwrap()).collect())
        .unwrap_or_default()
}

#[test]
fn a_workspace_without_a_live_wake_watch_is_told_the_exact_arm_command_over_the_mesh() {
    let h = home("ws-stale");
    let n = now0();
    devswarm(&h, n, Some(n - 10 * MIN));
    let mut st = State::default();
    let mut e = env(&h, n);
    e.plugin_root = Some(PathBuf::from("/plug"));
    tick(&e, &mut st);
    assert_eq!(agent(&st, "sessW").progress, 0, "steps done before the first look are history, not progress");
    std::fs::write(
        h.join(".anti-hall/devswarm/plans/primary-1.json"),
        r#"{"worktreePath":"/wt/x","steps":[{"n":1,"text":"Add the gauge","status":"done"},{"n":2,"text":"Wire telemetry export","status":"done","ts":5}]}"#,
    )
    .unwrap();
    e.now_ms = n + MIN;
    tick(&e, &mut st);
    let a = agent(&st, "sessW");
    assert_eq!(a.kind, kind_name("workspace"));
    assert_eq!(a.step, "Wire telemetry export", "the plan step is the declared step");
    assert_eq!(a.progress, weight("step"), "a plan step finished while tracked is progress");
    assert!(a.flags.contains_key("monitor_unarmed"));
    let rows = outbox(&h);
    assert_eq!(rows.len(), 1, "{rows:?}");
    assert_eq!((rows[0]["workspace"].as_str(), rows[0]["to_parent"].as_bool()), (Some("ws1"), Some(false)));
    assert!(rows[0]["text"].as_str().unwrap().contains("node /plug/companion/lib/devswarm-wake-watch.js"), "{rows:?}");
    assert!(queue(&h, "sessW").is_empty(), "a workspace is not reached through a session queue");
}

#[test]
fn a_workspace_with_a_fresh_live_wake_watch_is_quiet() {
    let h = home("ws-armed");
    let n = now0();
    devswarm(&h, n, Some(n));
    let mut st = State::default();
    ticks(&h, &mut st, &[n, n + MIN]);
    assert_eq!(agent(&st, "sessW").ws.as_ref().unwrap().armed, Some(true));
    assert!(agent(&st, "sessW").flags.is_empty());
    assert!(outbox(&h).is_empty());
}

#[test]
fn without_devswarm_nothing_devswarm_happens() {
    let h = home("no-ds");
    let n = now0();
    write(&sess(&h, "sessW"), &[prompt(n - 5 * MIN, "/wt/x"), asst(n - MIN, "w1", 5, 5, json!([{"type": "text", "text": "on it"}]), Some("end_turn"))]);
    let mut st = State::default();
    ticks(&h, &mut st, &[n, n + MIN]);
    let a = agent(&st, "sessW");
    assert!(a.ws.is_none() && a.kind == kind_name("main"));
    assert!(outbox(&h).is_empty());
}

// ---- heartbeat ----------------------------------------------------------------------------------------------

#[test]
fn a_stale_running_heartbeat_reminds_the_newest_main_session_and_a_finished_one_is_ignored() {
    let h = home("hb");
    let n = now0();
    write(&sess(&h, "main1"), &[prompt(n - 3 * MIN, "/w"), asst(n - MIN, "m1", 5, 5, json!([{"type": "text", "text": "ok"}]), Some("end_turn"))]);
    let hb = h.join(".anti-hall/agents");
    std::fs::create_dir_all(&hb).unwrap();
    std::fs::write(hb.join("job1.json"), json!({"id": "job1", "ts": n - 30 * MIN, "status": "running", "step": "compiling"}).to_string()).unwrap();
    std::fs::write(hb.join("job2.json"), json!({"id": "job2", "ts": n - 30 * MIN, "status": "done"}).to_string()).unwrap();
    let mut st = State::default();
    ticks(&h, &mut st, &[n, n + MIN]);
    assert!(st.agents.contains_key("heartbeatjob1") && !st.agents.contains_key("heartbeatjob2"));
    let q = queue(&h, "main1");
    assert!(q.iter().any(|r| r["text"].as_str().unwrap().contains("compiling")), "{q:?}");
}

#[test]
fn the_heartbeat_rule_agrees_with_the_node_watchdog_on_running_agents() {
    let Ok(node) = std::process::Command::new("node").arg("--version").output() else { return };
    if !node.status.success() {
        return;
    }
    let h = home("witness");
    let n = now0();
    let hb = h.join(".anti-hall/agents");
    std::fs::create_dir_all(&hb).unwrap();
    for (id, age) in [("old", 30 * MIN), ("fresh", MIN), ("older", 90 * MIN)] {
        std::fs::write(hb.join(format!("{id}.json")), json!({"id": id, "ts": n - age, "status": "running"}).to_string()).unwrap();
    }
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../plugins/anti-hall/hooks/agent-watchdog.js");
    let out = std::process::Command::new("node").arg(root).arg(lim("heartbeat_stale_ms").to_string()).env("HOME", &h).output().unwrap();
    let mut node_ids: Vec<String> = String::from_utf8_lossy(&out.stdout)
        .lines()
        .filter_map(|l| l.strip_prefix("STALE "))
        .filter_map(|l| l.split_whitespace().next().map(str::to_string))
        .collect();
    node_ids.sort();
    let mut st = State::default();
    tick(&env(&h, n), &mut st);
    let mut ours: Vec<String> = st.agents.values().filter(|a| a.flags.contains_key("heartbeat_stale")).map(|a| a.name.clone()).collect();
    ours.sort();
    assert_eq!(ours, node_ids, "the engine and the Node watchdog flag the same running heartbeats");
}

// ---- cooldowns, caps, outcomes ------------------------------------------------------------------------------

/// The injected clock of the cooldown, cap and outcome tests: noon UTC of a fixed day, so the day bucket (`now_ms / day_ms`) of the
/// later ticks never depends on the time of day the suite runs at (it used to split within 40 minutes before 00:00 UTC).
const HUNG_CLOCK_MS: u64 = 1_768_478_400_000;

fn hung_home(tag: &str) -> (PathBuf, u64, PathBuf) {
    let h = home(tag);
    let n = HUNG_CLOCK_MS;
    let p = sess(&h, "s1");
    write(&p, &[prompt(n - 60 * MIN, "/w"), asst(n - 55 * MIN, "m1", 5, 5, json!([{"type": "text", "text": "working"}]), None)]);
    (h, n, p)
}

#[test]
fn a_cooldown_holds_the_next_reminder_back_and_says_so_once() {
    let (h, n, _) = hung_home("cool");
    let mut st = State::default();
    emit::take_queued();
    ticks(&h, &mut st, &[n, n + MIN, n + 2 * MIN, n + 3 * MIN]);
    assert_eq!(queue(&h, "s1").len(), 1, "inside the cooldown nothing more is queued");
    let evs = emit::take_queued();
    let held = evs.iter().filter(|e| e.h.as_str() == "reminder" && e.o == crate::telemetry::event::Outcome::Skip).count();
    assert_eq!(held, 1, "the suppression is recorded once per cooldown, not once per tick");
    ticks(&h, &mut st, &[n + 40 * MIN]);
    assert_eq!(queue(&h, "s1").len(), 2, "after the cooldown it is queued again");
    assert_eq!(st.today(&env(&h, n)).queued, 2);
    assert_eq!(st.today(&env(&h, n)).suppressed, 1);
}

#[test]
fn an_agent_with_undelivered_reminders_is_not_flooded() {
    let (h, n, _) = hung_home("pending-cap");
    let mut st = State::default();
    ticks(&h, &mut st, &[n, n + MIN, n + 35 * MIN, n + 70 * MIN, n + 105 * MIN, n + 140 * MIN]);
    assert_eq!(queue(&h, "s1").len(), 3, "max_pending undelivered reminders, then they are held back");
}

#[test]
fn recovery_after_a_reminder_is_recorded_with_how_long_it_took() {
    let (h, n, p) = hung_home("recover");
    let mut st = State::default();
    ticks(&h, &mut st, &[n, n + MIN]);
    emit::take_queued();
    append(&p, &[asst(n + 6 * MIN, "m2", 5, 5, json!([{"type": "text", "text": "back"}]), Some("end_turn"))]);
    ticks(&h, &mut st, &[n + 7 * MIN]);
    assert!(agent(&st, "s1").flags.is_empty());
    let evs = emit::take_queued();
    let rec = evs.iter().find(|e| e.h.as_str() == "outcome" && e.e.as_str() == "recovered").expect("a recovered outcome");
    let crate::telemetry::event::Extras::Fields(f) = &rec.extras else { panic!("fields") };
    assert_eq!(f.get_num("lat_s"), Some(6 * 60), "six minutes after the reminder");
    assert_eq!(st.today(&env(&h, n)).recovered, 1);
}

#[test]
fn a_flag_that_clears_on_its_own_with_progress_is_a_false_positive() {
    let (h, n, p) = hung_home("fp");
    let mut st = State::default();
    ticks(&h, &mut st, &[n]);
    assert!(agent(&st, "s1").flags.contains_key("hung"));
    append(
        &p,
        &[
            tool(n + 30_000, "m2", 5, "u1", "Edit", json!({"file_path": "/w/new.rs"})),
            result(n + 31_000, "u1", "ok", false),
            asst(n + 32_000, "m3", 5, 5, json!([{"type": "text", "text": "done"}]), Some("end_turn")),
        ],
    );
    ticks(&h, &mut st, &[n + MIN]);
    assert!(agent(&st, "s1").flags.is_empty());
    let day = st.today(&env(&h, n));
    assert_eq!((day.false_positives, day.recovered), (1, 0));
    assert!(queue(&h, "s1").is_empty(), "it was never reminded");
}

#[test]
fn every_signal_and_series_sample_is_telemetry_and_the_report_totals_them() {
    let (h, n, _) = hung_home("tel");
    let mut st = State::default();
    emit::take_queued();
    ticks(&h, &mut st, &[n, n + MIN]);
    let evs = emit::take_queued();
    assert!(evs.iter().any(|e| e.h.as_str() == "signal" && e.e.as_str() == "hung"));
    assert!(evs.iter().any(|e| e.h.as_str() == "series"));
    assert!(evs.iter().any(|e| e.h.as_str() == "reminder" && e.e.as_str() == "hung"));
    for e in &evs {
        let back = crate::telemetry::event::Event::from_json(&e.to_json()).expect("an agent event reads back under the schema");
        assert_eq!(&back, e);
    }
    let sec = crate::telemetry::report::agent_section(evs);
    assert_eq!(sec["signals"]["hung"], 1);
    assert_eq!(sec["reminders_sent"][chan("session")], 1);
}

// ---- the hook side, the state file, the status table --------------------------------------------------------

#[test]
fn the_hook_check_delivers_queued_reminders_once_and_the_tick_sees_the_delivery() {
    let (h, n, _) = hung_home("deliver");
    let mut st = State::default();
    ticks(&h, &mut st, &[n, n + MIN]);
    let renv = RequestEnv::from_pairs([("HOME", h.to_str().unwrap())]);
    let payload = json!({"hook_event_name": "UserPromptSubmit", "session_id": "s1"});
    let first = crate::script::run_forced("agent-reminders", &payload, &Value::Null, "UserPromptSubmit", &renv).expect("a shipped script").expect("a verdict");
    match first {
        crate::checks::Verdict::Advisory(j) => assert!(j.contains("no output"), "{j}"),
        other => panic!("expected an advisory, got {other:?}"),
    }
    let second = crate::script::run_forced("agent-reminders", &payload, &Value::Null, "PostToolUse", &renv).expect("a shipped script").expect("a verdict");
    assert!(matches!(second, crate::checks::Verdict::Allow), "a delivered reminder is not repeated");
    let other = json!({"hook_event_name": "Stop", "session_id": "s1"});
    assert!(matches!(crate::script::run_forced("agent-reminders", &other, &Value::Null, "Stop", &renv).unwrap().unwrap(), crate::checks::Verdict::Allow));
    ticks(&h, &mut st, &[n + 2 * MIN]);
    assert_eq!(st.today(&env(&h, n)).delivered, 1);
    assert!(agent(&st, "s1").flags["hung"].delivered_at > 0);
}

#[test]
fn state_round_trips_and_a_damaged_file_is_discarded() {
    let h = home("state");
    let n = now0();
    write(&sess(&h, "s1"), &[prompt(n - MIN, "/w"), tool(n - 30_000, "m1", 9, "u1", "Edit", json!({"file_path": "/w/a.rs"}))]);
    let e = env(&h, n);
    let mut st = State::default();
    tick(&e, &mut st);
    save_state(&e, &st);
    let back = load_state(&e);
    assert_eq!(back.agents["s1"].tin, 9);
    assert_eq!(back.agents["s1"].offset, st.agents["s1"].offset);
    std::fs::write(e.dir().join(pth("state")), "{not json").unwrap();
    assert!(load_state(&e).agents.is_empty());
}

#[test]
fn the_status_table_lists_every_agent_with_tokens_progress_and_flags() {
    let (h, n, _) = hung_home("status");
    write(&sess(&h, "s2"), &[prompt(n - MIN, "/w"), asst(n - 30_000, "x1", 11, 22, json!([{"type": "text", "text": "ok"}]), Some("end_turn"))]);
    let mut st = State::default();
    let mut e = env(&h, n);
    e.act = false;
    let l = tick(&e, &mut st);
    let doc = status::document(&e, &st, &l);
    assert_eq!(doc["agents"].as_array().unwrap().len(), 2);
    assert_eq!(doc["agents"][0]["agent"], "s1", "flagged agents first");
    assert_eq!(doc["agents"][0]["flags"][0]["signal"], "hung");
    let text = status::render(&doc);
    for col in defaults::raw("agent_tracker.fmt").get("columns").unwrap().strings() {
        assert!(text.contains(col), "{col} in\n{text}");
    }
    assert!(text.contains("s2") && text.contains("hung"), "{text}");
    assert!(!h.join(".anti-hall/agent-tracker/reminders").exists(), "a status read queues nothing");
    assert!(emit::take_queued().is_empty(), "a status read records nothing");
}

#[test]
fn the_tracker_never_acts_on_an_agent_it_only_flags() {
    let (h, n, p) = hung_home("noact");
    let before = std::fs::read(&p).unwrap();
    let mut st = State::default();
    ticks(&h, &mut st, &[n, n + MIN, n + 40 * MIN]);
    assert_eq!(std::fs::read(&p).unwrap(), before, "a transcript is only ever read");
}

// ---- polling is not a loop; the Claude Code CLI as a source ---------------------------------------------------

#[test]
fn the_same_poll_every_few_minutes_is_not_a_loop() {
    let h = home("poll");
    let n = now0();
    let mut l = vec![prompt(n - 60 * MIN, "/w")];
    for i in 0..7u64 {
        l.push(tool(n - (30 - i * 5) * MIN, &format!("m{i}"), 5, &format!("u{i}"), "Bash", json!({"command": "sleep 298; echo t"})));
        l.push(result(n - (30 - i * 5) * MIN + 1000, &format!("u{i}"), "t", false));
    }
    write(&sess(&h, "s1"), &l);
    let mut st = State::default();
    ticks(&h, &mut st, &[n]);
    assert!(!agent(&st, "s1").flags.contains_key("looping"), "seven polls five minutes apart are not a tight loop");
}

fn fake_claude(h: &Path, body: &str) -> PathBuf {
    use std::os::unix::fs::PermissionsExt;
    let p = h.join("fake-claude");
    std::fs::write(&p, format!("#!/bin/sh\n{body}\n")).unwrap();
    std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o755)).unwrap();
    p
}

#[test]
fn the_cli_listing_settles_busy_waiting_and_gone_and_a_broken_cli_falls_back_to_the_transcripts() {
    let h = home("cli");
    let n = now0();
    for id in ["s1", "s2"] {
        write(&sess(&h, id), &[prompt(n - 60 * MIN, "/w"), asst(n - 50 * MIN, "m1", 5, 5, json!([{"type": "text", "text": "x"}]), None)]);
    }
    let var = defaults::env_name("claude_bin");
    let good = fake_claude(
        &h,
        "case \"$1\" in --version) echo '2.1.295 (Claude Code)';; agents) echo '[{\"sessionId\":\"s1\",\"kind\":\"interactive\",\"status\":\"waiting\"}]';; esac",
    );
    // SAFETY: only this test sets the variable; the other tests run with the CLI source off and never read it.
    unsafe { std::env::set_var(var, &good) };
    let mut e = env(&h, n);
    e.use_cli = true;
    let mut st = State::default();
    let l = tick(&e, &mut st);
    assert!(l.cli_used && st.cli_ok == Some(true) && st.cli_version == "2.1.295");
    assert!(agent(&st, "s1").flags.is_empty(), "the host says s1 waits for input: silent is not hung");
    assert_eq!(state::of(agent(&st, "s1")), state_name("waiting"));
    assert!(agent(&st, "s2").gone && agent(&st, "s2").flags.is_empty(), "a session the host no longer lists has no process");
    let bad = fake_claude(&h, "exit 1");
    // SAFETY: as above; this test is the only one that touches the variable.
    unsafe { std::env::set_var(var, &bad) };
    let mut st2 = State::default();
    let l2 = tick(&e, &mut st2);
    assert!(!l2.cli_used && st2.cli_ok == Some(false));
    assert!(agent(&st2, "s1").flags.contains_key("hung"), "without the CLI the transcript decides");
    // SAFETY: as above.
    unsafe { std::env::remove_var(var) };
}
