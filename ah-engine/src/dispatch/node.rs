//! Running an event's Node hooks the way the host runs them: each `hooks.json` command under the shell, all at once,
//! with the payload on stdin, stdout and stderr captured, and the entry's own timeout. A hook that runs longer is
//! killed with its whole process group and counts as having said nothing, as the host discards a timed-out hook.
use super::combine::HookResult;
use super::table::Entry;
use crate::defaults;
use std::io::{Read, Write};
use std::os::unix::process::CommandExt;
use std::process::{Child, Command, Stdio};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

/// A Node hook that has been started.
pub struct Running {
    id: String,
    child: Option<Child>,
    out: Option<JoinHandle<Vec<u8>>>,
    err: Option<JoinHandle<Vec<u8>>>,
    timeout: Duration,
    started: Instant,
}

fn reader<R: Read + Send + 'static>(r: Option<R>) -> Option<JoinHandle<Vec<u8>>> {
    let mut r = r?;
    Some(std::thread::spawn(move || {
        let mut b = Vec::new();
        let _ = r.read_to_end(&mut b);
        b
    }))
}

/// Start `entry`'s command with `payload` on stdin. A command that cannot start is a result with no exit code (the
/// host's "could not run" is no decision either).
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
        timeout: Duration::from_secs(if entry.timeout_s == 0 { defaults::num("dispatch.default_timeout_s") } else { entry.timeout_s }),
        started: Instant::now(),
    }
}

/// The bytes a reader thread collected; `None` when its pipe was still open `dispatch.read_ms` after the hook exited
/// (a process the hook left behind holds it), so the output is incomplete and must not pass for an empty one.
fn join(h: Option<JoinHandle<Vec<u8>>>) -> Option<String> {
    let Some(h) = h else { return Some(String::new()) };
    let deadline = Instant::now() + defaults::millis("dispatch.read_ms");
    while !h.is_finished() {
        if Instant::now() >= deadline {
            return None;
        }
        std::thread::sleep(defaults::millis("dispatch.poll_ms"));
    }
    Some(String::from_utf8_lossy(&h.join().unwrap_or_default()).to_string())
}

/// Wait for every started hook (each up to its own timeout) and return their results in the same order.
pub fn finish(mut running: Vec<Running>) -> Vec<HookResult> {
    let poll = defaults::millis("dispatch.poll_ms");
    let mut codes: Vec<Option<Option<i32>>> = running.iter().map(|r| if r.child.is_none() { Some(None) } else { None }).collect();
    while codes.iter().any(Option::is_none) {
        for (i, r) in running.iter_mut().enumerate() {
            if codes[i].is_some() {
                continue;
            }
            let Some(c) = r.child.as_mut() else { continue };
            match c.try_wait() {
                Ok(Some(st)) => codes[i] = Some(st.code()),
                Ok(None) if r.started.elapsed() < r.timeout => {}
                _ => {
                    // over its timeout (or unwaitable): kill the whole group, the host would have discarded it
                    // SAFETY: killpg only sends a signal; the group id is the child we spawned as its own group leader
                    unsafe {
                        libc::killpg(c.id() as libc::pid_t, libc::SIGKILL);
                    }
                    let _ = c.kill();
                    let _ = c.wait();
                    codes[i] = Some(None);
                }
            }
        }
        if codes.iter().any(Option::is_none) {
            std::thread::sleep(poll);
        }
    }
    running
        .into_iter()
        .zip(codes)
        .map(|(r, code)| {
            let code = code.flatten();
            let (out, err) = (join(r.out), join(r.err));
            match (code, out, err) {
                (Some(c), Some(out), Some(err)) => HookResult { id: r.id, code: Some(c), out, err },
                (Some(_), _, _) => {
                    // finished, but its output is incomplete: an explicit error, never an empty answer that reads as an allow
                    crate::health::log_event("fallback_read_timeout", &r.id, defaults::text("msg.log_fallback_read_timeout"));
                    HookResult { id: r.id, code: Some(1), out: String::new(), err: format!("{}\n", defaults::text("msg.fallback_read_timeout")) }
                }
                (None, _, _) => HookResult { id: r.id, code: None, out: String::new(), err: String::new() },
            }
        })
        .collect()
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
        let rs = finish(es.iter().map(|e| start(e, b"{\"x\":1}")).collect());
        assert!(started.elapsed() < Duration::from_millis(900), "the hooks ran one after another: {:?}", started.elapsed());
        assert_eq!(rs[0], HookResult { id: "a".into(), code: Some(2), out: "{\"x\":1}".into(), err: "err\n".into() });
        assert_eq!(rs[1].out, "b");
        assert_eq!(rs[2], HookResult::quiet("c"));
    }

    #[test]
    fn a_hook_that_exits_with_its_output_still_open_is_an_error_not_an_empty_answer() {
        // the background `sleep` keeps the stdout pipe open past dispatch.read_ms; the shell itself exits at once
        let rs = finish(vec![start(&entry("leaky", "echo early; (exec sleep 4) & exit 0", 30), b"")]);
        assert_eq!(rs[0].code, Some(1));
        assert!(rs[0].out.is_empty() && rs[0].err.contains("not complete"), "{:?}", rs[0]);
    }

    #[test]
    fn an_entry_without_a_timeout_gets_the_hosts_default_not_zero() {
        let rs = finish(vec![start(&entry("none", "sleep 0.2; printf kept", 0), b"")]);
        assert_eq!(rs[0], HookResult { id: "none".into(), code: Some(0), out: "kept".into(), err: String::new() });
    }

    #[test]
    fn a_hook_over_its_timeout_is_killed_with_its_group_and_says_nothing() {
        let started = Instant::now();
        let rs = finish(vec![start(&entry("slow", "echo partial; sleep 30 & sleep 30", 1), b"")]);
        assert!(started.elapsed() < Duration::from_secs(5));
        assert_eq!(rs[0], HookResult { id: "slow".into(), code: None, out: String::new(), err: String::new() });
    }
}
