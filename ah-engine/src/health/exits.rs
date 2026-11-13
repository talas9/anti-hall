//! Bounded daemon-exit provenance: one row per daemon exit (kind, detail, uptime, footprint), kept in a small file that survives
//! log rotation. Limits, field names, the kind allowlist and texts live in the plugin defaults (`health.exit_*`).
use crate::{defaults, health, paths};
use serde_json::{Map, Value};
use std::io::Read;
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Instant;

static START: std::sync::OnceLock<Instant> = std::sync::OnceLock::new();
static RECORDED: AtomicBool = AtomicBool::new(false);
/// The first drain's (kind, detail): later drains of the same process do not replace the cause.
static NOTED: Mutex<Option<(String, String)>> = Mutex::new(None);

fn field(name: &str) -> &'static str {
    defaults::raw("health.exit_fields").str_field(name)
}

fn file(dir: &std::path::Path) -> std::path::PathBuf {
    dir.join(defaults::text("health.exit_ring_file"))
}

/// Mark the moment this daemon started; uptime at exit is measured from here.
pub fn mark_start() {
    START.get_or_init(Instant::now);
}

/// A kind outside the configured allowlist is stored as `health.exit_kind_other`, so the kind cardinality stays bounded.
pub fn kind(name: &str) -> &'static str {
    let allowed = defaults::list("health.exit_kinds");
    allowed.iter().find(|k| **k == name).copied().unwrap_or_else(|| defaults::text("health.exit_kind_other"))
}

/// Remember why the drain began (first call wins); the exit that follows records it.
pub fn note(kind_name: &str, detail: &str) {
    let mut n = NOTED.lock().unwrap_or_else(|e| e.into_inner());
    if n.is_none() {
        *n = Some((kind(kind_name).to_string(), detail.to_string()));
    }
}

/// Record the exit once per process: the noted drain cause, or `clean` when the loop ended without one.
pub fn record_exit() {
    if RECORDED.swap(true, Ordering::SeqCst) {
        return;
    }
    let noted = NOTED.lock().unwrap_or_else(|e| e.into_inner()).take();
    let (k, d) = noted.unwrap_or_else(|| (kind("clean").to_string(), defaults::text("health.exit_detail_clean").to_string()));
    append_in(&paths::dir(), &k, &d, START.get().map_or(0, |s| s.elapsed().as_secs()), crate::limits::rss_kb(), std::process::id());
}

/// At the next start: the previous daemon left without recording an exit (SIGKILL, out of memory, a crash). Uptime and pid are unknown.
pub fn record_unclean() {
    append_in(&paths::dir(), "unclean", defaults::text("health.exit_detail_unclean"), 0, 0, 0);
}

fn rows(dir: &std::path::Path) -> Vec<Value> {
    let cap = defaults::num("health.exit_ring_bytes");
    let Ok(f) = std::fs::File::open(file(dir)) else { return Vec::new() };
    let mut bytes = Vec::new();
    if f.take(cap.saturating_add(1)).read_to_end(&mut bytes).is_err() || bytes.len() as u64 > cap {
        return Vec::new();
    }
    serde_json::from_slice::<Vec<Value>>(&bytes).unwrap_or_default()
}

/// Take the ring's exclusive flock, bounded by `health.exit_lock_wait_ms`. On a timeout or an unopenable lock file the caller skips its
/// record (fail open: an exit must never hang behind a stuck holder) and the cause is logged under `health.exit_ring_lock_kind`.
fn lock_ring(dir: &std::path::Path) -> Option<std::fs::File> {
    use std::os::fd::AsRawFd;
    use std::os::unix::fs::OpenOptionsExt;
    let kind = defaults::text("health.exit_ring_lock_kind");
    let f = match std::fs::OpenOptions::new().read(true).write(true).create(true).truncate(false).mode(0o600).open(paths::lock_for(&file(dir))) {
        Ok(f) => f,
        Err(e) => {
            crate::discard::note(kind, &e.to_string());
            return None;
        }
    };
    let until = Instant::now() + defaults::millis("health.exit_lock_wait_ms");
    loop {
        // SAFETY: `f` is an open file owned by this scope, so its descriptor is valid; `flock` takes only the descriptor and a flag.
        if unsafe { libc::flock(f.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } == 0 {
            return Some(f);
        }
        let e = std::io::Error::last_os_error();
        if e.kind() != std::io::ErrorKind::WouldBlock || Instant::now() >= until {
            crate::discard::note(kind, &e.to_string());
            return None;
        }
        std::thread::sleep(defaults::millis("health.exit_lock_poll_ms"));
    }
}

/// Append one row and trim the ring to its row and byte bounds (oldest rows first).
pub fn append_in(dir: &std::path::Path, kind_name: &str, detail: &str, uptime_s: u64, rss_kb: u64, pid: u32) {
    // The read-modify-write below is one critical section: concurrent starts (several clients, a supervisor start) would otherwise
    // each read the same ring and the last rename would drop the others' rows. The lock is a sibling file, held until this returns.
    let Some(_guard) = lock_ring(dir) else { return };
    let mut ring = rows(dir);
    let max = defaults::num("health.exit_detail_max") as usize;
    let detail: String = detail.chars().take(max).collect();
    let mut row = Map::new();
    row.insert(field("timestamp").into(), Value::from(health::now_ms()));
    row.insert(field("pid").into(), Value::from(pid));
    row.insert(field("uptime").into(), Value::from(uptime_s));
    row.insert(field("rss").into(), Value::from(rss_kb));
    row.insert(field("kind").into(), Value::from(kind(kind_name)));
    row.insert(field("detail").into(), Value::from(detail));
    ring.push(Value::Object(row));
    let keep = defaults::num("health.exit_ring_rows") as usize;
    if ring.len() > keep {
        ring.drain(..ring.len() - keep);
    }
    let cap = defaults::num("health.exit_ring_bytes") as usize;
    let mut bytes = serde_json::to_vec(&ring).unwrap_or_default();
    while bytes.len() > cap && !ring.is_empty() {
        ring.remove(0);
        bytes = serde_json::to_vec(&ring).unwrap_or_default();
    }
    crate::discard::logged(defaults::text("health.exit_ring_write_kind"), crate::atomic::write(file(dir), bytes));
}

/// Counts per kind over the retained ring, the last N rows (`health.exit_status_rows`), oldest first.
pub fn add_summary(summary: &mut Value) {
    add_summary_in(&paths::dir(), summary);
}

fn add_summary_in(dir: &std::path::Path, summary: &mut Value) {
    let ring = rows(dir);
    let mut counts = Map::new();
    for row in &ring {
        if let Some(k) = row.get(field("kind")).and_then(Value::as_str) {
            let n = counts.get(k).and_then(Value::as_u64).unwrap_or(0);
            counts.insert(k.into(), Value::from(n.saturating_add(1)));
        }
    }
    let n = defaults::num("health.exit_status_rows") as usize;
    let last: Vec<Value> = ring.iter().skip(ring.len().saturating_sub(n)).cloned().collect();
    summary[field("counts")] = Value::Object(counts);
    summary[field("last")] = Value::Array(last);
}

#[cfg(test)]
pub(crate) fn reset_for_test() {
    RECORDED.store(false, Ordering::SeqCst);
    *NOTED.lock().unwrap_or_else(|e| e.into_inner()) = None;
}

#[cfg(test)]
mod tests;
