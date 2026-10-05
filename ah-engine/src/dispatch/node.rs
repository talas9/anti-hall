//! Running an event's Node hooks the way the host runs them: each `hooks.json` command under the shell, all at once,
//! with the payload on stdin, stdout and stderr captured, and the entry's own timeout. A hook that runs longer is
//! killed with its whole process group and counts as having said nothing, as the host discards a timed-out hook.
//!
//! Every hook ends with a [`Fate`], so the dispatcher can tell "the hook ran and said nothing" (an allow) from "the hook
//! could not be run" (no decision: on a guard event that must never read as an allow, D74).
use super::combine::{self, HookResult};
use super::table::Entry;
use crate::defaults;
use std::io::{Read, Write};
use std::os::unix::process::CommandExt;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

/// How a hook ended, apart from what it printed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Fate {
    /// It ran to its end and its output is whole (or it exited 2 / printed a JSON block, whose partial output is kept).
    Ran,
    /// It was still running at its timeout and was killed with its group; the host discards such a hook.
    Timeout,
    /// The command could not be started at all (no shell, EAGAIN, a command the OS refuses).
    Spawn,
    /// It was killed by a signal (an OOM kill, a crash) or could not be waited for.
    Died,
    /// It finished but a process it left behind still held its output open, so the output is incomplete.
    Incomplete,
}

/// A hook's result and how it ended.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Finished {
    /// What the hook produced (no exit code when it did not finish normally).
    pub result: HookResult,
    /// How it ended.
    pub fate: Fate,
}

/// What a reader thread has collected so far, shared so a pipe still held open by a leftover process does not hide the
/// bytes that did arrive (a hook that exited 2 has blocked, whatever else holds its pipes).
struct Capture {
    buf: Arc<Mutex<Vec<u8>>>,
    done: Arc<AtomicBool>,
    /// The read failed before the end of the pipe: what is in `buf` is not the whole output.
    failed: Arc<AtomicBool>,
}

impl Capture {
    /// The bytes so far, as text, and whether the pipe was read to its end (a read error is not an end). Waits up to
    /// `dispatch.read_ms` for the end.
    fn collect(&self) -> (String, bool) {
        let deadline = Instant::now() + defaults::millis("dispatch.read_ms");
        while !self.done.load(Ordering::Acquire) && Instant::now() < deadline {
            std::thread::sleep(defaults::millis("dispatch.poll_ms"));
        }
        let complete = self.done.load(Ordering::Acquire) && !self.failed.load(Ordering::Acquire);
        let bytes = self.buf.lock().map(|b| b.clone()).unwrap_or_default();
        (String::from_utf8_lossy(&bytes).to_string(), complete)
    }
}

/// A Node hook that has been started.
pub struct Running {
    id: String,
    child: Option<Child>,
    out: Option<Capture>,
    err: Option<Capture>,
    timeout: Duration,
    started: Instant,
}

fn reader<R: Read + Send + 'static>(r: Option<R>) -> Option<Capture> {
    let mut r = r?;
    let cap = Capture { buf: Arc::new(Mutex::new(Vec::new())), done: Arc::new(AtomicBool::new(false)), failed: Arc::new(AtomicBool::new(false)) };
    let (buf, done, failed) = (cap.buf.clone(), cap.done.clone(), cap.failed.clone());
    std::thread::spawn(move || {
        let mut chunk = [0u8; 8192];
        loop {
            match r.read(&mut chunk) {
                Ok(0) => break,
                Ok(n) => {
                    if let Ok(mut b) = buf.lock() {
                        b.extend_from_slice(&chunk[..n]);
                    }
                }
                Err(e) if e.kind() == std::io::ErrorKind::Interrupted => {}
                Err(_) => {
                    failed.store(true, Ordering::Release);
                    break;
                }
            }
        }
        done.store(true, Ordering::Release);
    });
    Some(cap)
}

/// Start `entry`'s command with `payload` on stdin. A command that cannot start is a hook with no child (its fate is
/// [`Fate::Spawn`]; the host's "could not run" is no decision either).
pub fn start(entry: &Entry, payload: &[u8]) -> Running {
    let shell = defaults::list("dispatch.shell");
    let child = Command::new(shell.first().copied().unwrap_or_default())
        .args(&shell[1.min(shell.len())..])
        .arg(&entry.command)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .process_group(0)
        .spawn()
        .ok();
    let mut child = child;
    let (mut out, mut err) = (None, None);
    if let Some(c) = child.as_mut() {
        if let Some(mut stdin) = c.stdin.take() {
            let data = payload.to_vec();
            std::thread::spawn(move || {
                let _ = stdin.write_all(&data);
            });
        }
        out = reader(c.stdout.take());
        err = reader(c.stderr.take());
    }
    Running {
        id: entry.id.clone(),
        child,
        out,
        err,
        timeout: Duration::from_secs(
            if entry.timeout_s == 0 { defaults::num("dispatch.default_timeout_s") } else { entry.timeout_s }.min(defaults::num("dispatch.max_timeout_s")),
        ),
        started: Instant::now(),
    }
}

/// How the wait for one hook ended.
#[derive(Clone, Copy)]
enum Waited {
    Code(i32),
    Signal,
    TimedOut,
    NotStarted,
}

/// Wait for every started hook (each up to its own timeout) and return what each produced, in the same order.
pub fn finish(mut running: Vec<Running>) -> Vec<Finished> {
    let poll = defaults::millis("dispatch.poll_ms");
    let mut waited: Vec<Option<Waited>> = running.iter().map(|r| if r.child.is_none() { Some(Waited::NotStarted) } else { None }).collect();
    while waited.iter().any(Option::is_none) {
        for (i, r) in running.iter_mut().enumerate() {
            if waited[i].is_some() {
                continue;
            }
            let Some(c) = r.child.as_mut() else { continue };
            let end = |c: &mut Child, how: Waited| {
                // SAFETY: killpg only sends a signal; the group id is the child we spawned as its own group leader
                unsafe {
                    libc::killpg(c.id() as libc::pid_t, libc::SIGKILL);
                }
                let _ = c.kill();
                let _ = c.wait();
                how
            };
            waited[i] = match c.try_wait() {
                Ok(Some(st)) => Some(st.code().map_or(Waited::Signal, Waited::Code)),
                Ok(None) if r.started.elapsed() < r.timeout => None,
                // over its timeout: kill the whole group, the host would have discarded it
                Ok(None) => Some(end(c, Waited::TimedOut)),
                // unwaitable: its state is unknown, so it is no answer
                Err(_) => Some(end(c, Waited::Signal)),
            };
        }
        if waited.iter().any(Option::is_none) {
            std::thread::sleep(poll);
        }
    }
    running.into_iter().zip(waited).map(|(r, w)| conclude(r, w.unwrap_or(Waited::NotStarted))).collect()
}

fn nothing(id: String) -> HookResult {
    HookResult { id, code: None, out: String::new(), err: String::new() }
}

/// The result of one waited hook: its output when whole, and the right [`Fate`] when it is not.
fn conclude(r: Running, w: Waited) -> Finished {
    let log = |kind: &str, key: &str| crate::health::log_event(kind, &r.id, defaults::text(key));
    let code = match w {
        Waited::Code(c) => c,
        Waited::TimedOut => {
            log("dispatch_hook_timeout", "dispatch.msg_hook_timeout");
            return Finished { result: nothing(r.id), fate: Fate::Timeout };
        }
        Waited::Signal => {
            log("dispatch_hook_died", "dispatch.msg_hook_died");
            return Finished { result: nothing(r.id), fate: Fate::Died };
        }
        Waited::NotStarted => {
            log("dispatch_hook_spawn", "dispatch.msg_hook_spawn");
            return Finished { result: nothing(r.id), fate: Fate::Spawn };
        }
    };
    let (out, out_whole) = r.out.as_ref().map_or((String::new(), true), Capture::collect);
    let (err, err_whole) = r.err.as_ref().map_or((String::new(), true), Capture::collect);
    if out_whole && err_whole {
        return Finished { result: HookResult { id: r.id, code: Some(code), out, err }, fate: Fate::Ran };
    }
    log("fallback_read_timeout", "msg.log_fallback_read_timeout");
    // A hook that exited 2 has blocked, and one whose partial output is a JSON block has decided: a leftover process
    // holding the pipes must not turn either into "no decision". Anything else incomplete is an explicit error, never an
    // empty answer that reads as an allow.
    if code == 2 || combine::json_blocks(&out) {
        return Finished { result: HookResult { id: r.id, code: Some(code), out, err }, fate: Fate::Ran };
    }
    let err = format!("{}\n", defaults::text("msg.fallback_read_timeout"));
    Finished { result: HookResult { id: r.id, code: Some(1), out: String::new(), err }, fate: Fate::Incomplete }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(id: &str, command: &str, timeout_s: u64) -> Entry {
        Entry { id: id.into(), matcher: String::new(), command: command.into(), timeout_s, check: None }
    }

    #[test]
    fn hooks_run_at_once_with_the_payload_and_report_in_order() {
        let started = Instant::now();
        let es = [entry("a", "sleep 0.3; cat; echo err >&2; exit 2", 5), entry("b", "sleep 0.3; printf b", 5), entry("c", "exit 0", 5)];
        let rs: Vec<HookResult> = finish(es.iter().map(|e| start(e, b"{\"x\":1}")).collect()).into_iter().map(|f| f.result).collect();
        assert!(started.elapsed() < Duration::from_millis(900), "the hooks ran one after another: {:?}", started.elapsed());
        assert_eq!(rs[0], HookResult { id: "a".into(), code: Some(2), out: "{\"x\":1}".into(), err: "err\n".into() });
        assert_eq!(rs[1].out, "b");
        assert_eq!(rs[2], HookResult::quiet("c"));
    }

    #[test]
    fn a_hook_that_exits_with_its_output_still_open_is_an_error_not_an_empty_answer() {
        // the background `sleep` keeps the stdout pipe open past dispatch.read_ms; the shell itself exits at once
        let rs = finish(vec![start(&entry("leaky", "echo early; (exec sleep 4) & exit 0", 30), b"")]);
        assert_eq!(rs[0].fate, Fate::Incomplete);
        assert_eq!(rs[0].result.code, Some(1));
        assert!(rs[0].result.out.is_empty() && rs[0].result.err.contains("not complete"), "{:?}", rs[0]);
    }

    #[test]
    fn an_entry_without_a_timeout_gets_the_hosts_default_not_zero() {
        let rs = finish(vec![start(&entry("none", "sleep 0.2; printf kept", 0), b"")]);
        assert_eq!(rs[0].result, HookResult { id: "none".into(), code: Some(0), out: "kept".into(), err: String::new() });
    }

    #[test]
    fn a_hook_over_its_timeout_is_killed_with_its_group_and_says_nothing() {
        let started = Instant::now();
        let rs = finish(vec![start(&entry("slow", "echo partial; sleep 30 & sleep 30", 1), b"")]);
        assert!(started.elapsed() < Duration::from_secs(5));
        assert_eq!(rs[0], Finished { result: HookResult { id: "slow".into(), code: None, out: String::new(), err: String::new() }, fate: Fate::Timeout });
    }

    #[test]
    fn a_hook_that_exits_two_keeps_its_block_while_a_leftover_process_holds_its_pipes() {
        let rs = finish(vec![start(&entry("blocker", "echo BLOCKED >&2; echo part; (exec sleep 4) & exit 2", 30), b"")]);
        assert_eq!(rs[0].fate, Fate::Ran);
        assert_eq!(rs[0].result, HookResult { id: "blocker".into(), code: Some(2), out: "part\n".into(), err: "BLOCKED\n".into() });
    }

    #[test]
    fn a_json_block_survives_a_leftover_process_holding_the_pipes() {
        let deny = r#"{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny"}}"#;
        let rs = finish(vec![start(&entry("deny", &format!("echo '{deny}'; (exec sleep 4) & exit 0"), 30), b"")]);
        assert_eq!(rs[0].fate, Fate::Ran);
        assert_eq!((rs[0].result.code, rs[0].result.out.trim()), (Some(0), deny));
    }

    #[test]
    fn a_hook_that_cannot_start_or_dies_by_a_signal_has_its_own_fate_and_no_exit_code() {
        // a NUL in the command makes the OS refuse to start it (the stand-in for EAGAIN)
        let rs = finish(vec![start(&entry("nospawn", "a\0b", 5), b""), start(&entry("killed", "kill -9 $$", 5), b"")]);
        assert_eq!((rs[0].fate, rs[0].result.code), (Fate::Spawn, None));
        assert_eq!((rs[1].fate, rs[1].result.code), (Fate::Died, None));
    }

    /// Some bytes, then a read error (not an end of file).
    struct Broken(bool);

    impl Read for Broken {
        fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
            if self.0 {
                return Err(std::io::Error::other("injected read error"));
            }
            self.0 = true;
            buf[..4].copy_from_slice(b"part");
            Ok(4)
        }
    }

    #[test]
    fn a_read_error_on_a_pipe_is_incomplete_output_not_a_whole_answer() {
        let running =
            Running { id: "broken".into(), child: None, out: reader(Some(Broken(false))), err: None, timeout: Duration::from_secs(5), started: Instant::now() };
        let f = conclude(running, Waited::Code(0));
        assert_eq!(f.fate, Fate::Incomplete);
        assert_eq!(f.result.code, Some(1));
        assert!(f.result.out.is_empty(), "{f:?}");
    }
}
