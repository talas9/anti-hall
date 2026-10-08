//! Unit tests of the task-tracker check. The comparison with the real Node hook, on seeded homes, is `tests/task_tracker_parity.rs`.
use super::*;
use serde_json::json;

fn home(tag: &str) -> PathBuf {
    static N: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
    let h = std::env::temp_dir().join(format!("ah-tt-{tag}-{}-{}", std::process::id(), N.fetch_add(1, std::sync::atomic::Ordering::Relaxed)));
    crate::discard::harmless(std::fs::remove_dir_all(&h));
    std::fs::create_dir_all(&h).unwrap();
    h.canonicalize().unwrap()
}

fn env(h: &Path, extra: &[(&str, &str)]) -> RequestEnv {
    let mut pairs: Vec<(String, String)> = vec![("HOME".into(), h.to_string_lossy().into())];
    pairs.extend(extra.iter().map(|(k, v)| (k.to_string(), v.to_string())));
    RequestEnv::from_pairs(pairs)
}

fn prompt(session: &str) -> Value {
    json!({"hook_event_name": "UserPromptSubmit", "session_id": session, "prompt": "do the thing", "cwd": "/tmp/proj"})
}

fn text_of(v: &Verdict) -> String {
    match v {
        Verdict::Advisory(line) => serde_json::from_str::<Value>(line).unwrap()["hookSpecificOutput"]["additionalContext"].as_str().unwrap().to_string(),
        other => panic!("expected an advisory, got {other:?}"),
    }
}

/// A transcript line pair that creates task `n` with `subject`, then sets its status.
fn task(n: u32, subject: &str, status: &str, extra: Value) -> Vec<String> {
    let mut input = json!({"subject": subject});
    for (k, v) in extra.as_object().cloned().unwrap_or_default() {
        input[k] = v;
    }
    vec![
        json!({"type":"assistant","timestamp":"2026-10-06T08:00:00.000Z","message":{"id":format!("m{n}"),"role":"assistant","content":[{"type":"tool_use","id":format!("c{n}"),"name":"TaskCreate","input":input}]}}).to_string(),
        json!({"type":"user","timestamp":"2026-10-06T08:00:01.000Z","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":format!("c{n}"),"content":format!("Task #{n} created successfully: {subject}")}]}}).to_string(),
        json!({"type":"assistant","timestamp":"2026-10-06T08:00:02.000Z","message":{"id":format!("u{n}"),"role":"assistant","content":[{"type":"tool_use","id":format!("t{n}"),"name":"TaskUpdate","input":{"taskId":n.to_string(),"status":status}}]}}).to_string(),
        json!({"type":"user","timestamp":"2026-10-06T08:00:03.000Z","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":format!("t{n}"),"content":format!("Updated task #{n}")}]}}).to_string(),
    ]
}

fn transcript(h: &Path, lines: &[String]) -> String {
    let p = h.join("t.jsonl");
    std::fs::write(&p, lines.join("\n") + "\n").unwrap();
    p.to_string_lossy().into_owned()
}

#[test]
fn the_full_directive_comes_once_then_the_short_reminder_then_silence() {
    let h = home("cycle");
    let e = env(&h, &[]);
    let first = decide(&prompt("s1"), &e);
    let full = text_of(&first);
    assert!(full.contains("capture EVERY user request as a task (TaskCreate)"), "{full}");
    assert!(!full.contains("keep the MAIN thread non-blocking"), "the compact level drops that clause: {full}");
    assert!(h.join(".anti-hall/task-tracker-s1.json").exists());
    // the same burst: the reminder that follows the directive is the directive's lookalike and is collapsed
    assert_eq!(decide(&prompt("s1"), &e), Verdict::Allow);
    // a later turn of a fresh dedupe store gets the short reminder, then the keepalive rations it
    std::fs::remove_dir_all(h.join(".anti-hall/emit-dedupe")).unwrap();
    let second = text_of(&decide(&prompt("s1"), &e));
    assert!(second.contains("capture every request as a priority-sorted task"), "{second}");
    assert_eq!(decide(&prompt("s1"), &e), Verdict::Allow, "the unchanged short reminder is rationed");
}

#[test]
fn the_full_protocol_level_keeps_the_non_blocking_clause_and_codex_names_a_plan_list() {
    let h = home("level");
    let full = text_of(&decide(&prompt("s1"), &env(&h, &[("ANTIHALL_PROTOCOL_LEVEL", "full")])));
    assert!(full.contains("keep the MAIN thread non-blocking"));
    let h = home("codex");
    let mut p = prompt("s1");
    p["turn_id"] = json!("t1");
    let codex = text_of(&decide(&p, &env(&h, &[])));
    assert!(codex.contains("as an item in your task/plan list ") && !codex.contains("TaskCreate"), "{codex}");
}

#[test]
fn the_window_expiry_the_growth_and_a_corrupt_stamp_decide_the_directive() {
    let h = home("window");
    let e = env(&h, &[]);
    let t = transcript(&h, &["{}".to_string()]);
    let mut p = prompt("s1");
    p["transcript_path"] = json!(t);
    text_of(&decide(&p, &e));
    let file = h.join(".anti-hall/task-tracker-s1.json");
    let now = emit_dedupe::now_ms();
    // within the window and no growth: the short reminder (a fresh dedupe store, so the burst collapse does not apply)
    let reset = || crate::discard::harmless(std::fs::remove_dir_all(h.join(".anti-hall/emit-dedupe")));
    reset();
    assert!(text_of(&decide(&p, &e)).contains("priority-sorted"));
    // a stamp from the future beyond the tolerance is corrupt: the window counts as expired
    reset();
    std::fs::write(&file, format!("{{\"lastFull\":{},\"lastFullSize\":3}}", now + 3_600_000.0)).unwrap();
    assert!(text_of(&decide(&p, &e)).contains("capture EVERY"));
    // growth of the transcript past the threshold since the recorded size
    reset();
    std::fs::write(&file, format!("{{\"lastFull\":{},\"lastFullSize\":{}}}", now - 1000.0, 0)).unwrap();
    std::fs::write(&t, "x".repeat(250_000)).unwrap();
    assert!(text_of(&decide(&p, &e)).contains("capture EVERY"), "250000 bytes past a zero baseline exceed 240 KiB");
    // an unknown baseline never counts as growth
    reset();
    std::fs::write(&file, format!("{{\"lastFull\":{}}}", now - 1000.0)).unwrap();
    let again = decide(&p, &e);
    assert!(!text_of(&again).contains("capture EVERY"));
    // a stamp older than the window
    reset();
    std::fs::write(&file, format!("{{\"lastFull\":{}}}", now - 7.0 * 3_600_000.0)).unwrap();
    assert!(text_of(&decide(&p, &e)).contains("capture EVERY"));
    // junk is no state
    reset();
    std::fs::write(&file, "not json").unwrap();
    assert!(text_of(&decide(&p, &e)).contains("capture EVERY"));
}

#[test]
fn open_tasks_add_one_line_and_blocked_ones_are_counted_apart() {
    let h = home("open");
    let mut lines = task(1, "Write the parser", "in_progress", json!({}));
    lines.extend(task(2, "OWNER: pick a name", "pending", json!({})));
    lines.extend(task(3, "Wait for review", "pending", json!({"metadata": {"blockedOn": "external"}})));
    lines.extend(task(4, "Done already", "completed", json!({})));
    let mut p = prompt("s1");
    p["transcript_path"] = json!(transcript(&h, &lines));
    let t = text_of(&decide(&p, &env(&h, &[])));
    assert!(t.ends_with("open tasks: 1 (+2 blocked: owner/external) (oldest in_progress subject: \"Write the parser\") — update or close them."), "{t}");
}

#[test]
fn a_session_with_nothing_open_says_nothing_extra_and_a_long_subject_is_cut() {
    let h = home("none");
    let mut p = prompt("s1");
    p["transcript_path"] = json!(transcript(&h, &task(1, "done", "completed", json!({}))));
    assert!(!text_of(&decide(&p, &env(&h, &[]))).contains("open tasks"));
    let h = home("long");
    let long = format!("{}  {}\t{}", "a".repeat(40), "b".repeat(30), "c");
    let mut p = prompt("s1");
    p["transcript_path"] = json!(transcript(&h, &task(1, &long, "in_progress", json!({}))));
    let t = text_of(&decide(&p, &env(&h, &[])));
    assert!(t.contains(&format!("\"{} {}…\"", "a".repeat(40), "b".repeat(9))), "{t}");
}

#[test]
fn what_the_engine_cannot_reproduce_is_left_to_node_before_anything_is_written() {
    let h = home("defer");
    let mut lines = task(1, "Pending and free", "pending", json!({}));
    lines.extend(task(2, "Second", "in_progress", json!({})));
    let mut p = prompt("s1");
    p["transcript_path"] = json!(transcript(&h, &lines));
    assert_eq!(decide(&p, &env(&h, &[])), Verdict::Defer, "a task the DISPATCH NOW line would name");
    assert!(!h.join(".anti-hall").exists(), "a deferral leaves no trace, not even the Jev row");
    // the demand line switched off: the engine answers
    assert!(matches!(decide(&p, &env(&h, &[("ANTIHALL_DISPATCH_DEMAND", "0")])), Verdict::Advisory(_)));
    // a session that could be a Primary
    let h = home("primary");
    assert_eq!(decide(&prompt("s1"), &env(&h, &[("DEVSWARM_REPO_ID", "r")])), Verdict::Defer);
    assert!(!h.join(".anti-hall").exists());
    // a recommendation whose outcome is still to be labelled
    let h = home("tier");
    std::fs::create_dir_all(h.join(".anti-hall")).unwrap();
    std::fs::write(h.join(".anti-hall/dispatch-tier-state.json"), r#"{"requested":{},"sessions":{"s1":{"t":1,"tasks":{"1":{"tier":"subagent","h":"x"}}}}}"#)
        .unwrap();
    let mut p = prompt("s1");
    p["transcript_path"] = json!(transcript(&h, &task(1, "x", "completed", json!({}))));
    assert_eq!(decide(&p, &env(&h, &[])), Verdict::Defer);
    assert!(!h.join(".anti-hall/task-tracker-s1.json").exists());
    // no session and no working directory: Node uses its own
    let h = home("nosession");
    assert_eq!(decide(&json!({"prompt": "x"}), &env(&h, &[])), Verdict::Defer);
    assert!(matches!(decide(&json!({"prompt": "x", "cwd": "/tmp/p"}), &env(&h, &[])), Verdict::Advisory(_)));
    assert!(h.join(".anti-hall").read_dir().unwrap().flatten().any(|e| e.file_name().to_string_lossy().starts_with("task-tracker-")));
}

#[test]
fn off_skipped_judge_child_and_a_null_payload_are_silent() {
    let h = home("quiet");
    for (extra, p) in [
        (vec![("ANTIHALL_JUDGE_CHILD", "1")], prompt("s1")),
        (vec![("CLAUDE_PLUGIN_OPTION_CONTEXT_TASK_TRACKER", "false")], prompt("s1")),
        (vec![], Value::Null),
    ] {
        assert_eq!(decide(&p, &env(&h, &extra)), Verdict::Allow);
    }
    std::fs::create_dir_all(h.join(".anti-hall")).unwrap();
    std::fs::write(h.join(".anti-hall/skip.json"), r#"{"task-tracker": 4102444800000}"#).unwrap();
    assert_eq!(decide(&prompt("s1"), &env(&h, &[])), Verdict::Allow);
    assert!(!h.join(".anti-hall/task-tracker-s1.json").exists());
    assert_eq!(decide(&json!([1]), &env(&h, &[])), Verdict::Defer);
}

#[test]
fn a_pending_demand_is_scored_and_the_file_rewritten_like_node_does() {
    let h = home("metrics");
    std::fs::create_dir_all(h.join(".anti-hall")).unwrap();
    let now = emit_dedupe::now_ms();
    let spawn_at = crate::checks::taskkit::time::iso((now - 1000.0) as i64);
    let t = transcript(
        &h,
        &[json!({"type":"assistant","timestamp":spawn_at,"message":{"role":"assistant","content":[{"type":"tool_use","id":"a","name":"Agent","input":{}}]}})
            .to_string()],
    );
    let file = h.join(".anti-hall/dispatch-demand-metrics.json");
    std::fs::write(
        &file,
        format!(
            r#"{{"demandsShown":4,"tier":{{"x":1}},"pending":{{"s1":{{"ts":{},"n":2}},"gone":{{"ts":{}}},"bad":"x"}}}}"#,
            now - 5000.0,
            now - 2.0 * 86_400_000.0
        ),
    )
    .unwrap();
    let mut p = prompt("s1");
    p["transcript_path"] = json!(t);
    decide(&p, &env(&h, &[]));
    let m: Value = serde_json::from_str(&std::fs::read_to_string(&file).unwrap()).unwrap();
    assert_eq!(m["demandsFollowed"], 1, "a spawn since the demand: followed");
    assert_eq!(m["demandsIgnored"], 0);
    assert_eq!(m["pending"], json!({}));
    assert_eq!(m["tier"], json!({"x": 1}), "other keys are kept");
    assert_eq!(m["demandsShown"], 4);
}
