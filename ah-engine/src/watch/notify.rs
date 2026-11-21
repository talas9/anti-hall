//! The events backend: OS file-change notifications. On Linux through the `notify` crate (inotify); on macOS through `kq`
//! (kqueue over `libc`: the crate's FSEvents backend links CoreServices and CoreFoundation, a cost on every invocation).
//!
//! Directories are watched non-recursively and every event is filtered by file name, so only the names a consumer asked for
//! reach the queue. An event is a hint: nothing here reads a file, and the consumer re-reads its source.
//!
//! * Read-only access events (inotify reports every read and close) are dropped, because a consumer reading its source
//!   would otherwise wake itself in a loop.
//! * An editor's atomic save (rename onto the name, or create) arrives as create/modify/rename events whose paths include the
//!   target, so the target name is reported; the temporary name is dropped by the name filter.
//! * The OS reports real paths (`/private/var/...` for `/var/...` on macOS), so a directory is also registered by its
//!   canonical path and reported back under the path the consumer used.
//! * A kernel queue overflow (`Flag::Rescan`) or a backend error becomes a rescan signal.

#[cfg(target_os = "macos")]
pub use super::kq::Events;

#[cfg(target_os = "macos")]
impl Events {
    /// Start the backend with the bounds of `cfg`; `sink` receives the signals on the backend's own thread.
    pub fn start(sink: Sink, cfg: &super::Config) -> Result<Events, String> {
        Events::new(sink, super::kq::Limits { max_entries: cfg.max_entries, per_dir: cfg.file_watches_per_dir, total: cfg.max_file_watches })
    }

    /// The descriptors this backend holds for watches.
    pub fn watch_fds(&self) -> usize {
        self.fds()
    }
}

/// Per-file descriptor opens the events backends skipped for their budget (`realtime.max_file_watches`; 0 off macOS).
pub fn skipped_fds() -> usize {
    #[cfg(target_os = "macos")]
    {
        super::kq::skipped_fds()
    }
    #[cfg(not(target_os = "macos"))]
    {
        0
    }
}

/// The descriptors the events backends of this process hold for watches (inotify needs none per watch: 0 there).
pub fn open_fds() -> usize {
    #[cfg(target_os = "macos")]
    {
        super::kq::open_fds()
    }
    #[cfg(not(target_os = "macos"))]
    {
        0
    }
}
use std::path::PathBuf;
use std::sync::Arc;

/// What the backend reports.
pub enum Signal {
    /// Files (under the paths the consumer registered) that changed.
    Changed(Vec<PathBuf>),
    /// Events were lost or the backend failed: reconcile everything.
    Rescan,
}

/// Where signals go.
pub type Sink = Arc<dyn Fn(Signal) + Send + Sync>;

#[cfg(not(target_os = "macos"))]
mod crate_backend {
    use super::{Signal, Sink};
    use crate::watch::poll::Filter;
    use notify::event::EventKind;
    use notify::{Event, RecommendedWatcher, RecursiveMode, Watcher};
    use std::path::{Path, PathBuf};
    use std::sync::{Arc, Mutex};

    struct Entry {
        canonical: PathBuf,
        given: PathBuf,
        filter: Filter,
    }

    /// A running events backend.
    pub struct Events {
        watcher: RecommendedWatcher,
        dirs: Arc<Mutex<Vec<Entry>>>,
    }

    fn translate(dirs: &Mutex<Vec<Entry>>, ev: &Event) -> Vec<PathBuf> {
        if matches!(ev.kind, EventKind::Access(_) | EventKind::Other) {
            return Vec::new();
        }
        let dirs = dirs.lock().unwrap_or_else(|e| e.into_inner());
        let mut out = Vec::new();
        for p in &ev.paths {
            let (Some(parent), Some(name)) = (p.parent(), p.file_name()) else { continue };
            if let Some(e) = dirs.iter().find(|e| e.canonical == parent || e.given == parent)
                && e.filter.matches(name)
            {
                out.push(e.given.join(name));
            }
        }
        out
    }

    impl Events {
        /// Start the backend; `sink` receives the signals on the backend's own thread. inotify holds one descriptor whatever
        /// the number of watches, so the per-file bounds of `_cfg` do not apply here.
        pub fn start(sink: Sink, _cfg: &crate::watch::Config) -> Result<Events, String> {
            let dirs: Arc<Mutex<Vec<Entry>>> = Arc::new(Mutex::new(Vec::new()));
            let seen = Arc::clone(&dirs);
            let watcher = notify::recommended_watcher(move |res: notify::Result<Event>| match res {
                Ok(ev) if ev.need_rescan() => sink(Signal::Rescan),
                Ok(ev) => {
                    let changed = translate(&seen, &ev);
                    if !changed.is_empty() {
                        sink(Signal::Changed(changed));
                    }
                }
                Err(_) => sink(Signal::Rescan),
            })
            .map_err(|e| e.to_string())?;
            Ok(Events { watcher, dirs })
        }

        /// Watch `dir` (non-recursive) for the names `filter` selects. An error (the directory does not exist, the kernel's
        /// watch limit is reached) leaves the directory unwatched and the caller polls it.
        pub fn watch(&mut self, dir: &Path, filter: Filter) -> Result<(), String> {
            let canonical = std::fs::canonicalize(dir).map_err(|e| e.to_string())?;
            self.watcher.watch(&canonical, RecursiveMode::NonRecursive).map_err(|e| e.to_string())?;
            self.dirs.lock().unwrap_or_else(|e| e.into_inner()).push(Entry { canonical, given: dir.to_path_buf(), filter });
            Ok(())
        }

        /// The descriptors this backend holds for watches (none per watch with inotify).
        pub fn watch_fds(&self) -> usize {
            0
        }

        /// Stop watching `dir`.
        pub fn unwatch(&mut self, dir: &Path) {
            let mut dirs = self.dirs.lock().unwrap_or_else(|e| e.into_inner());
            if let Some(i) = dirs.iter().position(|e| e.given == dir) {
                let e = dirs.remove(i);
                crate::discard::harmless(self.watcher.unwatch(&e.canonical)); // keep: a directory that is already gone has nothing to unwatch
            }
        }
    }
}

#[cfg(not(target_os = "macos"))]
pub use crate_backend::Events;
