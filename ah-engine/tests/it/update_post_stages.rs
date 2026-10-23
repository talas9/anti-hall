//! Roadmap #61 chunk C1: the post-update store stages the engine answers itself (`reader-cursors-import`, `reader-floor-repair`,
//! `dual-partition-acks`, `promote-unclaimed`), pinned against the Node functions of `update.js`.
//!
//! Each scenario seeds a scratch home with the BAD state an earlier version left (a partition never imported, floors pinned by
//! readers whose process is gone, a twin partition that never saw the other's ack, a row stuck on `unclaimed:`), then compares
//! the engine's answer, the store afterwards and the files under `.anti-hall` with what the Node function produced on the same
//! seed. The Node answer is FROZEN in `tests/fixtures/update_post/<stage>/<scenario>.json` (record it with
//! `AH_RECORD_UPDATE_FIXTURES=1`, which runs the Node function on a seeded world; the replay never runs Node: its `node` is a
//! shim that records the call and fails). Every stage is also run a second time (a no-op) and switched off with `enabled = false`.
use super::update_parity::{Opt, World, envs, finish, node_calls, norm, run_engine, tree, world};
use ah_engine::meshw::store::{CursorPut, MeshRow, MeshStore, RegistryRow};
use serde_json::{Value, json};
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicUsize, Ordering};

static N: AtomicUsize = AtomicUsize::new(0);
pub(super) const VERSION: &str = "0.1.0";
pub(super) const STORE: &str = "proj-a1b2c3";
const FAR_FUTURE: i64 = 4_000_000_000_000;

pub(super) fn recording() -> bool {
    std::env::var_os("AH_RECORD_UPDATE_FIXTURES").is_some()
}

pub(super) fn fixture_path(stage: &str, name: &str) -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/update_post").join(stage).join(format!("{name}.json"))
}

// ---- seeding -------------------------------------------------------------------------------------------------------------

pub(super) fn ds(home: &Path) -> PathBuf {
    home.join(".anti-hall/devswarm")
}

pub(super) fn open_store(home: &Path, hash: &str) -> MeshStore {
    let dir = ds(home).join("store").join(hash);
    fs::create_dir_all(&dir).unwrap();
    fs::write(dir.join("BACKEND"), "sqlite\n").unwrap();
    MeshStore::open(&dir.join("devswarm.db")).unwrap()
}

pub(super) fn msg(st: &MeshStore, ws: &str, n: i64, hash: &str, orig: Option<&str>) {
    st.append_mesh_row(&MeshRow {
        workspace_id: ws.into(),
        ts: 1_790_000_000_000 + n,
        hash: Some(hash.into()),
        body: format!("m{n}"),
        sender: Some("sender".into()),
        recipient: Some(ws.into()),
        mtype: Some("direct".into()),
        urgency: Some("normal".into()),
        orig_hash: orig.map(str::to_string),
        ..MeshRow::default()
    })
    .unwrap();
}

fn cur(st: &MeshStore, p: &str, ns: &str, reader: &str, value: i64) {
    st.reader_cursor_txn(&[CursorPut { partition: p.into(), ns: ns.into(), reader: reader.into(), value, retired_line: None, updated_at: 1000 }]).unwrap();
}

pub(super) fn registry(st: &MeshStore, id: &str, wt: Option<&str>, session: Option<&str>) {
    st.upsert_registry(
        &RegistryRow { id: id.into(), worktree_path: wt.map(str::to_string), session_id: session.map(str::to_string), ..RegistryRow::default() },
        1000,
        |a, b| a == b,
    )
    .unwrap();
}

pub(super) fn put(home: &Path, rel: &str, text: &str) {
    let p = home.join(rel);
    fs::create_dir_all(p.parent().unwrap()).unwrap();
    fs::write(p, text).unwrap();
}

/// This process as a live harness session (it started long before `FAR_FUTURE`, so its recorded start is not a pid reuse).
fn live_session(home: &Path) -> (String, String) {
    let pid = std::process::id();
    put(home, &format!(".claude/sessions/{pid}.json"), &format!(r#"{{"pid":{pid},"startedAt":{FAR_FUTURE},"cwd":"/nonexistent"}}"#));
    (format!("h:{pid}:{FAR_FUTURE}"), ah_engine::meshw::cursors::short_nonce(&format!("anc:{pid}:{FAR_FUTURE}")))
}

const GONE: &str = "h:999999:1000000000001";

/// A partition never imported by the earlier build, a legacy position per file, a live mapped harness, an ended reader on a
/// partition that was imported; a second, empty store.
fn seed_import(home: &Path) {
    let st = open_store(home, STORE);
    for (i, h) in ["a1", "a2", "a3"].iter().enumerate() {
        msg(&st, "w1", i as i64, h, None);
    }
    for (i, h) in ["b1", "b2"].iter().enumerate() {
        msg(&st, "w2", i as i64, h, None);
    }
    cur(&st, "w2", "store", "#floor", 1);
    cur(&st, "w2", "nd", "#floor", 0);
    cur(&st, "w2", "store", GONE, 0);
    cur(&st, "w2", "nd", GONE, 0);
    drop(st);
    registry(&open_store(home, "proj-d4e5f6"), "w9", None, None);
    let (_, short) = live_session(home);
    put(home, ".anti-hall/devswarm/cursors/w1.json", "2");
    put(home, &format!(".anti-hall/devswarm/cursors/w1#inst-{short}.json"), "1");
    put(home, &format!(".anti-hall/devswarm/cursors/w1#nd-{short}.json"), "0");
    put(home, ".anti-hall/devswarm/workspaces/w1.json", &format!(r#"{{"id":"w1","cursorPath":"{}/nd-w1.cursor"}}"#, home.display()));
    put(home, "nd-w1.cursor", "3");
}

/// A partition never imported and a live harness session whose `cwd` is empty and which has no legacy file: Node's
/// `cwdInPartition` is `false` for an empty cwd, so no reader row is declared (only the floors).
fn seed_import_no_cwd(home: &Path) {
    let st = open_store(home, STORE);
    for (i, h) in ["a1", "a2", "a3"].iter().enumerate() {
        msg(&st, "w1", i as i64, h, None);
    }
    drop(st);
    let pid = std::process::id();
    put(home, &format!(".claude/sessions/{pid}.json"), &format!(r#"{{"pid":{pid},"startedAt":{FAR_FUTURE},"cwd":""}}"#));
    put(home, ".anti-hall/devswarm/cursors/w1.json", "2");
}

/// Two partitions never imported; the second (`primary-...`, so it names a mesh id) meets a live session whose relative `cwd`
/// only Node can classify. The first alone would import cleanly.
fn seed_import_deferred(home: &Path) {
    let st = open_store(home, STORE);
    for p in ["a1", "primary-0123abcd"] {
        for (i, h) in ["a1", "a2"].iter().enumerate() {
            msg(&st, p, i as i64, &format!("{p}{h}"), None);
        }
    }
    drop(st);
    let pid = std::process::id();
    put(home, &format!(".claude/sessions/{pid}.json"), &format!(r#"{{"pid":{pid},"startedAt":{FAR_FUTURE},"cwd":"relative/dir"}}"#));
}

/// Two imported partitions; `a1` has a reader whose process is gone (it would be retired), `primary-0123abcd` a live reader whose
/// session names a relative `cwd` that only Node can classify.
fn seed_floors_deferred(home: &Path) {
    let st = open_store(home, STORE);
    let pid = std::process::id();
    for p in ["a1", "primary-0123abcd"] {
        for i in 0..3 {
            msg(&st, p, i, &format!("{p}{i}"), None);
        }
        for ns in ["store", "nd"] {
            cur(&st, p, ns, "#floor", 0);
        }
    }
    for ns in ["store", "nd"] {
        cur(&st, "a1", ns, GONE, 0);
        cur(&st, "primary-0123abcd", ns, &format!("h:{pid}:{FAR_FUTURE}"), 0);
    }
    put(home, &format!(".claude/sessions/{pid}.json"), &format!(r#"{{"pid":{pid},"startedAt":{FAR_FUTURE},"cwd":"relative/dir"}}"#));
}

/// `seed_dual`, plus a registry row whose worktree path is relative (only git can place it).
fn seed_dual_deferred(home: &Path) {
    seed_dual(home);
    registry(&open_store(home, STORE), "rel-1", Some("relative/wt"), None);
}

/// The anchor was never imported and the twin read all three of its rows (so the anchor would be raised through the import),
/// while a live session names a relative `cwd` that only Node can classify.
fn seed_dual_import_deferred(home: &Path) {
    let st = open_store(home, STORE);
    let (a, wt) = (anchor(), repo().to_string_lossy().into_owned());
    registry(&st, &a, Some(&wt), None);
    registry(&st, "kid-1", Some(&wt), None);
    for (i, h) in ["x1", "x2", "x3"].iter().enumerate() {
        msg(&st, &a, i as i64, h, None);
    }
    for (i, (h, o)) in [("y1", Some("x1")), ("y2", Some("x2")), ("y3", Some("x3"))].iter().enumerate() {
        msg(&st, "kid-1", 10 + i as i64, h, *o);
    }
    for ns in ["store", "nd"] {
        cur(&st, "kid-1", ns, "#floor", if ns == "store" { 3 } else { 0 });
    }
    drop(st);
    let pid = std::process::id();
    put(home, &format!(".claude/sessions/{pid}.json"), &format!(r#"{{"pid":{pid},"startedAt":{FAR_FUTURE},"cwd":"relative/dir"}}"#));
}

/// Floors the v0.106.0 import pinned: readers whose process is gone, one whose session file names another session, one live
/// but not local, one local that really read; an nd floor imported as 0 on a partition with a legacy nd cursor.
fn seed_floors(home: &Path) {
    let st = open_store(home, STORE);
    for i in 0..6 {
        msg(&st, "p1", i, &format!("c{i}"), None);
    }
    msg(&st, "p2", 0, "d0", None);
    for ns in ["store", "nd"] {
        for p in ["p1", "p2"] {
            cur(&st, p, ns, "#floor", 0);
        }
    }
    let (live, _) = live_session(home);
    let pid = std::process::id();
    for ns in ["store", "nd"] {
        cur(&st, "p1", ns, GONE, 0);
        cur(&st, "p1", ns, &format!("h:{pid}:5000000000000"), 2);
    }
    cur(&st, "p1", "store", &live, 5);
    cur(&st, "p1", "nd", &live, 0);
    put(home, ".anti-hall/devswarm/workspaces/p2.json", &format!(r#"{{"id":"p2","cursorPath":"{}/nd-p2.cursor"}}"#, home.display()));
    put(home, "nd-p2.cursor", "4");
}


/// Rows an older build stamped `unclaimed:`: one with a real session in its heartbeat (descriptor and registry both promoted),
/// one without a heartbeat, one whose heartbeat is itself a marker, one whose registry already holds a real value, one with no
/// registry row at all.
fn seed_promote(home: &Path) {
    let rows: [(&str, Option<&str>, Option<&str>); 5] = [
        ("u1", Some("sess-real-1"), Some("unclaimed:u1")),
        ("u2", None, Some("unclaimed:u2")),
        ("u3", Some("unclaimed:u3"), Some("unclaimed:u3")),
        ("u4", Some("sess-4"), Some("sess-reg-4")),
        ("u5", Some("sess-5"), None),
    ];
    for (id, beat, registered) in rows {
        let wt = format!("/nonexistent/{id}");
        put(
            home,
            &format!(".anti-hall/devswarm/workspaces/{id}.json"),
            &format!(r#"{{"id":"{id}","worktreePath":"{wt}","sessionId":"unclaimed:{id}","inboxPath":null,"cursorPath":null,"nudgeCommand":null}}"#),
        );
        if let Some(b) = beat {
            put(home, &format!(".anti-hall/devswarm/heartbeats/{id}.json"), &format!(r#"{{"id":"{id}","sessionId":" {b} "}}"#));
        }
        let st = open_store(home, &ah_engine::meshw::send::hash_from_workspace_id(id));
        if let Some(r) = registered {
            registry(&st, id, Some(&wt), Some(r));
        }
    }
}

static REPO: std::sync::OnceLock<PathBuf> = std::sync::OnceLock::new();

/// One git checkout shared by every world of this process: the mesh id of a worktree is a hash of its real path.
pub(super) fn repo() -> &'static Path {
    REPO.get_or_init(|| {
        let p = fs::canonicalize(std::env::temp_dir()).unwrap().join(format!("ah-c1-repo-{}-{}", std::process::id(), N.fetch_add(1, Ordering::Relaxed)));
        fs::create_dir_all(&p).unwrap();
        let ok = Command::new("git").args(["init", "-q"]).current_dir(&p).env("GIT_CONFIG_GLOBAL", "/dev/null").status().unwrap().success();
        assert!(ok, "git init");
        p
    })
}

pub(super) fn anchor() -> String {
    ah_engine::meshw::ident::canonical_mesh_id(&repo().to_string_lossy()).unwrap().unwrap()
}

/// An anchor and a partner row on one worktree; the partner holds forwarded copies of what the anchor's reader already read.
fn seed_dual(home: &Path) {
    let st = open_store(home, STORE);
    let (a, wt) = (anchor(), repo().to_string_lossy().into_owned());
    registry(&st, &a, Some(&wt), None);
    registry(&st, "kid-1", Some(&wt), None);
    for (i, h) in ["x1", "x2", "x3"].iter().enumerate() {
        msg(&st, &a, i as i64, h, None);
    }
    for (i, (h, o)) in [("y1", Some("x1")), ("y2", Some("x2")), ("y3", Some("x3")), ("y4", None)].iter().enumerate() {
        msg(&st, "kid-1", 10 + i as i64, h, *o);
    }
    for ns in ["store", "nd"] {
        cur(&st, &a, ns, "#floor", if ns == "store" { 2 } else { 0 });
        cur(&st, "kid-1", ns, "#floor", 0);
    }
}

/// A DevSwarm home with no cursors directory at all.
fn seed_nothing(home: &Path) {
    put(home, ".anti-hall/devswarm/workspaces/w1.json", r#"{"id":"w1"}"#);
}

/// Put a file's mtime `days` days in the past (a cursor file the staleness window covers).
fn age(home: &Path, rel: &str, days: u64) {
    let f = fs::OpenOptions::new().write(true).open(home.join(rel)).unwrap();
    f.set_modified(std::time::SystemTime::now() - std::time::Duration::from_secs(days * 86_400)).unwrap();
}

/// The per-instance cursor files an older build left: two stale instance files of `w1` (the lagging one pins the floor, so both would be
/// evicted), one fresh one (a live reader), a lone stale nd file (a plain delete), a stale instance file at the shared position (a plain
/// delete), a name that is not ours (never touched).
fn seed_hygiene(home: &Path) {
    let c = ".anti-hall/devswarm/cursors";
    for (name, body, days) in [
        ("w1.json", "5", 0),
        ("w1#base.json", "2", 0),
        ("w1#inst-aaaaaa.json", "3", 10),
        ("w1#inst-bbbbbb.json", "7", 10),
        ("w1#inst-cccccc.json", "9", 0),
        ("w2#nd-dddddd.json", "1", 10),
        ("w3.json", "4", 0),
        ("w3#inst-eeeeee.json", r#"{"line":4}"#, 10),
        ("junk#inst-ZZZZZZ.json", "1", 10),
    ] {
        put(home, &format!("{c}/{name}"), body);
        if days > 0 {
            age(home, &format!("{c}/{name}"), days);
        }
    }
}

/// Two sqlite stores and a `journal/` directory beside one of them that holds no `.ndjson` file: no store is split.
fn seed_not_split(home: &Path) {
    let st = open_store(home, STORE);
    msg(&st, "w1", 0, "m1", None);
    registry(&st, "w1", None, None);
    drop(st);
    registry(&open_store(home, "proj-d4e5f6"), "w9", None, None);
    put(home, &format!(".anti-hall/devswarm/store/{STORE}/journal/README.txt"), "not a journal segment");
}

/// A store whose sqlite side and `journal/*.ndjson` side both hold data: the split the merge repairs (Node's to do).
fn seed_split(home: &Path) {
    seed_not_split(home);
    put(home, &format!(".anti-hall/devswarm/store/{STORE}/journal/messages.ndjson"), "{\"workspaceId\":\"w1\",\"ts\":1,\"hash\":\"zz\",\"body\":\"only in the journal\"}\n");
}

static CHILD: std::sync::OnceLock<PathBuf> = std::sync::OnceLock::new();

/// A linked worktree of the shared checkout: a CHILD worktree (the main one is the Primary checkout).
fn child() -> &'static Path {
    CHILD.get_or_init(|| {
        let r = repo();
        let git = |args: &[&str]| {
            let ok = Command::new("git").args(args).current_dir(r).env("GIT_CONFIG_GLOBAL", "/dev/null").status().unwrap().success();
            assert!(ok, "git {args:?}");
        };
        git(&["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "init"]);
        let p = PathBuf::from(format!("{}-child", r.display()));
        git(&["worktree", "add", "-q", &p.to_string_lossy()]);
        fs::canonicalize(p).unwrap()
    })
}

/// The `primary-<hash>` sender label of the child worktree.
fn child_label() -> String {
    ah_engine::meshw::ident::canonical_mesh_id(&child().to_string_lossy()).unwrap().unwrap()
}

fn msg_from(st: &MeshStore, ws: &str, n: i64, hash: &str, sender: &str) {
    st.append_mesh_row(&MeshRow {
        workspace_id: ws.into(),
        ts: 1_790_000_000_000 + n,
        hash: Some(hash.into()),
        body: format!("m{n}"),
        sender: Some(sender.into()),
        recipient: Some(ws.into()),
        mtype: Some("direct".into()),
        urgency: Some("normal".into()),
        ..MeshRow::default()
    })
    .unwrap();
}

/// A message sent under the label of the PRIMARY checkout, whose worktree has a registered row: not a child's label.
fn seed_labels_primary(home: &Path) {
    let st = open_store(home, STORE);
    registry(&st, "kid-1", Some(&repo().to_string_lossy()), None);
    msg_from(&st, "kid-1", 0, "p1", &anchor());
}

/// A child worktree's sends carry its `primary-<hash>` label and no registry row holds that label: the label would be aliased.
fn seed_labels_sender(home: &Path) {
    let st = open_store(home, STORE);
    registry(&st, "kid-2", Some(&child().to_string_lossy()), None);
    msg_from(&st, "kid-2", 0, "c1", &child_label());
}

/// The phantom `primary-<childhash>` registry row an older build minted for the child, beside the child's real row.
fn seed_labels_row(home: &Path) {
    let st = open_store(home, STORE);
    let wt = child().to_string_lossy().into_owned();
    registry(&st, "kid-2", Some(&wt), None);
    registry(&st, &child_label(), Some(&wt), None);
    msg_from(&st, &child_label(), 0, "c1", "kid-2");
}

/// The same, but two real rows live on the child worktree: which one the label stands for is not provable, so nothing is guessed.
fn seed_labels_ambiguous(home: &Path) {
    seed_labels_row(home);
    registry(&open_store(home, STORE), "kid-3", Some(&child().to_string_lossy()), None);
}

// ---- the picture of a world ----------------------------------------------------------------------------------------------

fn near_now(v: i64) -> bool {
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis() as i64;
    (now - v).abs() < 600_000
}

fn rows(db: &Path, table: &str, cols: &str, order: &str) -> Value {
    let c = rusqlite::Connection::open_with_flags(db, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
    let Ok(mut st) = c.prepare(&format!("SELECT {cols} FROM {table} ORDER BY {order}")) else { return Value::Null };
    let n = st.column_count();
    let names: Vec<String> = st.column_names().iter().map(|s| s.to_string()).collect();
    let mut out = Vec::new();
    let mut q = st.query([]).unwrap();
    while let Some(r) = q.next().unwrap() {
        let mut o = serde_json::Map::new();
        #[allow(clippy::needless_range_loop)] // `i` indexes both the row and the column names
        for i in 0..n {
            let v = match r.get_ref(i).unwrap() {
                rusqlite::types::ValueRef::Null => Value::Null,
                rusqlite::types::ValueRef::Integer(x) if names[i].ends_with("updated_at") && near_now(x) => json!("<now>"),
                rusqlite::types::ValueRef::Integer(x) => json!(x),
                rusqlite::types::ValueRef::Real(x) => json!(x),
                rusqlite::types::ValueRef::Text(t) => json!(String::from_utf8_lossy(t)),
                rusqlite::types::ValueRef::Blob(_) => json!("<blob>"),
            };
            o.insert(names[i].clone(), v);
        }
        out.push(Value::Object(o));
    }
    Value::Array(out)
}

/// The stores (reader cursors, the legacy cursor rows, the registry) and the files under `.anti-hall` of a world.
pub(super) fn picture(w: &World, answer: Value, anchor: Option<&str>) -> Value {
    let mut stores = BTreeMap::new();
    let dir = ds(&w.home).join("store");
    for e in fs::read_dir(&dir).into_iter().flatten().flatten() {
        let db = e.path().join("devswarm.db");
        if !db.is_file() {
            continue;
        }
        stores.insert(
            e.file_name().to_string_lossy().into_owned(),
            json!({
                "reader_cursors": rows(&db, "reader_cursors", "partition, ns, reader, value, retired_line, updated_at", "partition, ns, reader"),
                "cursors": rows(&db, "cursors", "workspace_id, value", "workspace_id"),
                "registry": rows(&db, "registry", "id, worktree_path, session_id", "id"),
                "messages": rows(&db, "messages", "workspace_id, hash", "id"),
            }),
        );
    }
    let pid = regex::Regex::new(r#""pid":\d+"#).unwrap();
    let ts = regex::Regex::new(r#"^\{"ts":"[^"]*""#).unwrap();
    let generated = regex::Regex::new(r#""generatedAt":\d+"#).unwrap();
    let archived_at = regex::Regex::new(r#""archivedAt":\d+"#).unwrap();
    let files: BTreeMap<String, String> = tree(&w.home)
        .into_iter()
        .filter(|(k, _)| {
            k.starts_with(".anti-hall/") && !k.contains("/store/") && !k.contains("/locks/") && !k.starts_with(".anti-hall/state") && (!k.starts_with(".anti-hall/logs") || k == ".anti-hall/logs/" || k == ".anti-hall/logs/devswarm.jsonl")
        })
        .map(|(k, v)| {
            let v = pid.replace_all(&norm(&v, w), r#""pid":0"#).into_owned();
            let v = generated.replace_all(&v, r#""generatedAt":0"#).into_owned();
            let v = archived_at.replace_all(&v, r#""archivedAt":0"#).into_owned();
            (k, v.lines().map(|l| ts.replace(l, r#"{"ts":"T""#).into_owned()).collect::<Vec<_>>().join("\n"))
        })
        .collect();
    let mut text = json!({"answer": answer, "stores": stores, "files": files}).to_string();
    if let Some(a) = anchor {
        text = text.replace(a, "{ANCHOR}");
    }
    // the harness this test pretends to be is the test process itself: its pid and the tag derived from it are not part of the picture
    let pid = std::process::id();
    let far = ah_engine::meshw::cursors::short_nonce(&format!("anc:{pid}:{FAR_FUTURE}"));
    text = text.replace(&format!("h:{pid}:"), "h:{PID}:").replace(&far, "{SHORT}");
    if CHILD.get().is_some() {
        text = text.replace(&child_label(), "{CHILD_LABEL}");
    }
    if let Some(r) = REPO.get() {
        // the repo key of the shared checkout (its name carries this process's id and a hash of its path)
        if let Ok(Some(k)) = ah_engine::meshw::ident::repo_key_for_worktree(&r.to_string_lossy()) {
            text = text.replace(&k, "{REPOKEY}");
        }
        text = text.replace(r.to_string_lossy().as_ref(), "{REPO}");
    }
    let mut v: Value = serde_json::from_str(&norm(&text, w)).unwrap();
    for st in v["stores"].as_object_mut().unwrap().values_mut() {
        if let Some(rows) = st["reader_cursors"].as_array_mut() {
            rows.sort_by_key(|r| (r["partition"].to_string(), r["ns"].to_string(), r["reader"].to_string()));
        }
    }
    v
}

// ---- running a stage -----------------------------------------------------------------------------------------------------

/// Node's stage function on the world, as `update.js` calls it.
fn node_answer(w: &World, o: &Opt, func: &str) -> Value {
    let snippet = r#"const u=require(process.argv[1]+"/skills/update/scripts/update.js");const o=JSON.parse(process.argv[3]);o.paths=u.resolvePaths(process.env,require("os").homedir());console.log(JSON.stringify(u[process.argv[2]](o)))"#;
    let mut cmd = Command::new("node");
    cmd.arg("-e").arg(snippet).arg(w.mp.join("plugins/anti-hall")).arg(func).arg(format!(r#"{{"version":"{VERSION}"}}"#)).current_dir(&w.home);
    envs(&mut cmd, w, o);
    let out = finish(cmd.output().unwrap());
    assert_eq!(out.code, 0, "node stage failed: {}", out.stderr);
    serde_json::from_str(out.stdout.lines().rev().find(|l| !l.trim().is_empty()).unwrap()).unwrap()
}

fn engine_answer(w: &World, o: &Opt, key: &str) -> Value {
    let out = run_engine(w, o, &["--post-pull-only"]);
    assert_eq!(out.code, 0, "engine failed: {}", out.stderr);
    let status: Value = serde_json::from_str(out.stdout.lines().next().unwrap()).unwrap();
    let status = &status["status"];
    status.get(key).unwrap_or_else(|| panic!("no {key} in {status}")).clone()
}

struct Case {
    stage: &'static str,
    name: &'static str,
    /// The stage row's name in the post-pull table.
    row: &'static str,
    /// Its status key.
    key: &'static str,
    /// The Node stage function.
    func: &'static str,
    seed: fn(&Path),
    live: bool,
    markers: bool,
    /// The anchor is the mesh id of the nested repository (a working directory only git can place).
    nested: bool,
    /// Answer members left out of the comparison with the frozen Node result (the documented difference only), and files likewise.
    mask: &'static [&'static str],
}

impl Case {
    fn anchor(&self) -> String {
        if self.nested { nested_anchor() } else { anchor() }
    }

    fn opt(&self) -> Opt {
        Opt { ds: true, no_upstream_move: true, live: self.live, ..Opt::default() }
    }

    fn mark(&self, home: &Path) {
        if self.markers {
            put(home, ".anti-hall/update-sweep-state.json", &format!(r#"{{"{}":{{"completedVersion":"{VERSION}"}}}}"#, self.state_key()));
        }
    }

    fn state_key(&self) -> &'static str {
        match self.stage {
            "reader-cursors-import" => "readerCursorsImport",
            "reader-floor-repair" => "repairReaderFloors",
            "dual-partition-acks" => "reconcileDualPartitionAcks",
            "cursor-hygiene" => "cursorHygiene",
            "merge-split-backend-stores" => "mergeSplitBackendStores",
            "child-sender-labels" => "repairChildSenderLabels",
            "owner-key-migrate" => "ownerKeyMigrate",
            "app-archived-markers" => "markAppArchived",
            "re-retire-resurrected" => "reRetireResurrected",
            _ => "none",
        }
    }
}

/// What the replay's `node` shim logged, besides (the engine owns ingest by default, so no ingest probe is made).
fn stage_node_calls(w: &World) -> Vec<String> {
    node_calls(w).lines().map(str::to_string).collect()
}

/// Record (when asked) and replay one scenario; returns the replay world's picture and the world, for follow-up checks.
fn replay(c: &Case) -> (Value, World, Opt) {
    let o = c.opt();
    let anchor = c.anchor();
    if recording() {
        let a = world(&o);
        (c.seed)(&a.home);
        c.mark(&a.home);
        let ans = node_answer(&a, &o, c.func);
        let pic = picture(&a, ans, Some(&anchor));
        let p = fixture_path(c.stage, c.name);
        fs::create_dir_all(p.parent().unwrap()).unwrap();
        fs::write(p, format!("{}\n", serde_json::to_string_pretty(&pic).unwrap())).unwrap();
    }
    let want: Value = serde_json::from_str(&fs::read_to_string(fixture_path(c.stage, c.name)).unwrap_or_else(|e| panic!("{}/{}: no fixture ({e}); record with AH_RECORD_UPDATE_FIXTURES=1", c.stage, c.name))).unwrap();
    let eo = Opt { no_node: true, stage_only: Some(c.row), ..o };
    let w = world(&eo);
    (c.seed)(&w.home);
    c.mark(&w.home);
    let ans = engine_answer(&w, &eo, c.key);
    assert_eq!(stage_node_calls(&w), Vec::<String>::new(), "{}/{}: the engine ran Node for the stage", c.stage, c.name);
    let got = picture(&w, ans, Some(&anchor));
    let unmasked = |v: &Value| {
        let mut v = v.clone();
        if let Some(o) = v["answer"].as_object_mut() {
            o.retain(|k, _| !c.mask.contains(&k.as_str()));
        }
        if !c.mask.is_empty()
            && let Some(f) = v["files"].as_object_mut()
        {
            f.remove(".anti-hall/devswarm/wake/");
        }
        v
    };
    let (want_m, got_m) = (unmasked(&want), unmasked(&got));
    for k in ["answer", "stores", "files"] {
        assert!(want_m[k] == got_m[k], "{}/{}: {k} differs from the frozen Node result\n{}", c.stage, c.name, diff(&want_m[k], &got_m[k]));
    }
    (got, w, eo)
}

/// The members that differ between two JSON objects (or the two values), for a failure message.
pub(super) fn diff(want: &Value, got: &Value) -> String {
    match (want.as_object(), got.as_object()) {
        (Some(w), Some(g)) => w
            .keys()
            .chain(g.keys())
            .collect::<std::collections::BTreeSet<_>>()
            .into_iter()
            .filter(|k| w.get(*k) != g.get(*k))
            .map(|k| format!("  {k}\n    frozen: {}\n    engine: {}", w.get(k).map_or("<absent>".into(), Value::to_string), g.get(k).map_or("<absent>".into(), Value::to_string)))
            .collect::<Vec<_>>()
            .join("\n"),
        _ => format!("  frozen: {want}\n  engine: {got}"),
    }
}

/// A second run changes nothing: the one-time marker is stamped by the first run (or the stage is idempotent without one).
fn second_run_is_a_no_op(c: &Case, first: &Value, w: &World, o: &Opt) {
    let again = engine_answer(w, o, c.key);
    let pic = picture(w, again.clone(), Some(&c.anchor()));
    assert_eq!(first["stores"], pic["stores"], "{}/{}: a second run changed a store", c.stage, c.name);
    let strip = |v: &Value| {
        let mut f = v["files"].as_object().unwrap().clone();
        f.retain(|k, _| !k.contains("cursor-log") && !k.contains("update-sweep-state"));
        f
    };
    assert_eq!(strip(first), strip(&pic), "{}/{}: a second run changed a file", c.stage, c.name);
    if c.live && first["answer"]["errors"] == json!(0) && c.state_key() != "none" {
        assert_eq!(again["skippedAlreadyDone"], json!(true), "{}/{}: the one-time marker was not stamped: {again}", c.stage, c.name);
    }
}

fn run_case(c: &Case) {
    let (got, w, o) = replay(c);
    second_run_is_a_no_op(c, &got, &w, &o);
}

macro_rules! case {
    ($fn:ident, $stage:literal, $name:literal, $row:literal, $key:literal, $func:literal, $seed:expr, live: $live:literal, markers: $markers:literal) => {
        #[test]
        fn $fn() {
            run_case(&Case { stage: $stage, name: $name, row: $row, key: $key, func: $func, seed: $seed, live: $live, markers: $markers, nested: false, mask: &[] });
        }
    };
}

case!(import_repairs_a_partition_the_earlier_build_never_imported, "reader-cursors-import", "bad_state", "reader-cursors-import", "readerCursorsImport", "readerCursorsImportPostUpdate", seed_import, live: true, markers: false);
case!(import_skips_a_session_with_an_empty_cwd_like_node, "reader-cursors-import", "empty_cwd", "reader-cursors-import", "readerCursorsImport", "readerCursorsImportPostUpdate", seed_import_no_cwd, live: true, markers: false);
case!(import_preview_writes_nothing, "reader-cursors-import", "dry_run", "reader-cursors-import", "readerCursorsImport", "readerCursorsImportPostUpdate", seed_import, live: false, markers: false);
case!(import_already_done_is_skipped, "reader-cursors-import", "already_done", "reader-cursors-import", "readerCursorsImport", "readerCursorsImportPostUpdate", seed_import, live: true, markers: true);
case!(floor_repair_retires_pinning_readers_and_raises_the_floors, "reader-floor-repair", "bad_state", "reader-floor-repair", "readerFloorRepair", "readerFloorRepairPostUpdate", seed_floors, live: true, markers: false);
case!(floor_repair_preview_writes_nothing, "reader-floor-repair", "dry_run", "reader-floor-repair", "readerFloorRepair", "readerFloorRepairPostUpdate", seed_floors, live: false, markers: false);
case!(floor_repair_already_done_is_skipped, "reader-floor-repair", "already_done", "reader-floor-repair", "readerFloorRepair", "readerFloorRepairPostUpdate", seed_floors, live: true, markers: true);
case!(dual_acks_raise_the_twin_partition_through_what_was_already_read, "dual-partition-acks", "bad_state", "dual-partition-acks", "dualPartitionAcks", "dualPartitionAcksPostUpdate", seed_dual, live: true, markers: false);
case!(dual_acks_preview_writes_nothing, "dual-partition-acks", "dry_run", "dual-partition-acks", "dualPartitionAcks", "dualPartitionAcksPostUpdate", seed_dual, live: false, markers: false);
case!(dual_acks_already_done_is_skipped, "dual-partition-acks", "already_done", "dual-partition-acks", "dualPartitionAcks", "dualPartitionAcksPostUpdate", seed_dual, live: true, markers: true);

case!(hygiene_counts_what_the_old_pass_would_have_removed, "cursor-hygiene", "bad_state", "cursor-hygiene", "cursorHygiene", "cursorHygienePostUpdate", seed_hygiene, live: true, markers: false);
case!(hygiene_is_the_same_under_the_ingest_dry_run_switch, "cursor-hygiene", "dry_run", "cursor-hygiene", "cursorHygiene", "cursorHygienePostUpdate", seed_hygiene, live: false, markers: false);
case!(hygiene_already_done_is_skipped, "cursor-hygiene", "already_done", "cursor-hygiene", "cursorHygiene", "cursorHygienePostUpdate", seed_hygiene, live: true, markers: true);
case!(hygiene_with_no_cursors_directory_counts_nothing, "cursor-hygiene", "no_dir", "cursor-hygiene", "cursorHygiene", "cursorHygienePostUpdate", seed_nothing, live: true, markers: false);

case!(split_merge_on_stores_that_are_not_split_reports_zero, "merge-split-backend-stores", "bad_state", "merge-split-backend-stores", "mergeSplitBackendStores", "mergeSplitBackendStoresPostUpdate", seed_not_split, live: true, markers: false);
case!(split_merge_ignores_the_ingest_dry_run_switch_like_node, "merge-split-backend-stores", "dry_run", "merge-split-backend-stores", "mergeSplitBackendStores", "mergeSplitBackendStoresPostUpdate", seed_not_split, live: false, markers: false);
case!(split_merge_already_done_is_skipped, "merge-split-backend-stores", "already_done", "merge-split-backend-stores", "mergeSplitBackendStores", "mergeSplitBackendStoresPostUpdate", seed_not_split, live: true, markers: true);

case!(child_labels_skip_the_label_of_the_primary_checkout, "child-sender-labels", "primary_label", "child-sender-labels", "childSenderLabels", "childSenderLabelsPostUpdate", seed_labels_primary, live: true, markers: false);
case!(child_labels_preview_counts_an_unaliased_sender_label, "child-sender-labels", "sender_dry", "child-sender-labels", "childSenderLabels", "childSenderLabelsPostUpdate", seed_labels_sender, live: false, markers: false);
case!(child_labels_report_an_ambiguous_child_row_and_guess_nothing, "child-sender-labels", "ambiguous", "child-sender-labels", "childSenderLabels", "childSenderLabelsPostUpdate", seed_labels_ambiguous, live: true, markers: false);
case!(child_labels_already_done_is_skipped, "child-sender-labels", "already_done", "child-sender-labels", "childSenderLabels", "childSenderLabelsPostUpdate", seed_labels_sender, live: true, markers: true);

case!(promote_turns_a_marker_into_the_heartbeat_session, "promote-unclaimed", "bad_state", "promote-unclaimed", "promoteUnclaimed", "promoteUnclaimedPostUpdate", seed_promote, live: true, markers: false);
case!(promote_ignores_the_ingest_dry_run_switch_like_node, "promote-unclaimed", "dry_run_switch", "promote-unclaimed", "promoteUnclaimed", "promoteUnclaimedPostUpdate", seed_promote, live: false, markers: false);

/// An earlier build's store: sqlite data and no `BACKEND` marker (Node's `resolveStoreBackend` infers sqlite from the database file).
fn seed_floors_no_marker(home: &Path) {
    seed_floors(home);
    fs::remove_file(ds(home).join("store").join(STORE).join("BACKEND")).unwrap();
}

fn seed_not_split_no_marker(home: &Path) {
    seed_not_split(home);
    fs::remove_file(ds(home).join("store").join(STORE).join("BACKEND")).unwrap();
}

fn marker_of(w: &World) -> Option<String> {
    fs::read_to_string(ds(&w.home).join("store").join(STORE).join("BACKEND")).ok().map(|s| s.trim().to_string())
}

/// A store with data but no marker is settled as sqlite and pinned by a read-write open, like Node; a preview (read-only open) pins nothing.
#[test]
fn a_store_without_a_marker_is_adopted_as_sqlite_and_pinned_like_node() {
    let (_, w, o) = replay(&Case { stage: "reader-floor-repair", name: "no_marker", row: "reader-floor-repair", key: "readerFloorRepair", func: "readerFloorRepairPostUpdate", seed: seed_floors_no_marker, live: true, markers: false, nested: false, mask: &[] });
    assert_eq!(marker_of(&w).as_deref(), Some("sqlite"));
    assert_eq!(stage_node_calls(&w), Vec::<String>::new());
    let again = engine_answer(&w, &o, "readerFloorRepair");
    assert_eq!(again["skippedAlreadyDone"], json!(true), "{again}");
}

#[test]
fn a_preview_of_a_store_without_a_marker_writes_no_marker() {
    let (_, w, _) = replay(&Case { stage: "reader-floor-repair", name: "no_marker_dry", row: "reader-floor-repair", key: "readerFloorRepair", func: "readerFloorRepairPostUpdate", seed: seed_floors_no_marker, live: false, markers: false, nested: false, mask: &[] });
    assert_eq!(marker_of(&w), None);
}

#[test]
fn split_merge_pins_a_store_without_a_marker_even_in_a_preview_like_node() {
    let (_, w, _) = replay(&Case { stage: "merge-split-backend-stores", name: "no_marker", row: "merge-split-backend-stores", key: "mergeSplitBackendStores", func: "mergeSplitBackendStoresPostUpdate", seed: seed_not_split_no_marker, live: false, markers: false, nested: false, mask: &[] });
    assert_eq!(marker_of(&w).as_deref(), Some("sqlite"));
}

// ---- fallback, the switch, nothing deleted -------------------------------------------------------------------------------------

/// A journal store is the legacy backend of Node older than 22.5, which the engine does not read: a stage with nothing else to walk is
/// `disabled` (named, counted, nothing waiting for a later try), no Node runs, and the store is left byte for byte.
#[test]
fn a_journal_store_is_legacy_and_its_stage_is_disabled() {
    let o = Opt { ds: true, no_upstream_move: true, live: true, no_node: true, stage_only: Some("reader-floor-repair"), ..Opt::default() };
    let w = world(&o);
    seed_floors(&w.home);
    fs::write(ds(&w.home).join("store").join(STORE).join("BACKEND"), "journal\n").unwrap();
    let before = picture(&w, Value::Null, None);
    let ans = engine_answer(&w, &o, "readerFloorRepair");
    assert_eq!(ans["attempted"], json!(false), "{ans}");
    assert_eq!(ans["disabled"], json!(true), "{ans}");
    assert!(ans["detail"].as_str().unwrap().contains("legacy journal backend"), "{ans}");
    assert!(ans.get("held").is_none(), "{ans}");
    let calls = stage_node_calls(&w);
    assert!(calls.is_empty(), "the engine started Node: {calls:?}");
    assert_eq!(before["stores"], picture(&w, Value::Null, None)["stores"]);
    let db = fs::read(ds(&w.home).join("store").join(STORE).join("devswarm.db")).unwrap();
    assert!(!db.is_empty());
}

/// `enabled = false` in the stage table switches a stage off on the next run, with the table's text, and nothing runs for it.
#[test]
fn a_stage_switched_off_reports_itself_skipped_and_touches_nothing() {
    let o = Opt { ds: true, no_upstream_move: true, live: true, no_node: true, stage_only: Some("none"), ..Opt::default() };
    let w = world(&o);
    seed_floors(&w.home);
    seed_dual(&w.home);
    let before = picture(&w, Value::Null, None);
    let out = run_engine(&w, &o, &["--post-pull-only"]);
    let status: Value = serde_json::from_str(out.stdout.lines().next().unwrap()).unwrap();
    let status = &status["status"];
    for (key, name) in [("readerCursorsImport", "reader-cursors-import"), ("readerFloorRepair", "reader-floor-repair"), ("dualPartitionAcks", "dual-partition-acks"), ("promoteUnclaimed", "promote-unclaimed"), ("cursorHygiene", "cursor-hygiene"), ("mergeSplitBackendStores", "merge-split-backend-stores"), ("childSenderLabels", "child-sender-labels"), ("ownerKeyMigrate", "owner-key-migrate"), ("appArchivedMarkers", "app-archived-markers"), ("reRetireResurrected", "re-retire-resurrected"), ("wakeMonitor", "wake-monitor")] {
        let a = &status[key];
        assert_eq!(a["attempted"], json!(false), "{key}: {a}");
        assert_eq!(a["disabled"], json!(true), "{key}: {a}");
        assert_eq!(a["detail"], json!(format!("{name}: disabled (enabled = false in update_post.stages) - skipped")), "{key}");
    }
    assert_eq!(stage_node_calls(&w), Vec::<String>::new());
    let after = picture(&w, Value::Null, None);
    assert_eq!(before["stores"], after["stores"], "a switched-off stage changed a store");
}

/// Reading `enabled` on every run: the same world, the stage switched back on, does its work.
#[test]
fn a_stage_switched_back_on_runs_on_the_next_run() {
    let mut o = Opt { ds: true, no_upstream_move: true, live: true, no_node: true, stage_only: Some("none"), ..Opt::default() };
    let w = world(&o);
    seed_floors(&w.home);
    let off = engine_answer(&w, &o, "readerFloorRepair");
    assert_eq!(off["disabled"], json!(true), "{off}");
    let toml = w.mp.join("plugins/anti-hall/engine/defaults/update_post.toml");
    let text = fs::read_to_string(&toml).unwrap();
    let on = text.replacen("{ name = \"reader-floor-repair\", enabled = false,", "{ name = \"reader-floor-repair\", enabled = true,", 1);
    assert_ne!(text, on);
    fs::write(&toml, on).unwrap();
    o.stage_only = Some("none");
    let ans = engine_answer(&w, &o, "readerFloorRepair");
    assert_eq!(ans["attempted"], json!(true), "{ans}");
    assert_eq!(ans["repaired"], json!(2), "{ans}");
}

/// The repairs move or mark: every message, every registry row and every legacy cursor file is still there afterwards.
#[test]
fn the_store_stages_delete_nothing() {
    for (seed, row, key) in [(seed_import as fn(&Path), "reader-cursors-import", "readerCursorsImport"), (seed_floors, "reader-floor-repair", "readerFloorRepair"), (seed_dual, "dual-partition-acks", "dualPartitionAcks")] {
        let o = Opt { ds: true, no_upstream_move: true, live: true, no_node: true, stage_only: Some(row), ..Opt::default() };
        let w = world(&o);
        seed(&w.home);
        let before = picture(&w, Value::Null, None);
        engine_answer(&w, &o, key);
        let after = picture(&w, Value::Null, None);
        for store in before["stores"].as_object().unwrap().keys() {
            for table in ["messages", "registry"] {
                assert_eq!(before["stores"][store][table], after["stores"][store][table], "{row}: {store}.{table} changed");
            }
            let was = before["stores"][store]["reader_cursors"].as_array().unwrap();
            let now = after["stores"][store]["reader_cursors"].as_array().unwrap();
            for r in was {
                let same = now.iter().find(|n| n["partition"] == r["partition"] && n["ns"] == r["ns"] && n["reader"] == r["reader"]);
                let same = same.unwrap_or_else(|| panic!("{row}: reader row {r} vanished"));
                assert!(same["value"].as_i64() >= r["value"].as_i64(), "{row}: a cursor was lowered: {r} -> {same}");
            }
        }
        for f in before["files"].as_object().unwrap().keys() {
            assert!(after["files"].get(f).is_some(), "{row}: file {f} vanished");
        }
    }
}

/// A store with one session the engine cannot classify (relative cwd) is left byte-identical: the engine writes nothing for it,
/// even for the partition that alone would import cleanly, and the Node function answers from the untouched state.
#[test]
fn a_store_needing_the_node_fallback_is_left_untouched_by_the_engine() {
    let o = Opt { ds: true, no_upstream_move: true, live: true, no_node: true, stage_only: Some("reader-cursors-import"), ..Opt::default() };
    let w = world(&o);
    seed_import_deferred(&w.home);
    let before = picture(&w, Value::Null, None);
    let ans = engine_answer(&w, &o, "readerCursorsImport");
    assert_eq!(ans["attempted"], json!(false), "{ans}");
    let calls = stage_node_calls(&w);
    assert!(calls.is_empty(), "the engine started Node: {calls:?}");
    assert_eq!(ans["held"], json!(true), "{ans}");
    let after = picture(&w, Value::Null, None);
    assert_eq!(before["stores"], after["stores"], "the engine wrote rows for a store it handed to Node");
    assert!(before["stores"][STORE]["reader_cursors"].as_array().unwrap().is_empty(), "seed must start without reader rows");
}

/// The same for the two repairs that write per partition: the engine plans the whole store first and, when Node must decide any
/// part of it, writes nothing (not even the partition that alone would be repaired).
#[test]
fn the_repairs_leave_a_store_needing_the_node_fallback_untouched() {
    type Seed = fn(&Path);
    let cases: [(Seed, &str, &str, &str); 3] = [
        (seed_floors_deferred, "reader-floor-repair", "readerFloorRepair", "readerFloorRepairPostUpdate"),
        (seed_dual_deferred, "dual-partition-acks", "dualPartitionAcks", "dualPartitionAcksPostUpdate"),
        (seed_dual_import_deferred, "dual-partition-acks", "dualPartitionAcks", "dualPartitionAcksPostUpdate"),
    ];
    for (seed, row, key, _func) in cases {
        let o = Opt { ds: true, no_upstream_move: true, live: true, no_node: true, stage_only: Some(row), ..Opt::default() };
        let w = world(&o);
        seed(&w.home);
        let before = picture(&w, Value::Null, None);
        let ans = engine_answer(&w, &o, key);
        assert_eq!(ans["attempted"], json!(false), "{row}: {ans}");
        let calls = stage_node_calls(&w);
        assert!(calls.is_empty(), "{row}: the engine started Node: {calls:?}");
        assert_eq!(ans["held"], json!(true), "{row}: {ans}");
        let after = picture(&w, Value::Null, None);
        assert_eq!(before["stores"], after["stores"], "{row}: the engine wrote to a store it handed to Node");
    }
}

/// The hygiene pass is report-only (as in Node since the mesh redesign): every cursor file is still there, byte for byte.
#[test]
fn hygiene_removes_and_rewrites_nothing() {
    let o = Opt { ds: true, no_upstream_move: true, live: true, no_node: true, stage_only: Some("cursor-hygiene"), ..Opt::default() };
    let w = world(&o);
    seed_hygiene(&w.home);
    let before = picture(&w, Value::Null, None);
    let ans = engine_answer(&w, &o, "cursorHygiene");
    assert_eq!(ans["evicted"], json!(2), "{ans}");
    assert_eq!(ans["deleted"], json!(2), "{ans}");
    let after = picture(&w, Value::Null, None);
    for (f, body) in before["files"].as_object().unwrap() {
        if f.contains("update-sweep-state") || f.contains("cursor-log") {
            continue;
        }
        assert_eq!(after["files"].get(f), Some(body), "cursor-hygiene: file {f} changed or vanished");
    }
}

/// A split store (a sqlite side and a journal side): the engine folds the journal side into sqlite, never writes to or deletes the
/// journal side, leaves a marker, and a second run merges nothing.
#[test]
fn a_split_store_is_merged_into_sqlite_and_both_sides_stay() {
    let o = Opt { ds: true, no_upstream_move: true, live: true, no_node: true, stage_only: Some("merge-split-backend-stores"), ..Opt::default() };
    let w = world(&o);
    seed_split(&w.home);
    let journal = ds(&w.home).join("store").join(STORE).join("journal").join("messages.ndjson");
    let before = fs::read(&journal).unwrap();
    let ans = engine_answer(&w, &o, "mergeSplitBackendStores");
    assert_eq!(ans["attempted"], json!(true), "{ans}");
    assert_eq!((ans["splitStores"].clone(), ans["messagesMerged"].clone(), ans["errors"].clone()), (json!(1), json!(1), json!(0)), "{ans}");
    assert!(calls_none(&w));
    assert_eq!(fs::read(&journal).unwrap(), before, "the journal side was written");
    assert!(ds(&w.home).join("store").join(STORE).join("MERGE-STATE.json").is_file());
}

fn calls_none(w: &World) -> bool {
    let calls = stage_node_calls(w);
    assert!(calls.is_empty(), "the engine started Node: {calls:?}");
    true
}

/// Aliasing a child's label, forwarding its unread mail and retiring the phantom row are Node's: the engine sees there is work, writes
/// nothing, and the stage's Node function answers from the untouched state (also for the preview of a registry label row).
#[test]
fn child_label_repairs_are_left_to_the_node_function_untouched() {
    type Seed = fn(&Path);
    let cases: [(Seed, bool); 3] = [(seed_labels_sender, true), (seed_labels_row, true), (seed_labels_row, false)];
    for (seed, live) in cases {
        let o = Opt { ds: true, no_upstream_move: true, live, no_node: true, stage_only: Some("child-sender-labels"), ..Opt::default() };
        let w = world(&o);
        seed(&w.home);
        let before = picture(&w, Value::Null, None);
        let ans = engine_answer(&w, &o, "childSenderLabels");
        assert_eq!(ans["attempted"], json!(false), "{ans}");
        let calls = stage_node_calls(&w);
        assert!(calls.is_empty(), "the engine started Node: {calls:?}");
        assert_eq!(ans["held"], json!(true), "{ans}");
        let after = picture(&w, Value::Null, None);
        assert_eq!(before, after, "the engine changed a store it handed to Node");
    }
}

// ---- ingest heal: the engine owns the ingest daemons (roadmap #61, G2 part D) ------------------------------------------------

const STALE_PLIST: &str = "<?xml version=\"1.0\"?><plist><dict><key>WorkingDirectory</key><string>/nonexistent/gone</string><key>ProgramArguments</key><array><string>/usr/bin/node</string><string>/nonexistent/gone/devswarm-ingest.js</string></array></dict></plist>";
const STALE_SERVICE: &str = "[Service]\nWorkingDirectory=/nonexistent/gone\nExecStart=\"/usr/bin/node\" \"/nonexistent/gone/devswarm-ingest.js\"\n";
const UNIT_FILES: [&str; 2] = ["Library/LaunchAgents/com.anti-hall.devswarm-ingest.plist", ".config/systemd/user/anti-hall-devswarm-ingest.service"];

/// A stale Node ingest unit (its baked directory is gone) on both platforms.
fn seed_stale_unit(home: &Path) {
    put(home, UNIT_FILES[0], STALE_PLIST);
    put(home, UNIT_FILES[1], STALE_SERVICE);
}

fn unit_bytes(home: &Path) -> Vec<Vec<u8>> {
    UNIT_FILES.iter().map(|f| fs::read(home.join(f)).unwrap()).collect()
}

fn ingest_opt(ds: bool) -> Opt {
    Opt { ds, no_upstream_move: true, live: true, no_node: true, stage_only: Some("none"), ..Opt::default() }
}

fn ingest_fixture(name: &str) -> PathBuf {
    fixture_path("ingest-heal", name)
}

/// Record (when asked) Node's `ingestHeal` answer of a post-pull-only run on the seeded world, then replay the engine against it.
fn ingest_case(name: &str, ds: bool, seed: fn(&Path)) -> (World, Opt) {
    if recording() {
        let o = Opt { no_node: false, stage_only: None, ..ingest_opt(ds) };
        let a = world(&o);
        seed(&a.home);
        let out = super::update_parity::run_node(&a, &o, &["--post-pull-only"]);
        let st: Value = serde_json::from_str(out.stdout.lines().next().unwrap()).unwrap();
        let p = ingest_fixture(name);
        fs::create_dir_all(p.parent().unwrap()).unwrap();
        fs::write(p, format!("{}\n", serde_json::to_string_pretty(&st["status"]["ingestHeal"]).unwrap())).unwrap();
    }
    let want: Value = serde_json::from_str(&fs::read_to_string(ingest_fixture(name)).unwrap_or_else(|e| panic!("ingest-heal/{name}: no fixture ({e})"))).unwrap();
    let o = ingest_opt(ds);
    let w = world(&o);
    seed(&w.home);
    let got = engine_answer(&w, &o, "ingestHeal");
    assert_eq!(got, want, "ingest-heal/{name}: differs from the frozen Node answer");
    assert_eq!(node_calls(&w), "", "ingest-heal/{name}: the engine ran Node");
    (w, o)
}

fn seed_none(_: &Path) {}

#[test]
fn ingest_outside_a_devswarm_session_is_the_node_answer() {
    ingest_case("no_session", false, seed_stale_unit);
}

#[test]
fn ingest_with_no_unit_is_the_node_answer_without_running_node() {
    ingest_case("no_unit", true, seed_none);
}

#[test]
fn ingest_with_a_stale_unit_outside_a_worktree_is_the_node_answer() {
    let (w, o) = ingest_case("stale_unit_no_worktree", true, seed_stale_unit);
    let before = unit_bytes(&w.home);
    assert_eq!(engine_answer(&w, &o, "ingestHeal")["attempted"], json!(false)); // a second run: the same, nothing touched
    assert_eq!(before, unit_bytes(&w.home));
}

/// Node would re-install the stale unit here (the one place the engine deliberately differs): `devswarm_ingest.mode` is `engine` by
/// default, so the engine drains and `units heal` retires the Node unit; re-baking it would resurrect it. No Node, no unit touched.
#[test]
fn ingest_with_a_stale_unit_in_a_worktree_is_not_reinstalled_while_the_engine_owns_ingest() {
    let o = ingest_opt(true);
    let w = world(&o);
    seed_stale_unit(&w.home);
    assert!(Command::new("git").args(["init", "-q"]).current_dir(&w.home).status().unwrap().success());
    let before = unit_bytes(&w.home);
    for _ in 0..2 {
        let ans = engine_answer(&w, &o, "ingestHeal");
        assert_eq!(ans["attempted"], json!(false), "{ans}");
        assert_eq!(ans["healed"], json!(false), "{ans}");
        assert_eq!(node_calls(&w), "", "the engine ran Node");
    }
    assert_eq!(before, unit_bytes(&w.home), "a unit file was changed");
}

/// Witness mode (the Node daemons drain) and `ingest_native = 0` both switch the ingest heal off: it is `disabled`, nothing is healed and no Node is asked.
#[test]
fn ingest_heal_is_disabled_in_witness_mode_and_when_switched_off() {
    let o = ingest_opt(true);
    let w = world(&o);
    put(&w.home, ".anti-hall/settings.json", r#"{"devswarm_ingest":{"mode":"witness"}}"#);
    let ans = engine_answer(&w, &o, "ingestHeal");
    assert_eq!(ans["disabled"], json!(true), "{ans}");
    assert_eq!(node_calls(&w), "", "witness mode asked Node");
    let w = world(&o);
    let toml = w.mp.join("plugins/anti-hall/engine/defaults/update_post.toml");
    let text = fs::read_to_string(&toml).unwrap();
    let at = text.find("[update_post.ingest_native]").expect("the switch is in the table");
    let (head, tail) = text.split_at(at);
    let off = format!("{head}{}", tail.replacen("value = 1", "value = 0", 1));
    assert_ne!(text, off);
    fs::write(&toml, off).unwrap();
    let ans = engine_answer(&w, &o, "ingestHeal");
    assert_eq!(ans["disabled"], json!(true), "{ans}");
    assert_eq!(node_calls(&w), "", "the switched-off stage asked Node");
}


// ---- the git classifier of the post-update stages (roadmap #61 G3) ---------------------------------------------------------------

fn git_in(dir: &Path, args: &[&str]) {
    let ok = Command::new("git")
        .args(["-c", "user.name=t", "-c", "user.email=t@t", "-c", "protocol.file.allow=always"])
        .args(args)
        .current_dir(dir)
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .status()
        .unwrap()
        .success();
    assert!(ok, "git {args:?} in {}", dir.display());
}

fn scratch_dir(tag: &str) -> PathBuf {
    let p = fs::canonicalize(std::env::temp_dir()).unwrap().join(format!("ah-g3-{tag}-{}-{}", std::process::id(), N.fetch_add(1, Ordering::Relaxed)));
    fs::create_dir_all(&p).unwrap();
    p
}

static INNER: std::sync::OnceLock<PathBuf> = std::sync::OnceLock::new();

/// A repository nested, untracked, inside `repo()`: its `.git` is a directory below another checkout, which only git can classify.
fn inner() -> &'static Path {
    INNER.get_or_init(|| {
        let p = repo().join("inner");
        fs::create_dir_all(&p).unwrap();
        git_in(&p, &["init", "-q"]);
        fs::canonicalize(p).unwrap()
    })
}

fn nested_anchor() -> String {
    ah_engine::meshw::ident::canonical_mesh_id(&inner().to_string_lossy()).unwrap().unwrap()
}

/// `seed_dual` on a worktree nested in another checkout.
fn seed_dual_nested(home: &Path) {
    let st = open_store(home, STORE);
    let (a, wt) = (nested_anchor(), inner().to_string_lossy().into_owned());
    registry(&st, &a, Some(&wt), None);
    registry(&st, "kid-1", Some(&wt), None);
    for (i, h) in ["x1", "x2", "x3"].iter().enumerate() {
        msg(&st, &a, i as i64, h, None);
    }
    for (i, (h, o)) in [("y1", Some("x1")), ("y2", Some("x2")), ("y3", Some("x3")), ("y4", None)].iter().enumerate() {
        msg(&st, "kid-1", 10 + i as i64, h, *o);
    }
    for ns in ["store", "nd"] {
        cur(&st, &a, ns, "#floor", if ns == "store" { 2 } else { 0 });
        cur(&st, "kid-1", ns, "#floor", 0);
    }
}

fn nested_case() -> Case {
    Case { stage: "dual-partition-acks", name: "nested_repo", row: "dual-partition-acks", key: "dualPartitionAcks", func: "dualPartitionAcksPostUpdate", seed: seed_dual_nested, live: true, markers: false, nested: true, mask: &[] }
}

/// A worktree nested in another checkout is classified by git as Node does: the stage answers natively, equal to the frozen Node run
/// (the answer, the store, the files), runs Node for nothing, and a second run is a no-op.
#[test]
fn dual_acks_classify_a_nested_repository_with_git_like_node() {
    run_case(&nested_case());
}

/// The classifier itself, on real repositories (one implementation for hooks and the post-update stages): it answers as `identity.js` does for an untracked nested repo, a gitlink in the parent's index, and a linked worktree of a submodule.
#[test]
fn the_git_classifier_mirrors_identity_js() {
    use ah_engine::meshw::ident::resolve_context;
    let s = |p: &Path| p.to_string_lossy().into_owned();
    // 1. untracked nested repository
    let nested = inner();
    let on = resolve_context(&s(nested), false).unwrap();
    assert_eq!((on.kind.as_str(), on.worktree_root.as_deref()), ("main", Some(s(nested).as_str())), "git says no superproject: the nested repo is its own root");
    // 2. a nested repo registered as a gitlink in the parent's index: git names the parent as its superproject
    let top = scratch_dir("gitlink");
    git_in(&top, &["init", "-q"]);
    let sub = top.join("sub");
    fs::create_dir_all(&sub).unwrap();
    git_in(&sub, &["init", "-q"]);
    git_in(&sub, &["commit", "-q", "--allow-empty", "-m", "c"]);
    let sha = String::from_utf8(Command::new("git").args(["rev-parse", "HEAD"]).current_dir(&sub).output().unwrap().stdout).unwrap();
    git_in(&top, &["update-index", "--add", "--cacheinfo", &format!("160000,{},sub", sha.trim())]);
    let on = resolve_context(&s(&sub), false).unwrap();
    assert_eq!((on.kind.as_str(), on.worktree_root.as_deref(), on.toplevel.as_deref()), ("submodule-in-main", Some(s(&top).as_str()), Some(s(&sub).as_str())));
    // 3. a linked worktree of an absorbed submodule, checked out beside the superproject: the core.worktree hop
    let base = scratch_dir("subwt");
    let (lib, sup) = (base.join("lib"), base.join("sup"));
    for d in [&lib, &sup] {
        fs::create_dir_all(d).unwrap();
        git_in(d, &["init", "-q"]);
        git_in(d, &["commit", "-q", "--allow-empty", "-m", "c"]);
    }
    git_in(&sup, &["submodule", "add", "-q", &s(&lib), "libsub"]);
    git_in(&sup, &["commit", "-q", "-m", "add"]);
    let wt = base.join("libsub-wt");
    git_in(&sup.join("libsub"), &["worktree", "add", "-q", "--detach", &s(&wt)]);
    let wt = fs::canonicalize(wt).unwrap();
    let on = resolve_context(&s(&wt), false).unwrap();
    assert_eq!((on.kind.as_str(), on.worktree_root.as_deref()), ("submodule-in-main", Some(s(&fs::canonicalize(&sup).unwrap()).as_str())));
}


// ---- owner-key-migrate (roadmap #61 G3) ------------------------------------------------------------------------------------------

/// Descriptors an earlier build wrote without an `ownerKey`: an active one in a real worktree (the key resolves from git), an active
/// one whose worktree is gone, an archived one, one with a key already, a legacy one with no session id; plus a non-descriptor file.
fn seed_owner_keys(home: &Path) {
    let wt = repo().to_string_lossy().into_owned();
    put(home, ".anti-hall/devswarm/workspaces/ok-1.json", &format!(r#"{{"id":"ok-1","worktreePath":"{wt}","sessionId":"s1"}}"#));
    put(home, ".anti-hall/devswarm/workspaces/ok-2.json", r#"{"id":"ok-2","worktreePath":"/nonexistent/ok-2","sessionId":"s2","repoKey":"kept-abc123"}"#);
    put(home, ".anti-hall/devswarm/workspaces/ok-3.json", r#"{"id":"ok-3","worktreePath":"/nonexistent/ok-3"}"#);
    put(home, ".anti-hall/devswarm/workspaces/ok-4.json", r#"{"id":"ok-4","worktreePath":"/nonexistent/ok-4","ownerKey":"already-111111"}"#);
    put(home, ".anti-hall/devswarm/archived/ok-5.json", &format!(r#"{{"id":"ok-5","worktreePath":"{wt}","sessionId":"s5"}}"#));
    put(home, ".anti-hall/devswarm/workspaces/notes.json", r#"{"hello":"world"}"#);
}

/// An active descriptor stranded in its legacy hash bucket while its worktree now resolves a real repo key: the re-home (registry row
/// and backlog moved between stores) is Node's.
fn seed_owner_keys_rehome(home: &Path) {
    let wt = repo().to_string_lossy().into_owned();
    let hash = ah_engine::meshw::send::hash_from_workspace_id("rh-1");
    put(home, ".anti-hall/devswarm/workspaces/rh-1.json", &format!(r#"{{"id":"rh-1","worktreePath":"{wt}","sessionId":"s1","ownerKey":"{hash}"}}"#));
    put(home, ".anti-hall/devswarm/workspaces/ok-1.json", &format!(r#"{{"id":"ok-1","worktreePath":"{wt}","sessionId":"s1"}}"#));
}

case!(owner_keys_are_backfilled_on_active_and_archived_descriptors, "owner-key-migrate", "bad_state", "owner-key-migrate", "ownerKeyMigrate", "ownerKeyMigratePostUpdate", seed_owner_keys, live: true, markers: false);
case!(owner_keys_ignore_the_ingest_dry_run_switch_like_node, "owner-key-migrate", "dry_run_switch", "owner-key-migrate", "ownerKeyMigrate", "ownerKeyMigratePostUpdate", seed_owner_keys, live: false, markers: false);
case!(owner_keys_already_done_is_skipped, "owner-key-migrate", "already_done", "owner-key-migrate", "ownerKeyMigrate", "ownerKeyMigratePostUpdate", seed_owner_keys, live: true, markers: true);

/// The re-home stays with Node: the engine writes nothing (not even the descriptor it could have backfilled) and Node's function runs.
#[test]
fn owner_keys_needing_a_rehome_are_left_to_the_node_function_untouched() {
    let o = Opt { ds: true, no_upstream_move: true, live: true, no_node: true, stage_only: Some("owner-key-migrate"), ..Opt::default() };
    let w = world(&o);
    seed_owner_keys_rehome(&w.home);
    let before = picture(&w, Value::Null, None);
    let ans = engine_answer(&w, &o, "ownerKeyMigrate");
    assert_eq!(ans["attempted"], json!(false), "{ans}");
    let calls = stage_node_calls(&w);
    assert!(calls.is_empty(), "the engine started Node: {calls:?}");
    assert_eq!(ans["held"], json!(true), "{ans}");
    assert_eq!(before["files"], picture(&w, Value::Null, None)["files"], "the engine wrote for a stage it handed to Node");
}

/// Nothing is deleted: every descriptor file is still there and every key it had is kept (only `ownerKey` / `repoKey` are added).
#[test]
fn owner_key_migrate_deletes_nothing_and_keeps_every_field() {
    let o = Opt { ds: true, no_upstream_move: true, live: true, no_node: true, stage_only: Some("owner-key-migrate"), ..Opt::default() };
    let w = world(&o);
    seed_owner_keys(&w.home);
    let before = picture(&w, Value::Null, None);
    engine_answer(&w, &o, "ownerKeyMigrate");
    let after = picture(&w, Value::Null, None);
    for (f, text) in before["files"].as_object().unwrap() {
        let now = after["files"].get(f).unwrap_or_else(|| panic!("file {f} vanished"));
        if f.contains("/workspaces/") || f.contains("/archived/") {
            let body = |v: &Value| v.as_str().unwrap().split_once(' ').map(|(_, b)| b.to_string()).unwrap_or_default();
            if body(text).is_empty() {
                continue; // a directory
            }
            let (was, is): (Value, Value) = (serde_json::from_str(&body(text)).unwrap(), serde_json::from_str(&body(now)).unwrap());
            for (k, v) in was.as_object().unwrap() {
                assert_eq!(is.get(k), Some(v), "{f}: field {k} changed");
            }
        }
    }
}


// ---- app-archived-markers (roadmap #61 G3) ---------------------------------------------------------------------------------------

const B_ARCHIVED: &str = "11111111-1111-4111-8111-111111111111";
const B_DELETED: &str = "22222222-2222-4222-8222-222222222222";
const B_OPEN: &str = "33333333-3333-4333-8333-333333333333";
const B_MARKED: &str = "44444444-4444-4444-8444-444444444444";

/// The DevSwarm app's database on this platform, with the tables the app sync reads and one repository, the Primary, one archived
/// builder, one open builder and one archived builder that a twin descriptor shares a worktree with.
fn seed_app_db(home: &Path) {
    let file = ah_engine::meshw::ident::app_db_path(home, &std::collections::HashMap::new()).expect("app db path");
    fs::create_dir_all(Path::new(&file).parent().unwrap()).unwrap();
    let c = rusqlite::Connection::open(&file).unwrap();
    c.execute_batch(
        "CREATE TABLE repositories (id TEXT PRIMARY KEY, path TEXT, name TEXT, defaultBaseBranch TEXT);
         CREATE TABLE builders (id TEXT PRIMARY KEY, repositoryId TEXT, sourceBranch TEXT, branchName TEXT, worktreePath TEXT, terminalId TEXT, label TEXT, createdAt TEXT, lastAccessed TEXT, rank INTEGER, isHidden INTEGER, pullRequestId TEXT, builderType TEXT, isPinned INTEGER, isActive INTEGER, lastSelectedAt TEXT);
         CREATE TABLE builder_terminals (id TEXT, builderId TEXT, terminalId TEXT, terminalType TEXT, aiAgent TEXT, ai_session_config TEXT, isActive INTEGER, panelStatus TEXT, createdAt TEXT, lastViewedAt TEXT, initialPrompt TEXT, initialPromptDeliveredAt TEXT, initialPromptWithheldAt TEXT);
         CREATE TABLE pull_requests (id TEXT PRIMARY KEY, repositoryId TEXT, branchName TEXT, number INTEGER, state TEXT, isDraft INTEGER, url TEXT, checkStatus TEXT, reviewStatus TEXT, lastSyncedAt TEXT);
         CREATE TABLE workspace_messages (repositoryId TEXT, toBranch TEXT, createdAt TEXT, message TEXT);
         INSERT INTO repositories VALUES ('r1', '/code/r1', 'r1', 'main');",
    )
    .unwrap();
    let ins = |id: &str, wt: &str, hidden: i64, active: i64, kind: &str| {
        c.execute(
            "INSERT INTO builders (id, repositoryId, sourceBranch, branchName, worktreePath, label, createdAt, rank, isHidden, builderType, isPinned, isActive) VALUES (?1, 'r1', 'main', 'b', ?2, 'L', '2026-01-01T00:00:00.000Z', 1, ?3, ?4, 0, ?5)",
            rusqlite::params![id, wt, hidden, kind, active],
        )
        .unwrap();
    };
    ins("55555555-5555-4555-8555-555555555555", "/code/r1", 0, 1, "primary");
    ins(B_ARCHIVED, "/code/wts/archived", 1, 0, "standard");
    ins(B_OPEN, "/code/wts/open", 0, 1, "standard");
    ins("66666666-6666-4666-8666-666666666666", "/code/wts/twin", 1, 0, "standard");
}

/// Descriptors an earlier build never marked: archived in the app by id, deleted in the app (no row), open in the app, archived through
/// a twin builder on its worktree, one already marked, one with no worktree, one that is not a descriptor.
fn seed_app_archived(home: &Path) {
    seed_app_db(home);
    let d = |id: &str, wt: &str| put(home, &format!(".anti-hall/devswarm/workspaces/{id}.json"), &format!(r#"{{"id":"{id}","worktreePath":"{wt}","sessionId":"s-{id}"}}"#));
    d(B_ARCHIVED, "/code/wts/archived");
    d(B_DELETED, "/code/wts/deleted");
    d(B_OPEN, "/code/wts/open");
    d("twin-ws", "/code/wts/twin");
    d(B_MARKED, "/code/wts/gone-already-marked");
    put(home, ".anti-hall/devswarm/workspaces/nowt.json", r#"{"id":"nowt"}"#);
    put(home, ".anti-hall/devswarm/workspaces/junk.json", "[1,2");
    put(home, &format!(".anti-hall/devswarm/archived/{B_MARKED}.json"), r#"{"id":"mine","archivedBy":"owner","archivedAt":1}"#);
}

case!(app_markers_are_written_for_what_the_app_proves_archived_or_deleted, "app-archived-markers", "bad_state", "app-archived-markers", "appArchivedMarkers", "markAppArchivedPostUpdate", seed_app_archived, live: true, markers: false);
case!(app_markers_preview_writes_nothing, "app-archived-markers", "dry_run", "app-archived-markers", "appArchivedMarkers", "markAppArchivedPostUpdate", seed_app_archived, live: false, markers: false);
case!(app_markers_already_done_is_skipped, "app-archived-markers", "already_done", "app-archived-markers", "appArchivedMarkers", "markAppArchivedPostUpdate", seed_app_archived, live: true, markers: true);
case!(app_markers_without_an_app_database_do_nothing, "app-archived-markers", "no_db", "app-archived-markers", "appArchivedMarkers", "markAppArchivedPostUpdate", seed_nothing, live: true, markers: false);

/// A marker is created, never replaced; no descriptor is touched or removed.
#[test]
fn app_markers_never_overwrite_a_marker_and_never_touch_a_descriptor() {
    let o = Opt { ds: true, no_upstream_move: true, live: true, no_node: true, stage_only: Some("app-archived-markers"), ..Opt::default() };
    let w = world(&o);
    seed_app_archived(&w.home);
    let before = picture(&w, Value::Null, None);
    let ans = engine_answer(&w, &o, "appArchivedMarkers");
    assert_eq!(ans["marked"], json!(3), "{ans}");
    let after = picture(&w, Value::Null, None);
    for (f, v) in before["files"].as_object().unwrap() {
        if f.contains("/workspaces/") || f.ends_with(&format!("archived/{B_MARKED}.json")) {
            assert_eq!(after["files"].get(f), Some(v), "{f} changed");
        }
    }
}


// ---- re-retire-resurrected (roadmap #61 G3) --------------------------------------------------------------------------------------

fn archive_marker(home: &Path, id: &str, wt: &str) {
    put(home, &format!(".anti-hall/devswarm/archived/{id}.json"), &format!(r#"{{"id":"{id}","worktreePath":"{wt}","archivedBy":"owner","archivedAt":1}}"#));
}

/// A registry row an old migration resurrected: its worktree is archived under another id and its session is a placeholder (a
/// candidate); a twin on the same worktree with a real session (live, left alone); a row whose only marker is its own (no forward target);
/// a row with no archive link at all.
fn seed_resurrected(home: &Path) {
    let st = open_store(home, STORE);
    registry(&st, "rz-1", Some("/nonexistent/wt1"), Some("unclaimed:rz-1"));
    registry(&st, "rz-2", Some("/nonexistent/wt1"), Some("real-session-2"));
    registry(&st, "solo", Some("/nonexistent/wt2"), Some("unclaimed:solo"));
    registry(&st, "free", Some("/nonexistent/wt3"), Some("unclaimed:free"));
    drop(st);
    archive_marker(home, "arch-1", "/nonexistent/wt1");
    archive_marker(home, "solo", "/nonexistent/wt2");
}

/// Nothing resurrected: only the live twin and the unlinked row.
fn seed_not_resurrected(home: &Path) {
    let st = open_store(home, STORE);
    registry(&st, "rz-2", Some("/nonexistent/wt1"), Some("real-session-2"));
    registry(&st, "free", Some("/nonexistent/wt3"), Some("unclaimed:free"));
    drop(st);
    archive_marker(home, "arch-1", "/nonexistent/wt1");
}

/// Only a row with no forward target.
fn seed_unhealable_only(home: &Path) {
    let st = open_store(home, STORE);
    registry(&st, "solo", Some("/nonexistent/wt2"), Some("unclaimed:solo"));
    drop(st);
    archive_marker(home, "solo", "/nonexistent/wt2");
}

case!(resurrected_rows_are_reported_not_removed, "re-retire-resurrected", "bad_state", "re-retire-resurrected", "reRetireResurrected", "reRetireResurrectedPostUpdate", seed_resurrected, live: true, markers: false);
case!(resurrected_report_with_nothing_found, "re-retire-resurrected", "nothing", "re-retire-resurrected", "reRetireResurrected", "reRetireResurrectedPostUpdate", seed_not_resurrected, live: true, markers: false);
case!(resurrected_report_names_a_row_with_no_forward_target, "re-retire-resurrected", "unhealable_only", "re-retire-resurrected", "reRetireResurrected", "reRetireResurrectedPostUpdate", seed_unhealable_only, live: true, markers: false);
case!(resurrected_report_ignores_the_ingest_dry_run_switch_like_node, "re-retire-resurrected", "dry_run_switch", "re-retire-resurrected", "reRetireResurrected", "reRetireResurrectedPostUpdate", seed_resurrected, live: false, markers: false);
case!(resurrected_already_done_is_skipped, "re-retire-resurrected", "already_done", "re-retire-resurrected", "reRetireResurrected", "reRetireResurrectedPostUpdate", seed_resurrected, live: true, markers: true);

/// The update only reports: every registry row, every message and every marker is still there after the stage.
#[test]
fn the_resurrected_report_removes_nothing() {
    let o = Opt { ds: true, no_upstream_move: true, live: true, no_node: true, stage_only: Some("re-retire-resurrected"), ..Opt::default() };
    let w = world(&o);
    seed_resurrected(&w.home);
    let before = picture(&w, Value::Null, None);
    let ans = engine_answer(&w, &o, "reRetireResurrected");
    assert_eq!(ans["candidates"], json!(1), "{ans}");
    assert_eq!(stage_node_calls(&w), Vec::<String>::new());
    let after = picture(&w, Value::Null, None);
    assert_eq!(before["stores"], after["stores"], "the report changed a store");
    for f in before["files"].as_object().unwrap().keys() {
        assert!(after["files"].get(f).is_some(), "file {f} vanished");
    }
}


// ---- wake-monitor (roadmap #61 G3) -----------------------------------------------------------------------------------------------
//
// The watcher is the engine itself, so the stage no longer looks for a script file (Node did): it reports shipped and checks the lock.

/// A registered workspace whose worktree is the working directory (the stage resolves its identity from it).
fn wake_workspace(home: &Path) {
    put(home, ".anti-hall/devswarm/workspaces/ws-wake.json", &format!(r#"{{"id":"ws-wake","worktreePath":"{}","sessionId":"s-wake"}}"#, home.display()));
}

fn wake_lock(home: &Path, pid: i64) {
    put(home, ".anti-hall/devswarm/locks/wake-watch-ws-wake.lock", &format!(r#"{{"pid":{pid},"ts":{FAR_FUTURE}}}"#));
}

fn seed_wake_unresolved(_: &Path) {}

fn seed_wake_idle(home: &Path) {
    wake_workspace(home);
}

/// Pid 1 always exists (and answers EPERM to a probe from another user, which Node also reads as alive).
fn seed_wake_live(home: &Path) {
    wake_workspace(home);
    wake_lock(home, 1);
}

fn seed_wake_dead(home: &Path) {
    wake_workspace(home);
    wake_lock(home, 2_147_483_000);
}

case!(wake_monitor_without_an_identity_reports_shipped_and_asks_for_a_manual_arm, "wake-monitor", "unresolved", "wake-monitor", "wakeMonitor", "wakeMonitorPostUpdate", seed_wake_unresolved, live: true, markers: false);
case!(wake_monitor_not_live_names_the_arm_command, "wake-monitor", "not_live", "wake-monitor", "wakeMonitor", "wakeMonitorPostUpdate", seed_wake_idle, live: true, markers: false);
case!(wake_monitor_sees_a_live_watcher_lock, "wake-monitor", "live", "wake-monitor", "wakeMonitor", "wakeMonitorPostUpdate", seed_wake_live, live: true, markers: false);
case!(wake_monitor_ignores_a_lock_of_a_dead_process, "wake-monitor", "dead_lock", "wake-monitor", "wakeMonitor", "wakeMonitorPostUpdate", seed_wake_dead, live: true, markers: false);
case!(wake_monitor_runs_the_same_under_the_ingest_dry_run_switch, "wake-monitor", "dry_run_switch", "wake-monitor", "wakeMonitor", "wakeMonitorPostUpdate", seed_wake_live, live: false, markers: false);

/// The stage arms nothing and removes nothing: no lock is written, no workspace or lock file goes, no Node runs.
#[test]
fn wake_monitor_arms_nothing_deletes_nothing_and_runs_no_node() {
    let o = Opt { ds: true, no_upstream_move: true, live: true, no_node: true, stage_only: Some("wake-monitor"), ..Opt::default() };
    let w = world(&o);
    seed_wake_live(&w.home);
    let lock = w.home.join(".anti-hall/devswarm/locks/wake-watch-ws-wake.lock");
    let before = fs::read(&lock).unwrap();
    let before_tree = tree(&w.home);
    let ans = engine_answer(&w, &o, "wakeMonitor");
    assert_eq!(ans["live"], json!(true), "{ans}");
    assert_eq!(stage_node_calls(&w), Vec::<String>::new());
    assert_eq!(fs::read(&lock).unwrap(), before, "the lock was rewritten");
    let after_tree = tree(&w.home);
    let new: Vec<&String> = after_tree.keys().filter(|k| !before_tree.contains_key(*k)).filter(|k| !k.starts_with(".anti-hall/ah-engine") && !k.starts_with(".anti-hall/logs") && !k.starts_with(".anti-hall/state")).collect();
    assert_eq!(new, vec![".anti-hall/devswarm/wake/"], "only the watcher state directory is created");
    for k in before_tree.keys().filter(|k| !k.starts_with(".anti-hall/ah-engine") && !k.starts_with(".anti-hall/logs")) {
        assert!(after_tree.contains_key(k), "{k} vanished");
    }
}
