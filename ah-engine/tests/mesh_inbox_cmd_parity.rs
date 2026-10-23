//! `inbox count|read|peek-primary|ack|pull` parity: `ah-engine mesh inbox <verb> ...` (mesh.engine_writes = on) against
//! `node scripts/devswarm.js inbox <verb> ...` on identical scratch homes.
//!
//! A `native` case is answered by the engine: stdout and exit code, every store table and every file of the home tree match
//! Node's. A `defer` case must write NOTHING and exit 69 (`exit_unable`) when no Node is on PATH: since the shim has no Node
//! fallback, a case the engine cannot answer is a visible error, never a silent success. The no-Node half of every case runs
//! with a PATH that holds only git and ps.
#![allow(clippy::unwrap_used, clippy::expect_used)] // a test crate: a panic is the failure report, and E2 exempts tests
#![allow(clippy::panic, clippy::unreachable)] // integration tests: a panic is the failure report; production crates deny these in Cargo.toml
#![allow(dead_code)]
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
    // the spec goes on stdin (`-`): as one argument a large spec exceeds Linux's 128 KiB cap on a single argument
    let mut child = Command::new("node")
        .arg(support(script))
        .arg(h)
        .arg(&fx.repo_key)
        .arg("-")
        .env_clear()
        .env("PATH", std::env::var("PATH").unwrap())
        .env("HOME", h)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .unwrap();
    {
        use std::io::Write;
        child.stdin.take().unwrap().write_all(spec.to_string().as_bytes()).unwrap();
    }
    let o = child.wait_with_output().unwrap();
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
            if key.ends_with("/logs/devswarm.jsonl") {
                // the central log's entries carry the wall clock and the writer's pid
                val = mask_digits(&mask_digits(&val, "\"pid\":"), "\"pid\":");
                val = regex_ts(&val);
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
    {
        if let Ok(t) = fs::read_to_string(state.join("mesh-verify.jsonl"))
            && let Some(l) = t.lines().last()
        {
            return serde_json::from_str(l).unwrap();
        }
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


fn d_inbox_fn(h: &Path, wt: &Path) -> Vec<Value> {
    vec![desc(h, "child-1", Some("inbox/child-1.ndjson"), Some("cursors-nd/child-1.txt"), wt)]
}

fn cmd(verb: &str, id: &str, more: &[&str]) -> Vec<String> {
    let mut v: Vec<String> = vec!["inbox".into(), verb.into(), id.into()];
    v.extend(more.iter().map(|x| (*x).to_string()));
    v
}

fn cases(fx: &Fx) -> Vec<Case> {
    let wt = fx.child.clone();
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
    let mut v: Vec<Case> = Vec::new();
    let base = |name: &'static str, argv: Vec<String>, ack: Spec, union: Spec, native: bool, expect: Vec<&'static str>| Case {
        name,
        cwd: "child",
        argv,
        extra: vec![],
        ack,
        union,
        fixup: plain(),
        native,
        engine_only: false,
        expect,
    };
    // ---- count: native ----
    v.push(base("count-3-ndjson-unread", cmd("count", "child-1", &[]), ack(floors("child-1", 0, 0), d_inbox.clone()), inbox(text3.clone()), true, vec!["\"action\":\"count\"", "\"unreadNdjson\":3"]));
    v.push(base("count-partly-read", cmd("count", "child-1", &[]), ack(floors("child-1", 1, 1), d_inbox.clone()), inbox(text3.clone()), true, vec!["\"action\":\"count\"", "\"cursorNdjson\":1"]));
    v.push(base("count-all-read", cmd("count", "child-1", &[]), ack(floors("child-1", 2, 3), d_inbox.clone()), inbox(text3.clone()), true, vec!["\"unreadTotal\":0"]));
    v.push(base("count-unknown-no-inbox-files", cmd("count", "child-1", &[]), ack(floors("child-1", 0, 0), d_inbox.clone()), nothing(), true, vec!["\"known\":false"]));
    // ---- read: native ----
    v.push(base("read-3-ndjson-and-store-unread", cmd("read", "child-1", &[]), ack(floors("child-1", 0, 0), d_inbox.clone()), inbox(text3.clone()), true, vec!["\"action\":\"read\"", "\"cursorAdvanced\":false", "first native", "\"meshMessages\":[{"]));
    v.push(base("read-partly-read", cmd("read", "child-1", &[]), ack(floors("child-1", 1, 2), d_inbox.clone()), inbox(text3.clone()), true, vec!["\"action\":\"read\"", "legacy line without hash", "!first native"]));
    v.push(base("read-all-read", cmd("read", "child-1", &[]), ack(floors("child-1", 2, 3), d_inbox.clone()), inbox(text3.clone()), true, vec!["\"lines\":[]", "!ackHint"]));
    v.push(base("read-unknown-no-inbox-files", cmd("read", "child-1", &[]), ack(floors("child-1", 0, 0), d_inbox.clone()), nothing(), true, vec!["\"known\":false", "\"meshMessages\":[{"]));
    // ---- peek-primary: native ----
    v.push(base("peek-store-only-2-unread", cmd("peek-primary", "child-1", &[]), ack(floors("child-1", 0, 0), d_store.clone()), nothing(), true, vec!["\"action\":\"peek-primary\"", "\"count\":2", "!readReceiptId"]));
    v.push(base("peek-partly-read", cmd("peek-primary", "child-1", &[]), ack(floors("child-1", 1, 0), d_store.clone()), nothing(), true, vec!["\"count\":1"]));
    v.push(base("peek-nothing-unread", cmd("peek-primary", "child-1", &[]), ack(floors("child-1", 2, 0), d_store.clone()), nothing(), true, vec!["\"count\":0", "\"messages\":[]"]));
    v.push(base("peek-union-ndjson-and-store", cmd("peek-primary", "child-1", &[]), ack(floors("child-1", 0, 0), d_inbox.clone()), inbox(text3.clone()), true, vec!["\"cursorNdjson\":0", "first native", "!ackCommand"]));
    v.push(base("peek-with-limit", cmd("peek-primary", "child-1", &["--limit", "10"]), ack(floors("child-1", 0, 0), d_store.clone()), nothing(), true, vec!["\"count\":2"]));
    let mut from_main = base("peek-from-another-checkout", cmd("peek-primary", "child-1", &[]), ack(floors("child-1", 0, 0), d_store.clone()), nothing(), true, vec!["\"count\":2"]);
    from_main.cwd = "main";
    v.push(from_main);
    // ---- peek-primary: `--format text` is read-primary's alone, a peek prints its JSON ----
    v.push(base("peek-text-format", cmd("peek-primary", "child-1", &["--format", "text"]), ack(floors("child-1", 0, 0), d_store.clone()), nothing(), true, vec!["\"count\":2"]));
    v.push(base("peek-no-descriptor", cmd("peek-primary", "ghost", &[]), ack(floors("child-1", 0, 0), d_store.clone()), nothing(), true, vec!["unregistered-workspace"]));
    // ---- ack: native ----
    let pid = i64::from(std::process::id());
    let session = json!({"sessions": [{"pid": pid, "startedAt": OLD}]});
    let own_reader = format!("h:{pid}:{OLD}");
    v.push(base("ack-3-ndjson-and-store-unread", cmd("ack", "child-1", &[]), ack(floors("child-1", 0, 0), d_inbox.clone()), inbox(text3.clone()), true, vec!["\"action\":\"ack\"", "\"cursor\":3"]));
    v.push(base("ack-partly-read", cmd("ack", "child-1", &[]), ack(floors("child-1", 1, 2), d_inbox.clone()), inbox(text3.clone()), true, vec!["\"cursor\":3"]));
    v.push(base("ack-all-read", cmd("ack", "child-1", &[]), ack(floors("child-1", 2, 3), d_inbox.clone()), inbox(text3.clone()), true, vec!["\"cursor\":3"]));
    v.push(base("ack-empty-inbox-store-rows", cmd("ack", "child-1", &[]), ack(floors("child-1", 0, 0), d_inbox.clone()), inbox(String::new()), true, vec!["\"total\":0"]));
    v.push(base("ack-unknown-no-inbox-files", cmd("ack", "child-1", &[]), ack(floors("child-1", 0, 0), d_inbox.clone()), nothing(), true, vec!["\"known\":false"]));
    v.push(base("ack-as-owner-flag", cmd("ack", "child-1", &["--ack-as-owner"]), ack(floors("child-1", 0, 0), d_inbox.clone()), inbox(text3.clone()), true, vec!["\"cursor\":3"]));
    v.push(base(
        "ack-declared-reader",
        cmd("ack", "child-1", &[]),
        {
            let session = session.clone();
            let d = d_inbox.clone();
            let own = own_reader.clone();
            let mut rows = floors("child-1", 0, 0);
            rows.push(row("child-1", "store", &own, 0));
            rows.push(row("child-1", "nd", &own, 1));
            Box::new(move |h| {
                let mut v = json!({"rows": rows.clone(), "descriptors": d(h)});
                v["sessions"] = session["sessions"].clone();
                v
            })
        },
        inbox(text3.clone()),
        true,
        vec!["\"cursor\":3"],
    ));
    // ---- ack: deferred ----
    v.push(base("ack-no-descriptor", cmd("ack", "ghost", &[]), ack(floors("child-1", 0, 0), d_inbox.clone()), inbox(text3.clone()), true, vec!["unregistered-workspace"]));
    // ---- the window flags: refused before anything is read ----
    for (name, verb, flags) in [
        ("window-count-since", "count", vec!["--since", "1"]),
        ("window-read-tail", "read", vec!["--tail", "2"]),
        ("window-ack-since-and-tail", "ack", vec!["--since", "1", "--tail", "1"]),
        ("window-pull-tail", "pull", vec!["--tail", "1"]),
        ("window-peek-since", "peek-primary", vec!["--since", "2"]),
    ] {
        v.push(base(name, cmd(verb, "child-1", &flags), ack(floors("child-1", 0, 0), d_inbox.clone()), inbox(text3.clone()), true, vec!["window-flags-unsupported-on-acking-verb"]));
    }
    // ---- --limit, --to, a caller that is another row ----
    for (name, verb, flags) in [
        ("count-limit-1", "count", vec!["--limit", "1"]),
        ("read-limit-1", "read", vec!["--limit", "1"]),
        ("ack-limit-1", "ack", vec!["--limit", "1"]),
        ("read-limit-not-a-number-is-ignored", "read", vec!["--limit", "abc"]),
        ("ack-to-1", "ack", vec!["--to", "1"]),
        ("ack-to-beyond-the-inbox", "ack", vec!["--to", "99"]),
        ("ack-to-not-a-number", "ack", vec!["--to", "abc"]),
    ] {
        v.push(base(name, cmd(verb, "child-1", &flags), ack(floors("child-1", 0, 0), d_inbox.clone()), inbox(text3.clone()), true, vec![if name == "ack-to-not-a-number" { "must be a number" } else { "child-1" }]));
    }
    let mut other_row = base("ack-by-another-registered-row", cmd("ack", "child-1", &[]), ack(floors("child-1", 0, 0), d_inbox.clone()), inbox(text3.clone()), true, vec!["ownership-mismatch"]);
    other_row.cwd = "main";
    v.push(other_row);
    // ---- an id with no descriptor of its own ----
    let mesh = fx.child_mesh.clone();
    for verb in ["count", "read", "ack"] {
        let name: &'static str = Box::leak(format!("{verb}-by-the-mesh-label").into_boxed_str());
        let nm: &'static str = Box::leak(format!("{verb}-registry-only-row").into_boxed_str());
        v.push(base(name, cmd(verb, &mesh, &[]), ack(floors("child-1", 0, 0), d_inbox.clone()), inbox(text3.clone()), true, vec!["\"id\":\"child-1\""]));
        let wt2 = wt.clone();
        v.push(base(
            nm,
            cmd(verb, "regonly-1", &[]),
            Box::new(move |h| json!({"rows": floors("child-1", 0, 0), "descriptors": d_inbox_fn(h, &wt2), "registry": [{"id": "regonly-1", "worktreePath": wt2.join("nowhere").to_string_lossy(), "sessionId": "regonly-1"}]})),
            inbox(text3.clone()),
            true,
            vec!["no-inbox-path"],
        ));
    }
    // ---- a mesh group: the workspace and a twin row on the same worktree ----
    let twin = {
        let wt = wt.clone();
        move |h: &Path| json!({"rows": floors("child-1", 0, 0), "descriptors": d_inbox_fn(h, &wt), "registry": [{"id": "child-1b", "worktreePath": wt.to_string_lossy(), "sessionId": "child-1b"}]})
    };
    let twin_mail = |n: usize| -> Spec {
        let text = text3.clone();
        Box::new(move |_| {
            let mesh: Vec<Value> = (0..n).map(|i| json!({"to": "child-1b", "from": "child-1", "ts": 1_790_000_100_000_i64 + i as i64, "hash": format!("mesh:twin{i}"), "message": format!("for the twin {i}")})).collect();
            json!({"files": [{"rel": "inbox/child-1.ndjson", "text": text.clone()}, {"rel": "cursors-nd/child-1.txt", "text": "0"}], "mesh": mesh})
        })
    };
    for verb in ["count", "read", "ack"] {
        let name: &'static str = Box::leak(format!("{verb}-mesh-group-with-twin-mail").into_boxed_str());
        // (the group's mesh label resolves to the twin here, so an ack is the owner override's)
        let own: &[&str] = if verb == "ack" { &["--ack-as-owner"] } else { &[] };
        v.push(base(name, cmd(verb, "child-1", own), Box::new(twin.clone()), twin_mail(3), true, vec!["child-1b"]));
        let lim: &'static str = Box::leak(format!("{verb}-mesh-group-limit-3").into_boxed_str());
        v.push(base(lim, cmd(verb, "child-1", &[own, &["--limit", "3"]].concat()), Box::new(twin.clone()), twin_mail(3), true, vec!["child-1b"]));
    }
    v.push(base("count-mesh-group-nothing-for-the-twin", cmd("count", "child-1", &[]), Box::new(twin.clone()), twin_mail(0), true, vec!["child-1b"]));
    // ---- a fold-retired id redirects to its survivor ----
    for (name, verb, flags, live, expect) in [
        ("count-retired-redirect", "count", vec![], false, "redirectedFrom"),
        ("read-retired-redirect", "read", vec![], false, "redirectedFrom"),
        ("ack-retired-redirect", "ack", vec![], false, "redirectedFrom"),
    ] {
        let mut c = base(name, cmd(verb, "gone-1", &flags), ack(floors("child-1", 0, 0), d_inbox.clone()), inbox(text3.clone()), true, vec![expect]);
        c.fixup = with_launcher(move |h, now| {
            put(h, "retired/gone-1.json", "{\"retiredTo\":\"child-1\"}");
            if live {
                put(h, "heartbeats/child-1.json", &format!("{{\"ts\":{now}}}"));
            }
        });
        v.push(c);
    }
    // ---- count: deferred ----
    v.push(base("count-no-descriptor", cmd("count", "ghost", &[]), ack(floors("child-1", 0, 0), d_inbox.clone()), inbox(text3.clone()), true, vec!["unregistered-workspace"]));
    v.push(base("read-no-descriptor", cmd("read", "ghost", &[]), ack(floors("child-1", 0, 0), d_inbox.clone()), inbox(text3.clone()), true, vec!["unregistered-workspace"]));

    v
}

fn run_case_list(tag: &str, list: Vec<Case>, fx: &Fx) {
    let nonode = no_node_path(&fx.root);
    let (mut native, mut deferred) = (0, 0);
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
            seed(h, fx, c, now);
        }
        let av: Vec<&str> = c.argv.iter().map(String::as_str).collect();
        let extra: Vec<(&str, &str)> = c.extra.iter().map(|(k, v)| (*k, v.as_str())).collect();
        let (before_n, before_e) = (receipts(&hn), receipts(&he));
        let n = node_verb(&hn, &hn.join("state"), &cwd, &av, now, None, &extra);
        if c.native {
            for want in &c.expect {
                match want.strip_prefix('!') {
                    Some(absent) => assert!(!n.stdout.contains(absent), "{}: Node's output has {absent:?}: {}", c.name, n.stdout),
                    None => assert!(n.stdout.contains(want), "{}: Node's output lacks {want:?}: {}", c.name, n.stdout),
                }
            }
        }
        let e = engine_verb(&he, &he.join("state"), &cwd, &av, now, None, &[extra.clone(), vec![("PATH", nonode.as_str())]].concat());
        let log = last_log(&he.join("state"));
        assert_eq!(log["result"] == "native", c.native, "{}: expected native={} but the engine logged {log} (stdout {})", c.name, c.native, e.stdout);
        if c.native {
            native += 1;
            assert_eq!(e.code, n.code, "{}: exit code differs", c.name);
            assert_eq!(canon_out(&he, &e.stdout, &[]), canon_out(&hn, &n.stdout, &[]), "{}: stdout differs", c.name);
            assert_same_homes(c.name, &hn, &he, &before_n, &before_e, &fx.repo_key, "node vs engine");
        } else {
            deferred += 1;
            assert_eq!(e.code, 69, "{}: no Node to hand the verb to, the engine is unable (69, a visible error)", c.name);
            let (pre_tree, pre_db) = (tree(&hd), store_dump(&hd, &fx.repo_key));
            let d = engine_verb(&hd, &hd.join("state"), &cwd, &av, now, None, &[extra.clone(), vec![("PATH", nonode.as_str())]].concat());
            assert_eq!(d.code, 69, "{}: a deferral exits 69 (exit_unable), got {} / {}", c.name, d.code, d.stdout);
            assert!(d.stdout.is_empty(), "{}: nothing is printed on a deferral: {}", c.name, d.stdout);
            assert!(pre_tree == tree(&hd) && pre_db == store_dump(&hd, &fx.repo_key), "{}: deferral wrote", c.name);
        }
    }
    eprintln!("{tag} parity: {} cases, {native} answered by the engine and identical to Node, {deferred} deferred with nothing written", list.len());
}

#[test]
fn inbox_count_read_peek_and_ack_match_node_byte_for_byte_and_defer_without_writing() {
    if !node_sqlite_available() {
        eprintln!("SKIPPED: Node with node:sqlite is not available, so there is no Node writer to compare with");
        return;
    }
    let fx = fixture("ic");
    let list = cases(&fx).into_iter().filter(|c| matches!(c.argv.get(1).map(String::as_str), Some("count" | "read" | "peek-primary" | "ack" | "pull"))).collect();
    run_case_list("count+read+peek+ack", list, &fx);
}

/// A receipt Node files for a union partition carries an `nd` op; `inbox ack-primary` applies it natively (the NDJSON position and
/// the descriptor's cursor file), with Node's own output, store, cursor files and journal.
#[test]
fn ack_primary_applies_the_ndjson_op_of_a_receipt_like_node() {
    if !node_sqlite_available() {
        eprintln!("SKIPPED: Node with node:sqlite is not available, so there is no Node writer to compare with");
        return;
    }
    let fx = fixture("ican");
    let nonode = no_node_path(&fx.root);
    let list: Vec<Case> = cases(&fx).into_iter().filter(|c| ["ack-3-ndjson-and-store-unread", "ack-partly-read", "ack-all-read", "ack-empty-inbox-store-rows", "ack-declared-reader"].contains(&c.name)).collect();
    assert!(list.len() >= 4, "{}", list.len());
    for (i, c) in list.iter().enumerate() {
        let now = NOW + i as i64 * 7_919;
        let (hn, he) = (fx.root.join(format!("{}-apn", c.name)), fx.root.join(format!("{}-ape", c.name)));
        for h in [&hn, &he] {
            copy_tree(&fx.seed_home, h);
            seed(h, &fx, c, now);
        }
        let rp = |h: &Path| node_verb(h, &h.join("state"), &fx.child, &["inbox", "read-primary", "child-1"], now, None, &[]);
        let (rn, re) = (rp(&hn), rp(&he));
        let (rid_n, rid_e) = (rid_of(&rn.stdout).expect("a receipt"), rid_of(&re.stdout).expect("a receipt"));
        assert!(rn.stdout.contains("\"ok\":true"), "{}: {}", c.name, rn.stdout);
        let an = node_verb(&hn, &hn.join("state"), &fx.child, &["inbox", "ack-primary", "child-1", "--receipt", &rid_n], now + 1, None, &[]);
        let ae = engine_verb(&he, &he.join("state"), &fx.child, &["inbox", "ack-primary", "child-1", "--receipt", &rid_e], now + 1, None, &[("PATH", nonode.as_str())]);
        assert_eq!(last_log(&he.join("state"))["result"], "native", "{}: the engine did not apply the receipt: {} / {}", c.name, ae.code, ae.stdout);
        assert_eq!(ae.code, an.code, "{}", c.name);
        assert_eq!(canon_out(&he, &ae.stdout, std::slice::from_ref(&rid_e)), canon_out(&hn, &an.stdout, std::slice::from_ref(&rid_n)), "{}: ack output differs", c.name);
        assert_same_homes(c.name, &hn, &he, &[], &[], &fx.repo_key, "after ack-primary");
    }
}

/// The quoted `"ts":"..."` of a central-log entry replaced.
fn regex_ts(t: &str) -> String {
    let mut out = String::new();
    let mut rest = t;
    while let Some(i) = rest.find("\"ts\":\"") {
        out.push_str(&rest[..i + 6]);
        let tail = &rest[i + 6..];
        let end = tail[1..].find('"').map_or(tail.len(), |e| e + 2);
        out.push_str("\"T\"");
        rest = &tail[end..];
    }
    out.push_str(rest);
    out
}
