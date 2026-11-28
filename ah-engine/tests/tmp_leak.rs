//! Temp-directory leak regression: a test process that makes scratch directories through `tmpsweep::scratch` leaves none behind,
//! on a normal run and on a failing one, and the start-up sweep removes only its own old entries.
#![allow(clippy::unwrap_used, clippy::expect_used)] // a test crate: a panic is the failure report
use ah_engine::tmpsweep;
use std::process::Command;
use std::time::{Duration, SystemTime};

const MODE: &str = "AH_TMPLEAK_MODE";

/// Runs only inside the child the tests below spawn: makes scratch directories, then ends normally or fails.
#[test]
fn child_probe() {
    let Ok(mode) = std::env::var(MODE) else { return };
    for tag in ["a", "b", "c"] {
        let d = tmpsweep::scratch("ah-script-", tag);
        std::fs::write(d.join("x"), "x").unwrap();
    }
    assert!(mode != "error", "forced failure after the scratch dirs exist");
}

fn entries(dir: &std::path::Path) -> usize {
    std::fs::read_dir(dir).unwrap().count()
}

fn run_child(mode: &str) -> usize {
    let tmp = std::env::temp_dir().join(format!("ah-tmpleak-parent-{mode}-{}", std::process::id()));
    std::fs::create_dir_all(&tmp).unwrap();
    let before = entries(&tmp);
    let out = Command::new(std::env::current_exe().unwrap())
        .args(["child_probe", "--exact", "--test-threads=1"])
        .env(MODE, mode)
        .env("TMPDIR", &tmp)
        .output()
        .unwrap();
    assert_eq!(out.status.success(), mode == "normal", "child outcome for {mode}");
    let after = entries(&tmp);
    std::fs::remove_dir_all(&tmp).unwrap();
    assert_eq!(before, 0);
    after
}

#[test]
fn a_normal_run_leaves_no_temp_entries() {
    assert_eq!(run_child("normal"), 0);
}

#[test]
fn a_failing_run_leaves_no_temp_entries() {
    assert_eq!(run_child("error"), 0);
}

#[test]
fn the_sweep_removes_only_old_entries_with_a_listed_prefix() {
    let root = std::env::temp_dir().join(format!("ah-tmpleak-sweep-{}", std::process::id()));
    std::fs::create_dir_all(&root).unwrap();
    let old = SystemTime::now() - Duration::from_secs(7200);
    let mk = |name: &str, aged: bool| {
        let p = root.join(name);
        std::fs::create_dir_all(p.join("inner")).unwrap();
        if aged {
            std::fs::File::open(&p).unwrap().set_modified(old).unwrap();
        }
    };
    mk("ah-script-old", true);
    mk("ah-script-young", false);
    mk("other-old", true);
    mk("keep-ah-script-old", true);
    std::os::unix::fs::symlink(&root, root.join("ah-script-link")).unwrap();
    std::fs::File::open(&root).unwrap();
    let n = tmpsweep::sweep(&root, &["ah-script-"], Duration::from_secs(3600), SystemTime::now());
    let mut left: Vec<String> = std::fs::read_dir(&root).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().into_owned()).collect();
    left.sort();
    assert_eq!(n, 1);
    assert_eq!(left, ["ah-script-link", "ah-script-young", "keep-ah-script-old", "other-old"]);
    // age 0 = off, an empty prefix matches nothing
    assert_eq!(tmpsweep::sweep(&root, &["ah-script-"], Duration::ZERO, SystemTime::now()), 0);
    assert_eq!(tmpsweep::sweep(&root, &[""], Duration::from_secs(1), SystemTime::now()), 0);
    std::fs::remove_dir_all(&root).unwrap();
}

#[test]
fn the_prefixes_and_the_age_come_from_the_shipped_config() {
    ah_engine::defaults::init().unwrap();
    assert_eq!(ah_engine::defaults::num("disk_watch.tmp_sweep_max_age_s"), 3600);
    let p = ah_engine::defaults::list("disk_watch.tmp_sweep_prefixes");
    for want in ["ah-script-", "ah-reblock-", "ah-hostd-"] {
        assert!(p.contains(&want), "{want} is swept");
    }
    assert!(p.iter().all(|x| !x.is_empty()), "no empty prefix");
}
