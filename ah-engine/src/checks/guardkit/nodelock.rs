//! The cross-process lock file of `companion/lib/lock.js`, in the one shape the swarm-guard uses it.
//!
//! The Node hook and this check can run against the same lock file at the same moment (the engine is down for one
//! spawn and up for the next, or both run during a restart), so the file format and the takeover protocol are the
//! Node ones: a JSON owner record `{pid, host, ts, token, boot, pidns}` published with a hard link (never visible
//! empty), a stale lock renamed aside and verified before it is discarded, and a `<lock>.reclaim` marker that
//! serializes the takeovers.
//!
//! What is fixed for the swarm-guard (and so not a parameter): holders are judged by age alone. Its Node call passes the
//! same limit for a dead, a live and an unknown holder and never steals a dead one early, so the holder's class never
//! changes the answer for the lock itself. The class does matter for the takeover marker (a dead owner's marker is taken
//! over at once), which is why liveness and the machine identity are implemented.
//!
//! Mirrors `companion/lib/lock.js` `acquire`, `inspect`, `reclaim`, `takeSidecar`, `reclaimGuarded` and `release`.
// Discard triage (E3): every `.ok()` / `unwrap_or_default()` in this file is a deliberate keep, for these reasons:
// - text that does not parse or decode is the absent value (Node Number()/JSON.parse catch parity)
// - an unreadable optional file is the same as an absent one (fail-open, as Node's try/catch)
// - serializing a string cannot fail
// A failure that must be seen goes through `crate::discard` instead.

use crate::defaults;
use std::io::Write;
use std::os::unix::fs::MetadataExt;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

/// How long to wait for the lock and how stale one may be before it is taken over.
#[derive(Debug, Clone, Copy)]
pub struct Params {
    /// A lock older than this is taken over.
    pub stale_ms: u64,
    /// How long to keep retrying a lock that is respected.
    pub wait_ms: u64,
    /// The pause between retries.
    pub step_ms: u64,
    /// A takeover marker older than this is taken over.
    pub reclaim_stale_ms: u64,
    /// How many times a release tries to take the takeover marker.
    pub release_tries: u64,
    /// The pause between those tries.
    pub release_step_ms: u64,
    /// Two boot times closer than this many seconds are the same boot.
    pub boot_slop_s: u64,
    /// Take over a lock whose holder is a dead process at once, whatever its age (Node's `stealDead`; the per-workspace
    /// lock of `recovery.js` sets it, the swarm-guard does not).
    pub steal_dead: bool,
}

impl Params {
    /// The swarm-guard's values, from the defaults.
    pub fn swarm() -> Params {
        Params {
            stale_ms: defaults::num("swarm_guard.lock_stale_ms"),
            wait_ms: defaults::num("swarm_guard.lock_wait_ms"),
            step_ms: defaults::num("swarm_guard.lock_step_ms"),
            reclaim_stale_ms: defaults::num("swarm_guard.lock_reclaim_stale_ms"),
            release_tries: defaults::num("swarm_guard.lock_release_tries"),
            release_step_ms: defaults::num("swarm_guard.lock_release_step_ms"),
            boot_slop_s: defaults::num("swarm_guard.lock_boot_slop_s"),
            steal_dead: false,
        }
    }

    /// The values of the defaults group `prefix` (`<prefix>.lock_stale_ms`, `.lock_wait_ms`, `.lock_step_ms`,
    /// `.lock_reclaim_stale_ms`, `.lock_release_tries`, `.lock_release_step_ms`, `.lock_boot_slop_s`). `None` when the group
    /// is not shipped.
    pub fn from_group(prefix: &str) -> Option<Params> {
        let num = |k: &str| defaults::get(&format!("{prefix}.{k}")).and_then(|e| e.value.as_integer()).map(|_| defaults::num(&format!("{prefix}.{k}")));
        Some(Params {
            stale_ms: num("lock_stale_ms")?,
            wait_ms: num("lock_wait_ms")?,
            step_ms: num("lock_step_ms")?,
            reclaim_stale_ms: num("lock_reclaim_stale_ms")?,
            release_tries: num("lock_release_tries")?,
            release_step_ms: num("lock_release_step_ms")?,
            boot_slop_s: num("lock_boot_slop_s")?,
            steal_dead: false,
        })
    }
}

/// A held lock; release it with [`Held::release`] (dropping it without releasing leaves the file, which goes stale).
#[derive(Debug)]
pub struct Held {
    path: String,
    token: String,
    p: Params,
}

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

static SEQ: AtomicU64 = AtomicU64::new(0);

/// A short random base-36 string (`Math.random().toString(36).slice(2)`).
fn rand() -> String {
    use std::hash::{BuildHasher, Hasher};
    let mut h = std::collections::hash_map::RandomState::new().build_hasher();
    h.write_u64(now_ms());
    h.write_u32(std::process::id());
    h.write_u64(SEQ.fetch_add(1, Ordering::Relaxed));
    let mut n = h.finish();
    let mut out = String::new();
    while n > 0 && out.len() < 11 {
        out.push(char::from_digit((n % 36) as u32, 36).unwrap_or('0'));
        n /= 36;
    }
    out
}

fn new_token(ts: u64) -> String {
    format!("{}:{ts}:{}:{}", std::process::id(), SEQ.fetch_add(1, Ordering::Relaxed) + 1, rand())
}

fn hostname() -> String {
    let mut buf = [0u8; 256];
    // SAFETY: the buffer is valid for its length and gethostname nul-terminates within it on success.
    let ok = unsafe { libc::gethostname(buf.as_mut_ptr().cast(), buf.len()) } == 0;
    if !ok {
        return String::new();
    }
    let n = buf.iter().position(|b| *b == 0).unwrap_or(buf.len());
    String::from_utf8_lossy(&buf[..n]).to_string()
}

/// The boot time of this machine in epoch seconds (`Math.floor(Date.now() / 1000 - os.uptime())`), if known.
fn boot_time() -> Option<i64> {
    let up = uptime_s()?;
    if !(up.is_finite() && up > 0.0) {
        return None;
    }
    Some((now_ms() as f64 / 1000.0 - up).floor() as i64)
}

#[cfg(target_os = "macos")]
fn uptime_s() -> Option<f64> {
    let name = std::ffi::CString::new(defaults::text("swarm_guard.sysctl_boottime")).ok()?;
    let mut tv = libc::timeval { tv_sec: 0, tv_usec: 0 };
    let mut len = std::mem::size_of::<libc::timeval>();
    // SAFETY: `tv` and `len` describe a writable timeval-sized buffer, the name is a valid C string.
    let rc = unsafe { libc::sysctlbyname(name.as_ptr(), (&raw mut tv).cast(), &mut len, std::ptr::null_mut(), 0) };
    if rc != 0 {
        return None;
    }
    let now_s = now_ms() / 1000;
    Some(now_s as f64 - tv.tv_sec as f64)
}

#[cfg(not(target_os = "macos"))]
fn uptime_s() -> Option<f64> {
    std::fs::read_to_string(defaults::text("swarm_guard.proc_uptime")).ok()?.split_whitespace().next()?.parse().ok()
}

fn pid_namespace() -> String {
    if cfg!(target_os = "linux") {
        std::fs::read_link(defaults::text("swarm_guard.proc_pidns")).map(|p| p.to_string_lossy().to_string()).unwrap_or_default()
    } else {
        String::new()
    }
}

/// The owner record, in the key order Node writes it.
fn owner_record(ts: u64, token: &str) -> String {
    let q = |s: &str| serde_json::to_string(s).unwrap_or_default();
    let mut out = format!("{{\"pid\":{},\"host\":{},\"ts\":{ts},\"token\":{}", std::process::id(), q(&hostname()), q(token));
    if let Some(b) = boot_time() {
        out.push_str(&format!(",\"boot\":{b}"));
    }
    let ns = pid_namespace();
    if !ns.is_empty() {
        out.push_str(&format!(",\"pidns\":{}", q(&ns)));
    }
    out.push('}');
    out
}

#[derive(Debug)]
struct Holder {
    token: Option<serde_json::Value>,
    ts_from_mtime: bool,
    ts: Option<f64>,
    pid: Option<i64>,
    age_ms: f64,
    dead: bool,
}

fn parse_record(raw: &str) -> Option<serde_json::Map<String, serde_json::Value>> {
    match serde_json::from_str::<serde_json::Value>(raw) {
        Ok(serde_json::Value::Object(o)) => Some(o),
        _ => None,
    }
}

fn pid_alive(pid: i64) -> bool {
    if pid <= 0 || pid > i64::from(i32::MAX) {
        return false;
    }
    // SAFETY: signal 0 only probes for the process.
    let rc = unsafe { libc::kill(pid as i32, 0) };
    rc == 0 || std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
}

/// `sameMachine(record)`: written on this boot of this machine, in this pid namespace.
fn same_machine(rec: &serde_json::Map<String, serde_json::Value>, p: &Params) -> bool {
    let Some(boot) = rec.get("boot").and_then(serde_json::Value::as_f64) else { return false };
    let Some(mine) = boot_time() else { return false };
    if (boot - mine as f64).abs() > p.boot_slop_s as f64 {
        return false;
    }
    rec.get("pidns").and_then(serde_json::Value::as_str).unwrap_or("") == pid_namespace()
}

/// `inspect(path)`: `None` when there is no lock file.
fn inspect(path: &str, p: &Params) -> Option<Holder> {
    let raw = match std::fs::read(path) {
        Ok(b) => Some(String::from_utf8_lossy(&b).to_string()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return None,
        Err(_) => None,
    };
    let rec = raw.as_deref().and_then(parse_record);
    let pid = rec.as_ref().and_then(|r| r.get("pid")).and_then(serde_json::Value::as_f64).filter(|n| n.is_finite() && *n > 0.0).map(|n| n as i64);
    let host = rec.as_ref().and_then(|r| r.get("host")).and_then(serde_json::Value::as_str).map(str::to_string);
    let token = rec.as_ref().and_then(|r| r.get("token")).cloned();
    let mut ts = rec.as_ref().and_then(|r| r.get("ts")).and_then(serde_json::Value::as_f64).filter(|n| n.is_finite());
    let mut ts_from_mtime = false;
    if ts.is_none() {
        ts = std::fs::metadata(path).ok().map(|m| m.mtime() as f64 * 1000.0 + (m.mtime_nsec() as f64 / 1e6));
        ts_from_mtime = ts.is_some();
    }
    let age_ms = ts.map_or(f64::INFINITY, |t| (now_ms() as f64 - t).max(0.0));
    let known = pid.is_some() && (host.is_none() || host.as_deref() == Some(hostname().as_str()) || rec.as_ref().is_some_and(|r| same_machine(r, p)));
    let dead = known && !pid_alive(pid.unwrap_or(0));
    Some(Holder { token, ts_from_mtime, ts, pid, age_ms, dead })
}

enum Published {
    Yes,
    Exists,
    Failed,
}

/// `publish(F, p, payload, 'link')`.
fn publish(path: &str, payload: &str) -> Published {
    let tmp = format!("{path}.tmp-{}-{}", std::process::id(), rand());
    if std::fs::write(&tmp, payload).is_err() {
        return Published::Failed;
    }
    let out = match std::fs::hard_link(&tmp, path) {
        Ok(()) => Published::Yes,
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => Published::Exists,
        Err(_) => match std::fs::OpenOptions::new().write(true).create_new(true).open(path) {
            Ok(mut f) => {
                crate::discard::logged("lock_payload_write", f.write_all(payload.as_bytes()));
                Published::Yes
            }
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => Published::Exists,
            Err(_) => Published::Failed,
        },
    };
    crate::discard::harmless(std::fs::remove_file(&tmp)); // keep: cleanup that raced; an absent file is the goal state
    out
}

#[derive(PartialEq, Eq)]
enum Reclaimed {
    Done,
    Gone,
    Caught,
    Failed,
}

/// `reclaim(F, p, h)`: rename aside, verify against the judged holder, discard.
fn reclaim(path: &str, h: &Holder) -> Reclaimed {
    let reap = format!("{path}.reap-{}-{}", std::process::id(), rand());
    if std::fs::rename(path, &reap).is_err() {
        return Reclaimed::Gone;
    }
    let moved_raw = std::fs::read(&reap).ok().map(|b| String::from_utf8_lossy(&b).to_string());
    let moved = moved_raw.as_deref().and_then(parse_record);
    let moved_token = moved.as_ref().and_then(|m| m.get("token")).cloned();
    let mut same = moved_token == h.token;
    if same && h.token.is_none() {
        let mt = std::fs::metadata(&reap).ok().map(|m| m.mtime() as f64 * 1000.0 + (m.mtime_nsec() as f64 / 1e6));
        same = match &moved {
            None => h.ts_from_mtime && mt.is_some() && mt == h.ts,
            Some(m) => m.get("pid").and_then(serde_json::Value::as_f64).map(|n| n as i64) == h.pid && m.get("ts").and_then(serde_json::Value::as_f64) == h.ts,
        };
    }
    if !same {
        if std::fs::hard_link(&reap, path).is_ok() {
            crate::discard::harmless(std::fs::remove_file(&reap)); // keep: cleanup that raced; an absent file is the goal state
        } else if std::fs::metadata(path).is_err() {
            crate::discard::harmless(std::fs::rename(&reap, path)); // keep: cleanup that raced; an absent file is the goal state
        } else {
            crate::discard::harmless(std::fs::remove_file(&reap)); // keep: cleanup that raced; an absent file is the goal state
        }
        return Reclaimed::Caught;
    }
    match std::fs::remove_file(&reap) {
        Ok(()) => Reclaimed::Done,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Reclaimed::Done,
        Err(_) => {
            if std::fs::metadata(path).is_err() {
                crate::discard::harmless(std::fs::rename(&reap, path)); // keep: cleanup that raced; an absent file is the goal state
            }
            Reclaimed::Failed
        }
    }
}

struct Sidecar {
    path: String,
    token: String,
}

/// `takeSidecar(F, p, 'link')`: `None` when another reclaimer is at work or the marker cannot be created.
fn take_sidecar(path: &str, p: &Params) -> Option<Sidecar> {
    let side = format!("{path}.reclaim");
    for _ in 0..2 {
        let ts = now_ms();
        let token = new_token(ts);
        match publish(&side, &owner_record(ts, &token)) {
            Published::Yes => return Some(Sidecar { path: side, token }),
            Published::Exists => {}
            Published::Failed => return None,
        }
        let Some(h) = inspect(&side, p) else { continue };
        if !(h.dead || h.age_ms > p.reclaim_stale_ms as f64) {
            return None;
        }
        if !matches!(reclaim(&side, &h), Reclaimed::Done | Reclaimed::Gone) {
            return None;
        }
    }
    None
}

/// `releaseUnguarded`: remove the file only while the on-disk token is ours.
fn release_unguarded(path: &str, token: &str) -> bool {
    let Some(cur) = std::fs::read(path).ok().and_then(|b| parse_record(&String::from_utf8_lossy(&b))) else { return false };
    if cur.get("token").and_then(serde_json::Value::as_str) == Some(token) {
        return std::fs::remove_file(path).is_ok();
    }
    false
}

/// `shouldSteal` for the policies in use: the live-holder limit equals `stale_ms` in both callers, so a dead holder
/// (with `steal_dead`) or any holder older than `stale_ms` is taken over.
fn stealable(h: &Holder, p: &Params) -> bool {
    (p.steal_dead && h.dead) || h.age_ms > p.stale_ms as f64
}

/// `acquire(path, ...)`: `None` when the lock could not be taken (the caller fails open).
pub fn acquire(path: &str, p: Params) -> Option<Held> {
    if let Some(i) = path.rfind('/')
        && i > 0
    {
        crate::discard::harmless(std::fs::create_dir_all(&path[..i])); // keep: the write that follows fails too when the directory is missing
    }
    let deadline = std::time::Instant::now() + Duration::from_millis(p.wait_ms);
    let mut retry_now = false;
    let mut first = true;
    loop {
        if !first && !retry_now && std::time::Instant::now() >= deadline {
            return None;
        }
        first = false;
        retry_now = false;
        let ts = now_ms();
        let token = new_token(ts);
        match publish(path, &owner_record(ts, &token)) {
            Published::Yes => return Some(Held { path: path.to_string(), token, p }),
            Published::Exists => {}
            Published::Failed => return None,
        }
        let Some(h) = inspect(path, &p) else { continue };
        if stealable(&h, &p) {
            // reclaimGuarded: only a holder of the takeover marker may rename or remove the lock, and it re-judges first.
            let r = match take_sidecar(path, &p) {
                None => None,
                Some(side) => {
                    let out = match inspect(path, &p) {
                        None => Reclaimed::Gone,
                        Some(fresh) if stealable(&fresh, &p) => reclaim(path, &fresh),
                        Some(_) => Reclaimed::Caught,
                    };
                    release_unguarded(&side.path, &side.token);
                    Some(out)
                }
            };
            match r {
                Some(Reclaimed::Caught | Reclaimed::Failed) => return None,
                Some(other) => {
                    retry_now = other == Reclaimed::Done;
                    continue;
                }
                None => {} // busy: wait like a respected holder
            }
        }
        if std::time::Instant::now() >= deadline {
            return None;
        }
        std::thread::sleep(Duration::from_millis(p.step_ms));
    }
}

impl Held {
    /// `release(handle)`: true when our lock was removed; a lock that is no longer ours is left alone.
    pub fn release(self) -> bool {
        if std::fs::metadata(&self.path).is_err() {
            return false;
        }
        let mut side = None;
        for i in 0..self.p.release_tries {
            if i > 0 {
                std::thread::sleep(Duration::from_millis(self.p.release_step_ms));
            }
            side = take_sidecar(&self.path, &self.p);
            if side.is_some() {
                break;
            }
        }
        match side {
            None => release_unguarded(&self.path, &self.token),
            Some(s) => {
                let r = release_unguarded(&self.path, &self.token);
                release_unguarded(&s.path, &s.token);
                r
            }
        }
    }
}
