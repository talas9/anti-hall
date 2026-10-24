//! `ah-hook integrity <verb>`: the binary known-good / roll-back logic that used to be `hooks/ah-engine-integrity.sh`. Scratch HOME and
//! plugin root only; the "binaries" are text files, since the integrity check only hashes and moves them.
#![allow(clippy::unwrap_used, clippy::expect_used)]

mod common;
use common::Env;
use sha2::{Digest, Sha256};
use std::path::PathBuf;
use std::process::Command;

struct Kit {
    e: Env,
}

fn sha(body: &str) -> String {
    Sha256::digest(body.as_bytes())
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

impl Kit {
    fn new(tag: &str) -> Kit {
        let k = Kit { e: Env::new(tag) };
        std::fs::create_dir_all(k.e.state.join("bin")).unwrap();
        k
    }

    fn cmd(&self, args: &[&str], envs: &[(&str, &str)]) -> Command {
        let mut c = Command::new(env!("CARGO_BIN_EXE_ah-hook"));
        c.env_clear()
            .env("PATH", "/usr/bin:/bin")
            .env("HOME", &self.e.home)
            .arg("--plugin-root")
            .arg(&self.e.root)
            .arg("integrity")
            .args(args);
        for (k, v) in envs {
            c.env(k, v);
        }
        c
    }

    fn run_env(&self, args: &[&str], envs: &[(&str, &str)]) -> (i32, String) {
        let o = self.cmd(args, envs).output().unwrap();
        (
            o.status.code().unwrap_or(-1),
            String::from_utf8_lossy(&o.stdout).into_owned(),
        )
    }

    /// A verb; every verb but a refused `lock` exits 0 (never fails a session).
    fn run(&self, verb: &str) -> String {
        let (code, out) = self.run_env(&[verb], &[]);
        assert_eq!(code, 0, "{verb} never fails a session");
        out
    }

    fn put(&self, name: &str, body: &str) {
        std::fs::write(self.e.state.join("bin").join(name), body).unwrap();
    }

    fn text(&self, rel: &str) -> String {
        std::fs::read_to_string(self.e.state.join(rel)).unwrap_or_default()
    }

    fn write(&self, rel: &str, body: &str) {
        std::fs::create_dir_all(self.e.state.join(rel).parent().unwrap()).unwrap();
        std::fs::write(self.e.state.join(rel), body).unwrap();
    }

    fn aside(&self) -> Vec<String> {
        let mut v: Vec<String> = std::fs::read_dir(self.e.state.join("bin"))
            .unwrap()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .filter(|n| n.starts_with("ah-engine.rolledback-"))
            .collect();
        v.sort();
        v
    }

    fn log(&self) -> String {
        self.text("integrity.log")
    }

    /// An installed binary that ran healthy (so `check` promotes it), then a damaged one in its place.
    fn good_then_damaged(&self) -> (String, String) {
        self.put("ah-engine", "GOOD-BINARY");
        self.run("record");
        let good = sha("GOOD-BINARY");
        self.write("healthy.binary", &format!("{good}\n"));
        self.run("check");
        assert_eq!(
            self.text("bin/ah-engine.good"),
            "GOOD-BINARY",
            "a binary that ran healthy is promoted to known-good"
        );
        self.put("ah-engine", "DAMAGED-BINARY");
        (good, sha("DAMAGED-BINARY"))
    }
}

#[test]
fn rollback_restores_the_known_good_binary_and_keeps_the_damaged_one() {
    let k = Kit::new("rb1");
    let (good, bad) = k.good_then_damaged();
    k.write("rollback.request", &format!("{bad}\n")); // the engine's crash-loop trip asked for it
    k.run("check");
    assert_eq!(k.text("bin/ah-engine"), "GOOD-BINARY");
    let aside = k.aside();
    assert_eq!(aside.len(), 1, "{aside:?}");
    assert!(
        aside[0].ends_with(&format!("-{}", &bad[..8])),
        "named by time and sha prefix: {aside:?}"
    );
    assert_eq!(
        k.text(&format!("bin/{}", aside[0])),
        "DAMAGED-BINARY",
        "the damaged binary is renamed, never deleted"
    );
    assert!(
        k.text("rollback.last").contains(&good),
        "{}",
        k.text("rollback.last")
    );
    assert_eq!(k.text("bin/ah-engine.expected").trim(), good);
    assert!(!k.e.state.join("rollback.request").exists());
    assert!(k.log().contains("event=rollback "), "{}", k.log());
    // idempotent: a second check changes nothing
    k.run("check");
    assert_eq!(k.aside().len(), 1);
    assert_eq!(k.text("bin/ah-engine"), "GOOD-BINARY");
    let mode = std::fs::metadata(k.e.state.join("bin/ah-engine")).unwrap();
    assert_ne!(
        std::os::unix::fs::PermissionsExt::mode(&mode.permissions()) & 0o111,
        0,
        "the restored binary is executable"
    );
}

#[test]
fn rollback_counts_wrapper_failures_and_needs_all_of_them() {
    let k = Kit::new("rb2");
    k.good_then_damaged();
    for _ in 0..2 {
        k.run("fail");
    }
    assert_eq!(
        k.text("bin/ah-engine"),
        "DAMAGED-BINARY",
        "two failures are below rollback.fail_n"
    );
    k.run("fail");
    assert_eq!(
        k.text("bin/ah-engine"),
        "GOOD-BINARY",
        "the third failure inside the window rolls back"
    );
    assert_eq!(k.aside().len(), 1);
    assert_eq!(
        k.text("wrapper.fails"),
        "",
        "the failure count restarts after a roll-back"
    );
}

#[test]
fn failures_older_than_the_window_do_not_count() {
    let k = Kit::new("rb2b");
    k.good_then_damaged();
    let old = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs()
        - 100_000;
    k.write("wrapper.fails", &format!("{old}\n{old}\n{old}\n{old}\n"));
    k.run("check");
    assert_eq!(k.text("bin/ah-engine"), "DAMAGED-BINARY");
    assert!(k.aside().is_empty());
}

#[test]
fn rollback_leaves_alone_what_is_not_damaged_or_not_failing() {
    // matches the expected checksum: the installer's own binary is never swapped, even with a request
    let k = Kit::new("rb3");
    k.put("ah-engine", "GOOD-BINARY");
    k.run("record");
    let good = sha("GOOD-BINARY");
    k.write("healthy.binary", &format!("{good}\n"));
    k.run("check");
    k.write("rollback.request", &format!("{good}\n"));
    k.run("check");
    assert_eq!(k.text("bin/ah-engine"), "GOOD-BINARY");
    assert!(k.aside().is_empty());
    // a hand-built binary that is not failing (just differs): left alone
    let k = Kit::new("rb3b");
    k.good_then_damaged();
    k.run("check");
    assert_eq!(k.text("bin/ah-engine"), "DAMAGED-BINARY");
    // a hand-built binary that has run healthy: left alone however much it fails
    let (_, bad) = k.good_then_damaged();
    k.write("healthy.binary", &format!("{bad}\n"));
    for _ in 0..5 {
        k.run("fail");
    }
    assert_eq!(k.text("bin/ah-engine"), "DAMAGED-BINARY");
    assert!(k.aside().is_empty());
}

#[test]
fn rollback_never_replaces_an_accepted_binary_and_needs_a_verified_good_copy() {
    let k = Kit::new("rb4");
    k.good_then_damaged();
    k.run("accept");
    for _ in 0..4 {
        k.run("fail");
    }
    assert_eq!(
        k.text("bin/ah-engine"),
        "DAMAGED-BINARY",
        "accept vouches for the installed binary"
    );
    // no verified known-good copy: nothing to restore, nothing moved
    let k = Kit::new("rb4b");
    k.put("ah-engine", "FIRST");
    k.run("record");
    k.put("ah-engine", "SECOND");
    for _ in 0..4 {
        k.run("fail");
    }
    assert_eq!(k.text("bin/ah-engine"), "SECOND");
    assert!(k.aside().is_empty());
    // a known-good copy that no longer matches its checksum is not trusted
    let k = Kit::new("rb4c");
    k.good_then_damaged();
    k.put("ah-engine.good", "TAMPERED");
    for _ in 0..4 {
        k.run("fail");
    }
    assert_eq!(k.text("bin/ah-engine"), "DAMAGED-BINARY");
    assert!(k.aside().is_empty());
}

#[test]
fn the_mismatch_rollback_can_be_switched_off() {
    let k = Kit::new("rb6");
    let (_, bad) = k.good_then_damaged();
    k.write("rollback.request", &format!("{bad}\n"));
    let (code, _) = k.run_env(&["check"], &[("AH_ENGINE_ROLLBACK_ON_MISMATCH", "0")]);
    assert_eq!(code, 0);
    assert_eq!(k.text("bin/ah-engine"), "DAMAGED-BINARY");
    assert!(k.aside().is_empty());
}

#[test]
fn status_prints_what_is_known() {
    let k = Kit::new("rb5");
    let (good, bad) = k.good_then_damaged();
    let s = k.run("status");
    assert!(s.contains(&format!("installed {bad}")), "{s}");
    assert!(s.contains(&format!("expected  {good}")), "{s}");
    assert!(s.contains(&format!("good      {good}")), "{s}");
}

#[test]
fn a_settings_file_without_a_key_does_nothing_and_does_not_fail() {
    let k = Kit::new("nokey");
    k.put("ah-engine", "X");
    k.e.edit_toml("engine.toml", |t| {
        t.replace("[rollback.bin_name]", "[rollback.bin_name_gone]")
    });
    k.run("record");
    assert!(
        !k.e.state.join("bin/ah-engine.expected").exists(),
        "nothing is safe to do without the key"
    );
}

#[test]
fn the_install_lock_is_one_lock_with_one_owner() {
    let k = Kit::new("lock1");
    let w = [("AH_ENGINE_INSTALL_LOCK_WAIT_S", "1")];
    assert_eq!(
        k.run_env(&["lock", "100 1"], &w).0,
        0,
        "a free lock is taken"
    );
    assert_eq!(
        k.run_env(&["lock", "100 1"], &w).0,
        0,
        "the holder asking again keeps it"
    );
    // a live holder (this test process) within lock_stale_s is not broken
    k.write(
        "install.lock/owner",
        &format!("{} {}\n", std::process::id(), now()),
    );
    let (code, _) = k.run_env(&["lock", "200 2"], &w);
    assert_eq!(
        code, 1,
        "another holder keeps it for the whole wait (a live pid within lock_stale_s is not broken)"
    );
    assert!(k.log().contains("event=lock_refused"), "{}", k.log());
}

#[test]
fn only_the_holder_can_give_the_lock_back() {
    let k = Kit::new("lock2");
    let me = format!("{} {}", std::process::id(), now());
    let w = [("AH_ENGINE_INSTALL_LOCK_WAIT_S", "1")];
    assert_eq!(k.run_env(&["lock", &me], &w).0, 0);
    k.run_env(&["unlock", "x y"], &w);
    assert!(
        k.e.state.join("install.lock/owner").exists(),
        "a stranger's unlock changes nothing"
    );
    assert_eq!(k.run_env(&["unlock", &me], &w).0, 0);
    assert!(
        !k.e.state.join("install.lock").exists(),
        "the holder's unlock removes the lock"
    );
}

#[test]
fn record_waits_for_a_held_lock_unless_the_installer_holds_it() {
    let k = Kit::new("lock3");
    k.put("ah-engine", "NEW");
    let me = format!("{} {}", std::process::id(), now());
    k.run_env(&["lock", &me], &[]);
    // someone else holds it: record does not write, and says so
    let (code, _) = k.run_env(&["record"], &[("AH_ENGINE_INSTALL_LOCK_WAIT_S", "1")]);
    assert_eq!(code, 0);
    assert!(!k.e.state.join("bin/ah-engine.expected").exists());
    assert!(k.log().contains("event=record_lock_held"), "{}", k.log());
    // the installer itself holds it and says so with its token: record runs under that hold and leaves it held
    let (code, _) = k.run_env(&["record"], &[("AH_ENGINE_INSTALL_LOCK_TOKEN", &me)]);
    assert_eq!(code, 0);
    assert_eq!(k.text("bin/ah-engine.expected").trim(), sha("NEW"));
    assert!(
        k.e.state.join("install.lock/owner").exists(),
        "record leaves the installer's hold to the installer"
    );
}

#[test]
fn check_and_fail_skip_instead_of_holding_a_session() {
    let k = Kit::new("lock4");
    let (_, bad) = k.good_then_damaged();
    k.write("rollback.request", &format!("{bad}\n"));
    let me = format!("{} {}", std::process::id(), now());
    k.run_env(&["lock", &me], &[]);
    let t = std::time::Instant::now();
    k.run("check");
    assert!(
        t.elapsed().as_secs() < 10,
        "bounded by rollback.lock_hook_wait_s"
    );
    assert_eq!(
        k.text("bin/ah-engine"),
        "DAMAGED-BINARY",
        "no roll-back runs under another holder's lock"
    );
    assert!(k.log().contains("event=check_lock_held"), "{}", k.log());
    k.run_env(&["unlock", &me], &[]);
    k.run("check");
    assert_eq!(
        k.text("bin/ah-engine"),
        "GOOD-BINARY",
        "the next run checks"
    );
}

#[test]
fn a_lock_whose_holder_is_gone_is_broken_and_kept() {
    let k = Kit::new("lock5");
    let mut dead = Command::new("true").spawn().unwrap();
    let pid = dead.id();
    dead.wait().unwrap();
    k.write("install.lock/owner", &format!("{pid} {}\n", now()));
    let me = format!("{} {}", std::process::id(), now());
    assert_eq!(
        k.run_env(&["lock", &me], &[("AH_ENGINE_INSTALL_LOCK_WAIT_S", "1")])
            .0,
        0
    );
    assert_eq!(k.text("install.lock/owner").trim(), me);
    assert!(k.log().contains("event=lock_broke_stale"), "{}", k.log());
    let kept: Vec<PathBuf> = std::fs::read_dir(&k.e.state)
        .unwrap()
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.to_string_lossy().contains("install.lock.stale."))
        .collect();
    assert_eq!(
        kept.len(),
        1,
        "the stale owner is renamed aside, never deleted: {kept:?}"
    );
}

#[test]
fn a_lock_held_past_the_stale_age_is_broken_even_when_its_pid_lives() {
    let k = Kit::new("lock6");
    k.write("install.lock/owner", &format!("{} 1\n", std::process::id())); // taken in 1970
    let me = format!("{} {}", std::process::id(), now());
    assert_eq!(
        k.run_env(&["lock", &me], &[("AH_ENGINE_INSTALL_LOCK_WAIT_S", "1")])
            .0,
        0
    );
    assert_eq!(k.text("install.lock/owner").trim(), me);
}

fn now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs()
}
