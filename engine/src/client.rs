//! Hook client. Contract: NEVER fail the host. Any error, panic or timeout prints nothing and exits 0.
use crate::paths;
use std::io::{Read, Write};
use std::os::unix::net::UnixStream;
use std::os::unix::process::CommandExt;
use std::path::Path;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

const REPLY_TIMEOUT: Duration = Duration::from_millis(1500);
/// How long a cold start may take before this call gives up (fail-open) and lets the daemon finish
/// coming up for the next call.
const COLD_START_WAIT: Duration = Duration::from_millis(40);

fn exchange(sock: &Path, payload: &[u8]) -> Option<String> {
    let mut s = UnixStream::connect(sock).ok()?;
    s.set_read_timeout(Some(REPLY_TIMEOUT)).ok()?;
    s.set_write_timeout(Some(REPLY_TIMEOUT)).ok()?;
    s.write_all(payload).ok()?;
    s.shutdown(std::net::Shutdown::Write).ok()?;
    let mut out = String::new();
    s.read_to_string(&mut out).ok()?;
    Some(out)
}

/// `Some("pong <version> <pid>")` when a daemon answers on `sock`.
pub fn ping(sock: &Path) -> Option<String> {
    exchange(sock, b"CTL ping\n").filter(|r| r.starts_with("pong "))
}

/// Send a control verb (`reload`, `stop`, `ping`).
pub fn ctl(verb: &str) -> Option<String> {
    exchange(&paths::socket(), format!("CTL {verb}\n").as_bytes())
}

fn spawn_daemon() -> Option<std::process::Child> {
    if std::env::var_os("ANTIHALL_ENGINE_NOSPAWN").is_some() {
        return None;
    }
    Command::new(std::env::current_exe().ok()?)
        .arg("serve")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .process_group(0)
        .spawn()
        .ok()
}

/// Core of `engine hook`: returns the text to print (possibly empty). Pure of process exit.
pub fn run(raw: &str) -> String {
    if raw.trim().is_empty() {
        return String::new();
    }
    let sock = paths::socket();
    let payload = format!("V {}\n{}", crate::version(), raw);
    if let Some(r) = exchange(&sock, payload.as_bytes()) {
        return r;
    }
    // No daemon (or it is mid-handoff): start one, wait briefly, retry once.
    let Some(mut child) = spawn_daemon() else { return String::new() };
    let start = Instant::now();
    while start.elapsed() < COLD_START_WAIT {
        if matches!(child.try_wait(), Ok(Some(_))) && ping(&sock).is_none() {
            return String::new(); // daemon could not start (unwritable dir, ...): fail open immediately
        }
        if let Some(r) = exchange(&sock, payload.as_bytes()) {
            return r;
        }
        std::thread::sleep(Duration::from_millis(1));
    }
    String::new()
}

/// `engine hook`: read stdin, print the reply, exit 0 no matter what.
pub fn hook_main() -> i32 {
    let _ = std::panic::catch_unwind(|| {
        let mut raw = String::new();
        let _ = std::io::stdin().take(8 * 1024 * 1024).read_to_string(&mut raw);
        let out = run(&raw);
        if !out.is_empty() {
            let mut so = std::io::stdout();
            let _ = so.write_all(out.as_bytes());
            let _ = so.write_all(b"\n");
            let _ = so.flush();
        }
    });
    0
}
