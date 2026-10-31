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
    let d = std::env::temp_dir().join("ah-test-agents").join(format!("{tag}-{}", std::process::id()));
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
        // These are plain reminder routing cases; the nudge loop has its own tests.
        settings: Settings { home: h.to_string_lossy().to_string(), env: HashMap::from([("ANTIHALL_AGENT_NUDGE".into(), "false".into())]) },
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
    write(&p, &[prompt(n - 90 * MIN, "/w"), asst(n - MIN, "m0", 1000, 10, json!([{"type": "text", "text": "thinking"}]), None)]);
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

/// GH #458 / PR #472 soft outcomes. Threat model: an ACCIDENTAL runaway (a loop, polling, waiting), not deliberate spoofing. A live probe
/// is a SOFT outcome: it never resets the burn accounting, it only holds off the pause for burn.soft_hold.hold_ms inside a burn episode
/// that has not spent its cap, so a polling loop is paused after the cap (a shell-file write and a passing check are HARD: tests a1/a2).
/// A build still in flight holds off the pause too (bounded by burn.doubt.max_ms) and the hard reminder says so.
#[test]
fn soft_outcomes_never_reset_burn_hold_off_the_pause_up_to_the_cap_and_a_build_in_flight_holds_it_gh458() {
    let h = home("burn458");
    let n = now0();
    let p = sess(&h, "s1");
    let marker = h.join(".anti-hall").join("agent-tracker").join("breaker").join("s1.json");
    write(&p, &[prompt(n - 7 * MIN, "/w"), asst(n - 6 * MIN, "m0", 1000, 10, json!([{"type": "text", "text": "start"}]), None)]);
    let mut st = State::default();
    ticks(&h, &mut st, &[n - 5 * MIN]);
    // past the hard line while a build waits on the cargo lock: hard flag (the nudge) stands, the pause is held off and not claimed
    append(
        &p,
        &[
            asst(n + MIN, "m1", 3_500_000, 10, json!([{"type": "text", "text": "planning"}]), None),
            tool(n + 2 * MIN, "m2", 10, "u2", "Bash", json!({"command": "lockf -t 3600 /x/cargo-heavy.lock nice -n 10 cargo build -j4"})),
        ],
    );
    ticks(&h, &mut st, &[n + 3 * MIN]);
    assert!(agent(&st, "s1").flags.contains_key("burn_hard"), "{:?}", agent(&st, "s1").flags.keys().collect::<Vec<_>>());
    assert!(!marker.exists(), "a running build holds off the pause");
    let note = queue(&h, "s1").iter().map(|r| r.to_string()).collect::<Vec<_>>().join(" ");
    assert!(!note.contains("are paused"), "the hard reminder does not claim a pause it held off: {note}");
    // the build fails: nothing holds the pause off any more
    append(&p, &[result(n + 4 * MIN, "u2", "error: could not compile `x`", false)]);
    ticks(&h, &mut st, &[n + 5 * MIN]);
    assert!(marker.exists(), "no build in flight: the pause stands");
    // a few live probes are soft outcomes: no progress, the burn count stands, but a recent one inside the episode holds off the pause
    let mut lines = Vec::new();
    for k in 0..2 {
        let id = format!("s{k}");
        lines.push(tool(n + 6 * MIN, &format!("ms{k}"), 10, &id, "Bash", json!({"command": format!("curl --version #{k}")})));
        lines.push(result(n + 6 * MIN, &id, "ok", false));
    }
    append(&p, &lines);
    ticks(&h, &mut st, &[n + 7 * MIN]);
    let a = agent(&st, "s1");
    assert_eq!(a.progress, 0, "soft outcomes never add progress");
    assert!(crate::agents::signals::tokens_since_outcome(a, n + 7 * MIN) >= 3_000_000, "the burn count is not reset");
    assert!(a.flags.contains_key("burn_hard"));
    assert!(!marker.exists(), "a few recent soft outcomes hold off the pause");
    // a polling loop: past burn.soft_hold.cap soft outcomes in the window the pause comes back
    let mut lines = Vec::new();
    for k in 2..10 {
        let id = format!("p{k}");
        lines.push(tool(n + 8 * MIN, &format!("mp{k}"), 10, &id, "Bash", json!({"command": format!("curl -s http://dev/status?t={k}")})));
        lines.push(result(n + 8 * MIN, &id, "{\"mode\":\"test\"}", false));
    }
    append(&p, &lines);
    ticks(&h, &mut st, &[n + 9 * MIN]);
    assert_eq!(agent(&st, "s1").progress, 0);
    assert!(marker.exists(), "a polling loop is paused once it passes the soft cap");
}

/// GH #458 review: the soft hold-off is bounded per burn episode, not per sliding window. A polling loop every 6 minutes for 2 hours (each
/// poll a soft outcome, each spending tokens) is paused once the episode's budget (burn.soft_hold cap / episode_ms) is spent.
#[test]
fn a_six_minute_polling_loop_is_paused_once_the_soft_episode_budget_is_spent_gh458() {
    let h = home("poll458");
    let n = now0();
    let p = sess(&h, "s1");
    let marker = h.join(".anti-hall").join("agent-tracker").join("breaker").join("s1.json");
    write(&p, &[prompt(n - 2 * MIN, "/w"), asst(n - MIN, "m0", 1000, 10, json!([{"type": "text", "text": "start"}]), None)]);
    let mut st = State::default();
    ticks(&h, &mut st, &[n]);
    let mut paused_at = None;
    for k in 0..20u64 {
        let t = n + (6 * k + 1) * MIN;
        let id = format!("p{k}");
        append(
            &p,
            &[tool(t, &format!("mp{k}"), 700_000, &id, "Bash", json!({"command": format!("curl -s http://dev/status?t={k}")})), result(t, &id, "{}", false)],
        );
        ticks(&h, &mut st, &[t + MIN]);
        if marker.exists() && paused_at.is_none() {
            paused_at = Some(k);
        }
    }
    assert_eq!(agent(&st, "s1").progress, 0, "polling is no hard outcome");
    assert!(paused_at.is_some(), "a 6-minute polling loop is paused within 2 hours");
    assert!(marker.exists(), "and stays paused while it keeps polling");
}

/// An agent past the hard burn line with its pause marker written (the start of the A1/A2 acceptance tests).
fn burned(tag: &str) -> (PathBuf, PathBuf, PathBuf, State, u64) {
    burned_in(tag, "/w")
}

/// `burned`, the session working in `cwd` (an empty `cwd`: a directory `w` in the scratch home, created with its `out` folder).
fn burned_in(tag: &str, cwd: &str) -> (PathBuf, PathBuf, PathBuf, State, u64) {
    let h = home(tag);
    let w = h.join("w");
    std::fs::create_dir_all(w.join("out")).unwrap();
    let cwd = if cwd.is_empty() { w.to_string_lossy().into_owned() } else { cwd.to_string() };
    let n = now0();
    let p = sess(&h, "s1");
    let marker = h.join(".anti-hall").join("agent-tracker").join("breaker").join("s1.json");
    write(&p, &[prompt(n - 2 * MIN, &cwd), asst(n - MIN, "m0", 1000, 10, json!([{"type": "text", "text": "start"}]), None)]);
    let mut st = State::default();
    ticks(&h, &mut st, &[n]);
    append(&p, &[asst(n + 19 * MIN, "m1", 3_500_000, 10, json!([{"type": "text", "text": "reading"}]), None)]);
    ticks(&h, &mut st, &[n + 20 * MIN]);
    assert!(marker.exists(), "precondition: paused");
    (h, p, marker, st, n)
}

/// PR #472 acceptance A1: a successful shell-file write is a HARD outcome: it adds progress and resets the burn episode.
#[test]
fn a1_a_shell_file_write_is_a_hard_outcome_and_resets_the_burn_pr472() {
    let (h, p, marker, mut st, n) = burned_in("a1-472", "");
    // the write happened: the file exists and was modified at or after the call began
    touch(&h.join("w/out/result1.txt"), n + 21 * MIN + 1000);
    append(&p, &[tool(n + 21 * MIN, "m2", 10, "w1", "Bash", json!({"command": "printf 'x\\n' > out/result1.txt"})), result(n + 21 * MIN, "w1", "", false)]);
    ticks(&h, &mut st, &[n + 22 * MIN]);
    let a = agent(&st, "s1");
    assert!(a.progress > 0, "a shell-file write adds progress");
    assert!(crate::agents::signals::tokens_since_outcome(a, n + 22 * MIN) < 1_000_000, "the burn count restarts");
    assert!(!a.flags.contains_key("burn_hard") && !marker.exists(), "the pause is lifted");
}

/// Create `p` with its modification time at `ms` (milliseconds since the epoch).
fn touch(p: &Path, ms: u64) {
    let f = std::fs::File::create(p).unwrap();
    f.set_modified(std::time::UNIX_EPOCH + std::time::Duration::from_millis(ms)).unwrap();
}

/// PR #472 round 3: a redirect inside a comment or a heredoc body is no write (the engine shell splitter drops both), so it earns no
/// HARD credit even when the command ends with success.
#[test]
fn w1_a_redirect_in_a_comment_or_heredoc_body_is_no_write_pr472() {
    let (h, p, _marker, mut st, n) = burned_in("w1-472", "");
    for (k, c) in ["printf ok # example > out/comment-file", "cat <<'EOF'\n> out/heredoc-file\nEOF", "echo 'a > out/quoted-file'"].iter().enumerate() {
        let t = n + (21 + k as u64) * MIN;
        let id = format!("w{k}");
        append(&p, &[tool(t, &format!("mw{k}"), 10, &id, "Bash", json!({"command": c})), result(t, &id, "", false)]);
        ticks(&h, &mut st, &[t + 30_000]);
        assert_eq!(agent(&st, "s1").progress, 0, "no HARD credit for {c:?}");
    }
}

/// PR #472 round 3: a shell write earns HARD credit only when its target exists after the call and was modified at or after the call
/// began; a missing target, a stale one or a device is at most SOFT.
#[test]
fn w2_a_write_is_hard_only_when_the_target_exists_and_is_fresh_pr472() {
    let (h, p, marker, mut st, n) = burned_in("w2-472", "");
    touch(&h.join("w/out/stale.txt"), n - 60 * MIN);
    for (k, c) in
        ["printf x > out/missing.txt", "printf x >> out/stale.txt", "printf x > /dev/stderr", "printf x > ../../../../../../dev/null"].iter().enumerate()
    {
        let t = n + (21 + k as u64) * MIN;
        let id = format!("s{k}");
        append(&p, &[tool(t, &format!("ms{k}"), 10, &id, "Bash", json!({"command": c})), result(t, &id, "", false)]);
        ticks(&h, &mut st, &[t + 30_000]);
        assert_eq!(agent(&st, "s1").progress, 0, "no HARD credit for {c:?}");
    }
    let t = n + 30 * MIN;
    touch(&h.join("w/out/real.txt"), t + 1000);
    append(&p, &[tool(t, "mr", 10, "r1", "Bash", json!({"command": "printf x > out/real.txt"})), result(t, "r1", "", false)]);
    ticks(&h, &mut st, &[t + 30_000]);
    assert!(agent(&st, "s1").progress > 0, "a real fresh write is HARD");
    assert!(!marker.exists(), "and lifts the pause");
}

/// PR #472 round 3: an agent that names a new file each call but never writes one is not held off forever: it is paused.
#[test]
fn w3_a_new_apparent_path_each_call_still_pauses_pr472() {
    let h = home("w3-472");
    let w = h.join("w");
    std::fs::create_dir_all(&w).unwrap();
    let n = now0();
    let p = sess(&h, "s1");
    let marker = h.join(".anti-hall").join("agent-tracker").join("breaker").join("s1.json");
    write(&p, &[prompt(n - 2 * MIN, &w.to_string_lossy()), asst(n - MIN, "m0", 1000, 10, json!([{"type": "text", "text": "start"}]), None)]);
    let mut st = State::default();
    ticks(&h, &mut st, &[n]);
    for k in 0..24u64 {
        let t = n + (5 * k + 1) * MIN;
        let id = format!("f{k}");
        let c = format!("printf ok # > out/f{k}.txt");
        append(&p, &[tool(t, &format!("mf{k}"), 700_000, &id, "Bash", json!({"command": c})), result(t, &id, "", false)]);
        ticks(&h, &mut st, &[t + MIN]);
    }
    assert_eq!(agent(&st, "s1").progress, 0, "no write ever happened");
    assert!(marker.exists(), "a changed apparent path each call does not hold off the pause");
}

/// PR #472 round 3: a check backgrounded with a top-level `&` has not run when its launching shell exits 0: at most SOFT.
#[test]
fn bg1_a_check_backgrounded_with_an_ampersand_is_at_most_soft_pr472() {
    let (h, p, _marker, mut st, n) = burned_in("bg1-472", "");
    append(&p, &[tool(n + 21 * MIN, "m2", 10, "c1", "Bash", json!({"command": "npx tsc --noEmit >/dev/null 2>&1 &"})), result(n + 21 * MIN, "c1", "", false)]);
    ticks(&h, &mut st, &[n + 22 * MIN]);
    let a = agent(&st, "s1");
    assert_eq!(a.progress, 0, "a `&` check is no HARD outcome");
    assert_eq!(a.soft_ts.len(), 1, "it is exactly one SOFT outcome (which may hold the pause off within burn.soft_hold)");
}

/// PR #472 round 3: a commit or push backgrounded with a top-level `&` earns no credit from its launching shell's exit status.
#[test]
fn bg2_a_commit_or_push_backgrounded_with_an_ampersand_earns_no_credit_pr472() {
    let (h, p, _marker, mut st, n) = burned_in("bg2-472", "");
    for (k, c) in ["git commit -m x >/dev/null 2>&1 &", "git push &"].iter().enumerate() {
        let t = n + (21 + k as u64) * MIN;
        let id = format!("g{k}");
        append(&p, &[tool(t, &format!("mg{k}"), 10, &id, "Bash", json!({"command": c})), result(t, &id, "", false)]);
        ticks(&h, &mut st, &[t + 30_000]);
        let a = agent(&st, "s1");
        assert_eq!((a.progress, a.commits, a.pushes), (0, 0, 0), "no credit for {c:?}");
    }
}

/// PR #472 round 3: run_in_background plus a top-level `&` inside the task: the task's completion notice is only the launching shell's,
/// so the check earns nothing from it.
#[test]
fn bg3_run_in_background_with_an_inner_ampersand_is_no_hard_outcome_pr472() {
    let (h, p, _marker, mut st, n) = burned_in("bg3-472", "");
    let t = n + 21 * MIN;
    append(
        &p,
        &[
            tool(t, "m2", 10, "c1", "Bash", json!({"command": "npx tsc --noEmit &", "run_in_background": true})),
            result(t, "c1", "Command running in background with ID: bgx", false),
        ],
    );
    ticks(&h, &mut st, &[t + 30_000]);
    let done = "<task-notification>\n<task-id>bgx</task-id>\n<status>completed</status>\n</task-notification>";
    append(&p, &[user_text(t + MIN, done)]);
    ticks(&h, &mut st, &[t + 2 * MIN]);
    assert_eq!(agent(&st, "s1").progress, 0, "an inner `&` check is never HARD");
}

/// PR #472 acceptance A2: a passing check is a HARD outcome: it adds progress and resets the burn episode.
#[test]
fn a2_a_passing_check_is_a_hard_outcome_and_resets_the_burn_pr472() {
    let (h, p, marker, mut st, n) = burned("a2-472");
    // a failing check (non-zero exit: the tool result is an error) is no outcome
    append(
        &p,
        &[tool(n + 20 * MIN, "m1f", 10, "c0", "Bash", json!({"command": "cargo fmt --all -- --check"})), result(n + 20 * MIN, "c0", "Exit code 1", true)],
    );
    ticks(&h, &mut st, &[n + 21 * MIN]);
    assert_eq!(agent(&st, "s1").progress, 0, "a failing check adds nothing");
    append(&p, &[tool(n + 21 * MIN, "m2", 10, "c1", "Bash", json!({"command": "cargo fmt --all -- --check"})), result(n + 21 * MIN, "c1", "", false)]);
    ticks(&h, &mut st, &[n + 22 * MIN]);
    let a = agent(&st, "s1");
    assert!(a.progress > 0, "a passing check adds progress");
    assert!(crate::agents::signals::tokens_since_outcome(a, n + 22 * MIN) < 1_000_000, "the burn count restarts");
    assert!(!a.flags.contains_key("burn_hard") && !marker.exists(), "the pause is lifted");
}

/// PR #472 acceptance A3: the soft hold-off cap (burn.soft_hold cap / episode_ms) applies to every soft kind, a running build too: an
/// endless chain of overlapping background builds with no outcome still reaches the cap and is paused.
#[test]
fn a3_overlapping_background_builds_without_outcomes_still_hit_the_cap_and_pause_pr472() {
    let h = home("a3-472");
    let n = now0();
    let p = sess(&h, "s1");
    let marker = h.join(".anti-hall").join("agent-tracker").join("breaker").join("s1.json");
    write(&p, &[prompt(n - 2 * MIN, "/w"), asst(n - MIN, "m0", 1000, 10, json!([{"type": "text", "text": "start"}]), None)]);
    let mut st = State::default();
    ticks(&h, &mut st, &[n]);
    let mut paused_at = None;
    for k in 0..24u64 {
        let t = n + (5 * k + 1) * MIN;
        let id = format!("b{k}");
        append(
            &p,
            &[
                tool(t, &format!("mb{k}"), 700_000, &id, "Bash", json!({"command": "cargo build -j4", "run_in_background": true})),
                result(t, &id, &format!("Command running in background with ID: bg{k}"), false),
            ],
        );
        ticks(&h, &mut st, &[t + MIN]);
        if marker.exists() && paused_at.is_none() {
            paused_at = Some(k);
        }
    }
    assert_eq!(agent(&st, "s1").progress, 0, "a build that never ends is no outcome");
    assert!(paused_at.is_some(), "an endless chain of overlapping background builds is paused within 2 hours");
    assert!(marker.exists(), "and stays paused while it keeps launching builds");
}

/// PR #472 acceptance A4: the soft-hold episode clock starts at the last HARD outcome, not at the first soft one: a soft outcome that comes
/// more than burn.soft_hold.episode_ms after the last hard outcome holds nothing off.
#[test]
fn a4_the_episode_clock_starts_at_the_last_hard_outcome_not_the_first_soft_one_pr472() {
    let h = home("a4-472");
    let n = now0();
    let p = sess(&h, "s1");
    let marker = h.join(".anti-hall").join("agent-tracker").join("breaker").join("s1.json");
    write(&p, &[prompt(n - 2 * MIN, "/w"), asst(n - MIN, "m0", 1000, 10, json!([{"type": "text", "text": "start"}]), None)]);
    let mut st = State::default();
    ticks(&h, &mut st, &[n]);
    // the last hard outcome: a commit at n+1
    append(&p, &[tool(n + MIN, "m1", 10, "u1", "Bash", json!({"command": "git commit -m done"})), result(n + MIN, "u1", "ok", false)]);
    ticks(&h, &mut st, &[n + 2 * MIN]);
    let base = agent(&st, "s1").progress;
    assert!(base > 0);
    // 40 minutes of burn with no outcome at all (past the hard line inside the waste window)
    ticks(&h, &mut st, &[n + 10 * MIN, n + 19 * MIN]);
    append(&p, &[asst(n + 20 * MIN, "m2", 1_800_000, 10, json!([{"type": "text", "text": "reading"}]), None)]);
    ticks(&h, &mut st, &[n + 21 * MIN]);
    append(&p, &[asst(n + 38 * MIN, "m3", 1_800_000, 10, json!([{"type": "text", "text": "reading more"}]), None)]);
    ticks(&h, &mut st, &[n + 39 * MIN]);
    assert!(marker.exists(), "precondition: paused");
    // the first soft outcome of this episode comes 40 minutes after the hard one: past episode_ms, it holds nothing off
    append(&p, &[tool(n + 41 * MIN, "m4", 10, "q1", "Bash", json!({"command": "curl -s http://dev/status"})), result(n + 41 * MIN, "q1", "{}", false)]);
    ticks(&h, &mut st, &[n + 42 * MIN]);
    assert_eq!(agent(&st, "s1").progress, base, "a probe is no hard outcome");
    assert!(marker.exists(), "the episode began at the commit 40 minutes ago: its hold-off budget is spent");
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
    // A child doing work has a live launching session.
    register(&h, std::process::id(), "parent", "busy", n);
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
    // A child doing work has a live launching session.
    register(&h, std::process::id(), "parent", "busy", n);
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
    // A child doing work has a live launching session.
    register(&h, std::process::id(), "parent", "busy", n);
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
    // A child doing work has a live launching session.
    register(&h, std::process::id(), "parent", "busy", n);
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
    // A child doing work has a live launching session.
    register(&h, std::process::id(), "parent", "busy", n);
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
fn a_stale_running_heartbeat_of_no_followed_session_reaches_nobody_and_a_finished_one_is_ignored() {
    // GH #430: a heartbeat row goes only to the session that wrote it; an unowned job's row used to go to the newest main session
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
    assert!(!q.iter().any(|r| r["text"].as_str().unwrap().contains("compiling")), "{q:?}");
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
    register(h, std::process::id(), "parent", "idle", n);
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
        register(&h, std::process::id(), "m1", "busy", n);
        write(&sess(&h, "m1"), &[prompt(n - 30 * MIN, "/w"), asst(n - MIN, "p1", 5, 5, json!([{"type": "text", "text": "working"}]), None)]);
        write(
            &h.join(".claude/projects/p/m1/subagents/agent-r1.jsonl"),
            &[prompt(n - 20 * MIN, "/w"), asst(n - MIN, "s1", 5, 5, json!([{"type": "text", "text": "x"}]), None)],
        );
        if armed {
            std::fs::create_dir_all(h.join(".anti-hall/agent-tracker/wake")).unwrap();
            let stamp = h.join(".anti-hall/agent-tracker/wake/m1.armed");
            std::fs::write(&stamp, "{}").unwrap();
            // The last tick is exactly stale_lock_ms after n. Linux's coarse filesystem clock can stamp
            // a new file before n, so pin the fixture to the simulated clock instead of wall-clock mtime.
            std::fs::File::options().write(true).open(&stamp).unwrap().set_modified(std::time::UNIX_EPOCH + std::time::Duration::from_millis(n)).unwrap();
        }
        let mut st = State::default();
        ticks(&h, &mut st, &[n, n + MIN, n + 2 * MIN]);
        (agent(&st, "m1").flags.contains_key("monitor_unarmed"), queue(&h, "m1"))
    };
    let (flagged, q) = run("unarmed-main", false);
    assert!(flagged);
    let line = q.iter().find(|r| r["signal"] == "monitor_unarmed").expect("the reminder is queued")["text"].as_str().unwrap().to_string();
    assert!(!line.contains('\n') && line.len() < 320, "one short line: {line}");
    assert!(!run("armed-main", true).0, "a live wake-watch is a wake path");
}

/// Waits until the wake watcher has read its starting offset and stamped itself armed (the stamp is written after the offset is read). A fixed
/// sleep here raced a slow thread start: rows appended before the offset was read are, by design, not replayed.
fn wait_armed(e: &Env) {
    for _ in 0..500 {
        if sinks::wake_armed(e, "parent") {
            return;
        }
        std::thread::sleep(std::time::Duration::from_millis(10));
    }
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
    wait_armed(&e);
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
    assert_eq!((b.kind.as_str(), state::of(b), b.pid), ("main", "waiting", me), "a busy shell does not reopen a completed assistant turn");
    assert_eq!((state::of(i), i.pid), ("waiting", me), "an idle process waits");
    assert_eq!(state::of(d), "dead", "a gone process with a missing cwd is dead, even with an unfinished turn");
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
    assert_eq!((a.kind.as_str(), state::of(a)), ("main", "waiting"));
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
    let checkout = h.join("checkout");
    std::fs::create_dir_all(&checkout).unwrap();
    let checkout = checkout.canonicalize().unwrap();
    assert!(std::process::Command::new("git").args(["init", "-q"]).arg(&checkout).status().unwrap().success());
    std::fs::rename(h.join(".anti-hall/devswarm/workspaces/ws1.json"), h.join(".anti-hall/devswarm/workspaces/primary-1.json")).unwrap();
    std::fs::write(h.join(".anti-hall/devswarm/workspaces/primary-1.json"), json!({"id":"primary-1","sessionId":"sessW","worktreePath":checkout}).to_string())
        .unwrap();
    let mut st = State::default();
    ticks(&h, &mut st, &[n, n + MIN, n + 2 * MIN]);
    let a = agent(&st, "sessW");
    assert!(a.ws.as_ref().is_some_and(|w| w.armed == Some(true)), "an idle Primary is covered by the watcher idle-skip decision");
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
    // A child doing work has a live launching session.
    register(&h, std::process::id(), "parent", "busy", n);
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
    // The host records the launch description in the teammate metadata used to match stop answers.
    for (id, name, desc) in [("astopped-1", "stopped", "Fix the stopped thing"), ("akept-2", "kept", "Fix the kept thing")] {
        let p = h.join(format!(".claude/projects/p/parent/subagents/agent-{id}.meta.json"));
        let mut v: Value = serde_json::from_str(&std::fs::read_to_string(&p).unwrap()).unwrap();
        v["description"] = json!(desc);
        assert_eq!(v["name"], name);
        std::fs::write(&p, v.to_string()).unwrap();
        age_file(&p, 70 * MIN);
    }
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
                std::fs::write(&p, v.to_string()).unwrap();
                age_file(&p, 70 * MIN);
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
        // A child doing work has a live launching session.
        register(&h, std::process::id(), "parent", "busy", n);
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

/// Measurement (b), issue #338 item 8: six completion wake rows arrive back to back. Lines the watcher prints for them: before (window 0,
/// the old behaviour) one each; after (`agents.wakeCoalesceSeconds`) ONE line that counts rows per agent. The tracker rows are the
/// engine's own; the host's task-notification messages are not printed by this process and are not touched.
fn wake_burst_lines(window_secs: &str) -> Vec<String> {
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::{Arc, Mutex};
    let h = home(&format!("burst-{window_secs}"));
    let n = now0();
    let mut e = env(&h, n);
    e.settings.env.insert("ANTIHALL_AGENT_WAKE_COALESCE_SECONDS".into(), window_secs.into());
    let (seen, stop) = (Arc::new(Mutex::new(Vec::<String>::new())), Arc::new(AtomicBool::new(false)));
    let t = {
        let (seen, stop) = (Arc::clone(&seen), Arc::clone(&stop));
        let mut e2 = env(&h, n);
        e2.settings.env = e.settings.env.clone();
        std::thread::spawn(move || {
            wake::pump(&e2, "parent", std::time::Duration::from_millis(20), &mut |l| seen.lock().unwrap().push(l.to_string()), &|| stop.load(Ordering::Relaxed))
        })
    };
    wait_armed(&e);
    let feed = sinks::WakeFeed::file(&e, "parent");
    std::fs::create_dir_all(feed.parent().unwrap()).unwrap();
    for (i, (agent, signal)) in
        [("w1", "watched_exit"), ("w1", "idle_open_task"), ("w2", "watched_exit"), ("w2", "watched_exit"), ("w3", "no_work"), ("w1", "watched_exit")]
            .into_iter()
            .enumerate()
    {
        let row = json!({"id": format!("r{i}"), "ts": n, "signal": signal, "agent": agent, "text": format!("{agent} {signal}")});
        sinks::append(&feed, &row).unwrap();
        std::thread::sleep(std::time::Duration::from_millis(40));
    }
    std::thread::sleep(std::time::Duration::from_millis(if window_secs == "0" { 300 } else { 1500 }));
    let during = seen.lock().unwrap().clone();
    stop.store(true, Ordering::Relaxed);
    t.join().unwrap();
    assert_eq!(during, seen.lock().unwrap().clone(), "nothing more is printed at stop once the window has passed");
    during
}

#[test]
fn six_wake_rows_in_a_burst_print_six_lines_before_and_one_coalesced_line_after() {
    let before = wake_burst_lines("0");
    let after = wake_burst_lines("1");
    eprintln!("MEASURE b: before (window 0) {} lines: {before:?}", before.len());
    eprintln!("MEASURE b: after  (window 1s) {} line(s): {after:?}", after.len());
    assert_eq!(before.len(), 6, "{before:?}");
    assert_eq!(after.len(), 1, "{after:?}");
    assert!(after[0].starts_with("[agent-wake] 6 wake rows in "), "{after:?}");
    assert!(
        after[0].contains("w1 x3 (watched_exit, idle_open_task)") && after[0].contains("w2 x2 (watched_exit)") && after[0].contains("w3 x1 (no_work)"),
        "{after:?}"
    );
}

// ---- nudge loop: snoozes, delivery count (GH #333) --------------------------------------------------------------

/// A nudge-on environment (the shared `env()` turns the loop off); `extra` are settings overrides.
fn nudge_env(h: &Path, now: u64, extra: &[(&str, &str)]) -> Env {
    let mut e = env(h, now);
    e.settings.env.clear();
    for (k, v) in extra {
        e.settings.env.insert((*k).into(), (*v).into());
    }
    e
}

/// Renew the parent's wake stamp as of the env's clock (a live `agents wake-watch` renews it every few seconds).
fn arm_wake(e: &Env, session: &str) {
    let stamp = sinks::WakeFeed::stamp(e, session);
    std::fs::create_dir_all(stamp.parent().unwrap()).unwrap();
    std::fs::write(&stamp, "{}").unwrap();
    std::fs::OpenOptions::new().write(true).open(&stamp).unwrap().set_modified(std::time::UNIX_EPOCH + std::time::Duration::from_millis(e.now_ms)).unwrap();
}

/// Append the verb's row: `agents nudge <child> snooze <min>`.
fn answer_snooze(e: &Env, child: &str, min: u64) {
    let row = json!({"ts": e.now_ms, "child": child, "answer": "snooze", "text": "", "min": min});
    sinks::append(&e.dir().join(defaults::raw("agent_nudge.paths").str_field("answers")), &row).unwrap();
}

/// The scripted session of the issue: a live, wake-armed parent, one subagent that spends 700k tokens per cycle with no outcome until
/// a commit clears the flag, and an owner that snoozes every nudge that shows up. Returns (nudges opened, delivery rows written for the
/// nudge signal over the queue and the wake feed, distinct reminder ids among them, snooze answers sent).
/// The parent session (live, wake-armed through `arm_wake`) and its subagent `abc`; returns (home, start time, the child's transcript).
fn nudge_home(tag: &str) -> (PathBuf, u64, PathBuf) {
    let h = home(tag);
    let n = now0();
    register(&h, std::process::id(), "parent", "busy", n);
    write(&sess(&h, "parent"), &[prompt(n - 30 * MIN, "/w"), asst(n - MIN, "p1", 5, 5, json!([{"type": "text", "text": "waiting"}]), Some("end_turn"))]);
    let child = h.join(".claude/projects/p/parent/subagents/agent-abc.jsonl");
    write(&child, &[prompt(n - 5 * MIN, "/w"), asst(n - 4 * MIN, "c0", 1000, 10, json!([{"type": "text", "text": "start"}]), None)]);
    std::fs::write(child.with_file_name("agent-abc.meta.json"), r#"{"description":"Research the billing export"}"#).unwrap();
    (h, n, child)
}

/// One cycle's first half at `b`: a commit (progress), then 700k tokens with no outcome.
fn spend_cycle(child: &Path, k: u64, b: u64) -> (Vec<String>, Vec<String>) {
    let _ = child;
    (
        vec![
            tool(b, &format!("k{k}"), 10, &format!("g{k}"), "Bash", json!({"command": "git commit -m step"})),
            result(b + 1000, &format!("g{k}"), "ok", false),
        ],
        vec![asst(b + 2 * MIN, &format!("w{k}"), 700_000, 10, json!([{"type": "text", "text": "reading"}]), None)],
    )
}

fn snooze_scenario(tag: &str, extra: &[(&str, &str)], cycles: u64, snooze_min: u64) -> (usize, usize, usize, u64, u64) {
    let (h, n, child) = nudge_home(tag);
    let mut st = State::default();
    let mut answers = 0;
    let tick_at = |st: &mut State, t: u64| {
        let e = nudge_env(&h, t, extra);
        arm_wake(&e, "parent");
        tick(&e, st);
        e
    };
    for k in 0..cycles {
        let b = n + k * 45 * MIN;
        let (commit, spend) = spend_cycle(&child, k, b);
        append(&child, &commit);
        tick_at(&mut st, b + MIN);
        append(&child, &spend);
        let e = tick_at(&mut st, b + 18 * MIN);
        if st.nudges.get("abc").is_some_and(|n| n.first_answer_at == 0) {
            answer_snooze(&e, "abc", snooze_min);
            answers += 1;
        }
        tick_at(&mut st, b + 19 * MIN);
    }
    let sig = defaults::raw("agent_nudge.words").str_field("signal");
    let rows: Vec<Value> = queue(&h, "parent").into_iter().chain(wake_rows(&h, "parent")).filter(|r| r["signal"] == sig).collect();
    let ids: std::collections::BTreeSet<String> = rows.iter().map(|r| r["id"].as_str().unwrap_or("").to_string()).collect();
    let opened = st.nudges.len() + st.nudge_log.iter().filter(|n| n.trigger != "dead").count();
    let most = st.nudges.values().chain(st.nudge_log.iter()).map(|n| n.snoozes).max().unwrap_or(0);
    println!(
        "MEASURE {tag}: nudges_opened={opened} delivery_rows={} distinct_reminders={} snooze_answers={answers} snoozes_counted={most}",
        rows.len(),
        ids.len()
    );
    (opened, rows.len(), ids.len(), answers, most)
}

/// The legacy loop, as it was before #333: a snooze lives and dies with its nudge, and a nudge goes to both the queue and the wake feed.
const LEGACY: [(&str, &str); 2] = [("ANTIHALL_AGENT_NUDGE_SNOOZE_HOLD", "false"), ("ANTIHALL_AGENT_NUDGE_DELIVER_ONCE", "false")];

#[test]
fn a_session_with_four_snoozes_gets_one_nudge_delivered_once_not_four_delivered_twice() {
    // 4 cycles of "spend 700k with no outcome, then a commit clears it", 45 minutes apart, the owner snoozing every nudge that shows up
    let (opened, rows, ids, answers, _) = snooze_scenario("nudge-after", &[], 4, 240);
    let (l_opened, l_rows, l_ids, l_answers, _) = snooze_scenario("nudge-before", &LEGACY, 4, 240);
    println!("MEASURE before (legacy): nudges={l_opened} deliveries={l_rows} answers={l_answers}; after: nudges={opened} deliveries={rows} answers={answers}");
    assert_eq!((l_opened, l_rows, l_ids, l_answers), (4, 8, 4, 4), "the legacy loop: a new nudge per re-raise, each on two paths");
    assert_eq!((opened, rows, ids, answers), (1, 1, 1, 1), "one nudge, held by its snooze, delivered once");
}

#[test]
fn a_snooze_that_ran_out_lets_the_next_nudge_in_and_its_count_carries_over() {
    // 60 minute snoozes: the re-raises at +18 and +63 min are held then the one at +108 min (snooze ended at +78) opens a new nudge
    let (opened, _, _, answers, counted) = snooze_scenario("nudge-expiry", &[], 3, 60);
    assert_eq!((opened, answers, counted), (2, 2, 2), "the second nudge started from the first one's snooze");
}

#[test]
fn a_snooze_outside_the_configured_range_is_clamped_and_the_answer_names_the_limit() {
    let (hi, lo) = (lim_n("snooze_max_min"), lim_n("snooze_min_min"));
    assert_eq!(nudge::clamp_snooze(360), (hi, Some("msg.agent_nudge_snooze_clamped")));
    assert_eq!(nudge::clamp_snooze(1), (lo, Some("msg.agent_nudge_snooze_floor")));
    assert_eq!(nudge::clamp_snooze(60), (60, None));
    let said = defaults::render("msg.agent_nudge_snooze_clamped", &[("child", &"abc"), ("min", &hi), ("max", &hi), ("asked", &360)]);
    assert!(said.contains("240") && said.contains("maximum") && said.contains("360"), "{said}");
}

fn lim_n(k: &str) -> u64 {
    defaults::raw("agent_nudge.limits").get(k).and_then(crate::defaults::V::as_integer).unwrap_or(0) as u64
}

/// A nudge that went to the wake feed alone is put in the reminder queue once when no wake delivery is recorded in time, and never
/// when one was.
fn wake_only_run(tag: &str, delivered: bool) -> (usize, usize) {
    let (h, n, child) = nudge_home(tag);
    let mut st = State::default();
    let tick_at = |st: &mut State, t: u64| {
        let e = nudge_env(&h, t, &[]);
        arm_wake(&e, "parent");
        tick(&e, st);
    };
    let (commit, spend) = spend_cycle(&child, 0, n);
    append(&child, &commit);
    tick_at(&mut st, n + MIN);
    append(&child, &spend);
    tick_at(&mut st, n + 18 * MIN);
    assert!(st.nudges.contains_key("abc"), "the waste nudge opened");
    assert_eq!((queue(&h, "parent").len(), wake_rows(&h, "parent").len()), (0, 1), "the first delivery is the wake line alone");
    if delivered {
        let row = json!({"id": "x", "key": "parent", "signal": "nudge", "agent": "abc", "ts": n + 19 * MIN, "channel": "wake"});
        sinks::append(&nudge_env(&h, n, &[]).dir().join(pth("delivered")), &row).unwrap();
    }
    for m in [19, 20, 22, 23, 24] {
        tick_at(&mut st, n + m * MIN);
    }
    (queue(&h, "parent").len(), wake_rows(&h, "parent").len())
}

#[test]
fn a_wake_only_nudge_reaches_the_queue_once_when_no_delivery_is_recorded_and_never_after_one() {
    assert_eq!(wake_only_run("nudge-fb", false), (1, 1), "no wake line was seen: the queue gets it once");
    assert_eq!(wake_only_run("nudge-fb-seen", true), (0, 1), "the wake line was delivered: the queue never gets it");
}

#[test]
fn a_session_registered_on_the_primary_checkout_is_exempt_whatever_id_the_app_gave_it() {
    let h = home("primary-id");
    let n = now0();
    devswarm(&h, n, None);
    let checkout = h.join("checkout");
    std::fs::create_dir_all(&checkout).unwrap();
    let checkout = checkout.canonicalize().unwrap();
    assert!(std::process::Command::new("git").args(["init", "-q"]).arg(&checkout).status().unwrap().success());
    std::fs::write(h.join(".anti-hall/devswarm/workspaces/ws1.json"), json!({"id":"ws-main-7","sessionId":"sessW","worktreePath":checkout}).to_string())
        .unwrap();
    let mut st = State::default();
    ticks(&h, &mut st, &[n, n + MIN]);
    let a = agent(&st, "sessW");
    let w = a.ws.as_ref().expect("a workspace");
    assert!(!w.id.starts_with(defaults::text("agent_tracker.primary_prefix")), "its id does not say Primary");
    assert!(w.primary && escalate::primary(a), "its checkout does: it is never nudged about or acted on");
}

#[test]
fn subagent_results_report_files_and_owner_messages_are_outcomes_and_an_active_owner_means_healthy() {
    let h = home("outcomes");
    let n = now0();
    let notice_line = |ts: u64, id: &str| {
        let body = format!("<task-notification>\n<task-id>{id}</task-id>\n<status>completed</status>\n<result>done</result>\n</task-notification>");
        json!({"type": "user", "timestamp": iso(ts), "origin": {"kind": "task-notification"}, "message": {"role": "user", "content": body}}).to_string()
    };
    let owner = |ts: u64, kind: Option<&str>| {
        let mut v = json!({"type": "user", "timestamp": iso(ts), "message": {"role": "user", "content": "how is the billing export going?"}});
        if let Some(k) = kind {
            v["origin"] = json!({"kind": k});
        }
        v.to_string()
    };
    let p = sess(&h, "s1");
    write(
        &p,
        &[
            prompt(n - 90 * MIN, "/w"),
            tool(n - 80 * MIN, "m1", 5, "a1", "Agent", json!({"description": "research", "prompt": "go"})),
            result(n - 70 * MIN, "a1", "the report", false),
            tool(n - 69 * MIN, "m2", 5, "a2", "Agent", json!({"description": "bg research", "prompt": "go", "run_in_background": true})),
            result(n - 68 * MIN, "a2", "Async agent launched successfully", false),
            notice_line(n - 60 * MIN, "t9"),
            notice_line(n - 59 * MIN, "t9"),
            tool(n - 58 * MIN, "m3", 5, "w1", "Write", json!({"file_path": "/private/tmp/c/scratchpad/findings.md", "content": "x"})),
            result(n - 57 * MIN, "w1", "ok", false),
            owner(n - 56 * MIN, Some("task-notification")),
        ],
    );
    let mut st = State::default();
    ticks(&h, &mut st, &[n - 50 * MIN]);
    let a = agent(&st, "s1");
    assert_eq!(a.reports, 2, "a foreground result and one completed task notice (counted once); the background launch's acknowledgement is not a result");
    assert_eq!(a.progress, 2 * weight("agent_result") + weight("report_file"), "results and the report file are progress");
    assert_eq!(a.owner_ms, n - 90 * MIN, "a task notice is not the owner talking");
    append(&p, &[owner(n - 10 * MIN, Some("human"))]);
    ticks(&h, &mut st, &[n - 9 * MIN]);
    assert_eq!(agent(&st, "s1").owner_ms, n - 10 * MIN);
    // heavy spend with no outcome since the last unit: a session whose owner spoke inside the window is healthy; one whose owner did not is wasting
    for (tag, owner_line) in [("outcomes-owner", true), ("outcomes-quiet", false)] {
        let h2 = home(tag);
        let p2 = sess(&h2, "s1");
        write(&p2, &[prompt(n - 90 * MIN, "/w"), asst(n - MIN, "m0", 1000, 10, json!([{"type": "text", "text": "thinking"}]), None)]);
        let mut st2 = State::default();
        ticks(&h2, &mut st2, &[n]);
        let mut more = vec![asst(n + 19 * MIN, "m1", 700_000, 10, json!([{"type": "text", "text": "still thinking"}]), None)];
        if owner_line {
            more.insert(0, owner(n + 10 * MIN, Some("human")));
        }
        append(&p2, &more);
        ticks(&h2, &mut st2, &[n + 20 * MIN]);
        assert_eq!(agent(&st2, "s1").flags.contains_key("token_waste"), !owner_line, "{tag}");
    }
}

#[test]
fn drift_is_not_raised_while_the_work_matches_the_task_description_and_is_reminded_once_per_step() {
    // a subagent whose step text is stale but whose edits belong to the task it was given
    let h = home("drift-name");
    let n = now0();
    write(&sess(&h, "parent"), &[prompt(n - 60 * MIN, "/w")]);
    let dir = h.join(".claude/projects/p/parent/subagents");
    write(&dir.join("agent-ds.jsonl"), &drift_lines(n, "/w/src/billing/invoice_export_"));
    std::fs::write(dir.join("agent-ds.meta.json"), r#"{"description":"Fix the billing invoice export totals"}"#).unwrap();
    register(&h, std::process::id(), "parent", "busy", n);
    let mut st = State::default();
    ticks(&h, &mut st, &[n, n + MIN]);
    assert!(!agent(&st, "ds").flags.contains_key("drift"), "the work belongs to the agent's own task");
    // a session with no such description still drifts, is reminded once, and a re-raised flag on the same step is not reminded again
    let h2 = home("drift-once");
    write(&sess(&h2, "s1"), &drift_lines(n, "/w/src/billing/invoice_export_"));
    let mut st2 = State::default();
    ticks(&h2, &mut st2, &[n, n + MIN]);
    assert_eq!(queue(&h2, "s1").len(), 1);
    if let Some(a) = st2.agents.get_mut("s1") {
        a.flags.remove("drift");
        a.last_sent.clear();
        a.sent_log.clear();
    }
    ticks(&h2, &mut st2, &[n + 2 * MIN, n + 3 * MIN, n + 4 * MIN]);
    assert!(agent(&st2, "s1").flags.contains_key("drift"), "raised again");
    assert_eq!(queue(&h2, "s1").len(), 1, "but the same step is not reminded twice");
}

// ---- GH #430: answered nudges, judge-done holds, wake rows scoped to the owning session ---------------------------------------

/// A snooze answer moves the nudge's send clock; the wake fallback read that as "sent, never delivered" and queued the reminder the
/// parent had already seen (`<id>-<n>-q`) a few minutes after the snooze. After the answer, nothing reaches the parent for an hour.
#[test]
fn n430_a_snoozed_nudge_is_not_requeued_by_the_wake_fallback() {
    let (h, n, child) = nudge_home("n430-snooze");
    let mut st = State::default();
    let tick_at = |st: &mut State, t: u64| {
        let e = nudge_env(&h, t, &[]);
        arm_wake(&e, "parent");
        tick(&e, st);
        e
    };
    let (commit, spend) = spend_cycle(&child, 0, n);
    append(&child, &commit);
    tick_at(&mut st, n + MIN);
    append(&child, &spend);
    let e = tick_at(&mut st, n + 18 * MIN);
    let sig = defaults::raw("agent_nudge.words").str_field("signal");
    let id = st.nudges.get("abc").expect("a nudge is open about the child").id.clone();
    // the parent's wake-watch delivered the nudge line
    let seen = json!({"signal": sig, "agent": "abc", "key": "parent", "id": format!("{id}-1")});
    assert!(nudge::delivered(&mut st, &seen, n + 18 * MIN + 1000));
    answer_snooze(&e, "abc", 180);
    for m in [19, 23, 30, 45, 60, 78] {
        tick_at(&mut st, n + m * MIN);
    }
    let rows: Vec<Value> = queue(&h, "parent").into_iter().chain(wake_rows(&h, "parent")).filter(|r| r["signal"] == sig).collect();
    let requeued = rows.iter().filter(|r| r["id"].as_str().is_some_and(|i| i.ends_with("-q"))).count();
    println!("MEASURE n430 snooze: delivery_rows={} requeued_after_answer={requeued}", rows.len());
    assert_eq!(requeued, 0, "the snooze answer re-queued an already delivered reminder: {rows:?}");
    assert_eq!(rows.len(), 1, "one delivery (the first wake line), nothing within the 180 min snooze: {rows:?}");
}

/// Two sessions on one machine: session B was active last, session A wrote the heartbeat. A's stale heartbeat goes to A, never B.
#[test]
fn n430_a_heartbeat_reminder_goes_to_the_session_that_wrote_it_not_the_newest_one() {
    let h = home("n430-hb");
    let n = now0();
    let e = nudge_env(&h, n, &[]);
    let mut st = State::default();
    for (id, at) in [("sess-a", n - 20 * MIN), ("sess-b", n - MIN)] {
        st.agents.insert(id.into(), Agent { id: id.into(), kind: kind_name("main").into(), parent: id.into(), last_output_ms: at, ..Agent::default() });
    }
    let hb = Agent {
        id: format!("{}{}", kind_name("heartbeat"), "x"),
        kind: kind_name("heartbeat").into(),
        name: sinks::key_of("sess-a"),
        hb_step: "build".into(),
        ..Agent::default()
    };
    let to = signals::targets(&e, &st, &hb, "heartbeat_stale");
    println!("MEASURE n430 heartbeat: targets={to:?}");
    assert!(!to.is_empty(), "the writer's own session is told");
    for t in &to {
        assert!(matches!(t, signals::Target::Wake(k) | signals::Target::Session(k) if k == "sess-a"), "session B got A's heartbeat row: {to:?}");
    }
}

/// Two sessions on one machine: session A started the cargo that holds the shared lock, session B was active last. Only A hears of it;
/// a holder no followed session started reaches nobody (never "stop it by pid" to a session that did not start it).
#[test]
fn n430_a_lock_holder_event_goes_only_to_the_session_that_started_it() {
    let mut st = State::default();
    for (id, pid, at) in [("sess-a", 100u32, 1u64), ("sess-b", 200, 2)] {
        st.agents.insert(id.into(), Agent { id: id.into(), kind: kind_name("main").into(), pid, last_output_ms: at, ..Agent::default() });
    }
    // holder 300 (cargo) <- 250 (the lock wrapper) <- 100 (session A's process)
    let ppid = |p: u32| match p {
        300 => 250,
        250 => 100,
        _ => 1,
    };
    assert_eq!(lockwatch::lock_owner(&st, 300, &ppid).as_deref(), Some("sess-a"));
    assert_eq!(lockwatch::lock_owner(&st, 400, &ppid), None, "a holder no followed session started reaches nobody");
}

/// A stale heartbeat that names no step, or whose writer the tracker does not follow, is dropped, not sent to the newest session.
#[test]
fn n430_a_stale_heartbeat_with_no_step_or_no_owner_reaches_nobody() {
    let h = home("n430-hb-drop");
    let n = now0();
    let e = nudge_env(&h, n, &[]);
    let mut st = State::default();
    st.agents
        .insert("sess-b".into(), Agent { id: "sess-b".into(), kind: kind_name("main").into(), parent: "sess-b".into(), last_output_ms: n, ..Agent::default() });
    let foreign = Agent { kind: kind_name("heartbeat").into(), name: "not-followed".into(), hb_step: "build".into(), ..Agent::default() };
    assert_eq!(signals::heartbeat_owner(&st, &foreign.name), None);
    assert!(signals::targets(&e, &st, &foreign, "heartbeat_stale").is_empty(), "a foreign heartbeat goes to no session");
}

// ---- GH #430 P1: a judge-done hold is released by new activity and bypassed with agents.nudgeScope off ---------------------------

/// A child discovered and spending (waste trigger raised once a tick sees it), with a judge-done hold recorded at `n + 3 min`.
fn n430_done_held(tag: &str) -> (PathBuf, u64, PathBuf, State) {
    let (h, n, child) = nudge_home(tag);
    let mut st = State::default();
    let (commit, spend) = spend_cycle(&child, 0, n);
    append(&child, &commit);
    tick(&nudge_env(&h, n + MIN, &[]), &mut st);
    append(&child, &spend);
    tick(&nudge_env(&h, n + 3 * MIN, &[]), &mut st);
    let a = st.agents.get("abc").expect("the child is followed").clone();
    nudge::hold_done(&mut st, &a, n + 3 * MIN);
    (h, n, child, st)
}

/// A done child that stays idle stays held: no nudge for the whole hold.
#[test]
fn n430_a_done_child_that_stays_idle_stays_held() {
    let (h, n, _child, mut st) = n430_done_held("n430-done-idle");
    for m in [18, 40, 90, 200] {
        tick(&nudge_env(&h, n + m * MIN, &[]), &mut st);
        assert!(!st.nudges.contains_key("abc"), "an idle done child was nudged at +{m} min");
    }
}

/// Sequence: health said done (hold recorded) -> the child resumes work -> it hangs again. The hold no longer covers it.
#[test]
fn n430_a_done_hold_is_released_when_the_child_shows_new_activity() {
    let (h, n, child, mut st) = n430_done_held("n430-done-resume");
    tick(&nudge_env(&h, n + 18 * MIN, &[]), &mut st);
    assert!(!st.nudges.contains_key("abc"), "held while idle");
    // the child resumes: another 700k tokens with no outcome, then nothing
    let b = n + 20 * MIN;
    append(&child, &[asst(b, "w-resume", 700_000, 10, json!([{"type": "text", "text": "reading again"}]), None)]);
    for m in [1, 18, 40] {
        tick(&nudge_env(&h, b + m * MIN, &[]), &mut st);
    }
    println!("MEASURE n430 done-resume: nudge_open={}", st.nudges.contains_key("abc"));
    assert!(st.nudges.contains_key("abc"), "a child that worked again after the done verdict and then went bad was not nudged");
}

/// With agents.nudgeScope off the done hold is bypassed completely: the child is nudged exactly as without the scope rules.
#[test]
fn n430_nudge_scope_off_bypasses_a_recorded_done_hold() {
    let (h, n, _child, mut st) = n430_done_held("n430-done-off");
    let off = [("ANTIHALL_AGENT_NUDGE_SCOPE", "false")];
    tick(&nudge_env(&h, n + 18 * MIN, &off), &mut st);
    println!("MEASURE n430 done-off: nudge_open={}", st.nudges.contains_key("abc"));
    assert!(st.nudges.contains_key("abc"), "agents.nudgeScope=false still honoured the done hold");
}

// ---- GH #430 Codex P1: done holds written by an older version (old field, no activity time) ---------------------------------------

/// A child judged done at `n + 3 min` by a version that stored done holds in the old busy-hold field, saved to the state file the
/// way that version wrote it (no new-format done hold), and read back as an upgraded engine does at start-up.
fn n430_legacy_done_held(tag: &str) -> (PathBuf, u64, PathBuf, State) {
    let (h, n, child, st) = n430_done_held(tag);
    let mut v = serde_json::to_value(&st).unwrap();
    let o = v.as_object_mut().unwrap();
    o.remove("nudge_done_hold");
    let until = n + 3 * MIN + nudge_lim("health_done_hold_ms");
    o.insert("nudge_hold".into(), json!({ "abc": until }));
    let e = nudge_env(&h, n + 3 * MIN, &[]);
    let p = e.dir().join(pth("state"));
    std::fs::create_dir_all(p.parent().unwrap()).unwrap();
    std::fs::write(&p, serde_json::to_string(&v).unwrap()).unwrap();
    let st = load_state(&e);
    assert_eq!(st.nudge_hold.get("abc"), Some(&until), "the seeded old-shape state file was not read back");
    assert!(st.nudge_done_hold.is_empty(), "the seeded old-shape state file already had a new-format hold");
    (h, n, child, st)
}

fn nudge_lim(k: &str) -> u64 {
    crate::defaults::raw("agent_nudge.limits").get(k).and_then(crate::defaults::V::as_integer).and_then(|i| u64::try_from(i).ok()).unwrap()
}

/// (a) old version records a done hold -> upgrade -> the child resumes, then hangs: the legacy hold no longer covers it.
#[test]
fn n430_legacy_done_hold_is_released_when_the_child_resumes_after_the_upgrade() {
    let (h, n, child, mut st) = n430_legacy_done_held("n430-legacy-resume");
    tick(&nudge_env(&h, n + 18 * MIN, &[]), &mut st);
    assert!(!st.nudges.contains_key("abc"), "held while idle");
    let b = n + 20 * MIN;
    append(&child, &[asst(b, "w-resume", 700_000, 10, json!([{"type": "text", "text": "reading again"}]), None)]);
    for m in [1, 18, 40] {
        tick(&nudge_env(&h, b + m * MIN, &[]), &mut st);
    }
    println!("MEASURE n430 legacy-resume: nudge_open={} legacy_left={}", st.nudges.contains_key("abc"), st.nudge_hold.contains_key("abc"));
    assert!(st.nudges.contains_key("abc"), "a legacy done hold still suppressed a child that worked again and went bad");
}

/// (a) the child resumed while the old version still ran (output newer than the hold's verdict time, before the first upgraded tick).
#[test]
fn n430_legacy_done_hold_is_released_by_output_written_before_the_upgrade() {
    let (h, n, child, mut st) = n430_legacy_done_held("n430-legacy-pre");
    let b = n + 10 * MIN;
    append(&child, &[asst(b, "w-resume", 700_000, 10, json!([{"type": "text", "text": "reading again"}]), None)]);
    for m in [1, 18, 40] {
        tick(&nudge_env(&h, b + m * MIN, &[]), &mut st);
    }
    println!("MEASURE n430 legacy-pre: nudge_open={}", st.nudges.contains_key("abc"));
    assert!(st.nudges.contains_key("abc"), "a legacy done hold ignored output the child wrote after the verdict");
}

/// (b) agents.nudgeScope=false: the legacy field is honoured exactly as before (held to its expiry even after new output).
#[test]
fn n430_legacy_done_hold_is_honoured_as_before_with_nudge_scope_off() {
    let (h, n, child, mut st) = n430_legacy_done_held("n430-legacy-off");
    let until = *st.nudge_hold.get("abc").unwrap();
    let off = [("ANTIHALL_AGENT_NUDGE_SCOPE", "false")];
    let b = n + 20 * MIN;
    append(&child, &[asst(b, "w-resume", 700_000, 10, json!([{"type": "text", "text": "reading again"}]), None)]);
    for m in [1, 18, 40, 90] {
        tick(&nudge_env(&h, b + m * MIN, &off), &mut st);
        assert!(!st.nudges.contains_key("abc"), "nudgeScope off: the legacy hold was not honoured at +{m} min");
    }
    assert_eq!(st.nudge_hold.get("abc"), Some(&until), "nudgeScope off: the legacy hold was changed");
    assert!(st.nudge_done_hold.is_empty(), "nudgeScope off: the legacy hold was migrated");
}

/// (c) a legacy hold on a done child that stays idle keeps it held until the hold's own expiry.
#[test]
fn n430_legacy_done_hold_keeps_an_idle_done_child_held() {
    let (h, n, _child, mut st) = n430_legacy_done_held("n430-legacy-idle");
    let until = *st.nudge_hold.get("abc").unwrap();
    for m in [18, 40, 90, 200] {
        tick(&nudge_env(&h, n + m * MIN, &[]), &mut st);
        assert!(!st.nudges.contains_key("abc"), "an idle legacy-held done child was nudged at +{m} min");
    }
    let held_until = st.nudge_done_hold.get("abc").map(|d| d.until).or_else(|| st.nudge_hold.get("abc").copied());
    println!("MEASURE n430 legacy-idle: held_until={held_until:?} until={until}");
    assert_eq!(held_until, Some(until), "the legacy hold's expiry was not kept");
    tick(&nudge_env(&h, until + MIN, &[]), &mut st);
    println!("MEASURE n430 legacy-idle expiry: nudge_open={}", st.nudges.contains_key("abc"));
    assert!(st.nudges.contains_key("abc"), "the idle child was still held after the legacy hold's expiry");
}

// ---- telemetry of the nudge scope rules (counters declared in agent_nudge.toml) -------------------------------------------------

/// The pending-count table is process-wide; the tests below take turns so one never drains what another bumped. Other tests only add,
/// so each asserts "at least" on the series its own path bumps.
static NUDGE_COUNTS: std::sync::Mutex<()> = std::sync::Mutex::new(());

fn drained() -> crate::metrics::Metrics {
    let mut m = crate::metrics::Metrics::default();
    crate::metrics::drain_pending(&mut m);
    m
}

#[test]
fn nudge_counters_are_declared() {
    for m in [
        "agent_nudge_sent",
        "agent_nudge_suppressed",
        "agent_nudge_done_hold_released",
        "agent_nudge_legacy_hold_adopted",
        "agent_nudge_to_owner",
        "agent_nudge_delivery_failed",
        "agent_wake_dropped",
    ] {
        assert!(crate::metrics::is_registered(m), "{m} is not declared in agent_nudge.toml");
    }
}

/// A nudge opened (sent), then answered by a snooze: the wake fallback does not queue it again (suppressed, answered).
#[test]
fn nudge_sent_and_answered_suppression_are_counted() {
    let _g = NUDGE_COUNTS.lock().unwrap_or_else(|e| e.into_inner());
    let (h, n, child) = nudge_home("tel-sent");
    drained();
    let mut st = State::default();
    let tick_at = |st: &mut State, t: u64| {
        let e = nudge_env(&h, t, &[]);
        arm_wake(&e, "parent");
        tick(&e, st);
        e
    };
    let (commit, spend) = spend_cycle(&child, 0, n);
    append(&child, &commit);
    tick_at(&mut st, n + MIN);
    append(&child, &spend);
    let e = tick_at(&mut st, n + 18 * MIN);
    let sent = drained();
    assert!(sent.counter("agent_nudge_sent", &[("trigger", "waste")]) >= 1, "an opened nudge is counted by trigger");
    let sig = defaults::raw("agent_nudge.words").str_field("signal");
    let id = st.nudges.get("abc").expect("a nudge is open").id.clone();
    nudge::delivered(&mut st, &json!({"signal": sig, "agent": "abc", "key": "parent", "id": format!("{id}-1")}), n + 18 * MIN + 1000);
    answer_snooze(&e, "abc", 180);
    for m in [19, 23, 30] {
        tick_at(&mut st, n + m * MIN);
    }
    assert!(drained().counter("agent_nudge_suppressed", &[("reason", "answered")]) >= 1, "an answered nudge kept out of the queue is counted");
}

/// A done hold released by the held child's new output is counted; one that simply runs out is not.
#[test]
fn done_hold_release_by_output_is_counted() {
    let _g = NUDGE_COUNTS.lock().unwrap_or_else(|e| e.into_inner());
    let (h, n, child, mut st) = n430_done_held("tel-release");
    drained();
    tick(&nudge_env(&h, n + 18 * MIN, &[]), &mut st);
    assert_eq!(drained().counter("agent_nudge_done_hold_released", &[]), 0, "idle: still held, nothing released");
    append(&child, &[asst(n + 20 * MIN, "w-resume", 700_000, 10, json!([{"type": "text", "text": "reading again"}]), None)]);
    tick(&nudge_env(&h, n + 21 * MIN, &[]), &mut st);
    assert!(drained().counter("agent_nudge_done_hold_released", &[]) >= 1, "output after the verdict released the hold");
}

/// A done hold an older version kept in the busy-hold field is adopted once (idempotent).
#[test]
fn legacy_hold_adoption_is_counted() {
    let _g = NUDGE_COUNTS.lock().unwrap_or_else(|e| e.into_inner());
    let (h, n, _child, mut st) = n430_legacy_done_held("tel-legacy");
    drained();
    tick(&nudge_env(&h, n + 18 * MIN, &[]), &mut st);
    assert!(drained().counter("agent_nudge_legacy_hold_adopted", &[]) >= 1, "the old-field hold was moved and counted");
}

/// A child whose parent is not live escalates at once: the notice goes to the owner's channel (no armed session of the project: the file).
#[test]
fn nudge_to_owner_is_counted() {
    let _g = NUDGE_COUNTS.lock().unwrap_or_else(|e| e.into_inner());
    let h = home("tel-owner");
    let n = now0();
    register(&h, dead_pid(), "parent", "busy", n);
    write(&sess(&h, "parent"), &[prompt(n - 30 * MIN, "/w"), asst(n - MIN, "p1", 5, 5, json!([{"type": "text", "text": "waiting"}]), Some("end_turn"))]);
    let child = h.join(".claude/projects/p/parent/subagents/agent-abc.jsonl");
    write(&child, &[prompt(n - 5 * MIN, "/w"), asst(n - 4 * MIN, "c0", 1000, 10, json!([{"type": "text", "text": "start"}]), None)]);
    drained();
    let mut st = State::default();
    let (commit, spend) = spend_cycle(&child, 0, n);
    append(&child, &commit);
    tick(&nudge_env(&h, n + MIN, &[]), &mut st);
    append(&child, &spend);
    for m in [18, 19] {
        tick(&nudge_env(&h, n + m * MIN, &[]), &mut st);
    }
    let got = drained();
    println!("MEASURE tel-owner: nudge_open={} to_owner_file={}", st.nudges.contains_key("abc"), got.counter("agent_nudge_to_owner", &[("where", "file")]));
    assert!(got.counter("agent_nudge_to_owner", &[("where", "file")]) >= 1, "an escalation to the owner file is counted");
}

/// Parent live with no wake-watch and an unwritable reminder queue: the delivery fails, so the nudge is not counted as sent.
#[test]
fn failed_delivery_is_not_counted_as_sent() {
    let _g = NUDGE_COUNTS.lock().unwrap_or_else(|e| e.into_inner());
    let (h, n, child) = nudge_home("tel-fail");
    drained();
    let mut st = State::default();
    let e0 = nudge_env(&h, n + MIN, &[]);
    std::fs::create_dir_all(sinks::SessionQueue::file(&e0, "parent")).unwrap(); // a directory where the queue file goes: append fails
    let (commit, spend) = spend_cycle(&child, 0, n);
    append(&child, &commit);
    tick(&e0, &mut st);
    append(&child, &spend);
    tick(&nudge_env(&h, n + 18 * MIN, &[]), &mut st);
    let got = drained();
    assert!(st.nudges.contains_key("abc"), "the nudge opened");
    assert_eq!(crate::metrics::bumped_on_this_thread("agent_nudge_sent", &[("trigger", "waste")]), 0, "a failed delivery is not a sent nudge");
    assert!(got.counter("agent_nudge_delivery_failed", &[("where", "queue")]) >= 1, "the failed queue write is counted");
    assert!(crate::metrics::bumped_on_this_thread("agent_nudge_delivery_failed", &[("where", "queue")]) >= 1);
}

/// A wake-only delivery that no wake line confirmed falls back to the reminder queue; an unwritable queue makes that fallback fail, and the failure is counted.
#[test]
fn failed_wake_fallback_queue_write_is_counted() {
    let _g = NUDGE_COUNTS.lock().unwrap_or_else(|e| e.into_inner());
    let (h, n, child) = nudge_home("tel-fallback-fail");
    drained();
    let mut st = State::default();
    let tick_at = |st: &mut State, t: u64| {
        let e = nudge_env(&h, t, &[]);
        arm_wake(&e, "parent");
        tick(&e, st);
        e
    };
    let e0 = nudge_env(&h, n + MIN, &[]);
    std::fs::create_dir_all(sinks::SessionQueue::file(&e0, "parent")).unwrap(); // the queue file cannot be written
    let (commit, spend) = spend_cycle(&child, 0, n);
    append(&child, &commit);
    tick_at(&mut st, n + MIN);
    append(&child, &spend);
    tick_at(&mut st, n + 18 * MIN);
    assert_eq!(crate::metrics::bumped_on_this_thread("agent_nudge_delivery_failed", &[("where", "queue")]), 0, "wake-only: the queue is not written at open");
    for m in [19, 23, 30, 45, 60, 78] {
        tick_at(&mut st, n + m * MIN);
    }
    assert!(crate::metrics::bumped_on_this_thread("agent_nudge_delivery_failed", &[("where", "queue")]) >= 1, "a failed wake-fallback queue write is counted");
}

/// The first delivery fails (nothing sent), the queue recovers, a later reminder lands: that success is counted as sent once.
#[test]
fn a_reminder_that_lands_after_a_failed_first_delivery_is_counted_as_sent() {
    let _g = NUDGE_COUNTS.lock().unwrap_or_else(|e| e.into_inner());
    let (h, n, child) = nudge_home("tel-recover");
    drained();
    let mut st = State::default();
    let e0 = nudge_env(&h, n + MIN, &[]);
    let q = sinks::SessionQueue::file(&e0, "parent");
    std::fs::create_dir_all(&q).unwrap();
    let (commit, spend) = spend_cycle(&child, 0, n);
    append(&child, &commit);
    tick(&e0, &mut st);
    append(&child, &spend);
    tick(&nudge_env(&h, n + 18 * MIN, &[]), &mut st);
    let sent = || crate::metrics::bumped_on_this_thread("agent_nudge_sent", &[("trigger", "waste")]);
    assert_eq!(sent(), 0, "the first delivery failed");
    assert!(st.nudges.contains_key("abc"), "the nudge is open");
    std::fs::remove_dir(&q).unwrap(); // the queue works again
    for m in [19, 23, 30, 45, 60, 78, 100, 130, 160] {
        tick(&nudge_env(&h, n + m * MIN, &[]), &mut st);
    }
    let reminded = st.nudges.get("abc").map_or(0, |x| x.reminders);
    assert!(reminded >= 1, "a reminder went out");
    assert_eq!(sent(), 1, "the reminder that landed is counted once as sent");
}

/// The same scene with a writable queue: delivered, counted once as sent, no failure.
#[test]
fn successful_delivery_is_counted_as_sent() {
    let _g = NUDGE_COUNTS.lock().unwrap_or_else(|e| e.into_inner());
    let (h, n, child) = nudge_home("tel-ok");
    drained();
    let mut st = State::default();
    let (commit, spend) = spend_cycle(&child, 0, n);
    append(&child, &commit);
    tick(&nudge_env(&h, n + MIN, &[]), &mut st);
    append(&child, &spend);
    tick(&nudge_env(&h, n + 18 * MIN, &[]), &mut st);
    let got = drained();
    assert_eq!(crate::metrics::bumped_on_this_thread("agent_nudge_sent", &[("trigger", "waste")]), 1);
    assert_eq!(crate::metrics::bumped_on_this_thread("agent_nudge_delivery_failed", &[("where", "queue")]), 0);
    let _ = got;
}

/// An unwritable owner notices file: the escalation is not counted as sent to the owner, the failure is.
#[test]
fn failed_owner_file_is_not_counted_as_to_owner() {
    let _g = NUDGE_COUNTS.lock().unwrap_or_else(|e| e.into_inner());
    let h = home("tel-owner-fail");
    let n = now0();
    register(&h, dead_pid(), "parent", "busy", n);
    write(&sess(&h, "parent"), &[prompt(n - 30 * MIN, "/w"), asst(n - MIN, "p1", 5, 5, json!([{"type": "text", "text": "waiting"}]), Some("end_turn"))]);
    let child = h.join(".claude/projects/p/parent/subagents/agent-abc.jsonl");
    write(&child, &[prompt(n - 5 * MIN, "/w"), asst(n - 4 * MIN, "c0", 1000, 10, json!([{"type": "text", "text": "start"}]), None)]);
    drained();
    let mut st = State::default();
    let e0 = nudge_env(&h, n + MIN, &[]);
    std::fs::create_dir_all(e0.dir().join(defaults::raw("agent_tracker.paths").str_field("notices"))).unwrap();
    let (commit, spend) = spend_cycle(&child, 0, n);
    append(&child, &commit);
    tick(&e0, &mut st);
    append(&child, &spend);
    for m in [18, 19] {
        tick(&nudge_env(&h, n + m * MIN, &[]), &mut st);
    }
    let got = drained();
    let _ = got;
    assert_eq!(crate::metrics::bumped_on_this_thread("agent_nudge_to_owner", &[("where", "file")]), 0);
    assert_eq!(crate::metrics::bumped_on_this_thread("agent_nudge_sent", &[("trigger", "waste")]), 0);
    assert!(crate::metrics::bumped_on_this_thread("agent_nudge_delivery_failed", &[("where", "owner_file")]) >= 1);
}

/// A stale heartbeat of no followed session is dropped and counted by reason.
#[test]
fn unowned_heartbeat_drop_is_counted() {
    let _g = NUDGE_COUNTS.lock().unwrap_or_else(|e| e.into_inner());
    let h = home("tel-hb");
    let n = now0();
    write(&sess(&h, "main1"), &[prompt(n - 3 * MIN, "/w"), asst(n - MIN, "m1", 5, 5, json!([{"type": "text", "text": "ok"}]), Some("end_turn"))]);
    let hb = h.join(".anti-hall/agents");
    std::fs::create_dir_all(&hb).unwrap();
    std::fs::write(hb.join("job1.json"), json!({"id": "job1", "ts": n - 30 * MIN, "status": "running", "step": "compiling"}).to_string()).unwrap();
    drained();
    let mut st = State::default();
    ticks(&h, &mut st, &[n, n + MIN]);
    assert!(drained().counter("agent_wake_dropped", &[("reason", "foreign_agent")]) >= 1, "the dropped row is counted with its reason");
}

/// PR #472 review P1: a BACKGROUND check's launch acknowledgment is no outcome: the check has not run yet. The launch is at most SOFT (an
/// event of the burn episode); HARD credit comes only when its completion notice says it ended with success. An agent that keeps
/// launching background checks never resets the burn.
#[test]
fn p1_a_background_check_is_hard_only_once_its_successful_completion_is_seen_pr472() {
    let h = home("p1-472");
    let n = now0();
    let p = sess(&h, "s1");
    let marker = h.join(".anti-hall").join("agent-tracker").join("breaker").join("s1.json");
    write(&p, &[prompt(n - 2 * MIN, "/w"), asst(n - MIN, "m0", 1000, 10, json!([{"type": "text", "text": "start"}]), None)]);
    let mut st = State::default();
    ticks(&h, &mut st, &[n]);
    // an agent that keeps launching background checks (each launch acknowledged, none seen to end) is paused once the soft cap is spent
    let mut paused_at = None;
    let mut t = n;
    for k in 0..24u64 {
        t = n + (5 * k + 1) * MIN;
        let id = format!("c{k}");
        append(
            &p,
            &[
                tool(t, &format!("mc{k}"), 700_000, &id, "Bash", json!({"command": "npx tsc --noEmit", "run_in_background": true})),
                result(t, &id, &format!("Command running in background with ID: bgc{k}"), false),
            ],
        );
        ticks(&h, &mut st, &[t + MIN]);
        assert_eq!(agent(&st, "s1").progress, 0, "a background check launch is no hard outcome (launch {k})");
        if marker.exists() && paused_at.is_none() {
            paused_at = Some(k);
        }
    }
    assert!(paused_at.is_some() && marker.exists(), "endless background check launches are paused");
    // a failed completion adds nothing
    append(&p, &[user_text(t + 2 * MIN, "<task-notification>\n<task-id>bgc22</task-id>\n<status>failed</status>\n</task-notification>")]);
    ticks(&h, &mut st, &[t + 3 * MIN]);
    assert_eq!(agent(&st, "s1").progress, 0, "a failed background check is no outcome");
    assert!(marker.exists(), "and lifts no pause");
    // a successful completion is the HARD outcome
    append(&p, &[user_text(t + 4 * MIN, "<task-notification>\n<task-id>bgc23</task-id>\n<status>completed</status>\n</task-notification>")]);
    ticks(&h, &mut st, &[t + 5 * MIN]);
    let a = agent(&st, "s1");
    assert!(a.progress > 0, "a background check that completed with success adds progress");
    assert_eq!(a.reports, 0, "a background check's end is no subagent result");
    assert!(crate::agents::signals::tokens_since_outcome(a, t + 5 * MIN) < 1_000_000, "the burn count restarts");
    assert!(!marker.exists(), "the pause is lifted");
}

/// PR #472 review P2: shell writes to distinct quoted paths are distinct files: each first write is a HARD outcome (A1).
#[test]
fn p2_writes_to_distinct_quoted_paths_are_distinct_hard_outcomes_pr472() {
    let (h, p, _marker, mut st, n) = burned_in("p2-472", "");
    touch(&h.join("w/out/first.txt"), n + 21 * MIN + 1000);
    touch(&h.join("w/out/second.txt"), n + 23 * MIN + 1000);
    append(&p, &[tool(n + 21 * MIN, "m2", 10, "w1", "Bash", json!({"command": "printf 'x\\n' > \"out/first.txt\""})), result(n + 21 * MIN, "w1", "", false)]);
    ticks(&h, &mut st, &[n + 22 * MIN]);
    let first = agent(&st, "s1").progress;
    assert!(first > 0, "the first quoted write is an outcome");
    append(&p, &[tool(n + 23 * MIN, "m3", 10, "w2", "Bash", json!({"command": "printf 'y\\n' > 'out/second.txt'"})), result(n + 23 * MIN, "w2", "", false)]);
    ticks(&h, &mut st, &[n + 24 * MIN]);
    let a = agent(&st, "s1");
    assert!(a.progress > first, "a write to a second distinct quoted path is a new hard outcome");
    assert!(
        a.files.iter().any(|f| f.ends_with("/w/out/first.txt")) && a.files.iter().any(|f| f.ends_with("/w/out/second.txt")),
        "the real paths are kept: {:?}",
        a.files
    );
    // quoted text that is no redirect target still names no file
    append(&p, &[tool(n + 25 * MIN, "m4", 10, "w3", "Bash", json!({"command": "echo \"a > b.txt\""})), result(n + 25 * MIN, "w3", "", false)]);
    ticks(&h, &mut st, &[n + 26 * MIN]);
    assert!(!agent(&st, "s1").files.iter().any(|f| f.contains("b.txt")), "a `>` inside quotes is no write");
}

/// One Bash call of `c` at `t` that ended with success, as a tool call and its result.
fn ok_bash(p: &Path, t: u64, k: &str, tin: u64, c: &str) {
    append(p, &[tool(t, &format!("m{k}"), tin, k, "Bash", json!({"command": c})), result(t, k, "", false)]);
}

/// PR #472 round 4 P1: a passing check repeated with nothing changed in between (no edit, no fresh shell write, no commit since its last
/// HARD pass) is SOFT, so a polling `git diff --check` every 6 minutes is paused like any other poll.
#[test]
fn d1_a_repeated_passing_check_with_no_change_in_between_is_soft_and_pauses_pr472() {
    let h = home("d1-472");
    let n = now0();
    let p = sess(&h, "s1");
    let marker = h.join(".anti-hall").join("agent-tracker").join("breaker").join("s1.json");
    write(&p, &[prompt(n - 2 * MIN, "/w"), asst(n - MIN, "m0", 1000, 10, json!([{"type": "text", "text": "start"}]), None)]);
    let mut st = State::default();
    ticks(&h, &mut st, &[n]);
    let mut paused_at = None;
    let mut first = 0;
    for k in 0..20u64 {
        let t = n + (6 * k + 1) * MIN;
        ok_bash(&p, t, &format!("d{k}"), 700_000, "git diff --check");
        ticks(&h, &mut st, &[t + MIN]);
        if k == 0 {
            first = agent(&st, "s1").progress;
        }
        if marker.exists() && paused_at.is_none() {
            paused_at = Some(k);
        }
    }
    assert!(first > 0, "the first pass is HARD (A2)");
    assert_eq!(agent(&st, "s1").progress, first, "a repeat with no change since earns nothing");
    assert!(paused_at.is_some() && marker.exists(), "a 6-minute `git diff --check` poll is paused within 2 hours");
}

/// PR #472 round 4 P1 (regression guard): check, edit, check: every pass after a real change is HARD again, even when the same file is
/// edited each time (the change counter re-arms the check, not first-edit progress).
#[test]
fn d2_check_edit_check_keeps_earning_hard_pr472() {
    let (h, p, marker, mut st, n) = burned_in("d2-472", "");
    let f = h.join("w/out/a.txt").to_string_lossy().into_owned();
    for k in 0..5u64 {
        let t = n + (21 + 2 * k) * MIN;
        append(
            &p,
            &[
                tool(t, &format!("me{k}"), 10, &format!("e{k}"), "Edit", json!({"file_path": f, "old_string": "a", "new_string": "b"})),
                result(t, &format!("e{k}"), "ok", false),
            ],
        );
        ticks(&h, &mut st, &[t + 10_000]);
        let before = agent(&st, "s1").progress;
        ok_bash(&p, t + 20_000, &format!("c{k}"), 10, "git diff --check");
        ticks(&h, &mut st, &[t + MIN]);
        assert!(agent(&st, "s1").progress > before, "check {k} after an edit is HARD");
    }
    assert!(!marker.exists(), "legit work is not paused");
}

/// PR #472 round 4 P2: a leading `cd <literal dir>` in the same call is followed when resolving a relative write; a cd that cannot be
/// resolved (an expansion) leaves the relative write at most SOFT.
#[test]
fn c1_a_leading_cd_is_followed_when_resolving_a_relative_write_pr472() {
    let (h, p, marker, mut st, n) = burned_in("c1-472", "");
    std::fs::create_dir_all(h.join("w/sub")).unwrap();
    touch(&h.join("w/other.txt"), n + 21 * MIN + 1000);
    ok_bash(&p, n + 21 * MIN, "x1", 10, "cd $SUBDIR && printf x > other.txt");
    ticks(&h, &mut st, &[n + 22 * MIN]);
    assert_eq!(agent(&st, "s1").progress, 0, "an unresolvable cd: the relative write is no HARD outcome");
    assert_eq!(agent(&st, "s1").soft_ts.len(), 1, "but still a SOFT one");
    touch(&h.join("w/sub/new.txt"), n + 23 * MIN + 1000);
    ok_bash(&p, n + 23 * MIN, "x2", 10, "cd sub && printf x > new.txt");
    ticks(&h, &mut st, &[n + 24 * MIN]);
    let a = agent(&st, "s1");
    assert!(a.progress > 0, "a write after `cd sub` is resolved in sub/ and is HARD");
    assert!(a.files.iter().any(|f| f.ends_with("/w/sub/new.txt")), "the real path is kept: {:?}", a.files);
    assert!(!marker.exists(), "and lifts the pause");
}

/// PR #472 round 4 P2: commit and push credit come from the command run (command position), never from quoted argument text.
#[test]
fn q1_quoted_git_commit_text_earns_no_commit_credit_pr472() {
    let (h, p, _marker, mut st, n) = burned_in("q1-472", "");
    for (k, c) in ["rg 'git commit' src", "echo \"git commit\"", "echo 'git push'"].iter().enumerate() {
        let t = n + (21 + k as u64) * MIN;
        ok_bash(&p, t, &format!("q{k}"), 10, c);
        ticks(&h, &mut st, &[t + 30_000]);
        let a = agent(&st, "s1");
        assert_eq!((a.progress, a.commits, a.pushes), (0, 0, 0), "no credit for {c:?}");
    }
    for (k, c) in ["git commit -m x", "cd repo && git commit -m 'y'", "git -C \"my repo\" commit -m z"].iter().enumerate() {
        let t = n + (30 + k as u64) * MIN;
        ok_bash(&p, t, &format!("r{k}"), 10, c);
        ticks(&h, &mut st, &[t + 30_000]);
        assert_eq!(agent(&st, "s1").commits, k as u64 + 1, "a real commit counts: {c:?}");
    }
}

/// PR #472 round 4: a polling loop at the lowest spend that reaches the hard burn line (burn.hard_tokens_no_outcome within one waste
/// window, at a 6-minute cadence) is paused; below that line nothing pauses by design, but the soft episode is spent all the same, so
/// nothing holds the pause off once the spend does reach the line.
#[test]
fn l1_low_spend_polling_spends_the_episode_and_pauses_at_the_burn_line_pr472() {
    let hard = crate::defaults::num("burn.hard_tokens_no_outcome");
    let polls = lim("waste_window_ms") / (6 * MIN);
    for (tag, per, pauses) in [("l1lo-472", hard / polls / 2, false), ("l1hi-472", hard / polls + hard / 50, true)] {
        let h = home(tag);
        let n = now0();
        let p = sess(&h, "s1");
        let marker = h.join(".anti-hall").join("agent-tracker").join("breaker").join("s1.json");
        write(&p, &[prompt(n - 2 * MIN, "/w"), asst(n - MIN, "m0", 1000, 10, json!([{"type": "text", "text": "start"}]), None)]);
        let mut st = State::default();
        ticks(&h, &mut st, &[n]);
        let mut t = n;
        for k in 0..20u64 {
            t = n + (6 * k + 1) * MIN;
            ok_bash(&p, t, &format!("p{k}"), per, &format!("curl -s http://dev/status?t={k}"));
            ticks(&h, &mut st, &[t + MIN]);
        }
        assert_eq!(crate::agents::signals::hold_reason(agent(&st, "s1"), t + MIN), None, "{tag}: the soft episode is spent at {per} tokens per poll");
        assert_eq!(marker.exists(), pauses, "{tag}: {per} tokens per 6-minute poll (hard line {hard} per {polls} polls)");
    }
}

// ---- PR #472 round 5: full credit comes from a change in repo state, not from the command text -------------------------------

/// Run git in `w` with an isolated configuration (no system or user config).
fn git_in(w: &Path, args: &[&str]) {
    let ok = std::process::Command::new("git")
        .current_dir(w)
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .args(["-c", "user.email=t@example.invalid", "-c", "user.name=t", "-c", "commit.gpgsign=false"])
        .args(args)
        .output()
        .unwrap();
    assert!(ok.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&ok.stderr));
}

/// A scratch git repo at `w`: one tracked file (`tracked.txt`) committed, `ignored/` gitignored, `out/` present.
fn git_repo(w: &Path) {
    std::fs::create_dir_all(w.join("out")).unwrap();
    std::fs::create_dir_all(w.join("ignored")).unwrap();
    std::fs::write(w.join("tracked.txt"), "v0\n").unwrap();
    std::fs::write(w.join(".gitignore"), "ignored/\n").unwrap();
    git_in(w, &["init", "-q"]);
    git_in(w, &["add", "-A"]);
    git_in(w, &["commit", "-qm", "init"]);
}

/// Write `body` to `p` and set its modification time to `ms` (a transcript call at `ms` wrote it).
fn put(p: &Path, body: &str, ms: u64) {
    std::fs::write(p, body).unwrap();
    std::fs::File::options().write(true).open(p).unwrap().set_modified(std::time::UNIX_EPOCH + std::time::Duration::from_millis(ms)).unwrap();
}

/// A fresh agent working in a scratch git repo `h/w` (not yet burned).
fn fresh_in_repo(tag: &str) -> (PathBuf, PathBuf, PathBuf, State, u64) {
    let h = home(tag);
    let w = h.join("w");
    git_repo(&w);
    let n = now0();
    let p = sess(&h, "s1");
    let marker = h.join(".anti-hall").join("agent-tracker").join("breaker").join("s1.json");
    write(&p, &[prompt(n - 2 * MIN, &w.to_string_lossy()), asst(n - MIN, "m0", 1000, 10, json!([{"type": "text", "text": "start"}]), None)]);
    let mut st = State::default();
    ticks(&h, &mut st, &[n]);
    (h, p, marker, st, n)
}

/// One Bash call of `c` at `t` that ended with success and printed `out`.
fn ok_bash_out(p: &Path, t: u64, k: &str, tin: u64, c: &str, out: &str) {
    append(p, &[tool(t, &format!("m{k}"), tin, k, "Bash", json!({"command": c})), result(t, k, out, false)]);
}

/// Spec (a): an unchanged `cargo test`, or a cached `cargo build`, repeated 20x at 6-minute intervals in a repo whose state never
/// changes earns HARD at most once and is paused.
#[test]
fn r5a_an_unchanged_test_or_cached_build_repeated_pauses_pr472r5() {
    for (tag, cmd, out) in [
        ("r5a-test", "cargo test", "test result: ok. 3 passed"),
        ("r5a-build", "cargo build", "    Finished `dev` profile [unoptimized] target(s) in 0.31s"),
    ] {
        let (h, p, marker, mut st, n) = fresh_in_repo(tag);
        let mut first = 0;
        let mut paused_at = None;
        for k in 0..20u64 {
            let t = n + (6 * k + 1) * MIN;
            ok_bash_out(&p, t, &format!("t{k}"), 700_000, cmd, out);
            ticks(&h, &mut st, &[t + MIN]);
            if k == 0 {
                first = agent(&st, "s1").progress;
            }
            if marker.exists() && paused_at.is_none() {
                paused_at = Some(k);
            }
        }
        assert_eq!(agent(&st, "s1").progress, first, "{tag}: a repeat with the repo unchanged earns nothing");
        assert!(paused_at.is_some() && marker.exists(), "{tag}: a 6-minute unchanged `{cmd}` loop is paused");
    }
}

/// Spec (b): `RUN_AT=<ts> npm run lint` repeated with a changing ts (a fresh command text each run) earns nothing new and pauses.
#[test]
fn r5b_a_check_with_a_changing_env_value_pauses_pr472r5() {
    let (h, p, marker, mut st, n) = fresh_in_repo("r5b");
    let mut first = 0;
    for k in 0..20u64 {
        let t = n + (6 * k + 1) * MIN;
        ok_bash_out(&p, t, &format!("l{k}"), 700_000, &format!("RUN_AT={t} npm run lint"), "");
        ticks(&h, &mut st, &[t + MIN]);
        if k == 0 {
            first = agent(&st, "s1").progress;
        }
    }
    assert_eq!(agent(&st, "s1").progress, first, "a changing env value is no change in the repo");
    assert!(marker.exists(), "the lint loop is paused");
}

/// Spec (c): a loop `curl ... > /tmp/out-<ts>.json` (a fresh real file each run, under the temp dir and outside the repo) pauses, in a
/// repo and outside one.
#[test]
fn r5c_a_curl_to_a_fresh_tmp_file_each_run_pauses_pr472r5() {
    for repo in [true, false] {
        let tag = if repo { "r5c-repo" } else { "r5c-plain" };
        let (h, p, marker, mut st, n) = fresh_in_repo(tag);
        if !repo {
            std::fs::remove_dir_all(h.join("w/.git")).unwrap();
        }
        let tmp = std::env::temp_dir().join("ah-test-agents").join(format!("{tag}-out-{}", std::process::id()));
        std::fs::create_dir_all(&tmp).unwrap();
        for k in 0..20u64 {
            let t = n + (6 * k + 1) * MIN;
            let out = tmp.join(format!("out-{t}.json"));
            put(&out, "{}", t + 500);
            ok_bash_out(&p, t, &format!("c{k}"), 700_000, &format!("curl -s http://dev/status > {}", out.display()), "");
            ok_bash_out(&p, t + 1000, &format!("d{k}"), 10, "curl -s http://dev/status > /tmp/out-$(date +%s).json", "");
            ticks(&h, &mut st, &[t + MIN]);
        }
        assert_eq!(agent(&st, "s1").progress, 0, "{tag}: a temp-file write is no work");
        assert!(marker.exists(), "{tag}: the curl loop is paused");
    }
}

/// Spec (d), regression guard: Edit tool -> `cargo test` -> Edit tool -> `cargo test` on the SAME tracked file: every edit changes the
/// tree, so every passing test after it earns HARD and legit work is never paused.
#[test]
fn r5d_edit_then_test_keeps_earning_hard_pr472r5() {
    let (h, p, marker, mut st, n) = fresh_in_repo("r5d");
    let f = h.join("w/tracked.txt");
    for k in 0..20u64 {
        let t = n + (6 * k + 1) * MIN;
        put(&f, &format!("v{}\n", k + 1), t);
        append(
            &p,
            &[
                tool(t, &format!("me{k}"), 350_000, &format!("e{k}"), "Edit", json!({"file_path": f.to_string_lossy(), "old_string": "v", "new_string": "v"})),
                result(t, &format!("e{k}"), "ok", false),
            ],
        );
        ticks(&h, &mut st, &[t + 10_000]);
        let before = agent(&st, "s1").progress;
        ok_bash_out(&p, t + 20_000, &format!("t{k}"), 350_000, "cargo test", "test result: ok. 3 passed");
        ticks(&h, &mut st, &[t + MIN]);
        assert!(agent(&st, "s1").progress > before, "test {k} after an edit earns HARD");
        assert!(!marker.exists(), "edit/test work is never paused (round {k})");
    }
}

/// Spec (e): a real shell write of a tracked file and of an untracked non-ignored file earns HARD once; the identical write repeated
/// with no content change earns none; a write that really changes the content again is work again; a gitignored write earns none.
#[test]
fn r5e_a_shell_write_earns_hard_only_when_it_changes_the_repo_pr472r5() {
    let (h, p, _marker, mut st, n) = fresh_in_repo("r5e");
    let w = h.join("w");
    let mut t = n + MIN;
    let mut step = |file: &str, body: &str, k: &str| -> u64 {
        t += 6 * MIN;
        put(&w.join(file), body, t + 500);
        let before = agent(&st, "s1").progress;
        ok_bash_out(&p, t, k, 10, &format!("printf '{}' > {file}", body.trim_end()), "");
        ticks(&h, &mut st, &[t + MIN]);
        agent(&st, "s1").progress - before
    };
    assert!(step("tracked.txt", "v1\n", "w1") > 0, "a tracked write that changes the file is HARD");
    assert_eq!(step("tracked.txt", "v1\n", "w2"), 0, "the identical write again is none");
    assert!(step("tracked.txt", "v2\n", "w3") > 0, "a write that changes the content again is work");
    assert!(step("out/new.txt", "n1\n", "w4") > 0, "an untracked non-ignored new file is HARD");
    assert_eq!(step("out/new.txt", "n1\n", "w5"), 0, "the identical untracked write again is none");
    assert_eq!(step("ignored/x.txt", "i1\n", "w6"), 0, "a gitignored write is none");
}

/// Spec (f): git missing, or git hanging past agent_tracker.repo_state.timeout_ms, falls back to the verified-write rule: a fresh write
/// still earns HARD once, an edit re-arms a passing test, an unchanged repeat earns none, every call stays bounded (no wedge).
#[test]
fn r5f_git_unavailable_or_timing_out_falls_back_to_the_verified_write_rule_pr472r5() {
    let hang = std::env::temp_dir().join("ah-test-agents").join(format!("r5f-hang-git-{}.sh", std::process::id()));
    std::fs::create_dir_all(hang.parent().unwrap()).unwrap();
    std::fs::write(&hang, "#!/bin/sh\nsleep 5\n").unwrap();
    std::os::unix::fs::PermissionsExt::set_mode(&mut std::fs::metadata(&hang).unwrap().permissions(), 0o755);
    std::fs::set_permissions(&hang, std::os::unix::fs::PermissionsExt::from_mode(0o755)).unwrap();
    for (tag, git, ms) in [("r5f-missing", "/nonexistent/ah-no-git".to_string(), 2000), ("r5f-hang", hang.to_string_lossy().into_owned(), 200)] {
        let (h, p, marker, mut st, n) = fresh_in_repo(tag);
        repo::GIT_OVERRIDE.with(|g| *g.borrow_mut() = Some((git, ms)));
        let began = std::time::Instant::now();
        let w = h.join("w");
        let t = n + MIN;
        put(&w.join("out/f.txt"), "x", t + 500);
        ok_bash_out(&p, t, "w1", 10, "printf x > out/f.txt", "");
        ticks(&h, &mut st, &[t + MIN]);
        let p1 = agent(&st, "s1").progress;
        assert!(p1 > 0, "{tag}: a verified write earns HARD without git");
        put(&w.join("out/f.txt"), "x", t + 2 * MIN);
        ok_bash_out(&p, t + 2 * MIN - 500, "w2", 10, "printf x > out/f.txt", "");
        ticks(&h, &mut st, &[t + 3 * MIN]);
        assert_eq!(agent(&st, "s1").progress, p1, "{tag}: the same file written again earns none");
        for k in 0..3u64 {
            let tk = t + (6 * k + 4) * MIN;
            let f = w.join("tracked.txt").to_string_lossy().into_owned();
            append(&p, &[tool(tk, &format!("me{k}"), 10, &format!("e{k}"), "Edit", json!({"file_path": f, "old_string": "v", "new_string": "v"})), result(tk, &format!("e{k}"), "ok", false)]);
            ticks(&h, &mut st, &[tk + 10_000]);
            let before = agent(&st, "s1").progress;
            ok_bash_out(&p, tk + 20_000, &format!("t{k}"), 10, "cargo test", "test result: ok. 3 passed");
            ok_bash_out(&p, tk + 30_000, &format!("u{k}"), 10, "cargo test", "test result: ok. 3 passed");
            ticks(&h, &mut st, &[tk + MIN]);
            assert_eq!(agent(&st, "s1").progress, before + weight("test"), "{tag}: an edit re-arms one test credit, the repeat earns none ({k})");
        }
        assert!(!marker.exists(), "{tag}: legit work is not paused without git");
        assert!(began.elapsed() < std::time::Duration::from_secs(30), "{tag}: every git read is bounded by the timeout");
        repo::GIT_OVERRIDE.with(|g| *g.borrow_mut() = None);
    }
}
