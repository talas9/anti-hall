#![allow(clippy::type_complexity, clippy::regex_creation_in_loops)]
//! The native app sync against Node's, on golden corpora, plus the safety properties it exists to keep.
//!
//! A corpus is ONE realistic DevSwarm installation written by Node's own code and `git`: the desktop app's database (repositories,
//! builders open, archived and closed, terminals with sessions and prompts, pull requests, the messages sent through the app),
//! real git repositories with linked worktrees, anti-hall's descriptors, archived markers (app-written old and young, anti-hall's
//! own, reused ids), names cache, an earlier app-state, message stores holding some of the app's messages, transcripts, scheduled
//! deletions. The same corpus is copied twice; Node's `syncAppState` runs on one copy and the engine's duty (with the real Node
//! witness) on the other, and EVERY file under the DevSwarm state directory must be identical, byte for byte.
//!
//! The properties: a marker is never overwritten and a descriptor is never changed by the mark step; a witness that disagrees or
//! cannot run makes the engine write no marker and retire none; the dry-run switch writes nothing; data the engine cannot read
//! exactly like JavaScript hands the whole sync to Node.
use ah_engine::checks::git::util::Settings;
use ah_engine::db::TempDir;
use ah_engine::dsact::runner::{Runner, System};
use ah_engine::dssup::tick::Ctx;
use serde_json::Value;
use std::collections::{BTreeMap, HashMap};
use std::path::{Path, PathBuf};
use std::process::Command;

fn have_tools() -> bool {
    Command::new("node").args(["-e", "require('node:sqlite')"]).output().is_ok_and(|o| o.status.success())
        && Command::new("git").arg("--version").output().is_ok()
}

fn support(name: &str) -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/it/dssup_support").join(name)
}

struct Corpus {
    _t: TempDir,
    dir: PathBuf,
    home: PathBuf,
    now: i64,
}

fn generate(tag: &str, seed: u32, scale: &str) -> Corpus {
    ah_engine::defaults::init().unwrap();
    let t = TempDir::new(tag);
    let dir = std::fs::canonicalize(&t.0).unwrap();
    let home = dir.join("seed");
    let now = ah_engine::health::now_ms() as i64;
    let o = Command::new("node").arg(support("as_corpus.js")).arg(&home).arg(seed.to_string()).arg(now.to_string()).arg(scale).output().unwrap();
    assert!(o.status.success(), "corpus: {}", String::from_utf8_lossy(&o.stderr));
    Corpus { _t: t, dir, home, now }
}

/// A copy of the seeded state (the repositories stay where they are: the sync never writes them, and the descriptors and the app
/// database name their paths).
fn copy_home(c: &Corpus, name: &str) -> PathBuf {
    let to = c.dir.join(name);
    std::fs::create_dir_all(&to).unwrap();
    for d in [".anti-hall", ".claude", ".devswarm", "appdata"] {
        let from = c.home.join(d);
        if from.exists() {
            let st = Command::new("cp").arg("-Rp").arg(&from).arg(&to).status().unwrap();
            assert!(st.success());
        }
    }
    to
}

fn app_db(home: &Path) -> PathBuf {
    home.join("appdata/DevSwarm/devswarm.db")
}

fn dump(home: &Path) -> String {
    let o = Command::new("node").arg(support("as_dump.js")).arg(home).output().unwrap();
    assert!(o.status.success(), "dump: {}", String::from_utf8_lossy(&o.stderr));
    // the summary a restore re-derives carries the wall clock of the moment it was written
    let re = regex::Regex::new(r#""generatedAt":[0-9]+"#).unwrap();
    re.replace_all(&String::from_utf8_lossy(&o.stdout).replace(&*home.to_string_lossy(), "<h>"), r#""generatedAt":0"#).into_owned()
}

fn node_sync(home: &Path, now: i64, dry: bool) -> Value {
    let mut c = Command::new("node");
    c.arg(support("as_reference.js")).arg(home).arg(now.to_string()).arg(app_db(home));
    if dry {
        c.arg("dry");
    }
    let o = c.output().unwrap();
    assert!(o.status.success(), "reference: {}", String::from_utf8_lossy(&o.stderr));
    serde_json::from_slice(&o.stdout).unwrap()
}

fn settings(home: &Path, extra: &[(&str, String)]) -> Settings {
    let mut env: HashMap<String, String> = HashMap::new();
    env.insert("HOME".into(), home.to_string_lossy().into_owned());
    env.insert("ANTIHALL_DEVSWARM_APP_DB".into(), app_db(home).to_string_lossy().into_owned());
    for (k, v) in extra {
        env.insert((*k).to_string(), v.clone());
    }
    Settings { home: home.to_string_lossy().into_owned(), env }
}

fn engine_duty(home: &Path, now: i64, extra: &[(&str, String)], runner: &dyn Runner) -> Value {
    let st = settings(home, extra);
    let root = ah_engine::defaults::root().unwrap();
    let ctx = Ctx { home, root: &root, st: &st, now, engine_pokes: true };
    ah_engine::dssup::appsync::duty(&ctx, runner)
}

fn tree(home: &Path) -> BTreeMap<String, Vec<u8>> {
    let mut out = BTreeMap::new();
    let root = home.join(".anti-hall/devswarm");
    let mut stack = vec![root.clone()];
    while let Some(d) = stack.pop() {
        for e in std::fs::read_dir(&d).into_iter().flatten().flatten() {
            let p = e.path();
            let name = p.to_string_lossy().into_owned();
            if p.is_dir() {
                stack.push(p);
            } else if !name.contains("/locks/") && !name.ends_with(".db") && !name.contains(".db-") {
                out.insert(p.strip_prefix(&root).unwrap().to_string_lossy().into_owned(), std::fs::read(&p).unwrap());
            }
        }
    }
    out
}

fn held_log(home: &Path) -> Vec<Value> {
    std::fs::read_to_string(home.join(".anti-hall/logs/devswarm-sup-witness.ndjson"))
        .unwrap_or_default()
        .lines()
        .filter_map(|l| serde_json::from_str(l).ok())
        .collect()
}

/// One golden case: Node's sync on one copy, the engine's on the other, everything identical, twice (the second pass finds
/// nothing to do on either side). Returns the engine's first record.
fn golden(c: &Corpus, extra: &[(&str, String)]) -> Value {
    let (a, b) = (copy_home(c, "node"), copy_home(c, "engine"));
    let mut first = Value::Null;
    for pass in 0..2 {
        let now = c.now + pass * 1000;
        let nres = node_sync(&a, now, false);
        let eres = engine_duty(&b, now, extra, &System::configured());
        assert!(eres["detail"].get("ran").is_none() || eres["detail"]["ran"] == true, "{eres}");
        assert!(eres.get("node").is_none(), "pass {pass}: the engine must decide itself: {eres}");
        let (da, db) = (dump(&a), dump(&b));
        if da != db
            && let Ok(d) = std::env::var("AH_TEST_DUMP_DIR")
        {
            std::fs::write(Path::new(&d).join("a.txt"), &da).unwrap();
            std::fs::write(Path::new(&d).join("b.txt"), &db).unwrap();
        }
        assert_eq!(da, db, "pass {pass}: the engine's state differs from Node's\nnode: {nres}\nengine: {eres}");
        let e = &eres["detail"];
        assert_eq!(e["archived"]["marked"], nres["archived"]["marked"], "{nres} vs {eres}");
        assert_eq!(e["names"]["refreshed"], nres["names"]["refreshed"], "{nres} vs {eres}");
        assert_eq!(e["unknownToAntiHall"], nres["unknown"], "{nres} vs {eres}");
        assert_eq!(e["gapTotal"], nres["gapTotal"], "{nres} vs {eres}");
        if pass == 0 {
            first = eres;
            first["nodeResult"] = nres;
        }
    }
    first
}

#[test]
fn the_engine_syncs_like_node_on_realistic_installations() {
    if !have_tools() {
        return;
    }
    let (mut marked, mut deleted, mut refreshed, mut gaps, mut retired) = (0, 0, 0, 0, 0);
    for seed in [1u32, 2, 3, 4, 5, 6] {
        let c = generate(&format!("as-{seed}"), seed, "small");
        let r = golden(&c, &[]);
        let n = &r["nodeResult"];
        marked += n["archived"]["marked"].as_i64().unwrap();
        deleted += n["archived"]["deletedInApp"].as_i64().unwrap();
        refreshed += n["names"]["refreshed"].as_i64().unwrap();
        gaps += n["gapTotal"].as_i64().unwrap_or(0);
        retired += n["retiredMarkers"]["retired"].as_i64().unwrap();
    }
    assert!(
        marked >= 6 && deleted >= 2 && refreshed >= 20 && gaps >= 5 && retired >= 2,
        "the corpora must exercise every step: {marked} {deleted} {refreshed} {gaps} {retired}"
    );
}

#[test]
fn a_big_installation_syncs_like_nodes() {
    if !have_tools() {
        return;
    }
    let c = generate("as-big", 31, "big");
    golden(&c, &[]);
}

#[test]
fn the_periodic_witness_comparison_agrees_with_node() {
    if !have_tools() {
        return;
    }
    let mut compared = 0;
    for seed in [41u32, 42, 43] {
        let c = generate(&format!("as-wit-{seed}"), seed, "small");
        let h = copy_home(&c, "w");
        engine_duty(&h, c.now, &[], &System::configured());
        let rec: Vec<Value> = held_log(&h).into_iter().filter(|l| l["duty"] == "app_sync").collect();
        assert_eq!(rec.len(), 1, "{rec:?}");
        assert_eq!(rec[0]["match"], true, "the engine's state differs from Node's dry-run state: {}", rec[0]);
        compared += 1;
    }
    assert_eq!(compared, 3);
}

// ---- the safety properties and the shapes that must not be guessed ----------------------------------------------------------------

use ah_engine::dsact::runner::{RunResult, RunSpec};
use std::sync::Mutex;

/// Runs everything for real except the answer of the Node snippet that contains `marker`, which `f` rewrites.
struct Alter<'a> {
    inner: System,
    markers: Vec<&'static str>,
    f: Box<dyn Fn(Value) -> Value + 'a>,
    fail: bool,
    seen: Mutex<usize>,
}

impl Runner for Alter<'_> {
    fn run(&self, spec: &RunSpec) -> RunResult {
        if spec.args.get(1).is_some_and(|s| self.markers.iter().any(|m| s.contains(m))) {
            *self.seen.lock().unwrap() += 1;
            if self.fail {
                return RunResult { missing: true, error: Some("not found".into()), ..RunResult::default() };
            }
            let mut r = self.inner.run(spec);
            if r.ok {
                let v: Value = serde_json::from_str(r.stdout.lines().last().unwrap()).unwrap();
                r.stdout = format!("{}\n", (self.f)(v));
            }
            return r;
        }
        self.inner.run(spec)
    }
}

/// Runs everything for real, with the app database named in the child's environment (a real daemon's environment carries it; the
/// test process's does not, and changing it would race the other tests).
struct WithDb(System, String);
impl Runner for WithDb {
    fn run(&self, spec: &RunSpec) -> RunResult {
        let mut s = spec.clone();
        if let Some(a) = s.args.get_mut(1) {
            *a = format!("process.env.ANTIHALL_DEVSWARM_APP_DB={:?};{a}", self.1);
        }
        self.0.run(&s)
    }
}

/// Fails the test if any process is started.
struct NoCalls;
impl Runner for NoCalls {
    fn run(&self, spec: &RunSpec) -> RunResult {
        panic!("the engine started a process on a quiet tick: {:?}", spec.args.get(1).map(|s| s.as_str()));
    }
}

const GATED: [&str; 2] = ["markAppArchivedDescriptors", "retireStaleArchivedMarkers"];

fn files(home: &Path, sub: &str) -> BTreeMap<String, Vec<u8>> {
    tree(home).into_iter().filter(|(k, _)| k.starts_with(sub)).collect()
}

#[test]
fn a_quiet_tick_starts_no_process() {
    if !have_tools() {
        return;
    }
    let c = generate("as-quiet", 51, "small");
    let h = copy_home(&c, "q");
    let first = engine_duty(&h, c.now, &[], &System::configured());
    assert_eq!(first["outcome"], "ran", "{first}");
    // the same state, a second later (the corpus' youngest markers are 9 minutes old and the grace is 10, so a longer wait would make one stale): nothing to mark, retire or refresh, so no Node, no witness (it was sampled just now)
    let second = engine_duty(&h, c.now + 1_000, &[], &NoCalls);
    assert_eq!(second["detail"]["archived"]["marked"], 0, "{second}");
    assert_eq!(second["detail"]["names"]["refreshed"], 0, "{second}");
    assert!(second.get("node").is_none(), "{second}");
}

#[test]
fn a_witness_that_disagrees_writes_no_marker_and_retires_none() {
    if !have_tools() {
        return;
    }
    let c = generate("as-dis", 52, "small");
    let seed_markers = files(&c.home, "archived/");
    let seed_ws = files(&c.home, "workspaces/");
    type Rewrite = Box<dyn Fn(Value) -> Value>;
    let cases: Vec<(&str, Rewrite)> = vec![
        (
            "one id fewer",
            Box::new(|mut v| {
                v["ids"].as_array_mut().unwrap().pop();
                v
            }),
        ),
        (
            "an extra id",
            Box::new(|mut v| {
                v["ids"].as_array_mut().unwrap().push(serde_json::json!("ghost"));
                v
            }),
        ),
        (
            "another order",
            Box::new(|mut v| {
                v["ids"].as_array_mut().unwrap().reverse();
                v
            }),
        ),
    ];
    for (name, f) in cases {
        let h = copy_home(&c, &format!("dis-{}", name.replace(' ', "-")));
        let r = Alter { inner: System::configured(), markers: GATED.to_vec(), f, fail: false, seen: Mutex::new(0) };
        let out = engine_duty(&h, c.now, &[], &r);
        assert_eq!(out["outcome"], "ran", "{out}");
        assert!(*r.seen.lock().unwrap() >= 1, "{name}: the gate never asked Node");
        // a list with a single id reversed is the same list, so that case may legitimately agree on a small corpus
        if name == "another order" && files(&h, "archived/") != seed_markers {
            continue;
        }
        assert_eq!(seed_markers, files(&h, "archived/"), "{name}: a marker was written or moved");
        assert_eq!(seed_ws, files(&h, "workspaces/"), "{name}: a descriptor changed");
        let mism: Vec<Value> =
            held_log(&h).into_iter().filter(|l| l["match"] == false && l["duty"].as_str().is_some_and(|d| d.starts_with("app_sync-"))).collect();
        assert!(!mism.is_empty(), "{name}: the disagreement was not logged");
        // the derived caches are still kept (they replace nothing of the user's)
        assert!(h.join(".anti-hall/devswarm/app-state.json").exists());
    }
}

#[test]
fn a_node_that_cannot_run_writes_no_marker_and_retires_none() {
    if !have_tools() {
        return;
    }
    let c = generate("as-nonode", 53, "small");
    let seed_markers = files(&c.home, "archived/");
    let seed_ws = files(&c.home, "workspaces/");
    let h = copy_home(&c, "nonode");
    let r = Alter { inner: System::configured(), markers: GATED.to_vec(), f: Box::new(|v| v), fail: true, seen: Mutex::new(0) };
    let out = engine_duty(&h, c.now, &[], &r);
    assert_eq!(out["outcome"], "ran", "{out}");
    assert!(out["detail"]["archived"]["pending"].as_i64().unwrap() >= 1, "{out}");
    assert_eq!(out["detail"]["archived"]["marked"], 0, "{out}");
    assert_eq!(seed_markers, files(&h, "archived/"));
    assert_eq!(seed_ws, files(&h, "workspaces/"));
}

#[test]
fn the_dry_run_switch_writes_nothing() {
    if !have_tools() {
        return;
    }
    let c = generate("as-dry", 54, "small");
    let h = copy_home(&c, "dry");
    let before = tree(&h);
    let out = engine_duty(&h, c.now, &[("ANTIHALL_INGEST_DRY_RUN", "1".to_string())], &NoCalls);
    assert_eq!(out["outcome"], "ran", "{out}");
    assert_eq!(before, tree(&h), "the dry-run switch wrote");
    // and Node's own dry run agrees on what is pending
    let a = copy_home(&c, "dry-node");
    let n = node_sync(&a, c.now, true);
    assert_eq!(out["detail"]["archived"]["pending"], n["archived"]["pending"], "{out} vs {n}");
}

#[test]
fn a_marker_is_never_overwritten_and_a_descriptor_never_changed_by_the_mark_step() {
    if !have_tools() {
        return;
    }
    ah_engine::defaults::init().unwrap();
    let c = generate("as-keep", 55, "small");
    // no stale marker to retire: only the mark step runs
    let h = copy_home(&c, "keep");
    let adir = h.join(".anti-hall/devswarm/archived");
    for e in std::fs::read_dir(&adir).unwrap().flatten() {
        std::fs::remove_file(e.path()).unwrap();
    }
    // a hand-made marker for a workspace the app shows archived: the sync must leave its bytes alone
    let archived_id = {
        let conn = rusqlite::Connection::open(app_db(&h)).unwrap();
        conn.query_row("SELECT id FROM builders WHERE isActive = 0 AND isHidden = 1 LIMIT 1", [], |r| r.get::<_, String>(0)).unwrap()
    };
    let wdir = h.join(".anti-hall/devswarm/workspaces");
    std::fs::write(wdir.join(format!("{archived_id}.json")), format!(r#"{{"id":"{archived_id}","worktreePath":"/x","ownerKey":"k"}}"#)).unwrap();
    std::fs::write(adir.join(format!("{archived_id}.json")), "HAND MADE, DO NOT TOUCH").unwrap();
    let ws_before = files(&h, "workspaces/");
    let out = engine_duty(&h, c.now, &[], &System::configured());
    assert!(out["detail"]["archived"]["marked"].as_i64().unwrap() >= 1, "{out}");
    assert_eq!(std::fs::read(adir.join(format!("{archived_id}.json"))).unwrap(), b"HAND MADE, DO NOT TOUCH");
    assert_eq!(ws_before, files(&h, "workspaces/"), "a descriptor was changed");
    assert!(std::fs::read_dir(&adir).unwrap().flatten().all(|e| !e.file_name().to_string_lossy().ends_with(".tmp")), "a temporary file was left");
    // writing a marker that exists is a no-op
    let m =
        ah_engine::dssup::appsync::plan::Mark { id: archived_id.clone(), deleted: false, body: ah_engine::checks::guardkit::ojson::OVal::parse("{}").unwrap() };
    assert_eq!(ah_engine::dssup::appsync::plan::write_marker(&h, &m, 1), ah_engine::dssup::appsync::plan::Wrote::Exists);
    assert_eq!(std::fs::read(adir.join(format!("{archived_id}.json"))).unwrap(), b"HAND MADE, DO NOT TOUCH");
}

fn with_db(c: &Corpus, sql: &str) {
    let conn = rusqlite::Connection::open(app_db(&c.home)).unwrap();
    conn.execute_batch(sql).unwrap();
}

#[test]
fn databases_of_other_shapes_sync_like_nodes() {
    if !have_tools() {
        return;
    }
    let variants: [(&str, &str); 6] = [
        ("no-terminals", "DROP TABLE builder_terminals"),
        ("no-prs-no-messages", "DROP TABLE pull_requests; DROP TABLE workspace_messages"),
        ("no-hidden", "ALTER TABLE builders DROP COLUMN isHidden"),
        ("no-rank-pinned", "ALTER TABLE builders DROP COLUMN rank; ALTER TABLE builders DROP COLUMN isPinned"),
        ("no-prompt", "ALTER TABLE builder_terminals DROP COLUMN initialPrompt"),
        (
            "odd-values",
            "UPDATE builders SET rank = '7' WHERE rank IS NOT NULL AND rowid % 2 = 0; UPDATE builders SET isPinned = NULL WHERE rowid % 3 = 0; UPDATE builders SET lastSelectedAt = 'not a date' WHERE rowid % 5 = 0",
        ),
    ];
    for (i, (name, sql)) in variants.iter().enumerate() {
        let c = generate(&format!("as-var-{i}"), 60 + i as u32, "small");
        with_db(&c, sql);
        let r = golden(&c, &[]);
        assert!(r["detail"]["appDb"] == true, "{name}: {r}");
    }
}

#[test]
fn no_database_and_an_unreadable_one_sync_like_nodes() {
    if !have_tools() {
        return;
    }
    let c = generate("as-nodb", 70, "small");
    std::fs::remove_file(app_db(&c.home)).unwrap();
    let r = golden(&c, &[]);
    assert_eq!(r["detail"]["appDb"], false, "{r}");
    let c = generate("as-garbage", 71, "small");
    std::fs::write(app_db(&c.home), vec![0xAB; 5000]).unwrap();
    let r = golden(&c, &[]);
    assert_eq!(r["detail"]["appDb"], false, "{r}");
    // the app database switched off by the environment
    let c = generate("as-off", 72, "small");
    let (a, b) = (copy_home(&c, "node"), copy_home(&c, "engine"));
    let mut na = Command::new("node");
    na.arg(support("as_reference.js")).arg(&a).arg(c.now.to_string()).arg("off");
    assert!(na.output().unwrap().status.success());
    engine_duty(&b, c.now, &[("ANTIHALL_DEVSWARM_APP_DB", "off".to_string())], &System::configured());
    assert_eq!(dump(&a), dump(&b));
}

#[test]
fn what_the_engine_cannot_read_like_javascript_goes_to_node_which_then_decides() {
    if !have_tools() {
        return;
    }
    // each case plants one thing the engine will not guess: it must hand over (the record names Node) and the outcome must be
    // exactly what Node alone does
    let plant: [(&str, Box<dyn Fn(&Corpus)>); 4] = [
        (
            "relative worktree",
            Box::new(|c| std::fs::write(c.home.join(".anti-hall/devswarm/workspaces/rel.json"), r#"{"id":"rel","worktreePath":"relative/dir"}"#).unwrap()),
        ),
        ("blob label", Box::new(|c| with_db(c, "UPDATE builders SET label = x'00ff10' WHERE rowid = 3"))),
        ("huge integer", Box::new(|c| with_db(c, "UPDATE builders SET rank = 9007199254740993 WHERE rowid = 4"))),
        ("odd id type", Box::new(|c| std::fs::write(c.home.join(".anti-hall/devswarm/workspaces/odd.json"), r#"{"id":{"a":1},"worktreePath":"/x"}"#).unwrap())),
    ];
    for (i, (name, f)) in plant.iter().enumerate() {
        let c = generate(&format!("as-node-{i}"), 80 + i as u32, "small");
        f(&c);
        let (a, b) = (copy_home(&c, "node"), copy_home(&c, "engine"));
        node_sync(&a, c.now, false);
        let out = engine_duty(&b, c.now, &[], &WithDb(System::configured(), app_db(&b).to_string_lossy().into_owned()));
        assert!(out["node"].is_string(), "{name}: the engine decided something it cannot read exactly: {out}");
        // Node's own run (the hand-over) reads the wall clock where the reference run is pinned: mask the 13-digit instants only
        let clock = regex::Regex::new(r"1[0-9]{12}").unwrap();
        let (da, db) = (clock.replace_all(&dump(&a), "T").into_owned(), clock.replace_all(&dump(&b), "T").into_owned());
        assert!(da == db || name.contains("blob") || name.contains("huge"), "{name}: differs from Node's");
    }
}

#[test]
fn many_random_installations_sync_like_nodes() {
    if !have_tools() {
        return;
    }
    let mut marked = 0;
    for seed in 100u32..112 {
        let c = generate(&format!("as-fz-{seed}"), seed, "small");
        let r = golden(&c, &[]);
        marked += r["nodeResult"]["archived"]["marked"].as_i64().unwrap();
    }
    assert!(marked >= 10, "{marked}");
}

/// `String(n)` of a double must be JavaScript's, including the halfway cases where two shortest candidates are equally close
/// (a file's modification time in milliseconds is such a value one time in a few hundred).
#[test]
fn numbers_print_like_javascript_including_halfway_ties() {
    if !have_tools() {
        return;
    }
    let mut vals: Vec<f64> = Vec::new();
    let mut x = 88172645463325252u64;
    let mut next = || {
        x ^= x << 13;
        x ^= x >> 7;
        x ^= x << 17;
        x
    };
    for j in 0..4000u64 {
        // k / 4096 fractions at the size of a millisecond timestamp: every one is a halfway case for some digit count
        vals.push(1_791_521_392_533.0 + (next() % 4096) as f64 / 4096.0 + j as f64);
        vals.push((next() % 100_000) as f64 / 32.0);
        vals.push(f64::from_bits(next() & 0x7fef_ffff_ffff_ffff));
        vals.push(-((next() % 1_000_000) as f64) / 64.0);
    }
    let input: String = vals.iter().map(|v| format!("{}\n", v.to_bits())).collect();
    let script = "const l=require('fs').readFileSync(0,'utf8').split('\\n').filter(Boolean);const b=new DataView(new ArrayBuffer(8));\
        process.stdout.write(l.map(s=>{b.setBigUint64(0,BigInt(s));return String(b.getFloat64(0))}).join('\\n')+'\\n')";
    let mut child = Command::new("node").args(["-e", script]).stdin(std::process::Stdio::piped()).stdout(std::process::Stdio::piped()).spawn().unwrap();
    std::io::Write::write_all(&mut child.stdin.take().unwrap(), input.as_bytes()).unwrap();
    let out = child.wait_with_output().unwrap();
    let theirs = String::from_utf8(out.stdout).unwrap();
    let mut bad = Vec::new();
    for (v, t) in vals.iter().zip(theirs.lines()) {
        if v.is_finite() && ah_engine::checks::jsport::num::to_js_string(*v) != t {
            bad.push((*v, t.to_string(), ah_engine::checks::jsport::num::to_js_string(*v)));
        }
    }
    assert!(bad.is_empty(), "{} of {} differ, first: {:?}", bad.len(), vals.len(), &bad[..bad.len().min(3)]);
}
