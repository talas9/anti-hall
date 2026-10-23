//! `--selftest`: exit 0 only if the launcher's settings, socket path, engine binary and limits are all sane.
//! The engine updater runs it (with `--engine <new binary>`) before an atomic swap.

use crate::builtin;
use crate::cfg::Settings;
use crate::limits;
use crate::proc::{self, Feed, Opts, Retry, Run};
use crate::util::{env_nonempty, is_exec, say};
use std::path::{Path, PathBuf};
use std::time::Duration;

struct Report<'a> {
    s: &'a Settings,
    failed: u32,
}

impl Report<'_> {
    fn ok(&self, check: &str) {
        say(&self.s.msg("msg.launcher_selftest_ok", &[("check", check)]));
    }
    fn fail(&mut self, check: &str, why: &str) {
        self.failed += 1;
        say(&self.s.msg(
            "msg.launcher_selftest_fail",
            &[("check", check), ("why", why)],
        ));
    }
    fn verdict(&mut self, check: &str, r: Result<(), String>) {
        match r {
            Ok(()) => self.ok(check),
            Err(why) => self.fail(check, &why),
        }
    }
}

/// Every key the built-in copy holds must be present in the shipped files with the same type, and the numbers must be coherent.
fn check_config(s: &Settings) -> Result<(), String> {
    if !s.bad_files.is_empty() {
        return Err(s.msg(
            "msg.launcher_st_unusable",
            &[("files", &s.bad_files.join(","))],
        ));
    }
    let mut missing = Vec::new();
    for (k, _) in builtin::NUMS {
        if s.shipped(k).and_then(|v| v.as_integer()).is_none() {
            missing.push(*k);
        }
    }
    for (k, _) in builtin::STRS {
        if s.shipped(k).and_then(|v| v.as_str()).is_none() {
            missing.push(*k);
        }
    }
    for (k, _) in builtin::LISTS {
        if s.shipped(k).and_then(|v| v.as_array()).is_none() {
            missing.push(*k);
        }
    }
    if !missing.is_empty() {
        return Err(s.msg("msg.launcher_st_missing", &[("keys", &missing.join(","))]));
    }
    let n = |k: &str| s.num(k);
    let coherent = [
        (
            "stdin_soft<=hard",
            n("launcher.stdin_soft_bytes") <= n("launcher.stdin_hard_bytes"),
        ),
        (
            "mem_soft<=hard",
            n("launcher.mem_soft_bytes") <= n("launcher.mem_hard_bytes"),
        ),
        (
            "log_soft<=hard",
            n("launcher.log_soft_bytes") <= n("launcher.log_hard_bytes"),
        ),
        (
            "io_chunk<=prefix",
            n("launcher.io_chunk_bytes") <= n("launcher.payload_prefix_bytes"),
        ),
        (
            "buffers<mem_hard",
            n("launcher.payload_prefix_bytes")
                + n("launcher.out_cap_bytes")
                + n("launcher.err_cap_bytes")
                < n("launcher.mem_hard_bytes"),
        ),
        ("cpu_hard>0", n("launcher.cpu_hard_s") > 0),
        (
            "deadline>0",
            n("client.deadline_ms") > 0 && n("client.wrapper_extra_ms") > 0,
        ),
        ("hosts", !s.list("launcher.hosts").is_empty()),
    ];
    let bad: Vec<&str> = coherent
        .iter()
        .filter(|(_, ok)| !ok)
        .map(|(name, _)| *name)
        .collect();
    if bad.is_empty() {
        Ok(())
    } else {
        Err(format!("incoherent: {}", bad.join(",")))
    }
}

fn check_socket(s: &Settings, state_dir: &Path) -> Result<(), String> {
    if state_dir.as_os_str().is_empty() {
        return Err(s.text("msg.launcher_st_no_state"));
    }
    let sock = state_dir.join(s.text("paths.socket_file"));
    let max = s.num("paths.socket_max_len");
    let len = sock.as_os_str().len() as u64;
    if max == 0 || len > max {
        return Err(s.msg(
            "msg.launcher_st_socket_len",
            &[("len", &len.to_string()), ("max", &max.to_string())],
        ));
    }
    Ok(())
}

fn check_engine(s: &Settings, state_dir: &Path, engine: Option<String>) -> Result<(), String> {
    let path: PathBuf = match engine {
        Some(p) => PathBuf::from(p),
        None => {
            let home = env_nonempty(&s.text("env.home")).map(PathBuf::from);
            let installed = home.map(|h| {
                h.join(s.text("paths.base_dir"))
                    .join(s.text("paths.state_dir"))
                    .join(s.text("launcher.engine_bin_rel"))
            });
            let _ = state_dir;
            match installed.filter(|p| is_exec(p)) {
                Some(p) => p,
                None => return Err(s.text("msg.launcher_st_no_engine")),
            }
        }
    };
    if !is_exec(&path) {
        return Err(s.msg(
            "msg.launcher_st_not_exec",
            &[("path", &path.display().to_string())],
        ));
    }
    let argv = [path.display().to_string(), "version".to_string()];
    let ms = s.num("launcher.selftest_engine_timeout_ms");
    let r = proc::run_child(&Opts {
        argv: &argv,
        envs: &[],
        env_remove: &[],
        feed: Feed::memory(
            b"",
            Duration::from_millis(s.num("launcher.write_timeout_ms")),
            s.num("launcher.io_chunk_bytes") as usize,
        ),
        budget: Duration::from_millis(ms),
        wait_file: None,
        done_file: None,
        slow_max: Duration::ZERO,
        grace: Duration::from_millis(s.num("client.wrapper_kill_grace_ms")),
        strict_group: true,
        out_cap: s.num("launcher.err_cap_bytes") as usize,
        err_cap: s.num("launcher.err_cap_bytes") as usize,
        retry: Retry {
            max: s.num("launcher.spawn_retry_max"),
            base_ms: s.num("launcher.spawn_backoff_base_ms"),
            cap_ms: s.num("launcher.spawn_backoff_cap_ms"),
            jitter_pct: s.num("launcher.spawn_jitter_pct"),
        },
        drain: Duration::from_millis(s.num("launcher.io_drain_ms")),
        reaper: None,
    });
    match r {
        Run::Exited { code: 0, out, .. } if !out.is_empty() => Ok(()),
        Run::Exited { code: 0, .. } => Err(s.text("msg.launcher_st_ver_empty")),
        Run::Exited { code, .. } => {
            Err(s.msg("msg.launcher_st_ver_exit", &[("code", &code.to_string())]))
        }
        Run::TimedOut | Run::GroupAlive => {
            Err(s.msg("msg.launcher_st_ver_timeout", &[("ms", &ms.to_string())]))
        }
        Run::SpawnFailed { errno } => Err(s.msg(
            "msg.launcher_st_cannot_start",
            &[("errno", &errno.unwrap_or(0).to_string())],
        )),
    }
}

fn check_limits(s: &Settings) -> Result<(), String> {
    if s.num("launcher.mem_hard_bytes") <= limits::mem_now() as u64 {
        return Err(s.text("msg.launcher_st_mem_below"));
    }
    if !limits::arm_wall(
        s.num("launcher.selftest_engine_timeout_ms")
            .saturating_mul(4),
    ) {
        return Err(s.text("msg.launcher_st_no_wall"));
    }
    // the timer is re-armed per call; disarm this probe
    // SAFETY: setitimer with a zero value cancels the timer.
    unsafe {
        let off: libc::itimerval = std::mem::zeroed();
        libc::setitimer(libc::ITIMER_REAL, &off, std::ptr::null_mut());
    }
    Ok(())
}

pub fn run(s: &Settings, _root: Option<&Path>, state_dir: &Path, engine: Option<String>) -> i32 {
    let mut r = Report { s, failed: 0 };
    r.verdict("config", check_config(s));
    r.verdict("socket", check_socket(s, state_dir));
    r.verdict("engine", check_engine(s, state_dir, engine));
    r.verdict("limits", check_limits(s));
    i32::from(r.failed > 0)
}
