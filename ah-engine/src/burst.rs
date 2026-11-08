//! Burst allocation-site profiling: which function allocated the memory of a short heap jump.
//!
//! Why not jemalloc's `prof`: it needs jemalloc built with `--enable-prof` for every release target, a malloc_conf switch at process
//! start, and its dump holds raw addresses that only the external `jeprof` script resolves. This module does the same job with the
//! counting allocator the daemon already installs ([`crate::memstat::Counting`]): every `diagnostics.burst_sample_kb` of allocation
//! volume on a thread (byte-based sampling, like jemalloc's `lg_prof_sample`) the allocating stack is captured with the C library's
//! `backtrace` (no allocation) and the sampled bytes are added to a fixed table keyed by stack.
//!
//! Trigger: the table covers one window (`diagnostics.burst_window_ms`). When a request ends and the counted heap's high-water mark in
//! the window is more than `diagnostics.burst_dump_mb` above the heap at the window's start, ONE dump is written (rate limited by
//! `diagnostics.burst_dump_max_per_hour`) with the event, the checks and their peaks, the recent requests of the window and the sampled
//! sites, symbolised with `dladdr` where the binary has symbols (a stripped release carries the module base and offset instead, for
//! `atos`/`addr2line` against the separate symbol file). The high-water mark is read at the end of every request, so a burst that
//! was freed again before the next tick is still seen.
//!
//! Cost while on: one relaxed load per allocation, a thread-local add and compare, and one `backtrace` per sample interval.
//! While off: one relaxed load per allocation.
use std::cell::{Cell, RefCell};
use std::collections::VecDeque;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering::*};
use std::sync::{Mutex, OnceLock};

/// Frames one captured stack can hold (the stack buffer is this big; `diagnostics.burst_frames_max` is clamped to it).
const FRAME_CAP: usize = 64;

pub(crate) static ON: AtomicBool = AtomicBool::new(false);
static INTERVAL: AtomicUsize = AtomicUsize::new(usize::MAX);
static FRAMES: AtomicUsize = AtomicUsize::new(16);
static WIN_BASE: AtomicU64 = AtomicU64::new(0);
static WIN_PEAK: AtomicU64 = AtomicU64::new(0);
static WIN_START: AtomicU64 = AtomicU64::new(0);
/// Requests between `begin()` and `request_end()`: a window is only rolled by `begin()` when none is in flight.
static INFLIGHT: AtomicUsize = AtomicUsize::new(0);
static THRESH: AtomicU64 = AtomicU64::new(u64::MAX);
static WINDOW_MS: AtomicU64 = AtomicU64::new(500);
static WINDOW_MAX_MS: AtomicU64 = AtomicU64::new(5_000);
/// Generation of the site table: a slot belongs to the current window only while its `epoch` equals this. Clearing the table is one
/// increment, so a sample being recorded can never be mixed with a slot another thread is reusing (no slot is rewritten in place).
static EPOCH: AtomicU64 = AtomicU64::new(1);
/// `Slot::epoch` while one thread is filling the slot in: others skip it.
const CLAIMING: u64 = u64::MAX;
static MAX_PER_HOUR: AtomicU64 = AtomicU64::new(0);
static RATE_WINDOW_MS: AtomicU64 = AtomicU64::new(0);
static KEEP: AtomicUsize = AtomicUsize::new(1);
static DUMP_SITES: AtomicUsize = AtomicUsize::new(1);
static RECENT_MAX: AtomicUsize = AtomicUsize::new(1);
static DIR_OVERRIDE: Mutex<Option<PathBuf>> = Mutex::new(None);
static DUMPED: Mutex<VecDeque<u64>> = Mutex::new(VecDeque::new());
static RECENT: Mutex<VecDeque<Recent>> = Mutex::new(VecDeque::new());

thread_local! {
    static SINCE: Cell<usize> = const { Cell::new(0) };
    static BUSY: Cell<bool> = const { Cell::new(false) };
    static NOTE: RefCell<Vec<(String, u64)>> = const { RefCell::new(Vec::new()) };
}

struct Recent {
    ts: u64,
    event: String,
    checks: Vec<(String, u64)>,
}

struct Slot {
    epoch: AtomicU64,
    hash: AtomicU64,
    bytes: AtomicU64,
    samples: AtomicU64,
    depth: AtomicUsize,
}

struct Table {
    slots: Vec<Slot>,
    frames: Vec<AtomicUsize>,
    per: usize,
    dropped: AtomicU64,
}

static TABLE: OnceLock<Table> = OnceLock::new();

/// What a finished request tells the profiler.
pub struct Ctx<'a> {
    /// Hook event of the request.
    pub event: &'a str,
    /// Workers serving at the time.
    pub busy: u64,
}

/// What [`request_end`] did.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Outcome {
    /// A dump was written to this file.
    Written(PathBuf),
    /// A burst was seen but the hourly limit (or an unwritable directory) suppressed the dump.
    Suppressed,
}

/// Settings of the profiler (`diagnostics.burst_*`).
#[derive(Debug, Clone)]
pub struct Config {
    /// Master switch.
    pub on: bool,
    /// Bytes of allocation volume per captured stack.
    pub sample_bytes: usize,
    /// Heap growth within a window that triggers a dump.
    pub dump_bytes: u64,
    /// Window length.
    pub window_ms: u64,
    /// A window older than this when a request begins is rolled to the current heap, so slow growth over an idle gap is no burst.
    pub window_max_ms: u64,
    /// Most dumps per rate window.
    pub max_per_hour: u64,
    /// The rate window (an hour).
    pub rate_window_ms: u64,
    /// Dump files kept (the oldest is overwritten).
    pub keep: usize,
    /// Sites in the table (fixed at the first enable).
    pub sites: usize,
    /// Frames per stack.
    pub frames: usize,
    /// Sites listed in a dump.
    pub dump_sites: usize,
    /// Requests remembered for the dump.
    pub recent: usize,
}

/// [`configure`] from the shipped settings.
pub fn configure_from_defaults() {
    use crate::defaults::{num, raw};
    configure(&Config {
        on: raw("diagnostics.burst_profile").as_bool().unwrap_or_default(),
        sample_bytes: (num("diagnostics.burst_sample_kb") as usize).saturating_mul(1024),
        dump_bytes: num("diagnostics.burst_dump_mb").saturating_mul(1024 * 1024),
        window_ms: num("diagnostics.burst_window_ms"),
        window_max_ms: num("diagnostics.burst_window_max_ms"),
        max_per_hour: num("diagnostics.burst_dump_max_per_hour"),
        rate_window_ms: num("diagnostics.burst_rate_window_ms"),
        keep: num("diagnostics.burst_dump_keep") as usize,
        sites: num("diagnostics.burst_sites_max") as usize,
        frames: num("diagnostics.burst_frames_max") as usize,
        dump_sites: num("diagnostics.burst_dump_sites") as usize,
        recent: num("diagnostics.burst_recent_max") as usize,
    });
}

/// Apply `c`. Called outside the allocator (it allocates the table on the first enable).
pub fn configure(c: &Config) {
    if c.on {
        let per = c.frames.clamp(1, FRAME_CAP);
        TABLE.get_or_init(|| Table {
            slots: (0..c.sites.max(8))
                .map(|_| Slot {
                    epoch: AtomicU64::new(0),
                    hash: AtomicU64::new(0),
                    bytes: AtomicU64::new(0),
                    samples: AtomicU64::new(0),
                    depth: AtomicUsize::new(0),
                })
                .collect(),
            frames: (0..c.sites.max(8) * per).map(|_| AtomicUsize::new(0)).collect(),
            per,
            dropped: AtomicU64::new(0),
        });
        warm();
        if !ON.load(Relaxed) {
            // switched on (or started): the window opens at the heap as it is now, so the first request never counts the whole heap as growth
            INFLIGHT.store(0, Relaxed);
            reset_window(crate::memstat::heap().live, now_ms());
        }
    }
    INTERVAL.store(c.sample_bytes.max(1), Relaxed);
    FRAMES.store(c.frames.clamp(1, FRAME_CAP), Relaxed);
    THRESH.store(c.dump_bytes, Relaxed);
    WINDOW_MS.store(c.window_ms.max(1), Relaxed);
    WINDOW_MAX_MS.store(c.window_max_ms.max(c.window_ms).max(1), Relaxed);
    MAX_PER_HOUR.store(c.max_per_hour, Relaxed);
    RATE_WINDOW_MS.store(c.rate_window_ms, Relaxed);
    KEEP.store(c.keep.max(1), Relaxed);
    DUMP_SITES.store(c.dump_sites.max(1), Relaxed);
    RECENT_MAX.store(c.recent.max(1), Relaxed);
    ON.store(c.on, Relaxed);
}

/// Test seam: write dumps here instead of the state directory.
pub fn set_dump_dir(dir: Option<PathBuf>) {
    *DIR_OVERRIDE.lock().unwrap_or_else(|e| e.into_inner()) = dir;
}

/// Test seam: forget the window state left by earlier tests of the same process (base, peak, start, requests in flight), as a fresh
/// process has it, so a test's outcome never depends on which test ran before it.
pub fn forget_window() {
    WIN_BASE.store(0, Relaxed);
    WIN_PEAK.store(0, Relaxed);
    WIN_START.store(0, Relaxed);
    INFLIGHT.store(0, Relaxed);
}

/// Test seam: forget the dumps written so far, so the hourly limit starts empty.
pub fn forget_dumps() {
    DUMPED.lock().unwrap_or_else(|e| e.into_inner()).clear();
}

/// Where dumps are written (`files.burst_dumps_dir` in the state directory, unless a test redirected it).
pub fn dump_dir() -> PathBuf {
    DIR_OVERRIDE.lock().unwrap_or_else(|e| e.into_inner()).clone().unwrap_or_else(|| crate::paths::dir().join(crate::defaults::text("files.burst_dumps_dir")))
}

/// A request starts on this thread.
pub fn begin() {
    if ON.load(Relaxed) {
        NOTE.with(|n| n.borrow_mut().clear());
        // a window that outlived `window_max_ms` (an idle gap) holds growth of no burst: open a new one at the heap before this request
        // (only when no other request is in flight: that request's burst is in the window, and rolling would throw its growth away)
        let alone = INFLIGHT.fetch_add(1, AcqRel) == 0;
        let (now, start) = (now_ms(), WIN_START.load(Relaxed));
        if alone && now.saturating_sub(start) > WINDOW_MAX_MS.load(Relaxed) && WIN_START.compare_exchange(start, now, AcqRel, Relaxed).is_ok() {
            reset_window(crate::memstat::heap().live, now);
        }
    }
}

/// A check of the request in progress peaked at `peak` bytes.
pub fn note_check(id: &str, peak: u64) {
    if ON.load(Relaxed) {
        NOTE.with(|n| n.borrow_mut().push((id.to_string(), peak)));
    }
}

#[cfg(any(target_os = "macos", all(target_os = "linux", target_env = "gnu")))]
unsafe extern "C" {
    fn backtrace(buf: *mut *mut libc::c_void, size: libc::c_int) -> libc::c_int;
}

/// The first `backtrace` call may load the unwinder (and allocate): do it once, outside the allocator.
fn warm() {
    let mut b = [0usize; 4];
    capture(&mut b);
}

#[cfg(any(target_os = "macos", all(target_os = "linux", target_env = "gnu")))]
fn capture(buf: &mut [usize]) -> usize {
    // SAFETY: `buf` is writable for `buf.len()` pointers; `backtrace` writes at most that many and allocates nothing after the first call.
    let n = unsafe { backtrace(buf.as_mut_ptr().cast(), buf.len().min(FRAME_CAP) as libc::c_int) };
    n.max(0) as usize
}

#[cfg(not(any(target_os = "macos", all(target_os = "linux", target_env = "gnu"))))]
fn capture(_buf: &mut [usize]) -> usize {
    0
}

/// Called by the counting allocator on every allocation (`live` is the counted heap after it). Never allocates.
pub(crate) fn on_alloc(by: usize, live: u64) {
    if live > WIN_PEAK.load(Relaxed) {
        WIN_PEAK.fetch_max(live, Relaxed);
    }
    let s = SINCE.with(|c| {
        let s = c.get().saturating_add(by);
        if s >= INTERVAL.load(Relaxed) {
            c.set(0);
            s
        } else {
            c.set(s);
            0
        }
    });
    if s > 0 {
        sample(s);
    }
}

fn sample(bytes: usize) {
    let Some(t) = TABLE.get() else { return };
    if BUSY.with(|b| b.replace(true)) {
        return;
    }
    let mut buf = [0usize; FRAME_CAP];
    let n = buf.get_mut(..FRAMES.load(Relaxed).min(FRAME_CAP)).map_or(0, capture);
    if let Some(stack) = buf.get(..n).filter(|s| !s.is_empty()) {
        t.record(stack, bytes as u64);
    }
    BUSY.with(|b| b.set(false));
}

impl Table {
    fn record(&self, ips: &[usize], bytes: u64) {
        let mut h: u64 = 0xcbf2_9ce4_8422_2325;
        for ip in ips {
            h = (h ^ *ip as u64).wrapping_mul(0x0100_0000_01b3);
        }
        h |= 1;
        let cur = EPOCH.load(Acquire);
        let n = self.slots.len();
        for k in 0..n {
            let i = (h as usize).wrapping_add(k) % n;
            let Some(s) = self.slots.get(i) else { return };
            let e = s.epoch.load(Acquire);
            if e == cur {
                if s.hash.load(Relaxed) == h {
                    s.bytes.fetch_add(bytes, Relaxed);
                    s.samples.fetch_add(1, Relaxed);
                    return;
                }
            } else if e > cur {
                return; // the window rolled while this stack was captured: the sample belongs to the old one
            } else if e != CLAIMING && s.epoch.compare_exchange(e, CLAIMING, AcqRel, Acquire).is_ok() {
                // a slot of an older window, now mine alone until `epoch` is published
                let d = ips.len().min(self.per);
                for (j, ip) in ips.iter().take(d).enumerate() {
                    if let Some(cell) = self.frames.get(i * self.per + j) {
                        cell.store(*ip, Relaxed);
                    }
                }
                s.depth.store(d, Relaxed);
                s.hash.store(h, Relaxed);
                s.bytes.store(bytes, Relaxed);
                s.samples.store(1, Relaxed);
                s.epoch.store(cur, Release);
                return;
            }
        }
        self.dropped.fetch_add(bytes, Relaxed);
    }

    /// Start a new window: every slot becomes older than the current epoch at once.
    fn clear(&self) {
        EPOCH.fetch_add(1, AcqRel);
        self.dropped.store(0, Relaxed);
    }
}

fn now_ms() -> u64 {
    crate::health::now_ms()
}

fn reset_window(live: u64, now: u64) {
    WIN_BASE.store(live, Relaxed);
    WIN_PEAK.store(live, Relaxed);
    WIN_START.store(now, Relaxed);
    if let Some(t) = TABLE.get() {
        t.clear();
    }
}

/// A request ended on this thread: remember it, and write the dump when the window's heap growth passed the threshold.
pub fn request_end(ctx: &Ctx<'_>) -> Option<Outcome> {
    if !ON.load(Relaxed) {
        return None;
    }
    let checks = NOTE.with(|n| std::mem::take(&mut *n.borrow_mut()));
    INFLIGHT.try_update(AcqRel, Relaxed, |n| Some(n.saturating_sub(1))).ok();
    let now = now_ms();
    {
        let mut r = RECENT.lock().unwrap_or_else(|e| e.into_inner());
        r.push_back(Recent { ts: now, event: ctx.event.to_string(), checks: checks.clone() });
        while r.len() > RECENT_MAX.load(Relaxed) {
            r.pop_front();
        }
    }
    let live = crate::memstat::heap().live;
    let growth = WIN_PEAK.load(Relaxed).saturating_sub(WIN_BASE.load(Relaxed));
    if growth > THRESH.load(Relaxed) {
        let out = dump(ctx, &checks, growth, live, now);
        reset_window(live, now);
        return Some(out);
    }
    let start = WIN_START.load(Relaxed);
    if now.saturating_sub(start) >= WINDOW_MS.load(Relaxed) && WIN_START.compare_exchange(start, now, AcqRel, Relaxed).is_ok() {
        reset_window(live, now);
    }
    None
}

fn dump(ctx: &Ctx<'_>, checks: &[(String, u64)], growth: u64, live: u64, now: u64) -> Outcome {
    {
        let mut d = DUMPED.lock().unwrap_or_else(|e| e.into_inner());
        while d.front().is_some_and(|t| now.saturating_sub(*t) >= RATE_WINDOW_MS.load(Relaxed)) {
            d.pop_front();
        }
        if d.len() as u64 >= MAX_PER_HOUR.load(Relaxed) {
            crate::metrics::bump("burst_dumps_suppressed", &[]);
            return Outcome::Suppressed;
        }
        d.push_back(now);
    }
    let doc = build(ctx, checks, growth, live, now);
    let dir = dump_dir();
    let keep = KEEP.load(Relaxed);
    let write = || -> std::io::Result<PathBuf> {
        std::fs::create_dir_all(&dir)?;
        // a ring of `keep` files: the first free name, else the oldest is overwritten (nothing is deleted)
        let mut pick = (0usize, std::time::SystemTime::now());
        for i in 0..keep {
            let p = dir.join(dump_name(i));
            match std::fs::metadata(&p).and_then(|m| m.modified()) {
                Err(_) => {
                    pick = (i, std::time::UNIX_EPOCH);
                    break;
                }
                Ok(t) if t < pick.1 => pick = (i, t),
                Ok(_) => {}
            }
        }
        let path = dir.join(dump_name(pick.0));
        crate::atomic::write(&path, doc.to_string())?;
        Ok(path)
    };
    match write() {
        Ok(p) => {
            crate::metrics::bump("burst_dumps_written", &[]);
            Outcome::Written(p)
        }
        Err(_) => {
            crate::metrics::bump("burst_dumps_suppressed", &[]);
            Outcome::Suppressed
        }
    }
}

/// File name of ring slot `i`: `diagnostics.burst_dump_prefix`, the slot, `.` and `diagnostics.burst_dump_ext` (the extension `diag burst-dump` lists by).
pub(crate) fn dump_name(i: usize) -> String {
    format!("{}{i}.{}", crate::defaults::text("diagnostics.burst_dump_prefix"), crate::defaults::text("diagnostics.burst_dump_ext"))
}

fn build(ctx: &Ctx<'_>, checks: &[(String, u64)], growth: u64, live: u64, now: u64) -> serde_json::Value {
    use serde_json::json;
    let mut sites = Vec::new();
    let mut dropped = 0;
    let cur = EPOCH.load(Acquire);
    if let Some(t) = TABLE.get() {
        dropped = t.dropped.load(Relaxed);
        for (i, s) in t.slots.iter().enumerate() {
            let e = s.epoch.load(Acquire);
            if e != cur || s.bytes.load(Relaxed) == 0 {
                continue;
            }
            let d = s.depth.load(Relaxed).min(t.per);
            let ips: Vec<usize> = (0..d).map(|j| t.frames.get(i * t.per + j).map_or(0, |a| a.load(Relaxed))).collect();
            let (bytes, samples) = (s.bytes.load(Relaxed), s.samples.load(Relaxed));
            // the window rolled and another thread took the slot while it was read: drop the torn row
            if s.epoch.load(Acquire) == e {
                sites.push((bytes, samples, ips));
            }
        }
    }
    sites.sort_by_key(|a| std::cmp::Reverse(a.0));
    sites.truncate(DUMP_SITES.load(Relaxed));
    let sites: Vec<_> = sites
        .into_iter()
        .map(|(bytes, samples, ips)| {
            let mut frames: Vec<_> = ips.iter().map(|ip| symbolize(*ip)).collect();
            let internal_frames = crate::defaults::list("diagnostics.burst_internal_frames");
            // drop the allocator's own leading frames when the binary has symbols
            let internal =
                |f: &serde_json::Value| f.get("function").and_then(serde_json::Value::as_str).is_some_and(|n| internal_frames.iter().any(|p| n.contains(p)));
            while frames.len() > 1 && frames.first().is_some_and(internal) {
                frames.remove(0);
            }
            json!({"sampled_bytes": bytes, "samples": samples, "frames": frames})
        })
        .collect();
    let mut top = checks.to_vec();
    top.sort_by_key(|a| std::cmp::Reverse(a.1));
    let recent: Vec<_> = RECENT
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .iter()
        .map(|r| json!({"ts": r.ts, "event": r.event, "checks": r.checks.iter().map(|(c, p)| json!({"check": c, "peak_bytes": p})).collect::<Vec<_>>()}))
        .collect();
    json!({
        "ts": now, "event": ctx.event, "busy": ctx.busy,
        "trigger": {"growth_bytes": growth, "threshold_bytes": THRESH.load(Relaxed), "window_ms": WINDOW_MS.load(Relaxed), "base_bytes": WIN_BASE.load(Relaxed), "live_bytes": live},
        "checks": top.iter().map(|(c, p)| json!({"check": c, "peak_bytes": p})).collect::<Vec<_>>(),
        "recent_requests": recent,
        "build": identity(),
        "sample_interval_bytes": INTERVAL.load(Relaxed),
        "unrecorded_sampled_bytes": dropped,
        "sites": sites,
        "allocator": crate::memdiag::allocator_stats(),
        "note": crate::defaults::text("diagnostics.burst_dump_note"),
    })
}

/// Which build wrote a dump: the version, the identity of the running binary (Mach-O `LC_UUID` or ELF build-id, what the separate
/// symbol file carries too), where its image is loaded and where the binary is, so the dump can be matched to its symbols later
/// (`ah-engine diag burst-dump --symbolize <dump>`). Read once, at the first dump.
pub fn identity() -> &'static serde_json::Value {
    static ID: OnceLock<serde_json::Value> = OnceLock::new();
    ID.get_or_init(|| {
        let exe = std::env::current_exe().ok();
        let id = exe.as_deref().and_then(crate::buildid::of_file);
        // SAFETY: Dl_info is plain C data, valid all-zero.
        let mut info: libc::Dl_info = unsafe { std::mem::zeroed() };
        // SAFETY: `info` is a writable Dl_info; dladdr only reads the address of this function.
        let base = if unsafe { libc::dladdr(identity as fn() -> &'static serde_json::Value as *const libc::c_void, &mut info) } != 0 {
            info.dli_fbase as usize
        } else {
            0
        };
        serde_json::json!({
            "version": env!("CARGO_PKG_VERSION"),
            "build_id": id.as_ref().map(|i| i.id.clone()),
            "build_id_kind": id.as_ref().map(|i| i.kind.name()),
            "image_base": format!("{base:#x}"),
            "exe": exe.as_ref().map(|p| p.display().to_string()),
            "exe_bytes": exe.as_ref().and_then(|p| std::fs::metadata(p).ok()).map(|m| m.len()),
            "os": std::env::consts::OS,
            "arch": std::env::consts::ARCH,
        })
    })
}

fn symbolize(ip: usize) -> serde_json::Value {
    // SAFETY: Dl_info is plain C data, valid all-zero.
    let mut info: libc::Dl_info = unsafe { std::mem::zeroed() };
    // SAFETY: `info` is a writable Dl_info; dladdr only reads the address (the call-site byte before the return address).
    let ok = unsafe { libc::dladdr(ip.saturating_sub(1) as *const libc::c_void, &mut info) } != 0;
    let cstr = |p: *const libc::c_char| {
        // SAFETY: dladdr returns NUL-terminated strings that live as long as the image.
        (!p.is_null()).then(|| unsafe { std::ffi::CStr::from_ptr(p) }.to_string_lossy().into_owned())
    };
    if !ok {
        return serde_json::json!({"ip": format!("{ip:#x}"), "function": null});
    }
    let sym = cstr(info.dli_sname);
    serde_json::json!({
        "ip": format!("{ip:#x}"), "image": cstr(info.dli_fname), "image_base": format!("{:#x}", info.dli_fbase as usize),
        "offset": format!("{:#x}", ip.wrapping_sub(info.dli_fbase as usize)),
        "symbol": sym, "function": sym.as_deref().map(demangle),
    })
}

/// Legacy Rust mangling (`_ZN3foo3bar17h<hash>E`) to `foo::bar`; anything else as it is.
fn demangle(s: &str) -> String {
    let t = s.trim_start_matches('_');
    let Some(mut rest) = t.strip_prefix("ZN") else { return s.to_string() };
    let mut parts = Vec::new();
    while let Some(i) = rest.find(|c: char| !c.is_ascii_digit()) {
        let Some(Ok(n)) = rest.get(..i).map(str::parse::<usize>) else { break };
        let Some(end) = i.checked_add(n) else { break };
        let (Some(part), Some(after)) = (rest.get(i..end), rest.get(end..)) else { break };
        if i == 0 {
            break;
        }
        parts.push(part.to_string());
        rest = after;
    }
    if parts.last().is_some_and(|l| l.starts_with('h') && l.len() == 17) {
        parts.pop();
    }
    if parts.is_empty() { s.to_string() } else { parts.join("::") }
}

#[cfg(test)]
mod tests {
    /// Threads record two different stacks while the table is cleared over and over: every slot that survives holds ONE whole stack
    /// (never frames of one and the bytes or frames of the other), and its sampled bytes are a whole number of samples.
    #[test]
    fn clearing_while_recording_never_mixes_two_stacks_in_one_site() {
        use std::sync::atomic::Ordering::Relaxed;
        let per = 6;
        let t = std::sync::Arc::new(super::Table {
            slots: (0..4)
                .map(|_| super::Slot {
                    epoch: super::AtomicU64::new(0),
                    hash: super::AtomicU64::new(0),
                    bytes: super::AtomicU64::new(0),
                    samples: super::AtomicU64::new(0),
                    depth: super::AtomicUsize::new(0),
                })
                .collect(),
            frames: (0..4 * per).map(|_| super::AtomicUsize::new(0)).collect(),
            per,
            dropped: super::AtomicU64::new(0),
        });
        let stop = std::sync::Arc::new(super::AtomicBool::new(false));
        let writers: Vec<_> = (1..=3usize)
            .map(|w| {
                let (t, stop) = (t.clone(), stop.clone());
                std::thread::spawn(move || {
                    let stack = vec![w * 0x1000; per];
                    while !stop.load(Relaxed) {
                        t.record(&stack, 7);
                    }
                })
            })
            .collect();
        for _ in 0..20_000 {
            t.clear();
            std::thread::yield_now();
        }
        stop.store(true, Relaxed);
        for w in writers {
            w.join().unwrap();
        }
        let cur = super::EPOCH.load(Relaxed);
        for (i, s) in t.slots.iter().enumerate() {
            if s.epoch.load(Relaxed) != cur {
                continue;
            }
            let frames: Vec<usize> = (0..s.depth.load(Relaxed)).map(|j| t.frames[i * per + j].load(Relaxed)).collect();
            assert!(frames.windows(2).all(|p| p[0] == p[1]) && frames.len() == per, "one whole stack per site: {frames:?}");
            assert_eq!(s.bytes.load(Relaxed) % 7, 0, "whole samples only");
        }
    }

    #[test]
    fn legacy_names_demangle() {
        assert_eq!(super::demangle("__ZN9ah_engine5burst3foo17h0123456789abcdefE"), "ah_engine::burst::foo");
        assert_eq!(super::demangle("main"), "main");
    }
}
