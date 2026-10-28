//! The hook client launches nothing: an old `--fallback <script>` argument or AH_ENGINE_NODE is ignored, a payload that cannot
//! be sent to the engine (undecodable or over the cap) is answered by the client itself (guard events exit 2, others 0), and a
//! guard event the engine answered with no verdict follows the event's configured failure mode.
//!
//! Tests that cover daemon-unavailable behavior use AH_ENGINE_NOSPAWN; tests that cover a no-verdict reply run behind a
//! healthy non-OK daemon reply.
#![allow(clippy::unwrap_used, clippy::expect_used)] // a test crate: a panic is the failure report, and E2 exempts tests

use std::io::{Read, Write};
use std::os::unix::net::UnixListener;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::time::Duration;

struct Env {
    dir: PathBuf,
}

impl Env {
    /// `script` is a would-be fallback hook; it must never run (it records a marker if it does).
    fn new(tag: &str, script: &str) -> Env {
        let dir = std::env::temp_dir().join(format!("ah-fb-{tag}-{}", std::process::id()));
        ah_engine::discard::harmless(std::fs::remove_dir_all(&dir));
        std::fs::create_dir_all(dir.join("home")).unwrap();
        std::fs::write(dir.join("fb.sh"), script).unwrap();
        Env { dir }
    }

    /// (stdout, stderr, exit code) of one client call; the old `--fallback` argument and AH_ENGINE_NODE are passed on purpose.
    fn call_bytes(&self, input: &[u8]) -> (String, String, i32) {
        self.call_bytes_with(input, Some(self.dir.join("fb.sh")), Some("/bin/sh"))
    }

    fn call_bytes_with(&self, input: &[u8], fallback: Option<PathBuf>, node: Option<&str>) -> (String, String, i32) {
        let mut c = Command::new(env!("CARGO_BIN_EXE_ah-engine"));
        c.arg("hook")
            .env_clear()
            .env("PATH", std::env::var("PATH").unwrap_or_default())
            .env("HOME", self.dir.join("home"))
            .env("AH_ENGINE_DIR", self.dir.join("eng"))
            .env("AH_ENGINE_VERSION", "fb-test")
            .env("AH_ENGINE_NOSPAWN", "1");
        if let Some(fallback) = fallback {
            c.arg("--fallback").arg(fallback);
        }
        if let Some(node) = node {
            c.env("AH_ENGINE_NODE", node);
        }
        let mut ch = c.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn().unwrap();
        ch.stdin.take().unwrap().write_all(input).unwrap();
        let o = ch.wait_with_output().unwrap();
        (String::from_utf8_lossy(&o.stdout).into(), String::from_utf8_lossy(&o.stderr).into(), o.status.code().unwrap_or(-1))
    }

    fn log(&self) -> String {
        std::fs::read_dir(self.dir.join("eng")).into_iter().flatten().flatten().filter_map(|e| std::fs::read_to_string(e.path()).ok()).collect()
    }

    /// Whether the would-be fallback hook ran.
    fn hook_ran(&self) -> bool {
        self.dir.join("ran").exists()
    }
}

fn fake_non_ok_daemon(e: &Env) {
    std::fs::create_dir_all(e.dir.join("eng")).unwrap();
    let l = UnixListener::bind(e.dir.join("eng").join("e.sock")).unwrap();
    std::thread::spawn(move || {
        for s in l.incoming().flatten() {
            let mut s = s;
            let mut b = Vec::new();
            ah_engine::discard::harmless(s.read_to_end(&mut b));
            ah_engine::discard::harmless(s.write_all(&ah_engine::frame::encode(ah_engine::frame::Kind::Err, "fixture fallback")));
        }
    });
}

fn wait_for_socket(e: &Env) {
    let t = std::time::Instant::now();
    while t.elapsed() < Duration::from_secs(1) {
        if e.dir.join("eng").join("e.sock").exists() {
            return;
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    panic!("fake daemon socket was not created");
}

fn with_healthy_non_ok(e: &Env) {
    fake_non_ok_daemon(e);
    wait_for_socket(e);
}

impl Drop for Env {
    fn drop(&mut self) {
        ah_engine::discard::harmless(std::fs::remove_dir_all(&self.dir));
    }
}

const RAN: &str = "echo ran > \"$(dirname \"$0\")/ran\"\n";

const GUARD: &[u8] = b"{\"hook_event_name\":\"PreToolUse\",\"tool_name\":\"Bash\",\"tool_input\":{\"command\":\"npm test \xff\"}}";
const NON_GUARD: &[u8] = b"{\"hook_event_name\":\"SessionStart\",\"source\":\"startup \xff\"}";

#[test]
fn a_guard_event_the_engine_gave_no_verdict_for_follows_the_configured_failure_mode_and_runs_no_hook() {
    let e = Env::new("noverdict", RAN);
    with_healthy_non_ok(&e);
    let (out, err, code) = e.call_bytes(br#"{"hook_event_name":"PreToolUse","tool_name":"Bash","tool_input":{"command":"ls"}}"#);
    assert_eq!((out.as_str(), code), ("", 2), "infra is closed in the shipped failure mode: {err:?}");
    assert!(!e.hook_ran(), "no hook command is launched");
    assert!(e.log().contains("no_verdict"), "logged: {:?}", e.log());
}

#[test]
fn a_non_guard_event_the_engine_gave_no_verdict_for_passes_through() {
    let e = Env::new("noverdict-nonguard", RAN);
    with_healthy_non_ok(&e);
    let (out, _, code) = e.call_bytes(br#"{"hook_event_name":"SessionStart","source":"startup"}"#);
    assert_eq!((out.as_str(), code), ("", 0));
    assert!(!e.hook_ran(), "no hook command is launched");
}

#[test]
fn undecodable_stdin_on_a_guard_event_is_blocked_by_the_client_itself() {
    let e = Env::new("nonutf8-guard", RAN);
    let (out, err, code) = e.call_bytes(GUARD);
    assert_eq!((out.as_str(), code), ("", 2));
    assert!(err.contains("hook input unavailable"), "{err:?}");
    assert!(!e.hook_ran(), "no hook command is launched");
}

#[test]
fn undecodable_stdin_on_a_non_guard_event_passes_through_with_a_note() {
    let e = Env::new("nonutf8-nonguard", RAN);
    let (out, err, code) = e.call_bytes_with(NON_GUARD, None, None);
    assert_eq!((out.as_str(), code), ("", 0));
    assert!(err.contains("hook input unavailable"), "{err:?}");
}

#[test]
fn over_cap_stdin_on_a_guard_event_is_blocked_and_runs_no_hook() {
    let e = Env::new("overcap", RAN);
    let max = ah_engine::defaults::num("client.max_stdin") as usize;
    let mut input = br#"{"hook_event_name":"PreToolUse","tool_name":"Bash","tool_input":{"command":"npm test "#.to_vec();
    while input.len() <= max + 4096 {
        input.extend_from_slice(b"\xc3\xa9");
    }
    input.extend_from_slice(br#""}}"#);
    let (out, err, code) = e.call_bytes(&input);
    assert_eq!((out.as_str(), code), ("", 2));
    assert!(err.contains("hook input unavailable"), "{err:?}");
    assert!(!e.hook_ran(), "no hook command is launched");
}

#[test]
fn over_cap_stdin_on_a_non_guard_event_passes_through_with_a_note() {
    let max = ah_engine::defaults::num("client.max_stdin") as usize;
    for event in ["SessionStart", "UserPromptSubmit", "PostToolUse"] {
        let mut input = format!(r#"{{"hook_event_name":"{event}","source":"startup "#).into_bytes();
        input.resize(max + 4096, b'x');
        let e = Env::new(&format!("overcap-{event}"), RAN);
        let (out, err, code) = e.call_bytes_with(&input, None, None);
        assert_eq!((out.as_str(), code), ("", 0), "{event}");
        assert!(err.contains("hook input unavailable"), "{event}: {err:?}");
    }
}

#[test]
fn over_cap_prefix_event_classification_keeps_configured_key_precedence() {
    let max = ah_engine::defaults::num("client.max_stdin") as usize;
    let mut input = br#"{"event":"SessionStart","hook_event_name":"PreToolUse","tool_name":"Bash","tool_input":{"command":"npm test "#.to_vec();
    input.resize(max + 4096, b'x');
    let e = Env::new("overcap-precedence", RAN);
    let (out, _, code) = e.call_bytes_with(&input, None, None);
    assert_eq!((out.as_str(), code), ("", 2), "classified a guard event (PreToolUse wins)");
}

#[test]
fn exact_stdin_cap_is_asked_of_the_engine_and_one_more_byte_is_not() {
    let max = ah_engine::defaults::num("client.max_stdin") as usize;
    let prefix = br#"{"hook_event_name":"PreToolUse","tool_name":"Bash","tool_input":{"command":""#;
    let suffix = br#""}}"#;
    let filler = max - prefix.len() - suffix.len();
    let mut exact = prefix.to_vec();
    exact.resize(prefix.len() + filler, b'x');
    exact.extend_from_slice(suffix);
    assert_eq!(exact.len(), max);

    let e = Env::new("exact-cap", RAN);
    // The stdin cap (8 MiB) and the daemon request cap (1 MiB) differ on purpose: an exact-cap guard payload is still read whole
    // and is not "unavailable input", but it is too large to send to the daemon, so the guard event follows its configured
    // infra failure mode (closed: exit 2, stricter than the Node wrapper, which let such a call through).
    let (out, err, code) = e.call_bytes_with(&exact, None, None);
    assert!(!err.contains("hook input unavailable"), "the payload was read whole: {err:?}");
    assert_eq!((out.as_str(), code), ("", 2), "an unsendable guard request fails closed: {err:?}");
    assert!(err.contains("could not run the guards"), "{err:?}");

    let mut over = exact;
    over.push(b'\n');
    let (out, err, code) = e.call_bytes_with(&over, None, None);
    assert_eq!((out.as_str(), code), ("", 2));
    assert!(err.contains("hook input unavailable"), "{err:?}");
}
