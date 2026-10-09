//! The native retention sweep against Node's, on golden corpora, plus the safety properties retention exists to keep.
//!
//! A corpus is ONE realistic message store written by Node's own store code (direct partitions of every reader shape, the
//! broadcast partition with heartbeat runs, open questions, NDJSON inboxes that repeat bodies, legacy cursor files and rows,
//! restore holds, multi-byte and empty bodies, earlier tombstones). The same corpus is copied twice; Node's `sweep` runs on one
//! copy and the engine's duty (with the real Node witness) on the other, and EVERYTHING retention can touch must be identical:
//! every table of the store (all columns, so a tombstone is exactly a NULL body), every archive month (decompressed, byte for
//! byte), the retention state and the retention log.
//!
//! The properties: no body is lost unless Node would tombstone it and it is in the archive (when archiving is on); a witness
//! that disagrees, cannot run, or sees the store change under the comparison makes the engine write NOTHING; a row that stopped
//! being eligible between the plan and the write is not tombstoned; the dry run and the non-armed phase write nothing.
use ah_engine::checks::git::util::Settings;
use ah_engine::db::TempDir;
use ah_engine::dsact::runner::{RunResult, RunSpec, Runner, System};
use ah_engine::dssup::retention::apply::{self, Chosen, Run};
use ah_engine::dssup::retention::plan;
use ah_engine::dssup::tick::Ctx;
use serde_json::Value;
use std::collections::{BTreeMap, HashMap};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Mutex;

const HASH: &str = "proj-abcdef";

fn have_node_sqlite() -> bool {
    Command::new("node").args(["-e", "require('node:sqlite')"]).output().is_ok_and(|o| o.status.success())
        && Command::new("gzip").arg("--version").output().is_ok()
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
    let o = Command::new("node").arg(support("rt_corpus.js")).arg(&home).arg(HASH).arg(seed.to_string()).arg(now.to_string()).arg(scale).output().unwrap();
    assert!(o.status.success(), "corpus: {}", String::from_utf8_lossy(&o.stderr));
    Corpus { _t: t, dir, home, now }
}

/// A copy of the seeded home (modification times kept).
fn copy_home(c: &Corpus, name: &str) -> PathBuf {
    let to = c.dir.join(name);
    let st = Command::new("cp").arg("-Rp").arg(&c.home).arg(&to).status().unwrap();
    assert!(st.success());
    to
}

fn dump(home: &Path) -> String {
    let o = Command::new("node").arg(support("rt_dump.js")).arg(home).output().unwrap();
    assert!(o.status.success(), "dump: {}", String::from_utf8_lossy(&o.stderr));
    String::from_utf8_lossy(&o.stdout).into_owned()
}

fn node_sweep(home: &Path, now: i64, env: &HashMap<String, String>) -> Value {
    let o = Command::new("node").arg(support("rt_reference.js")).arg(home).arg(now.to_string()).arg(serde_json::to_string(env).unwrap()).output().unwrap();
    assert!(o.status.success(), "reference: {}", String::from_utf8_lossy(&o.stderr));
    serde_json::from_slice(&o.stdout).unwrap()
}

fn settings(home: &Path, env: &HashMap<String, String>) -> Settings {
    let mut e = env.clone();
    e.insert("HOME".into(), home.to_string_lossy().into_owned());
    Settings { home: home.to_string_lossy().into_owned(), env: e }
}

fn engine_duty(home: &Path, now: i64, env: &HashMap<String, String>, runner: &dyn Runner) -> Value {
    let st = settings(home, env);
    let root = ah_engine::defaults::root().unwrap();
    let ctx = Ctx { home, root: &root, st: &st, now, engine_pokes: true };
    ah_engine::dssup::retention::duty(&ctx, runner)
}

fn env_of(days: &str, keep: &str, max_mb: &str, archive: &str) -> HashMap<String, String> {
    let mut e = HashMap::new();
    e.insert("ANTIHALL_DEVSWARM_RETENTION_DAYS".into(), days.into());
    e.insert("ANTIHALL_DEVSWARM_RETENTION_KEEP_PER_PARTITION".into(), keep.into());
    e.insert("ANTIHALL_DEVSWARM_RETENTION_MAX_STORE_MB".into(), max_mb.into());
    e.insert("ANTIHALL_DEVSWARM_RETENTION_ARCHIVE".into(), archive.into());
    e.insert("ANTIHALL_DEVSWARM_RETENTION_BUDGET_MS".into(), "600000".into());
    e
}

/// The state and log fields that depend on the physical size of the file (two SQLite builds may lay pages out differently),
/// masked in both dumps; everything else must match exactly.
fn mask(d: &str) -> String {
    let re = regex::Regex::new(r#""(bytesBefore|bytesAfter)":[0-9.]+"#).unwrap();
    // the size of a compressed archive month depends on the compressor (zlib in Node, the system gzip here)
    let evict = regex::Regex::new(r#"("event":"archive-evict","file":"[^"]*","bytes":)[0-9]+"#).unwrap();
    evict.replace_all(&re.replace_all(d, r#""$1":0"#), "${1}0").into_owned()
}

fn bodies(home: &Path) -> BTreeMap<i64, Option<String>> {
    let c = rusqlite::Connection::open_with_flags(plan::db_path(home, HASH), rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
    let mut st = c.prepare("SELECT id, body FROM messages").unwrap();
    st.query_map([], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, Option<String>>(1)?))).unwrap().flatten().collect()
}

/// Every archived row of a home: id -> body.
fn archived(home: &Path) -> BTreeMap<i64, String> {
    let mut out = BTreeMap::new();
    let dir = home.join(".anti-hall/devswarm/archive").join(HASH);
    for e in std::fs::read_dir(dir).into_iter().flatten().flatten() {
        let gz = std::fs::read(e.path()).unwrap();
        let text = ah_engine::dssup::retention::gz::decompress(&gz).unwrap();
        for l in String::from_utf8(text).unwrap().lines() {
            let v: Value = serde_json::from_str(l).unwrap();
            out.insert(v["id"].as_i64().unwrap(), v["body"].as_str().unwrap_or_default().to_string());
        }
    }
    out
}

/// One golden case: Node's sweep on one copy, the engine's on the other, everything identical; the properties on the result.
fn golden(c: &Corpus, env: &HashMap<String, String>) -> usize {
    let (a, b) = (copy_home(c, "node"), copy_home(c, "engine"));
    let before = bodies(&c.home);
    let nres = node_sweep(&a, c.now, env);
    let eres = engine_duty(&b, c.now, env, &System::configured());
    assert_eq!(eres["outcome"], "ran", "{eres}");
    assert!(eres["detail"].get("node").is_none(), "the engine must decide itself: {eres}");
    assert_eq!(mask(&dump(&a)), mask(&dump(&b)), "the engine's store, archive, state and log differ from Node's\nnode: {nres}\nengine: {eres}");
    // the properties
    let (after_n, after_e) = (bodies(&a), bodies(&b));
    let lost_e: Vec<i64> = before.iter().filter(|(id, b0)| b0.is_some() && after_e[id].is_none()).map(|(id, _)| *id).collect();
    let lost_n: Vec<i64> = before.iter().filter(|(id, b0)| b0.is_some() && after_n[id].is_none()).map(|(id, _)| *id).collect();
    assert!(lost_e.iter().all(|id| lost_n.contains(id)), "the engine tombstoned a body Node would not have");
    if env["ANTIHALL_DEVSWARM_RETENTION_ARCHIVE"] == "true" {
        let arch = archived(&b);
        for id in &lost_e {
            assert_eq!(arch.get(id), before[id].as_ref(), "tombstoned body {id} is not in the archive byte for byte");
        }
    }
    assert!(after_e.keys().eq(before.keys()), "a row was deleted");
    lost_e.len()
}

#[test]
fn the_engine_sweeps_like_node_on_the_default_settings() {
    if !have_node_sqlite() {
        return;
    }
    let mut total = 0;
    for seed in [1u32, 2, 3] {
        let c = generate(&format!("rt-def-{seed}"), seed, "small");
        total += golden(&c, &env_of("30", "5", "100", "true"));
    }
    assert!(total > 100, "the corpora must tombstone something: {total}");
}

#[test]
fn the_engine_sweeps_like_node_under_a_size_limit_and_without_an_archive() {
    if !have_node_sqlite() {
        return;
    }
    let c = generate("rt-size", 4, "small");
    let n = golden(&c, &env_of("30", "5", "0.4", "true"));
    assert!(n > 100, "{n}");
    let c = generate("rt-noarch", 5, "small");
    golden(&c, &env_of("1", "0", "0.5", "false"));
}

#[test]
fn the_engine_sweeps_like_node_across_many_random_settings() {
    if !have_node_sqlite() {
        return;
    }
    let mut rng = 0x9e3779b9u32;
    let mut pick = |a: &[&'static str]| {
        rng = rng.wrapping_mul(1664525).wrapping_add(1013904223);
        a[(rng >> 8) as usize % a.len()]
    };
    let mut tombstoned = 0;
    for seed in 10u32..26 {
        let c = generate(&format!("rt-fz-{seed}"), seed, "small");
        let env =
            env_of(pick(&["1", "7", "30", "0.5", "90"]), pick(&["0", "3", "50", "200"]), pick(&["100", "0", "0.2", "0.6"]), pick(&["true", "true", "false"]));
        tombstoned += golden(&c, &env);
    }
    assert!(tombstoned > 500, "{tombstoned}");
}

#[test]
fn a_large_store_is_swept_like_nodes() {
    if !have_node_sqlite() {
        return;
    }
    let c = generate("rt-big", 31, "big");
    let n = golden(&c, &env_of("30", "20", "100", "true"));
    assert!(n > 1000, "{n}");
}

// ---- the safety properties ----------------------------------------------------------------------------------------------------

/// Runs everything for real except Node's witness, whose answer a test rewrites.
struct Rewriting<'a> {
    inner: System,
    witness: Box<dyn Fn(Value) -> Value + 'a>,
    after_witness: Option<Box<dyn Fn() + 'a>>,
    seen: Mutex<usize>,
}

impl Runner for Rewriting<'_> {
    fn run(&self, spec: &RunSpec) -> RunResult {
        let mut r = self.inner.run(spec);
        let is_witness = spec.args.get(1).is_some_and(|s| s.contains("planStore"));
        if is_witness && r.ok {
            *self.seen.lock().unwrap() += 1;
            let v: Value = serde_json::from_str(r.stdout.lines().last().unwrap()).unwrap();
            r.stdout = format!("{}\n", (self.witness)(v));
            if let Some(f) = &self.after_witness {
                f();
            }
        }
        r
    }
}

fn rewriting<'a>(f: impl Fn(Value) -> Value + 'a) -> Rewriting<'a> {
    Rewriting { inner: System::configured(), witness: Box::new(f), after_witness: None, seen: Mutex::new(0) }
}

fn untouched(c: &Corpus, home: &Path) {
    assert_eq!(bodies(&c.home), bodies(home), "a body changed");
    assert!(!home.join(".anti-hall/devswarm/archive").exists(), "an archive was written");
    let state = std::fs::read_to_string(home.join(".anti-hall/devswarm/retention-state.json")).unwrap();
    assert!(!state.contains("lastRunAt"), "the store was recorded as swept: {state}");
}

fn held_log(home: &Path) -> Vec<Value> {
    std::fs::read_to_string(home.join(".anti-hall/logs/devswarm-sup-witness.ndjson"))
        .unwrap_or_default()
        .lines()
        .filter_map(|l| serde_json::from_str(l).ok())
        .collect()
}

#[test]
fn a_witness_that_disagrees_makes_the_engine_write_nothing() {
    if !have_node_sqlite() {
        return;
    }
    let c = generate("rt-dis", 41, "small");
    let env = env_of("30", "5", "100", "true");
    // one candidate fewer, one extra, one with another position, one statistic off: each alone must stop the sweep
    type Rewrite = Box<dyn Fn(Value) -> Value>;
    let cases: Vec<(&str, Rewrite)> = vec![
        (
            "a candidate missing",
            Box::new(|mut v| {
                v["cands"].as_array_mut().unwrap().pop();
                v
            }),
        ),
        (
            "an extra candidate",
            Box::new(|mut v| {
                v["cands"].as_array_mut().unwrap().push(serde_json::json!([999_999, 1, "ws-1", 5, 1]));
                v
            }),
        ),
        (
            "another position",
            Box::new(|mut v| {
                v["cands"][0][1] = serde_json::json!(v["cands"][0][1].as_i64().unwrap() + 1);
                v
            }),
        ),
        (
            "a statistic off",
            Box::new(|mut v| {
                let k = v["parts"].as_object().unwrap().keys().next().unwrap().clone();
                v["parts"][k]["protected"]["unread"] = serde_json::json!(-1);
                v
            }),
        ),
        (
            "another count chosen",
            Box::new(|mut v| {
                v["dry"]["ageCandidates"] = serde_json::json!(v["dry"]["ageCandidates"].as_i64().unwrap() + 1);
                v
            }),
        ),
        (
            "node could not plan",
            Box::new(|mut v| {
                v["dry"]["ok"] = serde_json::json!(false);
                v
            }),
        ),
    ];
    for (name, f) in cases {
        let h = copy_home(&c, &format!("dis-{}", name.replace(' ', "-")));
        let r = rewriting(f);
        let out = engine_duty(&h, c.now, &env, &r);
        assert_eq!(*r.seen.lock().unwrap(), 1, "{name}");
        assert!(out["detail"]["store"]["held"].is_string(), "{name}: {out}");
        untouched(&c, &h);
        let last = held_log(&h).into_iter().rev().find(|l| l["duty"] == "retention").unwrap();
        assert_eq!(last["match"], false, "{name}: {last}");
        // and it is not retried before the witness interval: the next tick does not even ask Node
        let again = rewriting(|v| v);
        engine_duty(&h, c.now + 1000, &env, &again);
        assert_eq!(*again.seen.lock().unwrap(), 0, "{name}: retried at once");
        untouched(&c, &h);
    }
}

#[test]
fn a_witness_that_cannot_run_writes_nothing_unless_it_is_switched_off() {
    if !have_node_sqlite() {
        return;
    }
    let c = generate("rt-nowit", 42, "small");
    let env = env_of("30", "5", "100", "true");
    struct NoNode(System);
    impl Runner for NoNode {
        fn run(&self, spec: &RunSpec) -> RunResult {
            if spec.bin.as_deref() == Some("node") {
                return RunResult { missing: true, error: Some("not found".into()), ..RunResult::default() };
            }
            self.0.run(spec)
        }
    }
    let h = copy_home(&c, "nonode");
    let out = engine_duty(&h, c.now, &env, &NoNode(System::configured()));
    assert!(out["detail"]["store"]["held"].is_string(), "{out}");
    untouched(&c, &h);
    // switched off (Node decommissioned): the engine's two identical plans and its transaction checks are the guard
    let mut off = env.clone();
    off.insert("ANTIHALL_DEVSWARM_SUP_RETENTION_REQUIRE_WITNESS".into(), "false".into());
    let h2 = copy_home(&c, "nonode-off");
    let out = engine_duty(&h2, c.now, &off, &NoNode(System::configured()));
    assert!(out["detail"]["store"]["tombstoned"].as_i64().unwrap() > 0, "{out}");
}

#[test]
fn a_store_that_changes_during_the_comparison_is_left_alone() {
    if !have_node_sqlite() {
        return;
    }
    let c = generate("rt-move", 43, "small");
    let env = env_of("30", "5", "100", "true");
    let h = copy_home(&c, "move");
    let mut r = rewriting(|v| v);
    let home = h.clone();
    // a reader falls back in the middle: a floor row is lowered after Node answered
    r.after_witness = Some(Box::new(move || {
        let conn = rusqlite::Connection::open(plan::db_path(&home, HASH)).unwrap();
        conn.execute("UPDATE reader_cursors SET value = value / 2 WHERE ns = 'store'", []).unwrap();
        conn.execute("DELETE FROM messages WHERE id = (SELECT MAX(id) FROM messages)", []).unwrap();
    }));
    let out = engine_duty(&h, c.now, &env, &r);
    assert!(out["detail"]["store"]["held"].is_string(), "{out}");
    let b = bodies(&h);
    let b0 = bodies(&c.home);
    assert!(b.iter().all(|(id, v)| b0.get(id) == Some(v) || !b0.contains_key(id)), "a body changed");
    assert!(!h.join(".anti-hall/devswarm/archive").exists());
}

#[test]
fn a_row_that_stopped_being_eligible_after_the_plan_is_not_tombstoned() {
    if !have_node_sqlite() {
        return;
    }
    let c = generate("rt-late", 44, "small");
    let h = copy_home(&c, "late");
    let env = env_of("30", "5", "100", "true");
    let st = settings(&h, &env);
    let root = ah_engine::defaults::root().unwrap();
    let ctx = Ctx { home: &h, root: &root, st: &st, now: c.now, engine_pokes: true };
    let s = ah_engine::dssup::retention::read_settings(&ctx);
    let p = plan::plan_store(&h, HASH, s.rules(), c.now as f64, &[]).unwrap();
    let chosen = Chosen::by_age(&p);
    assert!(chosen.list.len() > 20);
    // after the plan: the first candidate becomes an open question, the second is re-pointed at another partition, the third's
    // reader falls back below its position
    let conn = rusqlite::Connection::open(plan::db_path(&h, HASH)).unwrap();
    let (c1, c2, c3) = (
        &chosen.list[0],
        &chosen.list[1],
        chosen
            .list
            .iter()
            .find(|x| x.partition != chosen.list[0].partition && x.partition != chosen.list[1].partition && x.partition != "*mesh-broadcast*")
            .unwrap(),
    );
    conn.execute("UPDATE messages SET needs_reply = 1 WHERE id = ?1", [c1.id]).unwrap();
    conn.execute("UPDATE messages SET workspace_id = 'moved' WHERE id = ?1", [c2.id]).unwrap();
    conn.execute("UPDATE reader_cursors SET value = 0 WHERE partition = ?1 AND ns = 'store'", [&c3.partition]).unwrap();
    drop(conn);
    let mut state = ah_engine::checks::guardkit::ojson::OVal::parse(r#"{"stores":{},"holds":{},"phase":"armed"}"#).unwrap();
    let mut run = Run { home: &h, hash: HASH, settings: s, now: c.now as f64, budget_ms: 600_000.0, state: &mut state };
    let bytes = apply::store_bytes(&h, HASH);
    let r = apply::prune(&mut run, &p, chosen.clone(), 0, chosen.list.len(), bytes, false).unwrap();
    let after = bodies(&h);
    assert!(after[&c1.id].is_some(), "an open question lost its body");
    assert!(after[&c2.id].is_some(), "a row moved to another partition lost its body");
    assert!(
        after.iter().filter(|(id, _)| chosen.list.iter().any(|x| x.id == **id && x.partition == c3.partition)).all(|(_, b)| b.is_some()),
        "rows above a fallen-back reader lost their bodies"
    );
    assert!(r.tombstoned > 0 && (r.tombstoned as usize) < chosen.list.len());
}

#[test]
fn the_dry_run_the_dry_run_phase_and_a_disabled_retention_write_nothing() {
    if !have_node_sqlite() {
        return;
    }
    let c = generate("rt-dry", 41, "small");
    let env = env_of("30", "5", "100", "true");
    // dry run: plans and compares, logs, writes nothing
    let h = copy_home(&c, "dry");
    let mut dry = env.clone();
    dry.insert("ANTIHALL_DEVSWARM_SUP_DRYRUN_RETENTION".into(), "true".into());
    let out = engine_duty(&h, c.now, &dry, &System::configured());
    assert_eq!(out["outcome"], "dry-run", "{out}");
    assert!(out["detail"]["store"]["candidates"].as_i64().unwrap() > 0, "{out}");
    untouched(&c, &h);
    // not armed, and Node's witness cannot answer (a recording runner stands in for Node): the engine writes nothing itself and
    // the whole sweep is handed to Node's own function
    let h2 = copy_home(&c, "phase");
    std::fs::write(h2.join(".anti-hall/devswarm/retention-state.json"), r#"{"stores":{},"holds":{},"phase":"dry-run"}"#).unwrap();
    struct Rec(Mutex<Vec<String>>);
    impl Runner for Rec {
        fn run(&self, spec: &RunSpec) -> RunResult {
            self.0.lock().unwrap().push(spec.args.get(1).cloned().unwrap_or_default());
            RunResult { ok: true, status: Some(0), stdout: "{\"stub\":true}\n".into(), ..RunResult::default() }
        }
    }
    let rec = Rec(Mutex::new(vec![]));
    let out = engine_duty(&h2, c.now, &env, &rec);
    assert_eq!(out["outcome"], "ran", "{out}");
    let calls = rec.0.lock().unwrap();
    assert_eq!(calls.len(), 2, "{calls:?}");
    assert!(calls[0].contains("planStore") && calls[1].contains(".sweep("), "the witness first, then the whole sweep is Node's: {calls:?}");
    assert_eq!(bodies(&c.home), bodies(&h2));
    assert!(!h2.join(".anti-hall/devswarm/retention-dry-run.json").exists(), "the engine wrote a report without a witness");
    // disabled (days = 0): nothing runs at all
    let h3 = copy_home(&c, "off");
    let rec = Rec(Mutex::new(vec![]));
    let out = engine_duty(&h3, c.now, &env_of("0", "5", "100", "true"), &rec);
    assert_eq!(out["detail"]["ran"], false, "{out}");
    assert!(rec.0.lock().unwrap().is_empty());
    assert_eq!(bodies(&c.home), bodies(&h3));
}

#[test]
fn a_retention_run_holds_the_lock_and_a_second_one_skips() {
    if !have_node_sqlite() {
        return;
    }
    let c = generate("rt-lock", 46, "small");
    let h = copy_home(&c, "lock");
    let env = env_of("30", "5", "100", "true");
    let lock = h.join(".anti-hall/devswarm/locks/retention.lock");
    std::fs::create_dir_all(lock.parent().unwrap()).unwrap();
    let held = ah_engine::checks::guardkit::nodelock::acquire(
        &lock.to_string_lossy(),
        ah_engine::checks::guardkit::nodelock::Params {
            stale_ms: 600_000,
            wait_ms: 0,
            steal_dead: true,
            ..ah_engine::checks::guardkit::nodelock::Params::swarm()
        },
    )
    .unwrap();
    let out = engine_duty(&h, c.now, &env, &System::configured());
    assert_eq!(out["detail"]["reason"], "lock-busy", "{out}");
    held.release();
    assert_eq!(bodies(&c.home), bodies(&h));
    assert!(!lock.exists() || std::fs::metadata(&lock).is_ok());
}

struct Rec(Mutex<Vec<String>>);
impl Runner for Rec {
    fn run(&self, spec: &RunSpec) -> RunResult {
        self.0.lock().unwrap().push(spec.args.get(1).cloned().unwrap_or_default());
        RunResult { ok: true, status: Some(0), stdout: "{\"stub\":true}\n".into(), ..RunResult::default() }
    }
}

#[test]
fn a_body_the_engine_cannot_read_like_node_hands_the_whole_sweep_to_node() {
    if !have_node_sqlite() {
        return;
    }
    let c = generate("rt-blob", 47, "small");
    let h = copy_home(&c, "blob");
    let conn = rusqlite::Connection::open(plan::db_path(&h, HASH)).unwrap();
    conn.execute("UPDATE messages SET body = x'00ff10' WHERE id = (SELECT MIN(id) FROM messages WHERE body IS NOT NULL)", []).unwrap();
    drop(conn);
    let before = bodies_raw(&h);
    let rec = Rec(Mutex::new(vec![]));
    let out = engine_duty(&h, c.now, &env_of("30", "5", "100", "true"), &rec);
    let calls = rec.0.lock().unwrap();
    assert_eq!(calls.len(), 1, "{calls:?}");
    assert!(calls[0].contains(".sweep("), "{calls:?}");
    assert_eq!(out["outcome"], "ran", "{out}");
    assert_eq!(before, bodies_raw(&h), "the engine wrote before handing over");
    assert!(!h.join(".anti-hall/devswarm/archive").exists());
}

fn bodies_raw(home: &Path) -> Vec<(i64, String)> {
    let c = rusqlite::Connection::open_with_flags(plan::db_path(home, HASH), rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
    let mut st = c.prepare("SELECT id, typeof(body) || ':' || COALESCE(hex(body), '') FROM messages ORDER BY id").unwrap();
    st.query_map([], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?))).unwrap().flatten().collect()
}

#[test]
fn the_journal_fold_and_the_archive_cap_stay_nodes_and_match_it() {
    if !have_node_sqlite() {
        return;
    }
    let c = generate("rt-cap", 48, "small");
    // a legacy journal beside the store (the fold's input) and a tiny archive cap (the eviction's)
    let jd = c.home.join(".anti-hall/devswarm/store").join(HASH).join("journal");
    std::fs::create_dir_all(&jd).unwrap();
    std::fs::write(jd.join("messages.ndjson"), "{\"a\":1}\n").unwrap();
    let mut env = env_of("30", "5", "100", "true");
    env.insert("ANTIHALL_DEVSWARM_RETENTION_ARCHIVE_MAX_MB".into(), "0.00001".into());
    let (a, b) = (copy_home(&c, "node"), copy_home(&c, "engine"));
    node_sweep(&a, c.now, &env);
    let eres = engine_duty(&b, c.now, &env, &System::configured());
    assert_eq!(eres["outcome"], "ran", "{eres}");
    assert!(eres["detail"]["archiveCap"].is_object(), "the cap ran through Node's function: {eres}");
    assert!(eres["detail"]["store"]["legacy"].is_object(), "{eres}");
    let (da, db) = (mask(&dump(&a)), mask(&dump(&b)));
    if da != db
        && let Ok(d) = std::env::var("AH_TEST_DUMP_DIR")
    {
        std::fs::write(Path::new(&d).join("a.txt"), &da).unwrap();
        std::fs::write(Path::new(&d).join("b.txt"), &db).unwrap();
    }
    assert_eq!(da, db);
}

// ---- the first-run dry-run phase, the journal fold and the archive cap (lane l7d) -----------------------------------------------

fn extra(args: &[&str]) {
    let o = Command::new("node").arg(support("rt_extra.js")).args(args).output().unwrap();
    assert!(o.status.success(), "rt_extra {args:?}: {}", String::from_utf8_lossy(&o.stderr));
}

/// A corpus of several stores in one home: the main store, two more message stores and (optionally) split stores that still
/// hold their old journal. Every store is written by Node's own store code.
fn generate_multi(tag: &str, seed: u32, extra_stores: u32, split: u32) -> Corpus {
    ah_engine::defaults::init().unwrap();
    let c = generate(tag, seed, "small");
    for i in 0..extra_stores {
        let hash = format!("projx-{:06x}", 0xabc000 + i);
        let o = Command::new("node")
            .arg(support("rt_corpus.js"))
            .arg(&c.home)
            .arg(&hash)
            .arg((seed + 100 + i).to_string())
            .arg(c.now.to_string())
            .arg("small")
            .output()
            .unwrap();
        assert!(o.status.success(), "corpus: {}", String::from_utf8_lossy(&o.stderr));
    }
    for i in 0..split {
        let hash = format!("projfold-{:06x}", 0xf01d00 + i);
        let o = Command::new("node")
            .arg(support("rt_split.js"))
            .arg(&c.home)
            .arg(&hash)
            .arg((seed + 200 + i).to_string())
            .arg(c.now.to_string())
            .arg((3 + i).to_string())
            .arg(if i % 3 == 2 { "1" } else { "0" })
            .output()
            .unwrap();
        assert!(o.status.success(), "split: {}", String::from_utf8_lossy(&o.stderr));
    }
    c
}

/// Node's sweep and the engine's duty, `ticks` times each on their own copy, the same clock for each pair: everything retention
/// can touch (and the dry-run report) must be identical after EVERY tick. Returns the engine's results.
fn golden_ticks(c: &Corpus, env: &HashMap<String, String>, ticks: usize, witness: &dyn Runner) -> Vec<Value> {
    let (a, b) = (copy_home(c, "node-t"), copy_home(c, "engine-t"));
    let mut out = Vec::new();
    for i in 0..ticks {
        let now = c.now + (i as i64) * 1000;
        let nres = node_sweep(&a, now, env);
        let eres = engine_duty(&b, now, env, witness);
        assert!(eres["detail"].get("node").is_none(), "tick {i}: the engine must decide itself: {eres}");
        let (da, db) = (mask(&dump(&a)).replace(&*a.to_string_lossy(), "<h>"), mask(&dump(&b)).replace(&*b.to_string_lossy(), "<h>"));
        if da != db
            && let Ok(d) = std::env::var("AH_TEST_DUMP_DIR")
        {
            std::fs::write(Path::new(&d).join("a.txt"), &da).unwrap();
            std::fs::write(Path::new(&d).join("b.txt"), &db).unwrap();
        }
        assert_eq!(da, db, "tick {i}: the engine's store, archive, report, state or log differ from Node's\nnode: {nres}\nengine: {eres}");
        out.push(eres);
    }
    out
}

#[test]
fn the_first_run_dry_run_report_is_nodes_byte_for_byte() {
    if !have_node_sqlite() {
        return;
    }
    let mut reported = 0;
    for (seed, extra_stores, split) in [(60u32, 2u32, 0u32), (61, 0, 1), (62, 3, 3)] {
        let c = generate_multi(&format!("rt-dryph-{seed}"), seed, extra_stores, split);
        extra(&["dry-state", &c.home.to_string_lossy()]);
        let env = env_of("30", "5", "100", "true");
        let before = bodies(&c.home);
        let res = golden_ticks(&c, &env, 3, &System::configured());
        assert_eq!(res[0]["detail"]["phase"], "dry-run", "{}", res[0]);
        assert_eq!(res[0]["detail"]["remaining"], 0, "{}", res[0]);
        reported += res[0]["detail"]["reported"].as_i64().unwrap();
        // the report phase tombstones nothing; the armed ticks after it do
        let h = c.dir.join("engine-t");
        let after = bodies(&h);
        assert!(after.keys().eq(before.keys()), "a row was deleted");
    }
    assert!(reported >= 10, "{reported}");
}

#[test]
fn a_half_done_report_is_resumed_and_a_zero_budget_reports_nothing() {
    if !have_node_sqlite() {
        return;
    }
    let c = generate_multi("rt-dryres", 63, 2, 1);
    extra(&["dry-state", &c.home.to_string_lossy(), "withReport"]);
    let env = env_of("30", "5", "100", "true");
    let res = golden_ticks(&c, &env, 2, &System::configured());
    assert!(res[0]["detail"]["reported"].as_i64().unwrap() >= 1, "{}", res[0]);
    // a budget of 0 ms: Node reports nothing in the tick (its first store is already over budget after the clock moved), and so must the engine
    let mut zero = env.clone();
    zero.insert("ANTIHALL_DEVSWARM_RETENTION_BUDGET_MS".into(), "0".into());
    let (a, b) = (copy_home(&c, "node-z"), copy_home(&c, "engine-z"));
    let nres = node_sweep(&a, c.now, &zero);
    let eres = engine_duty(&b, c.now, &zero, &System::configured());
    assert_eq!(nres["phase"], "dry-run");
    // both are timing dependent only in how many stores fit; with a zero budget at most the stores handled before the first clock check
    assert!(eres["detail"]["reported"].as_i64().unwrap() <= nres["reported"].as_i64().unwrap() + 1, "{eres} vs {nres}");
}

#[test]
fn the_engine_dry_switch_reports_nothing_to_disk_in_the_first_run_phase() {
    if !have_node_sqlite() {
        return;
    }
    let c = generate_multi("rt-dryph-sw", 64, 1, 0);
    extra(&["dry-state", &c.home.to_string_lossy()]);
    let h = copy_home(&c, "sw");
    let mut env = env_of("30", "5", "100", "true");
    env.insert("ANTIHALL_DEVSWARM_SUP_DRYRUN_RETENTION".into(), "true".into());
    let out = engine_duty(&h, c.now, &env, &System::configured());
    assert_eq!(out["outcome"], "dry-run", "{out}");
    assert!(!h.join(".anti-hall/devswarm/retention-dry-run.json").exists());
    let (d0, d1) = (dump(&c.home), dump(&h));
    let diff: Vec<(&str, &str)> = d0.lines().zip(d1.lines()).filter(|(x, y)| x != y).collect();
    assert!(
        diff.is_empty() && d0.lines().count() == d1.lines().count(),
        "{:?}",
        diff.iter().map(|(x, y)| (&x[..x.len().min(200)], &y[..y.len().min(200)])).collect::<Vec<_>>()
    );
}

#[test]
fn a_witness_that_disagrees_in_the_report_phase_leaves_the_sweep_to_node() {
    if !have_node_sqlite() {
        return;
    }
    let c = generate_multi("rt-dryph-dis", 65, 1, 0);
    extra(&["dry-state", &c.home.to_string_lossy()]);
    let env = env_of("30", "5", "100", "true");
    let h = copy_home(&c, "dis");
    let r = rewriting(|mut v| {
        v["dry"]["overLimitProtected"] = serde_json::json!(true);
        v
    });
    let out = engine_duty(&h, c.now, &env, &r);
    assert!(out["node"].is_string(), "the sweep must go to Node: {out}");
    // what Node then wrote is Node's own report (its clock, not the test's), and no body changed
    assert!(h.join(".anti-hall/devswarm/retention-dry-run.json").exists());
    assert_eq!(bodies(&c.home), bodies(&h));
    let last = held_log(&h).into_iter().rev().find(|l| l["duty"] == "retention").unwrap();
    assert_eq!(last["match"], false, "{last}");
}

/// Runs everything for real except the answer of the Node snippet that contains `marker`, which `f` rewrites.
struct Alter<'a> {
    inner: System,
    marker: &'static str,
    f: Box<dyn Fn(Value) -> Value + 'a>,
    seen: Mutex<usize>,
    fail: bool,
}

impl Runner for Alter<'_> {
    fn run(&self, spec: &RunSpec) -> RunResult {
        if spec.args.get(1).is_some_and(|s| s.contains(self.marker)) {
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

fn alter<'a>(marker: &'static str, f: impl Fn(Value) -> Value + 'a) -> Alter<'a> {
    Alter { inner: System::configured(), marker, f: Box::new(f), seen: Mutex::new(0), fail: false }
}

fn no_node_for(marker: &'static str) -> Alter<'static> {
    Alter { inner: System::configured(), marker, f: Box::new(|v| v), seen: Mutex::new(0), fail: true }
}

/// Every file under `dir` (relative path -> size).
fn tree(dir: &Path) -> BTreeMap<String, u64> {
    let mut out = BTreeMap::new();
    let mut stack = vec![dir.to_path_buf()];
    while let Some(d) = stack.pop() {
        for e in std::fs::read_dir(&d).into_iter().flatten().flatten() {
            let p = e.path();
            if p.is_dir() {
                stack.push(p);
            } else {
                out.insert(p.strip_prefix(dir).unwrap().to_string_lossy().into_owned(), std::fs::metadata(&p).unwrap().len());
            }
        }
    }
    out
}

fn journals(home: &Path) -> BTreeMap<String, u64> {
    tree(&home.join(".anti-hall/devswarm/store")).into_iter().filter(|(k, _)| k.contains("/journal/")).collect()
}

#[test]
fn the_legacy_journal_fold_is_nodes_and_a_pending_merge_is_never_folded() {
    if !have_node_sqlite() {
        return;
    }
    let mut folded = 0;
    for seed in [70u32, 71] {
        let c = generate_multi(&format!("rt-fold-{seed}"), seed, 1, 3);
        let before = journals(&c.home);
        assert!(before.len() >= 9, "the fixture must leave several journal files: {before:?}");
        let env = env_of("30", "5", "100", "true");
        golden_ticks(&c, &env, 6, &System::configured());
        let after = journals(&c.dir.join("engine-t"));
        // the third split store's merge is pending (a message only the journal has): its journal is untouched, the others are folded
        let pending: BTreeMap<_, _> = before.iter().filter(|(k, _)| k.contains("projfold-f01d02")).collect();
        assert!(!pending.is_empty());
        assert!(pending.iter().all(|(k, v)| after.get(*k) == Some(*v)), "a journal whose merge is pending was touched");
        let gone = before.keys().filter(|k| !after.contains_key(*k)).count();
        assert!(gone >= 5, "{gone}");
        folded += gone;
        // every removed journal file is in the archive, byte for byte
        let arch = tree(&c.dir.join("engine-t/.anti-hall/devswarm/archive"));
        assert!(arch.keys().filter(|k| k.contains("legacy-journal")).count() >= gone, "{arch:?}");
    }
    assert!(folded >= 10);
}

#[test]
fn a_journal_is_folded_only_when_nodes_dry_run_names_the_same_files() {
    if !have_node_sqlite() {
        return;
    }
    let c = generate_multi("rt-fold-dis", 72, 0, 1);
    let env = env_of("30", "5", "100", "true");
    type Rewrite = Box<dyn Fn(Value) -> Value>;
    let cases: Vec<(&str, Rewrite)> = vec![
        (
            "a file missing",
            Box::new(|mut v| {
                v["files"].as_array_mut().unwrap().pop();
                v
            }),
        ),
        (
            "another destination",
            Box::new(|mut v| {
                v["files"][0]["dest"] = serde_json::json!("elsewhere/x.ndjson.gz");
                v
            }),
        ),
        (
            "another size",
            Box::new(|mut v| {
                v["files"][0]["bytes"] = serde_json::json!(1);
                v
            }),
        ),
        (
            "not eligible",
            Box::new(|mut v| {
                v["eligible"] = serde_json::json!(false);
                v["reason"] = serde_json::json!("merge-pending");
                v
            }),
        ),
    ];
    for (name, f) in cases {
        let h = copy_home(&c, &format!("fold-{}", name.replace(' ', "-")));
        let before = journals(&h);
        // the main store goes first (largest); sweep until the split store has had its turn
        let r = alter("foldLegacyJournal", f);
        for i in 0..2 {
            engine_duty(&h, c.now + i * 1000, &env, &r);
        }
        assert!(*r.seen.lock().unwrap() >= 1, "{name}: the fold never asked Node");
        assert_eq!(before, journals(&h), "{name}: a journal changed");
        assert!(!tree(&h.join(".anti-hall/devswarm")).keys().any(|k| k.contains("legacy-journal")), "{name}: an archive file was written");
    }
    // Node cannot run: nothing is folded either
    let h = copy_home(&c, "fold-nonode");
    let before = journals(&h);
    let r = no_node_for("foldLegacyJournal");
    for i in 0..2 {
        engine_duty(&h, c.now + i * 1000, &env, &r);
    }
    assert_eq!(before, journals(&h));
}

#[test]
fn a_journal_file_that_changed_after_it_was_read_is_kept_and_a_bad_archive_copy_is_dropped() {
    if !have_node_sqlite() {
        return;
    }
    ah_engine::defaults::init().unwrap();
    let c = generate_multi("rt-fold-late", 73, 0, 1);
    let h = copy_home(&c, "late");
    let hash = "projfold-f01d00";
    let items = ah_engine::dssup::retention::fold::items(&h, hash);
    assert!(items.len() >= 3, "{items:?}");
    // the journal grows after the plan was taken: that file's raw copy must stay (and its archive copy is kept too)
    let grown = &items[0];
    {
        use std::io::Write;
        let mut f = std::fs::OpenOptions::new().append(true).open(&grown.src).unwrap();
        writeln!(f, "{{\"late\":true}}").unwrap();
    }
    let r = ah_engine::dssup::retention::fold::run(&h, hash, &items);
    assert!(grown.src.exists(), "a journal file that grew was removed: {r}");
    assert!(r["files"][0]["error"].is_string(), "{r}");
    for it in &items[1..] {
        assert!(!it.src.exists(), "an unchanged file was not folded: {}", it.file);
        let gz = std::fs::read(&it.dest).unwrap();
        let raw = ah_engine::dssup::retention::gz::decompress(&gz).unwrap();
        assert!(raw.len() as u64 == it.bytes, "{}", it.file);
    }
    // the archive copy of the changed file holds everything that was read, never less than the file now has
    let gz = std::fs::read(&grown.dest).unwrap();
    assert_eq!(ah_engine::dssup::retention::gz::decompress(&gz).unwrap().len() as u64, std::fs::metadata(&grown.src).unwrap().len());
}

fn archive_home(tag: &str, seed: u32, n: u32) -> Corpus {
    let c = generate_multi(tag, seed, 1, 0);
    extra(&["archive", &c.home.to_string_lossy(), &seed.to_string(), &c.now.to_string(), &n.to_string()]);
    c
}

#[test]
fn the_archive_cap_evicts_what_node_evicts() {
    if !have_node_sqlite() {
        return;
    }
    let mut evicted = 0;
    for (seed, cap) in [(80u32, "0.004"), (81, "0.002"), (82, "0.00001"), (83, "5")] {
        let c = archive_home(&format!("rt-cap-{seed}"), seed, 30);
        let mut env = env_of("30", "5", "100", "true");
        env.insert("ANTIHALL_DEVSWARM_RETENTION_ARCHIVE_MAX_MB".into(), cap.into());
        let before = tree(&c.home.join(".anti-hall/devswarm/archive"));
        golden_ticks(&c, &env, 2, &System::configured());
        let after = tree(&c.dir.join("engine-t/.anti-hall/devswarm/archive"));
        evicted += before.keys().filter(|k| !after.contains_key(*k)).count();
        assert!(after.contains_key("README.txt"), "a file that is not an archive month was touched");
    }
    assert!(evicted >= 30, "{evicted}");
}

#[test]
fn an_archive_file_is_evicted_only_when_nodes_dry_run_names_the_same_list() {
    if !have_node_sqlite() {
        return;
    }
    let c = archive_home("rt-cap-dis", 84, 30);
    let mut env = env_of("30", "5", "100", "true");
    env.insert("ANTIHALL_DEVSWARM_RETENTION_ARCHIVE_MAX_MB".into(), "0.003".into());
    type Rewrite = Box<dyn Fn(Value) -> Value>;
    let cases: Vec<(&str, Rewrite)> = vec![
        (
            "one file fewer",
            Box::new(|mut v| {
                v["removed"].as_array_mut().unwrap().pop();
                v
            }),
        ),
        (
            "another order",
            Box::new(|mut v| {
                v["removed"].as_array_mut().unwrap().reverse();
                v
            }),
        ),
        (
            "another total",
            Box::new(|mut v| {
                v["totalBytes"] = serde_json::json!(v["totalBytes"].as_i64().unwrap() + 1);
                v
            }),
        ),
    ];
    for (name, f) in cases {
        let h = copy_home(&c, &format!("cap-{}", name.replace(' ', "-")));
        let before = tree(&h.join(".anti-hall/devswarm/archive"));
        let r = alter("enforceArchiveCap", f);
        engine_duty(&h, c.now, &env, &r);
        assert_eq!(*r.seen.lock().unwrap(), 1, "{name}");
        // the sweep adds its own archive months before the cap is looked at; nothing of the seeded files may be gone
        let after = tree(&h.join(".anti-hall/devswarm/archive"));
        assert!(before.keys().all(|k| after.contains_key(k)), "{name}: an archive file was evicted");
        let last = held_log(&h).into_iter().rev().find(|l| l["duty"] == "retention-cap").unwrap();
        assert_eq!(last["match"], false, "{name}: {last}");
    }
    let h = copy_home(&c, "cap-nonode");
    let before = tree(&h.join(".anti-hall/devswarm/archive"));
    let r = no_node_for("enforceArchiveCap");
    engine_duty(&h, c.now, &env, &r);
    let after = tree(&h.join(".anti-hall/devswarm/archive"));
    assert!(before.keys().all(|k| after.contains_key(k)));
}

#[test]
fn the_cap_plan_equals_nodes_for_random_archives_and_an_evicted_file_must_still_be_what_was_planned() {
    if !have_node_sqlite() {
        return;
    }
    ah_engine::defaults::init().unwrap();
    let mut rng = 0x1234_5678u32;
    let mut next = |n: u32| {
        rng = rng.wrapping_mul(1664525).wrapping_add(1013904223);
        (rng >> 8) % n
    };
    let mut checked = 0;
    for round in 0..30 {
        let t = ah_engine::db::TempDir::new(&format!("rt-capprop-{round}"));
        let home = std::fs::canonicalize(&t.0).unwrap().join("h");
        std::fs::create_dir_all(home.join(".anti-hall/devswarm/store/aa-000001")).unwrap();
        extra(&["archive", &home.to_string_lossy(), &(900 + round).to_string(), &ah_engine::health::now_ms().to_string(), &(5 + next(40)).to_string()]);
        let total: u64 = tree(&home.join(".anti-hall/devswarm/archive")).values().sum();
        let cap_mb = (total as f64 * (next(120) as f64 / 100.0)) / 1_048_576.0;
        let mut env = env_of("30", "5", "100", "true");
        env.insert("ANTIHALL_DEVSWARM_RETENTION_ARCHIVE_MAX_MB".into(), format!("{cap_mb}"));
        let st = settings(&home, &env);
        let root = ah_engine::defaults::root().unwrap();
        let ctx = Ctx { home: &home, root: &root, st: &st, now: ah_engine::health::now_ms() as i64, engine_pokes: true };
        let s = ah_engine::dssup::retention::read_settings(&ctx);
        let mine = ah_engine::dssup::retention::cap::plan(&home, &s);
        let o = Command::new("node")
            .args(["-e", "const R=require(process.argv[1]+'/companion/lib/devswarm-retention.js');process.stdout.write(JSON.stringify(R.enforceArchiveCap({home:process.argv[2],settings:JSON.parse(process.argv[3]),dryRun:true})))"])
            .arg(&root)
            .arg(&home)
            .arg(serde_json::json!({"archiveMaxMB": s.archive_max_mb, "days": s.days}).to_string())
            .output()
            .unwrap();
        let node: Value = serde_json::from_slice(&o.stdout).unwrap();
        assert!(ah_engine::dssup::retention::cap::same(&mine, &node), "round {round}: engine {} vs node {node}", mine.json(true));
        // the invariants of the cap, on the engine's plan: what is left fits, or everything is gone; and it is the oldest months that go
        if let Some(after) = mine.after {
            assert!(after as f64 <= mine.cap || mine.files.len() == tree(&home.join(".anti-hall/devswarm/archive")).len() - 1, "round {round}");
            let keys: Vec<&String> = mine.files.iter().map(|f| &f.sort_key).collect();
            assert!(keys.windows(2).all(|w| w[0] <= w[1]), "not oldest first: {keys:?}");
        } else {
            assert!(mine.removed.is_empty());
        }
        // a file replaced after the plan (another size) is not evicted
        if let Some(f) = mine.files.first() {
            std::fs::write(&f.path, vec![b'x'; f.bytes as usize + 7]).unwrap();
            let done = ah_engine::dssup::retention::cap::evict(&home, &mine);
            assert!(f.path.exists() && !done.iter().any(|(r, _)| *r == f.rel), "round {round}: a changed file was evicted");
        }
        checked += 1;
    }
    assert_eq!(checked, 30);
}
