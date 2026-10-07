use super::*;
use serde_json::json;

fn env(home: &str, extra: &[(&str, &str)]) -> RequestEnv {
    let mut pairs: Vec<(String, String)> = vec![("HOME".into(), home.into())];
    pairs.extend(extra.iter().map(|(k, v)| (k.to_string(), v.to_string())));
    RequestEnv::from_pairs(pairs)
}

#[test]
fn a_tool_that_is_not_a_task_tool_does_nothing() {
    for p in [json!({"tool_name": "Bash"}), json!({}), json!(null), json!({"tool_name": 5})] {
        assert_eq!(decide(&p, &env("/nonexistent-home", &[])), Verdict::Allow, "{p}");
    }
}

const ON: [(&str, &str); 2] = [("ANTIHALL_JEV", "1"), ("CLAUDE_PLUGIN_OPTION_JEV_VERCEL_API_KEY", "vk")];

fn home(tag: &str) -> std::path::PathBuf {
    let h = std::env::temp_dir().join(format!("ah-dtier-{tag}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&h);
    std::fs::create_dir_all(&h).unwrap();
    h
}

fn state_of(h: &std::path::Path) -> Value {
    serde_json::from_str(&std::fs::read_to_string(h.join(".anti-hall/dispatch-tier-state.json")).unwrap()).unwrap()
}

fn create(subject: &str) -> Value {
    json!({"tool_name": "TaskCreate", "tool_input": {"subject": subject}, "session_id": "s1", "cwd": "/tmp"})
}

#[test]
fn jev_off_reads_and_writes_nothing() {
    let h = home("off");
    let hs = h.to_string_lossy().to_string();
    assert_eq!(decide(&create("x"), &env(&hs, &[])), Verdict::Allow);
    assert_eq!(decide(&create("x"), &env(&hs, &[("ANTIHALL_JEV", "1"), ("ANTIHALL_JEV_DISPATCH_TIER", "0")])), Verdict::Allow);
    assert!(!h.join(".anti-hall").exists());
    assert_eq!(decide(&create("x"), &RequestEnv::default()), Verdict::Defer, "no home: Node resolves it itself");
}

#[test]
fn a_new_task_text_is_asked_once_and_leaves_one_request_marker() {
    use crate::jev::testkit::{install_scripted, log_rows};
    let h = home("ask");
    let hs = h.to_string_lossy().to_string();
    let (jev, fake) = install_scripted(&h, &ON, vec![]);
    let e = env(&hs, &ON);
    assert_eq!(decide(&create("Fix the parser"), &e), Verdict::Allow);
    assert!(jev.drain(std::time::Duration::from_secs(5)));
    assert_eq!(fake.seen.lock().unwrap().len(), 1);
    let body = fake.seen.lock().unwrap()[0].2.clone().unwrap();
    assert!(body.contains(r#""state":"Fix the parser""#) && body.contains(r#""type":"choice""#), "{body}");
    let hash = crate::jev::assist::content_hash(&["dispatchTier", "v1", "Fix the parser"]);
    let st = state_of(&h);
    assert!(st["requested"][&hash].as_f64().is_some_and(|t| t > 1.0e12), "{st}");
    assert_eq!(st["sessions"], json!({}));
    let rows = log_rows(&h);
    assert_eq!((rows.len(), rows[0]["id"].clone(), rows[0]["trust"].clone()), (1, json!("dispatchTier"), json!("advisory")));
    // the same text again, inside the window: no second ask
    assert_eq!(decide(&create("Fix the parser"), &e), Verdict::Allow);
    assert!(jev.drain(std::time::Duration::from_secs(5)));
    assert_eq!(fake.seen.lock().unwrap().len(), 1);
}

#[test]
fn a_text_with_a_cached_verdict_is_not_asked_and_writes_no_marker() {
    use crate::jev::testkit::install_scripted;
    let h = home("cached");
    let hs = h.to_string_lossy().to_string();
    let (jev, fake) = install_scripted(&h, &ON, vec![]);
    let hash = crate::jev::assist::content_hash(&["dispatchTier", "v1", "Known task"]);
    std::fs::create_dir_all(h.join(".anti-hall/cache")).unwrap();
    std::fs::write(h.join(".anti-hall/cache/jev-assist.json"), format!(r#"{{"{hash}":{{"answer":"subagent","confidence":0.9,"_seq":1}}}}"#)).unwrap();
    assert_eq!(decide(&create("Known task"), &env(&hs, &ON)), Verdict::Allow);
    assert!(jev.drain(std::time::Duration::from_secs(5)));
    assert!(fake.seen.lock().unwrap().is_empty());
    assert!(!h.join(".anti-hall/dispatch-tier-state.json").exists());
}

#[test]
fn a_task_waiting_on_the_owner_is_never_classified() {
    use crate::jev::testkit::install_scripted;
    let h = home("owner");
    let hs = h.to_string_lossy().to_string();
    let (jev, fake) = install_scripted(&h, &ON, vec![]);
    let e = env(&hs, &ON);
    for p in [
        create("OWNER: pick the vendor"),
        create("owner decision needed"),
        json!({"tool_name": "TaskCreate", "tool_input": {"subject": "x", "metadata": {"blockedOn": " Owner "}}}),
        json!({"tool_name": "TaskCreate", "tool_input": {"subject": "y", "blockedOn": "external"}}),
        json!({"tool_name": "TaskCreate", "tool_input": {}}),
    ] {
        assert_eq!(decide(&p, &e), Verdict::Allow, "{p}");
    }
    assert!(jev.drain(std::time::Duration::from_secs(5)));
    assert!(fake.seen.lock().unwrap().is_empty());
    // the switch off: the marker is honoured no more and the subject is asked
    let off = env(&hs, &[("ANTIHALL_JEV", "1"), ("CLAUDE_PLUGIN_OPTION_JEV_VERCEL_API_KEY", "vk"), ("ANTIHALL_TASK_GUARD_OWNER_BLOCKED_MARKER", "0")]);
    assert_eq!(decide(&create("OWNER: pick the vendor"), &off), Verdict::Allow);
    assert!(jev.drain(std::time::Duration::from_secs(5)));
    assert_eq!(fake.seen.lock().unwrap().len(), 1);
}

#[test]
fn an_update_asks_about_the_reconstructed_task_with_its_new_description() {
    use crate::jev::testkit::install_scripted;
    let h = home("update");
    let hs = h.to_string_lossy().to_string();
    let (jev, fake) = install_scripted(&h, &ON, vec![]);
    let tr = h.join("t.jsonl");
    let lines = [
        json!({"type":"assistant","message":{"content":[{"type":"tool_use","id":"tu1","name":"TaskCreate","input":{"subject":"Port the guard","description":"old"}}]}}),
        json!({"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"tu1","content":"Task #1 created successfully: Port the guard"}]}}),
    ];
    std::fs::write(&tr, lines.iter().map(Value::to_string).collect::<Vec<_>>().join("\n") + "\n").unwrap();
    let up = |input: Value| json!({"tool_name":"TaskUpdate","tool_input":input,"transcript_path":tr.to_string_lossy(),"session_id":"s1"});
    let e = env(&hs, &ON);
    assert_eq!(decide(&up(json!({"taskId":"1","status":"completed"})), &e), Verdict::Allow, "no text change: nothing to ask");
    assert_eq!(decide(&up(json!({"taskId":"1","description":"new words"})), &e), Verdict::Allow);
    assert!(jev.drain(std::time::Duration::from_secs(5)));
    let seen = fake.seen.lock().unwrap();
    assert_eq!(seen.len(), 1);
    assert!(seen[0].2.as_deref().unwrap().contains(r#""state":"Port the guard\nnew words""#), "{:?}", seen[0].2);
}

#[test]
fn the_state_file_is_bounded_and_old_markers_go() {
    use crate::jev::testkit::install_scripted;
    let h = home("bound");
    let hs = h.to_string_lossy().to_string();
    let (jev, _fake) = install_scripted(&h, &ON, vec![]);
    let sessions: serde_json::Map<String, Value> = (0..52).map(|i| (format!("s{i}"), json!({"t": 1000 + i, "tasks": {}}))).collect();
    std::fs::create_dir_all(h.join(".anti-hall")).unwrap();
    std::fs::write(
        h.join(".anti-hall/dispatch-tier-state.json"),
        json!({"requested": {"old": 1, "junk": "x"}, "sessions": sessions, "extra": [1]}).to_string(),
    )
    .unwrap();
    assert_eq!(decide(&create("Another task"), &env(&hs, &ON)), Verdict::Allow);
    assert!(jev.drain(std::time::Duration::from_secs(5)));
    let st = state_of(&h);
    assert_eq!(st["sessions"].as_object().unwrap().len(), 50);
    assert!(st["sessions"].get("s0").is_none() && st["sessions"].get("s1").is_none() && st["sessions"].get("s51").is_some());
    assert_eq!(st["requested"].as_object().unwrap().len(), 1, "the old and the non-numeric markers went");
    assert_eq!(st["extra"], json!([1]));
}

#[test]
fn input_only_javascript_reads_or_a_cut_surrogate_is_left_to_node() {
    use crate::jev::testkit::install_scripted;
    let h = home("defer");
    let hs = h.to_string_lossy().to_string();
    let (_jev, fake) = install_scripted(&h, &ON, vec![]);
    let e = env(&hs, &ON);
    std::fs::create_dir_all(h.join(".anti-hall")).unwrap();
    std::fs::write(h.join(".anti-hall/dispatch-tier-state.json"), format!(r#"{{"requested":{{"a":1{}}}}}"#, "0".repeat(400))).unwrap();
    assert_eq!(decide(&create("t"), &e), Verdict::Defer, "a 400-digit number: JavaScript reads Infinity");
    std::fs::remove_file(h.join(".anti-hall/dispatch-tier-state.json")).unwrap();
    let long = format!("{}😀tail", "a".repeat(599));
    assert_eq!(decide(&create(&long), &e), Verdict::Defer, "the 600-unit cut splits the pair");
    let obj = json!({"tool_name": "TaskCreate", "tool_input": {"subject": {"x": 1}}});
    assert_eq!(decide(&obj, &e), Verdict::Defer);
    assert!(fake.seen.lock().unwrap().is_empty());
}
