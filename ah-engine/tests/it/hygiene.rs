//! `ah-engine hygiene`, end to end: the real binary in a scratch HOME and state dir (never the real HOME or a live engine),
//! over seeded clones of a local bare remote. One real-fixture test per row of the class contract (KEEP: a live process
//! works inside, or recent; TARGET-ONLY: dirty, untracked, stash, unpushed, remote unverifiable, only the ignored `target/`
//! goes; REMOVE-SAFE: clean, idle, every tip on a tip `git ls-remote` serves now), the failed report write (nonzero exit, a
//! counter, nothing but its own temp unlinked), plus the older broad shape tests.
#![allow(clippy::unwrap_used, clippy::expect_used)] // a test crate: a panic is the failure report, and E2 exempts tests
use serde_json::Value;
use std::path::{Path, PathBuf};
use std::process::{Child, Command};

const BIN: &str = env!("CARGO_BIN_EXE_ah-engine");

fn plugin() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../plugins/anti-hall").canonicalize().unwrap()
}

struct World {
    dir: PathBuf,
    kids: Vec<Child>,
}

impl Drop for World {
    fn drop(&mut self) {
        for k in &mut self.kids {
            ah_engine::discard::harmless(k.kill()); // keep: a child that already ended
            ah_engine::discard::harmless(k.wait()); // keep: reaping a child that already ended
        }
        ah_engine::discard::harmless(std::fs::remove_dir_all(&self.dir)); // keep: best-effort cleanup of the scratch dir
    }
}

fn path_env() -> String {
    format!("{}:/usr/sbin:/usr/bin:/bin", std::env::var("PATH").unwrap_or_default())
}

impl World {
    fn new(tag: &str) -> World {
        let name = format!("ah-hyg-{tag}-{}", std::process::id());
        let dir = std::env::temp_dir().join(&name).canonicalize().unwrap_or_else(|_| {
            let d = std::env::temp_dir().join(&name);
            std::fs::create_dir_all(&d).unwrap();
            d.canonicalize().unwrap()
        });
        std::fs::create_dir_all(dir.join("home/.anti-hall/work/scratch")).unwrap();
        World { dir, kids: Vec::new() }
    }
    fn home(&self) -> PathBuf {
        self.dir.join("home")
    }
    fn work(&self) -> PathBuf {
        self.home().join(".anti-hall/work")
    }
    fn git(&self, cwd: &Path, args: &[&str]) {
        let st = Command::new("git")
            .args(["-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "init.defaultBranch=main", "-c", "commit.gpgsign=false"])
            .args(args)
            .current_dir(cwd)
            .env("HOME", self.home())
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .env("GIT_CONFIG_GLOBAL", "/dev/null")
            .output()
            .unwrap();
        assert!(st.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&st.stderr));
    }
    fn git_out(&self, cwd: &Path, args: &[&str]) -> String {
        let o = Command::new("git")
            .args(args)
            .current_dir(cwd)
            .env("HOME", self.home())
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .env("GIT_CONFIG_GLOBAL", "/dev/null")
            .output()
            .unwrap();
        assert!(o.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&o.stderr));
        String::from_utf8_lossy(&o.stdout).into_owned()
    }
    fn clone(&self, name: &str) -> PathBuf {
        let to = self.work().join("scratch").join(name);
        self.git(&self.dir, &["clone", "-q", self.dir.join("remote.git").to_str().unwrap(), to.to_str().unwrap()]);
        to
    }
    fn run(&self, args: &[&str], env: &[(&str, &str)]) -> Value {
        let (code, v, err) = self.run_raw(args, env);
        assert_eq!(code, 0, "hygiene {args:?}: {err}");
        v
    }
    /// The run's exit code, its last stdout line as JSON, and its stderr.
    fn run_raw(&self, args: &[&str], env: &[(&str, &str)]) -> (i32, Value, String) {
        let mut c = Command::new(BIN);
        c.args(args)
            .arg("--json")
            .env_clear()
            .env("PATH", path_env())
            .env("HOME", self.home())
            .env("AH_ENGINE_DIR", self.dir.join("eng"))
            .env("AH_ENGINE_PLUGIN_ROOT", plugin())
            .env("AH_ENGINE_NOSPAWN", "1")
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .env("GIT_CONFIG_GLOBAL", "/dev/null");
        for (k, v) in env {
            c.env(k, v);
        }
        let out = c.output().unwrap();
        let text = String::from_utf8_lossy(&out.stdout).into_owned();
        let v = serde_json::from_str(text.lines().last().unwrap_or_default()).unwrap_or_else(|e| panic!("{e}: {text}"));
        (out.status.code().unwrap_or(-1), v, String::from_utf8_lossy(&out.stderr).into_owned())
    }
}

fn backdate(stamp: &str, paths: &[PathBuf]) {
    for p in paths {
        let st = Command::new("touch").args(["-c", "-h", "-t", stamp]).arg(p).status().unwrap();
        assert!(st.success());
    }
}

fn age_clone(c: &Path) {
    backdate("202001010000", &[c.join(".git/index"), c.join(".git/HEAD"), c.join(".git/logs/HEAD"), c.join(".git/FETCH_HEAD"), c.to_path_buf()]);
}

fn class_of(r: &Value, path: &Path) -> (String, String) {
    let p = path.to_string_lossy();
    let it = r["items"].as_array().unwrap().iter().find(|i| i["path"] == *p).unwrap_or_else(|| panic!("{p} not listed: {r}"));
    (it["class"].as_str().unwrap().to_string(), it["reason"].as_str().unwrap().to_string())
}

fn snapshot(dir: &Path) -> Vec<(PathBuf, u64)> {
    let mut v = Vec::new();
    let mut stack = vec![dir.to_path_buf()];
    while let Some(d) = stack.pop() {
        for e in std::fs::read_dir(&d).unwrap().flatten() {
            let m = e.path().symlink_metadata().unwrap();
            if m.is_dir() {
                stack.push(e.path());
            }
            v.push((e.path(), m.len()));
        }
    }
    v.sort();
    v
}

#[test]
fn hygiene_classifies_fail_closed_and_clean_is_idempotent_and_never_touches_unsafe_clones() {
    let mut w = World::new("a");
    // a bare remote with one commit on main
    w.git(&w.dir, &["init", "-q", "--bare", "remote.git"]);
    let seed = w.dir.join("seed");
    std::fs::create_dir_all(&seed).unwrap();
    w.git(&seed, &["init", "-q"]);
    std::fs::write(seed.join(".gitignore"), "target/\n").unwrap();
    std::fs::write(seed.join("README"), "seed\n").unwrap();
    w.git(&seed, &["add", "."]);
    w.git(&seed, &["commit", "-q", "-m", "seed"]);
    w.git(&seed, &["push", "-q", w.dir.join("remote.git").to_str().unwrap(), "HEAD:main"]);

    let dirty = w.clone("dirty");
    std::fs::write(dirty.join("wip.txt"), "unsaved work\n").unwrap();
    let unpushed = w.clone("unpushed");
    std::fs::write(unpushed.join("new.txt"), "local only\n").unwrap();
    w.git(&unpushed, &["add", "."]);
    w.git(&unpushed, &["commit", "-q", "-m", "local"]);
    let live = w.clone("live");
    let merged = w.clone("merged");
    let stale = w.clone("stale");
    std::fs::write(stale.join("notes.txt"), "dirty\n").unwrap();
    std::fs::create_dir_all(stale.join("target/debug")).unwrap();
    std::fs::write(stale.join("target/debug/big"), vec![7u8; 256 * 1024]).unwrap();
    // a tracked file under target/: the build dir is not regenerable, so nothing of it may go
    let tracked = w.clone("tracked");
    std::fs::create_dir_all(tracked.join("target")).unwrap();
    std::fs::write(tracked.join("target/only-copy.txt"), "v1\n").unwrap();
    w.git(&tracked, &["add", "-f", "target/only-copy.txt"]);
    w.git(&tracked, &["commit", "-q", "-m", "tracked build file"]);
    std::fs::write(tracked.join("target/only-copy.txt"), "v2, the only copy\n").unwrap();
    // a dirty submodule hidden by submodule.<name>.ignore=all (pushed, so only the submodule's change protects it)
    w.git(&w.dir, &["init", "-q", "--bare", "child.git"]);
    let cseed = w.dir.join("cseed");
    std::fs::create_dir_all(&cseed).unwrap();
    w.git(&cseed, &["init", "-q"]);
    std::fs::write(cseed.join("README"), "child\n").unwrap();
    w.git(&cseed, &["add", "."]);
    w.git(&cseed, &["commit", "-q", "-m", "child"]);
    w.git(&cseed, &["push", "-q", w.dir.join("child.git").to_str().unwrap(), "HEAD:main"]);
    let subdirty = w.clone("subdirty");
    w.git(&subdirty, &["-c", "protocol.file.allow=always", "submodule", "add", "-q", w.dir.join("child.git").to_str().unwrap(), "child"]);
    w.git(&subdirty, &["commit", "-q", "-m", "add child"]);
    // its own branch, so the other clones stay level with main (a clone behind a tip it never fetched is unverifiable)
    w.git(&subdirty, &["push", "-q", "origin", "HEAD:sub"]);
    w.git(&subdirty, &["config", "submodule.child.ignore", "all"]);
    // has every branch tip the remote serves, so its local commit is provably unpushed (not merely unverifiable)
    w.git(&unpushed, &["fetch", "-q"]);
    std::fs::write(subdirty.join("child/README"), "uncommitted submodule work\n").unwrap();
    let cache = w.work().join("sccache");
    std::fs::create_dir_all(&cache).unwrap();
    std::fs::write(cache.join("blob"), "cache").unwrap();
    // five deploy copies; the newest three stay
    let deploys: Vec<PathBuf> = (1..=5).map(|i| w.work().join(format!("deploy-{i}"))).collect();
    for (i, d) in deploys.iter().enumerate() {
        std::fs::create_dir_all(d).unwrap();
        std::fs::write(d.join("bin"), "x").unwrap();
        backdate(&format!("2020010100{i:02}"), std::slice::from_ref(d));
    }
    // spill files: one old, one fresh
    let spill = w.home().join(".anti-hall/context-spill");
    std::fs::create_dir_all(&spill).unwrap();
    std::fs::write(spill.join("old.txt"), "old").unwrap();
    std::fs::write(spill.join("new.txt"), "new").unwrap();
    backdate("202001010000", &[spill.join("old.txt")]);
    for c in [&dirty, &unpushed, &live, &merged, &stale, &tracked, &subdirty] {
        age_clone(c);
    }
    w.kids.push(Command::new("sleep").arg("600").current_dir(&live).spawn().unwrap());
    std::thread::sleep(std::time::Duration::from_millis(200));

    let (keep, tgt) = ("KEEP", "TARGET-ONLY");
    let r = w.run(&["hygiene", "--report"], &[]);
    assert_eq!(class_of(&r, &dirty), (tgt.into(), "untracked".into()));
    assert_eq!(class_of(&r, &unpushed), (tgt.into(), "unpushed".into()));
    assert_eq!(class_of(&r, &live), (keep.into(), "live_process".into()));
    assert_eq!(class_of(&r, &merged), ("REMOVE-SAFE".into(), "clean_pushed_idle".into()));
    assert_eq!(class_of(&r, &stale), (tgt.into(), "untracked".into()));
    assert_eq!(class_of(&r, &cache), (keep.into(), "reusable".into()));
    assert_eq!(class_of(&r, &tracked), (tgt.into(), "dirty".into()));
    let tracked_item = r["items"].as_array().unwrap().iter().find(|i| i["path"] == *tracked.to_string_lossy()).unwrap();
    assert_eq!(
        (tracked_item["bytes"].as_u64(), tracked_item["targets"].as_array().map(Vec::len)),
        (Some(0), Some(0)),
        "a build dir with a tracked file is not regenerable"
    );
    assert_eq!(class_of(&r, &subdirty), (tgt.into(), "dirty".into()), "a submodule change hidden by ignore=all still counts");
    for d in &deploys[2..] {
        assert_eq!(class_of(&r, d), (keep.into(), "deploy_newest".into()));
    }
    for d in &deploys[..2] {
        assert_eq!(class_of(&r, d).0, "REMOVE-SAFE");
    }
    assert_eq!(class_of(&r, &spill.join("old.txt")), (keep.into(), "spill_report_only".into()), "spill files lie outside the work roots: report only");
    assert!(r["items"].as_array().unwrap().iter().all(|i| i["path"] != *spill.join("new.txt").to_string_lossy()), "a fresh spill file is not listed");
    assert!(r["bytes_reclaimable"].as_u64().unwrap() > 256 * 1024);
    assert_eq!(r["items_by_class"]["TARGET-ONLY"].as_u64(), Some(5), "dirty, unpushed, stale, tracked, subdirty: {r}");
    assert_eq!(r["bytes_reclaimed"], 0);
    assert!(r["items_skipped"]["fresh"].as_u64() == Some(1), "{r}");
    // the report changed nothing, and the idle age survived the git probes
    assert!(merged.exists() && stale.join("target").exists());

    let before: Vec<_> = [&dirty, &unpushed, &live, &tracked, &subdirty].iter().map(|c| snapshot(c)).collect();
    let c1 = w.run(&["hygiene", "--clean"], &[]);
    assert!(c1["bytes_reclaimed"].as_u64().unwrap() > 256 * 1024, "{c1}");
    let after: Vec<_> = [&dirty, &unpushed, &live, &tracked, &subdirty].iter().map(|c| snapshot(c)).collect();
    assert_eq!(before, after, "--clean touched a dirty, unpushed or live clone");
    assert!(
        !merged.exists() && (w.home().join(".Trash/merged/.git").exists() || w.home().join(".local/share/Trash/files/merged/.git").exists()),
        "merged clone moved to the Trash"
    );
    assert!(!stale.join("target").exists() && stale.join("notes.txt").exists() && stale.join(".git").exists(), "only target/ goes");
    assert!(!deploys[0].exists() && !deploys[1].exists() && deploys[2..].iter().all(|d| d.exists()));
    assert!(spill.join("old.txt").exists() && spill.join("new.txt").exists(), "--clean never touches a path outside the work roots");
    assert!(cache.join("blob").exists());

    // idempotent: nothing is left to remove and nothing more changes
    let c2 = w.run(&["hygiene", "--clean"], &[]);
    assert_eq!(c2["bytes_reclaimed"], 0, "{c2}");
    assert!(c2["items"].as_array().unwrap().iter().all(|i| i["class"] != "REMOVE-SAFE" && i["bytes"] == 0), "{c2}");
    assert_eq!(before, [&dirty, &unpushed, &live, &tracked, &subdirty].iter().map(|c| snapshot(c)).collect::<Vec<_>>());

    // counters reached the telemetry inbox; a low-disk floor raises the notice; the off switch does nothing
    ah_engine::defaults::init().unwrap();
    let inbox = std::fs::read_to_string(w.dir.join("eng").join(ah_engine::defaults::text("files.telemetry_inbox"))).unwrap();
    for k in [
        "bytes_reclaimable",
        "bytes_reclaimed",
        "items_listed",
        "report_write_failed",
        "items_class_TARGET-ONLY",
        "items_class_REMOVE-SAFE",
        "items_skipped_live_process",
        "items_skipped_untracked",
        "items_skipped_dirty",
        "items_skipped_unpushed",
    ] {
        assert!(inbox.contains(k), "telemetry counter {k} missing");
    }
    let low = w.run(&["hygiene"], &[("ANTIHALL_DISK_WATCH_WARN_GB", "100000000")]);
    assert!(low["notice"].as_str().is_some_and(|n| n.contains("hygiene --clean")), "{low}");
    let off = w.run(&["hygiene", "--clean"], &[("ANTIHALL_DISK_HYGIENE", "0")]);
    assert_eq!(off["enabled"], false);
}

fn seeded(tag: &str) -> World {
    let w = World::new(tag);
    w.git(&w.dir, &["init", "-q", "--bare", "remote.git"]);
    let seed = w.dir.join("seed");
    std::fs::create_dir_all(&seed).unwrap();
    w.git(&seed, &["init", "-q"]);
    std::fs::write(seed.join(".gitignore"), "target/\n").unwrap();
    std::fs::write(seed.join("README"), "seed\n").unwrap();
    w.git(&seed, &["add", "."]);
    w.git(&seed, &["commit", "-q", "-m", "seed"]);
    w.git(&seed, &["push", "-q", w.dir.join("remote.git").to_str().unwrap(), "HEAD:main"]);
    w
}

/// The shapes that must stay whatever their age: no remote any more, a detached HEAD with a local commit, a linked
/// worktree (both sides), a symlinked entry, a dirty path with spaces, a stash, a corrupt repository, a symlinked work
/// root. A probe that cannot run (no git on PATH) makes every clone KEEP, and the report mode and the schedule's command
/// line never remove anything. A clone that is only behind its remote has nothing local and stays removable.
#[test]
fn hygiene_keeps_every_unsafe_or_unprovable_shape_and_fails_safe() {
    let w = seeded("b");
    let nremote = w.clone("no remote");
    w.git(&nremote, &["remote", "remove", "origin"]);
    let detached = w.clone("detached");
    w.git(&detached, &["checkout", "-q", "--detach"]);
    std::fs::write(detached.join("d.txt"), "d\n").unwrap();
    w.git(&detached, &["add", "."]);
    w.git(&detached, &["commit", "-q", "-m", "local on detached HEAD"]);
    let wtmain = w.clone("wtmain");
    let wt = w.work().join("scratch").join("wt");
    w.git(&wtmain, &["worktree", "add", "-q", "-b", "side", wt.to_str().unwrap()]);
    let spaced = w.clone("with space");
    std::fs::write(spaced.join("wip.txt"), "wip\n").unwrap();
    let stashed = w.clone("stashed");
    std::fs::write(stashed.join("README"), "stashed change\n").unwrap();
    w.git(&stashed, &["stash", "-q"]);
    let corrupt = w.clone("corrupt");
    std::fs::write(corrupt.join(".git/HEAD"), "not a ref\n").unwrap();
    let behind = w.clone("behind");
    let seed = w.dir.join("seed");
    std::fs::write(seed.join("more"), "more\n").unwrap();
    w.git(&seed, &["add", "."]);
    w.git(&seed, &["commit", "-q", "-m", "more"]);
    w.git(&seed, &["push", "-q", w.dir.join("remote.git").to_str().unwrap(), "HEAD:main"]);
    w.git(&behind, &["fetch", "-q"]);
    w.git(&detached, &["fetch", "-q"]);
    let outside = w.dir.join("outside-clone");
    w.git(&w.dir, &["clone", "-q", w.dir.join("remote.git").to_str().unwrap(), outside.to_str().unwrap()]);
    let link = w.work().join("scratch").join("link");
    std::os::unix::fs::symlink(&outside, &link).unwrap();
    let all = [&nremote, &detached, &wtmain, &wt, &spaced, &stashed, &corrupt, &behind, &outside];
    for c in all {
        if c.join(".git").is_dir() {
            age_clone(c);
        } else {
            backdate("202001010000", std::slice::from_ref(c));
        }
    }
    let keepers = [&nremote, &detached, &wtmain, &wt, &spaced, &stashed, &corrupt, &outside];
    let before: Vec<_> = keepers.iter().map(|c| snapshot(c)).collect();

    // no git on PATH: nothing is provable, so no clone is REMOVE-SAFE and --clean removes nothing (not even the behind clone)
    let nogit = w.run(&["hygiene", "--clean"], &[("PATH", "/nonexistent")]);
    assert_eq!(nogit["bytes_reclaimed"], 0, "{nogit}");
    assert!(nogit["items"].as_array().unwrap().iter().all(|i| i["class"] != "REMOVE-SAFE" && i["bytes"] == 0), "{nogit}");
    assert!(behind.join(".git").exists());

    let r = w.run(&["hygiene", "--report"], &[]);
    assert_eq!(class_of(&r, &nremote), ("TARGET-ONLY".into(), "remote_unverified".into()));
    assert_eq!(class_of(&r, &detached), ("TARGET-ONLY".into(), "unpushed".into()));
    assert_eq!(class_of(&r, &wtmain), ("KEEP".into(), "worktrees".into()));
    assert_eq!(class_of(&r, &spaced), ("TARGET-ONLY".into(), "untracked".into()));
    assert_eq!(class_of(&r, &stashed), ("TARGET-ONLY".into(), "stash".into()));
    assert_eq!(class_of(&r, &corrupt), ("TARGET-ONLY".into(), "unprovable".into()));
    assert_eq!(class_of(&r, &behind), ("REMOVE-SAFE".into(), "clean_pushed_idle".into()));
    assert_eq!(r["items_skipped"]["remote_unverified"].as_u64(), Some(1), "the no-remote clone counts its reason: {r}");
    let listed = |p: &Path| r["items"].as_array().unwrap().iter().find(|i| i["path"] == *p.to_string_lossy()).map(|i| i["class"].clone());
    assert!(listed(&wt).is_none_or(|c| c == "KEEP") && listed(&link).is_none_or(|c| c == "KEEP"), "{r}");
    // the report changed nothing
    assert!(behind.join(".git").exists());
    assert_eq!(before, keepers.iter().map(|c| snapshot(c)).collect::<Vec<_>>());

    let c = w.run(&["hygiene", "--clean"], &[]);
    assert!(!behind.exists(), "{c}");
    assert_eq!(before, keepers.iter().map(|c| snapshot(c)).collect::<Vec<_>>(), "--clean touched a KEEP shape");
    assert!(link.symlink_metadata().is_ok_and(|m| m.file_type().is_symlink()));

    // the scheduled job runs the report mode only
    ah_engine::defaults::init().unwrap();
    let job = ah_engine::defaults::raw("schedule.action_args").get("disk_hygiene").map(|v| v.strings()).unwrap_or_default();
    assert_eq!(job, vec!["hygiene", "--report"]);

    // a symlinked work root: nothing under it is proved inside the work root, so nothing is removable
    let w2 = seeded("c");
    let real = w2.dir.join("real-work");
    std::fs::create_dir_all(real.join("scratch")).unwrap();
    std::fs::remove_dir_all(w2.work()).unwrap();
    std::os::unix::fs::symlink(&real, w2.work()).unwrap();
    let m = real.join("scratch").join("m");
    w2.git(&w2.dir, &["clone", "-q", w2.dir.join("remote.git").to_str().unwrap(), m.to_str().unwrap()]);
    age_clone(&m);
    let r2 = w2.run(&["hygiene", "--clean"], &[]);
    assert_eq!(r2["bytes_reclaimed"], 0, "{r2}");
    assert!(r2["items"].as_array().unwrap().iter().all(|i| i["class"] == "KEEP"), "{r2}");
    assert!(m.join(".git").exists());
}

/// An ignored `target/` with a 64 KiB artifact inside `clone`.
fn with_target(clone: &Path) {
    std::fs::create_dir_all(clone.join("target/debug")).unwrap();
    std::fs::write(clone.join("target/debug/artifact"), vec![1u8; 64 * 1024]).unwrap();
}

/// A snapshot of `clone` without its `target/`.
fn without_target(clone: &Path) -> Vec<(PathBuf, u64)> {
    let t = clone.join("target");
    snapshot(clone).into_iter().filter(|(p, _)| !p.starts_with(&t)).collect()
}

fn item<'a>(r: &'a Value, path: &Path) -> &'a Value {
    r["items"].as_array().unwrap().iter().find(|i| i["path"] == *path.to_string_lossy()).unwrap_or_else(|| panic!("{} not listed: {r}", path.display()))
}

/// Contract row KEEP: a live process with its working directory inside the clone (here a subdirectory), or activity within
/// the idle window, makes the clone KEEP, and `--clean` does nothing to it, not even its ignored `target/`.
#[test]
fn contract_keep_live_process_or_recent_clean_touches_nothing_not_even_target() {
    let mut w = seeded("keep");
    // a dirty clone with an ignored target/ and a real child process whose cwd is a subdirectory of the clone
    let busy_dirty = w.clone("busy-dirty");
    std::fs::write(busy_dirty.join("README"), "tracked change\n").unwrap();
    with_target(&busy_dirty);
    std::fs::create_dir_all(busy_dirty.join("src/deep")).unwrap();
    // a clean, fully pushed clone a process works in: never moved to the Trash
    let busy_clean = w.clone("busy-clean");
    // a clean, fully pushed clone that is not idle (not aged): KEEP recent
    let recent = w.clone("recent");
    with_target(&recent);
    age_clone(&busy_dirty);
    age_clone(&busy_clean);
    w.kids.push(Command::new("sleep").arg("600").current_dir(busy_dirty.join("src/deep")).spawn().unwrap());
    w.kids.push(Command::new("sleep").arg("600").current_dir(&busy_clean).spawn().unwrap());
    std::thread::sleep(std::time::Duration::from_millis(200));
    let before: Vec<_> = [&busy_dirty, &busy_clean, &recent].iter().map(|c| snapshot(c)).collect();

    let r = w.run(&["hygiene", "--report"], &[]);
    assert_eq!(class_of(&r, &busy_dirty), ("KEEP".into(), "live_process".into()));
    assert_eq!(class_of(&r, &busy_clean), ("KEEP".into(), "live_process".into()));
    assert_eq!(class_of(&r, &recent), ("KEEP".into(), "recent".into()));
    assert_eq!(r["items_by_class"]["KEEP"].as_u64(), Some(3), "{r}");
    let c = w.run(&["hygiene", "--clean"], &[]);
    assert_eq!(c["bytes_reclaimed"], 0, "{c}");
    assert_eq!(before, [&busy_dirty, &busy_clean, &recent].iter().map(|c| snapshot(c)).collect::<Vec<_>>(), "--clean touched a KEEP clone");
    assert!(busy_dirty.join("target/debug/artifact").exists() && recent.join("target/debug/artifact").exists(), "KEEP: not even target/ goes");
}

/// Contract row TARGET-ONLY: a dirty tree, untracked files, a stash and unpushed commits each leave the clone intact; only
/// its ignored, untracked `target/` goes, and nothing outside the clone changes.
#[test]
fn contract_target_only_protected_shapes_lose_only_their_ignored_target() {
    let w = seeded("tgt");
    let dirty = w.clone("dirty");
    std::fs::write(dirty.join("README"), "tracked change\n").unwrap();
    let untracked = w.clone("untracked");
    std::fs::write(untracked.join("notes.txt"), "only copy\n").unwrap();
    let stash = w.clone("stash");
    std::fs::write(stash.join("README"), "stashed\n").unwrap();
    w.git(&stash, &["stash", "-q"]);
    let unpushed = w.clone("unpushed");
    std::fs::write(unpushed.join("local.txt"), "local\n").unwrap();
    w.git(&unpushed, &["add", "."]);
    w.git(&unpushed, &["commit", "-q", "-m", "local only"]);
    let shapes = [(&dirty, "dirty"), (&untracked, "untracked"), (&stash, "stash"), (&unpushed, "unpushed")];
    for (c, _) in shapes {
        with_target(c);
        age_clone(c);
    }
    let sentinel = w.work().join("scratch").join("sentinel.txt");
    std::fs::write(&sentinel, "outside every clone\n").unwrap();
    let before: Vec<_> = shapes.iter().map(|(c, _)| without_target(c)).collect();
    let head_before: Vec<_> = shapes.iter().map(|(c, _)| std::fs::read(c.join(".git/HEAD")).unwrap()).collect();

    let r = w.run(&["hygiene", "--report"], &[]);
    for (c, why) in shapes {
        assert_eq!(class_of(&r, c), ("TARGET-ONLY".into(), why.into()), "{}", c.display());
        let it = item(&r, c);
        assert_eq!(it["targets"].as_array().unwrap().len(), 1, "{it}");
        assert!(it["bytes"].as_u64().unwrap() >= 64 * 1024, "{it}");
    }
    assert!(shapes.iter().all(|(c, _)| c.join("target/debug/artifact").exists()), "the report removed nothing");

    let c = w.run(&["hygiene", "--clean"], &[]);
    assert!(c["bytes_reclaimed"].as_u64().unwrap() >= 4 * 64 * 1024, "{c}");
    for (i, (cl, why)) in shapes.iter().enumerate() {
        assert!(!cl.join("target").exists(), "{why}: target/ goes");
        assert_eq!(without_target(cl), before[i], "{why}: only target/ goes, everything else stays");
        assert_eq!(std::fs::read(cl.join(".git/HEAD")).unwrap(), head_before[i]);
    }
    assert!(std::fs::read_to_string(&sentinel).unwrap() == "outside every clone\n");
    assert_eq!(w.git_out(&stash, &["stash", "list"]).lines().count(), 1, "the stash survives");
    assert!(w.git_out(&unpushed, &["log", "--oneline", "-1"]).contains("local only"), "the unpushed commit survives");
}

/// Contract row REMOVE-SAFE: a pushed but unmerged branch is loss-free, proved against the tips `git ls-remote` serves now;
/// a branch deleted on the remote whose stale remote-tracking ref still exists locally is unpushed (TARGET-ONLY); a remote
/// that cannot be reached is TARGET-ONLY (remote_unverified), never REMOVE-SAFE.
#[test]
fn contract_remove_safe_needs_tips_the_remote_serves_now_and_an_unreachable_remote_is_target_only() {
    let w = seeded("safe");
    let remote = w.dir.join("remote.git");
    // pushed, not merged into main
    let pushed = w.clone("pushed-unmerged");
    w.git(&pushed, &["checkout", "-q", "-b", "feature"]);
    std::fs::write(pushed.join("f.txt"), "feature\n").unwrap();
    w.git(&pushed, &["add", "."]);
    w.git(&pushed, &["commit", "-q", "-m", "feature"]);
    w.git(&pushed, &["push", "-q", "origin", "feature"]);
    // stale: pushed, then deleted on the remote from another clone; the tracking ref stays (no fetch here)
    let stale = w.clone("stale-ref");
    w.git(&stale, &["checkout", "-q", "-b", "gone"]);
    std::fs::write(stale.join("g.txt"), "gone\n").unwrap();
    w.git(&stale, &["add", "."]);
    w.git(&stale, &["commit", "-q", "-m", "gone"]);
    w.git(&stale, &["push", "-q", "-u", "origin", "gone"]);
    w.git(&w.dir, &["--git-dir", remote.to_str().unwrap(), "branch", "-D", "gone"]);
    assert!(w.git_out(&stale, &["rev-list", "HEAD", "--branches", "--not", "--remotes"]).trim().is_empty(), "the old check would call it pushed");
    // unreachable: a clean clone whose remote is gone
    let unreachable = w.clone("unreachable");
    w.git(&unreachable, &["remote", "set-url", "origin", w.dir.join("no-such-remote.git").to_str().unwrap()]);
    with_target(&unreachable);
    // behind: the remote's main moves on after the clone and the clone never fetches; the report never fetches either, so
    // its commits cannot be proved on the remote: remote_unverified, only target/ goes
    // (a world of its own: here the feature branch, based on the old main, would prove it)
    let w2 = seeded("safe2");
    let behind = w2.clone("behind-unfetched");
    with_target(&behind);
    let seed = w2.dir.join("seed");
    std::fs::write(seed.join("later"), "later\n").unwrap();
    w2.git(&seed, &["add", "."]);
    w2.git(&seed, &["commit", "-q", "-m", "later"]);
    w2.git(&seed, &["push", "-q", w2.dir.join("remote.git").to_str().unwrap(), "HEAD:main"]);
    // a plain fetch (no prune) keeps the stale tracking ref and gives the clone every served tip: provably unpushed
    w.git(&stale, &["fetch", "-q"]);
    assert!(stale.join(".git/refs/remotes/origin/gone").exists());
    for c in [&pushed, &stale, &unreachable, &behind] {
        age_clone(c);
    }
    let before_unreachable = without_target(&unreachable);
    let before_behind = without_target(&behind);

    let r = w.run(&["hygiene", "--report"], &[]);
    assert_eq!(class_of(&r, &pushed), ("REMOVE-SAFE".into(), "clean_pushed_idle".into()));
    assert_eq!(class_of(&r, &stale), ("TARGET-ONLY".into(), "unpushed".into()));
    assert_eq!(class_of(&r, &unreachable), ("TARGET-ONLY".into(), "remote_unverified".into()));
    let r2 = w2.run(&["hygiene", "--report"], &[]);
    assert_eq!(class_of(&r2, &behind), ("TARGET-ONLY".into(), "remote_unverified".into()));
    assert!(pushed.join(".git").exists() && stale.join(".git/refs/remotes/origin/gone").exists(), "the report changed nothing, no ref pruned");

    let c = w.run(&["hygiene", "--clean"], &[]);
    assert!(!pushed.exists(), "{c}");
    let trashed = [w.home().join(".Trash/pushed-unmerged"), w.home().join(".local/share/Trash/files/pushed-unmerged")];
    assert!(trashed.iter().any(|t| t.join(".git").exists()), "moved to the Trash, not deleted");
    assert!(stale.join("g.txt").exists() && stale.join(".git").exists());
    assert!(!unreachable.join("target").exists() && without_target(&unreachable) == before_unreachable, "only target/ goes");
    w2.run(&["hygiene", "--clean"], &[]);
    assert!(!behind.join("target").exists() && without_target(&behind) == before_behind, "only target/ goes");
}

/// The report path: a report file that cannot be written (a nonempty directory in its place) exits nonzero, counts
/// `report_write_failed`, removes nothing it did not create (the directory, its content and a stray file stay) and leaves no
/// temporary file of its own.
#[test]
fn a_failed_report_write_exits_nonzero_counts_and_unlinks_nothing_it_did_not_create() {
    let w = seeded("rpt");
    let eng = w.dir.join("eng");
    std::fs::create_dir_all(eng.join("hygiene-report.json")).unwrap();
    std::fs::write(eng.join("hygiene-report.json/keep"), "owner data\n").unwrap();
    std::fs::write(eng.join("unrelated.tmp"), "not the run's\n").unwrap();
    let listing = |d: &Path| {
        let mut v: Vec<String> = std::fs::read_dir(d).unwrap().flatten().map(|e| e.file_name().to_string_lossy().into_owned()).collect();
        v.sort();
        v
    };
    let (code, r, err) = w.run_raw(&["hygiene", "--report"], &[]);
    assert_ne!(code, 0, "a failed report write must fail the run: {r} {err}");
    assert!(r["report_error"].is_string() && err.contains("hygiene report not written"), "{r} {err}");
    assert_eq!(std::fs::read_to_string(eng.join("hygiene-report.json/keep")).unwrap(), "owner data\n");
    assert_eq!(std::fs::read_to_string(eng.join("unrelated.tmp")).unwrap(), "not the run's\n");
    assert!(listing(&eng).iter().all(|n| !n.starts_with("hygiene-report.json.")), "no temporary file left: {:?}", listing(&eng));
    ah_engine::defaults::init().unwrap();
    let inbox = std::fs::read_to_string(eng.join(ah_engine::defaults::text("files.telemetry_inbox"))).unwrap();
    let failed: Vec<&str> = inbox.lines().filter(|l| l.contains("report_write_failed")).collect();
    assert!(failed.iter().any(|l| l.contains("\"items\":1")), "report_write_failed counted: {failed:?}");
    // once the way is clear the report writes and the run succeeds
    std::fs::remove_dir_all(eng.join("hygiene-report.json")).unwrap();
    let (code, _, err) = w.run_raw(&["hygiene", "--report"], &[]);
    assert_eq!(code, 0, "{err}");
    assert!(eng.join("hygiene-report.json").is_file());
}

/// A directory with a fake `lsof` that prints `stdout`, prints a warning to stderr and exits `code`; returns a PATH that
/// finds it first.
fn fake_lsof(w: &World, tag: &str, stdout: &str, code: i32) -> String {
    use std::os::unix::fs::PermissionsExt;
    let d = w.dir.join(format!("fakebin-{tag}"));
    std::fs::create_dir_all(&d).unwrap();
    let f = d.join("lsof");
    std::fs::write(&f, format!("#!/bin/sh\nprintf '{stdout}'\necho 'lsof: WARNING: probe broke' >&2\nexit {code}\n")).unwrap();
    std::fs::set_permissions(&f, std::fs::Permissions::from_mode(0o755)).unwrap();
    format!("{}:{}", d.display(), path_env())
}

/// P1 of PR 522: the open-files probe's exit status was ignored, so a failed probe counted as proof of idleness. A clean,
/// pushed, idle clone with a file held open by a process whose cwd is elsewhere, and an `lsof` that errors (exit 2): KEEP
/// `probe_failed`, `--clean` leaves it, and the counter reaches the telemetry inbox. Exit 1 with no output (the lister's
/// "no matches") proves idleness and stays REMOVE-SAFE.
#[test]
fn a_failed_open_files_probe_keeps_every_clone_and_counts_while_no_matches_stays_removable() {
    use std::os::unix::fs::PermissionsExt;
    let mut w = seeded("probe");
    let held = w.clone("held-open");
    age_clone(&held);
    let file = std::fs::File::open(held.join("README")).unwrap();
    w.kids.push(Command::new("sleep").arg("600").current_dir("/").stdin(file).spawn().unwrap());
    let run = |w: &World, args: &[&str], path: &str| w.run(args, &[("ANTIHALL_DISK_HYGIENE_IDLE_HOURS", "0"), ("PATH", path)]);

    // exit 2 plus a stderr message: the listing is incomplete, so nothing is provable
    let bad = fake_lsof(&w, "bad", "", 2);
    let r = run(&w, &["hygiene", "--report"], &bad);
    assert_eq!(class_of(&r, &held), ("KEEP".into(), "probe_failed".into()), "{r}");
    assert_eq!(r["items_skipped"]["probe_failed"].as_u64(), Some(1), "{r}");
    let c = run(&w, &["hygiene", "--clean"], &bad);
    assert!(held.join(".git").exists() && c["bytes_reclaimed"] == 0, "--clean removed a clone whose probe failed: {c}");
    ah_engine::defaults::init().unwrap();
    let inbox = std::fs::read_to_string(w.dir.join("eng").join(ah_engine::defaults::text("files.telemetry_inbox"))).unwrap();
    assert!(inbox.lines().any(|l| l.contains("\"probe_failed\"") && l.contains("\"items\":1")), "probe_failed counter missing: {inbox}");

    // a lister killed by a signal is no better than a failing one
    let sig = w.dir.join("fakebin-sig");
    std::fs::create_dir_all(&sig).unwrap();
    std::fs::write(sig.join("lsof"), "#!/bin/sh\nkill -9 $$\n").unwrap();
    std::fs::set_permissions(sig.join("lsof"), std::fs::Permissions::from_mode(0o755)).unwrap();
    let r = run(&w, &["hygiene", "--report"], &format!("{}:{}", sig.display(), path_env()));
    assert_eq!(class_of(&r, &held), ("KEEP".into(), "probe_failed".into()), "{r}");

    // exit 1, no output: "no matches" is a complete listing, so the clone is idle and removable
    let none = fake_lsof(&w, "none", "", 1);
    let r = run(&w, &["hygiene", "--report"], &none);
    assert_eq!(class_of(&r, &held), ("REMOVE-SAFE".into(), "clean_pushed_idle".into()), "{r}");

    // exit 0 listing a file inside the clone: held open, KEEP live_process
    let hit = fake_lsof(&w, "hit", &format!("p1\\nn{}/README\\n", held.display()), 0);
    let r = run(&w, &["hygiene", "--report"], &hit);
    assert_eq!(class_of(&r, &held), ("KEEP".into(), "live_process".into()), "{r}");
}

/// The real `lsof` shape: a real process holds a file of the clone open with its cwd elsewhere; the real lister reports it
/// and the clone is KEEP live_process (or, where the lister cannot run at all, KEEP probe_failed), never REMOVE-SAFE.
#[test]
fn the_real_lsof_sees_a_file_held_open_by_a_process_working_elsewhere() {
    if Command::new("lsof").arg("-v").output().is_err() {
        return; // no lister installed here: the fake-lister test covers the contract
    }
    let mut w = seeded("reallsof");
    let held = w.clone("held-real");
    age_clone(&held);
    let file = std::fs::File::open(held.join("README")).unwrap();
    w.kids.push(Command::new("sleep").arg("600").current_dir("/").stdin(file).spawn().unwrap());
    std::thread::sleep(std::time::Duration::from_millis(200));
    let env = [("ANTIHALL_DISK_HYGIENE_IDLE_HOURS", "0")];
    let r = w.run(&["hygiene", "--report"], &env);
    let (class, why) = class_of(&r, &held);
    assert_eq!(class, "KEEP", "{r}");
    assert!(why == "live_process" || why == "probe_failed", "{why}: {r}");
    let c = w.run(&["hygiene", "--clean"], &env);
    assert!(held.join(".git").exists(), "--clean removed a held-open clone: {c}");
}
