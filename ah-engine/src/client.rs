//! Hook client. Contract: NEVER fail the host and NEVER mistake a bad reply for "allow".
//!
//! Order of events for `engine hook [--fallback <hook.js>]`:
//!  1. ask the daemon (2 s overall deadline, framed reply, size-capped input);
//!  2. a complete OK frame is the answer (its body may be empty = nothing to say);
//!  3. anything else (no daemon, BUSY, ERR, timeout, truncated/corrupt frame, breaker open, crash-loop
//!     stop) runs the Node hook given by `--fallback` / `AH_ENGINE_FALLBACK`, whose stdout and exit
//!     code are passed through;
//!  4. only when there is no usable fallback does the client print nothing and exit 0.
//!
//! The fallback command is chosen by the caller (argument or env), never by anything in the payload.
use crate::config::{ClientConfig, MAX_REQUEST};
use crate::frame::{self, Kind};
use crate::{health, paths};
use std::io::{Read, Write};
use std::os::unix::fs::{FileTypeExt, MetadataExt};
use std::os::unix::net::UnixStream;
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::time::{Duration, Instant};

/// How long a cold start may take before a client with NO fallback gives up (prints nothing).
const COLD_START_WAIT: Duration = Duration::from_millis(40);
const MAX_REPLY: u64 = 2 * 1024 * 1024;

/// Result of one exchange with the daemon.
#[derive(Debug)]
pub enum Exch {
    /// A complete, checksum-valid reply frame.
    Reply(Kind, String),
    /// Nothing is listening (no socket, or connection refused).
    Absent,
    /// A daemon may be there but the exchange failed: timeout, unsafe socket, bad or truncated frame.
    Failed(String),
}

fn exchange_inner(sock: &Path, payload: &[u8], deadline: Duration) -> Exch {
    match std::fs::symlink_metadata(sock) {
        Err(_) => return Exch::Absent,
        Ok(m) if !m.file_type().is_socket() || m.uid() != crate::limits::uid() => return Exch::Failed("socket is not a socket owned by this user".into()),
        Ok(_) => {}
    }
    let mut s = match UnixStream::connect(sock) {
        Ok(s) => s,
        Err(e) if matches!(e.kind(), std::io::ErrorKind::ConnectionRefused | std::io::ErrorKind::NotFound) => return Exch::Absent,
        Err(e) => return Exch::Failed(format!("connect: {e}")),
    };
    let io = |r: std::io::Result<()>, what: &str| r.map_err(|e| Exch::Failed(format!("{what}: {e}")));
    if let Err(e) = io(s.set_read_timeout(Some(deadline)), "set timeout")
        .and_then(|_| io(s.set_write_timeout(Some(deadline)), "set timeout"))
        .and_then(|_| io(s.write_all(payload), "write"))
        .and_then(|_| io(s.shutdown(std::net::Shutdown::Write), "shutdown"))
    {
        return e;
    }
    let mut buf = Vec::new();
    if let Err(e) = (&mut s).take(MAX_REPLY).read_to_end(&mut buf) {
        return Exch::Failed(format!("read: {e}"));
    }
    match frame::decode(&buf) {
        Ok((k, body)) => Exch::Reply(k, body),
        Err(e) => Exch::Failed(format!("bad reply frame: {e:?}")),
    }
}

/// One exchange under a hard overall deadline (the work runs on a thread so even a blocking connect
/// cannot outlive it).
pub fn exchange(sock: &Path, payload: &[u8], deadline: Duration) -> Exch {
    let (tx, rx) = mpsc::channel();
    let (sock, payload) = (sock.to_path_buf(), payload.to_vec());
    std::thread::spawn(move || {
        let _ = tx.send(exchange_inner(&sock, &payload, deadline));
    });
    rx.recv_timeout(deadline + Duration::from_millis(50)).unwrap_or_else(|_| Exch::Failed("timeout".into()))
}

fn ctl_body(sock: &Path, req: &str) -> Option<String> {
    match exchange(sock, req.as_bytes(), Duration::from_millis(1500)) {
        Exch::Reply(Kind::Ok, b) => Some(b),
        _ => None,
    }
}

/// `Some("pong <version> <pid>")` when a daemon answers on `sock`.
pub fn ping(sock: &Path) -> Option<String> {
    ctl_body(sock, "CTL ping\n").filter(|r| r.starts_with("pong "))
}

/// Send a control verb (`reload`, `stop`, `ping`, `status`).
pub fn ctl(verb: &str) -> Option<String> {
    ctl_body(&paths::socket(), &format!("CTL {verb}\n"))
}

/// A project-partitioned state operation (see `store.rs`): the daemon derives the partition from `cwd`.
pub fn proj(cwd: &str, verb: &str, args: &str) -> Option<String> {
    ctl_body(&paths::socket(), &format!("P {cwd}\n{verb} {args}"))
}

/// `engine status`: the daemon's own numbers, or what the state dir says when it is down.
pub fn status() -> String {
    if let Some(s) = ctl("status") {
        return s;
    }
    let ev = health::events();
    serde_json::json!({
        "running": false,
        "breaker": health::breaker_remaining().map_or("closed".to_string(), |d| format!("open ({} s left)", d.as_secs() + 1)),
        "crashloop": health::crashloop_remaining().map_or("clear".to_string(), |d| format!("stopped ({} s left)", d.as_secs() + 1)),
        "last_event": ev.last().map(|e| format!("{} {}", e.kind, e.code)),
    })
    .to_string()
}

fn spawn_daemon() -> Option<std::process::Child> {
    if std::env::var_os("AH_ENGINE_NOSPAWN").is_some() {
        return None;
    }
    Command::new(std::env::current_exe().ok()?).arg("serve").stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).process_group(0).spawn().ok()
}

/// What `hook` prints and exits with.
#[derive(Debug, PartialEq, Eq)]
pub struct Outcome {
    /// What to print on stdout.
    pub out: String,
    /// The process exit code.
    pub code: i32,
    /// Text for stderr (a built-in check that blocks the way the Node guards do: exit 2 + reason on stderr).
    pub err: String,
}

/// Ask the engine. `None` = use the fallback.
fn engine_attempt(raw: &str, cfg: &ClientConfig, have_fallback: bool) -> Option<String> {
    if raw.len() as u64 > MAX_REQUEST || health::breaker_remaining().is_some() || health::crashloop_remaining().is_some() {
        return None;
    }
    let sock = paths::socket();
    let payload = format!("V {}\n{}", crate::version(), raw);
    match exchange(&sock, payload.as_bytes(), cfg.deadline) {
        Exch::Reply(Kind::Ok, body) => Some(body),
        Exch::Reply(_, _) => None, // BUSY or ERR: the daemon shed or could not evaluate it
        Exch::Failed(why) => {
            health::breaker_failure(cfg, &why);
            None
        }
        Exch::Absent => {
            if health::crashloop_tripped(cfg) {
                return None;
            }
            let mut child = spawn_daemon()?;
            if have_fallback {
                return None; // the Node hook answers this call; the daemon is up for the next one
            }
            let start = Instant::now();
            while start.elapsed() < COLD_START_WAIT {
                if let Ok(Some(st)) = child.try_wait() {
                    use std::os::unix::process::ExitStatusExt;
                    if let Some(sig) = st.signal() {
                        health::log_event("start_fail", &format!("sig{sig}"), "daemon killed while starting");
                        health::record_failure("start_fail", &format!("sig{sig}"), "daemon killed while starting");
                    }
                    ping(&sock)?;
                }
                if let Exch::Reply(Kind::Ok, body) = exchange(&sock, payload.as_bytes(), cfg.deadline) {
                    return Some(body);
                }
                std::thread::sleep(Duration::from_millis(1));
            }
            None
        }
    }
}

/// Run the Node hook: stdin = the payload; stdout and exit code are returned; stderr is inherited.
/// `None` when it cannot run or does not finish in time (= the fallback is unavailable).
fn run_fallback(raw: &str, path: &Path, cfg: &ClientConfig) -> Option<Outcome> {
    let node = std::env::var_os("AH_ENGINE_NODE").unwrap_or_else(|| "node".into());
    let mut child = Command::new(node).arg(path).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::inherit()).spawn().ok()?;
    let mut stdin = child.stdin.take()?;
    let data = raw.as_bytes().to_vec();
    std::thread::spawn(move || {
        let _ = stdin.write_all(&data);
    });
    let mut stdout = child.stdout.take()?;
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        let mut b = Vec::new();
        let _ = stdout.read_to_end(&mut b);
        let _ = tx.send(b);
    });
    let start = Instant::now();
    let status = loop {
        match child.try_wait() {
            Ok(Some(st)) => break st,
            Ok(None) if start.elapsed() < cfg.fallback_timeout => std::thread::sleep(Duration::from_millis(2)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                health::log_event("fallback_fail", "timeout", "node fallback did not finish");
                return None;
            }
        }
    };
    let bytes = rx.recv_timeout(Duration::from_millis(500)).unwrap_or_default();
    Some(Outcome { out: String::from_utf8_lossy(&bytes).to_string(), code: status.code().unwrap_or(0), err: String::new() })
}

/// Core of `engine hook`. Pure of process exit.
pub fn run(raw: &str, fallback: Option<&Path>) -> Outcome {
    if raw.trim().is_empty() {
        return Outcome { out: String::new(), code: 0, err: String::new() };
    }
    let cfg = ClientConfig::from_env();
    if let Some(out) = engine_attempt(raw, &cfg, fallback.is_some()) {
        if let Some(reason) = out.strip_prefix(crate::hookio::EXIT2) {
            return Outcome { out: String::new(), code: 2, err: reason.to_string() };
        }
        return Outcome { out, code: 0, err: String::new() };
    }
    let mut o = fallback.and_then(|p| run_fallback(raw, p, &cfg)).unwrap_or(Outcome { out: String::new(), code: 0, err: String::new() });
    // We are running on the built-in checks: tell the agent once per session if the engine is in a known-bad state.
    if o.code == 0 && paths::dir().join("failure.json").exists() {
        if let Ok(p) = serde_json::from_str::<serde_json::Value>(raw) {
            let session = p["session_id"].as_str().unwrap_or("-");
            let event = ["hook_event_name", "hookEventName", "event"].iter().find_map(|k| p[*k].as_str()).unwrap_or("");
            if let Some(text) = health::advisory(session) {
                if let Some(m) = health::merge_advisory(event, o.out.trim(), &text) {
                    o.out = m;
                }
            }
        }
    }
    o
}

fn fallback_arg(args: &[String]) -> Option<PathBuf> {
    args.iter()
        .position(|a| a == "--fallback")
        .and_then(|i| args.get(i + 1))
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("AH_ENGINE_FALLBACK").map(PathBuf::from))
}

/// `engine hook`: read stdin, print the result, exit with the Node hook's code (0 when the engine answered).
pub fn hook_main(args: &[String]) -> i32 {
    let res = std::panic::catch_unwind(|| {
        let mut raw = String::new();
        let _ = std::io::stdin().take(8 * 1024 * 1024).read_to_string(&mut raw);
        let o = run(&raw, fallback_arg(args).as_deref());
        if !o.err.is_empty() {
            let mut se = std::io::stderr();
            let _ = se.write_all(o.err.as_bytes());
            let _ = se.flush();
        }
        if !o.out.is_empty() {
            let mut so = std::io::stdout();
            let _ = so.write_all(o.out.as_bytes());
            if !o.out.ends_with('\n') {
                let _ = so.write_all(b"\n");
            }
            let _ = so.flush();
        }
        o.code
    });
    res.unwrap_or(0)
}
