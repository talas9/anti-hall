//! The client's Node fallback: its stdout and stderr are read to EOF, bounded only by the overall fallback deadline, and a
//! deadline hit with output still unread is an explicit error, never an empty stdout that reads as an allow.
//!
//! The Node hook is simulated with `/bin/sh <script>` via AH_ENGINE_NODE, and no daemon ever runs (AH_ENGINE_NOSPAWN), so
//! every call goes to the fallback. A script that "writes late" hands its stdout to a background process that lives on
//! after the script itself exits, the way a Node hook that spawns a helper does.

use std::io::Write;
use std::path::PathBuf;
use std::process::{Command, Stdio};

struct Env {
    dir: PathBuf,
}

impl Env {
    fn new(tag: &str, script: &str) -> Env {
        let dir = std::env::temp_dir().join(format!("ah-fb-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("home")).unwrap();
        std::fs::write(dir.join("fb.sh"), script).unwrap();
        Env { dir }
    }

    /// (stdout, stderr, exit code) of one client call whose fallback deadline is `deadline_ms`.
    fn call(&self, deadline_ms: u64) -> (String, String, i32) {
        self.call_bytes(br#"{"hook_event_name":"PreToolUse","tool_name":"Bash","tool_input":{"command":"ls"}}"#, deadline_ms)
    }

    fn call_bytes(&self, input: &[u8], deadline_ms: u64) -> (String, String, i32) {
        self.call_bytes_with(input, deadline_ms, Some(self.dir.join("fb.sh")), Some("/bin/sh"))
    }

    fn call_bytes_with(&self, input: &[u8], deadline_ms: u64, fallback: Option<PathBuf>, node: Option<&str>) -> (String, String, i32) {
        let mut c = Command::new(env!("CARGO_BIN_EXE_ah-engine"));
        c.arg("hook")
            .env_clear()
            .env("PATH", std::env::var("PATH").unwrap_or_default())
            .env("HOME", self.dir.join("home"))
            .env("AH_ENGINE_DIR", self.dir.join("eng"))
            .env("AH_ENGINE_VERSION", "fb-test")
            .env("AH_ENGINE_NOSPAWN", "1")
            .env("AH_ENGINE_FALLBACK_MS", deadline_ms.to_string());
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

    fn seen(&self) -> Vec<u8> {
        std::fs::read(self.dir.join("seen")).unwrap()
    }
}

impl Drop for Env {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

#[test]
fn a_slow_writer_that_outlives_its_script_is_read_to_the_end_and_stderr_is_passed_through() {
    // The script exits at once; a background shell keeps stdout open and writes the real answer a moment later (longer
    // than the old fixed 500 ms drain allowed). The deadline is generous, so a read that waits for EOF always gets it.
    let e = Env::new("slow", "cat >/dev/null\n(sleep 1; printf 'LATE-ANSWER\\n') &\necho EARLY\necho why >&2\nexit 2\n");
    let (out, err, code) = e.call(30_000);
    assert_eq!((out.as_str(), err.as_str(), code), ("EARLY\nLATE-ANSWER\n", "why\n", 2));
}

#[test]
fn a_hook_whose_output_is_still_open_at_the_deadline_is_an_error_not_an_empty_allow() {
    // The script exits at once but a background process holds stdout for far longer than the deadline.
    let e = Env::new("expire", "cat >/dev/null\n(exec sleep 5) &\necho EARLY\nexit 0\n");
    let (out, err, code) = e.call(1_000);
    assert_eq!(out, "", "no partial stdout is passed on as the answer");
    assert_eq!(code, 1);
    assert!(err.contains("no decision was made"), "stderr explains it: {err:?}");
    assert!(e.log().contains("fallback_read_timeout"), "logged: {:?}", e.log());
}

#[test]
fn a_hook_still_running_at_the_deadline_is_killed_and_unavailable() {
    let e = Env::new("hang", "cat >/dev/null\nexec sleep 30\n");
    assert_eq!(e.call(500), (String::new(), String::new(), 0), "unavailable, like a host timeout: the call is not blocked");
    assert!(e.log().contains("fallback_fail"), "logged: {:?}", e.log());
}

#[test]
fn a_hook_killed_by_a_signal_is_an_error_not_an_exit_0() {
    let e = Env::new("sig", "cat >/dev/null\nkill -9 $$\n");
    let (out, err, code) = e.call(30_000);
    assert_eq!((out.as_str(), code), ("", 1));
    assert!(err.contains("killed by signal 9"), "{err:?}");
    assert!(e.log().contains("fallback_fail"), "logged: {:?}", e.log());
}

#[test]
fn forced_fallback_killed_by_a_signal_follows_the_event_fail_mode() {
    let e = Env::new("forced-sig-guard", "cat >/dev/null\nkill -9 $$\n");
    let input = b"{\"hook_event_name\":\"PreToolUse\",\"tool_name\":\"Bash\",\"tool_input\":{\"command\":\"npm test \xff\"}}";
    let (out, err, code) = e.call_bytes(input, 30_000);
    assert_eq!((out.as_str(), code), ("", 2));
    assert!(err.contains("killed by signal 9"), "{err:?}");

    let e = Env::new("forced-sig-nonguard", "cat >/dev/null\nkill -9 $$\n");
    let input = b"{\"hook_event_name\":\"SessionStart\",\"source\":\"startup \xff\"}";
    let (out, err, code) = e.call_bytes(input, 30_000);
    assert_eq!((out.as_str(), code), ("", 0));
    assert!(err.contains("killed by signal 9"), "{err:?}");
}

#[test]
fn non_utf8_stdin_runs_the_fallback_with_the_original_bytes() {
    let e = Env::new("nonutf8", "cat > \"$(dirname \"$0\")/seen\"\necho BLOCKED >&2\nexit 2\n");
    let input = b"{\"hook_event_name\":\"PreToolUse\",\"tool_name\":\"Bash\",\"tool_input\":{\"command\":\"npm test \xff\"}}";
    let (out, err, code) = e.call_bytes(input, 30_000);
    assert_eq!((out.as_str(), code), ("", 2));
    assert!(err.contains("BLOCKED"), "{err:?}");
    assert_eq!(e.seen(), input);
}

#[test]
fn non_empty_whitespace_stdin_is_not_a_noop_when_a_fallback_exists() {
    let e = Env::new("space", "cat > \"$(dirname \"$0\")/seen\"\necho BLOCKED >&2\nexit 2\n");
    let input = b" \n\t";
    let (out, err, code) = e.call_bytes(input, 30_000);
    assert_eq!((out.as_str(), code), ("", 2));
    assert!(err.contains("BLOCKED"), "{err:?}");
    assert_eq!(e.seen(), input);
}

#[test]
fn over_cap_stdin_runs_the_fallback_with_the_original_bytes() {
    let e = Env::new("overcap", "cat > \"$(dirname \"$0\")/seen\"\necho BLOCKED >&2\nexit 2\n");
    let max = ah_engine::defaults::num("client.max_stdin") as usize;
    let mut input = br#"{"hook_event_name":"PreToolUse","tool_name":"Bash","tool_input":{"command":"npm test "#.to_vec();
    while input.len() <= max + 4096 {
        input.extend_from_slice(b"\xc3\xa9");
    }
    input.extend_from_slice(br#""}}"#);
    let (out, err, code) = e.call_bytes(&input, 30_000);
    assert_eq!((out.as_str(), code), ("", 2));
    assert!(err.contains("BLOCKED"), "{err:?}");
    assert_eq!(e.seen().len(), input.len());
    assert_eq!(e.seen(), input);
}

#[test]
fn forced_fallback_without_a_usable_fallback_fails_closed() {
    let input = b"{\"hook_event_name\":\"PreToolUse\",\"tool_name\":\"Bash\",\"tool_input\":{\"command\":\"npm test \xff\"}}";
    let e = Env::new("nofb", "cat >/dev/null\n");
    let (out, err, code) = e.call_bytes_with(input, 30_000, None, None);
    assert_eq!((out.as_str(), code), ("", 2));
    assert!(err.contains("fallback unavailable"), "{err:?}");

    let e = Env::new("badnode", "cat >/dev/null\n");
    let (out, err, code) = e.call_bytes_with(input, 30_000, Some(e.dir.join("fb.sh")), Some("/nonexistent/ah-node"));
    assert_eq!((out.as_str(), code), ("", 2));
    assert!(err.contains("fallback unavailable"), "{err:?}");
}

#[test]
fn forced_fallback_without_a_usable_fallback_fails_open_for_non_guard_events() {
    let input = b"{\"hook_event_name\":\"SessionStart\",\"source\":\"startup \xff\"}";
    let e = Env::new("nofb-nonguard", "cat >/dev/null\n");
    let (out, err, code) = e.call_bytes_with(input, 30_000, None, None);
    assert_eq!((out.as_str(), code), ("", 0));
    assert!(err.contains("fallback unavailable"), "{err:?}");
}

#[test]
fn over_cap_forced_fallback_without_a_usable_fallback_fails_open_for_non_guard_events() {
    let max = ah_engine::defaults::num("client.max_stdin") as usize;
    for event in ["SessionStart", "UserPromptSubmit", "PostToolUse"] {
        let mut input = format!(r#"{{"hook_event_name":"{event}","source":"startup "#).into_bytes();
        input.resize(max + 4096, b'x');
        let e = Env::new(&format!("nofb-overcap-{event}"), "cat >/dev/null\n");
        let (out, err, code) = e.call_bytes_with(&input, 30_000, None, None);
        assert_eq!((out.as_str(), code), ("", 0), "{event}");
        assert!(err.contains("fallback unavailable"), "{event}: {err:?}");
    }
}

#[test]
fn over_cap_prefix_event_classification_keeps_configured_key_precedence() {
    let max = ah_engine::defaults::num("client.max_stdin") as usize;
    let mut input = br#"{"event":"SessionStart","hook_event_name":"PreToolUse","tool_name":"Bash","tool_input":{"command":"npm test "#.to_vec();
    input.resize(max + 4096, b'x');
    let e = Env::new("nofb-overcap-precedence", "cat >/dev/null\n");
    let (out, err, code) = e.call_bytes_with(&input, 30_000, None, None);
    assert_eq!((out.as_str(), code), ("", 2));
    assert!(err.contains("fallback unavailable"), "{err:?}");
}

#[test]
fn exact_stdin_cap_is_not_over_cap_but_one_more_byte_is() {
    let max = ah_engine::defaults::num("client.max_stdin") as usize;
    let prefix = br#"{"hook_event_name":"PreToolUse","tool_name":"Bash","tool_input":{"command":""#;
    let suffix = br#""}}"#;
    let filler = max - prefix.len() - suffix.len();
    let mut exact = prefix.to_vec();
    exact.resize(prefix.len() + filler, b'x');
    exact.extend_from_slice(suffix);
    assert_eq!(exact.len(), max);

    let e = Env::new("exact-cap", "cat >/dev/null\n");
    // With no daemon and no fallback, valid JSON at exactly the stdin cap keeps the historical fail-open outcome.
    assert_eq!(e.call_bytes_with(&exact, 30_000, None, None), (String::new(), String::new(), 0));

    let mut over = exact;
    over.push(b'\n');
    let (out, err, code) = e.call_bytes_with(&over, 30_000, None, None);
    assert_eq!((out.as_str(), code), ("", 2));
    assert!(err.contains("fallback unavailable"), "{err:?}");
}

#[test]
fn forced_fallback_timeout_fails_closed() {
    let e = Env::new("forced-timeout", "cat >/dev/null\nexec sleep 30\n");
    let input = b"{\"hook_event_name\":\"PreToolUse\",\"tool_name\":\"Bash\",\"tool_input\":{\"command\":\"npm test \xff\"}}";
    let (out, err, code) = e.call_bytes(input, 500);
    assert_eq!((out.as_str(), code), ("", 2));
    assert!(err.contains("fallback unavailable"), "{err:?}");
    assert!(e.log().contains("fallback_fail"), "logged: {:?}", e.log());
}

#[test]
fn forced_fallback_incomplete_output_follows_the_event_fail_mode() {
    let e = Env::new("forced-incomplete-guard", "cat >/dev/null\n(exec sleep 5) &\necho EARLY\nexit 0\n");
    let input = b"{\"hook_event_name\":\"PreToolUse\",\"tool_name\":\"Bash\",\"tool_input\":{\"command\":\"npm test \xff\"}}";
    let (out, err, code) = e.call_bytes(input, 500);
    assert_eq!((out.as_str(), code), ("", 2));
    assert!(err.contains("no decision was made"), "{err:?}");

    let e = Env::new("forced-incomplete-nonguard", "cat >/dev/null\n(exec sleep 5) &\necho EARLY\nexit 0\n");
    let input = b"{\"hook_event_name\":\"SessionStart\",\"source\":\"startup \xff\"}";
    let (out, err, code) = e.call_bytes(input, 500);
    assert_eq!((out.as_str(), code), ("", 0));
    assert!(err.contains("no decision was made"), "{err:?}");
}

#[test]
fn a_timed_out_hook_takes_its_helpers_down_with_it() {
    // the helper writes a marker after the deadline passes; killed with the group, it never does
    let e = Env::new("group", "cat >/dev/null\n(sleep 3; echo late > \"$(dirname \"$0\")/marker\") &\nsleep 30\n");
    assert_eq!(e.call(500), (String::new(), String::new(), 0));
    std::thread::sleep(std::time::Duration::from_millis(3500));
    assert!(!e.dir.join("marker").exists(), "a helper outlived the killed hook");
}
