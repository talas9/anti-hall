//! The Node fallback of the launcher (`fallback.node` marker set): the launcher runs the Node backup hooks itself, no shell, no
//! engine. A fake `node` (a shell script on PATH that runs its script argument) stands in for Node so the tests need no Node.

mod common;

use common::*;
use std::path::PathBuf;

const CP: &str = "${CLAUDE_PLUGIN_ROOT}/../anti-hall-node/hooks";

struct Fb {
    env: Env,
    node_dir: PathBuf,
    bin: PathBuf,
}

impl Fb {
    /// A scratch install: plugin root, a sibling Node backup directory with the list, a fake `node`, the fallback marker on.
    fn new(tag: &str, list: &str) -> Fb {
        let env = Env::new(tag);
        let node_dir = env.dir.join("anti-hall-node");
        std::fs::create_dir_all(node_dir.join("hooks")).unwrap();
        std::fs::write(node_dir.join("hooks/ah-fallback.list"), list).unwrap();
        let bin = env.dir.join("bin");
        std::fs::create_dir_all(&bin).unwrap();
        let node = bin.join("node");
        std::fs::write(&node, "#!/bin/sh\nexec /bin/sh \"$@\"\n").unwrap();
        std::fs::set_permissions(&node, std::os::unix::fs::PermissionsExt::from_mode(0o755))
            .unwrap();
        std::fs::create_dir_all(&env.state).unwrap();
        std::fs::write(env.state.join("fallback.node"), "").unwrap();
        Fb { env, node_dir, bin }
    }

    fn hook(&self, name: &str, body: &str) {
        std::fs::write(self.node_dir.join("hooks").join(name), format!("{body}\n")).unwrap();
    }

    fn run(&self, event: &str, payload: &str) -> Out {
        let path = format!("{}:/usr/bin:/bin", self.bin.display());
        // an engine that would record a start: the fallback must not ask it
        let engine = self.env.script(
            "engine.sh",
            &format!(
                "echo ran >>{}\nexit 0",
                self.env.path("engine-ran").display()
            ),
        );
        self.env
            .run(event, payload.as_bytes(), Some(&engine), &[("PATH", &path)])
    }

    fn ledger(&self) -> Vec<serde_json::Value> {
        std::fs::read_to_string(self.env.state.join("shadow.ndjson"))
            .unwrap_or_default()
            .lines()
            .map(|l| serde_json::from_str(l).unwrap())
            .collect()
    }
}

const PUSH: &str = r#"{"session_id":"s","tool_name":"Bash","tool_input":{"command":"git push --force origin main"}}"#;

#[test]
fn a_force_push_through_the_node_guard_blocks_and_writes_a_ledger_row() {
    let fb = Fb::new(
        "nb-block",
        &format!("@PreToolUse\t10\nBash\t10\tnode \"{CP}/git-guard.js\"\n"),
    );
    fb.hook(
        "git-guard.js",
        "cat >/dev/null\necho 'force push refused' >&2\nexit 2",
    );
    let o = fb.run("PreToolUse", PUSH);
    assert_eq!(o.code, 2, "{}", o.err);
    assert!(o.err.contains("force push refused"), "{}", o.err);
    assert!(
        !fb.env.path("engine-ran").exists(),
        "the engine is bypassed"
    );
    let rows = fb.ledger();
    assert_eq!(rows.len(), 1, "{rows:?}");
    assert_eq!(rows[0]["src"], "node");
    assert_eq!(rows[0]["chk"], "git-guard");
    assert_eq!(rows[0]["v"], "block");
    assert_eq!(rows[0]["ev"], "PreToolUse");
    assert_eq!(rows[0]["tool"], "Bash");
}

#[test]
fn a_missing_node_directory_is_one_notice_and_the_switch_does_nothing() {
    let fb = Fb::new("nb-nodir", "@PreToolUse\t10\nBash\t10\tnode \"x\"\n");
    std::fs::rename(&fb.node_dir, fb.env.dir.join("moved-away")).unwrap();
    let o = fb.run("PreToolUse", PUSH);
    assert_eq!(o.code, 0, "{}", o.err);
    // the Node notice comes first; the call then takes the normal path (no engine here, so its own single notice follows)
    assert!(
        o.err
            .lines()
            .next()
            .is_some_and(|l| l.contains("Node backup directory") && l.contains("anti-hall-node")),
        "{}",
        o.err
    );
    assert_eq!(
        o.err.matches("Node backup directory").count(),
        1,
        "{}",
        o.err
    );
    assert!(fb.ledger().is_empty());
}

#[test]
fn the_json_answers_of_two_hooks_are_merged_with_the_dispatch_joiners() {
    let fb = Fb::new(
        "nb-merge",
        &format!("@UserPromptSubmit\t10\n*\t10\tnode \"{CP}/a.js\"\n*\t10\tnode \"{CP}/b.js\"\n"),
    );
    fb.hook(
        "a.js",
        r#"cat >/dev/null
echo '{"systemMessage":"one","hookSpecificOutput":{"hookEventName":"UserPromptSubmit","additionalContext":"A"}}'"#,
    );
    fb.hook(
        "b.js",
        r#"cat >/dev/null
echo '{"systemMessage":"two","hookSpecificOutput":{"hookEventName":"UserPromptSubmit","additionalContext":"B"}}'"#,
    );
    let o = fb.run("UserPromptSubmit", r#"{"session_id":"s","prompt":"hi"}"#);
    assert_eq!(o.code, 0, "{}", o.err);
    let text = String::from_utf8(o.out).unwrap();
    assert_eq!(text.lines().count(), 1, "ONE json object: {text}");
    let v: serde_json::Value = serde_json::from_str(&text).unwrap();
    assert_eq!(v["hookSpecificOutput"]["additionalContext"], "A\n\nB");
    assert_eq!(v["systemMessage"], "one\ntwo");
    assert_eq!(v["hookSpecificOutput"]["hookEventName"], "UserPromptSubmit");
    assert_eq!(fb.ledger().iter().filter(|r| r["v"] == "advise").count(), 2);
}

#[test]
fn a_hook_past_its_row_timeout_is_skipped_logged_and_the_next_one_still_runs() {
    let fb = Fb::new(
        "nb-timeout",
        &format!(
            "@PreToolUse\t10\nBash\t1\tnode \"{CP}/slow.js\"\nBash\t10\tnode \"{CP}/ok.js\"\n"
        ),
    );
    fb.hook("slow.js", "cat >/dev/null\nsleep 30");
    fb.hook("ok.js", "cat >/dev/null\nexit 0");
    let o = fb.run("PreToolUse", PUSH);
    assert_eq!(o.code, 0, "{}", o.err);
    assert!(
        o.ms < 12_000,
        "the slow hook was cut at its row timeout, took {} ms",
        o.ms
    );
    let rows = fb.ledger();
    assert_eq!(rows.len(), 2, "{rows:?}");
    assert_eq!(
        (
            rows[0]["chk"].as_str(),
            rows[0]["v"].as_str(),
            rows[0]["err"].as_str()
        ),
        (Some("slow"), Some("timeout"), Some("timeout"))
    );
    assert_eq!(
        (rows[1]["chk"].as_str(), rows[1]["v"].as_str()),
        (Some("ok"), Some("allow"))
    );
}

#[test]
fn a_shell_row_is_never_started_and_counts_as_a_no_op() {
    let fb = Fb::new(
        "nb-nosh",
        "@PreToolUse\t10\n*\t10\tsh \"${CLAUDE_PLUGIN_ROOT}/hooks/noop\"\n",
    );
    let marker = fb.env.path("noop-ran");
    std::fs::write(
        fb.env.root.join("hooks/noop"),
        format!("touch {}\nexit 0\n", marker.display()),
    )
    .unwrap();
    let o = fb.run("PreToolUse", PUSH);
    assert_eq!(o.code, 0, "{}", o.err);
    assert!(!marker.exists(), "the launcher starts no shell");
    assert!(fb.ledger().is_empty());
}

#[test]
fn a_guard_event_fails_closed_when_a_hook_dies_and_nothing_blocked() {
    let fb = Fb::new(
        "nb-died",
        &format!("@PreToolUse\t10\nBash\t10\tnode \"{CP}/crash.js\"\n"),
    );
    fb.hook("crash.js", "cat >/dev/null\nkill -9 $$");
    let o = fb.run("PreToolUse", PUSH);
    assert_eq!(o.code, 2, "{}", o.err);
    assert!(o.err.contains("fail closed"), "{}", o.err);
    assert_eq!(fb.ledger()[0]["v"], "error");
}

#[test]
fn rows_of_other_tools_do_not_run_and_a_json_block_is_the_whole_answer() {
    let fb = Fb::new(
        "nb-match",
        &format!(
            "@PreToolUse\t10\nRead\t10\tnode \"{CP}/read.js\"\nBash|Edit\t10\tnode \"{CP}/deny.js\"\n"
        ),
    );
    let marker = fb.env.path("read-ran");
    fb.hook("read.js", &format!("touch {}\nexit 0", marker.display()));
    fb.hook(
        "deny.js",
        r#"cat >/dev/null
echo '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"no"}}'"#,
    );
    let o = fb.run("PreToolUse", PUSH);
    assert_eq!(o.code, 0, "{}", o.err);
    assert!(!marker.exists(), "the Read row does not match a Bash call");
    assert!(
        String::from_utf8_lossy(&o.out).contains("permissionDecision"),
        "{}",
        String::from_utf8_lossy(&o.out)
    );
    assert_eq!(fb.ledger()[0]["v"], "block");
}
