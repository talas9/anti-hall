//! GH #563: the offline inspection verbs open the databases read-only. A database of another schema is refused with the
//! step that clears it and is left byte-identical; a current one is read without a single byte changing and without
//! `archive.db` appearing. `storage.offline_open_readonly = 0` restores the old open.
#![allow(clippy::unwrap_used, clippy::expect_used)] // a test crate: a panic is the failure report, and E2 exempts tests

use ah_engine::{db, sql};
use rusqlite::Connection;
use std::path::{Path, PathBuf};
use std::process::Command;

const BIN: &str = env!("CARGO_BIN_EXE_ah-engine");

fn plugin() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap().join("plugins/anti-hall")
}

/// A fresh scratch HOME and engine directory under the test tmp dir.
fn scratch(tag: &str) -> (PathBuf, PathBuf) {
    let d = PathBuf::from(env!("CARGO_TARGET_TMPDIR")).join(format!("offro-{tag}-{}", std::process::id()));
    drop(std::fs::remove_dir_all(&d)); // keep: a leftover from an earlier run of this same test
    let state = d.join("state");
    std::fs::create_dir_all(&state).unwrap();
    std::fs::create_dir_all(d.join("home")).unwrap();
    (d, state)
}

/// hot.db migrated through the first `n` migrations, closed (so no -wal/-shm is left beside it).
fn seed(state: &Path, n: usize) {
    let mut c = Connection::open(state.join("hot.db")).unwrap();
    c.pragma_update(None, "journal_mode", "WAL").unwrap();
    db::migrate(&mut c, "hot.db", sql::HOT_MIGRATIONS.get(..n).unwrap()).unwrap();
    drop(c);
}

fn files(state: &Path) -> Vec<(String, Vec<u8>)> {
    let mut v: Vec<(String, Vec<u8>)> =
        std::fs::read_dir(state).unwrap().flatten().map(|e| (e.file_name().to_string_lossy().to_string(), std::fs::read(e.path()).unwrap())).collect();
    v.sort();
    v
}

fn summary(d: &Path, state: &Path, extra: &[(&str, &str)]) -> (i32, String, String) {
    let o = Command::new(BIN)
        .args(["telemetry", "summary", "--json"])
        .env_clear()
        .env("PATH", std::env::var("PATH").unwrap_or_default())
        .env("HOME", d.join("home"))
        .env("AH_ENGINE_DIR", state)
        .env("AH_ENGINE_NOSPAWN", "1")
        .env("AH_ENGINE_PLUGIN_ROOT", plugin())
        .envs(extra.iter().copied())
        .current_dir(d)
        .output()
        .unwrap();
    (o.status.code().unwrap_or(-1), String::from_utf8_lossy(&o.stdout).to_string(), String::from_utf8_lossy(&o.stderr).to_string())
}

#[test]
fn an_older_schema_is_refused_and_the_files_are_left_byte_identical() {
    let (d, state) = scratch("old");
    let known = sql::HOT_MIGRATIONS.len();
    seed(&state, known - 1);
    let before = files(&state);
    let (code, out, err) = summary(&d, &state, &[]);
    assert_eq!(code, 1, "stdout: {out} stderr: {err}");
    let said = format!("{out}{err}");
    assert!(said.contains(&(known - 1).to_string()) && said.contains(&known.to_string()), "the refusal names both schema versions: {said}");
    assert!(said.contains("ah-engine status"), "the refusal names the step that clears it: {said}");
    assert_eq!(files(&state), before, "a refused open changes no file");
    assert!(!state.join("archive.db").exists(), "no archive.db is created");
}

#[test]
fn a_current_schema_is_read_without_changing_a_byte_or_creating_archive_db() {
    let (d, state) = scratch("cur");
    seed(&state, sql::HOT_MIGRATIONS.len());
    let before = files(&state);
    let (code, out, err) = summary(&d, &state, &[]);
    assert_eq!(code, 0, "stdout: {out} stderr: {err}");
    assert!(out.contains("\"from\":\"files\"") || out.contains("\"from\": \"files\""), "answered from the files: {out}");
    assert_eq!(files(&state), before, "a read-only open changes no file");
    assert!(!state.join("archive.db").exists(), "no archive.db is created");
}

#[test]
fn the_kill_switch_restores_the_old_open_that_creates_archive_db() {
    let (d, state) = scratch("off");
    seed(&state, sql::HOT_MIGRATIONS.len());
    let (code, out, err) = summary(&d, &state, &[("AH_ENGINE_OFFLINE_OPEN_READONLY", "0")]);
    assert_eq!(code, 0, "stdout: {out} stderr: {err}");
    assert!(state.join("archive.db").exists(), "switch off: the old open creates archive.db");
}
