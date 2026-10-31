//! `ah-engine hygiene`, end to end: the real binary in a scratch HOME and state dir (never the real HOME or a live engine),
//! over seeded clones of a local bare remote: a dirty clone, a clone with an unpushed commit, a clone a live process works in,
//! a merged and clean clone, a dirty clone with a stale `target/`, a reusable cache, deploy copies and spill files. Asserts the
//! classification, that `--clean` moves only the REMOVE-SAFE items to the scratch Trash, deletes only the stale `target/`, never
//! touches the dirty, unpushed and live clones, and is idempotent; and that the counters land in the telemetry inbox.
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
    fn new() -> World {
        let dir = std::env::temp_dir().join(format!("ah-hyg-{}", std::process::id())).canonicalize().unwrap_or_else(|_| {
            let d = std::env::temp_dir().join(format!("ah-hyg-{}", std::process::id()));
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
    fn clone(&self, name: &str) -> PathBuf {
        let to = self.work().join("scratch").join(name);
        self.git(&self.dir, &["clone", "-q", self.dir.join("remote.git").to_str().unwrap(), to.to_str().unwrap()]);
        to
    }
    fn run(&self, args: &[&str], env: &[(&str, &str)]) -> Value {
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
        assert!(out.status.success(), "hygiene {args:?}: {}", String::from_utf8_lossy(&out.stderr));
        let text = String::from_utf8_lossy(&out.stdout).into_owned();
        serde_json::from_str(text.lines().last().unwrap_or_default()).unwrap_or_else(|e| panic!("{e}: {text}"))
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
    let mut w = World::new();
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
    for c in [&dirty, &unpushed, &live, &merged, &stale] {
        age_clone(c);
    }
    w.kids.push(Command::new("sleep").arg("600").current_dir(&live).spawn().unwrap());
    std::thread::sleep(std::time::Duration::from_millis(200));

    let keep = "KEEP";
    let r = w.run(&["hygiene", "--report"], &[]);
    assert_eq!(class_of(&r, &dirty), (keep.into(), "dirty".into()));
    assert_eq!(class_of(&r, &unpushed), (keep.into(), "unpushed".into()));
    assert_eq!(class_of(&r, &live), (keep.into(), "live_process".into()));
    assert_eq!(class_of(&r, &merged), ("REMOVE-SAFE".into(), "clean_pushed_idle".into()));
    assert_eq!(class_of(&r, &stale), ("REMOVE-TARGET-ONLY".into(), "dirty".into()));
    assert_eq!(class_of(&r, &cache), (keep.into(), "reusable".into()));
    for d in &deploys[2..] {
        assert_eq!(class_of(&r, d), (keep.into(), "deploy_newest".into()));
    }
    for d in &deploys[..2] {
        assert_eq!(class_of(&r, d).0, "REMOVE-SAFE");
    }
    assert_eq!(class_of(&r, &spill.join("old.txt")).0, "REMOVE-SAFE");
    assert!(r["items"].as_array().unwrap().iter().all(|i| i["path"] != *spill.join("new.txt").to_string_lossy()), "a fresh spill file is not listed");
    assert!(r["bytes_reclaimable"].as_u64().unwrap() > 256 * 1024);
    assert_eq!(r["bytes_reclaimed"], 0);
    assert!(r["items_skipped"]["dirty"].as_u64() == Some(1) && r["items_skipped"]["fresh"].as_u64() == Some(1), "{r}");
    // the report changed nothing, and the idle age survived the git probes
    assert!(merged.exists() && stale.join("target").exists());

    let before: Vec<_> = [&dirty, &unpushed, &live].iter().map(|c| snapshot(c)).collect();
    let c1 = w.run(&["hygiene", "--clean"], &[]);
    assert!(c1["bytes_reclaimed"].as_u64().unwrap() > 256 * 1024, "{c1}");
    let after: Vec<_> = [&dirty, &unpushed, &live].iter().map(|c| snapshot(c)).collect();
    assert_eq!(before, after, "--clean touched a dirty, unpushed or live clone");
    assert!(
        !merged.exists() && (w.home().join(".Trash/merged/.git").exists() || w.home().join(".local/share/Trash/files/merged/.git").exists()),
        "merged clone moved to the Trash"
    );
    assert!(!stale.join("target").exists() && stale.join("notes.txt").exists() && stale.join(".git").exists(), "only target/ goes");
    assert!(!deploys[0].exists() && !deploys[1].exists() && deploys[2..].iter().all(|d| d.exists()));
    assert!(!spill.join("old.txt").exists() && spill.join("new.txt").exists());
    assert!(cache.join("blob").exists());

    // idempotent: nothing is left to remove and nothing more changes
    let c2 = w.run(&["hygiene", "--clean"], &[]);
    assert_eq!(c2["bytes_reclaimed"], 0, "{c2}");
    assert!(c2["items"].as_array().unwrap().iter().all(|i| i["class"] == keep), "{c2}");
    assert_eq!(before, [&dirty, &unpushed, &live].iter().map(|c| snapshot(c)).collect::<Vec<_>>());

    // counters reached the telemetry inbox; a low-disk floor raises the notice; the off switch does nothing
    ah_engine::defaults::init().unwrap();
    let inbox = std::fs::read_to_string(w.dir.join("eng").join(ah_engine::defaults::text("files.telemetry_inbox"))).unwrap();
    for k in ["bytes_reclaimable", "bytes_reclaimed", "items_listed", "items_skipped_dirty"] {
        assert!(inbox.contains(k), "telemetry counter {k} missing");
    }
    let low = w.run(&["hygiene"], &[("ANTIHALL_DISK_WATCH_WARN_GB", "100000000")]);
    assert!(low["notice"].as_str().is_some_and(|n| n.contains("hygiene --clean")), "{low}");
    let off = w.run(&["hygiene", "--clean"], &[("ANTIHALL_DISK_HYGIENE", "0")]);
    assert_eq!(off["enabled"], false);
}
