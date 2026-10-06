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
    let payload = format!("V {}\n{}\n{}", crate::version(), crate::reqenv::RequestEnv::capture().to_line(), raw);
    attempt(payload.as_bytes(), cfg, have_fallback)
}

/// Send one request (a hook `V` or a dispatch `D` request) to the daemon, starting it when none answers. `None` =
/// use the fallback; with `have_fallback` a cold start does not wait (the Node hook answers this call).
pub(crate) fn attempt(payload: &[u8], cfg: &ClientConfig, have_fallback: bool) -> Option<String> {
    if health::breaker_remaining().is_some() || health::crashloop_remaining().is_some() {
        return None;
    }
    let sock = paths::socket();
    match exchange(&sock, payload, cfg.deadline) {
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
                if let Exch::Reply(Kind::Ok, body) = exchange(&sock, payload, cfg.deadline) {
                    return Some(body);
                }
                std::thread::sleep(defaults::millis("client.cold_start_poll_ms"));
            }
            None
        }
    }
}

/// Log a fallback failure; the state dir may not exist yet (no daemon ever ran here), and the event must still be on record.
fn log_fallback(kind: &str, code: &str, detail: &str) {
    let _ = crate::limits::ensure_private_dir(&paths::dir());
    health::log_event(kind, code, detail);
}

/// Read `stream` to EOF on a thread; the bytes arrive on the returned channel once, at EOF.
fn read_to_eof(mut stream: impl Read + Send + 'static) -> mpsc::Receiver<Vec<u8>> {
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        let mut b = Vec::new();
        let _ = stream.read_to_end(&mut b);
        let _ = tx.send(b);
    });
    rx
}

enum FallbackInput {
    Bytes(Vec<u8>),
    BytesThenStdin(Vec<u8>, std::io::Stdin),
}

enum FallbackResult {
    Answer(Outcome),
    NoDecision(Outcome),
}

/// Run the Node hook: stdin = the payload; stdout, stderr and the exit code are returned. Both streams are read to EOF,
/// bounded only by the overall deadline (`client.fallback_ms`), because a hook can exit before its output is complete
/// (a background process of its own holds the pipe) and an empty stdout would read as an allow.
///
/// `None` when it cannot run or does not finish in time (= the fallback is unavailable, as when the host's own timeout
/// kills a hook). A hook that finished but whose output was still unread at the deadline is an explicit error outcome
/// (exit 1, a message on stderr): never an empty stdout.
fn run_fallback(input: FallbackInput, path: &Path, cfg: &ClientConfig) -> Option<FallbackResult> {
    let node = std::env::var_os(defaults::env_name("node")).unwrap_or_else(|| "node".into());
    // its own process group, so a timeout can take its helpers down with it (they would otherwise hold the pipes open)
    let mut child = Command::new(node).arg(path).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped()).process_group(0).spawn().ok()?;
    let mut stdin = child.stdin.take()?;
    std::thread::spawn(move || match input {
        FallbackInput::Bytes(bytes) => {
            let _ = stdin.write_all(&bytes);
        }
        FallbackInput::BytesThenStdin(bytes, mut rest) => {
            let _ = stdin.write_all(&bytes);
            let _ = std::io::copy(&mut rest, &mut stdin);
        }
    });
    let (out_rx, err_rx) = (read_to_eof(child.stdout.take()?), read_to_eof(child.stderr.take()?));
    let deadline = Instant::now() + cfg.fallback_timeout;
    let (mut status, mut out, mut err) = (None, None, None);
    loop {
        status = status.or_else(|| child.try_wait().ok().flatten());
        out = out.or_else(|| out_rx.try_recv().ok());
        err = err.or_else(|| err_rx.try_recv().ok());
        if let (Some(st), Some(o), Some(e)) = (status, &out, &err) {
            use std::os::unix::process::ExitStatusExt;
            let Some(code) = st.code() else {
                // killed by a signal (out of memory, a crash): no decision, never an exit 0 that reads as an allow
                let sig = st.signal().unwrap_or(0);
                log_fallback("fallback_fail", &format!("sig{sig}"), &defaults::render("msg.log_fallback_signal", &[("signal", &sig)]));
                return Some(FallbackResult::NoDecision(Outcome {
                    out: String::new(),
                    code: 1,
                    err: format!("{}\n", defaults::render("msg.fallback_signal", &[("signal", &sig)])),
                }));
            };
            return Some(FallbackResult::Answer(Outcome { out: String::from_utf8_lossy(o).to_string(), code, err: String::from_utf8_lossy(e).to_string() }));
        }
        if Instant::now() >= deadline {
            break;
        }
        std::thread::sleep(defaults::millis("client.fallback_poll_ms"));
    }
    let finished = status.is_some();
    // the whole group, as `dispatch::node` does: a helper the hook left behind holds its pipes and must not outlive the deadline
    // SAFETY: killpg only sends a signal; the group id is the child we spawned as its own group leader
    unsafe {
        libc::killpg(child.id() as libc::pid_t, libc::SIGKILL);
    }
    if !finished {
        let _ = child.kill();
        let _ = child.wait();
        log_fallback("fallback_fail", "timeout", defaults::text("msg.log_fallback_timeout"));
        return None;
    }
    log_fallback("fallback_read_timeout", "-", defaults::text("msg.log_fallback_read_timeout"));
    Some(FallbackResult::NoDecision(Outcome { out: String::new(), code: 1, err: format!("{}\n", defaults::text("msg.fallback_read_timeout")) }))
}

/// What an OK reply body means: exact bytes, an exit-2 block, or plain stdout. `None` when the body claims to be exact
/// bytes but does not parse as such: a damaged verdict must never reach the host as plain stdout (an allow), so the caller
/// runs the Node fallback instead.
fn reply_outcome(body: String) -> Option<Outcome> {
    if let Some(j) = body.strip_prefix(crate::hookio::EXACT) {
        let x = serde_json::from_str::<(i32, String, String)>(j).ok()?;
        return Some(Outcome { out: x.1, code: x.0, err: x.2 });
    }
    if let Some(reason) = body.strip_prefix(crate::hookio::EXIT2) {
        return Some(Outcome { out: String::new(), code: 2, err: reason.to_string() });
    }
    Some(Outcome { out: body, code: 0, err: String::new() })
}

fn guarded(event: &str) -> bool {
    crate::defaults::list("dispatch.guard_events").contains(&event)
}

fn event_from_lossy(raw: &[u8]) -> Option<String> {
    let text = String::from_utf8_lossy(raw);
    if let Ok(p) = serde_json::from_str::<serde_json::Value>(&text) {
        return crate::hookio::event_of(&p).map(str::to_owned);
    }
    event_from_prefix(&text)
}

fn skip_ws(bytes: &[u8], mut i: usize) -> usize {
    while bytes.get(i).is_some_and(u8::is_ascii_whitespace) {
        i += 1;
    }
    i
}

fn string_end(bytes: &[u8], i: usize) -> Option<usize> {
    if bytes.get(i) != Some(&b'"') {
        return None;
    }
    let mut esc = false;
    for (off, b) in bytes[i + 1..].iter().enumerate() {
        if esc {
            esc = false;
        } else if *b == b'\\' {
            esc = true;
        } else if *b == b'"' {
            return Some(i + 1 + off + 1);
        }
    }
    None
}

fn skip_value(bytes: &[u8], mut i: usize) -> Option<usize> {
    let mut depth = 0usize;
    loop {
        match bytes.get(i).copied() {
            Some(b'"') => i = string_end(bytes, i)?,
            Some(b'{' | b'[') => {
                depth += 1;
                i += 1;
            }
            Some(b'}' | b']') if depth > 0 => {
                depth -= 1;
                i += 1;
            }
            Some(b',' | b'}') if depth == 0 => return Some(i),
            Some(_) => i += 1,
            None => return None,
        }
    }
}

fn best_event(keys: &[&str], found: &[(String, String)]) -> Option<String> {
    keys.iter().find_map(|want| found.iter().find(|(key, _)| key == want).map(|(_, value)| value.clone()))
}

fn event_from_prefix(text: &str) -> Option<String> {
    let keys = defaults::list("hook.event_keys");
    let bytes = text.as_bytes();
    let mut i = skip_ws(bytes, 0);
    if bytes.get(i) != Some(&b'{') {
        return None;
    }
    i += 1;
    let mut found: Vec<(String, String)> = Vec::new();
    loop {
        i = skip_ws(bytes, i);
        if bytes.get(i) == Some(&b'}') {
            break;
        }
        let key_end = match string_end(bytes, i) {
            Some(key_end) => key_end,
            None => return best_event(&keys, &found),
        };
        let key: String = match serde_json::from_str(&text[i..key_end]).ok() {
            Some(key) => key,
            None => return best_event(&keys, &found),
        };
        i = skip_ws(bytes, key_end);
        if bytes.get(i) != Some(&b':') {
            return best_event(&keys, &found);
        }
        i = skip_ws(bytes, i + 1);
        if keys.iter().any(|k| k == &key) {
            let value_end = match string_end(bytes, i) {
                Some(value_end) => value_end,
                None => return best_event(&keys, &found),
            };
            let value = match serde_json::from_str(&text[i..value_end]).ok() {
                Some(value) => value,
                None => return best_event(&keys, &found),
            };
            found.push((key, value));
            i = value_end;
        } else {
            i = match skip_value(bytes, i) {
                Some(i) => i,
                None => return best_event(&keys, &found),
            };
        }
        if bytes.get(i) == Some(&b',') {
            i += 1;
        }
    }
    best_event(&keys, &found)
}

/// Core of `engine hook`. Pure of process exit.
pub fn run(raw: &str, fallback: Option<&Path>) -> Outcome {
    run_bytes(raw.as_bytes().to_vec(), false, fallback, None, false)
}

/// Core of `engine hook` for raw stdin bytes. `force_fallback` means the client cannot safely ask the engine (invalid
/// UTF-8, a capped read, or a stdin read error), so the Node fallback receives the exact bytes the client read.
fn run_bytes(raw: Vec<u8>, force_fallback: bool, fallback: Option<&Path>, rest: Option<std::io::Stdin>, fail_closed_unavailable: bool) -> Outcome {
    if raw.is_empty() && !force_fallback {
        return Outcome { out: String::new(), code: 0, err: String::new() };
    }
    let cfg = ClientConfig::from_env();
    let text = std::str::from_utf8(&raw).ok();
    if !force_fallback
        && let Some(raw) = text
        && let Some(o) = engine_attempt(raw, &cfg, fallback.is_some()).and_then(reply_outcome)
    {
        return o;
    }
    let advisory_raw = if force_fallback { None } else { text.map(str::to_owned) };
    let input = match rest {
        Some(rest) => FallbackInput::BytesThenStdin(raw, rest),
        None => FallbackInput::Bytes(raw),
    };
    let unavailable = || {
        if fail_closed_unavailable {
            Outcome { out: String::new(), code: 2, err: defaults::text("msg.client_fallback_unavailable").into() }
        } else if force_fallback {
            Outcome { out: String::new(), code: 0, err: defaults::text("msg.client_fallback_unavailable").into() }
        } else {
            Outcome { out: String::new(), code: 0, err: String::new() }
        }
    };
    let mut o = match fallback.and_then(|p| run_fallback(input, p, &cfg)) {
        Some(FallbackResult::Answer(o)) => o,
        Some(FallbackResult::NoDecision(mut o)) if force_fallback && fail_closed_unavailable => {
            o.code = 2;
            o
        }
        Some(FallbackResult::NoDecision(mut o)) if force_fallback => {
            o.code = 0;
            o
        }
        Some(FallbackResult::NoDecision(o)) => o,
        None => unavailable(),
    };
    // We are running on the built-in checks: tell the agent once per session if the engine is in a known-bad state.
    if o.code == 0
        && paths::dir().join(defaults::text("files.failure")).exists()
        && let Some(raw) = advisory_raw
        && let Ok(p) = serde_json::from_str::<serde_json::Value>(&raw)
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
        let fallback = fallback_arg(args);
        let max = defaults::num("client.max_stdin");
        let mut raw = Vec::new();
        let mut stdin = std::io::stdin();
        let read = stdin.by_ref().take(max + 1).read_to_end(&mut raw);
        let cap_hit = raw.len() as u64 > max;
        let force_fallback = read.is_err() || cap_hit || std::str::from_utf8(&raw).is_err();
        let rest = (force_fallback && cap_hit).then_some(stdin);
        let fail_closed_unavailable = force_fallback && event_from_lossy(&raw).is_none_or(|event| guarded(&event));
        let o = run_bytes(raw, force_fallback, fallback.as_deref(), rest, fail_closed_unavailable);
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::checks::Exact;

    #[test]
    fn an_exact_verdict_reaches_the_host_byte_for_byte() {
        let x = Exact::json_block("no \"way\"\n");
        let body = crate::hookio::EXACT.to_string() + &serde_json::json!([x.code, x.out, x.err]).to_string();
        assert_eq!(reply_outcome(body), Some(Outcome { out: x.out, code: 2, err: x.err }));
    }

    #[test]
    fn the_other_reply_shapes_keep_their_meaning() {
        assert_eq!(reply_outcome(format!("{}why\n", crate::hookio::EXIT2)), Some(Outcome { out: String::new(), code: 2, err: "why\n".into() }));
        assert_eq!(reply_outcome("{\"a\":1}".into()), Some(Outcome { out: "{\"a\":1}".into(), code: 0, err: String::new() }));
        assert_eq!(reply_outcome(String::new()).unwrap().code, 0);
    }

    #[test]
    fn a_damaged_exact_verdict_is_no_answer_so_the_fallback_runs() {
        for body in [
            format!("{}not json", crate::hookio::EXACT),
            format!("{}[2,\"out\"]", crate::hookio::EXACT),
            format!("{}[\"2\",\"o\",\"e\"]", crate::hookio::EXACT),
            crate::hookio::EXACT.to_string(),
        ] {
            assert_eq!(reply_outcome(body.clone()), None, "{body}");
        }
    }
}
