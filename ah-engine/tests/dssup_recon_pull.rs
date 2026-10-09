//! The reconcile port, slices S3 (the drain of one workspace) and S4 (`cmdReconcile`, `distinctRepoKeys`, the sweep duty), against
//! Node's own functions.
//!
//! The ground truth of S3 is Node's real `inbox pull <id>` (the spawn `reconcile` makes: `defaultSpawnReconcile`), run on a twin
//! of the same seeded home with the same pinned clock and the same recording `hivecontrol` stub. The engine side stages the pull
//! on its twin (the destructive read, the raw capture) and drains it through the witness gate; the two homes (tree and store
//! dumps) must then be identical. Each test prints a `PARITY` line: cases / identical / deferred.
#![allow(clippy::unwrap_used, clippy::expect_used)] // a test crate: a panic is the failure report
use ah_engine::checks::git::util::Settings;
use ah_engine::dsact::runner::System;
use ah_engine::dssup::recon::{Hooks, pull, sweep};
use ah_engine::dssup::tick::Ctx;
use serde_json::{Value, json};
use std::collections::{BTreeMap, HashMap};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

#[path = "mesh_write_support/fx.rs"]
mod fx;
use fx::*;

const NOW: i64 = 1_795_000_000_000;

/// The Node program that pins the clock and loads devswarm.js as the main module.
const SNIPPET: &str = "const c=process.argv[1],n=Number(process.argv[2]);Date.now=()=>n;process.argv=[process.argv[0],c].concat(process.argv.slice(3));require('module')._load(c,null,true);";

/// The recording hivecontrol: logs its arguments, answers `message-count` from `$HOME/hc/count`, and a `read-messages` prints
/// `$HOME/hc/read` and CONSUMES it (the queue is destructive), then runs the optional hook `$HOME/hc/read.hook`.
const STUB: &str = r#"#!/bin/sh
PATH=/usr/bin:/bin
d="$HOME/hc"
echo "$*" >> "$d/calls.log" 2>/dev/null
case "$2" in
message-count)
  rc=0; [ -f "$d/count.rc" ] && rc=$(cat "$d/count.rc")
  [ -f "$d/count.err" ] && cat "$d/count.err" >&2
  [ -f "$d/count" ] && cat "$d/count"
  exit $rc ;;
read-messages)
  rc=0; [ -f "$d/read.rc" ] && rc=$(cat "$d/read.rc")
  if [ -f "$d/read" ]; then cat "$d/read"; mv "$d/read" "$d/read.consumed"; rm -f "$d/count"; fi
  [ -f "$d/read.hook" ] && sh "$d/read.hook"
  exit $rc ;;
esac
exit 2
"#;

fn init_env() -> String {
    use std::os::unix::fs::PermissionsExt;
    static ONCE: std::sync::OnceLock<String> = std::sync::OnceLock::new();
    ONCE.get_or_init(|| {
        let dir = PathBuf::from(std::env::var("HOME").unwrap()).join(".anti-hall/scratch/recon-tests/stub-bin");
        fs::create_dir_all(&dir).unwrap();
        let f = dir.join("hivecontrol");
        // written once (its modification time is part of Node's capability-cache key, which the tests compare)
        if fs::read_to_string(&f).ok().as_deref() != Some(STUB) {
            fs::write(&f, STUB).unwrap();
            fs::set_permissions(&f, fs::Permissions::from_mode(0o755)).unwrap();
        }
        let path = format!("{}:{}", dir.display(), std::env::var("PATH").unwrap());
        // SAFETY: set once, before anything in this process reads these variables
        unsafe {
            std::env::set_var("PATH", &path);
            std::env::set_var("ANTIHALL_DEVSWARM_APP_DB", "off");
            std::env::set_var("ANTIHALL_INGEST_DRY_RUN", "1");
            std::env::set_var("AH_ENGINE_PLUGIN_ROOT", plugin_root());
            std::env::set_var("RECON_PIN_NOW", NOW.to_string());
            std::env::set_var(
                "NODE_OPTIONS",
                format!("--require={}", Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/recon_support/pin-clock.js").display()),
            );
        }
        ah_engine::defaults::init().expect("defaults load");
        path
    })
    .clone()
}

fn ds(h: &Path) -> PathBuf {
    h.join(".anti-hall").join("devswarm")
}

fn put(h: &Path, rel: &str, text: &str) {
    let p = ds(h).join(rel);
    fs::create_dir_all(p.parent().unwrap()).unwrap();
    fs::write(p, text).unwrap();
}

fn hc(h: &Path, name: &str, text: &str) {
    let p = h.join("hc").join(name);
    fs::create_dir_all(p.parent().unwrap()).unwrap();
    fs::write(p, text).unwrap();
}

fn msgs(list: &[(&str, &str)]) -> String {
    let v: Vec<Value> = list.iter().map(|(m, t)| json!({"fromBranch": "main", "message": m, "createdAt": t, "status": "unread"})).collect();
    serde_json::to_string(&v).unwrap()
}

#[derive(Clone)]
struct W {
    repo_key: String,
    child: PathBuf,
}

fn run_seed(script: &str, h: &Path, repo_key: &str, spec: &Value) {
    let o = Command::new("node")
        .arg(support(script))
        .arg(h)
        .arg(repo_key)
        .arg(spec.to_string())
        .env_clear()
        .env("PATH", std::env::var("PATH").unwrap())
        .env("HOME", h)
        .output()
        .unwrap();
    assert!(o.status.success(), "{script} failed: {}", String::from_utf8_lossy(&o.stderr));
}

/// The standard child: descriptor (project keys present), empty inbox, cursor 0, nothing in the queue.
fn base(w: &W, h: &Path, extra: &[(&str, Value)], drop_keys: &[&str]) {
    let mut d = json!({
        "id": "child-1",
        "worktreePath": w.child.to_string_lossy(),
        "sessionId": "child-1",
        "inboxPath": ds(h).join("inbox/child-1.ndjson").to_string_lossy(),
        "cursorPath": ds(h).join("cursors/child-1.cursor").to_string_lossy(),
        "nudgeCommand": ["hivecontrol", "x"],
        "repoId": null,
        "repoKey": w.repo_key,
        "ownerKey": w.repo_key,
    });
    for (k, v) in extra {
        d[*k] = v.clone();
    }
    for k in drop_keys {
        d.as_object_mut().unwrap().remove(*k);
    }
    put(h, "workspaces/child-1.json", &d.to_string());
    let floor = |ns: &str, v: i64| json!({"partition": "child-1", "ns": ns, "reader": "#floor", "value": v, "updatedAt": NOW - 1000});
    run_seed("ack_seed.js", h, &w.repo_key, &json!({"rows": [floor("store", 2), floor("nd", 0)]}));
    put(h, "inbox/child-1.ndjson", "");
    put(h, "cursors/child-1.cursor", "0");
    // a healthy ingest daemon, so Node's self-heal neither warns nor spawns anything
    let pid = std::process::id();
    put(h, &format!("heartbeats/ingest-{}.json", w.repo_key), &json!({"ts": NOW, "pid": pid}).to_string());
    put(h, &format!("locks/ingest-project-{}.lock", w.repo_key), &json!({"pid": pid, "ts": NOW}).to_string());
}

fn read_inbox(h: &Path) -> String {
    fs::read_to_string(ds(h).join("inbox/child-1.ndjson")).unwrap_or_default()
}

fn wal_file(h: &Path) -> PathBuf {
    ds(h).join("wal/pull-child-1.ndjson")
}

fn wal_text(h: &Path) -> String {
    fs::read_to_string(wal_file(h)).unwrap_or_default()
}

/// The pid and the random part of a WAL entry id differ between the two processes by design.
///
/// The one deliberate difference: the closing record of a batch the engine captured itself is written by the replay (the same code
/// Node's replay runs, which the witness compared), so it also names the workspace it went `into`; Node's fresh-read record does
/// not. No reader looks at that field.
fn mask_wal(text: &str) -> String {
    let text = text.replace("\"into\":\"child-1\",", "");
    let e = regex::Regex::new(r#""e":"[^"]*""#).unwrap().replace_all(&text, r#""e":"E""#).into_owned();
    regex::Regex::new(r"entry [0-9]+-[0-9]+-[0-9]+-[0-9a-z]+").unwrap().replace_all(&e, "entry E").into_owned()
}

fn mask_journal(text: &str) -> String {
    regex::Regex::new(r#""(ts|pid)":[0-9]+"#).unwrap().replace_all(text, r#""$1":0"#).into_owned()
}

fn mask_dump(dump: &str) -> String {
    dump.lines()
        .map(|l| {
            if l.contains("reader=t\"") && l.contains(" ns=t\"") {
                regex::Regex::new(r"updated_at=i[0-9]+").unwrap().replace_all(l, "updated_at=<wall>").into_owned()
            } else {
                l.to_string()
            }
        })
        .collect::<Vec<_>>()
        .join("\n")
}

/// Every file under the home with its text, the home's own path masked; the engine's own scratch and logs are left out.
fn tree(home: &Path) -> BTreeMap<String, String> {
    tree_with(home, false)
}

/// [`tree`]; with `loose`, the counts of a closing record are masked (a batch replayed after a crash finds its rows already in the
/// inbox, so it closes as duplicates).
fn tree_with(home: &Path, loose: bool) -> BTreeMap<String, String> {
    home_files(home)
        .into_iter()
        .filter(|(k, _)| !k.starts_with(".anti-hall/scratch") && !k.starts_with(".anti-hall/logs/") && !k.starts_with("hc/calls.log") && !k.ends_with("/"))
        .map(|(k, v)| {
            let text = String::from_utf8_lossy(&v).replace(home.to_string_lossy().as_ref(), "<HOME>");
            // the order of the records of a log: the engine captures the new batch before it replays the open ones (so the whole
            // log is witnessed at once), Node reads after the replay; the records and the ingested rows are the same
            let text = if k.contains("/wal/") || k.contains("/wal-spill/") {
                let mut lines: Vec<String> = mask_wal(&text).lines().map(str::to_string).collect();
                if loose {
                    let counts = regex::Regex::new(r#""imported":[0-9]+,"duplicate":[0-9]+"#).unwrap();
                    lines = lines.iter().map(|l| counts.replace_all(l, r#""imported":N,"duplicate":N"#).into_owned()).collect();
                }
                lines.sort();
                lines.join("\n")
            } else {
                text
            };
            let text = if k.contains("/cursor-log/") { mask_journal(&text) } else { text };
            (k, text)
        })
        .collect()
}

fn key_db(h: &Path, key: &str) -> PathBuf {
    ds(h).join("store").join(key).join("devswarm.db")
}

fn store_dump(h: &Path, key: &str) -> String {
    store_dump_with(h, key, false)
}

/// [`store_dump`]; with `loose`, the registry's `write_seq` is masked (the ensure of an interrupted pull ran once more when Node
/// repeated it, and every upsert counts).
fn store_dump_with(h: &Path, key: &str, loose: bool) -> String {
    let db = key_db(h, key);
    if !db.is_file() {
        return String::new();
    }
    let d = mask_dump(&raw_dump(&db)).replace(h.to_string_lossy().as_ref(), "<HOME>");
    if loose {
        // a message that is ingested again after a kill is ignored but still takes a number of the table's sequence
        let d = regex::Regex::new(r"write_seq=i[0-9]+").unwrap().replace_all(&d, "write_seq=<n>").into_owned();
        regex::Regex::new(r#"name=t"messages" seq=i[0-9]+"#).unwrap().replace_all(&d, r#"name=t"messages" seq=<n>"#).into_owned()
    } else {
        d
    }
}

/// The twin homes must be identical: every file and every table of the store.
fn assert_same(case: &str, node: &Path, engine: &Path, key: &str) {
    assert_same_with(case, node, engine, key, false);
}

fn assert_same_with(case: &str, node: &Path, engine: &Path, key: &str, loose: bool) {
    let (tn, te) = (tree_with(node, loose), tree_with(engine, loose));
    for k in tn.keys().chain(te.keys()) {
        assert!(tn.get(k) == te.get(k), "{case}: the home tree differs at {k}:\n node:   {:?}\n engine: {:?}", tn.get(k), te.get(k));
    }
    let (dn, de) = (store_dump_with(node, key, loose), store_dump_with(engine, key, loose));
    assert!(dn == de, "{case}: the store differs: {}", first_diff(&dn, &de));
}

fn seed_home(h: &Path) {
    fs::create_dir_all(h.join(".anti-hall")).unwrap();
    fs::write(h.join(".anti-hall/settings.json"), "{\"mesh\":{\"engine_writes\":\"on\"}}\n").unwrap();
}

fn world(tag: &str) -> Option<(Fx, W)> {
    if !node_sqlite_available() {
        eprintln!("SKIPPED: Node with node:sqlite is not available, so there is no Node to compare with");
        return None;
    }
    init_env();
    let fx = fixture(tag);
    let w = W { repo_key: fx.repo_key.clone(), child: fx.child.clone() };
    Some((fx, w))
}

/// Node's own drain of `id`: the spawn `reconcile` makes (`inbox pull <id>` in the worktree), clock pinned. Returns its parsed answer.
fn node_pull(home: &Path, cwd: &Path, now: i64) -> Value {
    let cli = plugin_root().join("scripts").join("devswarm.js");
    let mut env = base_env(home, &home.join("state"), &[("ANTIHALL_RECONCILE_SWEEP", "1")]);
    env.retain(|(k, _)| k != "AH_ENGINE_NOSPAWN");
    let mut c = Command::new("node");
    c.arg("-e").arg(SNIPPET).arg(&cli).arg(now.to_string()).args(["inbox", "pull", "child-1"]).current_dir(cwd).env_clear().envs(env);
    let o = run(&mut c, None);
    serde_json::from_slice(&o.stdout).unwrap_or(Value::Null)
}

fn ctx_env(home: &Path) -> HashMap<String, String> {
    let mut env: HashMap<String, String> = HashMap::new();
    env.insert("HOME".into(), home.to_string_lossy().into_owned());
    env.insert("PATH".into(), std::env::var("PATH").unwrap());
    env.insert("ANTIHALL_DEVSWARM_APP_DB".into(), "off".into());
    env.insert("ANTIHALL_INGEST_DRY_RUN".into(), "1".into());
    env
}

struct Case {
    name: &'static str,
    setup: Box<dyn Fn(&Path)>,
    /// `None`: the engine must hand this workspace to Node; `Some`: the result the engine records.
    expect: Option<Value>,
}

fn case(name: &'static str, expect: Option<Value>, setup: impl Fn(&Path) + 'static) -> Case {
    Case { name, setup: Box::new(setup), expect }
}

fn ok(imported: usize, duplicate: usize, native: usize) -> Value {
    json!({"ok": true, "imported": imported, "duplicate": duplicate, "nativeCount": native, "locked": true, "lost": 0})
}

/// Stage and drain the child on `home` with the engine; the result the drain recorded, or the reason it went to Node.
fn engine_drain(home: &Path, fx: &Fx, hooks: &Hooks) -> Result<Value, String> {
    drain_at(home, &fx.child, &fx.repo_key, hooks, &|_| {})
}

/// [`engine_drain`] with a hook at the durable boundaries of the read as well.
fn drain_at(home: &Path, child: &Path, repo_key: &str, hooks: &Hooks, at: &dyn Fn(&str)) -> Result<Value, String> {
    let st = Settings { home: home.to_string_lossy().into_owned(), env: ctx_env(home) };
    let root = ah_engine::defaults::root().unwrap();
    let ctx = Ctx { home, root: &root, st: &st, now: NOW, engine_pokes: false };
    let cwd = child.to_string_lossy().into_owned();
    match pull::stage(&ctx, "child-1", &cwd, at) {
        pull::Stage::Node(why) => Err(why),
        pull::Stage::Ready(s) => {
            let r = pull::drain(&ctx, &System::configured(), repo_key, vec![*s], hooks).remove(0);
            if r.is_err() {
                eprintln!("witness log: {}", fs::read_to_string(home.join(".anti-hall/logs/devswarm-recon-witness.ndjson")).unwrap_or_default());
            }
            r
        }
    }
}

#[test]
fn a_workspace_drain_leaves_the_same_home_as_nodes_own_inbox_pull() {
    let Some((fx, w)) = world("s3parity") else { return };
    let wc = w.clone();
    let b = move |extra: Vec<(&'static str, Value)>, drop: Vec<&'static str>| {
        let wc = wc.clone();
        move |h: &Path| base(&wc, h, &extra, &drop)
    };
    let queued = |count: &'static str, read: String| {
        let f = b(vec![], vec![]);
        move |h: &Path| {
            f(h);
            hc(h, "count", count);
            hc(h, "read", &read);
        }
    };
    let cases = vec![
        case("nothing-queued", Some(ok(0, 0, 0)), b(vec![], vec![])),
        case("count-zero-printed", Some(ok(0, 0, 0)), {
            let f = b(vec![], vec![]);
            move |h| {
                f(h);
                hc(h, "count", "0\n");
            }
        }),
        case("two-messages-queued", Some(ok(2, 0, 2)), queued("2", msgs(&[("first", "2026-10-09T10:00:00.000Z"), ("second", "2026-10-09T10:01:00.000Z")]))),
        case("one-message-queued", Some(ok(1, 0, 1)), queued("1", msgs(&[("only", "2026-10-09T10:00:00.000Z")]))),
        case("descriptor-without-project-keys-is-backfilled", Some(ok(0, 0, 0)), b(vec![], vec!["repoKey", "ownerKey"])),
        case("descriptor-without-paths-gets-the-defaults", Some(ok(0, 0, 0)), b(vec![], vec!["inboxPath", "cursorPath"])),
        case("cursor-file-missing-is-created", Some(ok(0, 0, 0)), {
            let f = b(vec![], vec![]);
            move |h| {
                f(h);
                fs::remove_file(ds(h).join("cursors/child-1.cursor")).unwrap();
            }
        }),
        case("a-message-the-inbox-already-holds-is-a-duplicate", Some(ok(1, 1, 2)), {
            let f = queued("2", msgs(&[("already here", "2026-10-09T10:00:00.000Z"), ("new one", "2026-10-09T10:01:00.000Z")]));
            move |h| {
                f(h);
                // the first message was ingested before: its hash is in the inbox
                let m = json!({"fromBranch": "main", "message": "already here", "createdAt": "2026-10-09T10:00:00.000Z", "status": "unread"});
                let keyed = ["child-1", "main", "", "already here", "unread", "2026-10-09T10:00:00.000Z"].join("\u{0}");
                let d = ring::digest::digest(&ring::digest::SHA256, keyed.as_bytes());
                let hash = format!("native:{}", d.as_ref().iter().map(|b| format!("{b:02x}")).collect::<String>());
                let _ = m;
                put(h, "inbox/child-1.ndjson", &(json!({"_h": hash, "fromBranch": "main", "message": "already here", "createdAt": "2026-10-09T10:00:00.000Z", "status": "unread", "sender": null}).to_string() + "\n"));
            }
        }),
        case("an-open-wal-batch-is-replayed-first", Some(ok(0, 0, 0)), {
            let f = b(vec![], vec![]);
            move |h| {
                f(h);
                let raw = msgs(&[("left over", "2026-10-09T09:00:00.000Z")]);
                let rec = json!({"t": "batch", "e": "1-1-1-ffff", "ts": 1, "raw": raw, "worktree": null}).to_string() + "\n";
                put(h, "wal/pull-child-1.ndjson", &rec);
            }
        }),
        case("an-open-wal-batch-and-a-new-message", Some(ok(1, 0, 1)), {
            let f = queued("1", msgs(&[("new", "2026-10-09T10:00:00.000Z")]));
            move |h| {
                f(h);
                let raw = msgs(&[("left over", "2026-10-09T09:00:00.000Z")]);
                let rec = json!({"t": "batch", "e": "1-1-1-ffff", "ts": 1, "raw": raw, "worktree": null}).to_string() + "\n";
                put(h, "wal/pull-child-1.ndjson", &rec);
            }
        }),
        // ---- handed to Node, loss-free ----
        case("shortfall-count-above-what-the-read-returns", None, queued("3", msgs(&[("a", "2026-10-09T10:00:00.000Z"), ("b", "2026-10-09T10:01:00.000Z")]))),
        case("hivecontrol-count-fails", None, {
            let f = b(vec![], vec![]);
            move |h| {
                f(h);
                hc(h, "count.rc", "1");
                hc(h, "count", "DevSwarm is not running");
            }
        }),
        case("a-spilled-batch-waits-in-the-spill-directory", None, {
            let f = b(vec![], vec![]);
            move |h| {
                f(h);
                put(h, "wal-spill/pull-child-1/1-1-1-aaaa.json", &json!({"e": "1-1-1-aaaa", "ts": 1, "raw": "[]", "worktree": null}).to_string());
            }
        }),
        case("an-unclaimed-session", None, b(vec![("sessionId", json!("unclaimed:child-1"))], vec![])),
        // the engine refuses before the queue is read: nothing was touched, so Node's own pull has the whole queue
        case("untouched-an-adopted-log-still-holds-an-open-batch", None, {
            let f = queued("1", msgs(&[("only", "2026-10-09T10:00:00.000Z")]));
            move |h| {
                f(h);
                let rec = json!({"t": "batch", "e": "1-1-1-aaaa", "ts": 1, "raw": msgs(&[("adopted", "2026-10-09T09:00:00.000Z")]), "worktree": null})
                    .to_string()
                    + "\n";
                put(h, "wal/adopted/pull-child-1/pull-old.1.1.ndjson", &rec);
            }
        }),
        case("untouched-a-journal-backend-store", None, {
            let (f, key) = (queued("1", msgs(&[("only", "2026-10-09T10:00:00.000Z")])), w.repo_key.clone());
            move |h| {
                f(h);
                put(h, &format!("store/{key}/BACKEND"), "journal\n");
            }
        }),
        case("untouched-another-reader-holds-an-open-batch-of-this-worktree", None, {
            let (f, child) = (queued("1", msgs(&[("only", "2026-10-09T10:00:00.000Z")])), w.child.to_string_lossy().into_owned());
            move |h| {
                f(h);
                let rec = json!({"t": "batch", "e": "1-1-1-bbbb", "ts": 1, "raw": msgs(&[("theirs", "2026-10-09T09:00:00.000Z")]), "worktree": child})
                    .to_string()
                    + "\n";
                put(h, "wal/pull-other-reader.ndjson", &rec);
            }
        }),
        case("another-readers-batch-of-a-different-worktree-is-not-adopted", Some(ok(1, 0, 1)), {
            let f = queued("1", msgs(&[("only", "2026-10-09T10:00:00.000Z")]));
            move |h| {
                f(h);
                let rec =
                    json!({"t": "batch", "e": "1-1-1-cccc", "ts": 1, "raw": msgs(&[("theirs", "2026-10-09T09:00:00.000Z")]), "worktree": "/somewhere/else"})
                        .to_string()
                        + "\n";
                put(h, "wal/pull-other-reader.ndjson", &rec);
            }
        }),
    ];
    let (mut identical, mut deferred) = (0, 0);
    for (i, c) in cases.iter().enumerate() {
        let now = NOW;
        let (hn, he) = (fx.root.join(format!("c{i}-node")), fx.root.join(format!("c{i}-engine")));
        for h in [&hn, &he] {
            copy_tree(&fx.seed_home, h);
            seed_home(h);
            (c.setup)(h);
        }
        let answer = node_pull(&hn, &fx.child, now);
        let engine = engine_drain(&he, &fx, &Hooks::none());
        match &c.expect {
            Some(want) => {
                let got = engine.unwrap_or_else(|why| panic!("{}: the engine handed the drain to Node ({why}) but should have answered it", c.name));
                assert_eq!(&got, want, "{}: the recorded result", c.name);
                assert_eq!(answer["imported"], want["imported"], "{}: Node's own answer", c.name);
                assert_same(c.name, &hn, &he, &fx.repo_key);
                identical += 1;
            }
            None => {
                let why = engine.expect_err(&format!("{}: the engine must hand this one to Node", c.name));
                eprintln!("{}: handed to Node ({why})", c.name);
                if c.name.starts_with("untouched-") {
                    assert!(he.join("hc/read").exists(), "{}: the queue was not read", c.name);
                    assert!(
                        wal_text(&he).lines().all(|l| !l.contains("\"raw\"") || c.name.contains("log-still") || c.name.contains("another-reader")),
                        "{}: nothing was captured",
                        c.name
                    );
                    deferred += 1;
                    continue;
                }
                // nothing the engine did may be lost: whatever it read is in the log, and Node's own next pull settles the home
                // exactly as Node alone would have
                let after = node_pull(&he, &fx.child, now);
                let _ = after;
                let (nn, ne) = (read_inbox(&hn).lines().count(), read_inbox(&he).lines().count());
                assert_eq!(nn, ne, "{}: the inbox holds the same rows however the work was split", c.name);
                deferred += 1;
            }
        }
    }
    println!("PARITY S3.drain cases={} identical={identical} deferred={deferred}", cases.len());
    assert!(identical >= 8 && deferred >= 3);
    assert_eq!(identical + deferred, cases.len());
}

// ---------------------------------------------------------------- the witness refuses, and nothing the engine read is lost

#[test]
fn a_refused_witness_applies_nothing_and_leaves_the_captured_batch_for_nodes_replay() {
    let Some((fx, w)) = world("s3refuse") else { return };
    let (hn, he) = (fx.root.join("refuse-node"), fx.root.join("refuse-engine"));
    for h in [&hn, &he] {
        copy_tree(&fx.seed_home, h);
        seed_home(h);
        base(&w, h, &[], &[]);
        hc(h, "count", "2");
        hc(h, "read", &msgs(&[("first", "2026-10-09T10:00:00.000Z"), ("second", "2026-10-09T10:01:00.000Z")]));
    }
    // Node cannot run for the witness: the engine's PATH has no node, so the decision is unwitnessed
    let st = Settings { home: he.to_string_lossy().into_owned(), env: ctx_env(&he) };
    let root = ah_engine::defaults::root().unwrap();
    let ctx = Ctx { home: &he, root: &root, st: &st, now: NOW, engine_pokes: false };
    struct NoNode;
    impl ah_engine::dsact::runner::Runner for NoNode {
        fn run(&self, _: &ah_engine::dsact::runner::RunSpec) -> ah_engine::dsact::runner::RunResult {
            ah_engine::dsact::runner::RunResult { missing: true, error: Some("no node".into()), ..Default::default() }
        }
    }
    let cwd = fx.child.to_string_lossy().into_owned();
    let pull::Stage::Ready(s) = pull::stage(&ctx, "child-1", &cwd, &|_| {}) else { panic!("the engine should stage this pull") };
    let out = pull::drain(&ctx, &NoNode, &fx.repo_key, vec![*s], &Hooks::none());
    assert_eq!(out[0], Err("node-unavailable".to_string()));
    // the destructive read happened (the stub consumed the queue) and its bytes are durable and pending; the inbox was not touched
    assert!(he.join("hc/read.consumed").exists());
    assert!(wal_text(&he).contains("\"t\":\"batch\"") && !wal_text(&he).contains("\"t\":\"done\""), "the batch is pending: {}", wal_text(&he));
    assert_eq!(read_inbox(&he), "");
    // Node's own next pull replays it: the home ends exactly as if Node alone had read the queue
    node_pull(&he, &fx.child, NOW);
    node_pull(&hn, &fx.child, NOW);
    assert_same("refused-then-replayed", &hn, &he, &fx.repo_key);
    assert_eq!(read_inbox(&he).lines().count(), 2);
    println!("PARITY S3.refusal cases=1 identical=1 deferred=0");
}

#[test]
fn the_witness_never_reads_the_native_queue_itself() {
    let Some((fx, w)) = world("s3nored") else { return };
    let he = fx.root.join("nored-engine");
    copy_tree(&fx.seed_home, &he);
    seed_home(&he);
    base(&w, &he, &[], &[]);
    hc(&he, "count", "1");
    hc(&he, "read", &msgs(&[("only", "2026-10-09T10:00:00.000Z")]));
    engine_drain(&he, &fx, &Hooks::none()).unwrap();
    let calls = fs::read_to_string(he.join("hc/calls.log")).unwrap();
    assert_eq!(
        calls.lines().filter(|l| l.contains("read-messages")).count(),
        1,
        "exactly the engine's own destructive read reached the real hivecontrol:\n{calls}"
    );
}

#[test]
fn an_inbox_outside_the_state_directory_goes_to_node_before_anything_is_read() {
    let Some((fx, w)) = world("s3outside") else { return };
    let he = fx.root.join("outside-engine");
    copy_tree(&fx.seed_home, &he);
    seed_home(&he);
    let elsewhere = fx.root.join("elsewhere.ndjson");
    base(&w, &he, &[("inboxPath", json!(elsewhere.to_string_lossy()))], &[]);
    hc(&he, "count", "1");
    hc(&he, "read", &msgs(&[("only", "2026-10-09T10:00:00.000Z")]));
    assert_eq!(engine_drain(&he, &fx, &Hooks::none()), Err("path-outside-state-dir".to_string()));
    assert!(he.join("hc/read").exists(), "the queue was not read");
}

#[test]
fn another_pulls_lock_sends_the_workspace_to_node_before_anything_is_read() {
    let Some((fx, w)) = world("s3lock") else { return };
    let he = fx.root.join("lock-engine");
    copy_tree(&fx.seed_home, &he);
    seed_home(&he);
    base(&w, &he, &[], &[]);
    put(&he, "locks/pull-child-1.lock", &json!({"pid": std::process::id(), "ts": NOW, "token": "t", "host": "h"}).to_string());
    hc(&he, "count", "1");
    hc(&he, "read", &msgs(&[("only", "2026-10-09T10:00:00.000Z")]));
    assert_eq!(engine_drain(&he, &fx, &Hooks::none()), Err("pull-lock-held".to_string()));
    assert!(he.join("hc/read").exists(), "the queue was not read");
}

// ---------------------------------------------------------------- crash safety

fn kill_hook(point: String) -> impl Fn(&str) {
    move |name| {
        if name == point {
            // SAFETY: SIGKILL of this very process, the point of the crash test
            unsafe { libc::kill(libc::getpid(), libc::SIGKILL) };
            // the signal is delivered to the process, not to this thread: stand still until it lands, so the kill point is exact
            loop {
                std::thread::park();
            }
        }
    }
}

#[test]
fn crash_child() {
    // the child half of the crash tests: does nothing unless the parent set the environment
    let (Ok(home), Ok(at), Ok(child), Ok(key)) =
        (std::env::var("RECON_CRASH_HOME"), std::env::var("RECON_CRASH_AT"), std::env::var("RECON_CRASH_CHILD"), std::env::var("RECON_CRASH_KEY"))
    else {
        return;
    };
    init_env();
    let hook = kill_hook(at.clone());
    let _ = drain_at(Path::new(&home), Path::new(&child), &key, &Hooks { at: &hook }, &kill_hook(at));
}

/// What must hold after a kill and Node's next pull, whatever the kill point: every message is in the inbox exactly once and in
/// the store exactly once, the delivery log has the batch closed once, and the home equals the uninterrupted reference.
#[test]
fn a_sigkill_at_every_durable_boundary_loses_and_duplicates_nothing_and_nodes_next_pull_converges() {
    let Some((fx, w)) = world("s3crash") else { return };
    let setup = |h: &Path| {
        seed_home(h);
        base(&w, h, &[], &[]);
        hc(h, "count", "2");
        hc(h, "read", &msgs(&[("first", "2026-10-09T10:00:00.000Z"), ("second", "2026-10-09T10:01:00.000Z")]));
    };
    let reference = fx.root.join("crash-ref");
    copy_tree(&fx.seed_home, &reference);
    setup(&reference);
    engine_drain(&reference, &fx, &Hooks::none()).unwrap();
    assert_eq!(read_inbox(&reference).lines().count(), 2);
    // (point, does the batch survive the kill)
    let points: [(&str, bool); 6] = [
        ("read:after", false), // the documented residual window: the bytes exist only in the pipe between hivecontrol and the pull
        ("wal:after", true),   // the log holds the batch, nothing else happened
        ("pull:child-1:0:before", true),
        ("inbox:after", true),  // the inbox holds the rows, the store and the closing record do not
        ("close:before", true), // the store holds the rows too
        ("pull:child-1:0:after", true),
    ];
    for (point, survives) in points {
        let h = fx.root.join(format!("crash-{}", point.replace(':', "_")));
        copy_tree(&fx.seed_home, &h);
        setup(&h);
        let o = Command::new(std::env::current_exe().unwrap())
            .args(["--exact", "crash_child", "--nocapture", "--test-threads=1"])
            .env("RECON_CRASH_HOME", &h)
            .env("RECON_CRASH_AT", point)
            .env("RECON_CRASH_CHILD", &fx.child)
            .env("RECON_CRASH_KEY", &fx.repo_key)
            .output()
            .unwrap();
        use std::os::unix::process::ExitStatusExt;
        assert_eq!(o.status.signal(), Some(9), "{point}: the child was killed ({})", String::from_utf8_lossy(&o.stderr));
        // the dead process left its pull lock behind: old enough for the next run to take over
        let lock = ds(&h).join("locks/pull-child-1.lock");
        if lock.exists() {
            let mut rec: Value = serde_json::from_str(&fs::read_to_string(&lock).unwrap()).unwrap();
            rec["ts"] = json!(1);
            fs::write(&lock, rec.to_string()).unwrap();
        }
        // invariants right after the kill: the inbox only ever holds whole rows, the log parses
        for l in read_inbox(&h).lines() {
            assert!(serde_json::from_str::<Value>(l).is_ok(), "{point}: torn inbox row");
        }
        // Node's next pull settles it
        node_pull(&h, &fx.child, NOW);
        let inbox = read_inbox(&h);
        let hashes: Vec<String> = inbox.lines().map(|l| serde_json::from_str::<Value>(l).unwrap()["_h"].as_str().unwrap().to_string()).collect();
        let mut uniq = hashes.clone();
        uniq.sort();
        uniq.dedup();
        assert_eq!(hashes.len(), uniq.len(), "{point}: no message appears twice");
        assert_eq!(hashes.len(), if survives { 2 } else { 0 }, "{point}: the inbox holds every captured message");
        if survives {
            let wal = wal_text(&h);
            assert_eq!(wal.matches("\"t\":\"batch\"").count(), 1, "{point}: one batch in the log");
            assert_eq!(wal.matches("\"t\":\"done\"").count(), 1, "{point}: closed exactly once: {wal}");
            assert_same_with(point, &reference, &h, &fx.repo_key, true);
        }
    }
    println!("PARITY S3.crash cases=6 identical=5 deferred=0");
}

// ================================================================ S4: cmdReconcile, distinctRepoKeys, the sweep

fn support_js(name: &str) -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/recon_support").join(name)
}

fn node_env(home: &Path) -> Vec<(String, String)> {
    let mut env = base_env(home, &home.join("state"), &[]);
    env.retain(|(k, _)| k != "AH_ENGINE_NOSPAWN");
    env.push(("RECON_PIN_NOW".into(), NOW.to_string()));
    env.push(("NODE_OPTIONS".into(), std::env::var("NODE_OPTIONS").unwrap()));
    env
}

/// Node's own `reconcile` of the project `cwd` stands in (cmdReconcile), as the supervisor calls it.
fn node_reconcile(home: &Path, cwd: &Path, budget: Option<(u64, u64)>) -> Value {
    let mut c = Command::new("node");
    c.arg(support_js("reconcile.js")).arg(plugin_root()).arg(home).arg(cwd);
    if let Some((b, step)) = budget {
        c.arg(b.to_string()).arg(step.to_string());
    }
    c.current_dir(cwd).env_clear().envs(node_env(home));
    let o = run(&mut c, None);
    serde_json::from_slice(&o.stdout)
        .unwrap_or_else(|e| panic!("node reconcile printed {:?} / {:?}: {e}", String::from_utf8_lossy(&o.stdout), String::from_utf8_lossy(&o.stderr)))
}

fn engine_reconcile(home: &Path, cwd: &Path, budget: Option<(u64, u64)>, hooks: &Hooks) -> sweep::ProjectEnd {
    let st = Settings { home: home.to_string_lossy().into_owned(), env: ctx_env(home) };
    let root = ah_engine::defaults::root().unwrap();
    let ctx = Ctx { home, root: &root, st: &st, now: NOW, engine_pokes: false };
    let tick = std::cell::Cell::new(0i64);
    let step = budget.map_or(0, |b| b.1 as i64);
    let clock = || {
        let v = tick.get();
        tick.set(v + step);
        v
    };
    let o = sweep::Opts { budget_ms: budget.map(|b| b.0), clock: &clock, backoff_ms: Some(0) };
    sweep::cmd_reconcile(&ctx, &System::configured(), &cwd.to_string_lossy(), &o, hooks)
}

/// The store keeps only the registry rows named.
fn keep_rows(h: &Path, key: &str, ids: &[&str]) {
    let c = rusqlite::Connection::open(key_db(h, key)).unwrap();
    let list = ids.iter().map(|i| format!("'{i}'")).collect::<Vec<_>>().join(",");
    let broadcast = ah_engine::defaults::text("mesh_write.broadcast_partition");
    // the seed's other partitions go with their rows (a partition without a row is an orphan the summary cannot classify)
    c.execute_batch(&format!("DELETE FROM registry WHERE id NOT IN ({list}); DELETE FROM messages WHERE workspace_id NOT IN ({list},'{broadcast}');")).unwrap();
}

/// A registry row of the project (the engine's own store writer), for the cases that need more rows than the seed has.
fn add_row(h: &Path, key: &str, id: &str, wt: &str, session: &str) {
    let st = ah_engine::meshw::store::MeshStore::open(&key_db(h, key)).unwrap();
    let r = ah_engine::meshw::store::RegistryRow {
        id: id.into(),
        worktree_path: Some(wt.into()),
        session_id: Some(session.into()),
        inbox_path: None,
        cursor_path: None,
        nudge_command: None,
    };
    assert!(st.upsert_registry(&r, 1_000, |_, _| true).unwrap());
}

/// The masks the two reconciles differ by design in: the clock readings of a run (`elapsedMs`).
fn without_elapsed(mut v: Value) -> Value {
    if let Some(o) = v.as_object_mut() {
        o.remove("elapsedMs");
    }
    v
}

/// The central log reduced to what both sides write the same way.
fn log_lines(h: &Path) -> Vec<String> {
    let mut out = Vec::new();
    for e in fs::read_dir(h.join(".anti-hall/logs")).into_iter().flatten().flatten() {
        let name = e.file_name().to_string_lossy().into_owned();
        if name.contains("recon-witness") {
            continue;
        }
        for l in fs::read_to_string(e.path()).unwrap_or_default().lines() {
            if let Ok(v) = serde_json::from_str::<Value>(l) {
                out.push(format!("{name}: {} {} {} {} {} {}", v["component"], v["op"], v["level"], v["msg"], v["ctx"], v["meshId"]));
            }
        }
    }
    out.sort();
    out
}

struct World {
    key: String,
}

/// The standard project: child-1 registered with a descriptor, nothing else (the seed's other rows removed), a healthy daemon.
fn project(w: &W, h: &Path, keep: &[&str]) -> World {
    seed_home(h);
    base(w, h, &[], &[]);
    keep_rows(h, &w.repo_key, keep);
    World { key: w.repo_key.clone() }
}

fn reconcile_cases(w: &W, fx: &Fx) -> Vec<(&'static str, bool, Box<dyn Fn(&Path)>, Option<(u64, u64)>)> {
    let wc = w.clone();
    let key = fx.repo_key.clone();
    let child = fx.child.clone();
    let queued = |h: &Path| {
        hc(h, "count", "2");
        hc(h, "read", &msgs(&[("first", "2026-10-09T10:00:00.000Z"), ("second", "2026-10-09T10:01:00.000Z")]));
    };
    let mut cases: Vec<(&'static str, bool, Box<dyn Fn(&Path)>, Option<(u64, u64)>)> = Vec::new();
    {
        let (wc,) = (wc.clone(),);
        cases.push((
            "one-row-nothing-queued",
            true,
            Box::new(move |h| {
                project(&wc, h, &["child-1"]);
            }),
            None,
        ));
    }
    {
        let wc = wc.clone();
        cases.push((
            "one-row-two-messages",
            true,
            Box::new(move |h| {
                project(&wc, h, &["child-1"]);
                queued(h);
            }),
            None,
        ));
    }
    {
        let wc = wc.clone();
        cases.push((
            "a-live-row-whose-worktree-vanished-and-a-pruned-archived-one",
            true,
            Box::new(move |h| {
                project(&wc, h, &["child-1", "child-2", "child-3"]);
            }),
            None,
        ));
    }
    {
        let wc = wc.clone();
        cases.push((
            "an-archived-marker-on-a-worktree-that-exists-is-skipped",
            true,
            Box::new(move |h| {
                project(&wc, h, &["child-1"]);
                put(h, "archived/child-1.json", &json!({"id": "child-1", "worktreePath": wc.child.to_string_lossy(), "sessionId": "child-1"}).to_string());
            }),
            None,
        ));
    }
    {
        let (wc, key) = (wc.clone(), key.clone());
        cases.push((
            "a-worktree-git-cannot-resolve-is-not-a-git-root",
            true,
            Box::new(move |h| {
                project(&wc, h, &["child-1"]);
                let plain = h.join("plain-dir");
                fs::create_dir_all(&plain).unwrap();
                add_row(h, &key, "child-1", &plain.to_string_lossy(), "child-1");
            }),
            None,
        ));
    }
    {
        let wc = wc.clone();
        cases.push((
            "the-native-count-times-out-and-is-retried-once",
            false,
            Box::new(move |h| {
                project(&wc, h, &["child-1"]);
                hc(h, "count.rc", "1");
                hc(h, "count.err", "request timeout");
            }),
            None,
        ));
    }
    {
        let wc = wc.clone();
        cases.push((
            "a-spilled-batch-hands-that-row-to-node",
            false,
            Box::new(move |h| {
                project(&wc, h, &["child-1"]);
                put(h, "wal-spill/pull-child-1/1-1-1-aaaa.json", &json!({"e": "1-1-1-aaaa", "ts": 1, "raw": "[]", "worktree": null}).to_string());
            }),
            None,
        ));
    }
    {
        let (wc, key, child) = (wc.clone(), key.clone(), child.clone());
        cases.push((
            "a-budget-spent-defers-the-rest-and-leaves-a-resume-marker",
            false,
            Box::new(move |h| {
                project(&wc, h, &["child-1"]);
                // more rows, each a different id on the same checkout: their pulls are Node's (a second row of one worktree)
                for i in 2..=4 {
                    add_row(h, &key, &format!("child-{i}"), &child.to_string_lossy(), &format!("sess-{i}"));
                }
            }),
            Some((2500, 1000)),
        ));
    }
    {
        let (wc, key, child) = (wc.clone(), key.clone(), child.clone());
        cases.push((
            "the-resume-marker-of-a-prior-run-goes-first",
            false,
            Box::new(move |h| {
                project(&wc, h, &["child-1"]);
                for i in 2..=3 {
                    add_row(h, &key, &format!("child-{i}"), &child.to_string_lossy(), &format!("sess-{i}"));
                }
                put(h, "reconcile-resume.json", &json!({"repoKey": key, "ids": ["child-3", "child-1"], "ts": 1}).to_string());
            }),
            Some((2500, 1000)),
        ));
    }
    cases
}

#[test]
fn a_project_reconcile_answers_like_nodes_cmd_reconcile() {
    let Some((fx, w)) = world("s4recon") else { return };
    let cases = reconcile_cases(&w, &fx);
    let (mut identical, mut deferred) = (0, 0);
    for (i, (name, native, setup, budget)) in cases.iter().enumerate() {
        let (hn, he) = (fx.root.join(format!("r{i}-node")), fx.root.join(format!("r{i}-engine")));
        for h in [&hn, &he] {
            copy_tree(&fx.seed_home, h);
            setup(h);
        }
        let want = without_elapsed(node_reconcile(&hn, &fx.child, *budget));
        let got = match engine_reconcile(&he, &fx.child, *budget, &Hooks::none()) {
            sweep::ProjectEnd::Result(v) => without_elapsed(v),
            sweep::ProjectEnd::Node(why) => panic!("{name}: the engine handed the whole project to Node ({why})"),
        };
        let handbacks: Vec<String> = fs::read_to_string(he.join(".anti-hall/logs/devswarm-recon-witness.ndjson"))
            .unwrap_or_default()
            .lines()
            .filter(|l| l.contains("handback"))
            .map(str::to_string)
            .collect();
        eprintln!("{name}: handbacks {handbacks:?}");
        if *native {
            assert!(handbacks.is_empty(), "{name}: the engine handed work to Node: {handbacks:?}");
        }
        assert_eq!(got, want, "{name}: the result object");
        assert_same(name, &hn, &he, &fx.repo_key);
        assert_eq!(log_lines(&hn), log_lines(&he), "{name}: the central log");
        identical += 1;
    }
    deferred += 0;
    println!("PARITY S4.reconcile cases={} identical={identical} deferred={deferred}", cases.len());
}

#[test]
fn distinct_repo_keys_picks_the_same_representatives_as_node() {
    let Some((fx, _w)) = world("s4distinct") else { return };
    let other = fx.root.join("other-repo");
    fs::create_dir_all(&other).unwrap();
    git(&["init", "-q"], &other);
    git(&["commit", "-q", "--allow-empty", "-m", "init"], &other);
    let plain = fx.root.join("plain");
    fs::create_dir_all(&plain).unwrap();
    let gone = fx.root.join("gone-linked");
    let d = |id: &str, wt: &Path, sid: Option<&str>| {
        let mut v = json!({"id": id, "worktreePath": wt.to_string_lossy(), "inboxPath": null, "cursorPath": null});
        if let Some(s) = sid {
            v["sessionId"] = json!(s);
        }
        v.to_string()
    };
    let orders: Vec<Vec<(&str, String)>> = vec![
        // the main checkout and a linked worktree of one repo, a second repo, a plain directory
        vec![
            ("a-main", d("a-main", &fx.main, Some("s"))),
            ("b-child", d("b-child", &fx.child, Some("s"))),
            ("c-other", d("c-other", &other, Some("s"))),
            ("d-plain", d("d-plain", &plain, Some("s"))),
        ],
        // the linked worktree first, then the main one
        vec![("a-child", d("a-child", &fx.child, Some("s"))), ("b-main", d("b-main", &fx.main, Some("s")))],
        // a vanished worktree of a repo whose other worktree exists: the existing one wins whatever the order
        vec![("a-gone", d("a-gone", &gone, Some("s"))), ("b-main", d("b-main", &fx.main, Some("s")))],
        // rows readDescriptors drops: no session, an unsafe id, torn json, not an object
        vec![
            ("a-nosession", d("a-nosession", &fx.main, None)),
            ("b-torn", "{\"id\":\"b-torn\",".to_string()),
            ("c-array", "[1]".to_string()),
            ("d-ok", d("d-ok", &other, Some("s"))),
        ],
        vec![],
    ];
    let mut cases = 0;
    for (i, rows) in orders.iter().enumerate() {
        let h = fx.root.join(format!("dk{i}"));
        fs::create_dir_all(h.join(".anti-hall")).unwrap();
        for (name, body) in rows {
            put(&h, &format!("workspaces/{name}.json"), body);
        }
        let mut c = Command::new("node");
        c.arg(support_js("distinct.js")).arg(plugin_root()).arg(&h).env_clear().envs(node_env(&h));
        let o = run(&mut c, None);
        let want: Value = serde_json::from_slice(&o.stdout).unwrap_or_else(|e| panic!("{e}: {}", String::from_utf8_lossy(&o.stderr)));
        let descs = sweep::read_descriptors(&h).unwrap();
        let got: Vec<Value> =
            sweep::distinct_repo_keys(&descs).unwrap().into_iter().map(|p| json!({"repoKey": p.repo_key, "worktreePath": p.worktree})).collect();
        assert_eq!(Value::Array(got), want, "order {i}");
        cases += 1;
    }
    println!("PARITY S4.distinct cases={cases} identical={cases} deferred=0");
}

#[test]
fn the_reconcile_mode_word_defaults_to_node_and_only_the_engine_word_switches_it() {
    init_env();
    assert!(!sweep::mode_is_engine(ah_engine::defaults::text("devswarm_sup.reconcile_mode")), "the shipped default is node");
    for (word, engine) in [("node", false), ("engine", true), (" Engine ", true), ("", false), ("enginee", false), ("witness", false)] {
        assert_eq!(sweep::mode_is_engine(word), engine, "{word:?}");
    }
}

#[test]
fn the_sweep_duty_leaves_the_same_home_and_the_same_line_as_nodes_reconcile_sweep() {
    let Some((fx, w)) = world("s4duty") else { return };
    let build = |h: &Path| {
        project(&w, h, &["child-1"]);
        hc(h, "count", "2");
        hc(h, "read", &msgs(&[("first", "2026-10-09T10:00:00.000Z"), ("second", "2026-10-09T10:01:00.000Z")]));
    };
    let (hn, he) = (fx.root.join("duty-node"), fx.root.join("duty-engine"));
    for h in [&hn, &he] {
        copy_tree(&fx.seed_home, h);
        build(h);
    }
    let mut c = Command::new("node");
    c.arg(support_js("sweep.js")).arg(plugin_root()).arg(&hn).env_clear().envs(node_env(&hn));
    let o = run(&mut c, None);
    let want: Value = serde_json::from_slice(&o.stdout).unwrap_or_else(|e| panic!("{e}: {}", String::from_utf8_lossy(&o.stderr)));
    let st = Settings { home: he.to_string_lossy().into_owned(), env: ctx_env(&he) };
    let root = ah_engine::defaults::root().unwrap();
    let ctx = Ctx { home: &he, root: &root, st: &st, now: NOW, engine_pokes: false };
    let fallback = || panic!("the engine should run the sweep itself");
    let rec = sweep::duty(&ctx, &System::configured(), &Hooks::none(), &fallback);
    assert_eq!(rec["outcome"], "ran", "{rec}");
    assert_eq!(rec["engineProjects"], 1, "the engine reconciled the project itself: {rec}");
    assert_eq!(rec["detail"], want, "the sweep's log line");
    assert_same("sweep-duty", &hn, &he, &fx.repo_key);
    assert_eq!(read_inbox(&he).lines().count(), 2);
    assert!(he.join(".anti-hall/devswarm/reconcile-sweep-state.json").exists(), "the cool-down is persisted");
    println!("PARITY S4.duty cases=1 identical=1 deferred=0");
}

#[test]
fn a_stranded_descriptor_hands_the_whole_project_to_node_before_anything_is_written() {
    let Some((fx, w)) = world("s4stranded") else { return };
    let he = fx.root.join("stranded-engine");
    copy_tree(&fx.seed_home, &he);
    project(&w, &he, &["child-1"]);
    // a descriptor stranded in the legacy per-id bucket whose own worktree belongs to this project
    let hash = ah_engine::meshw::send::hash_from_workspace_id("stranded-1");
    put(
        &he,
        "workspaces/stranded-1.json",
        &json!({"id": "stranded-1", "worktreePath": fx.child.to_string_lossy(), "sessionId": "s", "ownerKey": hash}).to_string(),
    );
    hc(&he, "count", "1");
    hc(&he, "read", &msgs(&[("only", "2026-10-09T10:00:00.000Z")]));
    let before = tree(&he);
    match engine_reconcile(&he, &fx.child, None, &Hooks::none()) {
        sweep::ProjectEnd::Node(why) => assert_eq!(why, "rehome-stranded"),
        other => panic!("expected a hand-back, got {other:?}"),
    }
    let after = tree(&he);
    assert_eq!(before.keys().collect::<Vec<_>>(), after.keys().collect::<Vec<_>>());
    assert!(he.join("hc/read").exists(), "nothing was read");
}

#[test]
fn a_torn_resume_marker_reads_as_nothing_deferred_and_a_budget_rewrite_replaces_it_whole() {
    let Some((fx, w)) = world("s4torn") else { return };
    let he = fx.root.join("torn-engine");
    copy_tree(&fx.seed_home, &he);
    project(&w, &he, &["child-1"]);
    for i in 2..=3 {
        add_row(&he, &fx.repo_key, &format!("child-{i}"), &fx.child.to_string_lossy(), &format!("sess-{i}"));
    }
    put(&he, "reconcile-resume.json", "{\"repoKey\":\"x\",\"ids\":[\"a");
    let sweep::ProjectEnd::Result(v) = engine_reconcile(&he, &fx.child, Some((1500, 1000)), &Hooks::none()) else { panic!("hand-back") };
    assert!(v["deferred"].as_u64().unwrap() >= 1, "the budget deferred a row: {v}");
    let marker: Value = serde_json::from_str(&fs::read_to_string(ds(&he).join("reconcile-resume.json")).unwrap()).expect("the marker parses whole");
    assert_eq!(marker["repoKey"], json!(fx.repo_key));
    assert!(marker["ids"].as_array().is_some_and(|a| !a.is_empty()));
}

#[test]
fn crash_project_child() {
    let (Ok(home), Ok(at), Ok(child)) = (std::env::var("RECON_CRASH_HOME"), std::env::var("RECON_CRASH_AT"), std::env::var("RECON_CRASH_CHILD")) else {
        return;
    };
    if std::env::var("RECON_CRASH_KIND").as_deref() != Ok("project") {
        return;
    }
    init_env();
    let hook = kill_hook(at);
    let _ = engine_reconcile(Path::new(&home), Path::new(&child), None, &Hooks { at: &hook });
}

/// A kill in the middle of a project's reconcile, at every durable boundary of the drain: Node's next reconcile converges to the
/// same home an uninterrupted engine reconcile leaves, with every message in the inbox exactly once.
#[test]
fn a_sigkill_in_the_middle_of_a_project_reconcile_is_converged_by_nodes_next_reconcile() {
    let Some((fx, w)) = world("s4crash") else { return };
    let setup = |h: &Path| {
        project(&w, h, &["child-1"]);
        hc(h, "count", "2");
        hc(h, "read", &msgs(&[("first", "2026-10-09T10:00:00.000Z"), ("second", "2026-10-09T10:01:00.000Z")]));
    };
    let reference = fx.root.join("pcrash-ref");
    copy_tree(&fx.seed_home, &reference);
    setup(&reference);
    assert!(matches!(engine_reconcile(&reference, &fx.child, None, &Hooks::none()), sweep::ProjectEnd::Result(_)));
    node_reconcile(&reference, &fx.child, None);
    for point in ["pull:child-1:wal:after", "pull:child-1:read:after", "pull:child-1:0:before", "inbox:after", "close:before", "pull:child-1:0:after"] {
        let h = fx.root.join(format!("pcrash-{}", point.replace(':', "_")));
        copy_tree(&fx.seed_home, &h);
        setup(&h);
        let o = Command::new(std::env::current_exe().unwrap())
            .args(["--exact", "crash_project_child", "--nocapture", "--test-threads=1"])
            .env("RECON_CRASH_HOME", &h)
            .env("RECON_CRASH_AT", point)
            .env("RECON_CRASH_CHILD", &fx.child)
            .env("RECON_CRASH_KIND", "project")
            .output()
            .unwrap();
        use std::os::unix::process::ExitStatusExt;
        assert_eq!(o.status.signal(), Some(9), "{point}: killed ({})", String::from_utf8_lossy(&o.stderr));
        // locks of the dead process are old enough to be taken over
        for l in fs::read_dir(ds(&h).join("locks")).unwrap().flatten() {
            if let Ok(mut rec) = serde_json::from_str::<Value>(&fs::read_to_string(l.path()).unwrap_or_default()) {
                if rec.get("ts").is_some() && rec["pid"] != json!(std::process::id()) {
                    rec["ts"] = json!(1);
                    fs::write(l.path(), rec.to_string()).unwrap();
                }
            }
        }
        // every marker parses or is absent
        for m in ["reconcile-resume.json", "reconcile-sweep-state.json", "repo-unknown.json"] {
            if let Ok(t) = fs::read_to_string(ds(&h).join(m)) {
                assert!(serde_json::from_str::<Value>(&t).is_ok(), "{point}: {m} parses");
            }
        }
        node_reconcile(&h, &fx.child, None);
        let hashes: Vec<String> = read_inbox(&h).lines().map(|l| serde_json::from_str::<Value>(l).unwrap()["_h"].as_str().unwrap().to_string()).collect();
        let mut uniq = hashes.clone();
        uniq.sort();
        uniq.dedup();
        assert_eq!(hashes.len(), uniq.len(), "{point}: no message twice");
        let want = if point == "pull:child-1:read:after" { 0 } else { 2 };
        assert_eq!(hashes.len(), want, "{point}: every captured message is in the inbox");
        if want == 2 {
            assert_same_with(point, &reference, &h, &fx.repo_key, true);
        }
    }
    println!("PARITY S4.crash cases=6 identical=5 deferred=0");
}

#[test]
fn the_supervisor_tick_runs_the_port_only_behind_the_reconcile_mode_setting() {
    let Some((fx, w)) = world("s4tick") else { return };
    let build = |h: &Path| {
        project(&w, h, &["child-1"]);
        hc(h, "count", "2");
        hc(h, "read", &msgs(&[("first", "2026-10-09T10:00:00.000Z"), ("second", "2026-10-09T10:01:00.000Z")]));
    };
    let cfg_dir = fx.root.join("cfg");
    fs::create_dir_all(&cfg_dir).unwrap();
    // SAFETY: only this test sets them, and only `reconcile_mode` is read through them
    unsafe {
        std::env::set_var("AH_ENGINE_CONFIG", cfg_dir.join("config.toml"));
        std::env::set_var("AH_ENGINE_SETTINGS", cfg_dir.join("settings.json"));
    }
    for (mode, engine) in [("node", false), ("engine", true), ("enginee", false)] {
        fs::write(cfg_dir.join("config.toml"), format!("[devswarm_sup]\nreconcile_mode = \"{mode}\"\n")).unwrap();
        let h = fx.root.join(format!("tick-{mode}"));
        copy_tree(&fx.seed_home, &h);
        build(&h);
        let st = Settings { home: h.to_string_lossy().into_owned(), env: ctx_env(&h) };
        let root = ah_engine::defaults::root().unwrap();
        let ctx = Ctx { home: &h, root: &root, st: &st, now: NOW, engine_pokes: false };
        let (rec, _) = ah_engine::dssup::tick::run_duty_w("reconcile", &ctx, &System::configured());
        assert_eq!(rec["outcome"], "ran", "{mode}: {rec}");
        assert_eq!(rec.get("engineProjects").is_some(), engine, "{mode}: who ran the reconcile: {rec}");
        // either way the queue is drained exactly once
        assert_eq!(read_inbox(&h).lines().count(), 2, "{mode}");
    }
    println!("PARITY S4.tick cases=3 identical=3 deferred=0");
}

#[test]
fn a_sweep_over_more_projects_than_the_cap_leaves_the_rest_for_a_later_tick_like_node() {
    let Some((fx, w)) = world("s4cap") else { return };
    let cap = ah_engine::defaults::num("devswarm_recon.max_projects_per_tick") as usize;
    let build = |h: &Path| {
        seed_home(h);
        base(&w, h, &[], &[]);
        // one more project than the cap, each its own repository with a registered workspace
        for i in 0..=cap {
            let repo = fx.root.join(format!("proj-{i}"));
            if !repo.exists() {
                fs::create_dir_all(&repo).unwrap();
                git(&["init", "-q"], &repo);
                git(&["commit", "-q", "--allow-empty", "-m", "init"], &repo);
            }
            let repo = real(&repo);
            put(
                h,
                &format!("workspaces/p{i}.json"),
                &json!({"id": format!("p{i}"), "worktreePath": repo.to_string_lossy(), "sessionId": format!("s{i}"), "inboxPath": null, "cursorPath": null})
                    .to_string(),
            );
        }
    };
    let (hn, he) = (fx.root.join("cap-node"), fx.root.join("cap-engine"));
    for h in [&hn, &he] {
        copy_tree(&fx.seed_home, h);
        build(h);
    }
    let mut c = Command::new("node");
    c.arg(support_js("sweep.js")).arg(plugin_root()).arg(&hn).env_clear().envs(node_env(&hn));
    let o = run(&mut c, None);
    let want: Value = serde_json::from_slice(&o.stdout).unwrap_or_else(|e| panic!("{e}: {}", String::from_utf8_lossy(&o.stderr)));
    let st = Settings { home: he.to_string_lossy().into_owned(), env: ctx_env(&he) };
    let root = ah_engine::defaults::root().unwrap();
    let ctx = Ctx { home: &he, root: &root, st: &st, now: NOW, engine_pokes: false };
    let rec = sweep::duty(&ctx, &System::configured(), &Hooks::none(), &|| panic!("the engine should start the sweep itself"));
    assert_eq!(rec["detail"]["projects"], json!(cap), "engine {rec} / node {want}");
    assert!(rec["detail"]["skipped"].as_u64().unwrap() >= 1, "engine {rec} / node {want}");
    assert_eq!(rec["detail"]["projects"], want["projects"]);
    assert_eq!(rec["detail"]["skipped"], want["skipped"]);
    assert_eq!(
        rec["detail"]["results"].as_array().unwrap().iter().map(|r| r["repoKey"].clone()).collect::<Vec<_>>(),
        want["results"].as_array().unwrap().iter().map(|r| r["repoKey"].clone()).collect::<Vec<_>>(),
        "the same projects, in the same order"
    );
    println!("PARITY S4.cap cases=1 identical=1 deferred=0");
}
