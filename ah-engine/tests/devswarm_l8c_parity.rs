//! Parity of the DevSwarm CLI verbs of lane l8c (`done`, `primary`, `relay`, `archive-request`, `nudge`, `supervision-report`, `sync-ui`, `retention`): `ah-engine mesh <argv>` (mesh.engine_writes = on) against the
//! real `node scripts/devswarm.js <argv>`.
//!
//! Every case runs Node and the engine on identical copies of one seeded home (the D45 fixture: a real git repo with a linked
//! child worktree and a store written by Node's own code) with the same pinned clock, and compares the exact stdout, the exit
//! code, the whole home tree and every table of the project's store. A case the engine must hand to Node is run a third time with
//! no Node on the PATH: it must exit 75, print nothing and write nothing. The background Node witness of each answered call is
//! checked at the end: it must have logged a match.
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
    if std::env::var("AH_L8C_DEBUG").is_ok() || o.status.code() == Some(70) {
        eprintln!("engine {argv:?} -> {:?} stderr: {}", o.status.code(), String::from_utf8_lossy(&o.stderr));
        eprintln!("log: {}", fs::read_to_string(home.join("state/mesh-shadow.jsonl")).unwrap_or_default());
    }
    Run { code: o.status.code().unwrap_or(-1), stdout: String::from_utf8_lossy(&o.stdout).into_owned() }
}

fn tree(home: &Path) -> BTreeMap<String, String> {
    home_files(home).into_iter().map(|(k, v)| (k, String::from_utf8_lossy(&v).replace(home.to_string_lossy().as_ref(), "<HOME>"))).collect()
}

fn verify_lines(state: &Path) -> Vec<Value> {
    fs::read_to_string(state.join("mesh-verify.jsonl")).unwrap_or_default().lines().filter_map(|l| serde_json::from_str(l).ok()).collect()
}

fn to_ref(e: &[(String, String)]) -> Vec<(&str, &str)> {
    e.iter().map(|(k, v)| (k.as_str(), v.as_str())).collect()
}

fn gitout(args: &[&str], cwd: &Path) -> String {
    let o = Command::new("git")
        .args(["-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false"])
        .args(args)
        .current_dir(cwd)
        .env_remove("GIT_DIR")
        .env_remove("GIT_WORK_TREE")
        .output()
        .unwrap();
    assert!(o.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&o.stderr));
    String::from_utf8_lossy(&o.stdout).trim().to_string()
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
        if std::env::var("AH_L8C_FILTER").is_ok_and(|f| !c.name.contains(&f)) {
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
    eprintln!("l8c cli parity: {} cases, {native} answered by the engine and identical to Node, {deferred} deferred with nothing written", cases.len());
    if std::env::var("AH_L8C_FILTER").is_err() {
        assert!(native >= min_native && deferred >= min_deferred, "{native} native, {deferred} deferred");
    }
}

// ---- done ----------------------------------------------------------------------------------------------------------------

/// Run Node's own verb in a case's home before the case (a state the case starts from).
fn node_first(h: &Path, cwd: &Path, argv: &[&str], now: i64) {
    let a: Vec<String> = argv.iter().map(|x| (*x).into()).collect();
    let r = node_cli(h, cwd, &a, now, &[]);
    assert_eq!(r.code, 0, "setup {argv:?}: {}", r.stdout);
}

fn done_cases(fx: &Fx) -> Vec<Lc> {
    let child = fx.child.clone();
    let main = fx.main.clone();
    let d = |name: &str, argv: &[&str], native: bool| lc(name, argv, "child", native, "Done");
    let with_plan = {
        let c = child.clone();
        move |h: &Path| node_first(h, &c, &["plan", "set", "child-1", "--steps", "1. first\n2. second\n3. third"], NOW - 100)
    };
    let twice = {
        let c = child.clone();
        move |h: &Path| node_first(h, &c, &["done"], NOW - 100)
    };
    let _ = main;
    vec![
        d("done-plain", &["done"], true),
        d("done-with-summary", &["done", "--summary", "merged and tested"], true),
        d("done-bare-summary", &["done", "--summary"], true),
        d("done-own-id", &["done", "child-1"], true),
        d("done-own-mesh-label", &["done", &fx.child_mesh], true),
        d("done-twice-is-a-duplicate", &["done"], true).setup(twice),
        d("done-closes-a-plan", &["done"], true).setup(with_plan.clone()),
        d("done-closes-a-plan-with-a-summary", &["done", "--summary", "all steps"], true).setup(with_plan),
        d("done-someone-elses-id", &["done", "child-2"], false),
        d("done-unknown-id", &["done", "nope"], false),
        lc("done-from-the-primary-checkout", &["done"], "main", false, "Done"),
        lc("done-outside-a-project", &["done"], "nongit", false, "Done"),
        lc("done-outside-a-repository-other", &["done"], "other", false, "Done"),
    ]
}

#[test]
fn done_matches_node() {
    if !node_sqlite_available() {
        eprintln!("SKIPPED: Node with node:sqlite is not available, so there is no Node to compare with");
        return;
    }
    let fx = fixture("l8cdone");
    let cases = done_cases(&fx);
    check(&fx, &cases, &[], 8, 5);
}

// ---- primary -------------------------------------------------------------------------------------------------------------

#[test]
fn primary_matches_node() {
    if !node_sqlite_available() {
        eprintln!("SKIPPED: Node with node:sqlite is not available, so there is no Node to compare with");
        return;
    }
    let fx = fixture("l8cprimary");
    let p = |name: &str, argv: &[&str], cwd: &'static str, native: bool| lc(name, argv, cwd, native, "Primary");
    let cases = vec![
        p("primary-status-in-a-child", &["primary"], "child", true),
        p("primary-status-word", &["primary", "status"], "child", true),
        p("primary-status-with-a-session-flag", &["primary", "status", "--session", "sess-x"], "child", true),
        p("primary-status-with-a-session-env", &["primary", "status"], "child", true).env("CLAUDE_CODE_SESSION_ID", "sess-env"),
        p("primary-status-outside-a-repository", &["primary", "status"], "nongit", true),
        p("primary-status-in-another-repository-main", &["primary", "status"], "other", false),
        p("primary-takeover-in-a-child", &["primary", "takeover"], "child", true),
        p("primary-takeover-outside-a-repository", &["primary", "takeover", "--session", "s"], "nongit", true),
        p("primary-unknown-sub", &["primary", "frobnicate"], "child", true),
        p("primary-empty-sub", &["primary", ""], "child", true),
        p("primary-status-in-the-primary-checkout", &["primary", "status"], "main", false),
        p("primary-takeover-in-the-primary-checkout", &["primary", "takeover", "--session", "s"], "main", false),
    ];
    check(&fx, &cases, &[], 8, 3);
}

// ---- relay ---------------------------------------------------------------------------------------------------------------

#[test]
fn relay_matches_node() {
    if !node_sqlite_available() {
        eprintln!("SKIPPED: Node with node:sqlite is not available, so there is no Node to compare with");
        return;
    }
    let fx = fixture("l8crelay");
    let note = fx.root.join("note.txt");
    fs::write(&note, "please look at this\nthanks \u{e9}\n").unwrap();
    let empty_note = fx.root.join("empty-note.txt");
    fs::write(&empty_note, "").unwrap();
    let note_s = note.to_string_lossy().to_string();
    let empty_s = empty_note.to_string_lossy().to_string();
    let missing_s = fx.root.join("no-such-note.txt").to_string_lossy().to_string();
    let primary = fx.primary_id.clone();
    let r = |name: &str, argv: &[&str], cwd: &'static str, native: bool| lc(name, argv, cwd, native, "Relay");
    let cases = vec![
        r("relay-to-a-child", &["relay", "1", "--to", "child-2"], "child", true),
        r("relay-the-newest", &["relay", "12", "--to", "child-2"], "child", true),
        r("relay-from-the-primary", &["relay", "2", "--to", "child-2"], "main", true),
        r("relay-with-a-note", &["relay", "1", "--to", "child-2", "--note-file", &note_s], "child", true),
        r("relay-with-an-empty-note", &["relay", "1", "--to", "child-2", "--note-file", &empty_s], "child", true),
        r("relay-seq-as-a-float-is-floored", &["relay", "1.9", "--to", "child-2"], "child", true),
        r("relay-a-primary-message-to-a-child", &["relay", "7", "--to", "child-1"], "main", true),
        r("relay-to-the-primary-id-is-node", &["relay", "1", "--to", &primary], "child", false),
        r("relay-an-unreadable-note", &["relay", "1", "--to", "child-2", "--note-file", &missing_s], "child", false),
        r("relay-seq-not-in-my-inbox", &["relay", "2", "--to", "child-2"], "child", false),
        r("relay-unknown-seq", &["relay", "999", "--to", "child-2"], "child", false),
        r("relay-negative-seq", &["relay", "-1", "--to", "child-2"], "child", false),
        r("relay-seq-not-a-number", &["relay", "abc", "--to", "child-2"], "child", false),
        r("relay-a-receipt-is-node", &["relay", "r123abc", "--to", "child-2"], "child", false),
        r("relay-no-recipient", &["relay", "1"], "child", false),
        r("relay-no-seq", &["relay", "--to", "child-2"], "child", false),
        r("relay-unregistered-recipient", &["relay", "1", "--to", "nobody"], "child", false),
        r("relay-to-myself", &["relay", "1", "--to", "child-1"], "child", false),
        r("relay-several-recipients", &["relay", "1", "--to", "child-1,child-2"], "child", false),
        r("relay-outside-a-project", &["relay", "1", "--to", "child-2"], "nongit", false),
    ];
    check(&fx, &cases, &[], 7, 8);
}

// ---- archive-request -----------------------------------------------------------------------------------------------------

#[test]
fn archive_request_matches_node() {
    if !node_sqlite_available() {
        eprintln!("SKIPPED: Node with node:sqlite is not available, so there is no Node to compare with");
        return;
    }
    let fx = fixture("l8carchreq");
    let wt = fx.child.to_string_lossy().to_string();
    let descriptor = move |h: &Path| {
        put(h, ".anti-hall/devswarm/workspaces/child-1.json", &format!("{{\"id\":\"child-1\",\"worktreePath\":\"{wt}\",\"sessionId\":\"child-1\"}}"));
    };
    let fresh = |h: &Path| put(h, ".anti-hall/devswarm/heartbeats/child-1.json", &format!("{{\"id\":\"child-1\",\"ts\":{}}}", NOW - 60_000));
    let stale = |h: &Path| put(h, ".anti-hall/devswarm/heartbeats/child-1.json", &format!("{{\"id\":\"child-1\",\"ts\":{}}}", NOW - 86_400_000));
    let d2 = descriptor.clone();
    let d3 = descriptor.clone();
    let ar = |name: &str, argv: &[&str], cwd: &'static str, native: bool| lc(name, argv, cwd, native, "ArchiveRequest");
    let cases = vec![
        ar("ar-registered-child", &["archive-request", "child-1"], "main", true),
        ar("ar-with-a-reason", &["archive-request", "child-1", "--reason", "merged to main"], "main", true),
        ar("ar-with-a-bare-reason", &["archive-request", "child-1", "--reason"], "main", true),
        ar("ar-prefix-resolves-to-one", &["archive-request", "child-2"], "main", true),
        ar("ar-ambiguous-prefix", &["archive-request", "child-"], "main", true),
        ar("ar-mesh-label-resolves", &["archive-request", &fx.child_mesh], "main", true),
        ar("ar-unknown-id-makes-an-orphan-partition-is-node", &["archive-request", "nope"], "main", false),
        ar("ar-archived-id-with-mail-is-node", &["archive-request", "child-3"], "main", false),
        ar("ar-from-a-child", &["archive-request", "child-2"], "child", true),
        ar("ar-live-target-with-a-descriptor", &["archive-request", "child-1"], "main", true).setup(move |h| {
            descriptor(h);
            fresh(h);
        }),
        ar("ar-stale-target-is-node", &["archive-request", "child-1"], "main", false).setup(move |h| {
            d2(h);
            stale(h);
        }),
        ar("ar-target-without-a-heartbeat-is-node", &["archive-request", "child-1"], "main", false).setup(d3),
        ar("ar-unsafe-id", &["archive-request", "../x"], "main", true),
        ar("ar-no-id", &["archive-request"], "main", true),
        ar("ar-outside-a-project", &["archive-request", "child-1"], "nongit", false),
    ];
    check(&fx, &cases, &[], 10, 5);
}

// ---- nudge ---------------------------------------------------------------------------------------------------------------

#[test]
fn nudge_matches_node() {
    if !node_sqlite_available() {
        eprintln!("SKIPPED: Node with node:sqlite is not available, so there is no Node to compare with");
        return;
    }
    let fx = fixture("l8cnudge");
    let wt = fx.child.to_string_lossy().to_string();
    let with_descriptor = move |h: &Path| {
        put(h, ".anti-hall/devswarm/workspaces/child-1.json", &format!("{{\"id\":\"child-1\",\"worktreePath\":\"{wt}\",\"sessionId\":\"child-1\"}}"));
    };
    let nu = |name: &str, argv: &[&str], cwd: &'static str, native: bool| lc(name, argv, cwd, native, "Nudge");
    let cases = vec![
        nu("nudge-unknown-id", &["nudge", "nobody"], "main", true),
        nu("nudge-unsafe-id", &["nudge", "../x"], "main", true),
        nu("nudge-no-id", &["nudge"], "main", true),
        nu("nudge-outside-a-project", &["nudge", "nobody"], "nongit", true),
        nu("nudge-a-registered-id-without-a-descriptor-is-node", &["nudge", "child-1"], "main", false),
        nu("nudge-a-mesh-label-is-node", &["nudge", &fx.child_mesh], "main", false),
        nu("nudge-with-a-descriptor-is-node", &["nudge", "child-1"], "main", false).setup(with_descriptor),
    ];
    check(&fx, &cases, &[], 4, 3);
}
