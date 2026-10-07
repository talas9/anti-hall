//! `execFileSync('git', args, { cwd, timeout })` as the hooks call it: stdout only, `None` on any failure.
// Discard triage (E3): every `.ok()` / `unwrap_or_default()` in this file is a deliberate keep, for these reasons:
// - a missing binary is the same as an absent tool; the caller defers
// - a panicked or timed-out helper yields no output; the caller treats that as no answer
// A failure that must be seen goes through `crate::discard` instead.

use crate::defaults;
use crate::reqenv::RequestEnv;
use std::io::Read;
use std::os::unix::process::CommandExt;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

/// Run git in `cwd`; `Some(stdout)` only when it exits 0 within `timeout`. The environment is the request's (D76), never
/// the daemon's: the git variables the daemon itself inherited are removed, then the request's are set.
pub fn git(cwd: &str, args: &[&str], timeout: Duration, env: &RequestEnv) -> Option<String> {
    git_scrubbed(cwd, args, timeout, env, &[])
}

/// [`git`] with the named variables removed from the request's environment first (the identity resolver scrubs the git
/// location variables so its answer derives from the directory alone).
pub fn git_scrubbed(cwd: &str, args: &[&str], timeout: Duration, env: &RequestEnv, scrub: &[&str]) -> Option<String> {
    let mut cmd = Command::new(defaults::text("codex_handover.git_binary"));
    cmd.args(args).current_dir(cwd).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::null()).process_group(0);
    for name in defaults::list("gitcache.bypass_env") {
        cmd.env_remove(name);
    }
    for (k, v) in env.to_map() {
        if !scrub.contains(&k.as_str()) {
            cmd.env(k, v);
        }
    }
    let mut child = cmd.spawn().ok()?;
    let pid = child.id() as i32;
    let mut out = child.stdout.take()?;
    let reader = std::thread::spawn(move || {
        let mut b = Vec::new();
        crate::discard::harmless(out.read_to_end(&mut b)); // keep: reaping or draining a child or thread that already ended
        b
    });
    let start = Instant::now();
    let status = loop {
        match child.try_wait() {
            Ok(Some(st)) => break st,
            Ok(None) if start.elapsed() < timeout => std::thread::sleep(defaults::millis("codex_handover.git_poll_ms")),
            Ok(None) | Err(_) => {
                // SAFETY: the pid is our own child's process group.
                unsafe { libc::kill(-pid, libc::SIGKILL) };
                crate::discard::harmless(child.wait()); // keep: reaping or draining a child or thread that already ended
                crate::discard::harmless(reader.join()); // keep: reaping or draining a child or thread that already ended
                return None;
            }
        }
    };
    let bytes = reader.join().unwrap_or_default();
    // execFileSync fails (ENOBUFS) when stdout exceeds its buffer limit.
    if bytes.len() as u64 > defaults::num("codex_handover.git_max_buffer") {
        return None;
    }
    status.success().then(|| String::from_utf8_lossy(&bytes).into_owned())
}
