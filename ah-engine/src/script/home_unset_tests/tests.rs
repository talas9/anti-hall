//! #249: with no `HOME` in the hook environment Node falls back to the passwd home (`os.homedir()`), and the speculation, task and
//! tasklist guards decide under it. The scripts once took the missing home as "no state" and allowed (`no_home`).
//!
//! The passwd home is the real one and a test never touches it, so the calls run under a test marker: the guards look the passwd home
//! up, refuse it (`home_test_guard`, an allow) and note the refusal. The note tells the two apart where the verdict cannot (both
//! allow): the old scripts gave up before the lookup and counted `no_home`. The goldens expect the allow under isolation too, so
//! only this test pins that the lookup happens.
use super::*;
use serde_json::json;

#[test]
fn the_task_speculation_and_tasklist_guards_look_up_the_passwd_home_when_home_is_unset() {
    let tr = std::env::temp_dir().join(format!("ah-home-unset-{}.jsonl", std::process::id()));
    std::fs::write(&tr, "{\"type\":\"assistant\",\"message\":{\"content\":[{\"type\":\"text\",\"text\":\"probably x\"}]}}\n").unwrap();
    let env = RequestEnv::from_pairs([("ANTIHALL_TEST_ISOLATION", "1")]);
    let payload = json!({"session_id": "s1", "hook_event_name": "Stop", "stop_hook_active": false, "cwd": "/tmp", "transcript_path": tr});
    for guard in ["speculation-guard", "task-guard", "tasklist-guard"] {
        let got = run_forced(guard, &payload, &Value::Null, "Stop", &env).expect("a shipped script").expect("a verdict");
        assert!(matches!(got, Verdict::Allow), "{guard}: the real home under a test marker is refused, an allow: {got:?}");
    }
    std::fs::remove_file(&tr).unwrap();
    // `ah.unable(site)` is counted and noted in the trace ring under `script:<site>`
    let seen = crate::obs::trace::snapshot().iter().map(Value::to_string).collect::<Vec<_>>().join("\n");
    for guard in ["speculation-guard", "task-guard", "tasklist-guard"] {
        assert!(
            seen.contains(&format!("{guard}:home_test_guard")),
            "{guard} must refuse the passwd home it looked up (the old scripts counted no_home):\n{seen}"
        );
    }
}
