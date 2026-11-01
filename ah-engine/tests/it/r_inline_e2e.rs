//! R-inline (plan v3 L04, `guards.inlineRule`) end to end: real PreToolUse Bash payloads through the dispatcher
//! (`ah-engine hook --event PreToolUse --host claude`, in-process), a main-thread session in a scratch home.
//!
//! * The Bash write-parity block of command-guard stands down while spawning is stopped (the usage hard stop), with the switch on:
//!   the write is allowed and one note says why. Off, or with spawning allowed, the write is blocked as it always was.
//! * The coordinator-work-guard window block names the step count and the limit only with the switch on.
//!
//! The counters are checked in `src/script/tests.rs` (a count made outside the daemon is dropped, so the in-process dispatcher
//! cannot show them). Each test has its own HOME and state directory.
#![allow(clippy::unwrap_used, clippy::expect_used)] // a test crate: a panic is the failure report, and E2 exempts tests

use serde_json::{Value, json};
use std::io::Write;
use std::path::PathBuf;
use std::process::{Command, Stdio};

const CACHE: &str = ".claude/plugins/oh-my-claudecode/.usage-cache-anthropic.json";
const WRITE: &str = "sed -i 's/a/b/' src/x.rs";

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
        let dir = std::env::temp_dir().join(format!("ahd-rinline-{name}-{}", std::process::id()));
        ah_engine::discard::harmless(std::fs::remove_dir_all(&dir));
        std::fs::create_dir_all(dir.join("home/.anti-hall")).unwrap();
        std::fs::create_dir_all(dir.join("proj/.git/refs/heads")).unwrap();
        std::fs::create_dir_all(dir.join("proj/src")).unwrap();
        std::fs::write(dir.join("proj/.git/HEAD"), "ref: refs/heads/main\n").unwrap();
        Rig { dir }
    }

    fn home(&self) -> PathBuf {
        self.dir.join("home")
    }

    /// The usage hard stop: the weekly bucket is full, so nobody can be handed the work.
    fn stop_spawning(&self) {
        let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis() as u64;
        let body = json!({"timestamp": now, "data": {"fiveHourPercent": 10.0, "weeklyPercent": 95.0,
            "fiveHourResetsAt": "2099-01-01T05:00:00.000Z", "weeklyResetsAt": "2099-01-02T00:00:00.000Z"}});
        let p = self.home().join(CACHE);
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(p, body.to_string()).unwrap();
    }

    /// The window file of a session that already holds `n` steps, all in the last minute.
    fn seed_window(&self, sid: &str, n: usize) {
        let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis() as u64;
        let ts: Vec<u64> = (0..n as u64).map(|i| now - 60_000 + i).collect();
        let body = json!({"v": 1, "version": "t", "firstTs": ts[0], "ts": ts, "armed": true, "calls": n, "work": n, "blocks": 0, "lastBlockAt": 0, "skippedWouldBlock": 0, "pre": []});
        std::fs::write(self.home().join(format!(".anti-hall/coordinator-work-session-{sid}.json")), body.to_string()).unwrap();
    }

    /// One Bash call of the main thread through `hook --event PreToolUse --host claude`: (exit code, stdout, stderr).
    fn bash(&self, sid: &str, command: &str, on: bool) -> (i32, String, String) {
        let payload = json!({"hook_event_name": "PreToolUse", "tool_name": "Bash", "session_id": sid, "cwd": self.dir.join("proj"),
                             "tool_input": {"command": command}});
        let mut c = Command::new(env!("CARGO_BIN_EXE_ah-engine"));
        c.args(["hook", "--event", "PreToolUse", "--host", "claude"])
            .env_clear()
            .env("AH_ENGINE_PLUGIN_ROOT", std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../plugins/anti-hall"))
            .env("PATH", "/usr/bin:/bin")
            .env("HOME", self.home())
            .env("AH_ENGINE_DIR", self.dir.join("state"))
            .env("AH_ENGINE_VERSION", "rinline-e2e")
            .env("AH_ENGINE_DISPATCH_IN_PROCESS", "1")
            .env("CLAUDE_PLUGIN_ROOT", &self.dir)
            // a main-thread session of a DevSwarm checkout: the context in which the edit and heavy-command gates block
            .env("CLAUDE_CODE_ENTRYPOINT", "cli")
            .env("DEVSWARM_REPO_ID", "r1")
            .env("DEVSWARM_SOURCE_BRANCH", "feat")
            .env("ANTIHALL_INGEST_DRY_RUN", "1")
            .current_dir(&self.dir)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        if on {
            c.env("ANTIHALL_INLINE_RULE", "1");
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

#[test]
fn a_bash_write_is_blocked_with_the_switch_off_whether_or_not_spawning_is_stopped() {
    let rig = Rig::new("off");
    for stopped in [false, true] {
        if stopped {
            rig.stop_spawning();
        }
        let r = rig.bash(&format!("off-{stopped}"), WRITE, false);
        assert_eq!(r.0, 2, "stopped={stopped}: the earlier answer is a block: {r:?}");
        assert!(said(&r).contains("Hand the edit to a helper agent"), "stopped={stopped}: the block names the step that clears it: {r:?}");
    }
}

#[test]
fn with_the_switch_on_a_bash_write_is_blocked_while_spawning_is_allowed_and_stands_down_while_it_is_stopped() {
    let rig = Rig::new("on");
    let r = rig.bash("on-free", WRITE, true);
    assert_eq!(r.0, 2, "spawning allowed: still blocked: {r:?}");
    assert!(said(&r).contains("Hand the edit to a helper agent"), "{r:?}");

    rig.stop_spawning();
    // a write that is also a heavy command with unbounded output is still stopped, and the stopped call does not use up the session's note
    let heavy = rig.bash("on-stop", &format!("{WRITE} && npm test"), true);
    assert_eq!(heavy.0, 2, "a heavy write is still stopped while spawning is stopped: {heavy:?}");
    let r = rig.bash("on-stop", WRITE, true);
    assert_eq!(r.0, 0, "spawning stopped: the write is allowed: {r:?}");
    let v: Value = serde_json::from_str(r.1.trim()).unwrap_or_else(|e| panic!("stdout is one JSON object ({e}): {r:?}"));
    let note = v["hookSpecificOutput"]["additionalContext"].as_str().unwrap_or_default();
    assert_eq!(v["hookSpecificOutput"]["hookEventName"], "PreToolUse", "{r:?}");
    assert!(note.contains("weekly") && note.contains("2099-01-02T00:00Z"), "the note says why spawning is stopped and when it resets: {r:?}");

    let again = rig.bash("on-stop", WRITE, true);
    assert_eq!((again.0, again.1.trim()), (0, ""), "the note is told once per session: {again:?}");
}

#[test]
fn the_window_block_names_the_count_and_the_limit_only_with_the_switch_on() {
    let rig = Rig::new("window");
    let at = 7; // guards.coordinatorWorkBlockAt default
    for on in [false, true] {
        let sid = format!("win-{on}");
        rig.seed_window(&sid, at - 1);
        let r = rig.bash(&sid, "git commit --allow-empty -m x", on);
        assert_eq!(r.0, 2, "on={on}: the {at}th step is stopped: {r:?}");
        let text = said(&r);
        assert!(text.contains("hand the remaining work to a helper agent"), "on={on}: the block names the step that clears it: {r:?}");
        let named = text.contains(&format!("{at} file-changing steps in the main thread within 10 min, this one included; the limit is {at}."));
        assert_eq!(named, on, "on={on}: the headline names the count and the limit only with the switch on: {r:?}");
    }
}
