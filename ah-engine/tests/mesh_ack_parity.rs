//! `inbox ack-primary` parity: `ah-engine mesh inbox ack-primary ...` (mesh.engine_writes = on) against
//! `node scripts/devswarm.js inbox ack-primary ...` on identical scratch homes.
//!
//! Every case builds ONE seeded scratch home (the D45 fixture: a real git repo with a linked child worktree, a store
//! written by Node's own `devswarm-store.js`), applies a case spec to it with Node's own store code (`ack_seed.js`:
//! reader-cursor rows, read receipts, descriptors, legacy cursor files, a fake harness session), copies it three times and
//! runs Node on the first copy, the engine on the second, and the engine with NO Node on the third.
//!
//! * a `native` case: the engine answers itself; stdout, the exit code, every store table (every column; an `updated_at`
//!   within ten minutes of the real clock is masked, since Node stamps `ackFor` and `setCursor` with `Date.now()`), and
//!   every file of the home tree (cursor files, receipts, summaries; the cursor-write journals without their `ts` and
//!   `pid`) are byte-identical to Node's;
//! * a `defer` case: the engine must write NOTHING and exit 75 (`mesh_write.exit_defer`) when it cannot run Node (the
//!   third copy: `node` is not on its PATH), and hand the verb to Node otherwise (the second copy), whose output is then
//!   the engine's output. That is the exit-75 contract: 75 means "deferred, nothing written".
#![allow(clippy::unwrap_used, clippy::expect_used)] // a test crate: a panic is the failure report, and E2 exempts tests
use serde_json::{Value, json};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

#[path = "mesh_write_support/fx.rs"]
mod fx;
use fx::*;

const OLD: i64 = 1_790_000_000_000;

/// The real clock: `ackFor` stamps rows with `Date.now()`, not the pinned `ctx.now`.
fn real_now() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis() as i64
}
const DEAD_PID: i64 = 2_999_999;

struct Case {
    name: &'static str,
    cwd: &'static str,
    argv: Vec<String>,
    extra: Vec<(&'static str, String)>,
    spec: Value,
    native: bool,
    /// Substrings the (Node) stdout must contain, so a case cannot pass by both sides refusing alike.
    expect: Vec<&'static str>,
}

fn row(partition: &str, ns: &str, reader: &str, value: i64, updated_at: i64) -> Value {
    json!({"partition": partition, "ns": ns, "reader": reader, "value": value, "updatedAt": updated_at})
}

fn floors(partition: &str) -> Vec<Value> {
    vec![row(partition, "store", "#floor", 0, OLD), row(partition, "nd", "#floor", 0, OLD)]
}

fn receipt(dir: &str, name: &str, id: &str, reader: Value, created: i64, ops: Value, acked: Value) -> Value {
    json!({"dir": dir, "name": name, "rec": {"v": 1, "receiptId": name, "id": id, "reader": reader, "createdAt": created, "ops": ops, "hashes": ["h1", "h2", "h3"], "ackedAt": acked}})
}

fn own(partition: &str, target: i64) -> Value {
    json!({"k": "own", "partition": partition, "target": target, "delivered": 2})
}

fn merge(parts: Vec<Value>) -> Value {
    let mut out = json!({"rows": [], "receipts": [], "registry": [], "descriptors": [], "cursorFiles": [], "cursorsTable": [], "sessions": []});
    for p in parts {
        for (k, v) in p.as_object().unwrap() {
            out[k].as_array_mut().unwrap().extend(v.as_array().unwrap().iter().cloned());
        }
    }
    out
}

fn args(id: &str, rid: &str, more: &[&str]) -> Vec<String> {
    let mut v: Vec<String> = ["inbox", "ack-primary", id, "--receipt", rid].iter().map(|x| (*x).to_string()).collect();
    v.extend(more.iter().map(|x| (*x).to_string()));
    v
}

/// The journal lines without the two fields that differ per process.
fn normalized(rel: &str, bytes: &[u8]) -> Vec<u8> {
    if !rel.contains("cursor-log/") {
        return bytes.to_vec();
    }
    String::from_utf8_lossy(bytes)
        .lines()
        .map(|l| {
            let mut v: Value = serde_json::from_str(l).unwrap();
            let o = v.as_object_mut().unwrap();
            o.remove("ts");
            o.remove("pid");
            v.to_string()
        })
        .collect::<Vec<_>>()
        .join("\n")
        .into_bytes()
}

/// A PATH with `git` and `ps` only, so the engine cannot start Node.
fn no_node_path(root: &Path) -> String {
    let bin = root.join("nonode-bin");
    fs::create_dir_all(&bin).unwrap();
    for t in ["git", "ps"] {
        let out = Command::new("sh").args(["-c", &format!("command -v {t}")]).output().unwrap();
        let src = String::from_utf8_lossy(&out.stdout).trim().to_string();
        let _ = std::os::unix::fs::symlink(&src, bin.join(t));
    }
    bin.to_string_lossy().to_string()
}

fn seed(h: &Path, fx: &Fx, spec: &Value) {
    let o = Command::new("node")
        .arg(support("ack_seed.js"))
        .arg(h)
        .arg(&fx.repo_key)
        .arg(spec.to_string())
        .env_clear()
        .env("PATH", std::env::var("PATH").unwrap())
        .env("HOME", h)
        .output()
        .unwrap();
    assert!(o.status.success(), "ack_seed failed: {}", String::from_utf8_lossy(&o.stderr));
    fs::create_dir_all(h.join(".anti-hall")).unwrap();
    fs::write(h.join(".anti-hall").join("settings.json"), "{\"mesh\":{\"engine_writes\":\"on\"}}\n").unwrap();
}

/// A raw dump with `updated_at` values near the real clock masked.
fn dump(db: &Path) -> String {
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis() as i64;
    raw_dump(db)
        .lines()
        .map(|l| {
            l.split(' ')
                .map(|cell| match cell.strip_prefix("updated_at=i") {
                    Some(v) if v.parse::<i64>().is_ok_and(|x| (x - now).abs() < 600_000) => "updated_at=<now>".to_string(),
                    _ => cell.to_string(),
                })
                .collect::<Vec<_>>()
                .join(" ")
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn files(home: &Path) -> std::collections::BTreeMap<String, Vec<u8>> {
    home_files(home).into_iter().map(|(k, v)| (k.clone(), normalized(&k, &v))).collect()
}

fn assert_same_home(name: &str, a: &Path, b: &Path, key: &str, what: &str) {
    let db = |h: &Path| h.join(".anti-hall/devswarm/store").join(key).join("devswarm.db");
    let (da, dbb) = (dump(&db(a)), dump(&db(b)));
    assert!(da == dbb, "{name}: {what}: store differs: {}", first_diff(&da, &dbb));
    let (fa, fb) = (files(a), files(b));
    let ka: Vec<&String> = fa.keys().collect();
    let kb: Vec<&String> = fb.keys().collect();
    assert_eq!(ka, kb, "{name}: {what}: home tree file set differs");
    for (k, v) in &fa {
        assert!(fb[k] == *v, "{name}: {what}: {k} differs:\n a: {}\n b: {}", String::from_utf8_lossy(v), String::from_utf8_lossy(&fb[k]));
    }
}

#[test]
fn ack_primary_matches_node_byte_for_byte_and_defers_without_writing() {
    if !node_sqlite_available() {
        eprintln!("SKIPPED: Node with node:sqlite is not available, so there is no Node writer to compare with");
        return;
    }
    let fx = fixture("ack");
    let s = |x: &str| x.to_string();
    let primary = fx.primary_id.clone();
    let pid = i64::from(std::process::id());
    let reader = format!("h:{pid}:{OLD}");
    let session = json!({"sessions": [{"pid": pid, "startedAt": OLD}]});
    let as_child = vec![("DEVSWARM_BUILDER_ID", s("child-1"))];
    let created = 1_794_999_000_000_i64;
    let foreign = fx.root.join("foreign-project");
    fs::create_dir_all(&foreign).unwrap();
    let base = || merge(vec![json!({"rows": floors("child-1")}), json!({"rows": floors(&primary)})]);
    let with = |extra: Value| merge(vec![base(), extra]);
    let one = |r: Value| json!({"receipts": [r]});
    let child_wt = fx.child.to_string_lossy().to_string();
    let family = |parts: Vec<Value>| {
        merge(vec![
            base(),
            json!({"registry": [{"id": "child-1b", "worktreePath": child_wt.clone(), "sessionId": "child-1b"}], "rows": floors("child-1b")}),
            merge(parts),
        ])
    };
    let cases = vec![
        Case {
            name: "headless-own-child",
            cwd: "child",
            argv: args("child-1", "rhead1", &[]),
            extra: as_child.clone(),
            spec: with(one(receipt("child-1", "rhead1", "child-1", Value::Null, created, json!([own("child-1", 2)]), Value::Null))),
            native: true,
            expect: vec!["\"acked\":2", "\"alreadyAcked\":false", "\"messages\":3"],
        },
        Case {
            name: "headless-primary-from-main",
            cwd: "main",
            argv: args(&primary, "rprim1", &[]),
            extra: vec![],
            spec: with(one(receipt(&primary, "rprim1", &primary, Value::Null, created, json!([own(&primary, 3)]), Value::Null))),
            native: true,
            expect: vec!["\"acked\":3"],
        },
        Case {
            name: "two-own-ops",
            cwd: "main",
            argv: args(&primary, "rtwo1", &["--ack-as-owner"]),
            extra: vec![],
            spec: with(one(receipt(&primary, "rtwo1", &primary, Value::Null, created, json!([own(&primary, 2), own("child-1", 4)]), Value::Null))),
            native: true,
            expect: vec!["\"acked\":4"],
        },
        Case {
            name: "no-ops-no-acked-key",
            cwd: "main",
            argv: args(&primary, "rnoop1", &[]),
            extra: vec![],
            spec: with(one(receipt(&primary, "rnoop1", &primary, Value::Null, created, json!([]), Value::Null))),
            native: true,
            expect: vec!["\"alreadyAcked\":false"],
        },
        Case {
            name: "unknown-op-kind-is-skipped",
            cwd: "main",
            argv: args(&primary, "runk1", &[]),
            extra: vec![],
            spec: with(one(receipt(
                &primary,
                "runk1",
                &primary,
                Value::Null,
                created,
                json!([{"k": "future", "x": 1}, null, 7, own(&primary, 1)]),
                Value::Null,
            ))),
            native: true,
            expect: vec!["\"acked\":1"],
        },
        Case {
            name: "already-acked-is-not-restamped",
            cwd: "main",
            argv: args(&primary, "ralr1", &[]),
            extra: vec![],
            spec: with(one(receipt(&primary, "ralr1", &primary, Value::Null, created, json!([own(&primary, 2)]), json!(1_794_999_500_000_i64)))),
            native: true,
            expect: vec!["\"alreadyAcked\":true"],
        },
        Case {
            name: "lower-target-never-lowers",
            cwd: "main",
            argv: args(&primary, "rlow1", &[]),
            extra: vec![],
            spec: with(json!({
                "rows": [row(&primary, "store", "#floor", 5, OLD)],
                "cursorsTable": [{"id": primary, "value": 5}],
                "cursorFiles": [{"id": primary, "text": "5"}],
                "receipts": [receipt(&primary, "rlow1", &primary, Value::Null, created, json!([own(&primary, 2)]), Value::Null)],
            })),
            native: true,
            expect: vec!["\"acked\":5"],
        },
        Case {
            name: "legacy-cursor-file-object-form",
            cwd: "main",
            argv: args(&primary, "rleg1", &[]),
            extra: vec![],
            spec: with(json!({
                "cursorFiles": [{"id": primary, "text": "{\"line\": 1}"}],
                "receipts": [receipt(&primary, "rleg1", &primary, Value::Null, created, json!([own(&primary, 3)]), Value::Null)],
            })),
            native: true,
            expect: vec!["\"acked\":3"],
        },
        Case {
            name: "declared-reader-own-row",
            cwd: "main",
            argv: args(&primary, "rdecl1", &[]),
            extra: vec![],
            spec: with(merge(vec![
                session.clone(),
                one(receipt(&primary, "rdecl1", &primary, json!(reader), created, json!([own(&primary, 2)]), Value::Null)),
            ])),
            native: true,
            expect: vec!["\"acked\":2"],
        },
        Case {
            name: "declared-reader-live-pin-keeps-floor",
            cwd: "main",
            argv: args(&primary, "rpin1", &[]),
            extra: vec![],
            spec: with(merge(vec![
                session.clone(),
                json!({"rows": [row(&primary, "store", &format!("h:1:{}", real_now() + 86_400_000), 0, 1)]}),
                one(receipt(&primary, "rpin1", &primary, json!(reader), created, json!([own(&primary, 4)]), Value::Null)),
            ])),
            native: true,
            expect: vec!["\"acked\":4"],
        },
        Case {
            name: "declared-reader-retires-dead-pin",
            cwd: "main",
            argv: args(&primary, "rret1", &[]),
            extra: vec![],
            spec: with(merge(vec![
                session.clone(),
                json!({"rows": [row(&primary, "store", &format!("h:{DEAD_PID}:{OLD}"), 0, 1)]}),
                one(receipt(&primary, "rret1", &primary, json!(reader), created, json!([own(&primary, 3)]), Value::Null)),
            ])),
            native: true,
            expect: vec!["\"acked\":3"],
        },
        Case {
            name: "headless-with-recent-foreign-pin",
            cwd: "main",
            argv: args(&primary, "rrec1", &[]),
            extra: vec![],
            spec: with(merge(vec![
                json!({"rows": [row(&primary, "store", &format!("h:{DEAD_PID}:{OLD}"), 0, real_now() + 1_800_000)]}),
                one(receipt(&primary, "rrec1", &primary, Value::Null, created, json!([own(&primary, 3)]), Value::Null)),
            ])),
            native: true,
            expect: vec!["\"acked\":3"],
        },
        Case {
            name: "alias-family-receipt-dir",
            cwd: "main",
            argv: args("child-1b", "rfam1", &["--ack-as-owner"]),
            extra: vec![],
            spec: family(vec![
                json!({"descriptors": [{"id": "child-1b", "worktreePath": child_wt.clone(), "sessionId": "child-1b"}]}),
                one(receipt("child-1", "rfam1", "child-1b", Value::Null, created, json!([own("child-1b", 2)]), Value::Null)),
            ]),
            native: true,
            expect: vec!["\"acked\":2"],
        },
        Case {
            name: "descriptor-registered-in-this-project",
            cwd: "child",
            argv: args("child-1", "rdesc1", &[]),
            extra: as_child.clone(),
            spec: with(merge(vec![
                json!({"descriptors": [{"id": "child-1", "worktreePath": child_wt.clone(), "sessionId": "child-1", "ownerKey": fx.repo_key}]}),
                one(receipt("child-1", "rdesc1", "child-1", Value::Null, created, json!([own("child-1", 1)]), Value::Null)),
            ])),
            native: true,
            expect: vec!["\"acked\":1"],
        },
        Case {
            name: "child-ack-as-owner-flag-order",
            cwd: "child",
            argv: vec![s("inbox"), s("ack-primary"), s("child-1"), s("--ack-as-owner"), s("--receipt"), s("rflag1")],
            extra: vec![],
            spec: with(one(receipt("child-1", "rflag1", "child-1", Value::Null, created, json!([own("child-1", 2)]), Value::Null))),
            native: true,
            expect: vec!["\"acked\":2"],
        },
        // ---- deferred: Node's refusals and everything the engine does not apply ----
        Case {
            name: "unknown-receipt",
            cwd: "main",
            argv: args(&primary, "rnone1", &[]),
            extra: vec![],
            spec: base(),
            native: false,
            expect: vec!["unknown-receipt"],
        },
        Case {
            name: "malformed-receipt-id",
            cwd: "main",
            argv: args(&primary, "NOT_A_RECEIPT", &[]),
            extra: vec![],
            spec: base(),
            native: false,
            expect: vec!["unknown-receipt"],
        },
        Case {
            name: "missing-receipt-flag",
            cwd: "main",
            argv: vec![s("inbox"), s("ack-primary"), primary.clone()],
            extra: vec![],
            spec: base(),
            native: false,
            expect: vec!["missing-receipt"],
        },
        Case {
            name: "expired-receipt",
            cwd: "main",
            argv: args(&primary, "rold1", &[]),
            extra: vec![],
            spec: with(one(receipt(&primary, "rold1", &primary, Value::Null, 1_700_000_000_000, json!([own(&primary, 2)]), Value::Null))),
            native: false,
            expect: vec!["receipt-expired"],
        },
        Case {
            name: "reader-mismatch",
            cwd: "main",
            argv: args(&primary, "rrdr1", &[]),
            extra: vec![],
            spec: with(one(receipt(&primary, "rrdr1", &primary, json!("h:12345:1790000000000"), created, json!([own(&primary, 2)]), Value::Null))),
            native: false,
            expect: vec!["receipt-owner-mismatch"],
        },
        Case {
            name: "receipt-for-another-id",
            cwd: "main",
            argv: args(&primary, "rfor1", &[]),
            extra: vec![],
            spec: with(one(receipt(&primary, "rfor1", "child-1", Value::Null, created, json!([own("child-1", 2)]), Value::Null))),
            native: false,
            expect: vec!["receipt-owner-mismatch"],
        },
        Case {
            name: "caller-does-not-own",
            cwd: "main",
            argv: args("child-1", "rown1", &[]),
            extra: vec![],
            spec: with(one(receipt("child-1", "rown1", "child-1", Value::Null, created, json!([own("child-1", 2)]), Value::Null))),
            native: false,
            expect: vec!["ack-primary refused"],
        },
        Case {
            name: "sibling-op",
            cwd: "main",
            argv: args(&primary, "rsib1", &[]),
            extra: vec![],
            spec: with(one(receipt(
                &primary,
                "rsib1",
                &primary,
                Value::Null,
                created,
                json!([own(&primary, 1), {"k": "sibling", "partition": "child-1", "ackTarget": 1, "seenTarget": 1, "notAckable": false, "delivered": 1}]),
                Value::Null,
            ))),
            native: false,
            expect: vec!["\"acked\""],
        },
        Case {
            name: "nd-op",
            cwd: "main",
            argv: args(&primary, "rnd1", &[]),
            extra: vec![],
            spec: with(one(receipt(
                &primary,
                "rnd1",
                &primary,
                Value::Null,
                created,
                json!([{"k": "nd", "partition": primary, "target": 1, "cursorPath": null, "inboxPath": null}]),
                Value::Null,
            ))),
            native: false,
            expect: vec!["\"ok\":true"],
        },
        Case {
            name: "floor-rows-missing-needs-import",
            cwd: "main",
            argv: args(&primary, "rimp1", &[]),
            extra: vec![],
            spec: one(receipt(&primary, "rimp1", &primary, Value::Null, created, json!([own(&primary, 2)]), Value::Null)),
            native: false,
            expect: vec!["\"acked\""],
        },
        Case {
            name: "window-flag",
            cwd: "main",
            argv: args(&primary, "rwin1", &["--tail", "3"]),
            extra: vec![],
            spec: with(one(receipt(&primary, "rwin1", &primary, Value::Null, created, json!([own(&primary, 2)]), Value::Null))),
            native: false,
            expect: vec!["window-flags-unsupported-on-acking-verb"],
        },
        Case {
            name: "help",
            cwd: "main",
            argv: vec![s("inbox"), s("ack-primary"), s("--help")],
            extra: vec![],
            spec: base(),
            native: false,
            expect: vec!["\"action\":\"help\""],
        },
        Case {
            name: "unsafe-id",
            cwd: "main",
            argv: vec![s("inbox"), s("ack-primary"), s("a/b"), s("--receipt"), s("rx1")],
            extra: vec![],
            spec: base(),
            native: false,
            expect: vec!["invalid or missing workspace id"],
        },
        Case {
            name: "foreign-project-descriptor",
            cwd: "main",
            argv: args("child-1", "rfp1", &["--ack-as-owner"]),
            extra: vec![],
            spec: with(merge(vec![
                json!({"descriptors": [{"id": "child-1", "worktreePath": foreign.to_string_lossy(), "repoKey": "some-other-project-key", "sessionId": "child-1"}]}),
                one(receipt("child-1", "rfp1", "child-1", Value::Null, created, json!([own("child-1", 2)]), Value::Null)),
            ])),
            native: false,
            expect: vec!["project-context-mismatch"],
        },
    ];
    let nonode = no_node_path(&fx.root);
    let (mut native, mut deferred) = (0, 0);
    for (i, c) in cases.iter().enumerate() {
        let now = 1_795_000_000_000 + i as i64 * 7_919;
        let cwd: PathBuf = match c.cwd {
            "main" => fx.main.clone(),
            _ => fx.child.clone(),
        };
        let (hn, he, hd) = (fx.root.join(format!("{}-node", c.name)), fx.root.join(format!("{}-engine", c.name)), fx.root.join(format!("{}-defer", c.name)));
        for h in [&hn, &he, &hd] {
            copy_tree(&fx.seed_home, h);
            seed(h, &fx, &c.spec);
        }
        let argv: Vec<&str> = c.argv.iter().map(String::as_str).collect();
        let extra: Vec<(&str, &str)> = c.extra.iter().map(|(k, v)| (*k, v.as_str())).collect();
        let n = node_verb(&hn, &hn.join("state"), &cwd, &argv, now, None, &extra);
        for want in &c.expect {
            assert!(n.stdout.contains(want), "{}: Node's output lacks {want:?}: {}", c.name, n.stdout);
        }
        let e = engine_verb(&he, &he.join("state"), &cwd, &argv, now, None, &extra);
        let log = last_log(&he.join("state"));
        let answered = log["result"] == "native";
        assert_eq!(answered, c.native, "{}: expected native={} but the engine logged {log}", c.name, c.native);
        if c.native {
            native += 1;
            assert_eq!((e.code, &e.stdout), (n.code, &n.stdout), "{}: stdout/exit differ", c.name);
            assert_same_home(c.name, &hn, &he, &fx.repo_key, "node vs engine");
        } else {
            deferred += 1;
            // handed to Node: the engine's result is Node's own (a deferral that Node answers with ok:true writes with its
            // own clock, so only the code and a refusal's text are compared exactly)
            assert_eq!(e.code, n.code, "{}: exit code of the fallback", c.name);
            if n.code != 0 {
                assert_eq!(e.stdout, n.stdout, "{}: stdout of the fallback", c.name);
            }
            // the contract: deferred means NOTHING written, and exit 75 when the engine cannot run Node
            let before = fx.root.join(format!("{}-before", c.name));
            copy_tree(&fx.seed_home, &before);
            seed(&before, &fx, &c.spec);
            let d = engine_verb(&hd, &hd.join("state"), &cwd, &argv, now, None, &[extra.clone(), vec![("PATH", nonode.as_str())]].concat());
            assert_eq!(d.code, 75, "{}: a deferral the engine cannot hand to Node exits 75, got {} / {}", c.name, d.code, d.stdout);
            assert!(d.stdout.is_empty(), "{}: nothing is printed on a deferral: {}", c.name, d.stdout);
            assert_same_home(c.name, &before, &hd, &fx.repo_key, "deferral wrote");
        }
    }
    eprintln!("ack-primary parity: {} cases, {native} answered by the engine and identical to Node, {deferred} deferred with nothing written", cases.len());
    assert!(native >= 14 && deferred >= 12);
}

#[test]
fn a_replayed_ack_is_idempotent_and_matches_node() {
    if !node_sqlite_available() {
        eprintln!("SKIPPED: no node:sqlite");
        return;
    }
    let fx = fixture("ackrep");
    let primary = fx.primary_id.clone();
    let created = 1_794_999_000_000_i64;
    let spec = merge(vec![
        json!({"rows": floors(&primary)}),
        json!({"receipts": [receipt(&primary, "rrep1", &primary, Value::Null, created, json!([own(&primary, 3)]), Value::Null)]}),
    ]);
    let (hn, he) = (fx.root.join("n"), fx.root.join("e"));
    for h in [&hn, &he] {
        copy_tree(&fx.seed_home, h);
        seed(h, &fx, &spec);
    }
    let argv = args(&primary, "rrep1", &[]);
    let a: Vec<&str> = argv.iter().map(String::as_str).collect();
    for round in 0..3 {
        let now = 1_795_000_100_000 + round * 1000;
        let n = node_verb(&hn, &hn.join("state"), &fx.main, &a, now, None, &[]);
        let e = engine_verb(&he, &he.join("state"), &fx.main, &a, now, None, &[]);
        assert_eq!(last_log(&he.join("state"))["result"], "native", "round {round}");
        assert_eq!((e.code, &e.stdout), (n.code, &n.stdout), "round {round}");
        assert!(round == 0 || n.stdout.contains("\"alreadyAcked\":true"), "round {round}: {}", n.stdout);
    }
    assert_same_home("replay", &hn, &he, &fx.repo_key, "after three acks");
}

#[test]
fn shadow_mode_runs_ack_primary_in_node_and_counts_it() {
    if !node_sqlite_available() {
        eprintln!("SKIPPED: no node:sqlite");
        return;
    }
    let fx = fixture("ackshadow");
    let primary = fx.primary_id.clone();
    let spec = merge(vec![
        json!({"rows": floors(&primary)}),
        json!({"receipts": [receipt(&primary, "rsh1", &primary, Value::Null, 1_794_999_000_000_i64, json!([own(&primary, 2)]), Value::Null)]}),
    ]);
    let home = fx.root.join("h");
    copy_tree(&fx.seed_home, &home);
    seed(&home, &fx, &spec);
    fs::write(home.join(".anti-hall").join("settings.json"), "{\"mesh\":{\"engine_writes\":\"shadow\"}}\n").unwrap();
    let state = home.join("state");
    let o = engine_verb(&home, &state, &fx.main, &["inbox", "ack-primary", &primary, "--receipt", "rsh1"], 1_795_000_000_000, None, &[]);
    assert_eq!(o.code, 0, "{}", o.stdout);
    assert!(o.stdout.contains("\"action\":\"ack-primary\"") && o.stdout.contains("\"acked\":2"), "{}", o.stdout);
    let rec = last_log(&state);
    assert_eq!((rec["mode"].as_str(), rec["result"].as_str(), rec["verb"].as_str()), (Some("shadow"), Some("skipped"), Some("InboxAckPrimary")), "{rec}");
}
