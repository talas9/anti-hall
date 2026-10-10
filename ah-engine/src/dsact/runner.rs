//! The bounded subprocess every DevSwarm action runs through. One call: a wall-clock timeout (only the engine's own child is
//! killed), a stdout cap, no stdin, a missing binary reported as such (never retried here). Behind a trait so the tests use a
//! scripted runner; [`System`] is the real one.
use crate::defaults;
use std::io::Read;
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex, mpsc};
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
    /// Most bytes of stdout kept; 0 is the configured default. A destructive read sets it high, and checks [`RunResult::truncated`].
    pub cap_bytes: u64,
    /// Environment variables whose NAME starts with one of these are removed from the child's environment (so a daemon started from
    /// a workspace never hands its workspace identity to a child that must act as the project).
    pub scrub_env: Vec<String>,
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
    /// More stdout was written than the cap kept (the rest was read and dropped).
    pub truncated: bool,
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

/// A pipe being read on its own thread. What was read so far is always available: a grandchild that keeps the pipe open after the
/// child was killed must not make the output the child already printed disappear (a destructive read cannot be repeated).
struct Drained {
    buf: Arc<Mutex<(Vec<u8>, bool)>>,
    done: mpsc::Receiver<()>,
}

impl Drained {
    /// Wait up to `grace` for the end of the stream, then take what was read (and whether more than the cap was dropped).
    fn finish(self, grace: Duration) -> (Vec<u8>, bool) {
        let _wait = self.done.recv_timeout(grace); // keep: a timeout just means a holder of the pipe is still alive; what is read so far is taken
        self.buf.lock().map(|g| g.clone()).unwrap_or_default()
    }
}

fn drain(mut r: impl Read + Send + 'static, cap: usize) -> Drained {
    let buf = Arc::new(Mutex::new((Vec::new(), false)));
    let (tx, rx) = mpsc::channel();
    let shared = buf.clone();
    std::thread::spawn(move || {
        let mut chunk: Vec<u8> = std::iter::repeat_n(0, defaults::num("devswarm_act.read_chunk_bytes") as usize).collect();
        loop {
            match r.read(&mut chunk) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    // keep reading past the cap so the child never blocks on a full pipe
                    if let Ok(mut g) = shared.lock() {
                        let room = cap.saturating_sub(g.0.len());
                        g.1 |= n > room;
                        g.0.extend_from_slice(&chunk[..n.min(room)]);
                    }
                }
            }
        }
        let _sent = tx.send(()); // keep: the receiver is gone only after its own timeout
    });
    Drained { buf, done: rx }
}

impl Runner for System {
    fn run(&self, spec: &RunSpec) -> RunResult {
        let bin = spec.bin.clone().unwrap_or_else(|| self.hc.clone());
        // a test build never reaches the real DevSwarm CLI (src/hcguard.rs): a refused call reads as a missing binary
        if let Err(why) = crate::hcguard::permit(&bin, None) {
            return RunResult { missing: true, error: Some(why), ..RunResult::default() };
        }
        let mut cmd = Command::new(&bin);
        cmd.args(&spec.args).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
        if !spec.scrub_env.is_empty() {
            for (k, _) in std::env::vars_os() {
                if k.to_str().is_some_and(|k| spec.scrub_env.iter().any(|p| k.starts_with(p.as_str()))) {
                    cmd.env_remove(&k);
                }
            }
        }
        if let Some(c) = &spec.cwd {
            cmd.current_dir(c);
        }
        crate::proc::apply_git_env(&mut cmd);
        let mut child = match cmd.spawn() {
            Ok(c) => c,
            Err(e) => {
                let missing = matches!(e.kind(), std::io::ErrorKind::NotFound | std::io::ErrorKind::PermissionDenied);
                return RunResult { missing, error: Some(e.to_string()), ..RunResult::default() };
            }
        };
        let cap = if spec.cap_bytes > 0 { spec.cap_bytes as usize } else { defaults::num("devswarm_act.output_cap_bytes") as usize };
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
        let text = |rx: Option<Drained>| rx.map(|r| r.finish(grace)).map(|(b, d)| (String::from_utf8_lossy(&b).into_owned(), d)).unwrap_or_default();
        let ((stdout, truncated), (stderr, _)) = (text(out_rx), text(err_rx));
        let code = status.and_then(|s| s.code());
        RunResult {
            ok: !timed_out && status.is_some_and(|s| s.success()),
            status: code,
            stdout,
            stderr,
            timed_out,
            missing: false,
            truncated,
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
