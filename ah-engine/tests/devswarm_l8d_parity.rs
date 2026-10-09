//! Parity of the DevSwarm CLI refusals and events lane l8d writes to the central log (`~/.anti-hall/logs/devswarm.jsonl`): `ah-engine mesh <argv>`
//! (mesh.engine_writes = on) against the real `node scripts/devswarm.js <argv>`.
//!
//! Every case runs Node and the engine on identical copies of one seeded home (the D45 fixture) with the same pinned clock, and
//! compares the exact stdout, the exit code, the whole home tree and every table of the project's store. A case the engine must
//! hand to Node is run a third time with no Node on the PATH: it must exit 75, print nothing and write nothing. The background
//! Node witness of each answered call is checked at the end: it must have logged a match.
//!
//! THE LOG MASK. Each log line carries the writer's `pid` and a wall-clock `ts` (`new Date().toISOString()`, which the pinned
//! `Date.now` does not reach). The engine is a different process, so its pid differs from Node's by design, and the two writes
//! happen at different instants. [`mask_log`] blanks exactly those two fields on both sides (the same patterns as the plugin's
//! `devswarm_cli.log_masks`, which the Node witness applies); every other byte of the line, and the number of lines, must be equal.
#![allow(clippy::unwrap_used, clippy::expect_used)] // a test crate: a panic is the failure report, and E2 exempts tests
use serde_json::Value;
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

#[path = "mesh_write_support/fx.rs"]
mod fx;
use fx::*;

const NOW: i64 = 1_795_000_000_000;

/// The Node program the engine's witness uses (pins the clock, loads devswarm.js as the main module).
const SNIPPET: &str = "const c=process.argv[1],n=Number(process.argv[2]);Date.now=()=>n;process.argv=[process.argv[0],c].concat(process.argv.slice(3));require('module')._load(c,null,true);";

type Setup = Box<dyn Fn(&Path)>;

struct Lc {
    name: String,
    argv: Vec<String>,
    /// `child` (the registered child worktree), `main` (the Primary checkout), `rc` (the ready-check repository), `other`, `nongit`.
    cwd: &'static str,
    setup: Setup,
    env: Vec<(String, String)>,
    native: bool,
    label: &'static str,
}

fn lc(name: &str, argv: &[&str], cwd: &'static str, native: bool, label: &'static str) -> Lc {
    Lc { name: name.into(), argv: argv.iter().map(|s| (*s).into()).collect(), cwd, setup: Box::new(|_| {}), env: vec![], native, label }
}

impl Lc {
    fn env(mut self, k: &str, v: &str) -> Lc {
        self.env.push((k.into(), v.into()));
        self
    }
    fn setup(mut self, f: impl Fn(&Path) + 'static) -> Lc {
        self.setup = Box::new(f);
        self
    }
}

fn put(h: &Path, rel: &str, text: &str) {
    let p = h.join(rel);
    fs::create_dir_all(p.parent().unwrap()).unwrap();
    fs::write(p, text).unwrap();
}

fn tools_path(root: &Path, with_node: bool) -> String {
    let bin = root.join(if with_node { "tools-bin" } else { "nonode-bin" });
    fs::create_dir_all(&bin).unwrap();
    let list: &[&str] = if with_node { &["node", "git", "ps"] } else { &["git", "ps"] };
    for t in list {
        let out = Command::new("sh").args(["-c", &format!("command -v {t}")]).output().unwrap();
        let src = String::from_utf8_lossy(&out.stdout).trim().to_string();
        std::os::unix::fs::symlink(&src, bin.join(t)).ok();
    }
    bin.display().to_string()
}

fn node_cli(home: &Path, cwd: &Path, argv: &[String], now: i64, env: &[(&str, &str)]) -> Run {
    let cli = plugin_root().join("scripts").join("devswarm.js");
    let mut c = Command::new("node");
    c.arg("-e").arg(SNIPPET).arg(&cli).arg(now.to_string()).args(argv).current_dir(cwd).env_clear().envs(base_env(home, &home.join("state"), env));
    let o = run(&mut c, None);
    Run { code: o.status.code().unwrap_or(-1), stdout: String::from_utf8_lossy(&o.stdout).into_owned() }
}

fn engine_cli(home: &Path, cwd: &Path, argv: &[String], now: i64, env: &[(&str, &str)]) -> Run {
    let mut c = Command::new(BIN);
    c.arg("mesh").args(argv).current_dir(cwd).env_clear().envs(base_env(home, &home.join("state"), env)).env("AH_ENGINE_MESH_NOW_MS", now.to_string());
    let o = run(&mut c, None);
    if std::env::var("AH_L8D_DEBUG").is_ok() || o.status.code() == Some(70) {
        eprintln!("engine {argv:?} -> {:?} stderr: {}", o.status.code(), String::from_utf8_lossy(&o.stderr));
        eprintln!("log: {}", fs::read_to_string(home.join("state/mesh-shadow.jsonl")).unwrap_or_default());
    }
    Run { code: o.status.code().unwrap_or(-1), stdout: String::from_utf8_lossy(&o.stdout).into_owned() }
}

/// Blank the writer's pid and the wall-clock timestamp of every central-log line (see the module doc).
fn mask_log(text: &str) -> String {
    let ts = regex::Regex::new(r#"(?m)^\{"ts":"[^"]*""#).unwrap();
    let pid = regex::Regex::new(r#""pid":[0-9]+,"msg""#).unwrap();
    pid.replace_all(&ts.replace_all(text, r#"{"ts":"T""#), r#""pid":0,"msg""#).into_owned()
}

fn tree(home: &Path) -> BTreeMap<String, String> {
    home_files(home)
        .into_iter()
        .map(|(k, v)| {
            let text = String::from_utf8_lossy(&v).replace(home.to_string_lossy().as_ref(), "<HOME>");
            let text = if k.contains("devswarm.jsonl") && !k.ends_with(".lock") { mask_log(&text) } else { text };
            (k, text)
        })
        .collect()
}

fn verify_lines(state: &Path) -> Vec<Value> {
    fs::read_to_string(state.join("mesh-verify.jsonl")).unwrap_or_default().lines().filter_map(|l| serde_json::from_str(l).ok()).collect()
}

fn to_ref(e: &[(String, String)]) -> Vec<(&str, &str)> {
    e.iter().map(|(k, v)| (k.as_str(), v.as_str())).collect()
}

/// The shared run: every case against Node, the engine, and the engine with no Node.
fn check(fx: &Fx, cases: &[Lc], extra_dirs: &[(&str, PathBuf)], min_native: usize, min_deferred: usize) {
    check_from(fx, cases, extra_dirs, &fx.seed_home, None, NOW, min_native, min_deferred);
}

/// [`check`] over another seed home (only `only_dirs` of it are copied) and clock base.
#[allow(clippy::too_many_arguments)]
fn check_from(
    fx: &Fx,
    cases: &[Lc],
    extra_dirs: &[(&str, PathBuf)],
    seed: &Path,
    only_dirs: Option<&[&str]>,
    now_base: i64,
    min_native: usize,
    min_deferred: usize,
) {
    let other = fx.root.join("repo-other");
    fs::create_dir_all(&other).unwrap();
    git(&["init", "-q"], &other);
    git(&["commit", "-q", "--allow-empty", "-m", "init"], &other);
    let other = real(&other);
    let nongit = fx.root.join("not-a-repo");
    fs::create_dir_all(&nongit).unwrap();
    let nongit = real(&nongit);
    let tools = tools_path(&fx.root, true);
    let nonode = tools_path(&fx.root, false);
    let key_db = |h: &Path| h.join(".anti-hall/devswarm/store").join(&fx.repo_key).join("devswarm.db");
    let (mut native, mut deferred) = (0, 0);
    let mut pending: Vec<(String, PathBuf)> = Vec::new();
    for (i, c) in cases.iter().enumerate() {
        if std::env::var("AH_L8D_FILTER").is_ok_and(|f| !c.name.contains(&f)) {
            continue;
        }
        let now = now_base + i as i64 % 50;
        let cwd = match c.cwd {
            "child" => fx.child.clone(),
            "main" => fx.main.clone(),
            "other" => other.clone(),
            "nongit" => nongit.clone(),
            k => extra_dirs.iter().find(|(n, _)| *n == k).unwrap().1.clone(),
        };
        let homes: Vec<PathBuf> = ["node", "engine", "defer"].iter().map(|k| fx.root.join(format!("c{i}-{k}"))).collect();
        for h in &homes {
            match only_dirs {
                None => copy_tree(seed, h),
                Some(ds) => {
                    for d in ds {
                        if seed.join(d).exists() {
                            copy_tree(&seed.join(d), &h.join(d));
                        }
                    }
                }
            }
            fs::create_dir_all(h.join(".anti-hall")).unwrap();
            fs::write(h.join(".anti-hall/settings.json"), "{\"mesh\":{\"engine_writes\":\"on\"}}\n").unwrap();
            (c.setup)(h);
        }
        let env_of = |h: &Path| -> Vec<(String, String)> { c.env.iter().map(|(k, v)| (k.clone(), v.replace("{HOME}", &h.to_string_lossy()))).collect() };
        let run_env = |h: &Path, path: &str| -> Vec<(String, String)> {
            let mut e = env_of(h);
            e.push(("PATH".into(), path.into()));
            e
        };
        let refs = |e: &[(String, String)]| -> Vec<(String, String)> { e.to_vec() };
        let (en, ee, ed) = (refs(&run_env(&homes[0], &tools)), refs(&run_env(&homes[1], &tools)), refs(&run_env(&homes[2], &nonode)));
        let n = node_cli(&homes[0], &cwd, &c.argv, now, &to_ref(&en));
        let e = engine_cli(&homes[1], &cwd, &c.argv, now, &to_ref(&ee));
        let log = last_log(&homes[1].join("state"));
        assert_eq!(
            log["result"] == "native",
            c.native,
            "{}: expected native={} but the engine logged {log} (engine exit {} stdout {:?}; node exit {} stdout {:?})",
            c.name,
            c.native,
            e.code,
            e.stdout,
            n.code,
            n.stdout
        );
        if c.native {
            native += 1;
            assert_eq!(log["verb"], c.label, "{}: telemetry names the verb", c.name);
            let (es, ns) = (e.stdout.replace(homes[1].to_string_lossy().as_ref(), "<HOME>"), n.stdout.replace(homes[0].to_string_lossy().as_ref(), "<HOME>"));
            assert_eq!((e.code, &es), (n.code, &ns), "{}: stdout/exit differ\n engine: {es:?}\n node:   {ns:?}", c.name);
            let (te, tn) = (tree(&homes[1]), tree(&homes[0]));
            for k in te.keys().chain(tn.keys()) {
                assert!(te.get(k) == tn.get(k), "{}: the home tree differs at {k}:\n engine: {:?}\n node:   {:?}", c.name, te.get(k), tn.get(k));
            }
            if key_db(&homes[0]).is_file() {
                let (de, dn) = (raw_dump(&key_db(&homes[1])), raw_dump(&key_db(&homes[0])));
                assert!(de == dn, "{}: the store differs: {}", c.name, first_diff(&dn, &de));
            }
            pending.push((c.name.clone(), homes[1].join("state")));
        } else {
            deferred += 1;
            assert_eq!(e.code, n.code, "{}: exit code of the fallback", c.name);
            let pre = (tree(&homes[2]), key_db(&homes[2]).is_file().then(|| raw_dump(&key_db(&homes[2]))));
            let d = engine_cli(&homes[2], &cwd, &c.argv, now, &to_ref(&ed));
            assert_eq!(d.code, 75, "{}: a deferral the engine cannot hand to Node exits 75, got {} / {}", c.name, d.code, d.stdout);
            assert!(d.stdout.is_empty(), "{}: nothing is printed on a deferral: {}", c.name, d.stdout);
            assert_eq!(last_log(&homes[2].join("state"))["result"], "defer", "{}", c.name);
            let post = (tree(&homes[2]), key_db(&homes[2]).is_file().then(|| raw_dump(&key_db(&homes[2]))));
            assert!(pre == post, "{}: a deferral wrote", c.name);
        }
    }
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(120);
    for (name, state) in &pending {
        let line = loop {
            if let Some(l) = verify_lines(state).into_iter().last() {
                break l;
            }
            assert!(std::time::Instant::now() < deadline, "{name}: the Node witness never logged");
            std::thread::sleep(std::time::Duration::from_millis(100));
        };
        assert_eq!(line["result"], "match", "{name}: the background Node witness disagrees: {line}");
    }
    eprintln!("l8d cli parity: {} cases, {native} answered by the engine and identical to Node, {deferred} deferred with nothing written", cases.len());
    if std::env::var("AH_L8D_FILTER").is_err() {
        assert!(native >= min_native && deferred >= min_deferred, "{native} native, {deferred} deferred");
    }
}

// ---- read-primary windows ------------------------------------------------------------------------------------------------

fn put_log_line(h: &Path, line: &str) {
    put(h, ".anti-hall/logs/devswarm.jsonl", line);
}

#[test]
fn read_primary_windows_match_node() {
    if !node_sqlite_available() {
        eprintln!("SKIPPED: Node with node:sqlite is not available, so there is no Node to compare with");
        return;
    }
    let fx = fixture("l8dwin");
    let rp = |name: &str, argv: &[&str], cwd: &'static str, native: bool| lc(name, argv, cwd, native, "InboxReadPrimary");
    let seeded = |h: &Path| put_log_line(h, "{\"ts\":\"2026-01-01T00:00:00.000Z\",\"component\":\"seed\",\"op\":\"x\",\"level\":\"info\",\"repoKey\":null,\"meshId\":null,\"pid\":1,\"msg\":\"earlier\"}\n");
    let cases = vec![
        rp("win-tail", &["inbox", "read-primary", "child-1", "--tail", "5"], "child", true),
        rp("win-since-index", &["inbox", "read-primary", "child-1", "--since", "3"], "child", true),
        rp("win-since-date", &["inbox", "read-primary", "child-1", "--since", "2026-01-01T00:00:00Z"], "child", true),
        rp("win-both", &["inbox", "read-primary", "child-1", "--since", "3", "--tail", "2"], "child", true),
        rp("win-equals-form", &["inbox", "read-primary", "child-1", "--tail=2"], "child", true),
        rp("win-empty-value", &["inbox", "read-primary", "child-1", "--tail="], "child", true),
        rp("win-text-format", &["inbox", "read-primary", "child-1", "--tail", "2", "--format", "text"], "child", true),
        rp("win-text-format-equals", &["inbox", "read-primary", "child-1", "--since", "1", "--format=text"], "child", true),
        rp("win-text-format-but-json", &["inbox", "read-primary", "child-1", "--tail", "2", "--format", "text", "--json"], "child", true),
        rp("win-other-format", &["inbox", "read-primary", "child-1", "--tail", "2", "--format", "json"], "child", true),
        rp("win-limit-too", &["inbox", "read-primary", "child-1", "--tail", "2", "--limit", "3"], "child", true),
        rp("win-from-the-primary-checkout", &["inbox", "read-primary", "child-1", "--tail", "5"], "main", true),
        rp("win-outside-a-project", &["inbox", "read-primary", "child-1", "--tail", "5"], "nongit", true),
        rp("win-in-another-repository", &["inbox", "read-primary", "child-1", "--tail", "5"], "other", true),
        rp("win-unknown-id", &["inbox", "read-primary", "nope", "--tail", "5"], "child", true),
        rp("win-appends-to-an-existing-log", &["inbox", "read-primary", "child-1", "--tail", "5"], "child", true).setup(seeded),
        rp("win-log-dir-from-the-environment", &["inbox", "read-primary", "child-1", "--tail", "5"], "child", true).env("ANTI_HALL_LOG_DIR", "{HOME}/elsewhere"),
        rp("win-node-test-context-is-node", &["inbox", "read-primary", "child-1", "--tail", "5"], "child", false).env("NODE_TEST_CONTEXT", "child-v8"),
        rp("win-bare-flag-reads-normally-so-is-node", &["inbox", "read-primary", "child-1", "--tail"], "child", false),
        rp("win-unsafe-id-is-node", &["inbox", "read-primary", "a/b", "--tail", "5"], "child", false),
    ];
    check(&fx, &cases, &[], 15, 3);
}

// ---- interleaved appends -------------------------------------------------------------------------------------------------

/// Engine and Node refusals racing into ONE log (the same file, the same rotate lock): every line is a whole JSON object, none
/// is lost, and a log that fills up mid-race rotates exactly once into `.1` with nothing torn.
#[test]
fn engine_and_node_appends_interleave_without_corrupting_a_line() {
    if !node_sqlite_available() {
        eprintln!("SKIPPED: Node with node:sqlite is not available, so there is no Node to compare with");
        return;
    }
    let fx = fixture("l8dmix");
    let tools = tools_path(&fx.root, true);
    let argv: Vec<String> = ["inbox", "read-primary", "child-1", "--tail", "5"].iter().map(|s| (*s).to_string()).collect();
    for (round, fill_to_the_bound) in [(0, false), (1, true)] {
        let home = fx.root.join(format!("mix-{round}"));
        copy_tree(&fx.seed_home, &home);
        fs::create_dir_all(home.join(".anti-hall")).unwrap();
        fs::write(home.join(".anti-hall/settings.json"), "{\"mesh\":{\"engine_writes\":\"on\"}}\n").unwrap();
        let log = home.join(".anti-hall/logs/devswarm.jsonl");
        if fill_to_the_bound {
            // a first line that leaves room for only a couple of refusals before the 5 MiB bound
            let pad = "p".repeat(5 * 1024 * 1024 - 1500);
            put(&home, ".anti-hall/logs/devswarm.jsonl", &format!("{{\"ts\":\"seed\",\"pid\":0,\"msg\":\"{pad}\"}}\n"));
        }
        let per_side = 8;
        let mut threads = Vec::new();
        for i in 0..per_side * 2 {
            let (home, cwd, argv, tools) = (home.clone(), fx.child.clone(), argv.clone(), tools.clone());
            threads.push(std::thread::spawn(move || {
                let env = [("PATH", tools.as_str())];
                let r = if i % 2 == 0 { engine_cli(&home, &cwd, &argv, NOW, &env) } else { node_cli(&home, &cwd, &argv, NOW, &env) };
                assert_eq!(r.code, 2, "a refusal exits 2 (writer {i})");
            }));
        }
        for t in threads {
            t.join().unwrap();
        }
        let mut lines: Vec<String> = Vec::new();
        for f in [home.join(".anti-hall/logs/devswarm.jsonl.1"), log.clone()] {
            lines.extend(fs::read_to_string(f).unwrap_or_default().lines().map(str::to_string));
        }
        let mut pids = std::collections::BTreeSet::new();
        let mut refusals = 0;
        for l in &lines {
            let v: Value = serde_json::from_str(l).unwrap_or_else(|e| panic!("round {round}: a torn or corrupt line ({e}): {}", &l[..l.len().min(200)]));
            if v["op"] == "inbox-read-primary" {
                refusals += 1;
                pids.insert(v["pid"].as_u64().unwrap());
            }
        }
        assert_eq!(refusals, per_side * 2, "round {round}: every refusal is in the log exactly once");
        assert_eq!(pids.len(), per_side * 2, "round {round}: each writer left its own pid");
        if fill_to_the_bound {
            assert!(home.join(".anti-hall/logs/devswarm.jsonl.1").is_file(), "the full log rotated");
            assert_eq!(lines.iter().filter(|l| l.contains("\"ts\":\"seed\"")).count(), 1, "the seed line survived the rotation");
        }
        assert!(!home.join(".anti-hall/logs/devswarm.jsonl.rotate.lock").exists(), "round {round}: the rotate lock is released");
    }
}
