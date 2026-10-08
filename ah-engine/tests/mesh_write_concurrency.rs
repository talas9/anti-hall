//! D45 stage 2: Node and the engine write ONE store at the same time, and no message is lost or duplicated and no cursor
//! moves back.
//!
//! In one seeded scratch home (HOME isolated, `ANTIHALL_INGEST_DRY_RUN=1`, app database off) these run at once:
//! * Node processes (`mesh_write_support/conc_node.js`): real `devswarm.js send` calls through its `run()` (per-id lock,
//!   `INSERT OR IGNORE`, readback), each followed by a reader-cursor ack (`readerCursorTxn`) and, now and then, a
//!   broadcast-cursor advance;
//! * engine processes: `ah-engine mesh send` (on mode, each logged `native`) and consuming `ah-engine mesh mesh read`;
//! * engine threads in this process: `MeshStore::reader_cursor_txn` acks and `append_mesh_row` (the store layer itself).
//!
//! Then: every send succeeded and was written exactly once (one row per body, no extra rows), the mesh `seq` is unique and
//! gap-free, every reader cursor holds the highest value anyone wrote, a last consuming read sets the broadcast cursor to
//! the head, no lock file is left behind, and `PRAGMA integrity_check` is ok.
#![allow(clippy::unwrap_used, clippy::expect_used)] // a test crate: a panic is the failure report, and E2 exempts tests
use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

#[path = "mesh_write_support/fx.rs"]
mod fx;
use fx::BIN;
const NODE_PROCS: usize = 3;
const NODE_OPS: usize = 20;
const ENGINE_PROCS: usize = 3;
const ENGINE_OPS: usize = 20;
const LIB_THREADS: usize = 2;
const LIB_OPS: usize = 40;

fn env_for(home: &Path) -> Vec<(String, String)> {
    vec![
        ("HOME".into(), home.to_string_lossy().into()),
        ("PATH".into(), std::env::var("PATH").unwrap()),
        ("ANTIHALL_INGEST_DRY_RUN".into(), "1".into()),
        ("ANTIHALL_DEVSWARM_APP_DB".into(), "off".into()),
        ("AH_ENGINE_DIR".into(), home.join("state").to_string_lossy().into()),
        ("AH_ENGINE_PLUGIN_ROOT".into(), Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap().join("plugins/anti-hall").to_string_lossy().into()),
        ("AH_ENGINE_NOSPAWN".into(), "1".into()),
    ]
}

#[test]
fn node_and_engine_write_one_store_at_once_without_loss_or_duplication() {
    if !Command::new("node").args(["-e", "require('node:sqlite')"]).stderr(Stdio::null()).status().map(|s| s.success()).unwrap_or(false) {
        eprintln!("SKIPPED: Node with node:sqlite is not available");
        return;
    }
    let fixture = fx::fixture("conc");
    let home: PathBuf = fx_path(&fixture, "home");
    fx::copy_tree(&fx_path(&fixture, "seed-home"), &home);
    fs::write(home.join(".anti-hall").join("settings.json"), "{\"mesh\":{\"engine_writes\":\"on\"}}\n").unwrap();
    let main = fx_path(&fixture, "repo");
    let db = store_db(&home);
    let seed_rows: i64 = count(&db, "SELECT COUNT(*) FROM messages");
    // This test process uses the store layer directly: point its defaults at this checkout's plugin and its home at the
    // scratch home before anything reads either (the only test in this binary, so no other thread sees the change).
    // SAFETY: set before any thread is started.
    unsafe {
        std::env::set_var("AH_ENGINE_PLUGIN_ROOT", Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap().join("plugins/anti-hall"));
        std::env::set_var("AH_ENGINE_DIR", home.join("state-lib"));
        std::env::set_var("HOME", &home);
    }

    let mut handles = Vec::new();
    for p in 0..NODE_PROCS {
        let (home, main) = (home.clone(), main.clone());
        handles.push(std::thread::spawn(move || {
            let o = Command::new("node")
                .arg(Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/mesh_write_support/conc_node.js"))
                .args([format!("n{p}"), NODE_OPS.to_string()])
                .current_dir(&main)
                .env_clear()
                .envs(env_for(&home))
                .output()
                .unwrap();
            assert!(o.status.success(), "node {p}: {}", String::from_utf8_lossy(&o.stderr));
            String::from_utf8_lossy(&o.stdout).into_owned()
        }));
    }
    for p in 0..ENGINE_PROCS {
        let (home, main) = (home.clone(), main.clone());
        handles.push(std::thread::spawn(move || {
            let mut lines = Vec::new();
            for i in 0..ENGINE_OPS {
                let body = format!("e{p}-{i}");
                let argv: Vec<String> = if i % 3 == 2 {
                    vec!["send".into(), "--broadcast".into(), "--message".into(), body.clone()]
                } else {
                    vec!["send".into(), "--to".into(), "child-1".into(), "--message".into(), body.clone()]
                };
                let o = Command::new(BIN).arg("mesh").args(&argv).current_dir(&main).env_clear().envs(env_for(&home)).output().unwrap();
                let v: serde_json::Value = serde_json::from_slice(&o.stdout).unwrap_or_else(|e| panic!("{e}: {}", String::from_utf8_lossy(&o.stdout)));
                lines.push(serde_json::json!({"op": "send", "ok": v["ok"], "sent": v["sent"], "seq": v["seq"], "body": body}).to_string());
                if i % 4 == 0 {
                    let o = Command::new(BIN).args(["mesh", "mesh", "read"]).current_dir(&main).env_clear().envs(env_for(&home)).output().unwrap();
                    assert_eq!(o.status.code(), Some(0), "engine mesh read: {}", String::from_utf8_lossy(&o.stdout));
                }
            }
            lines.join("\n")
        }));
    }
    let mut lib_max: BTreeMap<String, i64> = BTreeMap::new();
    let lib: Vec<_> = (0..LIB_THREADS)
        .map(|t| {
            let db = db.clone();
            std::thread::spawn(move || {
                let st = ah_engine::meshw::store::MeshStore::open(&db).unwrap();
                let mut seen: BTreeMap<String, i64> = BTreeMap::new();
                for i in 0..LIB_OPS {
                    let v = ((i * 37 + t * 11) % 1000) as i64;
                    let now = 1_797_000_000_000 + i as i64;
                    st.reader_cursor_txn(&[
                        ah_engine::meshw::store::CursorPut {
                            partition: "child-1".into(),
                            ns: "store".into(),
                            reader: "r-shared".into(),
                            value: v,
                            retired_line: None,
                            updated_at: now,
                        },
                        ah_engine::meshw::store::CursorPut {
                            partition: "child-1".into(),
                            ns: "store".into(),
                            reader: format!("r-lib-{t}"),
                            value: i as i64,
                            retired_line: None,
                            updated_at: now,
                        },
                    ])
                    .unwrap();
                    let e = seen.entry("r-shared".into()).or_insert(0);
                    *e = (*e).max(v);
                    seen.insert(format!("r-lib-{t}"), i as i64);
                    let body = format!("lib{t}-{i}");
                    let hash = ah_engine::meshw::store::mesh_message_hash(Some("lib"), Some("child-1"), "direct", "normal", &body, &now.to_string(), false);
                    let row = ah_engine::meshw::store::mesh_message_row(Some("lib"), Some("child-1"), false, &body, now, "normal", &hash, false, None);
                    let r = st.append_mesh_row(&row).unwrap();
                    assert!(r.inserted && r.seq.is_some());
                    // the same row again is ignored (dedupe by hash), whoever wrote it first
                    assert!(!st.append_mesh_row(&row).unwrap().inserted);
                }
                seen
            })
        })
        .collect();
    let mut node_out = String::new();
    for h in handles {
        node_out.push_str(&h.join().unwrap());
        node_out.push('\n');
    }
    for h in lib {
        for (k, v) in h.join().unwrap() {
            let e = lib_max.entry(k).or_insert(0);
            *e = (*e).max(v);
        }
    }

    // every send succeeded and was written once
    let mut bodies: BTreeSet<String> = BTreeSet::new();
    let mut expect_max: BTreeMap<String, i64> = lib_max;
    for l in node_out.lines().filter(|l| !l.trim().is_empty()) {
        let v: serde_json::Value = serde_json::from_str(l).unwrap();
        match v["op"].as_str().unwrap() {
            "send" => {
                assert_eq!((v["ok"].as_bool(), v["sent"].as_bool()), (Some(true), Some(true)), "a send failed: {v}");
                assert!(bodies.insert(v["body"].as_str().unwrap().to_string()), "body sent twice: {v}");
            }
            "ack" => {
                let e = expect_max.entry(v["reader"].as_str().unwrap().into()).or_insert(0);
                *e = (*e).max(v["value"].as_i64().unwrap());
            }
            _ => unreachable!(),
        }
    }
    let sends = NODE_PROCS * NODE_OPS + ENGINE_PROCS * ENGINE_OPS;
    assert_eq!(bodies.len(), sends);
    let lib_rows = (LIB_THREADS * LIB_OPS) as i64;
    let total = count(&db, "SELECT COUNT(*) FROM messages");
    assert_eq!(total, seed_rows + sends as i64 + lib_rows, "rows: seed + one per send + one per library append, nothing lost, nothing extra");
    for b in &bodies {
        assert_eq!(count(&db, &format!("SELECT COUNT(*) FROM messages WHERE body = '{b}'")), 1, "body {b} is stored exactly once");
    }
    assert_eq!(count(&db, "SELECT COUNT(DISTINCT seq) FROM messages"), total, "every seq is unique");
    assert_eq!(count(&db, "SELECT MAX(seq) FROM messages"), total, "and gap-free");
    // every reader cursor holds the highest value written by either side
    for (reader, max) in &expect_max {
        let got = count(&db, &format!("SELECT value FROM reader_cursors WHERE partition = 'child-1' AND ns = 'store' AND reader = '{reader}'"));
        assert_eq!(got, *max, "reader {reader}: MAX-only cursor");
    }
    // every engine send was answered by the engine itself
    let log = fs::read_to_string(home.join("state").join("mesh-shadow.jsonl")).unwrap();
    let recs: Vec<serde_json::Value> = log.lines().map(|l| serde_json::from_str(l).unwrap()).collect();
    assert!(recs.iter().all(|r| r["result"] == "native"), "an engine call was handed to Node: {:?}", recs.iter().find(|r| r["result"] != "native"));
    // a last consuming read moves the child's broadcast cursor to the head
    let o = Command::new(BIN)
        .args(["mesh", "mesh", "read"])
        .current_dir(fx_path(&fixture, "wt-child"))
        .env_clear()
        .envs(env_for(&home))
        .env("DEVSWARM_BUILDER_ID", "child-1")
        .output()
        .unwrap();
    assert_eq!(o.status.code(), Some(0));
    let head = count(&db, "SELECT MAX(seq) FROM messages WHERE mtype = 'broadcast'");
    assert_eq!(count(&db, "SELECT value FROM broadcast_cursors WHERE workspace_id = 'child-1'"), head);
    // no lock left behind, and the file is sound
    let locks = home.join(".anti-hall/devswarm/locks");
    let left: Vec<String> = fs::read_dir(&locks).map(|d| d.flatten().map(|e| e.file_name().to_string_lossy().into_owned()).collect()).unwrap_or_default();
    assert!(left.iter().all(|n| !n.ends_with(".lock") && !n.contains(".lock.")), "locks left: {left:?}");
    let c = rusqlite::Connection::open(&db).unwrap();
    assert_eq!(c.query_row("PRAGMA integrity_check", [], |r| r.get::<_, String>(0)).unwrap(), "ok");
    eprintln!(
        "concurrency: {sends} CLI sends ({} Node, {} engine) + {lib_rows} store appends + {} acks; {total} rows, seq 1..{total} unique",
        NODE_PROCS * NODE_OPS,
        ENGINE_PROCS * ENGINE_OPS,
        expect_max.len()
    );
}

fn fx_path(f: &fx::Fx, name: &str) -> PathBuf {
    f.root.join(name)
}

fn store_db(home: &Path) -> PathBuf {
    let base = home.join(".anti-hall/devswarm/store");
    let key = fs::read_dir(&base).unwrap().flatten().next().unwrap().file_name();
    base.join(key).join("devswarm.db")
}

fn count(db: &Path, q: &str) -> i64 {
    let c = rusqlite::Connection::open_with_flags(db, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
    c.busy_timeout(std::time::Duration::from_secs(10)).unwrap();
    c.query_row(q, [], |r| r.get::<_, Option<i64>>(0)).unwrap().unwrap_or(0)
}
