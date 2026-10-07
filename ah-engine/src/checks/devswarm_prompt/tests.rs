//! Unit tests of the DevSwarm prompt gates. The Node-vs-engine comparison is `tests/devswarm_prompt_parity.rs`.
use super::*;
use serde_json::json;

fn env(pairs: &[(&str, &str)]) -> RequestEnv {
    RequestEnv::from_pairs(pairs.iter().map(|(k, v)| (k.to_string(), v.to_string())))
}

fn home_with(settings: Option<&str>) -> String {
    let d = std::env::temp_dir().join(format!(
        "ah-dsp-unit-{}-{}",
        std::process::id(),
        std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()
    ));
    std::fs::create_dir_all(d.join(".anti-hall")).unwrap();
    if let Some(t) = settings {
        std::fs::write(d.join(".anti-hall/settings.json"), t).unwrap();
    }
    d.to_string_lossy().into_owned()
}

fn verdict(check: &dyn Check, e: &RequestEnv) -> Option<Verdict> {
    let ti = Value::Null;
    let s = Subject { event: "UserPromptSubmit", tool: None, cwd: None, tool_input: &ti, prompt: None };
    check.run_env(&s, &json!({}), &Value::Null, e)
}

#[test]
fn a_plain_session_is_answered_for_both_hooks() {
    let h = home_with(None);
    let e = env(&[("HOME", &h)]);
    assert_eq!(verdict(&DevswarmParentInbox, &e), Some(Verdict::Allow));
    assert_eq!(verdict(&DevswarmChildTurn, &e), Some(Verdict::Allow));
}

#[test]
fn an_active_primary_and_an_active_child_defer_to_their_own_hook_only() {
    let h = home_with(None);
    let primary = env(&[("HOME", &h), ("DEVSWARM_REPO_ID", "r")]);
    assert_eq!(verdict(&DevswarmParentInbox, &primary), Some(Verdict::Defer));
    assert_eq!(verdict(&DevswarmChildTurn, &primary), Some(Verdict::Allow));
    let child = env(&[("HOME", &h), ("DEVSWARM_REPO_ID", "r"), ("DEVSWARM_SOURCE_BRANCH", "b")]);
    assert_eq!(verdict(&DevswarmParentInbox, &child), Some(Verdict::Allow));
    assert_eq!(verdict(&DevswarmChildTurn, &child), Some(Verdict::Defer));
}

#[test]
fn a_switch_in_settings_json_silences_only_its_own_hook() {
    let h = home_with(Some(r#"{"devswarm":{"parentInbox":false}}"#));
    let primary = env(&[("HOME", &h), ("DEVSWARM_REPO_ID", "r")]);
    assert_eq!(verdict(&DevswarmParentInbox, &primary), Some(Verdict::Allow));
    let child = env(&[("HOME", &h), ("DEVSWARM_REPO_ID", "r"), ("DEVSWARM_SOURCE_BRANCH", "b")]);
    assert_eq!(verdict(&DevswarmChildTurn, &child), Some(Verdict::Defer));
}

#[test]
fn the_kill_switch_and_the_judge_child_need_no_home() {
    for var in ["DISABLE_ANTIHALL_DEVSWARM", "ANTIHALL_JUDGE_CHILD"] {
        let e = env(&[("DEVSWARM_REPO_ID", "r"), (var, "1")]);
        assert_eq!(verdict(&DevswarmParentInbox, &e), Some(Verdict::Allow), "{var}");
    }
}

#[test]
fn without_a_home_only_the_environment_proves_silence() {
    let primary = env(&[("DEVSWARM_REPO_ID", "r")]);
    assert_eq!(verdict(&DevswarmParentInbox, &primary), Some(Verdict::Defer), "settings files cannot be read");
    assert_eq!(verdict(&DevswarmChildTurn, &primary), Some(Verdict::Allow), "a non-child is silent from the environment alone");
}

#[test]
fn a_userprofile_alone_is_not_a_home() {
    let h = home_with(Some(r#"{"devswarm":{"supervisorMode":"off"}}"#));
    let e = env(&[("USERPROFILE", &h), ("DEVSWARM_REPO_ID", "r")]);
    assert_eq!(verdict(&DevswarmParentInbox, &e), Some(Verdict::Defer), "Node reads os.homedir(), which ignores USERPROFILE on POSIX");
}

#[test]
fn run_without_an_environment_defers() {
    let ti = Value::Null;
    let s = Subject { event: "UserPromptSubmit", tool: None, cwd: None, tool_input: &ti, prompt: None };
    assert_eq!(DevswarmParentInbox.run(&s, &Value::Null), Some(Verdict::Defer));
    assert_eq!(DevswarmChildTurn.run(&s, &Value::Null), Some(Verdict::Defer));
}
