use super::*;
use crate::jev::assist::iso_ms;
use crate::jev::cascade::{MODEL_LOCK, TEST_MODEL};
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
    json!({"type": "assistant", "timestamp": iso_ms(t as u64), "message": {"content": [{"type": "tool_use", "name": "Bash", "input": {"command": cmd}}]}}).to_string()
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
        json!({"type": "user", "timestamp": iso_ms(NOW as u64 + 2000), "message": {"content": [{"type": "tool_result", "is_error": true, "content": "boom"}]}}).to_string(),
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
    assert_eq!((d["integration"].as_str(), d["phase"].as_str(), d["label"].as_str(), d["rule"].as_str()), (Some("devswarmWaitKind"), Some("rule"), Some("waiting"), Some("unanswered_question_to_parent")));
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
    assert_eq!((d["phase"].as_str(), d["source"].as_str(), d["label"].as_str(), d["actionable"].as_bool()), (Some("asked"), Some("haiku"), Some("stuck"), Some(true)));
    let input = seen.lock().unwrap()[0].clone();
    assert!(input.contains("No step progress for 40m") && input.contains("cargo test 1") && input.contains("waiting for the next step") && input.contains("mesh_coverage = 1"), "{input}");
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
    assert_eq!((d["integration"].as_str(), d["phase"].as_str(), d["label"].as_str()), (Some("devswarmLoop"), Some("asked"), Some("looping")), "{d}\n{:?}", seen.lock().unwrap());
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
    assert_eq!((d["integration"].as_str(), d["reason"].as_str()), (Some("devswarmStepMap"), Some("insufficient")), "needs one earlier summary with a reported step");
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
    let held = Env::from_pairs([("ANTIHALL_JEV", "1"), ("CLAUDE_PLUGIN_OPTION_JEV_INTEGRATION_DEVSWARM_WAIT_KIND", "on"), ("ANTIHALL_DEVSWARM_HELD_PARTITIONS", "other, kid")]);
    let r = sweep(&h, &held, NOW);
    assert_eq!(r["decided"][0]["rule"], "child_on_hold");
    let calm = Env::from_pairs([("ANTIHALL_JEV", "1"), ("CLAUDE_PLUGIN_OPTION_JEV_INTEGRATION_DEVSWARM_WAIT_KIND", "on"), ("ANTIHALL_DEVSWARM_STEP_STALL_MIN", "90")]);
    let h2 = home("env2");
    fixture(&h2, plan(40), &six_tools(NOW - 45 * MIN));
    assert_eq!(sweep(&h2, &calm, NOW)["children"], 0, "40 quiet minutes is under a 90 minute stall window");
}
