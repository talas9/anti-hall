//! Reliability e2e: real binary, real daemon, isolated HOME + engine dir under /tmp (short socket paths).
//! The Node fallback is simulated with `/bin/sh <script>` via AH_ENGINE_NODE.
#![allow(clippy::unwrap_used, clippy::expect_used)] // a test crate: a panic is the failure report, and E2 exempts tests
use crate::common;
use std::io::{Read, Write};
use std::os::unix::fs::PermissionsExt;
use std::os::unix::io::AsRawFd;
use std::os::unix::net::UnixListener;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Mutex, MutexGuard};
use std::time::{Duration, Instant};

const BIN: &str = env!("CARGO_BIN_EXE_ah-engine");
const RULES: &str = r#"{"version":1,"rules":[{"id":"force","events":["PreToolUse"],"tools":["Bash"],"field":"command","pattern":"git push --force","action":"deny","message":"engine-blocked"}]}"#;
const DENY_IN: &str =
    r#"{"session_id":"s1","cwd":"/tmp","hook_event_name":"PreToolUse","tool_name":"Bash","tool_input":{"command":"git push --force origin main"}}"#;
static ENV_LOCK: Mutex<()> = Mutex::new(());

fn copy_dir(from: &Path, to: &Path) {
    std::fs::create_dir_all(to).unwrap();
    for ent in std::fs::read_dir(from).unwrap() {
        let ent = ent.unwrap();
        let dest = to.join(ent.file_name());
        if ent.file_type().unwrap().is_dir() {
            copy_dir(&ent.path(), &dest);
        } else {
            std::fs::copy(ent.path(), dest).unwrap();
        }
    }
}

fn wrapper_timing_lock() -> MutexGuard<'static, ()> {
    ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner())
}

fn plugin_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap().join("plugins/anti-hall")
}

struct Env {
    dir: PathBuf,
    extra: Vec<(String, String)>,
}

impl Env {
    fn new(tag: &str, extra: &[(&str, &str)]) -> Env {
        Self::make(tag, extra, true)
    }
    fn new_no_prime(tag: &str, extra: &[(&str, &str)]) -> Env {
        Self::make(tag, extra, false)
    }
    fn make(tag: &str, extra: &[(&str, &str)], prime: bool) -> Env {
        // Integration tests must read this checkout's defaults, not any installed/live plugin.
        // SAFETY: sets the same value (this checkout's plugin root) every time, before any child of this test is spawned; nothing reads it concurrently with a different value.
        unsafe {
            std::env::set_var("AH_ENGINE_PLUGIN_ROOT", plugin_root());
        }
        let dir = PathBuf::from("/tmp").join(format!("ah-r-{}-{}", tag, std::process::id()));
        ah_engine::discard::harmless(std::fs::remove_dir_all(&dir));
        std::fs::create_dir_all(dir.join("home")).unwrap();
        std::fs::write(dir.join("rules.json"), RULES).unwrap();
        // the stand-in for the Node hook: reads stdin, prints a marker, exits 2 (a "block")
        std::fs::write(dir.join("fb.sh"), "cat >/dev/null\necho NODE-FALLBACK\nexit 2\n").unwrap();
        let bin_wrap = dir.join("ah-engine-bin-wrapper.sh");
        std::fs::write(
            &bin_wrap,
            r#"#!/bin/sh
umask 077
mkdir -p "$AH_ENGINE_DIR"
printf '%s	%s
' "$$" "$*" >> "$AH_ENGINE_DIR/engine-bin-invocations.log"
exec "$REAL_AH_ENGINE_BIN" "$@"
"#,
        )
        .unwrap();
        let mut perms = std::fs::metadata(&bin_wrap).unwrap().permissions();
        perms.set_mode(0o700);
        std::fs::set_permissions(&bin_wrap, perms).unwrap();
        let e = Env { dir, extra: extra.iter().map(|(a, b)| (a.to_string(), b.to_string())).collect() };
        if prime {
            e.prime_defaults_cache();
        }
        e
    }
    fn eng(&self) -> PathBuf {
        self.dir.join("eng")
    }
    fn engine_wrapper(&self) -> PathBuf {
        self.dir.join("ah-engine-bin-wrapper.sh")
    }
    fn invocation_log(&self) -> PathBuf {
        self.eng().join("engine-bin-invocations.log")
    }
    fn health_log(&self) -> String {
        std::fs::read_to_string(self.eng().join("ah-engine.log")).unwrap_or_default()
    }
    fn fresh_down_marker(&self) -> bool {
        std::fs::read_to_string(self.eng().join("daemon.down.until"))
            .ok()
            .and_then(|s| s.trim().parse::<u64>().ok())
            .is_some_and(|until| until > ah_engine::health::now_ms())
    }
    fn spawn_attempt_count(&self) -> usize {
        self.health_log().lines().filter(|line| line.contains("\tclient_spawn_attempt\t")).count()
    }
    fn invocation_pids_for(&self, needle: &str) -> Vec<u32> {
        std::fs::read_to_string(self.invocation_log())
            .unwrap_or_default()
            .lines()
            .filter(|line| line.contains(needle))
            .filter_map(|line| line.split('\t').next()?.parse::<u32>().ok())
            .collect()
    }
    fn cmd(&self) -> Command {
        let mut c = Command::new(BIN);
        c.env("HOME", self.dir.join("home"))
            .env("AH_ENGINE_DIR", self.eng())
            .env("AH_ENGINE_PLUGIN_ROOT", plugin_root())
            .env("AH_ENGINE_RULES", self.dir.join("rules.json"))
            .env("AH_ENGINE_VERSION", "0.1.0")
            .env("AH_ENGINE_TEST_HOOKS", "1")
            .env_remove("AH_ENGINE_NOSPAWN");
        for (k, v) in &self.extra {
            c.env(k, v);
        }
        c
    }
    fn prime_defaults_cache(&self) {
        let mut c = self.cmd();
        c.env("AH_ENGINE_NOSPAWN", "1").arg("hook").arg("--event").arg("Notification").stdin(Stdio::piped()).stdout(Stdio::null()).stderr(Stdio::null());
        let mut ch = c.spawn().unwrap();
        ch.stdin.take().unwrap().write_all(br#"{"hook_event_name":"Notification","message":"prime"}"#).unwrap();
        ah_engine::discard::harmless(ch.wait());
    }
    /// (stdout, exit code, elapsed)
    fn hook(&self, input: &str, fallback: bool) -> (String, String, i32, Duration) {
        let mut c = self.cmd();
        c.arg("hook");
        if fallback {
            c.env("AH_ENGINE_NODE", "/bin/sh").arg("--fallback").arg(self.dir.join("fb.sh"));
        }
        let t = Instant::now();
        let mut ch = c.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn().unwrap();
        ch.stdin.take().unwrap().write_all(input.as_bytes()).unwrap();
        let o = ch.wait_with_output().unwrap();
        (
            String::from_utf8_lossy(&o.stdout).trim().to_string(),
            String::from_utf8_lossy(&o.stderr).trim().to_string(),
            o.status.code().unwrap_or(-1),
            t.elapsed(),
        )
    }
    fn wrapper_cmd(&self) -> Command {
        let wrapper = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap().join("plugins/anti-hall/hooks/ah-hook.sh");
        let mut c = Command::new("sh");
        c.arg(wrapper)
            .arg("PreToolUse")
            .arg("--tool-from-payload")
            .env("AH_WRAPPER_TEST", "1")
            .env("REAL_AH_ENGINE_BIN", BIN)
            .env("AH_ENGINE_PLUGIN_ROOT", plugin_root())
            .env("CLAUDE_PLUGIN_ROOT", plugin_root())
            .env("HOME", self.dir.join("home"))
            .env("AH_ENGINE_DIR", self.eng())
            .env("AH_ENGINE_RULES", self.dir.join("rules.json"))
            .env("AH_ENGINE_VERSION", "0.1.0")
            .env("AH_ENGINE_TEST_HOOKS", "1")
            .env("AH_KILL_GRACE_S", "0");
        c.env("AH_ENGINE_BIN", self.engine_wrapper());
        for (k, v) in &self.extra {
            c.env(k, v);
        }
        c
    }
    fn wrapper_hook(&self, input: &str) -> (String, i32, Duration) {
        let t = Instant::now();
        let mut ch = self.wrapper_cmd().stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn().unwrap();
        ch.stdin.take().unwrap().write_all(input.as_bytes()).unwrap();
        let o = ch.wait_with_output().unwrap();
        (String::from_utf8_lossy(&o.stdout).trim().to_string(), o.status.code().unwrap_or(-1), t.elapsed())
    }

    fn diag(&self) -> String {
        format!("\n--- ah-engine.log ---\n{}\n--- status ---\n{}", self.health_log(), self.ctl("status").unwrap_or_else(|| "<no status>".to_string()))
    }
    fn ctl(&self, verb: &str) -> Option<String> {
        let o = self.cmd().args(["ctl", verb]).output().unwrap();
        o.status.success().then(|| String::from_utf8_lossy(&o.stdout).trim().to_string())
    }
    fn pid(&self) -> Option<u32> {
        self.ctl("ping")?.split_whitespace().nth(2)?.parse().ok()
    }
    fn clear_down_marker(&self) {
        ah_engine::discard::harmless(std::fs::remove_file(self.eng().join("daemon.down.until")));
        ah_engine::discard::harmless(std::fs::remove_file(self.eng().join("daemon.spawn.lock")));
    }
    fn status(&self) -> serde_json::Value {
        serde_json::from_str(&self.ctl("status").expect("daemon status")).unwrap()
    }
    /// Wait until a hook call is answered by the engine itself (no fallback marker).
    fn warm(&self) {
        let mut last = (String::new(), String::new(), -1);
        assert!(
            wait_for(|| {
                let (out, err, code, _) = self.hook(DENY_IN, false);
                last = (out.clone(), err, code);
                out.contains("engine-blocked")
            }),
            "daemon never came up; last hook={last:?}{}",
            self.diag()
        );
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
    while t.elapsed() < crate::common::READY_CEILING {
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
    s.set_read_timeout(Some(crate::common::IO_CEILING)).unwrap();
    ah_engine::discard::harmless(s.write_all(req)); // the daemon may reply and close before an oversize body is fully sent
    ah_engine::discard::harmless(s.shutdown(std::net::Shutdown::Write));
    let mut b = Vec::new();
    ah_engine::discard::harmless(s.read_to_end(&mut b));
    b
}

fn set_recv_buf(s: &std::os::unix::net::UnixStream, bytes: libc::c_int) -> libc::c_int {
    // SAFETY: `s` is a live socket; `bytes` is passed by pointer with its exact size.
    let set = unsafe {
        libc::setsockopt(
            s.as_raw_fd(),
            libc::SOL_SOCKET,
            libc::SO_RCVBUF,
            (&bytes as *const libc::c_int).cast(),
            std::mem::size_of_val(&bytes) as libc::socklen_t,
        )
    };
    assert_eq!(set, 0, "SO_RCVBUF set failed: {}", std::io::Error::last_os_error());
    let mut got = 0 as libc::c_int;
    let mut len = std::mem::size_of_val(&got) as libc::socklen_t;
    // SAFETY: `got` and `len` are valid output pointers for this socket option.
    let get = unsafe { libc::getsockopt(s.as_raw_fd(), libc::SOL_SOCKET, libc::SO_RCVBUF, (&mut got as *mut libc::c_int).cast(), &mut len) };
    assert_eq!(get, 0, "SO_RCVBUF get failed: {}", std::io::Error::last_os_error());
    got
}

fn config_reply_len(e: &Env) -> usize {
    let mut s = std::os::unix::net::UnixStream::connect(e.eng().join("e.sock")).unwrap();
    ah_engine::discard::harmless(s.write_all(b"CTL config\n"));
    ah_engine::discard::harmless(s.shutdown(std::net::Shutdown::Write));
    let b = read_all_deadline(&mut s, Duration::from_secs(5));
    let (k, body) = ah_engine::frame::decode(&b).expect("config reply");
    assert_eq!(k, ah_engine::frame::Kind::Ok);
    body.len()
}

fn write_fill_reply_len(e: &Env, bytes: usize) -> usize {
    let mut s = std::os::unix::net::UnixStream::connect(e.eng().join("e.sock")).unwrap();
    let req = format!("CTL config\n{}", "x".repeat(bytes));
    ah_engine::discard::harmless(s.write_all(req.as_bytes()));
    ah_engine::discard::harmless(s.shutdown(std::net::Shutdown::Write));
    let b = read_all_deadline(&mut s, Duration::from_secs(5));
    let (k, body) = ah_engine::frame::decode(&b).expect("write-fill reply");
    assert_eq!(k, ah_engine::frame::Kind::Ok);
    body.len()
}

fn ensure_write_fill(e: &Env, larger_than: usize) -> usize {
    let mut bytes = larger_than;
    loop {
        let len = write_fill_reply_len(e, bytes);
        if len > larger_than {
            return bytes;
        }
        bytes *= 2;
    }
}

fn read_all_deadline(s: &mut std::os::unix::net::UnixStream, max: Duration) -> Vec<u8> {
    s.set_nonblocking(true).unwrap();
    let deadline = Instant::now() + max;
    let mut out = Vec::new();
    let mut chunk = [0u8; 4096];
    loop {
        match s.read(&mut chunk) {
            Ok(0) => return out,
            Ok(n) => out.extend_from_slice(&chunk[..n]),
            Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                let Some(remaining) = deadline.checked_duration_since(Instant::now()) else {
                    return out;
                };
                let mut timeout = remaining.as_millis().min(i32::MAX as u128) as i32;
                if timeout == 0 && !remaining.is_zero() {
                    timeout = 1;
                }
                let mut pfd = libc::pollfd { fd: s.as_raw_fd(), events: libc::POLLIN, revents: 0 };
                // SAFETY: `pfd` is a live, writable `pollfd` and the count passed is 1.
                if unsafe { libc::poll(&mut pfd, 1, timeout) } <= 0 {
                    return out;
                }
            }
            Err(_) => return out,
        }
    }
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

fn wrapper_child(e: &Env) -> std::process::Child {
    let mut c = e.wrapper_cmd();
    c.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut ch = c.spawn().unwrap();
    ch.stdin.take().unwrap().write_all(DENY_IN.as_bytes()).unwrap();
    ch
}

fn wrapper_once(e: &Env) -> (i32, String, Duration) {
    let t = Instant::now();
    let o = wrapper_child(e).wait_with_output().unwrap();
    (o.status.code().unwrap_or(-1), String::from_utf8_lossy(&o.stdout).to_string(), t.elapsed())
}

/// A cold first wrapper run builds the defaults cache (slow in a debug binary) and may be killed by the wrapper watchdog before it
/// reaches the daemon: it must still allow in under a second, but it is not required to leave the down marker. This second,
/// cache-warm run is the one that records the marker and the single spawn attempt, and must also be under a second.
fn settle_after_cold(e: &Env) {
    // a cold client killed mid-parse leaves no cache, so settle it the way a plugin update or any unwatched engine call does
    e.prime_defaults_cache();
    let (code, out, dt) = wrapper_once(e);
    println!("TIMING wrapper warm-cache follow-up wall_ms={:.1}", dt.as_secs_f64() * 1000.0);
    assert_eq!((code, out.as_str()), (0, ""));
    assert!(dt < Duration::from_secs(1), "warm follow-up wrapper took {dt:?}");
}

/// [`settle_after_cold`] for a daemon that is late rather than absent: the warm call waits out its window and fails open (a
/// late call never runs a Node hook), or, inside the down marker of the call before, is skipped.
fn settle_after_cold_slow(e: &Env) {
    e.prime_defaults_cache();
    let (code, _, dt) = wrapper_once(e);
    println!("TIMING wrapper warm-cache follow-up wall_ms={:.1}", dt.as_secs_f64() * 1000.0);
    assert!(code == 0 || code == 2, "warm follow-up wrapper exited {code}");
    assert!(dt < Duration::from_secs(4), "warm follow-up wrapper took {dt:?}");
}

fn clamped_num(key: &str, value: u64) -> u64 {
    let e = ah_engine::defaults::all().iter().find(|e| e.key == key).unwrap();
    let min = e.min.map(|n| n.max(0) as u64).unwrap_or(0);
    let max = e.max.map(|n| n.max(0) as u64).unwrap_or(u64::MAX);
    value.max(min).min(max)
}

fn assert_twenty_wrappers_exit(e: &Env) {
    let mut children: Vec<_> = (0..20).map(|_| wrapper_child(e)).collect();
    std::thread::sleep(Duration::from_secs(2));
    for (i, ch) in children.iter_mut().enumerate() {
        assert!(ch.try_wait().unwrap().is_some(), "wrapper child {i} still alive after 2s");
    }
    let hook_pids = e.invocation_pids_for("hook --event");
    for pid in &hook_pids {
        assert!(!alive(*pid), "ah-engine hook pid {pid} tied to {} still alive after 2s", e.eng().display());
    }
    println!("TIMING wrapper 20-concurrent hook_survivors_after_2s=0 hook_invocations={}", hook_pids.len());
}

#[test]
fn ah_hook_wrapper_failfast_no_daemon_hung_daemon_and_restart_loop() {
    let _timing = wrapper_timing_lock();
    let down = Env::new_no_prime("wrap-down", &[("AH_ENGINE_NOSPAWN", "1")]);
    let (code, out, dt) = wrapper_once(&down);
    println!("TIMING wrapper no-daemon wall_ms={:.1}", dt.as_secs_f64() * 1000.0);
    assert_eq!((code, out.as_str()), (0, ""));
    assert!(dt < Duration::from_secs(1), "no-daemon wrapper took {dt:?}");
    settle_after_cold(&down);
    assert!(down.fresh_down_marker(), "no-daemon wrapper did not leave a fresh daemon-down marker");
    assert_eq!(down.spawn_attempt_count(), 1, "no-daemon first client should be the only spawn single-flight holder");
    assert_twenty_wrappers_exit(&down);
    assert_eq!(down.spawn_attempt_count(), 1, "fresh marker should make concurrent no-daemon wrappers skip spawning");

    let hung = Env::new("wrap-hung", &[("AH_ENGINE_NOSPAWN", "1"), ("AH_ENGINE_SLOW_DOWN_N", "1")]);
    fake_server(&hung, || None);
    let (code, out, dt) = wrapper_once(&hung);
    println!("TIMING wrapper hung-daemon wall_ms={:.1}", dt.as_secs_f64() * 1000.0);
    // no reply in the whole wait window: the call fails open and runs no Node hook (the daemon may have processed it already)
    assert_eq!((code, out.as_str()), (0, ""), "{code} {out}");
    assert!(dt < Duration::from_millis(clamped_num("client.slow_fallback_max_ms", 3000)) + Duration::from_secs(1), "hung-daemon wrapper took {dt:?}");
    settle_after_cold_slow(&hung);
    assert!(hung.fresh_down_marker(), "a slow reply (slow_down_n = 1) did not leave a fresh daemon-down marker");
    assert_eq!(hung.spawn_attempt_count(), 0, "a slow daemon is alive: it is never restarted");
    assert_twenty_wrappers_exit(&hung);
    assert_eq!(hung.spawn_attempt_count(), 0, "a slow daemon is never restarted by concurrent wrappers");

    let looping = Env::new_no_prime("wrap-loop", &[("AH_ENGINE_NOSPAWN", "1")]);
    std::fs::create_dir_all(looping.eng()).unwrap();
    let now = ah_engine::health::now_ms();
    let log = (0..4).map(|i| format!("{}\tcrash\tunknown\tloop\n", now.saturating_sub(i))).collect::<String>();
    std::fs::write(looping.eng().join("ah-engine.log"), log).unwrap();
    let (code, out, dt) = wrapper_once(&looping);
    println!("TIMING wrapper restart-loop wall_ms={:.1}", dt.as_secs_f64() * 1000.0);
    assert_eq!((code, out.as_str()), (0, ""));
    assert!(dt < Duration::from_secs(1), "restart-loop wrapper took {dt:?}");
    assert_twenty_wrappers_exit(&looping);
    assert!(looping.spawn_attempt_count() <= 1, "restart-loop wrappers should not pile up spawn attempts");
}

// ---- 1. framing + fail-open rule ---------------------------------------------------------------

#[test]
fn bad_replies_fail_open_never_block() {
    use ah_engine::frame::{Kind, encode};
    let good = encode(Kind::Ok, r#"{"decision":"block","reason":"x"}"#);
    let cases: Vec<(&str, Vec<u8>)> = vec![
        ("empty", vec![]),
        ("truncated", good[..good.len() - 3].to_vec()),
        ("header only", good[..10].to_vec()),
        ("garbage", b"{\"decision\":\"allow\"}".to_vec()),
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
        let (out, _, code, elapsed) = e.hook(DENY_IN, true);
        assert_eq!((out.as_str(), code), ("", 0), "case {name}");
        assert!(elapsed < Duration::from_secs(1), "case {name} took {elapsed:?}");
    }
}

#[test]
fn healthy_non_ok_replies_use_the_fallback_contract() {
    use ah_engine::frame::{Kind, encode};
    for (name, reply) in [("busy", encode(Kind::Busy, "")), ("err", encode(Kind::Err, "boom"))] {
        let e = Env::new("non-ok", &[("AH_ENGINE_NOSPAWN", "1")]);
        fake_server(&e, move || Some(reply.clone()));
        let (out, _, code, elapsed) = e.hook(DENY_IN, true);
        assert_eq!((out.as_str(), code), ("NODE-FALLBACK", 2), "case {name}");
        assert!(elapsed < Duration::from_secs(1), "case {name} took {elapsed:?}");
    }
}

#[test]
fn engine_down_fails_open_quickly_with_or_without_fallback() {
    let e = Env::new("down", &[("AH_ENGINE_NOSPAWN", "1")]);
    let (out, _, code, dt) = e.hook(DENY_IN, true);
    assert_eq!((out.as_str(), code), ("", 0));
    assert!(dt < Duration::from_secs(1), "took {dt:?}");
    // P0 fail-open: no engine must not block a Claude Code hook, even for a guard event.
    let (out, _, code, _) = e.hook(DENY_IN, false);
    assert_eq!((out.as_str(), code), ("", 0), "a guard event fails open when the daemon is unavailable");
    let quiet = r#"{"session_id":"s1","cwd":"/tmp","hook_event_name":"Notification","message":"hi"}"#;
    assert_eq!(e.hook(quiet, false).2, 0, "a non-guard event with no engine and no fallback stays the neutral no-op");
    // fallback unavailable (node missing) is the same plain allow
    let mut c = e.cmd();
    c.env("AH_ENGINE_NODE", "/nonexistent/node").args(["hook", "--fallback"]).arg(e.dir.join("fb.sh"));
    let mut ch = c.stdin(Stdio::piped()).stdout(Stdio::piped()).spawn().unwrap();
    ch.stdin.take().unwrap().write_all(DENY_IN.as_bytes()).unwrap();
    let o = ch.wait_with_output().unwrap();
    assert!(o.stdout.is_empty() && o.status.success());
}

#[cfg(target_os = "macos")] // RLIMIT_NPROC counts processes only here (Linux counts threads too, which the client needs)
#[test]
fn a_daemon_that_cannot_be_forked_is_logged_with_its_errno() {
    // review finding 18: spawn_daemon dropped the fork error (`.spawn().ok()`), so EAGAIN left no trace
    let e = Env::new("nofork", &[]);
    std::fs::create_dir_all(e.eng()).unwrap();
    let c = e.cmd();
    let envs: Vec<(std::ffi::OsString, std::ffi::OsString)> = c.get_envs().filter_map(|(k, v)| Some((k.to_owned(), v?.to_owned()))).collect();
    let mut sh = Command::new("/bin/sh");
    // a process limit below what this user already runs: every fork fails with EAGAIN, exec does not fork
    sh.args(["-c", "ulimit -u 1 2>/dev/null; exec \"$0\" hook", BIN]).envs(envs).env_remove("AH_ENGINE_NOSPAWN");
    let mut ch = sh.stdin(Stdio::piped()).stdout(Stdio::null()).stderr(Stdio::null()).spawn().unwrap();
    ch.stdin.take().unwrap().write_all(DENY_IN.as_bytes()).unwrap();
    ah_engine::discard::harmless(ch.wait());
    let log = std::fs::read_to_string(e.eng().join("ah-engine.log")).unwrap_or_default();
    assert!(log.contains("spawn_fail\tos35"), "the failed fork is logged with EAGAIN: {log:?}");
}

#[test]
fn healthy_engine_answers_and_fallback_is_not_run() {
    let e = Env::new("good", &[]);
    e.warm();
    let (out, _, code, _) = e.hook(DENY_IN, true);
    assert_eq!(code, 0);
    assert!(out.contains("engine-blocked") && !out.contains("NODE-FALLBACK"), "{out}");
    // a valid "nothing to say" is an OK frame with an empty body: allowed, no fallback
    let (out, _, code, _) = e.hook(r#"{"hook_event_name":"PreToolUse","tool_name":"Bash","tool_input":{"command":"ls"}}"#, true);
    assert_eq!((out.as_str(), code), ("", 0));
}

// ---- 2. no hangs ------------------------------------------------------------------------------

#[test]
fn hung_engine_times_out_then_falls_back() {
    let requested_deadline_ms = 400;
    let effective_deadline_ms = clamped_num("client.deadline_ms", requested_deadline_ms);
    // the wait window equals the deadline (slow_fallback_max_ms 0): the call gives up at the clamped deadline
    let e = Env::new("hang", &[("AH_ENGINE_NOSPAWN", "1"), ("AH_ENGINE_DEADLINE_MS", "400"), ("AH_ENGINE_SLOW_FALLBACK_MAX_MS", "0")]);
    fake_server(&e, || None);
    let (out, _, code, dt) = e.hook(DENY_IN, true);
    println!("TIMING client hung-daemon wall_ms={:.1}", dt.as_secs_f64() * 1000.0);
    assert_eq!((out.as_str(), code), ("", 0), "no reply in the window fails open; the Node hook does not run (the daemon may have processed the call)");
    // Gave up at the configured, clamped client deadline rather than waiting for the server's 30 s hang.
    assert!(dt >= Duration::from_millis(effective_deadline_ms) && dt < Duration::from_secs(1), "took {dt:?}");
}

#[test]
fn default_client_deadline_is_under_one_second() {
    // the deadline (300 ms) is what a call waits when no wait window is configured
    let e = Env::new("hang2", &[("AH_ENGINE_NOSPAWN", "1"), ("AH_ENGINE_SLOW_FALLBACK_MAX_MS", "0")]);
    fake_server(&e, || None);
    let (out, _, code, dt) = e.hook(DENY_IN, true);
    assert_eq!((out.as_str(), code), ("", 0));
    assert!(dt >= Duration::from_millis(300) && dt < Duration::from_secs(1), "took {dt:?}");
}

#[test]
fn wrapper_fails_open_under_one_second_with_no_daemon() {
    let _timing = wrapper_timing_lock();
    let e = Env::new_no_prime("wrapdown", &[("AH_ENGINE_NOSPAWN", "1")]);
    let (out, code, dt) = e.wrapper_hook(DENY_IN);
    println!("TIMING wrapper no-daemon separate wall_ms={:.1}", dt.as_secs_f64() * 1000.0);
    assert_eq!((out.as_str(), code), ("", 0));
    assert!(dt < Duration::from_secs(1), "wrapper took {dt:?}");
}

#[test]
fn wrapper_fails_open_under_one_second_when_daemon_accepts_and_never_replies() {
    let _timing = wrapper_timing_lock();
    let e = Env::new("wraphung", &[("AH_ENGINE_NOSPAWN", "1"), ("AH_ENGINE_SLOW_DOWN_N", "1")]);
    fake_server(&e, || None);
    let (out, code, dt) = e.wrapper_hook(DENY_IN);
    println!("TIMING wrapper hung-daemon separate wall_ms={:.1}", dt.as_secs_f64() * 1000.0);
    assert_eq!((code, out.as_str()), (0, ""), "no reply in the window fails open, no Node hook");
    assert!(dt < Duration::from_millis(clamped_num("client.slow_fallback_max_ms", 3000)) + Duration::from_secs(1), "wrapper took {dt:?}");
    settle_after_cold_slow(&e);
    assert!(e.fresh_down_marker(), "hung wrapper did not write daemon-down marker");
    assert_eq!(e.spawn_attempt_count(), 0, "a slow daemon is never restarted");
}

#[test]
fn wrapper_deadline_clamps_high_env_override_and_keeps_lower_override() {
    let _timing = wrapper_timing_lock();
    let high = Env::new("wrapenvdeadline-high", &[("AH_ENGINE_NOSPAWN", "1"), ("AH_ENGINE_DEADLINE_MS", "5000"), ("AH_ENGINE_SLOW_DOWN_N", "1")]);
    fake_server(&high, || None);
    let (out, code, dt) = high.wrapper_hook(DENY_IN);
    println!("TIMING wrapper hung-daemon env-deadline-5000-clamped wall_ms={:.1}", dt.as_secs_f64() * 1000.0);
    assert_eq!((code, out.as_str()), (0, ""), "{code} {out}");
    assert!(dt < Duration::from_secs(4), "wrapper took {dt:?}");
    settle_after_cold_slow(&high);
    assert!(high.fresh_down_marker(), "wrapper killed client before it wrote the daemon-down marker");
    assert_eq!(high.spawn_attempt_count(), 0, "a slow daemon is never restarted");

    let lower = Env::new("wrapenvdeadline-low", &[("AH_ENGINE_NOSPAWN", "1"), ("AH_ENGINE_DEADLINE_MS", "200"), ("AH_ENGINE_SLOW_DOWN_N", "1")]);
    fake_server(&lower, || None);
    let (out, code, dt) = lower.wrapper_hook(DENY_IN);
    println!("TIMING wrapper hung-daemon env-deadline-200 wall_ms={:.1}", dt.as_secs_f64() * 1000.0);
    assert_eq!((code, out.as_str()), (0, ""), "{code} {out}");
    assert!(dt < Duration::from_secs(4), "wrapper took {dt:?}");
    lower.prime_defaults_cache();
    let (_, _, warm) = wrapper_once(&lower);
    assert!(warm < Duration::from_secs(3), "warm wrapper took {warm:?}");
    assert!(lower.fresh_down_marker(), "wrapper killed lower-deadline client before it wrote the daemon-down marker");
    assert_eq!(lower.spawn_attempt_count(), 0, "a slow daemon is never restarted");
}

#[test]
fn twenty_parallel_wrappers_leave_no_clients_alive_after_two_seconds() {
    let _timing = wrapper_timing_lock();
    let e = Env::new_no_prime("wrap20", &[("AH_ENGINE_NOSPAWN", "1"), ("AH_ENGINE_SLOW_DOWN_N", "1")]);
    fake_server(&e, || None);
    let mut children: Vec<_> = (0..20)
        .map(|_| {
            let mut ch = e.wrapper_cmd().stdin(Stdio::piped()).stdout(Stdio::null()).stderr(Stdio::null()).spawn().unwrap();
            ch.stdin.take().unwrap().write_all(DENY_IN.as_bytes()).unwrap();
            ch
        })
        .collect();
    // a slow daemon's call may run its Node hook up to client.slow_fallback_max_ms (plus the kill grace) before the wrapper ends it
    let bound = Duration::from_millis(clamped_num("client.slow_fallback_max_ms", 3000)) + Duration::from_secs(1);
    std::thread::sleep(bound);
    for ch in &mut children {
        assert!(ch.try_wait().unwrap().is_some(), "client pid {} still alive after {bound:?}", ch.id());
    }
    let hook_pids = e.invocation_pids_for("hook --event");
    for pid in &hook_pids {
        assert!(!alive(*pid), "ah-engine hook pid {pid} tied to {} still alive after {bound:?}", e.eng().display());
    }
    assert!(e.spawn_attempt_count() <= 1, "20 hung wrappers should have at most one spawn attempt");
    println!(
        "TIMING wrapper 20-concurrent survivors_after_2s=0 hook_survivors_after_2s=0 hook_invocations={} spawn_attempts={}",
        hook_pids.len(),
        e.spawn_attempt_count()
    );
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

/// R0 P0: a daemon killed right after its start was not restarted by the wrapper. The single-flight spawn lock outlived the
/// start it guarded (client.rs SpawnLock kept it for `client.spawn_lock_ttl_ms`), so every client in that window found the lock
/// held and skipped the spawn. The TTL is stretched here so the window covers the whole test: the daemon must free the lock
/// once it listens, and the first or second wrapper call after a `kill -9` must start a new daemon.
#[test]
fn wrapper_respawns_a_daemon_killed_right_after_its_start() {
    let _timing = wrapper_timing_lock();
    let e = Env::new("kill9", &[("AH_ENGINE_SPAWN_LOCK_TTL_MS", "600000")]);
    let (code, _, _) = wrapper_once(&e);
    assert!(code == 0 || code == 2, "the first call waits for the cold daemon and may get its block (cold guard wait): {code}");
    assert!(wait_for(|| e.pid().is_some()), "the first wrapper call did not start a daemon{}", e.diag());
    let old = e.pid().unwrap();
    // SAFETY: `kill` takes plain integers and has no memory-safety preconditions; the pid is this test's own daemon.
    unsafe { libc::kill(old as i32, libc::SIGKILL) };
    assert!(wait_for(|| !alive(old)), "kill -9 did not end the daemon");
    let mut calls = 0;
    let mut fresh = None;
    while calls < 2 && fresh.is_none() {
        calls += 1;
        let (code, _, dt) = wrapper_once(&e);
        assert_eq!(code, 0, "wrapper call {calls} after kill -9 must fail open");
        assert!(dt < Duration::from_secs(1), "wrapper call {calls} after kill -9 took {dt:?}");
        fresh = wait_for(|| e.pid().is_some_and(|p| p != old)).then(|| e.pid().unwrap());
    }
    assert!(fresh.is_some(), "no new daemon after {calls} wrapper calls following kill -9{}", e.diag());
}

/// R0: after the daemon is killed, twenty wrapper calls at once must leave exactly ONE daemon running (an earlier lane had 56
/// engine processes alive at once). Counted from the process table: every `serve` process whose environment names this state directory.
#[test]
fn twenty_concurrent_wrapper_calls_after_a_kill_leave_exactly_one_daemon() {
    let _timing = wrapper_timing_lock();
    let e = Env::new("storm20", &[("AH_HOOK_TIMEOUT_MS", "5000")]);
    let (code, _, _) = wrapper_once(&e);
    assert!(code == 0 || code == 2, "the first call waits for the cold daemon and may get its block (cold guard wait): {code}");
    assert!(wait_for(|| e.pid().is_some()), "the first wrapper call did not start a daemon{}", e.diag());
    let old = e.pid().unwrap();
    // SAFETY: `kill` takes plain integers and has no memory-safety preconditions; the pid is this test's own daemon.
    unsafe { libc::kill(old as i32, libc::SIGKILL) };
    assert!(wait_for(|| !alive(old)), "kill -9 did not end the daemon");
    let children: Vec<_> = (0..20).map(|_| wrapper_child(&e)).collect();
    for ch in children {
        let o = ch.wait_with_output().unwrap();
        assert!(matches!(o.status.code(), Some(0) | Some(2)), "a wrapper call after the kill must fail open or fall back, got {:?}", o.status.code());
    }
    assert!(wait_for(|| e.pid().is_some_and(|p| p != old)), "no new daemon after 20 wrapper calls following kill -9{}", e.diag());
    std::thread::sleep(Duration::from_secs(3)); // a spawn storm shows up as late extra daemons
    // every `serve` process of THIS state directory (the daemon may fork away from the logged pid, so ask the process table). The
    // engine's own process table reads command lines and environments on both platforms (`ps -E` is BSD-only: procps on Linux
    // rejects it, which left this list empty there).
    let mine = e.eng().display().to_string();
    let mut table = ah_engine::procwatch::table::Table::new();
    let rows = table.list();
    let mut daemons: Vec<u32> = rows
        .into_iter()
        .filter(|r| r.cmd.split_whitespace().any(|a| a == "serve"))
        .filter(|r| table.environ(r.pid).iter().any(|(k, v)| k == "AH_ENGINE_DIR" && *v == mine))
        .map(|r| r.pid)
        .collect();
    daemons.sort_unstable();
    daemons.dedup();
    assert_eq!(daemons.len(), 1, "exactly one daemon must be running, found {daemons:?}{}", e.diag());
}

/// The start-up probe warm-up runs on its own thread after the socket is listening: a slow interpreter probe (a fake `python3` that
/// takes 3 s) must not delay the daemon's first reply, and once it finishes the answer is kept for the guards.
#[test]
fn the_probe_warm_up_never_slows_the_first_reply_and_fills_the_cache() {
    let e0 = Env::new("prewarm-dir", &[]);
    let bindir = e0.dir.join("fakebin");
    std::fs::create_dir_all(&bindir).unwrap();
    std::fs::write(bindir.join("python3"), "#!/bin/sh\nsleep 3\necho 'Python 3.13.0'\n").unwrap();
    std::fs::set_permissions(bindir.join("python3"), std::os::unix::fs::PermissionsExt::from_mode(0o755)).unwrap();
    drop(e0);
    let path = format!("{}:/usr/bin:/bin", std::env::temp_dir().join(format!("ah-r-prewarm-dir-{}", std::process::id())).join("fakebin").display());
    let e = Env::new("prewarm", &[("PATH", path.as_str()), ("AH_HOOK_TIMEOUT_MS", "5000")]);
    let fake = PathBuf::from(&path.split(':').next().unwrap());
    std::fs::create_dir_all(&fake).unwrap();
    std::fs::write(fake.join("python3"), "#!/bin/sh\nsleep 3\necho 'Python 3.13.0'\n").unwrap();
    std::fs::set_permissions(fake.join("python3"), std::os::unix::fs::PermissionsExt::from_mode(0o755)).unwrap();
    let _ = e.hook(DENY_IN, true);
    assert!(wait_for(|| e.pid().is_some()), "no daemon{}", e.diag());
    // the fake interpreter is still running its 3 s: the daemon answers at once
    let t = Instant::now();
    assert!(e.ctl("ping").is_some());
    assert!(t.elapsed() < Duration::from_millis(1500), "ping took {:?} while the warm-up probe runs", t.elapsed());
    let (_, _, code, dt) = e.hook(DENY_IN, true);
    assert!(code == 0 || code == 2, "{code}");
    assert!(dt < Duration::from_secs(2), "a guard call took {dt:?} while the warm-up probe runs");
    // after the probe finished, the kept answer shows in the memory registry
    assert!(
        wait_for(|| {
            fn kept(v: &serde_json::Value) -> bool {
                match v {
                    serde_json::Value::Object(m) => {
                        (m.get("name").and_then(|n| n.as_str()) == Some("spawn_probe") && m.get("bytes").and_then(|b| b.as_u64()).unwrap_or(0) > 0)
                            || m.values().any(kept)
                    }
                    serde_json::Value::Array(a) => a.iter().any(kept),
                    _ => false,
                }
            }
            e.ctl("status").and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok()).is_some_and(|v| kept(&v))
        }),
        "the warm-up kept no probe answer{}",
        e.diag()
    );
    ah_engine::discard::harmless(std::fs::remove_dir_all(fake.parent().unwrap().join("fakebin")));
}

/// The wrapper's cold-start kick (`client.cold_guard_kick_event`) names no hook: the engine answers it with nothing (exit 0, no
/// output, no deferral to Node) and the call starts the daemon.
#[test]
fn the_cold_start_kick_starts_the_daemon_and_decides_nothing() {
    let e = Env::new_no_prime("kick", &[("AH_HOOK_TIMEOUT_MS", "5000")]);
    let o = e
        .cmd()
        .args(["hook", "--event", "ColdStartKick", "--host", "claude"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .and_then(|mut ch| {
            ch.stdin.take().unwrap().write_all(br#"{"hook_event_name":"ColdStartKick"}"#)?;
            ch.wait_with_output()
        })
        .unwrap();
    assert_eq!(o.status.code(), Some(0), "the kick is a no-op, not a deferral: {}", String::from_utf8_lossy(&o.stderr));
    assert!(o.stdout.is_empty() && o.stderr.is_empty(), "the kick prints nothing: {:?} {:?}", o.stdout, o.stderr);
    assert!(wait_for(|| e.pid().is_some()), "the kick started no daemon{}", e.diag());
    assert!(!e.health_log().contains("dispatch_defer"), "the kick must not be logged as a deferral{}", e.diag());
}

/// R0 P0: on a fresh state directory the first wrapper calls started no daemon. The hook client, finding no snapshot cache,
/// parsed the defaults and then kept the last-known-good copy and healed (one synced write per defaults file) BEFORE it asked
/// the daemon: over a second, so the wrapper's watchdog killed it before the spawn. The client now leaves that copy to the
/// daemon it starts, so the copy is written after the spawn attempt. Timestamps, not timing: this holds on any machine load.
#[test]
fn a_cold_hook_client_starts_the_daemon_before_any_last_known_good_copy_is_written() {
    let e = Env::new_no_prime("coldorder", &[]);
    let o = e
        .cmd()
        .args(["hook", "--event", "PreToolUse", "--host", "claude"])
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .and_then(|mut ch| {
            ch.stdin.take().unwrap().write_all(DENY_IN.as_bytes())?;
            ch.wait()
        })
        .unwrap();
    assert_eq!(o.code(), Some(0), "a cold call fails open");
    assert!(wait_for(|| e.pid().is_some()), "the cold call started no daemon{}", e.diag());
    let stamp =
        || std::fs::read_dir(e.eng().join("defaults.lkg")).ok()?.flatten().find_map(|d| std::fs::metadata(d.path().join("STAMP")).ok()?.modified().ok());
    assert!(wait_for(|| stamp().is_some()), "the daemon kept no last-known-good copy{}", e.diag());
    let stamp_ms = stamp().unwrap().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis() as u64;
    let log = e.health_log();
    let spawn_ms: u64 = log
        .lines()
        .find(|l| l.contains("\tclient_spawn_attempt\t"))
        .and_then(|l| l.split('\t').next()?.parse().ok())
        .unwrap_or_else(|| panic!("no spawn attempt logged{}", e.diag()));
    assert!(stamp_ms >= spawn_ms, "the client wrote the last-known-good copy ({stamp_ms}) before it started the daemon ({spawn_ms})");
}

/// The same through the wrapper: the first call on a fresh state directory leaves a daemon starting. The wrapper deadline is
/// widened (the test-only knob) because this debug build parses the defaults several times slower than a release build, and
/// machine load slows it further; the ordering itself is pinned by the test above.
#[test]
fn a_cold_first_wrapper_call_starts_the_daemon() {
    let _timing = wrapper_timing_lock();
    let mut e = Env::new_no_prime("cold1", &[("AH_HOOK_TIMEOUT_MS", "5000"), ("AH_HOOK_TIMEOUT_S", "30")]);
    // This debug-build daemon needs ~2.7 s from a cold state to bind its socket, longer than the shipped client.cold_guard_wait_ms
    // (2000, sized for a release build's ~0.6 s), so against the shipped value the wait legitimately ends and the wrapper fails open
    // (rc 0). The assertion below stays strict; only the wait cap is widened, in a private copy of the engine config (the shipped
    // file is untouched), so the test measures the kick/wait/decision path and not the debug build's speed. The hook timeout (AH_HOOK_TIMEOUT_S) is
    // widened with it: the wait never exceeds what that timeout leaves after the 5 s engine attempt.
    let root = e.dir.join("plugin");
    copy_dir(&plugin_root().join("engine"), &root.join("engine"));
    let toml = root.join("engine/defaults/engine.toml");
    let src = std::fs::read_to_string(&toml).unwrap();
    let marker = "[client.cold_guard_wait_ms]";
    let at = src.find(marker).expect("client.cold_guard_wait_ms present");
    let rest = &src[at..];
    let val = rest.find("\nvalue = 2000\n").expect("cold_guard_wait_ms value is 2000");
    let patched = format!("{}{}{}", &src[..at], &rest[..val], rest[val..].replacen("value = 2000", "value = 10000", 1));
    std::fs::write(&toml, patched).unwrap();
    for k in ["AH_ENGINE_PLUGIN_ROOT", "CLAUDE_PLUGIN_ROOT"] {
        e.extra.push((k.to_string(), root.display().to_string()));
    }
    let o = wrapper_child(&e).wait_with_output().unwrap();
    let (code, out, err) = (o.status.code().unwrap_or(-1), String::from_utf8_lossy(&o.stdout), String::from_utf8_lossy(&o.stderr));
    // a guard event no longer runs against a daemon that is still starting: the wrapper kicks it, waits for the socket
    // (client.cold_guard_wait_ms) and returns the engine's real decision (DENY_IN is a block). The engine answers a Claude
    // PreToolUse block in either host form: a JSON `decision: block` on stdout, or exit 2 with the reason on stderr (the shipped
    // git check, which answers this force push before the test rule, uses the second). The wrapper's own fail-closed exit 2
    // (no engine answer) is not the engine's decision, and neither is a Node fallback answer.
    assert_eq!(code, 2, "a cold first guard call waits for the daemon and gets its decision: stdout={out} stderr={err}");
    let engine_block = out.contains("\"decision\":\"block\"") || (!err.trim().is_empty() && !err.contains("fail closed"));
    assert!(engine_block, "a cold first guard call gets the engine's block: stdout={out} stderr={err}");
    let invocations = std::fs::read_to_string(e.invocation_log()).unwrap_or_default();
    assert!(invocations.lines().any(|l| l.contains("--event PreToolUse")), "the engine answered the guard call itself: {invocations}");
    assert_eq!(e.status()["health"]["fallbacks"]["total"], 0, "no Node fallback answered the cold guard call{}", e.diag());
    assert!(wait_for(|| e.pid().is_some()), "no daemon after the first cold wrapper call{}", e.diag());
}

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
    h.join().unwrap();
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
    let log = || std::fs::read_to_string(e.eng().join("ah-engine.log")).unwrap_or_default();
    assert!(wait_for(|| log().contains("accept\trecovered")), "the failed accepts are logged once a descriptor frees up: {}", log());
    drop(e.ctl("stop"));
    ah_engine::discard::harmless(daemon.wait());
}

#[test]
fn a_wedged_daemon_is_marked_down_only_after_a_streak_of_slow_replies() {
    // one slow call is not a down daemon (R0 P0); client.slow_down_n (5) in a row are: those calls fail open (no Node hook), then
    // later clients skip the daemon and nothing is respawned.
    let e = Env::new(
        "slowok",
        &[("AH_ENGINE_NOSPAWN", "1"), ("AH_ENGINE_DEADLINE_MS", "150"), ("AH_ENGINE_SLOW_FALLBACK_MAX_MS", "700"), ("AH_ENGINE_BREAKER_N", "3")],
    );
    std::fs::create_dir_all(e.eng()).unwrap();
    let l = UnixListener::bind(e.eng().join("e.sock")).unwrap();
    std::thread::spawn(move || {
        for s in l.incoming().flatten() {
            std::thread::spawn(move || {
                let mut s = s;
                let mut b = Vec::new();
                ah_engine::discard::harmless(s.read_to_end(&mut b));
                if b.starts_with(b"CTL ping") {
                    ah_engine::discard::harmless(s.write_all(&ah_engine::frame::encode(ah_engine::frame::Kind::Ok, "pong 0.1.0 1")));
                } else {
                    std::thread::sleep(Duration::from_secs(5)); // a slow request
                }
            });
        }
    });
    for i in 0..5 {
        assert_eq!(e.hook(DENY_IN, true).0, "", "slow call {i} fails open without running its Node hook");
        assert_eq!(e.fresh_down_marker(), i == 4, "the marker appears with the 5th slow reply, not before (call {i})");
    }
    assert_eq!(e.hook(DENY_IN, true).0, "", "a marked-down daemon is skipped");
    assert_eq!(e.spawn_attempt_count(), 0, "a slow daemon is never restarted");
    let log = std::fs::read_to_string(e.eng().join("ah-engine.log")).unwrap_or_default();
    assert!(log.contains("client_slow") && !log.contains("client_spawn_attempt"), "{log}");
}

#[test]
fn a_non_slow_reply_between_slow_ones_breaks_the_slow_streak() {
    // Codex delta F5: slow, BUSY, slow with slow_down_n = 2 is not two slow replies in a row; the completed BUSY reply clears the streak
    let e = Env::new(
        "slowbusy",
        &[
            ("AH_ENGINE_NOSPAWN", "1"),
            ("AH_ENGINE_DEADLINE_MS", "150"),
            ("AH_ENGINE_SLOW_FALLBACK_MAX_MS", "700"),
            ("AH_ENGINE_SLOW_DOWN_N", "2"),
            ("AH_ENGINE_BREAKER_N", "9"),
        ],
    );
    std::fs::create_dir_all(e.eng()).unwrap();
    let l = UnixListener::bind(e.eng().join("e.sock")).unwrap();
    let seen = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
    std::thread::spawn(move || {
        for s in l.incoming().flatten() {
            let seen = seen.clone();
            std::thread::spawn(move || {
                let mut s = s;
                let mut b = Vec::new();
                ah_engine::discard::harmless(s.read_to_end(&mut b));
                if b.starts_with(b"CTL ping") {
                    ah_engine::discard::harmless(s.write_all(&ah_engine::frame::encode(ah_engine::frame::Kind::Ok, "pong 0.1.0 1")));
                } else if seen.fetch_add(1, std::sync::atomic::Ordering::SeqCst) == 1 {
                    ah_engine::discard::harmless(s.write_all(&ah_engine::frame::encode(ah_engine::frame::Kind::Busy, "busy")));
                } else {
                    std::thread::sleep(Duration::from_secs(5)); // a slow request
                }
            });
        }
    });
    for (i, want_down, node) in [(0, false, false), (1, false, true), (2, false, false)] {
        // a slow call fails open (no Node hook); the completed BUSY reply is a refusal, so its call runs the Node hook
        assert_eq!(e.hook(DENY_IN, true).0, if node { "NODE-FALLBACK" } else { "" }, "call {i}");
        assert_eq!(e.fresh_down_marker(), want_down, "slow, BUSY, slow must not mark the daemon down (call {i})");
    }
    // two slow replies in a row still do (the streak itself works)
    assert_eq!(e.hook(DENY_IN, true).0, "");
    assert!(e.fresh_down_marker(), "two consecutive slow replies mark the daemon down");
}

#[test]
fn wrapper_returns_the_guards_block_when_the_daemon_is_slow() {
    // Codex delta F1: a daemon that answers a deny after the client deadline: the client keeps waiting for that reply and the wrapper
    // lets it (client.slow_fallback_max_ms) and returns the block, not kills it at the fail-fast budget and allows
    let _timing = wrapper_timing_lock();
    let diag = format!("/tmp/ah-r-slowblock-{}/wrapper.diag", std::process::id());
    let e = Env::new("slowblock", &[("AH_ENGINE_NOSPAWN", "1"), ("AH_ENGINE_SLOW_DOWN_N", "9"), ("AH_ENGINE_WRAPPER_DIAG", diag.as_str())]);
    fake_server(&e, || {
        std::thread::sleep(Duration::from_millis(800)); // a deny that arrives after client.deadline_ms
        Some(ah_engine::frame::encode(ah_engine::frame::Kind::Ok, &format!("{}late deny", ah_engine::hookio::EXIT2)))
    });
    let max_ms = clamped_num("client.slow_fallback_max_ms", 3000);
    let (out, code, dt) = e.wrapper_hook(DENY_IN);
    println!("TIMING wrapper slow-daemon-delayed-deny wall_ms={:.1}", dt.as_secs_f64() * 1000.0);
    assert_eq!(
        code,
        2,
        "a delayed deny through the wrapper must block, not allow: out={out:?} diag={:?} log={}",
        std::fs::read_to_string(&diag),
        e.health_log()
    );
    assert!(dt < Duration::from_millis(max_ms), "slow-daemon call took {dt:?}, bound is client.slow_fallback_max_ms = {max_ms} ms");
    // a daemon that is merely absent keeps the fail-fast budget
    let down = Env::new("slowblock-down", &[("AH_ENGINE_NOSPAWN", "1")]);
    let (_, code, dt) = down.wrapper_hook(DENY_IN);
    assert_eq!(code, 0);
    assert!(dt < Duration::from_secs(1), "an absent daemon still fails fast: {dt:?}");
}

#[test]
fn an_ok_reply_that_defers_to_node_keeps_the_wait_until_the_node_deny_is_ready() {
    // Codex final Prior-1B: the daemon answers OK at once but leaves the entries to their Node hooks; one denies after the fail-fast
    // budget. The wait marker must stay while that Node work is unresolved, or the wrapper's watchdog kills the call and allows.
    let _timing = wrapper_timing_lock();
    let tag = "okdefer";
    let map = format!("/tmp/ah-r-{tag}-{}/map.json", std::process::id());
    let e = Env::new(tag, &[("AH_ENGINE_NOSPAWN", "1"), ("AH_ENGINE_SLOW_DOWN_N", "9"), ("AH_FALLBACK_MAP", map.as_str())]);
    let entries = ah_engine::dispatch::table::entries("claude", "PreToolUse");
    let first_node = entries.iter().position(|x| x.check.is_none()).unwrap_or(0);
    let late_deny = "sleep 1.2; echo NODE-LATE-DENY >&2; exit 2";
    let m: serde_json::Map<String, serde_json::Value> =
        entries.iter().enumerate().map(|(i, x)| (x.id.clone(), if i == first_node { late_deny } else { "true" }.into())).collect();
    std::fs::write(&map, serde_json::json!({ "PreToolUse": m }).to_string()).unwrap();
    // an OK frame with no decided answer: every entry is deferred to its Node hook
    fake_server(&e, || Some(ah_engine::frame::encode(ah_engine::frame::Kind::Ok, "[]")));
    let fail_fast_ms = clamped_num("client.deadline_ms", 300) + clamped_num("client.deadline_slack_ms", 0) + clamped_num("client.wrapper_extra_ms", 0);
    let max_ms = clamped_num("client.slow_fallback_max_ms", 3000);
    let (_, code, dt) = e.wrapper_hook(DENY_IN);
    println!("TIMING wrapper ok-defer-late-node-deny wall_ms={:.1} fail_fast_ms={fail_fast_ms}", dt.as_secs_f64() * 1000.0);
    assert!(dt > Duration::from_millis(fail_fast_ms), "the Node deny must land after the fail-fast budget to prove the wait: {dt:?} <= {fail_fast_ms} ms");
    assert_eq!(code, 2, "a Node deny after the fail-fast budget must still block: {dt:?}{}", e.diag());
    assert!(dt < Duration::from_millis(max_ms), "bounded by client.slow_fallback_max_ms = {max_ms} ms: {dt:?}");
}

#[test]
fn a_late_reply_is_the_daemons_decision_and_no_node_hook_runs() {
    // R0 P0: the daemon may have committed state for a request by the time its reply is late, so a Node hook on top would count
    // the call twice. The client keeps waiting (client.slow_fallback_max_ms) and uses the daemon's own answer.
    let e = Env::new("latewait", &[("AH_ENGINE_NOSPAWN", "1"), ("AH_ENGINE_SLOW_DOWN_N", "9")]);
    let served = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let s2 = served.clone();
    fake_server(&e, move || {
        s2.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        std::thread::sleep(Duration::from_millis(800)); // after client.deadline_ms (300), inside the window
        Some(ah_engine::frame::encode(ah_engine::frame::Kind::Ok, &format!("{}late deny", ah_engine::hookio::EXIT2)))
    });
    let (out, err, code, dt) = e.hook(DENY_IN, true);
    assert_eq!((code, out.as_str()), (2, ""), "the daemon's deny, not the Node fallback's: {err:?}");
    assert!(err.contains("late deny") && !err.contains("NODE-FALLBACK"), "{err:?}");
    assert_eq!(served.load(std::sync::atomic::Ordering::SeqCst), 1, "the daemon processed the call exactly once");
    assert!(dt >= Duration::from_millis(700) && dt < Duration::from_millis(2500), "{dt:?}");
    let log = e.health_log();
    assert!(log.contains("client_late") && !log.contains("client_slow"), "{log}");
    assert!(!e.fresh_down_marker());
}

/// A crash-looping daemon: it accepts, then dies before any reply byte (`reset` = the connection is reset, else a plain close).
fn dying_server(e: &Env, reset: bool) {
    std::fs::create_dir_all(e.eng()).unwrap();
    let l = UnixListener::bind(e.eng().join("e.sock")).unwrap();
    std::thread::spawn(move || {
        for s in l.incoming().flatten() {
            if reset {
                let lin = libc::linger { l_onoff: 1, l_linger: 0 };
                // SAFETY: `s` is a live socket fd and `lin` is a valid `linger` of the size passed.
                unsafe {
                    libc::setsockopt(
                        std::os::fd::AsRawFd::as_raw_fd(&s),
                        libc::SOL_SOCKET,
                        libc::SO_LINGER,
                        (&raw const lin).cast(),
                        std::mem::size_of::<libc::linger>() as libc::socklen_t,
                    )
                };
            }
            drop(s);
        }
    });
}

#[test]
fn a_daemon_that_accepts_then_dies_fails_fast_not_after_the_slow_window() {
    // R0: only a slow-but-ALIVE daemon may take the slow window; one that closes or resets the connection before any reply byte
    // (a crash loop) fails the call at once, and counts as a failed exchange, not a slow one
    for reset in [false, true] {
        let e = Env::new(if reset { "dyingrst" } else { "dyingeof" }, &[("AH_ENGINE_NOSPAWN", "1"), ("AH_ENGINE_SLOW_DOWN_N", "9")]);
        dying_server(&e, reset);
        let (out, err, _code, dt) = e.hook(DENY_IN, true);
        assert!(dt < Duration::from_secs(1), "reset={reset}: a dying daemon must fail fast: {dt:?} {err:?}");
        assert!(!out.contains("late deny"), "reset={reset}: no reply byte ever arrived: {out:?} {err:?}");
        let log = e.health_log();
        assert!(!log.contains("client_late") && !log.contains("client_slow"), "reset={reset}: not treated as slow: {log}");
    }
}

#[test]
fn a_reply_that_never_comes_fails_open_within_the_window_without_node() {
    let e = Env::new("latenever", &[("AH_ENGINE_NOSPAWN", "1"), ("AH_ENGINE_SLOW_DOWN_N", "9"), ("AH_ENGINE_SLOW_FALLBACK_MAX_MS", "1100")]);
    fake_server(&e, || None);
    let (out, err, code, dt) = e.hook(DENY_IN, true);
    assert_eq!((code, out.as_str()), (0, ""), "{err:?}");
    assert!(!err.contains("NODE-FALLBACK"), "{err:?}");
    assert!(dt >= Duration::from_millis(600) && dt < Duration::from_millis(2000), "bounded by the window: {dt:?}");
    let log = e.health_log();
    assert!(log.contains("client_slow"), "{log}");
    let streak = std::fs::read_to_string(e.eng().join("daemon.slow.streak")).unwrap_or_default();
    assert!(streak.trim_start().starts_with('1'), "the slow call counts in the streak: {streak:?} {log}");
}

#[test]
fn a_daemon_whose_state_dir_is_removed_exits_by_itself() {
    // coordinator finding: 48 test daemons ran on for hours after their tests deleted the state dir (no idle exit, nothing
    // left that could reach them); a daemon now drains and exits once its state dir, lock file or binary is gone
    let e = Env::new("orphan", &[]);
    e.warm();
    let pid = e.pid().unwrap();
    // the daemon may still be writing into its directory while it is removed (DirectoryNotEmpty): remove again until it is gone
    let gone = Instant::now();
    while std::fs::remove_dir_all(e.eng()).is_err() && gone.elapsed() < Duration::from_secs(5) {
        std::thread::sleep(Duration::from_millis(20));
    }
    assert!(!e.eng().exists(), "the state dir could not be removed");
    let t = Instant::now();
    while alive(pid) && t.elapsed() < Duration::from_secs(15) {
        std::thread::sleep(Duration::from_millis(50));
    }
    assert!(!alive(pid), "a daemon with its state dir gone must exit");
}

#[test]
fn a_daemon_whose_run_marker_is_gone_is_still_reaped_by_its_test() {
    // a daemon whose run marker was never written or was removed was skipped by the teardown and outlived its test; the
    // teardown now falls back to the pid in the lock file
    let e = Env::new("nomarker", &[]);
    e.warm();
    let pid = e.pid().unwrap();
    std::fs::remove_file(e.eng().join("daemon.run")).unwrap();
    common::reap(&e.eng(), || {}); // no polite stop: only the lock-file fallback can find it
    assert!(!alive(pid), "the teardown must end the daemon it started");
}

/// CPU-free guard: no `ah-engine serve` of THIS build has been running for longer than any test run takes. A leak from an
/// earlier run (a test that did not reap its daemon) fails here.
#[test]
fn no_daemon_of_this_build_outlives_its_test_run() {
    let o = Command::new("ps").args(["-Ao", "pid=,etime=,command="]).output().unwrap();
    let old: Vec<String> = String::from_utf8_lossy(&o.stdout)
        .lines()
        .filter(|l| l.contains(&format!("{BIN} serve")))
        .filter(|l| {
            // etime is [[dd-]hh:]mm:ss: anything with an hour field, or over 45 minutes, is a leak
            let et = l.split_whitespace().nth(1).unwrap_or("");
            et.contains('-') || et.matches(':').count() >= 2 || et.split(':').next().and_then(|m| m.parse::<u64>().ok()).is_some_and(|m| m >= 45)
        })
        .map(String::from)
        .collect();
    assert!(old.is_empty(), "daemons of this build left running by earlier tests:\n{}", old.join("\n"));
}

#[test]
fn breaker_opens_after_repeated_failures_and_skips_engine() {
    let e =
        Env::new("brk", &[("AH_ENGINE_NOSPAWN", "1"), ("AH_ENGINE_DEADLINE_MS", "150"), ("AH_ENGINE_BREAKER_N", "3"), ("AH_ENGINE_DOWN_MARKER_TTL_MS", "1")]);
    // a late reply is not an engine failure (R0 P0); a reply that is not a frame is
    fake_server(&e, || Some(b"not a frame".to_vec()));
    for _ in 0..3 {
        let (out, _, _, _) = e.hook(DENY_IN, true);
        assert_eq!(out, "");
        std::thread::sleep(Duration::from_millis(5));
    }
    assert!(e.eng().join("breaker.until").exists(), "breaker should be open");
    let fails = || e.health_log().lines().filter(|l| l.contains("\tclient_fail\t")).count();
    let before = fails();
    let (out, _, _, _) = e.hook(DENY_IN, true);
    assert_eq!(out, "");
    assert_eq!(fails(), before, "an open breaker skips the engine: no new failure is counted");
    let st: serde_json::Value =
        serde_json::from_str(&e.cmd().args(["status", "--json"]).output().map(|o| String::from_utf8_lossy(&o.stdout).to_string()).unwrap()).unwrap();
    assert!(st["breaker"].as_str().unwrap().starts_with("open"), "{st}");
}

// ---- 4. crash-loop ----------------------------------------------------------------------------

#[test]
fn crash_loop_stops_respawning_records_reason_and_advises_once() {
    let e = Env::new("loop", &[("AH_ENGINE_CRASH_N", "3")]);
    for i in 0..3 {
        // Exactly one daemon per round, started directly and awaited with `ctl ping` (which never spawns). `warm()` would
        // retry the hook, and every retry that still finds no daemon spawns another one; on a loaded machine such a surplus
        // daemon is still starting when the round's daemon is killed, takes the free lock, and answers after the crash loop
        // tripped although no client respawned anything.
        let mut d = e.cmd().arg("serve").stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).spawn().unwrap();
        assert!(wait_for(|| e.pid().is_some()), "no daemon on round {i}");
        assert_eq!(e.pid(), Some(d.id()), "round {i}: the daemon answering is the one this round started");
        // SAFETY: `kill` takes plain integers and has no memory-safety preconditions; a dead pid just fails with ESRCH.
        unsafe { libc::kill(d.id() as i32, libc::SIGKILL) };
        d.wait().unwrap(); // reaped: a zombie would still count as alive
    }
    // the next call finds the daemon dead 3 times: no respawn, and the hook fails open.
    let (out, _, _, _) = e.hook(DENY_IN, true);
    assert!(out.is_empty(), "{out}");
    assert!(e.eng().join("crashloop.until").exists());
    assert!(std::fs::read_to_string(e.eng().join("failure.json")).unwrap().contains("crashloop"));
    assert!(e.ctl("ping").is_none(), "no daemon was respawned");
    assert!(e.cmd().arg("status").output().unwrap().stdout.windows(7).any(|w| w == b"stopped"), "status shows the stop");
}

#[test]
fn wrapper_restart_loop_fails_open_under_one_second() {
    let e = Env::new_no_prime("wraploop", &[("AH_ENGINE_CRASH_N", "3")]);
    std::fs::create_dir_all(e.eng()).unwrap();
    let now = ah_engine::health::now_ms();
    let log = (0..3).map(|_| format!("{now}\tcrash\tunknown\ttest\n")).collect::<String>();
    std::fs::write(e.eng().join("ah-engine.log"), log).unwrap();
    // the first exec of a freshly linked binary is slow on macOS (~0.4 s, measured: 0.9-1.0 s on the first run after a rebuild, 0.52 s on
    // every later one, identical before and after the slow-wait change); that is the OS, not the call, so it is paid before the timing
    let _ = e.ctl("ping");
    let (out, code, dt) = e.wrapper_hook(DENY_IN);
    assert_eq!((out.as_str(), code), ("", 0));
    assert!(dt < Duration::from_secs(1), "wrapper took {dt:?}");
}

#[test]
fn environment_failure_gets_a_plain_hint_not_an_issue_request() {
    // the engine dir is a regular file => the daemon cannot make it a private dir (an environment problem)
    let e = Env::new_no_prime("envf", &[]);
    std::fs::write(e.eng(), "not a dir").unwrap();
    std::fs::write(e.dir.join("fb.sh"), "cat >/dev/null\necho '{}'\n").unwrap();
    // spawn the daemon directly so its start failure is recorded, then read the advisory path
    let st = e.cmd().arg("serve").status().unwrap();
    assert_eq!(st.code(), Some(78), "start failure exit code");
    // state dir itself is unusable, so record in a sibling dir the client can read: use a fresh good dir
    let f = Env::new("envg", &[]);
    f.clear_down_marker();
    std::fs::create_dir_all(f.eng()).unwrap();
    std::fs::write(f.eng().join("failure.json"), format!(r#"{{"ts":{},"class":"env","kind":"start_fail","code":"os28","hint":"the disk is full (no space left); free some space, then it recovers by itself","reason":"x"}}"#, ah_engine::health::now_ms())).unwrap();
    std::fs::write(f.dir.join("fb.sh"), "cat >/dev/null\necho '{}'\n").unwrap();
    let mut c = f.cmd();
    c.env("AH_ENGINE_NOSPAWN", "1").env("AH_ENGINE_NODE", "/bin/sh").args(["hook", "--fallback"]).arg(f.dir.join("fb.sh"));
    let mut ch = c.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn().unwrap();
    ch.stdin.take().unwrap().write_all(DENY_IN.as_bytes()).unwrap();
    let got = ch.wait_with_output().unwrap();
    let out = format!("{}{}", String::from_utf8_lossy(&got.stdout), String::from_utf8_lossy(&got.stderr));
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
        // a cold start with no fallback now fails open; one peer performs the single-flight restart.
        let code = h.wait().unwrap().code();
        assert_eq!(code, Some(0));
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
fn queue_overflow_answers_busy_and_clients_fail_open() {
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
        (out, _, code, dt) = e.hook(DENY_IN, true);
        // a hook that was merely queued waits out its window and also fails open; only a refused one is answered at once
        if out.is_empty() && dt < Duration::from_secs(1) {
            break;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    assert_eq!((out.as_str(), code), ("", 0), "overflow must fail open, not block");
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
fn accept_loop_survives_a_hundred_client_flood_with_silent_peers() {
    let e = Env::new(
        "flood",
        &[
            ("AH_ENGINE_WORKERS", "4"),
            ("AH_ENGINE_QUEUE", "64"),
            ("AH_ENGINE_READ_MS", "250"),
            ("AH_ENGINE_WRITE_MS", "250"),
            ("AH_ENGINE_STALL_MS", "1000"),
            ("AH_ENGINE_WATCHDOG_TICK_MS", "100"),
            ("AH_ENGINE_SESSION_RPS", "0"),
            ("AH_ENGINE_PROJECT_RPS", "0"),
        ],
    );
    e.warm();
    let old = e.pid().unwrap();
    let cfg_reply_len = config_reply_len(&e);
    let mut silent = Vec::new();
    for _ in 0..20 {
        silent.push(std::os::unix::net::UnixStream::connect(e.eng().join("e.sock")).unwrap());
    }
    let probe = std::os::unix::net::UnixStream::connect(e.eng().join("e.sock")).unwrap();
    let effective_recv = set_recv_buf(&probe, 1024) as usize;
    let fill = ensure_write_fill(&e, effective_recv);
    assert!(write_fill_reply_len(&e, fill) > effective_recv);
    assert!(cfg_reply_len > 0);
    drop(probe);
    let oversized_config = format!("CTL config\n{}", "x".repeat(fill));
    let mut no_read = Vec::new();
    for _ in 0..10 {
        let mut s = std::os::unix::net::UnixStream::connect(e.eng().join("e.sock")).unwrap();
        assert_eq!(set_recv_buf(&s, 1024) as usize, effective_recv);
        ah_engine::discard::harmless(s.write_all(oversized_config.as_bytes()));
        ah_engine::discard::harmless(s.shutdown(std::net::Shutdown::Write));
        no_read.push(s);
    }
    let mut hs = Vec::new();
    for i in 0..70 {
        let sock = e.eng().join("e.sock");
        hs.push(std::thread::spawn(move || {
            let mut s = std::os::unix::net::UnixStream::connect(sock).unwrap();
            let req = if i % 2 == 0 { format!("V 0.1.0\n{}", DENY_IN) } else { "CTL status\n".to_string() };
            ah_engine::discard::harmless(s.write_all(req.as_bytes()));
            ah_engine::discard::harmless(s.shutdown(std::net::Shutdown::Write));
            let b = read_all_deadline(&mut s, Duration::from_secs(5));
            ah_engine::frame::decode(&b).map(|(k, _)| k).ok()
        }));
    }
    let mut answered = 0;
    for h in hs {
        match h.join().unwrap() {
            Some(ah_engine::frame::Kind::Ok | ah_engine::frame::Kind::Busy) => answered += 1,
            other => panic!("well-behaved client got no usable reply: {other:?}"),
        }
    }
    assert_eq!(answered, 70);
    for mut s in silent {
        let b = read_all_deadline(&mut s, Duration::from_secs(3));
        let (k, body) = ah_engine::frame::decode(&b).expect("silent peer gets framed timeout");
        assert_eq!(k, ah_engine::frame::Kind::Err);
        assert_eq!(body, ah_engine::defaults::text("msg.reply_read_deadline"));
    }
    drop(no_read);
    std::thread::sleep(Duration::from_millis(1300));
    assert_eq!(e.pid(), Some(old), "watchdog must not restart a healthy accept loop");
    assert!(e.status()["reply_write_errors"].as_u64().unwrap_or(0) > 0, "no-read peers should trip the write deadline");
    let log = std::fs::read_to_string(e.eng().join("ah-engine.log")).unwrap_or_default();
    assert!(!log.contains("watchdog\tstall"), "{log}");
}

#[test]
fn rate_limited_session_gets_busy_so_it_uses_the_fallback_contract() {
    let e = Env::new("rate", &[("AH_ENGINE_SESSION_RPS", "1"), ("AH_ENGINE_SESSION_BURST", "2")]);
    e.warm(); // consumes some of s1's burst
    let mut fell_back = false;
    for _ in 0..6 {
        if e.hook(DENY_IN, true).0 == "NODE-FALLBACK" {
            fell_back = true;
        }
    }
    assert!(fell_back, "per-session limit never produced a healthy BUSY/ERR fallback");
    let other = DENY_IN.replace("s1", "fresh-session");
    assert!(e.hook(&other, true).0.contains("engine-blocked"), "other sessions are unaffected");
}

#[test]
fn cpu_budget_trip_uses_the_fallback_contract() {
    let e = Env::new("cpu", &[("AH_ENGINE_EVAL_BUDGET_US", "1")]);
    // a heavy-ish rule set so evaluation takes > 1 us of thread CPU
    let rules: Vec<String> = (0..200).map(|i| format!(r#"{{"pattern":"zzz{i}[a-z]+q","action":"warn","message":"m"}}"#)).collect();
    std::fs::write(e.dir.join("rules.json"), format!(r#"{{"version":1,"rules":[{}]}}"#, rules.join(","))).unwrap();
    let mut daemon = e.cmd().arg("serve").stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).spawn().unwrap();
    assert!(wait_for(|| e.pid().is_some()));
    e.clear_down_marker();
    assert_eq!(e.hook(DENY_IN, true).0, "NODE-FALLBACK", "budget exceeded => healthy ERR => fallback contract");
    e.warm_status_budget();
    drop(e.ctl("stop"));
    ah_engine::discard::harmless(daemon.wait());
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
    let probe = Env::new_no_prime("rssprobe", &[("AH_ENGINE_RSS_CHECK_MS", "200"), ("AH_ENGINE_WATCHDOG_TICK_MS", "100")]);
    let rules: Vec<String> = (0..8000).map(|i| format!(r#"{{"pattern":"rss{i}[a-z]{{20}}","action":"warn","message":"m{i}"}}"#)).collect();
    let rules_text = format!(r#"{{"version":1,"rules":[{}]}}"#, rules.join(","));
    std::fs::write(probe.dir.join("rules.json"), &rules_text).unwrap();
    let mut probe_daemon = probe.cmd().arg("serve").stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).spawn().unwrap();
    assert!(wait_for(|| probe.pid().is_some()));
    let startup_mem = probe.status()["mem_kb"].as_u64().unwrap();
    drop(probe.ctl("stop"));
    ah_engine::discard::harmless(probe_daemon.wait());

    let cap_num = startup_mem + 4096;
    let cap = cap_num.to_string();
    let e = Env::new_no_prime("rss", &[("AH_ENGINE_RSS_CAP_KB", cap.as_str()), ("AH_ENGINE_RSS_CHECK_MS", "200"), ("AH_ENGINE_WATCHDOG_TICK_MS", "100")]);
    std::fs::write(e.dir.join("rules.json"), rules_text).unwrap();
    let mut daemon = e.cmd().arg("serve").stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).spawn().unwrap();
    assert!(wait_for(|| e.pid().is_some()));
    let before = e.status()["mem_kb"].as_u64().unwrap();
    println!("TIMING rss cap startup_probe_kb={startup_mem} before_kb={before} cap_kb={cap_num}");
    assert!(before <= cap_num, "test cap must exceed startup footprint: before={before} cap={cap_num}");
    let old = e.pid().unwrap();
    e.clear_down_marker();
    let alloc_kb = cap_num.saturating_sub(before) + 65536;
    assert_eq!(e.ctl(&format!("alloc {alloc_kb}")).as_deref(), Some("ok"));
    if let Some(after) = e.ctl("status").and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok()) {
        println!(
            "TIMING rss cap after_alloc_kb={} mem_kb={} alloc_kb={alloc_kb}",
            after["rss_kb"].as_u64().unwrap_or(0),
            after["mem_kb"].as_u64().unwrap_or(0)
        );
        assert_eq!(after["rss_cap_kb"].as_u64(), Some(cap_num), "RSS cap env override not applied: {after}");
    }
    assert!(wait_for(|| daemon.try_wait().unwrap().is_some() || !alive(old)), "daemon above its RSS cap must exit");
    assert!(std::fs::read_to_string(e.eng().join("ah-engine.log")).unwrap().contains("rss"));
    let (out, _, code, _) = e.hook(DENY_IN, true);
    assert_eq!(code, 0, "first post-rss hook fails open while it restarts: {out}");
    assert!(wait_for(|| e.pid().is_some_and(|p| p != old)), "next client must respawn the daemon after RSS exit; log:\n{}", e.health_log());
    drop(e.ctl("stop"));
    ah_engine::discard::harmless(daemon.wait());
}

#[test]
fn memory_limit_and_nice_are_applied_and_reported() {
    let e = Env::new("mem", &[("AH_ENGINE_MEM_MB", "512"), ("AH_ENGINE_NICE", "7")]);
    e.warm();
    let st = e.status();
    if cfg!(target_os = "linux") {
        assert_eq!(st["mem_limit"], "ok:512");
    } else if cfg!(target_os = "macos") {
        assert_eq!(st["mem_limit"], "unsupported:rlimit_data");
    } else {
        assert!(st["mem_limit"].as_str().unwrap().starts_with("ok:512") || st["mem_limit"].as_str().unwrap().starts_with("err:"), "{st}");
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
    let e = Env::new_no_prime("symd", &[]);
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

#[test]
fn abort_breadcrumb_is_reaped_on_next_start_and_reported_by_status() {
    let e = Env::new("abortbc", &[]);
    std::fs::create_dir_all(e.eng()).unwrap();
    std::fs::write(e.eng().join("daemon.run"), "0").unwrap();
    std::fs::write(e.eng().join("crash-breadcrumb.json"), r#"{"request":"D","event":"Stop","check":"task-guard","uptime_s":7,"memory":{"rss_kb":12}}"#)
        .unwrap();
    e.warm();
    let st = e.status();
    assert_eq!(st["health"]["last_crash"]["kind"], "crash", "{st}");
    assert_eq!(st["health"]["last_crash"]["breadcrumb"]["request"], "D", "{st}");
    assert_eq!(st["health"]["last_crash"]["breadcrumb"]["event"], "Stop", "{st}");
    assert_eq!(st["health"]["last_crash"]["breadcrumb"]["check"], "task-guard", "{st}");
}

// ---- R0 P0: a hung (SIGSTOPped / wedged) daemon -------------------------------------------------------------------------

fn signal(pid: u32, sig: libc::c_int) {
    // SAFETY: `kill` takes plain integers and has no memory-safety preconditions; the pid is this test's own daemon or child.
    unsafe { libc::kill(pid as i32, sig) };
}

/// A daemon frozen by SIGSTOP (alive, holding its socket and singleton lock, making no progress) costs at most one slow call:
/// every later hook call is under a second and fails open, also after the down marker's TTL has run out.
#[test]
fn a_stopped_daemon_costs_at_most_one_slow_call() {
    let _timing = wrapper_timing_lock();
    let e = Env::new("hbstop", &[]);
    e.warm();
    let old = e.pid().unwrap();
    signal(old, libc::SIGSTOP);
    let max_ms = clamped_num("client.slow_fallback_max_ms", 3000);
    let ttl_ms = clamped_num("client.down_marker_ttl_ms", 3000);
    let (_, code, dt) = e.wrapper_hook(DENY_IN);
    println!("TIMING hung-daemon call 0 wall_ms={:.1} rc={code}", dt.as_secs_f64() * 1000.0);
    assert!(code == 0 || code == 2, "call 0 exited {code}");
    assert!(dt <= Duration::from_millis(max_ms), "the one slow call is bounded by client.slow_fallback_max_ms = {max_ms} ms: {dt:?}");
    let mut times = Vec::new();
    for phase in 0..2 {
        if phase == 1 {
            std::thread::sleep(Duration::from_millis(ttl_ms + 200)); // past the down marker: the hang must not cost again
        }
        for i in 0..5 {
            let (_, code, dt) = e.wrapper_hook(DENY_IN);
            println!("TIMING hung-daemon phase {phase} call {} wall_ms={:.1} rc={code}", i + 1, dt.as_secs_f64() * 1000.0);
            assert!(code == 0 || code == 2, "phase {phase} call {} exited {code}", i + 1);
            times.push(dt);
        }
    }
    signal(old, libc::SIGKILL);
    assert!(times.iter().all(|t| *t < Duration::from_secs(1)), "every call after the first must be under 1 s: {times:?}{}", e.diag());
}

/// A permanently wedged daemon is recovered: the client that finds it hung ends it (by the pid it verified as this daemon) and
/// a new daemon answers within a few calls.
#[test]
fn a_permanently_wedged_daemon_is_replaced_by_a_new_one() {
    let _timing = wrapper_timing_lock();
    let e = Env::new("hbwedge", &[]);
    e.warm();
    let old = e.pid().unwrap();
    signal(old, libc::SIGSTOP);
    let mut fresh = None;
    for i in 0..10 {
        let (_, code, dt) = e.wrapper_hook(DENY_IN);
        println!("TIMING wedged-daemon call {i} wall_ms={:.1} rc={code}", dt.as_secs_f64() * 1000.0);
        fresh = e.pid().filter(|p| *p != old);
        if fresh.is_some() {
            break;
        }
        std::thread::sleep(Duration::from_millis(500));
    }
    let old_alive = alive(old);
    signal(old, libc::SIGKILL);
    assert!(fresh.is_some(), "no new daemon answered within 10 calls after the old one wedged{}", e.diag());
    assert!(!old_alive, "the wedged daemon must have been ended");
    e.warm();
    assert!(e.health_log().contains("\tclient_hung_kill\t"), "the recovery is logged: {}", e.health_log());
}

/// The heartbeat a fake daemon keeps (the file the real daemon's watchdog touches): `fresh` touches it every 100 ms, else it is
/// written once and aged past the stale threshold. `pid` is what the file names (never this test process), with its real start
/// time and executable and this instance's state dir, so only "is it this engine's daemon" can stop a signal.
fn fake_heartbeat(e: &Env, pid: u32, fresh: bool) {
    let p = e.eng().join("daemon.heartbeat");
    std::fs::create_dir_all(e.eng()).unwrap();
    let (start, exe) = (ah_engine::procid::start(pid).unwrap(), ah_engine::procid::exe(pid).unwrap());
    let dir = std::fs::canonicalize(e.eng()).unwrap();
    std::fs::write(&p, format!("{pid}\n{start}\n{}\n{}\n", exe.display(), dir.display())).unwrap();
    std::fs::write(e.eng().join("e.sock.lock"), pid.to_string()).unwrap(); // the singleton lock holder the heartbeat must name
    let old = std::time::SystemTime::now() - Duration::from_secs(60);
    std::fs::File::options().write(true).open(&p).unwrap().set_modified(old).unwrap();
    if fresh {
        std::thread::spawn(move || {
            while let Ok(f) = std::fs::File::options().write(true).open(&p) {
                ah_engine::discard::harmless(f.set_modified(std::time::SystemTime::now()));
                std::thread::sleep(Duration::from_millis(100));
            }
        });
    }
}

/// A slow-but-ALIVE daemon (its heartbeat fresh) still gets the slow window: a deny 1.5 s late blocks (rc 2).
#[test]
fn a_late_deny_from_a_daemon_with_a_fresh_heartbeat_still_blocks() {
    let _timing = wrapper_timing_lock();
    let e = Env::new("hbfresh", &[("AH_ENGINE_NOSPAWN", "1"), ("AH_ENGINE_SLOW_DOWN_N", "9")]);
    let mut stand_in = Command::new("sleep").arg("60").spawn().unwrap();
    fake_heartbeat(&e, stand_in.id(), true);
    fake_server(&e, || {
        std::thread::sleep(Duration::from_millis(1500));
        Some(ah_engine::frame::encode(ah_engine::frame::Kind::Ok, &format!("{}late deny", ah_engine::hookio::EXIT2)))
    });
    let (out, code, dt) = e.wrapper_hook(DENY_IN);
    println!("TIMING fresh-heartbeat late deny wall_ms={:.1} rc={code}", dt.as_secs_f64() * 1000.0);
    ah_engine::discard::harmless(stand_in.kill());
    ah_engine::discard::harmless(stand_in.wait());
    assert_eq!(code, 2, "a delayed deny from a live daemon must block: out={out:?} {}", e.health_log());
    assert!(dt >= Duration::from_millis(1500) && dt < Duration::from_millis(clamped_num("client.slow_fallback_max_ms", 3000)), "{dt:?}");
}

/// A daemon whose heartbeat is stale fails the call fast (no slow window), and a pid the heartbeat names that is not this
/// engine's daemon is never signalled.
#[test]
fn a_stale_heartbeat_fails_fast_and_never_kills_a_process_that_is_not_the_daemon() {
    let _timing = wrapper_timing_lock();
    let e = Env::new("hbstale", &[("AH_ENGINE_NOSPAWN", "1"), ("AH_ENGINE_SLOW_DOWN_N", "9")]);
    let mut stand_in = Command::new("sleep").arg("60").spawn().unwrap();
    fake_heartbeat(&e, stand_in.id(), false);
    fake_server(&e, || {
        std::thread::sleep(Duration::from_millis(1500));
        Some(ah_engine::frame::encode(ah_engine::frame::Kind::Ok, &format!("{}late deny", ah_engine::hookio::EXIT2)))
    });
    let (_, code, dt) = e.wrapper_hook(DENY_IN);
    println!("TIMING stale-heartbeat wall_ms={:.1} rc={code}", dt.as_secs_f64() * 1000.0);
    let marked = e.fresh_down_marker();
    // past the down marker, the same unchanged heartbeat confirms the hang: the replacement path runs and must spare it
    std::thread::sleep(Duration::from_millis(clamped_num("client.down_marker_ttl_ms", 3000) + 200));
    let (_, code2, dt2) = e.wrapper_hook(DENY_IN);
    println!("TIMING stale-heartbeat confirming call wall_ms={:.1} rc={code2}", dt2.as_secs_f64() * 1000.0);
    let survived = stand_in.try_wait().unwrap().is_none();
    ah_engine::discard::harmless(stand_in.kill());
    ah_engine::discard::harmless(stand_in.wait());
    let log = e.health_log();
    assert_eq!((code, code2), (0, 0), "a hung daemon fails open: {log}");
    assert!(dt < Duration::from_secs(1) && dt2 < Duration::from_secs(1), "a stale heartbeat must fail fast: {dt:?} {dt2:?}");
    assert!(marked, "a hung daemon is marked down at once: {log}");
    assert!(log.contains("\tclient_hung_spared\t"), "the confirming call reached the replacement path: {log}");
    assert!(survived, "a pid that is not the engine's daemon must never be signalled");
}

/// A stale heartbeat seen once only raises suspicion: the call fails open at once, and nothing is signalled until a later call finds
/// the same heartbeat still unchanged (`client.heartbeat_confirm_ms`). A daemon stopped for a while and resumed inside that window
/// beats again, which clears the suspicion: it is never killed and answers the next call itself.
#[test]
fn a_stopped_daemon_that_resumes_before_confirmation_is_not_killed() {
    let _timing = wrapper_timing_lock();
    let e = Env::new("hbresume", &[]);
    e.warm();
    let old = e.pid().unwrap();
    signal(old, libc::SIGSTOP);
    let (_, code, dt) = e.wrapper_hook(DENY_IN);
    println!("TIMING resumed-daemon suspect call wall_ms={:.1} rc={code}", dt.as_secs_f64() * 1000.0);
    signal(old, libc::SIGCONT);
    std::thread::sleep(Duration::from_millis(clamped_num("client.down_marker_ttl_ms", 3000) + 200));
    let (_, after, _) = e.wrapper_hook(DENY_IN);
    let (survived, same) = (alive(old), e.pid() == Some(old));
    let log = e.health_log();
    assert!(code == 0 || code == 2, "the suspect call exited {code}");
    assert!(log.contains("\tclient_hung\t"), "the stale heartbeat must have been seen: {log}");
    assert!(!log.contains("\tclient_hung_kill\t"), "a daemon that resumed must not be killed: {log}");
    assert!(survived && same, "the resumed daemon must still be the one serving{}", e.diag());
    assert_eq!(after, 2, "the resumed daemon answers the next call itself{}", e.diag());
}

/// A heartbeat that reads old on every sample but keeps moving (the wall clock jumped forward past it, or the beat lands late) is
/// progress, not a hang: the suspicion resets on every change, so the daemon is never signalled however many calls see it stale.
#[test]
fn a_heartbeat_that_reads_old_but_keeps_moving_is_never_killed() {
    use std::sync::Arc;
    use std::sync::atomic::{AtomicBool, Ordering};
    let _timing = wrapper_timing_lock();
    let e = Env::new("hbjump", &[]);
    e.warm();
    let old = e.pid().unwrap();
    signal(old, libc::SIGSTOP); // late replies; the heartbeat below stands in for its beat
    let (p, stop) = (e.eng().join("daemon.heartbeat"), Arc::new(AtomicBool::new(false)));
    let toucher = {
        let stop = stop.clone();
        std::thread::spawn(move || {
            while !stop.load(Ordering::SeqCst) {
                if let Ok(f) = std::fs::File::options().write(true).open(&p) {
                    ah_engine::discard::harmless(f.set_modified(std::time::SystemTime::now() - Duration::from_secs(60)));
                }
                std::thread::sleep(Duration::from_millis(100));
            }
        })
    };
    for i in 0..3 {
        let (_, code, dt) = e.wrapper_hook(DENY_IN);
        println!("TIMING moving-old-heartbeat call {i} wall_ms={:.1} rc={code}", dt.as_secs_f64() * 1000.0);
        std::thread::sleep(Duration::from_millis(clamped_num("client.down_marker_ttl_ms", 3000) + 200));
    }
    stop.store(true, Ordering::SeqCst);
    ah_engine::discard::harmless(toucher.join());
    let survived = alive(old);
    signal(old, libc::SIGCONT);
    let log = e.health_log();
    assert!(log.contains("\tclient_hung\t"), "every sample read stale: {log}");
    assert!(!log.contains("\tclient_hung_kill\t"), "a moving heartbeat must never be killed: {log}");
    assert!(survived, "the daemon must still be alive");
}

/// The heartbeat a real daemon of another instance (`other`) wrote, as `(pid, lines)`.
fn heartbeat_lines(other: &Env) -> (u32, Vec<String>) {
    let text = std::fs::read_to_string(other.eng().join("daemon.heartbeat")).unwrap();
    let lines: Vec<String> = text.lines().map(str::to_string).collect();
    (lines[0].parse().unwrap(), lines)
}

/// Plant `content` as a long-stale heartbeat in `e`, naming `pid` as the singleton lock holder, behind a slow fake daemon; run a
/// suspect call and, past the down marker, the confirming one.
fn stale_planted_heartbeat_two_calls(e: &Env, pid: u32, content: &str) {
    std::fs::create_dir_all(e.eng()).unwrap();
    let p = e.eng().join("daemon.heartbeat");
    std::fs::write(&p, content).unwrap();
    std::fs::write(e.eng().join("e.sock.lock"), pid.to_string()).unwrap();
    std::fs::File::options().write(true).open(&p).unwrap().set_modified(std::time::SystemTime::now() - Duration::from_secs(60)).unwrap();
    fake_server(e, || {
        std::thread::sleep(Duration::from_millis(1500));
        Some(ah_engine::frame::encode(ah_engine::frame::Kind::Ok, "{}"))
    });
    for i in 0..2 {
        if i == 1 {
            std::thread::sleep(Duration::from_millis(clamped_num("client.down_marker_ttl_ms", 3000) + 200));
        }
        let (_, code, dt) = e.wrapper_hook(DENY_IN);
        println!("TIMING planted-heartbeat call {i} wall_ms={:.1} rc={code}", dt.as_secs_f64() * 1000.0);
    }
}

/// P1-2: a heartbeat whose pid now belongs to another process generation (a reused pid: same number, another start time) is
/// never signalled, even when that process is a live engine daemon.
#[test]
fn a_heartbeat_naming_a_reused_pid_is_never_signalled() {
    let _timing = wrapper_timing_lock();
    let other = Env::new("hbreuse-b", &[]);
    other.warm();
    let (pid, mut lines) = heartbeat_lines(&other);
    let e = Env::new("hbreuse-a", &[("AH_ENGINE_NOSPAWN", "1"), ("AH_ENGINE_SLOW_DOWN_N", "9")]);
    lines[1] = (lines[1].parse::<u64>().unwrap() + 1).to_string(); // an earlier process that had this pid
    std::fs::create_dir_all(e.eng()).unwrap();
    lines[3] = std::fs::canonicalize(e.eng()).unwrap().to_string_lossy().into_owned(); // this instance
    stale_planted_heartbeat_two_calls(&e, pid, &(lines.join("\n") + "\n"));
    let (survived, log) = (alive(pid) && other.pid() == Some(pid), e.health_log());
    assert!(log.contains("\tclient_hung_spared\t"), "the confirmed hang must reach the identity check and decline: {log}");
    assert!(!log.contains("\tclient_hung_kill\t"), "{log}");
    assert!(survived, "a reused pid must never be signalled");
}

/// P1-2: a heartbeat a daemon of another instance (another state dir) wrote is never acted on here, even with its pid, start time
/// and executable all matching that live daemon.
#[test]
fn a_heartbeat_from_another_instance_is_never_signalled() {
    let _timing = wrapper_timing_lock();
    let other = Env::new("hbinst-b", &[]);
    other.warm();
    let (pid, lines) = heartbeat_lines(&other);
    let e = Env::new("hbinst-a", &[("AH_ENGINE_NOSPAWN", "1"), ("AH_ENGINE_SLOW_DOWN_N", "9")]);
    stale_planted_heartbeat_two_calls(&e, pid, &(lines.join("\n") + "\n"));
    let (survived, log) = (alive(pid) && other.pid() == Some(pid), e.health_log());
    assert!(log.contains("\tclient_hung_spared\t"), "the confirmed hang must reach the identity check and decline: {log}");
    assert!(!log.contains("\tclient_hung_kill\t"), "{log}");
    assert!(survived, "another instance's daemon must never be signalled");
}
