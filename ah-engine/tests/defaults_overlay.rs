//! #195: every `defaults::*` read answers the EFFECTIVE value of a setting (environment, `settings.json`, `config.toml`, shipped
//! default; the order `cfgstore` documents), not only the shipped one, and follows a config reload.
//!
//! The overlay is process-global and so are environment variables, so this file holds a single test that walks the scenarios
//! in order, on scratch files (never the user's real `~/.anti-hall`).
#![allow(clippy::unwrap_used, clippy::expect_used)] // a test crate: a panic is the failure report, and E2 exempts tests
#![allow(clippy::panic, clippy::unreachable)] // integration tests: a panic is the failure report; production crates deny these in Cargo.toml
use ah_engine::cfgstore::{ConfigStore, Paths, Reload, Source};
use ah_engine::defaults;
use std::path::Path;

/// A numeric setting with an `env` override that no other code reads at test time.
const NUM: &str = "telemetry.health_snapshot_ms";
/// A text setting.
const TEXT: &str = "msg.cfg_err_not_object";
/// A restart-only setting (`config.restart_only`).
const HELD: &str = "realtime.poll_ms";

fn put(path: &Path, text: &str) {
    let tmp = path.with_extension("tmp");
    std::fs::write(&tmp, text).unwrap();
    std::fs::rename(&tmp, path).unwrap();
}

fn shipped_num(key: &str) -> u64 {
    defaults::shipped(key).as_integer().unwrap() as u64
}

/// Every `defaults::*` answer equals the store's effective value: the property #195 is about, checked for every setting.
fn agrees_with(store: &ConfigStore) {
    let snap = store.snapshot();
    for (k, r) in snap.effective.iter() {
        if r.source == Source::Env {
            assert_eq!(Some(defaults::num(k) as i64), r.value.as_i64(), "{k}: env layer");
        } else {
            assert_eq!(defaults::raw(k).to_json(), r.value, "{k}: defaults::raw disagrees with the effective value ({})", r.source.name());
        }
    }
}

#[test]
fn defaults_reads_follow_the_config_layers_and_reloads() {
    let dir = std::env::temp_dir().join(format!(
        "ah-overlay-{}-{}",
        std::process::id(),
        std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()
    ));
    std::fs::create_dir_all(&dir).unwrap();
    let paths = Paths { user: dir.join("config.toml"), settings: Some(dir.join("settings.json")) };
    // SAFETY: this file holds one test, and these are set before any thread reads them. The state dir is set before the first
    // load, so the defaults come from this checkout, never from a snapshot cache in the real state directory.
    unsafe {
        std::env::set_var("HOME", &dir);
        std::env::set_var("AH_ENGINE_DIR", dir.join("state"));
    }
    defaults::init().unwrap();
    let env_num = defaults::env_of(NUM).unwrap();
    // SAFETY: as above
    unsafe {
        std::env::set_var(defaults::env_name("config"), &paths.user);
        std::env::set_var(defaults::env_name("settings"), paths.settings.as_ref().unwrap());
        std::env::remove_var(env_num);
    }
    let (num0, text0, held0) = (shipped_num(NUM), defaults::shipped(TEXT).as_str().unwrap(), shipped_num(HELD));
    assert_eq!((defaults::num(NUM), defaults::text(TEXT)), (num0, text0), "no files: the shipped values");

    // a one-shot process (a command, the hook client): config.toml is read once at start
    put(&paths.user, &format!("[telemetry]\nhealth_snapshot_ms = {}\n[msg]\ncfg_err_not_object = \"from toml\"\n", num0 + 1));
    ah_engine::cfgstore::install_process_overlay();
    assert_eq!((defaults::num(NUM), defaults::text(TEXT)), (num0 + 1, "from toml"), "config.toml reaches defaults::* in a one-shot process");

    // the daemon's store: its snapshot is the overlay, and a reload swaps it
    let store = ConfigStore::load_from(paths.clone());
    store.publish();
    assert_eq!(defaults::num(NUM), num0 + 1);
    agrees_with(&store);
    let g = defaults::generation();
    put(&paths.user, &format!("[telemetry]\nhealth_snapshot_ms = {}\n", num0 + 2));
    assert!(matches!(store.reload(), Reload::Applied(_)));
    assert_eq!((defaults::num(NUM), defaults::text(TEXT)), (num0 + 2, text0), "a reload changes the read at run time, and a removed key falls back");
    assert!(defaults::generation() > g, "a changed overlay rebuilds the values derived from settings (defaults::Cache)");
    agrees_with(&store);

    // precedence: env, then settings.json, then config.toml, then the shipped default
    put(paths.settings.as_ref().unwrap(), &format!(r#"{{"telemetry":{{"health_snapshot_ms":{}}}}}"#, num0 + 3));
    assert!(matches!(store.reload(), Reload::Applied(_)));
    assert_eq!(defaults::num(NUM), num0 + 3, "settings.json outranks config.toml");
    // SAFETY: as above, single test, no other thread reads it
    unsafe { std::env::set_var(env_num, (num0 + 4).to_string()) };
    assert_eq!(defaults::num(NUM), num0 + 4, "the env variable outranks both files");
    // SAFETY: as above
    unsafe { std::env::remove_var(env_num) };
    assert_eq!(defaults::num(NUM), num0 + 3);
    let max = defaults::get(NUM).unwrap().max;
    if let Some(max) = max {
        put(paths.settings.as_ref().unwrap(), &format!(r#"{{"telemetry":{{"health_snapshot_ms":{}}}}}"#, max + 1000));
        assert!(matches!(store.reload(), Reload::Applied(_)));
        assert_eq!(defaults::num(NUM), max as u64, "a settings.json number is clamped like Node's");
    }
    std::fs::remove_file(paths.settings.as_ref().unwrap()).unwrap();
    assert!(matches!(store.reload(), Reload::Applied(_)));
    assert_eq!(defaults::num(NUM), num0 + 2, "settings.json gone: config.toml again");
    agrees_with(&store);

    // locked keys (config.locked) stay locked: config.toml naming one is invalid and changes nothing, settings.json is ignored
    let home_var = defaults::env_name("home");
    put(&paths.user, "[env]\nhome = \"NOT_HOME\"\n");
    assert_eq!(store.reload(), Reload::Invalid("locked"));
    assert_eq!((defaults::env_name("home"), defaults::num(NUM)), (home_var, num0 + 2), "the invalid file keeps the last good snapshot");
    put(&paths.user, &format!("[telemetry]\nhealth_snapshot_ms = {}\n", num0 + 5));
    put(paths.settings.as_ref().unwrap(), r#"{"env":{"home":"NOT_HOME"},"config":{"user_file":"other.toml","locked":["x"]}}"#);
    assert!(matches!(store.reload(), Reload::Applied(_)));
    assert_eq!(defaults::env_name("home"), home_var, "settings.json cannot rename an environment variable");
    assert_eq!(defaults::text("config.user_file"), defaults::shipped("config.user_file").as_str().unwrap());
    assert_eq!(store.snapshot().effective.get("env.home").unwrap().source, Source::Default);
    assert_eq!(defaults::num(NUM), num0 + 5, "the rest of settings.json and config.toml still apply");
    agrees_with(&store);
    std::fs::remove_file(paths.settings.as_ref().unwrap()).unwrap();

    // a setting read once when a thread starts keeps its running value until the next start and is reported pending
    put(&paths.user, &format!("[realtime]\npoll_ms = {}\n", held0 + 1));
    assert!(matches!(store.reload(), Reload::Applied(_)));
    let snap = store.snapshot();
    assert!(snap.pending_restart.iter().any(|k| k.as_str() == HELD), "pending_restart: {:?}", snap.pending_restart);
    assert_eq!(defaults::num(HELD), held0, "restart-only: the running value stays");
    let report = store.report();
    assert!(report["pending_restart"].as_array().unwrap().iter().any(|k| *k == HELD), "config --json shows it: {}", report["pending_restart"]);
    // a fresh start (a new store) runs the file's value
    let fresh = ConfigStore::load_from(paths.clone());
    fresh.publish();
    assert_eq!(defaults::num(HELD), held0 + 1, "the next start applies it");

    // reloads do not accumulate memory: going back and forth between two contents 50 times leaks nothing after each is seen once,
    // and a reload of an unchanged file installs nothing
    let a = format!("[telemetry]\nhealth_snapshot_ms = {}\n", num0 + 6);
    let b = format!("[telemetry]\nhealth_snapshot_ms = {}\n", num0 + 7);
    put(&paths.user, &a);
    fresh.reload();
    put(&paths.user, &b);
    fresh.reload();
    let (leaked, g) = (ah_engine::mem::leaked_bytes(), defaults::generation());
    for i in 0..50 {
        put(&paths.user, if i % 2 == 0 { &a } else { &b });
        assert!(matches!(fresh.reload(), Reload::Applied(_)));
        assert_eq!(defaults::num(NUM), num0 + if i % 2 == 0 { 6 } else { 7 });
    }
    assert_eq!(ah_engine::mem::leaked_bytes(), leaked, "50 reloads between two contents leaked bytes");
    assert!(defaults::generation() > g);

    // no files at all: every read is the shipped value again
    std::fs::remove_file(&paths.user).unwrap();
    assert!(matches!(fresh.reload(), Reload::Applied(_)));
    assert_eq!((defaults::num(NUM), defaults::num(HELD)), (num0, held0 + 1), "held until restart even when the file goes");
    let last = ConfigStore::load_from(paths.clone());
    last.publish();
    assert_eq!((defaults::num(NUM), defaults::num(HELD), defaults::text(TEXT)), (num0, held0, text0));
    assert!(defaults::overlay().is_empty());
    agrees_with(&last);
    cleanup(&dir);
}

fn cleanup(dir: &Path) {
    let _gone = std::fs::remove_dir_all(dir); // keep: scratch cleanup; a leftover temp dir is harmless
}
