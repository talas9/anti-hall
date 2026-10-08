//! The bounded subprocess every DevSwarm action runs through. One call: a wall-clock timeout (only the engine's own child is
//! killed), a stdout cap, no stdin, a missing binary reported as such (never retried here). Behind a trait so the tests use a
//! scripted runner; [`System`] is the real one.
use crate::defaults;
use std::io::Read;
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::time::{Duration, Instant};

/// What to run. `bin` is the executable; `None` means the configured hivecontrol.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct RunSpec {
    /// The bin.
    pub bin: Option<String>,
    /// The args.
    pub args: Vec<String>,
    /// The cwd.
    pub cwd: Option<String>,
    /// The timeout ms.
    pub timeout_ms: u64,
}

/// What came back.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct RunResult {
    /// The ok.
    pub ok: bool,
    /// The status.
    pub status: Option<i32>,
    /// The stdout.
    pub stdout: String,
    /// The stderr.
    pub stderr: String,
    /// The timed out.
    pub timed_out: bool,
    /// The executable does not exist (or may not be run): DevSwarm is not installed.
    pub missing: bool,
    /// The error.
    pub error: Option<String>,
}

/// Runs one command.
pub trait Runner {
    /// The run.
    fn run(&self, spec: &RunSpec) -> RunResult;
}

/// The real runner.
pub struct System {
    /// The hivecontrol executable (the configured name, or an absolute path in tests).
    pub hc: String,
}

impl System {
    /// The configured hivecontrol.
    pub fn configured() -> System {
        System { hc: defaults::text("devswarm_act.hc_bin").to_string() }
    }
}

fn drain(mut r: impl Read + Send + 'static, cap: usize) -> mpsc::Receiver<Vec<u8>> {
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        let mut kept = Vec::new();
        let mut buf: Vec<u8> = std::iter::repeat_n(0, defaults::num("devswarm_act.read_chunk_bytes") as usize).collect();
        loop {
            match r.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    // keep reading past the cap so the child never blocks on a full pipe
                    let room = cap.saturating_sub(kept.len());
                    kept.extend_from_slice(&buf[..n.min(room)]);
                }
            }
        }
        let _sent = tx.send(kept); // keep: the receiver is gone only after its own timeout
    });
    rx
}

impl Runner for System {
    fn run(&self, spec: &RunSpec) -> RunResult {
        let bin = spec.bin.clone().unwrap_or_else(|| self.hc.clone());
        let mut cmd = Command::new(&bin);
        cmd.args(&spec.args).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
        if let Some(c) = &spec.cwd {
            cmd.current_dir(c);
        }
        let mut child = match cmd.spawn() {
            Ok(c) => c,
            Err(e) => {
                let missing = matches!(e.kind(), std::io::ErrorKind::NotFound | std::io::ErrorKind::PermissionDenied);
                return RunResult { missing, error: Some(e.to_string()), ..RunResult::default() };
            }
        };
        let cap = defaults::num("devswarm_act.output_cap_bytes") as usize;
        let out_rx = child.stdout.take().map(|s| drain(s, cap));
        let err_rx = child.stderr.take().map(|s| drain(s, cap));
        let started = Instant::now();
        let limit = Duration::from_millis(spec.timeout_ms);
        let poll = Duration::from_millis(defaults::num("devswarm_act.poll_ms"));
        let mut timed_out = false;
        let status = loop {
            match child.try_wait() {
                Ok(Some(s)) => break Some(s),
                Ok(None) => {}
                Err(_) => break None,
            }
            if started.elapsed() >= limit {
                timed_out = true;
                crate::discard::harmless(child.kill()); // keep: the child may have exited between the check and the kill
                break child.wait().ok();
            }
            std::thread::sleep(poll);
        };
        // a grandchild may hold the pipe open: wait a bounded while for what was written
        let grace = poll.saturating_mul(defaults::num("devswarm_act.poll_ms").max(1) as u32);
        let text = |rx: Option<mpsc::Receiver<Vec<u8>>>| {
            rx.and_then(|r| r.recv_timeout(grace).ok()).map(|b| String::from_utf8_lossy(&b).into_owned()).unwrap_or_default()
        };
        let (stdout, stderr) = (text(out_rx), text(err_rx));
        let code = status.and_then(|s| s.code());
        RunResult {
            ok: !timed_out && status.is_some_and(|s| s.success()),
            status: code,
            stdout,
            stderr,
            timed_out,
            missing: false,
            error: timed_out.then(|| defaults::render("devswarm_act.msg_timeout", &[("ms", &spec.timeout_ms)])),
        }
    }
}

/// The first `major.minor.patch` in `text`, as numbers (`hivecontrol 2.5.3` -> [2,5,3]); `None` when there is none.
pub fn parse_version(text: &str) -> Option<Vec<u64>> {
    let need = defaults::num("devswarm_act.version_min_parts") as usize;
    let bytes = text.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i].is_ascii_digit() {
            let start = i;
            while i < bytes.len() && (bytes[i].is_ascii_digit() || bytes[i] == b'.') {
                i += 1;
            }
            let parts: Vec<u64> = text[start..i].split('.').filter(|p| !p.is_empty()).filter_map(|p| p.parse().ok()).collect();
            if parts.len() >= need {
                return Some(parts);
            }
        } else {
            i += 1;
        }
    }
    None
}

/// `have >= want`, part by part (missing parts count as 0).
pub fn at_least(have: &[u64], want: &[u64]) -> bool {
    for i in 0..have.len().max(want.len()) {
        let (h, w) = (have.get(i).copied().unwrap_or(0), want.get(i).copied().unwrap_or(0));
        if h != w {
            return h > w;
        }
    }
    true
}
