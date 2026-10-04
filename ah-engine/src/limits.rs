//! Resource limits and process-level safety: token buckets, rlimit/nice, RSS and CPU readings,
//! peer-uid check, private-directory check.
use std::collections::HashMap;
use std::os::unix::fs::{MetadataExt, PermissionsExt};
use std::os::unix::io::AsRawFd;
use std::os::unix::net::UnixStream;
use std::path::Path;
use std::time::Instant;

pub fn uid() -> u32 {
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
    pub fn new(rps: f64, burst: f64) -> Buckets {
        Buckets { map: HashMap::new(), rps, burst: burst.max(1.0), cap: 4096 }
    }
    /// True when `key` may proceed; false when it is over its rate.
    pub fn allow(&mut self, key: &str) -> bool {
        self.allow_at(key, Instant::now())
    }
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
    let rc = unsafe { libc::clock_gettime(libc::CLOCK_THREAD_CPUTIME_ID, &mut ts) };
    if rc != 0 {
        return 0;
    }
    ts.tv_sec as u64 * 1_000_000 + ts.tv_nsec as u64 / 1000
}

/// User+system CPU seconds of this process.
pub fn process_cpu_secs() -> f64 {
    let mut ru: libc::rusage = unsafe { std::mem::zeroed() };
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
        if let Ok(s) = std::fs::read_to_string("/proc/self/statm") {
            if let Some(pages) = s.split_whitespace().nth(1).and_then(|v| v.parse::<u64>().ok()) {
                return pages * (unsafe { libc::sysconf(libc::_SC_PAGESIZE) } as u64) / 1024;
            }
        }
    }
    let out = std::process::Command::new("ps").args(["-o", "rss=", "-p", &std::process::id().to_string()]).output();
    out.ok().and_then(|o| String::from_utf8_lossy(&o.stdout).trim().parse().ok()).unwrap_or(0)
}

/// Cap the data segment. Returns a status word for `status`: "ok:<mb>", "off", or "err:<errno>".
/// NOTE: macOS accepts RLIMIT_DATA but the kernel may not enforce it, so the periodic RSS check is the
/// real guard there; the status string tells the truth about whether the call succeeded, not enforcement.
pub fn apply_mem_limit(mb: u64) -> String {
    if mb == 0 {
        return "off".into();
    }
    let bytes = (mb * 1024 * 1024) as libc::rlim_t;
    let mut cur: libc::rlimit = libc::rlimit { rlim_cur: 0, rlim_max: 0 };
    if unsafe { libc::getrlimit(libc::RLIMIT_DATA, &mut cur) } != 0 {
        return format!("err:{}", std::io::Error::last_os_error().raw_os_error().unwrap_or(0));
    }
    let lim = libc::rlimit { rlim_cur: bytes.min(cur.rlim_max), rlim_max: cur.rlim_max };
    if unsafe { libc::setrlimit(libc::RLIMIT_DATA, &lim) } != 0 {
        return format!("err:{}", std::io::Error::last_os_error().raw_os_error().unwrap_or(0));
    }
    format!("ok:{mb}")
}

pub fn apply_nice(n: i32) {
    if n > 0 {
        unsafe { libc::setpriority(libc::PRIO_PROCESS, 0, n) };
    }
}

/// uid of the process on the other end of `s`.
pub fn peer_uid(s: &UnixStream) -> Option<u32> {
    #[cfg(target_os = "linux")]
    {
        let mut cred = libc::ucred { pid: 0, uid: 0, gid: 0 };
        let mut len = std::mem::size_of::<libc::ucred>() as libc::socklen_t;
        let rc = unsafe { libc::getsockopt(s.as_raw_fd(), libc::SOL_SOCKET, libc::SO_PEERCRED, &mut cred as *mut _ as *mut libc::c_void, &mut len) };
        return (rc == 0).then_some(cred.uid);
    }
    #[cfg(not(target_os = "linux"))]
    {
        let (mut u, mut g): (libc::uid_t, libc::gid_t) = (0, 0);
        let rc = unsafe { libc::getpeereid(s.as_raw_fd(), &mut u, &mut g) };
        (rc == 0).then_some(u)
    }
}

/// A peer is allowed only when its uid is known and equals `expect`.
pub fn peer_allowed(s: &UnixStream, expect: u32) -> bool {
    peer_uid(s) == Some(expect)
}

/// Make `dir` a private directory owned by us: create 0700, or verify an existing one is a real
/// directory (not a symlink) owned by our uid, and tighten it to 0700. Err = (error code, detail).
pub fn ensure_private_dir(dir: &Path) -> Result<(), (String, String)> {
    let os = |e: std::io::Error| (format!("os{}", e.raw_os_error().unwrap_or(0)), format!("{}: {e}", dir.display()));
    match std::fs::symlink_metadata(dir) {
        Ok(m) => {
            if !m.file_type().is_dir() {
                return Err(("unsafe_dir".into(), format!("{} is not a plain directory", dir.display())));
            }
            if m.uid() != uid() {
                return Err(("unsafe_dir".into(), format!("{} is owned by uid {}, not {}", dir.display(), m.uid(), uid())));
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
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(&base).unwrap();
        let d = base.join("d");
        ensure_private_dir(&d).unwrap();
        assert_eq!(std::fs::metadata(&d).unwrap().mode() & 0o777, 0o700);
        std::fs::set_permissions(&d, std::fs::Permissions::from_mode(0o755)).unwrap();
        ensure_private_dir(&d).unwrap();
        assert_eq!(std::fs::metadata(&d).unwrap().mode() & 0o777, 0o700);
        std::os::unix::fs::symlink(&d, base.join("link")).unwrap();
        assert_eq!(ensure_private_dir(&base.join("link")).unwrap_err().0, "unsafe_dir");
        std::fs::write(base.join("f"), "x").unwrap();
        assert_eq!(ensure_private_dir(&base.join("f")).unwrap_err().0, "unsafe_dir");
        let _ = std::fs::remove_dir_all(&base);
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
