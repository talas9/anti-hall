//! Resource limits and process-level safety: token buckets, rlimit/nice, RSS and CPU readings,
//! peer-uid check, private-directory check.
use crate::error::DirError;
use std::collections::HashMap;
use std::os::unix::fs::{MetadataExt, PermissionsExt};
use std::os::unix::io::AsRawFd;
use std::os::unix::net::UnixStream;
use std::path::Path;
use std::time::Instant;

/// Real uid of this process.
pub fn uid() -> u32 {
    // SAFETY: `getuid` has no preconditions and cannot fail.
    unsafe { libc::getuid() }
}

/// Token bucket per key. Bounded: when the map grows past `cap`, idle (full) buckets are dropped.
pub struct Buckets {
    map: HashMap<String, (f64, Instant)>,
    rps: f64,
    burst: f64,
    cap: usize,
}

impl Buckets {
    /// A bucket map allowing `rps` per second with bursts up to `burst`.
    pub fn new(rps: f64, burst: f64) -> Buckets {
        Buckets { map: HashMap::new(), rps, burst: burst.max(1.0), cap: crate::defaults::num("daemon.bucket_cap") as usize }
    }
    /// Keys held.
    pub fn len(&self) -> usize {
        self.map.len()
    }
    /// True when no key is held.
    pub fn is_empty(&self) -> bool {
        self.map.is_empty()
    }
    /// Change the rate and burst for later requests (a config swap, D18); existing tokens are kept.
    pub fn set_rate(&mut self, rps: f64, burst: f64) {
        self.rps = rps;
        self.burst = burst.max(1.0);
    }
    /// True when `key` may proceed; false when it is over its rate.
    pub fn allow(&mut self, key: &str) -> bool {
        self.allow_at(key, Instant::now())
    }
    /// `allow` at an explicit time (tests drive the clock).
    pub fn allow_at(&mut self, key: &str, now: Instant) -> bool {
        if self.rps <= 0.0 {
            return true; // 0 = unlimited
        }
        if self.map.len() >= self.cap && !self.map.contains_key(key) {
            let (rps, burst) = (self.rps, self.burst);
            self.map.retain(|_, (t, last)| *t + now.saturating_duration_since(*last).as_secs_f64() * rps < burst);
            if self.map.len() >= self.cap {
                return false; // under a key flood, refuse unknown keys rather than grow without bound
            }
        }
        let e = self.map.entry(key.to_string()).or_insert((self.burst, now));
        let refill = now.saturating_duration_since(e.1).as_secs_f64() * self.rps;
        e.0 = (e.0 + refill).min(self.burst);
        e.1 = now;
        if e.0 >= 1.0 {
            e.0 -= 1.0;
            true
        } else {
            false
        }
    }
}

/// CPU time consumed by the calling thread, in microseconds.
pub fn thread_cpu_us() -> u64 {
    let mut ts = libc::timespec { tv_sec: 0, tv_nsec: 0 };
    // SAFETY: `ts` is a live, writable `timespec`.
    let rc = unsafe { libc::clock_gettime(libc::CLOCK_THREAD_CPUTIME_ID, &mut ts) };
    if rc != 0 {
        return 0;
    }
    ts.tv_sec as u64 * 1_000_000 + ts.tv_nsec as u64 / 1000
}

/// User+system CPU seconds of this process.
pub fn process_cpu_secs() -> f64 {
    // SAFETY: an all-zero `rusage` is a valid value (integers and timevals); `getrusage` fills it below.
    let mut ru: libc::rusage = unsafe { std::mem::zeroed() };
    // SAFETY: `ru` is a live, writable `rusage`.
    if unsafe { libc::getrusage(libc::RUSAGE_SELF, &mut ru) } != 0 {
        return 0.0;
    }
    let t = |tv: libc::timeval| tv.tv_sec as f64 + tv.tv_usec as f64 / 1e6;
    t(ru.ru_utime) + t(ru.ru_stime)
}

/// Current resident set of this process in KB (0 when it cannot be read).
pub fn rss_kb() -> u64 {
    #[cfg(target_os = "linux")]
    {
        if let Ok(s) = std::fs::read_to_string("/proc/self/statm")
            && let Some(pages) = s.split_whitespace().nth(1).and_then(|v| v.parse::<u64>().ok())
        {
            // SAFETY: sysconf takes only a name constant and has no memory effects.
            return pages * (unsafe { libc::sysconf(libc::_SC_PAGESIZE) } as u64) / 1024;
        }
    }
    #[cfg(target_os = "macos")]
    {
        // The kernel's own count, without spawning `ps` on every sample.
        // SAFETY: `proc_taskinfo` is a plain C struct of integers, for which all-zero bytes are a valid value.
        let mut ti: libc::proc_taskinfo = unsafe { std::mem::zeroed() };
        let want = std::mem::size_of::<libc::proc_taskinfo>() as libc::c_int;
        // SAFETY: `ti` is a writable `proc_taskinfo` of exactly `want` bytes, the size passed to the call.
        let got =
            unsafe { libc::proc_pidinfo(std::process::id() as libc::c_int, libc::PROC_PIDTASKINFO, 0, (&mut ti as *mut libc::proc_taskinfo).cast(), want) };
        if got == want {
            return ti.pti_resident_size / 1024;
        }
    }
    // bounded (review finding 6): a wedged `ps` must not hold the watchdog
    crate::health::probe_output(crate::defaults::list("health.rss_probe"), std::process::id()).trim().parse().unwrap_or(0)
}

/// Cap the data segment. Returns a status word for `status`: `ok:<mb>`, `off`, `unsupported:rlimit_data`, or `err:<errno>`.
pub fn apply_mem_limit(mb: u64) -> String {
    if mb == 0 {
        return "off".into();
    }
    #[cfg(target_os = "macos")]
    {
        // Darwin rejects setrlimit(RLIMIT_DATA) with EINVAL; RSS/footprint checks are the supported guard.
        "unsupported:rlimit_data".into()
    }
    #[cfg(not(target_os = "macos"))]
    {
        let bytes = (mb * 1024 * 1024) as libc::rlim_t;
        let mut cur: libc::rlimit = libc::rlimit { rlim_cur: 0, rlim_max: 0 };
        // SAFETY: `cur` is a live, writable `rlimit`.
        if unsafe { libc::getrlimit(libc::RLIMIT_DATA, &mut cur) } != 0 {
            return format!("err:{}", std::io::Error::last_os_error().raw_os_error().unwrap_or(0));
        }
        let lim = libc::rlimit { rlim_cur: bytes.min(cur.rlim_max), rlim_max: cur.rlim_max };
        // SAFETY: `lim` is a live `rlimit` that `setrlimit` only reads.
        if unsafe { libc::setrlimit(libc::RLIMIT_DATA, &lim) } != 0 {
            return format!("err:{}", std::io::Error::last_os_error().raw_os_error().unwrap_or(0));
        }
        format!("ok:{mb}")
    }
}

/// The process's own memory, without file-backed pages other processes share or the kernel can reclaim (`None` where the platform
/// will not say): macOS, `ri_phys_footprint` (what Activity Monitor shows); Linux, `RssAnon + RssShmem` from `/proc/self/status`.
pub fn footprint_kb() -> Option<u64> {
    #[cfg(target_os = "macos")]
    {
        // SAFETY: a zeroed rusage_info_v2 is a valid value of the plain C struct.
        let mut info: libc::rusage_info_v2 = unsafe { std::mem::zeroed() };
        // SAFETY: `info` is a live, writable struct of the flavour asked for; the call fails (non-zero) rather than overrun it.
        let rc = unsafe { libc::proc_pid_rusage(std::process::id() as libc::c_int, libc::RUSAGE_INFO_V2, (&mut info as *mut libc::rusage_info_v2).cast()) };
        return (rc == 0 && info.ri_phys_footprint > 0).then_some(info.ri_phys_footprint / 1024);
    }
    #[cfg(target_os = "linux")]
    {
        let s = std::fs::read_to_string("/proc/self/status").ok()?;
        let field = |k: &str| s.lines().find_map(|l| l.strip_prefix(k)).and_then(|v| v.split_whitespace().next()).and_then(|v| v.parse::<u64>().ok());
        return Some(field("RssAnon:")? + field("RssShmem:").unwrap_or(0));
    }
    #[allow(unreachable_code)]
    None
}

/// The figure the memory cap is compared with: the setting `daemon.mem_metric` (`footprint` or `rss`); the footprint falls back
/// to the resident set where the platform has none.
pub fn mem_kb() -> u64 {
    if crate::defaults::text("daemon.mem_metric") == crate::defaults::text("daemon.mem_metric_rss") {
        return rss_kb();
    }
    footprint_kb().unwrap_or_else(rss_kb)
}

/// Threads in this process (0 when the platform will not say).
pub fn thread_count() -> u64 {
    #[cfg(target_os = "linux")]
    {
        if let Ok(s) = std::fs::read_to_string("/proc/self/status")
            && let Some(n) = s.lines().find_map(|l| l.strip_prefix("Threads:")).and_then(|v| v.trim().parse::<u64>().ok())
        {
            return n;
        }
    }
    #[cfg(target_os = "macos")]
    {
        // SAFETY: `proc_taskinfo` is a plain C struct of integers, for which all-zero bytes are a valid value.
        let mut ti: libc::proc_taskinfo = unsafe { std::mem::zeroed() };
        let want = std::mem::size_of::<libc::proc_taskinfo>() as libc::c_int;
        // SAFETY: `ti` is a writable `proc_taskinfo` of exactly `want` bytes, the size passed to the call.
        let got =
            unsafe { libc::proc_pidinfo(std::process::id() as libc::c_int, libc::PROC_PIDTASKINFO, 0, (&mut ti as *mut libc::proc_taskinfo).cast(), want) };
        if got == want {
            return ti.pti_threadnum.max(0) as u64;
        }
    }
    0
}

/// Lower this process's priority by `n`.
pub fn apply_nice(n: i32) {
    if n > 0 {
        // SAFETY: `setpriority` takes plain integers and has no memory-safety preconditions.
        unsafe { libc::setpriority(libc::PRIO_PROCESS, 0, n) };
    }
}

/// uid of the process on the other end of `s`.
pub fn peer_uid(s: &UnixStream) -> Option<u32> {
    #[cfg(target_os = "linux")]
    {
        let mut cred = libc::ucred { pid: 0, uid: 0, gid: 0 };
        let mut len = std::mem::size_of::<libc::ucred>() as libc::socklen_t;
        // SAFETY: `cred` and `len` describe a writable ucred buffer of exactly `len` bytes; the fd is live for the call.
        let rc = unsafe { libc::getsockopt(s.as_raw_fd(), libc::SOL_SOCKET, libc::SO_PEERCRED, &mut cred as *mut _ as *mut libc::c_void, &mut len) };
        (rc == 0).then_some(cred.uid)
    }
    #[cfg(not(target_os = "linux"))]
    {
        let (mut u, mut g): (libc::uid_t, libc::gid_t) = (0, 0);
        // SAFETY: `s` is an open socket and `u` and `g` are live, writable out-values.
        let rc = unsafe { libc::getpeereid(s.as_raw_fd(), &mut u, &mut g) };
        (rc == 0).then_some(u)
    }
}

/// A peer is allowed only when its uid is known and equals `expect`.
pub fn peer_allowed(s: &UnixStream, expect: u32) -> bool {
    peer_uid(s) == Some(expect)
}

/// Make `dir` a private directory owned by us: create 0700, or verify an existing one is a real
/// directory (not a symlink) owned by our uid, and tighten it to 0700.
pub fn ensure_private_dir(dir: &Path) -> Result<(), DirError> {
    let os = |source: std::io::Error| DirError::Io { path: dir.to_path_buf(), source };
    match std::fs::symlink_metadata(dir) {
        Ok(m) => {
            if !m.file_type().is_dir() {
                return Err(DirError::NotADirectory(dir.to_path_buf()));
            }
            if m.uid() != uid() {
                return Err(DirError::WrongOwner { path: dir.to_path_buf(), found: m.uid(), expected: uid() });
            }
            if m.mode() & 0o777 != 0o700 {
                std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700)).map_err(os)?;
            }
            Ok(())
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            std::fs::create_dir_all(dir).map_err(os)?;
            std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700)).map_err(os)?;
            Ok(())
        }
        Err(e) => Err(os(e)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    #[test]
    fn bucket_allows_burst_then_throttles_then_refills() {
        let mut b = Buckets::new(10.0, 3.0);
        let t0 = Instant::now();
        assert!(b.allow_at("s", t0) && b.allow_at("s", t0) && b.allow_at("s", t0));
        assert!(!b.allow_at("s", t0), "burst exhausted");
        assert!(b.allow_at("other", t0), "other keys are independent");
        assert!(b.allow_at("s", t0 + Duration::from_millis(150)), "refilled ~1.5 tokens");
    }

    #[test]
    fn bucket_map_is_bounded_under_key_flood() {
        let mut b = Buckets::new(1.0, 1.0);
        let t0 = Instant::now();
        for i in 0..10_000 {
            b.allow_at(&format!("k{i}"), t0);
        }
        assert!(b.map.len() <= 4096);
    }

    #[test]
    fn peer_uid_is_ours_and_a_foreign_expectation_is_rejected() {
        let (a, _b) = UnixStream::pair().unwrap();
        assert_eq!(peer_uid(&a), Some(uid()));
        assert!(peer_allowed(&a, uid()));
        assert!(!peer_allowed(&a, uid().wrapping_add(1)), "any other uid must be rejected");
    }

    #[test]
    fn private_dir_is_created_0700_tightened_and_refuses_symlinks_and_files() {
        let base = std::env::temp_dir().join(format!("ah-lim-{}", std::process::id()));
        crate::discard::harmless(std::fs::remove_dir_all(&base)); // keep: cleanup that raced; an absent file is the goal state
        std::fs::create_dir_all(&base).unwrap();
        let d = base.join("d");
        ensure_private_dir(&d).unwrap();
        assert_eq!(std::fs::metadata(&d).unwrap().mode() & 0o777, 0o700);
        std::fs::set_permissions(&d, std::fs::Permissions::from_mode(0o755)).unwrap();
        ensure_private_dir(&d).unwrap();
        assert_eq!(std::fs::metadata(&d).unwrap().mode() & 0o777, 0o700);
        std::os::unix::fs::symlink(&d, base.join("link")).unwrap();
        assert_eq!(ensure_private_dir(&base.join("link")).unwrap_err().code(), "unsafe_dir");
        std::fs::write(base.join("f"), "x").unwrap();
        assert_eq!(ensure_private_dir(&base.join("f")).unwrap_err().code(), "unsafe_dir");
        crate::discard::harmless(std::fs::remove_dir_all(&base)); // keep: cleanup that raced; an absent file is the goal state
    }

    #[test]
    fn readings_are_sane() {
        assert!(rss_kb() > 0);
        assert!(process_cpu_secs() >= 0.0);
        let a = thread_cpu_us();
        let mut x = 0u64;
        for i in 0..2_000_000u64 {
            x = x.wrapping_add(i * i);
        }
        std::hint::black_box(x);
        assert!(thread_cpu_us() >= a);
    }
}
