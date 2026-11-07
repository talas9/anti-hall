//! Engine currency (issue #541), against a real daemon: the scheduled `engine_currency` job compares the running engine with the
//! checkout named by `diagnostics.engineCurrencyCheckout`, shows both commits in `status --json`, counts the check, writes one
//! event-log line, and does nothing while the switch is off or no checkout is set.
#![allow(clippy::unwrap_used, clippy::expect_used)] // a test crate: a panic is the failure report, and E2 exempts tests

use crate::common;

use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

const BIN: &str = env!("CARGO_BIN_EXE_ah-engine");

const JOBS: &str = r#"{"jobs": {"engine_currency": {"kind": "engine", "action": "engine_currency", "every_ms": 600000, "timeout_ms": 20000, "persist": false, "catch_up": "skip"}}}"#;

fn plugin() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).parent().unwrap().join("plugins/anti-hall")
}

struct Env {
    dir: PathBuf,
    daemon: Option<Child>,
}

impl Env {
    fn new(tag: &str) -> Env {
        let root = std::env::var_os("AH_ENGINE_IT_ROOT").map(PathBuf::from).unwrap_or_else(|| PathBuf::from("/tmp"));
        let dir = root.join(format!("ah-cur-{tag}-{}", std::process::id()));
        ah_engine::discard::harmless(std::fs::remove_dir_all(&dir));
        std::fs::create_dir_all(dir.join("home/.anti-hall")).unwrap();
        std::fs::create_dir_all(dir.join("eng")).unwrap();
        std::fs::write(dir.join("rules.json"), r#"{"version":1,"rules":[]}"#).unwrap();
        std::fs::write(dir.join("eng/schedules.json"), JOBS).unwrap();
        Env { dir, daemon: None }
    }
    fn sock(&self) -> PathBuf {
        self.dir.join("eng/e.sock")
    }
    fn cmd(&self) -> Command {
        let mut c = Command::new(BIN);
        c.env("HOME", self.dir.join("home"))
            .env("AH_ENGINE_DIR", self.dir.join("eng"))
            .env("AH_ENGINE_RULES", self.dir.join("rules.json"))
            .env("AH_ENGINE_VERSION", "0.1.0")
            .env("AH_ENGINE_NOSPAWN", "1")
            .env("AH_ENGINE_PLUGIN_ROOT", plugin())
            .env("AH_ENGINE_TICK_MS", "20")
            .env("AH_ENGINE_TEST_HOOKS", "1")
            .env_remove("ANTIHALL_ENGINE_CURRENCY")
            .env_remove("ANTIHALL_ENGINE_CURRENCY_CHECKOUT");
        c
    }
    fn settings(&self, body: serde_json::Value) {
        std::fs::write(self.dir.join("home/.anti-hall/settings.json"), body.to_string()).unwrap();
    }
    fn start(&mut self) {
        let child = self.cmd().arg("serve").stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).spawn().unwrap();
        self.daemon = Some(child);
        let t = Instant::now();
        while t.elapsed() < common::READY_CEILING && ah_engine::client::ping(&self.sock()).is_none() {
            std::thread::sleep(Duration::from_millis(10));
        }
        assert!(ah_engine::client::ping(&self.sock()).is_some(), "daemon did not come up");
    }
    fn json(&self, args: &[&str]) -> serde_json::Value {
        let o = self.cmd().args(args).output().unwrap();
        let out = String::from_utf8_lossy(&o.stdout);
        serde_json::from_str(out.trim()).unwrap_or_else(|e| panic!("{args:?}: {e}: {out}"))
    }
    fn log(&self) -> String {
        std::fs::read_to_string(self.dir.join("eng/ah-engine.log")).unwrap_or_default()
    }
}

impl Drop for Env {
    fn drop(&mut self) {
        if let Some(mut c) = self.daemon.take() {
            common::stop_child(&self.sock(), &mut c);
        }
        ah_engine::discard::harmless(std::fs::remove_dir_all(&self.dir));
    }
}

fn git(dir: &Path, args: &[&str]) -> String {
    let o = Command::new("git")
        .args(args)
        .current_dir(dir)
        .env("GIT_AUTHOR_NAME", "t")
        .env("GIT_AUTHOR_EMAIL", "t@example.invalid")
        .env("GIT_COMMITTER_NAME", "t")
        .env("GIT_COMMITTER_EMAIL", "t@example.invalid")
        .output()
        .unwrap();
    assert!(o.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&o.stderr));
    String::from_utf8_lossy(&o.stdout).trim().to_string()
}

/// A repository whose `dev` branch holds one commit that is not the commit this engine was built from.
fn checkout(env: &Env) -> (PathBuf, String) {
    let repo = env.dir.join("checkout");
    std::fs::create_dir_all(repo.join("plugins/anti-hall/engine/defaults")).unwrap();
    std::fs::write(repo.join("plugins/anti-hall/engine/defaults/a.toml"), "a = 1\n").unwrap();
    git(&repo, &["init", "-q", "-b", "dev"]);
    git(&repo, &["add", "-A"]);
    git(&repo, &["commit", "-q", "-m", "one"]);
    let head = git(&repo, &["rev-parse", "HEAD"]);
    (repo, head)
}

#[test]
fn engine_currency_a_lagging_engine_is_reported_in_status_the_counter_and_one_log_line() {
    let mut e = Env::new("behind");
    let (repo, head) = checkout(&e);
    e.settings(serde_json::json!({"diagnostics": {"engineCurrencyCheckout": repo}}));
    e.start();
    let r = e.json(&["schedule", "run", "engine_currency", "--json"]);
    assert_eq!(r["status"], "ok", "{r}");
    let status = e.json(&["status", "--json"]);
    let cur = &status["currency"];
    assert_eq!(cur["result"], "behind", "{status}");
    assert_eq!(cur["dev_head"], head.as_str());
    assert!(!cur["live_sha"].as_str().unwrap().is_empty(), "{cur}");
    assert!(!cur["files_dev_hash"].as_str().unwrap().is_empty(), "{cur}");
    let metrics = e.json(&["metrics", "--json"]).to_string();
    assert!(metrics.contains(r#""name":"engine_currency_check""#) && metrics.contains(r#""result":"behind""#), "{metrics}");
    let log = e.log();
    let lines: Vec<&str> = log.lines().filter(|l| l.contains("\tcurrency\tbehind\t")).collect();
    assert_eq!(lines.len(), 1, "{log}");
    assert!(lines[0].contains(&head), "the line names the branch tip: {}", lines[0]);
    // a second run in the same interval counts again but logs nothing new
    e.json(&["schedule", "run", "engine_currency", "--json"]);
    assert_eq!(e.log().lines().filter(|l| l.contains("\tcurrency\tbehind\t")).count(), 1);
}

#[test]
fn engine_currency_without_a_checkout_or_with_the_switch_off_the_job_does_nothing() {
    let mut e = Env::new("off");
    let (repo, _) = checkout(&e);
    e.start();
    // default: switch on, no checkout set
    assert_eq!(e.json(&["schedule", "run", "engine_currency", "--json"])["status"], "ok");
    assert!(e.json(&["status", "--json"]).get("currency").is_none());
    // the kill switch
    e.settings(serde_json::json!({"diagnostics": {"engineCurrency": false, "engineCurrencyCheckout": repo}}));
    e.json(&["schedule", "run", "engine_currency", "--json"]);
    assert!(e.json(&["status", "--json"]).get("currency").is_none());
    assert!(!e.log().contains("\tcurrency\t"), "{}", e.log());
}
