//! R-style (plan v3 L10, `guards.styleRule`) end to end: real Stop payloads through the dispatcher
//! (`ah-engine hook --event Stop --host claude` and `--host codex`, in-process), a main-thread session in a scratch home.
//!
//! * A long plain reply is held once (`decision: block`, the text names the length and the step that clears it); the retry that
//!   follows (`stop_hook_active`) is allowed, so the guard cannot loop and keeps no state file.
//! * The user asking for detail, a plan or an explanation, a fenced-code or table excess within the allowances, plan mode, a
//!   subagent, a Codex payload with no reply text and the switch off all leave the reply alone.
//!
//! The counters are checked in `src/script/tests.rs` (a count made outside the daemon is dropped, so the in-process dispatcher
//! cannot show them). Each test has its own HOME and state directory.
#![allow(clippy::unwrap_used, clippy::expect_used)] // a test crate: a panic is the failure report, and E2 exempts tests

use serde_json::{Value, json};
use std::io::Write;
use std::path::PathBuf;
use std::process::{Command, Stdio};

const MARKER: &str = "Reply too long:";

struct Rig {
    dir: PathBuf,
    /// The plugin root the engine reads its defaults and logic from: the repository's, or a copy with the form set to `note`.
    plugin: PathBuf,
}

impl Drop for Rig {
    fn drop(&mut self) {
        ah_engine::discard::harmless(std::fs::remove_dir_all(&self.dir)); // keep: a test directory; an absent one is the goal state
    }
}

/// Copy a directory tree (the plugin) to `to`.
fn copy_tree(from: &std::path::Path, to: &std::path::Path) {
    std::fs::create_dir_all(to).unwrap();
    for e in std::fs::read_dir(from).unwrap().filter_map(Result::ok) {
        let (src, dst) = (e.path(), to.join(e.file_name()));
        if src.is_dir() {
            copy_tree(&src, &dst);
        } else {
            std::fs::copy(&src, &dst).unwrap();
        }
    }
}

/// A reply of `n` short prose lines (about 60 characters each).
fn prose(n: usize) -> String {
    (0..n).map(|i| format!("Line {i}: the change is in place and the tests around it pass.")).collect::<Vec<_>>().join("\n")
}

/// A fenced code block of `n` lines.
fn code(n: usize) -> String {
    let body = (0..n).map(|i| format!("let v{i} = {i};")).collect::<Vec<_>>().join("\n");
    format!("```rust\n{body}\n```")
}

/// A markdown table of `n` rows.
fn table(n: usize) -> String {
    let rows = (0..n).map(|i| format!("| row {i} | {i} |")).collect::<Vec<_>>().join("\n");
    format!("| name | n |\n|---|---|\n{rows}")
}

impl Rig {
    fn new(name: &str) -> Rig {
        let dir = std::env::temp_dir().join(format!("ahd-rstyle-{name}-{}", std::process::id()));
        ah_engine::discard::harmless(std::fs::remove_dir_all(&dir));
        std::fs::create_dir_all(dir.join("home/.anti-hall")).unwrap();
        std::fs::create_dir_all(dir.join("proj/.git/refs/heads")).unwrap();
        std::fs::write(dir.join("proj/.git/HEAD"), "ref: refs/heads/main\n").unwrap();
        let plugin = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../plugins/anti-hall");
        Rig { dir, plugin }
    }

    /// Point the engine at a copy of the plugin whose `reply_length.toml` has `form = "note"` (both defaults trees, so they stay equal).
    fn note_form(mut self) -> Rig {
        let copy = self.dir.join("plugin");
        copy_tree(&self.plugin, &copy);
        for tree in ["defaults", "defaults.pristine"] {
            let f = copy.join("engine").join(tree).join("reply_length.toml");
            let body = std::fs::read_to_string(&f).unwrap();
            assert!(body.contains("value = \"block\"\n\n[reply_length.marker]"), "the form default is where the test expects it");
            std::fs::write(&f, body.replace("value = \"block\"\n\n[reply_length.marker]", "value = \"note\"\n\n[reply_length.marker]")).unwrap();
        }
        self.plugin = copy;
        self
    }

    fn state(&self) -> PathBuf {
        self.dir.join("state")
    }

    /// The transcript of a session whose user typed `prompt`, in the shape of each host.
    fn transcript(&self, host: &str, prompt: &str) -> PathBuf {
        let line = if host == "codex" {
            json!({"type": "event_msg", "timestamp": "2026-11-01T10:00:00.000Z", "payload": {"type": "user_message", "message": prompt}})
        } else {
            json!({"type": "user", "uuid": "u1", "origin": {"kind": "human"}, "promptSource": "typed", "message": {"role": "user", "content": prompt}})
        };
        let p = self.dir.join(format!("t-{host}.jsonl"));
        std::fs::write(&p, format!("{line}\n")).unwrap();
        p
    }

    fn stop(&self, host: &str, prompt: &str, reply: &str) -> Value {
        json!({"session_id": "rs1", "cwd": self.dir.join("proj"), "hook_event_name": "Stop", "permission_mode": "default", "stop_hook_active": false,
               "transcript_path": self.transcript(host, prompt), "last_assistant_message": reply})
    }

    /// One Stop through `hook --event Stop --host <host>`, the switch on or off: (exit code, stdout, stderr).
    fn run(&self, host: &str, payload: &Value, on: bool) -> (i32, String, String) {
        let mut c = Command::new(env!("CARGO_BIN_EXE_ah-engine"));
        c.args(["hook", "--event", "Stop", "--host", host])
            .env_clear()
            .env("AH_ENGINE_PLUGIN_ROOT", &self.plugin)
            .env("PATH", "/usr/bin:/bin")
            .env("HOME", self.dir.join("home"))
            .env("AH_ENGINE_DIR", self.state())
            .env("AH_ENGINE_VERSION", "rstyle-e2e")
            .env("AH_ENGINE_DISPATCH_IN_PROCESS", "1")
            .env("CLAUDE_PLUGIN_ROOT", &self.dir)
            .env("ANTIHALL_INGEST_DRY_RUN", "1")
            .current_dir(&self.dir)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        if on {
            c.env("ANTIHALL_STYLE_RULE", "1");
        }
        let mut ch = c.spawn().unwrap();
        ch.stdin.take().unwrap().write_all(payload.to_string().as_bytes()).unwrap();
        let o = ch.wait_with_output().unwrap();
        (o.status.code().unwrap_or(-1), String::from_utf8_lossy(&o.stdout).into_owned(), String::from_utf8_lossy(&o.stderr).into_owned())
    }
}

/// The text the host reads from an answer: stdout plus stderr.
fn said(r: &(i32, String, String)) -> String {
    format!("{}{}", r.1, r.2)
}

const HOSTS: [&str; 2] = ["claude", "codex"];

#[test]
fn a_long_plain_reply_is_held_once_with_the_length_and_the_step_that_clears_it() {
    for host in HOSTS {
        let rig = Rig::new(&format!("block-{host}"));
        let r = rig.run(host, &rig.stop(host, "fix the failing test", &prose(40)), true);
        assert_eq!(r.0, 0, "{host}: a Stop hold exits 0 with the JSON: {r:?}");
        let v: Value = serde_json::from_str(r.1.trim()).unwrap_or_else(|e| panic!("{host}: stdout is the block JSON ({e}): {r:?}"));
        assert_eq!(v["decision"], "block", "{host}: {r:?}");
        let reason = v["reason"].as_str().unwrap();
        assert!(reason.contains(MARKER) && reason.contains("40 lines") && reason.contains("limit 1200 / 18"), "{host}: names the fact: {reason}");
        assert!(reason.contains("link the detail from a file or PR"), "{host}: names the step that clears it: {reason}");
        // the retry that follows the hold is allowed, whatever it says: no loop, and no state file is written
        let mut retry = rig.stop(host, "fix the failing test", &prose(40));
        retry["stop_hook_active"] = json!(true);
        let r2 = rig.run(host, &retry, true);
        assert!(!said(&r2).contains(MARKER), "{host}: the retry is allowed: {r2:?}");
        assert!(
            !rig.dir.join("home/.anti-hall").read_dir().unwrap().filter_map(Result::ok).any(|e| e.file_name().to_string_lossy().contains("reply-length")),
            "{host}: no state file"
        );
    }
}

#[test]
fn a_reply_within_the_limits_the_switch_off_and_the_exempt_cases_are_left_alone() {
    type Patch = fn(&mut Value);
    let nop: Patch = |_| {};
    for host in HOSTS {
        let rig = Rig::new(&format!("allow-{host}"));
        let long = prose(40);
        let fenced = format!("Here:\n{}", code(70));
        let plain = "fix the failing test";
        let rows = table(30);
        let cases: Vec<(&str, &str, &str, Patch, bool)> = vec![
            ("short reply", plain, "Done: the test passes.", nop, true),
            ("switch off", plain, &long, nop, false),
            ("asked to explain", "please explain how this works", &long, nop, true),
            ("asked for a plan", "write the plan for the migration", &long, nop, true),
            ("asked for a report", "give me the report", &long, nop, true),
            ("70 fenced code lines", "show the change", &fenced, nop, true),
            ("30 table rows", "list them", &rows, nop, true),
            ("plan mode", plain, &long, |p| p["permission_mode"] = json!("plan"), true),
            ("subagent", plain, &long, |p| p["agent_id"] = json!("a1"), true),
            ("stop_hook_active", plain, &long, |p| p["stop_hook_active"] = json!(true), true),
            ("no reply text", plain, &long, |p| drop(p.as_object_mut().unwrap().remove("last_assistant_message")), true),
        ];
        for (name, prompt, reply, patch, on) in cases {
            let mut payload = rig.stop(host, prompt, reply);
            patch(&mut payload);
            let r = rig.run(host, &payload, on);
            assert!(!said(&r).contains(MARKER), "{host}: {name}: must not be held: {r:?}");
        }
    }
}

#[test]
fn an_excess_of_code_over_its_allowance_is_held() {
    let rig = Rig::new("code-excess");
    let r = rig.run("claude", &rig.stop("claude", "show the change", &format!("Here:\n{}", code(200))), true);
    assert!(said(&r).contains(MARKER), "{r:?}");
}

#[test]
fn the_note_form_answers_with_a_system_message_only() {
    let rig = Rig::new("note").note_form();
    for host in HOSTS {
        let r = rig.run(host, &rig.stop(host, "fix the failing test", &prose(40)), true);
        let v: Value = serde_json::from_str(r.1.trim()).unwrap_or_else(|e| panic!("{host}: stdout is JSON ({e}): {r:?}"));
        assert!(v.get("decision").is_none(), "{host}: a note does not hold the Stop: {r:?}");
        assert!(v["systemMessage"].as_str().unwrap().contains(MARKER), "{host}: {r:?}");
    }
}
