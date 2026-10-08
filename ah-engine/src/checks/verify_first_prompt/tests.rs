//! Unit tests of the verify-first check. The full Node comparison is `tests/prompt_emit_parity`.
use super::*;
use serde_json::json;
use std::collections::HashMap;

fn st(env: &[(&str, &str)]) -> Settings {
    // a counter, not the clock: two tests starting in the same millisecond must not share a home
    static N: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
    let d = std::env::temp_dir().join(format!("ah-vf-{}-{}", std::process::id(), N.fetch_add(1, std::sync::atomic::Ordering::Relaxed)));
    crate::discard::harmless(std::fs::remove_dir_all(&d));
    std::fs::create_dir_all(&d).unwrap();
    Settings { home: d.to_string_lossy().to_string(), env: env.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect::<HashMap<_, _>>() }
}

fn renv(s: &Settings) -> RequestEnv {
    RequestEnv::from_pairs(s.env.iter().map(|(k, v)| (k.clone(), v.clone())).chain([("HOME".to_string(), s.home.clone())]))
}

#[test]
fn the_digest_picks_the_line_by_its_first_four_bytes_modulo_the_count() {
    let n = defaults::list("verify_first.nudges").len();
    assert_eq!(n, 20, "the Node hook rotates among twenty lines");
    assert_eq!(nudge_for("00000000deadbeef"), defaults::list("verify_first.nudges").first().copied());
    assert_eq!(nudge_for("ffffffffdeadbeef"), defaults::list("verify_first.nudges").get(4_294_967_295usize % n).copied());
    assert_eq!(nudge_for("0000001400000000"), defaults::list("verify_first.nudges").first().copied(), "0x14 is twenty: back to the first line");
    assert_eq!(nudge_for("0000001300000000"), defaults::list("verify_first.nudges").get(19).copied());
    assert_eq!(nudge_for("zz"), None);
}

#[test]
fn only_a_session_that_could_be_a_devswarm_primary_is_left_to_node() {
    assert!(!primary_possible(&st(&[])));
    assert!(primary_possible(&st(&[("DEVSWARM_REPO_ID", "r")])));
    assert!(!primary_possible(&st(&[("DEVSWARM_REPO_ID", "r"), ("DEVSWARM_SOURCE_BRANCH", "b")])), "a child workspace is never a Primary");
    assert!(primary_possible(&st(&[("DEVSWARM_REPO_ID", "r"), ("DEVSWARM_SOURCE_BRANCH", "  ")])), "a blank branch is no branch");
    assert!(!primary_possible(&st(&[("DEVSWARM_REPO_ID", "  ")])));
    assert!(!primary_possible(&st(&[("DEVSWARM_REPO_ID", "r"), ("DISABLE_ANTIHALL_DEVSWARM", "1")])));
    assert!(primary_possible(&st(&[("DEVSWARM_REPO_ID", "r"), ("DISABLE_ANTIHALL_DEVSWARM", "yes")])), "only the exact value 1 kills it");
    assert!(!primary_possible(&st(&[("DEVSWARM_REPO_ID", "r"), ("ANTIHALL_DEVSWARM_SUPERVISOR", " OFF ")])));
    assert!(primary_possible(&st(&[("ANTIHALL_DEVSWARM_SUPERVISOR", "on")])));
    assert!(!primary_possible(&st(&[("DEVSWARM_REPO_ID", "r"), ("ANTIHALL_DEVSWARM_DISPATCH_TIER_TEXT", "0")])));
}

#[test]
fn the_reminder_is_the_prefix_and_the_picked_line_and_repeats_only_every_n_turns() {
    let s = st(&[]);
    let p = json!({"session_id": "u", "prompt": "x"});
    let first = decide(&p, "00000000aaaa", &s, &renv(&s)).unwrap().expect("first reminder");
    assert_eq!(first, format!("VERIFY-FIRST: {}", defaults::list("verify_first.nudges")[0]));
    assert_eq!(decide(&p, "00000000aaaa", &s, &renv(&s)), Ok(None), "the same block within the window is suppressed");
    assert_eq!(decide(&json!({"prompt": "x"}), "00000000aaaa", &s, &renv(&s)).unwrap().as_deref(), Some(first.as_str()), "no session: always emitted");
}

#[test]
fn the_switch_off_is_silent_and_writes_nothing() {
    let s = st(&[("CLAUDE_PLUGIN_OPTION_CONTEXT_VERIFY_FIRST_TURN", "false")]);
    assert_eq!(decide(&json!({"session_id": "u"}), "00000000", &s, &renv(&s)), Ok(None));
    assert!(!std::path::Path::new(&s.home).join(".anti-hall").exists());
}

#[test]
fn the_check_answers_through_the_trait_and_defers_without_a_digest() {
    let env = RequestEnv::from_pairs([("HOME", st(&[]).home)]);
    let s = Subject { event: "UserPromptSubmit", tool: None, cwd: None, tool_input: &Value::Null, prompt: None };
    let p = json!({"session_id": "t", "prompt": "x"});
    assert_eq!(VerifyFirst.run_env(&s, &p, &Value::Null, &env), Some(Verdict::Defer));
    let got = VerifyFirst.run_env(&s, &p, &json!({"payload_sha1": "00000001"}), &env);
    assert!(
        matches!(got, Some(Verdict::Advisory(ref j)) if j.starts_with("{\"hookSpecificOutput\":{\"hookEventName\":\"UserPromptSubmit\",\"additionalContext\":\"VERIFY-FIRST: ")),
        "{got:?}"
    );
    let judge = RequestEnv::from_pairs([("HOME", "/nonexistent"), ("ANTIHALL_JUDGE_CHILD", "1")]);
    assert_eq!(VerifyFirst.run_env(&s, &p, &json!({"payload_sha1": "0"}), &judge), Some(Verdict::Allow));
}

#[test]
fn a_primary_gets_the_tier_sentence_unless_the_repo_forbids_workspaces() {
    let p = json!({"session_id": "pp", "prompt": "x", "cwd": "/tmp/anti-hall-no-such-dir"});
    let s = st(&[("DEVSWARM_REPO_ID", "r")]);
    let t = decide(&p, "00000000aaaa", &s, &renv(&s)).unwrap().unwrap();
    assert!(t.ends_with(defaults::text("verify_first.primary_nudge")), "{t}");
    let s = st(&[("DEVSWARM_REPO_ID", "r"), ("ANTIHALL_JEV_DISPATCH_TIER_NO_WORKSPACE_REPOS", "anti-hall-no-such-dir")]);
    let t = decide(&p, "00000000aaaa", &s, &renv(&s)).unwrap().unwrap();
    assert!(!t.contains("DEVSWARM PRIMARY"), "{t}");
    let s = st(&[("DEVSWARM_REPO_ID", "r")]);
    assert_eq!(decide(&json!({"session_id": "q"}), "00000000aaaa", &s, &renv(&s)), Err(Defer), "no working directory: Node uses its own");
    assert!(!std::path::Path::new(&s.home).join(".anti-hall").exists(), "a deferral writes nothing");
}
