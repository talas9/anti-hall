//! The layered defaults failover, end to end through the real binary: a broken edited file falls back to the last-known-good
//! copy the engine kept on an earlier load (also on a cold start, with no snapshot cache), then to the plugin's pristine copy,
//! and only when all three are broken does the hook client answer "unavailable" (exit 75, the wrapper runs Node). Every
//! run uses its own HOME and state directory.
#![allow(clippy::unwrap_used, clippy::expect_used)] // a test crate: a panic is the failure report, and E2 exempts tests

use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

const BIN: &str = env!("CARGO_BIN_EXE_ah-engine");

fn plugin_src() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../plugins/anti-hall")
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

fn files(dir: &Path) -> Vec<(String, Vec<u8>)> {
    let mut out: Vec<(String, Vec<u8>)> =
        std::fs::read_dir(dir).unwrap().flatten().map(|e| (e.file_name().to_string_lossy().into_owned(), std::fs::read(e.path()).unwrap())).collect();
    out.sort();
    out
}

/// The pristine copy ships byte-identical to the editable defaults: it is what the loader falls back to, so it must be
/// exactly what was released.
#[test]
fn the_pristine_copy_is_byte_identical_to_the_shipped_defaults() {
    let (edited, pristine) = (plugin_src().join("engine/defaults"), plugin_src().join("engine/defaults.pristine"));
    let (a, b) = (files(&edited), files(&pristine));
    let names = |v: &[(String, Vec<u8>)]| v.iter().map(|(n, _)| n.clone()).collect::<Vec<_>>();
    assert_eq!(
        names(&a),
        names(&b),
        "the pristine copy must hold the same files (sync: cp plugins/anti-hall/engine/defaults/*.toml plugins/anti-hall/engine/defaults.pristine/)"
    );
    for ((n, x), (_, y)) in a.iter().zip(&b) {
        assert!(x == y, "{n} differs from its pristine copy (sync: cp plugins/anti-hall/engine/defaults/*.toml plugins/anti-hall/engine/defaults.pristine/)");
    }
}

struct Env {
    dir: PathBuf,
}

impl Env {
    fn new(tag: &str) -> Env {
        let dir = std::env::temp_dir().join(format!("ah-failover-{tag}-{}", std::process::id()));
        ah_engine::discard::harmless(std::fs::remove_dir_all(&dir));
        std::fs::create_dir_all(dir.join("home")).unwrap();
        // the plugin's defaults, pristine copy and fallback lists (no Node hooks: the event used is a thin trigger)
        copy_tree(&plugin_src().join("engine"), &dir.join("plugin/engine"));
        copy_tree(&plugin_src().join("hooks"), &dir.join("plugin/hooks"));
        Env { dir }
    }

    fn state(&self) -> PathBuf {
        self.dir.join("state")
    }

    fn plugin(&self) -> PathBuf {
        self.dir.join("plugin")
    }

    /// A thin-trigger hook call (`Notification`): exit 0 when defaults load, 75 when none can.
    fn hook(&self) -> (i32, String) {
        let mut c = Command::new(BIN);
        c.args(["hook", "--event", "Notification", "--host", "claude"])
            .env_clear()
            .env("PATH", std::env::var("PATH").unwrap_or_default())
            .env("HOME", self.dir.join("home"))
            .env("AH_ENGINE_DIR", self.state())
            .env("AH_ENGINE_PLUGIN_ROOT", self.plugin())
            .env("AH_ENGINE_NOSPAWN", "1")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        let mut ch = c.spawn().unwrap();
        ch.stdin.take().unwrap().write_all(b"{}").unwrap();
        let o = ch.wait_with_output().unwrap();
        (o.status.code().unwrap_or(-1), String::from_utf8_lossy(&o.stderr).into_owned())
    }

    fn corrupt(&self, path: &Path) {
        let text = std::fs::read_to_string(path).unwrap();
        std::fs::write(path, text.replacen("\n[", "\n[[[", 1)).unwrap();
    }

    fn events(&self) -> String {
        std::fs::read_dir(self.state())
            .unwrap()
            .flatten()
            .filter(|e| e.file_name().to_string_lossy().ends_with(".log"))
            .map(|e| std::fs::read_to_string(e.path()).unwrap_or_default())
            .collect()
    }
}

#[test]
fn a_cold_start_with_a_broken_file_uses_the_last_known_good_copy_and_all_three_broken_defer_to_node() {
    let e = Env::new("cold");
    // a first call loads the plugin's files and keeps them as last-known-good
    let (code, err) = e.hook();
    assert_eq!(code, 0, "{err}");
    let lkg = e.state().join("defaults.lkg");
    let copies: Vec<PathBuf> = std::fs::read_dir(&lkg).unwrap().flatten().map(|d| d.path()).collect();
    assert_eq!(copies.len(), 1, "one last-known-good copy");
    assert!(copies[0].join("engine.toml").is_file() && copies[0].join("STAMP").is_file());
    // cold start: no snapshot cache, a broken edited file, the pristine copy broken too: the last-known-good copy answers
    std::fs::remove_file(e.state().join("defaults.cache")).unwrap();
    e.corrupt(&e.plugin().join("engine/defaults/engine.toml"));
    e.corrupt(&e.plugin().join("engine/defaults.pristine/engine.toml"));
    let (code, err) = e.hook();
    assert_eq!(code, 0, "the last-known-good copy answers a cold start: {err}");
    let log = e.events();
    assert!(log.contains("defaults_fallback\tparse") && log.contains("using the lkg copy"), "the fallback is logged with its reason: {log}");
    // all three broken: no defaults, the hook client defers to Node (exit 75)
    std::fs::remove_file(e.state().join("defaults.cache")).unwrap();
    for c in &copies {
        e.corrupt(&c.join("engine.toml"));
    }
    let (code, err) = e.hook();
    assert_eq!(code, 75, "no layer validates: the wrapper runs Node: {err}");
    assert!(err.contains("defaults unavailable") && err.contains("parse"), "{err}");
    ah_engine::discard::harmless(std::fs::remove_dir_all(&e.dir));
}

/// `ah-engine config heal` writes the settings an edited file lacks, even in a version-controlled checkout where the
/// automatic heal only warns; the hook client's automatic heal leaves the checkout's files alone and logs the command.
#[test]
fn config_heal_writes_missing_settings_into_a_checkout_the_automatic_heal_leaves_alone() {
    let e = Env::new("heal");
    std::fs::create_dir_all(e.plugin().join(".git")).unwrap();
    let p = e.plugin().join("engine/defaults/engine.toml");
    let text = std::fs::read_to_string(&p).unwrap();
    let head = "[daemon.queue]\n";
    let at = text.find(head).unwrap();
    let end = at + head.len() + text[at + head.len()..].find("\n[").unwrap() + 1;
    let cut = format!("{}{}", &text[..at], &text[end..]);
    std::fs::write(&p, &cut).unwrap();
    let (code, err) = e.hook();
    assert_eq!(code, 0, "the pristine copy answers the missing setting: {err}");
    assert_eq!(std::fs::read_to_string(&p).unwrap(), cut, "an automatic heal never writes into a checkout");
    assert!(e.events().contains("ah-engine config heal"), "the warning names the command: {}", e.events());
    let o = Command::new(BIN)
        .args(["config", "heal"])
        .env("HOME", e.dir.join("home"))
        .env("AH_ENGINE_DIR", e.state())
        .env("AH_ENGINE_PLUGIN_ROOT", e.plugin())
        .output()
        .unwrap();
    assert_eq!(o.status.code(), Some(0), "{}", String::from_utf8_lossy(&o.stderr));
    let healed = std::fs::read_to_string(&p).unwrap();
    assert!(healed.starts_with(&cut) && healed.contains("\n[daemon.queue]\n"), "the setting is appended, the rest kept");
    assert!(String::from_utf8_lossy(&o.stdout).contains("daemon.queue"));
    ah_engine::discard::harmless(std::fs::remove_dir_all(&e.dir));
}
