//! The events backend on macOS: `kqueue` through `libc`, so the binary links nothing beyond libSystem (the FSEvents API pulls
//! CoreServices and CoreFoundation into every invocation, about a millisecond of dyld work, and the `notify` crate's kqueue
//! backend does not report writes to the files of a non-recursively watched directory).
//!
//! A watched directory is one descriptor (it reports entries created, deleted or renamed in it) plus one descriptor per file the
//! filter selects (it reports writes, truncation, deletion and rename). A directory event re-lists the directory and adopts the
//! selected files it did not know; a file that vanished is dropped and the directory is re-listed so a file recreated under the
//! same name (an editor's atomic save) is picked up again. Descriptors are opened `O_EVTONLY`: they do not keep a volume busy.
//! A directory with more selected files than `realtime.max_entries` is refused, so the caller polls it.
// Discard triage (E3): every `.ok()` / `unwrap_or_default()` in this file is a deliberate keep, for these reasons:
// - a file or directory that vanished between a kernel event and the follow-up open or listing is simply not watched (the next
//   directory event, or the caller's poll fallback, covers it)

use super::notify::{Signal, Sink};
use super::poll::Filter;
use crate::defaults;
use std::collections::HashMap;
use std::ffi::OsString;
use std::os::fd::RawFd;
use std::os::unix::ffi::OsStrExt;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard};
use std::thread::JoinHandle;

const FFLAGS: u32 = libc::NOTE_WRITE | libc::NOTE_EXTEND | libc::NOTE_DELETE | libc::NOTE_RENAME | libc::NOTE_ATTRIB | libc::NOTE_LINK | libc::NOTE_REVOKE;
const GONE: u32 = libc::NOTE_DELETE | libc::NOTE_RENAME | libc::NOTE_REVOKE;

struct Dir {
    given: PathBuf,
    canonical: PathBuf,
    filter: Filter,
    fd: RawFd,
    files: HashMap<OsString, RawFd>,
}

#[derive(Default)]
struct State {
    dirs: HashMap<PathBuf, Dir>,
    /// Which directory (by canonical path) and, for a file, which name a descriptor belongs to.
    by_fd: HashMap<RawFd, (PathBuf, Option<OsString>)>,
}

fn lock(s: &Mutex<State>) -> MutexGuard<'_, State> {
    s.lock().unwrap_or_else(|e| e.into_inner())
}

fn open_evt(path: &Path) -> Option<RawFd> {
    let c = std::ffi::CString::new(path.as_os_str().as_bytes()).ok()?;
    // SAFETY: `c` is NUL-terminated; O_EVTONLY opens for event notification only.
    let fd = unsafe { libc::open(c.as_ptr(), libc::O_EVTONLY | libc::O_CLOEXEC) };
    (fd >= 0).then_some(fd)
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

/// The selected names present in `dir`.
fn listing(dir: &Path, filter: &Filter) -> Vec<OsString> {
    let Ok(rd) = std::fs::read_dir(dir) else { return Vec::new() };
    rd.filter_map(|e| e.ok()).map(|e| e.file_name()).filter(|n| filter.matches(n)).collect()
}

impl State {
    /// Close and forget a file descriptor.
    fn drop_fd(&mut self, fd: RawFd) {
        if let Some((key, name)) = self.by_fd.remove(&fd)
            && let (Some(d), Some(n)) = (self.dirs.get_mut(&key), name)
        {
            d.files.remove(&n);
        }
        // SAFETY: `fd` was opened by this module and is closed exactly once (it was just removed from the maps); closing also
        // removes its kevent registration.
        unsafe { libc::close(fd) };
    }

    /// Re-list directory `key`, adopt the selected files not yet watched and return their paths (reported as changed).
    /// `None` when the selected files outnumber the cap (the caller reports a rescan).
    fn adopt(&mut self, kq: RawFd, key: &Path, cap: usize) -> Option<Vec<PathBuf>> {
        let d = self.dirs.get(key)?;
        let names = listing(&d.canonical, &d.filter);
        if names.len() > cap {
            return None;
        }
        let mut found = Vec::new();
        for n in names {
            let (given, canonical) = {
                let d = self.dirs.get(key)?;
                if d.files.contains_key(&n) {
                    continue;
                }
                (d.given.join(&n), d.canonical.join(&n))
            };
            let Some(fd) = open_evt(&canonical) else { continue };
            if !register(kq, fd) {
                // SAFETY: just opened here and not stored anywhere.
                unsafe { libc::close(fd) };
                continue;
            }
            if let Some(d) = self.dirs.get_mut(key) {
                d.files.insert(n.clone(), fd);
            }
            self.by_fd.insert(fd, (key.to_path_buf(), Some(n)));
            found.push(given);
        }
        Some(found)
    }
}

/// A running events backend.
pub struct Events {
    kq: RawFd,
    wake_w: RawFd,
    state: Arc<Mutex<State>>,
    thread: Option<JoinHandle<()>>,
}

fn run(kq: RawFd, wake_r: RawFd, state: &Mutex<State>, sink: &Sink) {
    let cap = defaults::num("realtime.max_entries") as usize;
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
            for ev in &out[..n as usize] {
                let fd = ev.ident as RawFd;
                if fd == wake_r {
                    return;
                }
                let Some((key, name)) = st.by_fd.get(&fd).cloned() else { continue };
                match name {
                    Some(name) => {
                        if let Some(d) = st.dirs.get(&key) {
                            changed.push(d.given.join(&name));
                        }
                        if ev.fflags & GONE != 0 {
                            st.drop_fd(fd);
                            // the name may already hold a new file (atomic save): look again
                            match st.adopt(kq, &key, cap) {
                                Some(found) => changed.extend(found),
                                None => rescan = true,
                            }
                        }
                    }
                    None => {
                        if ev.fflags & GONE != 0 {
                            rescan = true; // the directory itself went away
                        }
                        match st.adopt(kq, &key, cap) {
                            Some(found) => changed.extend(found),
                            None => rescan = true,
                        }
                    }
                }
            }
        }
        if rescan {
            sink(Signal::Rescan);
        }
        if !changed.is_empty() {
            sink(Signal::Changed(changed));
        }
    }
}

impl Events {
    /// Start the backend; `sink` receives the signals on the backend's own thread.
    pub fn new(sink: Sink) -> Result<Events, String> {
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
            run(kq, wake_r, &st, &sink);
            // SAFETY: the read end belongs to this thread alone.
            unsafe { libc::close(wake_r) };
        });
        match thread {
            Ok(t) => Ok(Events { kq, wake_w, state, thread: Some(t) }),
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
        let fd = open_evt(&canonical).ok_or_else(|| std::io::Error::last_os_error().to_string())?;
        if !register(self.kq, fd) {
            let e = std::io::Error::last_os_error().to_string();
            // SAFETY: just opened here and not stored anywhere.
            unsafe { libc::close(fd) };
            return Err(e);
        }
        let mut st = lock(&self.state);
        st.by_fd.insert(fd, (canonical.clone(), None));
        st.dirs.insert(canonical.clone(), Dir { given: dir.to_path_buf(), canonical: canonical.clone(), filter, fd, files: HashMap::new() });
        let cap = defaults::num("realtime.max_entries") as usize;
        // the files present now are watched but not reported: only later changes are
        if st.adopt(self.kq, &canonical, cap).is_none() {
            Self::forget(&mut st, &canonical);
            return Err(defaults::render("realtime.msg_too_many_files", &[("cap", &cap)]));
        }
        Ok(())
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
            crate::discard::harmless(t.join().map_err(|_| ())); // keep: a backend thread that panicked has nothing left to report
        }
        let fds: Vec<RawFd> = lock(&self.state).by_fd.keys().copied().collect();
        for fd in fds {
            // SAFETY: each was opened by this module; the thread has ended so nothing else uses them.
            unsafe { libc::close(fd) };
        }
        // SAFETY: both were opened in `new` and are closed once.
        unsafe {
            libc::close(self.kq);
            libc::close(self.wake_w);
        }
    }
}
