//! Node-vs-engine parity of the operator commands `update` and `install-codex` (D81, lane L9b).
//!
//! Each scenario builds two identical, isolated worlds under the temp dir: a scratch home with a marketplace clone (a real git
//! clone of a local bare "origin", so `git pull`/`fetch` run for real and never leave the machine), a cache root, a registry
//! file and a fake `claude` binary on the PATH. The real Node script runs in one, the engine command in the other, with an
//! empty environment (`HOME` at the scratch home, `ANTIHALL_INGEST_DRY_RUN=1`). The exit code, stdout and every file under the
//! home (path, mode, content) are compared; the fixture's own directory and the clock are masked.
//!
//! Stderr is compared without the `[update] <stage>` progress lines: the engine prints that line for the stage it runs itself
//! (the harness registration) and the Node parent for every stage it runs in-process; the engine runs those stages in the
//! plugin's own `update.js --post-pull-only` child, whose stderr is captured.
#![allow(clippy::unwrap_used, clippy::expect_used)] // a test crate: a panic is the failure report, and E2 exempts tests
use std::collections::BTreeMap;
use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicUsize, Ordering};

static N: AtomicUsize = AtomicUsize::new(0);
const V1: &str = "0.1.0";
const V2: &str = "0.2.0";

fn repo() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap().to_path_buf()
}

fn plugin() -> PathBuf {
    repo().join("plugins/anti-hall")
}

fn sh(dir: &Path, prog: &str, args: &[&str]) -> String {
    let o = Command::new(prog)
        .args(args)
        .current_dir(dir)
        .env("GIT_AUTHOR_NAME", "t")
        .env("GIT_AUTHOR_EMAIL", "t@t")
        .env("GIT_COMMITTER_NAME", "t")
        .env("GIT_COMMITTER_EMAIL", "t@t")
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .env("GIT_CONFIG_SYSTEM", "/dev/null")
        .output()
        .unwrap();
    assert!(o.status.success(), "{prog} {args:?}: {}", String::from_utf8_lossy(&o.stderr));
    String::from_utf8_lossy(&o.stdout).into_owned()
}

fn put(base: &Path, rel: &str, content: impl AsRef<[u8]>) {
    let p = base.join(rel);
    fs::create_dir_all(p.parent().unwrap()).unwrap();
    fs::write(p, content).unwrap();
}

fn manifest(version: &str) -> String {
    let src = fs::read_to_string(plugin().join(".claude-plugin/plugin.json")).unwrap();
    let mut v: serde_json::Value = serde_json::from_str(&src).unwrap();
    v["version"] = serde_json::Value::String(version.into());
    serde_json::to_string_pretty(&v).unwrap()
}

fn changelog(top: &str) -> String {
    let mut s = String::from("# Changelog\n\npreamble\n\n");
    if top == V2 {
        s.push_str("## 0.2.0 - second\n\n- added the second thing\n- fixed `x`\n\n");
    }
    s.push_str("## 0.1.0 - first\n\n- the first thing\n");
    s
}

/// What a scenario changes in the standard world.
#[derive(Clone, Default)]
struct Opt {
    /// `claude` exits non-zero with this on stderr.
    claude_fails: bool,
    /// `claude` prints a confirmation request.
    claude_confirms: bool,
    /// Origin does not move (the clone is already at the latest).
    no_upstream_move: bool,
    /// A local change in the clone.
    dirty: bool,
    /// A local commit the origin does not have, plus an origin commit: diverged.
    diverged: bool,
    /// The origin is gone.
    offline: bool,
    /// git cannot resolve the remote host (a shim on the PATH answers pull and fetch like that).
    net_down: bool,
    /// No cache directory, no registry file.
    unknown_installed: bool,
    /// The registry says this while the cache says V1.
    registry: Option<&'static str>,
    /// An invalid `ANTIHALL_MARKETPLACE_DIR`.
    bad_override: bool,
    /// No cache root at all.
    no_cache_root: bool,
    /// A DevSwarm session (`DEVSWARM_REPO_ID` set): the DevSwarm-only stages are not gated off.
    ds: bool,
    /// Every one-time stage already stamped complete for the version the update lands on.
    markers: bool,
    /// `ANTIHALL_UPDATE_POSTPULL_BUDGET_MS`.
    budget: Option<&'static str>,
}

struct World {
    root: PathBuf,
    home: PathBuf,
    mp: PathBuf,
    bin: PathBuf,
}

impl Drop for World {
    fn drop(&mut self) {
        if let Err(e) = fs::remove_dir_all(&self.root) {
            eprintln!("could not remove {}: {e}", self.root.display());
        }
    }
}

fn world(o: &Opt) -> World {
    let root = std::env::temp_dir().join(format!("ah-operator-parity-{}-{}", std::process::id(), N.fetch_add(1, Ordering::Relaxed)));
    let (home, bin, origin, seed) = (root.join("home"), root.join("bin"), root.join("origin.git"), root.join("seed"));
    for d in [&home, &bin, &seed] {
        fs::create_dir_all(d).unwrap();
    }
    assert!(home.starts_with(std::env::temp_dir()), "a fixture home is always under the temp dir");
    sh(&root, "git", &["init", "--bare", "-q", "-b", "main", origin.to_str().unwrap()]);
    sh(&seed, "git", &["init", "-q", "-b", "main"]);
    let dst = seed.join("plugins");
    fs::create_dir_all(&dst).unwrap();
    sh(&root, "cp", &["-R", plugin().to_str().unwrap(), dst.join("anti-hall").to_str().unwrap()]);
    put(&seed, "plugins/anti-hall/.claude-plugin/plugin.json", manifest(if o.unknown_installed { "dev" } else { V1 }));
    put(&seed, "CHANGELOG.md", changelog(V1));
    sh(&seed, "git", &["add", "-A"]);
    sh(&seed, "git", &["commit", "-q", "-m", "v1"]);
    sh(&seed, "git", &["remote", "add", "origin", origin.to_str().unwrap()]);
    sh(&seed, "git", &["push", "-q", "origin", "main"]);
    let mp = home.join(".claude/plugins/marketplaces/anti-hall");
    fs::create_dir_all(mp.parent().unwrap()).unwrap();
    sh(&root, "git", &["clone", "-q", origin.to_str().unwrap(), mp.to_str().unwrap()]);
    if !o.no_upstream_move {
        put(&seed, "plugins/anti-hall/.claude-plugin/plugin.json", manifest(V2));
        put(&seed, "CHANGELOG.md", changelog(V2));
        sh(&seed, "git", &["commit", "-q", "-am", "v2"]);
        sh(&seed, "git", &["push", "-q", "origin", "main"]);
    }
    if o.diverged {
        put(&mp, "LOCAL.txt", "local");
        sh(&mp, "git", &["add", "LOCAL.txt"]);
        sh(&mp, "git", &["commit", "-q", "-m", "local"]);
    }
    if o.dirty {
        put(&mp, "DIRTY.txt", "dirty");
    }
    if o.offline {
        fs::rename(&origin, root.join("origin-gone.git")).unwrap();
    }
    let plugins = home.join(".claude/plugins");
    if !o.unknown_installed {
        if !o.no_cache_root {
            put(&plugins, &format!("cache/anti-hall/anti-hall/{V1}/marker.txt"), "v1");
        }
        let reg = o.registry.unwrap_or(V1);
        put(
            &plugins,
            "installed_plugins.json",
            format!(r#"{{"version":2,"plugins":{{"anti-hall@anti-hall":[{{"scope":"user","installPath":"x","version":"{reg}"}}]}}}}"#),
        );
    }
    if o.markers {
        let v = if o.no_upstream_move { V1 } else { V2 };
        let keys = defaults_keys();
        let body: Vec<String> = keys.iter().map(|k| format!(r#""{k}":{{"completedVersion":"{v}"}}"#)).collect();
        put(&home, ".anti-hall/update-sweep-state.json", format!("{{{}}}", body.join(",")));
    }
    let claude = if o.claude_fails {
        "#!/bin/sh\necho 'boom: registry locked' >&2\nexit 3\n"
    } else if o.claude_confirms {
        "#!/bin/sh\necho 'needs --accept-command abc123'\nexit 0\n"
    } else {
        "#!/bin/sh\necho registered\nexit 0\n"
    };
    if o.net_down {
        let real = sh(&root, "sh", &["-c", "command -v git"]);
        let shim = format!(
            "#!/bin/sh\ncase \"$1\" in pull|fetch) echo \"fatal: unable to access 'https://x.invalid/': Could not resolve host: x.invalid\" >&2; exit 128;; esac\nexec {} \"$@\"\n",
            real.trim()
        );
        put(&bin, "git", shim);
        fs::set_permissions(bin.join("git"), fs::Permissions::from_mode(0o755)).unwrap();
    }
    put(&bin, "claude", claude);
    fs::set_permissions(bin.join("claude"), fs::Permissions::from_mode(0o755)).unwrap();
    World { root, home, mp, bin }
}

struct Out {
    stdout: String,
    stderr: String,
    code: i32,
}

fn envs(cmd: &mut Command, w: &World, o: &Opt) {
    let path = format!("{}:{}", w.bin.display(), std::env::var("PATH").unwrap());
    cmd.env_clear().env("PATH", path).env("HOME", &w.home).env("ANTIHALL_INGEST_DRY_RUN", "1").env("GIT_CONFIG_GLOBAL", "/dev/null");
    let ov = if o.bad_override { w.root.join("nope").to_string_lossy().into_owned() } else { w.mp.to_string_lossy().into_owned() };
    cmd.env("ANTIHALL_MARKETPLACE_DIR", ov);
    if o.ds {
        cmd.env("DEVSWARM_REPO_ID", "repo-parity").env("DEVSWARM_WORKSPACE_ID", "ws-parity");
    }
    if let Some(b) = o.budget {
        cmd.env("ANTIHALL_UPDATE_POSTPULL_BUDGET_MS", b);
    }
}

/// The update-sweep-state keys of the one-time stages, from the shipped stage table.
fn defaults_keys() -> Vec<String> {
    let text = fs::read_to_string(plugin().join("engine/defaults/update_post.toml")).unwrap();
    let re = regex::Regex::new(r#"state = \[([^\]]*)\]"#).unwrap();
    let mut keys: Vec<String> = re
        .captures_iter(&text)
        .flat_map(|c| c[1].split(',').map(|k| k.trim().trim_matches('"').to_string()).filter(|k| !k.is_empty()).collect::<Vec<_>>())
        .collect();
    keys.sort();
    keys.dedup();
    keys
}

fn finish(o: std::process::Output) -> Out {
    Out {
        stdout: String::from_utf8_lossy(&o.stdout).into_owned(),
        stderr: String::from_utf8_lossy(&o.stderr).into_owned(),
        code: o.status.code().unwrap_or(-1),
    }
}

fn run_node(w: &World, o: &Opt, args: &[&str]) -> Out {
    let mut cmd = Command::new("node");
    cmd.arg(plugin().join("skills/update/scripts/update.js")).args(args).current_dir(&w.home);
    envs(&mut cmd, w, o);
    finish(cmd.output().unwrap())
}

fn run_engine(w: &World, o: &Opt, args: &[&str]) -> Out {
    let mut cmd = Command::new(env!("CARGO_BIN_EXE_ah-engine"));
    cmd.arg("update").args(args).current_dir(&w.home);
    envs(&mut cmd, w, o);
    finish(cmd.output().unwrap())
}

fn norm(text: &str, w: &World) -> String {
    let canon = fs::canonicalize(&w.root).unwrap();
    text.replace(canon.to_string_lossy().as_ref(), "{ROOT}").replace(w.root.to_string_lossy().as_ref(), "{ROOT}")
}

fn clock(text: &str) -> String {
    let re = regex::Regex::new(r#"("completedTs"|"at"|"ts"|"startedAt"|"lastRun"|"time"):\s*\d{10,}"#).unwrap();
    let re2 = regex::Regex::new(r"\.corrupt-\d+|\.bak-[0-9TZ-]+").unwrap();
    let re3 = regex::Regex::new(r#""ts":"[0-9T:.Z-]+"|"pid":\d+"#).unwrap();
    re3.replace_all(&re2.replace_all(&re.replace_all(text, r#"$1:0"#), ".X"), "\"X\":0").into_owned()
}

fn tree(root: &Path) -> BTreeMap<String, String> {
    fn walk(base: &Path, dir: &Path, out: &mut BTreeMap<String, String>) {
        let Ok(rd) = fs::read_dir(dir) else { return };
        for e in rd.flatten() {
            let p = e.path();
            let rel = p.strip_prefix(base).unwrap().to_string_lossy().into_owned();
            if rel.starts_with(".anti-hall/ah-engine") || rel.contains("/.git/") || rel.ends_with("/.git") {
                continue; // the engine's own telemetry; git's object store (shas differ between worlds)
            }
            let meta = fs::symlink_metadata(&p).unwrap();
            if meta.is_dir() {
                out.insert(format!("{rel}/"), format!("{:o}", meta.permissions().mode() & 0o777));
                walk(base, &p, out);
            } else if meta.file_type().is_symlink() {
                out.insert(rel, format!("-> {}", fs::read_link(&p).unwrap().display()));
            } else {
                let text = String::from_utf8_lossy(&fs::read(&p).unwrap_or_default()).into_owned();
                out.insert(clock(&rel), format!("{:o} {}", meta.permissions().mode() & 0o777, clock(&text)));
            }
        }
    }
    let mut out = BTreeMap::new();
    walk(root, root, &mut out);
    if !out.keys().any(|k| k.starts_with(".anti-hall/") && k != ".anti-hall/") {
        out.remove(".anti-hall/");
    }
    out
}

fn no_progress(stderr: &str) -> String {
    stderr.lines().filter(|l| !l.starts_with("[update] ")).collect::<Vec<_>>().join("\n")
}

fn assert_same(name: &str, what: &str, node: &str, engine: &str) {
    if node == engine {
        return;
    }
    if let (Ok(serde_json::Value::Object(n)), Ok(serde_json::Value::Object(e))) =
        (serde_json::from_str(node.lines().next().unwrap_or("")), serde_json::from_str(engine.lines().next().unwrap_or("")))
    {
        let keys: std::collections::BTreeSet<&String> = n.keys().chain(e.keys()).collect();
        for k in keys {
            assert_eq!(n.get(k), e.get(k), "{name}: status key {k} differs");
        }
        assert_eq!(n.keys().collect::<Vec<_>>(), e.keys().collect::<Vec<_>>(), "{name}: status key order");
    }
    let (n, e): (Vec<&str>, Vec<&str>) = (node.split('\n').collect(), engine.split('\n').collect());
    let at = n.iter().zip(&e).position(|(a, b)| a != b).unwrap_or(n.len().min(e.len()));
    panic!("{name}: {what} differs at line {}\n  node:   {:?}\n  engine: {:?}", at + 1, n.get(at).unwrap_or(&"<end>"), e.get(at).unwrap_or(&"<end>"));
}

/// The keys the engine computes itself; every other status key comes from the stages the plugin's own update.js runs.
const OWN: [&str; 7] = ["installed", "latest", "updated", "cacheSynced", "action", "harnessRegistered", "ok"];

/// An update that moved the version: the Node script runs its stages twice (its own pass, then the new copy's pass over the same
/// home), so the status it prints is the second pass, which reports the one-time migrations as "already completed". The engine
/// runs the stages once and reports that run. For such a run everything the engine computes is compared exactly, and a stage
/// only by its presence and its `attempted` flag.
fn assert_same_update(name: &str, node: &str, engine: &str) {
    let first = |t: &str| -> serde_json::Map<String, serde_json::Value> {
        match serde_json::from_str(t.lines().next().unwrap_or("")) {
            Ok(serde_json::Value::Object(m)) => m,
            _ => panic!("{name}: not a status line: {t}"),
        }
    };
    let (n, e) = (first(node), first(engine));
    assert_eq!(n.keys().collect::<Vec<_>>(), e.keys().collect::<Vec<_>>(), "{name}: status key order");
    for (k, v) in &n {
        if OWN.contains(&k.as_str()) {
            assert_eq!(Some(v), e.get(k), "{name}: status key {k}");
        } else {
            assert_eq!(v.get("attempted"), e[k].get("attempted"), "{name}: stage {k} attempted");
        }
    }
    let human = |t: &str| -> Vec<String> {
        t.lines()
            .skip(1)
            .filter(|l| {
                let label = l.trim_start().split(':').next().unwrap_or("");
                !l.starts_with("  ") || ["installed", "latest", "updated", "action", "harness-register"].contains(&label)
            })
            .map(str::to_string)
            .collect()
    };
    assert_eq!(human(node), human(engine), "{name}: the summary outside the stage lines");
}

fn parity(name: &str, o: &Opt, args: &[&str]) -> String {
    let (a, b) = (world(o), world(o));
    let (node, eng) = (run_node(&a, o, args), run_engine(&b, o, args));
    assert_eq!(node.code, eng.code, "{name}: exit code\nnode out: {}\nengine out: {}\nengine err: {}", node.stdout, eng.stdout, eng.stderr);
    let (ns, es) = (norm(&node.stdout, &a), norm(&eng.stdout, &b));
    let moved = ns.lines().next().is_some_and(|l| l.contains("\"updated\":true") && l.contains("\"ingestHeal\""));
    if moved {
        assert_same_update(name, &ns, &es);
    } else {
        assert_same(name, "stdout", &ns, &es);
    }
    assert_same(name, "stderr", &norm(&no_progress(&node.stderr), &a), &norm(&no_progress(&eng.stderr), &b));
    let (ta, tb) = (tree(&a.home), tree(&b.home));
    let keys: Vec<&String> = ta.keys().chain(tb.keys()).collect();
    for k in keys {
        if moved && (k.contains("update-sweep-state") || k.contains("logs/devswarm.jsonl")) {
            continue; // the Node script's two passes stamp differently (see assert_same_update)
        }
        assert_eq!(ta.get(k).map(|v| norm(v, &a)), tb.get(k).map(|v| norm(v, &b)), "{name}: file {k} differs between the Node run and the engine run");
    }
    // the world is as the scenario left it: the engine never wrote the registry
    assert_eq!(
        fs::read(a.home.join(".claude/plugins/installed_plugins.json")).ok(),
        fs::read(b.home.join(".claude/plugins/installed_plugins.json")).ok(),
        "{name}: registry"
    );
    ns
}

#[test]
fn check_update_available() {
    let out = parity("check_available", &Opt::default(), &["--check"]);
    assert!(out.contains("update available (0.1.0"), "{out}");
}

#[test]
fn check_up_to_date() {
    let out = parity("check_current", &Opt { no_upstream_move: true, ..Opt::default() }, &["--check"]);
    assert!(out.contains("already up to date"), "{out}");
}

#[test]
fn check_registry_lags_the_cache() {
    parity("check_lag", &Opt { registry: Some("0.0.9"), no_upstream_move: true, ..Opt::default() }, &["--check"]);
}

#[test]
fn check_offline_fails_open() {
    let out = parity("check_offline", &Opt { offline: true, ..Opt::default() }, &["--check"]);
    assert!(out.contains("check failed (offline / no git)"), "{out}");
}

#[test]
fn check_unknown_installed() {
    parity("check_unknown", &Opt { unknown_installed: true, ..Opt::default() }, &["--check"]);
}

#[test]
fn bad_override_is_reported_and_ignored() {
    parity("bad_override", &Opt { bad_override: true, ..Opt::default() }, &["--check"]);
}

#[test]
fn update_pulls_syncs_the_cache_registers_and_prints_the_changelog() {
    let out = parity("update", &Opt::default(), &[]);
    assert!(out.contains("Changelog delta:") && out.contains("added the second thing"), "{out}");
    assert!(out.contains("\"cacheSynced\":true"), "{out}");
}

#[test]
fn update_when_already_current() {
    parity("update_current", &Opt { no_upstream_move: true, ..Opt::default() }, &[]);
}

#[test]
fn update_with_a_stale_registry_but_current_clone() {
    parity("update_stale_registry", &Opt { no_upstream_move: true, registry: Some("0.0.5"), ..Opt::default() }, &[]);
}

#[test]
fn update_harness_registration_fails() {
    let out = parity("update_harness_fail", &Opt { claude_fails: true, ..Opt::default() }, &[]);
    assert!(out.contains("run manually: claude plugin update anti-hall@anti-hall"), "{out}");
}

#[test]
fn update_harness_asks_for_confirmation() {
    parity("update_harness_confirm", &Opt { claude_confirms: true, ..Opt::default() }, &[]);
}

#[test]
fn update_stops_on_a_dirty_clone() {
    let o = Opt { dirty: true, ..Opt::default() };
    let (a, b) = (world(&o), world(&o));
    let (n, e) = (run_node(&a, &o, &[]), run_engine(&b, &o, &[]));
    assert_eq!((n.code, e.code), (1, 1));
    assert_same("dirty", "stdout", &norm(&n.stdout, &a), &norm(&e.stdout, &b));
    // nothing moved: the clone still has its change and no new cache directory exists
    assert!(b.mp.join("DIRTY.txt").exists());
    assert!(!b.home.join(format!(".claude/plugins/cache/anti-hall/anti-hall/{V2}")).exists());
    parity("dirty_tree", &o, &[]);
}

#[test]
fn update_stops_on_a_diverged_clone() {
    let o = Opt { diverged: true, ..Opt::default() };
    let out = parity("diverged", &o, &[]);
    assert!(out.contains("STOP: git pull --ff-only failed"), "{out}");
}

#[test]
fn update_origin_gone_is_a_stop_like_node() {
    let out = parity("update_origin_gone", &Opt { offline: true, ..Opt::default() }, &[]);
    assert!(out.contains("STOP: git pull --ff-only failed"), "{out}");
}

#[test]
fn update_network_down_fails_open() {
    let out = parity("update_net_down", &Opt { net_down: true, ..Opt::default() }, &[]);
    assert!(out.contains("update failed (offline / network)"), "{out}");
}

#[test]
fn check_network_down_fails_open() {
    let out = parity("check_net_down", &Opt { net_down: true, ..Opt::default() }, &["--check"]);
    assert!(out.contains("check failed (offline / no git)"), "{out}");
}

#[test]
fn update_with_unknown_installed_version() {
    parity("update_unknown", &Opt { unknown_installed: true, ..Opt::default() }, &[]);
}

#[test]
fn update_without_a_cache_root_mirrors_nothing() {
    parity("update_no_cache_root", &Opt { no_cache_root: true, ..Opt::default() }, &[]);
}

#[test]
fn post_pull_only_prints_just_the_status() {
    parity("post_pull_only", &Opt { no_upstream_move: true, ..Opt::default() }, &["--post-pull-only"]);
}

#[test]
fn update_in_a_devswarm_session_with_every_one_time_stage_done() {
    let out = parity("ds_done", &Opt { ds: true, markers: true, no_upstream_move: true, ..Opt::default() }, &[]);
    assert!(out.contains("already completed for 0.1.0"), "{out}");
}

#[test]
fn update_in_a_devswarm_session_with_nothing_stamped() {
    parity("ds_fresh", &Opt { ds: true, no_upstream_move: true, ..Opt::default() }, &[]);
}

#[test]
fn update_that_moves_the_version_in_a_devswarm_session() {
    parity("ds_moved", &Opt { ds: true, ..Opt::default() }, &[]);
    parity("ds_moved_done", &Opt { ds: true, markers: true, ..Opt::default() }, &[]);
}

#[test]
fn post_pull_only_in_a_devswarm_session() {
    parity("ds_post_pull_only", &Opt { ds: true, markers: true, no_upstream_move: true, ..Opt::default() }, &["--post-pull-only"]);
}

#[test]
fn an_exhausted_post_pull_budget_defers_the_later_stages_whole() {
    let o = Opt { ds: true, no_upstream_move: true, budget: Some("1"), ..Opt::default() };
    let (a, b) = (world(&o), world(&o));
    let (n, e) = (run_node(&a, &o, &[]), run_engine(&b, &o, &[]));
    assert_eq!((n.code, e.code), (0, 0), "{}", e.stderr);
    let first = |t: &str| -> serde_json::Map<String, serde_json::Value> { serde_json::from_str(t.lines().next().unwrap()).unwrap() };
    let (ns, es) = (first(&norm(&n.stdout, &a)), first(&norm(&e.stdout, &b)));
    assert_eq!(ns.keys().collect::<Vec<_>>(), es.keys().collect::<Vec<_>>(), "status key order");
    let mut deferred = 0;
    for (k, v) in &ns {
        // the first stage may start in the same millisecond the deadline is set; every later budgeted stage is past it
        if k == "reconcile" || v.get("deferred").is_none() {
            continue;
        }
        deferred += 1;
        assert_eq!(Some(v), es.get(k), "deferred stage {k}");
    }
    assert!(deferred >= 5, "the budget of 1ms defers the later stages: {ns:?}");
}

#[test]
fn update_never_writes_the_registry_and_is_idempotent() {
    let o = Opt::default();
    let w = world(&o);
    let before = fs::read(w.home.join(".claude/plugins/installed_plugins.json")).unwrap();
    let first = run_engine(&w, &o, &[]);
    assert_eq!(first.code, 0, "{}", first.stderr);
    let snapshot = tree(&w.home);
    let second = run_engine(&w, &o, &[]);
    assert_eq!(second.code, 0);
    assert_eq!(fs::read(w.home.join(".claude/plugins/installed_plugins.json")).unwrap(), before);
    assert!(second.stdout.contains("\"cacheSynced\":false"), "{}", second.stdout);
    assert_eq!(tree(&w.home).keys().collect::<Vec<_>>(), snapshot.keys().collect::<Vec<_>>(), "a second update adds no file");
}

// ---- install-codex ---------------------------------------------------------------------------------------------------------

struct Cx {
    root: PathBuf,
    home: PathBuf,
    cwd: PathBuf,
}

impl Drop for Cx {
    fn drop(&mut self) {
        if let Err(e) = fs::remove_dir_all(&self.root) {
            eprintln!("could not remove {}: {e}", self.root.display());
        }
    }
}

fn cx(seed: &dyn Fn(&Path, &Path)) -> Cx {
    let root = std::env::temp_dir().join(format!("ah-codex-parity-{}-{}", std::process::id(), N.fetch_add(1, Ordering::Relaxed)));
    let (home, cwd) = (root.join("home"), root.join("cwd"));
    fs::create_dir_all(&home).unwrap();
    fs::create_dir_all(&cwd).unwrap();
    seed(&home, &cwd);
    Cx { root, home, cwd }
}

fn codex_run(c: &Cx, engine: bool, args: &[&str]) -> Out {
    let mut cmd;
    if engine {
        cmd = Command::new(env!("CARGO_BIN_EXE_ah-engine"));
        cmd.arg("install-codex").args(args).arg("--root").arg(plugin());
    } else {
        cmd = Command::new("node");
        cmd.arg(plugin().join("codex/install-codex.js")).args(args);
    }
    cmd.current_dir(&c.cwd).env_clear().env("PATH", std::env::var("PATH").unwrap()).env("HOME", &c.home);
    finish(cmd.output().unwrap())
}

fn codex_parity(name: &str, seed: &dyn Fn(&Path, &Path), steps: &[&[&str]]) {
    let (a, b) = (cx(seed), cx(seed));
    for (i, args) in steps.iter().enumerate() {
        let (n, e) = (codex_run(&a, false, args), codex_run(&b, true, args));
        assert_eq!(n.code, e.code, "{name} step {i}: exit\n{}\n{}", n.stderr, e.stderr);
        let norm_c = |t: &str, c: &Cx| {
            t.replace(&fs::canonicalize(&c.root).unwrap().to_string_lossy().into_owned(), "{ROOT}").replace(c.root.to_string_lossy().as_ref(), "{ROOT}")
        };
        assert_same(name, "stdout", &norm_c(&n.stdout, &a), &norm_c(&e.stdout, &b));
        let (ta, tb) = (tree(&a.root), tree(&b.root));
        assert_eq!(ta.keys().collect::<Vec<_>>(), tb.keys().collect::<Vec<_>>(), "{name} step {i}: file set");
        for (k, v) in &ta {
            assert_eq!(v, &tb[k], "{name} step {i}: {k}");
        }
    }
}

const STALE: &str = r#"{
  "hooks": {
    "SessionStart": [
      {"hooks": [{"type": "command", "command": "/old/plugins/anti-hall/hooks/session-start.js"}]},
      {"hooks": [{"type": "command", "command": "/other/tool.sh"}]}
    ],
    "Stop": [
      {"hooks": [{"type": "command", "command": "\"/x/hooks/ah-hook.sh\" stop"}]}
    ],
    "CustomEvent": [{"hooks": [{"type": "command", "command": "/mine.sh"}]}]
  }
}
"#;

#[test]
fn install_codex_into_an_empty_project_then_again() {
    codex_parity("fresh", &|_, _| {}, &[&[], &[]]);
}

#[test]
fn install_codex_global_dry_run_then_real() {
    codex_parity("global", &|_, _| {}, &[&["--global", "--dry-run"], &["--global"], &["--global"]]);
}

#[test]
fn install_codex_replaces_only_its_own_groups() {
    codex_parity("merge", &|_, cwd| put(cwd, ".codex/hooks.json", STALE), &[&[], &[]]);
}

#[test]
fn install_codex_config_variants() {
    for (i, toml) in
        ["", "model = \"x\"\n", "[features]\nother = 1\n", "[features]\nhooks = false\n", "[tools]\na = 1\n\n\n", "[features]\r\nx = 1\r\n"].iter().enumerate()
    {
        codex_parity(&format!("toml{i}"), &|_, cwd| put(cwd, ".codex/config.toml", toml), &[&[], &[]]);
    }
}

#[test]
fn install_codex_survives_a_corrupt_registration() {
    codex_parity("corrupt", &|_, cwd| put(cwd, ".codex/hooks.json", "{not json"), &[&[]]);
}

// ---- the Node shadow -------------------------------------------------------------------------------------------------------

/// Every byte under `dir`, concatenated (the engine's event log lives somewhere under the home).
fn all_text(dir: &Path) -> String {
    let mut out = String::new();
    if let Ok(rd) = fs::read_dir(dir) {
        for e in rd.flatten() {
            let p = e.path();
            if p.is_dir() {
                out.push_str(&all_text(&p));
            } else if let Ok(b) = fs::read(&p) {
                out.push_str(&String::from_utf8_lossy(&b));
            }
        }
    }
    out
}

fn fake_node(w: &World, line: &str) -> PathBuf {
    let p = w.root.join("fake-node");
    put(&w.root, "fake-node", format!("#!/bin/sh\necho '{line}'\n"));
    fs::set_permissions(&p, fs::Permissions::from_mode(0o755)).unwrap();
    p
}

#[test]
fn a_disagreeing_node_check_is_logged_and_the_engine_result_stands() {
    let o = Opt::default();
    let w = world(&o);
    fs::create_dir_all(w.home.join(".anti-hall/ah-engine")).unwrap(); // the event log is only written where the state dir exists
    let node = fake_node(&w, r#"{"installed":"9.9.9","latest":"9.9.9","updated":false,"cacheSynced":false,"action":"x"}"#);
    let mut cmd = Command::new(env!("CARGO_BIN_EXE_ah-engine"));
    cmd.args(["update", "--check"]).current_dir(&w.home);
    envs(&mut cmd, &w, &o);
    let out = finish(cmd.env("AH_ENGINE_NODE", &node).output().unwrap());
    assert_eq!(out.code, 0);
    assert!(out.stdout.contains("update available (0.1.0"), "the engine's own answer is printed: {}", out.stdout);
    assert!(all_text(&w.home.join(".anti-hall")).contains("update_check_shadow_mismatch"), "the mismatch is logged");
}

#[test]
fn a_disagreeing_node_update_check_is_logged_before_the_update() {
    let o = Opt::default();
    let w = world(&o);
    fs::create_dir_all(w.home.join(".anti-hall/ah-engine")).unwrap(); // the event log is only written where the state dir exists
    let node = fake_node(&w, r#"{"installed":"9.9.9","latest":"9.9.9","updated":false,"cacheSynced":false,"action":"x"}"#);
    let mut cmd = Command::new(env!("CARGO_BIN_EXE_ah-engine"));
    cmd.arg("update").current_dir(&w.home);
    envs(&mut cmd, &w, &o);
    let out = finish(cmd.env("AH_ENGINE_NODE", &node).output().unwrap());
    assert_eq!(out.code, 0, "{}", out.stderr);
    assert!(out.stdout.contains("\"updated\":true"));
    assert!(all_text(&w.home.join(".anti-hall")).contains("update_shadow_mismatch"));
}

#[test]
fn a_matching_node_run_logs_nothing() {
    let o = Opt::default();
    let w = world(&o);
    fs::create_dir_all(w.home.join(".anti-hall/ah-engine")).unwrap();
    let mut cmd = Command::new(env!("CARGO_BIN_EXE_ah-engine"));
    cmd.args(["update", "--check"]).current_dir(&w.home);
    envs(&mut cmd, &w, &o);
    assert_eq!(finish(cmd.output().unwrap()).code, 0);
    assert!(!all_text(&w.home.join(".anti-hall")).contains("shadow_mismatch"));
    let c = cx(&|home, _| fs::create_dir_all(home.join(".anti-hall/ah-engine")).unwrap());
    assert_eq!(codex_run(&c, true, &[]).code, 0);
    assert!(!all_text(&c.home.join(".anti-hall")).contains("shadow_mismatch"));
}

#[test]
fn a_disagreeing_node_installer_is_logged_and_the_files_are_still_written() {
    let c = cx(&|home, _| fs::create_dir_all(home.join(".anti-hall/ah-engine")).unwrap());
    let p = c.root.join("fake-node");
    put(&c.root, "fake-node", "#!/bin/sh\necho 'anti-hall Codex install (project): would update'\necho '- hooks: nowhere unchanged'\n");
    fs::set_permissions(&p, fs::Permissions::from_mode(0o755)).unwrap();
    let mut cmd = Command::new(env!("CARGO_BIN_EXE_ah-engine"));
    cmd.arg("install-codex")
        .arg("--root")
        .arg(plugin())
        .current_dir(&c.cwd)
        .env_clear()
        .env("PATH", std::env::var("PATH").unwrap())
        .env("HOME", &c.home)
        .env("AH_ENGINE_NODE", &p);
    assert_eq!(finish(cmd.output().unwrap()).code, 0);
    assert!(c.cwd.join(".codex/hooks.json").exists());
    assert!(all_text(&c.home.join(".anti-hall")).contains("install_codex_shadow_mismatch"));
}
