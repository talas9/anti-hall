//! Unit tests of the shared spawn-context helpers; the Node-vs-engine parity corpus is `tests/spawn_ctx_parity.rs`.
use super::*;
use serde_json::json;

fn env(pairs: &[(&str, &str)]) -> HashMap<String, String> {
    pairs.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect()
}

/// Settings over a scratch home that is removed when they drop (a home left in the temp dir per test run piled up there).
struct Scratch(Settings);

impl std::ops::Deref for Scratch {
    type Target = Settings;
    fn deref(&self) -> &Settings {
        &self.0
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        crate::discard::harmless(std::fs::remove_dir_all(&self.0.home)); // keep: cleanup of a scratch directory
    }
}

fn settings(pairs: &[(&str, &str)]) -> Scratch {
    static SEQ: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
    let n = SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let home = std::env::temp_dir().join(format!("ah-spawnctx-unit-{}-{n}", std::process::id()));
    std::fs::create_dir_all(home.join(".anti-hall")).unwrap();
    let mut e = env(pairs);
    e.insert("HOME".into(), home.to_string_lossy().to_string());
    Scratch(Settings { home: home.to_string_lossy().to_string(), env: e })
}

#[test]
fn session_ids_sanitize_like_node() {
    assert_eq!(sanitize_session("abc-DEF_123"), "abc-DEF_123");
    assert_eq!(sanitize_session("a/b c.d"), "abcd");
    assert_eq!(sanitize_session("ünï"), "n");
    assert_eq!(sanitize_session("ü日"), "unknown-session");
    assert_eq!(sanitize_session(""), "unknown-session");
}

#[test]
fn a_subagent_marker_counts_when_present_and_not_null_even_if_falsy() {
    assert!(subagent_by_payload(&json!({"agent_id": ""})));
    assert!(subagent_by_payload(&json!({"agent_type": 0})));
    assert!(subagent_by_payload(&json!({"agent_type": false})));
    assert!(!subagent_by_payload(&json!({"agent_id": null, "agent_type": null})));
    assert!(!subagent_by_payload(&json!({})));
    assert!(!subagent_by_payload(&json!([{"agent_id": "x"}])));
}

#[test]
fn devswarm_detection_follows_the_kill_switch_then_the_mode_then_the_repo_variable() {
    assert!(!devswarm_active(&settings(&[])));
    assert!(devswarm_active(&settings(&[("DEVSWARM_REPO_ID", "r")])));
    assert!(!devswarm_active(&settings(&[("DEVSWARM_REPO_ID", "  ")])));
    assert!(!devswarm_active(&settings(&[("DEVSWARM_REPO_ID", "r"), ("DISABLE_ANTIHALL_DEVSWARM", "1")])));
    assert!(devswarm_active(&settings(&[("DEVSWARM_REPO_ID", "r"), ("DISABLE_ANTIHALL_DEVSWARM", "true")])));
    assert!(devswarm_active(&settings(&[("ANTIHALL_DEVSWARM_SUPERVISOR", " ON ")])));
    assert!(!devswarm_active(&settings(&[("DEVSWARM_REPO_ID", "r"), ("ANTIHALL_DEVSWARM_SUPERVISOR", "off")])));
    assert!(devswarm_active(&settings(&[("DEVSWARM_REPO_ID", "r"), ("ANTIHALL_DEVSWARM_SUPERVISOR", "nonsense")])));
}

#[test]
fn the_home_is_the_absolute_home_variable_and_a_test_run_never_gets_the_real_one() {
    assert_eq!(state_home(&env(&[])), Home::Unknown);
    assert_eq!(state_home(&env(&[("HOME", "")])), Home::Unknown);
    assert_eq!(state_home(&env(&[("HOME", "relative/dir")])), Home::Unknown);
    assert_eq!(state_home(&env(&[("HOME", "/some/where")])), Home::Ok("/some/where".into()));
    let real = passwd_home().expect("the test user has a passwd home");
    assert_eq!(state_home(&env(&[("HOME", &real)])), Home::Ok(real.clone()), "outside a test run the real home is used");
    assert_eq!(state_home(&env(&[("HOME", &real), ("ANTIHALL_TEST_ISOLATION", "1")])), Home::Guarded);
    assert_eq!(state_home(&env(&[("HOME", &format!("{real}/")), ("ANTIHALL_TEST", "1")])), Home::Guarded, "the trailing slash does not hide it");
    assert_eq!(state_home(&env(&[("HOME", &real), ("ANTIHALL_TEST_ISOLATION", "1"), ("ANTIHALL_ALLOW_REAL_HOME_TEST", "1")])), Home::Ok(real));
    assert_eq!(state_home(&env(&[("HOME", "/some/where"), ("ANTIHALL_TEST_ISOLATION", "1")])), Home::Ok("/some/where".into()));
}

#[test]
fn a_judge_child_is_recognized_only_by_the_exact_value() {
    assert!(judge_child(&env(&[("ANTIHALL_JUDGE_CHILD", "1")])));
    assert!(!judge_child(&env(&[("ANTIHALL_JUDGE_CHILD", "0")])));
    assert!(!judge_child(&env(&[])));
}

#[test]
fn a_scratch_home_goes_with_its_settings() {
    let s = settings(&[]);
    let home = std::path::PathBuf::from(&s.home);
    assert!(home.join(".anti-hall").is_dir());
    drop(s);
    assert!(!home.exists(), "{} outlived its test", home.display());
}
