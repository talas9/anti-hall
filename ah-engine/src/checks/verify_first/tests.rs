//! Unit tests of the verify-first checks. The full Node-vs-engine comparison is `tests/node_parity` (the Rust Node-parity test).
use super::*;
use serde_json::json;
use std::collections::HashMap;

/// A fake plugin root holding `hooks/verify-first-core.js`, and an empty home.
fn dirs(tag: &str) -> (String, String) {
    let d = std::env::temp_dir().join(format!("ah-vf-{tag}-{}", std::process::id()));
    crate::discard::harmless(std::fs::remove_dir_all(&d));
    std::fs::create_dir_all(d.join("plugin/hooks")).unwrap();
    std::fs::write(d.join("plugin/hooks/verify-first-core.js"), "").unwrap();
    std::fs::create_dir_all(d.join("home/.anti-hall")).unwrap();
    let real = std::fs::canonicalize(&d).unwrap();
    (real.join("plugin").to_string_lossy().to_string(), real.join("home").to_string_lossy().to_string())
}

fn st(home: &str, env: &[(&str, &str)]) -> Settings {
    Settings { home: home.into(), env: env.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect::<HashMap<_, _>>() }
}

fn opts(root: &str) -> Value {
    json!({ "plugin_root": root })
}

fn text(v: Option<Verdict>) -> (String, String) {
    match v {
        Some(Verdict::Advisory(j)) => {
            let v: Value = serde_json::from_str(&j).unwrap();
            let h = &v["hookSpecificOutput"];
            (h["hookEventName"].as_str().unwrap().into(), h["additionalContext"].as_str().unwrap().into())
        }
        other => panic!("expected an advisory, got {other:?}"),
    }
}

fn silent(v: Option<Verdict>) -> bool {
    matches!(v, Some(Verdict::Allow))
}

#[test]
fn the_compact_session_text_names_the_real_plugin_root_and_the_event() {
    let (root, home) = dirs("session");
    let (ev, t) = text(decide_full(&json!({"hook_event_name": "SessionStart"}), &st(&home, &[]), &opts(&root), &RequestEnv::default()));
    assert_eq!(ev, "SessionStart");
    assert!(t.starts_with("ANTI-HALL VERIFY-FIRST (re-sent at session start and after compaction). Full protocol: "), "{t}");
    assert!(t.contains(&format!("{root}/PROTOCOL.md")) && !t.contains("<abs>"), "{t}");
}

#[test]
fn a_root_that_cannot_be_proven_defers_instead_of_printing_another_path() {
    let (_, home) = dirs("noroot");
    let e = RequestEnv::default();
    assert!(decide_full(&json!({}), &st(&home, &[]), &json!({"plugin_root": "/nonexistent-root"}), &e).is_none());
    assert!(decide_full(&json!({}), &st(&home, &[]), &json!({"plugin_root": "relative"}), &e).is_none());
    assert!(decide_full(&json!({}), &st(&home, &[]), &Value::Null, &e).is_none());
    assert!(decide_subagent(&st(&home, &[]), &Value::Null, &e).is_none());
    // the full text carries no path, so it needs no root
    let full = st(&home, &[("ANTIHALL_PROTOCOL_LEVEL", "full")]);
    assert!(text(decide_full(&json!({}), &full, &Value::Null, &e)).1.starts_with("VERIFY-FIRST + ROOT-CAUSE PROTOCOL"));
}

#[test]
fn full_level_picks_the_codex_text_from_the_payload() {
    let (root, home) = dirs("codex");
    let s = st(&home, &[("ANTIHALL_PROTOCOL_LEVEL", " FULL ")]);
    let e = RequestEnv::default();
    let claude = text(decide_full(&json!({}), &s, &opts(&root), &e)).1;
    for p in [
        json!({"turn_id": "t1"}),
        json!({"transcript_path": "/x/rollout-1.jsonl"}),
        json!({"transcript_path": "/home/u/.codex/sessions/a"}),
        json!({"transcript_path": "C:\\a\\.codex\\b"}),
    ] {
        let t = text(decide_full(&p, &s, &opts(&root), &e)).1;
        assert_ne!(t, claude, "{p}");
        assert_eq!(t, defaults::text("verify_first.full_codex"), "{p}");
    }
    for p in [
        json!({"turn_id": ""}),
        json!({"turn_id": 5}),
        json!({"transcript_path": "/x/rollout-1.jsonl.bak"}),
        json!({"transcript_path": "/x/notcodex/a"}),
        json!([1]),
        json!(null),
    ] {
        assert_eq!(text(decide_full(&p, &s, &opts(&root), &e)).1, claude, "{p}");
    }
}

#[test]
fn switching_the_orchestration_hook_off_adds_the_routing_line_for_the_right_host() {
    let (root, home) = dirs("orch");
    let e = RequestEnv::default();
    let off = "CLAUDE_PLUGIN_OPTION_CONTEXT_VERIFY_FIRST_ORCHESTRATION";
    let t = text(decide_full(&json!({}), &st(&home, &[(off, "false")]), &opts(&root), &e)).1;
    assert!(t.ends_with(&format!("\n{}", defaults::text("verify_first.mn_line"))), "{t}");
    let t = text(decide_full(&json!({"turn_id": "x"}), &st(&home, &[(off, "false")]), &opts(&root), &e)).1;
    assert!(t.ends_with(&format!("\n{}", defaults::text("verify_first.mn_line_codex"))), "{t}");
    // a value equal to the default is not a choice (the host exports every option)
    let t = text(decide_full(&json!({}), &st(&home, &[(off, "true")]), &opts(&root), &e)).1;
    assert!(!t.contains("M/N. Workers do not re-delegate; read-only research -> Explore; 3+"), "{t}");
}

#[test]
fn switches_the_skip_file_and_the_judge_child_silence_the_hooks() {
    let (root, home) = dirs("silent");
    let e = RequestEnv::default();
    let far = "99999999999999";
    std::fs::write(format!("{home}/.anti-hall/settings.json"), r#"{"context":{"verifyFirstSession":false}}"#).unwrap();
    assert!(silent(decide_full(&json!({}), &st(&home, &[]), &opts(&root), &e)));
    assert!(!silent(decide_subagent(&st(&home, &[]), &opts(&root), &e)));
    std::fs::write(format!("{home}/.anti-hall/settings.json"), r#"{"context":{"verifyFirstSubagent":"off"}}"#).unwrap();
    assert!(silent(decide_subagent(&st(&home, &[]), &opts(&root), &e)));
    std::fs::write(format!("{home}/.anti-hall/settings.json"), "{}").unwrap();
    assert!(!silent(decide_subagent(&st(&home, &[]), &opts(&root), &e)));
    std::fs::write(format!("{home}/.anti-hall/skip.json"), format!(r#"{{"verify-first-subagent":{far}}}"#)).unwrap();
    assert!(silent(decide_subagent(&st(&home, &[]), &opts(&root), &e)));
    assert!(!silent(decide_full(&json!({}), &st(&home, &[]), &opts(&root), &e)), "the skip file names only the subagent hook");
    std::fs::write(format!("{home}/.anti-hall/skip.json"), r#"{"verify-first-subagent":1}"#).unwrap();
    assert!(!silent(decide_subagent(&st(&home, &[]), &opts(&root), &e)), "an expired skip is no skip");
    // the judge child silences verify-first-full only: the Node subagent hook never requires judge-child-exit
    let jc = st(&home, &[("ANTIHALL_JUDGE_CHILD", "1")]);
    assert!(silent(decide_full(&json!({}), &jc, &opts(&root), &e)));
    assert!(!silent(decide_subagent(&jc, &opts(&root), &e)));
    assert!(!silent(decide_full(&json!({}), &st(&home, &[("ANTIHALL_JUDGE_CHILD", "true")]), &opts(&root), &e)), "only the exact value 1");
}

#[test]
fn the_subagent_text_follows_level_and_devswarm_role() {
    let (root, home) = dirs("sub");
    let e = RequestEnv::default();
    let (ev, compact) = text(decide_subagent(&st(&home, &[]), &opts(&root), &e));
    assert_eq!(ev, "SubagentStart");
    assert!(compact.starts_with("ANTI-HALL VERIFY-FIRST. Full protocol: ") && compact.ends_with(defaults::text("verify_first.worker")), "{compact}");
    let child = st(&home, &[("DEVSWARM_SOURCE_BRANCH", "feat/x")]);
    let t = text(decide_subagent(&child, &opts(&root), &e)).1;
    assert_eq!(t, format!("{compact}\n{}", defaults::text("verify_first.child_note")));
    for blank in ["", "  ", "\u{feff}\t"] {
        assert_eq!(text(decide_subagent(&st(&home, &[("DEVSWARM_SOURCE_BRANCH", blank)]), &opts(&root), &e)).1, compact, "{blank:?}");
    }
    let full = st(&home, &[("ANTIHALL_PROTOCOL_LEVEL", "full"), ("DEVSWARM_SOURCE_BRANCH", "b")]);
    assert_eq!(
        text(decide_subagent(&full, &Value::Null, &e)).1,
        format!("{}\n{}", defaults::text("verify_first.subagent_full"), defaults::text("verify_first.child_note"))
    );
    // an unknown level falls back to compact, as Node's enum read does
    let bad = st(&home, &[("ANTIHALL_PROTOCOL_LEVEL", "huge")]);
    assert_eq!(text(decide_subagent(&bad, &opts(&root), &e)).1, compact);
}

#[test]
fn the_settings_file_level_is_read_when_the_environment_is_silent() {
    let (root, home) = dirs("level");
    let e = RequestEnv::default();
    std::fs::write(format!("{home}/.anti-hall/settings.json"), r#"{"context":{"protocolLevel":"Full"}}"#).unwrap();
    assert!(text(decide_full(&json!({}), &st(&home, &[]), &opts(&root), &e)).1.starts_with("VERIFY-FIRST + ROOT-CAUSE PROTOCOL"));
    // the environment outranks the file, and a junk environment value falls through to it
    let compact = st(&home, &[("ANTIHALL_PROTOCOL_LEVEL", "compact")]);
    assert!(text(decide_full(&json!({}), &compact, &opts(&root), &e)).1.starts_with("ANTI-HALL VERIFY-FIRST"));
    let junk = st(&home, &[("ANTIHALL_PROTOCOL_LEVEL", "zz")]);
    assert!(text(decide_full(&json!({}), &junk, &opts(&root), &e)).1.starts_with("VERIFY-FIRST + ROOT-CAUSE PROTOCOL"));
}

#[test]
fn the_registry_runs_both_checks_through_the_request_environment() {
    let (root, home) = dirs("reg");
    let env = RequestEnv::from_pairs([("HOME", home.as_str()), ("ANTIHALL_PROTOCOL_LEVEL", "full")]);
    let s = Subject { event: "SubagentStart", tool: None, cwd: None, tool_input: &Value::Null, prompt: None };
    let c = crate::checks::get("verify-first-subagent").unwrap();
    assert!(text(c.run_env(&s, &json!({}), &opts(&root), &env)).1.starts_with("VERIFY-FIRST + ROOT-CAUSE PROTOCOL"));
    assert_eq!(c.run(&s, &Value::Null), Some(Verdict::Defer));
    assert!(crate::checks::get("verify-first-full").is_some() && crate::checks::get("fable-availability").is_some());
}
