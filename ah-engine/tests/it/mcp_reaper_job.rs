//! `ah-engine mcp-reaper run`, the standalone MCP reaper as an engine job (port of companion/mcp-reaper.js), end to end: the real
//! binary and plugin script in a scratch HOME, with a process listing served by a stand-in `ps` on PATH. Every process the listing
//! selects is a `sleep` this test started (so a signal can only reach the test's own children); the other rows carry pids that are
//! never selected. The selection is compared with the Node companion's own `findOrphans` on the same listing.
#![allow(clippy::unwrap_used, clippy::expect_used)] // a test crate: a panic is the failure report, and E2 exempts tests
use serde_json::Value;
use std::os::unix::process::ExitStatusExt;
use std::path::{Path, PathBuf};
use std::process::{Child, Command};

const BIN: &str = env!("CARGO_BIN_EXE_ah-engine");

fn plugin() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../plugins/anti-hall").canonicalize().unwrap()
}

static SEQ: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);

struct World {
    dir: PathBuf,
    kids: Vec<Child>,
}

impl Drop for World {
    fn drop(&mut self) {
        for k in &mut self.kids {
            ah_engine::discard::harmless(k.kill()); // keep: a child already reaped by the test
            ah_engine::discard::harmless(k.wait()); // keep: reaping a child that already ended
        }
        ah_engine::discard::harmless(std::fs::remove_dir_all(&self.dir)); // keep: best-effort cleanup of the scratch dir
    }
}

impl World {
    fn new(tag: &str) -> World {
        let n = SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!("ah-mrj-{tag}-{}-{n}", std::process::id()));
        ah_engine::discard::harmless(std::fs::remove_dir_all(&dir)); // keep: an absent dir is the goal state
        std::fs::create_dir_all(dir.join("home")).unwrap();
        std::fs::create_dir_all(dir.join("bin")).unwrap();
        World { dir, kids: Vec::new() }
    }

    fn home(&self) -> PathBuf {
        self.dir.join("home")
    }

    /// A `sleep` child of this test: its pid.
    fn victim(&mut self) -> u32 {
        let c = Command::new("sleep").arg("120").spawn().unwrap();
        let pid = c.id();
        self.kids.push(c);
        pid
    }

    /// The stand-in `ps`: prints `rows` (pid, ppid, command) in the `pid=,ppid=,command=` layout.
    fn listing(&self, rows: &[(u32, u32, String)]) -> String {
        let text: String = rows.iter().map(|(p, pp, c)| format!("{p:>6} {pp:>6} {c}\n")).collect();
        std::fs::write(self.dir.join("listing.txt"), &text).unwrap();
        let ps = self.dir.join("bin/ps");
        std::fs::write(&ps, format!("#!/bin/sh\ncat '{}'\n", self.dir.join("listing.txt").display())).unwrap();
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&ps, std::fs::Permissions::from_mode(0o755)).unwrap();
        text
    }

    fn run(&self, args: &[&str], env: &[(&str, &str)]) -> Value {
        let mut c = Command::new(BIN);
        c.arg("mcp-reaper")
            .args(args)
            .env_clear()
            .env("PATH", format!("{}:/usr/bin:/bin", self.dir.join("bin").display()))
            .env("HOME", self.home())
            .env("AH_ENGINE_DIR", self.dir.join("eng"))
            .env("AH_ENGINE_PLUGIN_ROOT", plugin())
            .env("AH_ENGINE_NOSPAWN", "1")
            .env("MCP_REAP_GRACE", "0");
        for (k, v) in env {
            c.env(k, v);
        }
        let o = c.output().unwrap();
        let out = String::from_utf8_lossy(&o.stdout);
        serde_json::from_str(out.trim()).unwrap_or_else(|e| panic!("no JSON ({e}): {out:?} / {:?}", String::from_utf8_lossy(&o.stderr)))
    }

    fn log(&self) -> String {
        std::fs::read_to_string(self.home().join(".anti-hall/mcp-reaper.log")).unwrap_or_default()
    }

    /// The exit signal of victim `pid` once it ended, or `None` while it still runs.
    fn ended_by(&mut self, pid: u32) -> Option<i32> {
        let k = self.kids.iter_mut().find(|k| k.id() == pid).unwrap();
        for _ in 0..200 {
            if let Some(st) = k.try_wait().unwrap() {
                return st.signal();
            }
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        None
    }
}

#[test]
fn a_dry_run_logs_what_it_would_reap_and_signals_nothing() {
    let mut w = World::new("dry");
    let a = w.victim();
    w.listing(&[(1, 0, "/sbin/launchd".into()), (a, 1, "node mcp-server-everything".into())]);
    for (args, env) in
        [(vec!["run", "--dry-run"], vec![("ANTIHALL_MCP_REAPER_JOB", "on")]), (vec!["run"], vec![("ANTIHALL_MCP_REAPER_JOB", "on"), ("MCP_REAP_DRYRUN", "1")])]
    {
        let v = w.run(&args, &env);
        assert_eq!((v["ran"].clone(), v["dryRun"].clone()), (Value::Bool(true), Value::Bool(true)), "{v}");
        assert!(v["termed"].as_array().unwrap().is_empty());
    }
    assert_eq!(w.ended_by(a), None, "still running");
    assert_eq!(w.log().matches(&format!("DRYRUN would reap pid={a} ppid=1 cmd=node mcp-server-everything")).count(), 2);
}

#[test]
fn the_switch_the_opt_in_and_an_installed_node_unit_decide_whether_it_runs() {
    let mut w = World::new("switch");
    let a = w.victim();
    w.listing(&[(1, 0, "/sbin/launchd".into()), (a, 1, "node mcp-server-everything".into())]);
    assert_eq!(w.run(&["run"], &[("ANTIHALL_MCP_REAPER_JOB", "off")])["reason"], "off");
    assert_eq!(w.run(&["run"], &[])["reason"], "not-opted-in", "auto without the carried-over opt-in");
    let la = w.home().join("Library/LaunchAgents");
    std::fs::create_dir_all(&la).unwrap();
    std::fs::write(la.join("com.anti-hall.mcp-reaper.plist"), "x").unwrap();
    let v = w.run(&["run"], &[("ANTIHALL_MCP_REAPER_JOB", "on")]);
    assert_eq!(v["reason"], "node-unit-installed", "the Node reaper still runs: the job stands down ({v})");
    assert_eq!(w.ended_by(a), None);
    assert!(w.log().is_empty(), "nothing logged while it does not run");
    // the opt-in carried over and the Node unit gone: auto runs
    std::fs::remove_file(la.join("com.anti-hall.mcp-reaper.plist")).unwrap();
    let marker = w.home().join(".anti-hall/ah-engine/units/mcp-reaper.optin");
    std::fs::create_dir_all(marker.parent().unwrap()).unwrap();
    std::fs::write(&marker, "").unwrap();
    let v = w.run(&["run", "--dry-run"], &[]);
    assert_eq!(v["ran"], true, "{v}");
}

#[test]
fn no_orphan_logs_one_scan_line_and_a_bad_command_line_is_a_usage_error() {
    let w = World::new("none");
    w.listing(&[(1, 0, "/sbin/launchd".into()), (4242, 1, "/usr/bin/vim notes.txt".into())]);
    let v = w.run(&["run"], &[("ANTIHALL_MCP_REAPER_JOB", "on")]);
    assert!(v["orphans"].as_array().unwrap().is_empty(), "{v}");
    assert!(w.log().ends_with(" scan: no orphans\n"), "{}", w.log());
    let o = Command::new(BIN).args(["mcp-reaper", "sweep"]).env("AH_ENGINE_PLUGIN_ROOT", plugin()).env("HOME", w.home()).output().unwrap();
    assert_eq!(o.status.code(), Some(64));
}
