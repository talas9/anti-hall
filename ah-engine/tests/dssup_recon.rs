//! The reconcile port, slices S0 to S2, against Node's own functions.
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
use ah_engine::dssup::recon::{Hooks, Op, UnitEnd, apply, heal, norm, orphans, side};
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
