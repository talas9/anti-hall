//! Parity of `inbox tick <id> --child` (lane l8e): `ah-engine mesh inbox tick ... --child` (mesh.engine_writes = on) against the
//! real `node scripts/devswarm.js inbox tick ... --child`.
//!
//! A `--child` tick first PULLS: it ensures the registration (descriptor backfill, cursor and inbox pre-create, registry upsert),
//! takes the pull lock, replays the open batches of the delivery write-ahead log, asks `hivecontrol workspace message-count` and,
//! for a count above zero, drains the native queue with the ONE destructive `workspace read-messages` into the NDJSON inbox, the
//! store and the WAL; then it counts and writes the tick records. Every case runs Node and the engine on identical copies of one
//! seeded home with the same pinned clock and a RECORDING hivecontrol stub (a shell script on the PATH of both, which logs every
//! call under `$HOME/hc/calls.log`, answers from files in `$HOME/hc` and makes a read destructive by consuming the queue file), and
//! compares stdout, the exit code, the whole home tree (descriptor, inbox, cursor, WAL, summaries, the stub's call log) and every
//! table of the store. A case the engine must hand to Node is run a third time with no Node on the PATH: it must exit 75, print
//! nothing and write nothing (the stub's call log aside: the count is a read).
#![allow(clippy::unwrap_used, clippy::expect_used)] // a test crate: a panic is the failure report, and E2 exempts tests
use serde_json::{Value, json};
use std::collections::BTreeMap;
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

type Setup = Box<dyn Fn(&Path)>;

/// What the cases need to know about the fixture.
#[derive(Clone)]
struct W {
    repo_key: String,
    child: PathBuf,
}

struct Lc {
    name: String,
    argv: Vec<String>,
    cwd: &'static str,
    setup: Setup,
    env: Vec<(String, String)>,
    native: bool,
    /// Run without the recording stub on the PATH (no hivecontrol at all).
    no_hc: bool,
}

fn lc(name: &str, argv: &[&str], native: bool) -> Lc {
    Lc { name: name.into(), argv: argv.iter().map(|s| (*s).into()).collect(), cwd: "child", setup: Box::new(|_| {}), env: vec![], native, no_hc: false }
}

impl Lc {
    fn env(mut self, k: &str, v: &str) -> Lc {
        self.env.push((k.into(), v.into()));
        self
    }
    fn setup(mut self, f: impl Fn(&Path) + 'static) -> Lc {
        self.setup = Box::new(f);
        self
    }
    fn cwd(mut self, c: &'static str) -> Lc {
        self.cwd = c;
        self
    }
    fn no_hc(mut self) -> Lc {
        self.no_hc = true;
        self
    }
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

/// The standard child: descriptor (project keys present), empty inbox, cursor 0, a live wake-watch lock, nothing in the queue.
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
    // the reader-cursor floor rows a registered child has (the store is read from the floor, the NDJSON inbox from its cursor)
    let floor = |ns: &str, v: i64| json!({"partition": "child-1", "ns": ns, "reader": "#floor", "value": v, "updatedAt": NOW - 1000});
    run_seed("ack_seed.js", h, &w.repo_key, &json!({"rows": [floor("store", 2), floor("nd", 0)]}));
    put(h, "inbox/child-1.ndjson", "");
    put(h, "cursors/child-1.cursor", "0");
    wake_lock(h);
}

fn wake_lock(h: &Path) {
    put(h, "locks/wake-watch-child-1.lock", &json!({"pid": std::process::id(), "ts": NOW, "version": "x"}).to_string());
}

fn read_inbox(h: &Path) -> String {
    fs::read_to_string(ds(h).join("inbox/child-1.ndjson")).unwrap_or_default()
}

fn wal_file(h: &Path) -> PathBuf {
    ds(h).join("wal/pull-child-1.ndjson")
}

fn tools_path(root: &Path, with_node: bool) -> String {
    let bin = root.join(if with_node { "tools-bin" } else { "nonode-bin" });
    fs::create_dir_all(&bin).unwrap();
    let list: &[&str] = if with_node { &["node", "git", "ps"] } else { &["git", "ps"] };
    for t in list {
        let out = Command::new("sh").args(["-c", &format!("command -v {t}")]).output().unwrap();
        let src = String::from_utf8_lossy(&out.stdout).trim().to_string();
        std::os::unix::fs::symlink(&src, bin.join(t)).ok();
    }
    bin.display().to_string()
}

fn stub_dir(root: &Path) -> String {
    use std::os::unix::fs::PermissionsExt;
    let dir = root.join("stub-bin");
    fs::create_dir_all(&dir).unwrap();
    let f = dir.join("hivecontrol");
    fs::write(&f, STUB).unwrap();
    fs::set_permissions(&f, fs::Permissions::from_mode(0o755)).unwrap();
    dir.display().to_string()
}

struct Out {
    code: i32,
    stdout: String,
    stderr: String,
}

fn node_cli(home: &Path, cwd: &Path, argv: &[String], now: i64, env: &[(String, String)]) -> Out {
    let cli = plugin_root().join("scripts").join("devswarm.js");
    let mut c = Command::new("node");
    let e: Vec<(&str, &str)> = env.iter().map(|(k, v)| (k.as_str(), v.as_str())).collect();
    c.arg("-e").arg(SNIPPET).arg(&cli).arg(now.to_string()).args(argv).current_dir(cwd).env_clear().envs(base_env(home, &home.join("state"), &e));
    let o = run(&mut c, None);
    Out {
        code: o.status.code().unwrap_or(-1),
        stdout: String::from_utf8_lossy(&o.stdout).into_owned(),
        stderr: String::from_utf8_lossy(&o.stderr).into_owned(),
    }
}

fn engine_cli(home: &Path, cwd: &Path, argv: &[String], now: i64, env: &[(String, String)]) -> Out {
    let mut c = Command::new(BIN);
    let e: Vec<(&str, &str)> = env.iter().map(|(k, v)| (k.as_str(), v.as_str())).collect();
    c.arg("mesh").args(argv).current_dir(cwd).env_clear().envs(base_env(home, &home.join("state"), &e)).env("AH_ENGINE_MESH_NOW_MS", now.to_string());
    let o = run(&mut c, None);
    Out {
        code: o.status.code().unwrap_or(-1),
        stdout: String::from_utf8_lossy(&o.stdout).into_owned(),
        stderr: String::from_utf8_lossy(&o.stderr).into_owned(),
    }
}

/// The pid and the random part of a WAL entry id differ between the two processes by design.
fn mask_wal(text: &str) -> String {
    let e = regex::Regex::new(r#""e":"[^"]*""#).unwrap().replace_all(text, r#""e":"E""#).into_owned();
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

fn tree(home: &Path) -> BTreeMap<String, String> {
    home_files(home)
        .into_iter()
        .map(|(k, v)| {
            let text = String::from_utf8_lossy(&v).replace(home.to_string_lossy().as_ref(), "<HOME>");
            let text = if k.contains("/wal/") || k.contains("/wal-spill/") { mask_wal(&text) } else { text };
            let text = if k.contains("/cursor-log/") { mask_journal(&text) } else { text };
            (k, text)
        })
        .collect()
}

/// The lines a pull itself prints to stderr (Node prints other things too: its experimental-feature notices).
fn pull_lines(stderr: &str, home: &Path) -> Vec<String> {
    stderr.lines().filter(|l| l.starts_with("devswarm-pull:")).map(|l| mask_wal(&l.replace(home.to_string_lossy().as_ref(), "<HOME>"))).collect()
}

fn seed_home(w: &W, h: &Path, c: &Lc) {
    fs::create_dir_all(h.join(".anti-hall")).unwrap();
    fs::write(h.join(".anti-hall/settings.json"), "{\"mesh\":{\"engine_writes\":\"on\"}}\n").unwrap();
    (c.setup)(h);
    let _ = w;
}

fn last_native(state: &Path) -> bool {
    last_log(state)["result"] == "native"
}

fn run_cases(fx: &Fx, w: &W, cases: &[Lc], min_native: usize, min_deferred: usize) {
    let tools = tools_path(&fx.root, true);
    let nonode = tools_path(&fx.root, false);
    let stub = stub_dir(&fx.root);
    let key_db = |h: &Path| ds(h).join("store").join(&fx.repo_key).join("devswarm.db");
    let (mut native, mut deferred) = (0, 0);
    for (i, c) in cases.iter().enumerate() {
        if std::env::var("AH_L8E_FILTER").is_ok_and(|f| !c.name.contains(&f)) {
            continue;
        }
        let now = NOW + i as i64 % 50;
        let cwd = match c.cwd {
            "child" => fx.child.clone(),
            "main" => fx.main.clone(),
            _ => unreachable!(),
        };
        let homes: Vec<PathBuf> = ["node", "engine", "defer"].iter().map(|k| fx.root.join(format!("e{i}-{k}"))).collect();
        for h in &homes {
            copy_tree(&fx.seed_home, h);
            seed_home(w, h, c);
        }
        let path_with = |tools: &str| if c.no_hc { tools.to_string() } else { format!("{stub}:{tools}") };
        let env_for = |path: String| -> Vec<(String, String)> {
            let mut e = c.env.clone();
            e.push(("PATH".into(), path));
            e
        };
        let n = node_cli(&homes[0], &cwd, &c.argv, now, &env_for(path_with(&tools)));
        let e = engine_cli(&homes[1], &cwd, &c.argv, now, &env_for(path_with(&tools)));
        let log = last_log(&homes[1].join("state"));
        if std::env::var("AH_L8E_DEBUG").is_ok() {
            eprintln!("{}: engine stderr {:?} / node stderr {:?}", c.name, e.stderr, n.stderr);
        }
        assert_eq!(
            last_native(&homes[1].join("state")),
            c.native,
            "{}: expected native={} but the engine logged {log} (engine exit {} stdout {:?} stderr {:?}; node exit {} stdout {:?})",
            c.name,
            c.native,
            e.code,
            e.stdout,
            e.stderr,
            n.code,
            n.stdout
        );
        if c.native {
            native += 1;
            let (es, ns) = (e.stdout.replace(homes[1].to_string_lossy().as_ref(), "<HOME>"), n.stdout.replace(homes[0].to_string_lossy().as_ref(), "<HOME>"));
            assert_eq!((e.code, &es), (n.code, &ns), "{}: stdout/exit differ\n engine: {es:?}\n node:   {ns:?}", c.name);
            assert_eq!(pull_lines(&e.stderr, &homes[1]), pull_lines(&n.stderr, &homes[0]), "{}: the pull's stderr differs", c.name);
            if key_db(&homes[0]).is_file() {
                let norm = |h: &Path| mask_dump(&raw_dump(&key_db(h))).replace(h.to_string_lossy().as_ref(), "<HOME>");
                let (de, dn) = (norm(&homes[1]), norm(&homes[0]));
                assert!(de == dn, "{}: the store differs: {}", c.name, first_diff(&dn, &de));
            }
            let (te, tn) = (tree(&homes[1]), tree(&homes[0]));
            for k in te.keys().chain(tn.keys()) {
                assert!(te.get(k) == tn.get(k), "{}: the home tree differs at {k}:\n engine: {:?}\n node:   {:?}", c.name, te.get(k), tn.get(k));
            }
        } else {
            deferred += 1;
            assert_eq!(e.code, n.code, "{}: exit code of the fallback", c.name);
            let snap = |h: &Path| {
                let mut t = tree(h);
                t.retain(|k, _| !k.starts_with("hc/calls.log"));
                (t, key_db(h).is_file().then(|| raw_dump(&key_db(h)).replace(h.to_string_lossy().as_ref(), "<HOME>")))
            };
            let pre = snap(&homes[2]);
            let d = engine_cli(&homes[2], &cwd, &c.argv, now, &env_for(path_with(&nonode)));
            assert_eq!(d.code, 75, "{}: a deferral the engine cannot hand to Node exits 75, got {} / {} / {}", c.name, d.code, d.stdout, d.stderr);
            assert!(d.stdout.is_empty(), "{}: nothing is printed on a deferral: {}", c.name, d.stdout);
            assert_eq!(last_log(&homes[2].join("state"))["result"], "defer", "{}", c.name);
            assert!(pre == snap(&homes[2]), "{}: a deferral wrote", c.name);
        }
    }
    eprintln!(
        "l8e tick --child parity: {} cases, {native} answered by the engine and identical to Node, {deferred} deferred with nothing written",
        cases.len()
    );
    if std::env::var("AH_L8E_FILTER").is_err() {
        assert!(native >= min_native && deferred >= min_deferred, "{native} native, {deferred} deferred");
    }
}

fn setup_world(tag: &str) -> Option<(Fx, W)> {
    if !node_sqlite_available() {
        eprintln!("SKIPPED: Node with node:sqlite is not available, so there is no Node to compare with");
        return None;
    }
    let fx = fixture(tag);
    let w = W { repo_key: fx.repo_key.clone(), child: fx.child.clone() };
    Some((fx, w))
}

fn tick(more: &[&str]) -> Vec<String> {
    let mut v: Vec<String> = vec!["inbox".into(), "tick".into(), "child-1".into()];
    v.extend(more.iter().map(|x| (*x).to_string()));
    v
}

fn child(more: &[&str]) -> Vec<String> {
    tick(&[more, &["--child"]].concat())
}

fn argv(v: Vec<String>) -> Vec<String> {
    v
}

fn case(name: &str, more: &[&str], native: bool, setup: impl Fn(&Path) + 'static) -> Lc {
    let mut c = lc(name, &[], native);
    c.argv = argv(child(more));
    c.setup(setup)
}

// ---- slice 1: the steady state (a registered child, nothing to import) --------------------------------------------------

#[test]
fn child_tick_steady_state_matches_node() {
    let Some((fx, w)) = setup_world("l8esteady") else { return };
    let wc = w.clone();
    let b = move |extra: Vec<(&'static str, Value)>, drop: Vec<&'static str>| {
        let wc = wc.clone();
        move |h: &Path| base(&wc, h, &extra, &drop)
    };
    let cases = vec![
        case("quiet-nothing-queued", &["--quiet"], true, b(vec![], vec![])),
        case("json-nothing-queued", &["--json"], true, b(vec![], vec![])),
        case("json-default-form", &[], true, b(vec![], vec![])),
        case("count-zero-printed", &["--quiet"], true, {
            let f = b(vec![], vec![]);
            move |h| {
                f(h);
                hc(h, "count", "0\n");
            }
        }),
        case("descriptor-without-project-keys-is-backfilled", &["--quiet"], true, b(vec![], vec!["repoKey", "ownerKey"])),
        case("descriptor-without-owner-key-only", &["--quiet"], true, b(vec![], vec!["ownerKey"])),
        case("descriptor-without-paths-gets-the-defaults", &["--quiet"], true, b(vec![], vec!["inboxPath", "cursorPath"])),
        case("descriptor-with-null-paths", &["--quiet"], true, b(vec![("inboxPath", Value::Null), ("cursorPath", json!(""))], vec![])),
        case("cursor-file-missing-is-created", &["--quiet"], true, {
            let f = b(vec![], vec![]);
            move |h| {
                f(h);
                fs::remove_file(ds(h).join("cursors/child-1.cursor")).unwrap();
            }
        }),
        case("inbox-file-missing-is-created", &["--quiet"], true, {
            let f = b(vec![], vec![]);
            move |h| {
                f(h);
                fs::remove_file(ds(h).join("inbox/child-1.ndjson")).unwrap();
            }
        }),
        case("hivecontrol-count-fails", &["--quiet"], true, {
            let f = b(vec![], vec![]);
            move |h| {
                f(h);
                hc(h, "count.rc", "1");
                hc(h, "count", "DevSwarm is not running");
            }
        }),
        case("hivecontrol-absent", &["--quiet"], true, b(vec![], vec![])).no_hc(),
        case("count-is-garbage-zero", &["--quiet"], true, {
            let f = b(vec![], vec![]);
            move |h| {
                f(h);
                hc(h, "count", "no idea");
            }
        }),
        case("pull-lock-held-by-a-live-process-skips-the-pull", &["--quiet"], true, {
            let f = b(vec![], vec![]);
            move |h| {
                f(h);
                put(h, "locks/pull-child-1.lock", &json!({"pid": std::process::id(), "ts": NOW, "token": "t", "host": "h"}).to_string());
                hc(h, "count", "2");
            }
        }),
        case("pull-lock-of-a-dead-process-but-fresh-is-respected", &["--quiet"], true, {
            let f = b(vec![], vec![]);
            move |h| {
                f(h);
                put(h, "locks/pull-child-1.lock", &json!({"pid": 999_999, "ts": NOW, "token": "t"}).to_string());
                hc(h, "count", "2");
            }
        }),
        case("pull-lock-of-a-dead-process-and-stale-is-taken-over", &["--quiet"], true, {
            let f = b(vec![], vec![]);
            move |h| {
                f(h);
                put(h, "locks/pull-child-1.lock", &json!({"pid": 999_999, "ts": 1, "token": "t"}).to_string());
            }
        }),
        case("wal-over-the-rotation-size-with-nothing-pending-is-archived", &["--quiet"], true, {
            let f = b(vec![], vec![]);
            move |h| {
                f(h);
                let closed = "{\"t\":\"batch\",\"e\":\"1-1-1-aaaa\",\"ts\":1,\"raw\":\"[]\"}\n{\"t\":\"done\",\"e\":\"1-1-1-aaaa\",\"ts\":2}\n";
                put(h, "wal/pull-child-1.ndjson", &closed.repeat(12_000));
            }
        }),
        case("wal-with-closed-batches-only", &["--quiet"], true, {
            let f = b(vec![], vec![]);
            move |h| {
                f(h);
                put(
                    h,
                    "wal/pull-child-1.ndjson",
                    "{\"t\":\"batch\",\"e\":\"1-1-1-aaaa\",\"ts\":1,\"raw\":\"[]\"}\n{\"t\":\"done\",\"e\":\"1-1-1-aaaa\",\"ts\":2}\n",
                );
            }
        }),
        // ---- the deferrals: everything Node does that the engine does not, decided before the first write ----
        case("defer-session-flag", &["--quiet", "--session", "s1"], false, b(vec![], vec![])),
        case("defer-unclaimed-session", &["--quiet"], false, b(vec![("sessionId", json!("unclaimed:child-1"))], vec![])),
        case("defer-owner-key-is-the-legacy-hash-bucket-rehome", &["--quiet"], false, {
            let key = hash_of("child-1");
            let f = b(vec![], vec![]);
            let rk = w.repo_key.clone();
            move |h| {
                let _ = &rk;
                f(h);
                let p = ds(h).join("workspaces/child-1.json");
                let mut d: Value = serde_json::from_str(&fs::read_to_string(&p).unwrap()).unwrap();
                d["ownerKey"] = json!(key);
                d.as_object_mut().unwrap().remove("repoKey");
                fs::write(p, d.to_string()).unwrap();
            }
        }),
        case("defer-self-heal-would-spawn-the-installer", &["--quiet"], false, b(vec![], vec![])).env("DEVSWARM_REPO_ID", "repo-1"),
        case("defer-a-foreign-reader-wal-has-an-open-batch", &["--quiet"], false, {
            let f = b(vec![], vec![]);
            move |h| {
                f(h);
                put(h, "wal/pull-other.ndjson", "{\"t\":\"batch\",\"e\":\"1-1-1-bbbb\",\"ts\":1,\"raw\":\"[]\"}\n");
            }
        }),
        case("defer-a-spilled-batch-waits-in-wal-spill", &["--quiet"], false, {
            let f = b(vec![], vec![]);
            move |h| {
                f(h);
                put(h, "wal-spill/pull-child-1/x.json", "{\"e\":\"1-1-1-cccc\",\"ts\":1,\"raw\":\"[]\"}");
            }
        }),
        case("defer-a-pending-batch-with-a-date-form-the-engine-does-not-reproduce", &["--quiet"], false, {
            let f = b(vec![], vec![]);
            move |h| {
                f(h);
                let raw = serde_json::to_string(&json!([{"message": "m", "createdAt": "2026-10-09 10:00"}])).unwrap();
                let rec = json!({"t": "batch", "e": "1-1-1-dddd", "ts": 1, "raw": raw}).to_string() + "\n";
                put(h, "wal/pull-child-1.ndjson", &rec);
            }
        }),
        case("defer-registry-holds-a-second-row-of-the-same-worktree", &["--quiet"], false, {
            let f = b(vec![], vec![]);
            let (rk, wt) = (w.repo_key.clone(), w.child.clone());
            move |h| {
                f(h);
                let spec = json!({"registry": [{"id": "dup-1", "worktreePath": wt.to_string_lossy(), "sessionId": "dup-1"}]});
                run_seed("ack_seed.js", h, &rk, &spec);
            }
        }),
        case("defer-no-descriptor", &["--quiet"], false, |_| {}),
    ];
    run_cases(&fx, &w, &cases, 18, 8);
}

fn hash_of(id: &str) -> String {
    let d = ring::digest::digest(&ring::digest::SHA256, id.as_bytes());
    d.as_ref().iter().map(|b| format!("{b:02x}")).collect::<String>()[..8].to_string()
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

// ---- slice 3: the native queue is drained (WAL, inbox, store) ------------------------------------------------------------

#[test]
fn child_tick_drains_the_queue_like_node() {
    let Some((fx, w)) = setup_world("l8edrain") else { return };
    let wc = w.clone();
    let queued = move |count: &'static str, read: String, extra: Vec<(&'static str, Value)>| {
        let wc = wc.clone();
        move |h: &Path| {
            base(&wc, h, &extra, &[]);
            hc(h, "count", count);
            hc(h, "read", &read);
        }
    };
    let two = msgs(&[("first task", "2026-10-09T10:00:00.000Z"), ("second task", "2026-10-09T10:01:00.000Z")]);
    let cases = vec![
        case("one-message", &["--quiet"], true, queued("1", msgs(&[("hello child", "2026-10-09T10:00:00.000Z")]), vec![])),
        case("two-messages-json", &["--json"], true, queued("2", two.clone(), vec![])),
        case("two-messages-quiet", &["--quiet"], true, queued("2", two.clone(), vec![])),
        case("count-as-json-object", &["--quiet"], true, queued("{\"count\":2}", two.clone(), vec![])),
        case("count-as-text", &["--quiet"], true, queued("you have 2 unread", two.clone(), vec![])),
        case("messages-wrapper-object", &["--quiet"], true, queued("2", format!("{{\"messages\":{two}}}"), vec![])),
        case("data-wrapper-object", &["--quiet"], true, queued("2", format!("{{\"data\":{two}}}"), vec![])),
        case(
            "single-message-object",
            &["--quiet"],
            true,
            queued("1", "{\"message\":\"solo\",\"fromBranch\":\"main\",\"createdAt\":\"2026-10-09T10:00:00Z\"}".into(), vec![]),
        ),
        case(
            "message-without-created-at-hashes-the-whole-object",
            &["--quiet"],
            true,
            queued("1", "[{\"message\":\"no date\",\"fromBranch\":\"main\"}]".into(), vec![]),
        ),
        case(
            "message-with-unusual-fields",
            &["--quiet"],
            true,
            queued(
                "1",
                "[{\"message\":{\"a\":[1,2]},\"fromBranch\":7,\"status\":null,\"toBranch\":\"x\",\"createdAt\":\"2026-10-09T10:00:00+04:00\"}]".into(),
                vec![],
            ),
        ),
        case(
            "unicode-and-newlines-in-the-body",
            &["--quiet"],
            true,
            queued("1", "[{\"message\":\"caf\\u00e9\\n\\u2603 line two\",\"createdAt\":\"2026-10-09T10:00:00Z\"}]".into(), vec![]),
        ),
        case(
            "duplicate-inside-one-batch",
            &["--quiet"],
            true,
            queued("2", msgs(&[("same", "2026-10-09T10:00:00Z"), ("same", "2026-10-09T10:00:00Z")]), vec![]),
        ),
        case("shortfall-count-three-read-one", &["--quiet"], true, queued("3", msgs(&[("only one", "2026-10-09T10:00:00Z")]), vec![])),
        case("unparseable-read-is-a-shortfall-and-kept-in-the-wal", &["--quiet"], true, queued("1", "this is not json".into(), vec![])),
        case("read-prints-an-empty-array", &["--quiet"], true, queued("1", "[]".into(), vec![])),
        case("read-exits-non-zero-but-printed-a-batch", &["--quiet"], true, {
            let f = queued("1", msgs(&[("popped", "2026-10-09T10:00:00Z")]), vec![]);
            move |h| {
                f(h);
                hc(h, "read.rc", "3");
            }
        }),
        case("the-inbox-already-holds-the-hash-so-it-is-a-duplicate", &["--quiet"], true, {
            let f = queued("1", msgs(&[("seen before", "2026-10-09T10:00:00Z")]), vec![]);
            let m = serde_json::from_str::<Value>(&msgs(&[("seen before", "2026-10-09T10:00:00Z")])).unwrap();
            move |h| {
                f(h);
                let hash = message_hash("child-1", &m[0]);
                put(h, "inbox/child-1.ndjson", &(json!({"_h": hash, "fromBranch": "main", "message": "seen before", "createdAt": "2026-10-09T10:00:00Z", "status": "unread", "sender": null}).to_string() + "\n"));
            }
        }),
        case("the-inbox-has-a-torn-tail", &["--quiet"], true, {
            let f = queued("1", msgs(&[("after a torn tail", "2026-10-09T10:00:00Z")]), vec![]);
            move |h| {
                f(h);
                put(h, "inbox/child-1.ndjson", "{\"_h\":\"native:old\",\"message\":\"torn");
            }
        }),
        case("the-wal-has-a-torn-tail", &["--quiet"], true, {
            let f = queued("1", msgs(&[("wal torn", "2026-10-09T10:00:00Z")]), vec![]);
            move |h| {
                f(h);
                put(
                    h,
                    "wal/pull-child-1.ndjson",
                    "{\"t\":\"batch\",\"e\":\"1-1-1-aaaa\",\"ts\":1,\"raw\":\"[]\"}\n{\"t\":\"done\",\"e\":\"1-1-1-aaaa\",\"ts\":2}\n{\"t\":\"batch\",\"e\":\"9-9-",
                );
            }
        }),
        // ---- replay: the states a crash leaves behind ----
        case("replay-wal-batch-written-inbox-not", &["--quiet"], true, pending_wal(&w, "2026-10-09T10:00:00Z", false)),
        case("replay-wal-batch-written-inbox-appended-no-done", &["--quiet"], true, pending_wal(&w, "2026-10-09T10:00:00Z", true)),
        case("replay-an-unparseable-batch-is-quarantined", &["--quiet"], true, {
            let wc = w.clone();
            move |h| {
                base(&wc, h, &[], &[]);
                let rec = json!({"t": "batch", "e": "1-1-1-eeee", "ts": 1, "raw": "garbage"}).to_string() + "\n";
                put(h, "wal/pull-child-1.ndjson", &rec);
            }
        }),
    ];
    run_cases(&fx, &w, &cases, 20, 0);
}

/// `messageHash(workspaceId, msg)` through the engine's own port (the test only seeds a duplicate with it).
fn message_hash(id: &str, m: &Value) -> String {
    let keyed = [
        id.to_string(),
        m["fromBranch"].as_str().unwrap_or("").to_string(),
        m["toBranch"].as_str().unwrap_or("").to_string(),
        m["message"].as_str().unwrap_or("").to_string(),
        m["status"].as_str().unwrap_or("").to_string(),
        m["createdAt"].as_str().unwrap_or("").to_string(),
    ]
    .join("\u{0}");
    let d = ring::digest::digest(&ring::digest::SHA256, keyed.as_bytes());
    format!("native:{}", d.as_ref().iter().map(|b| format!("{b:02x}")).collect::<String>())
}

/// A WAL that holds one batch without a closing record (a crash after the destructive read), with the inbox either still
/// empty (crash before the inbox append) or already holding the rows (crash before the closing record).
fn pending_wal(w: &W, created: &'static str, inbox_done: bool) -> impl Fn(&Path) + 'static {
    let wc = w.clone();
    move |h: &Path| {
        base(&wc, h, &[], &[]);
        let raw = msgs(&[("pending one", created), ("pending two", created)]);
        let rec = json!({"t": "batch", "e": "1-1-1-ffff", "ts": 1, "raw": raw, "worktree": wc.child.to_string_lossy()}).to_string() + "\n";
        put(h, "wal/pull-child-1.ndjson", &rec);
        if inbox_done {
            let m: Vec<Value> = serde_json::from_str(&raw).unwrap();
            let lines: String = m
                .iter()
                .map(|x| json!({"_h": message_hash("child-1", x), "fromBranch": x["fromBranch"], "message": x["message"], "createdAt": x["createdAt"], "status": x["status"], "sender": null}).to_string() + "\n")
                .collect();
            put(h, "inbox/child-1.ndjson", &lines);
        }
        let _ = read_inbox;
        let _ = wal_file;
    }
}

// ---- slice 2: the auto-ensure REGISTERS a workspace that has no descriptor ----------------------------------------------------

/// The floor rows and the watcher lock of a workspace that has no descriptor yet (the descriptor is what the pull creates).
fn unregistered(w: &W, h: &Path) {
    let floor = |ns: &str, v: i64| json!({"partition": "child-1", "ns": ns, "reader": "#floor", "value": v, "updatedAt": NOW - 1000});
    run_seed("ack_seed.js", h, &w.repo_key, &json!({"rows": [floor("store", 2), floor("nd", 0)]}));
    wake_lock(h);
}

/// A daemon that reads as healthy (a fresh heartbeat and a live lock of the same pid), so the self-heal neither warns nor spawns.
fn healthy_daemon(w: &W, h: &Path) {
    let pid = std::process::id();
    put(h, &format!("heartbeats/ingest-{}.json", w.repo_key), &json!({"ts": NOW, "pid": pid}).to_string());
    put(h, &format!("locks/ingest-project-{}.lock", w.repo_key), &json!({"pid": pid, "ts": NOW}).to_string());
}

/// A Claude harness session record for this test process, so the callers (Node and the engine alike) have a reader key.
fn harness_session(h: &Path) {
    let pid = std::process::id();
    let p = h.join(".claude/sessions").join(format!("{pid}.json"));
    fs::create_dir_all(p.parent().unwrap()).unwrap();
    fs::write(p, json!({"pid": pid, "startedAt": 1_790_000_000_000_i64}).to_string()).unwrap();
}

#[test]
fn child_tick_registers_a_workspace_without_a_descriptor_like_node() {
    let Some((fx, w)) = setup_world("l8ereg") else { return };
    let un = {
        let w = w.clone();
        move |h: &Path| unregistered(&w, h)
    };
    let cases = vec![
        case("register-under-the-builder-id", &["--quiet"], true, un.clone()).env("DEVSWARM_BUILDER_ID", "child-1"),
        case("register-under-the-builder-id-json", &["--json"], true, un.clone()).env("DEVSWARM_BUILDER_ID", "child-1"),
        case("register-with-a-repo-id-and-a-healthy-daemon", &["--quiet"], true, {
            let (w, un) = (w.clone(), un.clone());
            move |h| {
                un(h);
                healthy_daemon(&w, h);
            }
        })
        .env("DEVSWARM_BUILDER_ID", "child-1")
        .env("DEVSWARM_REPO_ID", "repo-7"),
        case("register-declares-the-caller-as-a-reader", &["--quiet"], true, {
            let un = un.clone();
            move |h| {
                un(h);
                harness_session(h);
            }
        })
        .env("DEVSWARM_BUILDER_ID", "child-1"),
        case("register-while-a-declared-row-is-retired-is-not-needed-without-a-session", &["--quiet"], true, un.clone()).env("DEVSWARM_BUILDER_ID", "child-1"),
        case("register-with-a-native-message-queued", &["--quiet"], true, {
            let un = un.clone();
            move |h| {
                un(h);
                hc(h, "count", "1");
                hc(h, "read", &msgs(&[("welcome", "2026-10-09T10:00:00Z")]));
            }
        })
        .env("DEVSWARM_BUILDER_ID", "child-1"),
        case("defer-register-unclaimed-without-a-builder-id", &["--quiet"], false, un.clone()),
        case("defer-register-an-archived-twin-exists", &["--quiet"], false, {
            let un = un.clone();
            move |h| {
                un(h);
                put(h, "archived/child-1.json", "{\"id\":\"child-1\"}");
            }
        })
        .env("DEVSWARM_BUILDER_ID", "child-1"),
        case("defer-register-from-the-primary-checkout-a-row-of-that-worktree-exists", &["--quiet"], false, un.clone())
            .env("DEVSWARM_BUILDER_ID", "child-1")
            .cwd("main"),
        case("defer-register-declares-but-a-legacy-instance-cursor-maps", &["--quiet"], false, {
            let un = un.clone();
            move |h| {
                un(h);
                harness_session(h);
                put(h, "cursors/child-1#inst-abcdef.json", "3");
            }
        })
        .env("DEVSWARM_BUILDER_ID", "child-1"),
    ];
    run_cases(&fx, &w, &cases, 5, 4);
}

// ---- crash safety: a kill between the destructive read and the end of the import ----------------------------------------------

#[derive(Clone, Copy, PartialEq, Debug)]
enum Tool {
    Node,
    Engine,
}

fn spawn_tick(tool: Tool, home: &Path, cwd: &Path, now: i64, env: &[(String, String)]) -> std::process::Child {
    let e: Vec<(&str, &str)> = env.iter().map(|(k, v)| (k.as_str(), v.as_str())).collect();
    let argv = child(&["--quiet"]);
    let mut c = match tool {
        Tool::Node => {
            let mut c = Command::new("node");
            c.arg("-e").arg(SNIPPET).arg(plugin_root().join("scripts").join("devswarm.js")).arg(now.to_string()).args(&argv);
            c
        }
        Tool::Engine => {
            let mut c = Command::new(BIN);
            c.arg("mesh").args(&argv);
            c
        }
    };
    c.current_dir(cwd).env_clear().envs(base_env(home, &home.join("state"), &e));
    if tool == Tool::Engine {
        c.env("AH_ENGINE_MESH_NOW_MS", now.to_string());
    }
    c.stdin(std::process::Stdio::null()).stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null());
    c.spawn().unwrap()
}

fn run_tick(tool: Tool, home: &Path, cwd: &Path, now: i64, env: &[(String, String)]) -> Out {
    match tool {
        Tool::Node => node_cli(home, cwd, &child(&["--quiet"]), now, env),
        Tool::Engine => engine_cli(home, cwd, &child(&["--quiet"]), now, env),
    }
}

fn wait_until(what: &str, f: impl Fn() -> bool) {
    let end = std::time::Instant::now() + std::time::Duration::from_secs(30);
    while !f() {
        assert!(std::time::Instant::now() < end, "timed out waiting for {what}");
        std::thread::sleep(std::time::Duration::from_millis(5));
    }
}

/// The kill points. Each names the state the process is in when it is killed (the wait condition) and the hook the stub runs
/// right after the destructive read.
struct Kill {
    name: &'static str,
    hook: &'static str,
    at: fn(&Path) -> bool,
    /// What the interrupted state looks like to the next run, and whether the batch survives the kill.
    batch_survives: bool,
}

fn wal_text(h: &Path) -> String {
    fs::read_to_string(wal_file(h)).unwrap_or_default()
}

const KILLS: &[Kill] = &[
    Kill {
        // the stub is still running: the batch exists only in the pipe between hivecontrol and the pull (the documented residual window)
        name: "between-the-destructive-read-and-the-wal-write",
        hook: "sleep 6",
        at: |h| h.join("hc/read.consumed").exists(),
        batch_survives: false,
    },
    Kill {
        // the WAL holds the batch (fsynced); the inbox is a named pipe, so the append never happens
        name: "after-the-wal-write-before-the-inbox-append",
        hook: "rm -f \"$HOME/.anti-hall/devswarm/inbox/child-1.ndjson\"; mkfifo \"$HOME/.anti-hall/devswarm/inbox/child-1.ndjson\"",
        at: |h| wal_text(h).contains("\"t\":\"batch\""),
        batch_survives: true,
    },
    Kill {
        // the inbox holds the rows (fsynced); the store is write-locked, so the feed and the closing record never happen
        name: "after-the-inbox-append-before-the-store-feed-and-the-closing-record",
        hook: "db=$(ls \"$HOME\"/.anti-hall/devswarm/store/*/devswarm.db | head -1); ( ( echo 'BEGIN IMMEDIATE;'; sleep 5 ) | sqlite3 \"$db\" ) </dev/null >/dev/null 2>&1 &\nsleep 0.6",
        at: |h| read_inbox(h).matches('\n').count() >= 2 && wal_text(h).contains("\"t\":\"batch\"") && !wal_text(h).contains("\"t\":\"done\""),
        batch_survives: true,
    },
];

/// Everything that must be the same however the interrupted run and the next run are split between Node and the engine.
fn settled(h: &Path, key: &str) -> (BTreeMap<String, String>, String) {
    // the home was copied from the one the killed process ran in: both names are paths inside the descriptor and the summary
    let name = regex::Regex::new(r"k[0-9]-(Node|Engine)(-then-(Node|Engine))?").unwrap();
    let mut t: BTreeMap<String, String> = tree(h).into_iter().map(|(k, v)| (k, name.replace_all(&v, "K").into_owned())).collect();
    t.retain(|k, _| !k.ends_with("lock.pid"));
    let db = ds(h).join("store").join(key).join("devswarm.db");
    let dump = mask_dump(&raw_dump(&db)).replace(h.to_string_lossy().as_ref(), "<HOME>");
    (t, name.replace_all(&dump, "K").into_owned())
}

#[test]
fn a_kill_at_every_step_loses_and_duplicates_nothing_whoever_runs_next() {
    let Some((fx, w)) = setup_world("l8ekill") else { return };
    let tools = tools_path(&fx.root, true);
    let stub = stub_dir(&fx.root);
    let env: Vec<(String, String)> = vec![("PATH".into(), format!("{stub}:{tools}"))];
    let now = NOW + 7;
    let raw = msgs(&[("first task", "2026-10-09T10:00:00.000Z"), ("second task", "2026-10-09T10:01:00.000Z")]);
    let sqlite_cli = Command::new("sqlite3").arg("-version").output().is_ok_and(|o| o.status.success());
    for (ki, k) in KILLS.iter().enumerate() {
        if !sqlite_cli && ki == 2 {
            eprintln!("SKIPPED {}: no sqlite3 command", k.name);
            continue;
        }
        let mut finals: Vec<(String, (BTreeMap<String, String>, String))> = Vec::new();
        for (killer, next) in [(Tool::Node, Tool::Node), (Tool::Node, Tool::Engine), (Tool::Engine, Tool::Node), (Tool::Engine, Tool::Engine)] {
            let home = fx.root.join(format!("k{ki}-{killer:?}-then-{next:?}"));
            copy_tree(&fx.seed_home, &home);
            fs::create_dir_all(home.join(".anti-hall")).unwrap();
            fs::write(home.join(".anti-hall/settings.json"), "{\"mesh\":{\"engine_writes\":\"on\"}}\n").unwrap();
            base(&w, &home, &[], &[]);
            hc(&home, "count", "2");
            hc(&home, "read", &raw);
            hc(&home, "read.hook", k.hook);
            let mut c = spawn_tick(killer, &home, &fx.child, now, &env);
            wait_until(k.name, || (k.at)(&home));
            std::thread::sleep(std::time::Duration::from_millis(150));
            c.kill().unwrap();
            c.wait().unwrap();
            // the dead process left its pull lock behind; it is old enough to be taken over by the next run
            let lock = ds(&home).join("locks/pull-child-1.lock");
            if lock.exists() {
                let mut rec: Value = serde_json::from_str(&fs::read_to_string(&lock).unwrap()).unwrap();
                rec["ts"] = json!(1);
                fs::write(&lock, rec.to_string()).unwrap();
            }
            // what a real crash leaves of the named pipe is the file it replaced
            let inbox = ds(&home).join("inbox/child-1.ndjson");
            if fs::metadata(&inbox).is_ok_and(|m| !m.is_file()) {
                fs::remove_file(&inbox).unwrap();
                fs::write(&inbox, "").unwrap();
            }
            // the write lock a hook took expires on its own
            std::thread::sleep(std::time::Duration::from_millis(5600));
            hc(&home, "read.hook", "true");
            {
                let copy = home.clone();
                let r = run_tick(next, &copy, &fx.child, now, &env);
                assert_eq!(r.code, 0, "{}: {killer:?} killed, {next:?} next: {} / {}", k.name, r.stdout, r.stderr);
                if next == Tool::Engine {
                    let log = last_log(&copy.join("state"));
                    assert_eq!(log["result"], "native", "{}: {killer:?} killed, the engine must answer the next run itself: {log}", k.name);
                }
                let inbox_lines = read_inbox(&copy).lines().filter(|l| !l.trim().is_empty()).count();
                let expected = if k.batch_survives { 2 } else { 0 };
                assert_eq!(
                    inbox_lines,
                    expected,
                    "{}: {killer:?} killed, {next:?} next: the inbox holds {inbox_lines} lines, not {expected}; wal {:?} locks {:?} stdout {:?} stderr {:?}",
                    k.name,
                    wal_text(&copy),
                    fs::read_dir(ds(&copy).join("locks"))
                        .unwrap()
                        .flatten()
                        .map(|e| (e.file_name(), fs::read_to_string(e.path()).unwrap_or_default()))
                        .collect::<Vec<_>>(),
                    r.stdout,
                    r.stderr
                );
                let wal = wal_text(&copy);
                if k.batch_survives {
                    assert_eq!(wal.matches("\"t\":\"batch\"").count(), 1, "{}: one batch in the log", k.name);
                    assert_eq!(wal.matches("\"t\":\"done\"").count(), 1, "{}: closed exactly once", k.name);
                }
                finals.push((format!("{killer:?}-killed-{next:?}-next"), settled(&copy, &w.repo_key)));
            }
        }
        let (first_name, first) = &finals[0];
        for (name, f) in &finals[1..] {
            for key in f.0.keys().chain(first.0.keys()) {
                assert!(
                    f.0.get(key) == first.0.get(key),
                    "{}: {name} differs from {first_name} at {key}:\n {:?}\n {:?}",
                    k.name,
                    f.0.get(key),
                    first.0.get(key)
                );
            }
            assert!(f.1 == first.1, "{}: {name} store differs from {first_name}: {}", k.name, first_diff(&first.1, &f.1));
        }
        eprintln!(
            "kill point {}: node/engine x node/engine all settle to the same state ({} lines in the inbox)",
            k.name,
            if k.batch_survives { 2 } else { 0 }
        );
    }
}

// ---- the one deliberate difference: a date form the engine does not reproduce in a FRESH batch -------------------------------

/// The batch is already read (destructive), so the engine cannot hand it to Node. It appends the rows to the inbox (no date is
/// needed for that), leaves the store feed to Node and leaves the batch PENDING in the WAL; the next tick defers to Node, which
/// replays it: nothing is lost, nothing is duplicated, and the store ends where Node's own pull would have left it.
#[test]
fn a_date_form_the_engine_does_not_reproduce_leaves_the_batch_pending_for_node() {
    let Some((fx, w)) = setup_world("l8edate") else { return };
    let tools = tools_path(&fx.root, true);
    let stub = stub_dir(&fx.root);
    let env: Vec<(String, String)> = vec![("PATH".into(), format!("{stub}:{tools}"))];
    let reference = fx.root.join("ref");
    let ours = fx.root.join("ours");
    for h in [&reference, &ours] {
        copy_tree(&fx.seed_home, h);
        fs::create_dir_all(h.join(".anti-hall")).unwrap();
        fs::write(h.join(".anti-hall/settings.json"), "{\"mesh\":{\"engine_writes\":\"on\"}}\n").unwrap();
        base(&w, h, &[], &[]);
        hc(h, "count", "1");
        hc(h, "read", &msgs(&[("odd date", "2026-10-09 10:00")]));
    }
    let n = node_cli(&reference, &fx.child, &child(&["--quiet"]), NOW, &env);
    let e = engine_cli(&ours, &fx.child, &child(&["--quiet"]), NOW, &env);
    assert_eq!(e.stdout, n.stdout, "the tick prints the same count");
    assert_eq!(last_log(&ours.join("state"))["result"], "native");
    assert_eq!(read_inbox(&ours), read_inbox(&reference), "the inbox is the same");
    assert!(wal_text(&ours).contains("\"t\":\"batch\"") && !wal_text(&ours).contains("\"t\":\"done\""), "the batch stays pending");
    // the next tick: the engine defers (exit 75 without Node, else Node runs); Node replays and closes
    let again = engine_cli(&ours, &fx.child, &child(&["--quiet"]), NOW, &env);
    assert_eq!(last_log(&ours.join("state"))["result"], "defer", "{}", again.stderr);
    assert_eq!(read_inbox(&ours).lines().count(), 1, "nothing duplicated");
    assert!(wal_text(&ours).contains("\"t\":\"done\""), "Node closed the batch");
    let key_db = |h: &Path| ds(h).join("store").join(&fx.repo_key).join("devswarm.db");
    // the second tick (Node, real clock) ensured the registration once more, so only the message rows are compared
    let norm = |h: &Path| mask_dump(&raw_dump(&key_db(h))).lines().filter(|l| l.contains("hash=t\"native:")).collect::<Vec<_>>().join("\n");
    assert!(
        !norm(&ours).is_empty() && norm(&ours) == norm(&reference),
        "the store ends as Node's own pull leaves it: {}",
        first_diff(&norm(&reference), &norm(&ours))
    );
}
