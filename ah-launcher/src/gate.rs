//! Cold-start gate: who may ask for a daemon start (one launcher at a time, not again while the last ask is still fresh, and
//! not past the crash-loop window), and a bounded probe that tells a live daemon from a stale socket file.

use crate::util::now_ms;
use std::fs::File;
use std::os::fd::AsRawFd;
use std::os::unix::ffi::OsStrExt;
use std::path::Path;
use std::time::Duration;

#[derive(PartialEq, Eq, Debug)]
pub enum Sock {
    /// something accepts connections (a busy or stopped daemon counts: its backlog took us)
    Live,
    /// a socket file nobody listens on
    Stale,
    Absent,
}

/// A non-blocking connect to the socket, bounded by `timeout`. Sends nothing.
pub fn probe(path: &Path, timeout: Duration) -> Sock {
    let bytes = path.as_os_str().as_bytes();
    // SAFETY: a zeroed sockaddr_un filled from `bytes` (length checked against sun_path); fd closed on every path.
    unsafe {
        let mut addr: libc::sockaddr_un = std::mem::zeroed();
        if bytes.len() >= addr.sun_path.len() {
            return Sock::Absent;
        }
        addr.sun_family = libc::AF_UNIX as libc::sa_family_t;
        for (i, b) in bytes.iter().enumerate() {
            addr.sun_path[i] = *b as libc::c_char;
        }
        let fd = libc::socket(libc::AF_UNIX, libc::SOCK_STREAM, 0);
        if fd < 0 {
            return Sock::Absent;
        }
        let fl = libc::fcntl(fd, libc::F_GETFL);
        libc::fcntl(fd, libc::F_SETFL, fl | libc::O_NONBLOCK);
        libc::fcntl(fd, libc::F_SETFD, libc::FD_CLOEXEC);
        let r = libc::connect(
            fd,
            (&raw const addr).cast(),
            std::mem::size_of::<libc::sockaddr_un>() as libc::socklen_t,
        );
        let out = if r == 0 {
            Sock::Live
        } else {
            match std::io::Error::last_os_error().raw_os_error() {
                Some(libc::ENOENT) => Sock::Absent,
                Some(libc::ECONNREFUSED) => Sock::Stale,
                Some(libc::EAGAIN | libc::EINPROGRESS) => {
                    // the listener's backlog is full (or the connect is pending): alive if it completes in time or is only busy
                    match crate::proc::poll_fd(fd, libc::POLLOUT, timeout) {
                        crate::proc::Ready::Yes => {
                            let mut err: libc::c_int = 0;
                            let mut len = std::mem::size_of::<libc::c_int>() as libc::socklen_t;
                            libc::getsockopt(
                                fd,
                                libc::SOL_SOCKET,
                                libc::SO_ERROR,
                                (&raw mut err).cast(),
                                &mut len,
                            );
                            if err == libc::ECONNREFUSED {
                                Sock::Stale
                            } else if err == 0 {
                                Sock::Live
                            } else {
                                Sock::Absent
                            }
                        }
                        crate::proc::Ready::Timeout => Sock::Live,
                        crate::proc::Ready::Gone => Sock::Absent,
                    }
                }
                _ => Sock::Absent,
            }
        };
        libc::close(fd);
        out
    }
}

pub enum Right {
    /// you may ask for the start (the ask is recorded; the lock is held until this is dropped)
    Kick(File),
    /// someone else asked recently (or is asking): only wait for the socket
    WaitOnly,
    /// too many asks in the crash-loop window: do not ask, do not wait
    Tripped,
    /// the state directory is unusable: no gate; the caller carries on without a kick
    Unavailable,
}

/// `fresh_ms`: an ask newer than this means the daemon is still coming up. `sock_ms`: when a socket file nobody listens on was left
/// behind, the time it was last changed; an ask older than that file started the daemon that bound it and then died, so it no longer
/// means "still coming up". `window_s`/`max`: the crash-loop rule.
pub fn acquire(
    dir: &Path,
    lock_name: &str,
    log_name: &str,
    fresh_ms: u64,
    sock_ms: Option<u64>,
    window_s: u64,
    max: u64,
) -> Right {
    if std::fs::create_dir_all(dir).is_err() {
        return Right::Unavailable;
    }
    let Ok(lock) = std::fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .write(true)
        .open(dir.join(lock_name))
    else {
        return Right::Unavailable;
    };
    // SAFETY: flock on an fd we own; released when the file is closed or the process dies, so a crash never strands it.
    if unsafe { libc::flock(lock.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } != 0 {
        return Right::WaitOnly;
    }
    let log = dir.join(log_name);
    let now = now_ms();
    let mut recent: Vec<u64> = std::fs::read_to_string(&log)
        .unwrap_or_default()
        .lines()
        .filter_map(|l| l.trim().parse().ok())
        .filter(|t: &u64| now.saturating_sub(*t) < window_s.saturating_mul(1000))
        .collect();
    if recent
        .iter()
        .any(|t| now.saturating_sub(*t) < fresh_ms && sock_ms.is_none_or(|m| *t >= m))
    {
        return Right::WaitOnly;
    }
    if recent.len() as u64 >= max {
        return Right::Tripped;
    }
    recent.push(now);
    let keep = max as usize;
    if recent.len() > keep {
        recent.drain(..recent.len() - keep);
    }
    let text: String = recent.iter().map(|t| format!("{t}\n")).collect();
    let _ = std::fs::write(&log, text);
    Right::Kick(lock)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::net::UnixListener;

    fn dir(tag: &str) -> std::path::PathBuf {
        let d = std::path::PathBuf::from(format!(
            "/tmp/ahg-{tag}-{}-{}",
            std::process::id(),
            now_ms() % 100000
        ));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn an_ask_older_than_the_stale_socket_no_longer_means_still_coming_up() {
        let d = dir("sk");
        let now = now_ms();
        std::fs::write(d.join("l.spawns"), format!("{}\n", now - 100)).unwrap();
        // no stale socket: the ask is fresh, wait only
        assert!(matches!(
            acquire(&d, "l.lock", "l.spawns", 10_000, None, 60, 5),
            Right::WaitOnly
        ));
        // the socket file is newer than the ask: that daemon died, ask again
        assert!(matches!(
            acquire(&d, "l.lock", "l.spawns", 10_000, Some(now - 50), 60, 5),
            Right::Kick(_)
        ));
        // the socket file is older than the newest ask: its daemon has not bound yet, wait only
        assert!(matches!(
            acquire(&d, "l.lock", "l.spawns", 10_000, Some(now - 50), 60, 5),
            Right::WaitOnly
        ));
    }

    #[test]
    fn probe_tells_live_stale_absent() {
        let d = dir("p");
        let s = d.join("s");
        assert_eq!(probe(&s, Duration::from_millis(50)), Sock::Absent);
        let l = UnixListener::bind(&s).unwrap();
        assert_eq!(probe(&s, Duration::from_millis(50)), Sock::Live);
        drop(l); // the file stays, nobody listens
        assert_eq!(probe(&s, Duration::from_millis(50)), Sock::Stale);
    }

    #[test]
    fn full_backlog_probe_is_bounded_and_never_reads_as_absent() {
        let d = dir("b");
        let s = d.join("s");
        let _l = UnixListener::bind(&s).unwrap(); // never accepts
        let t = std::time::Instant::now();
        let mut seen = Vec::new();
        for _ in 0..400 {
            seen.push(probe(&s, Duration::from_millis(50)));
        }
        assert!(
            t.elapsed() < Duration::from_secs(5),
            "each probe is bounded: {:?}",
            t.elapsed()
        );
        assert!(
            seen.iter().all(|p| *p != Sock::Absent),
            "a listening socket is never absent (ECONNREFUSED -> Stale or EAGAIN -> Live)"
        );
        assert_eq!(seen[0], Sock::Live);
    }

    #[test]
    fn one_asker_then_wait_then_trip() {
        let d = dir("g");
        let first = acquire(&d, "l.lock", "l.spawns", 10_000, None, 60, 3);
        assert!(matches!(first, Right::Kick(_)));
        // lock held by the first: a second launcher only waits
        assert!(matches!(
            acquire(&d, "l.lock", "l.spawns", 10_000, None, 60, 3),
            Right::WaitOnly
        ));
        drop(first);
        // lock free but the ask is fresh: still only waits
        assert!(matches!(
            acquire(&d, "l.lock", "l.spawns", 10_000, None, 60, 3),
            Right::WaitOnly
        ));
        // not fresh any more: may ask again, up to the window cap
        assert!(matches!(
            acquire(&d, "l.lock", "l.spawns", 0, None, 60, 3),
            Right::Kick(_)
        ));
        assert!(matches!(
            acquire(&d, "l.lock", "l.spawns", 0, None, 60, 3),
            Right::Kick(_)
        ));
        assert!(matches!(
            acquire(&d, "l.lock", "l.spawns", 0, None, 60, 3),
            Right::Tripped
        ));
        // the spawn log never grows past the cap
        assert!(
            std::fs::read_to_string(d.join("l.spawns"))
                .unwrap()
                .lines()
                .count()
                <= 3
        );
    }

    #[test]
    fn unusable_state_dir_is_unavailable() {
        assert!(matches!(
            acquire(Path::new("/proc/none/x"), "l", "s", 0, None, 60, 3),
            Right::Unavailable
        ));
    }
}
