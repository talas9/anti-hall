//! Unit tests of the edit-guard check. The full Node-vs-engine comparison is `parity/run-edit-guard.js`.
use super::*;
use serde_json::json;

fn home(tag: &str) -> String {
    let d = std::env::temp_dir().join(format!("ah-eg-{tag}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&d);
    std::fs::create_dir_all(d.join(".anti-hall/bin")).unwrap();
    std::fs::write(d.join(".anti-hall/bin/launcher.sh"), "x").unwrap();
    // canonical, as the launcher check compares real paths (the temp dir is a symlink on macOS)
    std::fs::canonicalize(&d).unwrap().to_string_lossy().to_string()
}

fn env(home: &str, entry: Option<&str>) -> RequestEnv {
    let mut pairs = vec![("HOME", home)];
    if let Some(e) = entry {
        pairs.push(("CLAUDE_CODE_ENTRYPOINT", e));
    }
    RequestEnv::from_pairs(pairs)
}

fn edit(file: &str, cwd: &str) -> Value {
    json!({"tool_name": "Edit", "cwd": cwd, "tool_input": {"file_path": file}})
}

fn blocked(v: &Verdict) -> &Exact {
    let Verdict::Exact(x) = v else { panic!("expected an exact block, got {v:?}") };
    x
}

#[test]
fn a_write_into_the_launcher_directory_is_blocked_for_every_agent_with_the_node_bytes() {
    let h = home("block");
    for entry in [Some("cli"), Some("agent_tool"), None] {
        let v = decide(&edit(&format!("{h}/.anti-hall/bin/x.sh"), &h), &env(&h, entry));
        let x = blocked(&v);
        assert_eq!(x.code, 2);
        assert!(x.err.is_empty(), "Claude reads the block from stdout alone");
        assert!(x.out.starts_with("{\"decision\":\"block\",\"reason\":\"\u{26d4} anti-hall \u{b7} edit-guard: Edit into ~/.anti-hall/bin/ (the stable launcher directory) is blocked.\\nWhy: "), "{}", x.out);
        assert!(x.out.ends_with("\\nAllowed here: the rest of .anti-hall/** (handovers, progress, history, state).\"}\n"), "{}", x.out);
    }
}

#[test]
fn spellings_that_reach_the_launcher_directory_are_blocked_and_the_rest_are_not() {
    let h = home("paths");
    let e = env(&h, Some("agent_tool"));
    for f in [
        ".anti-hall/bin/x.sh",
        "./.anti-hall/bin",
        ".anti-hall/bin/",
        "proj/../.anti-hall/bin/y",
        &format!("{h}/.anti-hall/bin"),
        &format!("{h}//.anti-hall//bin//z"),
        &format!("{h}/.anti-hall\\bin\\z"),
    ] {
        assert!(matches!(decide(&edit(f, &h), &e), Verdict::Exact(_)), "{f}");
    }
    for f in [".anti-hall/other", ".anti-hall/binx/x", "bin/x", "", "/etc/passwd", &format!("{h}/.anti-hall/BIN/x")] {
        assert_eq!(decide(&edit(f, &h), &e), Verdict::Allow, "{f:?}");
    }
}

#[test]
fn a_symlink_that_already_exists_is_followed_and_a_missing_leaf_is_not() {
    let h = home("link");
    std::os::unix::fs::symlink(format!("{h}/.anti-hall/bin"), format!("{h}/lnk")).unwrap();
    let e = env(&h, Some("agent_tool"));
    assert!(matches!(decide(&edit("lnk/launcher.sh", &h), &e), Verdict::Exact(_)));
    assert_eq!(decide(&edit("lnk/not-there.sh", &h), &e), Verdict::Allow, "Node's realpath throws on a missing leaf, so only the literal test applies");
}

#[test]
fn past_the_launcher_check_only_the_main_thread_is_deferred() {
    let h = home("coord");
    let p = edit("src/main.rs", &h);
    assert_eq!(decide(&p, &env(&h, Some("cli"))), Verdict::Defer, "main thread");
    assert_eq!(decide(&p, &env(&h, Some("terminal_ide_x"))), Verdict::Defer);
    assert_eq!(decide(&p, &env(&h, Some("agent_tool"))), Verdict::Allow, "subagent entry point");
    assert_eq!(decide(&p, &env(&h, Some("sdk-ts"))), Verdict::Allow, "unknown entry point");
    assert_eq!(decide(&p, &env(&h, None)), Verdict::Allow, "no entry point");
    let mut sub = p.clone();
    sub["agent_id"] = json!("a1");
    assert_eq!(decide(&sub, &env(&h, Some("cli"))), Verdict::Allow, "subagent marker");
}

#[test]
fn what_the_engine_cannot_see_defers() {
    let h = home("defer");
    let e = env(&h, Some("agent_tool"));
    let patch = json!({"tool_name": "apply_patch", "tool_input": {"command": "*** Begin Patch\n*** End Patch"}});
    assert_eq!(decide(&patch, &e), Verdict::Defer, "no patch parser");
    assert_eq!(decide(&edit("x.sh", "rel/dir"), &e), Verdict::Defer, "a relative cwd resolves against the hook's own directory");
    assert_eq!(decide(&json!({"tool_name": "Edit", "tool_input": {"file_path": "x.sh"}}), &e), Verdict::Defer, "no cwd");
    assert_eq!(decide(&json!({"tool_name": "Edit", "tool_input": {"file_path": "/x.sh"}}), &e), Verdict::Allow, "an absolute path needs no cwd");
    assert_eq!(decide(&json!({"tool_name": "Edit", "cwd": h, "tool_input": {"file_path": ["a"]}}), &e), Verdict::Defer, "an array path");
    assert_eq!(
        decide(&edit("x.sh", &h), &RequestEnv::from_pairs([("CLAUDE_CODE_ENTRYPOINT", "agent_tool")])),
        Verdict::Defer,
        "no home directory: the environment may have been cut off"
    );
}

#[test]
fn other_tools_and_non_objects_are_allowed() {
    let h = home("other");
    let e = env(&h, Some("cli"));
    assert_eq!(decide(&json!({"tool_name": "Bash", "tool_input": {"command": "ls"}}), &e), Verdict::Allow);
    assert_eq!(decide(&json!(null), &e), Verdict::Allow);
    assert_eq!(decide(&json!("x"), &e), Verdict::Allow);
    assert_eq!(decide(&json!({"tool_name": 5}), &e), Verdict::Allow);
}

#[test]
fn the_switch_and_a_skip_allow() {
    let h = home("sw");
    let p = edit(&format!("{h}/.anti-hall/bin/x.sh"), &h);
    let off = RequestEnv::from_pairs([("HOME", h.as_str()), ("CLAUDE_CODE_ENTRYPOINT", "cli"), ("ANTIHALL_EDIT_GUARD", "off")]);
    assert_eq!(decide(&p, &off), Verdict::Allow);
    std::fs::write(format!("{h}/.anti-hall/skip.json"), r#"{"edit-guard": 99999999999999}"#).unwrap();
    assert_eq!(decide(&p, &env(&h, Some("cli"))), Verdict::Allow);
}

#[test]
fn the_notebook_tool_reads_its_own_path_field() {
    let h = home("nb");
    let e = env(&h, Some("agent_tool"));
    let nb = json!({"tool_name": "NotebookEdit", "cwd": h, "tool_input": {"notebook_path": ".anti-hall/bin/n.ipynb", "file_path": "ok.txt"}});
    assert!(matches!(decide(&nb, &e), Verdict::Exact(_)));
    let wrong = json!({"tool_name": "NotebookEdit", "cwd": h, "tool_input": {"file_path": ".anti-hall/bin/n.ipynb"}});
    assert_eq!(decide(&wrong, &e), Verdict::Allow);
}
