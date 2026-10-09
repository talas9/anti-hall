//! `ah-engine devswarm wake-watch [--auto]`: the DevSwarm idle-wake Monitor, in the engine. Port of
//! `companion/lib/devswarm-wake-watch.js` (which the plugin's `monitors/monitors.json` ran as a Node process for the whole
//! session).
//!
//! # The protocol
//!
//! The host runs the command as a Monitor: every line the process prints on stdout is an event delivered to the session, so
//! a line is printed only for an arm notice, new mail, a persistent read error, a refusal to arm, a newer build or a handoff.
//! Lifecycle diagnostics go to stderr. The lines, their order and the exit codes are the Node watcher's own.
//!
//! # What it reads
//!
//! Only plain files: the project's summary (`summaries/<hash>.json`) for the direct and broadcast channels and, for a child,
//! its durable NDJSON inbox. It never opens the SQLite store, and runs no command that consumes or acknowledges mail (a
//! watcher that did would erase its own trigger).
//!
//! # Timing
//!
//! Node polls every `devswarm.wakeWatchPollMs`. The engine keeps that tick for everything that is not a file change (the lock
//! heartbeat, the parent-death check, the stale-build check, the archived re-check) and, in addition, wakes the tick early when
//! the realtime watch layer (`crate::watch`: OS events, polling on a filesystem without them) reports a change of the files it
//! reads, so mail is announced within the layer's debounce instead of the poll interval. An early wake only happens while the
//! reads are healthy, so the error back-off, which counts ticks, is exactly Node's.
//!
//! # What stays with Node
//!
//! Anything the engine cannot answer exactly as Node does is decided before a single line is printed or file is written, and
//! the verb answers exit 75 (the launcher then runs the Node script): a checkout nested in another one, a settings file the
//! engine cannot parse as JavaScript does, and a Primary with no live child (Node prints its one idle line and records the
//! metric). After the first line nothing defers; every later failure takes the fail-open path Node takes.
pub mod arch;
pub mod edge;
pub mod read;
pub mod stale;
pub mod who;

use crate::checks::git::util::Settings;
use crate::checks::guardkit::nodelock::{self, Extra, Held, Refresh};
use crate::defaults;
use crate::meshw::idlock::devswarm_root;
use crate::watch::poll::Filter;
use crate::watch::{Config as WatchConfig, Watcher};
use edge::{Snapshot, State};
use read::Hashes;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use who::{Identity, Proc};

fn text(key: &str) -> &'static str {
    defaults::text(key)
}

/// A line on stdout, the watcher's event channel. A closed pipe is not an error here: the loop keeps going.
fn emit(line: &str) {
    let mut out = std::io::stdout().lock();
    let line = if line.ends_with('\n') { line.to_string() } else { format!("{line}\n") };
    crate::discard::harmless(out.write_all(line.as_bytes())); // keep: Node swallows an output error too, "never let it kill the loop"
    crate::discard::harmless(out.flush()); // keep: same
}

/// A diagnostic on stderr.
fn diag(line: &str) {
    let mut err = std::io::stderr().lock();
    crate::discard::harmless(err.write_all(line.as_bytes())); // keep: a closed stderr must not stop the watcher
}

fn now_ms() -> f64 {
    crate::health::now_ms() as f64
}

/// Everything the watcher owns that the signal thread must also reach.
struct Shared {
    home: PathBuf,
    id: String,
    primary: bool,
    state: State,
    lock: Option<Held>,
    cleaned: bool,
    /// The pid of a handed-off successor: signals are forwarded to it instead of ending this process.
    child: Option<i32>,
}

type Cell = Arc<Mutex<Shared>>;

fn locked(c: &Cell) -> std::sync::MutexGuard<'_, Shared> {
    c.lock().unwrap_or_else(|e| e.into_inner())
}

/// `cleanup(opts)`: persist the cursors (unless a newer holder owns them now) and release the lock. Once only.
fn cleanup(c: &Cell, skip_save: bool) {
    let mut s = locked(c);
    if s.cleaned {
        return;
    }
    s.cleaned = true;
    if !skip_save {
        read::save_seen(&s.home.clone(), &s.id.clone(), &s.state.clone(), s.primary);
    }
    if let Some(l) = s.lock.take() {
        l.release();
    }
}

// ---- signals -----------------------------------------------------------------------------------------------------------------

static SIGNAL_PIPE: std::sync::atomic::AtomicI32 = std::sync::atomic::AtomicI32::new(-1);

extern "C" fn on_signal(sig: libc::c_int) {
    let fd = SIGNAL_PIPE.load(std::sync::atomic::Ordering::Relaxed);
    if fd >= 0 {
        let b = sig as u8;
        // SAFETY: write(2) is async-signal-safe; the descriptor is the write end of our own pipe.
        unsafe { libc::write(fd, (&raw const b).cast(), 1) };
    }
}

/// SIGTERM and SIGINT end the watcher cleanly (or are forwarded to a handed-off successor). Everything else keeps the default.
fn install_signals(c: &Cell) {
    let mut fds = [0 as libc::c_int; 2];
    // SAFETY: pipe(2) fills the two descriptors of the array.
    if unsafe { libc::pipe(fds.as_mut_ptr()) } != 0 {
        return;
    }
    SIGNAL_PIPE.store(fds[1], std::sync::atomic::Ordering::Relaxed);
    // SAFETY: the handler only calls write(2).
    unsafe {
        libc::signal(libc::SIGTERM, on_signal as extern "C" fn(libc::c_int) as libc::sighandler_t);
        libc::signal(libc::SIGINT, on_signal as extern "C" fn(libc::c_int) as libc::sighandler_t);
    }
    let c = Arc::clone(c);
    let read_fd = fds[0];
    std::thread::spawn(move || {
        let mut b = 0u8;
        loop {
            // SAFETY: reads one byte from the read end of our own pipe into a one-byte buffer.
            let n = unsafe { libc::read(read_fd, (&raw mut b).cast(), 1) };
            if n < 0 && std::io::Error::last_os_error().kind() == std::io::ErrorKind::Interrupted {
                continue;
            }
            if n <= 0 {
                return;
            }
            let child = locked(&c).child;
            if let Some(pid) = child {
                // SAFETY: forwards the signal we received to the successor we started.
                unsafe { libc::kill(pid, i32::from(b)) };
                continue;
            }
            cleanup(&c, false);
            std::process::exit(0);
        }
    });
}

// ---- the parent -------------------------------------------------------------------------------------------------------------

/// `parentGone(startPpid)`: the OS reparented this process, or the process that started it no longer exists.
fn parent_gone(start_ppid: i32) -> bool {
    if start_ppid <= 0 {
        return false;
    }
    // SAFETY: getppid(2) takes no arguments and cannot fail.
    let current = unsafe { libc::getppid() };
    if current != start_ppid || current == 1 {
        return true;
    }
    // SAFETY: signal 0 only probes for the process.
    let rc = unsafe { libc::kill(start_ppid, 0) };
    rc != 0 && std::io::Error::last_os_error().raw_os_error() == Some(libc::ESRCH)
}

// ---- the run ----------------------------------------------------------------------------------------------------------------

fn defer_exit() -> i32 {
    defaults::num("ops.defer_exit") as i32
}

/// What a startup step may do: carry on, or end the run with an exit code (a deferral is exit 75, nothing written).
enum Start {
    Go(Box<Armed>),
    Exit(i32),
}

/// A watcher that passed every check and holds its lock.
struct Armed {
    id: Identity,
    hashes: Option<Hashes>,
    inbox: PathBuf,
}

fn reason(key: &str) -> &'static str {
    text(key)
}

/// `main()` up to the lock: the checks in Node's order; every deferral happens here, before anything is printed or written.
fn start(p: &Proc, auto: bool) -> Start {
    let refuse_quietly = |why: &str| {
        if !auto {
            emit(&edge::refusal_line(why));
        }
    };
    if crate::checks::guardkit::settings::unreadable_settings_file(&p.st.home) {
        return Start::Exit(defer_exit());
    }
    if p.switched_off("wake_watch.set_enabled") {
        refuse_quietly(reason("wake_watch.reason_disabled"));
        return Start::Exit(0);
    }
    match who::gate(p) {
        Err(_) => return Start::Exit(defer_exit()),
        Ok(false) => {
            diag(text("wake_watch.diag_not_devswarm"));
            refuse_quietly(reason("wake_watch.reason_not_devswarm"));
            return Start::Exit(0);
        }
        Ok(true) => {}
    }
    let id = match who::resolve_identity(p) {
        Err(_) => return Start::Exit(defer_exit()),
        Ok(Some(i)) => i,
        Ok(None) => {
            diag(&defaults::render("wake_watch.diag_no_identity", &[("cwd", &p.cwd)]));
            emit(&edge::refusal_line(reason("wake_watch.reason_identity")));
            return Start::Exit(1);
        }
    };
    // an idle Primary: Node prints its one line and records the metric; nothing is written before this decision
    if id.primary {
        match arch::idle_skip(p) {
            Err(_) => return Start::Exit(defer_exit()),
            Ok(arch::IdleSkip::Applies) => return Start::Exit(defer_exit()),
            Ok(arch::IdleSkip::NotApplicable) => {}
        }
    }
    let hashes = if id.primary { who::primary_hashes(&p.cwd) } else { who::child_hashes(&p.cwd, &id.id) };
    let Ok(hashes) = hashes else { return Start::Exit(defer_exit()) };
    let root = devswarm_root(&p.home);
    let inbox = id
        .descriptor
        .as_ref()
        .and_then(|d| who::str_member(d, "inboxPath"))
        .map(PathBuf::from)
        .unwrap_or_else(|| root.join(text("wake_watch.dir_inbox")).join(format!("{}{}", id.id, text("wake_watch.inbox_suffix"))));
    Start::Go(Box::new(Armed { id, hashes, inbox }))
}

fn own_session_id(p: &Proc) -> Option<String> {
    defaults::list("wake_watch.session_env").into_iter().find_map(|k| p.env.get(k).filter(|v| !v.is_empty()).cloned())
}

fn plugin_version(p: &Proc) -> Option<String> {
    let manifest = Path::new(&p.root).join(text("wake_watch.manifest_rel"));
    match read::parse_json(&read::read_text(&manifest)?)?.get("version") {
        Some(crate::checks::jsport::json::J::Str(s)) => Some(s.clone()),
        _ => None,
    }
}

fn lock_params() -> nodelock::Params {
    nodelock::Params {
        stale_ms: defaults::num("wake_watch.lock_stale_ms"),
        wait_ms: defaults::num("wake_watch.lock_wait_ms"),
        step_ms: defaults::num("wake_watch.lock_step_ms"),
        reclaim_stale_ms: defaults::num("wake_watch.lock_reclaim_stale_ms"),
        release_tries: defaults::num("wake_watch.lock_release_tries"),
        release_step_ms: defaults::num("wake_watch.lock_release_step_ms"),
        boot_slop_s: defaults::num("wake_watch.lock_boot_slop_s"),
        // Node's watcher lock steals by age alone (a live holder only once its re-stamp is overdue), never a dead pid early
        steal_dead: false,
    }
}

/// The refusal text of a held lock: the holder's pid, age, session, acquisition time and version.
fn held_by_diag(role: &str, id: &str, r: &nodelock::Refused) -> String {
    let age = r.age_ms.map_or_else(|| text("wake_watch.word_unknown").to_string(), |a| format!("{}s", (a / 1000.0).round()));
    let pid = r.pid.map_or_else(|| text("wake_watch.word_unknown").to_string(), |p| p.to_string());
    let version = r.version.clone().unwrap_or_else(|| text("wake_watch.word_unknown").to_string());
    let session = r.session_id.clone().unwrap_or_else(|| text("wake_watch.word_unavailable").to_string());
    let acquired = r.ts.and_then(iso_ms).unwrap_or_else(|| text("wake_watch.word_unknown").to_string());
    defaults::render(
        "wake_watch.diag_lock_held",
        &[("role", &role), ("id", &id), ("pid", &pid), ("age", &age), ("session", &session), ("acquired", &acquired), ("version", &version)],
    )
}

fn iso_ms(ts: f64) -> Option<String> {
    crate::checks::jsport::date::to_iso(ts)
}

/// `rearm`-free tail of `main()`: take the lock, then loop.
fn run_armed(p: &Proc, a: Armed, start_ppid: i32) -> i32 {
    let role = a.id.role();
    let own_version = plugin_version(p);
    let mut extra = Extra::default();
    extra.fields.push((text("wake_watch.field_version").to_string(), own_version.clone().map_or(serde_json::Value::Null, serde_json::Value::String)));
    if let Some(sid) = own_session_id(p) {
        extra.fields.push((text("wake_watch.field_session").to_string(), serde_json::Value::String(sid)));
    }
    let lock_path = devswarm_root(&p.home).join(text("mesh_write.dir_locks")).join(format!(
        "{}{}{}",
        text("wake_watch.lock_prefix"),
        a.id.id,
        text("wake_watch.lock_suffix")
    ));
    let Some(held) = nodelock::acquire_ex(&lock_path.to_string_lossy(), lock_params(), &mut extra) else {
        diag(&held_by_diag(role, &a.id.id, &extra.refused.unwrap_or_default()));
        emit(&edge::refusal_line(reason("wake_watch.reason_lock_held")));
        return 0;
    };
    let state = read::load_seen(&p.home, &a.id.id, a.id.primary);
    let cell: Cell = Arc::new(Mutex::new(Shared {
        home: p.home.clone(),
        id: a.id.id.clone(),
        primary: a.id.primary,
        state: state.clone(),
        lock: Some(held),
        cleaned: false,
        child: None,
    }));
    install_signals(&cell);
    let poll = Duration::from_millis(p.poll_ms());
    let watcher = make_watcher(p, &a);
    let mut run = Run {
        p,
        a: &a,
        cell: &cell,
        own_version,
        start_ppid,
        poll,
        saved: (state.last_total, state.last_total2, state.last_broadcast),
        notified_update: None,
        archived_checked: None,
        own_archived: false,
        last_restamp_ok: Instant::now(),
        restamp_err_logged: false,
        recheck: archived_recheck(p),
    };
    let code = run.run_loop(&watcher);
    cleanup(&cell, false);
    code
}

fn archived_recheck(p: &Proc) -> Duration {
    let n = p.env.get(text("wake_watch.env_archived_recheck")).and_then(|v| v.trim().parse::<i64>().ok());
    Duration::from_millis(
        n.filter(|n| *n >= defaults::num("wake_watch.archived_recheck_floor_ms") as i64).map_or(defaults::num("wake_watch.archived_recheck_ms"), |n| n as u64),
    )
}

/// The realtime layer over the files this watcher reads: the project's summary buckets and, for a child, its inbox.
fn make_watcher(p: &Proc, a: &Armed) -> Watcher {
    let w = Watcher::start(WatchConfig::load());
    if let Some(h) = &a.hashes {
        let names: Vec<String> = [&h.repo_key, &h.fallback].into_iter().flatten().map(|k| format!("{k}{}", text("wake_watch.json_suffix"))).collect();
        if !names.is_empty() {
            w.add(&devswarm_root(&p.home).join(text("wake_watch.dir_summaries")), Filter::names(names));
        }
    }
    if !a.id.primary
        && let (Some(dir), Some(name)) = (a.inbox.parent(), a.inbox.file_name())
    {
        w.add(dir, Filter::names([name.to_string_lossy().into_owned()]));
    }
    w
}

struct Run<'a> {
    p: &'a Proc,
    a: &'a Armed,
    cell: &'a Cell,
    own_version: Option<String>,
    start_ppid: i32,
    poll: Duration,
    /// The cursors as last written, so an idle watcher writes nothing.
    saved: (f64, f64, f64),
    notified_update: Option<String>,
    archived_checked: Option<Instant>,
    own_archived: bool,
    last_restamp_ok: Instant,
    restamp_err_logged: bool,
    recheck: Duration,
}

/// What one tick decided.
enum Flow {
    Next,
    Stop(i32),
}

impl Run<'_> {
    fn run_loop(&mut self, watcher: &Watcher) -> i32 {
        loop {
            match self.tick() {
                Flow::Stop(code) => return code,
                Flow::Next => {}
            }
            // wait out the poll interval, or wake early on a change of the files read while the reads are healthy
            let healthy = locked(self.cell).state.consec_errors == 0.0;
            let deadline = Instant::now() + self.poll;
            loop {
                let left = deadline.saturating_duration_since(Instant::now());
                if left.is_zero() {
                    break;
                }
                if watcher.next(left).is_some() && healthy {
                    break;
                }
            }
        }
    }

    /// One pass of Node's `loop()`.
    fn tick(&mut self) -> Flow {
        let (p, a) = (self.p, self.a);
        if parent_gone(self.start_ppid) {
            diag(&format!("{}\n", edge::parent_gone_line()));
            return Flow::Stop(0);
        }
        // the lock heartbeat: a healthy watcher's lock never reads stale; a definitive loss ends the loop without touching the
        // new holder's lock or state
        let mut restamped = false;
        let mut r = self.refresh();
        if r == Refresh::Lost {
            r = self.refresh(); // one re-check of a definitive loss
        }
        match r {
            Refresh::Ok => {
                restamped = true;
                self.last_restamp_ok = Instant::now();
                self.restamp_err_logged = false;
            }
            Refresh::Error => {
                if self.last_restamp_ok.elapsed() <= Duration::from_millis(lock_params().stale_ms) {
                    restamped = true;
                    if !self.restamp_err_logged {
                        self.restamp_err_logged = true;
                        diag(text("wake_watch.diag_restamp_transient"));
                    }
                } else {
                    diag(text("wake_watch.diag_restamp_stale"));
                }
            }
            Refresh::Lost => {}
        }
        if !restamped {
            diag(&format!("{}\n", edge::lock_lost_line(reason("wake_watch.reason_lock_held"))));
            cleanup(self.cell, true);
            return Flow::Stop(0);
        }
        // an archived child stays alive but silent; a restore resumes without a re-arm
        if !a.id.primary {
            let due = self.archived_checked.is_none_or(|t| t.elapsed() >= self.recheck);
            if due {
                self.archived_checked = Some(Instant::now());
                self.own_archived = arch::own_child_archived(p, &a.id.id);
            }
            if self.own_archived {
                return Flow::Next;
            }
        }
        if let Some(flow) = self.stale_check() {
            return flow;
        }
        let mut snap = if a.id.primary {
            let d = read::read_direct(&p.home, a.hashes.as_ref(), &a.id.id);
            Snapshot { ok: d.ok, error: d.error, total: d.total, ..Snapshot::default() }
        } else {
            read::read_child(&p.home, &a.inbox, a.hashes.as_ref(), &a.id.id)
        };
        snap.role = a.id.role().to_string();
        snap.id = a.id.id.clone();
        snap.now_ms = now_ms();
        let snap = read::attach_broadcast(snap, &p.home, a.hashes.as_ref(), &a.id.id);
        let (state, lines) = {
            let s = locked(self.cell);
            edge::tick(&s.state, &snap)
        };
        for l in &lines {
            emit(l);
        }
        let changed = (state.last_total, state.last_total2, state.last_broadcast) != self.saved;
        locked(self.cell).state = state.clone();
        if changed && read::save_seen(&p.home, &a.id.id, &state, a.id.primary) {
            self.saved = (state.last_total, state.last_total2, state.last_broadcast);
        }
        Flow::Next
    }

    fn refresh(&self) -> Refresh {
        locked(self.cell).lock.as_ref().map_or(Refresh::Lost, Held::refresh)
    }

    /// The stale-build check, every tick: hand off to a newer build, or say once that an update is pending.
    fn stale_check(&mut self) -> Option<Flow> {
        let (p, a) = (self.p, self.a);
        let s = stale::check(p, self.own_version.as_deref())?;
        let role = a.id.role();
        if let Some(script) = s.script.as_ref() {
            let script_s = script.to_string_lossy().into_owned();
            let stamp = p.env.get(text("wake_watch.env_handoff")).map(String::as_str);
            let own = self.own_version.clone().unwrap_or_default();
            if stale::can_handoff(&own, &s.newest, stamp) {
                return Some(self.handoff(&s, &script_s));
            }
            // the guards refused the handoff: the original print-the-re-arm-line-and-exit
            emit(&stale::stale_line(role, &a.id.id, self.own_version.as_deref(), &s.newest, &script_s));
            cleanup(self.cell, false);
            return Some(Flow::Stop(0));
        }
        if self.notified_update.as_deref() != Some(s.newest.as_str()) {
            self.notified_update = Some(s.newest.clone());
            if read::claim_update_announcement(&p.home, &a.id.id, &s.newest) {
                emit(&stale::update_line(role, &a.id.id, self.own_version.as_deref(), &s.newest, s.registered));
            }
        }
        None
    }

    /// `attemptHandoff`: release the lock, start the newer build's watcher with our stdio, mirror its exit.
    fn handoff(&mut self, s: &stale::Stale, script: &str) -> Flow {
        let role = self.a.id.role();
        // the successor takes the lock itself, so there is never a moment two processes believe they hold it
        if let Some(l) = locked(self.cell).lock.take() {
            l.release();
        }
        let mut cmd = std::process::Command::new(text("wake_watch.node_bin"));
        cmd.arg(script).env(text("wake_watch.env_handoff"), &s.newest);
        match cmd.spawn() {
            Ok(mut child) => {
                locked(self.cell).child = i32::try_from(child.id()).ok();
                // the successor owns the lock and the cursors now: ours are stale and must never overwrite its fresher ones
                cleanup(self.cell, true);
                emit(&stale::handoff_line(&s.newest, s.registered, s.registered_version.as_deref()));
                let code = match child.wait() {
                    Ok(st) => exit_code_of(&st),
                    Err(_) => 1,
                };
                Flow::Stop(code)
            }
            Err(_) => {
                cleanup(self.cell, true);
                emit(&stale::stale_line(role, &self.a.id.id, self.own_version.as_deref(), &s.newest, script));
                Flow::Stop(1)
            }
        }
    }
}

/// `handoffExitCode`: the child's own code, or 128 + the signal number.
fn exit_code_of(st: &std::process::ExitStatus) -> i32 {
    use std::os::unix::process::ExitStatusExt;
    st.code().or_else(|| st.signal().map(|s| 128 + s)).unwrap_or(0)
}

/// The verb. `rest` is what follows `wake-watch` on the command line.
pub fn run(rest: &[String]) -> i32 {
    // SAFETY: getppid(2) takes no arguments and cannot fail.
    let start_ppid = unsafe { libc::getppid() };
    let env: crate::meshw::ident::Env = std::env::vars().collect();
    // the settings chain reads the whole environment (the Monitor's, not an allowlisted copy)
    let home = env.get(defaults::env_name("home")).or_else(|| env.get(defaults::env_name("home_alt"))).cloned().unwrap_or_default();
    let st = Settings { home, env: env.clone() };
    if st.home.is_empty() {
        return defer_exit();
    }
    let Ok(cwd) = std::env::current_dir().map(|d| d.to_string_lossy().into_owned()) else { return defer_exit() };
    let root = crate::ops::plugin_root(&env.iter().map(|(k, v)| (k.clone(), v.clone())).collect()).unwrap_or_default();
    let p = Proc { home: PathBuf::from(&st.home), cwd, env, st, root };
    let auto = rest.iter().any(|a| a == text("wake_watch.flag_auto"));
    match start(&p, auto) {
        Start::Exit(code) => code,
        Start::Go(armed) => run_armed(&p, *armed, start_ppid),
    }
}

#[cfg(test)]
mod tests;
