//! Scratch paths under the temp dir that are removed when the test process exits (#757).
//!
//! Why this exists: a test that names its scratch dir `ah-<tag>-<pid>` and never removes it leaves the dir behind on every run
//! (each run has a new pid, so the next run's start-up cleanup never finds the old one): tens of GB piled up in the temp dir.
//! `path(name)` is `temp_dir().join(name)` that also registers the path, and the process removes every registered path when
//! it exits, whether its tests passed or failed. Under nextest each test is its own process; under `cargo test` the sweep
//! runs once at the end. Every test scratch dir goes through `path` (the guard test in tests/it/temp_leaks.rs fails on a bare
//! `temp_dir().join(`). `AH_PARITY_KEEP=1` keeps the dirs for a post-mortem.
//!
//! Compiled into the lib's unit tests (`src/lib.rs`) and into every test crate that needs it, from this one file.
#![allow(dead_code)] // each test binary uses a subset

use std::path::{Path, PathBuf};
use std::sync::{Mutex, Once};

static PATHS: Mutex<Vec<PathBuf>> = Mutex::new(Vec::new());
static HOOK: Once = Once::new();

extern "C" fn sweep() {
    if std::env::var_os("AH_PARITY_KEEP").is_some() {
        return;
    }
    let paths = match PATHS.lock() {
        Ok(g) => g,
        Err(poisoned) => poisoned.into_inner(),
    };
    for p in paths.iter() {
        if std::fs::remove_dir_all(p).is_err() {
            // gone already, or a plain file: nothing is left to sweep for this entry
            std::fs::remove_file(p).ok();
        }
    }
}

/// Registers exactly `p` for the exit sweep. Only a path that is unique to this process may be registered: a shared parent
/// (`ah-test-<area>`) deleted by one exiting process would delete the fixtures of another live test process (#757).
fn register(p: &Path) {
    HOOK.call_once(|| {
        // SAFETY: `sweep` is an `extern "C" fn()` with no captured state, which is what atexit needs.
        unsafe {
            libc::atexit(sweep);
        }
    });
    let mut paths = match PATHS.lock() {
        Ok(g) => g,
        Err(poisoned) => poisoned.into_inner(),
    };
    if !paths.iter().any(|q| q == p) {
        paths.push(p.to_path_buf());
    }
}

/// `temp_dir().join(name)`, removed when the test process exits. The dir is not created: the caller does that, as before.
/// `name` must be unique to this process (carry the pid): the whole path is swept, so never pass a name another process shares.
pub fn path(name: impl AsRef<Path>) -> PathBuf {
    let p = std::env::temp_dir().join(name);
    register(&p);
    p
}

/// `temp_dir()/<shared_parent>/<leaf>` with only the leaf registered: the shared parent stays for every other process, so
/// `leaf` carries the pid. The parent is never registered, so it is never swept (an empty parent is left behind).
pub fn child(shared_parent: impl AsRef<Path>, leaf: impl AsRef<Path>) -> PathBuf {
    let p = std::env::temp_dir().join(shared_parent).join(leaf);
    register(&p);
    p
}

/// The paths registered so far (for the registry's own test).
pub fn registered() -> Vec<PathBuf> {
    match PATHS.lock() {
        Ok(g) => g.clone(),
        Err(poisoned) => poisoned.into_inner().clone(),
    }
}
