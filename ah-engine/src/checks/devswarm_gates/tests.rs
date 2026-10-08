//! Unit tests of the DevSwarm gate checks. The Node-vs-engine comparison is `tests/devswarm_gates_parity.rs`.
use super::*;
use serde_json::json;
use std::collections::HashMap;

fn home(tag: &str) -> String {
    let d = std::env::temp_dir().join(format!("ah-dsg-{tag}-{}", std::process::id()));
    crate::discard::harmless(std::fs::remove_dir_all(&d));
    std::fs::create_dir_all(d.join(".anti-hall")).unwrap();
    std::fs::create_dir_all(d.join(".claude")).unwrap();
    d.to_string_lossy().into_owned()
}

fn st(h: &str, env: &[(&str, &str)]) -> Settings {
    let mut m: HashMap<String, String> = env.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect();
    m.insert("HOME".into(), h.into());
    Settings { home: h.to_string(), env: m }
}

const CHILD: [(&str, &str); 2] = [("DEVSWARM_REPO_ID", "r1"), ("DEVSWARM_SOURCE_BRANCH", "feat/x")];

#[test]
fn a_word_is_matched_like_the_javascript_word_boundary() {
    for (c, want) in [
        ("node devswarm.js send --to a", true),
        ("DEVSWARM SEND", true),
        ("send devswarm", true),
        ("devswarm_send", false),
        ("xdevswarm send", false),
        ("devswarmx send", false),
        ("devswarm.jsx send", true),
        ("devswarm\u{e9} send", true),
        ("\u{e9}devswarm send", true),
        ("devswarm sen\u{17f}", false),
        ("\u{17f}end devswarm", false),
        ("DEVSWARM s\u{212a}nd", false),
        ("", false),
        ("devswarm", false),
        ("send", false),
        ("cli=./devswarm.js\nnode \"$cli\" send --to x", true),
        ("devswarm-send", true),
        ("/path/devswarm/send", true),
    ] {
        assert_eq!(looks_like_send(c), want, "{c:?}");
    }
}

#[test]
fn child_and_active_follow_the_environment() {
    let h = home("role");
    assert!(is_child(&st(&h, &CHILD)));
    assert!(!is_child(&st(&h, &[("DEVSWARM_SOURCE_BRANCH", " \u{a0}\t")])));
    assert!(!is_child(&st(&h, &[])));
    assert!(devswarm_active(&st(&h, &[("DEVSWARM_REPO_ID", "r")])));
    assert!(!devswarm_active(&st(&h, &[("DEVSWARM_REPO_ID", "  ")])));
    assert!(!devswarm_active(&st(&h, &[("DEVSWARM_REPO_ID", "r"), ("DISABLE_ANTIHALL_DEVSWARM", "1")])));
    assert!(devswarm_active(&st(&h, &[("DEVSWARM_REPO_ID", "r"), ("DISABLE_ANTIHALL_DEVSWARM", "true")])), "only exactly 1 kills it");
    assert!(!devswarm_active(&st(&h, &[("DEVSWARM_REPO_ID", "r"), ("ANTIHALL_DEVSWARM_SUPERVISOR", " OFF ")])));
    assert!(devswarm_active(&st(&h, &[("ANTIHALL_DEVSWARM_SUPERVISOR", "On")])), "on forces it without a repo id");
    assert!(!devswarm_active(&st(&h, &[("ANTIHALL_DEVSWARM_SUPERVISOR", "maybe")])), "an unknown mode falls back to auto");
}

#[test]
fn the_supervisor_mode_resolves_env_then_file_then_plugin_option() {
    let h = home("mode");
    let e = defaults::raw("devswarm_gates.supervisor_mode");
    assert_eq!(get_enum(&st(&h, &[]), e), "auto");
    std::fs::write(format!("{h}/.anti-hall/settings.json"), r#"{"devswarm":{"supervisorMode":" ON "}}"#).unwrap();
    assert_eq!(get_enum(&st(&h, &[]), e), "on");
    assert_eq!(get_enum(&st(&h, &[("ANTIHALL_DEVSWARM_SUPERVISOR", "off")]), e), "off", "env outranks the file");
    assert_eq!(get_enum(&st(&h, &[("ANTIHALL_DEVSWARM_SUPERVISOR", "zzz")]), e), "on", "an unreadable env value falls through");
    std::fs::write(format!("{h}/.anti-hall/settings.json"), r#"{"devswarm":{"supervisorMode":5}}"#).unwrap();
    assert_eq!(get_enum(&st(&h, &[("CLAUDE_PLUGIN_OPTION_DEVSWARM_SUPERVISOR_MODE", "off")]), e), "off");
    assert_eq!(get_enum(&st(&h, &[("CLAUDE_PLUGIN_OPTION_DEVSWARM_SUPERVISOR_MODE", "auto")]), e), "auto", "the default counts as unset");
    std::fs::write(format!("{h}/.claude/settings.json"), r#"{"pluginConfigs":{"anti-hall":{"options":{"devswarm_supervisor_mode":"on"}}}}"#).unwrap();
    assert_eq!(get_enum(&st(&h, &[]), e), "on");
    std::fs::write(format!("{h}/.anti-hall/settings.json"), "{bad").unwrap();
    assert_eq!(get_enum(&st(&h, &[]), e), "on", "a corrupt settings file falls through");
}

#[test]
fn the_child_gate_allows_only_when_the_hook_cannot_act_and_never_otherwise() {
    let h = home("gate");
    assert_eq!(decide_child_gate(&st(&h, &[])), Verdict::Allow, "not DevSwarm");
    assert_eq!(decide_child_gate(&st(&h, &[("DEVSWARM_REPO_ID", "r")])), Verdict::Allow, "a Primary");
    assert_eq!(decide_child_gate(&st(&h, &[("DEVSWARM_SOURCE_BRANCH", "b")])), Verdict::Allow, "child env without the supervisor");
    assert_eq!(decide_child_gate(&st(&h, &CHILD)), Verdict::Defer, "a child workspace is Node's to judge");
    std::fs::write(format!("{h}/.anti-hall/settings.json"), r#"{"devswarm":{"childGate":false}}"#).unwrap();
    assert_eq!(decide_child_gate(&st(&h, &CHILD)), Verdict::Allow, "switched off");
    std::fs::write(format!("{h}/.anti-hall/settings.json"), "{}").unwrap();
    let future = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis() + 3_600_000;
    std::fs::write(format!("{h}/.anti-hall/skip.json"), format!(r#"{{"devswarm-child-gate":{future}}}"#)).unwrap();
    assert_eq!(decide_child_gate(&st(&h, &CHILD)), Verdict::Allow, "a recorded skip");
    std::fs::write(format!("{h}/.anti-hall/skip.json"), r#"{"devswarm-child-gate":1}"#).unwrap();
    assert_eq!(decide_child_gate(&st(&h, &CHILD)), Verdict::Defer, "an expired skip does not count");
    std::fs::write(format!("{h}/.anti-hall/skip.json"), format!(r#"{{"all":{future}}}"#)).unwrap();
    assert_eq!(decide_child_gate(&st(&h, &CHILD)), Verdict::Allow, "a broad skip covers this guard");
}

#[test]
fn the_reply_tracker_allows_everything_but_a_plausible_send() {
    let h = home("track");
    let send = json!({"tool_name": "Bash", "tool_input": {"command": "node devswarm.js send --to a --message x"}});
    assert_eq!(decide_reply_tracker(&send, &st(&h, &[])), Verdict::Defer);
    assert_eq!(decide_reply_tracker(&send, &st(&h, &CHILD)), Verdict::Allow, "a child never records");
    for p in [
        json!(null),
        json!([1]),
        json!(5),
        json!({"tool_name": "Read", "tool_input": {"command": "devswarm send"}}),
        json!({"tool_name": "Bash"}),
        json!({"tool_name": "Bash", "tool_input": "devswarm send"}),
        json!({"tool_name": "Bash", "tool_input": {"command": 5}}),
        json!({"tool_name": "Bash", "tool_input": {"command": "ls"}}),
        json!({"tool_name": "Bash", "tool_input": {"command": "devswarm status"}}),
    ] {
        assert_eq!(decide_reply_tracker(&p, &st(&h, &[])), Verdict::Allow, "{p}");
    }
    std::fs::write(format!("{h}/.anti-hall/settings.json"), r#"{"devswarm":{"parentReplyTracker":"off"}}"#).unwrap();
    assert_eq!(decide_reply_tracker(&send, &st(&h, &[])), Verdict::Allow, "switched off");
}

#[test]
fn the_drain_nudge_defers_only_for_a_child_workspace() {
    let h = home("drain");
    assert_eq!(decide_child_drain(&st(&h, &[])), Verdict::Allow);
    assert_eq!(decide_child_drain(&st(&h, &[("DEVSWARM_REPO_ID", "r")])), Verdict::Allow);
    assert_eq!(decide_child_drain(&st(&h, &CHILD)), Verdict::Defer);
    std::fs::write(format!("{h}/.anti-hall/settings.json"), r#"{"devswarm":{"childDrain":false}}"#).unwrap();
    assert_eq!(decide_child_drain(&st(&h, &CHILD)), Verdict::Allow);
}

mod readside_unit {
    use super::super::readside::*;
    use crate::checks::Verdict;
    use crate::reqenv::RequestEnv;
    use serde_json::json;

    #[test]
    fn without_a_usable_home_or_plugin_root_both_defer() {
        let env = RequestEnv::from_pairs([("DEVSWARM_REPO_ID", "r"), ("DEVSWARM_SOURCE_BRANCH", "b")]);
        assert!(matches!(child_drain(&json!({"tool_name": "Read"}), &env, None), Verdict::Defer), "no home, no plugin root");
        let env = RequestEnv::from_pairs([("HOME", "/nonexistent-home-ds")]);
        assert!(matches!(child_drain(&json!({"tool_name": "Read"}), &env, None), Verdict::Defer), "no plugin root");
        assert!(matches!(child_drain(&json!({"tool_name": "Read"}), &env, Some("/nonexistent-root")), Verdict::Defer), "unresolvable root");
        assert!(matches!(parent_gate(&json!({"stop_hook_active": true}), &env, Some("/nonexistent-root")), Verdict::Defer));
    }
}
