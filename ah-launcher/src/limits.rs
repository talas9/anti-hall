//! The launcher's limits on ITSELF: heap (counting allocator), CPU (RLIMIT_CPU), wall time (ITIMER_REAL), plus the counters.
//!
//! Soft = warn + count (checked at exit); hard = enforce and fail open: stop the engine's process group, say so on stderr
//! (the text was rendered from the settings at start), exit 0. Everything an emergency exit does is async-signal-safe and
//! allocation-free: it runs inside the allocator and inside signal handlers.

use std::alloc::{GlobalAlloc, Layout, System};
use std::sync::atomic::{AtomicI32, AtomicPtr, AtomicU64, AtomicUsize, Ordering::Relaxed};

/// The process group of the engine being waited for (0 = none): killed by every emergency exit.
pub static CHILD_PGID: AtomicI32 = AtomicI32::new(0);

// ---------------------------------------------------------------------------------------------------------------------------
// Counters (sent to the engine inside the request; written locally only on a failure path)
// ---------------------------------------------------------------------------------------------------------------------------

#[derive(Clone, Copy)]
pub enum Ctr {
    SpawnRetries,
    SpawnFail,
    StdinSoft,
    StdinHard,
    StdinIdle,
    WriteTimeout,
    OutOverflow,
    MemSoft,
    CpuSoft,
    WallSoft,
    ConfigFallback,
    ReaperOff,
    KickSkipped,
    FailOpen,
    NoticeShown,
    NoticeSuppressed,
    NoticeEvicted,
}

const NCTR: usize = 17;
static COUNTERS: [AtomicU64; NCTR] = [const { AtomicU64::new(0) }; NCTR];

impl Ctr {
    /// The counter's name on the wire (the stats variable and the failure log): an identifier, not a message.
    pub fn name(self) -> &'static str {
        match self {
            Ctr::SpawnRetries => "spawn_retries",
            Ctr::SpawnFail => "spawn_fail",
            Ctr::StdinSoft => "stdin_soft",
            Ctr::StdinHard => "stdin_hard",
            Ctr::StdinIdle => "stdin_idle",
            Ctr::WriteTimeout => "write_timeout",
            Ctr::OutOverflow => "out_overflow",
            Ctr::MemSoft => "mem_soft",
            Ctr::CpuSoft => "cpu_soft",
            Ctr::WallSoft => "wall_soft",
            Ctr::ConfigFallback => "config_fallback",
            Ctr::ReaperOff => "reaper_off",
            Ctr::KickSkipped => "kick_skipped",
            Ctr::FailOpen => "fail_open",
            Ctr::NoticeShown => "notice_shown",
            Ctr::NoticeSuppressed => "notice_suppressed",
            Ctr::NoticeEvicted => "notice_evicted",
        }
    }
    const ALL: [Ctr; NCTR] = [
        Ctr::SpawnRetries,
        Ctr::SpawnFail,
        Ctr::StdinSoft,
        Ctr::StdinHard,
        Ctr::StdinIdle,
        Ctr::WriteTimeout,
        Ctr::OutOverflow,
        Ctr::MemSoft,
        Ctr::CpuSoft,
        Ctr::WallSoft,
        Ctr::ConfigFallback,
        Ctr::ReaperOff,
        Ctr::KickSkipped,
        Ctr::FailOpen,
        Ctr::NoticeShown,
        Ctr::NoticeSuppressed,
        Ctr::NoticeEvicted,
    ];
}

pub fn bump(c: Ctr) {
    COUNTERS[c as usize].fetch_add(1, Relaxed);
}

pub fn get(c: Ctr) -> u64 {
    COUNTERS[c as usize].load(Relaxed)
}

/// `name=value` pairs of the non-zero counters, `;`-separated.
pub fn render_counters() -> String {
    Ctr::ALL
        .iter()
        .filter(|c| get(**c) > 0)
        .map(|c| format!("{}={}", c.name(), get(*c)))
        .collect::<Vec<_>>()
        .join(";")
}

// ---------------------------------------------------------------------------------------------------------------------------
// Emergency exit
// ---------------------------------------------------------------------------------------------------------------------------

#[derive(Clone, Copy)]
pub enum Why {
    Mem = 0,
    Cpu = 1,
    Wall = 2,
}

static MSG_PTR: [AtomicPtr<u8>; 3] = [const { AtomicPtr::new(std::ptr::null_mut()) }; 3];
static MSG_LEN: [AtomicUsize; 3] = [const { AtomicUsize::new(0) }; 3];

/// Hands over the three emergency lines (rendered from the settings). Leaked on purpose: they must outlive everything.
pub fn set_messages(mem: &str, cpu: &str, wall: &str) {
    for (i, text) in [mem, cpu, wall].into_iter().enumerate() {
        let mut line = text.as_bytes().to_vec();
        line.push(b'\n');
        let leaked: &'static mut [u8] = Box::leak(line.into_boxed_slice());
        MSG_LEN[i].store(leaked.len(), Relaxed);
        MSG_PTR[i].store(leaked.as_mut_ptr(), Relaxed);
    }
}

/// Stop the engine's group, say why, exit 0 (fail open). Async-signal-safe, allocation-free.
pub fn emergency(why: Why) -> ! {
    let pg = CHILD_PGID.load(Relaxed);
    let i = why as usize;
    let (p, n) = (MSG_PTR[i].load(Relaxed), MSG_LEN[i].load(Relaxed));
    // SAFETY: kill/write/_exit are async-signal-safe; the message buffer is leaked and never freed.
    unsafe {
        if pg > 0 {
            libc::kill(-pg, libc::SIGKILL);
        }
        if !p.is_null() && n > 0 {
            libc::write(2, p.cast(), n);
        }
        libc::_exit(0)
    }
}

// ---------------------------------------------------------------------------------------------------------------------------
// Heap: a counting allocator with a hard cap
// ---------------------------------------------------------------------------------------------------------------------------

static CUR: AtomicUsize = AtomicUsize::new(0);
static PEAK: AtomicUsize = AtomicUsize::new(0);
static HARD: AtomicUsize = AtomicUsize::new(usize::MAX);

pub struct Counting;

fn grow(by: usize) {
    let now = CUR.fetch_add(by, Relaxed) + by;
    if now > HARD.load(Relaxed) {
        emergency(Why::Mem);
    }
    PEAK.fetch_max(now, Relaxed);
}

// SAFETY: every method forwards to `System` with the same arguments and only adds counter updates.
unsafe impl GlobalAlloc for Counting {
    unsafe fn alloc(&self, l: Layout) -> *mut u8 {
        grow(l.size());
        unsafe { System.alloc(l) }
    }
    unsafe fn alloc_zeroed(&self, l: Layout) -> *mut u8 {
        grow(l.size());
        unsafe { System.alloc_zeroed(l) }
    }
    unsafe fn dealloc(&self, p: *mut u8, l: Layout) {
        CUR.fetch_sub(l.size(), Relaxed);
        unsafe { System.dealloc(p, l) }
    }
    unsafe fn realloc(&self, p: *mut u8, l: Layout, new: usize) -> *mut u8 {
        if new > l.size() {
            grow(new - l.size());
        } else {
            CUR.fetch_sub(l.size() - new, Relaxed);
        }
        unsafe { System.realloc(p, l, new) }
    }
}

pub fn set_mem_hard(bytes: u64) {
    HARD.store(usize::try_from(bytes).unwrap_or(usize::MAX), Relaxed);
}

pub fn mem_now() -> usize {
    CUR.load(Relaxed)
}

pub fn mem_peak() -> usize {
    PEAK.load(Relaxed)
}

/// Checked BEFORE a buffer grows by `extra`: false when that growth would reach the hard cap (the caller stops growing instead
/// of tripping the allocator's emergency exit).
pub fn mem_ok(extra: usize) -> bool {
    CUR.load(Relaxed).saturating_add(extra) < HARD.load(Relaxed)
}

// ---------------------------------------------------------------------------------------------------------------------------
// CPU and wall time
// ---------------------------------------------------------------------------------------------------------------------------

static ORIG_CPU_CUR: AtomicU64 = AtomicU64::new(0);
static ORIG_CPU_MAX: AtomicU64 = AtomicU64::new(0);

extern "C" fn on_cpu(_: libc::c_int) {
    emergency(Why::Cpu)
}

extern "C" fn on_wall(_: libc::c_int) {
    emergency(Why::Wall)
}

fn handle(sig: libc::c_int, f: extern "C" fn(libc::c_int)) -> bool {
    // SAFETY: a zeroed sigaction with a plain handler and an empty mask is valid input.
    unsafe {
        let mut sa: libc::sigaction = std::mem::zeroed();
        sa.sa_sigaction = f as usize;
        libc::sigemptyset(&mut sa.sa_mask);
        libc::sigaction(sig, &sa, std::ptr::null_mut()) == 0
    }
}

/// RLIMIT_CPU soft limit of `secs` (the hard limit is left alone so the engine can be given the original back); SIGXCPU is an
/// emergency exit. False when it could not be set.
pub fn set_cpu_hard(secs: u64) -> bool {
    // SAFETY: get/setrlimit on a local struct.
    unsafe {
        let mut cur: libc::rlimit = std::mem::zeroed();
        if libc::getrlimit(libc::RLIMIT_CPU, &mut cur) != 0 {
            return false;
        }
        ORIG_CPU_CUR.store(cur.rlim_cur as u64, Relaxed);
        ORIG_CPU_MAX.store(cur.rlim_max as u64, Relaxed);
        if !handle(libc::SIGXCPU, on_cpu) {
            return false;
        }
        let want = libc::rlimit {
            rlim_cur: (secs as libc::rlim_t).min(cur.rlim_max),
            rlim_max: cur.rlim_max,
        };
        libc::setrlimit(libc::RLIMIT_CPU, &want) == 0
    }
}

/// For `pre_exec`: give the engine the CPU limit the launcher started with. Async-signal-safe.
pub fn restore_cpu_limit() {
    let lim = libc::rlimit {
        rlim_cur: ORIG_CPU_CUR.load(Relaxed) as libc::rlim_t,
        rlim_max: ORIG_CPU_MAX.load(Relaxed) as libc::rlim_t,
    };
    // SAFETY: setrlimit is async-signal-safe.
    unsafe {
        libc::setrlimit(libc::RLIMIT_CPU, &lim);
    }
}

/// Wall-clock backstop: SIGALRM after `ms` is an emergency exit. False when it could not be armed.
pub fn arm_wall(ms: u64) -> bool {
    if !handle(libc::SIGALRM, on_wall) {
        return false;
    }
    let it = libc::itimerval {
        it_interval: libc::timeval {
            tv_sec: 0,
            tv_usec: 0,
        },
        it_value: libc::timeval {
            tv_sec: (ms / 1000) as libc::time_t,
            tv_usec: ((ms % 1000) * 1000) as libc::suseconds_t,
        },
    };
    // SAFETY: setitimer on a local struct.
    unsafe { libc::setitimer(libc::ITIMER_REAL, &it, std::ptr::null_mut()) == 0 }
}

/// CPU time of this process so far (user + system), in ms.
pub fn cpu_ms() -> u64 {
    // SAFETY: getrusage on a local struct.
    unsafe {
        let mut ru: libc::rusage = std::mem::zeroed();
        if libc::getrusage(libc::RUSAGE_SELF, &mut ru) != 0 {
            return 0;
        }
        let tv = |t: libc::timeval| (t.tv_sec as u64) * 1000 + (t.tv_usec as u64) / 1000;
        tv(ru.ru_utime) + tv(ru.ru_stime)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn counters_render_only_non_zero() {
        let before = render_counters();
        bump(Ctr::KickSkipped);
        let after = render_counters();
        assert!(after.contains("kick_skipped="), "{before} -> {after}");
    }

    #[test]
    fn mem_ok_respects_the_cap() {
        assert!(mem_ok(1));
        assert!(!mem_ok(usize::MAX));
    }
}
