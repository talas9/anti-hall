//! The machine behind the process watch: one interface ([`Host`]), one real implementation per operating system family, and pure
//! parsers for the text the system hands back, so both families are tested from fixtures on either operating system.
//!
//! The process table, CPU, command line, environment and working directory of a process come from [`super::table`] (macOS: libproc and
//! `KERN_PROCARGS2`, own user only; Linux: `/proc`), swap from the same module. Free disk space is `statvfs`. Done here behind
//! `cfg(target_os)`: the macOS physical footprint (`proc_pid_rusage`) and memory pressure level (`sysctlbyname`), and Linux's
//! pressure file (PSI).
// Discard triage (E3): every `.ok()` / `unwrap_or_default()` in this file is a deliberate keep, for these reasons:
// - a process that vanished, or whose data the system will not give, is the absent value (fail-safe: nothing is done to it)
// A failure that must be seen goes through `crate::discard` instead.

use super::table::{Row, Table};
use crate::defaults;
use std::path::Path;

/// One process, as the watch sees it.
#[derive(Debug, Clone, PartialEq)]
pub struct ProcRow {
    /// Process id.
    pub pid: u32,
    /// Parent process id (1 after the parent died; 0 when unknown).
    pub ppid: u32,
    /// Start time, seconds since the epoch.
    pub start_s: u64,
    /// CPU use in per-core percent (100 = one core busy); 0 on the first sample of a process.
    pub cpu_pct: f32,
    /// Memory in bytes: the resident set on Linux, the physical footprint (compressed pages included) on macOS.
    pub mem_bytes: u64,
    /// The full command line (the program name when the system hides the arguments).
    pub cmd: String,
}

/// System memory pressure, in the unit its platform reports.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Pressure {
    /// Not available here.
    Unknown,
    /// Linux PSI `some avg10`: percent of the last ten seconds some task stalled on memory.
    Psi(f64),
    /// macOS `kern.memorystatus_vm_pressure_level`: 1 normal, 2 warn, 4 critical.
    MacLevel(u32),
}

/// System-wide memory facts.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct MemInfo {
    /// Swap in use, bytes.
    pub swap_used: u64,
    /// Memory pressure.
    pub pressure: Pressure,
}

/// Free space on one volume.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Space {
    /// Bytes available to this user.
    pub free: u64,
    /// Bytes on the volume.
    pub total: u64,
    /// The device the path is on (tells volumes apart).
    pub dev: u64,
}

/// Everything the watch needs from the machine. Tests supply a fake.
pub trait Host {
    /// The clock, seconds since the epoch.
    fn now_s(&self) -> u64;
    /// Refresh and list every process.
    fn procs(&mut self) -> Vec<ProcRow>;
    /// Refresh and return one process, `None` when it is gone.
    fn proc_row(&mut self, pid: u32) -> Option<ProcRow>;
    /// The environment of a process, `None` when the system will not show it (another user, a protected binary, gone).
    fn environ(&mut self, pid: u32) -> Option<Vec<(String, String)>>;
    /// The working directory of a process, `None` when the system will not show it.
    fn cwd(&mut self, pid: u32) -> Option<std::path::PathBuf>;
    /// System memory facts.
    fn mem(&mut self) -> MemInfo;
    /// Free space of the volume `path` is on.
    fn space(&self, path: &Path) -> Option<Space>;
    /// Send the polite (`false`) or forced (`true`) signal; `false` when the process is gone or the pid is refused.
    fn signal(&mut self, pid: u32, forced: bool) -> bool;
    /// Set the nice value of a process; `false` when refused.
    fn renice(&mut self, pid: u32, nice: i32) -> bool;
    /// Wait.
    fn sleep_ms(&mut self, ms: u64);
}

/// `/proc/<pid>/environ`: NUL-separated `KEY=value` entries (a trailing NUL, empty entries and entries without `=` are skipped).
pub fn parse_environ_block(bytes: &[u8]) -> Vec<(String, String)> {
    bytes
        .split(|b| *b == 0)
        .filter(|e| !e.is_empty())
        .filter_map(|e| {
            let s = String::from_utf8_lossy(e);
            let (k, v) = s.split_once('=')?;
            (!k.is_empty()).then(|| (k.to_string(), v.to_string()))
        })
        .collect()
}

/// `/proc/pressure/memory`: the `some avg10=` figure of the line that starts with `some`.
pub fn parse_psi(text: &str) -> Option<f64> {
    let line = text.lines().find(|l| l.starts_with("some"))?;
    let field = line.split_whitespace().find_map(|f| f.strip_prefix("avg10="))?;
    field.parse::<f64>().ok().filter(|v| v.is_finite() && *v >= 0.0)
}

/// The value of `key` in an environment list.
pub fn env_get<'a>(env: &'a [(String, String)], key: &str) -> Option<&'a str> {
    env.iter().find(|(k, _)| k == key).map(|(_, v)| v.as_str())
}

/// The real machine.
pub struct RealHost {
    table: Table,
    own_pid: u32,
}

impl Default for RealHost {
    fn default() -> RealHost {
        RealHost::new()
    }
}

impl RealHost {
    /// A host with an empty process table; the first [`Host::procs`] fills it (CPU readings start at the second).
    pub fn new() -> RealHost {
        RealHost { table: Table::new(), own_pid: std::process::id() }
    }
}

fn row(r: Row) -> ProcRow {
    ProcRow { pid: r.pid, ppid: r.ppid, start_s: r.start_s, cpu_pct: r.cpu_pct, mem_bytes: footprint(r.pid).unwrap_or(r.rss), cmd: r.cmd }
}

/// macOS: the physical footprint of a process (what Activity Monitor shows, compressed pages included); `None` elsewhere and for
/// a process the caller may not inspect.
#[cfg(target_os = "macos")]
fn footprint(pid: u32) -> Option<u64> {
    // SAFETY: a zeroed rusage_info_v2 is a valid value of the plain C struct; proc_pid_rusage fills at most that many bytes and
    // reads nothing else.
    let mut info: libc::rusage_info_v2 = unsafe { std::mem::zeroed() };
    // SAFETY: `info` is a live, writable struct of the flavour asked for; the call fails (non-zero) rather than overrun it.
    let rc = unsafe { libc::proc_pid_rusage(pid as libc::c_int, libc::RUSAGE_INFO_V2, (&mut info as *mut libc::rusage_info_v2).cast()) };
    (rc == 0 && info.ri_phys_footprint > 0).then_some(info.ri_phys_footprint)
}

#[cfg(not(target_os = "macos"))]
fn footprint(_pid: u32) -> Option<u64> {
    None
}

#[cfg(target_os = "macos")]
fn pressure() -> Pressure {
    let name = defaults::text("resource_watch.mac_pressure_sysctl");
    let Ok(cname) = std::ffi::CString::new(name) else { return Pressure::Unknown };
    let mut level: libc::c_int = 0;
    let mut len = std::mem::size_of::<libc::c_int>();
    // SAFETY: the name is NUL-terminated; `level` and `len` are live locals sized for one c_int; no new value is set (null, 0).
    let rc = unsafe { libc::sysctlbyname(cname.as_ptr(), (&mut level as *mut libc::c_int).cast(), &mut len, std::ptr::null_mut(), 0) };
    if rc == 0 && level >= 0 { Pressure::MacLevel(level as u32) } else { Pressure::Unknown }
}

#[cfg(not(target_os = "macos"))]
fn pressure() -> Pressure {
    std::fs::read_to_string(defaults::text("resource_watch.psi_path")).ok().and_then(|t| parse_psi(&t)).map_or(Pressure::Unknown, Pressure::Psi)
}

impl Host for RealHost {
    fn now_s(&self) -> u64 {
        std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
    }

    fn procs(&mut self) -> Vec<ProcRow> {
        self.table.list().into_iter().map(row).collect()
    }

    fn proc_row(&mut self, pid: u32) -> Option<ProcRow> {
        self.table.one(pid).map(row)
    }

    fn environ(&mut self, pid: u32) -> Option<Vec<(String, String)>> {
        // an empty list is a process the system would not show (a protected binary, another user), not an empty environment
        Some(self.table.environ(pid)).filter(|e| !e.is_empty())
    }

    fn cwd(&mut self, pid: u32) -> Option<std::path::PathBuf> {
        self.table.cwd(pid)
    }

    fn mem(&mut self) -> MemInfo {
        MemInfo { swap_used: self.table.swap_used(), pressure: pressure() }
    }

    fn space(&self, path: &Path) -> Option<Space> {
        use std::os::unix::ffi::OsStrExt;
        use std::os::unix::fs::MetadataExt;
        let c = std::ffi::CString::new(path.as_os_str().as_bytes()).ok()?;
        // SAFETY: a zeroed statvfs is a valid value of the plain C struct.
        let mut s: libc::statvfs = unsafe { std::mem::zeroed() };
        // SAFETY: `c` is NUL-terminated and `s` is a live, writable statvfs.
        if unsafe { libc::statvfs(c.as_ptr(), &mut s) } != 0 {
            return None;
        }
        // field widths differ by platform (u32 block counts on macOS, u64 on Linux): widen first
        let fr = s.f_frsize as u64;
        let unit = if fr != 0 { fr } else { s.f_bsize as u64 };
        let dev = std::fs::metadata(path).ok()?.dev();
        Some(Space { free: (s.f_bavail as u64).saturating_mul(unit), total: (s.f_blocks as u64).saturating_mul(unit), dev })
    }

    fn signal(&mut self, pid: u32, forced: bool) -> bool {
        if pid < defaults::num("procwatch.protect_pids_below") as u32 || pid == self.own_pid || pid > i32::MAX as u32 {
            return false;
        }
        let sig = if forced { libc::SIGKILL } else { libc::SIGTERM };
        // SAFETY: a plain signal to a validated pid (not below the protected floor, not this process); failure (gone) is reported.
        unsafe { libc::kill(pid as libc::pid_t, sig) == 0 }
    }

    fn renice(&mut self, pid: u32, nice: i32) -> bool {
        if pid < defaults::num("procwatch.protect_pids_below") as u32 || pid == self.own_pid {
            return false;
        }
        // SAFETY: setpriority takes plain integers; PRIO_PROCESS has the platform's own `which` type (c_int on macOS, c_uint on glibc).
        unsafe { libc::setpriority(libc::PRIO_PROCESS, pid as libc::id_t, nice) == 0 }
    }

    fn sleep_ms(&mut self, ms: u64) {
        std::thread::sleep(std::time::Duration::from_millis(ms));
    }
}
