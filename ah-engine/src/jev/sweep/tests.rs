use super::*;
use crate::jev::assist::iso_ms;
use crate::jev::cascade::{MODEL_LOCK, TEST_MODEL};
use std::process::Command;
use std::sync::{Arc, Mutex};

const NOW: i64 = 1_790_000_000_000;
const MIN: i64 = 60_000;

fn home(tag: &str) -> PathBuf {
    let h = std::env::temp_dir().join(format!("ah-sweep-{tag}-{}", std::process::id()));
    crate::discard::harmless(std::fs::remove_dir_all(&h));
    std::fs::create_dir_all(&h).unwrap();
    h
}

fn env(w: &str, l: &str, s: &str) -> Env {
    Env::from_pairs([
        ("ANTIHALL_JEV", "1"),
        ("CLAUDE_PLUGIN_OPTION_JEV_INTEGRATION_DEVSWARM_WAIT_KIND", w),
        ("CLAUDE_PLUGIN_OPTION_JEV_INTEGRATION_DEVSWARM_LOOP", l),
        ("CLAUDE_PLUGIN_OPTION_JEV_INTEGRATION_DEVSWARM_STEP_MAP", s),
    ])
}

fn put(path: PathBuf, text: &str) {
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(path, text).unwrap();
}

fn tool(t: i64, cmd: &str) -> String {
    json!({"type": "assistant", "timestamp": iso_ms(t as u64), "message": {"content": [{"type": "tool_use", "name": "Bash", "input": {"command": cmd}}]}})
        .to_string()
}
fn said(t: i64, text: &str) -> String {
    json!({"type": "assistant", "timestamp": iso_ms(t as u64), "message": {"content": [{"type": "text", "text": text}]}}).to_string()
}

/// A child `kid` whose plan has been quiet for `quiet_min`, with `tools` transcript lines, in a scratch home.
fn fixture(h: &Path, plan: Value, transcript: &[String]) {
    let base = h.join(".anti-hall/devswarm");
    put(base.join("plans/kid.json"), &plan.to_string());
    put(base.join("workspaces/kid.json"), &json!({"id": "kid", "worktreePath": "/nonexistent/wt/kid", "sessionId": "sess-1"}).to_string());
    put(h.join(".claude/projects/-nonexistent-wt-kid/sess-1.jsonl"), &(transcript.join("\n") + "\n"));
}

fn plan(quiet_min: i64) -> Value {
    let t = NOW - quiet_min * MIN;
    json!({"v": 1, "key": "kid", "id": "kid", "created_at": t - 5 * MIN, "step_ts": t, "steps": [
        {"n": 1, "text": "write the parser", "status": "done", "ts": t - MIN, "started_at": t - 5 * MIN},
        {"n": 2, "text": "wire the cache", "status": "doing", "ts": t, "started_at": t}], "summaries": []})
}

fn six_tools(from: i64) -> Vec<String> {
    let mut v: Vec<String> = (0..6).map(|i| tool(from + i * MIN, &format!("cargo test {i}"))).collect();
    v.push(said(from + 7 * MIN, "waiting for the next step"));
    v
}

fn mesh_store(h: &Path, rows: &[(&str, i64, &str, bool)]) {
    let dir = h.join(".anti-hall/devswarm/store");
    std::fs::create_dir_all(&dir).unwrap();
    let c = rusqlite::Connection::open(dir.join("devswarm.db")).unwrap();
    c.execute_batch("CREATE TABLE messages (id INTEGER PRIMARY KEY AUTOINCREMENT, workspace_id TEXT NOT NULL, ts INTEGER NOT NULL, hash TEXT, body TEXT, sender TEXT, recipient TEXT, mtype TEXT, urgency TEXT, is_heartbeat INTEGER, needs_reply INTEGER, orig_hash TEXT, instance_nonce TEXT, seq INTEGER, UNIQUE(hash));").unwrap();
    for (i, (partition, ts, sender, ask)) in rows.iter().enumerate() {
        c.execute(
            "INSERT INTO messages (workspace_id, ts, hash, body, sender, recipient, mtype, needs_reply, seq) VALUES (?1, ?2, ?3, 'hello', ?4, ?1, 'direct', ?5, ?6)",
            rusqlite::params![partition, ts, format!("h{i}"), sender, i32::from(*ask), i as i64 + 1],
        )
        .unwrap();
    }
}

fn rows(h: &Path) -> Vec<Value> {
    std::fs::read_to_string(h.join(".anti-hall/logs/jev-evidence.ndjson")).unwrap_or_default().lines().filter_map(|l| serde_json::from_str(l).ok()).collect()
}

fn model_says(reply: &'static str, seen: Arc<Mutex<Vec<String>>>) {
    *TEST_MODEL.lock().unwrap() = Some(Box::new(move |c| {
        seen.lock().unwrap().push(c.input.to_string());
        crate::judge::cli::CliOutcome { result: Ok(reply.to_string()), ms: 9 }
    }));
}

#[test]
fn durations_paths_and_the_current_step_read_the_way_the_plan_does() {
    assert_eq!((dur(5 * MIN), dur(150 * MIN), dur(50 * 60 * MIN)), ("5m".into(), "2h".into(), "2d".into()));
    assert_eq!(project_dir_name("/Users/a/.devswarm/x.y"), "-Users-a--devswarm-x-y");
    let p = plan(40);
    assert_eq!(current_step(&p).unwrap()["n"], 2);
    let none = json!({"steps": [{"n": 1, "status": "done"}]});
    assert!(current_step(&none).is_none());
}

#[test]
fn transcript_lines_become_tool_text_error_prompt_and_note_events() {
    let lines = [
        tool(NOW, "git reset --hard HEAD~1"),
        said(NOW + 1000, "hello"),
        json!({"type": "user", "timestamp": iso_ms(NOW as u64 + 2000), "message": {"content": [{"type": "tool_result", "is_error": true, "content": "boom"}]}})
            .to_string(),
        json!({"type": "user", "timestamp": iso_ms(NOW as u64 + 3000), "message": {"content": "<task-notification>x"}}).to_string(),
        json!({"type": "user", "timestamp": iso_ms(NOW as u64 + 4000), "message": {"content": "please continue"}}).to_string(),
        json!({"type": "user", "timestamp": iso_ms(NOW as u64 + 5000), "message": {"content": "<system-reminder>x"}}).to_string(),
        "not json".to_string(),
    ];
    let ev = parse_events(lines.iter().map(String::as_str));
    let kinds: Vec<&Kind> = ev.iter().map(|e| &e.kind).collect();
    assert_eq!(kinds, [&Kind::Tool, &Kind::Text, &Kind::Err, &Kind::Note, &Kind::User]);
    assert_eq!((ev[0].text.as_str(), ev[2].text.as_str()), ("git reset --hard HEAD~1", "boom"));
}

#[test]
fn a_quiet_child_with_a_question_unanswered_by_its_parent_is_decided_by_rule_and_logged() {
    let _g = MODEL_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let h = home("unanswered");
    fixture(&h, plan(40), &six_tools(NOW - 45 * MIN));
    mesh_store(&h, &[("kid", NOW - 90 * MIN, "parent", false), ("parent", NOW - 50 * MIN, "kid", true)]);
    let seen = Arc::new(Mutex::new(Vec::new()));
    model_says(r#"{"answer":true,"confidence":0.9,"evidence_ref":"tool_calls.1"}"#, seen.clone());
    let r = sweep(&h, &env("on", "off", "off"), NOW);
    *TEST_MODEL.lock().unwrap() = None;
    assert!(seen.lock().unwrap().is_empty(), "a rule decided; no model was called");
    assert_eq!(r["children"], 1);
    let d = &r["decided"][0];
    assert_eq!(
        (d["integration"].as_str(), d["phase"].as_str(), d["label"].as_str(), d["rule"].as_str()),
        (Some("devswarmWaitKind"), Some("rule"), Some("waiting"), Some("unanswered_question_to_parent"))
    );
    let log = rows(&h);
    assert_eq!((log.len(), log[0]["child"].as_str()), (1, Some("kid")));
    let present: Vec<&str> = log[0]["present"].as_array().unwrap().iter().filter_map(Value::as_str).collect();
    assert!(present.contains(&"mesh_coverage") && present.contains(&"unanswered_q_to_parent") && present.contains(&"tool_calls"), "{present:?}");
}

#[test]
fn a_quiet_child_with_no_outside_reason_is_asked_with_a_pack_of_its_own_transcript_and_mesh() {
    let _g = MODEL_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let h = home("ask");
    fixture(&h, plan(40), &six_tools(NOW - 45 * MIN));
    mesh_store(&h, &[("kid", NOW - 90 * MIN, "parent", false)]);
    let seen = Arc::new(Mutex::new(Vec::new()));
    model_says(r#"{"answer":true,"confidence":0.9,"evidence_ref":"tool_calls.2"}"#, seen.clone());
    let r = sweep(&h, &env("on", "off", "off"), NOW);
    *TEST_MODEL.lock().unwrap() = None;
    let d = &r["decided"][0];
    assert_eq!(
        (d["phase"].as_str(), d["source"].as_str(), d["label"].as_str(), d["actionable"].as_bool()),
        (Some("asked"), Some("haiku"), Some("stuck"), Some(true))
    );
    let input = seen.lock().unwrap()[0].clone();
    assert!(
        input.contains("No step progress for 40m")
            && input.contains("cargo test 1")
            && input.contains("waiting for the next step")
            && input.contains("mesh_coverage = 1"),
        "{input}"
    );
    // the same subject is not asked again until the re-ask window passes
    let again = sweep(&h, &env("on", "off", "off"), NOW + MIN);
    assert_eq!(again["decided"].as_array().unwrap().len(), 0);
    let later = sweep(&h, &env("on", "off", "off"), NOW + lim("reask_ms") + MIN);
    assert_eq!(later["decided"].as_array().unwrap().len(), 1);
}

#[test]
fn a_child_with_too_little_transcript_or_no_mesh_is_skipped_with_what_was_missing() {
    let h = home("insufficient");
    fixture(&h, plan(40), &[tool(NOW - 41 * MIN, "ls")]);
    let r = sweep(&h, &env("on", "off", "off"), NOW);
    assert_eq!(r["decided"][0]["reason"], "insufficient");
    let log = rows(&h);
    let missing: Vec<&str> = log[0]["missing"].as_array().unwrap().iter().filter_map(Value::as_str).collect();
    assert_eq!(missing, ["tool_calls:5", "assistant_texts:1", "mesh_coverage:1"]);
}

#[test]
fn a_done_child_is_never_asked_about_and_the_rule_says_so_once() {
    let h = home("done");
    let mut p = plan(40);
    p["done_reported_at"] = json!(NOW - 41 * MIN);
    fixture(&h, p, &six_tools(NOW - 45 * MIN));
    let r = sweep(&h, &env("on", "off", "off"), NOW);
    let d = &r["decided"][0];
    assert_eq!((d["phase"].as_str(), d["reason"].as_str(), d["rule"].as_str()), (Some("skipped"), Some("rule-skip"), Some("child_done")));
}

#[test]
fn a_looping_candidate_is_found_from_reverts_and_repeats_and_a_model_only_confirms_it() {
    let _g = MODEL_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let h = home("loop");
    let start = NOW - 100 * MIN;
    let mut t: Vec<String> = (0..11).map(|i| tool(NOW - 50 * MIN + i * MIN, "cargo test -p x")).collect();
    t.push(tool(NOW - 30 * MIN, "git reset --hard HEAD"));
    let mut p = plan(80);
    p["steps"][1]["started_at"] = json!(start);
    p["step_ts"] = json!(start);
    fixture(&h, p, &t);
    let seen = Arc::new(Mutex::new(Vec::new()));
    model_says(r#"{"answer":true,"confidence":0.9,"evidence_ref":"repeats.1"}"#, seen.clone());
    let r = sweep(&h, &env("off", "on", "off"), NOW);
    *TEST_MODEL.lock().unwrap() = None;
    let d = &r["decided"][0];
    assert_eq!(
        (d["integration"].as_str(), d["phase"].as_str(), d["label"].as_str()),
        (Some("devswarmLoop"), Some("asked"), Some("looping")),
        "{d}\n{:?}",
        seen.lock().unwrap()
    );
    let input = seen.lock().unwrap()[0].clone();
    assert!(input.contains("\"cargo test -p x\" x") && input.contains("reverts = 1") && input.contains("tool_calls = 12"), "{input}");
}

#[test]
fn a_looping_child_with_recent_progress_is_not_looping_by_rule_and_a_clean_one_is_no_candidate() {
    let h = home("loop-progress");
    let start = NOW - 100 * MIN;
    let mut p = plan(10);
    p["steps"][1]["started_at"] = json!(start);
    fixture(&h, p, &(0..12).map(|i| tool(start + i * MIN, "ls")).collect::<Vec<_>>());
    let r = sweep(&h, &env("off", "on", "off"), NOW);
    let d = &r["decided"][0];
    assert_eq!((d["phase"].as_str(), d["label"].as_str(), d["rule"].as_str()), (Some("rule"), Some("not_looping"), Some("recent_progress")));
}

#[test]
fn a_summary_that_quotes_a_step_is_mapped_by_rule_and_a_plan_with_no_earlier_report_is_insufficient() {
    let h = home("stepmap");
    let mut p = plan(10);
    p["steps"][0]["status"] = json!("todo");
    p["steps"][1]["status"] = json!("todo");
    p["summaries"] = json!([{"ts": NOW - 5 * MIN, "text": "made some progress today", "stepped": false}]);
    fixture(&h, p.clone(), &[]);
    let r = sweep(&h, &env("off", "off", "shadow"), NOW);
    let d = &r["decided"][0];
    assert_eq!(
        (d["integration"].as_str(), d["reason"].as_str()),
        (Some("devswarmStepMap"), Some("insufficient")),
        "needs one earlier summary with a reported step"
    );
    // with an earlier summary that was sent with step 1 (the step whose own timestamp sits next to it) the quote decides
    let mut p2 = p;
    p2["steps"][0]["ts"] = json!(NOW - 20 * MIN);
    p2["summaries"] = json!([{"ts": NOW - 20 * MIN + 1000, "text": "parser done", "stepped": true}, {"ts": NOW - 5 * MIN, "text": "finished the wire the cache work", "stepped": false}]);
    fixture(&h, p2, &[]);
    crate::discard::harmless(std::fs::remove_file(h.join(".anti-hall/devswarm/jev-sweep-state.json")));
    let r = sweep(&h, &env("off", "off", "on"), NOW);
    let d = &r["decided"][0];
    assert_eq!((d["phase"].as_str(), d["label"].as_str(), d["rule"].as_str()), (Some("rule"), Some("2"), Some("summary_quotes_step")));
}

#[test]
fn with_all_three_integrations_off_no_child_is_read_and_no_row_is_written() {
    let h = home("off");
    fixture(&h, plan(40), &six_tools(NOW - 45 * MIN));
    let r = sweep(&h, &env("off", "off", "off"), NOW);
    assert_eq!((r["children"].clone(), r["idle"].clone()), (json!(0), json!(true)));
    assert!(rows(&h).is_empty() && !h.join(".anti-hall/devswarm/jev-sweep-state.json").exists());
}

#[test]
fn the_held_list_and_the_stall_override_come_from_the_environment() {
    let h = home("env");
    fixture(&h, plan(40), &six_tools(NOW - 45 * MIN));
    let held = Env::from_pairs([
        ("ANTIHALL_JEV", "1"),
        ("CLAUDE_PLUGIN_OPTION_JEV_INTEGRATION_DEVSWARM_WAIT_KIND", "on"),
        ("ANTIHALL_DEVSWARM_HELD_PARTITIONS", "other, kid"),
    ]);
    let r = sweep(&h, &held, NOW);
    assert_eq!(r["decided"][0]["rule"], "child_on_hold");
    let calm =
        Env::from_pairs([("ANTIHALL_JEV", "1"), ("CLAUDE_PLUGIN_OPTION_JEV_INTEGRATION_DEVSWARM_WAIT_KIND", "on"), ("ANTIHALL_DEVSWARM_STEP_STALL_MIN", "90")]);
    let h2 = home("env2");
    fixture(&h2, plan(40), &six_tools(NOW - 45 * MIN));
    assert_eq!(sweep(&h2, &calm, NOW)["children"], 0, "40 quiet minutes is under a 90 minute stall window");
}

// ---- acting on the answers (the way Node's supervisor did while these integrations were on) ----------------------------------

fn stray_file(h: &Path) -> PathBuf {
    h.join(".anti-hall/devswarm/stray/kid.json")
}

/// The straying state the supervisor wrote for `kid`: one warned `signal` on step 2 (stall or burn), as Node's `evaluateChild` leaves it.
fn stray_with(h: &Path, signal: &str) {
    let key = format!("{signal}:2:1");
    let st = json!({"v": 1, "key": "kid", "id": "kid", "worktreePath": null, "warned": {key.clone(): {"at": NOW, "n": 1, "signal": signal, "step": 2}},
        "perStep": {format!("{signal}:2"): 1}, "active": [{"key": key, "signal": signal, "step": 2, "reason": "no step progress 40m", "at": NOW, "n": 1}], "updated_at": NOW});
    put(stray_file(h), &st.to_string());
}

fn stray(h: &Path) -> Value {
    serde_json::from_str(&std::fs::read_to_string(stray_file(h)).unwrap()).unwrap()
}

fn sup_log(h: &Path) -> Vec<Value> {
    std::fs::read_to_string(h.join(".anti-hall/logs/devswarm-supervision.ndjson"))
        .unwrap_or_default()
        .lines()
        .filter_map(|l| serde_json::from_str(l).ok())
        .collect()
}

/// What Node's own `strayingLine` prints for these active entries (None when node is not installed).
fn node_line(active: &Value, scratch: &Path) -> Option<String> {
    let lib = Path::new(env!("CARGO_MANIFEST_DIR")).join("../plugins/anti-hall/companion/lib/devswarm-supervision.js");
    let out = Command::new("node")
        .args(["-e", "const s=require(process.argv[1]);const a=JSON.parse(process.argv[2]);console.log(s.strayingLine(a.map(e=>({id:'kid',step:e.step,reason:e.reason,jev:e.jev}))))"])
        .arg(&lib)
        .arg(active.to_string())
        .env("HOME", scratch)
        .output()
        .ok()?;
    out.status.success().then(|| String::from_utf8_lossy(&out.stdout).trim().to_string())
}

#[test]
fn a_stuck_answer_is_attached_to_the_stall_warning_the_way_node_did_and_survives_a_supervisor_rewrite() {
    let _g = MODEL_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let h = home("act-wait");
    fixture(&h, plan(40), &six_tools(NOW - 45 * MIN));
    mesh_store(&h, &[("kid", NOW - 90 * MIN, "parent", false)]);
    stray_with(&h, "stall");
    model_says(r#"{"answer":true,"confidence":0.92,"evidence_ref":"tool_calls.2"}"#, Arc::new(Mutex::new(Vec::new())));
    let r = sweep(&h, &env("on", "off", "off"), NOW);
    *TEST_MODEL.lock().unwrap() = None;
    assert_eq!(r["decided"][0]["acted"], "annotated");
    let active = stray(&h)["active"].clone();
    assert_eq!(active[0]["jev"], json!([{"integration": "devswarmWaitKind", "verdict": "stuck", "confidence": 0.92, "supports": true}]));
    if let Some(line) = node_line(&active, &h) {
        assert!(line.contains("(Jev: stuck 0.92)"), "node prints the engine's note: {line}");
    }
    // telemetry: one `jev` event with Node's fields; `agree` is true because stuck agrees with the warning
    let ev: Vec<Value> = sup_log(&h).into_iter().filter(|e| e["type"] == "jev").collect();
    assert_eq!(ev.len(), 1);
    assert_eq!(
        (ev[0]["integration"].as_str(), ev[0]["mode"].as_str(), ev[0]["agree"].as_bool(), ev[0]["confidence"].as_f64()),
        (Some("devswarmWaitKind"), Some("on"), Some(true), Some(0.92))
    );
    // the supervisor rewrites its state from its own signals on its next pass: the note comes back, and no second event is written
    stray_with(&h, "stall");
    let again = sweep(&h, &env("on", "off", "off"), NOW + MIN);
    assert_eq!(again["decided"].as_array().unwrap().len(), 0);
    assert_eq!(stray(&h)["active"][0]["jev"][0]["verdict"], "stuck");
    assert_eq!(sup_log(&h).iter().filter(|e| e["type"] == "jev").count(), 1);
}

#[test]
fn a_waiting_rule_answer_says_so_with_full_confidence_and_a_shadow_integration_changes_nothing() {
    let h = home("act-rule");
    fixture(&h, plan(40), &six_tools(NOW - 45 * MIN));
    mesh_store(&h, &[("kid", NOW - 90 * MIN, "parent", false), ("parent", NOW - 50 * MIN, "kid", true)]);
    stray_with(&h, "idle");
    sweep(&h, &env("on", "off", "off"), NOW);
    assert_eq!(
        stray(&h)["active"][0]["jev"],
        json!([{"integration": "devswarmWaitKind", "verdict": "waiting on CI/owner/peer, not stuck", "confidence": 1.0, "supports": false}])
    );
    let sh = home("act-shadow");
    fixture(&sh, plan(40), &six_tools(NOW - 45 * MIN));
    mesh_store(&sh, &[("kid", NOW - 90 * MIN, "parent", false), ("parent", NOW - 50 * MIN, "kid", true)]);
    stray_with(&sh, "idle");
    let before = std::fs::read_to_string(stray_file(&sh)).unwrap();
    let r = sweep(&sh, &env("shadow", "off", "off"), NOW);
    assert_eq!(r["decided"][0]["acted"], Value::Null);
    assert_eq!(std::fs::read_to_string(stray_file(&sh)).unwrap(), before, "shadow writes nothing");
    assert!(sup_log(&sh).is_empty());
}

fn loop_fixture(h: &Path, tail_min: i64) {
    let start = NOW - tail_min * MIN;
    let mut p = plan(80);
    p["steps"][1]["started_at"] = json!(start);
    p["step_ts"] = json!(NOW - 100 * MIN);
    let mut t: Vec<String> = (0..11).map(|i| tool(NOW - 50 * MIN + i * MIN, "cargo test -p x")).collect();
    t.push(tool(NOW - 30 * MIN, "git reset --hard HEAD"));
    fixture(h, p, &t);
}

#[test]
fn a_looping_answer_joins_the_stall_warning_and_a_lower_confidence_than_the_floor_is_not_acted_on() {
    let _g = MODEL_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let h = home("act-loop-host");
    loop_fixture(&h, 100);
    stray_with(&h, "stall");
    model_says(r#"{"answer":true,"confidence":0.87,"evidence_ref":"repeats.1"}"#, Arc::new(Mutex::new(Vec::new())));
    let r = sweep(&h, &env("off", "on", "off"), NOW);
    assert_eq!(
        (r["decided"][0]["actionable"].as_bool(), r["decided"][0]["acted"].clone()),
        (Some(true), Value::Null),
        "0.87 clears the gate but not Loop's 0.9 floor"
    );
    assert!(stray(&h)["active"][0]["jev"].is_null());
    crate::discard::harmless(std::fs::remove_file(h.join(".anti-hall/devswarm/jev-sweep-state.json")));
    model_says(r#"{"answer":true,"confidence":0.93,"evidence_ref":"repeats.1"}"#, Arc::new(Mutex::new(Vec::new())));
    let r = sweep(&h, &env("off", "on", "off"), NOW);
    *TEST_MODEL.lock().unwrap() = None;
    assert_eq!(r["decided"][0]["acted"], "annotated");
    assert_eq!(stray(&h)["active"][0]["jev"], json!([{"integration": "devswarmLoop", "verdict": "looping", "confidence": 0.93, "supports": true}]));
    assert_eq!(stray(&h)["active"].as_array().unwrap().len(), 1, "no advisory warning when a warning exists");
    // agree is Node's: a looping verdict disagrees with Loop's baseline (not looping)
    assert_eq!(sup_log(&h).iter().find(|e| e["type"] == "jev").unwrap()["agree"], false);
}

#[test]
fn a_looping_answer_with_no_warning_to_join_adds_its_own_advisory_warning_counted_against_the_cap() {
    let _g = MODEL_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let calm = |max: &str| {
        Env::from_pairs([
            ("ANTIHALL_JEV", "1"),
            ("CLAUDE_PLUGIN_OPTION_JEV_INTEGRATION_DEVSWARM_LOOP", "on"),
            ("ANTIHALL_DEVSWARM_STEP_STALL_MIN", "120"),
            ("ANTIHALL_DEVSWARM_STRAY_WARN_MAX", max),
        ])
    };
    let h = home("act-loop-adv");
    loop_fixture(&h, 300);
    model_says(r#"{"answer":true,"confidence":0.95,"evidence_ref":"repeats.1"}"#, Arc::new(Mutex::new(Vec::new())));
    let r = sweep(&h, &calm("2"), NOW);
    *TEST_MODEL.lock().unwrap() = None;
    assert_eq!(r["decided"][0]["acted"], "advisory_loop", "{r}");
    let st = stray(&h);
    let e = &st["active"][0];
    assert_eq!((e["signal"].as_str(), e["step"].as_i64(), e["reason"].as_str()), (Some("loop"), Some(2), Some("Jev thinks it is looping on the step (5h)")));
    assert_eq!(e["key"], format!("loop:2:{}", NOW - 300 * MIN));
    assert_eq!(e["jev"][0]["verdict"], "looping");
    assert_eq!((st["perStep"]["loop:2"].as_i64(), st["warned"][e["key"].as_str().unwrap()]["signal"].as_str()), (Some(1), Some("loop")));
    if let Some(line) = node_line(&st["active"], &h) {
        assert!(line.contains("step 2 Jev thinks it is looping on the step (5h) (Jev: looping 0.95)"), "{line}");
    }
    let warns: Vec<Value> = sup_log(&h).into_iter().filter(|e| e["type"] == "warn").collect();
    assert_eq!((warns.len(), warns[0]["signal"].as_str(), warns[0]["repeat"].as_bool()), (1, Some("loop"), Some(false)));
    // a rewrite by the supervisor drops the advisory entry (it has no such signal): the sweep restores it without a second count
    let mut dropped = st.clone();
    dropped["active"] = json!([]);
    put(stray_file(&h), &dropped.to_string());
    sweep(&h, &calm("2"), NOW + MIN);
    let back = stray(&h);
    assert_eq!((back["active"].as_array().unwrap().len(), back["perStep"]["loop:2"].as_i64()), (1, Some(1)));
    assert_eq!(sup_log(&h).iter().filter(|e| e["type"] == "warn").count(), 1);
    // strayWarnMax 0 turns warnings off: nothing is added
    let off = home("act-loop-cap0");
    loop_fixture(&off, 300);
    model_says(r#"{"answer":true,"confidence":0.95,"evidence_ref":"repeats.1"}"#, Arc::new(Mutex::new(Vec::new())));
    sweep(&off, &calm("0"), NOW);
    *TEST_MODEL.lock().unwrap() = None;
    assert!(!stray_file(&off).exists());
}

#[test]
fn a_step_map_answer_writes_the_inferred_step_into_the_plan_once_and_leaves_the_rest_of_the_plan_alone() {
    let h = home("act-stepmap");
    let mut p = plan(10);
    p["steps"][0]["ts"] = json!(NOW - 20 * MIN);
    p["steps"][0]["status"] = json!("todo");
    p["steps"][1]["status"] = json!("todo");
    p["summaries"] = json!([{"ts": NOW - 20 * MIN + 1000, "text": "parser done", "stepped": true}, {"ts": NOW - 5 * MIN, "text": "finished the wire the cache work", "stepped": false}]);
    fixture(&h, p.clone(), &[]);
    let r = sweep(&h, &env("off", "off", "on"), NOW);
    assert_eq!(r["decided"][0]["acted"], "inferred_step");
    let after: Value = serde_json::from_str(&std::fs::read_to_string(h.join(".anti-hall/devswarm/plans/kid.json")).unwrap()).unwrap();
    let mut want = p;
    want["inferred_step"] = json!(2);
    assert_eq!(after, want, "only inferred_step was added");
    let ev: Vec<Value> = sup_log(&h).into_iter().filter(|e| e["type"] == "jev").collect();
    assert_eq!(
        (ev.len(), ev[0]["integration"].as_str(), ev[0]["agree"].as_bool()),
        (1, Some("devswarmStepMap"), Some(false)),
        "Node's agree: the plan's current step is the first open one, 1, not 2"
    );
    // the same step again changes nothing (no rewrite, no second event)
    crate::discard::harmless(std::fs::remove_file(h.join(".anti-hall/devswarm/jev-sweep-state.json")));
    let r = sweep(&h, &env("off", "off", "on"), NOW + MIN);
    assert_eq!(r["decided"][0]["acted"], Value::Null);
    assert_eq!(sup_log(&h).len(), 1);
    // the plan label Node shows
    let lib = Path::new(env!("CARGO_MANIFEST_DIR")).join("../plugins/anti-hall/companion/lib/devswarm-plan.js");
    if let Ok(o) = Command::new("node")
        .args(["-e", "const p=require(process.argv[1]);console.log(p.finishLabel(JSON.parse(process.argv[2]),Date.now()))"])
        .arg(&lib)
        .arg({
            let mut q = after.clone();
            q.as_object_mut().unwrap().remove("step_ts");
            q.to_string()
        })
        .env("HOME", &h)
        .output()
        && o.status.success()
    {
        assert!(String::from_utf8_lossy(&o.stdout).contains("~#2"));
    }
}

#[test]
fn hold_stall_and_warning_cap_read_settings_json_through_the_settings_layer() {
    let plain = |w: &str| Env::from_pairs([("ANTIHALL_JEV", "1"), ("CLAUDE_PLUGIN_OPTION_JEV_INTEGRATION_DEVSWARM_WAIT_KIND", w)]);
    let h = home("settings-held");
    fixture(&h, plan(40), &six_tools(NOW - 45 * MIN));
    put(h.join(".anti-hall/settings.json"), r#"{"devswarm":{"heldPartitions":"other, kid"}}"#);
    assert_eq!(sweep(&h, &plain("on"), NOW)["decided"][0]["rule"], "child_on_hold");
    let h2 = home("settings-stall");
    fixture(&h2, plan(40), &six_tools(NOW - 45 * MIN));
    put(h2.join(".anti-hall/settings.json"), r#"{"devswarm":{"stepStallMin":90}}"#);
    assert_eq!(sweep(&h2, &plain("on"), NOW)["children"], 0, "40 quiet minutes is under the 90 minute window set in settings.json");
    // the environment still outranks the file, and a value under the schema minimum is raised to it
    let h3 = home("settings-env");
    fixture(&h3, plan(40), &six_tools(NOW - 45 * MIN));
    put(h3.join(".anti-hall/settings.json"), r#"{"devswarm":{"stepStallMin":90}}"#);
    let e =
        Env::from_pairs([("ANTIHALL_JEV", "1"), ("CLAUDE_PLUGIN_OPTION_JEV_INTEGRATION_DEVSWARM_WAIT_KIND", "on"), ("ANTIHALL_DEVSWARM_STEP_STALL_MIN", "10")]);
    assert_eq!(sweep(&h3, &e, NOW)["children"], 1);
    let h4 = home("settings-floor");
    fixture(&h4, plan(4), &six_tools(NOW - 45 * MIN));
    put(h4.join(".anti-hall/settings.json"), r#"{"devswarm":{"stepStallMin":1}}"#);
    assert_eq!(sweep(&h4, &plain("on"), NOW)["children"], 0, "1 minute is raised to the schema minimum of 5, and 4 quiet minutes is under it");
}

#[test]
fn the_same_error_again_and_again_on_a_step_is_a_loop_fact_and_a_loop_candidate() {
    let h = home("loop-errors");
    let start = NOW - 100 * MIN;
    let err = |t: i64, text: &str| {
        json!({"type": "user", "timestamp": iso_ms(t as u64), "message": {"content": [{"type": "tool_result", "is_error": true, "content": text}]}}).to_string()
    };
    let mut t: Vec<String> = (0..10).map(|i| tool(NOW - 50 * MIN + i * MIN, &format!("cargo build --step {i}"))).collect();
    t.extend((0..3).map(|i| err(NOW - 40 * MIN + i * MIN, "error[E0432]: unresolved import `foo`")));
    let mut p = plan(80);
    p["steps"][1]["started_at"] = json!(start);
    fixture(&h, p.clone(), &t);
    let mut c = Child {
        id: "kid".into(),
        key: "kid".into(),
        plan: p,
        desc: json!({"worktreePath": "/nonexistent/wt/kid", "sessionId": "sess-1"}),
        now: NOW,
        base: h.join(".anti-hall"),
        home: h.clone(),
        events: Some(parse_events(t.iter().map(String::as_str))),
        held: Vec::new(),
        rt: None,
    };
    let req = looping(&mut c);
    assert_eq!(req["facts"]["repeat_error_max"], 3.0);
    assert!(req["sections"]["repeats"].as_array().unwrap().iter().any(|l| l.as_str().unwrap().contains("error[e0432]: unresolved import `foo`\" x3")), "{req}");
    // with git known and no commit on the step, the repeated error alone makes it a candidate for the model; without it, it is no candidate
    let _g = MODEL_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let mut with = req.clone();
    with["facts"]["git_known"] = json!(1.0);
    with["facts"]["minutes_since_progress"] = json!(90.0);
    let seen = Arc::new(Mutex::new(Vec::new()));
    model_says(r#"{"answer":true,"confidence":0.9,"evidence_ref":"repeats.1"}"#, seen.clone());
    let asked = evidence::evaluate(&h, &env("off", "on", "off"), &with);
    assert_eq!((asked.phase.as_str(), asked.label.as_deref()), ("asked", Some("looping")));
    let mut without = with.clone();
    without["facts"]["repeat_error_max"] = json!(0.0);
    let no = evidence::evaluate(&h, &env("off", "on", "off"), &without);
    *TEST_MODEL.lock().unwrap() = None;
    assert_eq!((no.phase.as_str(), no.reason.as_deref()), ("rule", Some("no-candidate")));
}

fn rt_snap(finished: bool, paused: bool, ci: Option<crate::devswarm_rt::state::Ci>) -> crate::devswarm_rt::Snapshot {
    use crate::devswarm_rt::state::{Activity, Field, Lifecycle, Paused, PrState, PrView, Src, Workspace};
    fn f<T>(v: T) -> Field<T> {
        Field { value: v, source: Src::AppDb, observed_ms: NOW, sig: String::new() }
    }
    let w = Workspace {
        id: "kid".into(),
        label: None,
        worktree: Some("/nonexistent/wt/kid".into()),
        branch: None,
        repo: None,
        lifecycle: f(if finished { Lifecycle::Archived } else { Lifecycle::Active }),
        paused: f(if paused { Paused::Yes("panel".into()) } else { Paused::No }),
        activity: f(Activity::Working),
        unread: f(None),
        plan_step: f(None),
        last_activity_ms: f(None),
        pr: f(ci.map(|c| PrView { number: Some(12), state: PrState::Open, checks: c })),
    };
    crate::devswarm_rt::Snapshot { generation: 1, at_ms: NOW, seeded: true, app_readable: true, workspaces: [("kid".to_string(), w)].into_iter().collect() }
}

#[test]
fn the_realtime_state_answers_archived_paused_and_ci_without_the_sweep_deriving_them_again() {
    use crate::devswarm_rt::state::Ci;
    let run = |tag: &str, snap: crate::devswarm_rt::Snapshot| {
        let h = home(tag);
        fixture(&h, plan(40), &six_tools(NOW - 45 * MIN));
        mesh_store(&h, &[("kid", NOW - 90 * MIN, "parent", false)]);
        let r = sweep_rt(&h, &env("on", "off", "off"), NOW, None, Some(&snap));
        (r["decided"][0]["rule"].clone(), r["decided"][0]["label"].clone())
    };
    assert_eq!(run("rt-archived", rt_snap(true, false, None)).0, "child_archived");
    assert_eq!(run("rt-paused", rt_snap(false, true, None)), (json!("workspace_paused"), json!("waiting")));
    assert_eq!(run("rt-ci", rt_snap(false, false, Some(Ci::Running))).0, "ci_running");
    // a finished CI run is a fact too, and decides nothing: the model is the one asked
    let _g = MODEL_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    model_says(r#"{"answer":true,"confidence":0.9,"evidence_ref":"tool_calls.1"}"#, Arc::new(Mutex::new(Vec::new())));
    let (rule, label) = run("rt-ci-pass", rt_snap(false, false, Some(Ci::Passing)));
    *TEST_MODEL.lock().unwrap() = None;
    assert_eq!((rule, label), (Value::Null, json!("stuck")));
}
