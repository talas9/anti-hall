//! The native liveness sweep against Node's `computeLiveness` + `writeVerdict` on a golden corpus: scratch homes of hundreds of
//! workspaces, every one a random combination of the states a verdict depends on (heartbeat, transcript, last commit, previous
//! verdict, NDJSON inbox and cursor, store mail with and without reader-cursor floors, live and dead sessions, odd descriptors),
//! built by Node's own store code. The same home is run through Node's reference and through the engine, and:
//!
//! * every verdict the engine writes is byte-identical to Node's (and never `stale`: a stale workspace is Node's);
//! * every workspace the engine hands to Node really is one Node needs to decide (`stale`) or a documented deferral;
//! * the recovery log holds the same lines for the workspaces the engine decided, and the engine wrote nothing else: the home
//!   tree is byte-identical to before except `liveness/` and `recovery.log`;
//! * a dry run writes nothing at all.
use ah_engine::db::TempDir;
use ah_engine::dsact::runner::System;
use ah_engine::dssup::liveness::{self, Thresholds};
use ah_engine::meshw::common::Inv;
use serde_json::Value;
use std::collections::{BTreeMap, HashMap};
use std::path::{Path, PathBuf};
use std::process::Command;

const IDLE_MS: f64 = 900_000.0;
const WINDOW_MS: f64 = 180_000.0;

fn have_node_sqlite() -> bool {
    Command::new("node").args(["-e", "require('node:sqlite')"]).output().is_ok_and(|o| o.status.success())
}

fn support(name: &str) -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/it/dssup_support").join(name)
}

fn now_ms() -> i64 {
    ah_engine::health::now_ms() as i64
}

fn thresholds() -> Thresholds {
    Thresholds { idle_ms: IDLE_MS, nudge_window_ms: WINDOW_MS, fresh_ms: 900_000.0, never_launched_ms: 21_600_000.0 }
}

struct Corpus {
    _t: TempDir,
    home: PathBuf,
    manifest: Value,
    now: i64,
}

fn build(tag: &str, seed: u32, count: u32, big: bool) -> Corpus {
    ah_engine::defaults::init().unwrap();
    let t = TempDir::new(tag);
    let dir = std::fs::canonicalize(&t.0).unwrap();
    let (home, root) = (dir.join("home"), dir.join("root"));
    let now = now_ms();
    let mut c = Command::new("node");
    c.arg(support("lv_corpus.js")).arg(&home).arg(&root).arg(seed.to_string()).arg(count.to_string()).arg(now.to_string()).arg(std::process::id().to_string());
    if big {
        c.arg("big");
    }
    let o = c.output().unwrap();
    assert!(o.status.success(), "corpus: {}", String::from_utf8_lossy(&o.stderr));
    let manifest: Value = serde_json::from_slice(&o.stdout).unwrap();
    Corpus { _t: t, home, manifest, now }
}

fn inv(c: &Corpus) -> Inv {
    let mut env: HashMap<String, String> = HashMap::new();
    env.insert("HOME".into(), c.home.to_string_lossy().into_owned());
    Inv { home: c.home.clone(), env, cwd: c.home.to_string_lossy().into_owned(), now: c.now, stdin: None, write_home: c.home.clone(), store_override: None }
}

fn ds(c: &Corpus) -> PathBuf {
    c.home.join(".anti-hall/devswarm")
}

/// Every regular file under `dir` (relative path -> bytes), except the ones named by `skip` (prefixes) and SQLite's side files.
fn tree(dir: &Path, skip: &[&str]) -> BTreeMap<String, Vec<u8>> {
    fn walk(base: &Path, d: &Path, skip: &[&str], out: &mut BTreeMap<String, Vec<u8>>) {
        for e in std::fs::read_dir(d).into_iter().flatten().flatten() {
            let p = e.path();
            let rel = p.strip_prefix(base).unwrap().to_string_lossy().into_owned();
            if skip.iter().any(|s| rel.starts_with(s)) || rel.ends_with("-shm") || rel.ends_with("-wal") {
                continue;
            }
            let ft = e.file_type().unwrap();
            if ft.is_dir() {
                walk(base, &p, skip, out);
            } else if ft.is_file() {
                out.insert(rel, std::fs::read(&p).unwrap());
            }
        }
    }
    let mut out = BTreeMap::new();
    walk(dir, dir, skip, &mut out);
    out
}

fn restore(c: &Corpus, snap: &BTreeMap<String, Vec<u8>>, log: Option<&Vec<u8>>) {
    let live = ds(c).join("liveness");
    std::fs::remove_dir_all(&live).ok();
    std::fs::create_dir_all(&live).unwrap();
    for (k, v) in snap {
        std::fs::write(live.join(k), v).unwrap();
    }
    let lp = ds(c).join("recovery.log");
    match log {
        Some(b) => std::fs::write(lp, b).unwrap(),
        None => std::fs::remove_file(lp).unwrap_or(()),
    }
}

struct Ref {
    texts: BTreeMap<String, String>,
    log: String,
}

fn node_reference(c: &Corpus) -> Ref {
    let o = Command::new("node")
        .arg(support("lv_reference.js"))
        .arg(&c.home)
        .arg(c.now.to_string())
        .arg(IDLE_MS.to_string())
        .arg(WINDOW_MS.to_string())
        .output()
        .unwrap();
    assert!(o.status.success(), "reference: {}", String::from_utf8_lossy(&o.stderr));
    let v: BTreeMap<String, String> = serde_json::from_slice(&o.stdout).unwrap();
    Ref { texts: v, log: std::fs::read_to_string(ds(c).join("recovery.log")).unwrap_or_default() }
}

fn status_of(text: &str) -> String {
    serde_json::from_str::<Value>(text).ok().and_then(|v| v["status"].as_str().map(str::to_string)).unwrap_or_else(|| format!("unparsable: {text}"))
}

/// One corpus: run Node, restore the prior state, run the engine, compare.
fn check(c: &Corpus) -> BTreeMap<String, usize> {
    let live = ds(c).join("liveness");
    let before_snap = tree(&live, &[]);
    let before_log = std::fs::read(ds(c).join("recovery.log")).ok();
    let outside_before = tree(&c.home, &[".anti-hall/devswarm/liveness", ".anti-hall/devswarm/recovery.log"]);

    let node = node_reference(c);
    restore(c, &before_snap, before_log.as_ref());
    let outside_after_node = tree(&c.home, &[".anti-hall/devswarm/liveness", ".anti-hall/devswarm/recovery.log"]);
    assert_eq!(outside_before, outside_after_node, "Node's own reference must not write outside liveness/ and recovery.log");

    let runner = System::configured();
    let out = liveness::sweep(&inv(c), thresholds(), &runner, false);
    let outside_after = tree(&c.home, &[".anti-hall/devswarm/liveness", ".anti-hall/devswarm/recovery.log"]);
    assert_eq!(outside_before, outside_after, "the engine wrote something outside liveness/ and recovery.log");

    let mut stats: BTreeMap<String, usize> = BTreeMap::new();
    let ids_engine: std::collections::BTreeSet<&String> = out.native.iter().chain(out.full.iter().map(|(i, _)| i)).collect();
    let ids_node: std::collections::BTreeSet<&String> = node.texts.keys().collect();
    assert_eq!(ids_engine, ids_node, "the descriptors the two sides look at");
    for id in &out.native {
        let written = std::fs::read_to_string(live.join(format!("{id}.json"))).unwrap();
        assert_eq!(written, node.texts[id], "verdict bytes of {id}");
        assert_ne!(status_of(&written), "stale", "{id}: the engine never writes a stale verdict");
        *stats.entry(format!("native:{}", status_of(&written))).or_default() += 1;
    }
    for (id, why) in &out.full {
        let key = if why == "stale" {
            assert_eq!(status_of(&node.texts[id]), "stale", "{id}: deferred as stale but Node says {}", node.texts[id]);
            "deferred:stale".to_string()
        } else {
            format!("deferred:{why}")
        };
        *stats.entry(key).or_default() += 1;
        // a deferred workspace's verdict file is exactly what it was
        let now_text = std::fs::read(live.join(format!("{id}.json"))).ok();
        assert_eq!(now_text.as_ref(), before_snap.get(&format!("{id}.json")), "{id}: a deferred workspace was written");
    }
    // the recovery log: Node's lines for the workspaces the engine decided
    let native: std::collections::BTreeSet<&str> = out.native.iter().map(String::as_str).collect();
    let expect: Vec<&str> = node
        .log
        .lines()
        .skip(before_log.as_ref().map_or(0, |b| String::from_utf8_lossy(b).lines().count()))
        .filter(|l| serde_json::from_str::<Value>(l).ok().and_then(|v| v["id"].as_str().map(|i| native.contains(i))).unwrap_or(false))
        .collect();
    let got_all = std::fs::read_to_string(ds(c).join("recovery.log")).unwrap_or_default();
    let got: Vec<&str> = got_all.lines().skip(before_log.as_ref().map_or(0, |b| String::from_utf8_lossy(b).lines().count())).collect();
    assert_eq!(got, expect, "recovery log lines");
    // the tail: exactly the decided workspaces Node has extra work for
    let want_tail: Vec<String> = c.manifest["kinds"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|k| (k["jev"] == true || k["plan"] == true) && native.contains(k["id"].as_str().unwrap()))
        .map(|k| k["id"].as_str().unwrap().to_string())
        .collect();
    let mut got_tail = out.tail.clone();
    got_tail.sort();
    let mut want_tail = want_tail;
    want_tail.sort();
    assert_eq!(got_tail, want_tail, "workspaces with tail work");
    stats
}

#[test]
fn engine_verdicts_equal_nodes_on_random_corpora() {
    if !have_node_sqlite() {
        return;
    }
    let mut all: BTreeMap<String, usize> = BTreeMap::new();
    for seed in [1u32, 2, 3, 4, 5] {
        let c = build(&format!("lv-{seed}"), seed, 160, false);
        for (k, v) in check(&c) {
            *all.entry(k).or_default() += v;
        }
    }
    eprintln!("liveness corpus: {all:?}");
    let native: usize = all.iter().filter(|(k, _)| k.starts_with("native:")).map(|(_, v)| v).sum();
    assert!(native > 300, "the corpus must exercise the native path: {all:?}");
    for want in ["native:alive", "native:nudged", "native:escalated", "deferred:stale"] {
        assert!(all.get(want).copied().unwrap_or(0) > 0, "no {want} case in the corpus: {all:?}");
    }
}

#[test]
fn a_large_store_is_read_like_nodes() {
    if !have_node_sqlite() {
        return;
    }
    let c = build("lv-big", 11, 60, true);
    let stats = check(&c);
    eprintln!("liveness big corpus: {stats:?}");
}

#[test]
fn a_dry_run_writes_nothing() {
    if !have_node_sqlite() {
        return;
    }
    let c = build("lv-dry", 21, 80, false);
    let before = tree(&c.home, &[]);
    let runner = System::configured();
    let out = liveness::sweep(&inv(&c), thresholds(), &runner, true);
    assert!(!out.native.is_empty());
    assert_eq!(before, tree(&c.home, &[]), "a dry run changed the home");
}

fn duty_settings(c: &Corpus) -> ah_engine::checks::git::util::Settings {
    let mut env: HashMap<String, String> = HashMap::new();
    env.insert("HOME".into(), c.home.to_string_lossy().into_owned());
    env.insert("ANTIHALL_DEVSWARM_IDLE_SEC".into(), "900".into());
    env.insert("ANTIHALL_DEVSWARM_NUDGE_WINDOW_SEC".into(), "180".into());
    ah_engine::checks::git::util::Settings { home: c.home.to_string_lossy().into_owned(), env }
}

/// The whole duty: native verdicts, Node's own sweep for the rest, and the non-acting Node witness over the verdicts it wrote.
#[test]
fn the_duty_runs_native_with_nodes_tail_and_a_matching_witness() {
    if !have_node_sqlite() {
        return;
    }
    let c = build("lv-duty", 31, 90, false);
    let st = duty_settings(&c);
    let root = ah_engine::defaults::root().unwrap();
    let ctx = ah_engine::dssup::tick::Ctx { home: &c.home, root: &root, st: &st, now: c.now, engine_pokes: true };
    let before = tree(&ds(&c).join("liveness"), &[]);
    let rec = ah_engine::dssup::tick::run_duty("verdicts", &ctx, &System::configured());
    assert_eq!(rec["outcome"], "ran", "{rec}");
    let detail = &rec["detail"];
    assert!(detail["native"].as_u64().unwrap() > 20, "{rec}");
    assert!(detail["node"].is_object() && detail["node"].get("error").is_none(), "Node's tail sweep must run: {rec}");
    // Node's sweep (restricted to the handed-over workspaces) recomputed the stale ones and left the decided ones as written
    let after = tree(&ds(&c).join("liveness"), &[]);
    let kinds = c.manifest["kinds"].as_array().unwrap();
    let mut stale = 0;
    for (name, text) in &after {
        let id = name.trim_end_matches(".json");
        let status = status_of(&String::from_utf8_lossy(text));
        let k = kinds.iter().find(|k| k["id"] == id);
        if before.get(name) == Some(text) {
            continue; // not a workspace the sweep looks at (or one whose verdict did not change)
        }
        if status == "stale" {
            stale += 1;
            assert!(detail["full"].as_array().unwrap().iter().any(|f| f["id"] == id), "{id} is stale but the engine did not hand it over");
        }
        if let Some(k) = k
            && (k["jev"] == true || k["plan"] == true)
            && !before.contains_key(name)
        {
            assert!(!text.is_empty(), "{id}");
        }
    }
    assert!(stale > 0, "the corpus must hold a stale workspace");
    // the witness ran Node's own computation over the engine's verdicts and found them identical
    let w = std::fs::read_to_string(c.home.join(".anti-hall/logs/devswarm-sup-witness.ndjson")).unwrap_or_default();
    let line: Value = serde_json::from_str(w.lines().last().expect("a witness line")).unwrap();
    assert_eq!(line["duty"], "verdicts", "{line}");
    assert_eq!(line["match"], true, "witness mismatch: {line}");
}
