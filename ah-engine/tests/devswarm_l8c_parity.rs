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

/// The central log's lines carry the wall-clock `ts` and the writer's `pid`, which differ between the engine and Node by design
/// (see tests/devswarm_l8d_parity.rs): both are blanked on both sides.
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
            (k.clone(), if k.contains("devswarm.jsonl") && !k.ends_with(".lock") { mask_log(&text) } else { text })
        })
        .collect()
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
        // the refusals Node logs to the central log: lane l8d writes that log itself (tests/devswarm_l8d_parity.rs compares the log line)
        d("done-someone-elses-id", &["done", "child-2"], true),
        d("done-unknown-id", &["done", "nope"], true),
        lc("done-from-the-primary-checkout", &["done"], "main", true, "Done"),
        lc("done-outside-a-project", &["done"], "nongit", true, "Done"),
        lc("done-outside-a-repository-other", &["done"], "other", true, "Done"),
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
    check(&fx, &cases, &[], 13, 0);
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

// ---- supervision-report --------------------------------------------------------------------------------------------------

/// `new Date(ms).toISOString()` for the dates these tests use.
fn iso(ms: i64) -> String {
    let days = ms.div_euclid(86_400_000);
    let rem = ms.rem_euclid(86_400_000);
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    format!("{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}.{:03}Z", rem / 3_600_000, rem / 60_000 % 60, rem / 1000 % 60, rem % 1000)
}

const DAY: i64 = 86_400_000;

fn sup_row(ago_ms: i64, rest: &str) -> String {
    format!("{{\"ts\":\"{}\",{rest}}}", iso(NOW - ago_ms))
}

fn sup_log() -> String {
    let rows = vec![
        sup_row(1000, "\"type\":\"plan\",\"id\":\"ws-a\",\"source\":\"plan-set\""),
        sup_row(2000, "\"type\":\"step\",\"id\":\"ws-a\""),
        sup_row(3000, "\"type\":\"step\",\"id\":\"ws-a\""),
        sup_row(4000, "\"type\":\"warn\",\"id\":\"ws-a\",\"signal\":\"off-scope\",\"repeat\":true"),
        sup_row(5000, "\"type\":\"warn\",\"id\":\"ws-a\",\"signal\":\"burn\""),
        sup_row(6000, "\"type\":\"warn\",\"id\":\"ws-b\""),
        sup_row(
            7000,
            "\"type\":\"correction\",\"signals\":[\"burn\",\"stall\"],\"jev\":[{\"integration\":\"supervision\",\"supports\":true},{\"integration\":\"supervision\",\"supports\":false},{}]",
        ),
        sup_row(8000, "\"type\":\"correction-followed\",\"signals\":[\"burn\"],\"jev\":[{\"integration\":\"supervision\",\"supports\":true}]"),
        sup_row(9000, "\"type\":\"tokens\",\"id\":\"ws-a\",\"tokens\":1500"),
        sup_row(9500, "\"type\":\"tokens\",\"id\":\"ws-b\",\"tokens\":2500000"),
        sup_row(9800, "\"type\":\"tokens\",\"id\":\"ws-a\",\"tokens\":420"),
        sup_row(10_000, "\"type\":\"tokens\",\"tokens\":\"many\""),
        sup_row(11_000, "\"type\":\"extra\",\"id\":\"ws-a\""),
        sup_row(12_000, "\"type\":\"done\",\"id\":\"ws-a\",\"durationMs\":5400000,\"stepsDone\":3,\"stepsPlanned\":4,\"tokensTotal\":9000"),
        sup_row(13_000, "\"type\":\"done\",\"id\":\"ws-b\",\"durationMs\":900000,\"stepsDone\":2,\"stepsPlanned\":2,\"respawnOf\":\"ws-old\""),
        sup_row(14_000, "\"type\":\"respawn\",\"id\":\"ws-a\",\"parked\":true"),
        sup_row(15_000, "\"type\":\"respawn\",\"id\":\"ws-b\""),
        sup_row(16_000, "\"type\":\"respawn-aborted\",\"stage\":\"park\""),
        sup_row(17_000, "\"type\":\"respawn-progress\",\"latencyMs\":7200000"),
        sup_row(18_000, "\"type\":\"jev\",\"integration\":\"supervision\",\"mode\":\"shadow\",\"agree\":true"),
        sup_row(19_000, "\"type\":\"jev\",\"integration\":\"supervision\",\"mode\":\"on\",\"agree\":false"),
        sup_row(20_000, "\"type\":\"jev\",\"mode\":\"on\",\"agree\":true"),
        sup_row(2 * DAY + 5000, "\"type\":\"plan\",\"id\":\"ws-c\""),
        sup_row(2 * DAY + 6000, "\"type\":\"done\",\"id\":\"ws-c\",\"durationMs\":60000,\"stepsDone\":1,\"stepsPlanned\":1,\"tokensTotal\":50"),
        "not json at all".to_string(),
        String::new(),
        "42".to_string(),
        "null".to_string(),
        "{\"type\":\"plan\"}".to_string(),
        "{\"ts\":\"yesterday\",\"type\":\"plan\"}".to_string(),
        "{\"ts\":5,\"type\":\"plan\"}".to_string(),
        sup_row(500, "\"type\":\"mystery\""),
    ];
    format!("{}\n", rows.join("\n"))
}

fn rotated_log() -> String {
    let rows = vec![
        sup_row(10 * DAY, "\"type\":\"plan\",\"id\":\"ws-old\""),
        sup_row(10 * DAY + 1000, "\"type\":\"warn\",\"signal\":\"stall\""),
        sup_row(10 * DAY + 2000, "\"type\":\"tokens\",\"id\":\"ws-old\",\"tokens\":321"),
    ];
    format!("{}\n", rows.join("\n"))
}

fn rollup_file(day_ago: i64, extra: &str) -> (String, String) {
    let day = iso(NOW - day_ago * DAY)[..10].to_string();
    let body = format!(
        "{{\"complete\":true,\"v\":1,\"day\":\"{day}\",\"plans\":2,\"steps\":5,\"warnings\":{{\"off-scope\":3,\"drift\":1}},\"repeats\":1,\"corrections\":2,\"correctionsFollowed\":1,\"extras\":1,\"done\":1,\"durationsMs\":[1000,3000],\"stepsDone\":2,\"stepsPlanned\":3,\"jev\":{{\"supervision\":{{\"byMode\":{{\"on\":2}},\"n\":2,\"agree\":1,\"followed\":1,\"overridden\":1,\"progressWhenSupported\":1,\"progressWhenNotSupported\":0}}}},\"tokenPeriods\":[100,200],\"tokensByWorkspace\":{{\"ws-z\":300}},\"doneTokens\":[150],\"burnCorrections\":1,\"burnFollowed\":0,\"respawns\":1,\"respawnsParked\":1,\"respawnsAborted\":0,\"respawnProgressMs\":[60000],\"respawnsFinished\":0{extra}}}"
    );
    (format!(".anti-hall/logs/devswarm-supervision-daily/{day}.json"), body)
}

#[test]
fn supervision_report_matches_node() {
    if !node_sqlite_available() {
        eprintln!("SKIPPED: Node with node:sqlite is not available, so there is no Node to compare with");
        return;
    }
    let fx = fixture("l8csr");
    let log = |h: &Path| {
        put(h, ".anti-hall/logs/devswarm-supervision.ndjson", &sup_log());
    };
    let full = |h: &Path| {
        put(h, ".anti-hall/logs/devswarm-supervision.ndjson", &sup_log());
        put(h, ".anti-hall/logs/devswarm-supervision.ndjson.1", &rotated_log());
        let (p, b) = rollup_file(20, "");
        put(h, &p, &b);
        let (p, b) = rollup_file(40, "");
        put(h, &p, &b);
        put(h, ".anti-hall/logs/devswarm-supervision-daily/notes.txt", "x");
        put(h, ".anti-hall/logs/devswarm-supervision-daily/2026-01-01.json", "{torn");
    };
    let sr = |name: &str, argv: &[&str], native: bool| lc(name, argv, "nongit", native, "SupervisionReport");
    let cases = vec![
        sr("sr-no-log", &["supervision-report"], true),
        sr("sr-no-log-json", &["supervision-report", "--json"], true),
        sr("sr-default", &["supervision-report"], true).setup(log),
        sr("sr-json", &["supervision-report", "--json"], true).setup(log),
        sr("sr-json-equals-is-still-text", &["supervision-report", "--json=1"], true).setup(log),
        sr("sr-days-one", &["supervision-report", "--days", "1"], true).setup(log),
        sr("sr-days-fraction", &["supervision-report", "--days", "2.9", "--json"], true).setup(log),
        sr("sr-days-bare-is-seven", &["supervision-report", "--days"], true).setup(log),
        sr("sr-days-thirty-with-rollups", &["supervision-report", "--days", "30"], true).setup(full),
        sr("sr-days-thirty-with-rollups-json", &["supervision-report", "--days=30", "--json"], true).setup(full),
        sr("sr-days-sixty", &["supervision-report", "--days", "60", "--json"], true).setup(full),
        sr("sr-days-zero", &["supervision-report", "--days", "0"], true),
        sr("sr-days-negative", &["supervision-report", "--days", "-3"], true),
        sr("sr-days-words", &["supervision-report", "--days", "soon"], true),
        sr("sr-days-empty", &["supervision-report", "--days="], true),
        sr("sr-integer-like-signal-is-node", &["supervision-report"], false).setup(|h| {
            put(h, ".anti-hall/logs/devswarm-supervision.ndjson", &(sup_row(1000, "\"type\":\"warn\",\"signal\":\"123\"") + "\n"));
        }),
        sr("sr-null-rollup-is-node", &["supervision-report", "--days", "30"], false).setup(|h| {
            let (p, _) = rollup_file(3, "");
            put(h, &p, "null");
        }),
        sr("sr-string-rollup-field-is-node", &["supervision-report", "--days", "30"], false).setup(|h| {
            let (p, b) = rollup_file(3, ",\"extra\":1");
            put(h, &p, &b.replace("\"plans\":2", "\"plans\":\"2\""));
        }),
        sr("sr-odd-timestamp-is-node", &["supervision-report"], false).setup(|h| {
            put(h, ".anti-hall/logs/devswarm-supervision.ndjson", "{\"ts\":\"Tue, 06 Oct 2026 10:00:00 GMT\",\"type\":\"plan\"}\n");
        }),
    ];
    check(&fx, &cases, &[], 15, 4);
}

const CORPUS_DIRS: &[&str] = &[".anti-hall", ".claude", ".devswarm", "appdata"];

fn corpus(root: &Path, name: &str, seed: u32, now: i64) -> PathBuf {
    let home = root.join(name);
    let sup = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/it/dssup_support");
    let o = Command::new("node").arg(sup.join("as_corpus.js")).arg(&home).arg(seed.to_string()).arg(now.to_string()).arg("small").output().unwrap();
    assert!(o.status.success(), "corpus: {}", String::from_utf8_lossy(&o.stderr));
    home
}

/// Node's own sync, run once on a copy of the corpus' state, so the next sync has nothing to mark or retire.
fn settle(home: &Path, now: i64) {
    let sup = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/it/dssup_support");
    let db = home.join("appdata/DevSwarm/devswarm.db");
    let o = Command::new("node").arg(sup.join("as_reference.js")).arg(home).arg(now.to_string()).arg(&db).output().unwrap();
    assert!(o.status.success(), "settle: {}", String::from_utf8_lossy(&o.stderr));
}

// ---- sync-ui -------------------------------------------------------------------------------------------------------------

#[test]
fn sync_ui_matches_node() {
    if !node_sqlite_available() {
        eprintln!("SKIPPED: Node with node:sqlite is not available, so there is no Node to compare with");
        return;
    }
    let fx = fixture("l8csui");
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis() as i64;
    let settled = corpus(&fx.root, "settled", 7, now);
    settle(&settled, now - 1_000);
    let conn = rusqlite::Connection::open_with_flags(settled.join("appdata/DevSwarm/devswarm.db"), rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
    let mut labels: Vec<String> = Vec::new();
    {
        let mut st = conn.prepare("SELECT label FROM builders WHERE builderType <> 'primary' AND label IS NOT NULL ORDER BY rank IS NULL, rank, id").unwrap();
        let mut rows = st.query([]).unwrap();
        while let Some(r) = rows.next().unwrap() {
            labels.push(r.get::<_, String>(0).unwrap());
        }
    }
    assert!(labels.len() >= 8, "the corpus has builders: {}", labels.len());
    let json = |v: &[String]| serde_json::to_string(v).unwrap();
    let write = |name: &str, body: &str| -> String {
        let p = fx.root.join(name);
        fs::write(&p, body).unwrap();
        p.to_string_lossy().to_string()
    };
    let exact: Vec<String> = labels.iter().take(6).cloned().collect();
    let trunc: Vec<String> = labels.iter().take(6).map(|l| format!("{}\u{2026}", l.chars().take(14).collect::<String>())).collect();
    let upper: Vec<String> = labels.iter().take(4).map(|l| format!("  {}  ", l.to_uppercase())).collect();
    let mixed: Vec<String> =
        vec!["nothing matches this title at all".into(), "   ".into(), labels[1].clone(), labels[1].clone(), "Ship it".into(), "Fix the gate...".into()];
    let f_exact = write("t-exact.json", &json(&exact));
    let f_trunc = write("t-trunc.json", &json(&trunc));
    let f_upper = write("t-upper.json", &json(&upper));
    let f_mixed = write("t-mixed.json", &json(&mixed));
    let f_wrapped = write("t-wrapped.json", &format!("{{\"titles\":{}}}", json(&exact)));
    let f_empty = write("t-empty.json", "[]");
    let f_nonstring = write("t-nonstring.json", "[\"a\", 5]");
    let f_garbage = write("t-garbage.json", "this is not json");
    let f_scalar = write("t-scalar.json", "5");
    let f_notitles = write("t-notitles.json", "{\"names\":[]}");
    let missing = fx.root.join("t-missing.json").to_string_lossy().to_string();
    let db = "{HOME}/appdata/DevSwarm/devswarm.db";
    let su = |name: &str, argv: &[&str], native: bool| lc(name, argv, "nongit", native, "SyncUi").env("ANTIHALL_DEVSWARM_APP_DB", db);
    let cases = vec![
        su("sui-exact", &["sync-ui", "--titles-json", &f_exact], true),
        su("sui-truncated-with-an-ellipsis", &["sync-ui", "--titles-json", &f_trunc], true),
        su("sui-upper-case-and-padding", &["sync-ui", "--titles-json", &f_upper], true),
        su("sui-unmatched-duplicates-and-short", &["sync-ui", "--titles-json", &f_mixed], true),
        su("sui-wrapped-titles", &["sync-ui", "--titles-json", &f_wrapped], true),
        su("sui-no-titles", &["sync-ui", "--titles-json", &f_empty], true),
        su("sui-titles-json-equals", &["sync-ui", &format!("--titles-json={f_exact}")], true),
        su("sui-non-string-title", &["sync-ui", "--titles-json", &f_nonstring], true),
        su("sui-garbage", &["sync-ui", "--titles-json", &f_garbage], true),
        su("sui-scalar", &["sync-ui", "--titles-json", &f_scalar], true),
        su("sui-object-without-titles", &["sync-ui", "--titles-json", &f_notitles], true),
        su("sui-needs-a-source", &["sync-ui"], true),
        su("sui-bare-titles-flag", &["sync-ui", "--titles-json"], true),
        lc("sui-db-off", &["sync-ui", "--titles-json", &f_mixed], "nongit", true, "SyncUi").env("ANTIHALL_DEVSWARM_APP_DB", "off"),
        lc("sui-db-missing", &["sync-ui", "--titles-json", &f_exact], "nongit", true, "SyncUi").env("ANTIHALL_DEVSWARM_APP_DB", "{HOME}/nothing/here.db"),
        su("sui-apply-is-node", &["sync-ui", "--titles-json", &f_exact, "--yes"], false),
        su("sui-stdin-is-node", &["sync-ui", "--stdin"], false),
        su("sui-missing-file-is-node", &["sync-ui", "--titles-json", &missing], false),
        su("sui-setting-in-the-environment-is-node", &["sync-ui", "--titles-json", &f_exact], false).env("ANTIHALL_DEVSWARM_SCREENSHOT_SYNC", "false"),
    ];
    // the titles are not all unmatched: Node itself matches the exact and the truncated sets
    let dbp = settled.join("appdata/DevSwarm/devswarm.db").to_string_lossy().to_string();
    for f in [&f_exact, &f_trunc] {
        let argv: Vec<String> = vec!["sync-ui".into(), "--titles-json".into(), f.clone()];
        let r = node_cli(&settled, &fx.root, &argv, now, &[("ANTIHALL_DEVSWARM_APP_DB", dbp.as_str())]);
        assert!(r.stdout.contains("\"matched\":[{"), "the titles match builders: {}", r.stdout);
    }
    check_from(&fx, &cases, &[], &settled, Some(CORPUS_DIRS), now, 15, 4);
}

// ---- retention -----------------------------------------------------------------------------------------------------------

const RT_HASH: &str = "proj-abcdef";

fn rt_support(name: &str) -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/it/dssup_support").join(name)
}

fn rt_corpus(root: &Path, name: &str, seed: u32, now: i64) -> PathBuf {
    let home = root.join(name);
    let o =
        Command::new("node").arg(rt_support("rt_corpus.js")).arg(&home).arg(RT_HASH).arg(seed.to_string()).arg(now.to_string()).arg("small").output().unwrap();
    assert!(o.status.success(), "corpus: {}", String::from_utf8_lossy(&o.stderr));
    home
}

fn rt_dump(home: &Path) -> String {
    let o = Command::new("node").arg(rt_support("rt_dump.js")).arg(home).output().unwrap();
    assert!(o.status.success(), "dump: {}", String::from_utf8_lossy(&o.stderr));
    mask_sizes(&String::from_utf8_lossy(&o.stdout))
}

/// Sizes that depend on how a file is laid out (two SQLite builds, two compressors) are blanked on both sides.
fn mask_sizes(d: &str) -> String {
    let re = regex::Regex::new(r#""(bytesBefore|bytesAfter|mbBefore|mbAfter|totalBytes|totalBytesAfter|capBytes|bytes|ms)":[0-9.]+"#).unwrap();
    let evict = regex::Regex::new(r#"("event":"archive-evict","file":"[^"]*","bytes":)[0-9]+"#).unwrap();
    evict.replace_all(&re.replace_all(d, r#""$1":0"#), "${1}0").into_owned()
}

fn rt_env(extra: &[(&str, &str)]) -> Vec<(String, String)> {
    let mut e: Vec<(String, String)> = vec![
        ("ANTIHALL_DEVSWARM_RETENTION_DAYS".into(), "30".into()),
        ("ANTIHALL_DEVSWARM_RETENTION_KEEP_PER_PARTITION".into(), "5".into()),
        ("ANTIHALL_DEVSWARM_RETENTION_MAX_STORE_MB".into(), "100".into()),
        ("ANTIHALL_DEVSWARM_RETENTION_ARCHIVE".into(), "true".into()),
    ];
    for (k, v) in extra {
        e.retain(|(x, _)| x != k);
        e.push(((*k).into(), (*v).into()));
    }
    e
}

#[test]
fn retention_matches_node() {
    if !node_sqlite_available() {
        eprintln!("SKIPPED: Node with node:sqlite is not available, so there is no Node to compare with");
        return;
    }
    let fx = fixture("l8cret");
    let seed = rt_corpus(&fx.root, "rt-seed", 3, NOW - 30 * DAY / 4);
    let tools = tools_path(&fx.root, true);
    let nonode = tools_path(&fx.root, false);
    for bin in [&tools, &nonode] {
        let g = Command::new("sh").args(["-c", "command -v gzip"]).output().unwrap();
        std::os::unix::fs::symlink(String::from_utf8_lossy(&g.stdout).trim(), Path::new(bin).join("gzip")).ok();
    }
    let nongit = fx.root.join("rt-cwd");
    fs::create_dir_all(&nongit).unwrap();
    let nongit = real(&nongit);
    struct Case {
        name: &'static str,
        argv: Vec<&'static str>,
        env: Vec<(String, String)>,
        native: bool,
    }
    let c = |name: &'static str, argv: &[&'static str], extra: &[(&str, &str)], native: bool| Case { name, argv: argv.to_vec(), env: rt_env(extra), native };
    let cases = vec![
        c("ret-status", &["retention", "status"], &[], true),
        c("ret-status-disabled", &["retention", "status"], &[("ANTIHALL_DEVSWARM_RETENTION_DAYS", "0")], true),
        c("ret-status-size-limit", &["retention", "status"], &[("ANTIHALL_DEVSWARM_RETENTION_MAX_STORE_MB", "0.1")], true),
        c("ret-dry-run", &["retention", "run", "--dry-run"], &[], true),
        c("ret-dry-run-one-store", &["retention", "run", "--dry-run", "--store", RT_HASH], &[], true),
        c("ret-dry-run-size-limit", &["retention", "run", "--dry-run"], &[("ANTIHALL_DEVSWARM_RETENTION_MAX_STORE_MB", "0.2")], true),
        c(
            "ret-dry-run-no-archive",
            &["retention", "run", "--dry-run"],
            &[("ANTIHALL_DEVSWARM_RETENTION_ARCHIVE", "false"), ("ANTIHALL_DEVSWARM_RETENTION_DAYS", "1")],
            true,
        ),
        c("ret-run-one-store", &["retention", "run", "--store", RT_HASH], &[], true),
        c("ret-run-the-only-store", &["retention", "run"], &[], true),
        c("ret-run-with-a-size-limit", &["retention", "run"], &[("ANTIHALL_DEVSWARM_RETENTION_MAX_STORE_MB", "0.4")], true),
        c(
            "ret-run-without-an-archive",
            &["retention", "run", "--store", RT_HASH],
            &[("ANTIHALL_DEVSWARM_RETENTION_ARCHIVE", "false"), ("ANTIHALL_DEVSWARM_RETENTION_DAYS", "1")],
            true,
        ),
        c("ret-run-disabled-is-node", &["retention", "run"], &[("ANTIHALL_DEVSWARM_RETENTION_DAYS", "0")], false),
        c("ret-run-unknown-store-is-node", &["retention", "run", "--store", "nope-123456"], &[], false),
        c("ret-run-bad-store", &["retention", "run", "--store", "../x"], &[], true),
        c("ret-run-dotfile-store", &["retention", "run", "--store", ".hidden"], &[], true),
        c("ret-restore-is-node", &["retention", "restore", "--store", RT_HASH, "--month", "2026-01"], &[], false),
        c("ret-usage", &["retention"], &[], true),
        c("ret-unknown-sub", &["retention", "frobnicate"], &[], true),
    ];
    let (mut native, mut deferred) = (0, 0);
    for (i, k) in cases.iter().enumerate() {
        if std::env::var("AH_L8C_FILTER").is_ok_and(|f| !k.name.contains(&f)) {
            continue;
        }
        let now = NOW + i as i64;
        let homes: Vec<PathBuf> = ["node", "engine", "defer"].iter().map(|x| fx.root.join(format!("ret{i}-{x}"))).collect();
        for h in &homes {
            let st = Command::new("cp").arg("-Rp").arg(&seed).arg(h).status().unwrap();
            assert!(st.success());
            fs::create_dir_all(h.join(".anti-hall")).unwrap();
            fs::write(h.join(".anti-hall/settings.json"), "{\"mesh\":{\"engine_writes\":\"on\"}}\n").unwrap();
        }
        let argv: Vec<String> = k.argv.iter().map(|x| (*x).into()).collect();
        let with_path = |p: &str| -> Vec<(String, String)> {
            let mut e = k.env.clone();
            e.push(("PATH".into(), p.into()));
            e
        };
        let (en, ee, ed) = (with_path(&tools), with_path(&tools), with_path(&nonode));
        let n = node_cli(&homes[0], &nongit, &argv, now, &to_ref(&en));
        let e = engine_cli(&homes[1], &nongit, &argv, now, &to_ref(&ee));
        let log = last_log(&homes[1].join("state"));
        assert_eq!(
            log["result"] == "native",
            k.native,
            "{}: expected native={} but the engine logged {log} (engine {} {:?}; node {} {:?})",
            k.name,
            k.native,
            e.code,
            e.stdout,
            n.code,
            n.stdout
        );
        if k.native {
            native += 1;
            let (es, ns) = (
                mask_sizes(&e.stdout).replace(homes[1].to_string_lossy().as_ref(), "<HOME>"),
                mask_sizes(&n.stdout).replace(homes[0].to_string_lossy().as_ref(), "<HOME>"),
            );
            assert_eq!((e.code, &es), (n.code, &ns), "{}: stdout/exit differ\n engine: {}\n node:   {}", k.name, e.stdout, n.stdout);
            let (de, dn) = (rt_dump(&homes[1]), rt_dump(&homes[0]));
            assert!(de == dn, "{}: the store, archive, state or log differ: {}", k.name, first_diff(&dn, &de));
            let _ = fs::remove_dir_all(&homes[0]);
            let _ = fs::remove_dir_all(&homes[1]);
        } else {
            deferred += 1;
            assert_eq!(e.code, n.code, "{}: exit code of the fallback", k.name);
            let pre = rt_dump(&homes[2]);
            let d = engine_cli(&homes[2], &nongit, &argv, now, &to_ref(&ed));
            assert_eq!(d.code, 75, "{}: a deferral the engine cannot hand to Node exits 75, got {} / {}", k.name, d.code, d.stdout);
            assert!(d.stdout.is_empty(), "{}: nothing is printed on a deferral", k.name);
            assert!(pre == rt_dump(&homes[2]), "{}: a deferral wrote", k.name);
        }
    }
    // an acting run with no Node to agree with the plan writes nothing and exits 75
    let h = fx.root.join("ret-nowitness");
    assert!(Command::new("cp").arg("-Rp").arg(&seed).arg(&h).status().unwrap().success());
    fs::create_dir_all(h.join(".anti-hall")).unwrap();
    fs::write(h.join(".anti-hall/settings.json"), "{\"mesh\":{\"engine_writes\":\"on\"}}\n").unwrap();
    let pre = rt_dump(&h);
    let mut e = rt_env(&[]);
    e.push(("PATH".into(), nonode.clone()));
    let argv: Vec<String> = vec!["retention".into(), "run".into()];
    let d = engine_cli(&h, &nongit, &argv, NOW, &to_ref(&e));
    assert_eq!(d.code, 75, "no witness, no write: {} / {}", d.code, d.stdout);
    assert!(pre == rt_dump(&h), "an acting run without a witness wrote");
    let (deferred, total) = (deferred + 1, cases.len() + 1);
    eprintln!("l8c retention parity: {total} cases, {native} answered by the engine and identical to Node, {deferred} deferred with nothing written");
    if std::env::var("AH_L8C_FILTER").is_err() {
        assert!(native >= 13 && deferred >= 4, "{native} native, {deferred} deferred");
    }
}
