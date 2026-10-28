//! The lock-holder watchdog (task #185): a shared lock file (the cargo-heavy lock) whose holder sits idle while other processes wait
//! on it blocks every lane, and nothing else sees it (the token-based sensors ignore a slow, cheap agent). Per pass, per configured
//! lock: find the holder (the top of the processes holding the lock), read the CPU of its process tree over a window, and when it was
//! idle for `idle_after_ms` with at least one waiter, wake the coordinator once per `renotify_ms` and count it. The optional
//! auto-action (SIGTERM, switch `agents.lockWatchTerm`, off by default) re-verifies the pid still holds the lock right before.
//! Everything (locks, windows, thresholds, texts, switches) is in `agent_waste.toml`.
use super::sinks::{Reminder, Sink, WakeFeed};
use super::{Env, State, fmtn, kind_name, procs};
use crate::defaults::{self, V};
use crate::telemetry::event::Outcome;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

/// What the watchdog remembers about one lock between passes.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct LockWatch {
    /// The holder it is tracking (0 = none).
    pub holder: u32,
    /// Accumulated CPU of the holder's tree at the last reading, ms.
    pub cpu_ms: u64,
    /// When that reading was taken.
    pub at: u64,
    /// Since when the holder has been idle (0 = not idle).
    pub idle_since: u64,
    /// When the coordinator was last alerted about this holder.
    pub alerted_at: u64,
    /// The auto-action was sent for this holder.
    pub termed: bool,
}

fn lim(k: &str) -> u64 {
    defaults::raw("lock_watch.limits").get(k).and_then(V::as_integer).unwrap_or(0).max(0) as u64
}
fn word(k: &str) -> &'static str {
    defaults::raw("lock_watch.words").str_field(k)
}

/// The configured lock files that exist (`~/` expanded, one `*` in the file name).
fn lock_files(env: &Env) -> Vec<PathBuf> {
    let mut out = Vec::new();
    for pat in defaults::raw("lock_watch.locks").strings() {
        let full = match pat.strip_prefix("~/") {
            Some(r) => env.home.join(r),
            None => PathBuf::from(pat),
        };
        let (Some(dir), Some(name)) = (full.parent(), full.file_name().and_then(|n| n.to_str())) else { continue };
        let Some((pre, post)) = name.split_once('*') else {
            if full.is_file() {
                out.push(full);
            }
            continue;
        };
        let Ok(rd) = std::fs::read_dir(dir) else { continue };
        let mut hit: Vec<PathBuf> = rd
            .flatten()
            .filter(|e| e.file_name().to_str().is_some_and(|n| n.len() >= pre.len() + post.len() && n.starts_with(pre) && n.ends_with(post)))
            .map(|e| e.path())
            .collect();
        hit.sort();
        out.extend(hit);
    }
    out
}

/// The session to wake: the main session that was active last (the same pick a heartbeat uses).
fn coordinator(st: &State) -> Option<String> {
    st.agents.values().filter(|m| m.kind == kind_name("main")).max_by_key(|m| m.last_output_ms).map(|m| m.id.clone())
}

/// One watchdog pass (throttled by `interval_ms`).
pub(crate) fn tick(env: &Env, st: &mut State) {
    if !env.act {
        return;
    }
    if !env.switch("lock_watch.setting") {
        st.locks.clear();
        return;
    }
    if env.now_ms.saturating_sub(st.lock_checked) < lim("interval_ms") {
        return;
    }
    st.lock_checked = env.now_ms;
    let files = lock_files(env);
    st.locks.retain(|k, _| files.iter().any(|f| f.to_string_lossy() == *k));
    if files.is_empty() {
        return;
    }
    let table = procs::snapshot();
    for f in files {
        let key = f.to_string_lossy().into_owned();
        check(env, st, &table, &key);
    }
}

fn check(env: &Env, st: &mut State, table: &[procs::Proc], lock: &str) {
    let now = env.now_ms;
    let open = procs::openers(lock);
    // a lock the kernel reports (flock on Linux) names its holders; where it does not (BSD `lockf` blocks in open(2), so only the
    // holder has the file open) every opener is a holder
    let reported = open.iter().any(|o| o.holds);
    let held: Vec<u32> = open.iter().filter(|o| o.holds || !reported).map(|o| o.pid).collect();
    let ppid = |pid: u32| table.iter().find(|p| p.pid == pid).map_or(0, |p| p.ppid);
    // the holder is the top of the locked processes: the one whose parent does not hold the lock too
    let Some(top) = held.iter().copied().find(|p| !held.contains(&ppid(*p))) else {
        st.locks.remove(lock);
        return;
    };
    let tree = procs::tree(table, top);
    let inside = |pid: u32| tree.iter().any(|p| p.pid == pid);
    // a waiter is a lock-wrapper process (config list) of this lock that is not the holder or below it
    let wrappers = defaults::raw("lock_watch.waiters").strings();
    let waiting = |p: &procs::Proc| {
        let first = p.cmd.split_whitespace().next().unwrap_or("");
        let name = first.rsplit('/').next().unwrap_or("");
        wrappers.contains(&name) && p.cmd.contains(lock) && !held.contains(&p.pid) && !inside(p.pid)
    };
    let waiters = table.iter().filter(|p| waiting(p)).count() as u64;
    let cmd = open.iter().find(|o| o.pid == top).map(|o| o.cmd.clone()).unwrap_or_default();
    let cpu = procs::cpu_of(&tree);
    let w = st.locks.entry(lock.to_string()).or_default();
    if w.holder != top {
        *w = LockWatch { holder: top, cpu_ms: cpu.0, at: now, ..Default::default() };
        return;
    }
    match procs::idle_since((w.cpu_ms, w.at), cpu, now, lim("min_span_ms"), lim("idle_pm")) {
        Some(true) => {
            if w.idle_since == 0 {
                w.idle_since = w.at;
            }
        }
        Some(false) => w.idle_since = 0,
        None => return, // too soon for a rate: keep the baseline
    }
    w.cpu_ms = cpu.0;
    w.at = now;
    let idle_for = if w.idle_since == 0 { 0 } else { now.saturating_sub(w.idle_since) };
    if waiters == 0 || idle_for < lim("idle_after_ms") {
        return;
    }
    let mut note = String::new();
    if !w.termed && idle_for >= lim("term_after_ms") && env.switch("lock_watch.term_setting") && terminate(lock, top, &cmd) {
        w.termed = true;
        note = defaults::render("msg.lock_stall_term", &[("pid", &top)]);
        super::signals::rec(
            env,
            word("class"),
            word("term"),
            Outcome::Advise,
            crate::telemetry::event::Fields::new().num("pid", top as u64).num("idle_s", idle_for / fmtn("ms_per_s")),
        );
    }
    if w.alerted_at != 0 && now.saturating_sub(w.alerted_at) < lim("renotify_ms") && note.is_empty() {
        return;
    }
    w.alerted_at = now;
    st.day(env).lock_stalls += 1;
    let text = defaults::render(
        "msg.lock_stall",
        &[("lock", &lock), ("pid", &top), ("cmd", &cmd), ("idle_min", &(idle_for / fmtn("ms_per_s") / 60)), ("waiters", &waiters), ("term", &note)],
    );
    let target = coordinator(st);
    let delivered = target.as_ref().map(|k| {
        let r = Reminder {
            id: format!("{:x}", crate::health::fnv(&format!("{lock}{top}{now}"))),
            ts: now,
            signal: word("signal").into(),
            agent: top.to_string(),
            text: text.clone(),
        };
        WakeFeed.deliver(env, k, &r).is_ok()
    });
    super::signals::rec(
        env,
        word("class"),
        word("stall"),
        if delivered == Some(true) { Outcome::Advise } else { Outcome::Skip },
        crate::telemetry::event::Fields::new().num("pid", top as u64).num("idle_s", idle_for / fmtn("ms_per_s")).num("waiters", waiters),
    );
}

/// SIGTERM `pid` after re-reading that it still holds `lock` and still runs the same command.
fn terminate(lock: &str, pid: u32, cmd: &str) -> bool {
    let still = procs::openers(lock).iter().any(|o| o.pid == pid && o.holds && o.cmd == cmd);
    // SAFETY: kill(2) with a verified pid and SIGTERM; no memory is touched.
    still && unsafe { libc::kill(pid as libc::pid_t, libc::SIGTERM) } == 0
}
