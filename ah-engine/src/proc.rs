//! The one bounded child process (review findings 6, 7, 8 and 12).
//!
//! Every helper the engine runs (git, `ps`, `vm_stat`, a scheduled job) goes through [`run`]:
//! - it runs in its own process group, and a timeout kills the whole group (a helper it started cannot outlive it);
//! - stdout and stderr are drained on their own threads while it runs, so a chatty child never blocks on a full pipe;
//! - after it exits, its output is collected for at most `proc.read_grace_ms`: a leftover process that still holds a pipe
//!   cannot hang the caller (the group is killed, and the output counts as unread, never as a whole answer);
//! - a spawn failure (EAGAIN, EMFILE, ENOENT, ...) and a timeout are logged with a reason code, rate-limited.
use crate::defaults;
use std::io::Read;
use std::os::unix::process::CommandExt;
use std::process::{Command, ExitStatus, Stdio};
use std::sync::mpsc;
use std::time::{Duration, Instant};

/// What a child that ran to its end produced.
#[derive(Debug)]
pub struct Output {
    /// Its exit status.
    pub status: ExitStatus,
    /// Everything it wrote to stdout.
    pub stdout: Vec<u8>,
    /// Everything it wrote to stderr.
    pub stderr: Vec<u8>,
}

/// Why a child produced no [`Output`].
#[derive(Debug)]
pub enum Error {
    /// It could not be started.
    Spawn(std::io::Error),
    /// It was still running at its timeout; its group was killed.
    Timeout,
    /// Its state could not be read (`waitpid` failed); its group was killed.
    Wait(std::io::Error),
    /// It exited, but its output was not complete within `proc.read_grace_ms` (a leftover process held a pipe, or a read
    /// failed); its group was killed.
    Unread,
}

impl Error {
    /// The error as an `io::Error`, for callers whose error type wraps one.
    pub fn into_io(self) -> std::io::Error {
        match self {
            Error::Spawn(e) | Error::Wait(e) => e,
            Error::Timeout => std::io::Error::from(std::io::ErrorKind::TimedOut),
            Error::Unread => std::io::Error::from(std::io::ErrorKind::UnexpectedEof),
        }
    }
}

/// Mark `cmd` as a read-only git reader when its program is git (`proc.git_programs`): every `proc.git_env` assignment
/// (`GIT_OPTIONAL_LOCKS=0`) is set unless the caller already set that name. Without it `git status`/`git diff` take
/// `.git/index.lock` to refresh the index, and a helper killed at its timeout (SIGKILL) leaves the lock behind, which blocks
/// the user's own git. A no-op for any other program, so every spawn site can call it. Writes are unaffected by the variable.
pub fn apply_git_env(cmd: &mut Command) {
    let prog = std::path::Path::new(cmd.get_program()).file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    if !defaults::list("proc.git_programs").iter().any(|g| *g == prog) {
        return;
    }
    for a in defaults::list("proc.git_env") {
        if let Some((k, v)) = a.split_once('=') {
            if !cmd.get_envs().any(|(name, _)| name == std::ffi::OsStr::new(k)) {
                cmd.env(k, v);
            }
        }
    }
}

/// The process groups of the helpers running now, so a daemon that exits takes them down instead of orphaning them.
static RUNNING: std::sync::Mutex<Vec<u32>> = std::sync::Mutex::new(Vec::new());

fn running() -> std::sync::MutexGuard<'static, Vec<u32>> {
    RUNNING.lock().unwrap_or_else(|e| e.into_inner())
}

/// Kill the process group of every helper still running (the daemon is exiting: nobody will wait for them).
pub fn kill_all() {
    for pid in running().drain(..) {
        // SAFETY: killpg only sends a signal; each id is a group we spawned as its own leader and have not reaped.
        unsafe {
            libc::killpg(pid as libc::pid_t, libc::SIGKILL);
        }
    }
}

fn drain(mut r: impl Read + Send + 'static) -> mpsc::Receiver<(Vec<u8>, bool)> {
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        let mut b = Vec::new();
        let clean = r.read_to_end(&mut b).is_ok();
        crate::discard::harmless(tx.send((b, clean))); // keep: the receiver is gone; nobody is waiting for the result
    });
    rx
}

/// True once the child has exited, without reaping it (it stays a zombie until `wait`, so its pid cannot be reused yet).
fn exited(pid: u32) -> Result<bool, std::io::Error> {
    // SAFETY: an all-zero siginfo_t is a valid out-parameter for waitid; WNOHANG|WNOWAIT only inspect the child's state.
    let mut info: libc::siginfo_t = unsafe { std::mem::zeroed() };
    loop {
        // SAFETY: `info` is a live, writable siginfo_t; P_PID names a child of this process.
        let r = unsafe { libc::waitid(libc::P_PID, pid as libc::id_t, &mut info, libc::WEXITED | libc::WNOHANG | libc::WNOWAIT) };
        if r == 0 {
            // SAFETY: waitid filled `info`; si_pid is zero when no child had changed state (WNOHANG).
            #[cfg(target_os = "linux")]
            let who = unsafe { info.si_pid() };
            #[cfg(not(target_os = "linux"))]
            let who = info.si_pid;
            return Ok(who != 0);
        }
        let e = std::io::Error::last_os_error();
        if e.kind() != std::io::ErrorKind::Interrupted {
            return Err(e);
        }
    }
}

fn kill_group(child: &mut std::process::Child) {
    // SAFETY: killpg only sends a signal; the group id is the child we spawned as its own group leader.
    unsafe {
        libc::killpg(child.id() as libc::pid_t, libc::SIGKILL);
    }
    crate::discard::harmless(child.kill()); // keep: reaping or draining a child or thread that already ended
    crate::discard::harmless(child.wait()); // keep: reaping or draining a child or thread that already ended
}

/// Run `cmd` (stdin from /dev/null, stdout and stderr captured, its own process group) for at most `timeout`, checking
/// every `poll`. `what` names the helper in the log line of a failure.
///
/// # Errors
/// See [`Error`].
pub fn run(mut cmd: Command, what: &str, timeout: Duration, poll: Duration) -> Result<Output, Error> {
    apply_git_env(&mut cmd);
    cmd.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped()).process_group(0);
    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => {
            let detail = defaults::render("msg.log_proc_spawn", &[("what", &what), ("code", &format!("os{}", e.raw_os_error().unwrap_or(0))), ("err", &e)]);
            crate::discard::note("proc_spawn_failed", &detail);
            return Err(Error::Spawn(e));
        }
    };
    let (Some(out), Some(err)) = (child.stdout.take(), child.stderr.take()) else {
        kill_group(&mut child);
        return Err(Error::Unread);
    };
    let (out, err) = (drain(out), drain(err));
    let pid = child.id();
    running().push(pid);
    let r = wait_out(&mut child, out, err, what, timeout, poll);
    running().retain(|p| *p != pid);
    r
}

fn wait_out(
    child: &mut std::process::Child,
    out: mpsc::Receiver<(Vec<u8>, bool)>,
    err: mpsc::Receiver<(Vec<u8>, bool)>,
    what: &str,
    timeout: Duration,
    poll: Duration,
) -> Result<Output, Error> {
    let start = Instant::now();
    // The exit is observed WITHOUT reaping (waitid + WNOWAIT): until the child is reaped its pid, and so its group id, stays
    // reserved, so every killpg below hits our group or nothing, never an unrelated group that reused the number (P2-5).
    loop {
        match exited(child.id()) {
            Ok(true) => break,
            Ok(false) if start.elapsed() < timeout => std::thread::sleep(poll),
            Ok(false) => {
                kill_group(child);
                crate::discard::note("proc_timeout", &defaults::render("msg.log_proc_timeout", &[("what", &what), ("ms", &timeout.as_millis())]));
                return Err(Error::Timeout);
            }
            Err(e) => {
                kill_group(child);
                return Err(Error::Wait(e));
            }
        }
    }
    // the output is collected until the pipe closes within what is left of the timeout (never less than the grace), as Node's
    // spawnSync bounds the whole run by its timeout: a pipe a helper of the command closes late must not turn a finished
    // command's output into an unread one (live2 684f526, ported onto this runner)
    let until = Instant::now() + timeout.saturating_sub(start.elapsed()).max(defaults::millis("proc.read_grace_ms"));
    let collect = |rx: &mpsc::Receiver<(Vec<u8>, bool)>| rx.recv_timeout(until.saturating_duration_since(Instant::now())).ok().filter(|(_, clean)| *clean);
    match (collect(&out), collect(&err)) {
        (Some((stdout, _)), Some((stderr, _))) => match child.wait() {
            Ok(status) => Ok(Output { status, stdout, stderr }),
            Err(e) => Err(Error::Wait(e)),
        },
        _ => {
            // a process the child left behind holds a pipe: take the group down so it cannot outlive the call
            kill_group(child);
            crate::discard::note("proc_unread", &defaults::render("msg.log_proc_unread", &[("what", &what)]));
            Err(Error::Unread)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sh(script: &str) -> Command {
        let mut c = Command::new("/bin/sh");
        c.args(["-c", script]);
        c
    }

    #[test]
    fn output_over_a_pipe_buffer_never_deadlocks_and_both_streams_are_kept() {
        // review finding 12: pipes read only after exit deadlocked a child that wrote more than 64 KiB
        let o = run(sh("head -c 300000 /dev/zero; head -c 200000 /dev/zero >&2"), "test", Duration::from_secs(10), Duration::from_millis(5)).unwrap();
        assert!(o.status.success());
        assert_eq!((o.stdout.len(), o.stderr.len()), (300_000, 200_000));
    }

    /// A stand-in named `git` that behaves like `git status` on a stale index: unless GIT_OPTIONAL_LOCKS=0 it takes
    /// `index.lock` in its directory, then keeps "refreshing" for far longer than any helper timeout.
    fn fake_git(dir: &std::path::Path) -> std::path::PathBuf {
        use std::os::unix::fs::PermissionsExt;
        std::fs::create_dir_all(dir).unwrap();
        let bin = dir.join("git");
        let script = "#!/bin/sh\nif [ \"$GIT_OPTIONAL_LOCKS\" != 0 ]; then : > \"$(dirname \"$0\")/index.lock\"; fi\nsleep 30\n";
        std::fs::write(&bin, script).unwrap();
        std::fs::set_permissions(&bin, std::fs::Permissions::from_mode(0o755)).unwrap();
        bin
    }

    #[test]
    fn a_read_only_git_killed_at_its_timeout_never_leaves_index_lock() {
        let dir = std::env::temp_dir().join(format!("ah-proc-gitlock-{}", std::process::id()));
        crate::discard::harmless(std::fs::remove_dir_all(&dir));
        let bin = fake_git(&dir);
        let lock = dir.join("index.lock");
        // (the timeout leaves a freshly written script time to start on a loaded host)
        // control: without the variable the killed helper leaves the lock (what the owner saw)
        let mut bare = Command::new(&bin);
        bare.env("GIT_OPTIONAL_LOCKS", "1");
        assert!(matches!(run(bare, "test", Duration::from_millis(1500), Duration::from_millis(5)), Err(Error::Timeout)));
        assert!(lock.exists(), "the control must reproduce the stale lock");
        std::fs::remove_file(&lock).unwrap();
        // through the runner: the variable is applied, the SIGKILL at the timeout leaves nothing behind
        assert!(matches!(run(Command::new(&bin), "test", Duration::from_millis(1500), Duration::from_millis(5)), Err(Error::Timeout)));
        assert!(!lock.exists(), "a read-only git killed at its timeout left index.lock");
        crate::discard::harmless(std::fs::remove_dir_all(&dir));
    }

    #[test]
    fn apply_git_env_only_touches_git_and_never_overrides_the_caller() {
        let env_of = |c: &Command, k: &str| c.get_envs().find(|(n, _)| *n == std::ffi::OsStr::new(k)).map(|(_, v)| v.map(|v| v.to_os_string()));
        let mut g = Command::new("/usr/bin/git");
        apply_git_env(&mut g);
        assert_eq!(env_of(&g, "GIT_OPTIONAL_LOCKS"), Some(Some("0".into())));
        let mut set = Command::new("git");
        set.env("GIT_OPTIONAL_LOCKS", "1");
        apply_git_env(&mut set);
        assert_eq!(env_of(&set, "GIT_OPTIONAL_LOCKS"), Some(Some("1".into())), "an explicit value wins");
        let mut other = Command::new("ps");
        apply_git_env(&mut other);
        assert_eq!(env_of(&other, "GIT_OPTIONAL_LOCKS"), None);
    }

    #[test]
    fn a_timeout_kills_the_whole_group() {
        // review finding 8: a timeout killed only the child; its own children lived on
        let marker = std::env::temp_dir().join(format!("ah-proc-group-{}", std::process::id()));
        crate::discard::harmless(std::fs::remove_file(&marker));
        let script = format!("(sleep 1; touch '{}') & sleep 30", marker.display());
        let t = Instant::now();
        assert!(matches!(run(sh(&script), "test", Duration::from_millis(200), Duration::from_millis(5)), Err(Error::Timeout)));
        assert!(t.elapsed() < Duration::from_secs(5));
        std::thread::sleep(Duration::from_millis(1500));
        assert!(!marker.exists(), "the grandchild survived the timeout");
    }

    #[test]
    fn a_leftover_process_holding_the_pipe_cannot_hang_the_caller() {
        // review finding 7: `reader.join()` waited for EOF, which a leftover process holding stdout never sends. The output is
        // awaited within the command's own timeout (as Node's spawnSync), never past it.
        let t = Instant::now();
        let r = run(sh("(exec sleep 30) & echo partial"), "test", Duration::from_secs(1), Duration::from_millis(5));
        assert!(matches!(r, Err(Error::Unread)), "{r:?}");
        assert!(t.elapsed() < Duration::from_secs(5), "{:?}", t.elapsed());
    }

    #[test]
    fn an_exit_is_observed_without_reaping_so_the_group_id_stays_reserved() {
        // P2-5: try_wait reaped the child before the leftover-group kill, freeing the pid for reuse
        let mut c = sh("exit 3");
        c.process_group(0);
        let mut child = c.spawn().unwrap();
        let pid = child.id();
        let t = Instant::now();
        while !exited(pid).unwrap() {
            assert!(t.elapsed() < Duration::from_secs(10));
            std::thread::sleep(Duration::from_millis(5));
        }
        // SAFETY: signal 0 only checks the pid exists.
        assert_eq!(unsafe { libc::kill(pid as libc::pid_t, 0) }, 0, "still a zombie: not reaped, pid reserved");
        assert_eq!(child.wait().unwrap().code(), Some(3), "the status survives to the reap");
    }

    #[test]
    fn a_leftover_is_killed_while_the_group_is_still_ours() {
        let marker = std::env::temp_dir().join(format!("ah-proc-left-{}", std::process::id()));
        crate::discard::harmless(std::fs::remove_file(&marker));
        let r = run(sh(&format!("(sleep 1; touch '{}') & echo x", marker.display())), "test", Duration::from_millis(300), Duration::from_millis(5));
        assert!(matches!(r, Err(Error::Unread)), "{r:?}");
        std::thread::sleep(Duration::from_millis(1500));
        assert!(!marker.exists(), "the leftover outlived the kill");
    }

    #[test]
    fn a_command_that_cannot_start_is_a_spawn_error() {
        assert!(matches!(run(Command::new("/nonexistent/helper"), "test", Duration::from_secs(1), Duration::from_millis(5)), Err(Error::Spawn(_))));
    }
}
