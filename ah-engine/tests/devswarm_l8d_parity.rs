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

/// A read receipt's id is the clock in base 36 plus 12 random hex digits: the random part differs between any two runs, so it is
/// blanked wherever it appears (stdout, file names, file contents) on both sides.
fn mask_rid(text: &str) -> String {
    regex::Regex::new(r"\b(r[0-9a-z]{8})[0-9a-f]{12}\b").unwrap().replace_all(text, "${1}<rand>").into_owned()
}

/// The cursor-write journal (`cursor-log/<repo>.ndjson`) stamps each line with the wall clock and the writer's pid, which differ
/// between the engine and Node by design: both are blanked, as in the log mask below.
fn mask_journal(text: &str) -> String {
    regex::Regex::new(r#""(ts|pid)":[0-9]+"#).unwrap().replace_all(text, r#""$1":0"#).into_owned()
}

/// A reader-cursor row's `updated_at` is the wall clock of whichever process moved it (Node's `Date.now()` is pinned in these
/// tests, the engine's clock is real): blanked on those rows only, so the registry's `updated_at` (the case's own clock) is still compared.
fn mask_dump(dump: &str) -> String {
    dump.lines()
        .map(|l| {
            if l.contains("reader=t\"") && l.contains(" ns=t\"") {
                regex::Regex::new(r"updated_at=i[0-9]+").unwrap().replace_all(l, "updated_at=<wall>").into_owned()
            } else {
                l.to_string()
            }
        })
        .collect::<Vec<_>>()
        .join("\n")
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
            let text = if k.contains("/cursor-log/") { mask_journal(&text) } else { text };
            (mask_rid(&k), mask_rid(&text))
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
            let (es, ns) = (
                mask_rid(&e.stdout.replace(homes[1].to_string_lossy().as_ref(), "<HOME>")),
                mask_rid(&n.stdout.replace(homes[0].to_string_lossy().as_ref(), "<HOME>")),
            );
            assert_eq!((e.code, &es), (n.code, &ns), "{}: stdout/exit differ\n engine: {es:?}\n node:   {ns:?}", c.name);
            let (te, tn) = (tree(&homes[1]), tree(&homes[0]));
            for k in te.keys().chain(tn.keys()) {
                assert!(te.get(k) == tn.get(k), "{}: the home tree differs at {k}:\n engine: {:?}\n node:   {:?}", c.name, te.get(k), tn.get(k));
            }
            if key_db(&homes[0]).is_file() {
                let (de, dn) = (mask_dump(&raw_dump(&key_db(&homes[1]))), mask_dump(&raw_dump(&key_db(&homes[0]))));
                assert!(de == dn, "{}: the store differs: {}", c.name, first_diff(&dn, &de));
            }
            // `send` has no background Node witness (it is checked in shadow mode); its log line is compared in the tree above
            if c.label != "Send" {
                pending.push((c.name.clone(), homes[1].join("state")));
            }
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
    let seeded = |h: &Path| {
        put_log_line(
            h,
            "{\"ts\":\"2026-01-01T00:00:00.000Z\",\"component\":\"seed\",\"op\":\"x\",\"level\":\"info\",\"repoKey\":null,\"meshId\":null,\"pid\":1,\"msg\":\"earlier\"}\n",
        )
    };
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
        rp("win-log-dir-from-the-environment", &["inbox", "read-primary", "child-1", "--tail", "5"], "child", true)
            .env("ANTI_HALL_LOG_DIR", "{HOME}/elsewhere"),
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

// ---- unclaimed-session promotion ---------------------------------------------------------------------------------------

/// Give `child-1` a descriptor (with the floor rows a read-primary needs) carrying `desc` as its session, and set the session of
/// its registry row (`None` leaves the seeded one).
fn set_sessions(h: &Path, child: &Path, repo_key: &str, desc: Option<&str>, reg: Option<&str>) {
    let mut d = serde_json::json!({"id": "child-1", "worktreePath": child.to_string_lossy()});
    if let Some(sid) = desc {
        d["sessionId"] = Value::String(sid.into());
    }
    let floor = |ns: &str| serde_json::json!({"partition": "child-1", "ns": ns, "reader": "#floor", "value": 0, "updatedAt": 1_700_000_000_000_i64});
    let spec = serde_json::json!({"rows": [floor("store"), floor("nd")], "descriptors": [d]});
    let o = Command::new("node")
        .arg(Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/mesh_write_support/ack_seed.js"))
        .arg(h)
        .arg(repo_key)
        .arg(spec.to_string())
        .env_clear()
        .env("PATH", std::env::var("PATH").unwrap())
        .env("HOME", h)
        .output()
        .unwrap();
    assert!(o.status.success(), "ack_seed: {}", String::from_utf8_lossy(&o.stderr));
    // the ackCommand names the stable launcher when one is on disk
    put(h, ".anti-hall/bin/devswarm.js", "// launcher\n");
    if let Some(sid) = reg {
        let db = h.join(".anti-hall/devswarm/store").join(repo_key).join("devswarm.db");
        let c = rusqlite::Connection::open(db).unwrap();
        c.execute("UPDATE registry SET session_id = ?1 WHERE id = 'child-1'", [sid]).unwrap();
    }
}

#[test]
fn unclaimed_session_promotion_matches_node() {
    if !node_sqlite_available() {
        eprintln!("SKIPPED: Node with node:sqlite is not available, so there is no Node to compare with");
        return;
    }
    let fx = fixture("l8dpromo");
    let rk = fx.repo_key.clone();
    let child_wt = fx.child.clone();
    let mk = |desc: Option<&'static str>, reg: Option<&'static str>| {
        let (rk, wt) = (rk.clone(), child_wt.clone());
        move |h: &Path| set_sessions(h, &wt, &rk, desc, reg)
    };
    let both = mk(Some("unclaimed:child-1"), Some("unclaimed:child-1"));
    let desc_only = mk(Some("unclaimed:child-1"), Some("sess-registry"));
    let reg_only = mk(Some("sess-descriptor"), Some("unclaimed:child-1"));
    let claimed = mk(Some("sess-a"), Some("sess-a"));
    let no_desc_session = mk(None, Some("unclaimed:child-1"));
    let rp = |name: &str, argv: &[&str], native: bool| lc(name, argv, "child", native, "InboxReadPrimary");
    fn with<'a>(extra: &[&'a str]) -> Vec<&'a str> {
        ["inbox", "read-primary", "child-1"].iter().chain(extra.iter()).copied().collect()
    }
    let cases = vec![
        rp("promo-both-sides-by-flag", &with(&["--session", "sess-real"]), true).setup(both.clone()),
        rp("promo-both-sides-by-env", &with(&[]), true).setup(both.clone()).env("CLAUDE_CODE_SESSION_ID", "sess-env"),
        rp("promo-flag-beats-env", &with(&["--session", "sess-flag"]), true).setup(both.clone()).env("CLAUDE_CODE_SESSION_ID", "sess-env"),
        rp("promo-blank-flag-falls-to-env", &with(&["--session", ""]), true).setup(both.clone()).env("CLAUDE_CODE_SESSION_ID", "sess-env"),
        rp("promo-padded-session-is-trimmed", &with(&["--session", "  sess-pad  "]), true).setup(both.clone()),
        rp("promo-text-format", &with(&["--session", "sess-real", "--format", "text"]), true).setup(both.clone()),
        rp("promo-descriptor-behind-the-registry", &with(&["--session", "sess-real"]), true).setup(desc_only),
        // the descriptor is claimed, so Node's ownership proof (the sole UNCLAIMED row of the caller's worktree) fails: Node reads on unpromoted
        rp("promo-registry-behind-a-claimed-descriptor-is-node", &with(&["--session", "sess-real"]), false).setup(reg_only.clone()),
        rp("promo-registry-behind-without-a-session", &with(&[]), false).setup(reg_only),
        rp("promo-registry-only-marker-null-descriptor", &with(&["--session", "sess-real"]), true).setup(no_desc_session),
        rp("promo-already-claimed-writes-nothing", &with(&["--session", "sess-real"]), true).setup(claimed),
        rp("promo-no-session-is-node", &with(&[]), false).setup(both.clone()),
        rp("promo-session-equal-to-the-id-is-node", &with(&["--session", "child-1"]), false).setup(both.clone()),
        rp("promo-synthetic-session-is-node", &with(&["--session", "unclaimed:other"]), false).setup(both.clone()),
        rp("promo-reconcile-sweep-is-node", &with(&["--session", "sess-real"]), false).setup(both.clone()).env("ANTIHALL_RECONCILE_SWEEP", "1"),
        rp("promo-read-of-another-row-is-node", &["inbox", "read-primary", "child-2", "--session", "sess-real"], false).setup(both.clone()),
        lc("promo-from-the-primary-checkout-is-node", &with(&["--session", "sess-real"]), "main", false, "InboxReadPrimary").setup(both),
    ];
    check(&fx, &cases, &[], 8, 7);
}

// ---- send refusals --------------------------------------------------------------------------------------------------------

#[test]
fn send_refusals_match_node() {
    if !node_sqlite_available() {
        eprintln!("SKIPPED: Node with node:sqlite is not available, so there is no Node to compare with");
        return;
    }
    let fx = fixture("l8dsend");
    let sd = |name: &str, argv: &[&str], cwd: &'static str, native: bool| lc(name, argv, cwd, native, "Send");
    let cases = vec![
        sd("send-outside-a-project", &["send", "--to", "child-1", "--message", "hi"], "nongit", true),
        sd("send-outside-a-project-quiet", &["send", "--to", "child-1", "--message", "hi", "--quiet"], "nongit", true),
        sd("send-from-someone-else", &["send", "--to", "child-2", "--message", "hi", "--from", "somebody"], "child", true),
        sd("send-without-a-target", &["send", "--message", "hi"], "child", true),
        sd("send-two-target-modes", &["send", "--to", "child-2", "--broadcast", "--message", "hi"], "child", true),
        sd("send-three-target-modes", &["send", "--to", "child-2", "--broadcast", "--to-primary", "--message", "hi"], "child", true),
        sd("send-question-on-a-broadcast", &["send", "--broadcast", "--question", "--message", "hi"], "child", true),
        sd("send-answers-on-a-broadcast", &["send", "--broadcast", "--answers", "--message", "hi"], "child", true),
        sd("send-both-on-a-broadcast-names-the-question", &["send", "--broadcast", "--answers", "--question", "--message", "hi"], "child", true),
        sd("send-two-message-sources", &["send", "--to", "child-2", "--message", "hi", "--message-file", "/no/such/file"], "child", true),
        sd("send-no-message-source", &["send", "--to", "child-2"], "child", true),
        sd("send-empty-message", &["send", "--to", "child-2", "--message", ""], "child", true),
        sd("send-unknown-urgency", &["send", "--to", "child-2", "--message", "hi", "--urgency", "asap"], "child", true),
        sd("send-unknown-urgency-quiet", &["send", "--to", "child-2", "--message", "hi", "--urgency", "asap", "--quiet"], "child", true),
        sd("send-to-itself", &["send", "--to", "child-1", "--message", "hi"], "child", true),
        sd("send-to-its-own-mesh-label", &["send", "--to", &fx.child_mesh, "--message", "hi"], "child", true),
        sd("send-to-primary-from-the-primary", &["send", "--to-primary", "--message", "hi"], "main", true),
        sd("send-refused-in-a-log-dir-of-its-own", &["send", "--message", "hi"], "child", true).env("ANTI_HALL_LOG_DIR", "{HOME}/elsewhere"),
        sd("send-refused-under-a-test-context-is-node", &["send", "--message", "hi"], "child", false).env("NODE_TEST_CONTEXT", "child-v8"),
        sd("send-unreadable-message-file-is-node", &["send", "--to", "child-2", "--message-file", "/no/such/file"], "child", false),
        sd("send-a-good-message-still-sends", &["send", "--to", "child-2", "--message", "hello"], "child", true),
    ];
    check(&fx, &cases, &[], 17, 2);
}

// ---- done refusals --------------------------------------------------------------------------------------------------------

#[test]
fn done_refusals_match_node() {
    if !node_sqlite_available() {
        eprintln!("SKIPPED: Node with node:sqlite is not available, so there is no Node to compare with");
        return;
    }
    let fx = fixture("l8ddone");
    let d = |name: &str, argv: &[&str], cwd: &'static str, native: bool| lc(name, argv, cwd, native, "Done");
    let cases = vec![
        d("done-someone-elses-id", &["done", "child-2"], "child", true),
        d("done-unknown-id", &["done", "nope"], "child", true),
        d("done-an-id-needing-json-quotes", &["done", "a\"b c\\d \u{e9}"], "child", true),
        d("done-from-the-primary-checkout", &["done"], "main", true),
        d("done-from-the-primary-checkout-naming-an-id", &["done", "child-1"], "main", true),
        d("done-outside-a-project", &["done"], "nongit", true),
        d("done-in-another-repository", &["done"], "other", true),
        d("done-refused-in-a-log-dir-of-its-own", &["done", "nope"], "child", true).env("ANTI_HALL_LOG_DIR", "{HOME}/elsewhere"),
        d("done-refused-under-a-test-context-is-node", &["done", "nope"], "child", false).env("NODE_TEST_CONTEXT", "child-v8"),
        d("done-still-reports", &["done", "--summary", "merged"], "child", true),
    ];
    check(&fx, &cases, &[], 9, 1);
}

// ---- read-primary --ack-after-print ----------------------------------------------------------------------------------------

#[test]
fn ack_after_print_matches_node() {
    if !node_sqlite_available() {
        eprintln!("SKIPPED: Node with node:sqlite is not available, so there is no Node to compare with");
        return;
    }
    let fx = fixture("l8dack");
    let (rk, wt) = (fx.repo_key.clone(), fx.child.clone());
    let claimed = {
        let (rk, wt) = (rk.clone(), wt.clone());
        move |h: &Path| set_sessions(h, &wt, &rk, Some("sess-a"), Some("sess-a"))
    };
    let marked = {
        let (rk, wt) = (rk.clone(), wt.clone());
        move |h: &Path| set_sessions(h, &wt, &rk, Some("unclaimed:child-1"), Some("unclaimed:child-1"))
    };
    // every message already behind the floor: nothing is left to read or ack
    let already_read = {
        let (claimed, rk) = (claimed.clone(), rk.clone());
        move |h: &Path| {
            claimed(h);
            let db = h.join(".anti-hall/devswarm/store").join(&rk).join("devswarm.db");
            let c = rusqlite::Connection::open(db).unwrap();
            c.execute("UPDATE reader_cursors SET value = 99 WHERE partition = 'child-1' AND ns = 'store' AND reader = '#floor'", []).unwrap();
        }
    };
    let with_ndjson = {
        let (rk, wt) = (rk.clone(), wt.clone());
        move |h: &Path| {
            set_sessions(h, &wt, &rk, Some("sess-a"), Some("sess-a"));
            let p = h.join(".anti-hall/devswarm/workspaces/child-1.json");
            let mut v: Value = serde_json::from_str(&fs::read_to_string(&p).unwrap()).unwrap();
            v["inboxPath"] = Value::String(h.join("inbox/child-1.ndjson").to_string_lossy().into());
            v["cursorPath"] = Value::String(h.join("cursors/child-1.cursor").to_string_lossy().into());
            fs::write(&p, v.to_string()).unwrap();
            put(
                h,
                "inbox/child-1.ndjson",
                "{\"fromBranch\":\"b\",\"message\":\"from the file\",\"status\":\"new\",\"createdAt\":1790000005000,\"_h\":\"hh1\"}\n",
            );
            put(h, "cursors/child-1.cursor", "0");
        }
    };
    let rp = |name: &str, extra: &[&str], cwd: &'static str, native: bool| {
        let argv: Vec<&str> = ["inbox", "read-primary", "child-1"].iter().chain(extra.iter()).copied().collect();
        lc(name, &argv, cwd, native, "InboxReadPrimary")
    };
    let cases = vec![
        rp("ack-after-print", &["--ack-after-print"], "child", true).setup(claimed.clone()),
        rp("ack-after-print-text", &["--ack-after-print", "--format", "text"], "child", true).setup(claimed.clone()),
        rp("ack-after-print-json-over-text", &["--ack-after-print", "--format", "text", "--json"], "child", true).setup(claimed.clone()),
        rp("ack-after-print-with-a-limit", &["--ack-after-print", "--limit", "5"], "child", true).setup(claimed.clone()),
        rp("ack-after-print-nothing-left", &["--ack-after-print"], "child", true).setup(already_read),
        rp("ack-after-print-with-a-promotion", &["--ack-after-print", "--session", "sess-real"], "child", true).setup(marked),
        rp("ack-after-print-as-owner-is-node", &["--ack-after-print", "--ack-as-owner"], "child", false).setup(claimed.clone()),
        rp("ack-after-print-over-an-ndjson-inbox-is-node", &["--ack-after-print"], "child", false).setup(with_ndjson),
        rp("ack-after-print-from-the-primary-checkout-is-node", &["--ack-after-print"], "main", false).setup(claimed.clone()),
        rp("ack-after-print-on-the-legacy-flag-is-node", &["--ack-after-print", "--legacy-ack-now"], "child", false).setup(claimed),
    ];
    check(&fx, &cases, &[], 6, 4);
}
