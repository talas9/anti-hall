//! JavaScript-shaped helpers for the status line: the escape-stripping `safeLabel`, truthiness and number coercion of the
//! session JSON, and one bounded child process with a piped stdin.
use crate::checks::guardkit::jsre;
use crate::checks::guardkit::text::js_trim;
use crate::checks::jsport::json::J;
use crate::checks::jsport::num;
use crate::defaults;
use crate::migrate::{j_number, j_string};
use crate::ops::js::Defer;
use std::io::{Read, Write};
use std::os::unix::process::CommandExt;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

/// `safeLabel(s)`: strip terminal-escape sequences, control characters and bidi overrides from dynamic text.
pub fn safe_label(s: &str) -> Result<String, Defer> {
    // `.` after ESC consumes one UTF-16 unit in JavaScript, which would leave half of an astral character behind.
    let c: Vec<char> = s.chars().collect();
    if c.windows(2).any(|w| w[0] == '\u{1b}' && (w[1] as u32) > 0xFFFF) {
        return Err(Defer);
    }
    let mut out = s.to_string();
    for key in ["statusline.safe_osc", "statusline.safe_csi", "statusline.safe_esc_any", "statusline.safe_controls", "statusline.safe_bidi"] {
        out = jsre::compile(defaults::text(key), false).replace_all(&out, "").into_owned();
    }
    Ok(out)
}

/// JavaScript truthiness of an optional value.
pub fn truthy(v: Option<&J>) -> bool {
    crate::migrate::j_truthy(v)
}

/// `String(v)` of a value as string concatenation shows it.
pub fn text_of(v: &J) -> String {
    j_string(v)
}

/// `Math.floor(v || fallback)` where `fallback` is what a falsy value becomes.
pub fn floor_or(v: Option<&J>, fallback: f64) -> f64 {
    if truthy(v) { j_number(v.unwrap_or(&J::Null)).floor() } else { fallback.floor() }
}

/// A number the way it prints in a string.
pub fn n(x: f64) -> String {
    num::to_js_string(x)
}

/// `parseInt(String(v), 10)`.
pub fn parse_int_of(v: Option<&J>) -> Option<f64> {
    let s = j_string(v?);
    crate::setup::jsfmt::parse_int(&s)
}

/// `s.trim()`.
pub fn trim(s: &str) -> &str {
    js_trim(s)
}

/// When the whole run must be over (set once by `statusline::run`): every child's own limit is cut to what is left of it.
static END: std::sync::Mutex<Option<Instant>> = std::sync::Mutex::new(None);

/// Arm (`Some`) or lift (`None`) the overall deadline of this run.
pub fn set_end(at: Option<Instant>) {
    *END.lock().unwrap_or_else(|e| e.into_inner()) = at;
}

/// Time left before the overall deadline; `None` when none is armed.
pub fn left() -> Option<Duration> {
    END.lock().unwrap_or_else(|e| e.into_inner()).map(|e| e.saturating_duration_since(Instant::now()))
}

/// What a bounded child came to.
pub struct Ran {
    /// The exit code was 0.
    pub ok: bool,
    /// Standard output.
    pub stdout: Vec<u8>,
}

/// Run `cmd` with `input` on its stdin for at most `timeout`, killing its process group at the limit or when its output passes
/// `max_bytes` (Node's `spawnSync` treats both as a failed run). `None` when it could not be started or was cut off.
pub fn run_with_input(cmd: Command, input: &[u8], timeout: Duration, max_bytes: usize) -> Option<Ran> {
    match run_with_input_detail(cmd, input, timeout, max_bytes) {
        Finished::Done { code, stdout } => Some(Ran { ok: code == Some(0), stdout }),
        Finished::TimedOut | Finished::Failed => None,
    }
}

/// How a bounded child ended, for a caller that must tell a time-out from a failure (the doctor's render check).
pub enum Finished {
    /// It exited; `code` is `None` when a signal ended it.
    Done {
        /// The exit code.
        code: Option<i32>,
        /// Standard output.
        stdout: Vec<u8>,
    },
    /// It was still running at the timeout and its group was killed.
    TimedOut,
    /// It could not be started, or its output passed the cap.
    Failed,
}

/// [`run_with_input`], saying how the run ended.
pub fn run_with_input_detail(mut cmd: Command, input: &[u8], timeout: Duration, max_bytes: usize) -> Finished {
    run_inner(&mut cmd, input, timeout, max_bytes).unwrap_or(Finished::Failed)
}

fn run_inner(cmd: &mut Command, input: &[u8], timeout: Duration, max_bytes: usize) -> Option<Finished> {
    // past the overall deadline nothing new starts; before it a child never outlives it
    let timeout = match left() {
        Some(l) if l.is_zero() => return None,
        Some(l) => timeout.min(l),
        None => timeout,
    };
    cmd.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped()).process_group(0);
    let mut child = cmd.spawn().ok()?;
    let mut stdin = child.stdin.take()?;
    let data = input.to_vec();
    std::thread::spawn(move || {
        // a command that never reads its stdin closes the pipe early: the write fails and that is fine
        crate::discard::harmless(stdin.write_all(&data));
    });
    let drain = |mut r: Box<dyn Read + Send>, cap: usize| {
        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let mut buf = Vec::new();
            let mut chunk = vec![0u8; defaults::num("statusline.read_chunk") as usize];
            let mut over = false;
            loop {
                match r.read(&mut chunk) {
                    Ok(0) | Err(_) => break,
                    Ok(k) => {
                        if buf.len() + k > cap {
                            over = true;
                            break;
                        }
                        buf.extend_from_slice(&chunk[..k]);
                    }
                }
            }
            crate::discard::harmless(tx.send((buf, over))); // keep: the receiver gave up at the timeout
        });
        rx
    };
    let out_rx = drain(Box::new(child.stdout.take()?), max_bytes);
    let err_rx = drain(Box::new(child.stderr.take()?), max_bytes);
    let start = Instant::now();
    let kill = |child: &mut std::process::Child| {
        // SAFETY: killpg only sends a signal to the group we created for this child.
        unsafe {
            libc::killpg(child.id() as libc::pid_t, libc::SIGKILL);
        }
        crate::discard::harmless(child.kill()); // keep: already gone
        crate::discard::harmless(child.wait()); // keep: reaping
    };
    let poll = defaults::millis("statusline.poll_ms");
    let status = loop {
        match child.try_wait() {
            Ok(Some(st)) => break st,
            Ok(None) if start.elapsed() < timeout => std::thread::sleep(poll),
            _ => {
                kill(&mut child);
                return Some(Finished::TimedOut);
            }
        }
    };
    let left = timeout.saturating_sub(start.elapsed()).max(defaults::millis("statusline.read_grace_ms"));
    let (stdout, over) = out_rx.recv_timeout(left).ok()?;
    crate::discard::harmless(err_rx.recv_timeout(left)); // keep: stderr is not used, only drained
    if over {
        kill(&mut child);
        return None;
    }
    Some(Finished::Done { code: status.code(), stdout })
}

#[cfg(all(test, unix))]
mod tests;
