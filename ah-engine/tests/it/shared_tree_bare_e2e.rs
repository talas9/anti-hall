//! `guards.sharedTreeBareClone` (GH #487) through the real hook: `ah-engine hook --event PreToolUse --host claude` on a spawn payload.
//! A bare "use ~/x as the working copy" exempts the shared-tree note; any negation in the same clause keeps it (fail safe).
use super::spawn_budget::{put, scratch};
use serde_json::json;
use std::io::Write;
use std::path::Path;
use std::process::{Command, Stdio};

/// One spawn with `prompt` through the real hook: stdout. Another async writer is running in the transcript; the cap is off.
fn spawn_prompt(home: &Path, switch: bool, prompt: &str) -> String {
    let proj = home.join("proj");
    put(&proj, ".git/HEAD", "ref: refs/heads/main\n");
    put(home, ".anti-hall/settings.json", &format!(r#"{{"guards":{{"maxConcurrentAgents":0,"sharedTreeBareClone":{switch}}}}}"#));
    let launch = json!({"type":"assistant","message":{"content":[{"type":"tool_use","id":"toolu_1","name":"Agent","input":{"description":"lane","subagent_type":"general-purpose","prompt":"fix it"}}]}});
    let result = json!({"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"toolu_1",
        "content":"Async agent launched successfully.\nagentId: a1b2c3d4e5f60718 (internal ID - do not mention to user)\noutput_file: /tmp/ah-none/a1b2c3d4e5f60718.output"}]}});
    put(home, "t.jsonl", &format!("{launch}\n{result}\n"));
    let payload = json!({"hook_event_name":"PreToolUse","tool_name":"Agent","session_id":"s","cwd":proj,"transcript_path":home.join("t.jsonl"),
        "tool_input":{"subagent_type":"general-purpose","model":"sonnet","prompt":prompt}});
    let mut c = Command::new(env!("CARGO_BIN_EXE_ah-engine"));
    c.args(["hook", "--event", "PreToolUse", "--host", "claude"])
        .env_clear()
        .env("PATH", std::env::var("PATH").unwrap_or_default())
        .env("HOME", home)
        .env("USERPROFILE", home)
        .env("ANTIHALL_TEST_ISOLATION", "1")
        .env("AH_ENGINE_DIR", home.join("engine-state"))
        .env("AH_ENGINE_NOSPAWN", "1")
        .env("AH_ENGINE_DISPATCH_IN_PROCESS", "1")
        .env("AH_ENGINE_PLUGIN_ROOT", Path::new(env!("CARGO_MANIFEST_DIR")).join("../plugins/anti-hall"))
        .current_dir(home)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut ch = c.spawn().unwrap();
    ch.stdin.take().unwrap().write_all(payload.to_string().as_bytes()).unwrap();
    let o = ch.wait_with_output().unwrap();
    assert_eq!(o.status.code(), Some(0), "an advisory never blocks: {}", String::from_utf8_lossy(&o.stderr));
    String::from_utf8_lossy(&o.stdout).into_owned()
}

#[test]
fn a_negation_in_the_clause_keeps_the_shared_tree_note_through_the_real_hook() {
    let h = scratch("bare-neg");
    for prompt in [
        "Do not actually use ~/x as the working copy; fix hooks/foo.js and commit.",
        "Do not under any circumstances use ~/x as the working copy; fix hooks/foo.js and commit.",
        "Use ~/x as the working copy, not the session tree; fix hooks/foo.js and commit.",
    ] {
        let out = spawn_prompt(&h, true, prompt);
        assert!(out.contains("another agent is already writing in this working tree"), "switch on, negated clause keeps the note: {prompt}: {out}");
    }
    for prompt in ["Use ~/x as the working copy; fix hooks/foo.js and commit.", "Do not push. Clone fresh into ~/x and build; fix hooks/foo.js and commit."] {
        assert_eq!(spawn_prompt(&h, true, prompt), "", "switch on, an affirmative clause is exempt: {prompt}");
        let off = spawn_prompt(&h, false, prompt);
        assert!(off.contains("another agent is already writing in this working tree"), "switch off keeps the note: {prompt}: {off}");
    }
}

/// The three P1 inputs of the round-2 review, byte for byte, plus the repeated affirmative: through the real hook, switch on keeps the
/// note for the negated ones (as switch off does) and exempts the repeated affirmative statement.
#[test]
fn the_reviewed_class_inputs_keep_the_shared_tree_note_through_the_real_hook() {
    let h = scratch("bare-class");
    let warn = "another agent is already writing in this working tree";
    for prompt in [
        "Do not (e.g. after testing) use ~/x as the working copy; fix hooks/foo.js and commit.",
        "Do not/never use ~/x as the working copy; fix hooks/foo.js and commit.",
        "Don\u{2bc}t use ~/x as the working copy; fix hooks/foo.js and commit.",
        "Use ~/x as the working copy\u{2014}avoid/work around shared state; fix hooks/foo.js and commit.",
        "Use ~/x as the working copy\n- not even temporarily; fix hooks/foo.js and commit.",
    ] {
        let on = spawn_prompt(&h, true, prompt);
        assert!(on.contains(warn), "switch on keeps the note: {prompt:?}: {on}");
        assert_eq!(on, spawn_prompt(&h, false, prompt), "switch on equals switch off for a negated brief: {prompt:?}");
    }
    let dup = "Use ~/x as the working copy; use ~/x as the working copy; fix hooks/foo.js and commit.";
    assert_eq!(spawn_prompt(&h, true, dup), "", "a repeated affirmative statement is exempt");
    assert!(spawn_prompt(&h, false, dup).contains(warn), "switch off keeps the note");
}

/// Round 3 of the review: a stop, ! or ? inside a single quote, emphasis, a hyphen dash or after a semicolon is no sure sentence end, so the
/// negation before it still reaches the isolation phrase. The reported input first, byte for byte; the switch-on answer equals the switch-off
/// answer (the warning), and the affirmative twin of each is exempt.
#[test]
fn an_uncertain_sentence_boundary_keeps_the_negated_shared_tree_note_through_the_real_hook() {
    let h = scratch("bare-bound");
    let warn = "another agent is already writing in this working tree";
    let pairs = [
        ("Do not 'especially! Really' use ~/x as the working copy", "Do 'especially! Really' use ~/x as the working copy"),
        ("Do not **especially! Really** use ~/x as the working copy", "Do **especially! Really** use ~/x as the working copy"),
        ("Do not - especially! Really - use ~/x as the working copy", "Do - especially! Really - use ~/x as the working copy"),
        ("Do not; Really use ~/x as the working copy", "Do; Really use ~/x as the working copy"),
    ];
    for (neg, yes) in pairs {
        let prompt = format!("{neg}; fix hooks/foo.js and commit.");
        let on = spawn_prompt(&h, true, &prompt);
        assert!(on.contains(warn), "switch on keeps the note: {prompt:?}: {on}");
        assert_eq!(on, spawn_prompt(&h, false, &prompt), "switch on equals switch off for a negated brief: {prompt:?}");
        let twin = format!("{yes}; fix hooks/foo.js and commit.");
        assert_eq!(spawn_prompt(&h, true, &twin), "", "the affirmative twin is exempt: {twin:?}");
    }
}
