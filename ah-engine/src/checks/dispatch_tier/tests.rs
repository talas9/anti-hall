use super::*;
use serde_json::json;

fn env(home: &str, extra: &[(&str, &str)]) -> RequestEnv {
    let mut pairs: Vec<(String, String)> = vec![("HOME".into(), home.into())];
    pairs.extend(extra.iter().map(|(k, v)| (k.to_string(), v.to_string())));
    RequestEnv::from_pairs(pairs)
}

#[test]
fn a_tool_that_is_not_a_task_tool_does_nothing() {
    for p in [json!({"tool_name": "Bash"}), json!({}), json!(null), json!({"tool_name": 5})] {
        assert_eq!(decide(&p, &env("/nonexistent-home", &[])), Verdict::Allow, "{p}");
    }
}

#[test]
fn jev_off_means_nothing_to_do_and_jev_on_defers() {
    let p = json!({"tool_name": "TaskCreate", "tool_input": {"subject": "x"}});
    assert_eq!(decide(&p, &env("/nonexistent-home", &[])), Verdict::Allow);
    assert_eq!(decide(&p, &env("/nonexistent-home", &[("ANTIHALL_JEV", "1")])), Verdict::Defer);
    assert_eq!(decide(&p, &env("/nonexistent-home", &[("ANTIHALL_JEV", "1"), ("ANTIHALL_JEV_DISPATCH_TIER", "0")])), Verdict::Allow);
    assert_eq!(decide(&p, &RequestEnv::default()), Verdict::Defer, "no home: Node resolves it itself");
}
