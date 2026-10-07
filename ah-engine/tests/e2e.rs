//! End-to-end: real binary, real daemon, isolated HOME + engine dir (never the user's real ~/.anti-hall).
#![allow(clippy::unwrap_used, clippy::expect_used)] // a test crate: a panic is the failure report, and E2 exempts tests
mod common;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

const BIN: &str = env!("CARGO_BIN_EXE_ah-engine");
const RULES: &str = r#"{"version":1,"rules":[{"id":"force","events":["PreToolUse"],"tools":["Bash"],"field":"command","pattern":"git push --force","action":"deny","message":"blocked"}]}"#;
const DENY_IN: &str = r#"{"hook_event_name":"PreToolUse","tool_name":"Bash","tool_input":{"command":"git push --force origin main"}}"#;

struct Env {
    dir: PathBuf,
}

impl Env {
    fn new(tag: &str) -> Env {
        let dir = PathBuf::from("/tmp").join(format!("ah-e2e-{}-{}", tag, std::process::id()));
        ah_engine::discard::harmless(std::fs::remove_dir_all(&dir));
        std::fs::create_dir_all(dir.join("home")).unwrap();
        std::fs::write(dir.join("rules.json"), RULES).unwrap();
        Env { dir }
    }
    fn cmd(&self, version: &str) -> Command {
        let mut c = Command::new(BIN);
        c.env("HOME", self.dir.join("home"))
            .env("AH_ENGINE_DIR", self.dir.join("eng"))
            .env("AH_ENGINE_RULES", self.dir.join("rules.json"))
            .env("AH_ENGINE_VERSION", version)
            .env_remove("AH_ENGINE_NOSPAWN");
        c
    }
    fn hook(&self, version: &str, input: &str) -> (String, i32) {
        let mut ch = self.cmd(version).arg("hook").stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn().unwrap();
        ch.stdin.take().unwrap().write_all(input.as_bytes()).unwrap();
        let o = ch.wait_with_output().unwrap();
        assert!(o.stderr.is_empty(), "client wrote to stderr: {}", String::from_utf8_lossy(&o.stderr));
        (String::from_utf8_lossy(&o.stdout).trim().to_string(), o.status.code().unwrap_or(-1))
    }
    fn ctl(&self, verb: &str) -> Option<String> {
        let o = self.cmd("0").args(["ctl", verb]).output().unwrap();
        o.status.success().then(|| String::from_utf8_lossy(&o.stdout).trim().to_string())
    }
    fn pid(&self) -> Option<u32> {
        self.ctl("ping")?.split_whitespace().nth(2)?.parse().ok()
    }
}

impl Drop for Env {
    fn drop(&mut self) {
        common::reap(&self.dir.join("eng"), || {
            let _ = self.ctl("stop");
        });
        ah_engine::discard::harmless(std::fs::remove_dir_all(&self.dir));
    }
}

fn wait_for(mut f: impl FnMut() -> bool) -> bool {
    let t = Instant::now();
    while t.elapsed() < Duration::from_secs(3) {
        if f() {
            return true;
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    false
}

fn alive(pid: u32) -> bool {
    Command::new("kill").args(["-0", &pid.to_string()]).stderr(Stdio::null()).status().is_ok_and(|s| s.success())
}

#[test]
fn cold_start_denies_and_stays_resident() {
    let e = Env::new("cold");
    let (out, code) = e.hook("0.1.0", DENY_IN);
    // first call may race the cold start; a retry must be served by the daemon
    let out = if out.is_empty() {
        assert!(wait_for(|| e.pid().is_some()));
        e.hook("0.1.0", DENY_IN).0
    } else {
        out
    };
    assert_eq!(code, 0);
    assert!(out.contains(r#""permissionDecision":"deny""#), "{out}");
    assert!(e.pid().is_some());
}

#[test]
fn concurrent_cold_starts_spawn_one_daemon() {
    let e = Env::new("conc");
    let hs: Vec<_> = (0..12)
        .map(|_| {
            let mut c = e.cmd("0.1.0");
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
    std::thread::sleep(Duration::from_millis(300)); // let losers of the lock race exit
    let n = Command::new("pgrep").args(["-f", &format!("{} serve", BIN)]).output().unwrap();
    let mine: Vec<_> = String::from_utf8_lossy(&n.stdout).lines().filter(|l| !l.is_empty()).filter_map(|l| l.trim().parse::<u32>().ok()).collect();
    // pgrep matches every daemon of every parallel test, so count only this env's lock holder instead
    let lock = e.dir.join("eng").join("e.sock.lock");
    let holders = Command::new("lsof").arg(&lock).output().unwrap();
    let pids: std::collections::HashSet<_> =
        String::from_utf8_lossy(&holders.stdout).lines().skip(1).filter_map(|l| l.split_whitespace().nth(1).map(String::from)).collect();
    assert_eq!(pids.len(), 1, "lock holders: {pids:?} (all engine daemons: {mine:?})");
}

#[test]
fn stale_socket_and_dead_lock_are_recovered() {
    let e = Env::new("stale");
    let eng = e.dir.join("eng");
    std::fs::create_dir_all(&eng).unwrap();
    // a leftover socket FILE from a crashed daemon (nothing listening) + an unlocked lock file
    let _l = std::os::unix::net::UnixListener::bind(eng.join("e.sock")).unwrap();
    drop(_l); // closes the fd; the file stays, connect() now gets ECONNREFUSED
    assert!(Path::new(&eng.join("e.sock")).exists());
    std::fs::write(eng.join("e.sock.lock"), "").unwrap();
    let mut out = String::new();
    assert!(wait_for(|| {
        out = e.hook("0.1.0", DENY_IN).0;
        !out.is_empty()
    }));
    assert!(out.contains("deny"));
}

#[test]
fn newer_client_hands_off_to_new_build() {
    let e = Env::new("handoff");
    assert!(wait_for(|| !e.hook("0.1.0", DENY_IN).0.is_empty()));
    let old = e.pid().unwrap();
    assert!(e.ctl("ping").unwrap().contains(" 0.1.0 ") || e.ctl("ping").unwrap().starts_with("pong 0.1.0"));
    // client at 0.2.0: the in-flight request is still answered by the old daemon
    let (out, code) = e.hook("0.2.0", DENY_IN);
    assert_eq!(code, 0);
    assert!(out.contains("deny"), "in-flight request must still be served: {out:?}");
    assert!(wait_for(|| !alive(old)), "old daemon must exit");
    // next client cold-starts the new build
    assert!(wait_for(|| !e.hook("0.2.0", DENY_IN).0.is_empty()));
    let ping = e.ctl("ping").unwrap();
    assert!(ping.starts_with("pong 0.2.0 "), "{ping}");
    assert_ne!(e.pid().unwrap(), old);
}

#[test]
fn older_client_does_not_restart_newer_daemon() {
    let e = Env::new("older");
    assert!(wait_for(|| !e.hook("0.2.0", DENY_IN).0.is_empty()));
    let pid = e.pid().unwrap();
    assert!(e.hook("0.1.0", DENY_IN).0.contains("deny"));
    assert_eq!(e.pid().unwrap(), pid);
}

#[test]
fn rules_reload_on_file_change_and_bad_edit_keeps_old_rules() {
    let e = Env::new("reload");
    assert!(wait_for(|| !e.hook("0.1.0", DENY_IN).0.is_empty()));
    std::fs::write(e.dir.join("rules.json"), "{ this is not json").unwrap();
    std::thread::sleep(Duration::from_millis(600));
    assert!(e.hook("0.1.0", DENY_IN).0.contains("deny"), "bad edit must keep previous rules");
    std::fs::write(e.dir.join("rules.json"), r#"{"version":1,"rules":[]}"#).unwrap();
    assert!(wait_for(|| e.hook("0.1.0", DENY_IN).0.is_empty()), "new (empty) rules must take effect");
    // SIGHUP path
    std::fs::write(e.dir.join("rules.json"), RULES).unwrap();
    let pid = e.pid().unwrap();
    Command::new("kill").args(["-HUP", &pid.to_string()]).status().unwrap();
    assert!(wait_for(|| e.hook("0.1.0", DENY_IN).0.contains("deny")));
}

#[test]
fn fail_open_everywhere() {
    let e = Env::new("failopen");
    // garbage in, no daemon spawn possible, unwritable dir: always empty stdout + exit 0
    for input in ["", "not json", "{}", "\u{0}\u{1}", r#"{"hook_event_name":"PreToolUse"}"#] {
        let (out, code) = e.hook("0.1.0", input);
        assert_eq!((out.as_str(), code), ("", 0), "{input:?}");
    }
    let mut c = e.cmd("0.1.0");
    c.env("AH_ENGINE_NOSPAWN", "1").env("AH_ENGINE_DIR", "/nonexistent/x");
    let mut ch = c.arg("hook").stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn().unwrap();
    ch.stdin.take().unwrap().write_all(DENY_IN.as_bytes()).unwrap();
    let o = ch.wait_with_output().unwrap();
    assert!(o.status.success() && o.stdout.is_empty() && o.stderr.is_empty());
    // unwritable engine dir WITH spawning enabled: the daemon cannot start, the client must still fail open
    let mut c = e.cmd("0.1.0");
    c.env("AH_ENGINE_DIR", "/proc/none/x").env("TMPDIR", "/nonexistent");
    let mut ch = c.arg("hook").stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn().unwrap();
    ch.stdin.take().unwrap().write_all(DENY_IN.as_bytes()).unwrap();
    let o = ch.wait_with_output().unwrap();
    assert!(o.status.success() && o.stderr.is_empty());
}
