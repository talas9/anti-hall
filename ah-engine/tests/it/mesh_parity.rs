//! D45 S0, parity P1: the read-only mesh reader returns what Node's store reader returns, byte for byte.
//!
//! Both sides read the same store file and print the same canonical dump (one JSON line per record, sorted keys):
//! Node through `devswarm-store.js` opened read-only (what the hooks do), Rust through `ah-engine mesh dump`. The dump
//! covers every read the hooks make on a store: the registry (`listRegistry`), the workspace ids, per workspace the
//! message count, the cursor, the unread tail (`listMessages` with `sinceCursor`), the pending questions and their
//! previews, the gates and who set them, the broadcast cursor, the reader cursors and the newest messages, and then every
//! message with its body.
//!
//! * `p1_fixture_stores_match_node` always runs (it needs Node 22.5+ with `node:sqlite`; without it the test says so and
//!   passes nothing it did not check). The fixtures are written by Node's own store code.
//! * `p1_live_store_copies` is `#[ignore]`: it compares both readers on COPIES of every store under a real
//!   `~/.anti-hall/devswarm/store` (set `AH_MESH_PARITY_LIVE_ROOT` to that devswarm directory). It never opens a live file
//!   for writing: it copies the database and its `-wal` with plain file reads (retrying until the files did not change
//!   during the copy and the copy passes `quick_check`), folds the WAL into the copy, and compares on the copy only.
#![allow(clippy::unwrap_used, clippy::expect_used)] // a test crate: a panic is the failure report, and E2 exempts tests
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::SystemTime;

const BIN: &str = env!("CARGO_BIN_EXE_ah-engine");

fn node_sqlite_available() -> bool {
    Command::new("node").args(["-e", "require('node:sqlite')"]).stderr(Stdio::null()).status().map(|s| s.success()).unwrap_or(false)
}

fn support(name: &str) -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("tests").join("it").join("mesh_support").join(name)
}

fn tmp(tag: &str) -> PathBuf {
    let p = PathBuf::from(env!("CARGO_TARGET_TMPDIR")).join(format!("mesh-{tag}-{}", std::process::id()));
    fs::remove_dir_all(&p).ok();
    fs::create_dir_all(&p).unwrap();
    p
}

fn store_dir(home: &Path, key: &str) -> PathBuf {
    home.join(".anti-hall").join("devswarm").join("store").join(key)
}

fn node_dump(home: &Path, key: &str) -> Vec<u8> {
    let o = Command::new("node").arg(support("dump.js")).arg(home).arg(key).output().expect("node runs");
    assert!(o.status.success(), "node dump of {key} failed: {}", String::from_utf8_lossy(&o.stderr));
    o.stdout
}

fn rust_dump(home: &Path, key: &str) -> Vec<u8> {
    let db = store_dir(home, key).join("devswarm.db");
    let o = Command::new(BIN).args(["mesh", "dump", "--db"]).arg(&db).output().expect("engine runs");
    assert!(o.status.success(), "engine dump of {key} failed: {}", String::from_utf8_lossy(&o.stderr));
    o.stdout
}

/// First difference between two dumps, as text, or None when equal.
fn diff(a: &[u8], b: &[u8]) -> Option<String> {
    if a == b {
        return None;
    }
    let (la, lb): (Vec<&[u8]>, Vec<&[u8]>) = (a.split(|c| *c == b'\n').collect(), b.split(|c| *c == b'\n').collect());
    for i in 0..la.len().max(lb.len()) {
        let (x, y) = (la.get(i).copied().unwrap_or(b"<missing>"), lb.get(i).copied().unwrap_or(b"<missing>"));
        if x != y {
            let at = x.iter().zip(y.iter()).position(|(p, q)| p != q).unwrap_or(x.len().min(y.len()));
            let cut = |s: &[u8]| String::from_utf8_lossy(&s[at.saturating_sub(60)..(at + 140).min(s.len())]).into_owned();
            return Some(format!("line {} differs at byte {at}:\n  node: ...{}\n  rust: ...{}", i + 1, cut(x), cut(y)));
        }
    }
    Some("lengths differ".into())
}

fn lines_of(b: &[u8], kind: &str) -> usize {
    String::from_utf8_lossy(b).lines().filter(|l| l.contains(&format!("\"k\":\"{kind}\""))).count()
}

#[test]
fn p1_fixture_stores_match_node() {
    if !node_sqlite_available() {
        eprintln!("SKIPPED: Node with node:sqlite is not available, so there is no Node reader to compare with");
        return;
    }
    let home = tmp("fixture");
    let st = Command::new("node").arg(support("fixture.js")).arg(&home).status().unwrap();
    assert!(st.success(), "the fixture writer failed");
    let mut seen_msgs = 0;
    for key in ["rich-aaaaaa", "thin-bbbbbb", "empty-cccccc", "old-dddddd"] {
        let (n, r) = (node_dump(&home, key), rust_dump(&home, key));
        if let Some(d) = diff(&n, &r) {
            panic!("P1 mismatch on {key}: {d}");
        }
        assert!(!n.is_empty() && !n.starts_with(b"OPEN"), "{key}: Node did not read the store: {}", String::from_utf8_lossy(&n));
        seen_msgs += lines_of(&n, "msg");
    }
    // not vacuous: the rich store really has the shapes the harness exists to compare
    let rich = String::from_utf8(node_dump(&home, "rich-aaaaaa")).unwrap();
    assert!(seen_msgs >= 36 + 4, "the fixture holds messages ({seen_msgs})");
    assert_eq!(lines_of(rich.as_bytes(), "ws"), 4, "four workspaces with messages");
    assert!(rich.contains("\"nudgeCommand\":[\"hivecontrol\",\"workspace\",\"monitor\"]"), "an argv nudge command round-trips");
    assert!(rich.contains("\"nudgeCommand\":\"plain string\""), "a non-JSON nudge command comes back as its text");
    assert!(rich.contains("\"gates\":{\"done\":false,\"merged\":true,\"tests_passed\":true}"), "a cleared gate reads false");
    assert!(rich.contains("\\ud83d\\ude80") || rich.contains('\u{1F680}'), "an astral character survives");
    assert!(rich.contains("\"hash\":null"), "null-hash rows exist");
    let old = String::from_utf8(node_dump(&home, "old-dddddd")).unwrap();
    assert!(old.contains("\"error\":true"), "a pre-mesh store fails identically on both sides, not silently empty");
    fs::remove_dir_all(&home).ok();
}

fn dir_state(d: &Path) -> Vec<(String, u64, Option<SystemTime>)> {
    let mut v: Vec<_> = fs::read_dir(d)
        .unwrap()
        .flatten()
        .map(|e| {
            let m = e.metadata().unwrap();
            (e.file_name().to_string_lossy().into_owned(), m.len(), m.modified().ok())
        })
        .collect();
    v.sort();
    v
}

#[test]
fn the_reader_never_writes_never_creates_and_refuses_a_journal_store() {
    if !node_sqlite_available() {
        eprintln!("SKIPPED: Node with node:sqlite is not available, so no fixture store can be built");
        return;
    }
    let home = tmp("ro");
    assert!(Command::new("node").arg(support("fixture.js")).arg(&home).status().unwrap().success());
    let dir = store_dir(&home, "rich-aaaaaa");
    let before = dir_state(&dir);
    let sum = |p: &Path| fs::read(p).unwrap();
    let db_before = sum(&dir.join("devswarm.db"));
    for verb in [&["roster"][..], &["unread"], &["read", "--id", "child-one"], &["read", "--id", "child-one", "--last", "2"], &["dump"]] {
        let o = Command::new(BIN).arg("mesh").args(verb).args(["--json", "--db"]).arg(dir.join("devswarm.db")).output().unwrap();
        assert!(o.status.success(), "{verb:?}: {}", String::from_utf8_lossy(&o.stderr));
    }
    assert_eq!(db_before, sum(&dir.join("devswarm.db")), "the store file is byte-identical after every verb");
    // A WAL-mode database that was closed cleanly has no -wal/-shm; SQLite's own read protocol creates them (empty) on the
    // first read, for Node's read-only open exactly as for ours. Nothing else may change: the store file and the marker keep
    // their size and modification time, and no other file appears.
    let after = dir_state(&dir);
    for entry in &before {
        assert!(after.contains(entry), "{} changed or vanished: before {before:?}, after {after:?}", entry.0);
    }
    for extra in after.iter().filter(|e| !before.contains(e)) {
        assert!(extra.0 == "devswarm.db-wal" || extra.0 == "devswarm.db-shm", "an unexpected file appeared: {}", extra.0);
    }
    if let Some(wal) = after.iter().find(|e| e.0 == "devswarm.db-wal") {
        assert_eq!(wal.1, 0, "the WAL a reader creates stays empty");
    }

    // a missing store is an error and is not created
    let ghost = home.join("nowhere").join("devswarm.db");
    let o = Command::new(BIN).args(["mesh", "roster", "--json", "--db"]).arg(&ghost).output().unwrap();
    assert_eq!(o.status.code(), Some(1));
    assert!(String::from_utf8_lossy(&o.stdout).contains("mesh_missing"));
    assert!(!ghost.exists() && !ghost.parent().unwrap().exists(), "nothing was created");

    // the journal backend belongs to Node
    let jd = store_dir(&home, "journal-eeeeee");
    fs::create_dir_all(&jd).unwrap();
    fs::copy(dir.join("devswarm.db"), jd.join("devswarm.db")).unwrap();
    fs::write(jd.join("BACKEND"), "journal").unwrap();
    let o = Command::new(BIN).args(["mesh", "roster", "--json", "--db"]).arg(jd.join("devswarm.db")).output().unwrap();
    assert_eq!(o.status.code(), Some(1));
    assert!(String::from_utf8_lossy(&o.stdout).contains("mesh_backend"), "{}", String::from_utf8_lossy(&o.stdout));

    // a read position and a tail
    let o = Command::new(BIN).args(["mesh", "read", "--json", "--id", "child-one", "--since", "2", "--db"]).arg(dir.join("devswarm.db")).output().unwrap();
    let text = String::from_utf8_lossy(&o.stdout);
    let idx: Vec<u64> = text.lines().filter_map(|l| serde_json::from_str::<serde_json::Value>(l).ok()).filter_map(|v| v["index"].as_u64()).collect();
    assert_eq!(idx, (3..=12).collect::<Vec<u64>>(), "child-one has 12 rows; since 2 skips two and keeps the positional index");
    fs::remove_dir_all(&home).ok();
}

// ---------------------------------------------------------------------------------------------------------------------
// P1 on copies of the live stores
// ---------------------------------------------------------------------------------------------------------------------

fn stat(p: &Path) -> Option<(u64, SystemTime)> {
    fs::metadata(p).ok().map(|m| (m.len(), m.modified().unwrap()))
}

/// Copy the store in `src` into `dst` (a plain file read of the live files; nothing is opened for writing there). The copy
/// is retried until the source did not change while it was read and the copy is a consistent database, then the WAL is
/// folded into it so it is one self-contained file.
fn copy_store(src: &Path, dst: &Path) -> Result<(), String> {
    fs::create_dir_all(dst).map_err(|e| e.to_string())?;
    let (db, wal) = (src.join("devswarm.db"), src.join("devswarm.db-wal"));
    for _ in 0..8 {
        let (s1, w1) = (stat(&db), stat(&wal));
        fs::remove_file(dst.join("devswarm.db-wal")).ok();
        fs::remove_file(dst.join("devswarm.db-shm")).ok();
        fs::copy(&db, dst.join("devswarm.db")).map_err(|e| e.to_string())?;
        if wal.exists() {
            fs::copy(&wal, dst.join("devswarm.db-wal")).map_err(|e| e.to_string())?;
        }
        if (s1, w1) != (stat(&db), stat(&wal)) {
            continue; // a writer touched it while we copied
        }
        if src.join("BACKEND").exists() {
            fs::copy(src.join("BACKEND"), dst.join("BACKEND")).map_err(|e| e.to_string())?;
        }
        let c = rusqlite::Connection::open(dst.join("devswarm.db")).map_err(|e| e.to_string())?;
        let ok: String = c.query_row("PRAGMA quick_check", [], |r| r.get(0)).map_err(|e| e.to_string())?;
        if ok != "ok" {
            continue;
        }
        let _: String = c.query_row("PRAGMA journal_mode = DELETE", [], |r| r.get(0)).map_err(|e| e.to_string())?;
        drop(c);
        fs::remove_file(dst.join("devswarm.db-wal")).ok();
        fs::remove_file(dst.join("devswarm.db-shm")).ok();
        return Ok(());
    }
    Err("the store kept changing during the copy".into())
}

#[test]
#[ignore = "reads the real stores (copies only); set AH_MESH_PARITY_LIVE_ROOT to the devswarm directory and run with --ignored"]
fn p1_live_store_copies() {
    assert!(node_sqlite_available(), "Node with node:sqlite is required");
    let root = PathBuf::from(std::env::var("AH_MESH_PARITY_LIVE_ROOT").expect("AH_MESH_PARITY_LIVE_ROOT"));
    let home = tmp("live");
    let mut keys: Vec<String> = fs::read_dir(root.join("store"))
        .unwrap()
        .flatten()
        .filter(|e| e.path().join("devswarm.db").is_file())
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .collect();
    keys.sort();
    let (mut equal, mut empty, mut errored, mut bad) = (0, 0, 0, Vec::new());
    let (mut rows, mut bytes) = (0usize, 0u64);
    let mut report = String::new();
    for key in &keys {
        let dst = store_dir(&home, key);
        if let Err(e) = copy_store(&root.join("store").join(key), &dst) {
            bad.push(format!("{key}: COPY FAILED {e}"));
            continue;
        }
        let (n, r) = (node_dump(&home, key), rust_dump(&home, key));
        match diff(&n, &r) {
            None => {
                equal += 1;
                rows += lines_of(&n, "msg");
                bytes += n.len() as u64;
                // what the equal dumps hold: no workspace at all, a failed read on both sides, or real data
                if String::from_utf8_lossy(&n).contains("\"error\":true") {
                    errored += 1;
                } else if lines_of(&n, "ws") == 0 {
                    empty += 1;
                }
                report.push_str(&format!("{key}\tEQUAL\t{} msgs\t{} bytes\n", lines_of(&n, "msg"), n.len()));
            }
            Some(d) => {
                report.push_str(&format!("{key}\tMISMATCH\t{d}\n"));
                bad.push(format!("{key}: {d}"));
            }
        }
        // a copy is scratch; remove only what this test made
        fs::remove_dir_all(&dst).ok();
    }
    if let Ok(p) = std::env::var("AH_MESH_PARITY_REPORT") {
        fs::write(p, &report).ok();
    }
    eprintln!(
        "P1 live copies: {} stores, {equal} byte-equal ({empty} without any workspace, {errored} with a read that fails identically on both sides, {} with data), {} mismatches, {rows} message rows, {bytes} dump bytes",
        keys.len(),
        equal - empty - errored,
        bad.len()
    );
    assert!(bad.is_empty(), "P1 mismatches:\n{}", bad.join("\n"));
    fs::remove_dir_all(&home).ok();
}
