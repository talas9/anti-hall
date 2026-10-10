//! The engine hardening bar (v1.0 "solid engine", issue #58): one executable definition of load behaviour, crash-loop
//! recovery, the client breaker, panic containment, corrupt sockets, a daemon killed mid-call, and memory growth.
//!
//! Every threshold, rate, count and report text lives in the plugin file `engine/defaults/hardening.toml` (read here, never
//! by the engine); engine settings the bar holds the daemon to (the client deadline, the RSS cap, the defer exit) are read
//! from the engine's own defaults by name. Each bar records its checks, writes a report fragment when
//! `AH_HARDENING_REPORT_DIR` is set (before it asserts, so a failing bar is still reported), then fails if any check missed
//! its limit. `scripts/soak.sh` runs the whole bar and assembles the report.
//!
//! Every bar is `#[ignore]`d: an opt-in profile (nightly / release), never the pull-request gate. They wait out cooldowns and
//! measure the machine for minutes; `scripts/soak.sh` runs them one at a time and assembles the report.
//!
//! Every daemon runs the real binary with a scratch HOME, a private state dir, a recording stand-in for hivecontrol and a
//! minimal PATH; nothing here touches the real home or a real DevSwarm.
#![allow(clippy::unwrap_used, clippy::expect_used)] // a test crate: a panic is the failure report, and E2 exempts tests

mod common;

use ah_engine::client::{Exch, exchange};
use ah_engine::frame::Kind;
use std::io::{Read, Write};
use std::os::unix::fs::PermissionsExt;
use std::os::unix::net::UnixListener;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::OnceLock;
use std::time::{Duration, Instant};

const BIN: &str = env!("CARGO_BIN_EXE_ah-engine");
/// The version the harness's daemons and requests share (a request from a newer version would hand the daemon off).
const VER: &str = "0.1.0";
const RULES: &str = r#"{"version":1,"rules":[{"id":"force","events":["PreToolUse"],"tools":["Bash"],"field":"command","pattern":"git push --force","action":"deny","message":"engine-blocked"}]}"#;
const DENY_IN: &str =
    r#"{"session_id":"s1","cwd":"/tmp","hook_event_name":"PreToolUse","tool_name":"Bash","tool_input":{"command":"git push --force origin main"}}"#;
/// What the engine's answer to `DENY_IN` contains, and what the fallback stand-in prints.
const ENGINE_MARK: &str = "engine-blocked";
const FALLBACK_MARK: &str = "NODE-FALLBACK";

// ---- the bar's settings -------------------------------------------------------------------------------------------------

fn plugin() -> PathBuf {
    std::fs::canonicalize(Path::new(env!("CARGO_MANIFEST_DIR")).join("../plugins/anti-hall")).unwrap()
}

fn bar() -> &'static toml::Table {
    static T: OnceLock<toml::Table> = OnceLock::new();
    T.get_or_init(|| {
        let p = plugin().join("engine/defaults/hardening.toml");
        toml::from_str(&std::fs::read_to_string(&p).unwrap_or_else(|e| panic!("{}: {e}", p.display()))).unwrap()
    })
}

fn val(key: &str) -> &'static toml::Value {
    let (section, name) = key.split_once('.').unwrap();
    bar().get(section).and_then(|s| s.get(name)).and_then(|e| e.get("value")).unwrap_or_else(|| panic!("hardening.toml has no {key}"))
}

fn n(key: &str) -> u64 {
    val(key).as_integer().unwrap_or_else(|| panic!("hardening.toml {key} is not an integer")) as u64
}

fn t(key: &str) -> String {
    val(key).as_str().unwrap_or_else(|| panic!("hardening.toml {key} is not a string")).to_string()
}

fn ms(key: &str) -> Duration {
    Duration::from_millis(n(key))
}

/// An engine setting, read from the engine's own shipped defaults.
fn engine_num(key: &str) -> u64 {
    ah_engine::defaults::num(key)
}

// ---- the report ---------------------------------------------------------------------------------------------------------

struct Report {
    order: u32,
    key: &'static str,
    rows: Vec<(String, String, String, bool)>,
    notes: Vec<String>,
}

impl Report {
    fn new(order: u32, key: &'static str) -> Report {
        Report { order, key, rows: Vec::new(), notes: Vec::new() }
    }
    fn check(&mut self, what: &str, measured: impl std::fmt::Display, limit: impl std::fmt::Display, ok: bool) {
        self.rows.push((what.to_string(), measured.to_string(), limit.to_string(), ok));
    }
    fn note(&mut self, line: impl Into<String>) {
        self.notes.push(line.into());
    }
    /// Write the fragment (when a report dir is set), then fail with every missed check.
    fn finish(self) {
        let cols: Vec<String> = val("report.columns").as_array().unwrap().iter().map(|c| c.as_str().unwrap().to_string()).collect();
        let mut md = format!("## {}\n\n| {} |\n|{}\n", t(&format!("report.bar_{}", self.key)), cols.join(" | "), "---|".repeat(cols.len()));
        for (w, m, l, ok) in &self.rows {
            md.push_str(&format!("| {w} | {m} | {l} | {} |\n", if *ok { t("report.pass") } else { t("report.fail") }));
        }
        if !self.notes.is_empty() {
            md.push('\n');
            for l in &self.notes {
                md.push_str(&format!("- {l}\n"));
            }
        }
        md.push('\n');
        if let Some(dir) = std::env::var_os("AH_HARDENING_REPORT_DIR") {
            let dir = PathBuf::from(dir);
            std::fs::create_dir_all(&dir).unwrap();
            std::fs::write(dir.join(format!("{:02}-{}.md", self.order, self.key)), &md).unwrap();
        }
        eprintln!("{md}");
        let failed: Vec<String> = self.rows.iter().filter(|r| !r.3).map(|(w, m, l, _)| format!("{w}: measured {m}, limit {l}")).collect();
        assert!(failed.is_empty(), "hardening bar {} missed:\n{}", self.key, failed.join("\n"));
    }
}

fn pct(sorted: &[u64], p: u64) -> u64 {
    if sorted.is_empty() {
        return 0;
    }
    sorted[((sorted.len() as u64 * p).div_ceil(100) as usize).clamp(1, sorted.len()) - 1]
}

// ---- the lab: one isolated engine -------------------------------------------------------------------------------------

/// How one hook call ended, from the host's point of view.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Answer {
    /// The engine answered.
    Engine,
    /// The fallback stand-in answered (it allows: exit 0).
    Fallback,
    /// Anything else: a silent allow, a block the engine did not decide, a crash.
    Other,
}

struct Call {
    out: String,
    code: i32,
    err: String,
    dt: Duration,
}

impl Call {
    fn answer(&self) -> Answer {
        if self.out.contains(ENGINE_MARK) {
            Answer::Engine
        } else if self.out.contains(FALLBACK_MARK) && self.code == 0 {
            Answer::Fallback
        } else {
            Answer::Other
        }
    }
}

struct Lab {
    dir: PathBuf,
    extra: Vec<(String, String)>,
}

impl Lab {
    fn new(tag: &str, extra: &[(&str, String)]) -> Lab {
        // short: the socket path must fit the platform's limit
        let dir = PathBuf::from("/tmp").join(format!("ah-hb-{tag}-{}", std::process::id()));
        ah_engine::discard::harmless(std::fs::remove_dir_all(&dir));
        std::fs::create_dir_all(dir.join("home")).unwrap();
        std::fs::write(dir.join("rules.json"), RULES).unwrap();
        // the fallback stand-in allows (exit 0) and says so, so a call it answered is told from a silent allow
        std::fs::write(dir.join("fb.sh"), format!("cat >/dev/null\necho {FALLBACK_MARK}\nexit 0\n")).unwrap();
        // a recording hivecontrol stand-in: the daemon must never reach a real one
        let hc = dir.join("hivecontrol");
        std::fs::write(&hc, format!("#!/bin/sh\necho \"$@\" >> {}\nexit 1\n", dir.join("hivecontrol.calls").display())).unwrap();
        std::fs::set_permissions(&hc, std::fs::Permissions::from_mode(0o755)).unwrap();
        Lab { dir, extra: extra.iter().map(|(a, b)| (a.to_string(), b.clone())).collect() }
    }
    fn eng(&self) -> PathBuf {
        self.dir.join("eng")
    }
    fn home(&self) -> PathBuf {
        self.dir.join("home")
    }
    fn sock(&self) -> PathBuf {
        ah_engine::paths::socket_in(&self.eng())
    }
    fn cmd(&self) -> Command {
        let mut c = Command::new(BIN);
        c.env_clear()
            .env("PATH", "/usr/bin:/bin")
            .env("HOME", self.home())
            .env("AH_ENGINE_DIR", self.eng())
            .env("AH_ENGINE_RULES", self.dir.join("rules.json"))
            .env("AH_ENGINE_VERSION", VER)
            .env("AH_ENGINE_TEST_HOOKS", "1")
            .env("AH_ENGINE_PLUGIN_ROOT", plugin())
            .env("CLAUDE_PLUGIN_ROOT", plugin())
            .env("ANTIHALL_INGEST_DRY_RUN", "1")
            .env("ANTIHALL_DEVSWARM_HIVECONTROL", self.dir.join("hivecontrol"))
            .current_dir(&self.dir);
        for (k, v) in &self.extra {
            c.env(k, v);
        }
        c
    }
    /// One `ah-engine hook` call, with the fallback stand-in given or not.
    fn hook_with(&self, input: &str, fallback: bool, extra: &[(&str, &str)]) -> Call {
        let mut c = self.cmd();
        c.arg("hook");
        if fallback {
            c.env("AH_ENGINE_NODE", "/bin/sh").arg("--fallback").arg(self.dir.join("fb.sh"));
        }
        for (k, v) in extra {
            c.env(k, v);
        }
        let start = Instant::now();
        let mut ch = c.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn().unwrap();
        ch.stdin.take().unwrap().write_all(input.as_bytes()).unwrap();
        let o = ch.wait_with_output().unwrap();
        Call {
            out: String::from_utf8_lossy(&o.stdout).trim().to_string(),
            code: o.status.code().unwrap_or(-1),
            err: String::from_utf8_lossy(&o.stderr).trim().to_string(),
            dt: start.elapsed(),
        }
    }
    fn hook(&self, input: &str) -> Call {
        self.hook_with(input, true, &[])
    }
    /// A control request straight to the socket (never spawns a daemon).
    fn ctl(&self, verb: &str) -> Option<String> {
        match exchange(&self.sock(), format!("CTL {verb}\n").as_bytes(), ms("common.ready_ms")) {
            Exch::Reply(Kind::Ok, body) => Some(body),
            _ => None,
        }
    }
    fn pid(&self) -> Option<u32> {
        self.ctl("ping")?.split_whitespace().nth(2)?.parse().ok()
    }
    fn status(&self) -> serde_json::Value {
        self.try_status().expect("daemon status")
    }
    fn try_status(&self) -> Option<serde_json::Value> {
        serde_json::from_str(&self.ctl("status")?).ok()
    }
    /// The end of the daemon's event log, into the report (why a daemon went away).
    fn note_log_tail(&self, r: &mut Report) {
        let log = self.log();
        let lines: Vec<&str> = log.lines().collect();
        for l in &lines[lines.len().saturating_sub(n("common.log_tail_lines") as usize)..] {
            r.note(format!("log: {}", l.split('\t').skip(1).collect::<Vec<_>>().join(" ")));
        }
    }
    /// `ah-engine status --json`: the client-side view (breaker, crash loop), with or without a daemon.
    fn client_status(&self) -> serde_json::Value {
        let o = self.cmd().args(["status", "--json"]).output().unwrap();
        serde_json::from_slice(&o.stdout).unwrap_or_else(|e| panic!("status is not JSON ({e}): {}", String::from_utf8_lossy(&o.stdout)))
    }
    fn serve(&self) -> Child {
        self.cmd().arg("serve").stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).spawn().unwrap()
    }
    fn log(&self) -> String {
        std::fs::read_to_string(self.eng().join("ah-engine.log")).unwrap_or_default()
    }
    fn log_count(&self, kind: &str) -> usize {
        self.log().lines().filter(|l| l.split('\t').nth(1) == Some(kind)).count()
    }
    fn wait_for(&self, mut f: impl FnMut() -> bool) -> bool {
        let start = Instant::now();
        while start.elapsed() < ms("common.ready_ms") {
            if f() {
                return true;
            }
            std::thread::sleep(ms("common.poll_ms"));
        }
        false
    }
    fn hivecontrol_calls(&self) -> usize {
        std::fs::read_to_string(self.dir.join("hivecontrol.calls")).map(|s| s.lines().count()).unwrap_or(0)
    }
}

impl Drop for Lab {
    fn drop(&mut self) {
        common::reap(&self.eng(), || {
            let _ = self.ctl("stop");
        });
        ah_engine::discard::harmless(std::fs::remove_dir_all(&self.dir));
    }
}

fn kill9(pid: u32) {
    // SAFETY: `kill` takes plain integers and has no memory-safety preconditions; a dead pid just fails with ESRCH.
    unsafe { libc::kill(pid as i32, libc::SIGKILL) };
}

/// The longest one hook call may take before it counts as holding the tool up.
fn call_ceiling(deadline: Duration) -> Duration {
    deadline + ms("common.call_slack_ms")
}

/// A stand-in daemon on the lab's socket that answers every connection with `reply()` (`None` = hang).
fn fake_server(lab: &Lab, reply: impl Fn() -> Option<Vec<u8>> + Send + 'static) {
    std::fs::create_dir_all(lab.eng()).unwrap();
    std::fs::set_permissions(lab.eng(), std::fs::Permissions::from_mode(0o700)).unwrap();
    let l = UnixListener::bind(lab.sock()).unwrap();
    std::thread::spawn(move || {
        for s in l.incoming().flatten() {
            let mut s = s;
            let mut b = Vec::new();
            ah_engine::discard::harmless(s.read_to_end(&mut b));
            match reply() {
                Some(r) => ah_engine::discard::harmless(s.write_all(&r)),
                None => std::thread::sleep(Duration::from_secs(60)), // hang: never reply
            }
        }
    });
}

// ---- crash loop ---------------------------------------------------------------------------------------------------------

#[test]
#[ignore = "hardening bar: opt-in nightly/release profile; run by scripts/soak.sh"]
fn crash_loop_repeated_daemon_death_trips_the_marker_and_recovers_after_the_cooldown() {
    let lab = Lab::new(
        "crash",
        &[
            ("AH_ENGINE_CRASH_N", n("crash.n").to_string()),
            ("AH_ENGINE_CRASH_WINDOW_S", n("crash.window_s").to_string()),
            ("AH_ENGINE_CRASH_COOLDOWN_S", n("crash.cooldown_s").to_string()),
        ],
    );
    let mut r = Report::new(10, "crash_loop");
    let deadline = Duration::from_millis(engine_num("client.deadline_ms"));
    let ceiling = call_ceiling(deadline);
    // n deaths: one daemon per round, started directly and awaited with a ping (which never spawns), then SIGKILLed
    let mut rounds_up = 0;
    for _ in 0..n("crash.n") {
        let mut d = lab.serve();
        if lab.wait_for(|| lab.pid() == Some(d.id())) {
            rounds_up += 1;
        }
        kill9(d.id());
        d.wait().unwrap(); // reaped: a zombie would still count as alive
    }
    r.check("daemons started and killed", rounds_up, n("crash.n"), rounds_up == n("crash.n"));
    // the next calls find the daemon dead n times: no respawn, the fallback answers, quickly
    let calls: Vec<Call> = (0..n("crash.tripped_calls")).map(|_| lab.hook(DENY_IN)).collect();
    let fallback = calls.iter().filter(|c| c.answer() == Answer::Fallback).count();
    r.check("calls answered by the fallback while tripped", fallback, calls.len(), fallback == calls.len());
    let slowest = calls.iter().map(|c| c.dt).max().unwrap_or_default();
    r.check("slowest call while tripped (ms)", slowest.as_millis(), ceiling.as_millis(), slowest <= ceiling);
    r.check("crash-loop marker written", lab.eng().join("crashloop.until").exists(), true, lab.eng().join("crashloop.until").exists());
    let respawned = lab.ctl("ping").is_some();
    r.check("daemon respawned while tripped", respawned, false, !respawned);
    let st = lab.client_status();
    let stopped = st["crashloop"].as_str().is_some_and(|s| s != "clear");
    r.check("status reports the stop", st["crashloop"].clone(), "stopped", stopped);
    let logged = lab.log_count("crashloop");
    r.check("crash-loop events logged", logged, ">= 1", logged >= 1);
    let failure = std::fs::read_to_string(lab.eng().join("failure.json")).unwrap_or_default();
    r.check("failure record names the crash loop", failure.contains("crashloop"), true, failure.contains("crashloop"));
    // recovery: once the cooldown ends (and the deaths have aged out of the window) a call starts a daemon again
    let recover_by = Instant::now() + Duration::from_secs(n("crash.cooldown_s")) + ms("crash.recover_extra_ms");
    let mut recovered = None;
    while Instant::now() < recover_by {
        let c = lab.hook(DENY_IN);
        if !matches!(c.answer(), Answer::Engine | Answer::Fallback) {
            r.check("call during the cooldown", format!("{:?} {} {}", c.code, c.out, c.err), "engine or fallback", false);
            break;
        }
        if c.answer() == Answer::Engine {
            recovered = Some(Instant::now());
            break;
        }
        std::thread::sleep(ms("common.poll_ms") * 10);
    }
    r.check("engine answers again after the cooldown", recovered.is_some(), true, recovered.is_some());
    let st = lab.client_status();
    r.check("status after recovery", st["crashloop"].clone(), "clear", st["crashloop"] == "clear");
    r.check("hivecontrol stand-in calls", lab.hivecontrol_calls(), 0, lab.hivecontrol_calls() == 0);
    r.finish();
}

// ---- breaker ------------------------------------------------------------------------------------------------------------

#[test]
#[ignore = "hardening bar: opt-in nightly/release profile; run by scripts/soak.sh"]
fn breaker_failures_open_it_calls_follow_the_no_engine_policy_and_a_half_open_probe_closes_it() {
    let deadline = ms("breaker.deadline_ms");
    let lab = Lab::new(
        "brk",
        &[
            ("AH_ENGINE_BREAKER_N", n("breaker.n").to_string()),
            ("AH_ENGINE_BREAKER_WINDOW_S", n("breaker.window_s").to_string()),
            ("AH_ENGINE_BREAKER_COOLDOWN_S", n("breaker.cooldown_s").to_string()),
            ("AH_ENGINE_DEADLINE_MS", deadline.as_millis().to_string()),
        ],
    );
    let mut r = Report::new(20, "breaker");
    let nospawn = [("AH_ENGINE_NOSPAWN", "1")];
    fake_server(&lab, || None); // a hung daemon
    let until = lab.eng().join("breaker.until");
    // n failures open it; each waited out the deadline
    let failing: Vec<Call> = (0..n("breaker.n")).map(|_| lab.hook_with(DENY_IN, true, &nospawn)).collect();
    let fb = failing.iter().filter(|c| c.answer() == Answer::Fallback).count();
    r.check("failing calls answered by the fallback", fb, failing.len(), fb == failing.len());
    r.check("breaker open after n failures", until.exists(), true, until.exists());
    let opened = lab.log_count("breaker_open");
    r.check("breaker_open logged", opened, 1, opened == 1);
    // open: calls skip the engine (faster than any call that waited) and follow the no-engine policy
    let fastest_wait = failing.iter().map(|c| c.dt).min().unwrap();
    let open: Vec<Call> = (0..n("breaker.open_calls")).map(|_| lab.hook_with(DENY_IN, true, &nospawn)).collect();
    let fb = open.iter().filter(|c| c.answer() == Answer::Fallback).count();
    r.check("open-breaker calls answered by the fallback", fb, open.len(), fb == open.len());
    let slowest = open.iter().map(|c| c.dt).max().unwrap();
    r.check("slowest open-breaker call (ms)", slowest.as_millis(), format!("< {}", fastest_wait.as_millis()), slowest < fastest_wait);
    // with no fallback to hand over to, a guard event defers (never a silent allow)
    let bare = lab.hook_with(DENY_IN, false, &nospawn);
    let defer = engine_num("dispatch.defer_exit") as i32;
    r.check("guard event with no fallback: exit", bare.code, defer, bare.code == defer && bare.out.is_empty());
    // half-open, failing: after the cooldown one failure re-opens it at once (the earlier ones are still in the window)
    let first_until = std::fs::read_to_string(&until).unwrap();
    std::thread::sleep(Duration::from_secs(n("breaker.cooldown_s")) + ms("common.poll_ms") * 4);
    let open_now = lab.client_status()["breaker"].as_str().unwrap_or("").to_string();
    r.check("breaker after its cooldown", open_now.clone(), "closed", open_now == "closed");
    let probe = lab.hook_with(DENY_IN, true, &nospawn);
    let reopened = std::fs::read_to_string(&until).unwrap_or_default();
    r.check("failed half-open probe answered by the fallback", format!("{:?}", probe.answer()), "Fallback", probe.answer() == Answer::Fallback);
    r.check("failed half-open probe re-opens it", reopened != first_until, true, reopened != first_until && lab.client_status()["breaker"] != "closed");
    // half-open, healthy: the hung stand-in is replaced by a running engine (started and awaited before the cooldown ends:
    // a daemon still loading would miss this run's short deadline and count as one more failure); after the cooldown the
    // probe succeeds and the breaker stays closed
    std::fs::remove_file(lab.sock()).unwrap();
    let mut d = lab.serve();
    let up = lab.wait_for(|| lab.pid() == Some(d.id()));
    r.check("engine up before the probe", up, true, up);
    std::thread::sleep(Duration::from_secs(n("breaker.cooldown_s")) + ms("common.poll_ms") * 4);
    let probe = lab.hook(DENY_IN);
    r.check("successful half-open probe answered by the engine", format!("{:?}", probe.answer()), "Engine", probe.answer() == Answer::Engine);
    let st = lab.client_status();
    r.check("breaker after a successful probe", st["breaker"].clone(), "closed", st["breaker"] == "closed");
    r.check("breaker_open logged per opening", lab.log_count("breaker_open"), 2, lab.log_count("breaker_open") == 2);
    common::stop_child(&lab.sock(), &mut d);
    for l in lab.log().lines().filter(|l| ["client_fail", "client_slow", "breaker_open"].contains(&l.split('\t').nth(1).unwrap_or(""))) {
        r.note(format!("log: {}", l.split('\t').skip(1).collect::<Vec<_>>().join(" ")));
    }
    r.finish();
}

// ---- panic injection ----------------------------------------------------------------------------------------------------

#[test]
#[ignore = "hardening bar: opt-in nightly/release profile; run by scripts/soak.sh"]
fn panic_injection_is_contained_and_the_same_daemon_keeps_serving() {
    let lab = Lab::new("panic", &[]);
    let mut r = Report::new(30, "panic");
    let mut d = lab.serve();
    let up = lab.wait_for(|| lab.pid() == Some(d.id()));
    r.check("daemon up", up, true, up);
    let rounds = n("panic.rounds");
    let mut answered_err = 0;
    for _ in 0..rounds {
        if let Exch::Reply(Kind::Err, _) = exchange(&lab.sock(), b"CTL panic\n", ms("common.ready_ms")) {
            answered_err += 1;
        }
    }
    r.check("panics answered as errors (never OK, never a hang)", answered_err, rounds, answered_err == rounds);
    let same = lab.pid() == Some(d.id());
    r.check("same daemon after the panics", same, true, same);
    let st = lab.status();
    r.check("panics counted", st["panics"].clone(), rounds, st["panics"].as_u64() == Some(rounds));
    r.check("restarts", st["restarts"].clone(), 0, st["restarts"].as_u64() == Some(0));
    let c = lab.hook(DENY_IN);
    r.check("next hook answered by the engine", format!("{:?}", c.answer()), "Engine", c.answer() == Answer::Engine);
    let logged = lab.log_count("panic");
    r.check("panics logged", logged, rounds, logged as u64 == rounds);
    common::stop_child(&lab.sock(), &mut d);
    r.finish();
}

// ---- corrupt socket -----------------------------------------------------------------------------------------------------

#[test]
#[ignore = "hardening bar: opt-in nightly/release profile; run by scripts/soak.sh"]
fn corrupt_socket_garbage_frames_and_a_non_socket_fall_back_never_allow() {
    let mut r = Report::new(40, "corrupt_socket");
    let deadline = Duration::from_millis(engine_num("client.deadline_ms"));
    let calls = n("corrupt.calls");
    {
        // a server that answers with bytes that are not a frame
        let lab = Lab::new("garb", &[("AH_ENGINE_NOSPAWN", "1".to_string())]);
        let garbage = t("corrupt.garbage").into_bytes();
        fake_server(&lab, move || Some(garbage.clone()));
        let cs: Vec<Call> = (0..calls).map(|_| lab.hook(DENY_IN)).collect();
        let fb = cs.iter().filter(|c| c.answer() == Answer::Fallback).count();
        r.check("garbage frames: calls answered by the fallback", fb, calls, fb as u64 == calls);
        let slowest = cs.iter().map(|c| c.dt).max().unwrap();
        r.check("garbage frames: slowest call (ms)", slowest.as_millis(), call_ceiling(deadline).as_millis(), slowest <= call_ceiling(deadline));
        let failed = lab.log_count("client_fail");
        r.check(
            "garbage frames: failures counted toward the breaker",
            failed,
            format!(">= {}", calls.min(engine_num("client.breaker_n"))),
            failed as u64 >= calls.min(engine_num("client.breaker_n")),
        );
    }
    {
        // a regular file where the socket should be: never deleted, never mistaken for a daemon
        let lab = Lab::new("nonsock", &[]);
        std::fs::create_dir_all(lab.eng()).unwrap();
        std::fs::set_permissions(lab.eng(), std::fs::Permissions::from_mode(0o700)).unwrap();
        std::fs::write(lab.sock(), "precious").unwrap();
        let cs: Vec<Call> = (0..calls).map(|_| lab.hook(DENY_IN)).collect();
        let fb = cs.iter().filter(|c| c.answer() == Answer::Fallback).count();
        r.check("non-socket: calls answered by the fallback", fb, calls, fb as u64 == calls);
        let slowest = cs.iter().map(|c| c.dt).max().unwrap();
        r.check("non-socket: slowest call (ms)", slowest.as_millis(), call_ceiling(deadline).as_millis(), slowest <= call_ceiling(deadline));
        let kept = std::fs::read_to_string(lab.sock()).unwrap_or_default() == "precious";
        r.check("non-socket: file left untouched", kept, true, kept);
    }
    r.finish();
}

// ---- daemon killed mid-call ---------------------------------------------------------------------------------------------

#[test]
#[ignore = "hardening bar: opt-in nightly/release profile; run by scripts/soak.sh"]
fn kill_mid_call_never_blocks_a_tool_and_never_reads_as_an_allow() {
    let lab = std::sync::Arc::new(Lab::new("kill", &[]));
    let mut r = Report::new(50, "kill_mid_call");
    let deadline = Duration::from_millis(engine_num("client.deadline_ms"));
    let mut d = lab.serve();
    let up = lab.wait_for(|| lab.pid() == Some(d.id()));
    r.check("daemon up", up, true, up);
    let answered = std::sync::Arc::new(std::sync::atomic::AtomicU64::new(0));
    let workers: Vec<_> = (0..n("kill.clients"))
        .map(|i| {
            let (lab, answered) = (lab.clone(), answered.clone());
            std::thread::spawn(move || {
                let input = DENY_IN.replace("\"s1\"", &format!("\"kill-{i}\""));
                (0..n("kill.calls_per_client"))
                    .map(|_| {
                        let c = lab.hook(&input);
                        if c.answer() == Answer::Engine {
                            answered.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                        }
                        c
                    })
                    .collect::<Vec<Call>>()
            })
        })
        .collect();
    let saw = lab.wait_for(|| answered.load(std::sync::atomic::Ordering::SeqCst) >= n("kill.kill_after_answers"));
    r.check("engine answers before the kill", answered.load(std::sync::atomic::Ordering::SeqCst), format!(">= {}", n("kill.kill_after_answers")), saw);
    kill9(d.id());
    d.wait().unwrap();
    let calls: Vec<Call> = workers.into_iter().flat_map(|w| w.join().unwrap()).collect();
    let other: Vec<&Call> = calls.iter().filter(|c| c.answer() == Answer::Other).collect();
    r.check("calls that were neither the engine's nor the fallback's answer", other.len(), 0, other.is_empty());
    if let Some(c) = other.first() {
        r.note(format!("first such call: exit {} out {:?} err {:?}", c.code, c.out, c.err));
    }
    let slowest = calls.iter().map(|c| c.dt).max().unwrap_or_default();
    r.check("slowest call (ms)", slowest.as_millis(), call_ceiling(deadline).as_millis(), slowest <= call_ceiling(deadline));
    let fb = calls.iter().filter(|c| c.answer() == Answer::Fallback).count();
    r.note(format!("{} calls: {} by the engine, {fb} by the fallback", calls.len(), calls.iter().filter(|c| c.answer() == Answer::Engine).count()));
    r.finish();
}

// ---- load and memory: the dispatcher's own request, straight to the daemon ----------------------------------------------

/// A transcript in the shape of a real one (prompts, task and Bash tool uses, results, text) of about `kb` KB.
fn transcript(path: &Path, kb: u64) {
    let mut f = std::io::BufWriter::new(std::fs::File::create(path).unwrap());
    let (mut written, mut i) = (0u64, 0u64);
    while written < kb * 1024 {
        let line = match i % 5 {
            0 => format!(
                r#"{{"type":"user","timestamp":"2026-10-07T10:00:{:02}.000Z","message":{{"role":"user","content":"prompt number {i} about the engine"}}}}"#,
                i % 60
            ),
            1 => format!(
                r#"{{"type":"assistant","timestamp":"2026-10-07T10:00:{:02}.000Z","message":{{"role":"assistant","content":[{{"type":"tool_use","id":"t{i}","name":"TaskCreate","input":{{"subject":"task {i}","status":"pending"}}}}]}}}}"#,
                i % 60
            ),
            2 => format!(
                r#"{{"type":"assistant","timestamp":"2026-10-07T10:00:{:02}.000Z","message":{{"role":"assistant","content":[{{"type":"tool_use","id":"b{i}","name":"Bash","input":{{"command":"cargo test --lib module_{i}"}}}}]}}}}"#,
                i % 60
            ),
            3 => format!(
                r#"{{"type":"user","timestamp":"2026-10-07T10:00:{:02}.000Z","message":{{"role":"user","content":[{{"type":"tool_result","tool_use_id":"t{}","content":"Task #{i} created successfully: task"}}]}}}}"#,
                i % 60,
                i - 2
            ),
            _ => format!(
                r#"{{"type":"assistant","timestamp":"2026-10-07T10:00:{:02}.000Z","message":{{"role":"assistant","content":[{{"type":"text","text":"{}"}}]}}}}"#,
                i % 60,
                "x".repeat(300)
            ),
        };
        writeln!(f, "{line}").unwrap();
        written += line.len() as u64 + 1;
        i += 1;
    }
    f.flush().unwrap();
}

/// The mixed traffic of a session: the `D` request the dispatcher sends for call `i` (event, tool, payload).
struct Traffic {
    home: String,
    cwd: String,
    transcript: String,
    sessions: u64,
    deadline_ms: u64,
}

impl Traffic {
    fn new(lab: &Lab, transcript_kb: u64, sessions: u64) -> Traffic {
        let tp = lab.dir.join("session.jsonl");
        transcript(&tp, transcript_kb);
        Traffic {
            home: lab.home().to_string_lossy().into_owned(),
            cwd: lab.dir.to_string_lossy().into_owned(),
            transcript: tp.to_string_lossy().into_owned(),
            sessions,
            deadline_ms: engine_num("client.deadline_ms"),
        }
    }
    fn request(&self, i: u64) -> Vec<u8> {
        let session = format!("hb-session-{}", i % self.sessions);
        let base = |extra: serde_json::Value| {
            let mut v = serde_json::json!({"session_id": session, "transcript_path": self.transcript, "cwd": self.cwd});
            v.as_object_mut().unwrap().extend(extra.as_object().unwrap().clone());
            v
        };
        let (event, payload) = match i % 10 {
            0 | 1 => ("PreToolUse", base(serde_json::json!({"tool_name": "Bash", "tool_input": {"command": format!("ls -la dir{i}")}}))),
            2 => (
                "PreToolUse",
                base(
                    serde_json::json!({"tool_name": "Edit", "tool_input": {"file_path": format!("{}/f{i}.rs", self.cwd), "old_string": "a", "new_string": "b"}}),
                ),
            ),
            3 | 4 => {
                ("PostToolUse", base(serde_json::json!({"tool_name": "Bash", "tool_input": {"command": "ls"}, "tool_response": {"stdout": "x", "stderr": ""}})))
            }
            5 => ("UserPromptSubmit", base(serde_json::json!({"prompt": format!("please look at module {i}")}))),
            6 => ("Stop", base(serde_json::json!({"stop_hook_active": false}))),
            7 => ("PostToolBatch", base(serde_json::json!({}))),
            8 => ("SubagentStop", base(serde_json::json!({"agent_id": format!("a{i}")}))),
            _ => ("SessionStart", base(serde_json::json!({"source": "startup"}))),
        };
        let mut payload = payload;
        payload["hook_event_name"] = event.into();
        let tool = payload.get("tool_name").and_then(|t| t.as_str()).map(str::to_string);
        let env = ah_engine::reqenv::RequestEnv::from_pairs([("HOME", self.home.as_str())]);
        let meta = serde_json::json!({
            "host": "claude", "event": event, "tool": tool, "root": plugin(), "env": env, "only": null, "plan": [], "cfg": "",
            "deadline_ms": self.deadline_ms,
        });
        format!("D {VER}\n{meta}\n{payload}").into_bytes()
    }
}

/// One measured call: client wall time in microseconds, and whether the daemon answered it (anything else is a
/// whole-event fallback: BUSY, ERR, a timeout, a failed exchange, no daemon).
fn timed_call(sock: &Path, req: &[u8], deadline: Duration) -> (u64, bool, bool) {
    let start = Instant::now();
    let e = exchange(sock, req, deadline);
    let us = start.elapsed().as_micros() as u64;
    (us, matches!(e, Exch::Reply(Kind::Ok, _)), matches!(e, Exch::Slow(_)))
}

#[derive(Default)]
struct Phase {
    wall_us: Vec<u64>,
    fallbacks: u64,
    timeouts: u64,
}

impl Phase {
    fn add(&mut self, (us, ok, slow): (u64, bool, bool)) {
        self.wall_us.push(us);
        self.fallbacks += u64::from(!ok);
        self.timeouts += u64::from(slow);
    }
    fn merge(&mut self, o: Phase) {
        self.wall_us.extend(o.wall_us);
        self.fallbacks += o.fallbacks;
        self.timeouts += o.timeouts;
    }
}

/// The daemon's own stage timings over the minutes since `since_ms`: queue wait (scheduling delay) and processing (engine
/// time), from its load report.
fn daemon_stages(st: &serde_json::Value, since_ms: u64) -> (u64, u64, u64) {
    let floor = since_ms / 60_000 * 60_000;
    let minutes: Vec<&serde_json::Value> =
        st["load"]["minutes"].as_array().map(|m| m.iter().filter(|m| m["minute_start_ms"].as_u64().unwrap_or(0) >= floor).collect()).unwrap_or_default();
    let max_wait = minutes.iter().filter_map(|m| m["max_wait_us"].as_u64()).max().unwrap_or(0);
    let p95_proc = minutes.iter().filter_map(|m| m["p95_proc_us"].as_u64()).max().unwrap_or(0);
    let over = minutes.iter().filter_map(|m| m["calls_over_wait_threshold"].as_u64()).sum();
    (max_wait, p95_proc, over)
}

/// The machine's 1-minute load average, so a report read later says what the numbers were measured under.
fn loadavg() -> f64 {
    let mut l = [0f64; 3];
    // SAFETY: `getloadavg` writes at most `nelem` doubles into the buffer it is given, which holds three.
    let got = unsafe { libc::getloadavg(l.as_mut_ptr(), 3) };
    if got > 0 { l[0] } else { -1.0 }
}

fn now_ms() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis() as u64
}

fn phase_checks(r: &mut Report, name: &str, p: &mut Phase, st: &serde_json::Value, since_ms: u64, late: u64) {
    p.wall_us.sort_unstable();
    let budget = Duration::from_millis(engine_num("client.deadline_ms"));
    let p99 = pct(&p.wall_us, 99);
    r.check(&format!("{name}: calls"), p.wall_us.len(), "-", !p.wall_us.is_empty());
    r.check(&format!("{name}: client p99 (ms)"), format!("{:.1}", p99 as f64 / 1000.0), n("load.p99_ms_max"), p99 <= n("load.p99_ms_max") * 1000);
    r.check(
        &format!("{name}: client max within the hook budget (ms)"),
        format!("{:.1}", pct(&p.wall_us, 100) as f64 / 1000.0),
        budget.as_millis(),
        pct(&p.wall_us, 100) <= budget.as_micros() as u64 + ms("common.call_slack_ms").as_micros() as u64,
    );
    r.check(&format!("{name}: whole-event fallbacks"), p.fallbacks, n("load.fallbacks_max"), p.fallbacks <= n("load.fallbacks_max"));
    r.check(&format!("{name}: late replies (daemon slow_replies)"), late, n("load.late_max"), late <= n("load.late_max"));
    let (wait, proc_p95, over) = daemon_stages(st, since_ms);
    r.note(format!(
        "{name} stages: client wall p50 {:.1} ms, p95 {:.1} ms, p99 {:.1} ms, max {:.1} ms; daemon queue wait max {:.1} ms ({over} calls over the saturation wait); daemon processing p95 <= {:.1} ms; client timeouts {}",
        pct(&p.wall_us, 50) as f64 / 1000.0,
        pct(&p.wall_us, 95) as f64 / 1000.0,
        p99 as f64 / 1000.0,
        pct(&p.wall_us, 100) as f64 / 1000.0,
        wait as f64 / 1000.0,
        proc_p95 as f64 / 1000.0,
        p.timeouts,
    ));
}

#[test]
#[ignore = "hardening bar: minutes of wall time; run by scripts/soak.sh"]
fn load_sustained_and_burst_meet_the_bar_with_per_stage_timings() {
    let lab = Lab::new("load", &[]);
    let mut r = Report::new(60, "load");
    let traffic = std::sync::Arc::new(Traffic::new(&lab, n("load.transcript_kb"), n("load.sessions")));
    let deadline = Duration::from_millis(engine_num("client.deadline_ms"));
    let mut d = lab.serve();
    let up = lab.wait_for(|| lab.pid() == Some(d.id()));
    r.check("daemon up", up, true, up);
    let sock = lab.sock();
    for i in 0..n("load.warmup_calls") {
        timed_call(&sock, &traffic.request(i), deadline);
    }
    let pid = lab.pid();
    // sustained: clients paced so that together they make sustained_rps calls per second
    let clients = n("load.sustained_clients");
    let interval = Duration::from_secs_f64(clients as f64 / n("load.sustained_rps") as f64);
    let per_client = n("load.sustained_rps") * n("load.sustained_s") / clients;
    let late0 = lab.status()["slow_replies"].as_u64().unwrap_or(0);
    let since = now_ms();
    let mut sustained = Phase::default();
    let ws: Vec<_> = (0..clients)
        .map(|c| {
            let (traffic, sock) = (traffic.clone(), sock.clone());
            std::thread::spawn(move || {
                let mut p = Phase::default();
                let start = Instant::now();
                for k in 0..per_client {
                    let due = start + interval * k as u32 + interval.mul_f64(c as f64 / clients as f64);
                    if let Some(w) = due.checked_duration_since(Instant::now()) {
                        std::thread::sleep(w);
                    }
                    p.add(timed_call(&sock, &traffic.request(1000 + c * per_client + k), deadline));
                }
                p
            })
        })
        .collect();
    for w in ws {
        sustained.merge(w.join().unwrap());
    }
    let Some(st) = lab.try_status() else {
        r.check("daemon alive after the sustained phase", false, true, false);
        lab.note_log_tail(&mut r);
        return r.finish();
    };
    let late = st["slow_replies"].as_u64().unwrap_or(0) - late0;
    phase_checks(&mut r, "sustained", &mut sustained, &st, since, late);
    r.note(format!(
        "sustained: {} calls/s for {} s over {clients} clients; machine load average {:.1}",
        n("load.sustained_rps"),
        n("load.sustained_s"),
        loadavg()
    ));
    std::thread::sleep(ms("load.settle_ms"));
    // burst: clients released at once, back to back
    let late0 = st["slow_replies"].as_u64().unwrap_or(0);
    let since = now_ms();
    let gate = std::sync::Arc::new(std::sync::Barrier::new(n("load.burst_clients") as usize));
    let mut burst = Phase::default();
    let ws: Vec<_> = (0..n("load.burst_clients"))
        .map(|c| {
            let (traffic, sock, gate) = (traffic.clone(), sock.clone(), gate.clone());
            std::thread::spawn(move || {
                let mut p = Phase::default();
                gate.wait();
                for k in 0..n("load.burst_calls_per_client") {
                    p.add(timed_call(&sock, &traffic.request(500_000 + c * 1000 + k), deadline));
                }
                p
            })
        })
        .collect();
    for w in ws {
        burst.merge(w.join().unwrap());
    }
    let Some(st) = lab.try_status() else {
        r.check("daemon alive after the burst phase", false, true, false);
        lab.note_log_tail(&mut r);
        return r.finish();
    };
    let late = st["slow_replies"].as_u64().unwrap_or(0) - late0;
    phase_checks(&mut r, "burst", &mut burst, &st, since, late);
    r.note(format!(
        "burst: {} clients x {} calls, released together; machine load average {:.1}",
        n("load.burst_clients"),
        n("load.burst_calls_per_client"),
        loadavg()
    ));
    let same = lab.pid() == pid;
    r.check("same daemon throughout (no restart)", same, true, same);
    r.check("busy replies (load shedding)", st["busy_replies"].clone(), 0, st["busy_replies"].as_u64() == Some(0));
    r.check("hivecontrol stand-in calls", lab.hivecontrol_calls(), 0, lab.hivecontrol_calls() == 0);
    common::stop_child(&sock, &mut d);
    r.finish();
}

#[test]
#[ignore = "hardening bar: minutes of wall time; run by scripts/soak.sh"]
fn memory_soak_stays_in_the_rss_band_under_the_cap_with_no_recycle() {
    let lab = Lab::new("mem", &[]);
    let mut r = Report::new(70, "memory");
    let traffic = Traffic::new(&lab, n("memory.transcript_kb"), n("memory.sessions"));
    let deadline = Duration::from_millis(engine_num("client.deadline_ms"));
    // the allocator the daemon of this target links (src/memstat.rs): jemalloc where the crate supports the target
    let jemalloc = cfg!(any(all(target_os = "macos", target_arch = "aarch64"), all(target_os = "linux", target_env = "gnu")));
    let alloc = if jemalloc { "jemalloc" } else { "system" };
    let mut d = lab.serve();
    let up = lab.wait_for(|| lab.pid() == Some(d.id()));
    r.check("daemon up", up, true, up);
    let sock = lab.sock();
    let (total, warm, every) = (n("memory.calls"), n("memory.warmup_calls"), n("memory.sample_every"));
    let mut samples: Vec<(u64, u64, u64)> = Vec::new(); // (calls, rss_kb, heap_live_kb)
    let mut fallbacks = 0u64;
    let mut gone_at = None;
    let pid = lab.pid();
    let start = Instant::now();
    for i in 0..total {
        let (_, ok, _) = timed_call(&sock, &traffic.request(i), deadline);
        fallbacks += u64::from(!ok);
        if i + 1 >= warm && (i + 1 - warm) % every == 0 {
            let Some(st) = lab.try_status() else {
                gone_at = Some(i + 1);
                break;
            };
            samples.push((i + 1, st["memory"]["rss_kb"].as_u64().unwrap_or(0), st["memory"]["heap_live_kb"].as_u64().unwrap_or(0)));
        }
    }
    r.check("daemon alive for the whole soak", gone_at.map_or("yes".to_string(), |c| format!("gone by call {c}")), "yes", gone_at.is_none());
    if gone_at.is_some() {
        lab.note_log_tail(&mut r);
        r.finish();
        return;
    }
    let st = lab.status();
    let cap = engine_num("daemon.rss_cap_kb");
    r.check("calls answered by the daemon", total - fallbacks, total, fallbacks == 0);
    r.check("cap in force (daemon.rss_cap_kb)", st["rss_cap_kb"].clone(), cap, st["rss_cap_kb"].as_u64() == Some(cap) && cap > 0);
    let same = lab.pid() == pid && pid.is_some();
    r.check("same daemon throughout (no cap-triggered recycle)", same, true, same);
    r.check("restarts", st["restarts"].clone(), 0, st["restarts"].as_u64() == Some(0));
    let peak = samples.iter().map(|s| s.1).max().unwrap_or(0).max(st["memory"]["rss_kb"].as_u64().unwrap_or(0));
    r.check("RSS peak under the cap (KB)", peak, cap, peak < cap);
    let base = samples.first().map(|s| s.1).unwrap_or(0);
    let rise = peak.saturating_sub(base);
    let band = n(&format!("memory.band_kb_{alloc}"));
    r.check(&format!("RSS rise over call {warm} ({alloc}, KB)"), rise, band, rise <= band);
    // least-squares slope of RSS over calls, per 1,000 calls
    let k = samples.len() as f64;
    let (sx, sy) = samples.iter().fold((0.0, 0.0), |(a, b), s| (a + s.0 as f64, b + s.1 as f64));
    let (mx, my) = (sx / k, sy / k);
    let (num, den) = samples.iter().fold((0.0, 0.0), |(a, b), s| (a + (s.0 as f64 - mx) * (s.1 as f64 - my), b + (s.0 as f64 - mx).powi(2)));
    let slope = if den > 0.0 { num / den * 1000.0 } else { 0.0 };
    let slope_max = n(&format!("memory.slope_kb_per_1k_{alloc}"));
    r.check(&format!("RSS slope per 1,000 calls ({alloc}, KB)"), format!("{slope:.1}"), slope_max, slope <= slope_max as f64);
    r.note(format!(
        "{total} calls in {:.0} s, allocator {alloc}, machine load average {:.1}; samples (calls: rss KB / live heap KB):",
        start.elapsed().as_secs_f64(),
        loadavg()
    ));
    r.note(samples.iter().map(|s| format!("{}: {} / {}", s.0, s.1, s.2)).collect::<Vec<_>>().join(", "));
    r.check("hivecontrol stand-in calls", lab.hivecontrol_calls(), 0, lab.hivecontrol_calls() == 0);
    common::stop_child(&sock, &mut d);
    r.finish();
}
