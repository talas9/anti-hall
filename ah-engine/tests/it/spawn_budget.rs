//! The fan-out ceiling (`spawn-ceiling`) and usage-aware dispatch (`spawn-usage`) of `swarm-guard` (GH #270), through the real
//! check in a scratch home. Thresholds and texts come from `engine/defaults/spawn_guards.toml`.
use serde_json::json;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

fn scratch(tag: &str) -> PathBuf {
    let d = std::env::temp_dir().join(format!("ah-spawnbudget-{tag}-{}", std::process::id()));
    ah_engine::discard::harmless(std::fs::remove_dir_all(&d));
    std::fs::create_dir_all(d.join(".anti-hall")).unwrap();
    d
}

fn put(home: &Path, rel: &str, body: &str) {
    let p = home.join(rel);
    std::fs::create_dir_all(p.parent().unwrap()).unwrap();
    std::fs::write(p, body).unwrap();
}

/// A transcript in which `n` background agents were launched and none has finished.
fn running(n: usize) -> String {
    let mut out = String::new();
    for i in 0..n {
        let (tu, id) = (format!("toolu_{i}"), format!("a{i:015x}"));
        let call = json!({"type":"assistant","message":{"content":[{"type":"tool_use","id":tu,"name":"Agent","input":{"description":format!("lane {i}"),"subagent_type":"Explore"}}]}});
        let result = json!({"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":tu,
            "content":format!("Async agent launched successfully.\nagentId: {id} (internal ID - do not mention to user)\noutput_file: /tmp/ah-none/{id}.output")}]}});
        out.push_str(&format!("{call}\n{result}\n"));
    }
    out
}

fn usage(five: f64, weekly: f64) -> String {
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis() as u64;
    json!({"timestamp": now, "data": {"fiveHourPercent": five, "weeklyPercent": weekly,
        "fiveHourResetsAt": "2099-01-01T05:00:00.000Z", "weeklyResetsAt": "2099-01-02T00:00:00.000Z"}})
    .to_string()
}

/// The tracker's proof that the first `n` agents of `running(n)` are live: a fresh, readable subagent transcript each and a retained
/// tracker row for it. `spawn_ceiling.ignore_unknown_liveness` (default true) counts a transcript row only on such proof, so a bare
/// transcript row no longer fills a spawn slot.
fn tracked(home: &Path, n: usize) {
    let mut st = ah_engine::agents::State::default();
    for i in 0..n {
        let id = format!("a{i:015x}");
        let rel = format!(".claude/projects/p/s/subagents/agent-{id}.jsonl");
        put(home, &rel, &format!("{}\n", json!({"type":"assistant","message":{"content":[{"type":"text","text":"working"}]}})));
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
}

const NO_CAP: &str = r#"{"guards":{"maxConcurrentAgents":0}}"#;
const CACHE: &str = ".claude/plugins/oh-my-claudecode/.usage-cache-anthropic.json";

/// One spawn through the check: (exit code, stdout).
fn spawn(home: &Path) -> (i32, String) {
    spawn_as(home, "")
}

/// One spawn through the check carrying the tool call id `tu` (none when empty): (exit code, stdout).
fn spawn_as(home: &Path, tu: &str) -> (i32, String) {
    spawn_input(home, tu, json!({"subagent_type":"Explore","prompt":"x"}))
}

/// One spawn through the check with the tool input `input` and the tool call id `tu` (none when empty): (exit code, stdout).
fn spawn_input(home: &Path, tu: &str, input: serde_json::Value) -> (i32, String) {
    let mut payload = json!({"hook_event_name":"PreToolUse","tool_name":"Agent","session_id":"s","cwd":home,
        "transcript_path": home.join("t.jsonl"), "tool_input": input});
    if !tu.is_empty() {
        payload["tool_use_id"] = json!(tu);
    }
    let mut c = Command::new(env!("CARGO_BIN_EXE_ah-engine"));
    c.arg("check")
        .arg("swarm-guard")
        .env_clear()
        .env("PATH", std::env::var("PATH").unwrap_or_default())
        .env("HOME", home)
        .env("USERPROFILE", home)
        .env("ANTIHALL_TEST_ISOLATION", "1")
        .current_dir(home)
        .env("AH_ENGINE_DIR", home.join("engine-state"))
        .env("AH_ENGINE_PLUGIN_ROOT", Path::new(env!("CARGO_MANIFEST_DIR")).join("../plugins/anti-hall"))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut ch = c.spawn().unwrap();
    ch.stdin.take().unwrap().write_all(payload.to_string().as_bytes()).unwrap();
    let o = ch.wait_with_output().unwrap();
    (o.status.code().unwrap_or(-1), String::from_utf8_lossy(&o.stdout).into_owned())
}

#[test]
fn ceiling_blocks_at_twelve_running_and_names_them() {
    let h = scratch("ceil");
    put(&h, ".anti-hall/settings.json", NO_CAP);
    put(&h, "t.jsonl", &running(12));
    tracked(&h, 12);
    let (code, out) = spawn(&h);
    assert_eq!(code, 2, "{out}");
    assert!(out.contains("spawn ceiling") && out.contains("12 agents") && out.contains("limit 12"), "{out}");
    put(&h, "t.jsonl", &running(11));
    assert_eq!(spawn(&h).0, 0, "11 running is under the ceiling");
}

#[test]
fn ceiling_shrinks_near_the_limit() {
    let h = scratch("shrink");
    put(&h, ".anti-hall/settings.json", NO_CAP);
    put(&h, "t.jsonl", &running(6));
    tracked(&h, 6);
    put(&h, CACHE, &usage(10.0, 86.0)); // step 85 -> ceiling 12 - 6 = 6
    let (code, out) = spawn(&h);
    assert_eq!(code, 2, "{out}");
    assert!(out.contains("6 agents are running (limit 6)"), "{out}");
}

#[test]
fn usage_soft_advises_and_hard_blocks() {
    let h = scratch("usage");
    put(&h, "t.jsonl", "");
    put(&h, CACHE, &usage(80.0, 10.0));
    let (code, out) = spawn(&h);
    assert_eq!(code, 0, "{out}");
    assert!(out.contains("usage limit") && out.contains("5-hour"), "{out}");
    put(&h, CACHE, &usage(10.0, 95.0));
    let (code, out) = spawn(&h);
    assert_eq!(code, 2, "{out}");
    assert!(out.contains("weekly") && out.contains("2099-01-02T00:00Z"), "{out}");
    put(&h, CACHE, &usage(10.0, 20.0));
    let (code, out) = spawn(&h);
    assert!(code == 0 && !out.contains("usage limit"), "{out}");
}

#[test]
fn switches_and_skip_lift_the_guards() {
    let h = scratch("off");
    put(&h, "t.jsonl", &running(12));
    put(&h, CACHE, &usage(99.0, 99.0));
    assert_eq!(spawn(&h).0, 2);
    put(&h, ".anti-hall/skip.json", r#"{"spawn-ceiling":99999999999999,"spawn-usage":99999999999999}"#);
    assert_eq!(spawn(&h).0, 0, "skip entries lift both");
    std::fs::remove_file(h.join(".anti-hall/skip.json")).unwrap();
    put(&h, ".anti-hall/settings.json", r#"{"guards":{"spawnCeiling":false,"usageAwareDispatch":false,"maxConcurrentAgents":0}}"#);
    assert_eq!(spawn(&h).0, 0, "the switches lift both");
}

// ---- GH #484: the owner's concurrent-agent cap (guards.maxConcurrentAgents, default 6) ----

/// T1: 6 agents running, none of them tracked (unknown liveness counts as running), the 7th spawn is denied naming the cap and the agents.
#[test]
fn t1_seventh_spawn_denied_naming_cap_and_agents_unknown_liveness_counts() {
    let h = scratch("cap1");
    put(&h, "t.jsonl", &running(6));
    let (code, out) = spawn(&h);
    assert_eq!(code, 2, "{out}");
    assert!(out.contains("limit 6") && out.contains("lane 0"), "{out}");
    assert!(!out.contains("a000000000000000"), "no raw ids: {out}");
}

/// T2: one of four ends (its completion notification is appended to the same transcript), and that frees the slot it held.
#[test]
fn t2_ending_one_frees_a_slot() {
    let h = scratch("cap2");
    let mut t = running(6);
    put(&h, "t.jsonl", &t);
    assert_eq!(spawn(&h).0, 2, "6 running is at the cap of 6");
    let text = format!("<task-notification>\n<task-id>a{:015x}</task-id>\n<status>completed</status>\n</task-notification>", 5);
    t.push_str(&format!("{}\n", json!({"type":"user","message":{"role":"user","content":text}})));
    put(&h, "t.jsonl", &t);
    assert_eq!(spawn(&h).0, 0, "the finished agent no longer holds a slot");
}

/// T3: 0 is off; the setting is respected.
#[test]
fn t3_zero_turns_the_cap_off_and_the_value_is_the_cap() {
    let h = scratch("cap3");
    put(&h, "t.jsonl", &running(8));
    assert_eq!(spawn(&h).0, 2);
    put(&h, ".anti-hall/settings.json", r#"{"guards":{"maxConcurrentAgents":0}}"#);
    assert_eq!(spawn(&h).0, 0, "0 = no cap (the 8 are unproven under the 12-agent ceiling)");
    put(&h, ".anti-hall/settings.json", r#"{"guards":{"maxConcurrentAgents":9}}"#);
    assert_eq!(spawn(&h).0, 0, "8 running under a cap of 9");
    put(&h, ".anti-hall/settings.json", r#"{"guards":{"maxConcurrentAgents":8}}"#);
    assert_eq!(spawn(&h).0, 2, "8 running at a cap of 8");
}

/// A transcript with no agent launched in it (a prompt and an answer).
fn quiet() -> String {
    format!(
        "{}\n{}\n",
        json!({"type":"user","message":{"role":"user","content":"go"}}),
        json!({"type":"assistant","message":{"content":[{"type":"text","text":"ok"}]}})
    )
}

const RESERVATIONS: &str = ".anti-hall/spawn-reservations.json";

/// P1: a burst of 6 overlapping spawn checks with nothing running and the cap at 4: each allow reserves its slot atomically, so
/// exactly 4 are allowed and 2 denied.
#[test]
fn t6_a_parallel_burst_cannot_pass_the_cap() {
    let h = scratch("burst");
    put(&h, "t.jsonl", &quiet());
    put(&h, ".anti-hall/settings.json", r#"{"guards":{"maxConcurrentAgents":4}}"#);
    let go = std::sync::Arc::new(std::sync::Barrier::new(6));
    let runs: Vec<_> = (0..6)
        .map(|i| {
            let (h, go) = (h.clone(), go.clone());
            std::thread::spawn(move || {
                go.wait();
                spawn_as(&h, &format!("toolu_burst{i}")).0
            })
        })
        .collect();
    let codes: Vec<i32> = runs.into_iter().map(|r| r.join().unwrap()).collect();
    assert_eq!(codes.iter().filter(|c| **c == 0).count(), 4, "{codes:?}");
    assert_eq!(codes.iter().filter(|c| **c == 2).count(), 2, "{codes:?}");
}

/// P1: a reservation whose launch never arrives (a crashed or denied call) frees its slot when it expires.
#[test]
fn t7_an_expired_reservation_frees_its_slot() {
    let h = scratch("expire");
    put(&h, ".anti-hall/settings.json", r#"{"guards":{"maxConcurrentAgents":1}}"#);
    put(&h, "t.jsonl", &quiet());
    assert_eq!(spawn_as(&h, "toolu_e0").0, 0, "the first spawn reserves the one slot");
    assert_eq!(spawn_as(&h, "toolu_e1").0, 2, "the reserved slot is taken");
    let mut doc: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(h.join(RESERVATIONS)).unwrap()).unwrap();
    for r in doc["rows"].as_array_mut().unwrap() {
        r["at"] = json!(1); // aged far past the TTL
    }
    put(&h, RESERVATIONS, &doc.to_string());
    assert_eq!(spawn_as(&h, "toolu_e2").0, 0, "an expired reservation no longer holds the slot");
}

/// P1: the launch result of a reserved spawn releases that reservation only, so the launched agent is counted once and the other
/// reservation still holds its slot (no double free).
#[test]
fn t8_a_launch_result_releases_its_own_reservation_once() {
    let h = scratch("release");
    put(&h, ".anti-hall/settings.json", r#"{"guards":{"maxConcurrentAgents":4}}"#);
    put(&h, "t.jsonl", &running(2));
    assert_eq!(spawn_as(&h, "toolu_2").0, 0, "2 running + 0 reserved");
    assert_eq!(spawn_as(&h, "toolu_3").0, 0, "2 running + 1 reserved");
    assert_eq!(spawn_as(&h, "toolu_x").0, 2, "2 running + 2 reserved is the cap");
    put(&h, "t.jsonl", &running(3)); // toolu_2's launch result arrived
    assert_eq!(spawn_as(&h, "toolu_y").0, 2, "3 running + toolu_3 still reserved is the cap");
}

/// P2: tracked running agents count even when their launches fell out of the transcript window: 4 tracked + 1 visible launch is 4.
#[test]
fn t9_tracked_agents_outside_the_window_count() {
    let h = scratch("tracked");
    put(&h, ".anti-hall/settings.json", r#"{"guards":{"maxConcurrentAgents":4}}"#);
    put(&h, "t.jsonl", &running(1));
    tracked(&h, 4);
    let (code, out) = spawn(&h);
    assert_eq!(code, 2, "{out}");
    assert!(out.contains("4 agents are running"), "{out}");
}

// ---- PR #494 round 2: interleavings, a wedged lock, foreground calls, shell jobs, excluded agent types ----

const RES_LOCK: &str = ".anti-hall/spawn-reservations.lock";

fn now_ms() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis() as u64
}

/// A reservations file holding `ids` for session `s`, made now.
fn reserved(home: &Path, ids: &[&str]) {
    let rows: Vec<_> = ids.iter().map(|id| json!({"id": id, "session": "s", "at": now_ms()})).collect();
    put(home, RESERVATIONS, &json!({"rows": rows}).to_string());
}

/// The reservation lock held by `pid`, taken `age_ms` ago (the Node owner-record shape, no host: a local pid).
fn hold_lock(home: &Path, pid: u32, age_ms: u64) {
    put(home, RES_LOCK, &json!({"pid": pid, "ts": now_ms() - age_ms, "token": "held-by-test"}).to_string());
}

/// P1: cap 2, agent X (toolu_0) reserved but not launched. Check A starts while the lock is held; X then launches and check B
/// replaces X's reservation with its own; only then A gets the lock. A must count X (running) + B (reserved) = 2 and be denied.
#[test]
fn t10_a_launch_between_snapshot_and_lock_cannot_pass_the_cap() {
    let h = scratch("interleave");
    put(&h, ".anti-hall/settings.json", r#"{"guards":{"maxConcurrentAgents":2}}"#);
    put(&h, "t.jsonl", &quiet());
    reserved(&h, &["toolu_0"]);
    let warm = scratch("interleave-warm");
    put(&warm, "t.jsonl", &quiet());
    spawn_as(&warm, "toolu_warm"); // a warm binary and page cache, so A reaches its snapshot well inside the sleep below
    hold_lock(&h, std::process::id(), 0);
    let a = {
        let h = h.clone();
        std::thread::spawn(move || spawn_as(&h, "toolu_A"))
    };
    std::thread::sleep(std::time::Duration::from_millis(1200)); // A is waiting on the lock (spawn_reservation.lock_wait_ms 2000)
    put(&h, "t.jsonl", &running(1)); // X (toolu_0) launched
    reserved(&h, &["toolu_B"]); // B saw X running, dropped its reservation and reserved its own slot
    std::fs::remove_file(h.join(RES_LOCK)).unwrap(); // B releases the lock
    let (code, out) = a.join().unwrap();
    assert_eq!(code, 2, "X running + B reserved is the cap of 2, A must be denied: {out}");
}

/// LOCK MUST NOT WEDGE: a check that died holding the reservation lock (dead pid), or a hung one past swarm_guard.lock_stale_ms,
/// never stops the next spawn: it is allowed AND reserves (the lock was taken over, not skipped).
#[test]
fn t11_a_lock_left_by_a_dead_or_hung_check_does_not_wedge() {
    let h = scratch("wedge");
    put(&h, "t.jsonl", &quiet());
    let mut dead = Command::new("true").spawn().unwrap();
    let pid = dead.id();
    dead.wait().unwrap();
    hold_lock(&h, pid, 0);
    let t = std::time::Instant::now();
    assert_eq!(spawn_as(&h, "toolu_w0").0, 0);
    assert!(std::fs::read_to_string(h.join(RESERVATIONS)).unwrap_or_default().contains("toolu_w0"), "dead holder taken over");
    assert!(t.elapsed().as_millis() < 5000, "allowed within the stale timeout");
    hold_lock(&h, std::process::id(), 60_000); // a live but hung holder, far past the stale timeout
    assert_eq!(spawn_as(&h, "toolu_w1").0, 0);
    assert!(std::fs::read_to_string(h.join(RESERVATIONS)).unwrap_or_default().contains("toolu_w1"), "stale holder taken over");
}

/// An Agent call and its foreground (synchronous) result: no async launch, so never a running row.
fn foreground(i: usize) -> String {
    let tu = format!("toolu_fg{i}");
    let call = json!({"type":"assistant","message":{"content":[{"type":"tool_use","id":tu,"name":"Agent","input":{"description":format!("fg {i}"),"subagent_type":"Explore"}}]}});
    let result = json!({"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":tu,"content":"done: the answer"}]}});
    format!("{call}\n{result}\n")
}

/// P2: foreground Agent calls never hold a slot: four marked foreground reserve nothing, and four unmarked ones whose results are in
/// the transcript are released, so the next background spawn is allowed at once with zero background agents.
#[test]
fn t12_foreground_calls_leave_no_reservation() {
    let h = scratch("foreground");
    put(&h, "t.jsonl", &quiet());
    for i in 0..4 {
        let input = json!({"subagent_type":"Explore","prompt":"x","run_in_background":false});
        assert_eq!(spawn_input(&h, &format!("toolu_ff{i}"), input).0, 0);
    }
    assert_eq!(spawn_input(&h, "toolu_bg", json!({"subagent_type":"Explore","prompt":"x","run_in_background":true})).0, 0, "4 foreground calls hold no slot");
    let h = scratch("foreground2");
    put(&h, "t.jsonl", &quiet());
    for i in 0..4 {
        assert_eq!(spawn_as(&h, &format!("toolu_fg{i}")).0, 0);
    }
    put(&h, "t.jsonl", &(0..4).map(foreground).collect::<String>());
    assert_eq!(spawn_as(&h, "toolu_next").0, 0, "4 answered calls released their reservations");
}

/// P2: a background agent that launched and finished before the next check releases its reservation (its row is completed, so it
/// is not among the running rows).
#[test]
fn t13_a_background_agent_finished_before_reconciliation_frees_its_slot() {
    let h = scratch("finished");
    put(&h, ".anti-hall/settings.json", r#"{"guards":{"maxConcurrentAgents":1}}"#);
    put(&h, "t.jsonl", &quiet());
    assert_eq!(spawn_as(&h, "toolu_0").0, 0);
    let done = json!({"type":"user","message":{"role":"user","content":format!("<task-notification>\n<task-id>a{:015x}</task-id>\n<status>completed</status>\n</task-notification>", 0)}});
    put(&h, "t.jsonl", &format!("{}{done}\n", running(1)));
    let (code, out) = spawn_as(&h, "toolu_1");
    assert_eq!(code, 0, "the finished agent's reservation is released: {out}");
}

/// P2: background shell jobs of the session are tracker children too, but not agents: 4 running jobs and 0 agents allow a spawn.
#[test]
fn t14_shell_jobs_do_not_fill_the_cap() {
    let h = scratch("shelljobs");
    put(&h, "t.jsonl", &quiet());
    let mut st = ah_engine::agents::State::default();
    let mut a = ah_engine::agents::Agent {
        id: "s".into(),
        kind: "main".into(),
        parent: "s".into(),
        name: "main".into(),
        cwd: h.to_string_lossy().into_owned(),
        path: h.join("t.jsonl").to_string_lossy().into_owned(),
        ..Default::default()
    };
    for i in 0..4 {
        a.bg_ids.insert(format!("bjob{i}"), now_ms());
    }
    st.agents.insert("s".into(), a);
    put(&h, ".anti-hall/agent-tracker/state.json", &serde_json::to_string(&st).unwrap());
    let (code, out) = spawn(&h);
    assert_eq!(code, 0, "4 shell jobs are not agents: {out}");
}

/// A transcript in which one background agent of each type in `types` was launched and none has finished.
fn launches(types: &[&str]) -> String {
    let mut out = String::new();
    for (i, ty) in types.iter().enumerate() {
        let (tu, id) = (format!("toolu_{i}"), format!("a{i:015x}"));
        let call = json!({"type":"assistant","message":{"content":[{"type":"tool_use","id":tu,"name":"Agent","input":{"description":format!("lane {i}"),"subagent_type":ty,"run_in_background":true}}]}});
        let result = json!({"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":tu,
            "content":format!("Async agent launched successfully.\nagentId: {id} (internal ID - do not mention to user)\noutput_file: /tmp/ah-none/{id}.output")}]}});
        out.push_str(&format!("{call}\n{result}\n"));
    }
    out
}

/// COUNT WHAT THE OWNER MEANS: Codex reviewer agents (guards.cap_excluded_agent_types) neither count nor are capped: 4 builders + 2
/// Codex reviewers running at cap 4 deny a 5th builder and allow a 3rd Codex reviewer.
#[test]
fn t15_codex_reviewers_are_outside_the_cap() {
    let h = scratch("codex");
    put(&h, ".anti-hall/settings.json", r#"{"guards":{"maxConcurrentAgents":4}}"#);
    put(&h, "t.jsonl", &launches(&["executor", "executor", "executor", "executor", "codex:codex-rescue", "codex:codex-rescue"]));
    let (code, out) = spawn_input(&h, "toolu_b5", json!({"subagent_type":"executor","prompt":"x","run_in_background":true}));
    assert_eq!(code, 2, "4 builders fill the cap: {out}");
    assert!(out.contains("4 agents are running"), "the 2 reviewers are not counted: {out}");
    let (code, out) = spawn_input(&h, "toolu_c3", json!({"subagent_type":"codex:codex-rescue","prompt":"x","run_in_background":true}));
    assert_eq!(code, 0, "a Codex reviewer is outside the cap: {out}");
}

// ---- PR #494 round 3: one launch counted once, tracker-only children keep their agent type ----

/// One retained, live tracker child `id` of session `s` (a fresh subagent transcript), with the host meta file `meta` when given and
/// the tracker's Codex-rescue mark `rescue`; the rows already in the tracker state are kept.
fn tracked_child(home: &Path, id: &str, meta: Option<serde_json::Value>, rescue: bool) {
    let path = home.join(".anti-hall/agent-tracker/state.json");
    let mut st: ah_engine::agents::State = std::fs::read_to_string(&path).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default();
    let rel = format!(".claude/projects/p/s/subagents/agent-{id}.jsonl");
    put(home, &rel, &format!("{}\n", json!({"type":"assistant","message":{"content":[{"type":"text","text":"working"}]}})));
    if let Some(m) = meta {
        put(home, &format!(".claude/projects/p/s/subagents/agent-{id}.meta.json"), &m.to_string());
    }
    let a = ah_engine::agents::Agent {
        id: id.into(),
        kind: "subagent".into(),
        parent: "s".into(),
        name: format!("child {id}"),
        cwd: home.to_string_lossy().into_owned(),
        path: home.join(rel).to_string_lossy().into_owned(),
        codex_rescue: rescue,
        ..Default::default()
    };
    st.agents.insert(id.into(), a);
    put(home, ".anti-hall/agent-tracker/state.json", &serde_json::to_string(&st).unwrap());
}

/// P2-A: cap 2, launch A reserved; the tracker finds child A (its meta names A's call) before A's launch result shows in the
/// transcript. A is one agent, not a running child plus an open reservation, so launch B is allowed.
#[test]
fn t16_a_child_seen_before_its_launch_result_counts_once() {
    let h = scratch("dedupe");
    put(&h, ".anti-hall/settings.json", r#"{"guards":{"maxConcurrentAgents":2}}"#);
    put(&h, "t.jsonl", &quiet());
    assert_eq!(spawn_input(&h, "toolu_A", json!({"subagent_type":"Explore","prompt":"x","run_in_background":true})).0, 0, "A fits");
    tracked_child(&h, "a00000000000000a", Some(json!({"agentType":"Explore","toolUseId":"toolu_A"})), false);
    let (code, out) = spawn_input(&h, "toolu_B", json!({"subagent_type":"Explore","prompt":"x","run_in_background":true}));
    assert_eq!(code, 0, "A counted once (1 of 2): {out}");
    let (code, out) = spawn_input(&h, "toolu_C", json!({"subagent_type":"Explore","prompt":"x","run_in_background":true}));
    assert_eq!(code, 2, "A running + B reserved fill the cap: {out}");
}

/// P2-B: cap 4, three executors running and an older Codex rescue whose launch left the transcript window (tracker-only, known as a
/// rescue to the tracker): the rescue is outside the cap, so a 4th executor is allowed.
#[test]
fn t17_a_tracker_only_codex_rescue_is_outside_the_cap() {
    let h = scratch("rescue-tracked");
    put(&h, ".anti-hall/settings.json", r#"{"guards":{"maxConcurrentAgents":4}}"#);
    put(&h, "t.jsonl", &launches(&["executor", "executor", "executor"]));
    tracked(&h, 3);
    tracked_child(&h, "a00000000000000r", None, true);
    let (code, out) = spawn_input(&h, "toolu_e4", json!({"subagent_type":"executor","prompt":"x","run_in_background":true}));
    assert_eq!(code, 0, "3 executors + a Codex rescue at cap 4: {out}");
    let (code, out) = spawn_input(&h, "toolu_e5", json!({"subagent_type":"executor","prompt":"x","run_in_background":true}));
    assert_eq!(code, 2, "3 executors + the 4th reserved fill the cap: {out}");
}

/// GH #494: a general-purpose child that merely runs Codex (its meta names general-purpose even though the tracker marked it a rescue)
/// is an agent of the cap: 3 executors + it fill a cap of 4.
#[test]
fn t18_a_tracker_only_general_purpose_child_running_codex_counts() {
    let h = scratch("gp-codex");
    put(&h, ".anti-hall/settings.json", r#"{"guards":{"maxConcurrentAgents":4}}"#);
    put(&h, "t.jsonl", &launches(&["executor", "executor", "executor"]));
    tracked(&h, 3);
    tracked_child(&h, "a00000000000000g", Some(json!({"agentType":"general-purpose"})), true);
    let (code, out) = spawn_input(&h, "toolu_e4", json!({"subagent_type":"executor","prompt":"x","run_in_background":true}));
    assert_eq!(code, 2, "3 executors + the general-purpose child fill the cap: {out}");
}

/// GH #494: a child whose meta carries no (or another) launch id still releases its own reservation, matched by agent type: at cap 2
/// a child of reserved launch A is one agent, so launch B fits instead of waiting out the TTL.
#[test]
fn t19_a_child_without_a_launch_id_releases_its_reservation_by_type() {
    let h = scratch("noid");
    put(&h, ".anti-hall/settings.json", r#"{"guards":{"maxConcurrentAgents":2}}"#);
    put(&h, "t.jsonl", &quiet());
    assert_eq!(spawn_input(&h, "toolu_A", json!({"subagent_type":"Explore","prompt":"x","run_in_background":true})).0, 0, "A fits");
    tracked_child(&h, "a00000000000000a", Some(json!({"agentType":"Explore"})), false);
    let (code, out) = spawn_input(&h, "toolu_B", json!({"subagent_type":"Explore","prompt":"x","run_in_background":true}));
    assert_eq!(code, 0, "A counted once (1 of 2): {out}");
    let (code, out) = spawn_input(&h, "toolu_C", json!({"subagent_type":"Explore","prompt":"x","run_in_background":true}));
    assert_eq!(code, 2, "A running + B reserved fill the cap: {out}");
}
