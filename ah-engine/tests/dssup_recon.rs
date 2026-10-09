//! The reconcile port, slices S0 to S2 and S6, against Node's own functions.
//!
//! Every case builds a scratch home, plans with the engine, and runs the witness gate: Node's function on one mirror, the engine's
//! op list on another, byte-compared, then applied to the real (scratch) home. A case passes only when the gate agrees (or the
//! engine defers for a stated reason before writing). Each test prints a `PARITY` line: cases / identical / deferred.
//! Crash tests kill a child process with SIGKILL at every op boundary and then let Node's next sweep converge.
#![allow(clippy::unwrap_used, clippy::expect_used)] // a test crate: a panic is the failure report

use ah_engine::checks::git::util::Settings;
use ah_engine::checks::guardkit::ojson::OVal;
use ah_engine::dsact::runner::{RunResult, RunSpec, Runner, System};
use ah_engine::dssup::recon::gate::{self, Job, Verdict};
use ah_engine::dssup::recon::{Hooks, Op, UnitEnd, apply, archived, dup, fold, heal, norm, orphans, side};
use ah_engine::dssup::tick::Ctx;
use ah_engine::meshw::store::{CursorPut, MeshRow, MeshStore, RegistryRow};
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
    /// A linked worktree of `repo` named `name` (the repository gets an empty commit first); returns its real path.
    fn linked(&self, repo: &str, name: &str) -> String {
        let git = |args: &[&str], dir: &str| {
            assert!(Command::new("git").args(["-c", "user.name=t", "-c", "user.email=t@t"]).args(args).current_dir(dir).output().unwrap().status.success(), "git {args:?}");
        };
        if !Command::new("git").args(["rev-parse", "--verify", "-q", "HEAD"]).current_dir(repo).output().unwrap().status.success() {
            git(&["commit", "--allow-empty", "-q", "-m", "i"], repo);
        }
        let to = self.home.join("repos").join(name);
        git(&["worktree", "add", "-q", "-b", name, to.to_str().unwrap()], repo);
        std::fs::canonicalize(&to).unwrap().to_string_lossy().into_owned()
    }
    /// A message in `id`'s partition (the id is an orphan when it has no registry row).
    fn msg(&self, key: &str, id: &str) {
        self.store(key).append_message(id, 5, Some(&format!("h-{id}")), "body").unwrap();
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

fn job_for(label: &str, planned: Vec<side::Planned>, extra: &[String]) -> Job {
    let mut files: Vec<String> = extra.to_vec();
    for p in &planned {
        files.extend(side::touched(&p.unit));
    }
    Job {
        label: label.into(),
        scope: side::scope_for(&files),
        calls: planned.iter().map(|p| p.call.clone()).collect(),
        expect: planned.iter().map(|p| Some(p.expect.clone())).collect(),
        units: planned.into_iter().map(|p| p.unit).collect(),
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

struct Tally(&'static str, std::cell::Cell<u32>, std::cell::Cell<u32>, std::cell::Cell<u32>);
impl Tally {
    fn new(s: &'static str) -> Tally {
        Tally(s, 0.into(), 0.into(), 0.into())
    }
    fn case(&self, identical: bool) {
        self.1.set(self.1.get() + 1);
        if identical {
            self.2.set(self.2.get() + 1);
        } else {
            self.3.set(self.3.get() + 1);
        }
    }
    fn print(&self) {
        println!("PARITY {} cases={} identical={} deferred={}", self.0, self.1.get(), self.2.get(), self.3.get());
    }
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

// ---------------------------------------------------------------- S1: side files

#[test]
fn s1_sweep_state_resume_and_names_match_node() {
    if !have("node") {
        return;
    }
    let t = Tally::new("S1.state-resume-names");
    // sweep state
    let f = fix("s1a");
    agreed(&f, &job_for("sweep", vec![side::plan_sweep_state(&f.home, NOW)], &[]));
    assert_eq!(f.read(&f.ds("reconcile-sweep-state.json")).unwrap(), format!("{{\"lastRunAt\":{NOW}}}"));
    assert_eq!(side::read_sweep_state(&f.home), NOW as f64);
    t.case(true);
    // resume: write, overwrite, drain (unlink), drain with nothing there, torn marker
    let f = fix("s1b");
    let ids = vec!["a1".to_string(), "b2".to_string()];
    agreed(&f, &job_for("resume", vec![side::plan_resume(&f.home, "repo-1", &ids, NOW)], &[]));
    assert_eq!(f.read(&f.ds("reconcile-resume.json")).unwrap(), format!("{{\"repoKey\":\"repo-1\",\"ids\":[\"a1\",\"b2\"],\"ts\":{NOW}}}"));
    assert_eq!(side::read_resume(&f.home, "repo-1"), ids);
    assert!(side::read_resume(&f.home, "other").is_empty());
    t.case(true);
    agreed(&f, &job_for("resume2", vec![side::plan_resume(&f.home, "repo-1", &["z9".to_string()], NOW)], &[]));
    t.case(true);
    agreed(&f, &job_for("drain", vec![side::plan_resume(&f.home, "repo-1", &[], NOW)], &[]));
    assert!(f.read(&f.ds("reconcile-resume.json")).is_none());
    t.case(true);
    agreed(&f, &job_for("drain-none", vec![side::plan_resume(&f.home, "repo-1", &[], NOW)], &[]));
    t.case(true);
    f.put(&f.ds("reconcile-resume.json"), "{\"repoKey\":\"repo-1\",\"ids\":[\"a");
    assert!(side::read_resume(&f.home, "repo-1").is_empty(), "a torn marker reads as nothing deferred");
    agreed(&f, &job_for("resume-over-torn", vec![side::plan_resume(&f.home, "repo-1", &ids, NOW)], &[]));
    t.case(true);
    // names
    let f = fix("s1c");
    agreed(&f, &job_for("name", vec![side::plan_name(&f.home, "ws-1", "My title \u{1F600}", NOW)], &[]));
    assert_eq!(f.read(&f.ds("names/ws-1.json")).unwrap(), format!("{{\"name\":\"My title \u{1F600}\",\"updatedAt\":{NOW}}}"));
    t.case(true);
    agreed(&f, &job_for("name-unsafe", vec![side::plan_name(&f.home, "../x", "n", NOW)], &[]));
    agreed(&f, &job_for("name-empty", vec![side::plan_name(&f.home, "ws-2", "", NOW)], &[]));
    assert!(f.read(&f.ds("names/ws-2.json")).is_none());
    t.case(true);
    t.case(true);
    t.print();
}

#[test]
fn s1_repo_unknown_matches_node() {
    if !have("node") {
        return;
    }
    let t = Tally::new("S1.repo-unknown");
    let f = fix("s1d");
    let rel = f.ds("repo-unknown.json");
    for (i, reason) in ["Repository not found.", "Repository not found.", "Repository not found.", "\u{1b}[31m  other error \u{1b}[0m"].iter().enumerate() {
        let now = NOW + i as i64;
        let p = side::plan_repo_unknown_record(&f.home, "rk", "list", reason, now).unwrap();
        let job = job_for("ru", vec![p], &[]);
        let mut j = job;
        j.scope.files.push(rel.clone());
        let out = gate::run(&Ctx { now, ..f.ctx() }, &System::configured(), &j, &Hooks::none());
        assert_eq!(out.verdict, Verdict::Agreed, "{reason}");
        t.case(true);
    }
    assert!(!side::repo_unknown_suppressed(&f.home, "rk", "list", NOW + 10), "a different error restarted the streak");
    // suppression after three in a row, recheck after the window
    for i in 0..3 {
        let now = NOW + 100 + i;
        let p = side::plan_repo_unknown_record(&f.home, "rk2", "list", "Repository not found.", now).unwrap();
        let mut j = job_for("ru", vec![p], &[]);
        j.scope.files.push(rel.clone());
        assert_eq!(gate::run(&Ctx { now, ..f.ctx() }, &System::configured(), &j, &Hooks::none()).verdict, Verdict::Agreed);
        t.case(true);
    }
    assert!(side::repo_unknown_suppressed(&f.home, "rk2", "list", NOW + 200));
    assert!(!side::repo_unknown_suppressed(&f.home, "rk2", "list", NOW + 100 + 7 * 3_600_000));
    // clear: present, absent
    let mut j = job_for("clear", vec![side::plan_repo_unknown_clear(&f.home, "rk2", "list")], &[]);
    j.scope.files.push(rel.clone());
    agreed(&f, &j);
    let mut j = job_for("clear-none", vec![side::plan_repo_unknown_clear(&f.home, "nope", "list")], &[]);
    j.scope.files.push(rel.clone());
    agreed(&f, &j);
    t.case(true);
    t.case(true);
    // torn marker reads as empty and is replaced
    f.put(&rel, "{\"version\":1,\"scopes\":{\"x");
    let p = side::plan_repo_unknown_record(&f.home, "rk3", "list", "Repository not found.", NOW).unwrap();
    let mut j = job_for("ru-torn", vec![p], &[]);
    j.scope.files.push(rel);
    agreed(&f, &j);
    t.case(true);
    // a cut through a surrogate pair is the engine's deferral, not a guess
    let long = format!("{}{}", "a".repeat(299), "\u{1F600}");
    assert!(side::plan_repo_unknown_record(&f.home, "rk4", "list", &long, NOW).is_err());
    t.case(false);
    t.print();
}

#[test]
fn s1_active_cache_matches_node_including_the_floor_guard() {
    if !have("node") {
        return;
    }
    let t = Tally::new("S1.active-cache");
    let f = fix("s1e");
    let wt = f.repo("w");
    let recs = |n: usize| OVal::Arr((0..n).map(|i| OVal::Obj(vec![("id".into(), OVal::Str(format!("id{i}"))), ("worktreePath".into(), OVal::Str(wt.clone())), ("repositoryId".into(), OVal::Str("r1".into()))])).collect());
    let floor = side::active_floor_pct(&f.st);
    assert_eq!(floor, 50.0);
    let rel = side::active_rel();
    // first snapshot
    let p = side::plan_active_cache(&f.home, &[("rk".into(), recs(10))], NOW, floor).unwrap();
    let mut j = job_for("ac1", vec![p], &[]);
    j.scope.files.push(rel.clone());
    agreed(&f, &j);
    t.case(true);
    // a partial list (2 of 10) keeps the previous snapshot and logs the guard
    let p = side::plan_active_cache(&f.home, &[("rk".into(), recs(2))], NOW + 1, floor).unwrap();
    assert!(p.unit.ops.iter().any(|o| matches!(o, Op::Log { .. })));
    let mut j = job_for("ac2", vec![p], &[]);
    j.scope.files.push(rel.clone());
    agreed(&f, &j);
    assert!(f.read(&rel).unwrap().contains("\"id9\""), "the previous ten records were kept");
    t.case(true);
    // floor off: the short list replaces it
    let p = side::plan_active_cache(&f.home, &[("rk".into(), recs(2))], NOW + 2, 0.0).unwrap();
    let mut j = job_for("ac3", vec![p], &[]);
    j.scope.files.push(rel.clone());
    j.calls = vec![serde_json::json!({"fn": "activeCache", "args": {"byRepoKey": {"rk": serde_json::from_str::<Value>(&recs(2).stringify()).unwrap()}, "now": NOW + 2, "floorPct": 0}})];
    agreed(&f, &j);
    assert!(!f.read(&rel).unwrap().contains("\"id9\""));
    t.case(true);
    // an empty answer writes nothing and returns null
    let p = side::plan_active_cache(&f.home, &[("rk".into(), OVal::Arr(vec![]))], NOW + 3, floor).unwrap();
    assert!(p.unit.ops.is_empty());
    let mut j = job_for("ac4", vec![p], &[]);
    j.scope.files.push(rel.clone());
    agreed(&f, &j);
    t.case(true);
    // a second project, a relative worktree (deferred)
    let p = side::plan_active_cache(&f.home, &[("rk".into(), recs(2)), ("rk2".into(), recs(1))], NOW + 4, 0.0).unwrap();
    let mut j = job_for("ac5", vec![p], &[]);
    j.scope.files.push(rel);
    j.calls = vec![serde_json::json!({"fn": "activeCache", "args": {"byRepoKey": {"rk": serde_json::from_str::<Value>(&recs(2).stringify()).unwrap(), "rk2": serde_json::from_str::<Value>(&recs(1).stringify()).unwrap()}, "now": NOW + 4, "floorPct": 0}})];
    agreed(&f, &j);
    t.case(true);
    let rel_wt = OVal::Arr(vec![OVal::Obj(vec![("id".into(), OVal::Str("i".into())), ("worktreePath".into(), OVal::Str("relative/p".into()))])]);
    assert!(side::plan_active_cache(&f.home, &[("rk".into(), rel_wt)], NOW, floor).is_err());
    t.case(false);
    t.print();
}

#[test]
fn s1_startup_sampling_matches_node_and_never_calls_read_messages() {
    if !have("node") {
        return;
    }
    let t = Tally::new("S1.sampling");
    let f = fix("s1f");
    let fx = f.home.join("fx");
    std::fs::create_dir_all(&fx).unwrap();
    let log = f.home.join("stub.log");
    let stub = stub_with(&f, &format!("HC_STUB_DIR={}\nHC_STUB_LOG={}\nHC_STUB_FORBID=read-messages\n", fx.display(), log.display()));
    let runner = System { hc: stub.to_string_lossy().into_owned() };
    for (id, verdict) in [("w1", "{\"status\":\"stale\"}"), ("w2", "{\"notDraining\":true}"), ("w3", "{\"status\":\"live\"}"), ("w4", "{\"status\":\"stale\"}")] {
        f.put(&f.ds(&format!("liveness/{id}.json")), verdict);
    }
    std::fs::write(fx.join("workspace_info_w1.out"), "{\"terminalId\":\"t1\",\"startup\":null}").unwrap();
    std::fs::write(fx.join("workspace_info_w2.out"), "{\"startup\":{\"phase\":\"booting\"}}").unwrap();
    std::fs::write(fx.join("workspace_info_w4.out"), "not json").unwrap();
    let ids: Vec<String> = ["w1", "w2", "w3", "w4", "bad id"].iter().map(|s| s.to_string()).collect();
    for round in 0..3 {
        let cands = side::sampling_candidates(&f.home, &ids, 8);
        assert_eq!(cands, vec!["w1", "w2", "w4"]);
        let probes: Vec<(String, side::Probe)> = cands.iter().map(|c| (c.clone(), side::probe(&runner, c))).collect();
        let p = side::plan_sampling(&f.home, &ids, 8, &probes, NOW + round).unwrap();
        let mut j = job_for("sampling", vec![p], &ids.iter().map(|i| format!(".anti-hall/devswarm/liveness/{i}.json")).collect::<Vec<_>>());
        j.scope.files.push(side::sampling_state_rel());
        j.scope.files.push(side::samples_rel());
        let out = gate::run(&Ctx { now: NOW + round, ..f.ctx() }, &System::configured(), &j, &Hooks::none());
        assert_eq!(out.verdict, Verdict::Agreed, "round {round}");
        t.case(true);
        if round == 0 {
            // terminalId changes on the next round
            std::fs::write(fx.join("workspace_info_w1.out"), "{\"terminalId\":\"t2\"}").unwrap();
        }
    }
    let samples = f.read(&side::samples_rel()).unwrap();
    assert_eq!(samples.lines().count(), 5, "w1 first terminal id and its change, w2 startup each round: {samples}");
    // a candidate list capped by maxProbe
    assert_eq!(side::sampling_candidates(&f.home, &ids, 1), vec!["w1"]);
    // the samples log past its cap is rotated, exactly as Node rotates it
    let big = "x".repeat(5_242_880 - 5);
    f.put(&side::samples_rel(), &format!("{big}\n"));
    let probes: Vec<(String, side::Probe)> = vec![("w2".into(), side::probe(&runner, "w2"))];
    let p = side::plan_sampling(&f.home, &ids, 8, &probes, NOW + 9).unwrap();
    assert!(p.unit.ops.iter().any(|o| matches!(o, Op::Rename { .. })));
    let mut j = job_for("sampling-rotate", vec![p], &[]);
    j.scope.files.push(side::sampling_state_rel());
    j.scope.files.extend(ids.iter().map(|i| format!(".anti-hall/devswarm/liveness/{i}.json")));
    let out = gate::run(&Ctx { now: NOW + 9, ..f.ctx() }, &System::configured(), &j, &Hooks::none());
    assert_eq!(out.verdict, Verdict::Agreed);
    assert!(f.home.join(format!("{}.1", side::samples_rel())).exists());
    t.case(true);
    let seen = std::fs::read_to_string(&log).unwrap();
    assert!(!seen.contains("VIOLATION") && !seen.contains("read-messages"), "a witness never calls the destructive read");
    t.print();
}

// ---------------------------------------------------------------- the gate refuses what it cannot witness

struct Lying;
impl Runner for Lying {
    fn run(&self, _: &RunSpec) -> RunResult {
        RunResult { ok: true, status: Some(0), stdout: "[null]\n".into(), ..Default::default() }
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
    let f = fix("gate");
    let job = job_for("sweep", vec![side::plan_sweep_state(&f.home, NOW)], &[]);
    // Node says "null" where the engine expects a value: mismatch on a call that has an expected value
    let mut j = job_for("name", vec![side::plan_name(&f.home, "ws-1", "n", NOW)], &[]);
    let out = gate::run(&f.ctx(), &Lying, &j, &Hooks::none());
    assert!(matches!(out.verdict, Verdict::Mismatch(_)), "{:?}", out.verdict);
    assert!(matches!(&out.ends[0], UnitEnd::Deferred(w) if w == "witness-mismatch"));
    assert!(f.read(&f.ds("names/ws-1.json")).is_none());
    // Node absent: unwitnessed, so unapplied
    let out = gate::run(&f.ctx(), &Absent, &job, &Hooks::none());
    assert!(matches!(out.verdict, Verdict::NodeUnavailable(_)));
    assert!(matches!(&out.ends[0], UnitEnd::Deferred(w) if w == "node-unavailable"));
    assert!(f.read(&f.ds("reconcile-sweep-state.json")).is_none());
    j.units.clear();
}

#[test]
fn a_drifted_precondition_or_a_busy_lock_defers_the_unit_untouched() {
    let f = fix("drift");
    let rel = side::repo_unknown_rel();
    f.put(&rel, "{\"version\":1,\"scopes\":{}}");
    let p = side::plan_repo_unknown_record(&f.home, "rk", "s", "Repository not found.", NOW).unwrap();
    f.put(&rel, "{\"version\":1,\"scopes\":{\"changed\":{}}}"); // someone wrote between plan and apply
    let before = f.snapshot();
    let env = apply::Env { home: &f.home, now: NOW, st: &f.st, log_dir: None };
    let end = apply::unit(&env, &p.unit, &Hooks::none());
    assert!(matches!(&end, UnitEnd::Deferred(w) if w.starts_with("drift:")), "{end:?}");
    assert_eq!(f.snapshot(), before);
    // a live holder of the per-id lock
    let _held = ah_engine::meshw::idlock::acquire(&f.home, "ws-1").unwrap();
    let mut u = side::plan_name(&f.home, "ws-1", "n", NOW).unit;
    u.lock = Some("ws-1".into());
    let end = apply::unit(&env, &u, &Hooks::none());
    assert_eq!(end, UnitEnd::Deferred("lock-busy".into()));
}

// ---------------------------------------------------------------- S2: healRegistry

struct HealCase {
    name: &'static str,
    build: fn(&Fix) -> (),
    /// ids the engine must hand back to Node
    deferred: &'static [&'static str],
}

fn desc_json(id: &str, wt: &str, sid: &str, owner: Option<&str>, repo: Option<&str>) -> String {
    let mut s = format!("{{\"id\":\"{id}\",\"worktreePath\":\"{wt}\",\"sessionId\":\"{sid}\",\"inboxPath\":null,\"cursorPath\":null,\"nudgeCommand\":null,\"repoId\":null");
    if let Some(o) = owner {
        s.push_str(&format!(",\"ownerKey\":\"{o}\""));
    }
    if let Some(r) = repo {
        s.push_str(&format!(",\"repoKey\":\"{r}\""));
    }
    s.push('}');
    s
}

/// The repository every case lives in (`p`), and a second one (`q`) for the mis-keyed cases.
fn base(f: &Fix) -> (String, String, String) {
    let p = f.repo("p");
    let key = f.key_of(&p);
    (p, key, f.repo("q"))
}

fn heal_cases() -> Vec<HealCase> {
    vec![
        HealCase { name: "empty store", build: |f| { let (_, k, _) = base(f); f.store(&k); }, deferred: &[] },
        HealCase {
            name: "already healed",
            build: |f| { let (p, k, _) = base(f); f.row(&k, "w1", &p, "s1"); f.descriptor("w1", &desc_json("w1", &p, "s1", Some(&k), Some(&k))); },
            deferred: &[],
        },
        HealCase {
            name: "stale owner and repo keys",
            build: |f| { let (p, k, _) = base(f); f.row(&k, "w1", &p, "s1"); f.descriptor("w1", &desc_json("w1", &p, "s1", Some("deadbeef"), Some("other-1"))); },
            deferred: &[],
        },
        HealCase {
            name: "keys missing from the descriptor",
            build: |f| { let (p, k, _) = base(f); f.row(&k, "w1", &p, "s1"); f.descriptor("w1", &desc_json("w1", &p, "s1", None, None)); },
            deferred: &[],
        },
        HealCase {
            name: "stale registry worktree path",
            build: |f| { let (p, k, _) = base(f); f.row(&k, "w1", "/old/path", "s1"); f.descriptor("w1", &desc_json("w1", &p, "s1", Some(&k), Some(&k))); },
            deferred: &[],
        },
        HealCase {
            name: "stale path and stale keys",
            build: |f| { let (p, k, _) = base(f); f.row(&k, "w1", "/old/path", "s1"); f.descriptor("w1", &desc_json("w1", &p, "s1", None, Some("zzz"))); },
            deferred: &[],
        },
        HealCase {
            name: "no descriptor",
            build: |f| { let (p, k, _) = base(f); f.row(&k, "w1", &p, "s1"); },
            deferred: &[],
        },
        HealCase {
            name: "descriptor of another session",
            build: |f| { let (p, k, _) = base(f); f.row(&k, "w1", "/old", "s1"); f.descriptor("w1", &desc_json("w1", &p, "foreign", None, None)); },
            deferred: &[],
        },
        HealCase {
            name: "unclaimed sessions never confirm",
            build: |f| { let (p, k, _) = base(f); f.row(&k, "w1", "/old", "unclaimed:w1"); f.descriptor("w1", &desc_json("w1", &p, "unclaimed:w1", None, None)); },
            deferred: &[],
        },
        HealCase {
            name: "descriptor id differs",
            build: |f| { let (p, k, _) = base(f); f.row(&k, "w1", &p, "s1"); f.descriptor("w1", &desc_json("w9", &p, "s1", None, None)); },
            deferred: &[],
        },
        HealCase {
            name: "worktree is not a repository",
            build: |f| {
                let (_, k, _) = base(f);
                let plain = f.home.join("plain");
                std::fs::create_dir_all(&plain).unwrap();
                let plain = plain.to_string_lossy().into_owned();
                f.row(&k, "w1", &plain, "s1");
                f.descriptor("w1", &desc_json("w1", &plain, "s1", None, None));
            },
            deferred: &[],
        },
        HealCase {
            name: "mis-keyed row goes to Node",
            build: |f| { let (_, k, q) = base(f); f.row(&k, "w1", &q, "s1"); f.descriptor("w1", &desc_json("w1", &q, "s1", None, None)); },
            deferred: &["w1"],
        },
        HealCase {
            name: "worktree gone with an archived counterpart",
            build: |f| {
                let (_, k, _) = base(f);
                f.row(&k, "w1", "/gone/for/good", "s1");
                f.descriptor("w1", &desc_json("w1", "/gone/for/good", "s1", None, None));
                f.put(".anti-hall/devswarm/archived/w1.json", "{\"id\":\"w1\"}");
            },
            deferred: &[],
        },
        HealCase {
            name: "worktree gone without an archived counterpart",
            build: |f| { let (_, k, _) = base(f); f.row(&k, "w1", "/gone/for/good", "s1"); f.descriptor("w1", &desc_json("w1", "/gone/for/good", "s1", None, None)); },
            deferred: &[],
        },
        HealCase {
            name: "unsafe id in the registry",
            build: |f| { let (p, k, _) = base(f); f.row(&k, "bad id", &p, "s1"); },
            deferred: &[],
        },
        HealCase {
            name: "descriptor is a symlink",
            build: |f| {
                let (p, k, _) = base(f);
                f.row(&k, "w1", &p, "s1");
                f.put("real.json", &desc_json("w1", &p, "s1", None, None));
                std::fs::create_dir_all(f.home.join(".anti-hall/devswarm/workspaces")).unwrap();
                std::os::unix::fs::symlink(f.home.join("real.json"), f.home.join(".anti-hall/devswarm/workspaces/w1.json")).unwrap();
            },
            deferred: &[],
        },
        HealCase {
            name: "a mixed store",
            build: |f| {
                let (p, k, q) = base(f);
                f.row(&k, "a1", &p, "sa");
                f.descriptor("a1", &desc_json("a1", &p, "sa", Some("x"), None));
                f.row(&k, "b2", "/old", "sb");
                f.descriptor("b2", &desc_json("b2", &p, "sb", Some(&k), Some(&k)));
                f.row(&k, "c3", &q, "sc");
                f.descriptor("c3", &desc_json("c3", &q, "sc", None, None));
                f.row(&k, "d4", &p, "sd");
            },
            deferred: &["c3"],
        },
    ]
}

#[test]
fn s2_heal_registry_matches_node_for_every_row_shape() {
    if !have("node") || !have("git") {
        return;
    }
    let t = Tally::new("S2.heal-registry");
    for c in heal_cases() {
        let f = fix("s2");
        (c.build)(&f);
        let key = std::fs::read_dir(f.home.join(f.ds("store"))).unwrap().next().unwrap().unwrap().file_name().to_string_lossy().into_owned();
        let run = heal::run(&f.ctx(), &System::configured(), &key, &Hooks::none()).unwrap_or_else(|d| panic!("{}: deferred {d:?}", c.name));
        assert_eq!(run.verdict, Verdict::Agreed, "{}: {:?}", c.name, run.verdict);
        let got: Vec<&str> = run.deferred.iter().map(|(i, _)| i.as_str()).collect();
        assert_eq!(got, c.deferred, "{}", c.name);
        t.case(c.deferred.is_empty());
        // idempotent: a second pass over the healed home changes nothing
        let before = f.snapshot();
        let again = heal::run(&f.ctx(), &System::configured(), &key, &Hooks::none()).unwrap();
        assert_eq!(again.verdict, Verdict::Agreed, "{} (second pass)", c.name);
        assert_eq!(f.snapshot(), before, "{}: the second pass wrote something", c.name);
    }
    t.print();
}

#[test]
fn s2_rehome_core_answers_the_trivial_cases_and_defers_moves() {
    assert_eq!(heal::rehome_core("w1", ""), heal::Core::Nothing);
    assert_eq!(heal::rehome_core("w1", &ah_engine::meshw::send::hash_from_workspace_id("w1")), heal::Core::Nothing);
    assert!(matches!(heal::rehome_core("w1", "repo-abc123"), heal::Core::Node(_)));
}

#[test]
fn s2_a_deferred_store_shape_writes_nothing() {
    let f = fix("s2def");
    let (_, k, _) = base(&f);
    // a journal-backend store
    let dir = f.home.join(f.ds(&format!("store/{k}")));
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join("BACKEND"), "journal\n").unwrap();
    assert!(heal::run(&f.ctx(), &System::configured(), &k, &Hooks::none()).is_err());
    // a missing store (Node would materialise one)
    assert!(heal::plan(&f.home, "no-such-store").is_err());
}

// ---------------------------------------------------------------- S5: healOrphanPartitions

struct OrphanCase {
    name: &'static str,
    build: fn(&Fix),
    /// `Ok((adopted, unhealable))`: decided natively; `Err(reason)`: the whole store is handed back before anything is written.
    want: Result<(u64, u64), &'static str>,
}

fn orphan_cases() -> Vec<OrphanCase> {
    vec![
        OrphanCase { name: "no store directory", build: |f| { let (_, k, _) = base(f); let _ = k; }, want: Ok((0, 0)) },
        OrphanCase { name: "no orphans", build: |f| { let (p, k, _) = base(f); f.row(&k, "w1", &p, "s1"); f.msg(&k, "w1"); }, want: Ok((0, 0)) },
        OrphanCase {
            name: "one live orphan is adopted",
            build: |f| { let (p, k, _) = base(f); f.msg(&k, "o1"); f.descriptor("o1", &desc_json("o1", &p, "so1", Some(&k), Some(&k))); },
            want: Ok((1, 0)),
        },
        OrphanCase {
            name: "two orphans of two worktrees",
            build: |f| {
                let (p, k, _) = base(f);
                let p2 = f.linked(&p, "p2");
                f.msg(&k, "o1");
                f.msg(&k, "o2");
                f.descriptor("o1", &desc_json("o1", &p, "so1", None, None));
                f.descriptor("o2", &desc_json("o2", &p2, "so2", None, None));
            },
            want: Ok((2, 0)),
        },
        OrphanCase {
            name: "two orphans of one worktree: the second joins the first's family",
            build: |f| {
                let (p, k, _) = base(f);
                f.msg(&k, "o1");
                f.msg(&k, "o2");
                f.descriptor("o1", &desc_json("o1", &p, "so1", None, None));
                f.descriptor("o2", &desc_json("o2", &p, "so2", None, None));
            },
            want: Err("orphan-family"),
        },
        OrphanCase { name: "no descriptor anywhere", build: |f| { let (_, k, _) = base(f); f.msg(&k, "o1"); }, want: Ok((0, 1)) },
        OrphanCase {
            name: "descriptor of another repository",
            build: |f| { let (_, k, q) = base(f); f.msg(&k, "o1"); f.descriptor("o1", &desc_json("o1", &q, "so1", None, None)); },
            want: Ok((0, 1)),
        },
        OrphanCase {
            name: "adopt beside a drained unhealable orphan and a wrong-store one",
            build: |f| {
                let (p, k, q) = base(f);
                f.msg(&k, "o1");
                f.msg(&k, "o2");
                f.msg(&k, "o3");
                f.store(&k).set_cursor("o2", 1, 10).unwrap();
                f.store(&k).set_cursor("o3", 1, 10).unwrap();
                f.descriptor("o1", &desc_json("o1", &p, "so1", None, None));
                f.descriptor("o2", &desc_json("o2", &q, "so2", None, None));
            },
            want: Ok((1, 2)),
        },
        OrphanCase {
            name: "adopt beside an unhealable orphan with unread: the summary is Node's, the store is handed back",
            build: |f| { let (p, k, _) = base(f); f.msg(&k, "o1"); f.msg(&k, "o3"); f.descriptor("o1", &desc_json("o1", &p, "so1", None, None)); },
            want: Err("summary-orphan"),
        },
        OrphanCase {
            name: "worktree family already in the registry",
            build: |f| { let (p, k, _) = base(f); f.row(&k, "w1", &p, "s1"); f.msg(&k, "o1"); f.descriptor("o1", &desc_json("o1", &p, "so1", None, None)); },
            want: Err("orphan-family"),
        },
        OrphanCase {
            name: "descriptor only in archived/",
            build: |f| { let (p, k, _) = base(f); f.msg(&k, "o1"); f.put(&f.ds("archived/o1.json"), &desc_json("o1", &p, "so1", None, None)); },
            want: Err("orphan-archived"),
        },
        OrphanCase {
            name: "live descriptor with its own archive marker",
            build: |f| {
                let (p, k, _) = base(f);
                f.msg(&k, "o1");
                f.descriptor("o1", &desc_json("o1", &p, "so1", None, None));
                f.put(&f.ds("archived/o1.json"), &desc_json("o1", &p, "old", None, None));
            },
            want: Err("orphan-archived"),
        },
        OrphanCase {
            name: "worktree archived under another id",
            build: |f| {
                let (p, k, _) = base(f);
                f.msg(&k, "o1");
                f.descriptor("o1", &desc_json("o1", &p, "so1", None, None));
                f.put(&f.ds("archived/zz.json"), &desc_json("zz", &p, "szz", None, None));
            },
            want: Err("orphan-archived"),
        },
        OrphanCase {
            name: "own archive marker names another worktree (id reuse)",
            build: |f| {
                let (p, k, q) = base(f);
                f.msg(&k, "o1");
                f.descriptor("o1", &desc_json("o1", &p, "so1", None, None));
                f.put(&f.ds("archived/o1.json"), &desc_json("o1", &q, "old", None, None));
            },
            want: Ok((1, 0)),
        },
        OrphanCase {
            name: "unreadable archive marker",
            build: |f| { let (p, k, _) = base(f); f.msg(&k, "o1"); f.descriptor("o1", &desc_json("o1", &p, "so1", None, None)); f.put(&f.ds("archived/o1.json"), "{not json"); },
            want: Err("orphan-archived"),
        },
        OrphanCase {
            name: "a descriptor field of a type the engine does not model",
            build: |f| { let (p, k, _) = base(f); f.msg(&k, "o1"); f.descriptor("o1", &desc_json("o1", &p, "so1", None, None).replace("\"so1\"", "5")); },
            want: Err("descriptor-field-type"),
        },
        OrphanCase {
            name: "orphans known only by a cursor and a gate; broadcast and unsafe ids ignored",
            build: |f| {
                let (p, k, _) = base(f);
                let st = f.store(&k);
                st.set_cursor("o1", 3, 10).unwrap();
                st.set_gate("o2", "g", true, "t", 10).unwrap();
                st.append_message("*mesh-broadcast*", 5, Some("hb"), "x").unwrap();
                st.append_message("bad id", 5, Some("hb2"), "x").unwrap();
                f.descriptor("o1", &desc_json("o1", &p, "so1", None, None));
            },
            want: Ok((1, 1)),
        },
        OrphanCase {
            name: "descriptor without a worktree",
            build: |f| { let (_, k, _) = base(f); f.msg(&k, "o1"); f.descriptor("o1", "{\"id\":\"o1\",\"sessionId\":\"so1\"}"); },
            want: Ok((1, 0)),
        },
    ]
}

#[test]
fn s5_heal_orphan_partitions_matches_node_for_every_store_shape() {
    if !have("node") || !have("git") {
        return;
    }
    let t = Tally::new("S5.heal-orphans");
    for c in orphan_cases() {
        let f = fix("s5");
        (c.build)(&f);
        let key = f.key_of(&std::fs::canonicalize(f.home.join("repos/p")).unwrap().to_string_lossy());
        let before_msgs = msg_count(&f, &key);
        match (orphans::run(&f.ctx(), &System::configured(), &key, &Hooks::none()), c.want) {
            (Ok(run), Ok((adopted, unhealable))) => {
                assert_eq!(run.verdict, Verdict::Agreed, "{}: {:?}", c.name, run.verdict);
                assert!(run.deferred.is_empty(), "{}: {:?}", c.name, run.deferred);
                assert_eq!((run.result["adopted"].as_u64(), run.result["unhealable"].as_u64()), (Some(adopted), Some(unhealable)), "{}", c.name);
                t.case(true);
                // idempotent: a second pass changes nothing
                let after = f.snapshot();
                let again = orphans::run(&f.ctx(), &System::configured(), &key, &Hooks::none()).unwrap();
                assert_eq!(again.verdict, Verdict::Agreed, "{} (second pass)", c.name);
                assert_eq!(again.result["adopted"], 0, "{}", c.name);
                assert_eq!(f.snapshot(), after, "{}: the second pass wrote something", c.name);
            }
            (Ok(run), Err(why)) => {
                // decided natively, but the summary projection after the adoption is not the engine's: the witness fails and the
                // adoption is handed back with nothing written
                assert!(matches!(&run.verdict, Verdict::MirrorFailed(w) if w.contains(why)), "{}: {:?}", c.name, run.verdict);
                assert_eq!(run.deferred.len(), 1, "{}", c.name);
                assert_eq!(run.result["adopted"], 0, "{}", c.name);
                assert!(ah_engine::dssup::recon::view::registry(&f.home, &key).unwrap().is_empty(), "{}: nothing adopted", c.name);
                t.case(false);
            }
            (Err(d), Err(why)) => {
                assert_eq!(d.0, why, "{}", c.name);
                t.case(false);
                // nothing was written
                assert_eq!(msg_count(&f, &key), before_msgs);
            }
            (got, want) => panic!("{}: got {:?} want {want:?}", c.name, got.map(|r| (r.verdict, r.result)).map_err(|d| d.0)),
        }
        assert_eq!(msg_count(&f, &key), before_msgs, "{}: no message row was added or removed", c.name);
    }
    t.print();
}

fn msg_count(f: &Fix, key: &str) -> i64 {
    let db = f.home.join(f.ds(&format!("store/{key}/devswarm.db")));
    rusqlite::Connection::open(db).and_then(|c| c.query_row("SELECT COUNT(*) FROM messages", [], |r| r.get(0))).unwrap_or(0)
}

#[test]
fn s5_a_busy_lock_hands_the_adoption_back_untouched() {
    if !have("node") || !have("git") {
        return;
    }
    let f = fix("s5lock");
    let (p, k, _) = base(&f);
    f.msg(&k, "o1");
    f.descriptor("o1", &desc_json("o1", &p, "so1", None, None));
    let held = ah_engine::meshw::idlock::acquire(&f.home, "o1").expect("lock");
    let run = orphans::run(&f.ctx(), &System::configured(), &k, &Hooks::none()).unwrap();
    held.release();
    assert_eq!(run.verdict, Verdict::Agreed);
    assert_eq!(run.deferred.len(), 1);
    assert_eq!(run.deferred[0].0, "o1");
    assert_eq!(run.result["adopted"], 0);
    assert!(ah_engine::dssup::recon::view::registry(&f.home, &k).unwrap().is_empty(), "nothing was adopted");
}

/// `sweep_tail_mode`: default `node` leaves the stage to Node alone; `engine` runs the witnessed orphan heal first and records it.
#[test]
fn s5_the_sweep_tail_mode_selects_the_engine_part_of_the_deferred_stage() {
    if !have("node") || !have("git") {
        return;
    }
    let build = |tag: &str, mode: Option<&str>| {
        let mut f = fix(tag);
        let (p, k, _) = base(&f);
        f.msg(&k, "o1");
        f.descriptor("o1", &desc_json("o1", &p, "so1", None, None));
        // the rotation stands on the orphan-heal stage (index 1 of 4) and its marker has the store pending
        f.put(&f.ds("deferred-sweep-state.json"), "{\"nextStageIndex\":1}");
        f.put(".anti-hall/update-sweep-state.json", &format!("{{\"healOrphanPartitions\":{{\"pendingVersion\":\"9.9.9\",\"pendingHashes\":[\"{k}\"]}}}}"));
        if let Some(m) = mode {
            f.st.env.insert("ANTIHALL_DEVSWARM_SUP_SWEEP_TAIL_MODE".into(), m.into());
        }
        (f, k)
    };
    let (node_home, k) = build("s5mode-node", None);
    let rec = ah_engine::dssup::deferred::duty(&node_home.ctx(), &System::configured());
    assert!(rec.get("engine").is_none(), "{rec}");
    let _ = k;
    let (eng_home, k) = build("s5mode-engine", Some("engine"));
    let rec = ah_engine::dssup::deferred::duty(&eng_home.ctx(), &System::configured());
    let stores = rec["engine"].as_array().unwrap_or_else(|| panic!("no engine part: {rec}"));
    assert_eq!(stores.len(), 1, "{rec}");
    assert_eq!((stores[0]["repoKey"].as_str(), stores[0]["agreed"].as_bool(), stores[0]["adopted"].as_u64()), (Some(k.as_str()), Some(true), Some(1)), "{rec}");
    let rows = ah_engine::dssup::recon::view::registry(&eng_home.home, &k).unwrap();
    assert_eq!(rows.iter().map(|r| r.row.id.as_str()).collect::<Vec<_>>(), ["o1"], "the engine adopted the orphan");
}

// ---------------------------------------------------------------- crash safety

fn kill_hook(point: &str) -> impl Fn(&str) + '_ {
    move |name| {
        if name == point {
            // SAFETY: SIGKILL of this very process, the point of the crash test
            unsafe { libc::kill(libc::getpid(), libc::SIGKILL) };
        }
    }
}

fn crash_fixture(f: &Fix) -> String {
    let (p, k, _) = base(f);
    f.row(&k, "w1", "/old/path", "s1");
    f.descriptor("w1", &desc_json("w1", &p, "s1", Some("stale"), None));
    k
}

#[test]
fn crash_child() {
    // the child half of the crash tests: does nothing unless the parent set the environment
    let (Ok(home), Ok(at)) = (std::env::var("RECON_CRASH_HOME"), std::env::var("RECON_CRASH_AT")) else { return };
    init_defaults();
    let home = PathBuf::from(home);
    let mut env: HashMap<String, String> = HashMap::new();
    env.insert("HOME".into(), home.to_string_lossy().into_owned());
    let st = Settings { home: home.to_string_lossy().into_owned(), env };
    let root = ah_engine::defaults::root().unwrap();
    let ctx = Ctx { home: &home, root: &root, st: &st, now: NOW, engine_pokes: false };
    let hook = kill_hook(&at);
    if std::env::var("RECON_CRASH_KIND").as_deref() == Ok("sampling") {
        let ids = vec!["w1".to_string()];
        let probes = vec![("w1".to_string(), side::Probe { ok: true, raw: "{\"terminalId\":\"t9\",\"startup\":{\"p\":1}}".into() })];
        let p = side::plan_sampling(&home, &ids, 8, &probes, NOW).unwrap();
        let env = apply::Env { home: &home, now: NOW, st: &st, log_dir: None };
        let _ = apply::unit(&env, &p.unit, &Hooks { at: &hook });
        return;
    }
    if std::env::var("RECON_CRASH_KIND").as_deref() == Ok("fold") {
        let key = std::env::var("RECON_CRASH_KEY").unwrap();
        let mut st = st;
        st.env.insert("ANTIHALL_DEVSWARM_SWEEP_TAIL_MODE".into(), "engine".into());
        let ctx = Ctx { home: &home, root: &root, st: &st, now: NOW, engine_pokes: false };
        let _ = fold::run(&ctx, &System::configured(), &key, &Hooks { at: &hook });
        return;
    }
    let key = std::env::var("RECON_CRASH_KEY").unwrap();
    if std::env::var("RECON_CRASH_KIND").as_deref() == Ok("orphans") {
        let _ = orphans::run(&ctx, &System::configured(), &key, &Hooks { at: &hook });
        return;
    }
    let _ = heal::run(&ctx, &System::configured(), &key, &Hooks { at: &hook });
}

#[test]
fn a_sigkill_at_every_op_boundary_leaves_a_state_nodes_next_sweep_converges_from() {
    if !have("node") || !have("git") {
        return;
    }
    // the uninterrupted result is the reference
    let reference = fix("crash-ref");
    let key = crash_fixture(&reference);
    let r = heal::run(&reference.ctx(), &System::configured(), &key, &Hooks::none()).unwrap();
    assert_eq!(r.verdict, Verdict::Agreed);
    let points: Vec<String> = ["before", "after"].iter().flat_map(|w| (0..3).map(move |i| format!("heal:w1:{i}:{w}"))).collect();
    let mut survived = 0;
    for point in &points {
        let f = fix("crash");
        let k = crash_fixture(&f);
        let desc_rel = f.ds("workspaces/w1.json");
        let old_desc = f.read(&desc_rel).unwrap();
        let o = Command::new(std::env::current_exe().unwrap())
            .args(["--exact", "crash_child", "--nocapture", "--test-threads=1"])
            .env("RECON_CRASH_HOME", &f.home)
            .env("RECON_CRASH_AT", point)
            .env("RECON_CRASH_KEY", &k)
            .output()
            .unwrap();
        use std::os::unix::process::ExitStatusExt;
        if o.status.signal() != Some(9) {
            continue; // the op list has fewer ops than this point names
        }
        survived += 1;
        // invariants: the descriptor exists whole (old or new), the registry row is entirely old or entirely new, markers parse
        let desc = f.read(&desc_rel).expect("the descriptor is never missing");
        assert!(OVal::parse(&desc).is_some(), "{point}: descriptor parses");
        assert!(desc == old_desc || desc.contains(&format!("\"ownerKey\":\"{k}\"")), "{point}: descriptor is old or new");
        let rows = ah_engine::dssup::recon::view::registry(&f.home, &k).unwrap();
        assert_eq!(rows.len(), 1);
        let path = rows[0].row.worktree_path.clone().unwrap();
        assert!(path == "/old/path" || path.ends_with("/p"), "{point}: row is old or new: {path}");
        // Node's own next sweep converges to the uninterrupted result
        let code = "process.env.HOME=process.argv[2];const F=require(process.argv[1]+'/scripts/devswarm-lib/fold.js');F.healRegistry(process.argv[2],process.argv[3],{})";
        let n = Command::new("node").args(["-e", code, f.root.to_str().unwrap(), f.home.to_str().unwrap(), &k]).env("ANTI_HALL_LOG_DIR", f.home.join("logs")).output().unwrap();
        assert!(n.status.success(), "{}", String::from_utf8_lossy(&n.stderr));
        let norm_desc = |x: &Fix, key: &str| x.read(&x.ds("workspaces/w1.json")).unwrap().replace(key, "KEY").replace(&x.home.to_string_lossy().into_owned(), "HOME");
        assert_eq!(norm_desc(&f, &k), norm_desc(&reference, &key), "{point}: converged descriptor");
        let tup = |x: &Fix, key: &str| ah_engine::dssup::recon::view::registry(&x.home, key).unwrap().into_iter().map(|r| (r.row.id, r.row.worktree_path.map(|p| p.rsplit('/').next().unwrap_or("").to_string()), r.row.session_id)).collect::<Vec<_>>();
        assert_eq!(tup(&f, &k), tup(&reference, &key), "{point}: converged registry");
    }
    assert!(survived >= 4, "the kill points were reached ({survived})");
}

fn orphan_crash_fixture(f: &Fix) -> String {
    let (p, k, _) = base(f);
    let p2 = f.linked(&p, "p2");
    f.msg(&k, "o1");
    f.msg(&k, "o2");
    f.descriptor("o1", &desc_json("o1", &p, "so1", None, None));
    f.descriptor("o2", &desc_json("o2", &p2, "so2", None, None));
    k
}

/// The registry as (id, worktree basename, session) triples.
fn reg_tuples(f: &Fix, key: &str) -> Vec<(String, Option<String>, Option<String>)> {
    ah_engine::dssup::recon::view::registry(&f.home, key).unwrap().into_iter().map(|r| (r.row.id, r.row.worktree_path.map(|p| p.rsplit('/').next().unwrap_or("").to_string()), r.row.session_id)).collect()
}

#[test]
fn s5_a_sigkill_at_every_adoption_and_summary_boundary_loses_nothing_and_nodes_next_pass_converges() {
    if !have("node") || !have("git") {
        return;
    }
    // the uninterrupted result is the reference
    let reference = fix("s5crash-ref");
    let rkey = orphan_crash_fixture(&reference);
    let r = orphans::run(&reference.ctx(), &System::configured(), &rkey, &Hooks::none()).unwrap();
    assert_eq!(r.verdict, Verdict::Agreed);
    assert_eq!(reg_tuples(&reference, &rkey).len(), 2);
    let summary_rel = |x: &Fix, k: &str| x.ds(&format!("summaries/{k}.json"));
    // the native part never forwards, so the boundaries are the two adoptions and the summary
    let points: Vec<String> = ["before", "after"].iter().flat_map(|w| ["orphan:o1:0", "orphan:o2:0", "orphan-summary:0"].map(|u| format!("{u}:{w}"))).collect();
    let mut survived = 0;
    for point in &points {
        let f = fix("s5crash");
        let k = orphan_crash_fixture(&f);
        let before = msg_count(&f, &k);
        let o = Command::new(std::env::current_exe().unwrap())
            .args(["--exact", "crash_child", "--nocapture", "--test-threads=1"])
            .env("RECON_CRASH_HOME", &f.home)
            .env("RECON_CRASH_AT", point)
            .env("RECON_CRASH_KEY", &k)
            .env("RECON_CRASH_KIND", "orphans")
            .output()
            .unwrap();
        use std::os::unix::process::ExitStatusExt;
        if o.status.signal() != Some(9) {
            continue;
        }
        survived += 1;
        // every message survives; every registry row is whole; the summary parses or is absent
        assert_eq!(msg_count(&f, &k), before, "{point}: no message lost or duplicated");
        for (id, wt, sid) in reg_tuples(&f, &k) {
            assert!(wt.is_some() && sid.as_deref() == Some(&format!("s{id}")), "{point}: row {id} is whole");
        }
        if let Some(s) = f.read(&summary_rel(&f, &k)) {
            assert!(OVal::parse(&s).is_some(), "{point}: summary parses");
        }
        // Node's own next pass converges to the uninterrupted result
        let code = "process.env.HOME=process.argv[2];const R=require(process.argv[1]+'/scripts/devswarm-lib/repair.js');R.healOrphanPartitions(process.argv[2],{repoKey:process.argv[3]})";
        let n = Command::new("node").args(["-e", code, f.root.to_str().unwrap(), f.home.to_str().unwrap(), &k]).env("ANTI_HALL_LOG_DIR", f.home.join("logs")).output().unwrap();
        assert!(n.status.success(), "{}", String::from_utf8_lossy(&n.stderr));
        assert_eq!(reg_tuples(&f, &k), reg_tuples(&reference, &rkey), "{point}: converged registry");
        assert_eq!(msg_count(&f, &k), before, "{point}: still no message added by the convergence");
    }
    assert!(survived >= 6, "the kill points were reached ({survived})");
}

#[test]
fn a_sigkill_inside_a_sampling_pass_leaves_parsable_markers_and_the_rerun_converges() {
    let build = |tag: &str| {
        let f = fix(tag);
        f.put(&f.ds("liveness/w1.json"), "{\"status\":\"stale\"}");
        f.put(&side::samples_rel(), &format!("{}\n", "y".repeat(5_242_880 - 40)));
        f
    };
    let reference = build("samp-ref");
    let ids = vec!["w1".to_string()];
    let probes = vec![("w1".to_string(), side::Probe { ok: true, raw: "{\"terminalId\":\"t9\",\"startup\":{\"p\":1}}".into() })];
    let plan = side::plan_sampling(&reference.home, &ids, 8, &probes, NOW).unwrap();
    let env = apply::Env { home: &reference.home, now: NOW, st: &reference.st, log_dir: None };
    assert_eq!(apply::unit(&env, &plan.unit, &Hooks::none()), UnitEnd::Applied);
    let n = plan.unit.ops.len();
    assert_eq!(n, 3, "rotate, append, state");
    let mut killed = 0;
    for i in 0..n {
        for w in ["before", "after"] {
            let f = build("samp");
            let o = Command::new(std::env::current_exe().unwrap())
                .args(["--exact", "crash_child", "--nocapture", "--test-threads=1"])
                .env("RECON_CRASH_HOME", &f.home)
                .env("RECON_CRASH_AT", format!("sampling:{i}:{w}"))
                .env("RECON_CRASH_KIND", "sampling")
                .output()
                .unwrap();
            use std::os::unix::process::ExitStatusExt;
            assert_eq!(o.status.signal(), Some(9), "sampling:{i}:{w}");
            killed += 1;
            // every sample line is whole JSON or the oversized filler; the state marker parses or is absent
            for l in f.read(&side::samples_rel()).unwrap_or_default().lines() {
                assert!(l.starts_with('y') || OVal::parse(l).is_some(), "torn sample line");
            }
            if let Some(s) = f.read(&side::sampling_state_rel()) {
                assert!(OVal::parse(&s).is_some(), "state marker parses");
            }
            // the rerun of the same pass completes the work and never loses a line
            let plan = side::plan_sampling(&f.home, &ids, 8, &probes, NOW).unwrap();
            let env = apply::Env { home: &f.home, now: NOW, st: &f.st, log_dir: None };
            assert_eq!(apply::unit(&env, &plan.unit, &Hooks::none()), UnitEnd::Applied);
            let all = format!("{}{}", f.read(&format!("{}.1", side::samples_rel())).unwrap_or_default(), f.read(&side::samples_rel()).unwrap_or_default());
            assert!(all.contains("\"terminalId\":\"t9\""), "sampling:{i}:{w}: the sample survived");
        }
    }
    assert_eq!(killed, 6);
}

#[test]
fn a_hivecontrol_stub_killed_mid_read_loses_nothing_the_engine_holds() {
    // the stub dies half way through `read-messages`; the runner reports a non-zero exit and what was printed, and the planner
    // never treats the partial text as a probe answer
    let dir = fix("stubkill");
    let fx = dir.home.join("fx");
    std::fs::create_dir_all(&fx).unwrap();
    std::fs::write(fx.join("workspace_info_w1.out"), "{\"startup\":{\"phase\":\"boot\"},\"terminalId\":\"t1\"}").unwrap();
    let stub = stub_with(&dir, &format!("HC_STUB_DIR={}\nHC_STUB_DIE_MID=workspace\n", fx.display()));
    let r = System { hc: stub.to_string_lossy().into_owned() };
    let p = side::probe(&r, "w1");
    assert!(!p.ok, "a probe whose process was killed is a failed probe");
}

// ---------------------------------------------------------------- S6: the mesh fold

/// A fixture whose engine switch for the sweep tail is on.
fn fix6(tag: &str) -> Fix {
    let mut f = fix(tag);
    f.st.env.insert("ANTIHALL_DEVSWARM_SWEEP_TAIL_MODE".into(), "engine".into());
    f
}

impl Fix {
    fn row_s(&self, key: &str, id: &str, wt: &str, sid: Option<&str>) {
        let st = self.store(key);
        let r = RegistryRow { id: id.into(), worktree_path: Some(wt.into()), session_id: sid.map(str::to_string), inbox_path: None, cursor_path: None, nudge_command: None };
        assert!(st.upsert_registry(&r, 1_000, |_, _| true).unwrap());
    }
    fn db(&self, key: &str) -> rusqlite::Connection {
        rusqlite::Connection::open(self.home.join(self.ds(&format!("store/{key}/devswarm.db")))).unwrap()
    }
    fn touch(&self, key: &str, id: &str, updated_at: i64) {
        self.db(key).execute("UPDATE registry SET updated_at = ?1 WHERE id = ?2", rusqlite::params![updated_at, id]).unwrap();
    }
    /// A direct message in `part`'s partition (`sender` empty makes it non-forwardable).
    fn msg(&self, key: &str, part: &str, ts: i64, body: &str, sender: &str) {
        let st = self.store(key);
        st.append_mesh_row(&MeshRow {
            workspace_id: part.into(),
            ts,
            hash: Some(format!("mesh:seed-{part}-{ts}-{}", body.len())),
            body: body.into(),
            sender: Some(sender.into()),
            recipient: Some(part.into()),
            mtype: Some("direct".into()),
            urgency: Some("normal".into()),
            ..MeshRow::default()
        })
        .unwrap();
    }
    fn floors(&self, key: &str, part: &str, v: i64) {
        let put = |ns: &str, value: i64| CursorPut { partition: part.into(), ns: ns.into(), reader: "#floor".into(), value, retired_line: None, updated_at: 5 };
        self.store(key).reader_cursor_txn(&[put("store", v), put("nd", 0)]).unwrap();
    }
    fn rows(&self, key: &str) -> Vec<String> {
        ah_engine::dssup::recon::view::registry(&self.home, key).unwrap().into_iter().map(|r| r.row.id).collect()
    }
    fn msgs_in(&self, key: &str, part: &str) -> Vec<String> {
        let c = self.db(key);
        let mut st = c.prepare("SELECT body FROM messages WHERE workspace_id = ?1 ORDER BY id").unwrap();
        st.query_map([part], |r| r.get::<_, String>(0)).unwrap().flatten().collect()
    }
}

struct FoldCase {
    name: &'static str,
    /// Builds the home; returns the store key and the texts that depend on the home's path (replaced by `N0`, `N1` ...).
    build: fn(&Fix) -> (String, Vec<String>),
    retired: &'static [&'static str],
    forwarded: i64,
    /// Groups the engine hands to Node (nothing is planned or written for them).
    deferred: usize,
    /// Compared against Node's whole `foldMeshDuplicates` on a twin home (only when nothing is deferred).
    whole: bool,
}

fn s6_base(f: &Fix) -> (String, String) {
    let wt = f.repo("p");
    let key = f.key_of(&wt);
    (wt, key)
}

fn pair(k: &str, wt: &str) -> Vec<String> {
    vec![k.to_string(), wt.to_string()]
}

fn s6_cases() -> Vec<FoldCase> {
    vec![
        FoldCase {
            name: "live survivor, phantom with two unread",
            build: |f| {
                let (wt, k) = s6_base(f);
                f.row_s(&k, "w-live", &wt, Some("s1"));
                f.row_s(&k, "w-ph", &wt, None);
                f.floors(&k, "w-ph", 0);
                f.msg(&k, "w-ph", 10, "one", "snd");
                f.msg(&k, "w-ph", 11, "two", "snd");
                (k.clone(), vec![k, wt])
            },
            retired: &["w-ph"],
            forwarded: 2,
            deferred: 0,
            whole: true,
        },
        FoldCase {
            name: "phantom without mail",
            build: |f| {
                let (wt, k) = s6_base(f);
                f.row_s(&k, "w-live", &wt, Some("s1"));
                f.row_s(&k, "w-ph", &wt, None);
                (k.clone(), vec![k, wt])
            },
            retired: &["w-ph"],
            forwarded: 0,
            deferred: 0,
            whole: true,
        },
        FoldCase {
            name: "descriptor-backed duplicate is forwarded and left",
            build: |f| {
                let (wt, k) = s6_base(f);
                f.row_s(&k, "w-live", &wt, Some("s1"));
                f.row_s(&k, "w-zdup", &wt, None);
                f.descriptor("w-zdup", &desc_json("w-zdup", &wt, "", None, None));
                f.floors(&k, "w-zdup", 0);
                f.msg(&k, "w-zdup", 10, "kept", "snd");
                (k.clone(), vec![k, wt])
            },
            retired: &[],
            forwarded: 1,
            deferred: 0,
            whole: true,
        },
        FoldCase {
            name: "the id-first row is not the live one: the survivor needs liveness, Node's",
            build: |f| {
                let (wt, k) = s6_base(f);
                f.row_s(&k, "w-live", &wt, Some("s1"));
                f.row_s(&k, "w-adup", &wt, None);
                f.floors(&k, "w-adup", 0);
                f.msg(&k, "w-adup", 10, "kept", "snd");
                (k.clone(), pair(&k, &wt))
            },
            retired: &[],
            forwarded: 0,
            deferred: 1,
            whole: false,
        },
        FoldCase {
            name: "a retired partition left with unread mail cannot be summarised natively: Node's",
            build: |f| {
                let (wt, k) = s6_base(f);
                f.row_s(&k, "w-live", &wt, Some("s1"));
                f.row_s(&k, "w-ph", &wt, None);
                f.floors(&k, "w-ph", 0);
                f.msg(&k, "w-ph", 10, "native", "");
                f.msg(&k, "w-ph", 11, "real", "snd");
                (k.clone(), vec![k, wt])
            },
            retired: &[],
            forwarded: 0,
            deferred: 1,
            whole: false,
        },
        FoldCase {
            name: "a floor above zero skips the consumed prefix",
            build: |f| {
                let (wt, k) = s6_base(f);
                f.row_s(&k, "w-live", &wt, Some("s1"));
                f.row_s(&k, "w-ph", &wt, None);
                f.floors(&k, "w-ph", 1);
                f.msg(&k, "w-ph", 10, "read", "snd");
                f.msg(&k, "w-ph", 11, "unread-a", "snd");
                f.msg(&k, "w-ph", 12, "unread-b", "snd");
                (k.clone(), vec![k, wt])
            },
            retired: &["w-ph"],
            forwarded: 2,
            deferred: 0,
            whole: true,
        },
        FoldCase {
            name: "identical mail in two candidates is added once",
            build: |f| {
                let (wt, k) = s6_base(f);
                f.row_s(&k, "w-a", &wt, Some("s1"));
                f.row_s(&k, "w-b", &wt, None);
                f.row_s(&k, "w-c", &wt, None);
                for id in ["w-b", "w-c"] {
                    f.floors(&k, id, 0);
                }
                // same sender, body, time: the forwarded copies share a hash; the seeded originals differ in their part name
                f.msg(&k, "w-b", 10, "same", "snd");
                f.msg(&k, "w-c", 10, "same", "snd");
                (k.clone(), vec![k, wt])
            },
            retired: &["w-b", "w-c"],
            forwarded: 1,
            deferred: 0,
            whole: true,
        },
        FoldCase {
            name: "a stale cross-reference makes two live-shaped rows: Node's survivor pick",
            build: |f| {
                let (wt, k) = s6_base(f);
                f.row_s(&k, "w-live", &wt, Some("s1"));
                f.row_s(&k, "w-x", &wt, Some("w-live"));
                f.descriptor("w-x", &desc_json("w-x", &wt, "w-live", None, None));
                (k.clone(), vec![k, wt])
            },
            retired: &[],
            forwarded: 0,
            deferred: 1,
            whole: false,
        },
        FoldCase {
            name: "a lone subdirectory row is re-keyed to its toplevel",
            build: |f| {
                let (wt, k) = s6_base(f);
                let sub = format!("{wt}/sub");
                std::fs::create_dir_all(&sub).unwrap();
                f.row_s(&k, "w-sub", &sub, Some("s1"));
                (k.clone(), pair(&k, &wt))
            },
            retired: &[],
            forwarded: 0,
            deferred: 0,
            whole: true,
        },
        FoldCase {
            name: "a subdirectory row joins its toplevel's group and folds",
            build: |f| {
                let (wt, k) = s6_base(f);
                let sub = format!("{wt}/sub");
                std::fs::create_dir_all(&sub).unwrap();
                f.row_s(&k, "w-a", &wt, Some("s1"));
                f.row_s(&k, "w-b", &sub, None);
                f.touch(&k, "w-a", NOW + 5); // the re-keyed row is stamped `now`; the live row must still win the fallback
                f.floors(&k, "w-b", 0);
                f.msg(&k, "w-b", 10, "from the subdir", "snd");
                (k.clone(), pair(&k, &wt))
            },
            retired: &["w-b"],
            forwarded: 1,
            deferred: 0,
            whole: true,
        },
        FoldCase {
            name: "an aged ghost folds into the lone non-ghost",
            build: |f| {
                let (wt, k) = s6_base(f);
                f.row_s(&k, "w-anchor", &wt, Some("unclaimed:primary-x"));
                f.row_s(&k, "w-ghost", &wt, None);
                (k.clone(), pair(&k, &wt))
            },
            retired: &["w-ghost"],
            forwarded: 0,
            deferred: 0,
            whole: true,
        },
        FoldCase {
            name: "a young ghost is only reported",
            build: |f| {
                let (wt, k) = s6_base(f);
                f.row_s(&k, "w-anchor", &wt, Some("unclaimed:primary-x"));
                f.row_s(&k, "w-ghost", &wt, None);
                f.touch(&k, "w-ghost", NOW - 3_600_000);
                (k.clone(), pair(&k, &wt))
            },
            retired: &[],
            forwarded: 0,
            deferred: 0,
            whole: true,
        },
        FoldCase {
            name: "two sessionless rows are refused (needs attention)",
            build: |f| {
                let (wt, k) = s6_base(f);
                f.row_s(&k, "w-a", &wt, Some("unclaimed:a"));
                f.row_s(&k, "w-b", &wt, Some("unclaimed:b"));
                (k.clone(), pair(&k, &wt))
            },
            retired: &[],
            forwarded: 0,
            deferred: 0,
            whole: true,
        },
        FoldCase {
            name: "an attended anchor candidate is left",
            build: |f| {
                let (wt, k) = s6_base(f);
                let anchor = ah_engine::meshw::ident::primary_workspace_id(&wt).unwrap();
                f.row_s(&k, "z-live", &wt, Some("s1"));
                f.row_s(&k, &anchor, &wt, None);
                f.touch(&k, "z-live", 5_000); // the live row is the freshest, so it wins the fallback too
                f.descriptor(&anchor, &desc_json(&anchor, &wt, "", None, None));
                (k.clone(), vec![k, wt, anchor])
            },
            retired: &[],
            forwarded: 0,
            deferred: 0,
            whole: true,
        },
        FoldCase {
            name: "an unattended anchor candidate is folded",
            build: |f| {
                let (wt, k) = s6_base(f);
                let anchor = ah_engine::meshw::ident::primary_workspace_id(&wt).unwrap();
                f.row_s(&k, "z-live", &wt, Some("s1"));
                f.row_s(&k, &anchor, &wt, None);
                f.touch(&k, "z-live", 5_000); // the live row is the freshest, so it wins the fallback too
                (k.clone(), vec![k, wt, anchor])
            },
            retired: &["N2"],
            forwarded: 0,
            deferred: 0,
            whole: true,
        },
        FoldCase {
            name: "two live sessions: the survivor needs liveness, Node's",
            build: |f| {
                let (wt, k) = s6_base(f);
                f.row_s(&k, "w-a", &wt, Some("s1"));
                f.row_s(&k, "w-b", &wt, Some("s2"));
                (k.clone(), pair(&k, &wt))
            },
            retired: &[],
            forwarded: 0,
            deferred: 1,
            whole: false,
        },
        FoldCase {
            name: "an anchor with a real session and no descriptor needs dormancy, Node's",
            build: |f| {
                let (wt, k) = s6_base(f);
                let anchor = ah_engine::meshw::ident::primary_workspace_id(&wt).unwrap();
                f.row_s(&k, "w-live", &wt, Some("s1"));
                f.row_s(&k, &anchor, &wt, Some("s9"));
                (k.clone(), vec![k, wt, anchor])
            },
            retired: &[],
            forwarded: 0,
            deferred: 1,
            whole: false,
        },
        FoldCase {
            name: "unread mail without floor rows needs the legacy cursor import, Node's",
            build: |f| {
                let (wt, k) = s6_base(f);
                f.row_s(&k, "w-live", &wt, Some("s1"));
                f.row_s(&k, "w-ph", &wt, None);
                f.msg(&k, "w-ph", 10, "one", "snd");
                (k.clone(), pair(&k, &wt))
            },
            retired: &[],
            forwarded: 0,
            deferred: 1,
            whole: false,
        },
    ]
}

/// The post-state with the home's own path and the case's path-dependent names replaced, without logs, locks or scratch.
fn canon(f: &Fix, needles: &[String]) -> std::collections::BTreeMap<String, String> {
    let home = f.home.to_string_lossy().into_owned();
    let fix_up = |t: &str| {
        let mut o = t.replace(&home, "HOME");
        for (i, nd) in needles.iter().enumerate() {
            o = o.replace(nd.as_str(), &format!("N{i}"));
        }
        o
    };
    norm::dump(&f.home)
        .into_iter()
        .filter(|(k, _)| !k.starts_with(".anti-hall/logs") && !k.starts_with(".anti-hall/work") && !k.contains("/locks/") && !k.starts_with("repos/") && !k.starts_with(".git"))
        .map(|(k, v)| (fix_up(&k), fix_up(&v)))
        .collect()
}

/// Node's whole `foldMeshDuplicates` on a home, with the clock pinned.
fn node_whole_fold(f: &Fix, key: &str) -> Value {
    let code = "const NOW=Number(process.argv[4]);Date.now=()=>NOW;process.env.HOME=process.argv[2];process.env.USERPROFILE=process.argv[2];process.env.ANTI_HALL_LOG_DIR=process.argv[2]+'/.anti-hall/logs';const F=require(process.argv[1]+'/scripts/devswarm-lib/fold.js');console.log(JSON.stringify(F.foldMeshDuplicates(process.argv[2],{repoKey:process.argv[3]})))";
    let o = Command::new("node").args(["-e", code, f.root.to_str().unwrap(), f.home.to_str().unwrap(), key, &NOW.to_string()]).output().unwrap();
    assert!(o.status.success(), "{}", String::from_utf8_lossy(&o.stderr));
    serde_json::from_str(String::from_utf8_lossy(&o.stdout).lines().last().unwrap()).unwrap()
}

#[test]
fn s6_fold_mesh_duplicates_matches_node_for_every_group_shape() {
    if !have("node") || !have("git") {
        return;
    }
    let t = Tally::new("S6.fold-mesh-duplicates");
    for c in s6_cases() {
        let f = fix6("s6");
        let (key, needles) = (c.build)(&f);
        let name_of = |s: &str| if let Some(i) = s.strip_prefix('N').and_then(|d| d.parse::<usize>().ok()) { needles[i].clone() } else { s.to_string() };
        let end = fold::run(&f.ctx(), &System::configured(), &key, &Hooks::none()).unwrap_or_else(|d| panic!("{}: deferred {d:?}", c.name));
        assert_eq!(end.verdict, Verdict::Agreed, "{}: {:?}", c.name, end.verdict);
        let want: Vec<String> = c.retired.iter().map(|s| name_of(s)).collect();
        assert_eq!(end.result.retired, want, "{}: retired (deferred {:?}, verdict {:?})", c.name, end.deferred, end.verdict);
        assert_eq!(end.result.forwarded, c.forwarded, "{}: forwarded (deferred {:?} / {:?})", c.name, end.deferred, fold::plan_fold(&f.ctx(), &key).map(|p| p.deferred));
        let plan = fold::plan_fold(&f.ctx(), &key).unwrap();
        assert_eq!(plan.deferred.len(), c.deferred, "{}: deferred groups {:?}", c.name, plan.deferred);
        if c.deferred == 0 {
            // the engine's whole pass equals Node's whole function on a twin home, and a second pass writes nothing
            assert!(end.deferred.is_empty(), "{}: {:?}", c.name, end.deferred);
            if c.whole {
                let twin = fix6("s6-twin");
                let (tkey, tneedles) = (c.build)(&twin);
                let node = node_whole_fold(&twin, &tkey);
                assert_eq!(node["ok"], serde_json::json!(true), "{}: {node}", c.name);
                let mut got: Vec<String> = node["retired"].as_array().unwrap().iter().map(|v| v.as_str().unwrap().to_string()).collect();
                let mut mine = end.result.retired.clone();
                got.sort();
                mine.sort();
                assert_eq!(got.len(), mine.len(), "{}: node retired {node}", c.name);
                assert_eq!(node["forwarded"].as_i64().unwrap(), end.result.forwarded, "{}", c.name);
                assert_eq!(node["folded"].as_i64().unwrap(), end.result.folded, "{}", c.name);
                assert_eq!(canon(&f, &needles), canon(&twin, &tneedles), "{}: engine and Node ended in different states", c.name);
            }
            let before = f.snapshot();
            let again = fold::run(&f.ctx(), &System::configured(), &key, &Hooks::none()).unwrap();
            assert_eq!(again.verdict, Verdict::Agreed, "{} (second pass)", c.name);
            assert!(again.result.retired.is_empty() && again.result.forwarded == 0, "{}: second pass acted", c.name);
            assert_eq!(f.snapshot(), before, "{}: the second pass wrote something", c.name);
        } else {
            // a deferred group is untouched
            assert!(end.result.retired.is_empty() && end.result.forwarded == 0, "{}", c.name);
        }
        t.case(c.deferred == 0);
    }
    t.print();
}

#[test]
fn s6_the_engine_switch_is_off_by_default_and_a_deferred_store_writes_nothing() {
    let f = fix("s6-off");
    let (wt, k) = s6_base(&f);
    f.row_s(&k, "w-live", &wt, Some("s1"));
    f.row_s(&k, "w-ph", &wt, None);
    let before = f.snapshot();
    assert!(fold::run(&f.ctx(), &System::configured(), &k, &Hooks::none()).is_err(), "mode node hands the store to Node");
    assert_eq!(f.snapshot(), before);
    // a missing store: nothing to fold, and nothing is created
    let g = fix6("s6-none");
    let end = fold::run(&g.ctx(), &System::configured(), "no-such-store", &Hooks::none()).unwrap();
    assert!(end.result.retired.is_empty());
    assert!(!g.home.join(g.ds("store/no-such-store")).exists());
}

#[test]
fn s6_ghost_rows_match_nodes_ghost_registry_rows() {
    if !have("node") || !have("git") {
        return;
    }
    let f = fix6("s6-ghost");
    let (wt, k) = s6_base(&f);
    f.row_s(&k, "g-old", &wt, None); // a ghost
    f.row_s(&k, "g-young", &wt, None);
    f.touch(&k, "g-young", NOW - 1_000);
    f.row_s(&k, "g-sess", &wt, Some("unclaimed:x"));
    f.row_s(&k, "g-desc", &wt, None);
    f.descriptor("g-desc", &desc_json("g-desc", &wt, "", None, None));
    f.row_s(&k, "g-beat", &wt, None);
    f.put(&f.ds("heartbeats/g-beat.json"), "{\"ts\":1}");
    f.row_s(&k, "g-read", &wt, None);
    f.floors(&k, "g-read", 3);
    f.row_s(&k, "g-file", &wt, None);
    f.put(&f.ds("cursors/g-file.json"), "0");
    let ids: Vec<String> = ["g-old", "g-young", "g-sess", "g-desc", "g-beat", "g-read", "g-file"].iter().map(|s| s.to_string()).collect();
    let (got, verdict) = fold::ghost_ids(&f.ctx(), &System::configured(), &k, &ids).unwrap();
    assert_eq!(verdict, Verdict::Agreed);
    assert_eq!(got, vec!["g-old".to_string()]);
    // the age bar comes from the environment, as in Node
    let mut env = HashMap::new();
    env.insert("ANTIHALL_DEVSWARM_GHOST_ROW_MAX_AGE_H".to_string(), "2".to_string());
    assert_eq!(fold::ghost_age_ms(&env).unwrap(), 7_200_000.0);
    env.insert("ANTIHALL_DEVSWARM_GHOST_ROW_MAX_AGE_H".to_string(), "0x10".to_string());
    assert!(fold::ghost_age_ms(&env).is_err());
}

#[test]
fn s6_retire_worktree_duplicates_matches_node() {
    if !have("node") || !have("git") {
        return;
    }
    let t = Tally::new("S6.retire-worktree-duplicates");
    type Build = fn(&Fix) -> (String, String);
    let cases: Vec<(&str, Build, Option<Value>)> = vec![
        ("phantoms fold into the caller", |f| {
            let (wt, k) = s6_base(f);
            f.row_s(&k, "w-keep", &wt, Some("s1"));
            f.row_s(&k, "w-ph", &wt, None);
            f.floors(&k, "w-ph", 0);
            f.msg(&k, "w-ph", 10, "m", "snd");
            (wt, k)
        }, Some(serde_json::json!({"retired": ["w-ph"], "forwarded": 1}))),
        ("a distinct live child is forwarded to and left", |f| {
            let (wt, k) = s6_base(f);
            f.row_s(&k, "w-keep", &wt, Some("s1"));
            f.row_s(&k, "w-kid", &wt, Some("s2"));
            f.descriptor("w-kid", &desc_json("w-kid", &wt, "s2", None, None));
            f.floors(&k, "w-kid", 0);
            f.msg(&k, "w-kid", 10, "m", "snd");
            (wt, k)
        }, Some(serde_json::json!({"retired": [], "forwarded": 1, "left": ["w-kid"]}))),
        ("nothing to fold", |f| {
            let (wt, k) = s6_base(f);
            f.row_s(&k, "w-keep", &wt, Some("s1"));
            (wt, k)
        }, None),
    ];
    for (name, build, want) in cases {
        let f = fix6("s6-dup");
        let (wt, _k) = build(&f);
        let run = dup::retire_worktree_duplicates(&f.ctx(), &System::configured(), &wt, "w-keep", &wt, &Hooks::none()).unwrap_or_else(|d| panic!("{name}: deferred {d:?}"));
        assert_eq!(run.verdict, Verdict::Agreed, "{name}: {:?}", run.verdict);
        assert!(run.deferred.is_empty(), "{name}: {:?}", run.deferred);
        assert_eq!(run.result, want, "{name}");
        t.case(true);
    }
    t.print();
}

#[test]
fn s6_retire_archived_worktree_group_matches_node() {
    if !have("node") || !have("git") {
        return;
    }
    let t = Tally::new("S6.retire-archived-worktree-group");
    type Build = fn(&Fix) -> (String, String);
    let cases: Vec<(&str, Build, Value)> = vec![
        ("one drainable sibling takes the mail", |f| {
            let (wt, k) = s6_base(f);
            f.row_s(&k, "w-live", &wt, Some("s1"));
            f.descriptor("w-live", &desc_json("w-live", &wt, "s1", None, None));
            f.row_s(&k, "w-ph", &wt, None);
            f.floors(&k, "w-ph", 0);
            f.msg(&k, "w-ph", 10, "m", "snd");
            (wt, k)
        }, serde_json::json!({"retired": ["w-ph"], "forwarded": 1, "left": [{"id": "w-live", "reason": "live-descriptor"}], "forwardedTo": "w-live"})),
        ("no drainable sibling: phantoms fold into the archived row", |f| {
            let (wt, k) = s6_base(f);
            f.row_s(&k, "w-arch", &wt, None);
            f.row_s(&k, "w-ph", &wt, None);
            f.floors(&k, "w-ph", 0);
            f.msg(&k, "w-ph", 10, "m", "snd");
            (wt, k)
        }, serde_json::json!({"retired": ["w-ph"], "forwarded": 1, "left": [], "forwardedTo": "w-arch"})),
        ("the archived row is already gone: the survivor is missing", |f| {
            let (wt, k) = s6_base(f);
            f.row_s(&k, "w-ph", &wt, None);
            f.floors(&k, "w-ph", 0);
            f.msg(&k, "w-ph", 10, "m", "snd");
            (wt, k)
        }, serde_json::json!({"retired": [], "forwarded": 0, "left": [{"id": "w-ph", "reason": "survivor-gone"}], "forwardedTo": "w-arch"})),
    ];
    for (name, build, want) in cases {
        let f = fix6("s6-arch");
        let (wt, k) = build(&f);
        let run = archived::retire_archived_worktree_group(&f.ctx(), &System::configured(), &k, "w-arch", &wt, &Hooks::none()).unwrap_or_else(|d| panic!("{name}: deferred {d:?}"));
        assert_eq!(run.verdict, Verdict::Agreed, "{name}: {:?} {}", run.verdict, run.result);
        assert!(run.deferred.is_empty(), "{name}: {:?}", run.deferred);
        assert_eq!(run.result, want, "{name}");
        t.case(true);
    }
    t.print();
}

#[test]
fn s6_forward_archived_orphan_unread_matches_node() {
    if !have("node") || !have("git") {
        return;
    }
    let t = Tally::new("S6.forward-archived-orphan-unread");
    let day = 86_400_000;
    let max_age = 30.0 * day as f64;
    // a fresh and a stale unread, a non-forwardable one, and a read one below the floor
    let f = fix6("s6-fwd");
    let (wt, k) = s6_base(&f);
    f.row_s(&k, "w-live", &wt, Some("s1"));
    f.floors(&k, "w-arch", 1);
    f.msg(&k, "w-arch", NOW - 100 * day, "already read", "snd");
    f.msg(&k, "w-arch", NOW - day, "fresh", "snd");
    f.msg(&k, "w-arch", NOW - 40 * day, "stale", "snd");
    f.msg(&k, "w-arch", NOW - day + 1, "native", "");
    let (res, verdict, ends) = archived::forward_archived_orphan_unread(&f.ctx(), &System::configured(), &k, "w-arch", "w-live", max_age, &Hooks::none()).unwrap();
    assert_eq!(verdict, Verdict::Agreed);
    assert_eq!((res.forwarded, res.stale, res.status.as_str()), (1, 1, "ok"));
    assert!(ends.iter().all(|e| *e == UnitEnd::Applied));
    assert_eq!(f.msgs_in(&k, "w-live"), vec!["[forwarded from archived w-arch] fresh".to_string()]);
    t.case(true);
    // nothing is deleted from the archived partition, and a second pass adds nothing
    assert_eq!(f.msgs_in(&k, "w-arch").len(), 4);
    let (again, v2, _) = archived::forward_archived_orphan_unread(&f.ctx(), &System::configured(), &k, "w-arch", "w-live", max_age, &Hooks::none()).unwrap();
    assert_eq!((again.forwarded, v2), (0, Verdict::Agreed));
    t.case(true);
    // a survivor that is not registered answers `gone` and writes nothing
    let g = fix6("s6-fwd2");
    let (wt, k) = s6_base(&g);
    g.row_s(&k, "w-other", &wt, Some("s1"));
    g.floors(&k, "w-arch", 0);
    g.msg(&k, "w-arch", NOW - day, "fresh", "snd");
    let (res, verdict, _) = archived::forward_archived_orphan_unread(&g.ctx(), &System::configured(), &k, "w-arch", "w-live", max_age, &Hooks::none()).unwrap();
    assert_eq!((res.forwarded, res.status.as_str(), verdict), (0, "gone", Verdict::Agreed));
    assert!(g.msgs_in(&k, "w-live").is_empty());
    t.case(true);
    t.print();
}

// ---- S6 crash safety: SIGKILL at each op boundary of a fold, then Node's next fold converges

fn crash_fold_fixture(f: &Fix) -> String {
    let (wt, k) = s6_base(f);
    f.row_s(&k, "w-live", &wt, Some("s1"));
    f.row_s(&k, "w-ph", &wt, None);
    f.floors(&k, "w-ph", 0);
    f.msg(&k, "w-ph", 10, "one", "snd");
    f.msg(&k, "w-ph", 11, "two", "snd");
    k
}

fn fold_state(f: &Fix, key: &str) -> (Vec<String>, Vec<(String, String)>, Vec<(String, String, i64)>) {
    let c = f.db(key);
    let rows = f.rows(key);
    let mut st = c.prepare("SELECT workspace_id, hash FROM messages ORDER BY hash").unwrap();
    let msgs: Vec<(String, String)> = st.query_map([], |r| Ok((r.get(0)?, r.get(1)?))).unwrap().flatten().collect();
    let mut st = c.prepare("SELECT partition, ns, value FROM reader_cursors ORDER BY partition, ns, reader").unwrap();
    let cur: Vec<(String, String, i64)> = st.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get::<_, f64>(2)? as i64))).unwrap().flatten().collect();
    (rows, msgs, cur)
}

#[test]
fn s6_a_sigkill_at_every_fold_op_boundary_loses_no_mail_and_nodes_next_fold_converges() {
    if !have("node") || !have("git") {
        return;
    }
    let reference = fix6("s6-crash-ref");
    let rkey = crash_fold_fixture(&reference);
    let r = fold::run(&reference.ctx(), &System::configured(), &rkey, &Hooks::none()).unwrap();
    assert_eq!(r.verdict, Verdict::Agreed);
    let (rrows, rmsgs, rcur) = fold_state(&reference, &rkey);
    assert_eq!(rrows, vec!["w-live".to_string()]);
    let rhashes: std::collections::BTreeSet<String> = rmsgs.iter().map(|m| m.1.clone()).collect();
    let mut points: Vec<String> = Vec::new();
    for w in ["before", "after"] {
        for i in 0..7 {
            points.push(format!("fold:w-ph:{i}:{w}"));
        }
        points.push(format!("derive-summary:0:{w}"));
    }
    let mut killed = 0;
    let mut kinds = std::collections::BTreeSet::new();
    for point in &points {
        let f = fix6("s6-crash");
        let k = crash_fold_fixture(&f);
        let before: std::collections::BTreeSet<String> = fold_state(&f, &k).1.iter().map(|m| m.1.clone()).collect();
        let o = Command::new(std::env::current_exe().unwrap())
            .args(["--exact", "crash_child", "--nocapture", "--test-threads=1"])
            .env("RECON_CRASH_HOME", &f.home)
            .env("RECON_CRASH_AT", point)
            .env("RECON_CRASH_KEY", &k)
            .env("RECON_CRASH_KIND", "fold")
            .output()
            .unwrap();
        use std::os::unix::process::ExitStatusExt;
        if o.status.signal() != Some(9) {
            continue;
        }
        killed += 1;
        kinds.insert(point.split(':').nth(2).map(str::to_string).unwrap_or_default());
        let (rows, msgs, cur) = fold_state(&f, &k);
        // no mail is lost and none appears twice
        let hashes: std::collections::BTreeSet<String> = msgs.iter().map(|m| m.1.clone()).collect();
        assert!(before.is_subset(&hashes), "{point}: a message hash disappeared");
        assert_eq!(hashes.len(), msgs.len(), "{point}: a hash appears twice");
        // each registry row is whole, and the survivor is never the one removed
        assert!(rows.contains(&"w-live".to_string()), "{point}");
        // a cursor never passes what was forwarded
        let forwarded = msgs.iter().filter(|m| m.0 == "w-live").count() as i64;
        for (p, ns, v) in &cur {
            if p == "w-ph" && ns == "store" {
                assert!(*v <= forwarded, "{point}: cursor {v} passed the forwarded prefix {forwarded}");
            }
        }
        // Node's own next fold converges to the uninterrupted result
        let node = node_whole_fold(&f, &k);
        assert_eq!(node["ok"], serde_json::json!(true), "{point}: {node}");
        let (rows2, msgs2, cur2) = fold_state(&f, &k);
        assert_eq!(rows2, rrows, "{point}: converged registry");
        let h2: std::collections::BTreeSet<String> = msgs2.iter().map(|m| m.1.clone()).collect();
        assert_eq!(h2, rhashes, "{point}: converged mail");
        assert_eq!(msgs2.len(), rmsgs.len(), "{point}: converged mail count");
        assert_eq!(cur2.iter().filter(|c| c.0 == "w-ph" && c.1 == "store").map(|c| c.2).max(), rcur.iter().filter(|c| c.0 == "w-ph" && c.1 == "store").map(|c| c.2).max(), "{point}: converged cursor");
    }
    assert!(killed >= 10, "the kill points were reached ({killed})");
    // the four named points: forward (0 is the guard, 1 the forward), cursor raise (2), tombstone (op after the journal lines), summary
    for want in ["1", "2", "5", "0"] {
        assert!(kinds.contains(want), "kill point {want} was exercised: {kinds:?}");
    }
}

/// Read-only survey: what the planner would do on a snapshot of a real home (`RECON_SNAPSHOT_HOME`, made with
/// `tests/recon_support/snapshot.js`). It plans every store and prints the tally; nothing is written or applied.
#[test]
#[ignore = "needs RECON_SNAPSHOT_HOME"]
fn s6_survey_plans_over_a_snapshot() {
    let Ok(home) = std::env::var("RECON_SNAPSHOT_HOME") else { return };
    init_defaults();
    let home = PathBuf::from(home);
    let mut env: HashMap<String, String> = HashMap::new();
    env.insert("HOME".into(), home.to_string_lossy().into_owned());
    let st = Settings { home: home.to_string_lossy().into_owned(), env };
    let root = ah_engine::defaults::root().unwrap();
    let ctx = Ctx { home: &home, root: &root, st: &st, now: NOW, engine_pokes: false };
    let mut reasons: std::collections::BTreeMap<String, u32> = std::collections::BTreeMap::new();
    let (mut stores, mut with_work, mut groups_deferred, mut units, mut store_deferred) = (0, 0, 0, 0, 0);
    for e in std::fs::read_dir(home.join(".anti-hall/devswarm/store")).unwrap().flatten() {
        let key = e.file_name().to_string_lossy().into_owned();
        stores += 1;
        match fold::plan_fold(&ctx, &key) {
            Err(d) => {
                store_deferred += 1;
                *reasons.entry(format!("store:{}", d.0.split(':').next().unwrap_or(""))).or_default() += 1;
            }
            Ok(p) => {
                if !p.job.units.is_empty() || !p.deferred.is_empty() || !p.result.needs_attention.is_empty() {
                    with_work += 1;
                }
                units += p.job.units.len();
                for (_, why) in &p.deferred {
                    groups_deferred += 1;
                    *reasons.entry(format!("group:{why}")).or_default() += 1;
                }
            }
        }
    }
    println!("SURVEY stores={stores} with_work={with_work} planned_units={units} groups_deferred={groups_deferred} stores_deferred={store_deferred}");
    for (k, v) in reasons {
        println!("SURVEY   {k} = {v}");
    }
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
    assert!(checked >= 7);
    // the SQL the ported modules use lives in sql.rs under the RECON_ prefix
    let sql = std::fs::read_to_string(Path::new(env!("CARGO_MANIFEST_DIR")).join("src/sql.rs")).unwrap();
    for line in sql.lines().filter(|l| l.contains("pub const RECON_")) {
        assert!(!re.is_match(line), "{line}");
    }
    // and no op of the vocabulary can address a message row
    let ops = std::fs::read_to_string(dir.join("mod.rs")).unwrap();
    assert!(!ops.contains("Message"));
}
