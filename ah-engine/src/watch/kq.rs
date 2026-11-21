//! The events backend on macOS: `kqueue` through `libc`, so the binary links nothing beyond libSystem (the FSEvents API pulls
//! CoreServices and CoreFoundation into every invocation, about a millisecond of dyld work, and the `notify` crate's kqueue
//! backend does not report writes to the files of a non-recursively watched directory).
//!
//! A watched directory is one descriptor (it reports entries created, deleted or renamed in it, so every write that stages a
//! file and renames it into place) plus one descriptor for each of its NEWEST selected files, at most
//! `realtime.file_watches_per_dir` per directory and `realtime.max_file_watches` over the whole backend (a file descriptor
//! reports writes made in place, an appended transcript). Descriptor use therefore does not grow with the number of files a
//! directory holds (GH #912: one descriptor per file put about 1,900 descriptors on a DevSwarm state directory of heartbeats
//! and archived workspaces, and a daemon under launchd's default limit of 256 died with EMFILE).
//!
//! A directory event re-lists the directory and compares each selected file's signature (modification time, size, inode:
//! [`DirState`], the poll backend's comparison) with the last listing, so a created, replaced, removed or renamed file is
//! reported, and so is an in-place write to a file outside the newest set (late: at the directory's next event). The newest set
//! is chosen again on every directory event. Descriptors are opened `O_EVTONLY`: they do not keep a volume busy. A directory
//! with more selected files than `realtime.max_entries` is refused, so the caller polls it.
// Discard triage (E3): every `.ok()` / `unwrap_or_default()` in this file is a deliberate keep, for these reasons:
// - a file or directory that vanished between a kernel event and the follow-up open or listing is simply not watched (the next
//   directory event, or the caller's poll fallback, covers it)

use super::notify::{Signal, Sink};
use super::poll::{DirState, Filter};
use crate::defaults;
use std::collections::{HashMap, HashSet};
use std::ffi::OsString;
use std::os::fd::RawFd;
use std::os::unix::ffi::OsStrExt;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::thread::JoinHandle;

const FFLAGS: u32 = libc::NOTE_WRITE | libc::NOTE_EXTEND | libc::NOTE_DELETE | libc::NOTE_RENAME | libc::NOTE_ATTRIB | libc::NOTE_LINK | libc::NOTE_REVOKE;
const GONE: u32 = libc::NOTE_DELETE | libc::NOTE_RENAME | libc::NOTE_REVOKE;

/// Descriptors every running kqueue backend holds open for watches (directories and files), for the daemon's status.
static OPEN_FDS: AtomicUsize = AtomicUsize::new(0);

/// Per-file descriptors not opened because the backend's budget (`realtime.max_file_watches`) was used up: those files are only
/// seen through their directory's events (a create, delete or rename in it), so a growing count means in-place writes may be
/// reported late. For the daemon's status.
static SKIPPED: AtomicUsize = AtomicUsize::new(0);

/// The descriptors all kqueue backends of this process hold for watches.
pub fn open_fds() -> usize {
    OPEN_FDS.load(Ordering::Relaxed)
}

/// Per-file descriptor opens skipped for the budget since the process started.
pub fn skipped_fds() -> usize {
    SKIPPED.load(Ordering::Relaxed)
}

/// The bounds of one backend (from [`super::Config`]).
#[derive(Clone, Copy, Debug)]
pub struct Limits {
    /// Most selected files a watched directory may hold (`realtime.max_entries`).
    pub max_entries: usize,
    /// Most per-file descriptors one directory gets (its newest files).
    pub per_dir: usize,
    /// Most per-file descriptors over the whole backend.
    pub total: usize,
}

struct Dir {
    given: PathBuf,
    fd: RawFd,
    files: HashMap<OsString, RawFd>,
    /// The last listing with each selected file's signature.
    snap: DirState,
}

#[derive(Default)]
struct State {
    dirs: HashMap<PathBuf, Dir>,
    /// Which directory (by canonical path) and, for a file, which name a descriptor belongs to.
    by_fd: HashMap<RawFd, (PathBuf, Option<OsString>)>,
    /// Per-file descriptors held now (bounded by `Limits::total`).
    file_fds: usize,
}

fn lock(s: &Mutex<State>) -> MutexGuard<'_, State> {
    s.lock().unwrap_or_else(|e| e.into_inner())
}

fn open_evt(path: &Path) -> Option<RawFd> {
    let c = std::ffi::CString::new(path.as_os_str().as_bytes()).ok()?;
    // SAFETY: `c` is NUL-terminated; O_EVTONLY opens for event notification only.
    let fd = unsafe { libc::open(c.as_ptr(), libc::O_EVTONLY | libc::O_CLOEXEC) };
    if fd >= 0 {
        OPEN_FDS.fetch_add(1, Ordering::Relaxed);
    }
    (fd >= 0).then_some(fd)
}

/// Close a descriptor `open_evt` returned.
fn close_evt(fd: RawFd) {
    // SAFETY: `fd` was opened by `open_evt` and the caller closes it exactly once; closing also removes its kevent registration.
    unsafe { libc::close(fd) };
    OPEN_FDS.fetch_sub(1, Ordering::Relaxed);
}

fn kev(ident: RawFd, filter: i16, flags: u16, fflags: u32) -> libc::kevent {
    libc::kevent { ident: ident as libc::uintptr_t, filter, flags, fflags, data: 0, udata: std::ptr::null_mut() }
}

/// Register `fd` for vnode events on `kq`.
fn register(kq: RawFd, fd: RawFd) -> bool {
    let ch = kev(fd, libc::EVFILT_VNODE, libc::EV_ADD | libc::EV_CLEAR, FFLAGS);
    // SAFETY: one change record, no event list requested.
    unsafe { libc::kevent(kq, &ch, 1, std::ptr::null_mut(), 0, std::ptr::null()) >= 0 }
}

impl State {
    /// Close and forget a descriptor (a file's or a directory's).
    fn drop_fd(&mut self, fd: RawFd) {
        if let Some((key, name)) = self.by_fd.remove(&fd)
            && let (Some(d), Some(n)) = (self.dirs.get_mut(&key), name)
            && d.files.remove(&n).is_some()
        {
            self.file_fds = self.file_fds.saturating_sub(1);
        }
        close_evt(fd);
    }

    /// Re-list directory `key`, return the selected files whose signature changed since the last listing (new, replaced,
    /// written, removed) and move the per-file descriptors to its newest files. `None` when the selected files outnumber the
    /// cap (the caller reports a rescan).
    fn resync(&mut self, kq: RawFd, key: &Path, lim: Limits) -> Option<Vec<PathBuf>> {
        let d = self.dirs.get_mut(key)?;
        let scan = d.snap.scan(lim.max_entries);
        if scan.overflow || d.snap.truncated() {
            return None;
        }
        // the listing reads the canonical directory; the consumer knows the directory by the path it gave
        let changed = scan.changed.iter().filter_map(|p| p.file_name()).map(|n| d.given.join(n)).collect();
        self.rehome(kq, key, lim);
        Some(changed)
    }

    /// Hold per-file descriptors for the newest selected files of directory `key` (at most `lim.per_dir`, and only while the
    /// backend holds fewer than `lim.total`); close the ones on files that left that set or vanished.
    fn rehome(&mut self, kq: RawFd, key: &Path, lim: Limits) {
        let Some(d) = self.dirs.get(key) else { return };
        let want: HashSet<OsString> = d.snap.newest(lim.per_dir).into_iter().collect();
        let stale: Vec<RawFd> = d.files.iter().filter(|(n, _)| !want.contains(*n)).map(|(_, fd)| *fd).collect();
        for fd in stale {
            self.drop_fd(fd);
        }
        let Some(d) = self.dirs.get(key) else { return };
        let todo: Vec<(OsString, PathBuf)> = want.into_iter().filter(|n| !d.files.contains_key(n)).map(|n| (n.clone(), key.join(&n))).collect();
        for (n, canonical) in todo {
            if self.file_fds >= lim.total {
                // the directory descriptor still reports every rename, create and delete in it; counted so the loss shows
                SKIPPED.fetch_add(1, Ordering::Relaxed);
                continue;
            }
            let Some(fd) = open_evt(&canonical) else { continue };
            if !register(kq, fd) {
                close_evt(fd); // just opened here and not stored anywhere
                continue;
            }
            if let Some(d) = self.dirs.get_mut(key) {
                d.files.insert(n.clone(), fd);
                self.file_fds += 1;
                self.by_fd.insert(fd, (key.to_path_buf(), Some(n)));
            } else {
                close_evt(fd);
            }
        }
    }
}

/// A running events backend.
pub struct Events {
    kq: RawFd,
    wake_w: RawFd,
    lim: Limits,
    state: Arc<Mutex<State>>,
    thread: Option<JoinHandle<()>>,
}

fn run(kq: RawFd, wake_r: RawFd, state: &Mutex<State>, sink: &Sink, lim: Limits) {
    let mut out = [kev(0, 0, 0, 0); 32];
    loop {
        // SAFETY: no change list; `out` is 32 writable kevent records; no timeout (block).
        let n = unsafe { libc::kevent(kq, std::ptr::null(), 0, out.as_mut_ptr(), out.len() as libc::c_int, std::ptr::null()) };
        if n < 0 {
            if std::io::Error::last_os_error().kind() == std::io::ErrorKind::Interrupted {
                continue;
            }
            sink(Signal::Rescan);
            return;
        }
        let mut changed: Vec<PathBuf> = Vec::new();
        let mut rescan = false;
        {
            let mut st = lock(state);
            // directories to re-list, each once per batch however many of its events arrived (a replaced file fires both its own
            // descriptor and the directory's)
            let mut dirty: Vec<PathBuf> = Vec::new();
            for ev in &out[..n as usize] {
                let fd = ev.ident as RawFd;
                if fd == wake_r {
                    return;
                }
                let Some((key, name)) = st.by_fd.get(&fd).cloned() else { continue };
                match name {
                    Some(name) => {
                        if let Some(d) = st.dirs.get_mut(&key) {
                            changed.push(d.given.join(&name));
                            d.snap.touch(&name); // reported here: the next listing must not report it again
                        }
                        if ev.fflags & GONE != 0 {
                            st.drop_fd(fd);
                            // the name may already hold a new file (atomic save): look again
                            if !dirty.contains(&key) {
                                dirty.push(key);
                            }
                        }
                    }
                    None => {
                        if ev.fflags & GONE != 0 {
                            rescan = true; // the directory itself went away
                        }
                        if !dirty.contains(&key) {
                            dirty.push(key);
                        }
                    }
                }
            }
            for key in dirty {
                match st.resync(kq, &key, lim) {
                    Some(found) => changed.extend(found),
                    None => rescan = true,
                }
            }
        }
        if rescan {
            sink(Signal::Rescan);
        }
        if !changed.is_empty() {
            changed.sort();
            changed.dedup();
            sink(Signal::Changed(changed));
        }
    }
}

impl Events {
    /// Start the backend; `sink` receives the signals on the backend's own thread.
    pub fn new(sink: Sink, lim: Limits) -> Result<Events, String> {
        // SAFETY: plain system calls; every descriptor they return is checked and owned by the value built below.
        let kq = unsafe { libc::kqueue() };
        if kq < 0 {
            return Err(std::io::Error::last_os_error().to_string());
        }
        let mut p = [0 as RawFd; 2];
        // SAFETY: `p` holds the two descriptors pipe(2) writes.
        if unsafe { libc::pipe(p.as_mut_ptr()) } != 0 {
            let e = std::io::Error::last_os_error().to_string();
            // SAFETY: `kq` was opened above.
            unsafe { libc::close(kq) };
            return Err(e);
        }
        let (wake_r, wake_w) = (p[0], p[1]);
        let ch = kev(wake_r, libc::EVFILT_READ, libc::EV_ADD, 0);
        // SAFETY: one change record, no event list requested.
        let ok = unsafe { libc::kevent(kq, &ch, 1, std::ptr::null_mut(), 0, std::ptr::null()) >= 0 };
        if !ok {
            let e = std::io::Error::last_os_error().to_string();
            // SAFETY: all three were opened above and are not used again.
            unsafe {
                libc::close(kq);
                libc::close(wake_r);
                libc::close(wake_w);
            }
            return Err(e);
        }
        let state = Arc::new(Mutex::new(State::default()));
        let st = Arc::clone(&state);
        let thread = std::thread::Builder::new().name("ah-kqueue".into()).spawn(move || {
            run(kq, wake_r, &st, &sink, lim);
            // SAFETY: the read end belongs to this thread alone.
            unsafe { libc::close(wake_r) };
        });
        match thread {
            Ok(t) => Ok(Events { kq, wake_w, lim, state, thread: Some(t) }),
            Err(e) => {
                // SAFETY: nothing else holds these.
                unsafe {
                    libc::close(kq);
                    libc::close(wake_r);
                    libc::close(wake_w);
                }
                Err(e.to_string())
            }
        }
    }

    /// Watch `dir` (non-recursive) for the names `filter` selects. An error (the directory does not exist, too many selected
    /// files, no descriptors left) leaves the directory unwatched and the caller polls it.
    pub fn watch(&mut self, dir: &Path, filter: Filter) -> Result<(), String> {
        let canonical = std::fs::canonicalize(dir).map_err(|e| e.to_string())?;
        let cap = self.lim.max_entries;
        // the files present now are the baseline: only later changes are reported
        let snap = DirState::new(&canonical, filter, cap);
        if snap.truncated() {
            return Err(defaults::render("realtime.msg_too_many_files", &[("cap", &cap)]));
        }
        let fd = open_evt(&canonical).ok_or_else(|| std::io::Error::last_os_error().to_string())?;
        if !register(self.kq, fd) {
            let e = std::io::Error::last_os_error().to_string();
            close_evt(fd); // just opened here and not stored anywhere
            return Err(e);
        }
        let mut st = lock(&self.state);
        if st.dirs.contains_key(&canonical) {
            Self::forget(&mut st, &canonical); // watched again (under another name): one entry per directory
        }
        st.by_fd.insert(fd, (canonical.clone(), None));
        st.dirs.insert(canonical.clone(), Dir { given: dir.to_path_buf(), fd, files: HashMap::new(), snap });
        st.rehome(self.kq, &canonical, self.lim);
        Ok(())
    }

    /// The descriptors this backend holds for watches (one per directory plus the per-file ones).
    pub fn fds(&self) -> usize {
        let st = lock(&self.state);
        st.dirs.len() + st.file_fds
    }

    fn forget(st: &mut State, key: &Path) {
        if let Some(d) = st.dirs.remove(key) {
            let fds: Vec<RawFd> = d.files.values().copied().chain([d.fd]).collect();
            st.dirs.insert(key.to_path_buf(), d);
            for fd in fds {
                st.drop_fd(fd);
            }
            st.dirs.remove(key);
        }
    }

    /// Stop watching `dir`.
    pub fn unwatch(&mut self, dir: &Path) {
        let mut st = lock(&self.state);
        let key = st.dirs.iter().find(|(_, d)| d.given == dir).map(|(k, _)| k.clone());
        if let Some(k) = key {
            Self::forget(&mut st, &k);
        }
    }
}

impl Drop for Events {
    fn drop(&mut self) {
        // SAFETY: a one-byte write wakes the thread, which returns and closes its read end.
        unsafe { libc::write(self.wake_w, [1u8].as_ptr().cast(), 1) };
        if let Some(t) = self.thread.take() {
            crate::discard::logged("watch_kq_join", t.join().map_err(|_| "panic"));
        }
        let fds: Vec<RawFd> = lock(&self.state).by_fd.keys().copied().collect();
        for fd in fds {
            close_evt(fd); // each was opened by this module; the thread has ended so nothing else uses them
        }
        // SAFETY: both were opened in `new` and are closed once.
        unsafe {
            libc::close(self.kq);
            libc::close(self.wake_w);
        }
    }
}
