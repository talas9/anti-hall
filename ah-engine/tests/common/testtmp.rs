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

/// `temp_dir().join(name)`, removed when the test process exits. The dir is not created: the caller does that, as before.
pub fn path(name: impl AsRef<Path>) -> PathBuf {
    let p = std::env::temp_dir().join(name);
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
    if !paths.contains(&p) {
        paths.push(p.clone());
    }
    p
}
