//! Parity of the DevSwarm CLI verbs of lane dsA (`archive`, `register-primary`, `diagnose`, `healthcheck`): `ah-engine mesh <argv>`
//! (mesh.engine_writes = on) against the real `node scripts/devswarm.js <argv>`.
//!
//! Every case runs Node and the engine on identical copies of one seeded home (the D45 fixture: a real git repo with a linked
//! child worktree and a store written by Node's own code) with the same pinned clock, and compares the exact stdout, the exit
//! code, the whole home tree and every table of the project's store. A case the engine must hand to Node is run a third time with
//! no Node on the PATH: it must exit 75, print nothing and write nothing. The verbs that act (`archive`, `register-primary`) are
//! also checked by the background Node witness where it runs. `hivecontrol` is a recording stub on the PATH (the same script for
//! both sides; the calls it saw are a file of the home, so the comparison covers them).
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
    /// The recording `hivecontrol` stub is not on the PATH.
    no_stub: bool,
    /// The background Node witness runs after the engine answered (and is awaited).
    witness: bool,
    /// Texts the answer must contain (both sides print the same, so this guards against two identical wrong answers).
    expect: Vec<String>,
}

fn lc(name: &str, argv: &[&str], cwd: &'static str, native: bool, label: &'static str) -> Lc {
    Lc {
        name: name.into(),
        argv: argv.iter().map(|s| (*s).into()).collect(),
        cwd,
        setup: Box::new(|_| {}),
        env: vec![],
        native,
        label,
        no_stub: false,
        witness: true,
        expect: vec![],
    }
}

impl Lc {
    fn env(mut self, k: &str, v: &str) -> Lc {
        self.env.push((k.into(), v.into()));
        self
    }
    fn expect(mut self, t: &[&str]) -> Lc {
        self.expect = t.iter().map(|x| (*x).into()).collect();
        self
    }
    fn no_stub(mut self) -> Lc {
        self.no_stub = true;
        self
    }
    fn no_witness(mut self) -> Lc {
        self.witness = false;
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
    if std::env::var("AH_DSA_DEBUG").is_ok() || o.status.code() == Some(70) {
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
            let text = if k.ends_with("app-archived.json") { regex::Regex::new(r#""mtimeMs":[0-9.]+"#).unwrap().replace_all(&text, r#""mtimeMs":0"#).into_owned() } else { text };
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
    let stub = fx.root.join("stub-bin").display().to_string();
    let key_db = |h: &Path| h.join(".anti-hall/devswarm/store").join(&fx.repo_key).join("devswarm.db");
    let (mut native, mut deferred) = (0, 0);
    let mut pending: Vec<(String, PathBuf)> = Vec::new();
    for (i, c) in cases.iter().enumerate() {
        if std::env::var("AH_DSA_FILTER").is_ok_and(|f| !c.name.contains(&f)) {
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
        let (pt, pn) = if c.no_stub { (tools.clone(), nonode.clone()) } else { (format!("{tools}:{stub}"), format!("{nonode}:{stub}")) };
        let (en, ee, ed) = (refs(&run_env(&homes[0], &pt)), refs(&run_env(&homes[1], &pt)), refs(&run_env(&homes[2], &pn)));
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
            for x in &c.expect {
                assert!(es.contains(x.as_str()), "{}: the answer lacks {x:?}: {es}", c.name);
            }
            if c.witness {
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
    eprintln!("dsA cli parity: {} cases, {native} answered by the engine and identical to Node, {deferred} deferred with nothing written", cases.len());
    if std::env::var("AH_DSA_FILTER").is_err() {
        assert!(native >= min_native && deferred >= min_deferred, "{native} native, {deferred} deferred");
    }
}

// ---- shared setup ----------------------------------------------------------------------------------------------------------

macro_rules! need_node {
    () => {
        if !node_sqlite_available() {
            eprintln!("SKIPPED: Node with node:sqlite is not available, so there is no Node to compare with");
            return;
        }
    };
}

#[allow(dead_code)]
fn node_first(h: &Path, cwd: &Path, argv: &[&str], now: i64) {
    let a: Vec<String> = argv.iter().map(|x| (*x).into()).collect();
    let r = node_cli(h, cwd, &a, now, &[]);
    assert_eq!(r.code, 0, "setup {argv:?}: {}", r.stdout);
}

fn dsroot(h: &Path) -> PathBuf {
    h.join(".anti-hall/devswarm")
}

/// A second linked worktree of the fixture's repository.
fn second_worktree(fx: &Fx, name: &str) -> PathBuf {
    let p = fx.root.join(name);
    gitout(&["worktree", "add", "-q", "-b", name, p.to_str().unwrap()], &fx.main);
    real(&p)
}

fn sqlite3_available() -> bool {
    Command::new("sqlite3").arg("-version").output().is_ok_and(|o| o.status.success())
}

/// The recording `hivecontrol` the PATH holds: it answers the capability probe, records every `workspace archive` call (working
/// directory and arguments) in `$HOME/hc-calls.log` and behaves as `HC_MODE` says; where it archives it flips the builder in the
/// app database `ANTIHALL_DEVSWARM_APP_DB` the way the real app does (`isActive = 0`, `isHidden = 1`).
const STUB: &str = r#"#!/bin/sh
mode="${HC_MODE:-ok}"
db="${ANTIHALL_DEVSWARM_APP_DB:-}"
case "$1" in
  --version) echo "hivecontrol ${HC_VERSION:-2.5.3}"; exit 0;;
  --help|-h) echo "Usage: hivecontrol [options] [command]"; exit 0;;
esac
if [ "$1" = workspace ]; then
  case "$2" in
    --help|-h)
      cat <<'EOT'
Usage: hivecontrol workspace [options] [command]

Workspace commands

Options:
  -h, --help               display help for command

Commands:
  list [options]           List workspaces
  info [idOrBranch]        Show a workspace
  create [options]         Create a workspace
  archive [idOrBranch]     Archive a workspace
  delete [idOrBranch]      Delete an archived workspace
  read-messages [options]  Read messages
  message-count [options]  Count messages
EOT
      exit 0;;
    archive)
      if [ "$3" = "--help" ] || [ "$3" = "-h" ]; then printf 'Usage: hivecontrol workspace archive [options] [idOrBranch]\n\nOptions:\n  -h, --help  display help\n'; exit 0; fi
      printf '%s\t%s\n' "$PWD" "$*" >> "$HOME/hc-calls.log"
      ref="$3"
      flip() { [ -n "$db" ] && sqlite3 "$db" "UPDATE builders SET isActive=0, isHidden=1 WHERE id='$1' OR branchName='$1';"; }
      case "$mode" in
        ok) flip "$ref"; echo '{"archived":true}'; exit 0;;
        branch-only) case "$ref" in br-*) flip "$ref"; echo '{"archived":true}';; *) echo '{}';; esac; exit 0;;
        noop) echo '{"archived":true}'; exit 0;;
        false) echo '{"archived":false,"why":"not today"}'; exit 0;;
        fail) echo "boom" >&2; exit 1;;
        flaky)
          if [ ! -f "$HOME/hc-flaky.mark" ]; then : > "$HOME/hc-flaky.mark"; echo "Could not confirm terminal process boundary" >&2; exit 1; fi
          flip "$ref"; echo '{"archived":true}'; exit 0;;
        flaky-always) echo "Could not confirm terminal t-1 stopped" >&2; exit 1;;
        side) flip "$ref"; sqlite3 "$db" "UPDATE builders SET isActive=0, isHidden=1 WHERE id='ar-sibling';"; echo '{"archived":true}'; exit 0;;
        signal) kill -KILL $$;;
      esac;;
  esac
fi
exit 0
"#;

/// The recording stub in `<root>/stub-bin`, and the capability caches Node writes for it (`2.5.3`, and `2.5.2` with the dormant
/// line Node records): `(current, old)` as file bytes.
fn install_stub(root: &Path) -> (Vec<u8>, Vec<u8>) {
    let dir = root.join("stub-bin");
    fs::create_dir_all(&dir).unwrap();
    // the stub runs with a PATH that holds only its own directory: it needs `cat` and `sqlite3` from there
    for tool in ["cat", "sqlite3"] {
        let out = Command::new("sh").args(["-c", &format!("command -v {tool}")]).output().unwrap();
        let src = String::from_utf8_lossy(&out.stdout).trim().to_string();
        if !src.is_empty() {
            std::os::unix::fs::symlink(&src, dir.join(tool)).ok();
        }
    }
    let bin = dir.join("hivecontrol");
    fs::write(&bin, STUB).unwrap();
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(&bin, fs::Permissions::from_mode(0o755)).unwrap();
    let make = |version: &str| -> Vec<u8> {
        let home = root.join(format!("capgen-{version}"));
        fs::create_dir_all(&home).unwrap();
        let caps = plugin_root().join("companion/lib/devswarm-capabilities.js");
        let js = format!(
            "const c=require({caps:?});const env={{PATH:{path:?},HC_VERSION:{version:?},HOME:{home:?}}};c.probe({{env,home:{home:?},fresh:true,now:1}});c.can('workspace.archive',{{env,home:{home:?}}});",
            caps = caps.display().to_string(),
            path = dir.display().to_string(),
            home = home.display().to_string(),
        );
        let o = Command::new("node").args(["-e", &js]).env_clear().env("PATH", std::env::var("PATH").unwrap()).env("HOME", &home).output().unwrap();
        assert!(o.status.success(), "capability probe failed: {}", String::from_utf8_lossy(&o.stderr));
        fs::read(home.join(".anti-hall/devswarm/capabilities.json")).unwrap()
    };
    (make("2.5.3"), make("2.5.2"))
}

fn put_caps(h: &Path, bytes: &[u8]) {
    let p = dsroot(h).join("capabilities.json");
    fs::create_dir_all(p.parent().unwrap()).unwrap();
    fs::write(p, bytes).unwrap();
}

/// A project workspace `id` at `wt`, registered by Node's own `register` (descriptor, registry row, summary).
fn reg(h: &Path, wt: &Path, id: &str) {
    node_first(h, wt, &["register", id, "--worktree", &wt.to_string_lossy(), "--session", &format!("s-{id}")], NOW - 5000);
}

/// The DevSwarm app's database as `{HOME}/app.db`.
fn builders(h: &Path, rows: &[(&str, &Path, i64, i64, &str)]) {
    let c = rusqlite::Connection::open(h.join("app.db")).unwrap();
    c.execute_batch(
        "CREATE TABLE builders (id TEXT, repositoryId TEXT, sourceBranch TEXT, branchName TEXT, worktreePath TEXT, terminalId TEXT, label TEXT, createdAt TEXT, lastAccessed TEXT, rank INTEGER, isHidden INTEGER, pullRequestId TEXT, builderType TEXT, isPinned INTEGER, isActive INTEGER, lastSelectedAt TEXT);
         CREATE TABLE builder_terminals (id TEXT, builderId TEXT, terminalId TEXT, terminalType TEXT, aiAgent TEXT, ai_session_config TEXT, isActive INTEGER, panelStatus TEXT, createdAt TEXT, lastViewedAt TEXT, initialPrompt TEXT, initialPromptDeliveredAt TEXT, initialPromptWithheldAt TEXT);
         CREATE TABLE pull_requests (id TEXT, repositoryId TEXT, branchName TEXT, number INTEGER, state TEXT, isDraft INTEGER, url TEXT, checkStatus TEXT, reviewStatus TEXT, lastSyncedAt TEXT);
         CREATE TABLE repositories (id TEXT, path TEXT, name TEXT, defaultBaseBranch TEXT);",
    )
    .unwrap();
    for (id, wt, hidden, active, kind) in rows {
        c.execute(
            "INSERT INTO builders (id, branchName, worktreePath, label, rank, isHidden, builderType, isPinned, isActive) VALUES (?, ?, ?, ?, 0, ?, ?, 0, ?)",
            rusqlite::params![id, format!("br-{id}"), wt.to_string_lossy(), format!("lbl-{id}"), hidden, kind, active],
        )
        .unwrap();
    }
}

fn heartbeat(h: &Path, id: &str, ts: i64) {
    put(h, &format!(".anti-hall/devswarm/heartbeats/{id}.json"), &format!("{{\"id\":\"{id}\",\"ts\":{ts}}}"));
}

// ---- archive -------------------------------------------------------------------------------------------------------------

/// Which test runs a case: the app leg, the cases Node must answer, or the local archive.
fn group_of(c: &Lc) -> &'static str {
    if c.name.starts_with("ar-app") {
        "app"
    } else if !c.native {
        "defer"
    } else {
        "local"
    }
}

fn archive_group(group: &'static str, tag: &str) {
    need_node!();
    let fx = fixture(tag);
    let (cases, extra) = archive_cases(&fx);
    let cases: Vec<Lc> = cases.into_iter().filter(|c| group_of(c) == group).collect();
    let n = cases.len();
    // the app group holds two cases Node may answer alone: a capability cache that is missing (Node probes and writes it) and, on a
    // Mac with the DevSwarm app installed, the app's own hivecontrol that the PATH does not hide
    let (native_min, deferred_min) = match group {
        "defer" => (0, n),
        "app" => (n - 2, 0),
        _ => (n, 0),
    };
    check(&fx, &cases, &extra, native_min, deferred_min);
}

#[test]
fn archive_local_matches_node() {
    archive_group("local", "dsaarch1");
}

#[test]
fn archive_deferrals_match_node() {
    archive_group("defer", "dsaarch2");
}

#[test]
fn archive_app_leg_matches_node() {
    archive_group("app", "dsaarch3");
}

fn archive_cases(fx: &Fx) -> (Vec<Lc>, Vec<(&'static str, PathBuf)>) {
    let have_sqlite = sqlite3_available();
    let (caps, caps_old) = install_stub(&fx.root);
    let wt2 = second_worktree(fx, "wt-two");
    let extra: Vec<(&str, PathBuf)> = vec![("wt2", wt2.clone())];
    let app = ("ANTIHALL_DEVSWARM_APP_DB", "{HOME}/app.db");
    let a = |name: &str, argv: &[&str], cwd: &'static str, native: bool| lc(name, argv, cwd, native, "Archive").no_witness();
    // a registered, clean workspace `ar-1` at the second worktree, the app holding it open as a child builder
    let base = {
        let (w, c) = (wt2.clone(), caps.clone());
        move |h: &Path| {
            reg(h, &w, "ar-1");
            put_caps(h, &c);
        }
    };
    let with_app = {
        let (w, b) = (wt2.clone(), base.clone());
        move |h: &Path| {
            b(h);
            builders(h, &[("ar-1", &w, 0, 1, "child")]);
        }
    };
    let app_case = |name: &str, mode: &'static str, native: bool| {
        a(name, &["archive", "ar-1"], "main", native).env(app.0, app.1).env("HC_MODE", mode).setup(with_app.clone())
    };
    let sql = have_sqlite;
    let real_hivecontrol = defaults_known_locations().iter().any(|p| Path::new(p).is_file());
    let (w1, w2, w3, w4, w5) = (wt2.clone(), wt2.clone(), wt2.clone(), wt2.clone(), wt2.clone());
    let b1 = base.clone();
    let b2 = base.clone();
    let b3 = base.clone();
    let b4 = base.clone();
    let (b5, b6, b7, b8, b9) = (base.clone(), base.clone(), base.clone(), base.clone(), base.clone());
    let old = caps_old.clone();
    let key = fx.repo_key.clone();
    let cases = vec![
        // ---- the local half only: the app database is off ----
        a("ar-local-only", &["archive", "ar-1"], "main", true).setup(base.clone()).expect(&["\"descriptorArchived\":true", "app DB unreadable"]),
        a("ar-from-the-workspace-itself", &["archive", "ar-1"], "wt2", true).setup(base.clone()),
        a("ar-no-id", &["archive"], "main", true),
        a("ar-empty-id", &["archive", ""], "main", true),
        a("ar-unsafe-id-is-node", &["archive", "../x"], "main", false),
        a("ar-unknown-id-is-node", &["archive", "ar-nothing"], "main", false),
        a("ar-prefix-is-node", &["archive", "ar-"], "main", false).setup(base.clone()),
        a("ar-force-cross-project-is-node", &["archive", "ar-1", "--force-cross-project", "ar-1"], "main", false).setup(base.clone()),
        a("ar-outside-a-project-is-node", &["archive", "ar-1"], "nongit", false).setup(base.clone()),
        a("ar-another-project-is-node", &["archive", "ar-1"], "other", false).setup(base.clone()),
        a("ar-twice-the-second-is-node", &["archive", "ar-1"], "main", false).setup(move |h| {
            b1(h);
            let a: Vec<String> = vec!["archive".into(), "ar-1".into()];
            let r = node_cli(h, &w1.parent().unwrap().join("repo"), &a, NOW - 100, &[]);
            assert_eq!(r.code, 0, "{}", r.stdout);
        }),
        a("ar-unread-mail-is-node", &["archive", "child-1"], "child", false),
        a("ar-descriptor-without-an-owner-key-is-node", &["archive", "ar-1"], "main", false).setup(move |h| {
            b2(h);
            let p = dsroot(h).join("workspaces/ar-1.json");
            let t = fs::read_to_string(&p).unwrap();
            let mut v: Value = serde_json::from_str(&t).unwrap();
            v.as_object_mut().unwrap().remove("ownerKey");
            v.as_object_mut().unwrap().remove("repoKey");
            fs::write(p, serde_json::to_string(&v).unwrap()).unwrap();
        }),
        a("ar-hash-bucket-descriptor-is-node", &["archive", "ar-1"], "main", false).setup(move |h| {
            b3(h);
            let p = dsroot(h).join("workspaces/ar-1.json");
            let mut v: Value = serde_json::from_str(&fs::read_to_string(&p).unwrap()).unwrap();
            v["ownerKey"] = Value::String(hash8("ar-1"));
            fs::write(p, serde_json::to_string(&v).unwrap()).unwrap();
        }),
        a("ar-existing-archived-marker-is-node", &["archive", "ar-1"], "main", false).setup(move |h| {
            b4(h);
            put(h, ".anti-hall/devswarm/archived/ar-1.json", "{\"id\":\"ar-1\"}");
        }),
        a("ar-no-archived-directory-is-node", &["archive", "ar-1"], "main", false).setup(move |h| {
            b5(h);
            fs::remove_dir_all(dsroot(h).join("archived")).unwrap();
        }),
        a("ar-identity-twin-is-node", &["archive", "ar-1"], "main", false).setup(move |h| {
            b6(h);
            put(
                h,
                ".anti-hall/devswarm/workspaces/ar-twin.json",
                &format!("{{\"id\":\"ar-twin\",\"worktreePath\":\"{}\",\"sessionId\":\"ar-1\",\"ownerKey\":\"{}\"}}", w2.display(), "K"),
            );
        }),
        a("ar-already-archived-descriptor-is-node", &["archive", "ar-gone"], "main", false).setup(move |h| {
            b7(h);
            put(h, ".anti-hall/devswarm/archived/ar-gone.json", "{\"id\":\"ar-gone\"}");
        }),
        a("ar-recovery-intent-dir-is-created", &["archive", "ar-1"], "main", true).setup(base.clone()),
        a("ar-live-child-warning", &["archive", "ar-1"], "main", true)
            .setup(move |h| {
                b8(h);
                heartbeat(h, "ar-1", NOW - 1000);
            })
            .expect(&["child session still live for ar-1"]),
        a("ar-stale-heartbeat-no-warning", &["archive", "ar-1"], "main", true).setup(move |h| {
            b9(h);
            heartbeat(h, "ar-1", NOW - 1_000_000_000);
        }),
        // ---- the app leg ----
        a("ar-app-has-no-such-builder", &["archive", "ar-1"], "main", true)
            .env(app.0, app.1)
            .setup({
                let (b, w) = (base.clone(), wt2.clone());
                move |h| {
                    b(h);
                    builders(h, &[("other-builder", &w, 0, 1, "child")]);
                }
            })
            .expect(&["no app builder with this exact id"]),
        a("ar-app-builder-is-primary", &["archive", "ar-1"], "main", true)
            .env(app.0, app.1)
            .setup({
                let (b, w) = (base.clone(), w3.clone());
                move |h| {
                    b(h);
                    builders(h, &[("ar-1", &w, 0, 1, "primary")]);
                }
            })
            .expect(&["primary builder"]),
        a("ar-app-builder-type-unknown", &["archive", "ar-1"], "main", true)
            .env(app.0, app.1)
            .setup({
                let (b, w) = (base.clone(), w4.clone());
                move |h| {
                    b(h);
                    builders(h, &[("ar-1", &w, 0, 1, "")]);
                }
            })
            .expect(&["app builderType unknown"]),
        a("ar-app-builder-already-archived", &["archive", "ar-1"], "main", true)
            .env(app.0, app.1)
            .setup({
                let (b, w) = (base.clone(), w5.clone());
                move |h| {
                    b(h);
                    builders(h, &[("ar-1", &w, 1, 0, "child")]);
                }
            })
            .expect(&["already archived"]),
        // on a Mac with the DevSwarm app installed Node finds the app's own hivecontrol at its known location: the engine must
        // not guess what that binary's capability probe says
        a("ar-app-hivecontrol-absent", &["archive", "ar-1"], "main", !real_hivecontrol).env(app.0, app.1).no_stub().setup(with_app.clone()),
        a("ar-app-capability-cache-missing-is-node", &["archive", "ar-1"], "main", false).env(app.0, app.1).setup({
            let w = wt2.clone();
            let b = base.clone();
            move |h| {
                b(h);
                fs::remove_file(dsroot(h).join("capabilities.json")).unwrap();
                builders(h, &[("ar-1", &w, 0, 1, "child")]);
            }
        }),
        a("ar-app-old-build-is-dormant", &["archive", "ar-1"], "main", true)
            .env(app.0, app.1)
            .setup({
                let w = wt2.clone();
                let b = base.clone();
                move |h| {
                    b(h);
                    put_caps(h, &old);
                    builders(h, &[("ar-1", &w, 0, 1, "child")]);
                }
            })
            .expect(&["requires DevSwarm >= 2.5.3 (have 2.5.2)"]),
    ];
    // the cases that need the stub to flip the app database
    let mut cases = cases;
    if sql {
        cases.extend(vec![
            app_case("ar-app-archived-by-id", "ok", true).expect(&["\"via\":\"id\"", "verified"]),
            app_case("ar-app-flaky-first-call-is-retried", "flaky", true).expect(&["succeeded on retry"]),
            app_case("ar-app-flaky-twice-fails-retried", "flaky-always", true).expect(&["\"retried\":true", "NOT verified"]),
            app_case("ar-app-answers-archived-false", "false", true).expect(&["hivecontrol reported archived:false"]),
            app_case("ar-app-exits-non-zero", "fail", true).expect(&["exited 1: boom"]),
            app_case("ar-app-killed-by-a-signal", "signal", true).expect(&["killed by signal SIGKILL"]),
            app_case("ar-app-accepts-the-id-without-effect-and-the-branch-works", "branch-only", true).expect(&["\"via\":\"branch\""]),
            app_case("ar-app-claims-archived-but-the-database-says-open", "noop", true).expect(&["still lists the workspace open"]),
            app_case("ar-app-side-effect-on-another-builder", "side", true)
                .setup({
                    let (b, w) = (base.clone(), wt2.clone());
                    move |h| {
                        b(h);
                        builders(h, &[("ar-1", &w, 0, 1, "child"), ("ar-sibling", &w, 0, 1, "child")]);
                    }
                })
                .expect(&["APP SIDE EFFECT"]),
            app_case("ar-app-branch-fallback-skipped-when-shared", "noop", true)
                .setup({
                    let (b, w) = (base.clone(), wt2.clone());
                    move |h| {
                        b(h);
                        builders(h, &[("ar-1", &w, 0, 1, "child")]);
                        let c = rusqlite::Connection::open(h.join("app.db")).unwrap();
                        c.execute("INSERT INTO builders (id, branchName, builderType, isActive, isHidden) VALUES ('ar-dup', 'br-ar-1', 'child', 1, 0)", [])
                            .unwrap();
                    }
                })
                .expect(&["branch fallback skipped: branch name is shared by 2 builders"]),
            app_case("ar-app-worktree-gone-cannot-start-the-call", "ok", true)
                .setup({
                    let (b, w) = (base.clone(), wt2.clone());
                    move |h| {
                        b(h);
                        builders(h, &[("ar-1", &w, 0, 1, "child")]);
                        let p = dsroot(h).join("workspaces/ar-1.json");
                        let mut v: Value = serde_json::from_str(&fs::read_to_string(&p).unwrap()).unwrap();
                        v["worktreePath"] = Value::String("/nonexistent/dsa-wt-gone".into());
                        fs::write(p, serde_json::to_string(&v).unwrap()).unwrap();
                    }
                })
                .expect(&["spawnSync hivecontrol ENOENT"]),
            app_case("ar-app-live-child-warning-kept-when-the-app-knows-it", "ok", true)
                .setup({
                    let (b, w) = (base.clone(), wt2.clone());
                    move |h| {
                        b(h);
                        builders(h, &[("ar-1", &w, 0, 1, "child")]);
                        heartbeat(h, "ar-1", NOW - 1000);
                    }
                })
                .expect(&["child session still live"]),
        ]);
    } else {
        eprintln!("SKIPPED the app-archive cases that flip the database: no sqlite3 on the PATH");
    }
    let _ = key;
    (cases, extra)
}

/// The places Node looks for the app's own `hivecontrol` after the PATH and the saved path.
fn defaults_known_locations() -> Vec<String> {
    vec!["/Applications/DevSwarm.app/Contents/Resources/cli/hivecontrol".to_string()]
}

fn hash8(id: &str) -> String {
    let o = Command::new("node")
        .args(["-e", "process.stdout.write(require('crypto').createHash('sha256').update(process.argv[1]).digest('hex').slice(0,8))", id])
        .output()
        .unwrap();
    String::from_utf8_lossy(&o.stdout).to_string()
}

// ---- register-primary ----------------------------------------------------------------------------------------------------

#[test]
fn register_primary_matches_node() {
    need_node!();
    let fx = fixture("dsaregprim");
    let child = fx.child.clone();
    let app = ("ANTIHALL_DEVSWARM_APP_DB", "{HOME}/app.db");
    let r = |name: &str, argv: &[&str], cwd: &'static str, native: bool| lc(name, argv, cwd, native, "RegisterPrimary");
    let session_alive = |h: &Path, sid: &str| {
        put(h, &format!(".claude/sessions/{sid}.json"), &format!("{{\"sessionId\":\"{sid}\",\"pid\":{}}}", std::process::id()));
    };
    let c1 = child.clone();
    let c2 = child.clone();
    let c3 = child.clone();
    let main = fx.main.clone();
    let m2 = main.clone();
    let cases = vec![
        r("rp-explicit-session", &["register-primary", "--session", "s-new"], "main", true),
        r("rp-session-from-the-environment", &["register-primary"], "main", true).env("CLAUDE_CODE_SESSION_ID", "s-env"),
        r("rp-session-from-the-builder-id", &["register-primary"], "main", true).env("DEVSWARM_BUILDER_ID", "b-1"),
        r("rp-session-falls-to-the-id", &["register-primary"], "main", true),
        r("rp-from-a-child-worktree", &["register-primary", "--session", "s-c"], "child", true),
        r("rp-worktree-flag", &["register-primary", "--worktree", &child.to_string_lossy(), "--session", "s-w"], "main", true),
        r("rp-cursor-and-inbox-flags", &["register-primary", "--session", "s-x", "--cursor", "{HOME}/cur.json", "--inbox", "{HOME}/in.ndjson"], "main", true),
        r("rp-update-over-an-existing-descriptor", &["register-primary", "--session", "s-second"], "main", true).setup(move |h| {
            let a: Vec<String> = vec!["register-primary".into(), "--session".into(), "s-first".into()];
            let x = node_cli(h, &main, &a, NOW - 2000, &[]);
            assert_eq!(x.code, 0, "{}", x.stdout);
        }),
        r("rp-outside-a-git-worktree", &["register-primary"], "nongit", true),
        r("rp-another-project-is-node", &["register-primary", "--session", "s-o"], "other", false),
        r("rp-child-builder-is-refused", &["register-primary", "--session", "s-b"], "child", true).env(app.0, app.1).setup(move |h| builders(h, &[("cb-1", &c1, 0, 1, "child")])),
        r("rp-child-builder-with-force", &["register-primary", "--session", "s-b", "--force"], "child", true).env(app.0, app.1).setup(move |h| builders(h, &[("cb-1", &c2, 0, 1, "child")])),
        r("rp-primary-builder-registers", &["register-primary", "--session", "s-b"], "main", true).env(app.0, app.1).setup({
            let m = fx.main.clone();
            move |h| builders(h, &[("pb-1", &m, 0, 1, "primary")])
        }),
        r("rp-live-holder-is-refused", &["register-primary", "--session", "s-intruder"], "main", true).setup(move |h| session_alive(h, "sess-primary")),
        r("rp-live-holder-with-force", &["register-primary", "--session", "s-intruder", "--force"], "main", true).setup(move |h| session_alive(h, "sess-primary")),
        r("rp-live-holder-same-session-registers", &["register-primary", "--session", "sess-primary"], "main", true).setup(move |h| session_alive(h, "sess-primary")),
        r("rp-live-holder-with-an-app-database-is-node", &["register-primary", "--session", "s-intruder"], "main", false)
            .env(app.0, app.1)
            .setup(move |h| {
                session_alive(h, "sess-primary");
                builders(h, &[("pb-1", &m2, 0, 1, "primary")]);
            }),
        r("rp-child-environment-is-node", &["register-primary", "--session", "s-e"], "main", false).env("DEVSWARM_SOURCE_BRANCH", "feat"),
        r("rp-empty-session-flag-is-node", &["register-primary", "--session", ""], "main", false),
        r("rp-archived-child-builder-is-refused-too", &["register-primary", "--session", "s-a"], "child", true).env(app.0, app.1).setup(move |h| builders(h, &[("ab-1", &c3, 1, 0, "child")])),
    ];
    check(&fx, &cases, &[], 16, 3);
}

// ---- diagnose / healthcheck ----------------------------------------------------------------------------------------------

/// A registry row of the project's store: (id, worktree, session, updated_at).
fn registry_row(h: &Path, key: &str, id: &str, wt: &str, session: Option<&str>) {
    let db = dsroot(h).join("store").join(key).join("devswarm.db");
    let c = rusqlite::Connection::open(db).unwrap();
    c.execute(
        "INSERT INTO registry (id, worktree_path, session_id, inbox_path, cursor_path, nudge_command, updated_at, write_seq) VALUES (?, ?, ?, NULL, NULL, NULL, ?, 1)",
        rusqlite::params![id, wt, session, NOW - 60_000],
    )
    .unwrap();
}

fn orphan_mail(h: &Path, key: &str, partition: &str) {
    let db = dsroot(h).join("store").join(key).join("devswarm.db");
    let c = rusqlite::Connection::open(db).unwrap();
    c.execute(
        "INSERT INTO messages (workspace_id, ts, hash, body, sender, recipient, mtype, urgency, is_heartbeat, needs_reply, orig_hash, instance_nonce, seq) VALUES (?, ?, 'mesh:orph', 'lost', 'x', ?, 'direct', 'low', 0, 0, NULL, NULL, (SELECT COALESCE(MAX(seq),0)+1 FROM messages))",
        rusqlite::params![partition, NOW - 1000, partition],
    )
    .unwrap();
}

#[test]
fn diagnose_and_healthcheck_match_node() {
    need_node!();
    let fx = fixture("dsadiag");
    let key = fx.repo_key.clone();
    let (child, main) = (fx.child.to_string_lossy().to_string(), fx.main.to_string_lossy().to_string());
    let app = ("ANTIHALL_DEVSWARM_APP_DB", "{HOME}/app.db");
    let d = |name: &str, argv: &[&str], cwd: &'static str, native: bool| lc(name, argv, cwd, native, "Diagnose");
    let hc = |name: &str, argv: &[&str], cwd: &'static str, native: bool| lc(name, argv, cwd, native, "Healthcheck");
    // a second registry row on the child worktree: a partitioned mesh id
    let twin = {
        let (k, c) = (key.clone(), child.clone());
        move |h: &Path, sid: Option<&str>| registry_row(h, &k, "child-twin", &c, sid)
    };
    let fresh = |h: &Path, id: &str| heartbeat(h, id, NOW - 1000);
    let mut cases: Vec<Lc> = Vec::new();
    for (verb, mk) in [("diagnose", 0), ("healthcheck", 1)] {
        let m = |name: &str, extra: &[&str], cwd: &'static str, native: bool| {
            let mut argv = vec![verb];
            argv.extend_from_slice(extra);
            let nm = format!("{verb}-{name}");
            if mk == 0 { d(&nm, &argv, cwd, native) } else { hc(&nm, &argv, cwd, native) }
        };
        let (t1, t2, t3, t4) = (twin.clone(), twin.clone(), twin.clone(), twin.clone());
        let k = key.clone();
        let k2 = key.clone();
        let (c1, c2) = (child.clone(), child.clone());
        cases.extend(vec![
            m("seed-human", &[], "main", true),
            m("seed-json", &["--json"], "main", true),
            m("from-a-child", &["--json"], "child", true),
            m("outside-a-project-human", &[], "nongit", true),
            m("outside-a-project-json", &["--json"], "nongit", true),
            m("project-without-a-store", &["--json"], "other", false),
            m("fresh-heartbeat-makes-a-row-live", &["--json"], "main", true).setup(move |h| fresh(h, "child-1")),
            m("all-quiet-heartbeats", &["--json"], "main", true).setup(move |h| {
                for id in ["child-1", "child-2"] {
                    heartbeat(h, id, NOW - 1000);
                }
            }),
            m("live-split", &["--json"], "main", true).setup(move |h| {
                t1(h, Some("s-twin"));
                heartbeat(h, "child-1", NOW - 1000);
                heartbeat(h, "child-twin", NOW - 1000);
            }),
            m("mixed-split", &["--json"], "main", true).setup(move |h| {
                t2(h, Some("s-twin"));
                heartbeat(h, "child-1", NOW - 1000);
            }),
            m("mixed-split-human", &[], "main", true).setup({
                let c = c1.clone();
                let k = k.clone();
                move |h| {
                    registry_row(h, &k, "child-twin", &c, Some("s-twin"));
                    heartbeat(h, "child-1", NOW - 1000);
                }
            }),
            m("dead-split", &["--json"], "main", true).setup(move |h| {
                t3(h, Some("unclaimed:x"));
                heartbeat(h, "child-1", NOW - 1_000_000_000);
            }),
            m("dead-split-human", &[], "main", true).setup(move |h| t4(h, None)),
            m("descriptor-session-fills-a-synthetic-registry-one", &["--json"], "main", true).setup({
                let (k, c) = (k2.clone(), c2.clone());
                move |h| {
                    registry_row(h, &k, "desc-only", &c, Some("unclaimed:desc-only"));
                    put(h, ".anti-hall/devswarm/workspaces/desc-only.json", &format!("{{\"id\":\"desc-only\",\"worktreePath\":\"{c}\",\"sessionId\":\"real-session\"}}"));
                }
            }),
            m("an-orphan-partition-is-node", &["--json"], "main", false).setup({
                let k = key.clone();
                move |h| orphan_mail(h, &k, "nobody-home")
            }),
            m("app-archived-row", &["--json"], "main", true).env(app.0, app.1).setup({
                let c = child.clone();
                move |h| builders(h, &[("child-1", Path::new(&c), 1, 0, "child")])
            }),
            m("app-open-row", &["--json"], "main", true).env(app.0, app.1).setup({
                let c = child.clone();
                move |h| builders(h, &[("child-1", Path::new(&c), 0, 1, "child")])
            }),
            m("another-primary-checkout-row", &["--json"], "main", true).setup({
                let (k, mw) = (key.clone(), main.clone());
                move |h| registry_row(h, &k, "primary-extra", &mw, Some("s-extra"))
            }),
        ]);
    }
    for c in &mut cases {
        c.witness = true;
    }
    check(&fx, &cases, &[], 28, 4);
}
