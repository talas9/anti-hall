//! `inbox read-primary <id>` parity: `ah-engine mesh inbox read-primary ...` (mesh.engine_writes = on) against
//! `node scripts/devswarm.js inbox read-primary ...` on identical scratch homes.
//!
//! The verb files a read receipt under a random id, so "byte-identical" is checked with that id (and nothing else) made
//! equal: stdout and exit code, every store table, every file of the home tree (the receipt record included, down to its
//! `ops`, `hashes`, `reader` and `createdAt`) match. A `native` case is answered by the engine, the detached background
//! run of Node on a scratch copy reaches the same verdict (`mesh-verify.jsonl`), and Node's own `inbox ack-primary` accepts
//! the receipt the engine wrote and moves every cursor exactly as it moves them for Node's receipt. A `defer` case must
//! write NOTHING and exit 75 when no Node is on PATH, and hand the verb to Node otherwise.
#![allow(clippy::unwrap_used, clippy::expect_used)] // a test crate: a panic is the failure report, and E2 exempts tests
use serde_json::{Value, json};
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

#[path = "mesh_write_support/fx.rs"]
mod fx;
use fx::*;

const OLD: i64 = 1_790_000_000_000;
const NOW: i64 = 1_795_000_000_000;

type Spec = Box<dyn Fn(&Path) -> Value>;
type Fixup = Box<dyn Fn(&Path, i64)>;

struct Case {
    name: &'static str,
    cwd: &'static str,
    argv: Vec<String>,
    extra: Vec<(&'static str, String)>,
    ack: Spec,
    union: Spec,
    /// Runs after seeding, on each of the homes (rows inserted, files placed or removed).
    fixup: Fixup,
    native: bool,
    /// Never run in Node (it would reach the network or the process table): only the deferral is checked.
    engine_only: bool,
    expect: Vec<&'static str>,
}

fn row(partition: &str, ns: &str, reader: &str, value: i64) -> Value {
    json!({"partition": partition, "ns": ns, "reader": reader, "value": value, "updatedAt": OLD})
}

fn floors(partition: &str, store: i64, nd: i64) -> Vec<Value> {
    vec![row(partition, "store", "#floor", store), row(partition, "nd", "#floor", nd)]
}

fn desc(h: &Path, id: &str, inbox: Option<&str>, cursor: Option<&str>, wt: &Path) -> Value {
    let mut d = json!({"id": id, "worktreePath": wt.to_string_lossy(), "sessionId": id});
    if let Some(i) = inbox {
        d["inboxPath"] = json!(h.join(i).to_string_lossy());
    }
    if let Some(c) = cursor {
        d["cursorPath"] = json!(h.join(c).to_string_lossy());
    }
    d
}

fn line(h_field: Option<&str>, created: Option<i64>, msg: &str) -> String {
    let mut v = json!({"fromBranch": "b", "message": msg, "status": "new"});
    if let Some(x) = h_field {
        v["_h"] = json!(x);
    }
    if let Some(c) = created {
        v["createdAt"] = json!(c);
    }
    v.to_string()
}

fn rp(id: &str, more: &[&str]) -> Vec<String> {
    let mut v: Vec<String> = vec!["inbox".into(), "read-primary".into(), id.into()];
    v.extend(more.iter().map(|x| (*x).to_string()));
    v
}

fn devswarm(h: &Path) -> PathBuf {
    h.join(".anti-hall").join("devswarm")
}

fn put(h: &Path, rel: &str, text: &str) {
    let p = devswarm(h).join(rel);
    fs::create_dir_all(p.parent().unwrap()).unwrap();
    fs::write(p, text).unwrap();
}

/// The stable launcher the `ackCommand` names (any file will do).
fn launcher(h: &Path) {
    let p = h.join(".anti-hall").join("bin").join("devswarm.js");
    fs::create_dir_all(p.parent().unwrap()).unwrap();
    fs::write(p, "// launcher\n").unwrap();
}

fn with_launcher(more: impl Fn(&Path, i64) + 'static) -> Fixup {
    Box::new(move |h, now| {
        launcher(h);
        more(h, now);
    })
}

fn plain() -> Fixup {
    with_launcher(|_, _| {})
}

/// One message row inserted into the store the way `appendMeshRow` does (every column).
struct R<'a> {
    ws: &'a str,
    ts: i64,
    hash: Option<&'a str>,
    body: &'a str,
    sender: Option<&'a str>,
    recipient: Option<&'a str>,
    mtype: Option<&'a str>,
    orig: Option<&'a str>,
    nonce: Option<&'a str>,
}

fn insert(h: &Path, key: &str, rows: &[R]) {
    let db = devswarm(h).join("store").join(key).join("devswarm.db");
    let c = rusqlite::Connection::open(db).unwrap();
    for r in rows {
        c.execute(
            "INSERT OR IGNORE INTO messages (workspace_id, ts, hash, body, sender, recipient, mtype, urgency, is_heartbeat, needs_reply, orig_hash, instance_nonce, seq) VALUES (?, ?, ?, ?, ?, ?, ?, 'normal', 0, 0, ?, ?, (SELECT COALESCE(MAX(seq),0)+1 FROM messages))",
            rusqlite::params![r.ws, r.ts, r.hash, r.body, r.sender, r.recipient, r.mtype, r.orig, r.nonce],
        )
        .unwrap();
    }
}

fn sql(h: &Path, key: &str, statement: &str) {
    let db = devswarm(h).join("store").join(key).join("devswarm.db");
    rusqlite::Connection::open(db).unwrap().execute_batch(statement).unwrap();
}

fn chmod(p: &Path, mode: u32) {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(p, fs::Permissions::from_mode(mode)).unwrap();
}

/// Undo every injected permission fault under `dir`, so the scratch tree can be removed.
fn reset_modes(dir: &Path) {
    use std::os::unix::fs::PermissionsExt;
    if let Ok(m) = fs::symlink_metadata(dir) {
        if m.file_type().is_symlink() {
            return;
        }
        fs::set_permissions(dir, fs::Permissions::from_mode(if m.is_dir() { 0o755 } else { 0o644 })).ok();
        if m.is_dir() {
            for e in fs::read_dir(dir).into_iter().flatten().flatten() {
                reset_modes(&e.path());
            }
        }
    }
}

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

fn seed(h: &Path, fx: &Fx, c: &Case, now: i64) {
    run_seed("ack_seed.js", h, fx, &(c.ack)(h));
    run_seed("union_seed.js", h, fx, &(c.union)(h));
    fs::create_dir_all(h.join(".anti-hall")).unwrap();
    fs::write(h.join(".anti-hall").join("settings.json"), "{\"mesh\":{\"engine_writes\":\"on\"}}\n").unwrap();
    (c.fixup)(h, now);
}

/// A home's files with its own path made equal.
fn tree(home: &Path) -> BTreeMap<String, Vec<u8>> {
    let h = home.to_string_lossy().to_string();
    home_files(home).into_iter().map(|(k, v)| (k, String::from_utf8_lossy(&v).replace(&h, "<HOME>").into_bytes())).collect()
}

/// The receipt ids a home holds, by file name.
fn receipts(home: &Path) -> Vec<String> {
    let mut out = Vec::new();
    let base = devswarm(home).join("read-receipts");
    if let Ok(rd) = fs::read_dir(&base) {
        for d in rd.flatten() {
            if let Ok(files) = fs::read_dir(d.path()) {
                for f in files.flatten() {
                    out.push(f.file_name().to_string_lossy().trim_end_matches(".json").to_string());
                }
            }
        }
    }
    out.sort();
    out
}

/// The tree with the ids of the receipts written by the run (those not in `before`) replaced by one name.
fn canon_tree(home: &Path, before: &[String]) -> BTreeMap<String, Vec<u8>> {
    let fresh: Vec<String> = receipts(home).into_iter().filter(|r| !before.contains(r)).collect();
    tree(home)
        .into_iter()
        .map(|(k, v)| {
            let mut key = k;
            let mut val = String::from_utf8_lossy(&v).into_owned();
            for r in &fresh {
                key = key.replace(r.as_str(), "<RID>");
                val = val.replace(r.as_str(), "<RID>");
            }
            if key.contains("/cursor-log/") {
                val = mask_digits(&mask_digits(&val, "\"ts\":"), "\"pid\":");
            }
            (key, val.into_bytes())
        })
        .collect()
}

fn canon_out(home: &Path, out: &str, rids: &[String]) -> String {
    let mut t = out.replace(&home.to_string_lossy().to_string(), "<HOME>");
    for r in rids {
        t = t.replace(r.as_str(), "<RID>");
    }
    t
}

/// `prefix` followed by digits, the digits replaced (the wall clock and process id a cursor-log line carries).
fn mask_digits(t: &str, prefix: &str) -> String {
    let mut out = String::new();
    let mut rest = t;
    while let Some(i) = rest.find(prefix) {
        out.push_str(&rest[..i + prefix.len()]);
        let tail = &rest[i + prefix.len()..];
        let digits = tail.bytes().take_while(u8::is_ascii_digit).count();
        out.push_str("<n>");
        rest = &tail[digits..];
    }
    out.push_str(rest);
    out
}

fn rid_of(stdout: &str) -> Option<String> {
    let v: Value = serde_json::from_str(stdout.trim()).ok()?;
    v["readReceiptId"].as_str().map(str::to_string)
}

fn assert_same_homes(name: &str, a: &Path, b: &Path, ba: &[String], bb: &[String], key: &str, what: &str) {
    let db = |h: &Path| h.join(".anti-hall/devswarm/store").join(key).join("devswarm.db");
    if db(a).is_file() && db(b).is_file() {
        let one = |p: &Path| {
            let bytes = fs::read(p).unwrap();
            if bytes.starts_with(b"SQLite format 3\0") { raw_dump(p) } else { format!("not a database: {bytes:?}") }
        };
        // a cursor row's `updated_at` is the wall clock of whichever process moved it
        let mask = |t: String| mask_digits(&t, "updated_at=i");
        let (da, dbb) = (mask(one(&db(a))), mask(one(&db(b))));
        assert!(da == dbb, "{name}: {what}: store differs: {}", first_diff(&da, &dbb));
    }
    let (fa, fb) = (canon_tree(a, ba), canon_tree(b, bb));
    let ka: Vec<&String> = fa.keys().collect();
    let kb: Vec<&String> = fb.keys().collect();
    assert_eq!(ka, kb, "{name}: {what}: home tree file set differs");
    for (k, v) in &fa {
        assert!(fb[k] == *v, "{name}: {what}: {k} differs:\n a: {}\n b: {}", String::from_utf8_lossy(v), String::from_utf8_lossy(&fb[k]));
    }
}

fn store_dump(home: &Path, key: &str) -> String {
    let db = home.join(".anti-hall/devswarm/store").join(key).join("devswarm.db");
    if !db.is_file() {
        return String::new();
    }
    // an injected fault leaves an unreadable file or a file that is no database: a marker, not a panic
    match fs::read(&db) {
        Err(_) => "<unreadable>".to_string(),
        Ok(b) if b.starts_with(b"SQLite format 3\0") => raw_dump(&db),
        Ok(b) => format!("not a database: {b:?}"),
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

fn ack(rows: Vec<Value>, d: impl Fn(&Path) -> Vec<Value> + 'static) -> Spec {
    Box::new(move |h| json!({"rows": rows.clone(), "descriptors": d(h)}))
}

fn inbox(text: String) -> Spec {
    Box::new(move |_| json!({"files": [{"rel": "inbox/child-1.ndjson", "text": text.clone()}, {"rel": "cursors-nd/child-1.txt", "text": "0"}]}))
}

fn nothing() -> Spec {
    Box::new(|_| json!({}))
}

fn cases(fx: &Fx) -> Vec<Case> {
    let wt = fx.child.clone();
    let key = fx.repo_key.clone();
    let pid = i64::from(std::process::id());
    let d_inbox = {
        let wt = wt.clone();
        move |h: &Path| vec![desc(h, "child-1", Some("inbox/child-1.ndjson"), Some("cursors-nd/child-1.txt"), &wt)]
    };
    let d_store = {
        let wt = wt.clone();
        move |h: &Path| vec![desc(h, "child-1", None, None, &wt)]
    };
    let l1 = line(Some("native:aaa"), Some(1_790_000_000_500), "first native");
    let l2 = line(Some("native:bbb"), Some(1_790_000_001_500), "second native");
    let l3 = line(None, Some(1_790_000_002_500), "legacy line without hash");
    let text3 = format!("{l1}\n{l2}\n{l3}\n");
    let session = json!({"sessions": [{"pid": pid, "startedAt": OLD}]});
    let own_reader = format!("h:{pid}:{OLD}");
    let mut v: Vec<Case> = Vec::new();
    let base = |name: &'static str, argv: Vec<String>, ack: Spec, union: Spec, fixup: Fixup, native: bool, expect: Vec<&'static str>| Case {
        name,
        cwd: "child",
        argv,
        extra: vec![],
        ack,
        union,
        fixup,
        native,
        engine_only: false,
        expect,
    };
    // ---- native: the store alone ----
    v.push(base(
        "store-only-2-unread",
        rp("child-1", &[]),
        ack(floors("child-1", 0, 0), d_store.clone()),
        nothing(),
        plain(),
        true,
        vec!["\"count\":2", "first task"],
    ));
    v.push(base(
        "store-only-partly-read",
        rp("child-1", &[]),
        ack(floors("child-1", 1, 0), d_store.clone()),
        nothing(),
        plain(),
        true,
        vec!["\"count\":1", "is the build green?"],
    ));
    v.push(base(
        "nothing-unread",
        rp("child-1", &[]),
        ack(floors("child-1", 2, 0), d_store.clone()),
        nothing(),
        plain(),
        true,
        vec!["\"count\":0", "\"messages\":[]"],
    ));
    v.push(base(
        "cursor-ahead-of-the-total",
        rp("child-1", &[]),
        ack(floors("child-1", 5, 0), d_store.clone()),
        nothing(),
        plain(),
        true,
        vec!["\"unreadCount\":0", "\"cursor\":5"],
    ));
    v.push(base(
        "no-descriptor-session",
        rp("child-1", &[]),
        ack(floors("child-1", 0, 0), {
            let wt = wt.clone();
            move |_| vec![json!({"id": "child-1", "worktreePath": wt.to_string_lossy()})]
        }),
        nothing(),
        plain(),
        true,
        vec!["\"count\":2"],
    ));
    // ---- native: renderings and flags ----
    v.push(base(
        "text-format",
        rp("child-1", &["--format", "text"]),
        ack(floors("child-1", 0, 0), d_store.clone()),
        nothing(),
        plain(),
        true,
        vec!["from: ", "seq: "],
    ));
    v.push(base(
        "text-format-equals-form",
        rp("child-1", &["--format=text"]),
        ack(floors("child-1", 0, 0), d_store.clone()),
        nothing(),
        plain(),
        true,
        vec!["from: "],
    ));
    v.push(base(
        "text-format-nothing-unread",
        rp("child-1", &["--format", "text"]),
        ack(floors("child-1", 2, 0), d_store.clone()),
        nothing(),
        plain(),
        true,
        vec!["(no messages)"],
    ));
    v.push(base(
        "text-and-json-json-wins",
        rp("child-1", &["--format", "text", "--json"]),
        ack(floors("child-1", 0, 0), d_store.clone()),
        nothing(),
        plain(),
        true,
        vec!["\"action\":\"read-primary\""],
    ));
    v.push(base(
        "session-flag-is-accepted",
        rp("child-1", &["--session", "abc"]),
        ack(floors("child-1", 0, 0), d_store.clone()),
        nothing(),
        plain(),
        true,
        vec!["\"count\":2"],
    ));
    // ---- native: the NDJSON inbox joined with the store ----
    v.push(base(
        "union-ndjson-3-and-store-2",
        rp("child-1", &[]),
        ack(floors("child-1", 0, 0), d_inbox.clone()),
        inbox(text3.clone()),
        plain(),
        true,
        vec!["first native", "origin"],
    ));
    v.push(base(
        "union-text-format-has-undefined-seq",
        rp("child-1", &["--format", "text"]),
        ack(floors("child-1", 0, 0), d_inbox.clone()),
        inbox(text3.clone()),
        plain(),
        true,
        vec!["seq: undefined"],
    ));
    v.push(base(
        "union-with-nd-and-store-floors",
        rp("child-1", &[]),
        ack(floors("child-1", 1, 1), d_inbox.clone()),
        inbox(text3.clone()),
        plain(),
        true,
        vec!["second native"],
    ));
    v.push(base(
        "union-everything-read",
        rp("child-1", &[]),
        ack(floors("child-1", 2, 3), d_inbox.clone()),
        inbox(text3.clone()),
        plain(),
        true,
        vec!["\"count\":0"],
    ));
    v.push(base(
        "union-empty-inbox",
        rp("child-1", &[]),
        ack(floors("child-1", 0, 0), d_inbox.clone()),
        inbox(String::new()),
        plain(),
        true,
        vec!["\"count\":2"],
    ));
    v.push(base(
        "union-a-store-twin-of-an-ndjson-line-is-counted-once",
        rp("child-1", &[]),
        ack(floors("child-1", 0, 0), d_inbox.clone()),
        inbox(text3.clone()),
        {
            let key = key.clone();
            with_launcher(move |h, _| {
                insert(
                    h,
                    &key,
                    &[R {
                        ws: "child-1",
                        ts: 1_790_000_000_600,
                        hash: Some("native:aaa"),
                        body: "first native",
                        sender: Some("b"),
                        recipient: Some("child-1"),
                        mtype: Some("direct"),
                        orig: None,
                        nonce: None,
                    }],
                );
            })
        },
        true,
        vec!["first native"],
    ));
    v.push(base(
        "union-a-store-row-covered-by-body",
        rp("child-1", &[]),
        ack(floors("child-1", 0, 0), d_inbox.clone()),
        inbox("plain body line\n".to_string()),
        {
            let key = key.clone();
            with_launcher(move |h, _| {
                insert(
                    h,
                    &key,
                    &[R {
                        ws: "child-1",
                        ts: 1_790_000_000_700,
                        hash: Some("mesh:zzz"),
                        body: "plain body line",
                        sender: Some("b"),
                        recipient: Some("child-1"),
                        mtype: Some("direct"),
                        orig: None,
                        nonce: None,
                    }],
                );
            })
        },
        true,
        vec!["\"count\":3"],
    ));
    v.push(base(
        "union-odd-ndjson-lines-and-field-types",
        rp("child-1", &[]),
        ack(floors("child-1", 2, 0), d_inbox.clone()),
        inbox(format!(
            "{}\n[1,2]\n\"just a string\"\nnull\nnot json at all\n{}\n{}\n{}\n",
            json!({"_h": 7, "fromBranch": 5, "message": 12.5, "createdAt": 1_790_000_003_000i64, "status": {"a": [1, 2], "b": null}}),
            json!({"fromBranch": true, "message": false, "createdAt": "1790000004000"}),
            json!({"message": "tie a", "createdAt": 1_790_000_005_000i64}),
            json!({"message": "tie b", "createdAt": 1_790_000_005_000i64}),
        )),
        plain(),
        true,
        vec!["tie a", "tie b"],
    ));
    // ---- native: row shapes ----
    v.push(base(
        "rows-with-instance-nonce-and-forward-marker",
        rp("child-1", &[]),
        ack(floors("child-1", 2, 0), d_store.clone()),
        nothing(),
        {
            let key = key.clone();
            with_launcher(move |h, _| {
                insert(
                    h,
                    &key,
                    &[
                        R {
                            ws: "child-1",
                            ts: 1_790_000_010_000,
                            hash: Some("mesh:f1"),
                            body: "forwarded copy",
                            sender: Some("p"),
                            recipient: Some("child-1"),
                            mtype: Some("direct"),
                            orig: Some("mesh:orig1"),
                            nonce: Some("anc:123:456"),
                        },
                        R {
                            ws: "child-1",
                            ts: 1_790_000_011_000,
                            hash: Some("mesh:f2"),
                            body: "with nonce only",
                            sender: None,
                            recipient: Some("child-1"),
                            mtype: Some("direct"),
                            orig: None,
                            nonce: Some("self:9:8"),
                        },
                        R {
                            ws: "child-1",
                            ts: 1_790_000_012_000,
                            hash: Some("mesh:f3"),
                            body: "a broadcast-typed row",
                            sender: Some("p"),
                            recipient: None,
                            mtype: Some("broadcast"),
                            orig: Some(""),
                            nonce: Some(""),
                        },
                    ],
                );
            })
        },
        true,
        vec!["forwarded", "instanceNonceShort", "fromLine"],
    ));
    v.push(base(
        "rows-with-unicode-and-escapes",
        rp("child-1", &["--format", "text"]),
        ack(floors("child-1", 2, 0), d_store.clone()),
        nothing(),
        {
            let key = key.clone();
            with_launcher(move |h, _| {
                insert(
                    h,
                    &key,
                    &[
                        R {
                            ws: "child-1",
                            ts: 1_790_000_020_000,
                            hash: Some("mesh:u1"),
                            body: "caf\u{e9} \u{1f980} \"quoted\" \\ back\ttab\nnewline {seq} {from}",
                            sender: Some("s{body}"),
                            recipient: Some("child-1"),
                            mtype: Some("direct"),
                            orig: None,
                            nonce: None,
                        },
                        R {
                            ws: "child-1",
                            ts: 1_790_000_021_000,
                            hash: None,
                            body: "a row without a hash \u{2028} \u{7f}",
                            sender: None,
                            recipient: None,
                            mtype: None,
                            orig: None,
                            nonce: None,
                        },
                    ],
                );
            })
        },
        true,
        vec!["caf"],
    ));
    v.push(base(
        "rows-with-a-ts-of-zero-and-a-legacy-bare-row",
        rp("child-1", &[]),
        ack(floors("child-1", 2, 0), d_store.clone()),
        nothing(),
        {
            let key = key.clone();
            with_launcher(move |h, _| {
                insert(
                    h,
                    &key,
                    &[R { ws: "child-1", ts: 0, hash: Some("legacy:z"), body: "zero ts", sender: None, recipient: None, mtype: None, orig: None, nonce: None }],
                );
            })
        },
        true,
        vec!["zero ts"],
    ));
    // ---- native: who reads, and what already exists ----
    v.push(base(
        "own-reader-rows-override-the-floor",
        rp("child-1", &[]),
        {
            let session = session.clone();
            let d = d_inbox.clone();
            let own = own_reader.clone();
            let mut rows = floors("child-1", 2, 0);
            rows.push(row("child-1", "store", &own, 0));
            rows.push(row("child-1", "nd", &own, 1));
            Box::new(move |h| {
                let mut v = json!({"rows": rows.clone(), "descriptors": d(h)});
                v["sessions"] = session["sessions"].clone();
                v
            })
        },
        inbox(text3.clone()),
        plain(),
        true,
        vec!["second native", "first task"],
    ));
    v.push(base(
        "a-reader-with-no_rows-of-its-own-reads-at-the-floor",
        rp("child-1", &[]),
        {
            let session = session.clone();
            let d = d_inbox.clone();
            let rows = floors("child-1", 1, 1);
            Box::new(move |h| {
                let mut v = json!({"rows": rows.clone(), "descriptors": d(h)});
                v["sessions"] = session["sessions"].clone();
                v
            })
        },
        inbox(text3.clone()),
        plain(),
        true,
        vec!["second native"],
    ));
    v.push(base(
        "young-receipts-already-in-the-directory",
        rp("child-1", &[]),
        ack(floors("child-1", 0, 0), d_store.clone()),
        nothing(),
        with_launcher(|h, now| {
            put(h, "read-receipts/child-1/rold1.json", "{}");
            put(h, "read-receipts/child-1/notes.txt", "not a receipt");
            put(h, "read-receipts/child-1/Rupper.json", "{}");
            // the pinned clock is ahead of the wall clock: age the files against IT, as Node does
            for (name, age_ms) in [("rold1.json", 3_600_000), ("notes.txt", 30 * 24 * 3_600_000), ("Rupper.json", 30 * 24 * 3_600_000)] {
                let f = fs::File::options().write(true).open(devswarm(h).join("read-receipts/child-1").join(name)).unwrap();
                f.set_modified(std::time::UNIX_EPOCH + std::time::Duration::from_millis((now - age_ms) as u64)).unwrap();
            }
        }),
        true,
        vec!["\"count\":2"],
    ));
    v.push(base(
        "jev-enabled-but-nothing-to-label",
        rp("child-1", &[]),
        ack(floors("child-1", 2, 0), d_store.clone()),
        nothing(),
        plain(),
        true,
        vec!["\"count\":0"],
    ));
    if let Some(last) = v.last_mut() {
        last.extra = vec![("ANTIHALL_JEV", "1".into())];
    }
    v.push(base(
        "the-primary-reads-its-own-inbox",
        rp("PRIMARY", &[]),
        Box::new({
            let wt = fx.main.clone();
            let pid_id = fx.primary_id.clone();
            move |h| json!({"rows": floors(&pid_id, 0, 0), "descriptors": [desc(h, &pid_id, None, None, &wt)]})
        }),
        nothing(),
        plain(),
        true,
        vec!["\"action\":\"read-primary\""],
    ));
    if let Some(last) = v.last_mut() {
        last.cwd = "main";
    }
    // ---- deferrals: nothing may be written ----
    let defer_store = |name: &'static str, argv: Vec<String>, expect: Vec<&'static str>| {
        base(name, argv, ack(floors("child-1", 0, 0), d_store.clone()), nothing(), plain(), false, expect)
    };
    v.push(defer_store("flag-limit", rp("child-1", &["--limit", "1"]), vec!["\"count\":1"]));
    v.push(defer_store("flag-since", rp("child-1", &["--since", "1"]), vec!["since"]));
    v.push(defer_store("flag-tail", rp("child-1", &["--tail", "1"]), vec!["tail"]));
    v.push(defer_store("flag-ack-as-owner", rp("child-1", &["--ack-as-owner"]), vec!["\"count\":2"]));
    v.push(defer_store("flag-ack-after-print", rp("child-1", &["--ack-after-print"]), vec!["autoAck"]));
    v.push(defer_store("flag-legacy-ack-now", rp("child-1", &["--legacy-ack-now"]), vec!["\"acked\""]));
    v.push(defer_store("flag-unread", rp("child-1", &["--unread"]), vec!["\"count\":2"]));
    v.push(defer_store("flag-with-broadcasts", rp("child-1", &["--with-broadcasts"]), vec!["withBroadcastsIgnored"]));
    v.push(defer_store("format-other-than-text", rp("child-1", &["--format", "yaml"]), vec!["\"count\":2"]));
    v.push(defer_store("format-twice", rp("child-1", &["--format", "text", "--format", "text"]), vec!["from: "]));
    v.push(defer_store("json-with-a-value", rp("child-1", &["--format", "text", "--json=1"]), vec!["from: "]));
    v.push(defer_store("extra-positional", rp("child-1", &["extra"]), vec!["\"count\":2"]));
    v.push(defer_store("unsafe-id", rp("../x", &[]), vec!["invalid or missing workspace id"]));
    v.push(base("no-descriptor", rp("child-1", &[]), Box::new(|_| json!({"rows": floors("child-1", 0, 0)})), nothing(), plain(), false, vec!["child-1"]));
    v.push(base(
        "descriptor-names-another-id",
        rp("child-1", &[]),
        ack(floors("child-1", 0, 0), {
            let wt = wt.clone();
            move |_| vec![json!({"id": "other", "worktreePath": wt.to_string_lossy(), "sessionId": "x"})]
        }),
        nothing(),
        plain(),
        false,
        vec!["child-1"],
    ));
    v.push(base(
        "unclaimed-descriptor-session-is-promoted-by-node",
        rp("child-1", &["--session", "real-session-1"]),
        ack(floors("child-1", 0, 0), {
            let wt = wt.clone();
            move |_| vec![json!({"id": "child-1", "worktreePath": wt.to_string_lossy(), "sessionId": "unclaimed:child-1"})]
        }),
        nothing(),
        plain(),
        false,
        vec!["\"count\":2"],
    ));
    v.push(base(
        "unclaimed-registry-row",
        rp("child-1", &[]),
        ack(floors("child-1", 0, 0), d_store.clone()),
        nothing(),
        {
            let key = key.clone();
            with_launcher(move |h, _| sql(h, &key, "UPDATE registry SET session_id = 'unclaimed:child-1' WHERE id = 'child-1';"))
        },
        false,
        vec!["\"count\":2"],
    ));
    v.push(base(
        "mesh-group-of-two-rows",
        rp("child-1", &[]),
        Box::new({
            let wt = wt.clone();
            let d = d_store.clone();
            move |h| json!({"rows": floors("child-1", 0, 0), "descriptors": d(h), "registry": [{"id": "child-1b", "worktreePath": wt.to_string_lossy(), "sessionId": "child-1b"}]})
        }),
        nothing(),
        plain(),
        false,
        vec!["meshPartitionIds"],
    ));
    v.push(Case {
        cwd: "main",
        ..base("the-caller-does-not-own-the-id", rp("child-1", &[]), ack(floors("child-1", 0, 0), d_store.clone()), nothing(), plain(), false, vec!["refused"])
    });
    v.push(base("floor-rows-missing-need-the-import", rp("child-1", &[]), ack(vec![], d_store.clone()), nothing(), plain(), false, vec!["\"count\":2"]));
    v.push(base(
        "inbox-missing-the-count-is-unknown",
        rp("child-1", &[]),
        ack(floors("child-1", 0, 0), d_inbox.clone()),
        nothing(),
        plain(),
        false,
        vec!["\"count\":2"],
    ));
    v.push(base(
        "descriptor-inbox-without-a-cursor-file",
        rp("child-1", &[]),
        ack(floors("child-1", 0, 0), {
            let wt = wt.clone();
            move |h| vec![desc(h, "child-1", Some("inbox/child-1.ndjson"), None, &wt)]
        }),
        inbox(text3.clone()),
        plain(),
        false,
        vec!["\"count\""],
    ));
    v.push(base(
        "no-stable-launcher",
        rp("child-1", &[]),
        ack(floors("child-1", 0, 0), d_store.clone()),
        nothing(),
        Box::new(|_, _| {}),
        false,
        vec!["\"count\":2"],
    ));
    v.push(base(
        "an-old-receipt-would-be-pruned-by-node",
        rp("child-1", &[]),
        ack(floors("child-1", 0, 0), d_store.clone()),
        nothing(),
        with_launcher(|h, now| {
            put(h, "read-receipts/child-1/rolder.json", "{}");
            let f = fs::File::options().write(true).open(devswarm(h).join("read-receipts/child-1/rolder.json")).unwrap();
            f.set_modified(std::time::UNIX_EPOCH + std::time::Duration::from_millis((now - 8 * 24 * 3600 * 1000) as u64)).unwrap();
        }),
        false,
        vec!["\"count\":2"],
    ));
    v.push(base(
        "a-legacy-forward-prefix-needs-the-original-hash",
        rp("child-1", &[]),
        ack(floors("child-1", 2, 0), d_store.clone()),
        nothing(),
        {
            let key = key.clone();
            with_launcher(move |h, _| {
                insert(
                    h,
                    &key,
                    &[R {
                        ws: "child-1",
                        ts: 1_790_000_030_000,
                        hash: Some("mesh:fw"),
                        body: "[forwarded from archived old-1] hello",
                        sender: Some("p"),
                        recipient: Some("child-1"),
                        mtype: Some("direct"),
                        orig: None,
                        nonce: None,
                    }],
                );
            })
        },
        false,
        vec!["forwarded"],
    ));
    v.push(base(
        "more-unread-than-one-call-returns",
        rp("child-1", &[]),
        ack(floors("child-1", 2, 0), d_inbox.clone()),
        inbox((0..2001).map(|i| line(Some(&format!("native:{i}")), Some(1_790_000_100_000 + i), &format!("bulk {i}")) + "\n").collect::<String>()),
        plain(),
        false,
        vec!["truncated"],
    ));
    // ---- injected faults: the engine must not guess where Node would report ----
    v.push(base(
        "fault-the-receipt-directory-is-read-only",
        rp("child-1", &[]),
        ack(floors("child-1", 0, 0), d_store.clone()),
        nothing(),
        with_launcher(|h, _| {
            put(h, "read-receipts/child-1/rkeep.json", "{}");
            chmod(&devswarm(h).join("read-receipts/child-1"), 0o555);
        }),
        false,
        vec!["receiptError"],
    ));
    v.push(base(
        "fault-the-receipt-root-is-a-file",
        rp("child-1", &[]),
        ack(floors("child-1", 0, 0), d_store.clone()),
        nothing(),
        with_launcher(|h, _| put(h, "read-receipts", "not a directory")),
        false,
        vec!["receiptError"],
    ));
    v.push(base(
        "fault-the-ndjson-inbox-is-unreadable",
        rp("child-1", &[]),
        ack(floors("child-1", 0, 0), d_inbox.clone()),
        inbox(text3.clone()),
        with_launcher(|h, _| chmod(&h.join("inbox/child-1.ndjson"), 0o000)),
        false,
        vec!["\"count\""],
    ));
    v.push(base(
        "fault-the-nd-cursor-file-is-garbage",
        rp("child-1", &[]),
        ack(floors("child-1", 0, 0), d_inbox.clone()),
        inbox(text3.clone()),
        with_launcher(|h, _| fs::write(h.join("cursors-nd/child-1.txt"), "abc").unwrap()),
        false,
        vec!["\"count\""],
    ));
    v.push(base(
        "fault-the-store-file-is-unreadable",
        rp("child-1", &[]),
        ack(floors("child-1", 0, 0), d_store.clone()),
        nothing(),
        {
            let key = key.clone();
            with_launcher(move |h, _| chmod(&devswarm(h).join("store").join(&key).join("devswarm.db"), 0o000))
        },
        false,
        vec![],
    ));
    v.push(base(
        "fault-the-descriptor-is-unreadable",
        rp("child-1", &[]),
        ack(floors("child-1", 0, 0), d_store.clone()),
        nothing(),
        with_launcher(|h, _| chmod(&devswarm(h).join("workspaces/child-1.json"), 0o000)),
        false,
        vec![],
    ));
    v.push(base(
        "fault-the-store-is-not-a-database",
        rp("child-1", &[]),
        ack(floors("child-1", 0, 0), d_store.clone()),
        nothing(),
        {
            let key = key.clone();
            with_launcher(move |h, _| fs::write(devswarm(h).join("store").join(&key).join("devswarm.db"), b"this is not sqlite").unwrap())
        },
        false,
        vec![],
    ));
    // Node would label with Jev (a worker, the network): only the engine's deferral is checked
    v.push(Case {
        extra: vec![("ANTIHALL_JEV", "1".into())],
        engine_only: true,
        ..base("jev-possibly-enabled-with-mail-to-label", rp("child-1", &[]), ack(floors("child-1", 0, 0), d_store.clone()), nothing(), plain(), false, vec![])
    });
    v
}

/// Run Node's `inbox ack-primary` for the receipt a read-primary printed; the result must be ok.
fn node_ack(home: &Path, cwd: &Path, id: &str, rid: &str, now: i64) -> Run {
    node_verb(home, &home.join("state"), cwd, &["inbox", "ack-primary", id, "--receipt", rid], now, None, &[])
}

#[test]
fn read_primary_matches_node_byte_for_byte_and_defers_without_writing() {
    if !node_sqlite_available() {
        eprintln!("SKIPPED: Node with node:sqlite is not available, so there is no Node writer to compare with");
        return;
    }
    let fx = fixture("rp");
    let nonode = no_node_path(&fx.root);
    let mut list = cases(&fx);
    // the Primary's own inbox: its id is only known from the fixture
    for c in &mut list {
        if c.argv.get(2).map(String::as_str) == Some("PRIMARY") {
            c.argv[2] = fx.primary_id.clone();
        }
    }
    let (mut native, mut deferred, mut acked) = (0, 0, 0);
    for (i, c) in list.iter().enumerate() {
        struct Undo(Vec<PathBuf>);
        impl Drop for Undo {
            fn drop(&mut self) {
                self.0.iter().for_each(|p| reset_modes(p));
            }
        }
        let _undo = Undo(["node", "engine", "defer"].iter().map(|k| fx.root.join(format!("{}-{k}", c.name))).collect());
        let now = NOW + i as i64 * 7_919;
        let cwd: PathBuf = if c.cwd == "main" { fx.main.clone() } else { fx.child.clone() };
        let (hn, he, hd) = (fx.root.join(format!("{}-node", c.name)), fx.root.join(format!("{}-engine", c.name)), fx.root.join(format!("{}-defer", c.name)));
        for h in [&hn, &he, &hd] {
            copy_tree(&fx.seed_home, h);
            seed(h, &fx, c, now);
        }
        let av: Vec<&str> = c.argv.iter().map(String::as_str).collect();
        let extra: Vec<(&str, &str)> = c.extra.iter().map(|(k, v)| (*k, v.as_str())).collect();
        let (before_n, before_e) = (receipts(&hn), receipts(&he));
        if c.engine_only {
            deferred += 1;
            let (pre_tree, pre_db) = (tree(&hd), store_dump(&hd, &fx.repo_key));
            let d = engine_verb(&hd, &hd.join("state"), &cwd, &av, now, None, &[extra.clone(), vec![("PATH", nonode.as_str())]].concat());
            assert_eq!(d.code, 75, "{}: a deferral the engine cannot hand to Node exits 75, got {} / {}", c.name, d.code, d.stdout);
            assert!(d.stdout.is_empty(), "{}: nothing is printed on a deferral: {}", c.name, d.stdout);
            assert_eq!(last_log(&hd.join("state"))["result"], "defer", "{}: logged as a deferral", c.name);
            assert!(pre_tree == tree(&hd) && pre_db == store_dump(&hd, &fx.repo_key), "{}: deferral wrote", c.name);
            continue;
        }
        let n = node_verb(&hn, &hn.join("state"), &cwd, &av, now, None, &extra);
        for want in &c.expect {
            assert!(n.stdout.contains(want), "{}: Node's output lacks {want:?}: {}", c.name, n.stdout);
        }
        let e = engine_verb(&he, &he.join("state"), &cwd, &av, now, None, &extra);
        let log = last_log(&he.join("state"));
        assert_eq!(log["result"] == "native", c.native, "{}: expected native={} but the engine logged {log}", c.name, c.native);
        if c.native {
            native += 1;
            assert_eq!(log["verb"], "InboxReadPrimary", "{}: telemetry names the verb", c.name);
            let (rn, re) = (rid_of(&n.stdout), rid_of(&e.stdout));
            let after_n: Vec<String> = receipts(&hn).into_iter().filter(|r| !before_n.contains(r)).collect();
            let after_e: Vec<String> = receipts(&he).into_iter().filter(|r| !before_e.contains(r)).collect();
            assert_eq!((after_n.len(), after_e.len()), (1, 1), "{}: exactly one new receipt on each side", c.name);
            assert_eq!(e.code, n.code, "{}: exit code differs", c.name);
            assert_eq!(canon_out(&he, &e.stdout, &after_e), canon_out(&hn, &n.stdout, &after_n), "{}: stdout differs", c.name);
            assert_same_homes(c.name, &hn, &he, &before_n, &before_e, &fx.repo_key, "node vs engine");
            // an engine receipt must have Node's shape: id format, same length
            assert_eq!((after_e[0].len(), after_e[0].starts_with('r')), (after_n[0].len(), true), "{}: receipt id shape", c.name);
            if let (Some(rn), Some(re)) = (rn, re) {
                assert_eq!(re, after_e[0]);
                assert_eq!(rn, after_n[0]);
                // Node's ack-primary applies the engine's receipt and Node's own alike
                let (an, ae) = (node_ack(&hn, &cwd, &c.argv[2], &rn, now + 1), node_ack(&he, &cwd, &c.argv[2], &re, now + 1));
                assert!(an.stdout.contains("\"ok\":true"), "{}: Node's own receipt is not acked: {}", c.name, an.stdout);
                assert_eq!(canon_out(&he, &ae.stdout, &after_e), canon_out(&hn, &an.stdout, &after_n), "{}: ack output differs", c.name);
                assert_same_homes(c.name, &hn, &he, &before_n, &before_e, &fx.repo_key, "after Node acked each receipt");
                acked += 1;
            }
            let v = verify_line(&he.join("state"));
            assert_eq!(v["result"], "match", "{}: the background Node shadow disagrees: {v}", c.name);
        } else {
            deferred += 1;
            assert_eq!(e.code, n.code, "{}: exit code of the fallback", c.name);
            let (pre_tree, pre_db) = (tree(&hd), store_dump(&hd, &fx.repo_key));
            let d = engine_verb(&hd, &hd.join("state"), &cwd, &av, now, None, &[extra.clone(), vec![("PATH", nonode.as_str())]].concat());
            assert_eq!(d.code, 75, "{}: a deferral the engine cannot hand to Node exits 75, got {} / {}", c.name, d.code, d.stdout);
            assert!(d.stdout.is_empty(), "{}: nothing is printed on a deferral: {}", c.name, d.stdout);
            let reason = last_log(&hd.join("state"));
            assert_eq!(reason["result"], "defer", "{}: logged as a deferral: {reason}", c.name);
            assert!(pre_tree == tree(&hd), "{}: deferral wrote: the home tree changed", c.name);
            assert!(pre_db == store_dump(&hd, &fx.repo_key), "{}: deferral wrote: the store changed", c.name);
        }
    }
    eprintln!(
        "read-primary parity: {} cases, {native} answered by the engine and identical to Node ({acked} also acked by Node), {deferred} deferred with nothing written",
        list.len()
    );
    assert!(native >= 24 && deferred >= 24, "{native} native, {deferred} deferred");
}
