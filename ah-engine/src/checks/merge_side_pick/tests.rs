//! Unit tests of the merge-side-pick check. The full Node-vs-engine comparison is `parity/run-merge-side-pick.js`;
//! these pin the behaviours that run without a Node install.
use super::*;
use crate::checks::guardkit::state::MemoryState;
use serde_json::json;
use std::collections::HashMap;

fn settings(home: &str) -> Settings {
    Settings { home: home.to_string(), env: HashMap::new() }
}

fn payload(event: &str, sid: &str, cmd: &str) -> Value {
    json!({"hook_event_name": event, "tool_name": "Bash", "session_id": sid, "tool_input": {"command": cmd}})
}

fn tmp_home(tag: &str) -> String {
    let d = std::env::temp_dir().join(format!("ah-msp-{tag}-{}", std::process::id()));
    crate::discard::harmless(std::fs::create_dir_all(d.join(".anti-hall")));
    d.to_string_lossy().to_string()
}

fn advisory(v: Option<Verdict>) -> Option<String> {
    match v {
        Some(Verdict::Advisory(j)) => Some(j),
        None => None,
        other => panic!("unexpected verdict {other:?}"),
    }
}

#[test]
fn detects_side_pick_and_test_forms() {
    for c in ["git checkout --theirs .", "git merge -Xtheirs origin/main", "git merge -s ours dev", "git -C repo checkout --theirs -- a"] {
        assert!(segments(c).iter().any(|s| seg_pick(s)), "{c}");
    }
    for c in ["git checkout main", "git commit -m \"used git checkout --theirs\"", "echo \"git merge -X ours\"", "git rebase -X patience main"] {
        assert!(!segments(c).iter().any(|s| seg_pick(s)), "{c}");
    }
    for c in ["npm test", "node --test tests/", "go test ./...", "./gradlew test", "npx vitest run", "bundle exec rake test"] {
        assert!(segments(c).iter().any(|s| seg_test(s)), "{c}");
    }
    for c in ["npm install", "echo \"npm test\"", "cat tests.md"] {
        assert!(!segments(c).iter().any(|s| seg_test(s)), "{c}");
    }
}

#[test]
fn push_after_untested_side_pick_advises_once_tests_run_it_stops() {
    let (home, store) = (tmp_home("flow"), MemoryState::new());
    let st = settings(&home);
    assert!(decide(&payload("PostToolUse", "s1", "git checkout --theirs . && git add -A"), &st, &store).is_none());
    let out = advisory(decide(&payload("PreToolUse", "s1", "git push origin dev"), &st, &store)).expect("advisory");
    assert!(
        out.starts_with(
            "{\"hookSpecificOutput\":{\"hookEventName\":\"PreToolUse\",\"additionalContext\":\"\u{26a0}\u{fe0f} anti-hall \u{b7} merge-side-pick: "
        ),
        "{out}"
    );
    assert!(out.contains("\\nWhy: ") && out.contains("\\nDo instead: run the tests first"), "{out}");
    decide(&payload("PostToolUse", "s1", "npm test"), &st, &store);
    assert!(decide(&payload("PreToolUse", "s1", "git push"), &st, &store).is_none());
    decide(&payload("PostToolUse", "s1", "git checkout --ours ."), &st, &store);
    assert!(decide(&payload("PreToolUse", "s1", "git push"), &st, &store).is_some(), "a later side-pick re-arms");
    assert!(decide(&payload("PreToolUse", "other", "git push"), &st, &store).is_none(), "state is per session");
}

#[test]
fn one_command_with_pick_then_push_advises_and_with_a_test_between_does_not() {
    let (home, store) = (tmp_home("one"), MemoryState::new());
    let st = settings(&home);
    assert!(decide(&payload("PreToolUse", "s", "git checkout --theirs . && git commit -am x && git push"), &st, &store).is_some());
    assert!(decide(&payload("PreToolUse", "s", "git checkout --theirs . && npm test && git push"), &st, &store).is_none());
    assert!(decide(&payload("PreToolUse", "s", "git push --dry-run"), &st, &store).is_none());
}

#[test]
fn off_switch_and_skip_silence_it_and_record_nothing() {
    let (home, store) = (tmp_home("off"), MemoryState::new());
    std::fs::write(format!("{home}/.anti-hall/settings.json"), r#"{"guards":{"mergeSidePickAdvisory":false}}"#).unwrap();
    let st = settings(&home);
    decide(&payload("PostToolUse", "s", "git checkout --theirs ."), &st, &store);
    assert!(store.get("merge-side-pick", "s").is_none());
    assert!(decide(&payload("PreToolUse", "s", "git push"), &st, &store).is_none());
}

#[test]
fn a_cut_inside_a_surrogate_pair_defers() {
    let (home, store) = (tmp_home("sur"), MemoryState::new());
    let st = settings(&home);
    let cmd = format!("git checkout --ours a{}", "\u{1F600}".repeat(70));
    assert_eq!(decide(&payload("PostToolUse", "s", &cmd), &st, &store), Some(Verdict::Defer));
}

#[test]
fn payloads_that_are_not_for_this_check_say_nothing() {
    let (home, store) = (tmp_home("shape"), MemoryState::new());
    let st = settings(&home);
    for p in [
        json!({"hook_event_name": "PreToolUse", "tool_name": "Edit", "session_id": "s", "tool_input": {"command": "git push"}}),
        json!({"hook_event_name": "PreToolUse", "tool_name": "Bash", "tool_input": {"command": "git push"}}),
        json!({"hook_event_name": "PreToolUse", "tool_name": "Bash", "session_id": "  ", "tool_input": {"command": "git push"}}),
        json!({"hook_event_name": "PreToolUse", "tool_name": "Bash", "session_id": "s", "tool_input": {"command": 5}}),
    ] {
        assert!(decide(&p, &st, &store).is_none(), "{p}");
    }
}

#[test]
fn run_without_the_payload_defers_for_bash_and_ignores_other_tools() {
    let ti = json!({"command": "git push"});
    let s = |tool| Subject { event: "PreToolUse", tool, cwd: None, tool_input: &ti, prompt: None };
    assert_eq!(MergeSidePick.run(&s(Some("Bash")), &Value::Null), Some(Verdict::Defer));
    assert!(MergeSidePick.run(&s(Some("Edit")), &Value::Null).is_none());
}

fn file_state(home: &str) -> FileState {
    FileState::new(home).expect("a home directory")
}

#[test]
fn the_record_is_the_node_file_and_survives_a_new_store() {
    let home = tmp_home("file");
    let st = settings(&home);
    decide(&payload("PostToolUse", "sess/1", "git checkout --theirs . && npm test && git merge -X ours x"), &st, &file_state(&home));
    let path = format!("{home}/.anti-hall/merge-side-pick-sess_1.json");
    // byte for byte what `JSON.stringify({seq, pickSeq, testSeq, cmd})` writes
    assert_eq!(std::fs::read_to_string(&path).unwrap(), r#"{"seq":3,"pickSeq":3,"testSeq":2,"cmd":"git merge -X ours x"}"#);
    // a new store (an engine restart) still sees the untested side-pick and advises on the push
    assert!(decide(&payload("PreToolUse", "sess/1", "git push"), &st, &file_state(&home)).is_some());
    decide(&payload("PostToolUse", "sess/1", "npm test"), &st, &file_state(&home));
    assert!(decide(&payload("PreToolUse", "sess/1", "git push"), &st, &file_state(&home)).is_none());
}

#[test]
fn a_record_written_by_node_is_read_and_coerced_like_node_does() {
    let home = tmp_home("coerce");
    let st = settings(&home);
    let d = format!("{home}/.anti-hall");
    // Node: `s.pickSeq | 0` of "3" is 3, `s.testSeq | 0` of "1" is 1, cmd is String(...)
    std::fs::write(format!("{d}/merge-side-pick-a.json"), r#"{"seq":"5","pickSeq":"3","testSeq":"1","cmd":"git checkout --ours x"}"#).unwrap();
    let out = advisory(decide(&payload("PreToolUse", "a", "git push"), &st, &file_state(&home))).expect("advisory");
    assert!(out.contains("git checkout --ours x"), "{out}");
    // a corrupt file is a fresh record
    std::fs::write(format!("{d}/merge-side-pick-b.json"), "{not json").unwrap();
    assert!(decide(&payload("PreToolUse", "b", "git push"), &st, &file_state(&home)).is_none());
    decide(&payload("PostToolUse", "b", "git checkout --theirs ."), &st, &file_state(&home));
    assert_eq!(std::fs::read_to_string(format!("{d}/merge-side-pick-b.json")).unwrap(), r#"{"seq":1,"pickSeq":1,"testSeq":0,"cmd":"git checkout --theirs ."}"#);
    // an int32 wrap, as `4294967297 | 0` is 1
    std::fs::write(format!("{d}/merge-side-pick-c.json"), r#"{"seq":4294967297,"pickSeq":4294967299,"testSeq":0,"cmd":"c"}"#).unwrap();
    decide(&payload("PostToolUse", "c", "npm test"), &st, &file_state(&home));
    assert_eq!(std::fs::read_to_string(format!("{d}/merge-side-pick-c.json")).unwrap(), r#"{"seq":2,"pickSeq":3,"testSeq":2,"cmd":"c"}"#);
}

#[test]
fn recording_prunes_old_files_of_the_family_but_never_its_own() {
    let home = tmp_home("prune");
    let st = settings(&home);
    let d = format!("{home}/.anti-hall");
    let old = format!("{d}/merge-side-pick-old.json");
    let other = format!("{d}/other-family-old.json");
    for f in [&old, &other] {
        std::fs::write(f, "{}").unwrap();
        let t = std::time::SystemTime::now() - std::time::Duration::from_secs(30 * 24 * 3600);
        std::fs::File::options().write(true).open(f).unwrap().set_modified(t).unwrap();
    }
    decide(&payload("PostToolUse", "live", "git checkout --theirs ."), &st, &file_state(&home));
    assert!(!std::path::Path::new(&old).exists(), "an old file of the family is removed");
    assert!(std::path::Path::new(&other).exists(), "another family is never touched");
    assert!(std::path::Path::new(&format!("{d}/merge-side-pick-live.json")).exists());
    assert!(std::path::Path::new(&format!("{d}/.prune-stamp-merge-side-pick.json")).exists());
}

#[test]
fn the_post_pass_follows_the_wired_event_and_no_home_defers() {
    let home = tmp_home("wired");
    let env = crate::reqenv::RequestEnv::from_pairs([("HOME", home.as_str())]);
    let ti = json!({"command": "git checkout --theirs ."});
    let sub = |event| Subject { event, tool: Some("Bash"), cwd: None, tool_input: &ti, prompt: None };
    // a Post entry whose payload lacks the event name still records (what `--post` does in Node)
    let p = json!({"tool_name": "Bash", "session_id": "w", "tool_input": {"command": "git checkout --theirs ."}});
    assert_eq!(
        MergeSidePick.run_env(&sub("PostToolUse"), &p, &Value::Null, &env),
        Some(Verdict::Allow),
        "a silent answer is Allow, never None (None hands the call to Node, which would record it twice)"
    );
    assert!(std::path::Path::new(&format!("{home}/.anti-hall/merge-side-pick-w.json")).exists());
    let none = crate::reqenv::RequestEnv::from_pairs(Vec::<(String, String)>::new());
    assert_eq!(MergeSidePick.run_env(&sub("PostToolUse"), &p, &Value::Null, &none), Some(Verdict::Defer));
}

fn run_check(event: &str, p: &Value, home: &str) -> Option<Verdict> {
    let null = Value::Null;
    let s = Subject { event, tool: Some("Bash"), cwd: None, tool_input: &null, prompt: None };
    MergeSidePick.run_env(&s, p, &Value::Null, &RequestEnv::from_pairs([("HOME", home)]))
}

/// The native Post writes Node's file, the native Pre reads it: one session sees the pick, with the advisory Node prints.
#[test]
fn a_native_post_then_a_native_pre_sees_the_pick() {
    let h = tmp_home("post-pre");
    let post = payload("PostToolUse", "s9", "git checkout --theirs .");
    assert_eq!(run_check("PostToolUse", &post, &h), Some(Verdict::Allow), "Post is answered natively, not deferred");
    let push = payload("PreToolUse", "s9", "git push");
    let native = run_check("PreToolUse", &push, &h);
    let Some(Verdict::Advisory(j)) = native else { panic!("expected the advisory, got {native:?}") };
    // identical to what the decision core yields from the same file with a fresh store (Node's reading of that file)
    let same = decide(&push, &settings(&h), &FileState::new(&h).unwrap());
    assert_eq!(Some(Verdict::Advisory(j.clone())), same);
    assert!(j.contains("git checkout --theirs ."), "{j}");
    // a test run after the pick clears it
    run_check("PostToolUse", &payload("PostToolUse", "s9", "npm test"), &h);
    assert_eq!(run_check("PreToolUse", &push, &h), Some(Verdict::Allow));
    // another session has no record
    assert_eq!(run_check("PreToolUse", &payload("PreToolUse", "s10", "git push"), &h), Some(Verdict::Allow));
}

/// A state file written by Node (its bytes, its coercions) is read by the native Pre pass; one the engine cannot read as text defers.
#[test]
fn a_node_written_state_file_is_read_natively_and_an_unreadable_one_defers() {
    let h = tmp_home("node-file");
    let push = payload("PreToolUse", "n1", "git push");
    std::fs::write(format!("{h}/.anti-hall/merge-side-pick-n1.json"), r#"{"seq":"2","pickSeq":2,"testSeq":"1","cmd":"git merge -X ours x"}"#).unwrap();
    let Some(Verdict::Advisory(j)) = run_check("PreToolUse", &push, &h) else { panic!("Node's record must be seen") };
    assert!(j.contains("git merge -X ours x"), "{j}");
    // unparseable text is a fresh record in Node, so the native answer is Allow
    std::fs::write(format!("{h}/.anti-hall/merge-side-pick-n2.json"), "{not json").unwrap();
    assert_eq!(run_check("PreToolUse", &payload("PreToolUse", "n2", "git push"), &h), Some(Verdict::Allow));
    // bytes that are not UTF-8 text: not provable, so Node decides (Pre and Post), and nothing is written
    let bad = format!("{h}/.anti-hall/merge-side-pick-n3.json");
    std::fs::write(&bad, [0x7b, 0xff, 0xfe, 0x7d]).unwrap();
    assert_eq!(run_check("PreToolUse", &payload("PreToolUse", "n3", "git push"), &h), Some(Verdict::Defer));
    assert_eq!(run_check("PostToolUse", &payload("PostToolUse", "n3", "git checkout --theirs ."), &h), Some(Verdict::Defer));
    assert_eq!(std::fs::read(&bad).unwrap(), vec![0x7b, 0xff, 0xfe, 0x7d]);
}

/// Review 3 P2: a record Node wrote that serde rejects but JavaScript parses (the lone `\ud83d` JSON.stringify emits for a cut astral
/// character, `1e400`, a 400-digit integer, nesting past 128) was read as a fresh record, so the Pre pass gave no advisory where Node does.
#[test]
fn a_record_only_javascript_can_parse_defers_both_passes() {
    let h = tmp_home("js-only");
    let deep = format!("{}{}", "[".repeat(200), "]".repeat(200));
    let big = format!("1{}", "0".repeat(400));
    for (i, body) in [
        r#"{"seq":1,"pickSeq":1,"testSeq":0,"cmd":"git checkout --theirs a\ud83d"}"#.to_string(),
        r#"{"seq":1,"pickSeq":1,"testSeq":0,"cmd":"c","x":1e400}"#.to_string(),
        format!(r#"{{"seq":1,"pickSeq":1,"testSeq":0,"cmd":"c","x":{big}}}"#),
        format!(r#"{{"seq":1,"pickSeq":1,"testSeq":0,"cmd":"c","d":{deep}}}"#),
    ]
    .into_iter()
    .enumerate()
    {
        let sid = format!("js{i}");
        std::fs::write(format!("{h}/.anti-hall/merge-side-pick-{sid}.json"), &body).unwrap();
        assert_eq!(run_check("PreToolUse", &payload("PreToolUse", &sid, "git push"), &h), Some(Verdict::Defer), "pre {i}");
        assert_eq!(run_check("PostToolUse", &payload("PostToolUse", &sid, "git checkout --theirs ."), &h), Some(Verdict::Defer), "post {i}");
        assert_eq!(std::fs::read_to_string(format!("{h}/.anti-hall/merge-side-pick-{sid}.json")).unwrap(), body, "nothing written {i}");
    }
}
