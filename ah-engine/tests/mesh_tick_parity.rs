//! `inbox tick <id> --quiet` parity: `ah-engine mesh inbox tick ...` (mesh.engine_writes = on) against
//! `node scripts/devswarm.js inbox tick ...` on identical scratch homes.
//!
//! Every case builds ONE seeded scratch home (the D45 fixture: a real git repo with a linked child worktree, a store
//! written by Node's own `devswarm-store.js`), applies a case spec to it with Node's own code (`ack_seed.js` for reader
//! cursors, descriptors and sessions, `union_seed.js` for NDJSON inbox files and store rows), copies it three times and runs
//! Node on the first copy, the engine on the second and the engine with NO Node on PATH on the third.
//!
//! * a `native` case: the engine answers itself; stdout, the exit code, every store table and every file of the home tree
//!   (the wake-tick marker, the refreshed heartbeat, the cron-found-mail file) are byte-identical to Node's, and the
//!   detached background run of Node on a scratch copy reaches the same verdict (`mesh-verify.jsonl`);
//! * a `defer` case: the engine must write NOTHING and exit 75 when it cannot run Node, and hand the verb to Node
//!   otherwise (exit 75 means "deferred, nothing written").
#![allow(clippy::unwrap_used, clippy::expect_used)] // a test crate: a panic is the failure report, and E2 exempts tests
use serde_json::{Value, json};
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
    /// Runs after seeding, on each of the three homes (a lock file, an old marker, a removed heartbeat...).
    fixup: Fixup,
    native: bool,
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

fn line(h_field: Option<&str>, created: i64, msg: &str) -> String {
    match h_field {
        Some(x) => json!({"_h": x, "fromBranch": "b", "message": msg, "createdAt": created, "status": "new"}).to_string(),
        None => json!({"fromBranch": "b", "message": msg, "createdAt": created}).to_string(),
    }
}

fn tick_argv(id: &str, more: &[&str]) -> Vec<String> {
    let mut v: Vec<String> = vec!["inbox".into(), "tick".into(), id.into()];
    v.extend(more.iter().map(|x| (*x).to_string()));
    v
}

fn quiet(id: &str) -> Vec<String> {
    tick_argv(id, &["--quiet"])
}

fn devswarm(h: &Path) -> PathBuf {
    h.join(".anti-hall").join("devswarm")
}

/// A wake-watch lock: alive (this process) and fresh by default.
fn lock(h: &Path, id: &str, ts: i64, pid: i64) {
    let d = devswarm(h).join("locks");
    fs::create_dir_all(&d).unwrap();
    fs::write(d.join(format!("wake-watch-{id}.lock")), json!({"pid": pid, "ts": ts, "version": "x"}).to_string()).unwrap();
}

fn live_lock() -> Fixup {
    Box::new(|h, now| lock(h, "child-1", now - 1000, i64::from(std::process::id())))
}

fn with_lock(more: impl Fn(&Path, i64) + 'static) -> Fixup {
    Box::new(move |h, now| {
        lock(h, "child-1", now - 1000, i64::from(std::process::id()));
        more(h, now);
    })
}

fn put(h: &Path, rel: &str, text: &str) {
    let p = devswarm(h).join(rel);
    fs::create_dir_all(p.parent().unwrap()).unwrap();
    fs::write(p, text).unwrap();
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

fn normalized(home: &Path, bytes: &[u8]) -> Vec<u8> {
    String::from_utf8_lossy(bytes).replace(&home.to_string_lossy().to_string(), "<HOME>").into_bytes()
}

fn tree(home: &Path) -> std::collections::BTreeMap<String, Vec<u8>> {
    home_files(home).into_iter().map(|(k, v)| (k, normalized(home, &v))).collect()
}

fn assert_same_home(name: &str, a: &Path, b: &Path, key: &str, what: &str) {
    let db = |h: &Path| h.join(".anti-hall/devswarm/store").join(key).join("devswarm.db");
    if db(a).is_file() && db(b).is_file() {
        let one = |p: &Path| {
            let bytes = fs::read(p).unwrap();
            if bytes.starts_with(b"SQLite format 3\0") { raw_dump(p) } else { format!("not a database: {bytes:?}") }
        };
        let (da, dbb) = (one(&db(a)), one(&db(b)));
        assert!(da == dbb, "{name}: {what}: store differs: {}", first_diff(&da, &dbb));
    }
    let (fa, fb) = (tree(a), tree(b));
    let ka: Vec<&String> = fa.keys().collect();
    let kb: Vec<&String> = fb.keys().collect();
    assert_eq!(ka, kb, "{name}: {what}: home tree file set differs");
    for (k, v) in &fa {
        assert!(fb[k] == *v, "{name}: {what}: {k} differs:\n a: {}\n b: {}", String::from_utf8_lossy(v), String::from_utf8_lossy(&fb[k]));
    }
}

fn store_dump(home: &Path, key: &str) -> String {
    let db = home.join(".anti-hall/devswarm/store").join(key).join("devswarm.db");
    if db.is_file() { raw_dump(&db) } else { String::new() }
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

fn cases(fx: &Fx) -> Vec<Case> {
    let wt = fx.child.clone();
    let pid = i64::from(std::process::id());
    let d_inbox = {
        let wt = wt.clone();
        move |h: &Path| vec![desc(h, "child-1", Some("inbox/child-1.ndjson"), Some("cursors-nd/child-1.txt"), &wt)]
    };
    let none: fn() -> Spec = || Box::new(|_| json!({}));
    let l1 = line(Some("native:aaa"), 1_794_999_900_000, "first native");
    let l2 = line(Some("native:bbb"), 1_794_999_940_000, "second native");
    let l3 = line(None, 1_794_999_950_000, "legacy line without hash");
    let text3 = format!("{l1}\n{l2}\n{l3}\n");
    let big_cron: String = (0..1005).map(|i| format!("{{\"ts\":{i},\"id\":\"x\",\"unreadTotal\":1}}\n")).collect();
    let wt2 = wt.clone();
    let wt3 = wt.clone();
    let session = json!({"sessions": [{"pid": pid, "startedAt": OLD}]});
    let own_reader = format!("h:{pid}:{OLD}");
    vec![
        Case {
            name: "quiet-nothing-unread",
            cwd: "child",
            argv: quiet("child-1"),
            extra: vec![],
            ack: ack(floors("child-1", 2, 0), d_inbox.clone()),
            union: inbox(String::new()),
            fixup: live_lock(),
            native: true,
            expect: vec!["tick child-1: unread 0, known true, meshGap false, watcherArmed true"],
        },
        Case {
            name: "ndjson-unread-3-and-cron-found-mail",
            cwd: "child",
            argv: quiet("child-1"),
            extra: vec![],
            ack: ack(floors("child-1", 2, 0), d_inbox.clone()),
            union: inbox(text3.clone()),
            fixup: live_lock(),
            native: true,
            expect: vec!["unread 3, known true"],
        },
        Case {
            name: "store-unread-2",
            cwd: "child",
            argv: quiet("child-1"),
            extra: vec![],
            ack: ack(floors("child-1", 0, 0), d_inbox.clone()),
            union: inbox(String::new()),
            fixup: live_lock(),
            native: true,
            expect: vec!["unread 2, known true"],
        },
        Case {
            name: "both-channels-with-nd-floor",
            cwd: "child",
            argv: quiet("child-1"),
            extra: vec![],
            ack: ack(floors("child-1", 1, 1), d_inbox.clone()),
            union: inbox(text3.clone()),
            fixup: live_lock(),
            native: true,
            expect: vec!["unread"],
        },
        Case {
            name: "own-reader-rows-override-the-floor",
            cwd: "child",
            argv: quiet("child-1"),
            extra: vec![],
            ack: {
                let own = own_reader.clone();
                let session = session.clone();
                let d = d_inbox.clone();
                let mut rows = floors("child-1", 2, 0);
                rows.push(row("child-1", "store", &own, 0));
                rows.push(row("child-1", "nd", &own, 1));
                Box::new(move |h| {
                    let mut v = json!({"rows": rows.clone(), "descriptors": d(h)});
                    v["sessions"] = session["sessions"].clone();
                    v
                })
            },
            union: inbox(text3.clone()),
            fixup: live_lock(),
            native: true,
            expect: vec!["unread 4, known true"],
        },
        Case {
            name: "marker-seq-is-carried",
            cwd: "child",
            argv: quiet("child-1"),
            extra: vec![],
            ack: ack(floors("child-1", 2, 0), d_inbox.clone()),
            union: inbox(String::new()),
            fixup: with_lock(|h, _| put(h, "wake-tick/child-1.json", "{\"ts\":1,\"seq\":7,\"unreadTotal\":0}")),
            native: true,
            expect: vec!["unread 0"],
        },
        Case {
            name: "marker-seq-string-and-fraction",
            cwd: "child",
            argv: quiet("child-1"),
            extra: vec![],
            ack: ack(floors("child-1", 2, 0), d_inbox.clone()),
            union: inbox(String::new()),
            fixup: with_lock(|h, _| put(h, "wake-tick/child-1.json", "{\"seq\":\"2.5\"}")),
            native: true,
            expect: vec!["unread 0"],
        },
        Case {
            name: "marker-seq-garbage-is-zero",
            cwd: "child",
            argv: quiet("child-1"),
            extra: vec![],
            ack: ack(floors("child-1", 2, 0), d_inbox.clone()),
            union: inbox(String::new()),
            fixup: with_lock(|h, _| put(h, "wake-tick/child-1.json", "{\"seq\":\"abc\"}")),
            native: true,
            expect: vec!["unread 0"],
        },
        Case {
            name: "marker-not-json",
            cwd: "child",
            argv: quiet("child-1"),
            extra: vec![],
            ack: ack(floors("child-1", 2, 0), d_inbox.clone()),
            union: inbox(String::new()),
            fixup: with_lock(|h, _| put(h, "wake-tick/child-1.json", "not json at all")),
            native: true,
            expect: vec!["unread 0"],
        },
        Case {
            name: "heartbeat-absent-minimal-record",
            cwd: "child",
            argv: quiet("child-1"),
            extra: vec![],
            ack: ack(floors("child-1", 2, 0), d_inbox.clone()),
            union: inbox(String::new()),
            fixup: with_lock(|h, _| fs::remove_file(devswarm(h).join("heartbeats/child-1.json")).unwrap()),
            native: true,
            expect: vec!["unread 0"],
        },
        Case {
            name: "heartbeat-existing-keeps-its-fields",
            cwd: "child",
            argv: quiet("child-1"),
            extra: vec![],
            ack: ack(floors("child-1", 2, 0), d_inbox.clone()),
            union: inbox(String::new()),
            fixup: with_lock(|h, _| {
                put(h, "heartbeats/child-1.json", "{\"phase\":\"build\",\"ts\":5,\"id\":\"child-1\",\"wip\":[\"a\"],\"version\":\"0.0.1\"}")
            }),
            native: true,
            expect: vec!["unread 0"],
        },
        Case {
            name: "heartbeat-without-ts-gets-the-keys-appended",
            cwd: "child",
            argv: quiet("child-1"),
            extra: vec![],
            ack: ack(floors("child-1", 2, 0), d_inbox.clone()),
            union: inbox(String::new()),
            fixup: with_lock(|h, _| put(h, "heartbeats/child-1.json", "{\"b\":1,\"a\":2,\"7\":3}")),
            native: true,
            expect: vec!["unread 0"],
        },
        Case {
            name: "heartbeat-invalid-json-is-replaced",
            cwd: "child",
            argv: quiet("child-1"),
            extra: vec![],
            ack: ack(floors("child-1", 2, 0), d_inbox.clone()),
            union: inbox(String::new()),
            fixup: with_lock(|h, _| put(h, "heartbeats/child-1.json", "{broken")),
            native: true,
            expect: vec!["unread 0"],
        },
        Case {
            name: "heartbeat-is-a-number-is-replaced",
            cwd: "child",
            argv: quiet("child-1"),
            extra: vec![],
            ack: ack(floors("child-1", 2, 0), d_inbox.clone()),
            union: inbox(String::new()),
            fixup: with_lock(|h, _| put(h, "heartbeats/child-1.json", "5")),
            native: true,
            expect: vec!["unread 0"],
        },
        Case {
            name: "cron-found-mail-is-capped",
            cwd: "child",
            argv: quiet("child-1"),
            extra: vec![],
            ack: ack(floors("child-1", 2, 0), d_inbox.clone()),
            union: inbox(text3.clone()),
            fixup: with_lock(move |h, _| put(h, "cron-found-mail.jsonl", &big_cron)),
            native: true,
            expect: vec!["unread 3"],
        },
        Case {
            name: "cron-found-mail-without-trailing-newline",
            cwd: "child",
            argv: quiet("child-1"),
            extra: vec![],
            ack: ack(floors("child-1", 2, 0), d_inbox.clone()),
            union: inbox(text3.clone()),
            fixup: with_lock(|h, _| put(h, "cron-found-mail.jsonl", "{\"ts\":1}\n\n{\"ts\":2}")),
            native: true,
            expect: vec!["unread 3"],
        },
        Case {
            name: "closed-wal-is-quiet",
            cwd: "child",
            argv: quiet("child-1"),
            extra: vec![],
            ack: ack(floors("child-1", 2, 0), d_inbox.clone()),
            union: inbox(String::new()),
            fixup: with_lock(|h, _| {
                put(
                    h,
                    "wal/inbox-x.ndjson",
                    "{\"t\":\"batch\",\"e\":\"e1\",\"ts\":1,\"raw\":\"r\"}\nnot json\n\n{\"t\":\"done\",\"e\":\"e1\",\"ts\":2}\n{\"t\":\"batch\",\"e\":\"e2\",\"ts\":1,\"raw\":\"r\"}\n{\"t\":\"quarantine\",\"e\":\"e2\"}\n",
                );
                put(h, "wal/notes.txt", "ignored");
            }),
            native: true,
            expect: vec!["unread 0"],
        },
        Case {
            name: "empty-wal-and-spill-dirs",
            cwd: "child",
            argv: quiet("child-1"),
            extra: vec![],
            ack: ack(floors("child-1", 2, 0), d_inbox.clone()),
            union: inbox(String::new()),
            fixup: with_lock(|h, _| {
                fs::create_dir_all(devswarm(h).join("wal")).unwrap();
                fs::create_dir_all(devswarm(h).join("wal-spill")).unwrap();
            }),
            native: true,
            expect: vec!["unread 0"],
        },
        Case {
            name: "lock-without-pid-is-armed-while-fresh",
            cwd: "child",
            argv: quiet("child-1"),
            extra: vec![],
            ack: ack(floors("child-1", 2, 0), d_inbox.clone()),
            union: inbox(String::new()),
            fixup: Box::new(|h, now| put(h, "locks/wake-watch-child-1.lock", &json!({"ts": now - 119_000}).to_string())),
            native: true,
            expect: vec!["watcherArmed true"],
        },
        Case {
            name: "lock-ts-as-numeric-string",
            cwd: "child",
            argv: quiet("child-1"),
            extra: vec![],
            ack: ack(floors("child-1", 2, 0), d_inbox.clone()),
            union: inbox(String::new()),
            fixup: Box::new(|h, now| put(h, "locks/wake-watch-child-1.lock", &json!({"ts": (now - 5).to_string(), "pid": 1}).to_string())),
            native: true,
            expect: vec!["watcherArmed true"],
        },
        Case {
            name: "lock-exactly-at-the-stale-limit",
            cwd: "child",
            argv: quiet("child-1"),
            extra: vec![],
            ack: ack(floors("child-1", 2, 0), d_inbox.clone()),
            union: inbox(String::new()),
            fixup: Box::new(move |h, now| lock(h, "child-1", now - 120_000, pid)),
            native: true,
            expect: vec!["watcherArmed true"],
        },
        // ---- deferrals: nothing may be written ----
        Case {
            name: "child-flag",
            cwd: "child",
            argv: tick_argv("child-1", &["--quiet", "--child"]),
            extra: vec![],
            ack: ack(floors("child-1", 2, 0), d_inbox.clone()),
            union: inbox(String::new()),
            fixup: live_lock(),
            native: false,
            expect: vec!["tick child-1"],
        },
        Case {
            name: "json-form",
            cwd: "child",
            argv: tick_argv("child-1", &[]),
            extra: vec![],
            ack: ack(floors("child-1", 2, 0), d_inbox.clone()),
            union: inbox(String::new()),
            fixup: live_lock(),
            native: false,
            expect: vec!["\"action\":\"tick\""],
        },
        Case {
            name: "quiet-and-json",
            cwd: "child",
            argv: tick_argv("child-1", &["--quiet", "--json"]),
            extra: vec![],
            ack: ack(floors("child-1", 2, 0), d_inbox.clone()),
            union: inbox(String::new()),
            fixup: live_lock(),
            native: false,
            expect: vec!["\"action\":\"tick\""],
        },
        Case {
            name: "no-lock-not-armed",
            cwd: "child",
            argv: quiet("child-1"),
            extra: vec![],
            ack: ack(floors("child-1", 2, 0), d_inbox.clone()),
            union: inbox(String::new()),
            fixup: Box::new(|_, _| {}),
            native: false,
            expect: vec!["tick child-1"],
        },
        Case {
            name: "stale-lock",
            cwd: "child",
            argv: quiet("child-1"),
            extra: vec![],
            ack: ack(floors("child-1", 2, 0), d_inbox.clone()),
            union: inbox(String::new()),
            fixup: Box::new(move |h, now| lock(h, "child-1", now - 121_000, pid)),
            native: false,
            expect: vec!["tick child-1"],
        },
        Case {
            name: "lock-one-ms-past-the-stale-limit",
            cwd: "child",
            argv: quiet("child-1"),
            extra: vec![],
            ack: ack(floors("child-1", 2, 0), d_inbox.clone()),
            union: inbox(String::new()),
            fixup: Box::new(move |h, now| lock(h, "child-1", now - 120_001, pid)),
            native: false,
            expect: vec!["tick child-1"],
        },
        Case {
            name: "lock-of-a-dead-process",
            cwd: "child",
            argv: quiet("child-1"),
            extra: vec![],
            ack: ack(floors("child-1", 2, 0), d_inbox.clone()),
            union: inbox(String::new()),
            fixup: Box::new(|h, now| lock(h, "child-1", now - 1000, 4_000_000)),
            native: false,
            expect: vec!["tick child-1"],
        },
        Case {
            name: "lock-is-not-json",
            cwd: "child",
            argv: quiet("child-1"),
            extra: vec![],
            ack: ack(floors("child-1", 2, 0), d_inbox.clone()),
            union: inbox(String::new()),
            fixup: Box::new(|h, _| put(h, "locks/wake-watch-child-1.lock", "garbage")),
            native: false,
            expect: vec!["tick child-1"],
        },
        Case {
            name: "wal-batch-pending",
            cwd: "child",
            argv: quiet("child-1"),
            extra: vec![],
            ack: ack(floors("child-1", 2, 0), d_inbox.clone()),
            union: inbox(String::new()),
            fixup: with_lock(|h, _| put(h, "wal/inbox-x.ndjson", "{\"t\":\"batch\",\"e\":\"e1\",\"ts\":1,\"raw\":\"r\"}\n")),
            native: false,
            expect: vec!["tick child-1"],
        },
        Case {
            name: "wal-spill-present",
            cwd: "child",
            argv: quiet("child-1"),
            extra: vec![],
            ack: ack(floors("child-1", 2, 0), d_inbox.clone()),
            union: inbox(String::new()),
            fixup: with_lock(|h, _| put(h, "wal-spill/inbox-x/e1.json", "{}")),
            native: false,
            expect: vec!["tick child-1"],
        },
        Case {
            name: "roster-setting-in-the-environment",
            cwd: "child",
            argv: quiet("child-1"),
            extra: vec![("ANTIHALL_DEVSWARM_TICK_ROSTER_EVERY", "0".into())],
            ack: ack(floors("child-1", 2, 0), d_inbox.clone()),
            union: inbox(String::new()),
            fixup: live_lock(),
            native: false,
            expect: vec!["tick child-1"],
        },
        Case {
            name: "roster-setting-in-settings-json",
            cwd: "child",
            argv: quiet("child-1"),
            extra: vec![],
            ack: ack(floors("child-1", 2, 0), d_inbox.clone()),
            union: inbox(String::new()),
            fixup: with_lock(|h, _| {
                fs::write(h.join(".anti-hall").join("settings.json"), "{\"mesh\":{\"engine_writes\":\"on\"},\"devswarm\":{\"tickRosterEvery\":3}}\n").unwrap()
            }),
            native: false,
            expect: vec!["tick child-1"],
        },
        Case {
            name: "no-descriptor",
            cwd: "child",
            argv: quiet("child-1"),
            extra: vec![],
            ack: Box::new(|_| json!({"rows": floors("child-1", 2, 0)})),
            union: none(),
            fixup: live_lock(),
            native: false,
            expect: vec!["ok:false"],
        },
        Case {
            name: "descriptor-without-inbox",
            cwd: "child",
            argv: quiet("child-1"),
            extra: vec![],
            ack: ack(floors("child-1", 2, 0), {
                let wt = wt2.clone();
                move |h| vec![desc(h, "child-1", None, None, &wt)]
            }),
            union: none(),
            fixup: live_lock(),
            native: false,
            expect: vec!["ok:false"],
        },
        Case {
            name: "floor-rows-missing-needs-the-import",
            cwd: "child",
            argv: quiet("child-1"),
            extra: vec![],
            ack: ack(vec![], d_inbox.clone()),
            union: inbox(text3.clone()),
            fixup: live_lock(),
            native: false,
            expect: vec!["tick child-1"],
        },
        Case {
            name: "inbox-missing-count-unknown",
            cwd: "child",
            argv: quiet("child-1"),
            extra: vec![],
            ack: ack(floors("child-1", 2, 0), d_inbox.clone()),
            union: none(),
            fixup: live_lock(),
            native: false,
            expect: vec!["known false"],
        },
        Case {
            name: "mesh-group-of-two-rows",
            cwd: "child",
            argv: quiet("child-1"),
            extra: vec![],
            ack: Box::new({
                let wt = wt3.clone();
                let d = d_inbox.clone();
                move |h| json!({"rows": floors("child-1", 2, 0), "descriptors": d(h), "registry": [{"id": "child-1b", "worktreePath": wt.to_string_lossy(), "sessionId": "child-1b"}]})
            }),
            union: inbox(String::new()),
            fixup: live_lock(),
            native: false,
            expect: vec!["tick child-1"],
        },
        Case {
            name: "child-addressing-another-id",
            cwd: "child",
            argv: quiet("child-1"),
            extra: vec![("DEVSWARM_BUILDER_ID", "child-2".into()), ("DEVSWARM_SOURCE_BRANCH", "child".into())],
            ack: ack(floors("child-1", 2, 0), d_inbox.clone()),
            union: inbox(String::new()),
            fixup: live_lock(),
            native: false,
            expect: vec!["tick child-1"],
        },
        Case {
            name: "unsafe-id",
            cwd: "child",
            argv: quiet("../x"),
            extra: vec![],
            ack: ack(floors("child-1", 2, 0), d_inbox.clone()),
            union: inbox(String::new()),
            fixup: live_lock(),
            native: false,
            expect: vec!["ok:false"],
        },
        Case {
            name: "extra-positional",
            cwd: "child",
            argv: tick_argv("child-1", &["extra", "--quiet"]),
            extra: vec![],
            ack: ack(floors("child-1", 2, 0), d_inbox.clone()),
            union: inbox(String::new()),
            fixup: live_lock(),
            native: false,
            expect: vec!["tick child-1"],
        },
        Case {
            name: "heartbeat-record-is-an-array",
            cwd: "child",
            argv: quiet("child-1"),
            extra: vec![],
            ack: ack(floors("child-1", 2, 0), d_inbox.clone()),
            union: inbox(String::new()),
            fixup: with_lock(|h, _| put(h, "heartbeats/child-1.json", "[1,2]")),
            native: false,
            expect: vec!["tick child-1"],
        },
    ]
}

#[test]
fn tick_matches_node_byte_for_byte_and_defers_without_writing() {
    if !node_sqlite_available() {
        eprintln!("SKIPPED: Node with node:sqlite is not available, so there is no Node writer to compare with");
        return;
    }
    let fx = fixture("tick");
    let nonode = no_node_path(&fx.root);
    let list = cases(&fx);
    let (mut native, mut deferred) = (0, 0);
    for (i, c) in list.iter().enumerate() {
        let now = NOW + i as i64 * 7_919;
        let cwd: PathBuf = if c.cwd == "main" { fx.main.clone() } else { fx.child.clone() };
        let (hn, he, hd) = (fx.root.join(format!("{}-node", c.name)), fx.root.join(format!("{}-engine", c.name)), fx.root.join(format!("{}-defer", c.name)));
        for h in [&hn, &he, &hd] {
            copy_tree(&fx.seed_home, h);
            seed(h, &fx, c, now);
        }
        let av: Vec<&str> = c.argv.iter().map(String::as_str).collect();
        let extra: Vec<(&str, &str)> = c.extra.iter().map(|(k, v)| (*k, v.as_str())).collect();
        let n = node_verb(&hn, &hn.join("state"), &cwd, &av, now, None, &extra);
        for want in &c.expect {
            assert!(n.stdout.contains(want), "{}: Node's output lacks {want:?}: {}", c.name, n.stdout);
        }
        let e = engine_verb(&he, &he.join("state"), &cwd, &av, now, None, &extra);
        let log = last_log(&he.join("state"));
        assert_eq!(log["result"] == "native", c.native, "{}: expected native={} but the engine logged {log}", c.name, c.native);
        if c.native {
            native += 1;
            assert_eq!(log["verb"], "InboxTick", "{}: telemetry names the verb", c.name);
            assert_eq!((e.code, &e.stdout), (n.code, &n.stdout), "{}: stdout/exit differ", c.name);
            assert_same_home(c.name, &hn, &he, &fx.repo_key, "node vs engine");
            let v = verify_line(&he.join("state"));
            assert_eq!(v["result"], "match", "{}: the background Node shadow disagrees: {v}", c.name);
        } else {
            deferred += 1;
            assert_eq!(e.code, n.code, "{}: exit code of the fallback", c.name);
            // the seeded home itself, before the engine runs (seeding twice stamps different wall-clock times into the registry)
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
    eprintln!("tick parity: {} cases, {native} answered by the engine and identical to Node, {deferred} deferred with nothing written", list.len());
    assert!(native >= 21 && deferred >= 21, "{native} native, {deferred} deferred");
}
