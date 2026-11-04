//! Notice turns (plan v3 L05 C3, `context.injectGateNoticeTurns`) end to end: real UserPromptSubmit payloads through the dispatcher
//! (`ah-engine hook --event UserPromptSubmit --host claude|codex`, in-process), a main-thread session in a scratch home.
//!
//! * Switch on and the prompt is a harness notice (task notification, mesh tick, goal check-in, peer or teammate message): the
//!   verify-first and task-tracker reminders are not in the answer.
//! * Switch on and a human prompt, or switch off and a notice: both are there, as they always were.
//!
//! The counters are checked in `src/dispatch/notice.rs` and `src/script/tests.rs` (a count made outside the daemon is dropped, so the
//! in-process dispatcher cannot show them). Each test has its own HOME and state directory.
#![allow(clippy::unwrap_used, clippy::expect_used)] // a test crate: a panic is the failure report, and E2 exempts tests

use serde_json::json;
use std::io::Write;
use std::path::PathBuf;
use std::process::{Command, Stdio};

const VERIFY_FIRST: &str = "VERIFY-FIRST";
const TASK_TRACKER: &str = "task tracker";

struct Rig {
    dir: PathBuf,
}

impl Drop for Rig {
    fn drop(&mut self) {
        ah_engine::discard::harmless(std::fs::remove_dir_all(&self.dir)); // keep: a test directory; an absent one is the goal state
    }
}

impl Rig {
    fn new(name: &str) -> Rig {
        let dir = std::env::temp_dir().join(format!("ahd-notice-{name}-{}", std::process::id()));
        ah_engine::discard::harmless(std::fs::remove_dir_all(&dir));
        std::fs::create_dir_all(dir.join("home/.anti-hall")).unwrap();
        std::fs::create_dir_all(dir.join("proj")).unwrap();
        Rig { dir }
    }

    /// One prompt through `hook --event UserPromptSubmit --host <host>`: (exit code, stdout, stderr).
    fn prompt(&self, host: &str, prompt: &str, on: bool) -> (i32, String, String) {
        let payload = json!({"hook_event_name": "UserPromptSubmit", "session_id": "notice-s1", "cwd": self.dir.join("proj"), "prompt": prompt});
        let mut c = Command::new(env!("CARGO_BIN_EXE_ah-engine"));
        c.args(["hook", "--event", "UserPromptSubmit", "--host", host])
            .env_clear()
            .env("AH_ENGINE_PLUGIN_ROOT", std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../plugins/anti-hall"))
            .env("PATH", "/usr/bin:/bin")
            .env("HOME", self.dir.join("home"))
            .env("AH_ENGINE_DIR", self.dir.join("state"))
            .env("AH_ENGINE_VERSION", "notice-e2e")
            .env("AH_ENGINE_DISPATCH_IN_PROCESS", "1")
            .env("CLAUDE_PLUGIN_ROOT", &self.dir)
            .env("CLAUDE_CODE_ENTRYPOINT", "cli")
            .env("ANTIHALL_INGEST_DRY_RUN", "1")
            .current_dir(&self.dir)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        if on {
            c.env("ANTIHALL_NOTICE_TURNS", "1");
        }
        let mut ch = c.spawn().unwrap();
        ch.stdin.take().unwrap().write_all(payload.to_string().as_bytes()).unwrap();
        let o = ch.wait_with_output().unwrap();
        (o.status.code().unwrap_or(-1), String::from_utf8_lossy(&o.stdout).to_string(), String::from_utf8_lossy(&o.stderr).to_string())
    }
}

const NOTICES: [&str; 5] = [
    "<task-notification>\n<task-id>b1</task-id>\n<status>completed</status>\n</task-notification>",
    "/Users/someone/.anti-hall/ah-engine/bin/ah-engine mesh inbox tick primary-xxxx --quiet",
    "Goal check-in: how is the goal going?",
    "<cross-session-message from=\"abc\">hello</cross-session-message>",
    "<teammate-message teammate_id=\"w1\">done</teammate-message>",
];

#[test]
fn notice_turn_a_human_prompt_keeps_both_reminders_with_the_switch_on() {
    for host in ["claude", "codex"] {
        let r = Rig::new(&format!("human-{host}"));
        let (code, out, err) = r.prompt(host, "please fix the failing build", true);
        assert_eq!((code, err.as_str()), (0, ""), "{host}: {out}");
        assert!(out.contains(VERIFY_FIRST) && out.contains(TASK_TRACKER), "{host}: {out}");
    }
}

#[test]
fn notice_turn_a_notice_keeps_both_reminders_with_the_switch_off() {
    for host in ["claude", "codex"] {
        for (i, notice) in NOTICES.iter().enumerate() {
            let r = Rig::new(&format!("off-{host}-{i}"));
            let (code, out, err) = r.prompt(host, notice, false);
            assert_eq!((code, err.as_str()), (0, ""), "{host}: {out}");
            // task-tracker has a peer-message filter of its own, so it is silent on those two kinds even with the switch off
            let tracker_quiet = notice.starts_with("<cross-session-message") || notice.starts_with("<teammate-message");
            assert!(out.contains(VERIFY_FIRST) && (tracker_quiet || out.contains(TASK_TRACKER)), "{host} {notice}: {out}");
        }
    }
}

#[test]
fn notice_turn_a_notice_drops_both_reminders_with_the_switch_on() {
    for host in ["claude", "codex"] {
        for (i, notice) in NOTICES.iter().enumerate() {
            let r = Rig::new(&format!("on-{host}-{i}"));
            let (code, out, err) = r.prompt(host, notice, true);
            assert_eq!((code, err.as_str()), (0, ""), "{host}: {out}");
            assert!(!out.contains(VERIFY_FIRST) && !out.contains(TASK_TRACKER), "{host} {notice}: {out}");
        }
    }
}

#[test]
fn notice_turn_a_human_sentence_that_names_a_notice_keeps_both_reminders_with_the_switch_on() {
    let r = Rig::new("mention");
    let (code, out, err) = r.prompt("claude", "why does the mesh inbox tick fail", true);
    assert_eq!((code, err.as_str()), (0, ""), "{out}");
    assert!(out.contains(VERIFY_FIRST) && out.contains(TASK_TRACKER), "{out}");
}
