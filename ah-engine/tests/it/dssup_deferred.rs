//! The native deferred-stage tick against Node's `deferredSweepIfDue`: the same rotation cursor bytes, the same stage taken,
//! the same "nothing pending" answer, and for a stage that has work the same final files (the stage body is Node's function in
//! both). Cases cover every marker shape the peek reads and every cursor shape, ticking the whole rotation more than once.
use ah_engine::checks::git::util::Settings;
use ah_engine::db::TempDir;
use ah_engine::dsact::runner::System;
use ah_engine::dssup::tick::Ctx;
use serde_json::Value;
use std::collections::{BTreeMap, HashMap};
use std::path::{Path, PathBuf};
use std::process::Command;

fn have_node() -> bool {
    Command::new("node").arg("--version").output().is_ok_and(|o| o.status.success())
}

fn put(home: &Path, rel: &str, text: &str) {
    let p = home.join(rel);
    std::fs::create_dir_all(p.parent().unwrap()).unwrap();
    std::fs::write(p, text).unwrap();
}

/// Every file under the home, bytes with 13-digit clock values masked (the stages stamp the time).
fn tree(home: &Path) -> BTreeMap<String, String> {
    fn walk(base: &Path, d: &Path, out: &mut BTreeMap<String, String>, re: &regex::Regex) {
        for e in std::fs::read_dir(d).into_iter().flatten().flatten() {
            let p = e.path();
            if e.file_type().unwrap().is_dir() {
                walk(base, &p, out, re);
            } else if let Ok(t) = std::fs::read_to_string(&p) {
                out.insert(p.strip_prefix(base).unwrap().to_string_lossy().into_owned(), re.replace_all(&t, "T").into_owned());
            }
        }
    }
    let mut out = BTreeMap::new();
    walk(home, home, &mut out, &regex::Regex::new(r"[0-9]{13}").unwrap());
    out
}

fn node_tick(home: &Path) -> Value {
    let root = ah_engine::defaults::root().unwrap();
    let code = "process.env.HOME=process.argv[2];process.env.ANTIHALL_CALLER=\"supervisor\";const S=require(process.argv[1]+\"/companion/devswarm-supervisor.js\");console.log(JSON.stringify(S.deferredSweepIfDue({home:process.argv[2]})))";
    let o = Command::new("node").args(["-e", code, root.to_str().unwrap(), home.to_str().unwrap()]).output().unwrap();
    assert!(o.status.success(), "{}", String::from_utf8_lossy(&o.stderr));
    serde_json::from_str(String::from_utf8_lossy(&o.stdout).lines().last().unwrap()).unwrap()
}

fn engine_tick(home: &Path) -> Value {
    let root = ah_engine::defaults::root().unwrap();
    let mut env: HashMap<String, String> = HashMap::new();
    env.insert("HOME".into(), home.to_string_lossy().into_owned());
    let st = Settings { home: home.to_string_lossy().into_owned(), env };
    let ctx = Ctx { home, root: &root, st: &st, now: ah_engine::health::now_ms() as i64, engine_pokes: true };
    ah_engine::dssup::deferred::duty(&ctx, &System::configured())
}

fn mask(v: &Value) -> Value {
    serde_json::from_str(&regex::Regex::new(r"[0-9]{13}").unwrap().replace_all(&v.to_string(), "T")).unwrap()
}

struct Case {
    name: &'static str,
    files: Vec<(&'static str, String)>,
}

fn cases() -> Vec<Case> {
    let c = |name, files: Vec<(&'static str, &str)>| Case { name, files: files.into_iter().map(|(a, b)| (a, b.to_string())).collect() };
    let upd = ".anti-hall/update-sweep-state.json";
    let cur = ".anti-hall/devswarm/deferred-sweep-state.json";
    vec![
        c("nothing at all", vec![]),
        c("cursor mid-rotation", vec![(cur, "{\"nextStageIndex\":2}")]),
        c("cursor wraps", vec![(cur, "{\"nextStageIndex\":7}")]),
        c("cursor negative", vec![(cur, "{\"nextStageIndex\":-1}")]),
        c("cursor a string", vec![(cur, "{\"nextStageIndex\":\"2\"}")]),
        c("cursor torn", vec![(cur, "{\"nextStageIn")]),
        c("cursor fractional", vec![(cur, "{\"nextStageIndex\":1.5}")]),
        c("fold-all pending", vec![(upd, "{\"foldAllStores\":{\"pendingVersion\":\"9.9.9\",\"pendingHashes\":[\"abcd12\"]}}")]),
        c("fold-all pending without a version", vec![(upd, "{\"foldAllStores\":{\"pendingVersion\":\"\",\"pendingHashes\":[\"abcd12\"]}}")]),
        c("fold-all empty list", vec![(upd, "{\"foldAllStores\":{\"pendingVersion\":\"9.9.9\",\"pendingHashes\":[]}}")]),
        c(
            "heal-orphan pending",
            vec![
                (".anti-hall/update-sweep-state.json", "{\"healOrphanPartitions\":{\"pendingVersion\":\"9.9.9\",\"pendingHashes\":[\"abcd12\"]}}"),
                (cur, "{\"nextStageIndex\":1}"),
            ],
        ),
        c(
            "heal-registry pending",
            vec![(upd, "{\"healRegistry\":{\"pendingVersion\":\"9.9.9\",\"pendingHashes\":[\"abcd12\"]}}"), (cur, "{\"nextStageIndex\":3}")],
        ),
        c("update state not an object", vec![(upd, "[1,2]")]),
        c(
            "fold-archived buckets pending",
            vec![(".anti-hall/devswarm/fold-archived-resume.json", "{\"buckets\":{\"k\":[\"a\",\"b\"]}}"), (cur, "{\"nextStageIndex\":2}")],
        ),
        c(
            "fold-archived buckets only non-strings",
            vec![(".anti-hall/devswarm/fold-archived-resume.json", "{\"buckets\":{\"k\":[1,null]}}"), (cur, "{\"nextStageIndex\":2}")],
        ),
        c("fold-archived family pending", vec![(".anti-hall/devswarm/fold-archived-family-resume.json", "{\"ids\":[\"x\"]}"), (cur, "{\"nextStageIndex\":2}")]),
        c(
            "fold-archived markers torn",
            vec![
                (".anti-hall/devswarm/fold-archived-resume.json", "{\"buck"),
                (".anti-hall/devswarm/fold-archived-family-resume.json", "nope"),
                (cur, "{\"nextStageIndex\":2}"),
            ],
        ),
    ]
}

#[test]
fn the_deferred_tick_is_nodes_on_every_marker_and_cursor_shape() {
    if !have_node() {
        return;
    }
    ah_engine::defaults::init().unwrap();
    let (mut ran, mut idle) = (0, 0);
    for case in cases() {
        let t = TempDir::new("dssup-deferred");
        let dir = std::fs::canonicalize(&t.0).unwrap();
        let (a, b): (PathBuf, PathBuf) = (dir.join("node"), dir.join("engine"));
        for h in [&a, &b] {
            std::fs::create_dir_all(h.join(".anti-hall/devswarm")).unwrap();
            for (rel, text) in &case.files {
                put(h, rel, text);
            }
        }
        for tick in 0..5 {
            let (n, e) = (node_tick(&a), engine_tick(&b));
            // Node's record is the duty's detail; a fallback to Node's function carries it too
            if n["ran"] == true {
                ran += 1;
            } else if n["reason"] == "no-marker" {
                idle += 1;
            }
            assert_eq!(mask(&n), mask(&e["detail"]), "{}: tick {tick}\nnode {n}\nengine {e}", case.name);
            assert_eq!(tree(&a), tree(&b), "{}: tick {tick}", case.name);
        }
    }
    assert!(ran >= 5 && idle >= 30, "the cases must reach both the stage run and the idle answer: ran {ran}, idle {idle}");
}
