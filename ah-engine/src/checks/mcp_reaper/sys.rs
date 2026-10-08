//! The real machine behind [`Sys`]: external commands in the request's environment, signals, the control-group file and the
//! local clock.
// Discard triage (E3): every `.ok()` / `unwrap_or_default()` in this file is a deliberate keep, for these reasons:
// - an unreadable optional file is the same as an absent one (fail-open, as Node's try/catch)
// A failure that must be seen goes through `crate::discard` instead.

use super::select::{Platform, Run, Sys};
use crate::defaults;
use crate::reqenv::RequestEnv;
use std::collections::HashMap;
use std::io::Read;
use std::process::{Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};

unsafe extern "C" {
    /// POSIX `tzset`: re-read the time zone from the environment and the zone files.
    fn tzset();
}

/// The local clock functions keep process-wide state; one conversion at a time.
static CLOCK: Mutex<()> = Mutex::new(());

/// The machine, as one request sees it.
pub struct RealSys {
    env: HashMap<String, String>,
    tz_agrees: bool,
}

impl RealSys {
    /// The system for a request: commands run with the request's environment, and a start time is read in local time only
    /// when the daemon and the hook would read the same zone (their `TZ` agree).
    pub fn new(env: &RequestEnv) -> RealSys {
        let tz = defaults::text("mcp_reaper.tz_env");
        let tz_agrees = env.get(tz).map(str::to_string) == std::env::var(tz).ok();
        RealSys { env: env.to_map(), tz_agrees }
    }
}

impl Sys for RealSys {
    fn run(&self, argv: &[String], timeout_ms: u64, max_bytes: u64) -> Run {
        let Some((prog, args)) = argv.split_first() else { return Run::Failed };
        let mut cmd = Command::new(prog);
        cmd.args(args).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::null()).env_clear();
        for (k, v) in &self.env {
            cmd.env(k, v);
        }
        let Ok(mut child) = cmd.spawn() else { return Run::Failed };
        let Some(mut out) = child.stdout.take() else { return Run::Failed };
        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let mut b = Vec::new();
            crate::discard::harmless((&mut out).take(max_bytes + 1).read_to_end(&mut b)); // keep: a short read is judged by the size below
            // keep draining so the child is never blocked on a full pipe before it is reaped
            crate::discard::harmless(std::io::copy(&mut out, &mut std::io::sink()));
            crate::discard::harmless(tx.send(b)); // keep: the receiver is gone; nobody is waiting for the result
        });
        let start = Instant::now();
        let timeout = Duration::from_millis(timeout_ms);
        let status = loop {
            match child.try_wait() {
                Ok(Some(st)) => break st,
                Ok(None) if start.elapsed() < timeout => std::thread::sleep(defaults::millis("mcp_reaper.poll_ms")),
                _ => {
                    crate::discard::harmless(child.kill()); // keep: reaping a child that already ended
                    crate::discard::harmless(child.wait()); // keep: reaping a child that already ended
                    return Run::Failed;
                }
            }
        };
        let bytes = rx.recv_timeout(defaults::millis("mcp_reaper.read_ms")).unwrap_or_default();
        if !status.success() {
            return Run::Failed;
        }
        if bytes.len() as u64 > max_bytes {
            return Run::TooBig;
        }
        Run::Ok(String::from_utf8_lossy(&bytes).into_owned())
    }

    fn read_cgroup(&self, pid: f64) -> Option<String> {
        let path = defaults::text("mcp_reaper.cgroup_path").replace("{pid}", &format!("{pid}"));
        std::fs::read_to_string(path).ok()
    }

    fn platform(&self) -> Platform {
        let os = std::env::consts::OS;
        if os == defaults::text("mcp_reaper.platform_launchd") {
            Platform::Launchd
        } else if os == defaults::text("mcp_reaper.platform_systemd") {
            Platform::Systemd
        } else {
            Platform::Other
        }
    }

    fn now_ms(&self) -> f64 {
        crate::checks::taskkit::time::now_ms() as f64
    }

    fn local_epoch_ms(&self, y: i64, mo: u32, d: u32, h: u32, mi: u32, s: u32) -> Option<f64> {
        if !self.tz_agrees {
            return None;
        }
        let _g = CLOCK.lock().unwrap_or_else(|e| e.into_inner());
        // SAFETY: tzset only reads the environment and the zone files; the lock above serializes this module's use of the
        // process-wide zone state.
        unsafe { tzset() };
        let wall = |t: &libc::tm| (i64::from(t.tm_year) + 1900, t.tm_mon as u32 + 1, t.tm_mday as u32, t.tm_hour as u32, t.tm_min as u32, t.tm_sec as u32);
        let mut valid: Vec<i64> = Vec::new();
        for isdst in [-1, 0, 1] {
            // SAFETY: a zeroed `tm` is a valid value of the plain C struct (a null zone pointer is allowed).
            let mut tm: libc::tm = unsafe { std::mem::zeroed() };
            tm.tm_year = (y - 1900) as libc::c_int;
            tm.tm_mon = mo as libc::c_int - 1;
            tm.tm_mday = d as libc::c_int;
            tm.tm_hour = h as libc::c_int;
            tm.tm_min = mi as libc::c_int;
            tm.tm_sec = s as libc::c_int;
            tm.tm_isdst = isdst;
            // SAFETY: `tm` is a valid, initialized struct owned by this frame.
            let t = unsafe { libc::mktime(&mut tm) };
            if t == -1 || valid.contains(&(t as i64)) {
                continue;
            }
            // SAFETY: as above; `back` is written by localtime_r and read only after it returns non-null.
            let mut back: libc::tm = unsafe { std::mem::zeroed() };
            let tt = t;
            // SAFETY: both pointers refer to live locals of this frame.
            let ok = unsafe { !libc::localtime_r(&tt, &mut back).is_null() };
            if ok && wall(&back) == (y, mo, d, h, mi, s) {
                valid.push(t as i64);
            }
        }
        // exactly one instant has this wall-clock time: an ambiguous (clock set back) or absent (clock set forward) time is Node's
        (valid.len() == 1).then(|| valid[0] as f64 * 1000.0)
    }

    fn kill(&self, pid: i32, forced: bool) {
        let sig = if forced { libc::SIGKILL } else { libc::SIGTERM };
        // SAFETY: a plain signal to a validated pid (at least 2, not this process or its parent); failure (already gone) is fine.
        unsafe { libc::kill(pid, sig) };
    }

    fn is_self_or_parent(&self, pid: f64) -> bool {
        // SAFETY: getppid takes no arguments and cannot fail.
        let ppid = unsafe { libc::getppid() };
        pid == f64::from(std::process::id()) || pid == f64::from(ppid)
    }

    fn sleep_ms(&self, ms: u64) {
        std::thread::sleep(Duration::from_millis(ms));
    }
}
