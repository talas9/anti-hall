//! Unit tests of the session gates; the Node-vs-engine comparison is `tests/port_guards_parity.rs`.
use super::*;
use serde_json::json;
use std::collections::HashMap;

fn home(tag: &str) -> String {
    let d = std::env::temp_dir().join(format!("ah-gates-{tag}-{}", std::process::id()));
    crate::discard::harmless(std::fs::remove_dir_all(&d));
    std::fs::create_dir_all(d.join(".anti-hall/state")).unwrap();
    d.to_string_lossy().to_string()
}

fn st(h: &str, extra: &[(&str, &str)]) -> Settings {
    let mut env: HashMap<String, String> = HashMap::from([("HOME".to_string(), h.to_string())]);
    env.extend(extra.iter().map(|(k, v)| (k.to_string(), v.to_string())));
    Settings { home: h.into(), env }
}

/// A plugin root with a manifest, inside the test home; the legacy settings need the plugin version.
fn root(h: &str) -> String {
    std::fs::create_dir_all(format!("{h}/plugin/.claude-plugin")).unwrap();
    write(h, "plugin/.claude-plugin/plugin.json", r#"{"version":"1.2.3"}"#);
    format!("{h}/plugin")
}

fn write(h: &str, rel: &str, body: &str) {
    std::fs::write(format!("{h}/{rel}"), body).unwrap();
}

#[test]
fn the_weekly_gate_is_silent_until_the_latch_is_a_week_old() {
    let h = home("weekly");
    let s = st(&h, &[]);
    let r = root(&h);
    assert_eq!(jev_weekly::decide(&json!({}), &s, &r), Ok(()), "Jev off is silent");
    assert_eq!(jev_weekly::decide(&json!({}), &s, ""), Err(Undecidable), "the legacy file tier needs the plugin root");
    write(&h, ".anti-hall/settings.json", r#"{"jev":{"enabled":true}}"#);
    assert_eq!(jev_weekly::decide(&json!({}), &s, &r), Err(Undecidable), "no latch: the Node hook must run");
    write(&h, ".anti-hall/state/jev-weekly-notice.json", &format!("{{\"lastCheckedTs\":{}}}", now_ms() as u64 - 86_400_000));
    assert_eq!(jev_weekly::decide(&json!({}), &s, &r), Ok(()));
    write(&h, ".anti-hall/state/jev-weekly-notice.json", &format!("{{\"lastCheckedTs\":{}}}", now_ms() as u64 - 8 * 86_400_000));
    assert_eq!(jev_weekly::decide(&json!({}), &s, &r), Err(Undecidable));
    assert_eq!(jev_weekly::decide(&json!({}), &st(&h, &[("DEVSWARM_SOURCE_BRANCH", "x")]), &r), Ok(()), "a child workspace is never nagged");
}

#[test]
fn a_subagent_turn_and_a_recent_recommend_notice_are_silent_a_headless_run_is_not_decided() {
    let h = home("review");
    let s = st(&h, &[]);
    let r = root(&h);
    assert_eq!(jev_review::decide(&json!({"agent_id": "a1"}), &s, &r), Ok(()));
    assert_eq!(jev_review::decide(&json!({"isSidechain": true}), &s, &r), Ok(()));
    assert_eq!(jev_review::decide(&json!({}), &s, &r), Err(Undecidable), "first run: the notice is due");
    write(&h, ".anti-hall/state/jev-recommend-notice.json", &format!("{{\"lastShownTs\":{}}}", now_ms() as u64 - 1000));
    assert_eq!(jev_review::decide(&json!({}), &s, &r), Ok(()));
    assert_eq!(jev_review::decide(&json!({}), &st(&h, &[("CLAUDE_CODE_ENTRYPOINT", "sdk-cli")]), &r), Err(Undecidable));
    assert_eq!(jev_review::decide(&json!({"turn_id": "t", "model": "m"}), &st(&h, &[("CLAUDE_CODE_ENTRYPOINT", "sdk-cli")]), &r), Ok(()));
    write(&h, ".anti-hall/settings.json", r#"{"jev":{"enabled":true}}"#);
    assert_eq!(jev_review::decide(&json!({}), &s, &r), Err(Undecidable), "Jev on: the review line is Node's");
}

#[test]
fn the_repair_gate_needs_every_default_migration_stamped_at_the_running_version() {
    assert_eq!(repair_reload::triple_for_test("1.2.3"), Some([1.0, 2.0, 3.0]));
    assert_eq!(repair_reload::triple_for_test("1.2.3-rc.1"), None);
    assert_eq!(repair_reload::triple_for_test("1.2"), None);
    assert!(repair_reload::at_least_for_test([1.0, 2.0, 3.0], [1.0, 2.0, 3.0]));
    assert!(repair_reload::at_least_for_test([2.0, 0.0, 0.0], [1.0, 99.0, 99.0]));
    assert!(repair_reload::at_least_for_test([0.0, 10.0, 0.0], [0.0, 9.0, 99.0]));
    assert!(!repair_reload::at_least_for_test([0.0, 9.0, 99.0], [0.0, 10.0, 0.0]));
}
