//! The identity of one process generation, read from the operating system: a pid number is reused once its process ends, so a pid
//! alone never names "that daemon". [`start`] (when the process began) and [`exe`] (its executable) bind it to one generation, and
//! [`signal_verified`] delivers a signal only to the generation a caller's check accepted.
//!
//! Linux: `/proc/<pid>/stat` field 22 (start time in clock ticks since boot), `/proc/<pid>/exe`, and a pidfd (`pidfd_open` +
//! `pidfd_send_signal`) so the process checked is the process signalled. macOS: `proc_pidinfo(PROC_PIDTBSDINFO)` start time in
//! microseconds, `proc_pidpath`; there is no process handle, so the check runs immediately before `kill(2)`. The window between the
//! two is not bounded in time (the thread can be descheduled in it), but a wrong signal also needs the verified daemon to exit AND
//! its pid to be handed out again inside that window.
// Discard triage (E3): a process that vanished, or whose data the system will not give, is the absent value (fail-safe: nothing is
// done to it).

use std::path::PathBuf;

/// When `pid` started, in an OS-specific unit that only ever compares equal for the same process generation (Linux: clock ticks
/// since boot; macOS: microseconds since the epoch). `None` when the process is gone or the system will not say.
#[cfg(target_os = "linux")]
pub fn start(pid: u32) -> Option<u64> {
    let text = std::fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
    crate::procwatch::table::parse_proc_stat(&text).map(|f| f.4)
}

/// When `pid` started, in an OS-specific unit that only ever compares equal for the same process generation (Linux: clock ticks
/// since boot; macOS: microseconds since the epoch). `None` when the process is gone or the system will not say.
#[cfg(target_os = "macos")]
pub fn start(pid: u32) -> Option<u64> {
    // SAFETY: a zeroed proc_bsdinfo is a valid value of the plain C struct.
    let mut bsd: libc::proc_bsdinfo = unsafe { std::mem::zeroed() };
    let size = std::mem::size_of::<libc::proc_bsdinfo>() as libc::c_int;
    // SAFETY: `bsd` is a live, writable struct of the flavour and size passed.
    let rc = unsafe { libc::proc_pidinfo(pid as libc::c_int, libc::PROC_PIDTBSDINFO, 0, (&mut bsd as *mut libc::proc_bsdinfo).cast(), size) };
    (rc == size).then(|| bsd.pbi_start_tvsec.saturating_mul(1_000_000).saturating_add(bsd.pbi_start_tvusec))
}

/// No start time on other systems: generation identity cannot be established, so nothing is signalled.
#[cfg(not(any(target_os = "linux", target_os = "macos")))]
pub fn start(_pid: u32) -> Option<u64> {
    None
}

/// The executable `pid` runs, as the system reports it. `None` when the process is gone or the system will not say.
#[cfg(target_os = "linux")]
pub fn exe(pid: u32) -> Option<PathBuf> {
    std::fs::read_link(format!("/proc/{pid}/exe")).ok()
}

/// The executable `pid` runs, as the system reports it. `None` when the process is gone or the system will not say.
#[cfg(target_os = "macos")]
pub fn exe(pid: u32) -> Option<PathBuf> {
    use std::os::unix::ffi::OsStrExt;
    let mut buf = vec![0u8; libc::PROC_PIDPATHINFO_MAXSIZE as usize];
    // SAFETY: `buf` is a live, writable buffer of the length passed.
    let n = unsafe { libc::proc_pidpath(pid as libc::c_int, buf.as_mut_ptr().cast(), buf.len() as u32) };
    (n > 0).then(|| PathBuf::from(std::ffi::OsStr::from_bytes(&buf[..n as usize])))
}

/// No executable path on other systems: generation identity cannot be established, so nothing is signalled.
#[cfg(not(any(target_os = "linux", target_os = "macos")))]
pub fn exe(_pid: u32) -> Option<PathBuf> {
    None
}

/// Send `sig` to `pid` only when `verify` (run as late as possible) accepts it; true once delivered. On Linux the process is pinned
/// by a pidfd before `verify` runs, so the signal reaches the generation `verify` saw or none (`ESRCH` once it exited); on an old
/// kernel without pidfd (`ENOSYS`, before 5.3) it falls back to the macOS order; any other `pidfd_open` error declines.
#[cfg(target_os = "linux")]
pub fn signal_verified(pid: u32, sig: libc::c_int, verify: impl FnOnce() -> bool) -> bool {
    use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};
    // SAFETY: `pidfd_open` takes a pid and a flags word, and returns a new descriptor or -1.
    let fd = unsafe { libc::syscall(libc::SYS_pidfd_open, pid as libc::pid_t, 0) };
    if fd < 0 {
        // ENOSYS (old kernel) is the only case with no pidfd to be had; ESRCH (gone) and any other failure decline the signal
        return std::io::Error::last_os_error().raw_os_error() == Some(libc::ENOSYS) && verify_then_kill(pid, sig, verify);
    }
    // SAFETY: `fd` was just returned by pidfd_open and is owned by nothing else.
    let fd = unsafe { OwnedFd::from_raw_fd(fd as std::os::fd::RawFd) };
    if !verify() {
        return false;
    }
    // SAFETY: a live pidfd, a signal number, no siginfo (the kernel fills the SI_USER default), no flags.
    unsafe { libc::syscall(libc::SYS_pidfd_send_signal, fd.as_raw_fd(), sig, std::ptr::null::<libc::siginfo_t>(), 0) == 0 }
}

/// Send `sig` to `pid` only when `verify` accepts it; true once delivered. No process handle exists here, so `verify` runs
/// immediately before `kill(2)` (see the module comment for the residual window).
#[cfg(not(target_os = "linux"))]
pub fn signal_verified(pid: u32, sig: libc::c_int, verify: impl FnOnce() -> bool) -> bool {
    verify_then_kill(pid, sig, verify)
}

fn verify_then_kill(pid: u32, sig: libc::c_int, verify: impl FnOnce() -> bool) -> bool {
    // SAFETY: `kill` takes plain integers and has no memory-safety preconditions; it runs only for a pid `verify` just accepted.
    verify() && unsafe { libc::kill(pid as libc::pid_t, sig) } == 0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn this_process_has_a_stable_start_and_its_own_executable() {
        let me = std::process::id();
        let s = start(me).expect("own start time");
        assert_eq!(start(me), Some(s), "the start time of one generation never changes");
        let exe_os = exe(me).expect("own executable");
        assert_eq!(std::fs::canonicalize(exe_os).unwrap(), std::fs::canonicalize(std::env::current_exe().unwrap()).unwrap());
    }

    #[test]
    fn a_child_is_another_generation_and_a_rejected_check_signals_nothing() {
        let mut child = std::process::Command::new("sleep").arg("30").spawn().unwrap();
        let pid = child.id();
        assert_ne!(start(pid), None);
        assert!(!signal_verified(pid, libc::SIGKILL, || false), "a rejected check must not signal");
        assert!(child.try_wait().unwrap().is_none(), "the child must still run");
        assert!(signal_verified(pid, libc::SIGKILL, || true));
        crate::discard::harmless(child.wait());
    }
}
