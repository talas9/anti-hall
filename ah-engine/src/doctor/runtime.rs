//! The daemon and the state directory: is a daemon up, hung, stale, crash-looping or duplicated, and can the engine keep state
//! (does the directory exist, is it a directory, writable, owned by the user, on a disk with room, on a sane filesystem,
//! holding real databases). Nothing here writes: writability comes from `access(2)` and `statvfs(3)`, a full disk from the free
//! block and inode counts, so a plain `doctor` stays read-only.
use super::{Doc, Fix, facts};
use crate::checks::guardkit::text::js_trim;
use crate::defaults;
use crate::health;
use crate::paths;
use std::os::unix::fs::{FileTypeExt, MetadataExt, PermissionsExt};
use std::path::{Path, PathBuf};

/// Why the state directory cannot be used, from an OS error.
#[derive(Debug, PartialEq, Eq)]
pub enum IoClass {
    /// A path component is a file (ENOTDIR).
    NotADirectory,
    /// No space on the device (ENOSPC, EDQUOT).
    DiskFull,
    /// Read-only file system or permission denied (EROFS, EACCES, EPERM).
    NotWritable,
    /// Anything else.
    Other,
}

/// Classify an I/O error the way the doctor words it.
pub fn classify_io(e: &std::io::Error) -> IoClass {
    match e.raw_os_error() {
        Some(c) if c == libc::ENOTDIR => IoClass::NotADirectory,
        Some(c) if c == libc::ENOSPC || c == libc::EDQUOT => IoClass::DiskFull,
        Some(c) if c == libc::EROFS || c == libc::EACCES || c == libc::EPERM => IoClass::NotWritable,
        _ => IoClass::Other,
    }
}

fn writable(p: &Path) -> bool {
    use std::os::unix::ffi::OsStrExt;
    std::ffi::CString::new(p.as_os_str().as_bytes())
        // SAFETY: the path is NUL-terminated; `access` only reads it.
        .is_ok_and(|c| unsafe { libc::access(c.as_ptr(), libc::W_OK) } == 0)
}

/// The nearest existing ancestor of `p` that is not a directory (the file sitting where a directory should be).
fn file_in_the_way(p: &Path) -> Option<PathBuf> {
    p.ancestors().find(|a| std::fs::metadata(a).is_ok_and(|m| !m.is_dir())).map(Path::to_path_buf)
}

/// True when `release` (the kernel's version text) is a WSL kernel.
pub fn is_wsl(release: &str) -> bool {
    let lower = release.to_lowercase();
    defaults::list("doctor.wsl_markers").iter().any(|m| lower.contains(m))
}

/// True when `dir` is on a Windows drive mounted into WSL (`/mnt/c/...`).
pub fn on_windows_mount(dir: &Path) -> Option<String> {
    let re = crate::checks::lit_re(defaults::text("doctor.wsl_mount_re"));
    re.find(&dir.to_string_lossy()).map(|m| m.as_str().trim_end_matches('/').to_string())
}

fn mb(bytes: u64) -> u64 {
    bytes / defaults::num("doctor.mb")
}

/// ST-01..09.
pub fn state_section(doc: &mut Doc, fixes: &mut Vec<Fix>, uid: u32) {
    doc.head(defaults::text("doctor_msg.head_state"));
    let dir = paths::dir();
    let shown = dir.display().to_string();
    match std::fs::metadata(&dir) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            if let Some(f) = file_in_the_way(&dir) {
                doc.bad(defaults::render("doctor_msg.state_not_dir", &[("path", &f.display()), ("err", &defaults::text("doctor_msg.enotdir"))]));
                return;
            }
            let parent = dir.ancestors().skip(1).find(|a| a.is_dir());
            match parent {
                Some(p) if writable(p) => {
                    doc.infol(defaults::render("doctor_msg.state_missing", &[("dir", &shown)]));
                    fixes.push(Fix::Mkdir(dir));
                }
                Some(p) => doc.bad(defaults::render("doctor_msg.state_uncreatable", &[("dir", &shown), ("err", &defaults::render("doctor_msg.no_write_in", &[("parent", &p.display())]))])),
                None => doc.bad(defaults::render("doctor_msg.state_uncreatable", &[("dir", &shown), ("err", &defaults::text("doctor_msg.no_parent"))])),
            }
            return;
        }
        Err(e) if classify_io(&e) == IoClass::NotADirectory => {
            let f = file_in_the_way(&dir).unwrap_or_else(|| dir.clone());
            doc.bad(defaults::render("doctor_msg.state_not_dir", &[("path", &f.display()), ("err", &e)]));
            return;
        }
        Err(e) => {
            doc.bad(defaults::render("doctor_msg.state_unwritable", &[("dir", &shown), ("err", &e)]));
            return;
        }
        Ok(m) if !m.is_dir() => {
            doc.bad(defaults::render("doctor_msg.state_not_dir", &[("path", &shown), ("err", &defaults::text("doctor_msg.enotdir"))]));
            return;
        }
        Ok(m) => {
            if m.uid() != uid {
                doc.bad(defaults::render("doctor_msg.state_owner", &[("dir", &shown), ("owner", &m.uid()), ("uid", &uid)]));
                return;
            }
            let mode = m.permissions().mode() & defaults::num("doctor.mode_mask") as u32;
            if mode & defaults::num("doctor.others_mask") as u32 != 0 {
                doc.warnl(defaults::render("doctor_msg.state_open", &[("dir", &shown), ("mode", &format!("{mode:o}"))]));
                fixes.push(Fix::Private(dir.clone()));
            }
        }
    }
    let mut ok = true;
    if !writable(&dir) {
        ok = false;
        doc.bad(defaults::render("doctor_msg.state_unwritable", &[("dir", &shown), ("err", &defaults::text("doctor_msg.no_write"))]));
    }
    ok &= space(doc, &dir);
    if let Some(mount) = std::fs::read_to_string(defaults::text("doctor.proc_version")).ok().filter(|r| is_wsl(r)).and_then(|_| on_windows_mount(&dir)) {
        ok = false;
        doc.warnl(defaults::render("doctor_msg.state_windows_mount", &[("dir", &shown), ("mount", &mount)]));
    }
    let sock = paths::socket();
    if let Some(private) = sock.parent().filter(|p| *p != dir.as_path())
        && let Ok(m) = std::fs::metadata(private)
        && m.uid() != uid
    {
        ok = false;
        doc.bad(defaults::render("doctor_msg.private_dir_owner", &[("dir", &private.display()), ("owner", &m.uid())]));
    }
    for name in defaults::list("doctor.db_files") {
        let p = dir.join(name);
        let Ok(mut f) = std::fs::File::open(&p) else { continue };
        let size = f.metadata().map(|m| m.len()).unwrap_or(0);
        let magic = defaults::text("doctor.sqlite_magic");
        let mut head = vec![0u8; magic.len()];
        let read = std::io::Read::read(&mut f, &mut head).unwrap_or(0);
        if size > 0 && head[..read] != *magic.as_bytes() {
            ok = false;
            doc.bad(defaults::render("doctor_msg.db_bad", &[("file", &p.display())]));
        }
    }
    if ok {
        doc.ok(defaults::render("doctor_msg.state_ok", &[("dir", &shown)]));
    }
}

/// ST-04 and ST-04b from the free space and inode counts of the volume holding `dir`.
fn space(doc: &mut Doc, dir: &Path) -> bool {
    use std::os::unix::ffi::OsStrExt;
    let Some(free) = facts::free_bytes(dir) else { return true };
    let inodes_gone = std::ffi::CString::new(dir.as_os_str().as_bytes()).ok().is_some_and(|c| {
        // SAFETY: `statvfs` is plain data, all zeroes is valid; the call fills it and reads only the NUL-terminated path.
        let mut s: libc::statvfs = unsafe { std::mem::zeroed() };
        // SAFETY: `c` is NUL-terminated and `s` is writable.
        unsafe { libc::statvfs(c.as_ptr(), &mut s) == 0 && s.f_files > 0 && s.f_favail == 0 }
    });
    let min = defaults::num("doctor.min_free_mb");
    if free == 0 || inodes_gone {
        doc.bad(defaults::render("doctor_msg.state_disk_full", &[("dir", &dir.display()), ("free_mb", &mb(free))]));
        false
    } else if mb(free) < min {
        doc.warnl(defaults::render("doctor_msg.state_low_space", &[("dir", &dir.display()), ("free_mb", &mb(free)), ("min_mb", &min)]));
        false
    } else {
        true
    }
}

/// The pid a lock or marker file names, if any.
fn file_pid(p: &Path) -> Option<u32> {
    std::fs::read_to_string(p).ok()?.trim().parse().ok().filter(|p| *p != 0)
}

/// True when another process holds the daemon's lock (a shared `flock` attempt fails).
fn lock_held(lock: &Path) -> bool {
    use std::os::unix::io::AsRawFd;
    let Ok(f) = std::fs::File::open(lock) else { return false };
    // SAFETY: `f` is an open file owned by this scope; `flock` takes the descriptor and a flag only.
    let rc = unsafe { libc::flock(f.as_raw_fd(), libc::LOCK_SH | libc::LOCK_NB) };
    rc != 0 && std::io::Error::last_os_error().raw_os_error() == Some(libc::EWOULDBLOCK)
}

/// A stale pid file: the process is gone (info) or is another program now (warn, and nothing is ever signalled).
fn stale_pid(doc: &mut Doc, file: &Path) {
    let Some(pid) = file_pid(file) else { return };
    if !health::pid_alive(pid) {
        doc.infol(defaults::render("doctor_msg.pid_gone", &[("file", &file.display()), ("pid", &pid)]));
    } else if !health::pid_is_engine(pid) {
        let cmd: String = health::process_command(pid).trim().chars().take(defaults::num("doctor.why_max") as usize).collect();
        doc.warnl(defaults::render("doctor_msg.pid_reused", &[("file", &file.display()), ("pid", &pid), ("cmd", &cmd)]));
    }
}

/// The pids of daemons this state directory's own event log says started (`start` events: "v<version> pid <n> ...").
pub fn logged_daemon_pids() -> Vec<u32> {
    let re = crate::checks::lit_re(defaults::text("doctor.start_pid_re"));
    let kind = defaults::text("doctor.start_event");
    let mut pids: Vec<u32> = Vec::new();
    for e in health::events().iter().rev().filter(|e| e.kind == kind).take(defaults::num("doctor.max_daemon_probes") as usize) {
        if let Some(p) = re.captures(&e.detail).and_then(|c| c.get(1)).and_then(|m| m.as_str().parse().ok())
            && !pids.contains(&p)
        {
            pids.push(p);
        }
    }
    pids
}

/// The daemons among `logged` (pids that started in this state directory) that are still running as engines but are not the
/// legitimate one (the process that answers or holds the lock). Only this directory's own log counts, so a daemon of another
/// state directory (a test run, a second setup) is never mistaken for a duplicate.
pub fn extra_daemons(logged: &[u32], running: impl Fn(u32) -> bool, legit: Option<u32>) -> Vec<u32> {
    logged.iter().copied().filter(|p| Some(*p) != legit && running(*p)).collect()
}

/// DMN-01..12: the daemon, the pid files, the cooldowns, the recorded failure.
pub fn daemon_section(doc: &mut Doc) {
    doc.head(defaults::text("doctor_msg.head_engine"));
    doc.ok(defaults::render("doctor_msg.engine_version", &[("version", &crate::version())]));
    let sock = paths::socket();
    let lock = paths::lock_for(&sock);
    let sock_kind = std::fs::symlink_metadata(&sock).ok();
    let held = lock_held(&lock);
    let holder = file_pid(&lock);
    let reply = crate::client::ctl("ping");
    match (&reply, &sock_kind) {
        (Some(r), _) => {
            doc.ok(defaults::render("doctor_msg.daemon_up", &[("reply", &js_trim(r))]));
            let their = r.split_whitespace().nth(1).unwrap_or("");
            if !their.is_empty() && their != crate::version() {
                doc.infol(defaults::render("doctor_msg.daemon_other_version", &[("daemon", &their), ("engine", &crate::version())]));
            }
        }
        (None, Some(m)) if !m.file_type().is_socket() => {
            doc.bad(defaults::render("doctor_msg.sock_not_socket", &[("sock", &sock.display()), ("kind", &defaults::text(if m.is_dir() { "doctor_msg.kind_dir" } else { "doctor_msg.kind_file" }))]));
        }
        (None, _) if held => {
            let pid = holder.map_or_else(|| defaults::text("doctor_msg.unknown_pid").to_string(), |p| p.to_string());
            doc.bad(defaults::render("doctor_msg.daemon_hung", &[("lock", &lock.display()), ("pid", &pid), ("sock", &sock.display())]));
        }
        (None, Some(_)) => {
            doc.warnl(defaults::render("doctor_msg.sock_stale", &[("sock", &sock.display())]));
            stale_pid(doc, &lock);
        }
        (None, None) => {
            doc.infol(defaults::text("doctor_msg.daemon_down").to_string());
            stale_pid(doc, &lock);
        }
    }
    stale_pid(doc, &paths::dir().join(defaults::text("files.run_marker")));
    // the legitimate daemon is the one that answers (its pid is in the pong) or holds the lock; any other daemon that started here and still runs is a second one
    let legit = reply.as_deref().and_then(|r| r.split_whitespace().nth(2)).and_then(|p| p.parse::<u32>().ok()).or(if held { holder } else { None });
    let extra: Vec<String> = extra_daemons(&logged_daemon_pids(), health::pid_is_engine, legit).iter().map(u32::to_string).collect();
    if !extra.is_empty() {
        doc.warnl(defaults::render("doctor_msg.daemons_many", &[("n", &(extra.len() + usize::from(legit.is_some()))), ("pids", &extra.join(", ")), ("sock", &sock.display())]));
    }
    if let Some(left) = health::crashloop_remaining() {
        let reason = health::read_json("failure").and_then(|f| f["reason"].as_str().map(str::to_string)).unwrap_or_default();
        doc.bad(defaults::render("doctor_msg.crashloop", &[("secs", &(left.as_secs() + 1)), ("reason", &reason)]));
    }
    if let Some(left) = health::breaker_remaining() {
        let reason = health::read_json("failure").and_then(|f| f["reason"].as_str().map(str::to_string)).unwrap_or_default();
        doc.warnl(defaults::render("doctor_msg.breaker", &[("secs", &(left.as_secs() + 1)), ("reason", &reason)]));
    }
    if let Some(f) = health::read_json("failure") {
        let (class, reason, hint) = (f["class"].as_str().unwrap_or(""), f["reason"].as_str().unwrap_or(""), f["hint"].as_str().unwrap_or(""));
        doc.warnl(defaults::render("doctor_msg.failure_recorded", &[("class", &class), ("reason", &reason), ("hint", &hint)]));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn io_errors_classify() {
        let e = |c: i32| std::io::Error::from_raw_os_error(c);
        assert_eq!(classify_io(&e(libc::ENOTDIR)), IoClass::NotADirectory);
        assert_eq!(classify_io(&e(libc::ENOSPC)), IoClass::DiskFull);
        assert_eq!(classify_io(&e(libc::EDQUOT)), IoClass::DiskFull);
        for c in [libc::EROFS, libc::EACCES, libc::EPERM] {
            assert_eq!(classify_io(&e(c)), IoClass::NotWritable);
        }
        assert_eq!(classify_io(&e(libc::EIO)), IoClass::Other);
    }

    #[test]
    fn extra_daemons_are_the_logged_ones_still_running_besides_the_legitimate_one() {
        crate::defaults::init().unwrap();
        // two daemons started in this directory and both alive (a lock that did not exclude): the one that is not legitimate is extra
        assert_eq!(extra_daemons(&[10, 11], |_| true, Some(10)), vec![11]);
        // a logged daemon that has exited is not extra
        assert!(extra_daemons(&[10, 11], |p| p == 10, Some(10)).is_empty());
        // no legitimate daemon (down) and a leftover one still running
        assert_eq!(extra_daemons(&[14], |_| true, None), vec![14]);
    }

    #[test]
    fn wsl_and_windows_mounts() {
        crate::defaults::init().unwrap();
        assert!(is_wsl("5.15.90.1-microsoft-standard-WSL2"));
        assert!(!is_wsl("6.1.0-13-amd64"));
        assert_eq!(on_windows_mount(Path::new("/mnt/c/Users/me/.anti-hall")).as_deref(), Some("/mnt/c"));
        assert_eq!(on_windows_mount(Path::new("/home/me/.anti-hall")), None);
        assert_eq!(on_windows_mount(Path::new("/mnt/data/x")), None);
    }
}
