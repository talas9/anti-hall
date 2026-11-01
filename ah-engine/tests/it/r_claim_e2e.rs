//! R-claim (plan v2 section 4, `guards.claimEvidenceFocus`), end to end through the real dispatcher (`ah-engine hook --event Stop`):
//! Stop payloads of the shape the host sends and transcripts of the shapes the host writes (a typed prompt with `origin.kind`
//! human, a background-task notification with `origin.kind` task-notification, a `Stop hook feedback:` entry with `isMeta`).
//! The texts are synthetic; only the record shapes are the recorded ones. The switch is OFF by default: every case runs both ways.
//!
//! Each test has its own HOME and state directory.
#![allow(clippy::unwrap_used, clippy::expect_used)] // a test crate: a panic is the failure report, and E2 exempts tests

use serde_json::{Value, json};
use std::io::Write;
use std::path::PathBuf;
use std::process::{Command, Stdio};

struct Rig {
    dir: PathBuf,
}

impl Drop for Rig {
    fn drop(&mut self) {
        ah_engine::discard::harmless(std::fs::remove_dir_all(&self.dir)); // keep: a test directory; an absent one is the goal state
    }
}

fn human() -> Value {
    json!({"type": "user", "origin": {"kind": "human"}, "promptSource": "typed", "message": {"role": "user", "content": "check the PRs"}})
}

fn notification() -> Value {
    json!({"type": "user", "origin": {"kind": "task-notification"}, "promptSource": "system", "turnOrigin": "task_notification",
           "message": {"role": "user", "content": "<task-notification>agent done</task-notification>"}})
}

fn injected() -> Value {
    json!({"type": "user", "isMeta": true, "message": {"role": "user", "content": "Stop hook feedback:\nsay it"}})
}

fn tool_call(id: &str, cmd: &str) -> Value {
    json!({"type": "assistant", "message": {"id": format!("m-{id}"), "role": "assistant", "content": [{"type": "tool_use", "id": id, "name": "Bash", "input": {"command": cmd}}]}})
}

fn tool_result(id: &str, text: &str) -> Value {
    json!({"type": "user", "message": {"role": "user", "content": [{"type": "tool_result", "tool_use_id": id, "content": text}]}})
}

fn reply(text: &str) -> Value {
    json!({"type": "assistant", "message": {"id": "m-reply", "role": "assistant", "content": [{"type": "text", "text": text}], "stop_reason": "end_turn"}})
}

impl Rig {
    fn new(name: &str) -> Rig {
        let dir = std::env::temp_dir().join(format!("ahd-rclaim-{name}-{}", std::process::id()));
        ah_engine::discard::harmless(std::fs::remove_dir_all(&dir));
        std::fs::create_dir_all(dir.join("home/.anti-hall")).unwrap();
        std::fs::create_dir_all(dir.join("proj/.git")).unwrap();
        std::fs::write(dir.join("proj/.git/HEAD"), "ref: refs/heads/main\n").unwrap();
        Rig { dir }
    }

    fn t(&self) -> PathBuf {
        self.dir.join("t.jsonl")
    }

    fn transcript(&self, lines: &[Value]) {
        std::fs::write(self.t(), lines.iter().map(|l| format!("{l}\n")).collect::<String>()).unwrap();
    }

    /// One Stop as the host sends it, with the reply in the payload.
    fn stop(&self, text: &str, focus: bool) -> (i32, String, String) {
        let payload = json!({"session_id": "rc1", "cwd": self.dir.join("proj"), "hook_event_name": "Stop", "permission_mode": "default",
                             "stop_hook_active": false, "background_tasks": [], "session_crons": [], "transcript_path": self.t(),
                             "last_assistant_message": text});
        let mut c = Command::new(env!("CARGO_BIN_EXE_ah-engine"));
        c.args(["hook", "--event", "Stop", "--host", "claude"])
            .env_clear()
            .env("AH_ENGINE_PLUGIN_ROOT", std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../plugins/anti-hall"))
            .env("PATH", "/usr/bin:/bin")
            .env("HOME", self.dir.join("home"))
            .env("AH_ENGINE_DIR", self.dir.join("state"))
            .env("AH_ENGINE_VERSION", "rclaim-e2e")
            .env("AH_ENGINE_DISPATCH_IN_PROCESS", "1")
            .env("CLAUDE_PLUGIN_ROOT", &self.dir)
            .current_dir(&self.dir)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        if focus {
            c.env("ANTIHALL_CLAIM_EVIDENCE_FOCUS", "1");
        }
        let mut ch = c.spawn().unwrap();
        ch.stdin.take().unwrap().write_all(payload.to_string().as_bytes()).unwrap();
        let o = ch.wait_with_output().unwrap();
        (o.status.code().unwrap_or(-1), String::from_utf8_lossy(&o.stdout).to_string(), String::from_utf8_lossy(&o.stderr).to_string())
    }
}

#[test]
fn a_pr_check_made_before_a_task_notification_backs_the_merged_claim_only_with_the_switch_on() {
    let r = "PR #12 is merged.";
    let rig = Rig::new("turn");
    rig.transcript(&[
        human(),
        tool_call("u1", "gh pr view 12 --json state,mergedAt"),
        tool_result("u1", "{\"state\":\"MERGED\"}"),
        notification(),
        tool_call("u2", "ls"),
        tool_result("u2", "a"),
        injected(),
        reply(r),
    ]);
    let (code, out, err) = rig.stop(r, false);
    assert_eq!(code, 0, "{out:?} {err:?}");
    assert!(
        out.contains("\"decision\":\"block\"") && out.contains("claim evidence guard") && out.contains("\\\"is merged\\\""),
        "off: today's block names the phrase: {out:?}"
    );
    assert!(out.contains("run the check and show its result"), "off: today's advice: {out:?}");
    let (code, out, err) = rig.stop(r, true);
    assert_eq!(code, 0, "{out:?} {err:?}");
    assert!(!out.contains("claim evidence guard"), "on: the check in the same owner turn backs the claim: {out:?}");
}

#[test]
fn a_bare_claim_is_held_with_the_switch_on_and_the_block_names_the_check_that_clears_it() {
    let r = "PR #12 is merged.";
    let rig = Rig::new("bare");
    rig.transcript(&[human(), tool_call("u1", "ls"), tool_result("u1", "a"), notification(), reply(r)]);
    let (code, out, err) = rig.stop(r, true);
    assert_eq!(code, 0, "{out:?} {err:?}");
    assert!(
        out.contains("\"decision\":\"block\"") && out.contains("\\\"is merged\\\"") && out.contains("gh pr view"),
        "names the phrase and the check: {out:?}"
    );
}

#[test]
fn a_likely_cause_that_says_it_is_not_confirmed_is_not_held_only_with_the_switch_on() {
    let r = "The likely candidates are the recent builds, but I haven't confirmed that.";
    let rig = Rig::new("hedge");
    rig.transcript(&[human(), tool_call("u1", "ls"), tool_result("u1", "a"), reply(r)]);
    let (code, out, err) = rig.stop(r, false);
    assert_eq!(code, 0, "{out:?} {err:?}");
    assert!(out.contains("\"decision\":\"block\"") && out.contains("unverified claim") && out.contains("\\\"likely\\\""), "off: today's block: {out:?}");
    let (code, out, err) = rig.stop(r, true);
    assert_eq!(code, 0, "{out:?} {err:?}");
    assert!(!out.contains("unverified claim"), "on: an honest hedge passes: {out:?}");
    // a bare hedge is still held with the switch on, and the block says what clears it
    let bare = "The likely cause is the stale cache.";
    rig.transcript(&[human(), reply(bare)]);
    let (code, out, err) = rig.stop(bare, true);
    assert_eq!(code, 0, "{out:?} {err:?}");
    assert!(out.contains("unverified claim") && out.contains("I haven't confirmed that"), "{out:?}");
}
