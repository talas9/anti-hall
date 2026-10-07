//! A lock file other processes can honour: the format of the Node plugin's lock primitive (`companion/lib/lock.js`) for the
//! part that matters between a Node hook and the engine.
//!
//! The lock is a JSON file `{pid, host, ts, token}` published through a private temporary file and a hard link (so it is never
//! visible half written; a file system without hard links gets an exclusive create). A Node process that finds this lock sees
//! a live holder and waits for it; this module does the same with a lock a Node process holds.
//!
//! Deliberate difference: the takeover of an old lock and the release do not use Node's reclaim sidecar. The sidecar only
//! matters when three processes judge the same abandoned lock at once; the lock here is held for a few milliseconds, far below
//! the age at which anyone takes it over.
use crate::defaults;
use std::io::Write;
use std::sync::atomic::{AtomicU64, Ordering};

/// A held lock.
pub struct Lock {
    path: String,
    token: String,
}

fn now_ms() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

fn hostname() -> String {
    let mut buf = [0u8; 256];
    // SAFETY: the buffer is valid for its length and gethostname NUL-terminates within it on success
    let rc = unsafe { libc::gethostname(buf.as_mut_ptr().cast(), buf.len()) };
    if rc != 0 {
        return String::new();
    }
    let end = buf.iter().position(|b| *b == 0).unwrap_or(buf.len());
    String::from_utf8_lossy(&buf[..end]).to_string()
}

fn new_token(ts: u64) -> String {
    static SEQ: AtomicU64 = AtomicU64::new(0);
    let n = SEQ.fetch_add(1, Ordering::Relaxed) + 1;
    format!("{}:{ts}:{n}:{:x}", std::process::id(), ts.wrapping_mul(2_654_435_761).wrapping_add(n))
}

/// Publish `body` at `path` without ever exposing a partial file; `Err` with `AlreadyExists` means it is held.
fn publish(path: &str, body: &str) -> std::io::Result<()> {
    static N: AtomicU64 = AtomicU64::new(0);
    let tmp = format!("{path}.tmp-{}-{}", std::process::id(), N.fetch_add(1, Ordering::Relaxed));
    std::fs::write(&tmp, body)?;
    let r = match std::fs::hard_link(&tmp, path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => Err(e),
        Err(_) => std::fs::OpenOptions::new().write(true).create_new(true).open(path).and_then(|mut f| f.write_all(body.as_bytes())),
    };
    let _ = std::fs::remove_file(&tmp);
    r
}

/// What a lock file says about its holder, as `inspect` judges it.
struct Holder {
    token: Option<String>,
    /// The record's `ts`, else the file's mtime (a torn or unparseable file is dated by its mtime); `None` when neither is known.
    ts: Option<f64>,
    ts_from_mtime: bool,
}

fn inspect(path: &str) -> Option<Holder> {
    let raw = std::fs::read_to_string(path);
    if raw.as_ref().is_err_and(|e| e.kind() == std::io::ErrorKind::NotFound) {
        return None;
    }
    let rec = raw.ok().and_then(|t| serde_json::from_str::<serde_json::Value>(&t).ok()).filter(serde_json::Value::is_object);
    let token = rec.as_ref().and_then(|r| r.get("token")).filter(|t| !t.is_null()).map(|t| t.as_str().map_or_else(|| t.to_string(), str::to_string));
    let mut ts = rec.as_ref().and_then(|r| r.get("ts")).and_then(serde_json::Value::as_f64);
    let mut ts_from_mtime = false;
    if ts.is_none() {
        ts = std::fs::metadata(path).and_then(|m| m.modified()).ok().map(|t| t.duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as f64).unwrap_or(0.0));
        ts_from_mtime = ts.is_some();
    }
    Some(Holder { token, ts, ts_from_mtime })
}

/// True when the holder is old enough to take the lock over. Both stale limits of the callers are the same
/// (`guardkit.lock_stale_ms`), so the holder's class (live, dead, unknown) does not matter.
fn stealable(h: &Holder) -> bool {
    let age = h.ts.map_or(f64::INFINITY, |t| (now_ms() as f64 - t).max(0.0));
    age > defaults::num("guardkit.lock_stale_ms") as f64
}

/// Move the judged holder's file aside and drop it when it is still the one judged; a fresh lock that was caught is put back.
fn reclaim(path: &str, h: &Holder) -> bool {
    static N: AtomicU64 = AtomicU64::new(0);
    let reap = format!("{path}.reap-{}-{}", std::process::id(), N.fetch_add(1, Ordering::Relaxed));
    if std::fs::rename(path, &reap).is_err() {
        return true; // gone already: try the create again
    }
    let moved = std::fs::read_to_string(&reap).ok().and_then(|t| serde_json::from_str::<serde_json::Value>(&t).ok()).filter(serde_json::Value::is_object);
    let moved_token = moved.as_ref().and_then(|r| r.get("token")).filter(|t| !t.is_null()).map(|t| t.as_str().map_or_else(|| t.to_string(), str::to_string));
    let same = match (&h.token, &moved_token) {
        (Some(a), Some(b)) => a == b,
        (None, None) => {
            // no token to compare: the moved file must still be the same old, tokenless file
            let mt = std::fs::metadata(&reap).and_then(|m| m.modified()).ok().map(|t| t.duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as f64).unwrap_or(0.0));
            moved.is_none() && h.ts_from_mtime && mt == h.ts
        }
        _ => false,
    };
    if same {
        let _ = std::fs::remove_file(&reap);
        return true;
    }
    // a fresh lock was caught: put it back without overwriting one published meanwhile, and respect it
    let restored = std::fs::hard_link(&reap, path).is_ok();
    if !restored && !std::path::Path::new(path).exists() {
        let _ = std::fs::rename(&reap, path);
    } else {
        let _ = std::fs::remove_file(&reap);
    }
    false
}

/// Take the lock at `path`, waiting up to `wait_ms` for a holder to let go; a holder older than the stale limit is taken over
/// (moved aside and verified, as `lock.js` does, without its reclaim sidecar). `None` when it stays held or cannot be created.
pub fn acquire(path: &str, wait_ms: u64) -> Option<Lock> {
    if let Some(dir) = std::path::Path::new(path).parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    let deadline = std::time::Instant::now() + std::time::Duration::from_millis(wait_ms);
    loop {
        let ts = now_ms();
        let token = new_token(ts);
        let body = serde_json::json!({"pid": std::process::id(), "host": hostname(), "ts": ts, "token": token}).to_string();
        match publish(path, &body) {
            Ok(()) => return Some(Lock { path: path.to_string(), token }),
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {}
            Err(_) => return None,
        }
        let Some(h) = inspect(path) else { continue }; // released between the create and the read: try again at once
        if stealable(&h) {
            if reclaim(path, &h) {
                continue;
            }
            return None;
        }
        if std::time::Instant::now() >= deadline {
            return None;
        }
        std::thread::sleep(defaults::millis("guardkit.lock_step_ms"));
    }
}

/// Let the lock go, when the file on disk still carries our token.
pub fn release(lock: Lock) {
    let ours = std::fs::read_to_string(&lock.path)
        .ok()
        .and_then(|t| serde_json::from_str::<serde_json::Value>(&t).ok())
        .is_some_and(|v| v.get("token").and_then(serde_json::Value::as_str) == Some(lock.token.as_str()));
    if ours {
        let _ = std::fs::remove_file(&lock.path);
    }
}
