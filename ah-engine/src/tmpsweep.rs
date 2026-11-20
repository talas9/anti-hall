//! Temp-directory hygiene (#tmp-leak). Two halves:
//!
//! - [`sweep`] / [`sweep_configured`]: remove entries of the temp directory whose name starts with one of the engine's OWN
//!   prefixes (`disk_watch.tmp_sweep_prefixes`) and whose last change is older than `disk_watch.tmp_sweep_max_age_s`. Nothing
//!   else is ever touched: a name that matches no prefix, a symlink and anything younger than the age stay. Age 0 turns it off.
//!   The daemon runs it once at start-up (`daemon::serve`).
//! - [`scratch`]: the one way a test makes a per-process scratch directory. It is registered and removed when the process
//!   exits (normally or after a failed test), so a run leaves nothing behind. Before this, each test helper created
//!   `<prefix>-<tag>-<pid>` and never removed it: one directory per test per run, thousands per hour.
//!
//! The prefixes and the age live in `disk_watch.toml`; nothing here decides a name or a number.
use crate::defaults;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, Once};
use std::time::{Duration, SystemTime};

/// Remove the entries of `dir` that start with one of `prefixes` and were last changed at least `max_age` before `now`.
/// Returns how many were removed. An empty prefix is ignored (it would match everything); a zero age removes nothing.
pub fn sweep(dir: &Path, prefixes: &[&str], max_age: Duration, now: SystemTime) -> usize {
    if max_age.is_zero() || prefixes.iter().all(|p| p.is_empty()) {
        return 0;
    }
    let Ok(rd) = std::fs::read_dir(dir) else { return 0 };
    let mut removed = 0;
    for ent in rd.flatten() {
        let name = ent.file_name();
        let Some(name) = name.to_str() else { continue };
        if !prefixes.iter().any(|p| !p.is_empty() && name.starts_with(p)) {
            continue;
        }
        let path = ent.path();
        let Ok(meta) = std::fs::symlink_metadata(&path) else { continue };
        if meta.file_type().is_symlink() {
            continue;
        }
        let old = meta.modified().ok().and_then(|m| now.duration_since(m).ok()).is_some_and(|age| age >= max_age);
        if !old {
            continue;
        }
        let gone = if meta.is_dir() { std::fs::remove_dir_all(&path) } else { std::fs::remove_file(&path) };
        if gone.is_ok() {
            removed += 1;
        }
    }
    removed
}

/// [`sweep`] over the temp directory with the configured prefixes and age.
pub fn sweep_configured() -> usize {
    let age = Duration::from_secs(defaults::num("disk_watch.tmp_sweep_max_age_s"));
    sweep(&std::env::temp_dir(), &defaults::list("disk_watch.tmp_sweep_prefixes"), age, SystemTime::now())
}

static LIVE: Mutex<Vec<PathBuf>> = Mutex::new(Vec::new());
static REGISTER: Once = Once::new();

extern "C" fn at_exit() {
    remove_registered();
}

/// Remove every directory [`scratch`] made in this process.
pub fn remove_registered() {
    let dirs = std::mem::take(&mut *LIVE.lock().unwrap_or_else(|e| e.into_inner()));
    for d in dirs {
        crate::discard::harmless(std::fs::remove_dir_all(&d)); // keep: cleanup that raced; an absent dir is the goal state
    }
}

/// A fresh scratch directory `<temp>/<prefix><tag>-<pid>` (any older one of that name is replaced), removed when this process
/// exits. A process killed before exit leaves it for [`sweep_configured`], which this runs once per process when the defaults are loaded.
pub fn scratch(prefix: &str, tag: &str) -> PathBuf {
    REGISTER.call_once(|| {
        if defaults::is_loaded() {
            sweep_configured();
        }
        // SAFETY: at_exit is a plain extern "C" fn with no arguments; registering it cannot fail in a way that matters here.
        unsafe { libc::atexit(at_exit) };
    });
    let d = std::env::temp_dir().join(format!("{prefix}{tag}-{}", std::process::id()));
    crate::discard::harmless(std::fs::remove_dir_all(&d)); // keep: cleanup that raced; an absent dir is the goal state
    std::fs::create_dir_all(&d).unwrap_or_else(|e| panic!("scratch dir {}: {e}", d.display()));
    LIVE.lock().unwrap_or_else(|e| e.into_inner()).push(d.clone());
    d
}
