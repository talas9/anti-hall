//! End-to-end for the built-in `check = "git"`: real binary, real daemon, isolated HOME + engine dir.
//! A block must reach the host the way the Node guard does it: exit code 2 with the reason on stderr.
#![allow(clippy::unwrap_used, clippy::expect_used)] // a test crate: a panic is the failure report, and E2 exempts tests
use crate::common;
use std::io::Write;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

const BIN: &str = env!("CARGO_BIN_EXE_ah-engine");
const P: &str = "pu\x73h";

struct Env {
    dir: PathBuf,
}

impl Env {
    fn new(tag: &str) -> Env {
        let dir = PathBuf::from("/tmp").join(format!("ah-gc-{}-{}", tag, std::process::id()));
        ah_engine::discard::harmless(std::fs::remove_dir_all(&dir));
        std::fs::create_dir_all(dir.join("home")).unwrap();
        let rules = r#"{"version":1,"rules":[{"id":"git-guard","events":["PreToolUse"],"tools":["Bash"],"check":"git","action":"deny","options":{"plugin_root":"/plugin"}}]}"#;
        std::fs::write(dir.join("rules.json"), rules).unwrap();
        Env { dir }
    }

    fn cmd(&self) -> Command {
        let mut c = Command::new(BIN);
        c.env("HOME", self.dir.join("home"))
            .env("AH_ENGINE_DIR", self.dir.join("eng"))
            .env("AH_ENGINE_RULES", self.dir.join("rules.json"))
            .env("AH_ENGINE_VERSION", "0.1.0")
            .env_remove("AH_ENGINE_NOSPAWN");
        c
    }

    /// (stdout, stderr, exit code) of one `engine hook` call; retried once so a cold start cannot hide the answer.
    fn hook(&self, command: &str) -> (String, String, i32) {
        let payload =
            serde_json::json!({"hook_event_name": "PreToolUse", "tool_name": "Bash", "cwd": "/tmp", "session_id": "s", "tool_input": {"command": command}})
                .to_string();
        let mut last = (String::new(), String::new(), 0);
        for _ in 0..2 {
            let mut ch = self.cmd().arg("hook").stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn().unwrap();
            ch.stdin.take().unwrap().write_all(payload.as_bytes()).unwrap();
            let o = ch.wait_with_output().unwrap();
            last =
                (String::from_utf8_lossy(&o.stdout).trim().to_string(), String::from_utf8_lossy(&o.stderr).trim().to_string(), o.status.code().unwrap_or(-1));
            // a cold start with no fallback hands a guard event over (dispatch.defer_exit), it is not the engine's answer
            if last.2 == 2 || (self.up() && last.2 != ah_engine::defaults::num("dispatch.defer_exit") as i32) {
                break;
            }
            let t = Instant::now();
            while t.elapsed() < Duration::from_secs(3) && !self.up() {
                std::thread::sleep(Duration::from_millis(20));
            }
        }
        last
    }

    fn up(&self) -> bool {
        self.cmd().args(["ctl", "ping"]).output().is_ok_and(|o| o.status.success())
    }
}

impl Drop for Env {
    fn drop(&mut self) {
        common::reap(&self.dir.join("eng"), || {
            ah_engine::discard::harmless(self.cmd().args(["ctl", "stop"]).output());
        });
        ah_engine::discard::harmless(std::fs::remove_dir_all(&self.dir));
    }
}

#[test]
fn a_block_is_exit_2_with_the_reason_on_stderr() {
    let e = Env::new("block");
    let (out, err, code) = e.hook(&format!("git {P} --force origin main"));
    assert_eq!(code, 2, "stdout={out} stderr={err}");
    assert!(out.is_empty(), "{out}");
    assert!(err.starts_with("\u{26d4} anti-hall \u{b7} git-guard: force push is blocked."), "{err}");
    // served by the resident daemon on the next call
    assert!(e.up());
    let (_, err2, code2) = e.hook(&format!("git {P} -f"));
    assert_eq!(code2, 2, "{err2}");
}

#[test]
fn benign_commands_and_other_tools_are_silent_exit_0() {
    let e = Env::new("allow");
    let _ = e.hook("echo warm");
    assert_eq!(e.hook("git status"), (String::new(), String::new(), 0));
    assert_eq!(e.hook(&format!("git commit -m \"never git {P} --force\"")), (String::new(), String::new(), 0));
}

#[test]
fn the_override_hint_names_the_configured_plugin_root() {
    let e = Env::new("root");
    let (_, err, code) = e.hook(&format!("git {P} --delete origin b"));
    assert_eq!(code, 2, "{err}");
    assert!(err.contains("node '/plugin/scripts/devswarm.js' skip git-guard"), "{err}");
}
