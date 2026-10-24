//! Stage 1 of the Node backup: the Node shadow.
//!
//! The client of a hook call asks [`begin`] before it dispatches (cheap: a few settings reads) and [`finish`] after the answer has been
//! written and the wait marker released. In between, the dispatcher reports what the engine decided per check ([`note`]). When the
//! event is followed, [`finish`] writes a job file and starts a detached `ah-engine shadow-run` (its own process group, no
//! inherited pipes), which runs the event's Node hooks one after the other in a scratch home and writes the engine rows and the node
//! rows to the ledger. Nothing in here can change the verdict already printed.
use super::ledger::{self, Row, ident};
use crate::client::Outcome;
use crate::defaults;
use crate::dispatch::{Args, combine::HookResult, table::Entry};
use crate::obs::counters::{self, Outcome as Acct};
use serde_json::{Value, json};
use std::cell::RefCell;
use std::io::Read;
use std::os::unix::io::AsRawFd;
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

/// A followed (or possibly followed) hook call.
#[derive(Debug)]
pub struct Armed {
    inv: String,
    host: String,
    event: String,
    tool: String,
    sampled: bool,
    started: Instant,
}

/// What the engine decided for one check, as the dispatcher noted it.
#[derive(Debug, Clone)]
struct Noted {
    chk: String,
    command: String,
    timeout_s: u64,
    verdict: &'static str,
    err: &'static str,
}

thread_local! {
    static CAPTURE: RefCell<Option<Vec<Noted>>> = const { RefCell::new(None) };
}

/// The verdict word of a hook's result: `block` (exit 2, or a JSON block), `advise` (it printed something), `allow`, or `error`
/// (it did not finish, or exited with another code).
pub fn verdict(code: Option<i32>, out: &str, err: &str) -> &'static str {
    match code {
        None => "error",
        Some(2) => "block",
        Some(0) if crate::dispatch::combine::json_blocks(out) => "block",
        Some(0) if !out.trim().is_empty() || !err.trim().is_empty() => "advise",
        Some(0) => "allow",
        Some(_) => "error",
    }
}

fn now_ms() -> u64 {
    crate::health::now_ms()
}

/// The call id: unique enough to pair the two sides of one event (time, pid, a counter).
fn new_inv() -> String {
    static N: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let n = N.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    format!("{:x}{:x}{:x}", now_ms(), std::process::id(), n)
}

/// A number 0..100 that differs from call to call (not a secret; it only spreads the sample).
fn roll() -> u64 {
    let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.subsec_nanos() as u64).unwrap_or(0);
    ((nanos ^ ((std::process::id() as u64) << 21)).wrapping_mul(0x9E37_79B9_7F4A_7C15) >> 33) % 100
}

fn count(name: &str, outcome: Acct, wall_us: u64) {
    counters::account("shadow", name, outcome, 0, wall_us);
}

/// Whether the shadow's end date has passed; the first call that sees it says so once (stderr and the log) and leaves a marker.
fn ended() -> bool {
    let end = defaults::text("nodeback.shadow_end_date");
    let Some(end_day) = super::parse_day(end) else { return false };
    if super::day_of(now_ms()) < end_day {
        return false;
    }
    let marker = super::state_file("files.shadow_ended");
    if !marker.exists() {
        let msg = defaults::render("nodeback.msg_shadow_ended", &[("date", &end)]);
        crate::discard::harmless(crate::limits::ensure_private_dir(&crate::paths::dir())); // keep: a failure surfaces at the next create here
        crate::discard::harmless(crate::atomic::write(&marker, end)); // keep: without the marker the notice repeats, nothing else
        crate::health::log_event(defaults::text("nodeback.log_kind"), "ended", &msg);
        crate::discard::harmless(std::io::Write::write_all(&mut std::io::stderr(), format!("{msg}\n").as_bytes())); // keep: a closed pipe leaves nobody to tell
    }
    true
}

/// Decide, before the dispatch, whether this call may be followed. `None` = no (the shadow is off, over, or the event is not one it
/// follows); the answer to a `Some` is final only in [`finish`], which knows the engine's verdict and the load.
pub fn begin(args: &Args) -> Option<Armed> {
    let mode = defaults::text("nodeback.shadow_mode");
    if mode != "sampled" && mode != "all" {
        return None;
    }
    if !defaults::list("nodeback.shadow_events").contains(&args.event.as_str()) || ended() {
        return None;
    }
    let sampled = mode == "all" || roll() < defaults::num("nodeback.shadow_sample_pct");
    if !sampled && defaults::num("nodeback.shadow_sample_blocks") == 0 {
        return None;
    }
    CAPTURE.with(|c| *c.borrow_mut() = Some(Vec::new()));
    Some(Armed {
        inv: new_inv(),
        host: ident(&args.host),
        event: ident(&args.event),
        tool: args.tool.as_deref().map(ident).unwrap_or_default(),
        sampled,
        started: Instant::now(),
    })
}

/// The dispatcher reports the checks the engine answered (`results[i]` for `entries[i]`; a `shadow[i]` entry is only measured).
pub fn note(entries: &[Entry], results: &[Option<HookResult>], shadow: &[bool]) {
    CAPTURE.with(|c| {
        let Some(v) = c.borrow_mut().take() else { return };
        let mut v = v;
        for (i, e) in entries.iter().enumerate() {
            let (Some(_), Some(Some(r)), false) = (e.check.as_ref(), results.get(i), shadow.get(i).copied().unwrap_or(false)) else { continue };
            let word = verdict(r.code, &r.out, &r.err);
            v.push(Noted {
                chk: ident(&e.id),
                command: e.command.clone(),
                timeout_s: e.timeout_s,
                verdict: word,
                err: if word == "error" { "no_exit" } else { "" },
            });
        }
        *c.borrow_mut() = Some(v);
    });
}

fn load_too_high() -> bool {
    let max = defaults::num("nodeback.shadow_load_max_pct");
    if max == 0 {
        return false;
    }
    let mut avg = [0f64; 1];
    // SAFETY: getloadavg writes at most `nelem` (1) doubles into the buffer, which holds one.
    let got = unsafe { libc::getloadavg(avg.as_mut_ptr(), 1) };
    let cores = std::thread::available_parallelism().map_or(1, |n| n.get()) as f64;
    got == 1 && avg[0] * 100.0 / cores >= max as f64
}

fn try_slot(i: u64) -> Option<std::fs::File> {
    let dir = super::state_sub("nodeback.shadow_slots_dir");
    crate::discard::harmless(crate::limits::ensure_private_dir(&dir)); // keep: the open below fails and the slot counts as taken
    let f = std::fs::OpenOptions::new().create(true).truncate(false).write(true).open(dir.join(format!("slot{i}"))).ok()?;
    // SAFETY: `f` is an open file owned here, so its descriptor is valid; `flock` takes only the descriptor and flags.
    (unsafe { libc::flock(f.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } == 0).then_some(f)
}

/// A free slot is available right now (probed without keeping it; the run takes its own).
fn slot_free() -> bool {
    (0..defaults::num("nodeback.shadow_max_concurrent")).any(|i| try_slot(i).is_some())
}

fn env_names() -> [&'static str; 3] {
    [defaults::env_name("done_file"), defaults::env_name("wait_file"), defaults::env_name("fail_open_file")]
}

/// After the answer is written: start the shadow of this call when it passes the gates. Never blocks, never fails the hook.
pub fn finish(armed: Option<Armed>, raw: &str, o: &Outcome) {
    let Some(a) = armed else { return };
    let noted = CAPTURE.with(|c| c.borrow_mut().take()).unwrap_or_default();
    if noted.is_empty() {
        return;
    }
    let blocked = o.code == 2 || noted.iter().any(|n| n.verdict == "block");
    if !a.sampled && !blocked {
        return; // not in the sample, and nothing the "always follow a block" rule asks for
    }
    let t0 = Instant::now();
    let skip = if super::node_dir(&a.host).is_none() {
        Some("skip_no_node")
    } else if super::state_file("files.shadow_hold").exists() {
        Some("skip_cpu")
    } else if load_too_high() {
        Some("skip_load")
    } else if raw.len() as u64 > defaults::num("nodeback.shadow_max_payload_bytes") {
        Some("skip_payload")
    } else if !slot_free() {
        Some("skip_busy")
    } else {
        None
    };
    if let Some(why) = skip {
        count(why, Acct::Held, 0);
        return;
    }
    let jobs = super::state_sub("nodeback.shadow_jobs_dir");
    crate::discard::harmless(crate::limits::ensure_private_dir(&jobs)); // keep: the write below fails and the call is simply not followed
    let job = jobs.join(format!("{}.json", a.inv));
    let root = crate::dispatch::table::plugin_root(&a.host).or_else(|| defaults::root().map(|p| p.to_string_lossy().into_owned())).unwrap_or_default();
    let cwd = serde_json::from_str::<Value>(raw).ok().and_then(|p| p.get("cwd").and_then(Value::as_str).map(str::to_string)).unwrap_or_default();
    let body = json!({
        "inv": a.inv, "host": a.host, "event": a.event, "tool": a.tool, "root": root, "cwd": cwd,
        "engine_ms": a.started.elapsed().as_millis() as u64, "payload": raw,
        "rows": noted.iter().map(|n| json!({"chk": n.chk, "cmd": n.command, "timeout_s": n.timeout_s, "v": n.verdict, "err": n.err})).collect::<Vec<_>>(),
    });
    let wrote = {
        use std::io::Write;
        std::fs::OpenOptions::new().write(true).create_new(true).mode_600().open(&job).and_then(|mut f| f.write_all(body.to_string().as_bytes()))
    };
    if wrote.is_err() {
        count("skip_job", Acct::Error, 0);
        return;
    }
    let started = std::env::current_exe().and_then(|exe| {
        let mut c = Command::new(exe);
        c.arg("shadow-run").arg(&job).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).process_group(0);
        for n in env_names() {
            c.env_remove(n);
        }
        c.spawn()
    });
    match started {
        Ok(_) => count("start", Acct::Ok, t0.elapsed().as_micros() as u64),
        Err(_) => {
            crate::discard::harmless(std::fs::remove_file(&job)); // keep: a leftover job is removed by the next run's sweep
            count("skip_spawn", Acct::Error, 0);
        }
    }
}

trait Mode600 {
    fn mode_600(&mut self) -> &mut Self;
}

impl Mode600 for std::fs::OpenOptions {
    fn mode_600(&mut self) -> &mut Self {
        std::os::unix::fs::OpenOptionsExt::mode(self, 0o600)
    }
}

// ---- the detached run -----------------------------------------------------------------------------------------------------------

/// What one Node hook did.
struct Ran {
    verdict: &'static str,
    err: &'static str,
    ms: u64,
}

fn read_capped(mut r: impl Read, max: usize) -> String {
    let mut buf = Vec::new();
    let mut chunk = vec![0u8; defaults::num("nodeback.read_chunk_bytes") as usize];
    while let Ok(n) = r.read(&mut chunk) {
        if n == 0 {
            break;
        }
        if buf.len() < max {
            buf.extend_from_slice(chunk.get(..n.min(max - buf.len())).unwrap_or_default());
        }
    }
    String::from_utf8_lossy(&buf).into_owned()
}

/// Run one Node hook command with the payload on stdin; kill its whole group at the timeout.
fn run_one(command: &str, payload: &[u8], env: &[(String, String)], cwd: &Path, timeout: Duration) -> Ran {
    let t0 = Instant::now();
    let shell = defaults::list("dispatch.shell");
    let mut cmd = Command::new(shell.first().copied().unwrap_or_default());
    cmd.args(&shell[1.min(shell.len())..]).arg(command).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped()).process_group(0).current_dir(cwd);
    for (k, v) in env {
        cmd.env(k, v);
    }
    for n in env_names() {
        cmd.env_remove(n);
    }
    let Ok(mut child) = cmd.spawn() else { return Ran { verdict: "error", err: "spawn", ms: 0 } };
    counters::handback(counters::Handback::NodeLaunch, "shadow");
    let feed = child.stdin.take().map(|mut s| {
        let data = payload.to_vec();
        std::thread::spawn(move || {
            crate::discard::harmless(std::io::Write::write_all(&mut s, &data)); // keep: a hook that exits early closes the pipe
        })
    });
    let max = defaults::num("mem.proc_output_max_bytes") as usize;
    let out = child.stdout.take().map(|s| std::thread::spawn(move || read_capped(s, max)));
    let err = child.stderr.take().map(|s| std::thread::spawn(move || read_capped(s, max)));
    let poll = defaults::millis("dispatch.poll_ms");
    let (code, timed_out) = loop {
        match child.try_wait() {
            Ok(Some(st)) => break (st.code(), false),
            Ok(None) if t0.elapsed() < timeout => std::thread::sleep(poll),
            _ => {
                // SAFETY: killpg only sends a signal; the group id is the child we spawned as its own group leader.
                unsafe {
                    libc::killpg(child.id() as libc::pid_t, libc::SIGKILL);
                }
                crate::discard::harmless(child.kill()); // keep: best effort, the group kill above did the work
                crate::discard::harmless(child.wait()); // keep: reaping only
                break (None, true);
            }
        }
    };
    if let Some(f) = feed {
        crate::discard::harmless(f.join().map_err(|_| ())); // keep: a panicked feeder only means the hook saw a short payload
    }
    let (out, err) = (out.and_then(|h| h.join().ok()).unwrap_or_default(), err.and_then(|h| h.join().ok()).unwrap_or_default());
    let ms = t0.elapsed().as_millis() as u64;
    if timed_out {
        return Ran { verdict: "timeout", err: "timeout", ms };
    }
    let v = verdict(code, &out, &err);
    Ran { verdict: v, err: if v == "error" { if code.is_none() { "signal" } else { "exit" } } else { "" }, ms }
}

/// The scratch home of the shadowed hooks, with the real settings linked in.
fn scratch_home() -> PathBuf {
    let home = super::state_sub("nodeback.shadow_scratch_dir");
    let rel = defaults::text("nodeback.settings_rel");
    let link = home.join(rel);
    if let Some(dot) = link.parent() {
        crate::discard::harmless(crate::limits::ensure_private_dir(dot)); // keep: the hooks then run with a bare home
    }
    if let Some(real) = defaults::env_var("home") {
        let from = Path::new(&real).join(rel);
        if from.exists() && std::fs::read_link(&link).ok().as_deref() != Some(&from) {
            crate::discard::harmless(std::fs::remove_file(&link)); // keep: absent is the normal case
            crate::discard::harmless(std::os::unix::fs::symlink(&from, &link)); // keep: without it the hooks read default settings
        }
    }
    home
}

fn sweep_jobs(dir: &Path) {
    let max = Duration::from_secs(defaults::num("nodeback.job_max_age_s"));
    let Ok(rd) = std::fs::read_dir(dir) else { return };
    for e in rd.flatten() {
        let old = e.metadata().and_then(|m| m.modified()).ok().and_then(|t| t.elapsed().ok()).is_some_and(|age| age > max);
        if old {
            crate::discard::harmless(std::fs::remove_file(e.path())); // keep: a stale job of a dead run; the next sweep retries
        }
    }
}

/// `ah-engine shadow-run <job>` (internal): run one job's Node hooks and write both sides' rows.
pub fn run(job: &Path) -> i32 {
    let text = std::fs::read_to_string(job);
    crate::discard::harmless(std::fs::remove_file(job)); // keep: the job is consumed; a failure leaves it for the sweep
    if let Some(dir) = job.parent() {
        sweep_jobs(dir);
    }
    let Ok(v) = text.map_err(|e| e.to_string()).and_then(|t| serde_json::from_str::<Value>(&t).map_err(|e| e.to_string())) else {
        crate::health::log_event(defaults::text("nodeback.log_kind"), "job", defaults::text("nodeback.msg_job_unreadable"));
        return 1;
    };
    let Some(_slot) = (0..defaults::num("nodeback.shadow_max_concurrent")).find_map(try_slot) else {
        count("skip_busy", Acct::Held, 0);
        return 0;
    };
    let s = |k: &str| v.get(k).and_then(Value::as_str).unwrap_or_default().to_string();
    let (inv, host, event, tool, root) = (s("inv"), s("host"), s("event"), s("tool"), s("root"));
    let payload = s("payload");
    let home = scratch_home();
    let cwd = Some(s("cwd")).filter(|c| !c.is_empty() && Path::new(c).is_dir()).map_or_else(|| home.clone(), PathBuf::from);
    let mut env: Vec<(String, String)> = vec![("HOME".into(), home.to_string_lossy().into_owned())];
    for var in defaults::raw("dispatch.root_vars").get(&host).map(|l| l.strings()).unwrap_or_default() {
        env.push((var.to_string(), root.clone()));
    }
    env.extend(defaults::list("nodeback.shadow_env").iter().filter_map(|kv| kv.split_once('=')).map(|(k, v)| (k.to_string(), v.to_string())));
    let engine_ms = v.get("engine_ms").and_then(Value::as_u64).unwrap_or(0);
    let cap = Duration::from_millis(defaults::num("nodeback.shadow_node_timeout_ms"));
    let row = |src: &str, chk: &str, verdict: &str, ms: u64, err: &str| Row {
        ts: now_ms(),
        inv: inv.clone(),
        src: src.into(),
        host: host.clone(),
        ev: event.clone(),
        tool: tool.clone(),
        chk: chk.into(),
        v: verdict.into(),
        ms,
        err: err.into(),
    };
    let mut rows = Vec::new();
    let started = Instant::now();
    for r in v.get("rows").and_then(Value::as_array).into_iter().flatten() {
        let g = |k: &str| r.get(k).and_then(Value::as_str).unwrap_or_default();
        let (chk, cmd) = (g("chk"), g("cmd"));
        rows.push(row("engine", chk, g("v"), engine_ms, g("err")));
        let own = r.get("timeout_s").and_then(Value::as_u64).filter(|t| *t > 0).map_or(cap, |t| Duration::from_secs(t).min(cap));
        let ran = run_one(cmd, payload.as_bytes(), &env, &cwd, own);
        rows.push(row("node", chk, ran.verdict, ran.ms, ran.err));
    }
    ledger::append(&rows);
    count("run", Acct::Ok, started.elapsed().as_micros() as u64);
    0
}

/// Keep the hold marker in step with the daemon's CPU budget: present while it is breached, absent otherwise. Written only when the
/// state changes, so a steady daemon costs no disk traffic.
pub fn hold(breached: bool) {
    static LAST: std::sync::atomic::AtomicU8 = std::sync::atomic::AtomicU8::new(2);
    let want = u8::from(breached);
    if LAST.swap(want, std::sync::atomic::Ordering::Relaxed) == want {
        return;
    }
    let marker = super::state_file("files.shadow_hold");
    if breached {
        crate::discard::logged("nodeback_hold_set", crate::atomic::write(&marker, b""));
    } else if let Err(e) = std::fs::remove_file(&marker)
        && e.kind() != std::io::ErrorKind::NotFound
    {
        crate::discard::logged("nodeback_hold_clear", Err::<(), _>(e));
    }
}
