//! `ah-engine mcp-reaper run`, the standalone MCP reaper as an engine job (port of companion/mcp-reaper.js), end to end: the real
//! binary and plugin script in a scratch HOME, with a process listing served by a stand-in `ps` on PATH. Every process the listing
//! selects is a `sleep` this test started (so a signal can only reach the test's own children); the other rows carry pids that are
//! never selected. The selection is compared with the Node companion's own `findOrphans` on the same listing.
#![allow(clippy::unwrap_used, clippy::expect_used)] // a test crate: a panic is the failure report, and E2 exempts tests
use serde_json::Value;
use std::collections::BTreeSet;
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

fn pids(v: &Value, field: &str) -> BTreeSet<u64> {
    v[field].as_array().unwrap().iter().map(|r| r["pid"].as_u64().unwrap()).collect()
}

/// The Node companion's selection on the same listing: `findOrphans(parsePs(text), null, <exclude as its buildExtraRe builds it>)`.
fn node_selection(listing: &str, exclude: &str) -> BTreeSet<u64> {
    let js = "const m=require(process.argv[1]);const o=m.findOrphans(m.parsePs(process.argv[2]),null,process.argv[3]?new RegExp(process.argv[3],'i'):null);process.stdout.write(JSON.stringify(o.map(p=>p.pid)));";
    let out = Command::new("node").args(["-e", js]).arg(plugin().join("companion/mcp-reaper.js")).arg(listing).arg(exclude).output().expect("node");
    serde_json::from_slice::<Vec<u64>>(&out.stdout).expect("node selection").into_iter().collect()
}

#[test]
fn the_job_reaps_exactly_what_the_node_companion_selects_politely_then_forced() {
    let mut w = World::new("sel");
    let (a, b, c, d, e, f, g, h) = (w.victim(), w.victim(), w.victim(), w.victim(), w.victim(), w.victim(), w.victim(), w.victim());
    let rows = vec![
        (1, 0, "/sbin/launchd".to_string()),
        (a, 1, "node /x/node_modules/.bin/mcp-server-fetch".to_string()),
        (77_001, 1, "/sbin/launchd".to_string()),
        (b, 77_001, "npx -y @modelcontextprotocol/server-filesystem /tmp".to_string()),
        (88_001, 1, "/usr/bin/node /app/init.js".to_string()),
        (c, 88_001, "uvx mcp-server-git --repository /work".to_string()),
        (d, 99_001, "node mcp-server.js".to_string()),
        (e, 1, "vim mcp-server.js".to_string()),
        (f, 1, "node /x/node_modules/playwright-mcp/cli.js".to_string()),
        (66_001, 1, "/usr/lib/systemd/systemd --user".to_string()),
        (g, 66_001, "node /opt/chrome-devtools-mcp/index.js".to_string()),
        (55_001, 1, "Relay(55)".to_string()),
        (h, 55_001, "python3 -m mcp_server_time".to_string()),
    ];
    let listing = w.listing(&rows);
    let env = [("ANTIHALL_MCP_REAPER_JOB", "on"), ("ANTIHALL_REAPER_EXCLUDE", "playwright")];
    let v = w.run(&["run"], &env);
    assert_eq!(v["ran"], true, "{v}");
    let want: BTreeSet<u64> = [a, b, g, h].into_iter().map(u64::from).collect();
    assert_eq!(pids(&v, "orphans"), want, "{v}");
    assert_eq!(pids(&v, "orphans"), node_selection(&listing, "playwright"), "the engine selects what the Node companion selects");
    assert_eq!(pids(&v, "termed"), want);
    assert_eq!(pids(&v, "killed"), want, "the fresh listing still selects them (the stand-in lists the same rows)");
    for p in [a, b, g, h] {
        assert_eq!(w.ended_by(p), Some(libc::SIGTERM), "{p} got the polite signal first");
    }
    for p in [c, d, e, f] {
        assert_eq!(w.kids.iter_mut().find(|k| k.id() == p).unwrap().try_wait().unwrap(), None, "{p} is not an orphan and still runs");
    }
    let log = w.log();
    assert!(log.contains(&format!(" SIGTERM pid={a} ppid=1 cmd=node /x/node_modules/.bin/mcp-server-fetch\n")), "{log}");
    assert!(log.contains(&format!(" SIGKILL pid={a} cmd=node /x/node_modules/.bin/mcp-server-fetch\n")), "{log}");
    assert!(log.lines().all(|l| l.split(' ').next().is_some_and(|ts| ts.ends_with('Z') && ts.contains('T'))), "ISO time first: {log}");
}

#[test]
fn a_dry_run_logs_what_it_would_reap_and_signals_nothing() {
    let mut w = World::new("dry");
    let a = w.victim();
    w.listing(&[(1, 0, "/sbin/launchd".into()), (a, 1, "node mcp-server-everything".into())]);
    for (args, env) in [(vec!["run", "--dry-run"], vec![("ANTIHALL_MCP_REAPER_JOB", "on")]), (vec!["run"], vec![("ANTIHALL_MCP_REAPER_JOB", "on"), ("MCP_REAP_DRYRUN", "1")])] {
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
