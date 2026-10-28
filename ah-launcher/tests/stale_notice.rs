//! #368: an installed engine older than the plugin's pin (`ah-engine.lock`) gets ONE notice per session that names the fix
//! (`ah-hook install`); the hook itself still runs. The installed version is the installer's marker. Scratch HOME and plugin
//! root only.
#![allow(clippy::unwrap_used, clippy::expect_used)]

mod common;

use common::*;

const PAYLOAD_S1: &[u8] =
    b"{\"session_id\":\"s-1\",\"tool_name\":\"Bash\",\"tool_input\":{\"command\":\"ls\"}}";
const PAYLOAD_S2: &[u8] =
    b"{\"session_id\":\"s-2\",\"tool_name\":\"Bash\",\"tool_input\":{\"command\":\"ls\"}}";

fn setup(tag: &str, pinned: &str, installed: Option<&str>) -> Env {
    let env = Env::new(tag);
    std::fs::write(
        env.root.join("ah-engine.lock"),
        format!("{{\"schema\":1,\"version\":\"{pinned}\",\"assets\":{{}}}}"),
    )
    .unwrap();
    if let Some(v) = installed {
        std::fs::create_dir_all(&env.state).unwrap();
        std::fs::write(
            env.state.join("bootstrap.installed"),
            format!("{v} aa bb cc\n"),
        )
        .unwrap();
    }
    env
}

fn fake(env: &Env) -> std::path::PathBuf {
    env.script("engine.sh", "cat >/dev/null\nexit 0")
}

#[test]
fn older_install_gets_one_line_naming_the_fix_once_per_session() {
    let env = setup("stale1", "0.2.1", Some("0.2.0"));
    let e = fake(&env);
    let o = env.run("PreToolUse", PAYLOAD_S1, Some(&e), &[]);
    assert_eq!(o.code, 0, "{}", o.err);
    let lines: Vec<&str> = o
        .err
        .lines()
        .filter(|l| l.contains("ah-hook install"))
        .collect();
    assert_eq!(lines.len(), 1, "{}", o.err);
    assert!(
        lines[0].contains("0.2.0") && lines[0].contains("0.2.1"),
        "{}",
        o.err
    );
    // same session: silent
    let o = env.run("PreToolUse", PAYLOAD_S1, Some(&e), &[]);
    assert!(!o.err.contains("ah-hook install"), "{}", o.err);
    // next session: again
    let o = env.run("PreToolUse", PAYLOAD_S2, Some(&e), &[]);
    assert!(o.err.contains("ah-hook install"), "{}", o.err);
}

#[test]
fn old_plugin_numbering_counts_as_older() {
    let env = setup("stale_legacy", "0.2.1", Some("0.301.1"));
    let e = fake(&env);
    let o = env.run("PreToolUse", PAYLOAD_S1, Some(&e), &[]);
    assert!(o.err.contains("ah-hook install"), "{}", o.err);
}

#[test]
fn matching_newer_or_unknown_install_is_silent() {
    for (tag, pinned, have) in [
        ("same", "0.2.1", Some("0.2.1")),
        ("newer", "0.2.1", Some("0.3.0")),
        ("nomarker", "0.2.1", None),
        ("junk", "0.2.1", Some("garbage")),
    ] {
        let env = setup(tag, pinned, have);
        let e = fake(&env);
        let o = env.run("PreToolUse", PAYLOAD_S1, Some(&e), &[]);
        assert!(!o.err.contains("ah-hook install"), "{tag}: {}", o.err);
    }
}

#[test]
fn no_lock_is_silent() {
    let env = setup("nolock", "0.2.1", Some("0.2.0"));
    std::fs::remove_file(env.root.join("ah-engine.lock")).unwrap();
    let e = fake(&env);
    let o = env.run("PreToolUse", PAYLOAD_S1, Some(&e), &[]);
    assert!(!o.err.contains("ah-hook install"), "{}", o.err);
}

#[test]
fn setting_off_silences_it() {
    let env = setup("off", "0.2.1", Some("0.2.0"));
    env.set("launcher.stale_notice_on", "0");
    let e = fake(&env);
    let o = env.run("PreToolUse", PAYLOAD_S1, Some(&e), &[]);
    assert!(!o.err.contains("ah-hook install"), "{}", o.err);
}

#[test]
fn the_hook_still_reaches_the_engine() {
    let env = setup("passes", "0.2.1", Some("0.2.0"));
    let e = env.script(
        "engine.sh",
        "echo ran >>ARGS\ncat >/dev/null\nexit 0"
            .replace("ARGS", env.path("ran").to_str().unwrap())
            .as_str(),
    );
    let o = env.run("PreToolUse", PAYLOAD_S1, Some(&e), &[]);
    assert_eq!(o.code, 0, "{}", o.err);
    assert!(env.read("ran").contains("ran"), "engine not run: {}", o.err);
}

#[test]
fn the_codex_host_gets_the_same_notice() {
    let env = setup("codex", "0.2.1", Some("0.2.0"));
    let e = fake(&env);
    let o = env.run_args(
        "PreToolUse",
        &["--host", "codex"],
        PAYLOAD_S1,
        Some(&e),
        &[],
    );
    assert!(o.err.contains("ah-hook install"), "{}", o.err);
}
