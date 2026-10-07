//! Unit tests of the DevSwarm role checks. The Node-vs-engine comparison is `tests/devswarm_role_parity.rs`.
use super::*;
use crate::checks::git::util::Settings;
use std::collections::HashMap;

fn home(tag: &str) -> String {
    let d = std::env::temp_dir().join(format!("ah-dsr-{tag}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&d);
    std::fs::create_dir_all(d.join(".anti-hall")).unwrap();
    d.canonicalize().unwrap().to_string_lossy().to_string()
}

fn env(h: &str, extra: &[(&str, &str)]) -> RequestEnv {
    let mut p: Vec<(String, String)> = vec![("HOME".into(), h.into())];
    p.extend(extra.iter().map(|(k, v)| (k.to_string(), v.to_string())));
    RequestEnv::from_pairs(p)
}

fn st(h: &str, extra: &[(&str, &str)]) -> Settings {
    Settings { home: h.to_string(), env: extra.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect::<HashMap<_, _>>() }
}

#[test]
fn fill_once_never_refills_a_value_and_keeps_foreign_braces() {
    assert_eq!(text::fill_once("a {x} b {y} {z}", &[("x", "{y}"), ("y", "Y")]), "a {y} b Y {z}");
    assert_eq!(text::fill_once("function () { return {x}; } {", &[("x", "1")]), "function () { return 1; } {");
    assert_eq!(text::fill_once("é{x}é", &[("x", "\u{1f600}")]), "é\u{1f600}é");
}

#[test]
fn the_manifest_default_of_the_supervisor_mode_is_the_one_the_check_compares_with() {
    // `get_enum` treats the plugin option equal to the entry default as unset; the Node reader compares with the
    // manifest's own default, so the two must be the same word.
    let manifest = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/../plugins/anti-hall/.claude-plugin/plugin.json")).unwrap();
    let v: Value = serde_json::from_str(&manifest).unwrap();
    let entry = defaults::raw("devswarm_role.sw_supervisor_mode");
    assert_eq!(v["userConfig"][entry.str_field("option")]["default"].as_str(), Some(entry.str_field("default")));
}

#[test]
fn supervisor_mode_follows_env_then_file_then_option_then_default() {
    let h = home("mode");
    let e = defaults::raw("devswarm_role.sw_supervisor_mode");
    assert_eq!(settings::get_enum(&st(&h, &[]), e), "auto");
    assert_eq!(settings::get_enum(&st(&h, &[("ANTIHALL_DEVSWARM_SUPERVISOR", " ON ")]), e), "on");
    assert_eq!(settings::get_enum(&st(&h, &[("ANTIHALL_DEVSWARM_SUPERVISOR", "bogus")]), e), "auto");
    assert_eq!(settings::get_enum(&st(&h, &[("CLAUDE_PLUGIN_OPTION_DEVSWARM_SUPERVISOR_MODE", "off")]), e), "off");
    std::fs::write(format!("{h}/.anti-hall/settings.json"), r#"{"devswarm":{"supervisorMode":"On"}}"#).unwrap();
    assert_eq!(settings::get_enum(&st(&h, &[]), e), "on");
    assert_eq!(settings::get_enum(&st(&h, &[("ANTIHALL_DEVSWARM_SUPERVISOR", "off")]), e), "off", "the environment outranks the file");
    assert_eq!(settings::get_enum(&st(&h, &[("CLAUDE_PLUGIN_OPTION_DEVSWARM_SUPERVISOR_MODE", "off")]), e), "on", "the file outranks the option");
}

#[test]
fn an_option_variable_that_is_present_decides_even_when_it_names_no_mode() {
    let h = home("optdecides");
    std::fs::create_dir_all(format!("{h}/.claude")).unwrap();
    std::fs::write(format!("{h}/.claude/settings.json"), r#"{"pluginConfigs":{"anti-hall":{"devswarm_supervisor_mode":"off"}}}"#).unwrap();
    let e = defaults::raw("devswarm_role.sw_supervisor_mode");
    assert_eq!(settings::get_enum(&st(&h, &[]), e), "off");
    assert_eq!(settings::get_enum(&st(&h, &[("CLAUDE_PLUGIN_OPTION_DEVSWARM_SUPERVISOR_MODE", "garbage")]), e), "auto");
    assert_eq!(settings::get_enum(&st(&h, &[("CLAUDE_PLUGIN_OPTION_DEVSWARM_SUPERVISOR_MODE", "auto")]), e), "auto");
}

#[test]
fn the_wake_cron_keeps_only_a_clean_five_field_schedule() {
    let h = home("cron");
    let c = |v: &str| settings::wake_cron(&st(&h, &[("ANTIHALL_DEVSWARM_WAKE_CRON", v)]));
    assert_eq!(c("*/5 * * * *"), "*/5 * * * *");
    assert_eq!(c("  1  2\t3 4\u{a0}5 "), "1 2 3 4 5");
    for bad in ["", "   ", "1 2 3 4", "1 2 3 4 5 6", "*/5 * * * *`x`", "a b c d e", "1 2 3 4 5;"] {
        assert_eq!(c(bad), "7,37 * * * *", "{bad:?}");
    }
}

#[test]
fn the_gate_allows_only_where_node_exits_before_reading_a_mailbox() {
    let h = home("gate");
    let repo = [("DEVSWARM_REPO_ID", "r")];
    assert_eq!(parent_gate(&env(&h, &repo)), Verdict::Defer, "an active Primary may be blocked: Node decides");
    assert_eq!(parent_gate(&env(&h, &[])), Verdict::Allow, "no DevSwarm");
    assert_eq!(parent_gate(&env(&h, &[("DEVSWARM_REPO_ID", "r"), ("DEVSWARM_SOURCE_BRANCH", "b")])), Verdict::Allow, "a child");
    assert_eq!(parent_gate(&env(&h, &[("DEVSWARM_REPO_ID", "r"), ("ANTIHALL_JUDGE_CHILD", "1")])), Verdict::Allow);
    assert_eq!(parent_gate(&env(&h, &[("DEVSWARM_REPO_ID", "r"), ("DISABLE_ANTIHALL_DEVSWARM", "1")])), Verdict::Allow);
    assert_eq!(parent_gate(&RequestEnv::from_pairs([("DEVSWARM_REPO_ID", "r")])), Verdict::Defer, "no home: Node would use another one");
    assert_eq!(parent_gate(&RequestEnv::default()), Verdict::Defer);
}

#[test]
fn the_gate_never_allows_on_an_unreadable_or_odd_switch() {
    let h = home("gateodd");
    let e = env(&h, &[("DEVSWARM_REPO_ID", "r")]);
    for body in ["{oops", "[]", r#"{"devswarm":{"parentGate":"perhaps"}}"#, r#"{"devswarm":{"parentGate":true}}"#, r#"{"devswarm":null}"#] {
        std::fs::write(format!("{h}/.anti-hall/settings.json"), body).unwrap();
        assert_eq!(parent_gate(&e), Verdict::Defer, "{body}");
    }
    std::fs::write(format!("{h}/.anti-hall/settings.json"), r#"{"devswarm":{"parentGate":false}}"#).unwrap();
    assert_eq!(parent_gate(&e), Verdict::Allow);
}

#[test]
fn a_skip_allows_but_an_expired_or_foreign_one_does_not() {
    let h = home("skip");
    let e = env(&h, &[("DEVSWARM_REPO_ID", "r")]);
    let future = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis() as u64 + 3_600_000;
    for (body, want) in [
        (format!(r#"{{"devswarm-parent-gate":{future}}}"#), Verdict::Allow),
        (format!(r#"{{"all":{future}}}"#), Verdict::Allow),
        (format!(r#"{{"git-guard":{future}}}"#), Verdict::Defer),
        (r#"{"devswarm-parent-gate":5}"#.to_string(), Verdict::Defer),
        ("not json".to_string(), Verdict::Defer),
    ] {
        std::fs::write(format!("{h}/.anti-hall/skip.json"), &body).unwrap();
        assert_eq!(parent_gate(&e), want, "{body}");
    }
}

#[test]
fn the_child_role_without_a_plugin_root_or_for_a_primary_defers() {
    let h = home("child");
    let e = env(&h, &[("DEVSWARM_REPO_ID", "r"), ("DEVSWARM_SOURCE_BRANCH", "b")]);
    assert_eq!(child_role(&e, None), Verdict::Defer);
    assert_eq!(child_role(&e, Some("/nonexistent-plugin-root")), Verdict::Defer);
    assert_eq!(child_role(&env(&h, &[("ANTIHALL_JUDGE_CHILD", "1")]), None), Verdict::Allow, "the judge child exits before anything is read");
}

#[test]
fn both_checks_defer_when_run_without_the_request_environment() {
    let ti = Value::Null;
    let s = Subject { event: "Stop", tool: None, cwd: None, tool_input: &ti, prompt: None };
    assert_eq!(DevswarmParentGate.run(&s, &Value::Null), Some(Verdict::Defer));
    assert_eq!(DevswarmChildRole.run(&s, &Value::Null), Some(Verdict::Defer));
    let wrong = Subject { event: "PreToolUse", ..s };
    assert_eq!(DevswarmParentGate.run_env(&wrong, &Value::Null, &Value::Null, &RequestEnv::default()), Some(Verdict::Defer));
}
