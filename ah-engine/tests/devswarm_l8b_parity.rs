#![allow(
    dead_code,
    clippy::type_complexity,
    clippy::collapsible_if,
    clippy::needless_range_loop,
    clippy::useless_vec,
    clippy::regex_creation_in_loops,
    clippy::let_underscore_must_use
)]
//! Parity of the DevSwarm CLI verbs of lane l8b (`ready-check`, ...): `ah-engine mesh <argv>` (mesh.engine_writes = on) against the
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
    let a: Vec<&str> = argv.iter().map(String::as_str).collect();
    engine_verb(home, &home.join("state"), cwd, &a, now, None, env)
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
        if std::env::var("AH_L8B_FILTER").is_ok_and(|f| !c.name.contains(&f)) {
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
        assert_eq!(log["result"] == "native", c.native, "{}: expected native={} but the engine logged {log}", c.name, c.native);
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
    eprintln!("l8b cli parity: {} cases, {native} answered by the engine and identical to Node, {deferred} deferred with nothing written", cases.len());
    if std::env::var("AH_L8B_FILTER").is_err() {
        assert!(native >= min_native && deferred >= min_deferred, "{native} native, {deferred} deferred");
    }
}

// ---- ready-check ---------------------------------------------------------------------------------------------------------

/// A repository for `ready-check`: `main` at c1, branches `ok` (edits and adds), `nested` (nested paths), `deleting` (removes a
/// file under `.planning`), `gitlink` (a submodule pointer), `odd` (names git quotes), `adv` (c1 plus one more commit).
fn ready_repo(root: &Path) -> (PathBuf, BTreeMap<&'static str, String>) {
    let repo = root.join("rc");
    fs::create_dir_all(&repo).unwrap();
    git(&["init", "-q", "-b", "main"], &repo);
    for (p, t) in [("a.txt", "a\n"), ("b.txt", "b\n"), ("docs/x.md", "x\n"), (".planning/p.md", "p\n"), (".planning/deep/q.md", "q\n"), ("src/lib.rs", "l\n")] {
        let f = repo.join(p);
        fs::create_dir_all(f.parent().unwrap()).unwrap();
        fs::write(f, t).unwrap();
    }
    git(&["add", "-A"], &repo);
    git(&["commit", "-q", "-m", "c1"], &repo);
    let c1 = gitout(&["rev-parse", "HEAD"], &repo);
    git(&["update-ref", "refs/remotes/origin/main", &c1], &repo);
    let mut shas: BTreeMap<&'static str, String> = BTreeMap::new();
    shas.insert("c1", c1.clone());
    let branch = |name: &'static str, f: &dyn Fn(&Path), shas: &mut BTreeMap<&'static str, String>| {
        git(&["checkout", "-q", "-b", name, &c1], &repo);
        f(&repo);
        git(&["add", "-A"], &repo);
        git(&["commit", "-q", "--allow-empty", "-m", name], &repo);
        shas.insert(name, gitout(&["rev-parse", "HEAD"], &repo));
    };
    let w = |p: &str, t: &str, r: &Path| {
        let f = r.join(p);
        fs::create_dir_all(f.parent().unwrap()).unwrap();
        fs::write(f, t).unwrap();
    };
    branch(
        "ok",
        &|r| {
            w("a.txt", "a2\n", r);
            w("src/new.rs", "n\n", r);
        },
        &mut shas,
    );
    branch(
        "nested",
        &|r| {
            w("src/deep/er/f.rs", "f\n", r);
            w("a/b.txt", "1\n", r);
            w("a/x/b.txt", "2\n", r);
            w("a/x/y/b.txt", "3\n", r);
            w("docs/y.md", "y\n", r);
            w("name with space.txt", "s\n", r);
        },
        &mut shas,
    );
    branch(
        "deleting",
        &|r| {
            fs::remove_file(r.join(".planning/p.md")).unwrap();
            fs::remove_file(r.join(".planning/deep/q.md")).unwrap();
            fs::remove_file(r.join("docs/x.md")).unwrap();
        },
        &mut shas,
    );
    branch(
        "gitlink",
        &|r| {
            git(&["update-index", "--add", "--cacheinfo", &format!("160000,{c1},subm")], r);
        },
        &mut shas,
    );
    branch(
        "odd",
        &|r| {
            w("caf\u{e9}.txt", "e\n", r);
            w("emoji-\u{1F600}.txt", "e\n", r);
            w("tab\tname.txt", "t\n", r);
            w("quo\"te.txt", "q\n", r);
        },
        &mut shas,
    );
    branch("same", &|_| {}, &mut shas);
    git(&["checkout", "-q", "-b", "adv", &c1], &repo);
    w("adv.txt", "adv\n", &repo);
    git(&["add", "-A"], &repo);
    git(&["commit", "-q", "-m", "adv"], &repo);
    shas.insert("adv", gitout(&["rev-parse", "HEAD"], &repo));
    git(&["checkout", "-q", "main"], &repo);
    (real(&repo), shas)
}

fn ready_cases(s: &BTreeMap<&'static str, String>) -> Vec<Lc> {
    let (c1, ok, nested, deleting, gitlink, odd, same, adv) =
        (&s["c1"], &s["ok"], &s["nested"], &s["deleting"], &s["gitlink"], &s["odd"], &s["same"], &s["adv"]);
    let rc = |name: &str, argv: &[&str]| lc(name, argv, "rc", true, "ReadyCheck");
    let mut v = vec![
        rc("ready-ok-default-base", &["ready-check", ok]),
        rc("ready-ok-explicit-base", &["ready-check", ok, "--base", c1]),
        rc("ready-ok-equals-base", &["ready-check", ok, &format!("--base={c1}")]),
        rc("ready-empty-base-is-the-default", &["ready-check", ok, "--base="]),
        rc("ready-bare-base-is-the-default", &["ready-check", ok, "--base"]),
        rc("ready-same-commit", &["ready-check", same]),
        rc("ready-branch-name-as-sha", &["ready-check", "ok"]),
        rc("ready-head", &["ready-check", "HEAD"]),
        rc("ready-not-ff", &["ready-check", ok, "--base", adv]),
        rc("ready-gitlink", &["ready-check", gitlink]),
        rc("ready-deletions-unwatched", &["ready-check", deleting]),
        rc("ready-deletions-watched", &["ready-check", deleting, "--watch-deletions", ".planning"]),
        rc("ready-deletions-watched-trailing-slash", &["ready-check", deleting, "--watch-deletions", ".planning/"]),
        rc("ready-deletions-watched-several", &["ready-check", deleting, "--watch-deletions", "docs, .planning,docs"]),
        rc("ready-deletions-watched-repeated-flag", &["ready-check", deleting, "--watch-deletions", "docs", "--watch-deletions", ".planning"]),
        rc("ready-deletions-watched-only-a-prefix-of-a-name", &["ready-check", deleting, "--watch-deletions", ".plan"]),
        rc("ready-deletions-watched-slash-only", &["ready-check", deleting, "--watch-deletions", "/"]),
        rc("ready-deletions-watch-nothing-changed", &["ready-check", ok, "--watch-deletions", ".planning"]),
        rc("ready-allow-star-star", &["ready-check", ok, "--allow", "src/**,a.txt"]),
        rc("ready-allow-misses", &["ready-check", ok, "--allow", "docs/**"]),
        rc("ready-allow-star-does-not-cross-slashes", &["ready-check", nested, "--allow", "src/*"]),
        rc("ready-allow-globstar-swallows-the-slash", &["ready-check", nested, "--allow", "a/**/b.txt"]),
        rc("ready-allow-question-mark", &["ready-check", nested, "--allow", "a/?/b.txt,docs/?.md"]),
        rc("ready-allow-star-then-extension", &["ready-check", nested, "--allow", "*.txt,src/**,a/**,docs/*.md"]),
        rc("ready-allow-regex-metacharacters-are-literal", &["ready-check", nested, "--allow", "name with space.txt,a.b+c(d)|e[f]{g}$h^i\\j"]),
        rc("ready-allow-repeated-and-blank", &["ready-check", nested, "--allow", " , ", "--allow", "a/**", "--allow", "a/**"]),
        rc("ready-allow-bare-is-no-restriction", &["ready-check", nested, "--allow"]),
        rc("ready-allow-and-watch-and-not-ff", &["ready-check", deleting, "--base", adv, "--allow", "nothing", "--watch-deletions", "docs"]),
        rc("ready-names-git-quotes", &["ready-check", odd]),
        rc("ready-names-git-quotes-allowed-by-a-glob", &["ready-check", odd, "--allow", "*"]),
        rc("ready-unknown-sha", &["ready-check", "0000000000000000000000000000000000000000"]),
        rc("ready-nonsense-sha", &["ready-check", "no-such-ref"]),
        rc("ready-unknown-base", &["ready-check", ok, "--base", "no-such-base"]),
        rc("ready-sha-looks-like-an-option", &["ready-check", "-x"]),
        rc("ready-sha-is-a-range", &["ready-check", "ok..nested"]),
        rc("ready-no-sha", &["ready-check"]),
        rc("ready-no-sha-with-flags", &["ready-check", "--base", "x"]),
        rc("ready-fetch-is-node", &["ready-check", ok, "--fetch"]),
        rc("ready-flags-before-the-sha", &["ready-check", "--base", c1, ok]),
        lc("ready-outside-a-repository", &["ready-check", "HEAD"], "nongit", true, "ReadyCheck"),
        lc("ready-in-another-repository", &["ready-check", ok], "other", true, "ReadyCheck"),
    ];
    for c in &mut v {
        if c.name == "ready-fetch-is-node" {
            c.native = false;
        }
    }
    // quotepath off: git prints the raw UTF-8 names
    v.push(
        lc("ready-quotepath-off-bmp", &["ready-check", odd, "--allow", "caf*"], "rc", false, "ReadyCheck")
            .env("GIT_CONFIG_COUNT", "1")
            .env("GIT_CONFIG_KEY_0", "core.quotepath")
            .env("GIT_CONFIG_VALUE_0", "false"),
    );
    v.push(
        lc("ready-quotepath-off-astral", &["ready-check", odd], "rc", false, "ReadyCheck")
            .env("GIT_CONFIG_COUNT", "1")
            .env("GIT_CONFIG_KEY_0", "core.quotepath")
            .env("GIT_CONFIG_VALUE_0", "false"),
    );
    v.push(lc("ready-an-astral-glob", &["ready-check", ok, "--allow", "\u{1F600}?"], "rc", false, "ReadyCheck"));
    v
}

#[test]
fn ready_check_matches_node() {
    if !node_sqlite_available() {
        eprintln!("SKIPPED: Node with node:sqlite is not available, so there is no Node to compare with");
        return;
    }
    let fx = fixture("l8bready");
    let (rc, shas) = ready_repo(&fx.root);
    let cases = ready_cases(&shas);
    check(&fx, &cases, &[("rc", rc)], 35, 3);
}

// ---- app-state and app-sync ----------------------------------------------------------------------------------------------

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

fn app_cases() -> Vec<Lc> {
    let db = "{HOME}/appdata/DevSwarm/devswarm.db";
    let live = |l: Lc| l.env("ANTIHALL_DEVSWARM_APP_DB", db).env("ANTIHALL_INGEST_DRY_RUN", "0");
    let a = |name: &str, argv: &[&str], native: bool, label: &'static str| live(lc(name, argv, "nongit", native, label));
    vec![
        a("app-state-text", &["app-state"], true, "AppState"),
        a("app-state-json", &["app-state", "--json"], true, "AppState"),
        a("app-state-json-equals", &["app-state", "--json=1"], true, "AppState"),
        a("app-state-extra-word", &["app-state", "whatever"], true, "AppState"),
        lc("app-state-db-off", &["app-state"], "nongit", true, "AppState").env("ANTIHALL_DEVSWARM_APP_DB", "off"),
        lc("app-state-db-off-json", &["app-state", "--json"], "nongit", true, "AppState").env("ANTIHALL_DEVSWARM_APP_DB", "off"),
        lc("app-state-db-missing", &["app-state"], "nongit", true, "AppState").env("ANTIHALL_DEVSWARM_APP_DB", "{HOME}/nothing/here.db"),
        a("app-sync-dry-run", &["app-sync", "--dry-run"], true, "AppSync"),
        a("app-sync-env-dry", &["app-sync"], true, "AppSync").env("ANTIHALL_INGEST_DRY_RUN", "1"),
        a("app-sync", &["app-sync"], true, "AppSync"),
        lc("app-sync-db-off", &["app-sync"], "nongit", true, "AppSync").env("ANTIHALL_DEVSWARM_APP_DB", "off").env("ANTIHALL_INGEST_DRY_RUN", "0"),
    ]
}

#[test]
fn app_state_and_app_sync_match_node() {
    if !node_sqlite_available() {
        eprintln!("SKIPPED: Node with node:sqlite is not available, so there is no Node to compare with");
        return;
    }
    let fx = fixture("l8bapp");
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis() as i64;
    // a settled installation (Node already marked and retired what it would): the verbs are native
    let settled = corpus(&fx.root, "settled", 7, now);
    settle(&settled, now - 1_000);
    check_from(&fx, &app_cases(), &[], &settled, Some(CORPUS_DIRS), now, 8, 0);
}

#[test]
fn app_sync_hands_a_retirement_to_node_with_nothing_written() {
    if !node_sqlite_available() {
        eprintln!("SKIPPED: Node with node:sqlite is not available, so there is no Node to compare with");
        return;
    }
    let fx = fixture("l8bappraw");
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis() as i64;
    let raw = corpus(&fx.root, "raw", 11, now);
    let db = "{HOME}/appdata/DevSwarm/devswarm.db";
    let cases = vec![
        lc("app-state-unsettled", &["app-state", "--json"], "nongit", true, "AppState").env("ANTIHALL_DEVSWARM_APP_DB", db),
        lc("app-sync-dry-unsettled", &["app-sync", "--dry-run"], "nongit", true, "AppSync").env("ANTIHALL_DEVSWARM_APP_DB", db),
        lc("app-sync-unsettled-is-node", &["app-sync"], "nongit", false, "AppSync").env("ANTIHALL_DEVSWARM_APP_DB", db).env("ANTIHALL_INGEST_DRY_RUN", "0"),
    ];
    check_from(&fx, &cases, &[], &raw, Some(CORPUS_DIRS), now, 2, 1);
}
