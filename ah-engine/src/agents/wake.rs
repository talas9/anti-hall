//! `ah-engine agents wake-watch [--auto]`: the wake Monitor of a session. The host runs it as a Monitor (armed at SessionStart by the
//! plugin's monitor entry): every line it prints on stdout is an event delivered to the session, so a session that went idle is woken
//! when the tracker queues a wake row for it (an agent idle with an open task, a looping or burning agent, a watched process that
//! ended). It only stats and reads one file of its own session while quiet: no tokens, no commands.
//!
//! The tracker writes the rows ([`super::sinks::WakeFeed`]); this process only reads them, prints each once, and renews a stamp that
//! tells the tracker the session can be woken (the `monitor_unarmed` signal reads it). Everything it says, waits and names is config.
use super::sinks::WakeFeed;
use super::{Env, lim, pth};
use crate::cli::Parsed;
use crate::defaults;
use serde_json::Value;
use std::io::Write;
use std::path::Path;
use std::time::Duration;

fn setting_num(key: &str) -> u64 {
    defaults::num(key).max(1)
}

/// The session this watcher belongs to: the first of the configured variables that is set.
fn session(env: &Env) -> Option<String> {
    defaults::list("agent_tracker.wake_session_env")
        .into_iter()
        .filter_map(|v| env.settings.env.get(v).cloned())
        .find(|s| !s.trim().is_empty())
        .or_else(|| session_from_tree(env, std::process::id()))
}

/// A Monitor's shell carries no session variable: walk up from `start` (at most `wake_walk_depth` parents) to the process the host
/// registered for a session and take its session id.
pub(crate) fn session_from_tree(env: &Env, start: u32) -> Option<String> {
    let sessions = super::live::registry(env)?;
    let mut pid = start;
    for _ in 0..=defaults::num("agent_tracker.wake_walk_depth") {
        if let Some(s) = sessions.iter().find(|s| s.pid == pid) {
            return Some(s.id.clone());
        }
        pid = crate::procid::parent(pid).filter(|p| *p > 1)?;
    }
    None
}

fn parent_gone(start: i32) -> bool {
    if start <= 0 {
        return false;
    }
    // SAFETY: getppid(2) takes no arguments and cannot fail.
    let cur = unsafe { libc::getppid() };
    cur != start || cur == 1
}

fn stamp(path: &Path, now: u64) {
    if let Some(d) = path.parent() {
        crate::discard::harmless(std::fs::create_dir_all(d)); // keep: the write below reports a missing directory
    }
    let body = serde_json::json!({"pid": std::process::id(), "ts": now}).to_string();
    crate::discard::harmless(crate::atomic::write(path, body)); // keep: a missed stamp only makes the next tick re-stamp
}

/// Atomic per-session ownership; a crashed watcher releases the flock automatically.
fn acquire(stamp: &Path) -> Option<std::fs::File> {
    use std::os::unix::fs::OpenOptionsExt;
    let parent = stamp.parent()?;
    std::fs::create_dir_all(parent).ok()?;
    let lock = crate::paths::lock_for(stamp);
    let file = std::fs::OpenOptions::new().create(true).truncate(false).read(true).write(true).custom_flags(libc::O_NOFOLLOW).open(lock).ok()?;
    crate::health::flock(&file, libc::LOCK_EX | libc::LOCK_NB).then_some(file)
}

/// Another live watcher already holds a fresh stamp for this session.
fn held_elsewhere(env: &Env, path: &Path) -> bool {
    let fresh = crate::checks::agent_scan::mtime_ms(path).is_some_and(|m| env.now_ms.saturating_sub(m as u64) <= lim("stale_lock_ms"));
    let pid = std::fs::read_to_string(path).ok().and_then(|t| serde_json::from_str::<Value>(&t).ok()).and_then(|v| v["pid"].as_u64());
    fresh && pid.is_some_and(|p| p as u32 != std::process::id() && crate::health::pid_alive(p as u32))
}

fn emit(line: &str) {
    let mut out = std::io::stdout().lock();
    crate::discard::harmless(out.write_all(format!("{line}\n").as_bytes())); // keep: a closed pipe ends the parent check, not the loop
    crate::discard::harmless(out.flush()); // keep: same
}

/// New complete rows of the feed since `offset`; returns the rows with the line to print for each, and the new offset.
fn drain(feed: &Path, offset: u64) -> (Vec<(Value, String)>, u64) {
    let Ok(t) = std::fs::read(feed) else { return (Vec::new(), offset) };
    let len = t.len() as u64;
    if len < offset {
        return (Vec::new(), 0);
    }
    let tail = &t[offset as usize..];
    let end = tail.iter().rposition(|b| *b == b'\n').map_or(0, |i| i + 1);
    let lines = String::from_utf8_lossy(&tail[..end])
        .lines()
        .filter_map(|l| serde_json::from_str::<Value>(l).ok())
        .filter_map(|v| {
            let line = v["text"].as_str().map(|t| defaults::render("msg.agent_wake_line", &[("text", &t)]))?;
            Some((v, line))
        })
        .collect();
    (lines, offset + end as u64)
}

/// Record a printed wake row as delivered, in the same file and shape the `agent-reminders` check writes, so the tick stamps the
/// flag's `delivered_at` for a wake delivery too (it read only the hook's deliveries before, and a woken idle session never showed one).
fn record(env: &Env, sid: &str, v: &Value, now: u64) {
    let row = serde_json::json!({"id": v["id"], "key": super::sinks::key_of(sid), "signal": v["signal"], "agent": v["agent"], "ts": now, "channel": super::chan("wake")});
    crate::discard::harmless(super::sinks::append(&env.dir().join(pth("delivered")), &row)); // keep: a lost row only leaves delivered_at at 0
}

/// Run the watcher until the process that started it is gone. Returns the exit code.
pub(crate) fn run(p: &Parsed) -> i32 {
    let auto = p.rest.iter().any(|a| a == defaults::text("agent_tracker.wake_flag_auto"));
    let Some(env) = Env::current() else { return 0 };
    let refuse = |why: &str| {
        if !auto {
            emit(&defaults::render("msg.agent_wake_refused", &[("reason", &why)]));
        }
        0
    };
    if !env.switch("agent_tracker.setting") || !env.switch("agent_tracker.wake_setting") {
        return refuse(defaults::text("msg.agent_wake_reason_off"));
    }
    let Some(sid) = session(&env) else { return refuse(defaults::text("msg.agent_wake_reason_no_session")) };
    let armed = WakeFeed::stamp(&env, &sid);
    // Hold a kernel lock for the whole watcher lifetime: the old check-then-stamp race let two starters both enter pump.
    // The separate stable inode stays locked while the JSON stamp is atomically replaced by each renewal.
    let Some(lease) = acquire(&armed) else { return refuse(defaults::text("msg.agent_wake_reason_held")) };
    if held_elsewhere(&env, &armed) {
        return refuse(defaults::text("msg.agent_wake_reason_held"));
    }
    // SAFETY: getppid(2) takes no arguments and cannot fail.
    let start_ppid = unsafe { libc::getppid() };
    let poll = Duration::from_millis(setting_num("agent_tracker.wake_poll_ms"));
    crate::web::actions::register(&format!("{}-{}", defaults::text("act.watcher_name"), super::sinks::key_of(&sid)), defaults::text("act.watcher_kind"), &[]);
    // The engine binary this watcher started from: when a deploy or an update replaces it, the watcher hands over to the new one (the
    // same module and semantics as the DevSwarm watcher), so a long session never pins an old build.
    let rebin = Rebin::start(crate::health::now_ms());
    let stop = || parent_gone(start_ppid) || rebin.due_and_changed(crate::health::now_ms());
    pump(&env, &sid, poll, &mut |l| emit(l), &stop);
    if rebin.changed.get() && !parent_gone(start_ppid) {
        return rebin_exec(lease, rebin.path());
    }
    0
}

/// The watcher's check that the engine binary it started from was replaced on disk (`agent_tracker.wake_rebin_*`).
struct Rebin {
    /// The binary's path and identity at start; `None` when the switch is off or the identity cannot be read (then it never hands over).
    bin: Option<(std::path::PathBuf, crate::wakew::rebin::Ident)>,
    every_ms: u64,
    last_ms: std::cell::Cell<u64>,
    /// Set once the check saw a replaced binary, so the caller hands over after the loop has flushed.
    changed: std::cell::Cell<bool>,
}

impl Rebin {
    fn start(now_ms: u64) -> Rebin {
        let bin = (defaults::num("agent_tracker.wake_rebin_enabled") != 0)
            .then(crate::wakew::rebin::watched_path)
            .flatten()
            .and_then(|path| crate::wakew::rebin::ident(&path).map(|i| (path, i)));
        Rebin { bin, every_ms: setting_num("agent_tracker.wake_rebin_check_ms"), last_ms: std::cell::Cell::new(now_ms), changed: std::cell::Cell::new(false) }
    }

    fn path(&self) -> &Path {
        self.bin.as_ref().map_or(Path::new(""), |(p, _)| p)
    }

    /// True (and remembered) when the check is due at `now_ms` and the binary is a different generation than at start.
    fn due_and_changed(&self, now_ms: u64) -> bool {
        let Some((path, start)) = &self.bin else { return false };
        if now_ms.saturating_sub(self.last_ms.get()) < self.every_ms {
            return false;
        }
        self.last_ms.set(now_ms);
        let changed = crate::wakew::rebin::changed(path, Some(*start));
        self.changed.set(changed);
        changed
    }
}

/// Replace this process with the engine binary now at `path`, same arguments, same stdio. The lease is released first (the successor
/// takes it itself), and the rows the loop held were flushed before the loop returned. When the exec fails a line says so and the
/// watcher ends: never a silent stale one.
fn rebin_exec(lease: std::fs::File, path: &Path) -> i32 {
    use std::os::unix::process::CommandExt;
    drop(lease);
    emit(&defaults::render("wake_watch.line_rebin", &[("path", &path.display())]));
    crate::metrics::bump_shared("wake_rebin", &[("result", "exec")]);
    crate::telemetry::emit::flush();
    let err = std::process::Command::new(path)
        .args(std::env::args().skip(1))
        .env(defaults::text("wake_watch.env_rebin"), (crate::health::now_ms() / 1000).to_string())
        .exec(); // only returns on failure
    crate::metrics::bump_shared("wake_rebin", &[("result", "exec_failed")]);
    crate::telemetry::emit::flush();
    eprint!("{}", defaults::render("wake_watch.diag_rebin_failed", &[("path", &path.display()), ("why", &err)]));
    1
}

/// The loop of the watcher: renew the stamp, print each new row of the session's feed once, stop when `stop` says so. Rows from before
/// the watcher armed are not replayed (the reminder queue still delivers them at the next turn).
pub(crate) fn pump(env: &Env, sid: &str, poll: Duration, out: &mut dyn FnMut(&str), stop: &dyn Fn() -> bool) {
    let (feed, armed) = (WakeFeed::file(env, sid), WakeFeed::stamp(env, sid));
    let mut offset = std::fs::metadata(&feed).map(|m| m.len()).unwrap_or(0);
    let every = setting_num("agent_tracker.wake_stamp_ms");
    let mut last_stamp = 0u64;
    let mut window_ms = coalesce_ms(env);
    // rows drained but not yet printed: (row, its line, when it was drained)
    let mut held: Vec<(Value, String, u64)> = Vec::new();
    loop {
        let now = crate::health::now_ms();
        if now.saturating_sub(last_stamp) >= every {
            stamp(&armed, now);
            last_stamp = now;
            window_ms = coalesce_ms(env); // re-read with the stamp: a changed setting applies without a restart
        }
        let (lines, next) = drain(&feed, offset);
        for (v, l) in lines {
            if window_ms == 0 {
                out(&l);
                record(env, sid, &v, now);
            } else {
                held.push((v, l, now));
            }
        }
        if held.first().is_some_and(|(_, _, first)| now.saturating_sub(*first) >= window_ms) {
            flush(env, sid, &mut held, now, out);
        }
        if next != offset {
            offset = next;
            let mut cur = feed.clone().into_os_string();
            cur.push(pth("cursor_ext"));
            crate::discard::harmless(crate::atomic::write_styled(
                cur,
                drain_count(&feed, offset).to_string(),
                crate::atomic::Style { skip_sync: true, ..Default::default() },
            )); // keep: only delays the compaction of the feed
        }
        if stop() {
            flush(env, sid, &mut held, now, out); // rows held for the window are not dropped with the watcher
            crate::discard::harmless(std::fs::remove_file(&armed)); // keep: a stale stamp expires on its own
            return;
        }
        std::thread::sleep(poll);
    }
}

/// The coalescing window in milliseconds (`agents.wakeCoalesceSeconds`; 0 = print every row at once).
fn coalesce_ms(env: &Env) -> u64 {
    let secs = crate::checks::guardkit::settings::get_num(&env.settings, defaults::raw("agent_tracker.wake_coalesce_setting"));
    (secs.max(0.0) * 1000.0) as u64
}

/// Print what was held: one row as its own line, several as ONE coalesced line that counts rows per agent. Every row is recorded as
/// delivered, as a row printed at once is.
fn flush(env: &Env, sid: &str, held: &mut Vec<(Value, String, u64)>, now: u64, out: &mut dyn FnMut(&str)) {
    let rows = std::mem::take(held);
    if let [(v, l, _)] = rows.as_slice() {
        out(l);
        record(env, sid, v, now);
        return;
    }
    let Some(first) = rows.first().map(|r| r.2) else { return };
    let last = rows.last().map_or(first, |r| r.2);
    out(&merged(&rows, last.saturating_sub(first)));
    for (v, _, _) in &rows {
        record(env, sid, v, now);
    }
}

/// The one line for several wake rows: rows per agent, with each agent's distinct signals, in order of first appearance.
fn merged(rows: &[(Value, String, u64)], span_ms: u64) -> String {
    let mut per: Vec<(String, u64, Vec<String>)> = Vec::new();
    for (v, _, _) in rows {
        let (agent, signal) = (v["agent"].as_str().unwrap_or_default(), v["signal"].as_str().unwrap_or_default());
        let i = per.iter().position(|(a, _, _)| a == agent).unwrap_or_else(|| {
            per.push((agent.to_string(), 0, Vec::new()));
            per.len() - 1
        });
        per[i].1 += 1;
        if !per[i].2.iter().any(|x| x == signal) {
            per[i].2.push(signal.to_string());
        }
    }
    let cfg = defaults::raw("agent_tracker.wake_merge");
    let items: Vec<String> = per
        .iter()
        .map(|(agent, n, signals)| {
            defaults::render("msg.agent_wake_merged_item", &[("agent", agent), ("n", n), ("signals", &signals.join(cfg.str_field("signal_sep")))])
        })
        .collect();
    defaults::render("msg.agent_wake_merged", &[("n", &rows.len()), ("secs", &span_ms.div_ceil(1000)), ("items", &items.join(cfg.str_field("item_sep")))])
}

/// Lines in the feed up to `offset` (the cursor file counts rows, like the reminder queue's).
fn drain_count(feed: &Path, offset: u64) -> u64 {
    std::fs::read(feed).map(|t| t[..(offset as usize).min(t.len())].iter().filter(|b| **b == b'\n').count() as u64).unwrap_or(0)
}

#[cfg(test)]
mod rebin_tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    fn exe(path: &Path, body: &[u8]) {
        std::fs::write(path, body).unwrap();
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755)).unwrap();
    }

    /// A watcher whose binary lives in a HOME-isolated temp directory (never the real HOME or the live engine).
    fn started(tag: &str, enabled_every: Option<u64>) -> (std::path::PathBuf, Rebin) {
        crate::defaults::init().unwrap();
        let dir = std::env::temp_dir().join(format!("wake-rebin-{tag}-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let bin = dir.join("ah-engine");
        exe(&bin, b"one");
        let mut r = Rebin::start(0);
        // the unit under test is the check, so it is pointed at the temp binary instead of this test executable
        r.bin = crate::wakew::rebin::ident(&bin).map(|i| (bin.clone(), i)).filter(|_| enabled_every.is_some());
        r.every_ms = enabled_every.unwrap_or(1);
        (bin, r)
    }

    fn replace(bin: &Path) {
        let next = bin.with_extension("next");
        exe(&next, b"two!");
        std::fs::rename(&next, bin).unwrap();
    }

    #[test]
    fn a_stale_watcher_hands_over_and_a_current_one_keeps_running() {
        let (bin, r) = started("stale", Some(100));
        assert!(!r.due_and_changed(1_000), "an untouched binary is no change");
        assert!(!r.changed.get());
        replace(&bin);
        assert!(r.due_and_changed(2_000), "a replaced binary is a hand-over");
        assert!(r.changed.get());
        assert_eq!(r.path(), bin);
    }

    #[test]
    fn the_check_runs_at_its_interval_only() {
        let (bin, r) = started("interval", Some(5_000));
        replace(&bin);
        assert!(!r.due_and_changed(4_999), "not due yet: no stat, no hand-over");
        assert!(r.due_and_changed(5_000));
    }

    #[test]
    fn switched_off_it_never_hands_over() {
        let (bin, r) = started("off", None);
        replace(&bin);
        assert!(!r.due_and_changed(1_000_000));
        assert!(!r.changed.get());
    }

    #[test]
    fn the_shipped_switch_is_on_and_a_zero_turns_it_off() {
        crate::defaults::init().unwrap();
        assert_eq!(defaults::num("agent_tracker.wake_rebin_enabled"), 1);
        assert!(defaults::num("agent_tracker.wake_rebin_check_ms") >= 1);
    }
}
