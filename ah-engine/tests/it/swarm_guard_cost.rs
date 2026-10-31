//! The cost of `swarm-guard` on a long transcript (GH #537): a session with thousands of agent launches and a few dozen tracked
//! rows must not come near the script's CPU limit, and a script failure must let the spawn through (D15).
use super::spawn_budget::{NO_CAP, put, scratch};
use serde_json::json;
use std::io::Write;
use std::path::Path;
use std::process::{Command, Stdio};

/// Agents launched by the real-shape fixture, and tracker rows kept for them (the shape of the session behind #537).
pub(crate) const LAUNCHES: usize = 2881;
pub(crate) const TRACKED: usize = 64;

fn agent_id(i: usize) -> String {
    format!("a{i:015x}")
}

/// A generated transcript of `LAUNCHES` background launches, none finished (never a copy of a real one).
pub(crate) fn big_transcript() -> String {
    let mut out = String::new();
    for i in 0..LAUNCHES {
        let (tu, id) = (format!("toolu_{i}"), agent_id(i));
        let call = json!({"type":"assistant","message":{"content":[{"type":"tool_use","id":tu,"name":"Agent","input":{"description":format!("lane {i}"),"subagent_type":"Explore","prompt":"x".repeat(200)}}]}});
        let result = json!({"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":tu,
            "content":format!("Async agent launched successfully.\nagentId: {id} (internal ID - do not mention to user)\noutput_file: /tmp/ah-none/{id}.output")}]}});
        out.push_str(&format!("{call}\n{result}\n"));
    }
    out
}

/// The launch indices that have a tracker row: spread over the whole transcript, none in the oldest 400 launches (the scan reads a
/// tail of the transcript, so the oldest launches may lie outside it).
pub(crate) fn tracked_indices() -> Vec<usize> {
    let step = (LAUNCHES - 400) / TRACKED;
    (0..TRACKED).map(|k| 400 + k * step).collect()
}

/// The tracker's rows for `tracked_indices()`: the first `live` of them have a fresh transcript (the tracker reads them as running),
/// the others have none. Returns the ids of the live ones.
pub(crate) fn tracked_spread(home: &Path, live: usize) -> Vec<String> {
    let mut st = ah_engine::agents::State::default();
    let mut live_ids = Vec::new();
    for (k, i) in tracked_indices().into_iter().enumerate() {
        let id = agent_id(i);
        let rel = format!(".claude/projects/p/s/subagents/agent-{id}.jsonl");
        if k < live {
            live_ids.push(id.clone());
            put(home, &rel, &format!("{}\n", json!({"type":"assistant","message":{"content":[{"type":"text","text":"working"}]}})));
        }
        let a = ah_engine::agents::Agent {
            id: id.clone(),
            kind: "subagent".into(),
            parent: "s".into(),
            name: format!("lane {i}"),
            cwd: home.to_string_lossy().into_owned(),
            path: home.join(rel).to_string_lossy().into_owned(),
            ..Default::default()
        };
        st.agents.insert(id, a);
    }
    put(home, ".anti-hall/agent-tracker/state.json", &serde_json::to_string(&st).unwrap());
    live_ids
}

/// A spawn payload for `home`'s fixture session.
fn payload(home: &Path) -> String {
    json!({"hook_event_name":"PreToolUse","tool_name":"Agent","session_id":"s","cwd":home,"transcript_path": home.join("t.jsonl"),
        "tool_input":{"subagent_type":"Explore","prompt":"x"}})
    .to_string()
}

/// `ah-engine <args>` on `stdin` in `home` with a private state directory: (exit code, stdout, stderr).
fn run(home: &Path, args: &[&str], stdin: &str, extra: &[(&str, &str)]) -> (i32, String, String) {
    let mut c = Command::new(env!("CARGO_BIN_EXE_ah-engine"));
    c.args(args)
        .env_clear()
        .env("PATH", std::env::var("PATH").unwrap_or_default())
        .env("HOME", home)
        .env("USERPROFILE", home)
        .env("ANTIHALL_TEST_ISOLATION", "1")
        .current_dir(home)
        .env("AH_ENGINE_DIR", home.join("engine-state"))
        .env("AH_ENGINE_PLUGIN_ROOT", Path::new(env!("CARGO_MANIFEST_DIR")).join("../plugins/anti-hall"))
        .envs(extra.iter().copied())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut ch = c.spawn().unwrap();
    ch.stdin.take().unwrap().write_all(stdin.as_bytes()).unwrap();
    let o = ch.wait_with_output().unwrap();
    (o.status.code().unwrap_or(-1), String::from_utf8_lossy(&o.stdout).into_owned(), String::from_utf8_lossy(&o.stderr).into_owned())
}

/// The slow reference count: for every launch of the transcript, scan every tracker row (the quadratic way the guard used to work).
fn reference_running(live_ids: &[String]) -> usize {
    (0..LAUNCHES).filter(|i| live_ids.iter().any(|l| *l == agent_id(*i))).count()
}

fn check(home: &Path, extra: &[(&str, &str)]) -> (i32, String, String) {
    run(home, &["check", "swarm-guard"], &payload(home), extra)
}

fn block_count(out: &str) -> Option<usize> {
    out.split(" agents are running").next()?.rsplit(' ').next()?.parse().ok()
}

/// The ceiling counts the running agents of a 2,881-launch transcript against 64 tracker rows exactly as a naive scan does.
#[test]
fn the_real_shape_fixture_reports_the_running_count_a_slow_reference_gives() {
    for live in [14usize, 40, 64] {
        let h = scratch("cost-count");
        put(&h, ".anti-hall/settings.json", NO_CAP);
        put(&h, "t.jsonl", &big_transcript());
        let want = reference_running(&tracked_spread(&h, live));
        assert_eq!(want, live, "the reference sees every live row once");
        let (code, out, err) = check(&h, &[]);
        assert_eq!(code, 2, "{live} live agents are over the ceiling of 12: {out} {err}");
        assert_eq!(block_count(&out), Some(want), "the guard counts what the slow reference counts: {out}");
    }
    let h = scratch("cost-count-under");
    put(&h, ".anti-hall/settings.json", NO_CAP);
    put(&h, "t.jsonl", &big_transcript());
    assert_eq!(reference_running(&tracked_spread(&h, 11)), 11);
    let (code, out, err) = check(&h, &[]);
    assert_eq!((code, out.as_str()), (0, ""), "11 live agents are under the ceiling: {err}");
}

/// The true positive survives the speed-up: the owner's cap still refuses an over-cap spawn, through the dispatcher, on the big transcript.
#[test]
fn an_over_cap_spawn_is_still_refused_on_the_big_transcript() {
    let h = scratch("cost-cap");
    put(&h, ".anti-hall/settings.json", r#"{"guards":{"maxConcurrentAgents":6}}"#);
    put(&h, "t.jsonl", &big_transcript());
    tracked_spread(&h, 5);
    let (code, out, err) = run(&h, &["hook", "--event", "PreToolUse", "--tool", "Agent"], &payload(&h), &[("AH_ENGINE_DISPATCH_IN_PROCESS", "1")]);
    assert_eq!(code, 2, "{out} {err}");
    assert!(out.contains("agents are running (limit 6, your guards.maxConcurrentAgents cap)"), "{out}");
}

/// The CPU bound (tests/budgets.toml `swarm_guard_cost`): the real-shape fixture, cap on and ceiling on, so both counts run, finishes
/// inside `limit_pct` of the script's 500 ms CPU limit. The limit is set per run through the soft limit (hard = soft x time_hard_factor);
/// an interrupted script now fails OPEN with a notice, so the test requires the plain allow with no notice.
#[test]
fn the_real_shape_fixture_runs_inside_a_quarter_of_the_cpu_limit() {
    let b: toml::Table = std::fs::read_to_string(Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/budgets.toml")).unwrap().parse().unwrap();
    let b = &b["swarm_guard_cost"];
    let f = |k: &str| b[k].as_float().unwrap_or_else(|| b[k].as_integer().unwrap() as f64);
    let factor = if cfg!(debug_assertions) { f("debug_factor") } else { 1.0 };
    let hard_ms = f("limit_pct") / 100.0 * f("hard_limit_ms") * factor;
    let soft_ms = (hard_ms / f("time_hard_factor")).ceil() as u64;
    let h = scratch("cost-bound");
    put(&h, ".anti-hall/settings.json", r#"{"guards":{"maxConcurrentAgents":100000}}"#);
    put(&h, "t.jsonl", &big_transcript());
    tracked_spread(&h, 5);
    let soft = soft_ms.to_string();
    for round in 0..3 {
        let (code, out, err) = check(&h, &[("AH_ENGINE_SCRIPT_TIME_MS", &soft)]);
        assert_eq!((code, out.as_str()), (0, ""), "round {round}: the script must finish inside {} ms of CPU: {err}", soft_ms * 10);
    }
}

/// Each host scan is paid ONCE per spawn check, whatever number of counts use it: the transcript scan and the tracker read are wrapped by an
/// owner-style lib override (the editable-script mechanism) that records every call.
#[test]
fn the_transcript_scan_and_the_tracker_read_are_each_paid_once_per_spawn() {
    let h = scratch("cost-once");
    put(&h, ".anti-hall/settings.json", r#"{"guards":{"maxConcurrentAgents":100000}}"#);
    put(&h, "t.jsonl", &big_transcript());
    tracked_spread(&h, 5);
    put(
        &h,
        ".anti-hall/logic/lib/99-count.js",
        "(function () { var n = { agents: 0, tracked: 0 }, a = ah.transcript.agents, t = ah.transcript.trackedAgents;\n\
         ah.transcript.agents = function (p) { n.agents++; ah.state.writeAtomic('.anti-hall/host-calls.json', JSON.stringify(n)); return a(p); };\n\
         ah.transcript.trackedAgents = function (p) { n.tracked++; ah.state.writeAtomic('.anti-hall/host-calls.json', JSON.stringify(n)); return t(p); }; })();\n",
    );
    let (code, out, err) = check(&h, &[]);
    assert_eq!((code, out.as_str()), (0, ""), "{err}");
    let calls: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(h.join(".anti-hall/host-calls.json")).unwrap()).unwrap();
    assert_eq!(calls, json!({"agents": 1, "tracked": 1}), "the cap and the ceiling share one scan and one tracker read");
}

/// D15 (GH #537): a swarm-guard script that cannot run lets the spawn through, is counted, and says so with a step that exists.
#[test]
fn a_failing_swarm_guard_script_lets_the_spawn_through_counts_it_and_names_a_real_step() {
    let h = scratch("cost-open");
    put(&h, ".anti-hall/settings.json", NO_CAP);
    put(&h, "t.jsonl", "");
    put(&h, ".anti-hall/logic/swarm-guard.js", "throw new Error('injected');\n");
    let (code, out, err) = run(&h, &["hook", "--event", "PreToolUse", "--tool", "Agent"], &payload(&h), &[("AH_ENGINE_DISPATCH_IN_PROCESS", "1")]);
    assert_eq!(code, 0, "a failed swarm-guard must not refuse the spawn: {out} {err}");
    assert!(
        out.contains("systemMessage") && out.contains("swarm-guard guard could not run") && out.contains("injected"),
        "the notice names the failure: {out}"
    );
    assert!(out.contains("/anti-hall:doctor") && !out.contains("~/.anti-hall/logic"), "the notice names a step that exists: {out}");
    let inbox = std::fs::read_to_string(h.join("engine-state/telemetry-inbox.jsonl")).unwrap_or_default();
    assert!(
        inbox.lines().any(|l| l.contains(r#""h":"swarm-guard""#) && l.contains(r#""k":"check""#) && l.contains(r#""o":"error""#)),
        "counted as a failed check: {inbox}"
    );
}

/// The same through the real CPU limit: the interrupted real script on the real-shape fixture.
#[test]
fn a_swarm_guard_interrupted_by_the_cpu_limit_lets_the_spawn_through() {
    let h = scratch("cost-cpu");
    put(&h, ".anti-hall/settings.json", r#"{"guards":{"maxConcurrentAgents":100000}}"#);
    put(&h, "t.jsonl", &big_transcript());
    tracked_spread(&h, 5);
    let (code, out, err) = check(&h, &[("AH_ENGINE_SCRIPT_TIME_MS", "1")]);
    assert_eq!(code, 0, "{out} {err}");
    assert!(out.contains("swarm-guard guard could not run") && out.contains("cpu limit"), "{out}");
}

/// The text of the closed-guard block points at a step that exists (the owner override directory does not exist by default).
#[test]
fn the_fail_closed_block_text_names_a_real_step() {
    let _ = ah_engine::defaults::text("script.ext"); // loads the defaults
    let t = ah_engine::defaults::render("script.msg_fail_closed", &[("check", &"git"), ("why", &"boom")]);
    assert!(t.contains("/anti-hall:doctor") && !t.contains("~/.anti-hall/logic"), "{t}");
}

/// Once per session and check: a second failure of the same session's swarm-guard is told no more.
#[test]
fn the_swarm_guard_failure_notice_is_told_once_per_session() {
    let _ = ah_engine::defaults::text("script.ext");
    assert_eq!(ah_engine::script::failure_mode("swarm-guard"), "open");
    ah_engine::script::set_session("swarm-cost-session");
    let first = ah_engine::script::failed("swarm-guard", "PreToolUse", "boom");
    assert!(matches!(&first, ah_engine::checks::Verdict::Advisory(j) if j.contains("swarm-guard") && j.contains("boom")), "{first:?}");
    assert_eq!(ah_engine::script::failed("swarm-guard", "PreToolUse", "boom"), ah_engine::checks::Verdict::Allow);
}
