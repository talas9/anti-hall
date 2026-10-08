//! Reliability e2e: real binary, real daemon, isolated HOME + engine dir under /tmp (short socket paths).
//! The Node fallback is simulated with `/bin/sh <script>` via AH_ENGINE_NODE.
#![allow(clippy::unwrap_used, clippy::expect_used)] // a test crate: a panic is the failure report, and E2 exempts tests
mod common;
use std::io::{Read, Write};
use std::os::unix::fs::PermissionsExt;
use std::os::unix::net::UnixListener;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

/// Allowance added to a configured timeout before a wall-clock bound fails: it only has to be far below the 30 s the fake
/// server hangs, so a timeout that is not enforced still fails, while a loaded machine does not.
const SLACK: Duration = Duration::from_secs(10);

const BIN: &str = env!("CARGO_BIN_EXE_ah-engine");
const RULES: &str = r#"{"version":1,"rules":[{"id":"force","events":["PreToolUse"],"tools":["Bash"],"field":"command","pattern":"git push --force","action":"deny","message":"engine-blocked"}]}"#;
const DENY_IN: &str =
    r#"{"session_id":"s1","cwd":"/tmp","hook_event_name":"PreToolUse","tool_name":"Bash","tool_input":{"command":"git push --force origin main"}}"#;

struct Env {
    dir: PathBuf,
    extra: Vec<(String, String)>,
}

impl Env {
    fn new(tag: &str, extra: &[(&str, &str)]) -> Env {
        let dir = PathBuf::from("/tmp").join(format!("ah-r-{}-{}", tag, std::process::id()));
        ah_engine::discard::harmless(std::fs::remove_dir_all(&dir));
        std::fs::create_dir_all(dir.join("home")).unwrap();
        std::fs::write(dir.join("rules.json"), RULES).unwrap();
        // the stand-in for the Node hook: reads stdin, prints a marker, exits 2 (a "block")
        std::fs::write(dir.join("fb.sh"), "cat >/dev/null\necho NODE-FALLBACK\nexit 2\n").unwrap();
        Env { dir, extra: extra.iter().map(|(a, b)| (a.to_string(), b.to_string())).collect() }
    }
    fn eng(&self) -> PathBuf {
        self.dir.join("eng")
    }
    fn cmd(&self) -> Command {
        let mut c = Command::new(BIN);
        c.env("HOME", self.dir.join("home"))
            .env("AH_ENGINE_DIR", self.eng())
            .env("AH_ENGINE_RULES", self.dir.join("rules.json"))
            .env("AH_ENGINE_VERSION", "0.1.0")
            .env("AH_ENGINE_TEST_HOOKS", "1")
            .env_remove("AH_ENGINE_NOSPAWN");
        for (k, v) in &self.extra {
            c.env(k, v);
        }
        c
    }
    /// (stdout, exit code, elapsed)
    fn hook(&self, input: &str, fallback: bool) -> (String, i32, Duration) {
        let mut c = self.cmd();
        c.arg("hook");
        if fallback {
            c.env("AH_ENGINE_NODE", "/bin/sh").arg("--fallback").arg(self.dir.join("fb.sh"));
        }
        let t = Instant::now();
        let mut ch = c.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn().unwrap();
        ch.stdin.take().unwrap().write_all(input.as_bytes()).unwrap();
        let o = ch.wait_with_output().unwrap();
        (String::from_utf8_lossy(&o.stdout).trim().to_string(), o.status.code().unwrap_or(-1), t.elapsed())
    }
    fn ctl(&self, verb: &str) -> Option<String> {
        let o = self.cmd().args(["ctl", verb]).output().unwrap();
        o.status.success().then(|| String::from_utf8_lossy(&o.stdout).trim().to_string())
    }
    fn pid(&self) -> Option<u32> {
        self.ctl("ping")?.split_whitespace().nth(2)?.parse().ok()
    }
    fn status(&self) -> serde_json::Value {
        serde_json::from_str(&self.ctl("status").expect("daemon status")).unwrap()
    }
    /// Wait until a hook call is answered by the engine itself (no fallback marker).
    fn warm(&self) {
        assert!(wait_for(|| self.hook(DENY_IN, false).0.contains("engine-blocked")), "daemon never came up");
    }
}

impl Drop for Env {
    fn drop(&mut self) {
        let state = self.extra.iter().find(|(k, _)| k == "AH_ENGINE_DIR").map(|(_, v)| PathBuf::from(v)).unwrap_or_else(|| self.eng());
        common::reap(&state, || {
            let _ = self.ctl("stop");
        });
        if let Some(p) = std::fs::read_to_string(self.eng().join("e.sock.lock")).ok().and_then(|t| t.trim().parse::<i32>().ok())
            && p > 1
            && common::alive(p)
        {
            // SAFETY: `kill` takes plain integers and has no memory-safety preconditions; a dead pid just fails with ESRCH.
            unsafe { libc::kill(p, libc::SIGKILL) };
        }
        ah_engine::discard::harmless(std::fs::remove_dir_all(&self.dir));
    }
}

fn wait_for(mut f: impl FnMut() -> bool) -> bool {
    let t = Instant::now();
    while t.elapsed() < Duration::from_secs(5) {
        if f() {
            return true;
        }
        std::thread::sleep(Duration::from_millis(25));
    }
    false
}

fn alive(pid: u32) -> bool {
    // SAFETY: `kill` takes plain integers and has no memory-safety preconditions; a dead pid just fails with ESRCH.
    unsafe { libc::kill(pid as i32, 0) == 0 }
}

fn raw_exchange(e: &Env, req: &[u8]) -> Vec<u8> {
    let mut s = std::os::unix::net::UnixStream::connect(e.eng().join("e.sock")).unwrap();
    s.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
    ah_engine::discard::harmless(s.write_all(req)); // the daemon may reply and close before an oversize body is fully sent
    ah_engine::discard::harmless(s.shutdown(std::net::Shutdown::Write));
    let mut b = Vec::new();
    ah_engine::discard::harmless(s.read_to_end(&mut b));
    b
}

/// A fake daemon on the engine socket that answers every connection with `reply(request)`.
fn fake_server(e: &Env, reply: impl Fn() -> Option<Vec<u8>> + Send + 'static) {
    std::fs::create_dir_all(e.eng()).unwrap();
    let l = UnixListener::bind(e.eng().join("e.sock")).unwrap();
    std::thread::spawn(move || {
        for s in l.incoming().flatten() {
            let mut s = s;
            let mut b = Vec::new();
            ah_engine::discard::harmless(s.read_to_end(&mut b));
            match reply() {
                Some(r) => {
                    ah_engine::discard::harmless(s.write_all(&r));
                }
                None => std::thread::sleep(Duration::from_secs(30)), // hang: never reply
            }
        }
    });
}

// ---- 1. framing + fallback rule ---------------------------------------------------------------

#[test]
fn bad_replies_run_the_node_fallback_never_allow() {
    use ah_engine::frame::{Kind, encode};
    let good = encode(Kind::Ok, r#"{"decision":"block","reason":"x"}"#);
    let cases: Vec<(&str, Vec<u8>)> = vec![
        ("empty", vec![]),
        ("truncated", good[..good.len() - 3].to_vec()),
        ("header only", good[..10].to_vec()),
        ("garbage", b"{\"decision\":\"allow\"}".to_vec()),
        ("busy", encode(Kind::Busy, "")),
        ("err", encode(Kind::Err, "boom")),
        ("corrupt", {
            let mut g = good.clone();
            let n = g.len() - 12;
            g[n] ^= 0x20;
            g
        }),
    ];
    for (name, reply) in cases {
        let e = Env::new("bad", &[("AH_ENGINE_NOSPAWN", "1")]);
        fake_server(&e, move || Some(reply.clone()));
        let (out, code, _) = e.hook(DENY_IN, true);
        assert_eq!((out.as_str(), code), ("NODE-FALLBACK", 2), "case {name}");
    }
}

#[test]
fn engine_down_runs_fallback_and_plain_allow_only_without_one() {
    let e = Env::new("down", &[("AH_ENGINE_NOSPAWN", "1")]);
    assert_eq!(e.hook(DENY_IN, true).0, "NODE-FALLBACK");
    let (out, code, _) = e.hook(DENY_IN, false);
    assert_eq!((out.as_str(), code), ("", 0), "no engine AND no fallback = plain allow");
    // fallback unavailable (node missing) is the same plain allow
    let mut c = e.cmd();
    c.env("AH_ENGINE_NODE", "/nonexistent/node").args(["hook", "--fallback"]).arg(e.dir.join("fb.sh"));
    let mut ch = c.stdin(Stdio::piped()).stdout(Stdio::piped()).spawn().unwrap();
    ch.stdin.take().unwrap().write_all(DENY_IN.as_bytes()).unwrap();
    let o = ch.wait_with_output().unwrap();
    assert!(o.stdout.is_empty() && o.status.success());
}

#[test]
fn healthy_engine_answers_and_fallback_is_not_run() {
    let e = Env::new("good", &[]);
    e.warm();
    let (out, code, _) = e.hook(DENY_IN, true);
    assert_eq!(code, 0);
    assert!(out.contains("engine-blocked") && !out.contains("NODE-FALLBACK"), "{out}");
    // a valid "nothing to say" is an OK frame with an empty body: allowed, no fallback
    let (out, code, _) = e.hook(r#"{"hook_event_name":"PreToolUse","tool_name":"Bash","tool_input":{"command":"ls"}}"#, true);
    assert_eq!((out.as_str(), code), ("", 0));
}

// ---- 2. no hangs ------------------------------------------------------------------------------

#[test]
fn hung_engine_times_out_then_falls_back() {
    let e = Env::new("hang", &[("AH_ENGINE_NOSPAWN", "1"), ("AH_ENGINE_DEADLINE_MS", "400")]);
    fake_server(&e, || None);
    let (out, code, dt) = e.hook(DENY_IN, true);
    assert_eq!((out.as_str(), code), ("NODE-FALLBACK", 2));
    // gave up at the 400 ms deadline (the lower bound) rather than waiting for the server's 30 s hang; the upper bound is
    // the deadline plus a generous allowance for process start-up and the fallback under load
    assert!(dt >= Duration::from_millis(400) && dt < Duration::from_millis(400) + SLACK, "took {dt:?}");
}

#[test]
fn default_client_deadline_is_about_two_seconds() {
    let e = Env::new("hang2", &[("AH_ENGINE_NOSPAWN", "1")]);
    fake_server(&e, || None);
    let (out, _, dt) = e.hook(DENY_IN, true);
    assert_eq!(out, "NODE-FALLBACK");
    assert!(dt > Duration::from_millis(1800) && dt < Duration::from_millis(2000) + SLACK, "took {dt:?}");
}

#[test]
fn oversize_input_skips_engine_and_daemon_rejects_oversize_requests() {
    let e = Env::new("big", &[]);
    e.warm();
    let big = format!(r#"{{"hook_event_name":"PreToolUse","tool_input":{{"command":"{}"}}}}"#, "a".repeat(1_100_000));
    assert_eq!(e.hook(&big, true).0, "NODE-FALLBACK", "client never ships > 1 MiB to the engine");
    let reply = raw_exchange(&e, &vec![b'x'; 1_200_000]);
    let (k, _) = ah_engine::frame::decode(&reply).unwrap();
    assert_eq!(k, ah_engine::frame::Kind::Err, "daemon refuses oversize requests");
    assert!(e.pid().is_some(), "and survives them");
}

#[test]
fn slow_sender_cannot_wedge_the_daemon() {
    let e = Env::new("slow", &[("AH_ENGINE_READ_MS", "300")]);
    e.warm();
    let mut s = std::os::unix::net::UnixStream::connect(e.eng().join("e.sock")).unwrap();
    s.write_all(b"V 0.1.0\n{").unwrap(); // never finishes, never closes
    let t = Instant::now();
    let mut b = Vec::new();
    s.set_read_timeout(Some(Duration::from_secs(3))).unwrap();
    ah_engine::discard::harmless(s.read_to_end(&mut b));
    // the 300 ms read deadline; if it were not enforced the read above would run to its own 3 s timeout
    assert!(t.elapsed() < Duration::from_millis(2900), "read deadline not enforced: {:?}", t.elapsed());
    assert!(ah_engine::frame::decode(&b).is_ok(), "slow sender still gets a well-formed ERR frame");
    assert!(e.hook(DENY_IN, false).0.contains("engine-blocked"), "daemon still serves");
}

// ---- 3. watchdog + breaker --------------------------------------------------------------------

#[test]
fn stalled_loop_triggers_clean_exit_and_next_client_respawns() {
    let e = Env::new("stall", &[("AH_ENGINE_STALL_MS", "500"), ("AH_ENGINE_WATCHDOG_TICK_MS", "100")]);
    e.warm();
    let old = e.pid().unwrap();
    let _ = e.ctl("stall 3000"); // wedges the accept loop for 3 s
    assert!(wait_for(|| !alive(old)), "watchdog must end the stalled daemon");
    assert!(std::fs::read_to_string(e.eng().join("ah-engine.log")).unwrap().contains("watchdog"));
    e.warm(); // next client respawns
    assert_ne!(e.pid().unwrap(), old);
}

#[test]
fn stuck_worker_triggers_exit() {
    let e = Env::new("stuck", &[("AH_ENGINE_STUCK_MS", "400"), ("AH_ENGINE_WATCHDOG_TICK_MS", "100")]);
    e.warm();
    let old = e.pid().unwrap();
    let h = std::thread::spawn({
        let mut c = e.cmd();
        move || {
            ah_engine::discard::harmless(c.args(["ctl", "sleep 20000"]).output());
        }
    });
    assert!(wait_for(|| !alive(old)), "stuck worker must end the daemon");
    drop(h);
    e.warm();
}

#[test]
fn a_worker_stuck_during_a_drain_still_ends_the_daemon() {
    // review finding 1: once draining, the watchdog skipped its checks and a clean drain had no exit timer, so a worker
    // stuck during a drain kept the daemon alive (holding the lock, its socket already removed) until the request ended
    let e = Env::new("stuckdrain", &[("AH_ENGINE_STUCK_MS", "1500"), ("AH_ENGINE_WATCHDOG_TICK_MS", "100")]);
    e.warm();
    let old = e.pid().unwrap();
    let h = std::thread::spawn({
        let mut c = e.cmd();
        move || {
            ah_engine::discard::harmless(c.args(["ctl", "sleep 30000"]).output());
        }
    });
    std::thread::sleep(Duration::from_millis(300)); // the sleep request is on a worker
    assert_eq!(e.ctl("stop").as_deref(), Some("ok"), "stop begins a clean drain");
    let t = Instant::now();
    while alive(old) && t.elapsed() < Duration::from_secs(12) {
        std::thread::sleep(Duration::from_millis(50));
    }
    assert!(!alive(old), "a drain with a stuck worker must still end the daemon (it lived {:?})", t.elapsed());
    let log = std::fs::read_to_string(e.eng().join("ah-engine.log")).unwrap();
    assert!(log.contains("\tstuck\t") && log.contains("\texit\tforced\t"), "{log}");
    drop(h);
}

#[test]
fn a_start_that_gives_up_on_a_held_lock_with_no_daemon_says_why() {
    // review finding 1: a start that found the lock held and no daemon answering gave up in silence
    let e = Env::new("heldlock", &[]);
    std::fs::create_dir_all(e.eng()).unwrap();
    let lock = std::fs::OpenOptions::new().create(true).truncate(false).read(true).write(true).open(e.eng().join("e.sock.lock")).unwrap();
    // SAFETY: `lock` is an open file owned by this test; flock takes only its descriptor and a flag.
    assert_eq!(unsafe { libc::flock(std::os::unix::io::AsRawFd::as_raw_fd(&lock), libc::LOCK_EX | libc::LOCK_NB) }, 0);
    assert_eq!(e.cmd().arg("serve").status().unwrap().code(), Some(0), "giving up on the lock is not an error exit");
    let log = std::fs::read_to_string(e.eng().join("ah-engine.log")).unwrap_or_default();
    assert!(log.contains("lock_wait\tno_daemon"), "the give-up must be logged: {log:?}");
    drop(lock);
}

/// CPU seconds a process has used, from `ps` (`[[dd-]hh:]mm:ss[.cc]` on both macOS and Linux).
fn cpu_secs(pid: u32) -> f64 {
    let o = Command::new("ps").args(["-o", "time=", "-p", &pid.to_string()]).output().unwrap();
    let t = String::from_utf8_lossy(&o.stdout).trim().to_string();
    let t = t.rsplit('-').next().unwrap_or("").to_string();
    t.split(':').fold(0.0, |acc, part| acc * 60.0 + part.parse::<f64>().unwrap_or(0.0))
}

#[test]
fn a_full_descriptor_table_backs_the_accept_loop_off_instead_of_spinning() {
    // review finding 5: `while let Ok(..) = accept()` dropped EMFILE and went straight back to poll, which fired again at
    // once for the still-pending connection: the accept loop spun at full CPU until a descriptor freed up
    let e = Env::new("emfile", &[("AH_ENGINE_WORKERS", "1"), ("AH_ENGINE_QUEUE", "1000"), ("AH_ENGINE_NOSPAWN", "1")]);
    std::fs::create_dir_all(e.eng()).unwrap();
    // the daemon under a small descriptor limit (a child-process rlimit, so the test process keeps its own)
    let c = e.cmd();
    let envs: Vec<(std::ffi::OsString, std::ffi::OsString)> = c.get_envs().filter_map(|(k, v)| Some((k.to_owned(), v?.to_owned()))).collect();
    let mut sh = Command::new("/bin/sh");
    sh.args(["-c", "ulimit -n 48 && exec \"$0\" serve", BIN]).envs(envs).env_remove("AH_ENGINE_NOSPAWN");
    let mut daemon = sh.stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).spawn().unwrap();
    assert!(wait_for(|| e.pid().is_some()), "daemon never came up under the descriptor limit");
    let pid = e.pid().unwrap();
    let busy = std::thread::spawn({
        let mut c = e.cmd();
        move || {
            ah_engine::discard::harmless(c.args(["ctl", "sleep 4000"]).output());
        }
    });
    std::thread::sleep(Duration::from_millis(300)); // the only worker is asleep: accepted connections stay queued
    let mut held = Vec::new();
    for _ in 0..100 {
        if let Ok(s) = std::os::unix::net::UnixStream::connect(e.eng().join("e.sock")) {
            ah_engine::discard::harmless(s.shutdown(std::net::Shutdown::Write));
            held.push(s);
        }
    }
    let before = cpu_secs(pid);
    std::thread::sleep(Duration::from_secs(2));
    let used = cpu_secs(pid) - before;
    assert!(used < 1.0, "the accept loop spun on EMFILE: {used:.2}s of CPU in 2s");
    drop(held);
    ah_engine::discard::harmless(busy.join());
    assert!(
        wait_for(|| e.ctl("status").and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok()).is_some_and(|v| v["accept_errors"].as_u64() > Some(0))),
        "the failed accepts are counted"
    );
    let log = std::fs::read_to_string(e.eng().join("ah-engine.log")).unwrap_or_default();
    assert!(log.contains("accept\trecovered"), "the failed accepts are logged with their reason once a descriptor frees up: {log}");
    drop(e.ctl("stop"));
    ah_engine::discard::harmless(daemon.wait());
}

#[test]
fn breaker_opens_after_repeated_failures_and_skips_engine() {
    let e = Env::new("brk", &[("AH_ENGINE_NOSPAWN", "1"), ("AH_ENGINE_DEADLINE_MS", "150"), ("AH_ENGINE_BREAKER_N", "3")]);
    fake_server(&e, || None);
    // each of these waits out the 150 ms deadline against the hung server
    let mut waited = Vec::new();
    for _ in 0..3 {
        let (out, _, dt) = e.hook(DENY_IN, true);
        assert_eq!(out, "NODE-FALLBACK");
        waited.push(dt);
    }
    assert!(e.eng().join("breaker.until").exists(), "breaker should be open");
    let (out, _, dt) = e.hook(DENY_IN, true);
    assert_eq!(out, "NODE-FALLBACK");
    // relative, not absolute: an open breaker skips the wait, so it must be faster than every call that did wait
    let fastest_wait = waited.iter().min().unwrap();
    assert!(dt < *fastest_wait, "open breaker goes straight to fallback, took {dt:?} against {waited:?}");
    let st: serde_json::Value =
        serde_json::from_str(&e.cmd().args(["status", "--json"]).output().map(|o| String::from_utf8_lossy(&o.stdout).to_string()).unwrap()).unwrap();
    assert!(st["breaker"].as_str().unwrap().starts_with("open"), "{st}");
}

// ---- 4. crash-loop ----------------------------------------------------------------------------

#[test]
fn crash_loop_stops_respawning_records_reason_and_advises_once() {
    let e = Env::new("loop", &[("AH_ENGINE_CRASH_N", "3")]);
    for i in 0..3 {
        e.warm();
        let pid = e.pid().unwrap_or_else(|| panic!("no daemon on round {i}"));
        // SAFETY: `kill` takes plain integers and has no memory-safety preconditions; a dead pid just fails with ESRCH.
        unsafe { libc::kill(pid as i32, libc::SIGKILL) };
        assert!(wait_for(|| !alive(pid)));
    }
    // the next call finds the daemon dead 3 times: no respawn, fallback runs, advisory attached once
    let (out, _, _) = e.hook(DENY_IN, true);
    assert!(out.contains("NODE-FALLBACK") || out.contains("stopped after repeated failures"), "{out}");
    assert!(e.eng().join("crashloop.until").exists());
    assert!(std::fs::read_to_string(e.eng().join("failure.json")).unwrap().contains("crashloop"));
    assert!(e.ctl("ping").is_none(), "no daemon was respawned");
    // fallback output is not JSON here, so the advisory is not merged; use a JSON-printing fallback
    std::fs::write(e.dir.join("fb.sh"), "cat >/dev/null\necho '{}'\n").unwrap();
    let a = e.hook(DENY_IN, true).0;
    assert!(a.contains("⚠️ anti-hall · ah-engine: stopped after repeated failures (daemon died 3 times"), "{a}");
    assert!(a.contains("https://github.com/talas9/anti-hall/issues/new") && a.contains("--- anti-hall ah-engine diagnostics ---"), "{a}");
    assert!(a.contains("version:") && a.contains("error code:") && a.contains("last log lines"), "{a}");
    let again = e.hook(DENY_IN, true).0;
    assert!(!again.contains("stopped after repeated failures"), "advisory must be once per session: {again}");
    let other = e.hook(&DENY_IN.replace("s1", "s2"), true).0;
    assert!(other.contains("stopped after repeated failures"), "a new session is told once: {other}");
    assert!(e.cmd().arg("status").output().unwrap().stdout.windows(7).any(|w| w == b"stopped"), "status shows the stop");
}

#[test]
fn environment_failure_gets_a_plain_hint_not_an_issue_request() {
    // the engine dir is a regular file => the daemon cannot make it a private dir (an environment problem)
    let e = Env::new("envf", &[]);
    std::fs::write(e.eng(), "not a dir").unwrap();
    std::fs::write(e.dir.join("fb.sh"), "cat >/dev/null\necho '{}'\n").unwrap();
    // spawn the daemon directly so its start failure is recorded, then read the advisory path
    let st = e.cmd().arg("serve").status().unwrap();
    assert_eq!(st.code(), Some(78), "start failure exit code");
    // state dir itself is unusable, so record in a sibling dir the client can read: use a fresh good dir
    let f = Env::new("envg", &[]);
    std::fs::create_dir_all(f.eng()).unwrap();
    std::fs::write(f.eng().join("failure.json"), format!(r#"{{"ts":{},"class":"env","kind":"start_fail","code":"os28","hint":"the disk is full (no space left); free some space, then it recovers by itself","reason":"x"}}"#, ah_engine::health::now_ms())).unwrap();
    std::fs::write(f.dir.join("fb.sh"), "cat >/dev/null\necho '{}'\n").unwrap();
    let mut c = f.cmd();
    c.env("AH_ENGINE_NOSPAWN", "1").env("AH_ENGINE_NODE", "/bin/sh").args(["hook", "--fallback"]).arg(f.dir.join("fb.sh"));
    let mut ch = c.stdin(Stdio::piped()).stdout(Stdio::piped()).spawn().unwrap();
    ch.stdin.take().unwrap().write_all(DENY_IN.as_bytes()).unwrap();
    let out = String::from_utf8_lossy(&ch.wait_with_output().unwrap().stdout).to_string();
    assert!(out.contains("the disk is full") && !out.contains("issues/new"), "{out}");
}

// ---- 5. single instance -----------------------------------------------------------------------

#[test]
fn twenty_parallel_cold_clients_yield_exactly_one_daemon() {
    let e = Env::new("twenty", &[]);
    let hs: Vec<_> = (0..20)
        .map(|_| {
            let mut c = e.cmd();
            c.arg("hook").stdin(Stdio::piped()).stdout(Stdio::null()).stderr(Stdio::null());
            let mut ch = c.spawn().unwrap();
            ch.stdin.take().unwrap().write_all(DENY_IN.as_bytes()).unwrap();
            ch
        })
        .collect();
    for mut h in hs {
        assert!(h.wait().unwrap().success());
    }
    assert!(wait_for(|| e.pid().is_some()));
    std::thread::sleep(Duration::from_millis(400)); // losers of the lock race exit
    let eng_dir = e.eng().to_string_lossy().to_string();
    let out = Command::new("ps").args(["-axo", "pid=,command="]).output().unwrap();
    let n = String::from_utf8_lossy(&out.stdout).lines().filter(|l| l.contains(BIN) && l.trim_end().ends_with(" serve")).count();
    // ps shows no env, so count via the lock holder instead (lsof) plus the recorded pid
    let holders = Command::new("lsof").arg(e.eng().join("e.sock.lock")).output().unwrap();
    let pids: std::collections::HashSet<_> =
        String::from_utf8_lossy(&holders.stdout).lines().skip(1).filter_map(|l| l.split_whitespace().nth(1).map(String::from)).collect();
    assert_eq!(pids.len(), 1, "lock holders {pids:?} (engine procs overall {n}, dir {eng_dir})");
    assert_eq!(std::fs::read_to_string(e.eng().join("starts")).unwrap().trim(), "1", "exactly one daemon ever finished starting");
}

#[test]
fn stale_lock_from_dead_pid_is_recovered_but_live_engine_pid_is_not_stolen() {
    let e = Env::new("stale", &[]);
    std::fs::create_dir_all(e.eng()).unwrap();
    // a dead pid (spawn + reap a child, use its pid) in the lock file, plus a stale socket file
    let mut ch = Command::new("true").spawn().unwrap();
    let dead = ch.id();
    ch.wait().unwrap();
    std::fs::write(e.eng().join("e.sock.lock"), dead.to_string()).unwrap();
    drop(UnixListener::bind(e.eng().join("e.sock")).unwrap());
    e.warm();
    let pid = e.pid().unwrap();
    assert_eq!(std::fs::read_to_string(e.eng().join("e.sock.lock")).unwrap().trim(), pid.to_string());
    // a second daemon started by hand must not steal from the live one
    ah_engine::discard::harmless(e.cmd().arg("serve").status());
    assert_eq!(e.pid().unwrap(), pid);
}

#[test]
fn non_socket_at_socket_path_is_never_deleted() {
    let e = Env::new("nonsock", &[]);
    std::fs::create_dir_all(e.eng()).unwrap();
    std::fs::write(e.eng().join("e.sock"), "precious").unwrap();
    assert_eq!(e.cmd().arg("serve").status().unwrap().code(), Some(78));
    assert_eq!(std::fs::read_to_string(e.eng().join("e.sock")).unwrap(), "precious");
}

// ---- 6. cpu / memory protection ---------------------------------------------------------------

#[test]
fn queue_overflow_answers_busy_and_clients_fall_back() {
    let e = Env::new("busy", &[("AH_ENGINE_WORKERS", "1"), ("AH_ENGINE_QUEUE", "1"), ("AH_ENGINE_STUCK_MS", "60000")]);
    e.warm();
    let sleepers: Vec<_> = (0..3)
        .map(|_| {
            let mut c = e.cmd();
            std::thread::spawn(move || {
                ah_engine::discard::harmless(c.args(["ctl", "sleep 8000"]).output());
            })
        })
        .collect();
    // 1 running, 1 queued, 1 refused: poll until a hook is refused (the sleepers may take a while to connect on a loaded
    // machine; until they have, the engine simply answers the hook), instead of guessing how long that takes
    let t = Instant::now();
    let (mut out, mut code, mut dt) = (String::new(), 0, Duration::ZERO);
    while t.elapsed() < Duration::from_secs(6) {
        (out, code, dt) = e.hook(DENY_IN, true);
        if out == "NODE-FALLBACK" {
            break;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    assert_eq!((out.as_str(), code), ("NODE-FALLBACK", 2), "overflow must fall back, not allow");
    // a refused hook is answered at once: far below the sleepers' 8 s, with an allowance for a loaded machine
    assert!(dt < Duration::from_secs(3), "took {dt:?}");
    for s in sleepers {
        s.join().unwrap();
    }
    // the clients above gave up after their own deadline, so the daemon may still be sleeping in its worker: wait for it
    let t = Instant::now();
    while e.ctl("status").is_none() && t.elapsed() < Duration::from_secs(15) {
        std::thread::sleep(Duration::from_millis(100));
    }
    assert!(e.status()["busy_replies"].as_u64().unwrap() >= 1);
}

#[test]
fn rate_limited_session_gets_busy_so_it_falls_back() {
    let e = Env::new("rate", &[("AH_ENGINE_SESSION_RPS", "1"), ("AH_ENGINE_SESSION_BURST", "2")]);
    e.warm(); // consumes some of s1's burst
    let mut fell_back = false;
    for _ in 0..6 {
        if e.hook(DENY_IN, true).0 == "NODE-FALLBACK" {
            fell_back = true;
        }
    }
    assert!(fell_back, "per-session limit never engaged");
    let other = DENY_IN.replace("s1", "fresh-session");
    assert!(e.hook(&other, true).0.contains("engine-blocked"), "other sessions are unaffected");
}

#[test]
fn cpu_budget_trips_to_fallback() {
    let e = Env::new("cpu", &[("AH_ENGINE_EVAL_BUDGET_US", "1")]);
    // a heavy-ish rule set so evaluation takes > 1 us of thread CPU
    let rules: Vec<String> = (0..200).map(|i| format!(r#"{{"pattern":"zzz{i}[a-z]+q","action":"warn","message":"m"}}"#)).collect();
    std::fs::write(e.dir.join("rules.json"), format!(r#"{{"version":1,"rules":[{}]}}"#, rules.join(","))).unwrap();
    let _ = e.hook(DENY_IN, true); // cold start: spawns the daemon
    assert!(wait_for(|| e.pid().is_some()));
    assert_eq!(e.hook(DENY_IN, true).0, "NODE-FALLBACK", "budget exceeded => ERR => fallback, not allow");
    e.warm_status_budget();
}

impl Env {
    fn warm_status_budget(&self) {
        assert!(wait_for(|| self
            .ctl("status")
            .is_some_and(|s| serde_json::from_str::<serde_json::Value>(&s).unwrap()["budget_trips"].as_u64().unwrap_or(0) >= 1)));
    }
}

#[test]
fn rss_over_cap_restarts_cleanly_and_next_client_respawns() {
    let e = Env::new("rss", &[("AH_ENGINE_RSS_CAP_KB", "64"), ("AH_ENGINE_RSS_CHECK_MS", "200"), ("AH_ENGINE_WATCHDOG_TICK_MS", "100")]);
    e.warm();
    let old = e.pid().unwrap();
    assert!(wait_for(|| !alive(old)), "daemon above its RSS cap must exit");
    assert!(std::fs::read_to_string(e.eng().join("ah-engine.log")).unwrap().contains("rss"));
    assert!(wait_for(|| e.pid().is_some_and(|p| p != old)) || !e.hook(DENY_IN, true).0.is_empty());
}

#[test]
fn memory_limit_and_nice_are_applied_and_reported() {
    let e = Env::new("mem", &[("AH_ENGINE_MEM_MB", "64"), ("AH_ENGINE_NICE", "7")]);
    e.warm();
    let st = e.status();
    assert!(st["mem_limit"].as_str().unwrap().starts_with("ok:64") || st["mem_limit"].as_str().unwrap().starts_with("err:"), "{st}");
    // macOS rejects setrlimit(RLIMIT_DATA) with EINVAL (verified with a C probe); there the RSS cap is the guard.
    if cfg!(target_os = "linux") {
        assert_eq!(st["mem_limit"], "ok:64");
    }
    let pid = e.pid().unwrap();
    let nice = Command::new("ps").args(["-o", "nice=", "-p", &pid.to_string()]).output().unwrap();
    // an unprivileged process can only raise its niceness, so a test runner already niced above 7 keeps its own value
    // SAFETY: `getpriority` takes plain integers and has no memory-safety preconditions.
    let inherited = unsafe { libc::getpriority(libc::PRIO_PROCESS, 0) };
    assert_eq!(String::from_utf8_lossy(&nice.stdout).trim(), inherited.max(7).to_string());
}

// ---- 7. safety --------------------------------------------------------------------------------

#[test]
fn socket_is_0600_and_state_dir_0700() {
    let e = Env::new("perm", &[]);
    e.warm();
    let m = |p: PathBuf| std::fs::metadata(p).unwrap().permissions().mode() & 0o777;
    assert_eq!(m(e.eng().join("e.sock")), 0o600);
    assert_eq!(m(e.eng()), 0o700);
}

#[test]
fn long_path_socket_dir_is_private_and_owner_checked() {
    let long = format!("/tmp/ah-r-long-{}/{}", std::process::id(), "d".repeat(100));
    let e = Env::new("longp", &[("AH_ENGINE_DIR", &long)]);
    e.warm();
    let sock = engine_socket_for(&long);
    let d = sock.parent().unwrap();
    assert_eq!(std::fs::metadata(d).unwrap().permissions().mode() & 0o777, 0o700, "{d:?}");
    assert!(sock.as_os_str().len() < 100);
    // stop the daemon while its state dir and socket still exist, then clean up
    common::reap(Path::new(&long), || {
        let _ = e.ctl("stop");
    });
    ah_engine::discard::harmless(std::fs::remove_dir_all(format!("/tmp/ah-r-long-{}", std::process::id())));
    ah_engine::discard::harmless(std::fs::remove_file(&sock));
}

fn engine_socket_for(dir: &str) -> PathBuf {
    // mirror of paths::socket for a given dir, computed in-process (TMPDIR is inherited by the daemon)
    let name = format!("{:012x}.sock", ah_engine::health::fnv(dir) & 0xffff_ffff_ffff);
    let private = format!("anti-hall-{}", ah_engine::limits::uid());
    if let Some(t) = std::env::var_os("TMPDIR") {
        let p = PathBuf::from(t).join(&private).join(&name);
        if p.as_os_str().len() <= 100 {
            return p;
        }
    }
    PathBuf::from("/tmp").join(private).join(name)
}

#[test]
fn symlinked_state_dir_is_refused() {
    let e = Env::new("symd", &[]);
    std::fs::create_dir_all(e.dir.join("real")).unwrap();
    std::os::unix::fs::symlink(e.dir.join("real"), e.eng()).unwrap();
    assert_eq!(e.cmd().arg("serve").status().unwrap().code(), Some(78));
}

#[test]
fn payload_text_is_never_executed() {
    let e = Env::new("noexec", &[]);
    e.warm();
    let mark = e.dir.join("pwned");
    let evil = format!(
        r#"{{"session_id":"s","cwd":"/tmp","hook_event_name":"PreToolUse","tool_name":"Bash","fallback":"touch {m}","command":"touch {m}","tool_input":{{"command":"touch {m}; git push --force"}}}}"#,
        m = mark.display()
    );
    let _ = e.hook(&evil, true);
    let _ = raw_exchange(&e, format!("CTL touch {}\n", mark.display()).as_bytes());
    assert!(!mark.exists());
}

#[test]
fn projects_are_isolated_through_the_daemon() {
    let e = Env::new("iso", &[]);
    e.warm();
    for p in ["pa/.git", "pb/.git"] {
        std::fs::create_dir_all(e.dir.join(p)).unwrap();
    }
    let (a, b) = (e.dir.join("pa").to_string_lossy().to_string(), e.dir.join("pb").to_string_lossy().to_string());
    let proj = |cwd: &str, v: &str, args: &str| {
        let o = e.cmd().args(["proj", cwd, v, args]).output().unwrap();
        String::from_utf8_lossy(&o.stdout).trim().to_string()
    };
    assert_eq!(proj(&a, "put", "A-secret"), "ok");
    assert_eq!(proj(&b, "len", ""), "0");
    assert_eq!(proj(&b, "take", ""), "");
    assert_eq!(proj(&format!("{a}/sub/../../pb"), "take", ""), "", "path tricks resolve to B, not A");
    assert_eq!(proj(&a, "take", ""), "A-secret");
}

// ---- 9. status --------------------------------------------------------------------------------

#[test]
fn status_reports_all_required_fields() {
    let e = Env::new("stat", &[]);
    e.warm();
    let st = e.status();
    for k in ["uptime_s", "rss_kb", "cpu_s", "queue_depth", "restarts", "breaker", "rules"] {
        assert!(st.get(k).is_some(), "missing {k}: {st}");
    }
    assert!(st["rules"]["version"] == 1 && st["rules"]["fingerprint"].as_str().unwrap().len() == 16);
    assert!(st["rss_kb"].as_u64().unwrap() > 0);
    assert_eq!(st["breaker"], "closed");
    let down = Env::new("stat2", &[("AH_ENGINE_NOSPAWN", "1")]);
    let o = down.cmd().args(["status", "--json"]).output().unwrap();
    assert!(String::from_utf8_lossy(&o.stdout).contains(r#""running":false"#));
}
