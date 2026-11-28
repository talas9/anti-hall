//! #857 R5/R6: a repeated unchanged Stop hits the memo; a new transcript row, a task change or a non-quiet answer misses.
use super::*;
use serde_json::json;

fn meta() -> Meta {
    Meta {
        host: "claude".into(),
        event: "Stop".into(),
        tool: None,
        root: None,
        env: Default::default(),
        only: None,
        plan: vec![],
        cfg: String::new(),
        payload_sha1: None,
        deadline_ms: None,
        load_permille: None,
        notice: None,
    }
}

fn quiet_answers() -> Answers {
    vec![("a".into(), Answer::Decided(crate::dispatch::combine::HookResult::quiet("a"), Vec::new()))]
}

fn setup(tag: &str) -> (std::path::PathBuf, Value) {
    let d = crate::testtmp::path(format!("ah-stopmemo-{tag}-{}", std::process::id()));
    crate::discard::harmless(std::fs::remove_dir_all(&d));
    std::fs::create_dir_all(&d).unwrap();
    let t = d.join("t.jsonl");
    std::fs::write(&t, "{\"row\":1}\n").unwrap();
    let p = json!({"session_id": format!("s-857-{tag}"), "cwd": "/", "hook_event_name": "Stop", "stop_hook_active": false, "transcript_path": t});
    (t, p)
}

#[test]
fn a_repeat_with_unchanged_state_hits_and_a_new_transcript_row_misses() {
    let (t, p) = setup("row");
    let m = meta();
    assert!(applies(&m, &p));
    let k = key(&m, &p);
    assert!(recall(&m, &p, k).is_none(), "nothing remembered yet");
    store(&m, &p, k, &quiet_answers());
    assert_eq!(recall(&m, &p, key(&m, &p)), Some(quiet_answers()), "same state: the memo answers");
    let mut f = std::fs::OpenOptions::new().append(true).open(&t).unwrap();
    std::io::Write::write_all(&mut f, b"{\"row\":2}\n").unwrap();
    assert_ne!(key(&m, &p), k, "a new row changes the key");
    assert!(recall(&m, &p, key(&m, &p)).is_none(), "a new row misses");
}

#[test]
fn a_task_change_misses() {
    let (_t, p) = setup("task");
    let home = crate::testtmp::path(format!("ah-stopmemo-home-{}", std::process::id()));
    let dir = home.join(".claude/tasks/s-857-task");
    std::fs::create_dir_all(&dir).unwrap();
    // the stamp reads the variable named by `stopmemo.home_env`; HOME is process-wide, so it is set and restored around the two keys
    let old = std::env::var_os("HOME");
    // SAFETY: test-only env mutation. Only the stamp below reads HOME, on this thread, inside this window; no lock serialises other
    // tests' reads of HOME (the same open gap as the crate's other test-only env mutations).
    unsafe { std::env::set_var("HOME", &home) };
    let m = meta();
    let before = key(&m, &p);
    std::fs::write(dir.join("1.json"), r#"{"id":"1","status":"pending"}"#).unwrap();
    let after = key(&m, &p);
    match old {
        // SAFETY: restores the value set above, under the same single-reader condition.
        Some(o) => unsafe { std::env::set_var("HOME", o) },
        // SAFETY: as above.
        None => unsafe { std::env::remove_var("HOME") },
    }
    assert_ne!(before, after, "a task file appearing changes the key");
}

#[test]
fn a_block_is_never_remembered() {
    let (_t, p) = setup("block");
    let m = meta();
    let k = key(&m, &p);
    store(&m, &p, k, &quiet_answers());
    let blocked = vec![("a".to_string(), Answer::Decided(crate::dispatch::combine::HookResult { id: "a".into(), code: Some(2), out: String::new(), err: "no\n".into() }, Vec::new()))];
    store(&m, &p, k, &blocked);
    assert!(recall(&m, &p, k).is_none(), "a block forgets the entry, so a repeated block runs again");
}

#[test]
fn a_non_stop_event_or_no_session_does_not_apply() {
    let (_t, p) = setup("na");
    let mut m = meta();
    m.event = "PreToolUse".into();
    assert!(!applies(&m, &p));
    assert!(!applies(&meta(), &json!({"hook_event_name": "Stop"})));
}
