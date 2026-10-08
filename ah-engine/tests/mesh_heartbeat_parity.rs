//! `heartbeat` parity (and, through it, the NDJSON + store unread union): `ah-engine mesh heartbeat ...`
//! (mesh.engine_writes = on) against `node scripts/devswarm.js heartbeat ...` on identical scratch homes.
//!
//! Every case builds ONE seeded scratch home (the D45 fixture: a real git repo with a linked child worktree, a store
//! written by Node's own `devswarm-store.js`), applies a case spec to it with Node's own code (`ack_seed.js` for reader
//! cursors and descriptors, `union_seed.js` for NDJSON inbox files, store rows and files), copies it three times and runs
//! Node on the first copy, the engine on the second and the engine with NO Node on PATH on the third.
//!
//! * a `native` case: the engine answers itself; stdout, the exit code, every store table and every file of the home tree
//!   (the heartbeat record, the liveness verdict, the descriptors) are byte-identical to Node's;
//! * a `defer` case: the engine must write NOTHING and exit 75 when it cannot run Node, and hand the verb to Node
//!   otherwise (exit 75 means "deferred, nothing written");
//! * the fault cases corrupt an input (an unreadable inbox, a non-database store file, a cursor file of the wrong shape)
//!   and still require the same two outcomes, so a fault is either reproduced exactly or left to Node untouched.
#![allow(clippy::unwrap_used, clippy::expect_used)] // a test crate: a panic is the failure report, and E2 exempts tests
use serde_json::{Value, json};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

#[path = "mesh_write_support/fx.rs"]
mod fx;
use fx::*;

const OLD: i64 = 1_790_000_000_000;

type Spec = Box<dyn Fn(&Path) -> Value>;

struct Case {
    name: &'static str,
    cwd: &'static str,
    argv: Vec<String>,
    extra: Vec<(&'static str, String)>,
    /// `ack_seed.js` spec (reader-cursor rows, descriptors, cursor files).
    ack: Spec,
    /// `union_seed.js` spec (raw files, store rows).
    union: Spec,
    native: bool,
    /// Substrings the (Node) stdout must contain, so a case cannot pass by both sides refusing alike.
    expect: Vec<&'static str>,
}

fn row(partition: &str, ns: &str, reader: &str, value: i64) -> Value {
    json!({"partition": partition, "ns": ns, "reader": reader, "value": value, "updatedAt": OLD})
}

fn floors(partition: &str, store: i64, nd: i64) -> Vec<Value> {
    vec![row(partition, "store", "#floor", store), row(partition, "nd", "#floor", nd)]
}

fn none() -> Spec {
    Box::new(|_| json!({}))
}

fn ack(rows: Vec<Value>, descriptors: impl Fn(&Path) -> Vec<Value> + 'static, cursor_files: Vec<Value>) -> Spec {
    Box::new(move |h| json!({"rows": rows.clone(), "descriptors": descriptors(h), "cursorFiles": cursor_files.clone()}))
}

fn files(f: impl Fn(&Path) -> Vec<Value> + 'static) -> Spec {
    Box::new(move |h| json!({"files": f(h)}))
}

fn argv(id: &str, more: &[&str]) -> Vec<String> {
    let mut v: Vec<String> = vec!["heartbeat".into(), id.into()];
    v.extend(more.iter().map(|x| (*x).to_string()));
    v
}

/// File bytes with the scratch home's own path masked (descriptors name files under it).
fn normalized(home: &Path, bytes: &[u8]) -> Vec<u8> {
    String::from_utf8_lossy(bytes).replace(&home.to_string_lossy().to_string(), "<HOME>").into_bytes()
}

/// A PATH with `git` and `ps` only, so the engine cannot start Node.
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

fn seed(h: &Path, fx: &Fx, c: &Case) {
    run_seed("ack_seed.js", h, fx, &(c.ack)(h));
    run_seed("union_seed.js", h, fx, &(c.union)(h));
    fs::create_dir_all(h.join(".anti-hall")).unwrap();
    fs::write(h.join(".anti-hall").join("settings.json"), "{\"mesh\":{\"engine_writes\":\"on\"}}\n").unwrap();
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

/// The detached verifier's record (`mesh-verify.jsonl`), waited for up to 30 s.
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

fn cases(fx: &Fx) -> Vec<Case> {
    let s = |x: &str| x.to_string();
    let app_db = fx.root.join("app.db").to_string_lossy().to_string();
    fs::write(&app_db, b"").unwrap();
    let child_wt = fx.child.clone();
    let main_wt = fx.main.clone();
    let primary = fx.primary_id.clone();
    let sess = |x: &str| vec!["--session".to_string(), x.to_string()];
    let hb = |id: &str, more: &[&str]| -> Vec<String> {
        let mut v = argv(id, &[]);
        v.extend(sess("s1"));
        v.extend(more.iter().map(|x| (*x).to_string()));
        v
    };
    let wt = child_wt.clone();
    // a descriptor for child-1 with a NDJSON inbox of `n` lines under the home
    let d_inbox = {
        let wt = wt.clone();
        move |h: &Path| vec![desc(h, "child-1", Some("inbox/child-1.ndjson"), Some("cursors-nd/child-1.txt"), &wt)]
    };
    let d_plain = {
        let wt = wt.clone();
        move |h: &Path| vec![desc(h, "child-1", None, None, &wt)]
    };
    let inbox_file = |text: String| {
        files(move |_| vec![json!({"rel": "inbox/child-1.ndjson", "text": text.clone()}), json!({"rel": "cursors-nd/child-1.txt", "text": "0"})])
    };
    let l1 = line(Some("native:aaa"), 1_794_999_900_000, "first native");
    let l2 = line(Some("native:bbb"), 1_794_999_940_000, "second native");
    let l3 = line(None, 1_794_999_950_000, "legacy line without hash");
    let text3 = format!("{l1}\n{l2}\n{l3}\n");
    let text3b = text3.clone();
    let text3c = text3.clone();
    let text_blank = format!("{l1}\n\n   \n\r\n{l2}\r\n{l3}\n");
    let l3_for_body = l3.clone();
    vec![
        Case {
            name: "no-descriptor",
            cwd: "child",
            argv: hb("child-1", &[]),
            extra: vec![],
            ack: none(),
            union: none(),
            native: true,
            expect: vec!["\"action\":\"heartbeat\"", "\"idMismatch\":false"],
        },
        Case {
            name: "no-descriptor-fields",
            cwd: "child",
            argv: hb("child-1", &["--progress", "150", "--phase", "build", "--wip", "a", "--wip", "b c", "--blockers", "none"]),
            extra: vec![],
            ack: none(),
            union: none(),
            native: true,
            expect: vec!["\"progress_pct\":100", "\"phase\":\"build\"", "\"wip\":[\"a\",\"b c\"]"],
        },
        Case {
            name: "progress-negative",
            cwd: "child",
            argv: hb("child-1", &["--progress", "-5"]),
            extra: vec![],
            ack: none(),
            union: none(),
            native: true,
            expect: vec!["\"progress_pct\":0"],
        },
        Case {
            name: "progress-fraction",
            cwd: "child",
            argv: hb("child-1", &["--progress=33.5"]),
            extra: vec![],
            ack: none(),
            union: none(),
            native: true,
            expect: vec!["\"progress_pct\":33.5"],
        },
        Case {
            name: "progress-not-a-number",
            cwd: "child",
            argv: hb("child-1", &["--progress", "abc"]),
            extra: vec![],
            ack: none(),
            union: none(),
            native: true,
            expect: vec!["\"progress_pct\":null"],
        },
        Case {
            name: "progress-empty-is-zero",
            cwd: "child",
            argv: hb("child-1", &["--progress="]),
            extra: vec![],
            ack: none(),
            union: none(),
            native: true,
            expect: vec!["\"progress_pct\":0"],
        },
        Case {
            name: "session-with-unicode-and-quote",
            cwd: "child",
            argv: argv("child-1", &["--session", "s\"é☃", "--phase", "line\nbreak"]),
            extra: vec![],
            ack: none(),
            union: none(),
            native: true,
            expect: vec!["\"sessionId\""],
        },
        Case {
            name: "from-the-primary-checkout",
            cwd: "main",
            argv: hb("child-1", &[]),
            extra: vec![],
            ack: none(),
            union: none(),
            native: true,
            expect: vec!["\"kind\":\"resolved\""],
        },
        Case {
            name: "claude-session-set-child-not-primary",
            cwd: "child",
            argv: hb("child-1", &[]),
            extra: vec![("CLAUDE_CODE_SESSION_ID", s("sess-x"))],
            ack: none(),
            union: none(),
            native: true,
            expect: vec!["\"ok\":true"],
        },
        Case {
            name: "claude-session-set-primary-no-anchor",
            cwd: "main",
            argv: hb("child-1", &[]),
            extra: vec![("CLAUDE_CODE_SESSION_ID", s("sess-x"))],
            ack: none(),
            union: none(),
            native: true,
            expect: vec!["\"ok\":true"],
        },
        Case {
            name: "child-env-same-builder-id",
            cwd: "child",
            argv: hb("child-1", &[]),
            extra: vec![("DEVSWARM_SOURCE_BRANCH", s("feat")), ("DEVSWARM_BUILDER_ID", s("child-1"))],
            ack: none(),
            union: none(),
            native: true,
            expect: vec!["\"idMismatch\":false", "\"kind\":\"resolved\""],
        },
        // ---- descriptor present: the store-only backlog ----
        Case {
            name: "store-only-two-unread-old",
            cwd: "child",
            argv: hb("child-1", &[]),
            extra: vec![],
            ack: ack(floors("child-1", 0, 0), d_plain.clone(), vec![]),
            union: none(),
            native: true,
            expect: vec!["\"ok\":true"],
        },
        Case {
            name: "store-floor-skips-all",
            cwd: "child",
            argv: hb("child-1", &[]),
            extra: vec![],
            ack: ack(floors("child-1", 2, 0), d_plain.clone(), vec![]),
            union: none(),
            native: true,
            expect: vec!["\"ok\":true"],
        },
        Case {
            name: "store-recent-row-not-draining",
            cwd: "child",
            argv: hb("child-1", &[]),
            extra: vec![],
            ack: ack(floors("child-1", 2, 0), d_plain.clone(), vec![]),
            union: Box::new(|_| json!({"mesh": [{"to": "child-1", "from": "p", "ts": 1_794_999_990_000_i64, "hash": "mesh:recent1", "message": "recent"}]})),
            native: true,
            expect: vec!["\"ok\":true"],
        },
        Case {
            name: "store-empty-partition",
            cwd: "child",
            argv: hb("child-1", &[]),
            extra: vec![],
            ack: ack(floors("child-1", 0, 0), d_plain.clone(), vec![]),
            union: none(),
            native: true,
            expect: vec!["\"ok\":true"],
        },
        // ---- NDJSON inbox plus store ----
        Case {
            name: "nd-three-unread",
            cwd: "child",
            argv: hb("child-1", &[]),
            extra: vec![],
            ack: ack(floors("child-1", 2, 0), d_inbox.clone(), vec![json!({"id": "x", "text": "0"})]),
            union: inbox_file(text3.clone()),
            native: true,
            expect: vec!["\"ok\":true"],
        },
        Case {
            name: "nd-floor-skips-two",
            cwd: "child",
            argv: hb("child-1", &[]),
            extra: vec![],
            ack: ack(floors("child-1", 2, 2), d_inbox.clone(), vec![]),
            union: inbox_file(text3b.clone()),
            native: true,
            expect: vec!["\"ok\":true"],
        },
        Case {
            name: "nd-floor-past-the-end",
            cwd: "child",
            argv: hb("child-1", &[]),
            extra: vec![],
            ack: ack(floors("child-1", 2, 99), d_inbox.clone(), vec![]),
            union: inbox_file(text3c.clone()),
            native: true,
            expect: vec!["\"ok\":true"],
        },
        Case {
            name: "nd-blank-and-crlf-lines",
            cwd: "child",
            argv: hb("child-1", &[]),
            extra: vec![],
            ack: ack(floors("child-1", 2, 0), d_inbox.clone(), vec![]),
            union: inbox_file(text_blank),
            native: true,
            expect: vec!["\"ok\":true"],
        },
        Case {
            name: "nd-store-twin-by-embedded-hash",
            cwd: "child",
            argv: hb("child-1", &[]),
            extra: vec![],
            ack: ack(floors("child-1", 2, 0), d_inbox.clone(), vec![]),
            // the store already holds the native-drained twin of line 1 (same _h): counted once
            union: Box::new({
                let text = text3.clone();
                move |_| {
                    json!({
                        "files": [{"rel": "inbox/child-1.ndjson", "text": text.clone()}, {"rel": "cursors-nd/child-1.txt", "text": "0"}],
                        "mesh": [{"to": "child-1", "from": "p", "ts": 1_794_000_000_000_i64, "hash": "native:aaa", "message": "first native"}]
                    })
                }
            }),
            native: true,
            expect: vec!["\"ok\":true"],
        },
        Case {
            name: "nd-store-twin-by-legacy-hash",
            cwd: "child",
            argv: hb("child-1", &[]),
            extra: vec![],
            ack: ack(floors("child-1", 2, 0), d_inbox.clone(), vec![]),
            union: Box::new({
                let text = text3.clone();
                let l3 = l3_for_body.clone();
                move |_| {
                    json!({
                        "files": [{"rel": "inbox/child-1.ndjson", "text": text.clone()}, {"rel": "cursors-nd/child-1.txt", "text": "0"}],
                        "legacy": [{"workspaceId": "child-1", "ts": 1_794_000_000_000_i64, "hash": {"legacyOf": {"id": "child-1", "index": 2, "line": l3}}, "body": l3}]
                    })
                }
            }),
            native: true,
            expect: vec!["\"ok\":true"],
        },
        Case {
            name: "nd-store-twin-by-body",
            cwd: "child",
            argv: hb("child-1", &[]),
            extra: vec![],
            ack: ack(floors("child-1", 2, 0), d_inbox.clone(), vec![]),
            // a migration-skipped line lives in the store under a native: hash, body = the whole physical line; the line covers the
            // FIRST such row (the older), so the survivor is the later one and a wrong draw-down moves the oldest age
            union: Box::new({
                let text = text3.clone();
                let l3 = l3_for_body.clone();
                move |_| {
                    json!({
                        "files": [{"rel": "inbox/child-1.ndjson", "text": text.clone()}, {"rel": "cursors-nd/child-1.txt", "text": "0"}],
                        "legacy": [
                            {"workspaceId": "child-1", "ts": 1_794_100_000_000_i64, "hash": "global-migrate:zzz", "body": l3.clone()},
                            {"workspaceId": "child-1", "ts": 1_794_200_000_000_i64, "hash": "global-migrate:yyy", "body": l3}
                        ]
                    })
                }
            }),
            native: true,
            expect: vec!["\"ok\":true"],
        },
        Case {
            name: "nd-store-row-without-hash-is-never-a-twin",
            cwd: "child",
            argv: hb("child-1", &[]),
            extra: vec![],
            ack: ack(floors("child-1", 2, 0), d_inbox.clone(), vec![]),
            union: Box::new({
                let text = text3.clone();
                move |_| {
                    json!({
                        "files": [{"rel": "inbox/child-1.ndjson", "text": text.clone()}, {"rel": "cursors-nd/child-1.txt", "text": "0"}],
                        "legacy": [{"workspaceId": "child-1", "ts": 1_794_000_000_000_i64, "hash": null, "body": "first native"}]
                    })
                }
            }),
            native: true,
            expect: vec!["\"ok\":true"],
        },
        Case {
            name: "nd-twin-of-a-consumed-line-still-counts-in-the-store",
            cwd: "child",
            argv: hb("child-1", &[]),
            extra: vec![],
            // the NDJSON line is already read (nd floor 3) but its store twin sits past the store cursor: the union counts it
            ack: ack(floors("child-1", 2, 3), d_inbox.clone(), vec![]),
            union: Box::new({
                let text = text3.clone();
                move |_| {
                    json!({
                        "files": [{"rel": "inbox/child-1.ndjson", "text": text.clone()}, {"rel": "cursors-nd/child-1.txt", "text": "3"}],
                        "mesh": [{"to": "child-1", "from": "p", "ts": 1_794_000_000_000_i64, "hash": "native:aaa", "message": "first native"}]
                    })
                }
            }),
            native: true,
            expect: vec!["\"ok\":true"],
        },
        Case {
            name: "nd-cursor-file-json-shape",
            cwd: "child",
            argv: hb("child-1", &[]),
            extra: vec![],
            ack: ack(floors("child-1", 2, 0), d_inbox.clone(), vec![]),
            union: files(move |_| {
                vec![json!({"rel": "inbox/child-1.ndjson", "text": text3.clone()}), json!({"rel": "cursors-nd/child-1.txt", "text": "{\"line\": 1}"})]
            }),
            native: true,
            expect: vec!["\"ok\":true"],
        },
        Case {
            name: "nd-cursor-file-missing",
            cwd: "child",
            argv: hb("child-1", &[]),
            extra: vec![],
            ack: ack(floors("child-1", 2, 0), d_inbox.clone(), vec![]),
            union: files(|_| vec![json!({"rel": "inbox/child-1.ndjson", "text": "{\"message\":\"x\",\"createdAt\":1794999900000}\n"})]),
            native: true,
            expect: vec!["\"ok\":true"],
        },
        Case {
            name: "nd-cursor-file-garbage",
            cwd: "child",
            argv: hb("child-1", &[]),
            extra: vec![],
            ack: ack(floors("child-1", 2, 0), d_inbox.clone(), vec![]),
            union: files(|_| {
                vec![json!({"rel": "inbox/child-1.ndjson", "text": "{\"message\":\"x\"}\n"}), json!({"rel": "cursors-nd/child-1.txt", "text": "not json"})]
            }),
            native: true,
            expect: vec!["\"ok\":true"],
        },
        Case {
            name: "nd-inbox-missing",
            cwd: "child",
            argv: hb("child-1", &[]),
            extra: vec![],
            ack: ack(floors("child-1", 0, 0), d_inbox.clone(), vec![]),
            union: files(|_| vec![json!({"rel": "cursors-nd/child-1.txt", "text": "0"})]),
            native: true,
            expect: vec!["\"ok\":true"],
        },
        Case {
            name: "nd-cursor-file-is-the-shared-store-cursor",
            cwd: "child",
            argv: hb("child-1", &[]),
            extra: vec![],
            ack: ack(
                floors("child-1", 2, 0),
                {
                    let wt = wt.clone();
                    move |h| vec![desc(h, "child-1", Some("inbox/child-1.ndjson"), Some(".anti-hall/devswarm/cursors/child-1.json"), &wt)]
                },
                vec![json!({"id": "child-1", "text": "3"})],
            ),
            union: files(|_| vec![json!({"rel": "inbox/child-1.ndjson", "text": "{\"message\":\"x\",\"createdAt\":1794999900000}\n{\"message\":\"y\"}\n"})]),
            native: true,
            expect: vec!["\"ok\":true"],
        },
        Case {
            name: "descriptor-without-worktree-is-ndjson-only",
            cwd: "child",
            argv: hb("child-1", &[]),
            extra: vec![],
            ack: ack(
                floors("child-1", 0, 0),
                |h| {
                    vec![
                        json!({"id": "child-1", "inboxPath": h.join("inbox/child-1.ndjson").to_string_lossy(), "cursorPath": h.join("cursors-nd/child-1.txt").to_string_lossy()}),
                    ]
                },
                vec![],
            ),
            union: files(|_| {
                vec![
                    json!({"rel": "inbox/child-1.ndjson", "text": "{\"message\":\"x\"}\n{\"message\":\"y\"}\n"}),
                    json!({"rel": "cursors-nd/child-1.txt", "text": "1"}),
                ]
            }),
            native: true,
            expect: vec!["\"ok\":true"],
        },
        Case {
            name: "descriptor-worktree-without-a-store",
            cwd: "child",
            argv: hb("child-1", &[]),
            extra: vec![],
            ack: ack(
                vec![],
                |h| {
                    vec![
                        json!({"id": "child-1", "worktreePath": h.join("not-a-repo").to_string_lossy(), "inboxPath": h.join("inbox/child-1.ndjson").to_string_lossy(), "cursorPath": h.join("cursors-nd/child-1.txt").to_string_lossy()}),
                    ]
                },
                vec![],
            ),
            union: files(|_| {
                vec![json!({"rel": "inbox/child-1.ndjson", "text": "{\"message\":\"x\"}\n"}), json!({"rel": "cursors-nd/child-1.txt", "text": "0"})]
            }),
            native: true,
            expect: vec!["\"ok\":true"],
        },
        // ---- deferrals: nothing written, exit 75 without Node ----
        Case {
            name: "no-session",
            cwd: "child",
            argv: argv("child-1", &[]),
            extra: vec![],
            ack: none(),
            union: none(),
            native: false,
            expect: vec!["\"sessionId\":null"],
        },
        Case {
            name: "bare-session-flag",
            cwd: "child",
            argv: argv("child-1", &["--session"]),
            extra: vec![],
            ack: none(),
            union: none(),
            native: false,
            expect: vec!["\"sessionId\":null"],
        },
        Case {
            name: "summary",
            cwd: "child",
            argv: hb("child-1", &["--summary", "working"]),
            extra: vec![],
            ack: none(),
            union: none(),
            native: false,
            expect: vec!["\"meshBroadcast\""],
        },
        Case {
            name: "step",
            cwd: "child",
            argv: hb("child-1", &["--step", "1"]),
            extra: vec![],
            ack: none(),
            union: none(),
            native: false,
            expect: vec!["\"plan\""],
        },
        Case {
            name: "primary-label-id-plain",
            cwd: "main",
            argv: hb("primary-0123abcd", &[]),
            extra: vec![],
            ack: none(),
            union: none(),
            native: false,
            expect: vec!["\"action\":\"heartbeat\""],
        },
        Case {
            name: "child-addressing-another-id",
            cwd: "child",
            argv: hb("child-1", &[]),
            extra: vec![("DEVSWARM_SOURCE_BRANCH", s("feat")), ("DEVSWARM_BUILDER_ID", s("other-builder"))],
            ack: none(),
            union: none(),
            native: false,
            expect: vec!["\"action\":\"heartbeat\""],
        },
        Case {
            name: "anchor-session-would-refresh",
            cwd: "main",
            argv: hb("child-1", &[]),
            extra: vec![("CLAUDE_CODE_SESSION_ID", s("sess-new"))],
            ack: ack(
                vec![],
                {
                    let primary = primary.clone();
                    let wt = main_wt.clone();
                    move |h| {
                        vec![
                            json!({"id": primary.clone(), "worktreePath": wt.to_string_lossy(), "sessionId": "sess-old", "inboxPath": h.join("i").to_string_lossy()}),
                        ]
                    }
                },
                vec![],
            ),
            union: none(),
            native: false,
            expect: vec!["\"ok\":true"],
        },
        Case {
            name: "app-database-present-with-descriptor",
            cwd: "child",
            argv: hb("child-1", &[]),
            extra: vec![("ANTIHALL_DEVSWARM_APP_DB", app_db.clone())],
            ack: ack(floors("child-1", 0, 0), d_plain.clone(), vec![]),
            union: none(),
            native: false,
            expect: vec!["\"ok\":true"],
        },
        Case {
            name: "floor-rows-missing-needs-import",
            cwd: "child",
            argv: hb("child-1", &[]),
            extra: vec![],
            ack: ack(vec![], d_plain.clone(), vec![]),
            union: none(),
            native: false,
            expect: vec!["\"ok\":true"],
        },
        Case {
            name: "descriptor-id-differs",
            cwd: "child",
            argv: hb("child-1", &[]),
            extra: vec![],
            ack: ack(floors("child-1", 0, 0), |_| vec![], vec![]),
            union: Box::new({
                let wt = wt.clone();
                move |_| json!({"files": [{"rel": ".anti-hall/devswarm/workspaces/child-1.json", "text": json!({"id": "someone-else", "worktreePath": wt.to_string_lossy()}).to_string()}]})
            }),
            native: false,
            expect: vec!["\"ok\":true"],
        },
        Case {
            name: "journal-backend-marker",
            cwd: "child",
            argv: hb("child-1", &[]),
            extra: vec![],
            ack: ack(floors("child-1", 0, 0), d_plain.clone(), vec![]),
            union: Box::new({
                let key = fx.repo_key.clone();
                move |_| json!({"files": [{"rel": format!(".anti-hall/devswarm/store/{key}/BACKEND"), "text": "journal"}]})
            }),
            native: false,
            expect: vec!["\"ok\":true"],
        },
        Case {
            name: "unsafe-id",
            cwd: "child",
            argv: vec![s("heartbeat"), s("a/b"), s("--session"), s("s")],
            extra: vec![],
            ack: none(),
            union: none(),
            native: false,
            expect: vec!["invalid or missing workspace id"],
        },
        Case {
            name: "help",
            cwd: "child",
            argv: vec![s("heartbeat"), s("--help")],
            extra: vec![],
            ack: none(),
            union: none(),
            native: false,
            expect: vec!["\"action\":\"help\""],
        },
    ]
}

#[test]
fn heartbeat_matches_node_byte_for_byte_and_defers_without_writing() {
    if !node_sqlite_available() {
        eprintln!("SKIPPED: Node with node:sqlite is not available, so there is no Node writer to compare with");
        return;
    }
    let fx = fixture("hb");
    let nonode = no_node_path(&fx.root);
    let list = cases(&fx);
    let (mut native, mut deferred) = (0, 0);
    for (i, c) in list.iter().enumerate() {
        let now = 1_795_000_000_000 + i as i64 * 7_919;
        let cwd: PathBuf = if c.cwd == "main" { fx.main.clone() } else { fx.child.clone() };
        let (hn, he, hd) = (fx.root.join(format!("{}-node", c.name)), fx.root.join(format!("{}-engine", c.name)), fx.root.join(format!("{}-defer", c.name)));
        for h in [&hn, &he, &hd] {
            copy_tree(&fx.seed_home, h);
            seed(h, &fx, c);
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
            assert_eq!(log["verb"], "Heartbeat", "{}: telemetry names the verb", c.name);
            assert_eq!((e.code, &e.stdout), (n.code, &n.stdout), "{}: stdout/exit differ", c.name);
            assert_same_home(c.name, &hn, &he, &fx.repo_key, "node vs engine");
            // the background Node check on a scratch copy reaches the same verdict (it runs detached: wait for its line)
            let v = verify_line(&he.join("state"));
            assert_eq!(v["result"], "match", "{}: the background Node shadow disagrees: {v}", c.name);
        } else {
            deferred += 1;
            assert_eq!(e.code, n.code, "{}: exit code of the fallback", c.name);
            // the contract: deferred means NOTHING written, and exit 75 when the engine cannot run Node
            let before = fx.root.join(format!("{}-before", c.name));
            copy_tree(&fx.seed_home, &before);
            seed(&before, &fx, c);
            let d = engine_verb(&hd, &hd.join("state"), &cwd, &av, now, None, &[extra.clone(), vec![("PATH", nonode.as_str())]].concat());
            assert_eq!(d.code, 75, "{}: a deferral the engine cannot hand to Node exits 75, got {} / {}", c.name, d.code, d.stdout);
            assert!(d.stdout.is_empty(), "{}: nothing is printed on a deferral: {}", c.name, d.stdout);
            let reason = last_log(&hd.join("state"));
            assert_eq!(reason["result"], "defer", "{}: logged as a deferral: {reason}", c.name);
            assert_same_home(c.name, &before, &hd, &fx.repo_key, "deferral wrote");
        }
    }
    eprintln!("heartbeat parity: {} cases, {native} answered by the engine and identical to Node, {deferred} deferred with nothing written", list.len());
    assert!(native >= 25 && deferred >= 11, "{native} native, {deferred} deferred");
}

/// Input faults: whatever the engine cannot read exactly like Node, it must leave untouched for Node.
#[test]
fn faulty_inputs_are_reproduced_or_deferred_without_a_write() {
    if !node_sqlite_available() {
        eprintln!("SKIPPED: no node:sqlite");
        return;
    }
    let fx = fixture("hbfault");
    let nonode = no_node_path(&fx.root);
    let wt = fx.child.clone();
    let key = fx.repo_key.clone();
    let d_plain = {
        let wt = wt.clone();
        move |h: &Path| vec![desc(h, "child-1", Some("inbox/child-1.ndjson"), Some("cursors-nd/child-1.txt"), &wt)]
    };
    let hb = |more: &[&str]| -> Vec<String> {
        let mut v = argv("child-1", &["--session", "s1"]);
        v.extend(more.iter().map(|x| (*x).to_string()));
        v
    };
    struct Fault {
        name: &'static str,
        union: Spec,
        floors: Vec<Value>,
        native: bool,
    }
    let ok_inbox = |h: &str| json!({"rel": "inbox/child-1.ndjson", "text": h});
    let faults = vec![
        // an inbox that is a directory: unreadable, so the backlog is unknown on both sides
        Fault {
            name: "inbox-is-a-directory",
            union: Box::new(|_| json!({"files": [{"rel": "inbox/child-1.ndjson/keep", "text": "x"}, {"rel": "cursors-nd/child-1.txt", "text": "0"}]})),
            floors: floors("child-1", 2, 0),
            native: true,
        },
        Fault {
            name: "cursor-file-is-a-directory",
            union: Box::new(move |_| json!({"files": [ok_inbox("{\"message\":\"x\"}\n"), {"rel": "cursors-nd/child-1.txt/keep", "text": "x"}]})),
            floors: floors("child-1", 2, 0),
            native: true,
        },
        Fault {
            name: "cursor-file-null-json",
            union: Box::new(
                |_| json!({"files": [{"rel": "inbox/child-1.ndjson", "text": "{\"message\":\"x\"}\n"}, {"rel": "cursors-nd/child-1.txt", "text": "null"}]}),
            ),
            floors: floors("child-1", 2, 0),
            native: true,
        },
        Fault {
            name: "cursor-file-line-is-an-array",
            union: Box::new(
                |_| json!({"files": [{"rel": "inbox/child-1.ndjson", "text": "{\"message\":\"x\"}\n"}, {"rel": "cursors-nd/child-1.txt", "text": "{\"line\":[1]}"}]}),
            ),
            floors: floors("child-1", 2, 0),
            native: false,
        },
        Fault {
            name: "cursor-file-negative",
            union: Box::new(
                |_| json!({"files": [{"rel": "inbox/child-1.ndjson", "text": "{\"message\":\"x\"}\n"}, {"rel": "cursors-nd/child-1.txt", "text": "{\"line\":-3}"}]}),
            ),
            floors: floors("child-1", 2, 0),
            native: true,
        },
        Fault {
            name: "cursor-file-huge-digits",
            union: Box::new(
                |_| json!({"files": [{"rel": "inbox/child-1.ndjson", "text": "{\"message\":\"x\"}\n"}, {"rel": "cursors-nd/child-1.txt", "text": "99999999999999999999999"}]}),
            ),
            floors: floors("child-1", 2, 0),
            native: false,
        },
        Fault {
            name: "inbox-line-with-array-hash",
            union: Box::new(
                |_| json!({"files": [{"rel": "inbox/child-1.ndjson", "text": "{\"_h\":[1],\"message\":\"x\"}\n"}, {"rel": "cursors-nd/child-1.txt", "text": "0"}]}),
            ),
            floors: floors("child-1", 2, 0),
            native: false,
        },
        Fault {
            name: "inbox-line-with-numeric-hash",
            union: Box::new(
                |_| json!({"files": [{"rel": "inbox/child-1.ndjson", "text": "{\"_h\":42,\"message\":\"x\",\"createdAt\":1794999900000}\n"}, {"rel": "cursors-nd/child-1.txt", "text": "0"}]}),
            ),
            floors: floors("child-1", 2, 0),
            native: true,
        },
        Fault {
            name: "inbox-line-not-json",
            union: Box::new(
                |_| json!({"files": [{"rel": "inbox/child-1.ndjson", "text": "plain text line\n[1,2]\n\"str\"\n"}, {"rel": "cursors-nd/child-1.txt", "text": "0"}]}),
            ),
            floors: floors("child-1", 2, 0),
            native: true,
        },
        Fault {
            name: "inbox-invalid-utf8-and-bom",
            union: Box::new(
                |_| json!({"files": [{"rel": "inbox/child-1.ndjson", "text": "\u{feff}{\"message\":\"x\"}\n\u{fffd}\u{fffd}\n"}, {"rel": "cursors-nd/child-1.txt", "text": "0"}]}),
            ),
            floors: floors("child-1", 2, 0),
            native: true,
        },
        // the store file is not a database: Node's readOnly open throws and the union falls back; the engine defers
        Fault {
            name: "store-file-is-not-a-database",
            union: Box::new({
                let key = key.clone();
                move |_| json!({"files": [{"rel": format!(".anti-hall/devswarm/store/{key}/devswarm.db"), "text": "this is not sqlite"}, {"rel": "inbox/child-1.ndjson", "text": "{\"message\":\"x\"}\n"}, {"rel": "cursors-nd/child-1.txt", "text": "0"}]})
            }),
            floors: vec![],
            native: false,
        },
        Fault {
            name: "backend-marker-missing",
            union: Box::new({
                let key = key.clone();
                move |h| {
                    // the marker the seed wrote is removed after seeding by overwriting it with garbage
                    let _ = h;
                    json!({"files": [{"rel": format!(".anti-hall/devswarm/store/{key}/BACKEND"), "text": "weird"}]})
                }
            }),
            floors: floors("child-1", 2, 0),
            native: false,
        },
    ];
    let (mut native, mut deferred) = (0, 0);
    for (i, f) in faults.iter().enumerate() {
        let now = 1_795_100_000_000 + i as i64 * 7_919;
        let (hn, he, hd) = (fx.root.join(format!("{}-node", f.name)), fx.root.join(format!("{}-engine", f.name)), fx.root.join(format!("{}-defer", f.name)));
        let seed_one = |h: &Path| {
            copy_tree(&fx.seed_home, h);
            run_seed("ack_seed.js", h, &fx, &json!({"rows": f.floors.clone(), "descriptors": d_plain(h)}));
            run_seed("union_seed.js", h, &fx, &(f.union)(h));
            fs::create_dir_all(h.join(".anti-hall")).unwrap();
            fs::write(h.join(".anti-hall").join("settings.json"), "{\"mesh\":{\"engine_writes\":\"on\"}}\n").unwrap();
        };
        for h in [&hn, &he, &hd] {
            seed_one(h);
        }
        let a = hb(&[]);
        let av: Vec<&str> = a.iter().map(String::as_str).collect();
        let n = node_verb(&hn, &hn.join("state"), &fx.child, &av, now, None, &[]);
        let e = engine_verb(&he, &he.join("state"), &fx.child, &av, now, None, &[]);
        let log = last_log(&he.join("state"));
        assert_eq!(log["result"] == "native", f.native, "{}: expected native={} but the engine logged {log}", f.name, f.native);
        if f.native {
            native += 1;
            assert_eq!((e.code, &e.stdout), (n.code, &n.stdout), "{}: stdout/exit differ", f.name);
            assert_same_home(f.name, &hn, &he, &fx.repo_key, "node vs engine");
        } else {
            deferred += 1;
            assert_eq!(e.code, n.code, "{}: exit code of the fallback", f.name);
            let before = fx.root.join(format!("{}-before", f.name));
            seed_one(&before);
            let d = engine_verb(&hd, &hd.join("state"), &fx.child, &av, now, None, &[("PATH", nonode.as_str())]);
            assert_eq!((d.code, d.stdout.is_empty()), (75, true), "{}: deferral contract: {} / {}", f.name, d.code, d.stdout);
            assert_same_home(f.name, &before, &hd, &fx.repo_key, "deferral wrote");
        }
    }
    eprintln!("heartbeat fault parity: {native} reproduced exactly, {deferred} deferred untouched");
    assert!(native >= 7 && deferred >= 5);
}
