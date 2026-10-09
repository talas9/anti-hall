//! The reconcile port, slice S0 (the harness): stub hivecontrol, snapshot tool, mirrors, normaliser and the witness gate.
//!
//! Every case builds a scratch home, plans with the engine, and runs the witness gate: Node's function on one mirror, the engine's
//! op list on another, byte-compared, then applied to the real (scratch) home. A case passes only when the gate agrees (or the
//! engine defers for a stated reason before writing). Each test prints a `PARITY` line: cases / identical / deferred.
//! Crash tests kill a child process with SIGKILL at every op boundary and then let Node's next sweep converge.
#![allow(clippy::unwrap_used, clippy::expect_used)] // a test crate: a panic is the failure report

use ah_engine::checks::git::util::Settings;
use ah_engine::dsact::runner::{RunResult, RunSpec, Runner, System};
use ah_engine::dssup::recon::gate::{self, Job, Verdict};
use ah_engine::dssup::recon::{Hooks, Op, Unit, UnitEnd, apply, norm};
use ah_engine::dssup::tick::Ctx;
use ah_engine::meshw::store::{MeshStore, RegistryRow};
use serde_json::Value;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Command;

const NOW: i64 = 1_760_000_000_000;

fn have(bin: &str) -> bool {
    Command::new(bin).arg("--version").output().is_ok_and(|o| o.status.success())
}

struct Fix {
    home: PathBuf,
    st: Settings,
    root: PathBuf,
}

fn init_defaults() {
    static ONCE: std::sync::Once = std::sync::Once::new();
    ONCE.call_once(|| {
        // SAFETY: set once, before this process reads the defaults; nothing else here touches this variable
        unsafe { std::env::set_var("AH_ENGINE_PLUGIN_ROOT", Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap().join("plugins/anti-hall")) };
        ah_engine::defaults::init().expect("defaults load");
    });
}

fn fix(tag: &str) -> Fix {
    init_defaults();
    static N: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let home = PathBuf::from(std::env::var("HOME").unwrap()).join(".anti-hall/work/recon-tests").join(format!("recon-{tag}-{}-{}", std::process::id(), N.fetch_add(1, std::sync::atomic::Ordering::SeqCst)));
    let _ = std::fs::remove_dir_all(&home);
    std::fs::create_dir_all(&home).unwrap();
    let mut env: HashMap<String, String> = HashMap::new();
    env.insert("HOME".into(), home.to_string_lossy().into_owned());
    let st = Settings { home: home.to_string_lossy().into_owned(), env };
    Fix { home, st, root: ah_engine::defaults::root().unwrap() }
}

impl Fix {
    fn ctx(&self) -> Ctx<'_> {
        Ctx { home: &self.home, root: &self.root, st: &self.st, now: NOW, engine_pokes: false }
    }
    #[allow(dead_code)]
    fn put(&self, rel: &str, text: &str) {
        let p = self.home.join(rel);
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(p, text).unwrap();
    }
    fn read(&self, rel: &str) -> Option<String> {
        std::fs::read_to_string(self.home.join(rel)).ok()
    }
    fn ds(&self, rel: &str) -> String {
        format!(".anti-hall/devswarm/{rel}")
    }
    /// A real git repository under the home; returns its path.
    fn repo(&self, name: &str) -> String {
        let p = self.home.join("repos").join(name);
        std::fs::create_dir_all(&p).unwrap();
        assert!(Command::new("git").args(["init", "-q"]).current_dir(&p).status().unwrap().success());
        std::fs::canonicalize(&p).unwrap().to_string_lossy().into_owned()
    }
    fn key_of(&self, wt: &str) -> String {
        ah_engine::meshw::ident::repo_key_for_worktree(wt).unwrap().unwrap()
    }
    fn store(&self, key: &str) -> MeshStore {
        let dir = self.home.join(self.ds(&format!("store/{key}")));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("BACKEND"), "sqlite\n").unwrap();
        MeshStore::open(&dir.join("devswarm.db")).unwrap()
    }
    fn row(&self, key: &str, id: &str, wt: &str, sid: &str) {
        let st = self.store(key);
        let r = RegistryRow { id: id.into(), worktree_path: Some(wt.into()), session_id: Some(sid.into()), inbox_path: None, cursor_path: None, nudge_command: Some("[\"a\",\"b\"]".into()) };
        assert!(st.upsert_registry(&r, 1_000, |_, _| true).unwrap());
    }
    fn descriptor(&self, id: &str, json: &str) {
        self.put(&format!("{}/workspaces/{id}.json", self.ds("")).replace("//", "/"), json);
    }
    fn snapshot(&self) -> std::collections::BTreeMap<String, String> {
        let mut m = norm::dump(&self.home);
        m.retain(|k, _| !k.starts_with(".anti-hall/logs/devswarm-recon-witness"));
        m
    }
}

/// A one-unit job that writes `text` to `rel` and has Node run the sweep-state call (the gate is exercised end to end with a
/// real Node function; the planners of the later slices build the same shape).
fn write_job(f: &Fix, rel: &str, text: &str) -> Job {
    let pre = ah_engine::dssup::recon::view::pre_of(&f.home, rel);
    Job {
        label: "s0".into(),
        scope: ah_engine::dssup::recon::Scope { files: vec![rel.to_string()], dirs: vec![], stores: vec![] },
        units: vec![Unit { label: "s0".into(), lock: None, ops: vec![Op::Write { rel: rel.into(), bytes: text.as_bytes().to_vec(), pre }] }],
        calls: vec![serde_json::json!({"fn": "sweepState", "args": {"lastRunAt": NOW}})],
        expect: vec![Some(Value::Null)],
    }
}

/// Run a job through the gate and require agreement and application.
fn agreed(f: &Fix, job: &Job) -> Vec<UnitEnd> {
    let out = gate::run(&f.ctx(), &System::configured(), job, &Hooks::none());
    assert_eq!(out.verdict, Verdict::Agreed, "{}: {:?}", job.label, out.verdict);
    for e in &out.ends {
        assert_eq!(*e, UnitEnd::Applied, "{}", job.label);
    }
    out.ends
}

/// A private copy of the stub with its settings in a `stub.conf` beside it (no process-wide environment).
fn stub_with(f: &Fix, conf: &str) -> PathBuf {
    let dir = f.home.join("stub-bin");
    std::fs::create_dir_all(&dir).unwrap();
    let to = dir.join("hivecontrol");
    std::fs::copy(Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/recon_support/hivecontrol"), &to).unwrap();
    std::fs::write(dir.join("stub.conf"), conf).unwrap();
    to
}

// ---------------------------------------------------------------- S0: the harness itself

#[test]
fn the_hivecontrol_stub_replays_forbids_and_dies_mid_read() {
    let dir = fix("stub");
    let stub = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/recon_support/hivecontrol");
    let fx = dir.home.join("fx");
    std::fs::create_dir_all(&fx).unwrap();
    std::fs::write(fx.join("workspace_info_w1.out"), "{\"terminalId\":\"t1\"}").unwrap();
    std::fs::write(fx.join("read-messages_w1.out"), "0123456789").unwrap();
    let log = dir.home.join("stub.log");
    let run = |args: &[&str], envs: &[(&str, &str)]| {
        let mut c = Command::new(&stub);
        c.args(args).env("HC_STUB_DIR", &fx).env("HC_STUB_LOG", &log);
        for (k, v) in envs {
            c.env(k, v);
        }
        c.output().unwrap()
    };
    assert_eq!(String::from_utf8_lossy(&run(&["workspace", "info", "w1"], &[]).stdout), "{\"terminalId\":\"t1\"}");
    let forbidden = run(&["read-messages", "w1"], &[("HC_STUB_FORBID", "read-messages")]);
    assert_eq!(forbidden.status.code(), Some(99));
    assert!(std::fs::read_to_string(&log).unwrap().contains("VIOLATION read-messages w1"));
    use std::os::unix::process::ExitStatusExt;
    let died = run(&["read-messages", "w1"], &[("HC_STUB_DIE_MID", "read-messages")]);
    assert_eq!(died.status.signal(), Some(9), "the stub SIGKILLs itself mid-reply");
    assert_eq!(String::from_utf8_lossy(&died.stdout), "01234", "half of the recorded reply was printed");
}

#[test]
fn the_snapshot_tool_backs_up_and_anonymises_with_nodes_own_hashes() {
    if !have("node") {
        return;
    }
    let src = fix("snap-src");
    let wt = src.repo("p");
    let key = src.key_of(&wt);
    let st = src.store(&key);
    st.append_message("w1", 5, Some("native:old1"), "[forwarded from archived abc] secret body").unwrap();
    st.append_message("w1", 6, Some("native:old2"), "secret body").unwrap();
    drop(st);
    let dst = fix("snap-dst");
    let tool = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/recon_support/snapshot.js");
    let o = Command::new("node").arg(&tool).arg(&src.root).arg(&src.home).arg(&dst.home).arg("--anonymise").output().unwrap();
    assert!(o.status.success(), "{}", String::from_utf8_lossy(&o.stderr));
    let db = dst.home.join(dst.ds(&format!("store/{key}/devswarm.db")));
    let c = rusqlite::Connection::open(db).unwrap();
    let rows: Vec<(String, String)> = c.prepare("SELECT body, hash FROM messages ORDER BY id").unwrap().query_map([], |r| Ok((r.get(0)?, r.get(1)?))).unwrap().flatten().collect();
    assert_eq!(rows.len(), 2);
    assert!(rows[0].0.starts_with("[forwarded from archived abc] anon-"), "prefix kept: {}", rows[0].0);
    assert!(!rows[0].0.contains("secret") && !rows[1].0.contains("secret"));
    // the hash is Node's messageHash of the anonymised body (re-derived here by Node itself)
    let code = "const i=require(process.argv[1]+'/companion/devswarm-ingest.js');console.log(i.messageHash('w1',{message:process.argv[2],createdAt:'6'}))";
    let want = Command::new("node").args(["-e", code, src.root.to_str().unwrap(), &rows[1].0]).output().unwrap();
    assert_eq!(rows[1].1, String::from_utf8_lossy(&want.stdout).trim());
}

// ---------------------------------------------------------------- the gate

#[test]
fn the_gate_applies_only_what_node_reproduces() {
    if !have("node") {
        return;
    }
    let f = fix("s0gate");
    let rel = f.ds("reconcile-sweep-state.json");
    let job = write_job(&f, &rel, &format!("{{\"lastRunAt\":{NOW}}}"));
    let ends = agreed(&f, &job);
    assert_eq!(ends, vec![UnitEnd::Applied]);
    assert_eq!(f.read(&rel).unwrap(), format!("{{\"lastRunAt\":{NOW}}}"));
    // the engine's bytes differ from Node's: the post-states differ, nothing reaches the real home
    let f = fix("s0gate2");
    let job = write_job(&f, &rel, "{\"lastRunAt\":1}");
    let out = gate::run(&f.ctx(), &System::configured(), &job, &Hooks::none());
    assert!(matches!(out.verdict, Verdict::Mismatch(_)), "{:?}", out.verdict);
    assert!(matches!(&out.ends[0], UnitEnd::Deferred(w) if w == "witness-mismatch"));
    assert!(f.read(&rel).is_none());
}

struct Lying;
impl Runner for Lying {
    fn run(&self, _: &RunSpec) -> RunResult {
        RunResult { ok: true, status: Some(0), stdout: "[7]\n".into(), ..Default::default() }
    }
}
struct Absent;
impl Runner for Absent {
    fn run(&self, _: &RunSpec) -> RunResult {
        RunResult { ok: false, missing: true, error: Some("no node".into()), ..Default::default() }
    }
}

#[test]
fn a_disagreeing_or_absent_witness_writes_nothing() {
    let f = fix("s0gate3");
    let rel = f.ds("reconcile-sweep-state.json");
    let job = write_job(&f, &rel, &format!("{{\"lastRunAt\":{NOW}}}"));
    let out = gate::run(&f.ctx(), &Lying, &job, &Hooks::none());
    assert!(matches!(out.verdict, Verdict::Mismatch(_)), "{:?}", out.verdict);
    assert!(f.read(&rel).is_none());
    let out = gate::run(&f.ctx(), &Absent, &job, &Hooks::none());
    assert!(matches!(out.verdict, Verdict::NodeUnavailable(_)));
    assert!(matches!(&out.ends[0], UnitEnd::Deferred(w) if w == "node-unavailable"));
    assert!(f.read(&rel).is_none());
}

#[test]
fn a_drifted_precondition_or_a_busy_lock_defers_the_unit_untouched() {
    let f = fix("s0drift");
    let rel = f.ds("x.json");
    f.put(&rel, "one");
    let job = write_job(&f, &rel, "two");
    f.put(&rel, "changed in between");
    let before = norm::dump(&f.home);
    let env = apply::Env { home: &f.home, now: NOW, st: &f.st, log_dir: None };
    let end = apply::unit(&env, &job.units[0], &Hooks::none());
    assert!(matches!(&end, UnitEnd::Deferred(w) if w.starts_with("drift:")), "{end:?}");
    assert_eq!(norm::dump(&f.home), before);
    let _held = ah_engine::meshw::idlock::acquire(&f.home, "ws-1").unwrap();
    let mut u = job.units[0].clone();
    u.lock = Some("ws-1".into());
    assert_eq!(apply::unit(&env, &u, &Hooks::none()), UnitEnd::Deferred("lock-busy".into()));
}

#[test]
fn a_sigkill_between_two_ops_leaves_every_file_whole() {
    // a unit of two atomic writes killed at each boundary: each target is the old file or the new one, never a torn one
    for point in ["u:0:before", "u:0:after", "u:1:before", "u:1:after"] {
        let f = fix("s0crash");
        f.put("a.json", "old-a");
        let ops = vec![
            Op::Write { rel: "a.json".into(), bytes: b"new-a".to_vec(), pre: ah_engine::dssup::recon::Pre::Any },
            Op::Write { rel: "b.json".into(), bytes: b"new-b".to_vec(), pre: ah_engine::dssup::recon::Pre::Any },
        ];
        let o = Command::new(std::env::current_exe().unwrap())
            .args(["--exact", "crash_child", "--nocapture", "--test-threads=1"])
            .env("RECON_CRASH_HOME", &f.home)
            .env("RECON_CRASH_AT", point)
            .output()
            .unwrap();
        let _ = &ops;
        use std::os::unix::process::ExitStatusExt;
        assert_eq!(o.status.signal(), Some(9), "{point}");
        let a = f.read("a.json").unwrap();
        assert!(a == "old-a" || a == "new-a", "{point}: a.json is whole: {a}");
        if let Some(b) = f.read("b.json") {
            assert_eq!(b, "new-b", "{point}");
        }
    }
}

#[test]
fn crash_child() {
    let (Ok(home), Ok(at)) = (std::env::var("RECON_CRASH_HOME"), std::env::var("RECON_CRASH_AT")) else { return };
    init_defaults();
    let home = PathBuf::from(home);
    let mut env: HashMap<String, String> = HashMap::new();
    env.insert("HOME".into(), home.to_string_lossy().into_owned());
    let st = Settings { home: home.to_string_lossy().into_owned(), env };
    let ops = vec![
        Op::Write { rel: "a.json".into(), bytes: b"new-a".to_vec(), pre: ah_engine::dssup::recon::Pre::Any },
        Op::Write { rel: "b.json".into(), bytes: b"new-b".to_vec(), pre: ah_engine::dssup::recon::Pre::Any },
    ];
    let hook = move |name: &str| {
        if name == at {
            // SAFETY: SIGKILL of this very process, the point of the crash test
            unsafe { libc::kill(libc::getpid(), libc::SIGKILL) };
        }
    };
    let env = apply::Env { home: &home, now: NOW, st: &st, log_dir: None };
    let _ = apply::run(&env, "u", &ops, &Hooks { at: &hook });
}

// ---------------------------------------------------------------- the static guard

#[test]
fn no_message_row_is_deleted_or_updated() {
    let re = regex::Regex::new(r"(?i)(delete\s+from\s+messages|update\s+messages|drop\s+table\s+messages)").unwrap();
    let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("src/dssup/recon");
    let mut checked = 0;
    for e in std::fs::read_dir(&dir).unwrap().flatten() {
        let text = std::fs::read_to_string(e.path()).unwrap();
        assert!(!re.is_match(&text), "{} modifies message rows", e.path().display());
        checked += 1;
    }
    assert!(checked >= 6);
    // the SQL the ported modules use lives in sql.rs under the RECON_ prefix
    let sql = std::fs::read_to_string(Path::new(env!("CARGO_MANIFEST_DIR")).join("src/sql.rs")).unwrap();
    for line in sql.lines().filter(|l| l.contains("pub const RECON_")) {
        assert!(!re.is_match(line), "{line}");
    }
    // and no op of the vocabulary can address a message row
    let ops = std::fs::read_to_string(dir.join("mod.rs")).unwrap();
    assert!(!ops.contains("Message"));
}
