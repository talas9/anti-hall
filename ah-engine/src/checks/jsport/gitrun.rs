//! `execFileSync('git', args, { cwd, timeout })` as the hooks call it: stdout only, `None` on any failure.
// Discard triage (E3): every `.ok()` / `unwrap_or_default()` in this file is a deliberate keep, for these reasons:
// - a missing binary is the same as an absent tool; the caller defers
// - a panicked or timed-out helper yields no output; the caller treats that as no answer
// A failure that must be seen goes through `crate::discard` instead.

use crate::defaults;
use crate::reqenv::RequestEnv;
use std::process::Command;
use std::time::Duration;

/// Run git in `cwd`; `Some(stdout)` only when it exits 0 within `timeout`. The environment is the request's (D76), never
/// the daemon's: the git variables the daemon itself inherited are removed, then the request's are set.
pub fn git(cwd: &str, args: &[&str], timeout: Duration, env: &RequestEnv) -> Option<String> {
    git_scrubbed(cwd, args, timeout, env, &[])
}

/// [`git`] with the named variables removed from the request's environment first (the identity resolver scrubs the git
/// location variables so its answer derives from the directory alone).
pub fn git_scrubbed(cwd: &str, args: &[&str], timeout: Duration, env: &RequestEnv, scrub: &[&str]) -> Option<String> {
    let mut cmd = Command::new(defaults::text("codex_handover.git_binary"));
    cmd.args(args).current_dir(cwd);
    for name in defaults::list("gitcache.bypass_env") {
        cmd.env_remove(name);
    }
    for (k, v) in env.to_map() {
        if !scrub.contains(&k.as_str()) {
            cmd.env(k, v);
        }
    }
    // bounded end to end (review finding 7): a leftover process holding stdout cannot hang the hook
    let o = crate::proc::run(cmd, defaults::text("codex_handover.git_binary"), timeout, defaults::millis("codex_handover.git_poll_ms")).ok()?;
    // execFileSync fails (ENOBUFS) when stdout exceeds its buffer limit.
    if o.stdout.len() as u64 > defaults::num("codex_handover.git_max_buffer") {
        return None;
    }
    o.status.success().then(|| String::from_utf8_lossy(&o.stdout).into_owned())
}
