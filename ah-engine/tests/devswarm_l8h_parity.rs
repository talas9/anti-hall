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
                let (de, dn) = (
                    raw_dump(&key_db(&homes[1])).replace(homes[1].to_string_lossy().as_ref(), "<HOME>"),
                    raw_dump(&key_db(&homes[0])).replace(homes[0].to_string_lossy().as_ref(), "<HOME>"),
                );
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

// ---- migrate-owner-keys --------------------------------------------------------------------------------------------------

/// `store.hashFromWorkspaceId(id)` for an ordinary id (the first eight hex digits of its SHA-256), asked of Node itself.
fn hash8(id: &str) -> String {
    let o = Command::new("node")
        .args(["-e", "process.stdout.write(require('crypto').createHash('sha256').update(process.argv[1]).digest('hex').slice(0,8))", id])
        .output()
        .unwrap();
    String::from_utf8_lossy(&o.stdout).to_string()
}

fn desc_json(id: &str, wt: &str, extra: &str) -> String {
    format!("{{\"id\":\"{id}\",\"worktreePath\":\"{wt}\",\"sessionId\":\"s-{id}\",\"inboxPath\":null,\"cursorPath\":null,\"nudgeCommand\":null{extra}}}")
}

#[test]
fn migrate_owner_keys_matches_node() {
    need_node!();
    let fx = fixture("l8hmigrate");
    let wt = fx.child.to_string_lossy().to_string();
    let key = fx.repo_key.clone();
    let m = |name: &str, cwd: &'static str, native: bool| lc(name, &["migrate-owner-keys"], cwd, native, "MigrateOwnerKeys");
    let active = |id: &str, extra: &str| {
        let (id, d) = (id.to_string(), desc_json(id, &wt, extra));
        move |h: &Path| put(h, &format!(".anti-hall/devswarm/workspaces/{id}.json"), &d)
    };
    let archived = |id: &str, extra: &str| {
        let (id, d) = (id.to_string(), desc_json(id, &wt, extra));
        move |h: &Path| put(h, &format!(".anti-hall/devswarm/archived/{id}.json"), &d)
    };
    let (a1, a2, a3, a4) = (active("mo-1", ""), active("mo-2", &format!(",\"ownerKey\":\"{key}\"")), active("mo-3", ",\"ownerKey\":\"\""), active("mo-4", ",\"repoKey\":\"keep-me-abc123\""));
    let (r1, r2) = (archived("mo-arch", ""), archived("mo-arch-owned", &format!(",\"ownerKey\":\"{key}\"")));
    let gone = {
        let d = desc_json("mo-gone", "/no/such/worktree", "");
        move |h: &Path| put(h, ".anti-hall/devswarm/workspaces/mo-gone.json", &d)
    };
    let gone_rk = {
        let d = desc_json("mo-gone-rk", "/no/such/worktree", ",\"repoKey\":\"persisted-abc123\"");
        move |h: &Path| put(h, ".anti-hall/devswarm/workspaces/mo-gone-rk.json", &d)
    };
    let stranded = {
        let d = desc_json("mo-stranded", &wt, &format!(",\"ownerKey\":\"{}\"", hash8("mo-stranded")));
        move |h: &Path| put(h, ".anti-hall/devswarm/workspaces/mo-stranded.json", &d)
    };
    let stranded_archived = {
        let d = desc_json("mo-stranded-a", &wt, &format!(",\"ownerKey\":\"{}\"", hash8("mo-stranded-a")));
        move |h: &Path| put(h, ".anti-hall/devswarm/archived/mo-stranded-a.json", &d)
    };
    let junk = |h: &Path| {
        put(h, ".anti-hall/devswarm/workspaces/broken.json", "{not json");
        put(h, ".anti-hall/devswarm/workspaces/array.json", "[1,2]");
        put(h, ".anti-hall/devswarm/workspaces/notes.txt", "x");
        put(h, ".anti-hall/devswarm/workspaces/no-wt.json", "{\"id\":\"no-wt\"}");
        put(h, ".anti-hall/devswarm/workspaces/unsafe.json", "{\"id\":\"../x\",\"worktreePath\":\"/a\"}");
    };
    let mismatch = |h: &Path| put(h, ".anti-hall/devswarm/workspaces/other-name.json", &desc_json("not-the-file-name", "/a", ""));
    let both_dirs = {
        let (d1, d2) = (desc_json("mo-twin", &wt, ""), desc_json("mo-twin", &wt, ",\"note\":\"archived copy\""));
        move |h: &Path| {
            put(h, ".anti-hall/devswarm/workspaces/mo-twin.json", &d1);
            put(h, ".anti-hall/devswarm/archived/mo-twin.json", &d2);
        }
    };
    let cases = vec![
        m("mo-empty-home", "main", true),
        m("mo-backfills-one", "main", true).setup(a1.clone()),
        m("mo-from-a-child", "child", true).setup(a1.clone()),
        m("mo-outside-a-project", "nongit", true).setup(a1.clone()),
        m("mo-already-owned", "main", true).setup(a2.clone()),
        m("mo-empty-owner-key-is-missing", "main", true).setup(a3),
        m("mo-persisted-repo-key-kept", "main", true).setup(a4),
        m("mo-mixed-active-and-archived", "main", true).setup({
            let (a, b, c, d, e) = (a1.clone(), a2.clone(), r1.clone(), r2, gone.clone());
            move |h| {
                a(h);
                b(h);
                c(h);
                d(h);
                e(h);
            }
        }),
        m("mo-worktree-gone-falls-to-the-hash-bucket", "main", true).setup(gone.clone()),
        m("mo-worktree-gone-keeps-its-repo-key", "main", true).setup(gone_rk),
        m("mo-skips-what-is-no-descriptor", "main", true).setup({
            let a = a1.clone();
            move |h| {
                junk(h);
                a(h);
            }
        }),
        m("mo-stranded-in-the-hash-bucket-is-node", "main", false).setup(stranded),
        m("mo-stranded-archived-is-only-backfilled-never-rehomed", "main", true).setup(stranded_archived),
        m("mo-file-name-is-not-the-id-is-node", "main", false).setup(mismatch),
        m("mo-same-id-in-both-dirs-counts-once", "main", true).setup(both_dirs),
        m("mo-twice-is-idempotent", "main", true).setup({
            let main = fx.main.clone();
            let a = a1.clone();
            move |h| {
                a(h);
                node_first(h, &main, &["migrate-owner-keys"], NOW - 100);
            }
        }),
    ];
    check(&fx, &cases, &[], 13, 1);
}

// ---- ensure / register ---------------------------------------------------------------------------------------------------

/// A second linked worktree of the fixture's repository (the seeded registry already holds a row for the child's worktree, so
/// a registration there would fold that row: Node's).
fn second_worktree(fx: &Fx) -> PathBuf {
    let p = fx.root.join("wt-two");
    gitout(&["worktree", "add", "-q", "-b", "two", p.to_str().unwrap()], &fx.main);
    real(&p)
}

#[test]
fn ensure_and_register_match_node() {
    need_node!();
    let fx = fixture("l8hreg");
    let wt2 = second_worktree(&fx);
    let w2 = wt2.to_string_lossy().to_string();
    let child = fx.child.to_string_lossy().to_string();
    let key = fx.repo_key.clone();
    let extra: Vec<(&str, PathBuf)> = vec![("wt2", wt2.clone())];
    let e = |name: &str, argv: &[&str], cwd: &'static str, native: bool| lc(name, argv, cwd, native, "Ensure");
    let r = |name: &str, argv: &[&str], cwd: &'static str, native: bool| lc(name, argv, cwd, native, "Register");
    let put_desc = |id: &str, body: String| {
        let id = id.to_string();
        move |h: &Path| put(h, &format!(".anti-hall/devswarm/workspaces/{id}.json"), &body)
    };
    let home_paths = |h: &Path, id: &str| (h.join(format!(".anti-hall/devswarm/inbox/{id}.ndjson")), h.join(format!(".anti-hall/devswarm/cursors/{id}.json")));
    let full = {
        let (w, k) = (w2.clone(), key.clone());
        move |h: &Path| {
            let (i, c) = home_paths(h, "reg-full");
            put(
                h,
                ".anti-hall/devswarm/workspaces/reg-full.json",
                &format!(
                    "{{\"id\":\"reg-full\",\"worktreePath\":\"{w}\",\"sessionId\":\"s-full\",\"inboxPath\":\"{}\",\"cursorPath\":\"{}\",\"nudgeCommand\":null,\"repoId\":null,\"repoKey\":\"{k}\",\"ownerKey\":\"{k}\"}}",
                    i.display(),
                    c.display()
                ),
            );
        }
    };
    let bare = put_desc("reg-bare", format!("{{\"id\":\"reg-bare\",\"worktreePath\":\"{w2}\",\"sessionId\":\"s-bare\"}}"));
    let hashed = put_desc("reg-hash", format!("{{\"id\":\"reg-hash\",\"worktreePath\":\"{w2}\",\"sessionId\":\"s\",\"ownerKey\":\"{}\"}}", hash8("reg-hash")));
    let foreign = put_desc("reg-foreign", format!("{{\"id\":\"reg-foreign\",\"worktreePath\":\"{w2}\",\"sessionId\":\"s\",\"ownerKey\":\"other-project-abc123\",\"repoKey\":\"other-project-abc123\"}}"));
    let upd = put_desc("reg-upd", format!("{{\"id\":\"reg-upd\",\"worktreePath\":\"{w2}\",\"sessionId\":\"old\",\"inboxPath\":null,\"cursorPath\":null,\"nudgeCommand\":null,\"repoId\":null,\"ownerKey\":\"{key}\",\"repoKey\":\"{key}\",\"extra\":{{\"z\":1,\"a\":2}}}}"));
    let archived_twin = {
        let w = w2.clone();
        move |h: &Path| put(h, ".anti-hall/devswarm/archived/reg-arch.json", &format!("{{\"id\":\"reg-arch\",\"worktreePath\":\"{w}\",\"sessionId\":\"s\"}}"))
    };
    let broken = |h: &Path| put(h, ".anti-hall/devswarm/workspaces/reg-broken.json", "{not json");
    let archived_twin2 = archived_twin.clone();
    let cases = vec![
        e("ens-creates-a-registration", &["ensure", "reg-new", "--worktree", &w2, "--session", "s-new"], "wt2", true),
        e("ens-creates-from-the-primary-checkout", &["ensure", "reg-new", "--worktree", &w2, "--session", "s-new"], "main", true),
        e("ens-existing-steady-state", &["ensure", "reg-full", "--worktree", &w2, "--session", "ignored"], "wt2", true).setup(full.clone()),
        e("ens-existing-backfills-owner-and-paths", &["ensure", "reg-bare"], "wt2", true).setup(bare.clone()),
        e("ens-existing-hash-bucket-is-node", &["ensure", "reg-hash"], "wt2", false).setup(hashed),
        e("ens-existing-other-project-is-node", &["ensure", "reg-foreign"], "wt2", false).setup(foreign),
        e("ens-archived-twin-is-node", &["ensure", "reg-arch", "--worktree", &w2, "--session", "s"], "wt2", false).setup(archived_twin),
        e("ens-reserved-id-is-node", &["ensure", "reg.base", "--worktree", &w2, "--session", "s"], "wt2", false),
        e("ens-without-worktree-is-node", &["ensure", "reg-nowt", "--session", "s"], "wt2", false),
        e("ens-without-session-is-node", &["ensure", "reg-nosess", "--worktree", &w2], "wt2", false),
        e("ens-second-row-of-a-worktree-is-node", &["ensure", "reg-dup", "--worktree", &child, "--session", "s"], "wt2", false),
        e("ens-another-project-worktree-is-node", &["ensure", "reg-x", "--worktree", fx.root.join("repo-other").to_str().unwrap(), "--session", "s"], "wt2", false),
        e("ens-a-path-that-is-no-worktree", &["ensure", "reg-x", "--worktree", fx.root.join("not-a-repo").to_str().unwrap(), "--session", "s"], "wt2", true),
        e("ens-outside-a-project-is-node", &["ensure", "reg-new", "--worktree", &w2, "--session", "s"], "nongit", false),
        e("ens-primary-label-is-node", &["ensure", "primary-0123abcd", "--worktree", &w2, "--session", "s"], "wt2", false),
        e("ens-unreadable-descriptor-is-node", &["ensure", "reg-broken", "--worktree", &w2, "--session", "s"], "wt2", false).setup(broken),
        e("ens-unsafe-id", &["ensure", "../x"], "wt2", true),
        e("ens-no-id", &["ensure"], "wt2", true),
        r("reg-creates", &["register", "reg-new", "--worktree", &w2, "--session", "s-new"], "wt2", true),
        r("reg-creates-with-a-nudge-command", &["register", "reg-new", "--worktree", &w2, "--session", "s-new", "--nudge", "hivecontrol", "--nudge", "poke"], "wt2", true),
        r("reg-relative-worktree-is-resolved", &["register", "reg-new", "--worktree", ".", "--session", "s-new"], "wt2", true),
        r("reg-with-a-repo-id", &["register", "reg-new", "--worktree", &w2, "--session", "s", "--repo-id", "repo-77"], "wt2", true),
        r("reg-with-a-repo-id-env", &["register", "reg-new", "--worktree", &w2, "--session", "s"], "wt2", true).env("DEVSWARM_REPO_ID", "env-repo-9"),
        r("reg-updates-a-descriptor-keeping-its-fields", &["register", "reg-upd", "--session", "fresh-session"], "wt2", true).setup(upd),
        r("reg-re-registers-the-same-descriptor", &["register", "reg-full", "--worktree", &w2, "--session", "s-full"], "wt2", true).setup(full),
        r("reg-over-an-archived-twin-revives-nothing-else", &["register", "reg-arch", "--worktree", &w2, "--session", "s"], "wt2", true).setup(archived_twin2),
        r("reg-without-session-is-node", &["register", "reg-nosess", "--worktree", &w2], "wt2", false),
        r("reg-second-row-of-a-worktree-is-node", &["register", "reg-dup", "--worktree", &child, "--session", "s"], "wt2", false),
        r("reg-reserved-id-is-node", &["register", "x.inst-abcdef", "--worktree", &w2, "--session", "s"], "wt2", false),
        r("reg-unsafe-id", &["register", "a/b"], "wt2", true),
        r("reg-empty-flag-value-is-node", &["register", "reg-new", "--worktree", "", "--session", "s"], "wt2", false),
    ];
    check(&fx, &cases, &extra, 16, 15);
}

// ---- correct --------------------------------------------------------------------------------------------------------------

fn plan_json(steps: &str, extra: &str) -> String {
    format!("{{\"key\":\"child-1\",\"id\":\"child-1\",\"worktreePath\":null,\"steps\":{steps},\"scope_globs\":[],\"extras\":[],\"created_at\":1794990000000,\"step_ts\":1794991000000{extra}}}")
}

#[test]
fn correct_matches_node() {
    need_node!();
    let fx = fixture("l8hcorrect");
    let c = |name: &str, argv: &[&str], native: bool| lc(name, argv, "main", native, "Correct");
    let plan_with = |steps: &'static str, extra: &'static str| move |h: &Path| put(h, ".anti-hall/devswarm/plans/child-1.json", &plan_json(steps, extra));
    let two = r#"[{"n":1,"text":"read the code","status":"done","ts":1794990500000},{"n":2,"text":"write the fix","status":"doing","ts":1794991000000},{"n":3,"text":"run the tests","status":"todo","ts":0}]"#;
    let all_done = r#"[{"n":1,"text":"a","status":"done","ts":1},{"n":2,"text":"b","status":"done","ts":2}]"#;
    let blocked = r#"[{"n":1,"text":"a","status":"doing","ts":5},{"n":2,"text":"b","status":"blocked","ts":9},{"n":3,"text":"c","status":"doing","ts":9}]"#;
    let braces = r#"[{"n":1,"text":"look at {id} and {n}","status":"doing","ts":3}]"#;
    let stray = |h: &Path| {
        put(
            h,
            ".anti-hall/devswarm/stray/child-1.json",
            "{\"active\":[{\"signal\":\"off-scope\",\"reason\":\"edited src/x.js outside the plan scope\",\"jev\":[{\"integration\":\"scope\",\"supports\":true},{\"integration\":\"stall\",\"supports\":false}]},{\"signal\":\"stall\",\"reason\":\"no step progress for 25m\"},{\"signal\":\"stall\",\"reason\":\"\"}]}",
        );
    };
    let stray_only_empty = |h: &Path| put(h, ".anti-hall/devswarm/stray/child-1.json", "{\"active\":[{\"signal\":\"stall\"}]}");
    let both = |p: Box<dyn Fn(&Path)>, s: fn(&Path)| move |h: &Path| {
        p(h);
        s(h);
    };
    let cases = vec![
        c("corr-no-plan", &["correct", "child-1"], true),
        c("corr-dry-run-without-stray", &["correct", "child-1", "--dry-run"], true).setup(plan_with(two, "")),
        c("corr-dry-run-with-stray-reasons", &["correct", "child-1", "--dry-run"], true).setup(both(Box::new(plan_with(two, "")), stray)),
        c("corr-dry-run-stray-without-reasons", &["correct", "child-1", "--dry-run"], true).setup(both(Box::new(plan_with(two, "")), stray_only_empty)),
        c("corr-dry-run-all-done-is-the-final-report", &["correct", "child-1", "--dry-run"], true).setup(plan_with(all_done, "")),
        c("corr-dry-run-blocked-step-wins-by-time", &["correct", "child-1", "--dry-run"], true).setup(plan_with(blocked, "")),
        c("corr-dry-run-braces-in-a-step-text", &["correct", "child-1", "--dry-run"], true).setup(plan_with(braces, "")),
        c("corr-dry-run-plan-without-step-ts", &["correct", "child-1", "--dry-run"], true).setup(|h| {
            put(h, ".anti-hall/devswarm/plans/child-1.json", "{\"key\":\"child-1\",\"id\":\"child-1\",\"steps\":[{\"n\":4,\"text\":\"only\",\"status\":\"todo\"}],\"created_at\":1794000000000}")
        }),
        c("corr-sends-the-message-and-records-the-warning", &["correct", "child-1"], true).setup(plan_with(two, "")),
        c("corr-sends-with-stray-signals-and-jev", &["correct", "child-1"], true).setup(both(Box::new(plan_with(two, "")), stray)),
        c("corr-to-an-unregistered-id-is-node", &["correct", "ghost"], false).setup(|h| {
            put(h, ".anti-hall/devswarm/plans/ghost.json", "{\"key\":\"ghost\",\"id\":\"ghost\",\"steps\":[{\"n\":1,\"text\":\"x\",\"status\":\"doing\",\"ts\":1}],\"created_at\":1}")
        }),
        c("corr-unsafe-id", &["correct", "../x"], true),
        c("corr-no-id", &["correct"], true),
    ];
    check(&fx, &cases, &[], 11, 1);
}

// ---- reap-orphans ---------------------------------------------------------------------------------------------------------

#[test]
fn reap_orphans_matches_node() {
    need_node!();
    let fx = fixture("l8hreap");
    let r = |name: &str, argv: &[&str], cwd: &'static str, native: bool| lc(name, argv, cwd, native, "ReapOrphans");
    // a partition nobody registered, holding mail: the orphan the dry run would list
    let key = fx.repo_key.clone();
    let orphan = move |h: &Path| {
        let o = Command::new("node").arg(support("orphan.js")).arg(h).arg(&key).output().unwrap();
        assert!(o.status.success(), "orphan.js: {}", String::from_utf8_lossy(&o.stderr));
    };
    let orphan2 = orphan.clone();
    let orphan3 = orphan.clone();
    let cases = vec![
        r("reap-dry-run-with-an-orphan-is-node", &["reap-orphans"], "main", false).setup(orphan),
        r("reap-apply-with-an-orphan-is-node", &["reap-orphans", "--apply", "--max", "1", "--i-am-a-human"], "main", false).setup(orphan2),
        r("reap-refusal-does-not-need-the-orphans", &["reap-orphans", "--apply"], "main", true).setup(orphan3),
        r("reap-dry-run", &["reap-orphans"], "main", true),
        r("reap-apply-as-a-human", &["reap-orphans", "--apply", "--max", "3", "--i-am-a-human"], "main", true),
        r("reap-apply-as-a-human-from-a-child", &["reap-orphans", "--apply", "--max=2", "--i-am-a-human"], "child", true),
        r("reap-apply-without-max", &["reap-orphans", "--apply"], "main", true),
        r("reap-apply-with-a-bare-max", &["reap-orphans", "--apply", "--max"], "main", true),
        r("reap-apply-with-zero", &["reap-orphans", "--apply", "--max", "0"], "main", true),
        r("reap-apply-with-a-fraction", &["reap-orphans", "--apply", "--max", "2.5"], "main", true),
        r("reap-apply-with-words", &["reap-orphans", "--apply", "--max", "lots"], "main", true),
        r("reap-apply-under-automation", &["reap-orphans", "--apply", "--max", "3", "--i-am-a-human"], "main", true).env("ANTIHALL_DEVSWARM_AUTOMATION", "1"),
        r("reap-apply-from-a-non-interactive-shell", &["reap-orphans", "--apply", "--max", "3"], "main", true),
        r("reap-outside-a-project", &["reap-orphans"], "nongit", true),
        r("reap-apply-outside-a-project", &["reap-orphans", "--apply", "--max", "3"], "nongit", true),
        r("reap-from-a-child", &["reap-orphans", "--apply"], "child", true),
    ];
    check(&fx, &cases, &[], 11, 2);
}
