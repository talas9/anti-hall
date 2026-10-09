//! Parity of the DevSwarm CLI lifecycle verbs of lane l8h (`unarchive`, `migrate-owner-keys`, `ensure`, `register`, `reap-orphans`,
//! `reconcile-registry`, `reconcile-active`): `ah-engine mesh <argv>` (mesh.engine_writes = on) against the
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
    if std::env::var("AH_L8H_DEBUG").is_ok() || o.status.code() == Some(70) {
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
        if std::env::var("AH_L8H_FILTER").is_ok_and(|f| !c.name.contains(&f)) {
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
    eprintln!("l8h cli parity: {} cases, {native} answered by the engine and identical to Node, {deferred} deferred with nothing written", cases.len());
    if std::env::var("AH_L8H_FILTER").is_err() {
        assert!(native >= min_native && deferred >= min_deferred, "{native} native, {deferred} deferred");
    }
}

// ---- shared setup ----------------------------------------------------------------------------------------------------------

/// Run Node's own verb in a case's home before the case (a state the case starts from).
#[allow(dead_code)]
fn node_first(h: &Path, cwd: &Path, argv: &[&str], now: i64) {
    let a: Vec<String> = argv.iter().map(|x| (*x).into()).collect();
    let r = node_cli(h, cwd, &a, now, &[]);
    assert_eq!(r.code, 0, "setup {argv:?}: {}", r.stdout);
}

macro_rules! need_node {
    () => {
        if !node_sqlite_available() {
            eprintln!("SKIPPED: Node with node:sqlite is not available, so there is no Node to compare with");
            return;
        }
    };
}

fn dsroot(h: &Path) -> PathBuf {
    h.join(".anti-hall/devswarm")
}

// ---- unarchive -----------------------------------------------------------------------------------------------------------

/// An archived descriptor `id` of the fixture project.
fn archived_desc(fx: &Fx, id: &str, extra: &str) -> Setup {
    let (key, wt) = (fx.repo_key.clone(), fx.child.to_string_lossy().to_string());
    let id = id.to_string();
    let extra = extra.to_string();
    Box::new(move |h| {
        put(
            h,
            &format!(".anti-hall/devswarm/archived/{id}.json"),
            &format!("{{\"id\":\"{id}\",\"worktreePath\":\"{wt}\",\"sessionId\":\"s-{id}\",\"inboxPath\":null,\"cursorPath\":null,\"nudgeCommand\":null,\"ownerKey\":\"{key}\"{extra}}}"),
        );
    })
}

#[test]
fn unarchive_matches_node() {
    need_node!();
    let fx = fixture("l8hunarch");
    let u = |name: &str, argv: &[&str], cwd: &'static str, native: bool| lc(name, argv, cwd, native, "Unarchive");
    let key = fx.repo_key.clone();
    let wt = fx.child.to_string_lossy().to_string();
    let with = |id: &str, extra: &str| archived_desc(&fx, id, extra);
    let both = |a: Setup, b: Setup| -> Setup {
        Box::new(move |h| {
            a(h);
            b(h);
        })
    };
    let k2 = key.clone();
    let other_project: Setup = Box::new(move |h| {
        put(h, ".anti-hall/devswarm/archived/ua-other.json", "{\"id\":\"ua-other\",\"worktreePath\":\"/x/y\",\"sessionId\":\"s\",\"ownerKey\":\"some-other-project-abc123\"}");
        let _ = &k2;
    });
    let linked: Setup = {
        let w = with("ua-linked", "");
        Box::new(move |h| {
            w(h);
            fs::create_dir_all(dsroot(h).join("workspaces")).unwrap();
            fs::hard_link(dsroot(h).join("archived/ua-linked.json"), dsroot(h).join("workspaces/ua-linked.json")).unwrap();
        })
    };
    let twin: Setup = {
        let w = with("ua-twin", "");
        Box::new(move |h| {
            w(h);
            put(h, ".anti-hall/devswarm/workspaces/ua-twin.json", "{\"id\":\"ua-twin\",\"worktreePath\":\"/live\",\"sessionId\":\"s\",\"ownerKey\":\"k\"}");
        })
    };
    let w2 = wt.clone();
    let revive_same: Setup = {
        let c = Box::new(move |h: &Path| {
            put(
                h,
                ".anti-hall/devswarm/archived/child-1.json",
                &format!("{{\"id\":\"child-1\",\"worktreePath\":\"{w2}\",\"sessionId\":\"child-1\",\"inboxPath\":null,\"cursorPath\":null,\"nudgeCommand\":null,\"ownerKey\":\"{}\"}}", "KEY"),
            );
        });
        let k = key.clone();
        Box::new(move |h| {
            c(h);
            let p = dsroot(h).join("archived/child-1.json");
            let t = fs::read_to_string(&p).unwrap().replace("KEY", &k);
            fs::write(p, t).unwrap();
        })
    };
    let w3 = wt.clone();
    let k3 = key.clone();
    let revive_other_wt: Setup = Box::new(move |h| {
        let _ = &w3;
        put(
            h,
            ".anti-hall/devswarm/archived/child-1.json",
            &format!("{{\"id\":\"child-1\",\"worktreePath\":\"/somewhere/else\",\"sessionId\":\"child-1\",\"ownerKey\":\"{k3}\"}}"),
        );
    });
    let bad_json: Setup = Box::new(|h| put(h, ".anti-hall/devswarm/archived/ua-bad.json", "{not json"));
    let cases = vec![
        u("ua-plain", &["unarchive", "ua-1"], "main", true).setup(with("ua-1", "")),
        u("ua-from-a-child", &["unarchive", "ua-1"], "child", true).setup(with("ua-1", "")),
        u("ua-drops-the-marker-fields", &["unarchive", "ua-2"], "main", true).setup(with("ua-2", ",\"archivedBy\":\"someone\",\"archivedAt\":1790000000000")),
        u("ua-descriptor-without-an-owner-key", &["unarchive", "ua-3"], "main", true).setup({
            let (k, w) = (key.clone(), wt.clone());
            Box::new(move |h: &Path| {
                put(h, ".anti-hall/devswarm/archived/ua-3.json", &format!("{{\"id\":\"ua-3\",\"worktreePath\":\"{w}\",\"sessionId\":\"s\",\"repoKey\":\"{k}\"}}"));
            })
        }),
        u("ua-keeps-unknown-fields-in-order", &["unarchive", "ua-4"], "main", true).setup(with("ua-4", ",\"zeta\":1,\"alpha\":{\"b\":2,\"a\":1},\"nudge\":\"x\"")),
        u("ua-other-project-is-refused", &["unarchive", "ua-other"], "main", true).setup(other_project),
        u("ua-nothing-archived", &["unarchive", "ua-none"], "main", true),
        u("ua-hardlinked-pair", &["unarchive", "ua-linked"], "main", true).setup(linked),
        u("ua-live-twin-is-not-the-anchor", &["unarchive", "ua-twin"], "main", true).setup(twin),
        u("ua-revives-a-registered-row", &["unarchive", "child-1"], "main", true).setup(revive_same),
        u("ua-registered-row-at-another-worktree-is-node", &["unarchive", "child-1"], "main", false).setup(revive_other_wt),
        u("ua-prefix-resolves-to-one-registered-id", &["unarchive", "child-2"], "main", true),
        u("ua-ambiguous-prefix", &["unarchive", "child-"], "main", true),
        u("ua-ambiguous-mesh-label-or-unknown", &["unarchive", &fx.child_mesh], "main", true),
        u("ua-unreadable-descriptor-is-node", &["unarchive", "ua-bad"], "main", false).setup(bad_json),
        u("ua-outside-a-project-refuses-by-owner", &["unarchive", "ua-1"], "nongit", true).setup(with("ua-1", "")),
        u("ua-outside-a-project-unknown-id-is-node", &["unarchive", "ua-zz"], "nongit", false),
        u("ua-unsafe-id", &["unarchive", "../x"], "main", true),
        u("ua-no-id", &["unarchive"], "main", true),
        u("ua-two-archived-in-sequence-first", &["unarchive", "ua-5"], "main", true).setup(both(with("ua-5", ""), with("ua-6", ""))),
    ];
    check(&fx, &cases, &[], 15, 3);
}
