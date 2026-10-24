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

/// The prompt that takes a session's queued reminders: the queue's cursor moves to the end of the file.
fn take_queue(h: &Path, key: &str) {
    let q = h.join(".anti-hall/agent-tracker/reminders").join(format!("{key}.ndjson"));
    let mut cur = q.clone().into_os_string();
    cur.push(super::pth("cursor_ext"));
    std::fs::write(cur, queue(h, key).len().to_string()).unwrap();
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

/// The cost report (GH #270): tokens, commits, pushes and guard fires per agent, and tokens per outcome.
#[test]
fn the_cost_report_counts_commits_pushes_and_guard_fires_per_agent() {
    let h = home("cost");
    let n = now0();
    let block = "\u{26d4} anti-hall \u{b7} lane-test-guard: `cargo test` is blocked: a subagent does not run suite-scale tests (cargo test).";
    write(
        &sess(&h, "s1"),
        &[
            prompt(n - 9 * MIN, "/w"),
            tool(n - 8 * MIN, "m1", 100, "u1", "Bash", json!({"command": "cargo test"})),
            result(n - 7 * MIN, "u1", block, true),
            tool(n - 6 * MIN, "m2", 200, "u2", "Bash", json!({"command": "git commit -m x && git push origin b"})),
            result(n - 5 * MIN, "u2", "ok", false),
            tool(n - 4 * MIN, "m3", 300, "u3", "Bash", json!({"command": "git push origin c"})),
            result(n - 3 * MIN, "u3", "ok", false),
            tool(n - 2 * MIN, "m4", 400, "u4", "Bash", json!({"command": "git push origin d"})),
            result(n - MIN, "u4", "rejected", true),
        ],
    );
    write(
        &sess(&h, "s2"),
        &[prompt(n - 9 * MIN, "/w"), tool(n - 8 * MIN, "k1", 5000, "v1", "Read", json!({"file_path": "/w/a.rs"})), result(n - 7 * MIN, "v1", "ok", false)],
    );
    let mut st = State::default();
    ticks(&h, &mut st, &[n]);
    let a = agent(&st, "s1");
    assert_eq!((a.commits, a.pushes, a.guard_fires, a.errors), (1, 2, 1, 2), "a failed push is no push; the block text is one guard fire");
    let r = status::cost_json(&st);
    assert_eq!(r["outcome_units"], defaults::text("agent_tracker.cost_outcome_units"));
    let rows = r["agents"].as_array().unwrap();
    assert_eq!(rows.len(), 2);
    assert_eq!(rows[0]["agent"], "s2", "the agent that spent most tokens comes first");
    assert_eq!((rows[0]["outcomes"].as_u64(), rows[0]["tokens_per_outcome"].is_null()), (Some(0), true), "no outcome: no ratio");
    let s1 = &rows[1];
    assert_eq!((s1["commits"].as_u64(), s1["pushes"].as_u64(), s1["guard_fires"].as_u64(), s1["outcomes"].as_u64()), (Some(1), Some(2), Some(1), Some(3)));
    assert_eq!(s1["tokens_per_outcome"].as_u64(), Some(s1["tokens"].as_u64().unwrap() / 3));
    assert_eq!(r["totals"]["agents"], 2);
    assert_eq!(r["totals"]["pushes"], 2);
}

/// 2026-10-23 burn-breaker false blocks: a commit or push in another clone (git -C / cd), and a finished cargo build or check, are outcomes
/// that restart the waste window; a failed build and a failed push are not.
#[test]
fn a_commit_a_push_or_a_finished_build_in_any_repo_restarts_the_waste_window() {
    let h = home("restart");
    let n = now0();
    write(
        &sess(&h, "s1"),
        &[
            prompt(n - 9 * MIN, "/w"),
            tool(n - 8 * MIN, "m1", 100, "u1", "Bash", json!({"command": "cargo check -j4"})),
            result(n - 7 * MIN, "u1", "error[E0425]: cannot find value\nerror: could not compile `x`", false),
        ],
    );
    let mut st = State::default();
    ticks(&h, &mut st, &[n - 6 * MIN]);
    let a = agent(&st, "s1");
    assert_eq!((a.builds_ok, a.waste.reset_at, a.progress), (0, 0, 0), "a build that did not compile is no outcome");
    append(
        &sess(&h, "s1"),
        &[
            tool(n - 5 * MIN, "m2", 200, "u2", "Bash", json!({"command": "lockf /x/cargo-heavy.lock nice -n 10 cargo build --release -j4 2>&1 | tail -3"})),
            result(n - 4 * MIN, "u2", "Finished `release` profile in 1m", false),
        ],
    );
    ticks(&h, &mut st, &[n - 3 * MIN]);
    let a = agent(&st, "s1");
    assert_eq!((a.builds_ok, a.progress), (1, crate::agents::weight("build")));
    assert!(a.waste.reset_at > 0, "a finished build restarts the window");
    let after_build = a.waste.reset_at;
    append(
        &sess(&h, "s1"),
        &[
            tool(
                n - 2 * MIN,
                "m3",
                300,
                "u3",
                "Bash",
                json!({"command": "git -C /home/x/.anti-hall/work/wt-eng commit -m done && git -C /home/x/.anti-hall/work/wt-eng push origin b"}),
            ),
            result(n - MIN, "u3", "ok", false),
        ],
    );
    ticks(&h, &mut st, &[n]);
    let a = agent(&st, "s1");
    assert_eq!((a.commits, a.pushes), (1, 1), "git -C <other clone> counts");
    assert!(a.waste.reset_at > after_build, "a commit and push in another clone restart the window");
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

// ---- burn breaker (GH #270) ---------------------------------------------------------------------------------

#[test]
fn burn_without_outcome_warns_at_the_soft_line_blocks_at_the_hard_line_and_a_commit_resets_it() {
    let h = home("burn");
    let n = now0();
    let p = sess(&h, "s1");
    write(&p, &[prompt(n - 2 * MIN, "/w"), asst(n - MIN, "m0", 1000, 10, json!([{"type": "text", "text": "thinking"}]), None)]);
    let mut st = State::default();
    ticks(&h, &mut st, &[n]);
    let marker = h.join(".anti-hall").join("agent-tracker").join("breaker").join("s1.json");
    // between the soft and the hard line: soft flag only, no marker
    append(&p, &[asst(n + 19 * MIN, "m1", 2_000_000, 10, json!([{"type": "text", "text": "reading"}]), None)]);
    ticks(&h, &mut st, &[n + 20 * MIN]);
    assert!(agent(&st, "s1").flags.contains_key("burn_soft") && !agent(&st, "s1").flags.contains_key("burn_hard"));
    assert!(!marker.exists());
    // past the hard line: the hard flag and the marker the burn-breaker check reads
    append(&p, &[asst(n + 24 * MIN, "m2", 2_000_000, 10, json!([{"type": "text", "text": "reading more"}]), None)]);
    ticks(&h, &mut st, &[n + 25 * MIN]);
    assert!(agent(&st, "s1").flags.contains_key("burn_hard"), "{:?}", agent(&st, "s1").flags.keys().collect::<Vec<_>>());
    assert!(marker.exists());
    // a commit is an outcome: the count restarts and the marker goes
    append(&p, &[tool(n + 26 * MIN, "m3", 10, "u1", "Bash", json!({"command": "git commit -m done"})), result(n + 27 * MIN, "u1", "ok", false)]);
    ticks(&h, &mut st, &[n + 28 * MIN]);
    assert!(!agent(&st, "s1").flags.contains_key("burn_hard") && !agent(&st, "s1").flags.contains_key("burn_soft"));
    assert!(!marker.exists());
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

/// #177: a subagent the coordinator stopped with `TaskStop` (a tool call answered by its result, no completion notice) is done,
/// not hung; an unanswered stop does not end it, and a stop naming another task leaves it running.
#[test]
fn a_subagent_stopped_with_task_stop_is_done_not_hung() {
    let h = home("taskstop");
    let n = now0();
    write(
        &sess(&h, "parent"),
        &[
            prompt(n - 60 * MIN, "/w"),
            tool(n - 30 * MIN, "p1", 5, "toolu_stop1", "TaskStop", json!({"task_id": "abc"})),
            result(n - 30 * MIN + 1000, "toolu_stop1", "Successfully stopped task: abc (Docs-drift review)", false),
            tool(n - 29 * MIN, "p2", 5, "toolu_stop2", "TaskStop", json!({"task_id": "ghi"})),
        ],
    );
    let dir = h.join(".claude/projects/p/parent/subagents");
    for id in ["abc", "def", "ghi"] {
        write(
            &dir.join(format!("agent-{id}.jsonl")),
            &[prompt(n - 70 * MIN, "/w"), asst(n - 65 * MIN, "s1", 5, 5, json!([{"type": "text", "text": "x"}]), None)],
        );
    }
    let mut st = State::default();
    ticks(&h, &mut st, &[n, n + MIN, n + 2 * MIN]);
    assert_eq!(signals::state_of(agent(&st, "abc")), "done", "an answered TaskStop ends the agent");
    assert_eq!(signals::state_of(agent(&st, "def")), "running", "nothing ended it");
    assert_eq!(signals::state_of(agent(&st, "ghi")), "running", "a stop with no result yet is not a kill");
    let hung: Vec<Value> = queue(&h, "parent").into_iter().filter(|r| r["signal"] == "hung").collect();
    assert!(hung.iter().all(|r| !r["text"].as_str().unwrap().contains("abc")), "no hung reminder about the stopped agent: {hung:?}");
}

/// A teammate is stopped by NAME (`TaskStop {"task_id":"W3"}`); the tool answers with another task id, or "No task found" when it was
/// already gone. The tracked subagent is the transcript `agent-<agent_id>`: both stops must end it; a stop issued before a respawn
/// of the same name must not end the new agent.
#[test]
fn a_teammate_stopped_by_name_is_done_not_hung() {
    let h = home("stopname");
    let n = now0();
    let spawn = |ts: u64, tuid: &str, name: &str, aid: &str| {
        json!({"type": "user", "timestamp": iso(ts), "toolUseResult": {"status": "teammate_spawned", "name": name, "agent_id": aid},
               "message": {"role": "user", "content": [{"type": "tool_result", "tool_use_id": tuid, "content": "Spawned successfully."}]}})
        .to_string()
    };
    write(
        &sess(&h, "parent"),
        &[
            prompt(n - 80 * MIN, "/w"),
            tool(n - 70 * MIN, "p0", 5, "toolu_a1", "Agent", json!({"name": "W3"})),
            spawn(n - 70 * MIN + 1000, "toolu_a1", "W3", "aw3-1111"),
            tool(n - 69 * MIN, "p1", 5, "toolu_a2", "Agent", json!({"name": "live31"})),
            spawn(n - 69 * MIN + 1000, "toolu_a2", "live31", "alive31-2222"),
            tool(n - 68 * MIN, "p2", 5, "toolu_a3", "Agent", json!({"name": "W4"})),
            spawn(n - 68 * MIN + 1000, "toolu_a3", "W4", "aw4-3333"),
            tool(n - 30 * MIN, "p3", 5, "toolu_s1", "TaskStop", json!({"task_id": "W3"})),
            result(n - 30 * MIN + 1000, "toolu_s1", "{\"message\":\"Successfully stopped task: t9xu321q2 (x)\",\"task_id\":\"t9xu321q2\"}", false),
            tool(n - 29 * MIN, "p4", 5, "toolu_s2", "TaskStop", json!({"task_id": "live31"})),
            result(n - 29 * MIN + 1000, "toolu_s2", "<tool_use_error>No task found with ID: live31</tool_use_error>", true),
        ],
    );
    let dir = h.join(".claude/projects/p/parent/subagents");
    for id in ["aw3-1111", "alive31-2222", "aw4-3333"] {
        write(
            &dir.join(format!("agent-{id}.jsonl")),
            &[prompt(n - 70 * MIN, "/w"), asst(n - 65 * MIN, "s1", 5, 5, json!([{"type": "text", "text": "x"}]), None)],
        );
    }
    let mut st = State::default();
    ticks(&h, &mut st, &[n, n + MIN, n + 2 * MIN]);
    assert_eq!(signals::state_of(agent(&st, "aw3-1111")), "done", "stopped by name, answered with another task id");
    assert_eq!(signals::state_of(agent(&st, "alive31-2222")), "done", "stopped by name, task already gone");
    assert_eq!(signals::state_of(agent(&st, "aw4-3333")), "running", "never stopped");
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
fn a_workspace_without_a_live_wake_watch_is_told_the_exact_arm_command_in_its_session_queue_and_the_mesh() {
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
    assert!(
        rows[0]["text"].as_str().unwrap().contains("exec \"$HOME/.anti-hall/ah-engine/bin/ah-engine\"")
            && !rows[0]["text"].as_str().unwrap().contains("AH_ENGINE_PLUGIN_ROOT")
            && !rows[0]["text"].as_str().unwrap().contains("node "),
        "{rows:?}"
    );
    assert!(rows[0]["text"].as_str().unwrap().contains("devswarm wake-watch --auto"), "{rows:?}");
    // root cause of a Primary never being told (2026-10-22): the mesh outbox has no reader, so the workspace's own session queue is the
    // delivery that reaches it; it is a session, and its hook delivers the queue
    let q = queue(&h, "sessW");
    assert_eq!(q.len(), 1, "{q:?}");
    assert!(q[0]["text"].as_str().unwrap().contains("devswarm wake-watch --auto") && !q[0]["text"].as_str().unwrap().contains("node "), "{q:?}");
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
fn a_workspace_is_armed_by_a_live_lock_of_another_row_on_its_checkout() {
    // #181: the Monitor armed under a sibling row id of the same checkout still covers ws1 (the check `inbox tick` makes)
    let h = home("ws-armed-by-checkout");
    let n = now0();
    devswarm(&h, n, None);
    let d = h.join(".anti-hall/devswarm");
    std::fs::write(d.join("workspaces/ws2.json"), r#"{"id":"ws2","sessionId":"sessW2","worktreePath":"/wt/x"}"#).unwrap();
    std::fs::write(d.join("locks/wake-watch-ws2.lock"), json!({"ts": n, "pid": std::process::id()}).to_string()).unwrap();
    let mut st = State::default();
    ticks(&h, &mut st, &[n, n + MIN]);
    assert_eq!(agent(&st, "sessW").ws.as_ref().unwrap().armed, Some(true));
    assert!(!agent(&st, "sessW").flags.contains_key("monitor_unarmed"));
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
    take_queue(&h, "s1"); // a reminder still waiting for its prompt is never queued twice, so the first one is taken before the cooldown ends
    ticks(&h, &mut st, &[n + 40 * MIN]);
    assert_eq!(queue(&h, "s1").len(), 2, "after the cooldown it is queued again");
    assert_eq!(st.today(&env(&h, n)).queued, 2);
    assert_eq!(st.today(&env(&h, n)).suppressed, 1);
}

#[test]
fn an_agent_with_an_undelivered_reminder_is_not_flooded() {
    let (h, n, _) = hung_home("pending-cap");
    let mut st = State::default();
    ticks(&h, &mut st, &[n, n + MIN, n + 35 * MIN, n + 70 * MIN, n + 105 * MIN, n + 140 * MIN]);
    assert_eq!(queue(&h, "s1").len(), 1, "the same reminder about the same agent waits for its prompt instead of stacking");
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
        crate::checks::Verdict::Advisory(j) => {
            // the advisory is the hook's stdout line: a JSON object the dispatcher can combine with other hooks' answers, not plain text
            let v = crate::dispatch::combine::parse_object(&j).unwrap_or_else(|| panic!("an advisory is a JSON object: {j}"));
            let ctx = crate::dispatch::combine::context_of(&j).expect("the reminders ride in additionalContext");
            assert!(ctx.contains("no output"), "{ctx}");
            assert!(v.to_json().contains("\"hookEventName\":\"UserPromptSubmit\""), "{j}");
        }
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
        "case \"$1\" in --version) echo '2.1.295 (Claude Code)';; agents) echo x >> \"$0.count\"; echo '[{\"sessionId\":\"s1\",\"kind\":\"interactive\",\"status\":\"waiting\"}]';; esac",
    );
    let listings = || std::fs::read_to_string(format!("{}.count", good.display())).map_or(0, |t| t.lines().count());
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
    // between listings the host's answer is kept, not asked for again at every tick (one heavy process a minute otherwise)
    let base = listings(); // the first tick asks twice: once to probe the capability, once to list
    let ttl = lim("cli_list_ttl_ms");
    let mut e2 = env(&h, n + ttl / 5);
    e2.use_cli = true;
    let l = tick(&e2, &mut st);
    assert_eq!(listings(), base, "inside the listing ttl the CLI is not asked");
    assert!(l.cli_used, "the kept listing still counts as used");
    assert!(agent(&st, "s2").gone && agent(&st, "s1").host == "waiting", "gone and the host state are kept, not cleared");
    let mut e3 = env(&h, n + ttl + 1);
    e3.use_cli = true;
    tick(&e3, &mut st);
    assert_eq!(listings(), base + 1, "past the ttl it is asked again");
    write(&sess(&h, "s3"), &[prompt(n + ttl, "/w"), asst(n + ttl, "m3", 5, 5, json!([{"type": "text", "text": "x"}]), None)]);
    let mut e4 = env(&h, n + ttl + 2);
    e4.use_cli = true;
    tick(&e4, &mut st);
    assert_eq!(listings(), base + 2, "a session the last listing did not cover is listed at once");
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

#[test]
fn a_state_file_written_before_the_listing_cache_still_loads() {
    // the seeded old shape: a state of the previous version has neither cli_listed nor cli_seen
    let mut v = serde_json::to_value(State::default()).unwrap();
    let o = v.as_object_mut().unwrap();
    assert!(o.remove("cli_listed").is_some() && o.remove("cli_seen").is_some());
    let st: State = serde_json::from_value(v).unwrap();
    assert_eq!((st.cli_listed, st.cli_seen.len()), (0, 0), "defaults: the first tick lists");
}

// ---- the wake channel (#256) --------------------------------------------------------------------------------

fn wake_rows(h: &Path, key: &str) -> Vec<Value> {
    let p = h.join(".anti-hall/agent-tracker/wake").join(format!("{key}.ndjson"));
    std::fs::read_to_string(p).map(|t| t.lines().map(|l| serde_json::from_str(l).unwrap()).collect()).unwrap_or_default()
}

/// A coordinating main session and one subagent that finished its turn `idle_min` minutes ago with a task still open.
fn idle_subagent(h: &Path, n: u64, idle_min: u64) {
    write(&sess(h, "parent"), &[prompt(n - 90 * MIN, "/w"), asst(n - MIN, "p1", 5, 5, json!([{"type": "text", "text": "waiting"}]), Some("end_turn"))]);
    let todo = json!({"todos": [{"content": "Port the gauge", "status": "in_progress", "activeForm": "Porting the gauge"}]});
    write(
        &h.join(".claude/projects/p/parent/subagents/agent-w1.jsonl"),
        &[
            prompt(n - 80 * MIN, "/w"),
            tool(n - 70 * MIN, "s1", 5, "t1", "TodoWrite", todo),
            result(n - 70 * MIN + 1000, "t1", "ok", false),
            asst(n - idle_min * MIN, "s2", 5, 5, json!([{"type": "text", "text": "done for now"}]), Some("end_turn")),
        ],
    );
    std::fs::write(h.join(".claude/projects/p/parent/subagents/agent-w1.meta.json"), r#"{"description":"gauge worker"}"#).unwrap();
}

#[test]
fn every_route_names_a_configured_target() {
    let routes = defaults::raw("agent_tracker.routes");
    let targets = defaults::raw("agent_tracker.targets");
    for sig in defaults_signals() {
        let names = routes.get(sig).map(V::strings).unwrap_or_default();
        assert!(!names.is_empty() || sig == "never", "signal {sig} has a route");
        for r in names {
            assert!(targets.get(r).is_some(), "route {r} of {sig} is a row of agent_tracker.targets");
        }
    }
}

#[test]
fn an_agent_idle_with_an_open_task_wakes_its_coordinator_once() {
    let h = home("idle-open");
    let n = now0();
    idle_subagent(&h, n, 30);
    let mut st = State::default();
    ticks(&h, &mut st, &[n, n + MIN]);
    let a = agent(&st, "w1");
    assert!(a.open && a.flags.contains_key("idle_open_task"), "open={} flags={:?}", a.open, a.flags.keys().collect::<Vec<_>>());
    let wake = wake_rows(&h, "parent");
    assert_eq!(wake.len(), 1, "{wake:?}");
    let text = wake[0]["text"].as_str().unwrap();
    assert!(text.contains("gauge worker") && text.contains("Porting the gauge") && text.contains("idle for"), "{text}");
    assert_eq!(queue(&h, "parent").iter().filter(|r| r["signal"] == "idle_open_task").count(), 1, "the queue carries it too");
    // an unchanged state repeats nothing, however long it lasts
    ticks(&h, &mut st, &[n + 2 * MIN, n + 3 * MIN, n + 90 * MIN, n + 91 * MIN]);
    assert_eq!(wake_rows(&h, "parent").len(), 1, "no repeat for an unchanged state");
}

#[test]
fn an_agent_idle_for_less_than_the_window_or_with_no_open_task_wakes_nobody() {
    let h = home("idle-short");
    let n = now0();
    idle_subagent(&h, n, 3);
    let mut st = State::default();
    ticks(&h, &mut st, &[n, n + MIN]);
    assert!(wake_rows(&h, "parent").is_empty(), "idle for 3 minutes is inside idle_open_ms");
    let h2 = home("idle-closed");
    idle_subagent(&h2, n, 30);
    let done = json!({"todos": [{"content": "Port the gauge", "status": "completed", "activeForm": "Porting the gauge"}]});
    append(
        &h2.join(".claude/projects/p/parent/subagents/agent-w1.jsonl"),
        &[
            tool(n - 29 * MIN, "s3", 5, "t2", "TodoWrite", done),
            result(n - 29 * MIN + 1000, "t2", "ok", false),
            asst(n - 28 * MIN, "s4", 5, 5, json!([{"type": "text", "text": "all done"}]), Some("end_turn")),
        ],
    );
    let mut st = State::default();
    ticks(&h2, &mut st, &[n, n + MIN]);
    assert!(!agent(&st, "w1").open);
    assert!(wake_rows(&h2, "parent").is_empty(), "a finished task list is not open work");
}

fn user_text(ts: u64, body: &str) -> String {
    json!({"type": "user", "timestamp": iso(ts), "message": {"role": "user", "content": body}}).to_string()
}

#[test]
fn a_watched_background_process_that_ends_wakes_the_session_once() {
    let h = home("watched");
    let n = now0();
    let bg = json!({"command": "cargo test", "run_in_background": true});
    write(
        &sess(&h, "s1"),
        &[
            prompt(n - 30 * MIN, "/w"),
            tool(n - 20 * MIN, "m1", 5, "u1", "Bash", bg),
            result(n - 20 * MIN + 1000, "u1", "Command running in background with ID: bq1. Output is being written to: /tmp/x", false),
            asst(n - 19 * MIN, "m2", 5, 5, json!([{"type": "text", "text": "waiting for the run"}]), Some("end_turn")),
            user_text(n - 5 * MIN, "<task-notification>\n<task-id>bq1</task-id>\n<status>completed</status>\n</task-notification>"),
            asst(n - 4 * MIN, "m3", 5, 5, json!([{"type": "text", "text": "idle again"}]), Some("end_turn")),
        ],
    );
    let mut st = State::default();
    ticks(&h, &mut st, &[n, n + MIN]);
    let wake = wake_rows(&h, "s1");
    assert_eq!(wake.len(), 1, "{wake:?}");
    assert!(wake[0]["text"].as_str().unwrap().contains("bq1"), "{wake:?}");
    ticks(&h, &mut st, &[n + 2 * MIN, n + 3 * MIN, n + 4 * MIN]);
    assert_eq!(wake_rows(&h, "s1").len(), 1, "no repeat for an unchanged state");
}

#[test]
fn a_notice_for_a_task_the_agent_did_not_start_is_not_a_watched_exit() {
    let h = home("watched-other");
    let n = now0();
    write(
        &sess(&h, "s1"),
        &[prompt(n - 30 * MIN, "/w"), user_text(n - 5 * MIN, "<task-notification>\n<task-id>zz9</task-id>\n<status>completed</status>\n</task-notification>")],
    );
    let mut st = State::default();
    ticks(&h, &mut st, &[n, n + MIN]);
    assert!(wake_rows(&h, "s1").is_empty());
}

/// A main session with a running subagent and nothing to wake it is told so; a live wake-watch stamp is a wake path.
#[test]
fn a_main_session_with_running_agents_and_no_wake_path_is_told_and_a_live_watcher_silences_it() {
    let run = |tag: &str, armed: bool| {
        let h = home(tag);
        let n = now0();
        write(&sess(&h, "m1"), &[prompt(n - 30 * MIN, "/w"), asst(n - MIN, "p1", 5, 5, json!([{"type": "text", "text": "working"}]), None)]);
        write(
            &h.join(".claude/projects/p/m1/subagents/agent-r1.jsonl"),
            &[prompt(n - 20 * MIN, "/w"), asst(n - MIN, "s1", 5, 5, json!([{"type": "text", "text": "x"}]), None)],
        );
        if armed {
            std::fs::create_dir_all(h.join(".anti-hall/agent-tracker/wake")).unwrap();
            std::fs::write(h.join(".anti-hall/agent-tracker/wake/m1.armed"), "{}").unwrap();
        }
        let mut st = State::default();
        ticks(&h, &mut st, &[n, n + MIN, n + 2 * MIN]);
        (agent(&st, "m1").flags.contains_key("monitor_unarmed"), queue(&h, "m1"))
    };
    let (flagged, q) = run("unarmed-main", false);
    assert!(flagged);
    let line = q.iter().find(|r| r["signal"] == "monitor_unarmed").expect("the reminder is queued")["text"].as_str().unwrap().to_string();
    assert!(!line.contains('\n') && line.len() < 260, "one short line: {line}");
    assert!(!run("armed-main", true).0, "a live wake-watch is a wake path");
}

#[test]
fn the_wake_watch_prints_each_row_once_and_marks_the_session_armed() {
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::{Arc, Mutex};
    let h = home("pump");
    let n = now0();
    let e = env(&h, n);
    let (seen, stop) = (Arc::new(Mutex::new(Vec::<String>::new())), Arc::new(AtomicBool::new(false)));
    let t = {
        let (seen, stop, e2) = (Arc::clone(&seen), Arc::clone(&stop), env(&h, n));
        std::thread::spawn(move || {
            wake::pump(&e2, "parent", std::time::Duration::from_millis(20), &mut |l| seen.lock().unwrap().push(l.to_string()), &|| stop.load(Ordering::Relaxed))
        })
    };
    let wait = |want: usize| {
        for _ in 0..200 {
            if seen.lock().unwrap().len() >= want {
                return;
            }
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
    };
    std::thread::sleep(std::time::Duration::from_millis(150));
    assert!(sinks::wake_armed(&e, "parent"), "the stamp says the session can be woken");
    idle_subagent(&h, n, 30);
    let mut st = State::default();
    ticks(&h, &mut st, &[n, n + MIN]);
    wait(1);
    ticks(&h, &mut st, &[n + 2 * MIN, n + 3 * MIN]);
    std::thread::sleep(std::time::Duration::from_millis(200));
    stop.store(true, Ordering::Relaxed);
    t.join().unwrap();
    let lines = seen.lock().unwrap().clone();
    assert_eq!(lines.len(), 1, "{lines:?}");
    assert!(lines[0].starts_with("[agent-wake] ") && lines[0].contains("gauge worker"), "{lines:?}");
    assert!(!sinks::wake_armed(&e, "parent"), "a stopped watcher removes its stamp");
}

// ---- every kind of agent (process liveness, teammates, Codex, the tree) -----------------------------------

/// A registry file of the host: one live (or dead) session process.
fn register(h: &Path, pid: u32, sid: &str, status: &str, started: u64) {
    let dir = h.join(".claude/sessions");
    std::fs::create_dir_all(&dir).unwrap();
    let rec = json!({"pid": pid, "sessionId": sid, "cwd": "/w", "startedAt": started, "kind": "interactive", "status": status});
    std::fs::write(dir.join(format!("{pid}.json")), rec.to_string()).unwrap();
}

/// Make a file look last written `ago_ms` ago.
fn age_file(p: &Path, ago_ms: u64) {
    let t = std::time::SystemTime::now() - std::time::Duration::from_millis(ago_ms);
    std::fs::OpenOptions::new().write(true).open(p).unwrap().set_modified(t).unwrap();
}

fn dead_pid() -> u32 {
    let mut c = std::process::Command::new("true").spawn().unwrap();
    let pid = c.id();
    c.wait().unwrap();
    pid
}

#[test]
fn a_live_process_is_running_or_waiting_whatever_its_transcript_says_and_a_dead_one_is_done() {
    let h = home("liveproc");
    let n = now0();
    let quiet = |id: &str| {
        let p = sess(&h, id);
        write(&p, &[prompt(n - 9 * 3_600_000, "/w"), asst(n - 8 * 3_600_000, "m1", 5, 5, json!([{"type": "text", "text": "done"}]), Some("end_turn"))]);
        age_file(&p, 8 * 3_600_000); // older than limits.active_window_ms: only the process keeps it in view
    };
    quiet("busy1");
    quiet("idle1");
    write(&sess(&h, "dead1"), &[prompt(n - 5 * MIN, "/w"), asst(n - 4 * MIN, "m2", 5, 5, json!([{"type": "text", "text": "x"}]), None)]);
    let me = std::process::id();
    register(&h, me, "busy1", "busy", n);
    register(&h, dead_pid(), "dead1", "busy", n);
    // a second live process (this test's parent shell is not guaranteed, so reuse our own pid under another session id)
    let dir = h.join(".claude/sessions");
    std::fs::write(dir.join("other.json"), json!({"pid": me, "sessionId": "idle1", "cwd": "/w", "startedAt": n, "status": "idle"}).to_string()).unwrap();
    let mut st = State::default();
    ticks(&h, &mut st, &[n, n + MIN]);
    let (b, i, d) = (agent(&st, "busy1"), agent(&st, "idle1"), agent(&st, "dead1"));
    assert_eq!((b.kind.as_str(), state::of(b), b.pid), ("main", "running", me), "a busy process is running though its transcript ended its turn 8 h ago");
    assert_eq!((state::of(i), i.pid), ("waiting", me), "an idle process waits");
    assert_eq!(state::of(d), "done", "a session whose process is gone is done, even with an unfinished turn");
}

fn teammate(h: &Path, n: u64) {
    idle_subagent(h, n, 20);
    std::fs::write(
        h.join(".claude/projects/p/parent/subagents/agent-w1.meta.json"),
        r#"{"agentType":"gauge","description":"gauge worker","name":"gauger","taskKind":"in_process_teammate","teamName":"team-7"}"#,
    )
    .unwrap();
}

#[test]
fn an_in_process_teammate_is_its_own_kind_with_its_parent_and_team() {
    let h = home("mate");
    let n = now0();
    teammate(&h, n);
    let mut st = State::default();
    ticks(&h, &mut st, &[n, n + MIN]);
    let a = agent(&st, "w1");
    assert_eq!((a.kind.as_str(), a.parent.as_str(), a.name.as_str(), a.team.as_str()), ("teammate", "parent", "gauger", "team-7"));
    // the tree: the parent lists it and is a primary; the teammate shows its parent, project and transcript
    let doc = status::document(&env(&h, n + MIN), &st, &sources::Listing::default());
    let row = |id: &str| doc["agents"].as_array().unwrap().iter().find(|r| r["agent"] == id).unwrap().clone();
    assert_eq!((row("parent")["role"].as_str(), row("parent")["children"][0].as_str()), (Some("primary"), Some("w1")));
    let r = row("w1");
    assert_eq!((r["parent"].as_str(), r["project"].as_str(), r["team"].as_str()), (Some("parent"), Some("/w"), Some("team-7")));
    assert!(r["transcript"].as_str().unwrap().ends_with("agent-w1.jsonl"));
}

#[test]
fn an_idle_teammate_with_an_open_task_wakes_its_parent_not_itself() {
    let h = home("mate-wake");
    let n = now0();
    teammate(&h, n);
    let mut st = State::default();
    ticks(&h, &mut st, &[n, n + MIN]);
    assert!(agent(&st, "w1").flags.contains_key("idle_open_task"));
    let wake = wake_rows(&h, "parent");
    assert_eq!(wake.len(), 1, "{wake:?}");
    assert!(wake[0]["text"].as_str().unwrap().contains("gauger"), "{wake:?}");
    assert!(wake_rows(&h, "w1").is_empty(), "the teammate's own feed is not the target");
}

#[test]
fn a_solo_session_outside_devswarm_is_main_running_and_solo() {
    let h = home("solo");
    let n = now0();
    write(&sess(&h, "solo1"), &[prompt(n - 5 * MIN, "/proj"), asst(n - 4 * MIN, "m1", 5, 5, json!([{"type": "text", "text": "ok"}]), Some("end_turn"))]);
    register(&h, std::process::id(), "solo1", "busy", n);
    let mut st = State::default();
    ticks(&h, &mut st, &[n, n + MIN]);
    let a = agent(&st, "solo1");
    assert_eq!((a.kind.as_str(), state::of(a)), ("main", "running"));
    let doc = status::document(&env(&h, n + MIN), &st, &sources::Listing::default());
    let r = &doc["agents"][0];
    assert_eq!((r["role"].as_str(), r["project"].as_str(), r["pid"].as_u64()), (Some("solo"), Some("/proj"), Some(std::process::id() as u64)));
}

#[test]
fn a_codex_rollout_is_a_codex_agent_running_while_it_is_written() {
    let h = home("codex");
    let n = now0();
    let day = h.join(".codex/sessions/2026/10/22");
    std::fs::create_dir_all(&day).unwrap();
    let rollout = |stamp: &str, id: &str| {
        let p = day.join(format!("rollout-{stamp}-{id}.jsonl"));
        let meta = json!({"type": "session_meta", "payload": {"id": id, "cwd": "/cx"}}).to_string();
        write(&p, &[meta, json!({"type": "response_item", "payload": {}}).to_string()]);
        p
    };
    rollout("2026-10-22T05-21-20", "01a16132-aaaa");
    let old = rollout("2026-10-22T01-00-00", "01a16132-bbbb");
    age_file(&old, 30 * MIN);
    let mut st = State::default();
    ticks(&h, &mut st, &[n, n + MIN]);
    let (live, quiet) = (agent(&st, "01a16132-aaaa"), agent(&st, "01a16132-bbbb"));
    assert_eq!((live.kind.as_str(), state::of(live), live.cwd.as_str(), live.source.as_str()), ("codex", "running", "/cx", "codex"));
    assert_eq!((quiet.kind.as_str(), state::of(quiet)), ("codex", "waiting"));
}

#[test]
fn headless_one_shot_runs_are_not_agents_and_are_not_counted() {
    let h = home("headless");
    let n = now0();
    let line = |ts: u64| {
        json!({"type": "user", "timestamp": iso(ts), "cwd": "/w", "entrypoint": "sdk-cli", "message": {"role": "user", "content": "judge"}}).to_string()
    };
    write(
        &sess(&h, "judge1"),
        &[
            json!({"type": "queue-operation", "timestamp": iso(n)}).to_string(),
            line(n - MIN),
            asst(n - MIN, "j1", 5, 5, json!([{"type": "text", "text": "{}"}]), Some("end_turn")),
        ],
    );
    write(&h.join(".claude/projects/-x-double-shot-latte/judge2.jsonl"), &[prompt(n - MIN, "/w")]);
    write(&sess(&h, "real1"), &[prompt(n - MIN, "/w"), asst(n - MIN, "m1", 5, 5, json!([{"type": "text", "text": "ok"}]), None)]);
    let mut st = State::default();
    ticks(&h, &mut st, &[n, n + MIN]);
    assert_eq!(st.agents.keys().collect::<Vec<_>>(), vec!["real1"], "only the interactive session is an agent");
    let doc = status::document(&env(&h, n + MIN), &st, &sources::Listing::default());
    assert_eq!((doc["summary"]["headless_skipped"].as_u64(), doc["agents"].as_array().unwrap().len()), (Some(2), 1));
}

#[test]
fn the_list_is_live_agents_plus_a_short_recently_finished_window_and_the_summary_counts_live_ones() {
    let h = home("window");
    let n = now0();
    write(
        &sess(&h, "parent"),
        &[prompt(n - 3 * 3_600_000, "/w"), asst(n - 2 * 3_600_000, "p1", 5, 5, json!([{"type": "text", "text": "x"}]), Some("end_turn"))],
    );
    register(&h, std::process::id(), "parent", "busy", n);
    let dir = h.join(".claude/projects/p/parent/subagents");
    for (id, ago) in [("old", 2 * 3_600_000), ("fresh", 5 * MIN)] {
        write(
            &dir.join(format!("agent-{id}.jsonl")),
            &[prompt(n - ago - MIN, "/w"), asst(n - ago, "s1", 5, 5, json!([{"type": "text", "text": "x"}]), Some("end_turn"))],
        );
        std::fs::write(dir.join(format!("agent-{id}.meta.json")), r#"{"finished":true}"#).unwrap();
    }
    let mut st = State::default();
    ticks(&h, &mut st, &[n, n + MIN]);
    let doc = status::document(&env(&h, n + MIN), &st, &sources::Listing::default());
    let ids: Vec<&str> = doc["agents"].as_array().unwrap().iter().map(|r| r["agent"].as_str().unwrap()).collect();
    assert!(ids.contains(&"parent") && ids.contains(&"fresh") && !ids.contains(&"old"), "{ids:?}");
    let s = &doc["summary"];
    assert_eq!((s["sessions_live"].as_u64(), s["subagents_live"].as_u64(), s["done_hidden"].as_u64()), (Some(1), Some(0), Some(1)), "{s}");
}

#[test]
fn the_wake_watch_finds_its_session_from_the_process_tree_when_no_variable_is_set() {
    let h = home("wake-tree");
    let n = now0();
    assert_eq!(wake::session_from_tree(&env(&h, n), std::process::id()), None, "no registry, no session");
    // the registered process is this one: a watcher started under it (here: itself) resolves the session
    register(&h, std::process::id(), "sess-tree", "busy", n);
    assert_eq!(wake::session_from_tree(&env(&h, n), std::process::id()).as_deref(), Some("sess-tree"));
    // a registered ancestor is found by walking up
    let parent = crate::procid::parent(std::process::id()).unwrap();
    std::fs::remove_dir_all(h.join(".claude/sessions")).unwrap();
    register(&h, parent, "sess-up", "busy", n);
    assert_eq!(wake::session_from_tree(&env(&h, n), std::process::id()).as_deref(), Some("sess-up"));
}

#[test]
fn a_primary_is_not_told_to_arm_the_devswarm_watcher_it_declines_while_idle() {
    let h = home("primary-ws");
    let n = now0();
    devswarm(&h, n, None);
    std::fs::rename(h.join(".anti-hall/devswarm/workspaces/ws1.json"), h.join(".anti-hall/devswarm/workspaces/primary-1.json")).unwrap();
    std::fs::write(h.join(".anti-hall/devswarm/workspaces/primary-1.json"), r#"{"id":"primary-1","sessionId":"sessW","worktreePath":"/wt/x"}"#).unwrap();
    let mut st = State::default();
    ticks(&h, &mut st, &[n, n + MIN, n + 2 * MIN]);
    let a = agent(&st, "sessW");
    assert!(a.ws.as_ref().is_some_and(|w| w.armed.is_none()), "a Primary's DevSwarm watcher state is not judged");
    assert!(outbox(&h).is_empty() && queue(&h, "sessW").iter().all(|r| !r["text"].as_str().unwrap().contains("wake-watch --auto")), "nobody is told to arm it");
}

// ---- teammates the host no longer lists (#15) -----------------------------------------------------------------

/// The host's team roster (`<home>/.claude/teams/<team>/config.json`): the lead plus the members that are still alive.
fn roster(h: &Path, team: &str, members: &[&str]) {
    let m: Vec<Value> = std::iter::once("team-lead").chain(members.iter().copied()).map(|n| json!({"name": n, "agentId": format!("{n}@{team}")})).collect();
    let p = h.join(".claude/teams").join(team).join("config.json");
    std::fs::create_dir_all(p.parent().unwrap()).unwrap();
    std::fs::write(p, json!({"name": team, "members": m}).to_string()).unwrap();
}

/// A teammate transcript `agent-<id>` of session `parent` with its meta file; `lines` is its transcript.
fn mate(h: &Path, id: &str, name: &str, team: &str, lines: &[String]) {
    let dir = h.join(".claude/projects/p/parent/subagents");
    write(&dir.join(format!("agent-{id}.jsonl")), lines);
    let meta = json!({"agentType": name, "name": name, "taskKind": "in_process_teammate", "teamName": team});
    std::fs::write(dir.join(format!("agent-{id}.meta.json")), meta.to_string()).unwrap();
}

/// The shapes of the real session (2026-10-22): the lead spawned the teammates ~45 min ago, stopped some by name with `TaskStop`
/// (answered with the task's own id), and kept working; its transcript then grew far past the scan window (`agent_scan.tail_bytes`),
/// so neither the spawn nor the stop is in the window any more. Stopped teammates write no closing line.
#[test]
fn a_stopped_teammate_stays_done_after_the_stop_left_the_scan_window() {
    let h = home("rosterstop");
    let n = now0();
    let spawn = |ts: u64, tuid: &str, name: &str, aid: &str| {
        json!({"type": "user", "timestamp": iso(ts), "toolUseResult": {"status": "teammate_spawned", "name": name, "agent_id": aid},
               "message": {"role": "user", "content": [{"type": "tool_result", "tool_use_id": tuid, "content": "Spawned successfully."}]}})
        .to_string()
    };
    let mut parent = vec![prompt(n - 80 * MIN, "/w")];
    for (i, (name, aid)) in [("gone", "agone-1"), ("quiet", "aquiet-2")].iter().enumerate() {
        parent.push(tool(n - 70 * MIN + i as u64, "p0", 5, &format!("toolu_a{i}"), "Agent", json!({"name": name})));
        parent.push(spawn(n - 70 * MIN + 1000 + i as u64, &format!("toolu_a{i}"), name, aid));
    }
    parent.push(tool(n - 50 * MIN, "p3", 5, "toolu_s1", "TaskStop", json!({"task_id": "gone"})));
    parent.push(result(n - 50 * MIN + 1000, "toolu_s1", "{\"message\":\"Successfully stopped task: tdrz6qcoo (x)\",\"task_id\":\"tdrz6qcoo\"}", false));
    // the lead goes on for several MiB: the stop is now far outside the window of the default scan
    let filler = "x".repeat(1000);
    for i in 0..3500u64 {
        parent.push(json!({"type": "system", "timestamp": iso(n - 49 * MIN + i), "content": filler}).to_string());
    }
    write(&sess(&h, "parent"), &parent);
    let silent = |tail: Option<&str>| vec![prompt(n - 70 * MIN, "/w"), asst(n - 46 * MIN, "s1", 5, 5, json!([{"type": "text", "text": "working"}]), tail)];
    mate(&h, "agone-1", "gone", "team-r", &silent(None));
    mate(&h, "aquiet-2", "quiet", "team-r", &silent(None));
    // an idle teammate that is alive and mid-task, and a subagent that finished its turn
    mate(&h, "aidle-3", "idle", "team-r", &silent(Some("end_turn")));
    roster(&h, "team-r", &["quiet", "idle"]);
    write(
        &h.join(".claude/projects/p/parent/subagents/agent-sub9.jsonl"),
        &[prompt(n - 70 * MIN, "/w"), asst(n - 46 * MIN, "s9", 5, 5, json!([{"type": "text", "text": "done"}]), Some("end_turn"))],
    );
    let mut st = State::default();
    ticks(&h, &mut st, &[n, n + MIN, n + 5 * MIN]);
    assert_eq!(signals::state_of(agent(&st, "agone-1")), "done", "stopped by name, no longer on the roster");
    assert!(!agent(&st, "agone-1").flags.contains_key("hung"), "a stopped teammate is never reported hung");
    assert_eq!(signals::state_of(agent(&st, "aquiet-2")), "running", "alive on the roster, silent: still running");
    assert!(agent(&st, "aquiet-2").flags.contains_key("hung"), "an alive teammate that is truly silent still alerts");
    assert!(!agent(&st, "aidle-3").finished, "an idle teammate on the roster is not finished");
    assert_eq!(signals::state_of(agent(&st, "sub9")), "done", "a subagent that ended its turn");
}

/// The real answer to a `TaskStop` of an in-process teammate (session 44895798, 2026-10-22): the host's own task id plus the task's
/// description, nothing that names the agent. The teammate is still on the roster at that moment, so only the answer ends it.
#[test]
fn a_taskstop_answer_names_the_teammate_by_its_launch_description() {
    let h = home("stopanswer");
    let n = now0();
    let cwd = h.to_string_lossy().to_string(); // a missing working directory reads as dead
    let launch = |ts: u64, tuid: &str, name: &str, desc: &str| {
        asst(ts, &format!("m{tuid}"), 5, 5, json!([{"type": "tool_use", "id": tuid, "name": "Agent", "input": {"name": name, "description": desc}}]), None)
    };
    let stop_answer = |ts: u64, tuid: &str, desc: &str| {
        json!({"type": "user", "timestamp": iso(ts),
               "toolUseResult": {"message": "Successfully stopped task", "task_id": "tzzz", "task_type": "in_process_teammate", "command": desc},
               "message": {"role": "user", "content": [{"type": "tool_result", "tool_use_id": tuid, "content": "ok"}]}})
        .to_string()
    };
    let parent = vec![
        prompt(n - 80 * MIN, &cwd),
        launch(n - 70 * MIN, "toolu_a0", "stopped", "Fix the stopped thing"),
        launch(n - 70 * MIN + 1, "toolu_a1", "kept", "Fix the kept thing"),
        tool(n - 50 * MIN, "p3", 5, "toolu_s1", "TaskStop", json!({"task_id": "tzzz"})),
        stop_answer(n - 50 * MIN + 1000, "toolu_s1", "Fix the stopped thing"),
    ];
    write(&sess(&h, "parent"), &parent);
    let silent = vec![prompt(n - 70 * MIN, &cwd), asst(n - 46 * MIN, "s1", 5, 5, json!([{"type": "text", "text": "working"}]), None)];
    mate(&h, "astopped-1", "stopped", "team-r", &silent);
    mate(&h, "akept-2", "kept", "team-r", &[prompt(n - 70 * MIN, &cwd), asst(n - MIN, "s2", 5, 5, json!([{"type": "text", "text": "working"}]), None)]);
    roster(&h, "team-r", &["stopped", "kept"]);
    let mut st = State::default();
    ticks(&h, &mut st, &[n, n + MIN, n + 5 * MIN]);
    assert_eq!(signals::state_of(agent(&st, "astopped-1")), "done", "the stop answer carries the launch description");
    {
        let k = agent(&st, "akept-2");
        assert_eq!(
            signals::state_of(k),
            "running",
            "a teammate no stop names stays running; cwd={:?} last={} now={} run={} fin={} pend={}",
            k.cwd,
            k.last_output_ms,
            n,
            k.running,
            k.finished,
            k.pending.len()
        );
    }
}

/// Prevention: every way the host says an agent has ended must end an agent whose own transcript still reads "running and silent".
/// A liveness source that is added later and ignores these fails here.
#[test]
fn every_end_signal_ends_a_silent_running_agent() {
    let n = now0();
    let silent = vec![prompt(n - 70 * MIN, "/w"), asst(n - 46 * MIN, "s1", 5, 5, json!([{"type": "text", "text": "working"}]), None)];
    // (case, how the host records the end)
    for case in ["meta_finished", "off_roster", "stop_in_window", "rejoined_name", "not_rediscovered"] {
        let h = home(&format!("endsig-{case}"));
        write(&sess(&h, "parent"), &[prompt(n - 80 * MIN, "/w")]);
        let dir = h.join(".claude/projects/p/parent/subagents");
        write(&dir.join("agent-ax-1.jsonl"), &silent);
        let mut meta = json!({"agentType": "ax", "name": "ax", "taskKind": "in_process_teammate", "teamName": "team-e"});
        match case {
            "meta_finished" => {
                meta["finished"] = json!(true);
                roster(&h, "team-e", &["ax"]);
            }
            "off_roster" | "not_rediscovered" => roster(&h, "team-e", if case == "off_roster" { &[] } else { &["ax"] }),
            // the same name was spawned again later: the roster lists it, joined after this agent started
            "rejoined_name" => {
                roster(&h, "team-e", &["ax"]);
                let p = h.join(".claude/teams/team-e/config.json");
                let mut v: Value = serde_json::from_str(&std::fs::read_to_string(&p).unwrap()).unwrap();
                v["members"][1]["joinedAt"] = json!(n + 60 * MIN);
                std::fs::write(p, v.to_string()).unwrap();
            }
            _ => {
                roster(&h, "team-e", &["ax"]);
                let p = sess(&h, "parent");
                append(&p, &[
                    json!({"type": "user", "timestamp": iso(n - 60 * MIN), "toolUseResult": {"status": "teammate_spawned", "name": "ax", "agent_id": "ax-1"},
                           "message": {"role": "user", "content": [{"type": "tool_result", "tool_use_id": "toolu_a", "content": "Spawned successfully."}]}}).to_string(),
                    tool(n - 50 * MIN, "p3", 5, "toolu_s", "TaskStop", json!({"task_id": "ax"})),
                    result(n - 50 * MIN + 1000, "toolu_s", "{\"message\":\"Successfully stopped task: t1 (x)\",\"task_id\":\"t1\"}", false),
                ]);
            }
        }
        std::fs::write(dir.join("agent-ax-1.meta.json"), meta.to_string()).unwrap();
        let mut st = State::default();
        if case == "not_rediscovered" {
            // followed first, then left out of the tick (the cap) while the host drops it from the roster
            ticks(&h, &mut st, &[n]);
            assert_eq!(signals::state_of(agent(&st, "ax-1")), "running");
            roster(&h, "team-e", &[]);
            let moved = h.join("moved.jsonl");
            std::fs::rename(dir.join("agent-ax-1.jsonl"), moved).unwrap();
        }
        ticks(&h, &mut st, &[n, n + MIN, n + 5 * MIN]);
        assert_eq!(signals::state_of(agent(&st, "ax-1")), "done", "end signal {case} must end the agent");
    }
}
