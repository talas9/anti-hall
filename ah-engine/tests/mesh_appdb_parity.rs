//! The DevSwarm app database reader (`meshw::appdb`) and the heartbeat paths it opens, against Node.
//!
//! `heartbeat <id> --session S` with `ANTIHALL_DEVSWARM_APP_DB` pointing at a fixture app database: the engine
//! (mesh.engine_writes = on) must print the same stdout, exit with the same code and leave a byte-identical home tree
//! (heartbeat record, liveness verdict, the app-state cache file) as `devswarm.js` on an identical scratch home.
//!
//! The fixture databases hold active, closed (not archived), hidden-while-active and archived rows, twins that share a
//! worktree, duplicate ids, integer-like ids (JavaScript orders those first in the cache file), a symlinked worktree and
//! older app schemas. Injected faults: a missing file, an empty file, a non-database, a truncated database, a database
//! with an exclusive lock held, a missing table or column, values the engine does not convert like JavaScript. Every case
//! is either answered identically or deferred with NOTHING written (exit 75 when the engine cannot run Node). Cache
//! cases pre-run Node, poison the cache so the answer proves whether it was used, and age or invalidate it.
//! Native cases are also checked by the background Node shadow (`mesh-verify.jsonl`).
#![allow(clippy::unwrap_used, clippy::expect_used)] // a test crate: a panic is the failure report, and E2 exempts tests
use serde_json::{Value, json};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

#[path = "mesh_write_support/fx.rs"]
mod fx;
use fx::*;

const OLD: i64 = 1_790_000_000_000;

fn no_node_path(root: &Path) -> String {
    let bin = root.join("nonode-bin");
    fs::create_dir_all(&bin).unwrap();
    for t in ["git", "ps"] {
        let out = Command::new("sh").args(["-c", &format!("command -v {t}")]).output().unwrap();
        let src = String::from_utf8_lossy(&out.stdout).trim().to_string();
        std::os::unix::fs::symlink(&src, bin.join(t)).ok();
    }
    bin.to_string_lossy().to_string()
}

fn run_seed(script: &str, h: &Path, fx: &Fx, spec: &Value) {
    let o = Command::new("node")
        .arg(support(script))
        .arg(h)
        .arg(&fx.repo_key)
        .arg(spec.to_string())
        .env_clear()
        .env("PATH", std::env::var("PATH").unwrap())
        .env("HOME", h)
        .output()
        .unwrap();
    assert!(o.status.success(), "{script} failed: {}", String::from_utf8_lossy(&o.stderr));
}

fn normalized(home: &Path, bytes: &[u8]) -> Vec<u8> {
    String::from_utf8_lossy(bytes).replace(&home.to_string_lossy().to_string(), "<HOME>").into_bytes()
}

fn tree(home: &Path) -> std::collections::BTreeMap<String, Vec<u8>> {
    home_files(home).into_iter().map(|(k, v)| (k, normalized(home, &v))).collect()
}

fn assert_same_home(name: &str, a: &Path, b: &Path, what: &str) {
    let (fa, fb) = (tree(a), tree(b));
    assert_eq!(fa.keys().collect::<Vec<_>>(), fb.keys().collect::<Vec<_>>(), "{name}: {what}: home tree file set differs");
    for (k, v) in &fa {
        assert!(fb[k] == *v, "{name}: {what}: {k} differs:\n a: {}\n b: {}", String::from_utf8_lossy(v), String::from_utf8_lossy(&fb[k]));
    }
}

fn verify_line(state: &Path) -> Value {
    for _ in 0..300 {
        if let Ok(t) = fs::read_to_string(state.join("mesh-verify.jsonl"))
            && let Some(l) = t.lines().last()
        {
            return serde_json::from_str(l).unwrap();
        }
        std::thread::sleep(std::time::Duration::from_millis(100));
    }
    json!({"result": "none"})
}

// ---- fixture app databases ----

const BUILDERS_FULL: &str = "CREATE TABLE builders (id TEXT, repositoryId TEXT, sourceBranch TEXT, branchName TEXT, worktreePath TEXT, terminalId TEXT, label TEXT, createdAt TEXT, lastAccessed TEXT, rank INTEGER, isHidden INTEGER, pullRequestId TEXT, builderType TEXT, isPinned INTEGER, isActive INTEGER, lastSelectedAt TEXT)";

/// (id, worktreePath, isActive, isHidden, builderType)
type Row = (&'static str, Option<String>, i64, i64, Option<&'static str>);

fn insert(c: &rusqlite::Connection, r: &Row) {
    c.execute(
        "INSERT INTO builders (id, worktreePath, isActive, isHidden, builderType, branchName, label) VALUES (?1, ?2, ?3, ?4, ?5, 'b', 'l')",
        rusqlite::params![r.0, r.1, r.2, r.3, r.4],
    )
    .unwrap();
}

fn side_tables(c: &rusqlite::Connection) {
    c.execute_batch(
        "CREATE TABLE builder_terminals (id TEXT, builderId TEXT, terminalId TEXT, terminalType TEXT, aiAgent TEXT, ai_session_config TEXT, isActive INTEGER, panelStatus TEXT, createdAt TEXT, lastViewedAt TEXT, initialPrompt TEXT, initialPromptDeliveredAt TEXT, initialPromptWithheldAt TEXT);
         INSERT INTO builder_terminals VALUES ('t1','child-1','term.1','ai','claude','{\"sessionId\":\"s-1\"}',1,'idle','2026-10-01T00:00:00Z','2026-10-01T00:00:00Z','do the thing',NULL,NULL);
         CREATE TABLE pull_requests (id TEXT, repositoryId TEXT, branchName TEXT, number INTEGER, state TEXT, isDraft INTEGER, url TEXT, checkStatus TEXT, reviewStatus TEXT, lastSyncedAt TEXT);
         INSERT INTO pull_requests VALUES ('p1','r1','b',7,'open',0,'u','ok','ok','2026-10-01T00:00:00Z');
         CREATE TABLE repositories (id TEXT, path TEXT, name TEXT, defaultBaseBranch TEXT);
         INSERT INTO repositories VALUES ('r1','/tmp/does-not-matter','repo','main');",
    )
    .unwrap();
}

fn make_db(path: &Path, rows: &[Row]) {
    fs::remove_file(path).ok();
    let c = rusqlite::Connection::open(path).unwrap();
    c.execute_batch(BUILDERS_FULL).unwrap();
    side_tables(&c);
    for r in rows {
        insert(&c, r);
    }
}

struct Dirs {
    a: PathBuf,
    a_link: PathBuf,
    b: PathBuf,
    c: PathBuf,
    d: PathBuf,
    z: PathBuf,
}

fn dirs(fx: &Fx) -> Dirs {
    let mk = |n: &str| {
        let p = fx.root.join(n);
        fs::create_dir_all(&p).unwrap();
        real(&p)
    };
    let a = mk("wt-a");
    let link = fx.root.join("wt-a-link");
    std::os::unix::fs::symlink(&a, &link).unwrap();
    Dirs { a, a_link: link, b: mk("wt-b"), c: mk("wt-c"), d: mk("wt-d"), z: mk("wt-z") }
}

fn main_rows(fx: &Fx, d: &Dirs) -> Vec<Row> {
    let p = |x: &Path| Some(x.to_string_lossy().to_string());
    vec![
        ("child-1", p(&fx.child), 1, 0, Some("standard")),
        ("arch-1", p(&d.a), 0, 1, None),
        ("arch-2", p(&d.a), 0, 1, None),
        ("act-b", p(&d.b), 1, 0, None),
        ("arch-b", p(&d.b), 0, 1, None),
        ("closed-1", p(&d.c), 0, 0, None),
        ("arch-d", p(&d.d), 0, 1, None),
        ("closed-d", p(&d.d), 0, 0, None),
        ("hid-1", None, 1, 1, None),
        ("10", None, 1, 0, None),
        ("2", None, 1, 0, None),
        ("dup-1", None, 0, 1, None),
        ("dup-1", None, 1, 0, None),
    ]
}

struct Case {
    name: &'static str,
    id: &'static str,
    /// The descriptor's worktree.
    wt: Option<PathBuf>,
    /// The app database (a path; `None` = the variable is left `off`).
    db: Option<PathBuf>,
    /// Pre-run Node this many ms before the case's clock, so the cache exists.
    pre_ms: Option<i64>,
    /// (from, to) rewritten in the cache after the pre-run.
    poison: Option<(String, String)>,
    /// Touch the database after the pre-run (the cache signature changes).
    touch: bool,
    more: Vec<&'static str>,
    /// Extra files written into the home (relative path, text).
    files: Vec<(&'static str, &'static str)>,
    native: bool,
    expect: Vec<&'static str>,
    /// Hold an exclusive lock on the database during the run.
    lock: bool,
}

fn c(name: &'static str, id: &'static str, db: Option<&Path>, native: bool, expect: Vec<&'static str>) -> Case {
    Case {
        name,
        id,
        wt: None,
        db: db.map(Path::to_path_buf),
        pre_ms: None,
        poison: None,
        touch: false,
        more: vec![],
        files: vec![],
        native,
        expect,
        lock: false,
    }
}

fn seed(h: &Path, fx: &Fx, case: &Case, wt: &Path) {
    let wt = case.wt.clone().unwrap_or_else(|| wt.to_path_buf());
    let d = json!({"id": case.id, "worktreePath": wt.to_string_lossy(), "sessionId": case.id});
    let floors = json!([
        {"partition": case.id, "ns": "store", "reader": "#floor", "value": 0, "updatedAt": OLD},
        {"partition": case.id, "ns": "nd", "reader": "#floor", "value": 0, "updatedAt": OLD}
    ]);
    run_seed("ack_seed.js", h, fx, &json!({"rows": floors, "descriptors": [d]}));
    let files: Vec<Value> = case.files.iter().map(|(rel, text)| json!({"rel": rel, "text": text})).collect();
    run_seed("union_seed.js", h, fx, &json!({"files": files}));
    fs::create_dir_all(h.join(".anti-hall")).unwrap();
    fs::write(h.join(".anti-hall").join("settings.json"), "{\"mesh\":{\"engine_writes\":\"on\"}}\n").unwrap();
}

fn cache_of(h: &Path) -> PathBuf {
    h.join(".anti-hall/devswarm/cache/app-archived.json")
}

fn cases(d: &Dirs, dbs: &Dbs) -> Vec<Case> {
    let main = &dbs.main;
    let mut v = vec![
        // ---- verdicts by id ----
        c("by-id-active", "child-1", Some(main), true, vec!["\"ok\":true"]),
        c("by-id-archived-skips-the-verdict", "arch-1", Some(main), true, vec!["\"appArchived\":true"]),
        c("by-id-closed-is-not-archived", "closed-1", Some(main), true, vec!["\"idMismatch\":false"]),
        c("by-id-hidden-but-active", "hid-1", Some(main), true, vec!["\"ok\":true"]),
        c("integer-like-id", "10", Some(main), true, vec!["\"ok\":true"]),
        c("duplicate-id-last-row-wins", "dup-1", Some(main), true, vec!["\"ok\":true"]),
        // ---- verdicts by worktree (no row for the id) ----
        Case { wt: Some(d.a.clone()), ..c("twin-only-archived-by-worktree", "ghost-a", Some(main), true, vec!["\"appArchived\":true"]) },
        Case { wt: Some(d.a_link.clone()), ..c("twin-archived-through-a-symlink", "ghost-a2", Some(main), true, vec!["\"appArchived\":true"]) },
        Case { wt: Some(d.b.clone()), ..c("twin-with-an-active-builder", "ghost-b", Some(main), true, vec!["\"ok\":true"]) },
        Case { wt: Some(d.d.clone()), ..c("twin-archived-beside-a-closed-builder", "ghost-d", Some(main), true, vec!["\"idMismatch\":false"]) },
        Case { wt: Some(d.z.clone()), ..c("no-record-either-way", "ghost-z", Some(main), true, vec!["\"ok\":true"]) },
        // ---- unavailable databases: no opinion, the heartbeat is alive ----
        c("variable-off", "arch-1", None, true, vec!["\"ok\":true"]),
        c("database-missing", "arch-1", Some(&dbs.missing), true, vec!["\"ok\":true"]),
        c("database-empty-file", "arch-1", Some(&dbs.empty), true, vec!["\"ok\":true"]),
        c("database-not-sqlite", "arch-1", Some(&dbs.garbage), true, vec!["\"ok\":true"]),
        c("database-truncated", "arch-1", Some(&dbs.truncated), true, vec!["\"ok\":true"]),
        c("database-without-builders", "arch-1", Some(&dbs.no_builders), true, vec!["\"ok\":true"]),
        c("database-without-isactive", "arch-1", Some(&dbs.no_active), true, vec!["\"ok\":true"]),
        // ---- older schema: no isHidden, an inactive row is archived ----
        c("old-schema-without-ishidden", "arch-1", Some(&dbs.no_hidden), true, vec!["\"appArchived\":true"]),
        // ---- values the engine does not convert like JavaScript are deferred, nothing written ----
        c("relative-worktree-path", "child-1", Some(&dbs.relative), false, vec!["\"ok\":true"]),
        c("text-flag-value", "child-1", Some(&dbs.text_flag), false, vec!["\"ok\":true"]),
        c("blob-id", "child-1", Some(&dbs.blob_id), false, vec!["\"ok\":true"]),
        // ---- a database in WAL mode with its -wal file present (part of the cache signature) ----
        c("wal-database", "arch-1", Some(&dbs.wal), true, vec!["\"appArchived\":true"]),
        // ---- --step ----
        Case { more: vec!["--step", "2"], ..c("step-without-a-plan", "child-1", None, true, vec!["\"reason\":\"no-plan\"", "\"ok\":true"]) },
        Case { more: vec!["--step", "2", "--status", "done"], ..c("step-with-status-without-a-plan", "child-1", None, true, vec!["no-plan"]) },
        Case { more: vec!["--step", "--phase", "x"], ..c("step-bare-flag-is-no-step", "child-1", None, true, vec!["\"phase\":\"x\""]) },
        Case {
            more: vec!["--step", "1"],
            files: vec![(".anti-hall/devswarm/plans/child-1.json", "{\"steps\":[]}")],
            ..c("step-with-a-plan-defers", "child-1", None, false, vec!["\"plan\""])
        },
        Case { more: vec!["--step", "1"], ..c("step-and-archived-row", "arch-1", Some(main), true, vec!["\"appArchived\":true", "\"reason\":\"no-plan\""]) },
        Case { more: vec!["--summary", "hello"], ..c("summary-defers", "child-1", None, false, vec!["\"meshBroadcast\""]) },
        // ---- the cross-invocation cache ----
        Case {
            pre_ms: Some(1_000),
            poison: Some((r#""arch-1":{"active":false,"archived":true"#.into(), r#""arch-1":{"active":false,"archived":false"#.into())),
            ..c("cache-hit-is-used-not-the-database", "arch-1", Some(main), true, vec!["\"ok\":true"])
        },
        Case {
            pre_ms: Some(31_000),
            poison: Some((r#""arch-1":{"active":false,"archived":true"#.into(), r#""arch-1":{"active":false,"archived":false"#.into())),
            ..c("cache-expired-is-requeried", "arch-1", Some(main), true, vec!["\"appArchived\":true"])
        },
        Case {
            pre_ms: Some(29_000),
            poison: Some((r#""arch-1":{"active":false,"archived":true"#.into(), r#""arch-1":{"active":false,"archived":false"#.into())),
            ..c("cache-29s-old-is-still-used", "arch-1", Some(main), true, vec!["\"ok\":true"])
        },
        Case {
            pre_ms: Some(1_000),
            poison: Some((r#""arch-1":{"active":false,"archived":true"#.into(), r#""arch-1":{"active":false,"archived":false"#.into())),
            touch: true,
            ..c("cache-signature-changed-is-requeried", "arch-1", Some(&dbs.touch), true, vec!["\"appArchived\":true"])
        },
        Case {
            pre_ms: Some(1_000),
            poison: Some((format!("\"file\":\"{}\"", main.display()), "\"file\":\"/elsewhere/devswarm.db\"".into())),
            ..c("cache-for-another-file-is-ignored", "child-1", Some(main), true, vec!["\"ok\":true"])
        },
        Case {
            pre_ms: Some(1_000),
            poison: Some((r#""child-1":{"active":true"#.into(), r#""child-1":{"active":false"#.into())),
            ..c("cache-hit-rewrites-nothing", "child-1", Some(main), true, vec!["\"ok\":true"])
        },
        Case {
            pre_ms: Some(1_000),
            poison: Some(("\"at\":".into(), "\"at\":99".into())),
            ..c("cache-from-the-future-is-ignored", "arch-1", Some(main), true, vec!["\"appArchived\":true"])
        },
        Case {
            pre_ms: Some(1_000),
            poison: Some(("\"states\":{".into(), "\"states\":[],\"x\":{".into())),
            ..c("cache-states-of-the-wrong-shape", "arch-1", Some(main), false, vec!["\"ok\":true"])
        },
        // ---- a locked database reads as unavailable, at once ----
        Case { lock: true, ..c("database-exclusively-locked", "arch-1", Some(&dbs.locked), true, vec!["\"ok\":true"]) },
    ];
    // a corrupt cache file is a miss
    v.push(Case {
        files: vec![(".anti-hall/devswarm/cache/app-archived.json", "{not json")],
        ..c("cache-file-corrupt", "arch-1", Some(main), true, vec!["\"appArchived\":true"])
    });
    v
}

struct Dbs {
    main: PathBuf,
    missing: PathBuf,
    empty: PathBuf,
    garbage: PathBuf,
    truncated: PathBuf,
    no_builders: PathBuf,
    no_active: PathBuf,
    no_hidden: PathBuf,
    relative: PathBuf,
    text_flag: PathBuf,
    blob_id: PathBuf,
    wal: PathBuf,
    touch: PathBuf,
    locked: PathBuf,
}

fn build_dbs(fx: &Fx, d: &Dirs) -> (Dbs, rusqlite::Connection) {
    let r = &fx.root;
    let dbs = Dbs {
        main: r.join("main.db"),
        missing: r.join("nope/missing.db"),
        empty: r.join("empty.db"),
        garbage: r.join("garbage.db"),
        truncated: r.join("truncated.db"),
        no_builders: r.join("nobuilders.db"),
        no_active: r.join("noactive.db"),
        no_hidden: r.join("nohidden.db"),
        relative: r.join("relative.db"),
        text_flag: r.join("textflag.db"),
        blob_id: r.join("blobid.db"),
        wal: r.join("wal.db"),
        touch: r.join("touch.db"),
        locked: r.join("locked.db"),
    };
    let rows = main_rows(fx, d);
    make_db(&dbs.main, &rows);
    make_db(&dbs.touch, &rows);
    make_db(&dbs.locked, &rows);
    fs::write(&dbs.empty, b"").unwrap();
    fs::write(&dbs.garbage, b"this is not a database").unwrap();
    make_db(&dbs.truncated, &rows);
    let bytes = fs::read(&dbs.truncated).unwrap();
    // keep the first page(s) only: the schema is readable, the data pages are gone
    fs::write(&dbs.truncated, &bytes[..bytes.len().min(4096)]).unwrap();
    {
        let c = rusqlite::Connection::open(&dbs.no_builders).unwrap();
        c.execute_batch("CREATE TABLE other (x INTEGER)").unwrap();
        let c = rusqlite::Connection::open(&dbs.no_active).unwrap();
        c.execute_batch("CREATE TABLE builders (id TEXT, isHidden INTEGER); INSERT INTO builders VALUES ('arch-1', 1)").unwrap();
        let c = rusqlite::Connection::open(&dbs.no_hidden).unwrap();
        c.execute_batch(
            "CREATE TABLE builders (id TEXT, isActive INTEGER, worktreePath TEXT); INSERT INTO builders VALUES ('arch-1', 0, NULL), ('child-1', 1, NULL)",
        )
        .unwrap();
        let c = rusqlite::Connection::open(&dbs.relative).unwrap();
        c.execute_batch(
            "CREATE TABLE builders (id TEXT, isActive INTEGER, isHidden INTEGER, worktreePath TEXT); INSERT INTO builders VALUES ('child-1', 1, 0, 'rel/x')",
        )
        .unwrap();
        let c = rusqlite::Connection::open(&dbs.text_flag).unwrap();
        c.execute_batch("CREATE TABLE builders (id TEXT, isActive TEXT, isHidden INTEGER); INSERT INTO builders VALUES ('child-1', '1', 0)").unwrap();
        let c = rusqlite::Connection::open(&dbs.blob_id).unwrap();
        c.execute_batch("CREATE TABLE builders (id BLOB, isActive INTEGER, isHidden INTEGER); INSERT INTO builders VALUES (x'0102', 1, 0)").unwrap();
    }
    fs::remove_file(&dbs.wal).ok();
    let w = rusqlite::Connection::open(&dbs.wal).unwrap();
    w.pragma_update(None, "journal_mode", "WAL").unwrap();
    w.execute_batch(BUILDERS_FULL).unwrap();
    for row in &rows {
        insert(&w, row);
    }
    (dbs, w)
}

#[test]
fn app_database_heartbeats_match_node_byte_for_byte_and_defer_without_writing() {
    if !node_sqlite_available() {
        eprintln!("SKIPPED: Node with node:sqlite is not available, so there is no Node writer to compare with");
        return;
    }
    let fx = fixture("appdb");
    let d = dirs(&fx);
    let nonode = no_node_path(&fx.root);
    let (dbs, _wal_writer) = build_dbs(&fx, &d);
    let list = cases(&d, &dbs);
    let (mut native, mut deferred, mut verified) = (0, 0, 0);
    for (i, case) in list.iter().enumerate() {
        let now = 1_795_000_000_000 + i as i64 * 40_009;
        let (hn, he, hd) =
            (fx.root.join(format!("{}-node", case.name)), fx.root.join(format!("{}-engine", case.name)), fx.root.join(format!("{}-defer", case.name)));
        let mut av: Vec<String> = vec!["heartbeat".into(), case.id.into(), "--session".into(), "s1".into()];
        av.extend(case.more.iter().map(|x| (*x).to_string()));
        let av: Vec<&str> = av.iter().map(String::as_str).collect();
        let db_s = case.db.as_ref().map(|p| p.to_string_lossy().to_string());
        let extra: Vec<(&str, &str)> = db_s.iter().map(|p| ("ANTIHALL_DEVSWARM_APP_DB", p.as_str())).collect();
        for h in [&hn, &he, &hd] {
            copy_tree(&fx.seed_home, h);
            seed(h, &fx, case, &fx.child);
        }
        let _lock = case.lock.then(|| {
            let l = rusqlite::Connection::open(case.db.as_ref().unwrap()).unwrap();
            l.execute_batch("BEGIN EXCLUSIVE").unwrap();
            l
        });
        if let Some(ms) = case.pre_ms {
            for h in [&hn, &he, &hd] {
                let r = node_verb(h, &h.join("state"), &fx.child, &av, now - ms, None, &extra);
                assert_eq!(r.code, 0, "{}: pre-run", case.name);
                assert!(cache_of(h).is_file(), "{}: the pre-run left no cache file", case.name);
                if let Some((from, to)) = &case.poison {
                    let t = fs::read_to_string(cache_of(h)).unwrap();
                    assert!(t.contains(from.as_str()), "{}: cache lacks {from:?}: {t}", case.name);
                    fs::write(cache_of(h), t.replace(from.as_str(), to)).unwrap();
                }
            }
            if case.touch {
                let c = rusqlite::Connection::open(case.db.as_ref().unwrap()).unwrap();
                c.execute_batch("UPDATE builders SET label = 'changed'").unwrap();
            }
        }
        let n = node_verb(&hn, &hn.join("state"), &fx.child, &av, now, None, &extra);
        for want in &case.expect {
            assert!(n.stdout.contains(want), "{}: Node's output lacks {want:?}: {}", case.name, n.stdout);
        }
        let e = engine_verb(&he, &he.join("state"), &fx.child, &av, now, None, &extra);
        let log = last_log(&he.join("state"));
        assert_eq!(log["result"] == "native", case.native, "{}: expected native={} but the engine logged {log}", case.name, case.native);
        if case.native {
            native += 1;
            assert_eq!(log["verb"], "Heartbeat", "{}: telemetry names the verb", case.name);
            assert_eq!((e.code, &e.stdout), (n.code, &n.stdout), "{}: stdout/exit differ", case.name);
            assert_same_home(case.name, &hn, &he, "node vs engine");
            let v = verify_line(&he.join("state"));
            assert_eq!(v["result"], "match", "{}: the background Node shadow disagrees: {v}", case.name);
            verified += 1;
        } else {
            deferred += 1;
            assert_eq!(e.code, n.code, "{}: exit code of the fallback", case.name);
            // the contract: deferred means NOTHING written, and exit 75 when the engine cannot run Node
            let before = fx.root.join(format!("{}-before", case.name));
            copy_tree(&fx.seed_home, &before);
            seed(&before, &fx, case, &fx.child);
            if let Some(ms) = case.pre_ms {
                node_verb(&before, &before.join("state"), &fx.child, &av, now - ms, None, &extra);
                if let Some((from, to)) = &case.poison {
                    let t = fs::read_to_string(cache_of(&before)).unwrap();
                    fs::write(cache_of(&before), t.replace(from.as_str(), to)).unwrap();
                }
            }
            let dd = engine_verb(&hd, &hd.join("state"), &fx.child, &av, now, None, &[extra.clone(), vec![("PATH", nonode.as_str())]].concat());
            assert_eq!(dd.code, 75, "{}: a deferral the engine cannot hand to Node exits 75, got {} / {}", case.name, dd.code, dd.stdout);
            assert!(dd.stdout.is_empty(), "{}: nothing is printed on a deferral: {}", case.name, dd.stdout);
            assert_eq!(last_log(&hd.join("state"))["result"], "defer", "{}: logged as a deferral", case.name);
            if case.pre_ms.is_none() {
                assert_same_home(case.name, &before, &hd, "deferral wrote");
            }
        }
    }
    eprintln!(
        "app database parity: {} cases, {native} answered by the engine and identical to Node ({verified} confirmed by the background Node check), {deferred} deferred with nothing written",
        list.len()
    );
    assert!(native >= 28 && deferred >= 6, "{native} native, {deferred} deferred");
}
