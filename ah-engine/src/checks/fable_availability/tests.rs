//! Unit tests of the fable-availability check. The full Node-vs-engine comparison is `tests/node_parity` (the Rust Node-parity test).
use super::*;
use serde_json::json;
use std::collections::HashMap;

fn home(tag: &str) -> String {
    let d = std::env::temp_dir().join(format!("ah-fa-{tag}-{}", std::process::id()));
    crate::discard::harmless(std::fs::remove_dir_all(&d));
    std::fs::create_dir_all(&d).unwrap();
    d.to_string_lossy().to_string()
}

fn st(home: &str, env: &[(&str, &str)]) -> Settings {
    Settings { home: home.into(), env: env.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect::<HashMap<_, _>>() }
}

fn state(home: &str) -> Value {
    serde_json::from_str(&std::fs::read_to_string(format!("{home}/.anti-hall/fable-availability.json")).unwrap()).unwrap()
}

#[test]
fn detection_follows_the_two_caches_in_order() {
    let u = Found { available: None, source: "unknown" };
    assert_eq!(
        detect(&json!({"modelAccessCache": [{"apiName": "claude-Fable-5", "entitled": true}]})),
        Found { available: Some(true), source: "modelAccessCache" }
    );
    assert_eq!(detect(&json!({"modelAccessCache": [{"apiName": "FABLE", "entitled": 1}]})).available, Some(false), "only true counts as entitled");
    assert_eq!(detect(&json!({"modelAccessCache": [{"apiName": "x"}, null, 3, "fable", {"apiName": "fable-1"}]})).available, Some(false));
    let both = json!({"modelAccessCache": [{"apiName": "fable", "entitled": false}], "additionalModelOptionsCache": [{"value": "fable"}]});
    assert_eq!(detect(&both), Found { available: Some(false), source: "modelAccessCache" }, "the first cache wins even when it says no");
    assert_eq!(
        detect(&json!({"additionalModelOptionsCache": [{"label": "My Fable"}]})),
        Found { available: Some(true), source: "additionalModelOptionsCache" }
    );
    assert_eq!(detect(&json!({"additionalModelOptionsCache": [{"model": "fable", "disabled": true}]})).available, Some(false));
    assert_eq!(
        detect(&json!({"additionalModelOptionsCache": [{"model": "fable", "disabled": "true"}]})).available,
        Some(true),
        "only the boolean true disables"
    );
    for none in [
        json!({}),
        json!(null),
        json!([1]),
        json!("fable"),
        json!({"modelAccessCache": "fable"}),
        json!({"modelAccessCache": [{"apiName": 5}]}),
        json!({"additionalModelOptionsCache": {"value": "fable"}}),
    ] {
        assert_eq!(detect(&none), u, "{none}");
    }
}

#[test]
fn every_run_writes_the_state_and_only_an_available_fable_speaks() {
    let h = home("run");
    std::fs::write(format!("{h}/.claude.json"), r#"{"modelAccessCache":[{"apiName":"fable","entitled":true}]}"#).unwrap();
    let before = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis() as u64;
    let Some(Verdict::Advisory(j)) = decide(&st(&h, &[])) else { panic!("expected the availability message") };
    let v: Value = serde_json::from_str(&j).unwrap();
    assert_eq!(v["hookSpecificOutput"]["hookEventName"], "SessionStart");
    let t = v["hookSpecificOutput"]["additionalContext"].as_str().unwrap();
    assert!(t.starts_with("\u{1f4a1} anti-hall \u{b7} fable-availability: Fable is available this session (per ~/.claude.json).\nWhy: "), "{t}");
    let s = state(&h);
    assert_eq!((&s["available"], &s["source"]), (&json!(true), &json!("modelAccessCache")));
    assert!(s["checkedAt"].as_u64().unwrap() >= before);
    let raw = std::fs::read_to_string(format!("{h}/.anti-hall/fable-availability.json")).unwrap();
    assert!(raw.starts_with("{\"available\":true,\"checkedAt\":") && raw.ends_with(",\"source\":\"modelAccessCache\"}"), "{raw}");

    std::fs::write(format!("{h}/.claude.json"), r#"{"modelAccessCache":[{"apiName":"fable","entitled":false}]}"#).unwrap();
    assert_eq!(decide(&st(&h, &[])), Some(Verdict::Allow));
    assert_eq!(state(&h)["available"], json!(false));
    std::fs::remove_file(format!("{h}/.claude.json")).unwrap();
    assert_eq!(decide(&st(&h, &[])), Some(Verdict::Allow));
    let s = state(&h);
    assert_eq!((&s["available"], &s["source"]), (&json!(null), &json!("unknown")));
}

#[test]
fn the_judge_child_neither_writes_nor_speaks_and_a_missing_home_defers() {
    let h = home("judge");
    std::fs::write(format!("{h}/.claude.json"), r#"{"modelAccessCache":[{"apiName":"fable","entitled":true}]}"#).unwrap();
    assert_eq!(decide(&st(&h, &[("ANTIHALL_JUDGE_CHILD", "1")])), Some(Verdict::Allow));
    assert!(!std::path::Path::new(&format!("{h}/.anti-hall")).exists());
    assert_eq!(decide(&st("", &[])), Some(Verdict::Defer));
}

#[test]
fn an_unwritable_state_directory_is_silent_even_when_fable_is_available() {
    let h = home("nowrite");
    std::fs::write(format!("{h}/.claude.json"), r#"{"modelAccessCache":[{"apiName":"fable","entitled":true}]}"#).unwrap();
    std::fs::write(format!("{h}/.anti-hall"), "a file where the directory should be").unwrap();
    assert_eq!(decide(&st(&h, &[])), Some(Verdict::Allow));
}

#[test]
fn lone_surrogate_escapes_are_read_and_unparsable_files_defer() {
    let h = home("surr");
    let cfg = |body: &str| std::fs::write(format!("{h}/.claude.json"), body).unwrap();
    cfg(r#"{"history":"cut \ud83d here","modelAccessCache":[{"apiName":"fable\udc00","entitled":true}],"ok":"pair \ud83d\ude00"}"#);
    assert!(matches!(decide(&st(&h, &[])), Some(Verdict::Advisory(_))));
    assert_eq!(fix_lone_surrogates(r#""\ud83d\ude00 \\ud800 \ud800x \udfff""#), r#""\ud83d\ude00 \\ud800 \uFFFDx \uFFFD""#);
    for bad in ["{", "", "\u{feff}{}", "{\"a\":1,}", "nul"] {
        cfg(bad);
        crate::discard::harmless(std::fs::remove_file(format!("{h}/.anti-hall/fable-availability.json")));
        assert_eq!(decide(&st(&h, &[])), Some(Verdict::Defer), "{bad:?}");
        assert!(!std::path::Path::new(&format!("{h}/.anti-hall/fable-availability.json")).exists(), "a deferral leaves the writing to Node");
    }
}
