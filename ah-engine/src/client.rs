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
use crate::config::ClientConfig;
use crate::frame::{self, Kind};
use crate::{defaults, health, paths};
use std::io::{Read, Write};
use std::os::unix::fs::{FileTypeExt, MetadataExt};
use std::os::unix::net::UnixStream;
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::time::{Duration, Instant};

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
        Ok(m) if !m.file_type().is_socket() || m.uid() != crate::limits::uid() => return Exch::Failed(defaults::text("msg.client_bad_socket").into()),
        Ok(_) => {}
    }
    let mut s = match UnixStream::connect(sock) {
        Ok(s) => s,
        Err(e) if matches!(e.kind(), std::io::ErrorKind::ConnectionRefused | std::io::ErrorKind::NotFound) => return Exch::Absent,
        Err(e) => return Exch::Failed(defaults::render("msg.client_connect", &[("err", &e)])),
    };
    let io = |r: std::io::Result<()>, what: &str| r.map_err(|e| Exch::Failed(defaults::render("msg.client_io", &[("what", &what), ("err", &e)])));
    if let Err(e) = io(s.set_read_timeout(Some(deadline)), "set timeout")
        .and_then(|_| io(s.set_write_timeout(Some(deadline)), "set timeout"))
        .and_then(|_| io(s.write_all(payload), "write"))
        .and_then(|_| io(s.shutdown(std::net::Shutdown::Write), "shutdown"))
    {
        return e;
    }
    let mut buf = Vec::new();
    if let Err(e) = (&mut s).take(defaults::num("client.max_reply")).read_to_end(&mut buf) {
        return Exch::Failed(defaults::render("msg.client_io", &[("what", &"read"), ("err", &e)]));
    }
    match frame::decode(&buf) {
        Ok((k, body)) => Exch::Reply(k, body),
        Err(e) => Exch::Failed(defaults::render("msg.client_bad_frame", &[("err", &format!("{e:?}"))])),
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
    rx.recv_timeout(deadline + defaults::millis("client.deadline_slack_ms")).unwrap_or_else(|_| Exch::Failed(defaults::text("msg.client_timeout").into()))
}

fn ctl_body(sock: &Path, req: &str) -> Option<String> {
    match exchange(sock, req.as_bytes(), defaults::millis("client.ctl_timeout_ms")) {
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

/// The daemon's own status JSON, or what the state dir says when it is down.
pub fn status_value() -> serde_json::Value {
    if let Some(v) = ctl("status").and_then(|s| serde_json::from_str(&s).ok()) {
        return v;
    }
    let ev = health::events();
    serde_json::json!({
        "running": false,
        "breaker": health::breaker_remaining().map_or("closed".to_string(), |d| defaults::render("msg.state_open", &[("secs", &(d.as_secs() + 1))])),
        "crashloop": health::crashloop_remaining().map_or("clear".to_string(), |d| defaults::render("msg.state_stopped", &[("secs", &(d.as_secs() + 1))])),
        "last_event": ev.last().map(|e| format!("{} {}", e.kind, e.code)),
    })
}

/// `ah-engine status` as one JSON line.
pub fn status() -> String {
    status_value().to_string()
}

/// Send a control verb that answers with JSON (`metrics`, `impact`); `None` when there is no daemon or the reply is not JSON.
pub fn ctl_json(verb: &str) -> Option<serde_json::Value> {
    ctl(verb).and_then(|s| serde_json::from_str(&s).ok())
}

/// Start a detached daemon (unless the `nospawn` env var is set); `None` when it could not be started.
pub fn spawn_daemon() -> Option<std::process::Child> {
    if defaults::env_var("nospawn").is_some() {
        return None;
    }
    Command::new(std::env::current_exe().ok()?)
        .arg(defaults::text("health.serve_arg"))
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .process_group(0)
        .spawn()
        .ok()
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
    if raw.len() as u64 > crate::defaults::num("daemon.max_request") || health::breaker_remaining().is_some() || health::crashloop_remaining().is_some() {
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
            let cold_wait = defaults::millis("client.cold_start_wait_ms");
            while start.elapsed() < cold_wait {
                if let Ok(Some(st)) = child.try_wait() {
                    use std::os::unix::process::ExitStatusExt;
                    if let Some(sig) = st.signal() {
                        health::log_event("start_fail", &format!("sig{sig}"), defaults::text("msg.log_daemon_killed"));
                        health::record_failure("start_fail", &format!("sig{sig}"), defaults::text("msg.log_daemon_killed"));
                    }
                    ping(&sock)?;
                }
                if let Exch::Reply(Kind::Ok, body) = exchange(&sock, payload.as_bytes(), cfg.deadline) {
                    return Some(body);
                }
                std::thread::sleep(defaults::millis("client.cold_start_poll_ms"));
            }
            None
        }
    }
}

/// Run the Node hook: stdin = the payload; stdout and exit code are returned; stderr is inherited.
/// `None` when it cannot run or does not finish in time (= the fallback is unavailable).
fn run_fallback(raw: &str, path: &Path, cfg: &ClientConfig) -> Option<Outcome> {
    let node = std::env::var_os(defaults::env_name("node")).unwrap_or_else(|| "node".into());
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
            Ok(None) if start.elapsed() < cfg.fallback_timeout => std::thread::sleep(defaults::millis("client.fallback_poll_ms")),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                health::log_event("fallback_fail", "timeout", defaults::text("msg.log_fallback_timeout"));
                return None;
            }
        }
    };
    let bytes = rx.recv_timeout(defaults::millis("client.fallback_read_ms")).unwrap_or_default();
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
    if o.code == 0
        && paths::dir().join(defaults::text("files.failure")).exists()
        && let Ok(p) = serde_json::from_str::<serde_json::Value>(raw)
    {
        let session = p["session_id"].as_str().unwrap_or("-");
        let event = crate::hookio::event_of(&p).unwrap_or("");
        if let Some(text) = health::advisory(session)
            && let Some(m) = health::merge_advisory(event, o.out.trim(), &text)
        {
            o.out = m;
        }
    }
    o
}

fn fallback_arg(args: &[String]) -> Option<PathBuf> {
    args.iter()
        .position(|a| a == "--fallback")
        .and_then(|i| args.get(i + 1))
        .map(PathBuf::from)
        .or_else(|| std::env::var_os(defaults::env_name("fallback")).map(PathBuf::from))
}

/// `engine hook`: read stdin, print the result, exit with the Node hook's code (0 when the engine answered).
pub fn hook_main(args: &[String]) -> i32 {
    let res = std::panic::catch_unwind(|| {
        let mut raw = String::new();
        let _ = std::io::stdin().take(defaults::num("client.max_stdin")).read_to_string(&mut raw);
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
