//! The merge gate's clear-step block text (#538, `guards.mergeGateClearStep`) end to end: a real PreToolUse Bash payload
//! (`gh pr merge`) with a transcript whose last assistant message says "pending review" goes through
//! `ah-engine hook --event PreToolUse --host claude`, in-process, in a scratch home.
//!
//! * Switch on: the block names the hedge, says no real user prompt has resolved it and lists the phrases that clear it.
//! * Switch off: the old wording, byte for byte.
//! * Switch on and a real user prompt with a resolution phrase after the hedge: the merge gate stays silent.
#![allow(clippy::unwrap_used, clippy::expect_used)] // a test crate: a panic is the failure report, and E2 exempts tests

use serde_json::json;
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

impl Rig {
    fn new(name: &str) -> Rig {
        let dir = std::env::temp_dir().join(format!("ahd-mergegate-{name}-{}", std::process::id()));
        ah_engine::discard::harmless(std::fs::remove_dir_all(&dir));
        std::fs::create_dir_all(dir.join("home/.anti-hall")).unwrap();
        std::fs::create_dir_all(dir.join("proj")).unwrap();
        Rig { dir }
    }

    /// One `gh pr merge` Bash call after `transcript` (JSONL lines), with the clear-step switch `on` or off: (exit code, stdout, stderr).
    fn merge(&self, host: &str, transcript: &str, on: bool) -> (i32, String, String) {
        let tp = self.dir.join("t.jsonl");
        std::fs::write(&tp, transcript).unwrap();
        let payload = json!({
            "hook_event_name": "PreToolUse", "session_id": "mg-s1", "cwd": self.dir.join("proj"), "tool_name": "Bash",
            "tool_input": {"command": "gh pr merge 5"}, "transcript_path": tp,
        });
        let mut c = Command::new(env!("CARGO_BIN_EXE_ah-engine"));
        c.args(["hook", "--event", "PreToolUse", "--host", host])
            .env_clear()
            .env("AH_ENGINE_PLUGIN_ROOT", std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../plugins/anti-hall"))
            .env("PATH", "/usr/bin:/bin")
            .env("HOME", self.dir.join("home"))
            .env("AH_ENGINE_DIR", self.dir.join("state"))
            .env("AH_ENGINE_VERSION", "mergegate-e2e")
            .env("AH_ENGINE_DISPATCH_IN_PROCESS", "1")
            .env("CLAUDE_PLUGIN_ROOT", &self.dir)
            .env("CLAUDE_CODE_ENTRYPOINT", "cli")
            .env("ANTIHALL_INGEST_DRY_RUN", "1")
            .env("ANTIHALL_MERGE_GATE", "1")
            .current_dir(&self.dir)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        if on {
            c.env("ANTIHALL_MERGE_GATE_CLEAR_STEP", "1");
        }
        let mut ch = c.spawn().unwrap();
        ch.stdin.take().unwrap().write_all(payload.to_string().as_bytes()).unwrap();
        let o = ch.wait_with_output().unwrap();
        (o.status.code().unwrap_or(-1), String::from_utf8_lossy(&o.stdout).to_string(), String::from_utf8_lossy(&o.stderr).to_string())
    }
}

const HEDGE: &str = "{\"type\":\"assistant\",\"message\":{\"role\":\"assistant\",\"content\":[{\"type\":\"text\",\"text\":\"pending review\"}]}}\n";

#[test]
fn merge_gate_clear_step_on_names_the_hedge_and_lists_what_clears_it() {
    let r = Rig::new("on");
    let (code, out, err) = r.merge("claude", HEDGE, true);
    let all = format!("{out}{err}");
    assert_eq!(code, 2, "{all}");
    assert!(all.contains("your last message says \\\"pending review\\\" and no real user prompt has resolved it"), "{all}");
    // the visible instead must keep the phrases (a text past 115 characters is cut to the saved-instructions pointer)
    assert!(all.contains("owner replies: owner approved, owner signed off, sign-off received"), "{all}");
    assert!(all.contains("verified against") && all.contains("resolved:") && !all.contains("saved instructions"), "{all}");
}

#[test]
fn merge_gate_clear_step_off_keeps_the_old_wording() {
    let r = Rig::new("off");
    let (code, out, err) = r.merge("claude", HEDGE, false);
    let all = format!("{out}{err}");
    assert_eq!(code, 2, "{all}");
    assert!(all.contains("the merge is paused while recent work remains unverified."), "{all}");
    assert!(all.contains("verify the agreed result before merging."), "{all}");
    assert!(!all.contains("no real user prompt has resolved it"), "{all}");
}

#[test]
fn merge_gate_clear_step_on_still_allows_after_a_real_user_resolution() {
    let r = Rig::new("resolved");
    let user = "{\"type\":\"user\",\"message\":{\"role\":\"user\",\"content\":\"owner approved, go ahead\"}}\n";
    let (code, out, err) = r.merge("claude", &format!("{HEDGE}{user}"), true);
    // other guards (the heavy-command check) may still answer in this rig; the merge gate must not
    let all = format!("{out}{err}");
    assert!(!all.contains("merge check"), "code {code}: {all}");
}
