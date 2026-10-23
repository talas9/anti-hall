//! Crash-loop breaker and checksum roll-back drills (issue #158), all in a scratch HOME with the real binary and the real shell wrappers.
//!
//! * `spawn_storm_*`: a daemon that exits at once reports no crash, so only the spawn count can stop the respawning. The scratch
//!   plugin starts the daemon with an argument the binary rejects (`health.serve_arg`), which is an instant-exit daemon.
//! * `crashloop_*`: the breaker ends by cooldown, by a replaced binary and by an operator reset, and never re-trips on old events.
//! * the end-to-end roll-back drills: the engine's trip asks the thin client (`ah-hook integrity check`) to put the known-good binary back,
//!   which it does only for a damaged, never-healthy, failing one (the verbs themselves are tested in `ah-launcher/tests/integrity.rs`).
#![allow(clippy::unwrap_used, clippy::expect_used)] // a test crate: a panic is the failure report, and E2 exempts tests
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

const BIN: &str = env!("CARGO_BIN_EXE_ah-engine");

fn repo_plugin() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap().join("plugins/anti-hall")
}

/// The built thin client (`ah-launcher`): AH_HOOK_BIN, else its release or debug build in this checkout.
fn launcher_bin() -> PathBuf {
    if let Some(p) = std::env::var_os("AH_HOOK_BIN").map(PathBuf::from).filter(|p| p.is_file()) {
        return p;
    }
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap().join("ah-launcher/target");
    ["release", "debug"]
        .iter()
        .map(|b| root.join(b).join("ah-hook"))
        .find(|p| p.is_file())
        .expect("no ah-hook binary: build ah-launcher (cargo build in ah-launcher/) or set AH_HOOK_BIN")
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
        std::fs::copy(launcher_bin(), state.join("bin/ah-hook")).unwrap(); // the thin client runs the integrity check
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

    /// One hook call through the thin client: (exit code, seconds taken).
    fn hook(&self) -> (i32, f64) {
        let payload = self.root.join("payload.json");
        std::fs::write(&payload, r#"{"hook_event_name":"UserPromptSubmit","prompt":"x","session_id":"drill"}"#).unwrap();
        let t = Instant::now();
        let out =
            self.cmd(launcher_bin().to_str().unwrap()).arg("UserPromptSubmit").arg("--plugin-root").arg(&self.plugin).stdin(std::fs::File::open(&payload).unwrap()).output().unwrap();
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

/// Waits for the detached integrity check the engine started.
fn wait_for(what: &str, mut done: impl FnMut() -> bool, evidence: impl Fn() -> String) {
    let t = Instant::now();
    while !done() {
        assert!(t.elapsed() < crate::common::scaled(Duration::from_secs(20)), "timed out waiting for {what}\n{}", evidence());
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
    // the thin client sets the bad binary aside first and records the roll-back last: wait for the record, not the rename
    wait_for("the roll-back", || asides(&w) == 1 && w.state.join("rollback.last").exists(), || format!("integrity.log:\n{}\nengine log:\n{}", std::fs::read_to_string(w.state.join("integrity.log")).unwrap_or_default(), w.log()));
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
