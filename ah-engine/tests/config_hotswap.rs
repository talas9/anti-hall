//! D18 (file part): the daemon loads layered config, watches the files, and swaps a new version in atomically.
//!
//! One real daemon, an isolated HOME and state directory (never the user's real `~/.anti-hall`). Environment variables
//! are process-global, so this file holds a single test that walks the scenarios in order.
mod common;
use ah_engine::client;
use serde_json::{Value, json};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering::SeqCst};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

const BIN: &str = env!("CARGO_BIN_EXE_ah-engine");

fn wait_for(what: &str, mut f: impl FnMut() -> bool) {
    let t = Instant::now();
    while t.elapsed() < Duration::from_secs(8) {
        if f() {
            return;
        }
        std::thread::sleep(Duration::from_millis(25));
    }
    panic!("timed out waiting for {what}");
}

/// Replace a file atomically (write a sibling, then rename), the way editors and `settings.js` do.
fn put(path: &Path, text: &str) {
    let tmp = path.with_extension("tmp");
    std::fs::write(&tmp, text).unwrap();
    std::fs::rename(&tmp, path).unwrap();
}

fn status() -> Option<Value> {
    client::ctl_json("status")
}

fn queue_cap() -> Option<u64> {
    status()?["queue_cap"].as_u64()
}

fn cli(root: &Path, args: &[&str]) -> (i32, String) {
    let o = Command::new(BIN).env("HOME", root.join("home")).env("AH_ENGINE_DIR", root.join("eng")).env("AH_ENGINE_NOSPAWN", "1").args(args).output().unwrap();
    (o.status.code().unwrap_or(-1), String::from_utf8_lossy(&o.stdout).trim().to_string())
}

#[test]
fn layered_config_hot_swaps_without_dropping_requests() {
    let root: PathBuf = PathBuf::from("/tmp").join(format!("ah-cfg-hot-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    let eng = root.join("eng");
    std::fs::create_dir_all(root.join("home").join(".anti-hall")).unwrap();
    std::fs::create_dir_all(&eng).unwrap();
    let (toml, settings) = (eng.join("config.toml"), root.join("home").join(".anti-hall").join("settings.json"));
    for (k, v) in [
        ("HOME", root.join("home").to_string_lossy().to_string()),
        ("AH_ENGINE_DIR", eng.to_string_lossy().to_string()),
        ("AH_ENGINE_CONFIG_WATCH_MS", "50".into()),
        ("AH_ENGINE_CONFIG_DEBOUNCE_MS", "100".into()),
        ("AH_ENGINE_NOSPAWN", "1".into()),
    ] {
        // FIXME: Audit that the environment access only happens in single-threaded code.
        unsafe { std::env::set_var(k, v) };
    }
    let daemon = Command::new(BIN).arg("serve").stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).spawn().unwrap();
    /// Stops the daemon and collects it (a dead child stays a zombie until waited for, which `reap` would read as alive),
    /// even when an assertion panics.
    struct Reap(PathBuf, std::process::Child);
    impl Drop for Reap {
        fn drop(&mut self) {
            let _ = client::ctl("stop");
            let t = Instant::now();
            while self.1.try_wait().ok().flatten().is_none() && t.elapsed() < Duration::from_secs(3) {
                std::thread::sleep(Duration::from_millis(20));
            }
            common::reap(&self.0, || {});
        }
    }
    let reap_guard = Reap(eng.clone(), daemon);
    wait_for("the daemon to answer", || client::ping(&ah_engine::paths::socket()).is_some());

    // ---- startup: defaults, version 1 ----------------------------------------------------------------------------
    let s = status().expect("status");
    let (q0, rss0) = (s["queue_cap"].as_u64().unwrap(), s["rss_cap_kb"].as_u64().unwrap());
    assert_eq!(s["config"]["version"], 1);
    assert!(s["config"]["last_error"].is_null());

    // ---- a burst of requests while two keys change in ONE edit: each reply is wholly old or wholly new -----------
    let (q1, rss1) = (q0 + 24, rss0 + 16384);
    let stop = Arc::new(AtomicBool::new(false));
    let failures = Arc::new(AtomicUsize::new(0));
    let seen: Arc<Mutex<Vec<(u64, u64)>>> = Arc::new(Mutex::new(vec![]));
    let threads: Vec<_> = (0..4)
        .map(|_| {
            let (stop, failures, seen) = (stop.clone(), failures.clone(), seen.clone());
            std::thread::spawn(move || {
                while !stop.load(SeqCst) {
                    match status() {
                        Some(v) => seen.lock().unwrap().push((v["queue_cap"].as_u64().unwrap_or(0), v["rss_cap_kb"].as_u64().unwrap_or(0))),
                        None => {
                            failures.fetch_add(1, SeqCst);
                        }
                    }
                }
            })
        })
        .collect();
    std::thread::sleep(Duration::from_millis(150));
    put(&toml, &format!("[daemon]\nqueue = {q1}\nrss_cap_kb = {rss1}\n"));
    wait_for("the new queue", || queue_cap() == Some(q1));
    std::thread::sleep(Duration::from_millis(150));
    stop.store(true, SeqCst);
    for t in threads {
        t.join().unwrap();
    }
    let seen = seen.lock().unwrap();
    assert_eq!(failures.load(SeqCst), 0, "no request may fail during a swap");
    assert!(seen.len() > 50, "the burst was too small to mean anything: {}", seen.len());
    assert!(seen.contains(&(q0, rss0)) && seen.contains(&(q1, rss1)), "the burst must straddle the swap");
    for p in seen.iter() {
        assert!(*p == (q0, rss0) || *p == (q1, rss1), "torn config seen: {p:?}");
    }
    assert_eq!(status().unwrap()["config"]["version"], 2);

    // ---- an invalid edit keeps the last good config and logs config_invalid ------------------------------------
    put(&toml, "[daemon]\nqueue = \"many\"\n");
    wait_for("the error to be reported", || status().is_some_and(|s| s["config"]["last_error"].as_str().is_some_and(|e| e.starts_with("type"))));
    assert_eq!(queue_cap(), Some(q1), "invalid edit must not change anything");
    assert!(ah_engine::health::events().iter().any(|e| e.kind == "config_invalid" && e.code == "type"), "config_invalid is logged");
    put(&toml, "[daemon\nbroken");
    wait_for("the parse error", || status().is_some_and(|s| s["config"]["last_error"].as_str().is_some_and(|e| e.starts_with("parse"))));
    assert_eq!(queue_cap(), Some(q1));

    // ---- settings.json outranks the engine file, restart-only keys wait for a restart -----------------------------
    let workers = status().unwrap()["workers"].as_u64().unwrap();
    put(&toml, &format!("[daemon]\nqueue = {q1}\nworkers = {}\n", workers + 1));
    put(&settings, &json!({"daemon": {"queue": q1 + 1}}).to_string());
    wait_for("settings.json to win", || queue_cap() == Some(q1 + 1));
    let s = status().unwrap();
    assert_eq!(s["workers"], workers, "a restart-only setting keeps its running value");
    assert_eq!(s["config"]["pending_restart"], json!(["daemon.workers"]));
    assert!(s["config"]["last_error"].is_null(), "a good edit clears the error");
    let (code, out) = cli(&root, &["config", "--json"]);
    assert_eq!(code, 0, "{out}");
    let v: Value = serde_json::from_str(&out).unwrap();
    assert_eq!(v["from"], "daemon");
    assert_eq!(v["settings"]["daemon.queue"], json!({"value": q1 + 1, "source": "settings"}));
    assert_eq!(v["settings"]["daemon.rss_cap_kb"]["source"], "default");

    // ---- deleting the files falls back to the shipped defaults -------------------------------------------------
    std::fs::remove_file(&toml).unwrap();
    std::fs::remove_file(&settings).unwrap();
    wait_for("the defaults to return", || queue_cap() == Some(q0));
    let s = status().unwrap();
    assert_eq!(s["rss_cap_kb"], rss0);
    assert_eq!(s["config"]["pending_restart"], json!([]));

    // ---- `ctl reload` re-reads now; `config validate` ---------------------------------------------------------
    put(&toml, &format!("[daemon]\nqueue = {q1}\n"));
    assert!(client::ctl("reload").is_some());
    assert_eq!(queue_cap(), Some(q1), "ctl reload applies at once, without waiting for the watcher");
    let good = root.join("good.toml");
    std::fs::write(&good, "[daemon]\nqueue = 20\n").unwrap();
    let bad = root.join("bad.toml");
    std::fs::write(&bad, "[daemon]\nnope = 1\n").unwrap();
    assert_eq!(cli(&root, &["config", "validate", good.to_str().unwrap(), "--json"]).0, 0);
    let (code, out) = cli(&root, &["config", "validate", bad.to_str().unwrap(), "--json"]);
    assert_eq!(code, 1);
    assert_eq!(serde_json::from_str::<Value>(&out).unwrap()["code"], "unknown_key");
    assert_eq!(cli(&root, &["config", "validate"]).0, 64);
    assert_eq!(cli(&root, &["config", "rollback"]).0, 64, "rollback is planned (D18)");

    drop(reap_guard);
    let _ = std::fs::remove_dir_all(&root);
}
