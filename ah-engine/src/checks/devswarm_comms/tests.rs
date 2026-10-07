//! Unit tests of the devswarm-comms-guard check; the Node-vs-engine comparison is `tests/port_guards_parity.rs`.
use super::*;
use serde_json::json;
use std::collections::HashMap;

fn home(tag: &str) -> String {
    let d = std::env::temp_dir().join(format!("ah-comms-{tag}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&d);
    std::fs::create_dir_all(d.join(".claude/sessions")).unwrap();
    std::fs::create_dir_all(d.join(".anti-hall")).unwrap();
    d.to_string_lossy().to_string()
}

fn st(home: &str, extra: &[(&str, &str)]) -> Settings {
    let mut env: HashMap<String, String> = HashMap::new();
    env.insert("HOME".into(), home.into());
    env.insert("DEVSWARM_REPO_ID".into(), "r".into());
    for (k, v) in extra {
        env.insert((*k).into(), (*v).into());
    }
    Settings { home: home.into(), env }
}

fn send(to: &str) -> Value {
    json!({"tool_name": "SendMessage", "tool_input": {"to": to}})
}

fn session(home: &str, file: &str, name: &str, cwd: &str) {
    std::fs::write(format!("{home}/.claude/sessions/{file}"), json!({"name": name, "cwd": cwd}).to_string()).unwrap();
}

#[test]
fn a_reference_suffix_is_stripped_and_a_bare_name_is_kept() {
    assert_eq!(strip_ref("fix-login-9f [9b8fa3]"), "fix-login-9f");
    assert_eq!(strip_ref("name"), "name");
    assert_eq!(strip_ref("name [abc]"), "name [abc]");
    assert_eq!(strip_ref("a\nb [abcd1234]"), "a\nb [abcd1234]");
}

#[test]
fn the_workspace_test_is_a_path_prefix_not_a_string_prefix() {
    let h = "/home/u";
    assert_eq!(is_workspace_path(h, "/home/u/.devswarm/repos"), Ok(true));
    assert_eq!(is_workspace_path(h, "/home/u/.devswarm/repos/0/a/"), Ok(true));
    assert_eq!(is_workspace_path(h, "/home/u/.devswarm/repos2/x"), Ok(false));
    assert_eq!(is_workspace_path(h, "/home/u/.devswarm/repos/../x"), Ok(false));
    assert_eq!(is_workspace_path(h, ""), Ok(false));
    assert_eq!(is_workspace_path(h, "rel/dir"), Err(()));
}

#[test]
fn the_first_session_file_in_name_order_wins() {
    let h = home("order");
    session(&h, "b.json", "dup", "/second");
    session(&h, "a.json", "dup", "/first");
    assert_eq!(find_session(&h, "dup").as_deref(), Some("/first"));
    assert_eq!(find_session(&h, "none"), None);
}

#[test]
fn a_workspace_peer_is_blocked_with_the_node_bytes_and_a_background_agent_is_not() {
    let h = home("block");
    session(&h, "1.json", "peer", &format!("{h}/.devswarm/repos/0/x"));
    let Some(Verdict::Exact(x)) = decide(&send("peer"), &st(&h, &[]), "") else { panic!("expected a block") };
    assert_eq!(x.code, 2);
    assert!(x.err.is_empty() && x.out.starts_with("{\"decision\":\"block\",\"reason\":\"\u{26d4} anti-hall \u{b7} devswarm-comms-guard: "));
    assert!(decide(&send("a6042fcc9b2813dac"), &st(&h, &[]), "").is_none());
    assert!(decide(&send("peer"), &st(&h, &[("ANTIHALL_DEVSWARM_SUPERVISOR", "off")]), "").is_none());
}

#[test]
fn an_unknown_home_defers() {
    let s = Settings { home: String::new(), env: HashMap::new() };
    assert_eq!(decide(&send("x"), &s, ""), Some(Verdict::Defer));
}
