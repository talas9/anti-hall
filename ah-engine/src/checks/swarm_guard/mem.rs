//! Available and total memory, read the way `hooks/swarm-guard.js` `availableBytes` and `os.totalmem()` read them.
//!
//! Available memory counts reclaimable cache (free, inactive and speculative pages on macOS, `MemAvailable` on Linux),
//! never the operating system's "free" figure, which reads near zero on a healthy machine. A read that fails or parses to
//! nothing is `None`, which skips the memory gate (the guard never blocks on a number it could not read).
use crate::checks::guardkit::jsre;
use crate::defaults;
use std::io::Read;
use std::time::{Duration, Instant};

/// Where the memory figures come from; a test supplies its own.
pub trait MemSource {
    /// Available bytes, or `None` when they could not be read (the gate is then skipped).
    fn available(&self) -> Option<f64>;
    /// Total physical bytes (0 when unknown).
    fn total(&self) -> f64;
}

/// This machine.
pub struct HostMem;

/// Run `path` and return its standard output, or `None` when it fails, times out or prints non-UTF-8-lossy nothing.
fn run_capture(path: &str, timeout: Duration) -> Option<String> {
    let mut child = std::process::Command::new(path)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .spawn()
        .ok()?;
    let mut out = child.stdout.take()?;
    let reader = std::thread::spawn(move || {
        let mut b = Vec::new();
        let _ = out.read_to_end(&mut b);
        b
    });
    let deadline = Instant::now() + timeout;
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                let bytes = reader.join().ok()?;
                return status.success().then(|| String::from_utf8_lossy(&bytes).to_string());
            }
            Ok(None) if Instant::now() < deadline => std::thread::sleep(defaults::millis("swarm_guard.vm_stat_poll_ms")),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
        }
    }
}

/// `availableBytes()` on macOS from the output of the memory tool.
pub fn parse_vm_stat(out: &str) -> Option<f64> {
    let page = jsre::compile(defaults::text("swarm_guard.vm_page_size_re"), false)
        .captures(out)
        .and_then(|c| c.get(1))
        .and_then(|m| m.as_str().parse::<f64>().ok())
        .unwrap_or(defaults::num("swarm_guard.vm_default_page_size") as f64);
    let mut pages = 0.0;
    for label in defaults::list("swarm_guard.vm_labels") {
        let src = defaults::text("swarm_guard.vm_pages_re").replace("{label}", label);
        pages += jsre::compile(&src, false).captures(out).and_then(|c| c.get(1)).and_then(|m| m.as_str().parse::<f64>().ok()).unwrap_or(0.0);
    }
    (pages > 0.0).then_some(pages * page)
}

/// `availableBytes()` on Linux from the contents of the memory report.
pub fn parse_meminfo_available(text: &str) -> Option<f64> {
    let kb = jsre::compile(defaults::text("swarm_guard.meminfo_available_re"), false).captures(text)?.get(1)?.as_str().parse::<f64>().ok()?;
    Some(kb * 1024.0)
}

#[cfg_attr(target_os = "macos", allow(dead_code))]
fn meminfo_total(text: &str) -> Option<f64> {
    let key = defaults::text("swarm_guard.meminfo_total_key");
    let line = text.lines().find(|l| l.starts_with(key))?;
    let kb: f64 = line[key.len()..].split_whitespace().next()?.parse().ok()?;
    Some(kb * 1024.0)
}

impl MemSource for HostMem {
    #[cfg(target_os = "macos")]
    fn available(&self) -> Option<f64> {
        parse_vm_stat(&run_capture(defaults::text("swarm_guard.vm_stat_path"), defaults::millis("swarm_guard.vm_stat_timeout_ms"))?)
    }

    #[cfg(not(target_os = "macos"))]
    fn available(&self) -> Option<f64> {
        parse_meminfo_available(&std::fs::read_to_string(defaults::text("swarm_guard.meminfo_path")).ok()?)
    }

    #[cfg(target_os = "macos")]
    fn total(&self) -> f64 {
        let Ok(name) = std::ffi::CString::new(defaults::text("swarm_guard.sysctl_memsize")) else { return 0.0 };
        let mut v: u64 = 0;
        let mut len = std::mem::size_of::<u64>();
        // SAFETY: `v` and `len` describe a writable 8-byte buffer and the name is a valid C string.
        let rc = unsafe { libc::sysctlbyname(name.as_ptr(), (&raw mut v).cast(), &mut len, std::ptr::null_mut(), 0) };
        if rc == 0 { v as f64 } else { 0.0 }
    }

    #[cfg(not(target_os = "macos"))]
    fn total(&self) -> f64 {
        std::fs::read_to_string(defaults::text("swarm_guard.meminfo_path")).ok().and_then(|t| meminfo_total(&t)).unwrap_or(0.0)
    }
}
