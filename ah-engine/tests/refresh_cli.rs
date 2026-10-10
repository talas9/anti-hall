//! `ah-engine refresh` end to end (v1.0 lane L06): the real binary on a scratch HOME and state directory, with fake `git`,
//! `claude`, `devswarm` and `hivecontrol` programs first on PATH, so no network, no real CLI and never the user's home.
//! It checks what the SessionStart checks rely on: a request makes the job write the cache in the Node refresh scripts'
//! layout, a handled request is not handled twice, the fallbacks of the Node scripts hold, and the reload repair honours
//! its cooldown and lock.
#![allow(clippy::unwrap_used, clippy::expect_used)] // a test crate: a panic is the failure report, and E2 exempts tests

use serde_json::Value;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::Command;

const BIN: &str = env!("CARGO_BIN_EXE_ah-engine");

struct Scratch {
    root: PathBuf,
}

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

impl Scratch {
    fn new(tag: &str) -> Scratch {
        let root = std::env::temp_dir().join(format!("ah-refresh-it-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(root.join("home")).unwrap();
        std::fs::create_dir_all(root.join("bin")).unwrap();
        std::fs::create_dir_all(root.join("state")).unwrap();
        Scratch { root }
    }
    fn home(&self) -> PathBuf {
        self.root.join("home")
    }
    /// A fake program on the test PATH: a shell script.
    fn prog(&self, name: &str, body: &str) {
        let p = self.root.join("bin").join(name);
        std::fs::write(&p, format!("#!/bin/sh\n{body}\n")).unwrap();
        std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o755)).unwrap();
    }
    fn request(&self, probe: &str, body: &str) {
        let d = self.home().join(".anti-hall/refresh");
        std::fs::create_dir_all(&d).unwrap();
        std::fs::write(d.join(format!("{probe}.json")), body).unwrap();
    }
    fn run(&self, extra: &[&str]) -> Value {
        let plugin = Path::new(env!("CARGO_MANIFEST_DIR")).join("../plugins/anti-hall");
        let out = Command::new(BIN)
            .arg("refresh")
            .args(extra)
            .arg("--json")
            .env_clear()
            .env("HOME", self.home())
            .env("PATH", format!("{}:/usr/bin:/bin", self.root.join("bin").display()))
            .env("AH_ENGINE_DIR", self.root.join("state"))
            .env("AH_ENGINE_PLUGIN_ROOT", plugin)
            .env("AH_ENGINE_NOSPAWN", "1")
            .output()
            .unwrap();
        assert!(out.status.success(), "refresh failed: {}", String::from_utf8_lossy(&out.stderr));
        serde_json::from_slice(&out.stdout).unwrap_or_else(|e| panic!("{e}: {}", String::from_utf8_lossy(&out.stdout)))
    }
    fn read(&self, rel: &str) -> Option<Value> {
        std::fs::read(self.home().join(rel)).ok().map(|b| serde_json::from_slice(&b).unwrap())
    }
}

fn outcome(v: &Value, probe: &str) -> String {
    v["probes"].as_array().unwrap().iter().find(|p| p["probe"] == probe).unwrap()["outcome"].as_str().unwrap().to_string()
}

#[test]
fn refresh_writes_requested_caches_once_in_the_node_layout() {
    let s = Scratch::new("caches");
    s.prog("git", "printf 'a\\trefs/tags/v0.9.0\\nb\\trefs/tags/v0.12.1\\nc\\trefs/tags/v0.12.1^{}\\n'");
    s.prog("claude", "echo '2.1.240 (Claude Code)'");
    s.prog("devswarm", "echo 'devswarm 2.5.1'");
    // nothing requested: nothing written
    let v = s.run(&[]);
    for p in ["version", "claude_cli", "devswarm", "repair"] {
        assert_eq!(outcome(&v, p), "skipped", "{v}");
    }
    assert!(s.read(".anti-hall/version-check.json").is_none());
    s.request("version", "{\"requestedAt\":1}");
    s.request("claude_cli", "{\"requestedAt\":1}");
    s.request("devswarm", "{\"requestedAt\":1}");
    let v = s.run(&[]);
    for p in ["version", "claude_cli", "devswarm"] {
        assert_eq!(outcome(&v, p), "refreshed", "{v}");
    }
    let vc = s.read(".anti-hall/version-check.json").unwrap();
    assert_eq!(vc["latest"], "v0.12.1");
    assert!(vc["checkedAt"].as_f64().unwrap() > 0.0);
    let cc = s.read(".anti-hall/claude-cli-version.json").unwrap();
    assert_eq!(cc["installed"], "2.1.240");
    assert_eq!(cc["source"], "claude");
    assert!(cc["baseline"].is_string());
    let ds = s.read(".anti-hall/devswarm-version.json").unwrap();
    assert_eq!(ds["installed"], "2.5.1");
    assert_eq!(ds["source"], "devswarm");
    // handled: the next run skips them
    let v = s.run(&[]);
    for p in ["version", "claude_cli", "devswarm"] {
        assert_eq!(outcome(&v, p), "skipped", "{v}");
    }
    // a newer request is handled again
    s.request("claude_cli", "{\"requestedAt\":2}");
    assert_eq!(outcome(&s.run(&[]), "claude_cli"), "refreshed");
}

#[test]
fn refresh_follows_the_node_fallbacks() {
    let s = Scratch::new("fallbacks");
    // the remote fails, the marketplace clone answers (git runs inside it)
    std::fs::create_dir_all(s.home().join(".claude/plugins/marketplaces/anti-hall")).unwrap();
    s.prog("git", "case \"$3\" in origin) case \"$PWD\" in */marketplaces/anti-hall) printf 'x\\trefs/tags/v1.0.0\\n'; exit 0;; esac;; esac; exit 2");
    // no devswarm binary: the hivecontrol shim answers
    s.prog("hivecontrol", "echo 2.6.0 >&2");
    // the Claude CLI prints two different versions: ambiguous, installed stays null
    s.prog("claude", "echo '1.2.3 built with 4.5.6'");
    s.request("version", "{\"requestedAt\":5}");
    s.request("claude_cli", "{\"requestedAt\":5}");
    s.request("devswarm", "{\"requestedAt\":5}");
    let v = s.run(&[]);
    assert_eq!(outcome(&v, "version"), "refreshed", "{v}");
    assert_eq!(s.read(".anti-hall/version-check.json").unwrap()["latest"], "v1.0.0");
    let ds = s.read(".anti-hall/devswarm-version.json").unwrap();
    assert_eq!(ds["installed"], "2.6.0");
    assert_eq!(ds["source"], "hivecontrol");
    let cc = s.read(".anti-hall/claude-cli-version.json").unwrap();
    assert!(cc["installed"].is_null() && cc["source"].is_null(), "{cc}");
    // no git answer at all: the version cache is left alone (Node writes nothing then), the request counts as handled
    s.prog("git", "exit 1");
    std::fs::remove_file(s.home().join(".anti-hall/version-check.json")).unwrap();
    s.request("version", "{\"requestedAt\":6}");
    let v = s.run(&[]);
    assert_eq!(outcome(&v, "version"), "failed", "{v}");
    assert!(s.read(".anti-hall/version-check.json").is_none());
    assert_eq!(outcome(&s.run(&[]), "version"), "skipped");
}

#[test]
fn refresh_repair_honours_its_cooldown_and_lock() {
    let s = Scratch::new("repair");
    // a repair at this version within the cooldown: skipped, and the request is handled
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis() as u64;
    std::fs::create_dir_all(s.home().join(".anti-hall")).unwrap();
    std::fs::write(s.home().join(".anti-hall/repair-on-reload.last.json"), format!("{{\"ts\":{now},\"version\":\"9.9.9\"}}")).unwrap();
    s.request("repair", "{\"requestedAt\":1,\"version\":\"9.9.9\"}");
    let v = s.run(&[]);
    assert_eq!(outcome(&v, "repair"), "skipped", "{v}");
    assert_eq!(outcome(&s.run(&[]), "repair"), "skipped");
    // `--force` never starts a repair nobody asked for
    let v = s.run(&["--force"]);
    assert_eq!(outcome(&v, "repair"), "skipped", "{v}");
    // a live holder of the Node repair lock: the request stays pending
    let lock = format!(
        "{{\"pid\":{},\"host\":\"{}\",\"ts\":{now},\"token\":\"t\"}}",
        std::process::id(),
        String::from_utf8_lossy(&Command::new("hostname").output().unwrap().stdout).trim()
    );
    std::fs::write(s.home().join(".anti-hall/repair-on-reload.lock"), lock).unwrap();
    s.request("repair", "{\"requestedAt\":2,\"version\":\"9.9.8\"}");
    let v = s.run(&[]);
    assert_eq!(outcome(&v, "repair"), "failed", "{v}");
    let handled: Value = serde_json::from_slice(&std::fs::read(s.home().join(".anti-hall/refresh/handled.json")).unwrap()).unwrap();
    assert_eq!(handled["repair"].as_f64(), Some(1.0), "a locked repair is retried at the next tick: {handled}");
    // the cooldown record is untouched
    let last: Value = serde_json::from_slice(&std::fs::read(s.home().join(".anti-hall/repair-on-reload.last.json")).unwrap()).unwrap();
    assert_eq!(last["version"], "9.9.9");
}
