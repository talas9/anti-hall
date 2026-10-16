//! Crash-loop breaker and checksum roll-back drills (issue #158), all in a scratch HOME with the real binary and the real shell wrappers.
//!
//! * `spawn_storm_*`: a daemon that exits at once reports no crash, so only the spawn count can stop the respawning. The scratch
//!   plugin starts the daemon with an argument the binary rejects (`health.serve_arg`), which is an instant-exit daemon.
//! * `crashloop_*`: the breaker ends by cooldown, by a replaced binary and by an operator reset, and never re-trips on old events.
//! * `rollback_*`: `hooks/ah-engine-integrity.sh` puts the known-good binary back only for a damaged, never-healthy, failing one.
#![allow(clippy::unwrap_used, clippy::expect_used)] // a test crate: a panic is the failure report, and E2 exempts tests
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

const BIN: &str = env!("CARGO_BIN_EXE_ah-engine");

fn repo_plugin() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap().join("plugins/anti-hall")
}

fn scratch(tag: &str) -> PathBuf {
    let d = std::env::temp_dir().join(format!("ah-crashloop-{tag}-{}", std::process::id()));
    std::fs::remove_dir_all(&d).ok(); // a scratch dir of this test process
    std::fs::create_dir_all(&d).unwrap();
    d
}

fn copy_tree(from: &Path, to: &Path) {
    std::fs::create_dir_all(to).unwrap();
    for e in std::fs::read_dir(from).unwrap().flatten() {
        let (p, q) = (e.path(), to.join(e.file_name()));
        if p.is_dir() {
            copy_tree(&p, &q);
        } else {
            std::fs::copy(&p, &q).unwrap();
        }
    }
}

/// The drills time real processes: one at a time, so a loaded machine cannot starve a debug-build engine past the wrapper's deadline.
static ONE_AT_A_TIME: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// A scratch HOME with the engine installed where the wrapper looks, and a scratch plugin whose daemon exits at once.
struct World {
    _turn: std::sync::MutexGuard<'static, ()>,
    root: PathBuf,
    home: PathBuf,
    plugin: PathBuf,
    state: PathBuf,
}

impl World {
    fn new(tag: &str) -> World {
        let turn = ONE_AT_A_TIME.lock().unwrap_or_else(|e| e.into_inner());
        let root = scratch(tag);
        let (home, plugin) = (root.join("home"), root.join("plugin"));
        let state = home.join(".anti-hall/ah-engine");
        std::fs::create_dir_all(state.join("bin")).unwrap();
        for sub in ["engine", "hooks"] {
            copy_tree(&repo_plugin().join(sub), &plugin.join(sub));
        }
        std::fs::copy(BIN, state.join("bin/ah-engine")).unwrap();
        let toml = plugin.join("engine/defaults/engine.toml");
        let text = std::fs::read_to_string(&toml).unwrap();
        assert!(text.contains("value = \"serve\"\n"), "the daemon argument is where the drill expects it");
        std::fs::write(&toml, text.replacen("value = \"serve\"\n", "value = \"no-such-subcommand\"\n", 1)).unwrap();
        World { _turn: turn, root, home, plugin, state }
    }

    fn engine(&self) -> PathBuf {
        self.state.join("bin/ah-engine")
    }

    fn cmd(&self, prog: &str) -> Command {
        let mut c = Command::new(prog);
        c.env("HOME", &self.home)
            .env_remove("AH_ENGINE_DIR")
            .env_remove("AH_ENGINE_BIN")
            .env("AH_ENGINE_PLUGIN_ROOT", &self.plugin)
            .env("AH_WRAPPER_TEST", "1")
            .env("AH_HOOK_TIMEOUT_MS", "20000")
            .env("AH_ENGINE_SPAWN_N", "3")
            .env("AH_ENGINE_DOWN_MARKER_TTL_MS", "1")
            .env("AH_ENGINE_SPAWN_LOCK_TTL_MS", "1")
            .stdin(Stdio::null());
        c
    }

    /// One hook call through the shell wrapper: (exit code, seconds taken).
    fn hook(&self) -> (i32, f64) {
        let payload = self.root.join("payload.json");
        std::fs::write(&payload, r#"{"hook_event_name":"UserPromptSubmit","prompt":"x","session_id":"drill"}"#).unwrap();
        let t = Instant::now();
        let out =
            self.cmd("sh").arg(self.plugin.join("hooks/ah-hook.sh")).arg("UserPromptSubmit").stdin(std::fs::File::open(&payload).unwrap()).output().unwrap();
        (out.status.code().unwrap_or(-1), t.elapsed().as_secs_f64())
    }

    fn log(&self) -> String {
        std::fs::read_to_string(self.state.join("ah-engine.log")).unwrap_or_default()
    }

    fn spawns(&self) -> usize {
        self.log().lines().filter(|l| l.contains("\tclient_spawn_attempt\t")).count()
    }

    fn tripped(&self) -> bool {
        self.state.join("crashloop.until").exists()
    }

    /// Calls until the breaker trips; panics when it does not within `max` calls.
    fn run_to_trip(&self, max: usize) {
        for _ in 0..max {
            let (rc, _) = self.hook();
            assert_eq!(rc, 0, "a hook fails open while the daemon cannot start");
            if self.tripped() {
                return;
            }
            std::thread::sleep(Duration::from_millis(30));
        }
        panic!("the breaker never tripped; log:\n{}", self.log());
    }
}

impl Drop for World {
    fn drop(&mut self) {
        std::fs::remove_dir_all(&self.root).ok(); // keep: the scratch dir of this test; absent is the goal state
    }
}

#[test]
fn spawn_storm_trips_after_spawn_n_and_every_hook_fails_open_fast() {
    let w = World::new("storm");
    w.run_to_trip(12);
    assert_eq!(w.spawns(), 3, "exactly client.spawn_n starts, then the respawning stops:\n{}", w.log());
    assert!(w.log().contains("\tcrashloop\tcrashloop\tdaemon died 3 times in 60 s"), "the reason names the rule that fired:\n{}", w.log());
    for _ in 0..5 {
        let (rc, secs) = w.hook();
        assert_eq!(rc, 0);
        assert!(secs < 1.0, "a hook during the cooldown takes {secs:.2}s");
    }
    assert_eq!(w.spawns(), 3, "no daemon is started during the cooldown");
}

#[test]
fn crashloop_cooldown_ends_by_itself_and_does_not_retrip_on_old_events() {
    let w = World::new("cooldown");
    w.run_to_trip(12);
    let tripped_at = w.spawns();
    // the stamp holds the end time of the cooldown: an end time in the past is a cooldown that has run out, while the old
    // starts are still inside the count window (they were already judged)
    let until = w.state.join("crashloop.until");
    std::fs::write(&until, "1").unwrap(); // an end time long past
    let (rc, _) = w.hook();
    assert_eq!(rc, 0);
    assert!(w.spawns() > tripped_at, "respawning is allowed again after the cooldown:\n{}", w.log());
    assert_eq!(w.log().matches("\tcrashloop\tcrashloop\t").count(), 1, "the old events do not trip it again at once:\n{}", w.log());
}

#[test]
fn crashloop_ends_when_the_binary_is_replaced() {
    let w = World::new("replaced");
    w.run_to_trip(12);
    let before = w.spawns();
    assert!(w.state.join("crashloop.bin").exists(), "the trip records which binary it tripped on");
    // the recorded binary is not the one that runs now: a new binary got its own chance
    std::fs::write(w.state.join("crashloop.bin"), format!("1 1 {}\n", "0".repeat(64))).unwrap();
    let (rc, _) = w.hook();
    assert_eq!(rc, 0);
    assert!(w.log().contains("\tcrashloop_reset\tnew_binary\t"), "the reset is logged:\n{}", w.log());
    assert!(w.spawns() > before, "the new binary is allowed to start:\n{}", w.log());
}

#[test]
fn crashloop_operator_reset_clears_the_breaker() {
    let w = World::new("reset");
    w.run_to_trip(12);
    let out = w.cmd(w.engine().to_str().unwrap()).arg("reset").output().unwrap();
    assert!(out.status.success(), "reset: {}", String::from_utf8_lossy(&out.stderr));
    assert!(!w.tripped());
    let before = w.spawns();
    let (rc, _) = w.hook();
    assert_eq!(rc, 0);
    assert!(w.spawns() > before, "respawning is allowed after an operator reset");
}

fn sha_of(p: &Path) -> String {
    let out = Command::new("shasum").args(["-a", "256"]).arg(p).output().unwrap();
    String::from_utf8_lossy(&out.stdout).split_whitespace().next().unwrap().to_string()
}

/// Waits for the detached integrity script the engine started.
fn wait_for(what: &str, mut done: impl FnMut() -> bool) {
    let t = Instant::now();
    while !done() {
        assert!(t.elapsed() < Duration::from_secs(20), "timed out waiting for {what}");
        std::thread::sleep(Duration::from_millis(100));
    }
}

fn asides(w: &World) -> usize {
    std::fs::read_dir(w.state.join("bin")).unwrap().flatten().filter(|e| e.file_name().to_string_lossy().starts_with("ah-engine.rolledback-")).count()
}

#[test]
fn crashloop_trip_on_a_tampered_never_healthy_binary_rolls_it_back_end_to_end() {
    let w = World::new("e2e-tampered");
    // a verified known-good copy, and an installer record that names another binary: the one running is "tampered"
    // (the copy differs from the running binary by a trailing line: it is only ever copied back, never run here)
    let mut good = std::fs::read(BIN).unwrap();
    good.extend_from_slice(b"\nknown-good\n");
    std::fs::write(w.state.join("bin/ah-engine.good"), &good).unwrap();
    let good_sha = sha_of(&w.state.join("bin/ah-engine.good"));
    std::fs::write(w.state.join("bin/ah-engine.good.sha256"), format!("{good_sha}\n")).unwrap();
    std::fs::write(w.state.join("bin/ah-engine.expected"), format!("{}\n", "a".repeat(64))).unwrap();
    w.run_to_trip(12);
    // the script sets the bad binary aside first and records the roll-back last: wait for the record, not the rename
    wait_for("the roll-back", || asides(&w) == 1 && w.state.join("rollback.last").exists());
    assert!(w.state.join("rollback.last").exists(), "the roll-back is recorded");
    assert_eq!(sha_of(&w.state.join("bin/ah-engine")), good_sha, "the known-good binary is back in place");
    assert!(w.log().contains("\trollback_request\tcrashloop\t"), "{}", w.log());
}

#[test]
fn crashloop_trip_leaves_a_healthy_or_installer_matching_binary_alone() {
    // the binary ran healthy once: the loop is not its fault
    let w = World::new("e2e-healthy");
    let me = sha_of(&w.engine());
    std::fs::copy(BIN, w.state.join("bin/ah-engine.good")).unwrap();
    std::fs::write(w.state.join("bin/ah-engine.good.sha256"), format!("{me}\n")).unwrap();
    std::fs::write(w.state.join("bin/ah-engine.expected"), format!("{}\n", "a".repeat(64))).unwrap();
    std::fs::write(w.state.join("healthy.binary"), format!("{me}\n")).unwrap();
    w.run_to_trip(12);
    std::thread::sleep(Duration::from_secs(1));
    assert_eq!(asides(&w), 0, "a binary that has run healthy is never set aside");
    assert!(!w.log().contains("rollback_request"), "{}", w.log());
    drop(w); // the drills take turns
    // the binary the installer put there: matches the expected checksum
    let w = World::new("e2e-matching");
    let me = sha_of(&w.engine());
    std::fs::copy(BIN, w.state.join("bin/ah-engine.good")).unwrap();
    std::fs::write(w.state.join("bin/ah-engine.good.sha256"), format!("{me}\n")).unwrap();
    std::fs::write(w.state.join("bin/ah-engine.expected"), format!("{me}\n")).unwrap();
    w.run_to_trip(12);
    std::thread::sleep(Duration::from_secs(1));
    assert_eq!(asides(&w), 0, "a binary that matches the installer's record is never set aside");
}

// ---- hooks/ah-engine-integrity.sh ----------------------------------------------------------------------------------------

struct Kit {
    root: PathBuf,
    state: PathBuf,
}

impl Kit {
    fn new(tag: &str) -> Kit {
        let root = scratch(tag);
        let state = root.join("state");
        std::fs::create_dir_all(state.join("bin")).unwrap();
        Kit { root, state }
    }

    fn put(&self, name: &str, body: &str) -> PathBuf {
        let p = self.state.join("bin").join(name);
        std::fs::write(&p, body).unwrap();
        p
    }

    fn sh(&self, verb: &str) -> String {
        let out = Command::new("sh")
            .arg(repo_plugin().join("hooks/ah-engine-integrity.sh"))
            .arg(verb)
            .env("AH_ENGINE_DIR", &self.state)
            .env("AH_ENGINE_PLUGIN_ROOT", repo_plugin())
            .env_remove("AH_ENGINE_ROLLBACK_ON_MISMATCH")
            .output()
            .unwrap();
        assert!(out.status.success(), "the script never fails a session: {}", String::from_utf8_lossy(&out.stderr));
        String::from_utf8_lossy(&out.stdout).into_owned()
    }

    fn text(&self, rel: &str) -> String {
        std::fs::read_to_string(self.state.join(rel)).unwrap_or_default()
    }

    fn aside(&self) -> Vec<String> {
        let mut v: Vec<String> = std::fs::read_dir(self.state.join("bin"))
            .unwrap()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .filter(|n| n.starts_with("ah-engine.rolledback-"))
            .collect();
        v.sort();
        v
    }

    fn sha(&self, body: &str) -> String {
        let f = self.root.join("sha.tmp");
        std::fs::write(&f, body).unwrap();
        let out = Command::new("shasum").args(["-a", "256"]).arg(&f).output().unwrap();
        String::from_utf8_lossy(&out.stdout).split_whitespace().next().unwrap().to_string()
    }

    /// An installed binary that ran healthy (so `check` promotes it), then a damaged one in its place.
    fn good_then_damaged(&self) -> (String, String) {
        self.put("ah-engine", "GOOD-BINARY");
        self.sh("record");
        let good = self.sha("GOOD-BINARY");
        std::fs::write(self.state.join("healthy.binary"), format!("{good}\n")).unwrap();
        self.sh("check");
        assert_eq!(self.text("bin/ah-engine.good"), "GOOD-BINARY", "a binary that ran healthy is promoted to known-good");
        self.put("ah-engine", "DAMAGED-BINARY");
        (good, self.sha("DAMAGED-BINARY"))
    }
}

impl Drop for Kit {
    fn drop(&mut self) {
        std::fs::remove_dir_all(&self.root).ok(); // keep: the scratch dir of this test; absent is the goal state
    }
}

#[test]
fn rollback_restores_the_known_good_binary_and_keeps_the_damaged_one() {
    let k = Kit::new("rb1");
    let (good, bad) = k.good_then_damaged();
    std::fs::write(k.state.join("rollback.request"), format!("{bad}\n")).unwrap(); // the engine's crash-loop trip asked for it
    k.sh("check");
    assert_eq!(k.text("bin/ah-engine"), "GOOD-BINARY");
    let aside = k.aside();
    assert_eq!(aside.len(), 1, "{aside:?}");
    assert!(aside[0].ends_with(&format!("-{}", &bad[..8])), "named by time and sha prefix: {aside:?}");
    assert_eq!(k.text(&format!("bin/{}", aside[0])), "DAMAGED-BINARY", "the damaged binary is renamed, never deleted");
    assert!(k.text("rollback.last").contains(&good), "{}", k.text("rollback.last"));
    assert_eq!(k.text("bin/ah-engine.expected").trim(), good);
    assert!(!k.state.join("rollback.request").exists());
    // idempotent: a second check changes nothing
    k.sh("check");
    assert_eq!(k.aside().len(), 1);
    assert_eq!(k.text("bin/ah-engine"), "GOOD-BINARY");
}

#[test]
fn rollback_counts_wrapper_failures_and_needs_all_of_them() {
    let k = Kit::new("rb2");
    k.good_then_damaged();
    for _ in 0..2 {
        k.sh("fail");
    }
    assert_eq!(k.text("bin/ah-engine"), "DAMAGED-BINARY", "two failures are below rollback.fail_n");
    k.sh("fail");
    assert_eq!(k.text("bin/ah-engine"), "GOOD-BINARY", "the third failure inside the window rolls back");
    assert_eq!(k.aside().len(), 1);
}

#[test]
fn rollback_leaves_alone_what_is_not_damaged_or_not_failing() {
    // matches the expected checksum: the installer's own binary is never swapped, even with a request
    let k = Kit::new("rb3");
    k.put("ah-engine", "GOOD-BINARY");
    k.sh("record");
    let good = k.sha("GOOD-BINARY");
    std::fs::write(k.state.join("healthy.binary"), format!("{good}\n")).unwrap();
    k.sh("check");
    std::fs::write(k.state.join("rollback.request"), format!("{good}\n")).unwrap();
    k.sh("check");
    assert_eq!(k.text("bin/ah-engine"), "GOOD-BINARY");
    assert!(k.aside().is_empty());
    // a hand-built binary that is not failing (just differs): left alone
    let k = Kit::new("rb3b");
    k.good_then_damaged();
    k.sh("check");
    assert_eq!(k.text("bin/ah-engine"), "DAMAGED-BINARY");
    // a hand-built binary that has run healthy: left alone however much it fails
    let (_, bad) = k.good_then_damaged();
    std::fs::write(k.state.join("healthy.binary"), format!("{bad}\n")).unwrap();
    for _ in 0..5 {
        k.sh("fail");
    }
    assert_eq!(k.text("bin/ah-engine"), "DAMAGED-BINARY");
    assert!(k.aside().is_empty());
}

#[test]
fn rollback_never_replaces_an_accepted_binary_and_needs_a_verified_good_copy() {
    let k = Kit::new("rb4");
    k.good_then_damaged();
    k.sh("accept");
    for _ in 0..4 {
        k.sh("fail");
    }
    assert_eq!(k.text("bin/ah-engine"), "DAMAGED-BINARY", "accept vouches for the installed binary");
    // no verified known-good copy: nothing to restore, nothing moved
    let k = Kit::new("rb4b");
    k.put("ah-engine", "FIRST");
    k.sh("record");
    k.put("ah-engine", "SECOND");
    for _ in 0..4 {
        k.sh("fail");
    }
    assert_eq!(k.text("bin/ah-engine"), "SECOND");
    assert!(k.aside().is_empty());
    // a known-good copy that no longer matches its checksum is not trusted
    let k = Kit::new("rb4c");
    k.good_then_damaged();
    k.put("ah-engine.good", "TAMPERED");
    for _ in 0..4 {
        k.sh("fail");
    }
    assert_eq!(k.text("bin/ah-engine"), "DAMAGED-BINARY");
    assert!(k.aside().is_empty());
}

#[test]
fn rollback_status_prints_what_is_known() {
    let k = Kit::new("rb5");
    k.good_then_damaged();
    let s = k.sh("status");
    assert!(s.contains("expected") && s.contains("good"), "{s}");
}
