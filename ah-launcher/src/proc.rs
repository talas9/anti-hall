//! Running a child (the engine, the cold-start kick, the fallback runner) under the launcher's rules:
//! - spawn retries ONLY for a transient start failure (capped exponential backoff with jitter, inside the hard deadline);
//!   after the child has started nothing is ever retried;
//! - the payload is streamed through a fixed buffer (the part kept in memory is the bounded prefix) with an idle timeout on
//!   the read side and a stall timeout on the write side;
//! - the child's output is captured under a cap (overflow is flagged, the rest drained);
//! - own process group, TERM -> grace -> KILL on the soft deadline; one extension while the engine says it waits on a live
//!   daemon;
//! - a watcher process (`Reaper`) that kills the child's group if the launcher itself is SIGKILLed.

use crate::limits::{self, CHILD_PGID, Ctr};
use std::ffi::CString;
use std::io::{self, Read};
use std::os::fd::{AsRawFd, RawFd};
use std::os::unix::process::{CommandExt, ExitStatusExt};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering as AO};
use std::sync::mpsc;
use std::time::{Duration, Instant};

// ---------------------------------------------------------------------------------------------------------------------------
// Retry
// ---------------------------------------------------------------------------------------------------------------------------

#[derive(Clone, Copy)]
pub struct Retry {
    pub max: u64,
    pub base_ms: u64,
    pub cap_ms: u64,
    pub jitter_pct: u64,
}

/// A start failure worth retrying: a resource that may free up (process table, memory, descriptors) or a binary that is busy
/// (being replaced). Not found, not executable, wrong format and the like are final.
pub fn transient(e: &io::Error) -> bool {
    matches!(
        e.raw_os_error(),
        Some(
            libc::EAGAIN | libc::ENOMEM | libc::EINTR | libc::ETXTBSY | libc::EMFILE | libc::ENFILE
        )
    )
}

fn xorshift(mut x: u64) -> u64 {
    x ^= x << 13;
    x ^= x >> 7;
    x ^= x << 17;
    x
}

/// The wait before retry number `n` (0-based): `base * 2^n` capped, minus up to `jitter_pct` percent of it.
pub fn backoff(pol: &Retry, n: u32, seed: u64) -> Duration {
    let full = pol
        .base_ms
        .saturating_mul(1u64 << n.min(20))
        .min(pol.cap_ms);
    let cut = full * pol.jitter_pct.min(100) / 100;
    let jit = if cut == 0 {
        0
    } else {
        xorshift(seed.wrapping_add(n as u64 + 1) | 1) % (cut + 1)
    };
    Duration::from_millis(full - jit)
}

pub fn retry_spawn<T>(
    mut f: impl FnMut() -> io::Result<T>,
    pol: &Retry,
    deadline: Instant,
    seed: u64,
    mut sleep: impl FnMut(Duration),
) -> io::Result<T> {
    let mut n = 0u32;
    loop {
        match f() {
            Ok(v) => return Ok(v),
            Err(e) if transient(&e) && u64::from(n) < pol.max => {
                let wait = backoff(pol, n, seed);
                if Instant::now() + wait >= deadline {
                    return Err(e);
                }
                limits::bump(Ctr::SpawnRetries);
                sleep(wait);
                n += 1;
            }
            Err(e) => return Err(e),
        }
    }
}

// ---------------------------------------------------------------------------------------------------------------------------
// Low-level fd helpers
// ---------------------------------------------------------------------------------------------------------------------------

#[derive(PartialEq, Eq, Debug)]
pub enum Ready {
    Yes,
    Timeout,
    Gone,
}

pub fn poll_fd(fd: RawFd, events: libc::c_short, timeout: Duration) -> Ready {
    let end = Instant::now() + timeout;
    loop {
        let left = end.saturating_duration_since(Instant::now());
        let mut p = libc::pollfd {
            fd,
            events,
            revents: 0,
        };
        // SAFETY: one valid pollfd.
        let r = unsafe {
            libc::poll(
                &mut p,
                1,
                left.as_millis().min(i32::MAX as u128) as libc::c_int,
            )
        };
        if r < 0 {
            if io::Error::last_os_error().raw_os_error() == Some(libc::EINTR) {
                continue;
            }
            return Ready::Gone;
        }
        if r == 0 {
            return Ready::Timeout;
        }
        if p.revents & events != 0 {
            return Ready::Yes;
        }
        return Ready::Gone;
    }
}

fn read_fd(fd: RawFd, buf: &mut [u8]) -> io::Result<usize> {
    loop {
        // SAFETY: buf is a valid writable slice of its own length.
        let n = unsafe { libc::read(fd, buf.as_mut_ptr().cast(), buf.len()) };
        if n >= 0 {
            return Ok(n as usize);
        }
        let e = io::Error::last_os_error();
        if e.raw_os_error() != Some(libc::EINTR) {
            return Err(e);
        }
    }
}

fn write_fd(fd: RawFd, buf: &[u8]) -> io::Result<usize> {
    loop {
        // SAFETY: buf is a valid readable slice of its own length.
        let n = unsafe { libc::write(fd, buf.as_ptr().cast(), buf.len()) };
        if n >= 0 {
            return Ok(n as usize);
        }
        let e = io::Error::last_os_error();
        if e.raw_os_error() != Some(libc::EINTR) {
            return Err(e);
        }
    }
}

fn set_nonblocking(fd: RawFd) {
    // SAFETY: fcntl on an fd we own.
    unsafe {
        let fl = libc::fcntl(fd, libc::F_GETFL);
        if fl >= 0 {
            libc::fcntl(fd, libc::F_SETFL, fl | libc::O_NONBLOCK);
        }
    }
}

fn set_cloexec(fd: RawFd) {
    // SAFETY: fcntl on an fd we own.
    unsafe {
        libc::fcntl(fd, libc::F_SETFD, libc::FD_CLOEXEC);
    }
}

/// Write all of `buf` to a non-blocking fd; a stall longer than `stall` (the reader is not reading) is an error.
fn write_all_stall(fd: RawFd, mut buf: &[u8], stall: Duration) -> io::Result<()> {
    while !buf.is_empty() {
        match write_fd(fd, buf) {
            Ok(n) => buf = &buf[n..],
            Err(e) if e.raw_os_error() == Some(libc::EAGAIN) => {
                match poll_fd(fd, libc::POLLOUT, stall) {
                    Ready::Yes => {}
                    Ready::Timeout => {
                        limits::bump(Ctr::WriteTimeout);
                        return Err(io::Error::from(io::ErrorKind::TimedOut));
                    }
                    Ready::Gone => return Err(io::Error::from(io::ErrorKind::BrokenPipe)),
                }
            }
            Err(e) => return Err(e),
        }
    }
    Ok(())
}

/// The bounded prefix of the payload: reads fd 0 until `cap` bytes, EOF, an error or `idle` without data. The bool says the
/// payload may continue past the prefix. A closed or unreadable stdin is an empty payload.
pub fn read_prefix(fd: RawFd, cap: usize, idle: Duration, chunk: usize) -> (Vec<u8>, bool) {
    let mut out = Vec::new();
    let mut buf = vec![0u8; chunk.clamp(1, cap.max(1))];
    while out.len() < cap {
        match poll_fd(fd, libc::POLLIN, idle) {
            Ready::Yes => {}
            Ready::Timeout => {
                limits::bump(Ctr::StdinIdle);
                return (out, false);
            }
            Ready::Gone => return (out, false),
        }
        let want = buf.len().min(cap - out.len());
        if !limits::mem_ok(want) {
            return (out, true);
        }
        match read_fd(fd, &mut buf[..want]) {
            Ok(0) | Err(_) => return (out, false),
            Ok(n) => out.extend_from_slice(&buf[..n]),
        }
    }
    (out, true)
}

// ---------------------------------------------------------------------------------------------------------------------------
// The watcher that outlives a SIGKILLed launcher
// ---------------------------------------------------------------------------------------------------------------------------

/// A forked watcher holding the read end of a pipe whose write end only the launcher has. The launcher tells it the child's
/// process group and, when it is done with the child, `D`. If the pipe closes WITHOUT the `D` (the launcher was killed), the
/// watcher kills the group and removes the run directory's files, then exits. Forked BEFORE the child exists so it shares none
/// of the child's pipes; it runs only async-signal-safe calls (read, kill, unlink, rmdir, _exit).
pub struct Reaper {
    wr: RawFd,
}

const DONE: u8 = b'D';

impl Reaper {
    /// `cleanup`: paths to remove after the kill; every path but the last is unlinked, the last is rmdir'ed.
    pub fn start(cleanup: &[CString]) -> Option<Reaper> {
        let mut fds = [0 as libc::c_int; 2];
        // SAFETY: pipe fills the two-element array.
        if unsafe { libc::pipe(fds.as_mut_ptr()) } != 0 {
            return None;
        }
        let (rd, wr) = (fds[0], fds[1]);
        set_cloexec(rd);
        set_cloexec(wr);
        let devnull = CString::new("/dev/null").ok()?;
        let ptrs: Vec<*const libc::c_char> = cleanup.iter().map(|c| c.as_ptr()).collect();
        // SAFETY: fork; the child below makes only async-signal-safe calls on memory prepared before the fork.
        match unsafe { libc::fork() } {
            -1 => {
                // SAFETY: closing fds we just created.
                unsafe {
                    libc::close(rd);
                    libc::close(wr);
                }
                None
            }
            0 => watcher(rd, wr, &devnull, &ptrs),
            _ => {
                // SAFETY: closing the read end the parent does not use.
                unsafe { libc::close(rd) };
                Some(Reaper { wr })
            }
        }
    }

    pub fn arm(&self, pgid: i32) {
        let _ = write_fd(self.wr, &pgid.to_le_bytes());
    }

    /// The child is finished (or was never started): the watcher exits without killing anything.
    pub fn disarm(self) {
        let _ = write_fd(self.wr, &[DONE]);
    }
}

impl Drop for Reaper {
    fn drop(&mut self) {
        // SAFETY: closing the write end we own; the watcher then sees EOF (after a DONE byte it exits quietly).
        unsafe { libc::close(self.wr) };
    }
}

fn read_exact_raw(fd: RawFd, buf: &mut [u8]) -> bool {
    let mut got = 0;
    while got < buf.len() {
        // SAFETY: the slice from `got` is valid and writable.
        let n = unsafe { libc::read(fd, buf[got..].as_mut_ptr().cast(), buf.len() - got) };
        if n > 0 {
            got += n as usize;
        } else if n < 0 && io::Error::last_os_error().raw_os_error() == Some(libc::EINTR) {
            continue;
        } else {
            return false;
        }
    }
    true
}

fn watcher(rd: RawFd, wr: RawFd, devnull: &CString, cleanup: &[*const libc::c_char]) -> ! {
    // SAFETY: only async-signal-safe libc calls; no allocation.
    unsafe {
        libc::setsid();
        libc::close(wr);
        let nul = libc::open(devnull.as_ptr(), libc::O_RDWR);
        for fd in 0..3 {
            if nul >= 0 {
                libc::dup2(nul, fd);
            } else {
                libc::close(fd);
            }
        }
        if nul > 2 {
            libc::close(nul);
        }
        let mut pg = [0u8; 4];
        if !read_exact_raw(rd, &mut pg) {
            libc::_exit(0); // the launcher never started a child
        }
        let mut flag = [0u8; 1];
        if read_exact_raw(rd, &mut flag) && flag[0] == DONE {
            libc::_exit(0);
        }
        let pgid = i32::from_le_bytes(pg);
        if pgid > 1 {
            libc::kill(-pgid, libc::SIGKILL);
        }
        let n = cleanup.len();
        for (i, p) in cleanup.iter().enumerate() {
            if i + 1 == n {
                libc::rmdir(*p);
            } else {
                libc::unlink(*p);
            }
        }
        libc::_exit(0)
    }
}

// ---------------------------------------------------------------------------------------------------------------------------
// Running a child
// ---------------------------------------------------------------------------------------------------------------------------

#[derive(Clone)]
pub struct Feed {
    pub prefix: Arc<Vec<u8>>,
    /// stdin (fd 0) may hold more after the prefix: stream it through
    pub more: bool,
    pub idle: Duration,
    pub write_stall: Duration,
    pub chunk: usize,
    pub soft: u64,
    pub hard: u64,
    /// copy the part of the payload beyond the prefix to this private file (so the fallback runner can be given all of it)
    pub spool: Option<PathBuf>,
    pub spool_max: u64,
    /// after the prefix, stream this file instead of fd 0 (the replay of a spooled payload)
    pub file: Option<PathBuf>,
}

/// What the pump learned about the payload, read after the child has exited.
#[derive(Default)]
pub struct PumpState {
    eof: AtomicBool,
    spool_failed: AtomicBool,
}

impl Feed {
    /// A complete in-memory input (the kick body, the replayed payload).
    pub fn memory(bytes: &[u8], write_stall: Duration, chunk: usize) -> Feed {
        Feed {
            prefix: Arc::new(bytes.to_vec()),
            more: false,
            idle: Duration::ZERO,
            write_stall,
            chunk,
            soft: u64::MAX,
            hard: u64::MAX,
            spool: None,
            spool_max: 0,
            file: None,
        }
    }
}

pub struct Opts<'a> {
    pub argv: &'a [String],
    pub envs: &'a [(String, String)],
    /// variables removed from the child's environment
    pub env_remove: &'a [String],
    pub feed: Feed,
    /// the soft deadline from the start
    pub budget: Duration,
    /// while this file exists at the soft deadline the deadline moves, once, to `slow_max`
    pub wait_file: Option<&'a Path>,
    /// the engine's done mark: it exists from the moment the answer is written until the engine exits, so it also moves the
    /// deadline (the engine drops the wait file only after the done mark is made, so one of the two exists at every instant); a
    /// child killed with it present has already answered, and its captured output is delivered
    pub done_file: Option<&'a Path>,
    pub slow_max: Duration,
    pub grace: Duration,
    /// how long after the child has exited its output pipes may take to reach end of file
    pub drain: Duration,
    /// true: a helper left in the child's group after it exited is a failure (the engine); false: it is killed quietly (the
    /// shell fallback runner leaves watchdog helpers behind)
    pub strict_group: bool,
    pub out_cap: usize,
    pub err_cap: usize,
    pub retry: Retry,
    /// run the watcher; its cleanup paths (see `Reaper::start`)
    pub reaper: Option<Vec<CString>>,
}

pub enum Run {
    Exited {
        code: i32,
        out: Vec<u8>,
        err: Vec<u8>,
        overflow: bool,
    },
    TimedOut,
    GroupAlive,
    SpawnFailed {
        errno: Option<i32>,
    },
}

fn kill_group(pgid: i32, sig: i32) {
    // SAFETY: plain syscall on a process group we created (process_group(0) makes pgid == child pid).
    unsafe {
        libc::kill(-pgid, sig);
    }
}

fn group_alive(pgid: i32) -> bool {
    // SAFETY: signal 0 only probes for existence.
    unsafe { libc::kill(-pgid, 0) == 0 }
}

/// A thread that cannot be started is a failure to report, not a panic.
fn go<F: FnOnce() + Send + 'static>(f: F) -> bool {
    std::thread::Builder::new().spawn(f).is_ok()
}

fn stream_file(fd: RawFd, path: &Path, feed: &Feed) -> io::Result<()> {
    let mut f = std::fs::File::open(path)?;
    let mut buf = vec![0u8; feed.chunk.max(1)];
    loop {
        let n = f.read(&mut buf)?;
        if n == 0 {
            return Ok(());
        }
        write_all_stall(fd, &buf[..n], feed.write_stall)?;
    }
}

fn pump(w: ChildStdin, feed: Feed, st: Arc<PumpState>, done: mpsc::Sender<()>) {
    let fd = w.as_raw_fd();
    set_nonblocking(fd);
    let child_ok = write_all_stall(fd, &feed.prefix, feed.write_stall).is_ok();
    if let Some(p) = &feed.file {
        if child_ok {
            let _ = stream_file(fd, p, &feed);
        }
    } else if feed.more {
        pump_stdin(fd, &feed, &st, child_ok);
    } else {
        st.eof.store(true, AO::SeqCst);
    }
    drop(w); // the child sees end of input
    let _ = done.send(());
}

/// The rest of the payload, from fd 0 to the child in a fixed buffer. When the child stops reading and a spool is kept,
/// reading continues into the spool so the payload can still be replayed.
fn pump_stdin(fd: RawFd, feed: &Feed, st: &PumpState, mut child_ok: bool) {
    let mut spool = feed.spool.as_ref().and_then(|p| {
        use std::os::unix::fs::OpenOptionsExt;
        std::fs::OpenOptions::new()
            .create(true)
            .truncate(true)
            .write(true)
            .mode(0o600)
            .open(p)
            .ok()
    });
    if feed.spool.is_some() && spool.is_none() {
        st.spool_failed.store(true, AO::SeqCst);
    }
    let (mut total, mut spooled) = (feed.prefix.len() as u64, 0u64);
    let mut soft_hit = total > feed.soft;
    if soft_hit {
        limits::bump(Ctr::StdinSoft);
    }
    let mut buf = vec![0u8; feed.chunk.max(1)];
    loop {
        if !child_ok && spool.is_none() {
            return;
        }
        if poll_fd(0, libc::POLLIN, feed.idle) != Ready::Yes {
            if poll_fd(0, libc::POLLIN, Duration::ZERO) == Ready::Timeout {
                limits::bump(Ctr::StdinIdle);
            }
            return;
        }
        let n = match read_fd(0, &mut buf) {
            Ok(0) | Err(_) => {
                st.eof.store(true, AO::SeqCst);
                return;
            }
            Ok(n) => n,
        };
        let allowed = (feed.hard.saturating_sub(total)).min(n as u64) as usize;
        total += n as u64;
        if !soft_hit && total > feed.soft {
            soft_hit = true;
            limits::bump(Ctr::StdinSoft);
        }
        if child_ok
            && allowed > 0
            && write_all_stall(fd, &buf[..allowed], feed.write_stall).is_err()
        {
            child_ok = false;
        }
        if let Some(sp) = spool.as_mut() {
            use std::io::Write;
            if allowed > 0 {
                if spooled + allowed as u64 > feed.spool_max
                    || sp.write_all(&buf[..allowed]).is_err()
                {
                    spool = None;
                    st.spool_failed.store(true, AO::SeqCst);
                } else {
                    spooled += allowed as u64;
                }
            }
        }
        if total > feed.hard {
            limits::bump(Ctr::StdinHard);
            st.spool_failed.store(true, AO::SeqCst);
            return;
        }
    }
}

fn capture(
    mut r: impl Read + Send + 'static,
    cap: usize,
    chunk: usize,
) -> Option<mpsc::Receiver<(Vec<u8>, bool)>> {
    let (tx, rx) = mpsc::channel();
    go(move || {
        let mut out = Vec::new();
        let mut overflow = false;
        let mut buf = vec![0u8; chunk.max(1)];
        loop {
            match r.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    if !overflow && out.len() + n <= cap && limits::mem_ok(n) {
                        out.extend_from_slice(&buf[..n]);
                    } else {
                        overflow = true; // keep draining so the child is never blocked on a full pipe
                    }
                }
            }
        }
        let _ = tx.send((out, overflow));
    })
    .then_some(rx)
}

fn seed() -> u64 {
    crate::util::now_ms() ^ (u64::from(std::process::id()) << 20) | 1
}

/// True when the file starts like something the kernel can run: a `#!` script, an ELF or a Mach-O image. `execvp` runs any other
/// file as a shell script (the ENOEXEC fallback), which would execute a corrupt or truncated binary as commands; never do that.
pub fn loadable(path: &str) -> bool {
    if !path.contains('/') {
        return true; // looked up on PATH by the kernel's rules; not a file we vouch for here
    }
    let mut head = [0u8; 4];
    let ok = std::fs::File::open(path)
        .and_then(|mut f| f.read_exact(&mut head))
        .is_ok();
    let images: [[u8; 4]; 6] = [
        [0x7f, b'E', b'L', b'F'],
        [0xfe, 0xed, 0xfa, 0xce],
        [0xfe, 0xed, 0xfa, 0xcf],
        [0xce, 0xfa, 0xed, 0xfe],
        [0xcf, 0xfa, 0xed, 0xfe],
        [0xca, 0xfe, 0xba, 0xbe],
    ];
    ok && (head[..2] == *b"#!" || images.contains(&head))
}

pub fn run_child(o: &Opts) -> Run {
    let start = Instant::now();
    let Some((prog, rest)) = o.argv.split_first() else {
        return Run::SpawnFailed { errno: None };
    };
    if !loadable(prog) {
        limits::bump(Ctr::SpawnFail);
        return Run::SpawnFailed {
            errno: Some(libc::ENOEXEC),
        };
    }
    let mut cmd = Command::new(prog);
    cmd.args(rest)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .process_group(0);
    for k in o.env_remove {
        cmd.env_remove(k);
    }
    for (k, v) in o.envs {
        cmd.env(k, v);
    }
    // SAFETY: the closure only calls setrlimit (async-signal-safe): the engine must not inherit the launcher's CPU limit.
    unsafe {
        cmd.pre_exec(|| {
            limits::restore_cpu_limit();
            Ok(())
        });
    }
    let reaper = o.reaper.as_deref().and_then(Reaper::start);
    if o.reaper.is_some() && reaper.is_none() {
        limits::bump(Ctr::ReaperOff);
    }
    let spawned = retry_spawn(
        || cmd.spawn(),
        &o.retry,
        start + o.budget,
        seed(),
        std::thread::sleep,
    );
    let mut child: Child = match spawned {
        Ok(c) => c,
        Err(e) => {
            limits::bump(Ctr::SpawnFail);
            if let Some(r) = reaper {
                r.disarm();
            }
            return Run::SpawnFailed {
                errno: e.raw_os_error(),
            };
        }
    };
    let pgid = child.id() as i32;
    CHILD_PGID.store(pgid, std::sync::atomic::Ordering::SeqCst);
    if let Some(r) = &reaper {
        r.arm(pgid);
    }
    let finish = |reaper: Option<Reaper>| {
        CHILD_PGID.store(0, std::sync::atomic::Ordering::SeqCst);
        if let Some(r) = reaper {
            r.disarm();
        }
    };
    let (Some(stdin), Some(so), Some(se)) =
        (child.stdin.take(), child.stdout.take(), child.stderr.take())
    else {
        kill_group(pgid, libc::SIGKILL);
        let _ = child.wait();
        finish(reaper);
        return Run::SpawnFailed { errno: None };
    };
    let feed = o.feed.clone();
    let (chunk, out_cap, err_cap) = (o.feed.chunk, o.out_cap, o.err_cap);
    let (wtx, wrx) = mpsc::channel();
    let st = Arc::new(PumpState::default());
    let (dtx, _drx) = mpsc::channel(); // keep: the pump reports its end here; nothing waits for it any more (no replay runner exists)
    let pumped = go({
        let st = st.clone();
        move || pump(stdin, feed, st, dtx)
    });
    let (orx, erx) = (capture(so, out_cap, chunk), capture(se, err_cap, chunk));
    let waiting = go(move || {
        let _ = wtx.send(child.wait());
    });
    let (true, Some(orx), Some(erx), true) = (pumped, orx, erx, waiting) else {
        kill_group(pgid, libc::SIGKILL);
        finish(reaper);
        return Run::SpawnFailed { errno: None };
    };
    let mut status = wrx
        .recv_timeout(o.budget.saturating_sub(start.elapsed()))
        .ok();
    if status.is_none()
        && o.slow_max > o.budget
        && (o.wait_file.is_some_and(Path::exists) || o.done_file.is_some_and(Path::exists))
    {
        status = wrx
            .recv_timeout(o.slow_max.saturating_sub(start.elapsed()))
            .ok();
    }
    if status.is_none()
        && let Some(log) = crate::launcher::LOG.get()
    {
        log.append(&format!(
            "child_deadline budget_ms={} slow_ms={} elapsed_ms={} markers={} wait={} done={}",
            o.budget.as_millis(),
            o.slow_max.as_millis(),
            start.elapsed().as_millis(),
            o.wait_file.is_some(),
            o.wait_file.is_some_and(Path::exists),
            o.done_file.is_some_and(Path::exists)
        ));
    }
    // The answer is already written when the done mark exists: a child that is still not gone at the hard deadline is cut, but
    // what it printed is delivered (with its exit code when it leaves within the grace, else 0) instead of being dropped.
    let mut answered_cut = false;
    let status = match status {
        Some(st) => Some(st),
        None => {
            let answered = o.done_file.is_some_and(Path::exists);
            kill_group(pgid, libc::SIGTERM);
            let late = wrx.recv_timeout(o.grace);
            if late.is_err() || group_alive(pgid) {
                kill_group(pgid, libc::SIGKILL);
            }
            if !answered {
                finish(reaper);
                return Run::TimedOut;
            }
            answered_cut = true;
            late.ok()
        }
    };
    if group_alive(pgid) && (!o.strict_group || answered_cut) {
        kill_group(pgid, libc::SIGKILL);
    } else if group_alive(pgid) {
        // a helper of the engine outlived it in its group: it may still hold the pipes, and its answer is not the engine's
        kill_group(pgid, libc::SIGTERM);
        std::thread::sleep(o.grace);
        kill_group(pgid, libc::SIGKILL);
        finish(reaper);
        return Run::GroupAlive;
    }
    finish(reaper);
    let code = match status {
        Some(Ok(st)) if answered_cut => st.code().unwrap_or(0),
        Some(Ok(st)) => st.code().unwrap_or_else(|| 128 + st.signal().unwrap_or(0)),
        None if answered_cut => 0,
        _ => return Run::SpawnFailed { errno: None },
    };
    let wait = o.drain;
    let (Ok((out, o1)), Ok((err, o2))) = (orx.recv_timeout(wait), erx.recv_timeout(wait)) else {
        return Run::GroupAlive;
    };
    Run::Exited {
        code,
        out,
        err,
        overflow: o1 || o2,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;

    fn pol() -> Retry {
        Retry {
            max: 3,
            base_ms: 5,
            cap_ms: 40,
            jitter_pct: 50,
        }
    }
    fn err(code: i32) -> io::Error {
        io::Error::from_raw_os_error(code)
    }

    #[test]
    fn transient_failure_then_success_retries_with_growing_waits() {
        let calls = Cell::new(0);
        let waits = std::cell::RefCell::new(Vec::new());
        let r = retry_spawn(
            || {
                calls.set(calls.get() + 1);
                if calls.get() < 3 {
                    Err(err(libc::EAGAIN))
                } else {
                    Ok(7)
                }
            },
            &pol(),
            Instant::now() + Duration::from_secs(5),
            42,
            |d| waits.borrow_mut().push(d),
        );
        assert_eq!(r.unwrap(), 7);
        assert_eq!(calls.get(), 3);
        let w = waits.borrow();
        assert_eq!(w.len(), 2);
        assert!(
            w[0] <= Duration::from_millis(5) && w[1] <= Duration::from_millis(10),
            "{w:?}"
        );
        assert!(
            w[0] >= Duration::from_millis(2) && w[1] >= Duration::from_millis(5),
            "jitter takes off at most half: {w:?}"
        );
    }

    #[test]
    fn final_errors_are_not_retried() {
        for code in [libc::ENOENT, libc::EACCES, libc::ENOEXEC] {
            let calls = Cell::new(0);
            let r: io::Result<()> = retry_spawn(
                || {
                    calls.set(calls.get() + 1);
                    Err(err(code))
                },
                &pol(),
                Instant::now() + Duration::from_secs(5),
                1,
                |_| {},
            );
            assert!(r.is_err());
            assert_eq!(calls.get(), 1, "errno {code} is final");
        }
    }

    #[test]
    fn retries_stop_at_the_cap_and_at_the_deadline() {
        let calls = Cell::new(0);
        let r: io::Result<()> = retry_spawn(
            || {
                calls.set(calls.get() + 1);
                Err(err(libc::EAGAIN))
            },
            &pol(),
            Instant::now() + Duration::from_secs(5),
            1,
            |_| {},
        );
        assert!(r.is_err());
        assert_eq!(calls.get(), 4, "one try plus max retries");
        let calls = Cell::new(0);
        let r: io::Result<()> = retry_spawn(
            || {
                calls.set(calls.get() + 1);
                Err(err(libc::ENOMEM))
            },
            &pol(),
            Instant::now() + Duration::from_millis(1),
            1,
            |_| panic!("no wait fits inside the deadline"),
        );
        assert!(r.is_err());
        assert_eq!(calls.get(), 1);
    }

    #[test]
    fn backoff_is_capped_and_jitter_never_adds() {
        let p = pol();
        for n in 0..12 {
            let d = backoff(&p, n, 9);
            let full = (5u64 << n.min(20)).min(40);
            assert!(
                d <= Duration::from_millis(full) && d >= Duration::from_millis(full - full / 2),
                "n={n} d={d:?}"
            );
        }
    }
}

#[cfg(test)]
mod loadable_tests {
    use super::*;

    #[test]
    fn only_runnable_images_and_scripts_are_loadable() {
        let d = std::env::temp_dir().join(format!(
            "ah-load-{}-{}",
            std::process::id(),
            crate::util::now_ms()
        ));
        std::fs::create_dir_all(&d).unwrap();
        let w = |n: &str, b: &[u8]| {
            let p = d.join(n);
            std::fs::write(&p, b).unwrap();
            p.display().to_string()
        };
        assert!(loadable(&w("sh", b"#!/bin/sh\nexit 0\n")));
        assert!(loadable(&w("elf", b"\x7fELF\x02\x01\x01")));
        assert!(loadable(&w("macho", &[0xcf, 0xfa, 0xed, 0xfe, 0, 0])));
        assert!(!loadable(&w(
            "junk",
            b"echo this would run as a shell script\n"
        )));
        assert!(!loadable(&w("short", b"#")));
        assert!(!loadable(&d.join("missing").display().to_string()));
        assert!(loadable("ls"), "a bare name is left to PATH lookup");
    }
}
