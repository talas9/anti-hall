//! Parity of the DevSwarm CLI verbs of lane dsB (`merge`, `reconcile-registry`, `reap-stale`, `reconcile-active`, `auto-archive`,
//! `spawn`, `respawn`): `ah-engine mesh <argv>` (mesh.engine_writes = on) against the real `node scripts/devswarm.js <argv>`.
//!
//! Every case runs Node and the engine on identical copies of one seeded home (the D45 fixture: a real git repo with a linked
//! child worktree and a store written by Node's own code) with the same pinned clock, and compares the exact stdout, the exit
//! code, the whole home tree and every table of the project's store. Every home carries a RECORDING `hivecontrol` stub first on
//! the PATH (the real hivecontrol is never called): it appends `<cwd>|<argv>` to `$HOME/hc.log` for every call except the probe
//! (`--version`, `workspace --help`), whose answer Node's capability cache already holds, and it answers `check-merge`,
//! `merge-into-source` and `list all` from per-case shell fragments, so the argument vector and the working directory of every call are
//! part of the home tree both sides are compared on. A case the engine must hand to Node is run a third time with no Node on the PATH:
//! it must exit 75, print nothing and write nothing. The background Node witness of each answered call that has one (everything but
//! `merge`) is checked at the end: it must have logged a match.
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

/// The workspace verbs a normal build lists.
const DEFAULT_VERBS: &str = "list info create update-title check-merge merge-into-source";

struct Lc {
    /// The stub hivecontrol's answers (shell fragments) to `workspace check-merge`, `workspace merge-into-source ...` and `workspace list all`.
    check: String,
    merge: String,
    all: String,
    /// The verbs the stub's `workspace --help` lists (the capability probe reads them).
    verbs: String,
    /// The Node witness runs after the engine answered (everything but `merge`, whose witness would merge twice).
    witnessed: bool,
    /// Stdout fragments the answer must contain (so a case cannot pass by printing nothing).
    expect: Vec<String>,
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
    Lc {
        check: "echo '{}'".into(),
        merge: "echo '{}'".into(),
        all: "echo '[]'".into(),
        verbs: DEFAULT_VERBS.into(),
        witnessed: true,
        expect: vec![],
        name: name.into(),
        argv: argv.iter().map(|s| (*s).into()).collect(),
        cwd,
        setup: Box::new(|_| {}),
        env: vec![],
        native,
        label,
    }
}

impl Lc {
    fn check(mut self, body: &str) -> Lc {
        self.check = body.into();
        self
    }
    fn merge(mut self, body: &str) -> Lc {
        self.merge = body.into();
        self
    }
    fn verbs(mut self, list: &str) -> Lc {
        self.verbs = list.into();
        self
    }
    fn unwitnessed(mut self) -> Lc {
        self.witnessed = false;
        self
    }
    fn all(mut self, body: &str) -> Lc {
        self.all = body.into();
        self
    }
    fn expect(mut self, parts: &[&str]) -> Lc {
        self.expect = parts.iter().map(|p| (*p).into()).collect();
        self
    }
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
    if std::env::var("AH_DSB_DEBUG").is_ok() || o.status.code() == Some(70) {
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

fn stub_dir(root: &Path, name: &str, c: &Lc) -> PathBuf {
    let d = root.join(format!("stub-{name}"));
    fs::create_dir_all(&d).unwrap();
    let f = d.join("hivecontrol");
    let help: String = c.verbs.split_whitespace().map(|v| format!("  {v}  The {v} verb\\n")).collect();
    fs::write(
        &f,
        format!(
            "#!/bin/sh\ncase \"$*\" in\n  \"--version\") echo \"hivecontrol 2.6.0\";;\n  \"workspace --help\") printf 'Commands:\\n{help}';;\n  *) printf '%s|%s\\n' \"$PWD\" \"$*\" >> \"$HOME/hc.log\"\n     case \"$*\" in\n       \"workspace check-merge\") {check};;\n       \"workspace merge-into-source\"*) {merge};;\n       \"workspace list all\") {all};;\n       *) exit 0;;\n     esac;;\nesac\n",
            check = c.check,
            merge = c.merge,
            all = c.all
        ),
    )
    .unwrap();
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(&f, fs::Permissions::from_mode(0o755)).unwrap();
    d
}

/// Node's own capability probe of the stub, run once on a home.
fn prime_cache(home: &Path, path: &str) {
    let caps = plugin_root().join("companion/lib/devswarm-capabilities.js");
    let src = format!("const c=require({:?});c.probe({{env:process.env,home:process.env.HOME}});", caps);
    let o = Command::new("node").args(["-e", &src]).env_clear().env("PATH", path).env("HOME", home).output().unwrap();
    assert!(o.status.success(), "{}", String::from_utf8_lossy(&o.stderr));
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
        if std::env::var("AH_DSB_FILTER").is_ok_and(|f| !c.name.contains(&f)) {
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
        let stub = stub_dir(&fx.root, &format!("c{i}"), c);
        let (p_tools, p_nonode) = (format!("{}:{tools}", stub.display()), format!("{}:{nonode}", stub.display()));
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
            // Node's capability probe of the stub, cached once and copied (the cache carries a clock)
            let cache = h.join(".anti-hall/devswarm/capabilities.json");
            if h == &homes[0] {
                prime_cache(h, &p_tools);
            } else {
                fs::create_dir_all(cache.parent().unwrap()).unwrap();
                fs::copy(homes[0].join(".anti-hall/devswarm/capabilities.json"), &cache).unwrap();
            }
            (c.setup)(h);
        }
        let env_of = |h: &Path| -> Vec<(String, String)> { c.env.iter().map(|(k, v)| (k.clone(), v.replace("{HOME}", &h.to_string_lossy()))).collect() };
        let run_env = |h: &Path, path: &str| -> Vec<(String, String)> {
            let mut e = env_of(h);
            e.push(("PATH".into(), path.into()));
            e
        };
        let refs = |e: &[(String, String)]| -> Vec<(String, String)> { e.to_vec() };
        let (en, ee, ed) = (refs(&run_env(&homes[0], &p_tools)), refs(&run_env(&homes[1], &p_tools)), refs(&run_env(&homes[2], &p_nonode)));
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
        for part in &c.expect {
            assert!(n.stdout.contains(part.as_str()), "{}: Node's answer lacks {part:?}: {}", c.name, n.stdout);
        }
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
            if c.witnessed {
                pending.push((c.name.clone(), homes[1].join("state")));
            }
        } else {
            deferred += 1;
            assert_eq!(e.code, n.code, "{}: exit code of the fallback", c.name);
            // reconcile-registry reads `workspace list all` before it can know it must defer: the stub's own log of that read is not a write
            let strip = |mut t: BTreeMap<String, String>| {
                if c.argv[0] == "reconcile-registry" {
                    t.remove("hc.log");
                }
                t
            };
            let pre = (strip(tree(&homes[2])), key_db(&homes[2]).is_file().then(|| raw_dump(&key_db(&homes[2]))));
            let d = engine_cli(&homes[2], &cwd, &c.argv, now, &to_ref(&ed));
            assert_eq!(d.code, 75, "{}: a deferral the engine cannot hand to Node exits 75, got {} / {}", c.name, d.code, d.stdout);
            assert!(d.stdout.is_empty(), "{}: nothing is printed on a deferral: {}", c.name, d.stdout);
            assert_eq!(last_log(&homes[2].join("state"))["result"], "defer", "{}", c.name);
            let post = (strip(tree(&homes[2])), key_db(&homes[2]).is_file().then(|| raw_dump(&key_db(&homes[2]))));
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
    eprintln!("dsB parity: {} cases, {native} answered by the engine and identical to Node, {deferred} deferred with nothing written", cases.len());
    if std::env::var("AH_DSB_FILTER").is_err() {
        assert!(native >= min_native && deferred >= min_deferred, "{native} native, {deferred} deferred");
    }
}

// ---- fixtures of the cases ----------------------------------------------------------------------------------------------

const HOUR: i64 = 3_600_000;
const DAY: i64 = 86_400_000;

fn ds(h: &Path, rel: &str, text: &str) {
    put(h, &format!(".anti-hall/devswarm/{rel}"), text);
}

fn heartbeat(h: &Path, id: &str, ts: i64) {
    ds(h, &format!("heartbeats/{id}.json"), &format!("{{\"id\":\"{id}\",\"ts\":{ts}}}"));
}

/// A descriptor `readDescriptors` accepts: id, worktree, session; `owner` is the persisted `ownerKey` when given.
fn desc(h: &Path, id: &str, wt: &str, owner: Option<&str>) {
    let o = owner.map(|k| format!(",\"ownerKey\":\"{k}\"")).unwrap_or_default();
    ds(h, &format!("workspaces/{id}.json"), &format!("{{\"id\":\"{id}\",\"worktreePath\":\"{wt}\",\"sessionId\":\"sess-{id}\"{o}}}"));
}

fn own(k: &str) -> Option<&str> {
    Some(k)
}

fn verdict(h: &Path, id: &str, status: &str) {
    ds(h, &format!("liveness/{id}.json"), &format!("{{\"status\":\"{status}\"}}"));
}

/// A repository at `root/special/<name>` whose only commit was made at `secs` (created once, shared by every home).
fn repo_at(fx: &Fx, name: &str, secs: i64) -> String {
    let dir = fx.root.join("special").join(name);
    if !dir.join(".git").exists() {
        fs::create_dir_all(&dir).unwrap();
        git(&["init", "-q"], &dir);
        let when = format!("@{secs} +0000");
        let st = Command::new("git")
            .args(["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "x"])
            .current_dir(&dir)
            .env("GIT_AUTHOR_DATE", &when)
            .env("GIT_COMMITTER_DATE", &when)
            .status()
            .unwrap();
        assert!(st.success());
    }
    real(&dir).to_string_lossy().to_string()
}

/// The DevSwarm app's database, as `app.db` in the home: (id, label, worktree, rank, isHidden, isActive, builderType, pinned).
type Builder<'a> = (&'a str, &'a str, &'a str, i64, i64, i64, &'a str, i64);

fn app_db(h: &Path, builders: &[Builder]) {
    let c = rusqlite::Connection::open(h.join("app.db")).unwrap();
    c.execute_batch(
        "CREATE TABLE builders (id TEXT, repositoryId TEXT, sourceBranch TEXT, branchName TEXT, worktreePath TEXT, terminalId TEXT, label TEXT, createdAt TEXT, lastAccessed TEXT, rank INTEGER, isHidden INTEGER, pullRequestId TEXT, builderType TEXT, isPinned INTEGER, isActive INTEGER, lastSelectedAt TEXT);
         CREATE TABLE builder_terminals (id TEXT, builderId TEXT, terminalId TEXT, terminalType TEXT, aiAgent TEXT, ai_session_config TEXT, isActive INTEGER, panelStatus TEXT, createdAt TEXT, lastViewedAt TEXT, initialPrompt TEXT, initialPromptDeliveredAt TEXT, initialPromptWithheldAt TEXT);
         CREATE TABLE pull_requests (id TEXT, repositoryId TEXT, branchName TEXT, number INTEGER, state TEXT, isDraft INTEGER, url TEXT, checkStatus TEXT, reviewStatus TEXT, lastSyncedAt TEXT);
         CREATE TABLE repositories (id TEXT, path TEXT, name TEXT, defaultBaseBranch TEXT);",
    )
    .unwrap();
    for (id, label, wt, rank, hidden, active, kind, pinned) in builders {
        c.execute(
            "INSERT INTO builders (id, branchName, worktreePath, label, rank, isHidden, builderType, isPinned, isActive) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
            rusqlite::params![id, format!("br-{id}"), wt, label, rank, hidden, kind, pinned, active],
        )
        .unwrap();
    }
}

fn settings(h: &Path, extra: &str) {
    fs::write(h.join(".anti-hall/settings.json"), format!("{{\"mesh\":{{\"engine_writes\":\"on\"}},{extra}}}\n")).unwrap();
}

// ---- merge --------------------------------------------------------------------------------------------------------------

fn merge_cases(fx: &Fx) -> Vec<Lc> {
    let m = |name: &str, argv: &[&str], cwd: &'static str, native: bool| lc(name, argv, cwd, native, "Merge").unwitnessed();
    let ok_check = "echo '{\"mergeable\":true,\"conflicts\":[]}'";
    let ok_merge = "echo '{\"merged\":\"yes\"}'";
    let _ = fx;
    vec![
        m("lands", &["merge"], "child", true).check(ok_check).merge(ok_merge).expect(&["\"merged\":true", "\"sent\":true", "\"mergeable\":true"]),
        m("passes-its-arguments-on", &["merge", "--squash", "-m", "ship it", "--flag=x"], "child", true).check(ok_check).merge(ok_merge),
        m("from-the-primary-checkout", &["merge"], "main", true).check(ok_check).merge(ok_merge),
        m("a-failing-merge", &["merge"], "child", true)
            .check(ok_check)
            .merge("echo partial; echo 'conflict in a.txt' >&2; exit 3")
            .expect(&["exited 3: conflict in a.txt", "\"merged\":false"]),
        m("a-failing-merge-without-stderr", &["merge"], "child", true).check(ok_check).merge("exit 1").expect(&["exited 1"]),
        m("a-merge-killed-by-a-signal", &["merge"], "child", true).check(ok_check).merge("kill -TERM $$").expect(&["killed by signal SIGTERM"]),
        m("a-failing-check", &["merge"], "child", true).check("echo oops; exit 1").merge(ok_merge).expect(&["\"checkMerge\":null"]),
        m("a-check-that-is-not-json", &["merge"], "child", true).check("echo 'not json'").merge(ok_merge),
        m("a-check-that-prints-nothing", &["merge"], "child", true).check(":").merge(ok_merge),
        m("a-check-of-every-json-shape", &["merge"], "child", true)
            .check("echo '{\"a\":1.0,\"b\":[1e3,\"é\\u2028\\u0007\"],\"c\":{\"d\":null,\"d2\":[]},\"e\":-0,\"f\":1e21,\"g\":0.1,\"h\":true}'")
            .merge(ok_merge),
        m("a-check-that-is-a-scalar", &["merge"], "child", true).check("echo 42").merge(ok_merge),
        m("a-merge-that-prints-nothing", &["merge"], "child", true).check(ok_check).merge(":"),
        m("a-merge-that-prints-a-lot-and-succeeds", &["merge"], "child", true)
            .check(ok_check)
            .merge("i=0; while [ $i -lt 400 ]; do echo \"line $i\"; i=$((i+1)); done"),
        m("outside-a-project", &["merge"], "nongit", true).check(ok_check).merge(ok_merge).expect(&["\"reason\":\"no-project\""]),
        m("a-failing-merge-outside-a-project", &["merge"], "nongit", true).check(ok_check).merge("exit 2"),
        m("a-project-without-a-store", &["merge"], "other", false).check(ok_check).merge(ok_merge),
        m("a-build-without-the-merge-verb", &["merge"], "child", false).verbs("list info create").check(ok_check).merge(ok_merge),
        m("a-build-without-the-check-verb", &["merge"], "child", false).verbs("list info create merge-into-source").check(ok_check).merge(ok_merge),
        m("a-sender-label-nobody-aliased", &["merge"], "child", false).check(ok_check).merge(ok_merge).setup(|h| {
            ah_engine::discard::harmless(fs::remove_file(h.join(".anti-hall/devswarm/sender-aliases.json"))); // keep: absent is the wanted state
        }),
    ]
}

#[test]
fn merge_matches_node() {
    if !node_sqlite_available() {
        eprintln!("SKIPPED: Node with node:sqlite is not available, so there is no Node to compare with");
        return;
    }
    let fx = fixture("dsbmerge");
    let cases = merge_cases(&fx);
    check(&fx, &cases, &[], 14, 4);
}

// ---- reconcile-registry -------------------------------------------------------------------------------------------------

fn registry_cases(fx: &Fx) -> Vec<Lc> {
    let r = |name: &str, native: bool| lc(name, &["reconcile-registry"], "child", native, "ReconcileRegistry");
    let (cw, mw) = (fx.child.to_string_lossy().to_string(), fx.main.to_string_lossy().to_string());
    let seed = fx.seed_home.to_string_lossy().to_string();
    let pid = fx.primary_id.clone();
    let all_ok = format!(
        "echo '[{{\"id\":\"child-1\",\"path\":\"{cw}\"}},{{\"id\":\"child-2\",\"path\":\"{seed}/gone-worktree\"}},{{\"id\":\"child-3\",\"path\":\"{seed}/archived-wt\"}},{{\"id\":\"{pid}\",\"path\":\"{mw}\"}}]'"
    );
    let aligned = all_ok.clone();
    vec![
        r("an-empty-list", true).all("echo '[]'").expect(&["\"driftCount\":4"]),
        r("everything-aligned", true).all(&aligned).expect(&["\"driftCount\":0"]),
        r("a-workspace-the-registry-lacks", true)
            .all(&all_ok.replace("]'", ",{\"id\":\"x9\",\"path\":\"/p/x9\",\"label\":\"The nine\"},{\"id\":\"x8\",\"worktreePath\":\"/p/x8\"}]'"))
            .expect(&["workspaceWithoutRegistry", "The nine"]),
        r("a-path-that-differs", true)
            .all(&all_ok.replace(&format!("\"id\":\"child-1\",\"path\":\"{cw}\""), "\"id\":\"child-1\",\"path\":\"/elsewhere\""))
            .expect(&["worktreePathMismatch", "/elsewhere"]),
        r("a-path-with-a-trailing-slash-is-the-same", true)
            .all(&all_ok.replace(&format!("\"path\":\"{cw}\""), &format!("\"path\":\"{cw}/\"")))
            .expect(&["\"driftCount\":0"]),
        r("a-path-through-a-dot-is-the-same", true)
            .all(&all_ok.replace(&format!("\"path\":\"{cw}\""), &format!("\"path\":\"{cw}/.\"")))
            .expect(&["\"driftCount\":0"]),
        r("a-wrapper-object", true).all(&format!("echo '{{\"children\":[{{\"id\":\"child-1\",\"path\":\"{cw}\"}}]}}'")),
        r("worktree-path-in-place-of-path", true).all(&format!("echo '[{{\"id\":\"child-1\",\"worktreePath\":\"{cw}\"}}]'")),
        r("a-repeated-id-keeps-the-last", true)
            .all(&format!("echo '[{{\"id\":\"child-1\",\"path\":\"/a\"}},{{\"id\":\"child-2\",\"path\":\"/b\"}},{{\"id\":\"child-1\",\"path\":\"{cw}\"}}]'")),
        r("records-mixed-with-junk", true).all(&format!("echo '[null,1,\"x\",{{\"id\":\"child-1\",\"path\":\"{cw}\"}},false]'")),
        r("an-empty-id-is-skipped", true).all("echo '[{\"id\":\"\",\"path\":\"/p\"},{\"id\":null,\"path\":\"/q\"},{\"id\":0,\"path\":\"/r\"}]'"),
        r("a-record-without-a-path-field-anywhere", true).all("echo '[{\"id\":\"a\"}]'").expect(&["missingFields"]),
        r("a-record-without-an-id-field-anywhere", true).all("echo '[{\"path\":\"/p\"}]'").expect(&["missingFields"]),
        r("neither-id-nor-path", true).all("echo '[{\"label\":\"l\"}]'").expect(&["missingFields"]),
        r("the-fields-come-from-different-records", true).all("echo '[{\"id\":\"a\"},{\"path\":\"/p\"}]'"),
        r("an-object-without-children", true).all("echo '{\"x\":1,\"7\":2,\"a\":3}'").expect(&["rawKeys"]),
        r("children-that-is-not-a-list", true).all("echo '{\"children\":5}'"),
        r("a-scalar", true).all("echo 42"),
        r("not-json", true).all("echo 'not json'"),
        r("no-output", true).all(":"),
        r("a-failing-list", true).all("echo 'boom' >&2; exit 4").expect(&["exited 4: boom"]),
        r("a-failing-list-without-stderr", true).all("exit 1"),
        r("a-record-with-a-number-for-an-id", false).all("echo '[{\"id\":5,\"path\":\"/p\"}]'"),
        r("a-record-with-a-number-for-a-path", false).all("echo '[{\"id\":\"a\",\"path\":5}]'"),
        r("a-record-that-is-an-array", false).all("echo '[[1],{\"id\":\"a\",\"path\":\"/p\"}]'"),
        r("a-label-that-is-not-text", true).all("echo '[{\"id\":\"zz\",\"path\":\"/p\",\"label\":5}]'"),
        r("a-registry-row-with-a-relative-path-listed", false).all("echo '[{\"id\":\"child-1\",\"path\":\"relative/x\"}]'"),
        lc("outside-a-project", &["reconcile-registry"], "nongit", true, "ReconcileRegistry").all("echo '[]'"),
        lc("a-project-without-a-store", &["reconcile-registry"], "other", false, "ReconcileRegistry").all("echo '[]'"),
        r("a-build-without-the-list-verb", false).verbs("info create").all("echo '[]'"),
        lc("from-the-primary-checkout", &["reconcile-registry"], "main", true, "ReconcileRegistry").all(&aligned),
    ]
}

#[test]
fn reconcile_registry_matches_node() {
    if !node_sqlite_available() {
        eprintln!("SKIPPED: Node with node:sqlite is not available, so there is no Node to compare with");
        return;
    }
    let fx = fixture("dsbrr");
    let cases = registry_cases(&fx);
    check(&fx, &cases, &[], 20, 4);
}

// ---- reap-stale ---------------------------------------------------------------------------------------------------------

fn reap_cases(fx: &Fx) -> Vec<Lc> {
    let key = fx.repo_key.clone();
    let r = |name: &str, argv: &[&str], native: bool| lc(name, argv, "child", native, "ReapStale");
    let recent = repo_at(fx, "recent", (NOW - 60_000) / 1000);
    let old = repo_at(fx, "old", (NOW - DAY) / 1000);
    let cw = fx.child.to_string_lossy().to_string();
    let (k1, k2, k3, k4, k5, k6, k7, k8, k9) =
        (key.clone(), key.clone(), key.clone(), key.clone(), key.clone(), key.clone(), key.clone(), key.clone(), key.clone());
    let (rc1, rc2, ol1, ol2, ol3) = (recent.clone(), recent.clone(), old.clone(), old.clone(), old.clone());
    let (cw1, cw2) = (cw.clone(), cw.clone());
    vec![
        r("nothing-to-reap", &["reap-stale"], true),
        r("a-stale-workspace", &["reap-stale"], true)
            .setup(move |h| {
                desc(h, "ws-a", "/nowhere/a", own(&k1));
                verdict(h, "ws-a", "stale");
            })
            .expect(&["\"candidates\":[{\"id\":\"ws-a\""]),
        r("an-escalated-workspace", &["reap-stale"], true).setup(move |h| {
            desc(h, "ws-a", "/nowhere/a", own(&k2));
            verdict(h, "ws-a", "escalated");
        }),
        r("a-live-verdict-is-spared", &["reap-stale"], true).setup(move |h| {
            desc(h, "ws-a", "/nowhere/a", own(&k3));
            verdict(h, "ws-a", "live");
        }),
        r("a-workspace-with-no-verdict", &["reap-stale"], true).setup(move |h| desc(h, "ws-a", "/nowhere/a", own(&k4))),
        r("a-fresh-heartbeat-spares-it", &["reap-stale"], true)
            .setup(move |h| {
                desc(h, "ws-a", "/nowhere/a", own(&k5));
                verdict(h, "ws-a", "stale");
                heartbeat(h, "ws-a", NOW - 1000);
            })
            .expect(&["fresh-heartbeat"]),
        r("an-old-heartbeat-does-not", &["reap-stale"], true).setup(move |h| {
            desc(h, "ws-a", "/nowhere/a", own(&k6));
            verdict(h, "ws-a", "stale");
            heartbeat(h, "ws-a", NOW - 2 * HOUR);
        }),
        r("a-recent-commit-spares-it", &["reap-stale"], true)
            .setup(move |h| {
                desc(h, "ws-a", &rc1, own(&k7));
                verdict(h, "ws-a", "stale");
            })
            .expect(&["recent-activity"]),
        r("an-old-commit-does-not", &["reap-stale"], true).setup(move |h| {
            desc(h, "ws-a", &ol1, own(&k8));
            verdict(h, "ws-a", "escalated");
        }),
        r("several-in-name-order", &["reap-stale"], true).setup(move |h| {
            for (i, id) in ["ws-c", "ws-a", "ws-b", "ws-d"].iter().enumerate() {
                desc(h, id, if i == 3 { &rc2 } else { &ol2 }, own(&k9));
                verdict(h, id, if i % 2 == 0 { "stale" } else { "escalated" });
            }
            heartbeat(h, "ws-b", NOW - 5000);
        }),
        r("another-projects-workspace-is-not-ours", &["reap-stale"], true).setup(move |h| {
            desc(h, "ws-x", "/nowhere/x", Some("other-project-1234"));
            verdict(h, "ws-x", "stale");
        }),
        r("no-owner-key-uses-the-worktrees-project", &["reap-stale"], true).setup(move |h| {
            desc(h, "ws-a", &cw1, None);
            verdict(h, "ws-a", "stale");
        }),
        r("a-descriptor-without-a-session-is-not-read", &["reap-stale"], true).setup(move |h| {
            ds(h, "workspaces/ws-a.json", &format!("{{\"id\":\"ws-a\",\"worktreePath\":\"/nowhere/a\",\"ownerKey\":\"{}\"}}", "x"));
            verdict(h, "ws-a", "stale");
        }),
        r("a-torn-verdict-is-ignored", &["reap-stale"], true).setup(move |h| {
            desc(h, "ws-a", &ol3, None);
            ds(h, "liveness/ws-a.json", "{\"status\":");
        }),
        r("a-verdict-that-is-not-text", &["reap-stale"], true).setup(move |h| {
            desc(h, "ws-a", &cw2, None);
            ds(h, "liveness/ws-a.json", "{\"status\":5}");
        }),
        lc("outside-a-project", &["reap-stale"], "nongit", true, "ReapStale"),
        lc("from-the-primary-checkout", &["reap-stale"], "main", true, "ReapStale"),
        r("confirmed-with-nothing-to-reap", &["reap-stale", "--yes"], true),
        r("confirm-is-a-synonym", &["reap-stale", "--confirm"], true),
        r("confirmed-with-only-spared-ones", &["reap-stale", "--yes"], true).setup({
            let k = key.clone();
            move |h| {
                desc(h, "ws-a", "/nowhere/a", own(&k));
                verdict(h, "ws-a", "stale");
                heartbeat(h, "ws-a", NOW - 1000);
            }
        }),
        r("confirmed-with-a-candidate-is-nodes", &["reap-stale", "--yes"], false).setup({
            let k = key.clone();
            move |h| {
                desc(h, "ws-a", "/nowhere/a", own(&k));
                verdict(h, "ws-a", "stale");
            }
        }),
        r("a-descriptor-whose-worktree-is-not-text-is-nodes", &["reap-stale"], false).setup({
            let k = key.clone();
            move |h| {
                ds(h, "workspaces/ws-a.json", &format!("{{\"id\":\"ws-a\",\"worktreePath\":5,\"sessionId\":\"s\",\"ownerKey\":\"{k}\"}}"));
                verdict(h, "ws-a", "stale");
            }
        }),
    ]
}

#[test]
fn reap_stale_matches_node() {
    if !node_sqlite_available() {
        eprintln!("SKIPPED: Node with node:sqlite is not available, so there is no Node to compare with");
        return;
    }
    let fx = fixture("dsbreap");
    let cases = reap_cases(&fx);
    check(&fx, &cases, &[], 19, 2);
}

// ---- reconcile-active ---------------------------------------------------------------------------------------------------

fn active_cases(fx: &Fx) -> Vec<Lc> {
    let key = fx.repo_key.clone();
    let db = ("ANTIHALL_DEVSWARM_APP_DB", "{HOME}/app.db");
    let a = |name: &str, argv: &[&str], native: bool| lc(name, argv, "child", native, "ReconcileActive").env(db.0, db.1);
    // alpha: archived in the app; beta: active in the app; gamma: unknown to the app; delta: archived, matched by its worktree path
    let seed = {
        let k = key.clone();
        move |h: &Path| {
            desc(h, "alpha-0001", "/nowhere/alpha", own(&k));
            desc(h, "beta-0002", "/nowhere/beta", own(&k));
            desc(h, "gamma-0003", "/nowhere/gamma", own(&k));
            desc(h, "primary-deadbeef", "/nowhere/delta", own(&k));
            app_db(
                h,
                &[
                    ("alpha-0001", "Alpha", "/nowhere/alpha", 1, 1, 0, "standard", 0),
                    ("beta-0002", "Beta", "/nowhere/beta", 2, 0, 1, "standard", 0),
                    ("other-id", "Delta", "/nowhere/delta", 3, 1, 0, "standard", 0),
                ],
            );
        }
    };
    let (s1, s2, s3, s4, s5, s6, s7, s8, s9) =
        (seed.clone(), seed.clone(), seed.clone(), seed.clone(), seed.clone(), seed.clone(), seed.clone(), seed.clone(), seed.clone());
    vec![
        a("no-active-set", &["reconcile-active"], true),
        a("allow-empty-with-nothing-here", &["reconcile-active", "--allow-empty"], true),
        a("dry-run", &["reconcile-active", "--active", "beta-0002"], true).setup(s1).expect(&["\"candidates\":[{\"id\":\"alpha-0001\"", "app-unknown"]),
        a("allow-empty-lists-every-candidate", &["reconcile-active", "--allow-empty"], true).setup(s2),
        a("a-prefix-of-four-matches", &["reconcile-active", "--active", "alph"], true).setup(s3),
        a("a-prefix-of-three-does-not", &["reconcile-active", "--active", "alp"], true).setup(s4),
        a("a-part-of-eight-matches", &["reconcile-active", "--active", "deadbeef"], true).setup(s5),
        a("a-part-of-seven-does-not", &["reconcile-active", "--active", "eadbeef"], true).setup(s6),
        a("several-values-and-repeats", &["reconcile-active", "--active", "beta-0002, gamma-0003", "--active", "beta-0002"], true).setup(s7),
        a("the-active-set-keeps-everything", &["reconcile-active", "--active", "alpha-0001,beta-0002,gamma-0003,primary-deadbeef"], true).setup(s8),
        a("confirmed-with-a-candidate-is-nodes", &["reconcile-active", "--active", "beta-0002", "--yes"], false).setup(s9),
        a("confirmed-keeping-the-candidate", &["reconcile-active", "--active", "alpha-0001,beta-0002,gamma-0003,primary-deadbeef", "--confirm"], true).setup({
            let k = key.clone();
            move |h| {
                desc(h, "alpha-0001", "/nowhere/alpha", own(&k));
                app_db(h, &[("alpha-0001", "Alpha", "/nowhere/alpha", 1, 1, 0, "standard", 0)]);
            }
        }),
        a("confirmed-with-nothing-here", &["reconcile-active", "--allow-empty", "--yes"], true),
        a("the-app-database-is-missing", &["reconcile-active", "--active", "x"], true).setup({
            let k = key.clone();
            move |h| desc(h, "alpha-0001", "/nowhere/alpha", own(&k))
        }),
        lc("the-app-database-is-off", &["reconcile-active", "--active", "x"], "child", true, "ReconcileActive").setup({
            let k = key.clone();
            move |h| desc(h, "alpha-0001", "/nowhere/alpha", own(&k))
        }),
        lc("confirmed-with-the-app-database-off", &["reconcile-active", "--active", "x", "--yes"], "child", true, "ReconcileActive").setup({
            let k = key.clone();
            move |h| desc(h, "alpha-0001", "/nowhere/alpha", own(&k))
        }),
        lc("confirmed-with-the-app-database-off-and-nothing-here", &["reconcile-active", "--allow-empty", "--yes"], "child", true, "ReconcileActive"),
        a("stdin-is-nodes", &["reconcile-active", "--stdin"], false),
        lc("outside-a-project", &["reconcile-active", "--active", "x"], "nongit", true, "ReconcileActive"),
        lc("outside-a-project-without-an-active-set", &["reconcile-active"], "nongit", true, "ReconcileActive"),
        a("an-unreadable-database-file", &["reconcile-active", "--active", "x"], true).setup({
            let k = key.clone();
            move |h| {
                desc(h, "alpha-0001", "/nowhere/alpha", own(&k));
                fs::write(h.join("app.db"), "this is not a database").unwrap();
            }
        }),
    ]
}

#[test]
fn reconcile_active_matches_node() {
    if !node_sqlite_available() {
        eprintln!("SKIPPED: Node with node:sqlite is not available, so there is no Node to compare with");
        return;
    }
    let fx = fixture("dsbra");
    let cases = active_cases(&fx);
    check(&fx, &cases, &[], 17, 2);
}

// ---- auto-archive -------------------------------------------------------------------------------------------------------

fn auto_cases() -> Vec<Lc> {
    let u = |name: &str, native: bool| lc(name, &["auto-archive"], "child", native, "AutoArchive");
    vec![
        u("no-app-database", true).expect(&["app-db-unavailable", "\"mode\":\"on\"", "\"idleMin\":30"]),
        u("from-the-primary-checkout", true),
        lc("outside-a-project", &["auto-archive"], "nongit", true, "AutoArchive"),
        u("mode-from-settings-json", true)
            .setup(|h| settings(h, "\"devswarm\":{\"autoArchive\":{\"mode\":\"dry-run\",\"idleMin\":2,\"maxPerSweep\":50}}"))
            .expect(&["dry-run", "\"idleMin\":5", "\"maxPerSweep\":20"]),
        u("flat-keys-in-settings-json", true)
            .setup(|h| settings(h, "\"devswarm\":{\"autoArchive.mode\":\"off\",\"autoArchive.idleMin\":45,\"autoArchive.ignorePings\":false}")),
        u("environment-overrides", true)
            .env("ANTIHALL_DEVSWARM_AUTO_ARCHIVE_MODE", "off")
            .env("ANTIHALL_DEVSWARM_AUTO_ARCHIVE_IDLE_MIN", "90")
            .env("ANTIHALL_DEVSWARM_AUTO_ARCHIVE_MAX_PER_SWEEP", "7")
            .env("ANTIHALL_DEVSWARM_AUTO_ARCHIVE_IGNORE_PINGS", "false"),
        u("an-unknown-mode-word", true).env("ANTIHALL_DEVSWARM_AUTO_ARCHIVE_MODE", "sideways"),
        u("a-fractional-idle", true).env("ANTIHALL_DEVSWARM_AUTO_ARCHIVE_IDLE_MIN", "12.9"),
        u("an-app-database-is-nodes", false).env("ANTIHALL_DEVSWARM_APP_DB", "{HOME}/app.db").setup(|h| app_db(h, &[])),
        u("an-app-database-path-that-is-no-file", true).env("ANTIHALL_DEVSWARM_APP_DB", "{HOME}/nothing-here.db"),
    ]
}

#[test]
fn auto_archive_matches_node() {
    if !node_sqlite_available() {
        eprintln!("SKIPPED: Node with node:sqlite is not available, so there is no Node to compare with");
        return;
    }
    let fx = fixture("dsbaa");
    let cases = auto_cases();
    check(&fx, &cases, &[], 9, 1);
}

// ---- spawn and respawn --------------------------------------------------------------------------------------------------

fn spawn_cases() -> Vec<Lc> {
    let p = |name: &str, argv: &[&str], native: bool| lc(name, argv, "child", native, "Spawn").env("ANTIHALL_DEVSWARM_SPAWN_LAUNCH_WAIT_MS", "0");
    vec![
        p("no-branch", &["spawn"], true).expect(&["spawn requires a branch name"]),
        p("a-title-without-a-value", &["spawn", "b1", "-t"], true),
        p("a-prompt-without-a-value", &["spawn", "b1", "-p"], true),
        p("a-source-without-a-value", &["spawn", "b1", "--source"], true),
        p("an-empty-equals-value", &["spawn", "b1", "--source="], true),
        p("a-source-that-is-the-next-option", &["spawn", "b1", "-s", "-p", "brief"], true).expect(&["looks like another option"]),
        p("a-title-that-is-the-next-option", &["spawn", "b1", "-t", "-p", "brief"], true),
        p("a-prompt-that-is-option-shaped", &["spawn", "b1", "-p", "--title"], true),
        p("a-prompt-that-is-an-option-with-a-value", &["spawn", "b1", "-p", "--title=x"], true),
        p("an-agent-with-a-dash-in-equals-form", &["spawn", "b1", "--agent=-x"], true),
        p("a-title-with-a-dash-in-equals-form", &["spawn", "b1", "--title=-x"], true),
        p("a-quoted-value-with-a-dash", &["spawn", "b1", "-t", "-x\"y"], true),
        p("strict-by-environment-overrides-the-file", &["spawn", "b1", "-t"], true)
            .env("ANTIHALL_DEVSWARM_SPAWN_STRICT_FLAG_VALUES", "true")
            .setup(|h| settings(h, "\"devswarm\":{\"spawnStrictFlagValues\":false}")),
        p("a-plain-spawn-is-nodes", &["spawn", "b1"], false),
        p("a-prompt-that-starts-with-a-bullet-is-nodes", &["spawn", "b1", "-p", "- fix the thing"], false),
        p("lenient-by-setting-is-nodes", &["spawn", "b1", "-t"], false).setup(|h| settings(h, "\"devswarm\":{\"spawnStrictFlagValues\":false}")),
        p("a-value-with-a-next-line-character-is-nodes", &["spawn", "b1", "-p", "--x\u{85}y"], false),
    ]
}

#[test]
fn spawn_matches_node() {
    if !node_sqlite_available() {
        eprintln!("SKIPPED: Node with node:sqlite is not available, so there is no Node to compare with");
        return;
    }
    let fx = fixture("dsbsp");
    let cases = spawn_cases();
    check(&fx, &cases, &[], 13, 4);
}

fn respawn_cases() -> Vec<Lc> {
    let z = |name: &str, argv: &[&str], cwd: &'static str, native: bool| lc(name, argv, cwd, native, "Respawn");
    vec![
        z("respawn-without-an-id", &["respawn"], "child", true),
        z("respawn-with-an-unsafe-id", &["respawn", "../x"], "child", true),
        z("respawn-with-a-dotted-id", &["respawn", "a..b"], "child", true),
        z("respawn-from-a-child", &["respawn", "child-1"], "child", true).expect(&["not-primary", "n/a"]),
        z("respawn-dry-run-from-a-child", &["respawn", "child-1", "--dry-run"], "child", true),
        z("respawn-outside-a-project", &["respawn", "child-1"], "nongit", true),
        z("respawn-from-the-primary-checkout", &["respawn", "child-1", "--dry-run"], "main", false),
    ]
}

#[test]
fn respawn_matches_node() {
    if !node_sqlite_available() {
        eprintln!("SKIPPED: Node with node:sqlite is not available, so there is no Node to compare with");
        return;
    }
    let fx = fixture("dsbrsp");
    let cases = respawn_cases();
    check(&fx, &cases, &[], 6, 1);
}
