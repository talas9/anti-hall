#![allow(
    dead_code,
    clippy::type_complexity,
    clippy::collapsible_if,
    clippy::needless_range_loop,
    clippy::useless_vec,
    clippy::regex_creation_in_loops,
    clippy::let_underscore_must_use
)]
//! The reconcile port, slice S8: the four deferred stage wrappers run by the engine item by item
//! (`devswarm_sup.sweep_tail_mode = engine`) against Node's own `runDeferredStage` on twin homes.
//!
//! Every stage is seeded on two identical scratch homes, one left in Node mode and one in engine mode; after one supervisor tick
//! the two homes must hold the same state (timestamps masked) and the same `update-sweep-state.json` marker. Crash tests kill a
//! child process between items. The static test greps every reconcile module for a message-row mutation.
#![allow(clippy::unwrap_used, clippy::expect_used)] // a test crate: a panic is the failure report

use ah_engine::checks::git::util::Settings;
use ah_engine::checks::guardkit::ojson::OVal;
use ah_engine::dsact::runner::System;
use ah_engine::dssup::recon::{Hooks, norm};
use ah_engine::dssup::tick::Ctx;
use ah_engine::meshw::store::{MeshStore, RegistryRow};
use std::collections::{BTreeMap, HashMap};
use std::path::{Path, PathBuf};
use std::process::Command;

fn have(bin: &str) -> bool {
    Command::new(bin).arg("--version").output().is_ok_and(|o| o.status.success())
}

fn node_ready() -> bool {
    have("node") && have("git")
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

fn now_ms() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis() as i64
}

fn fix(tag: &str) -> Fix {
    init_defaults();
    static N: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let home = PathBuf::from(std::env::var("HOME").unwrap()).join(".anti-hall/scratch/recon-tests").join(format!(
        "s8-{tag}-{}-{}",
        std::process::id(),
        N.fetch_add(1, std::sync::atomic::Ordering::SeqCst)
    ));
    let _ = std::fs::remove_dir_all(&home);
    std::fs::create_dir_all(&home).unwrap();
    let mut env: HashMap<String, String> = HashMap::new();
    env.insert("HOME".into(), home.to_string_lossy().into_owned());
    let st = Settings { home: home.to_string_lossy().into_owned(), env };
    Fix { home, st, root: ah_engine::defaults::root().unwrap() }
}

impl Fix {
    fn ctx(&self) -> Ctx<'_> {
        Ctx { home: &self.home, root: &self.root, st: &self.st, now: now_ms(), engine_pokes: false }
    }
    fn engine(mut self) -> Fix {
        self.st.env.insert("ANTIHALL_DEVSWARM_SWEEP_TAIL_MODE".into(), "engine".into());
        self
    }
    fn ds(&self, rel: &str) -> String {
        format!(".anti-hall/devswarm/{rel}")
    }
    fn put(&self, rel: &str, text: &str) {
        let p = self.home.join(rel);
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(p, text).unwrap();
    }
    fn read(&self, rel: &str) -> Option<String> {
        std::fs::read_to_string(self.home.join(rel)).ok()
    }
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
    fn row(&self, key: &str, id: &str, wt: &str, sid: Option<&str>) {
        let st = self.store(key);
        let r = RegistryRow {
            id: id.into(),
            worktree_path: Some(wt.into()),
            session_id: sid.map(str::to_string),
            inbox_path: None,
            cursor_path: None,
            nudge_command: None,
        };
        assert!(st.upsert_registry(&r, 1_000, |_, _| true).unwrap());
    }
    fn msg(&self, key: &str, id: &str) {
        self.store(key).append_message(id, 5, Some(&format!("h-{id}")), "body").unwrap();
    }
    fn desc(&self, id: &str, wt: &str, sid: &str) -> String {
        format!(
            "{{\"id\":\"{id}\",\"worktreePath\":\"{wt}\",\"sessionId\":\"{sid}\",\"inboxPath\":null,\"cursorPath\":null,\"nudgeCommand\":null,\"repoId\":null}}"
        )
    }
    fn live(&self, id: &str, wt: &str, sid: &str) {
        self.put(&self.ds(&format!("workspaces/{id}.json")), &self.desc(id, wt, sid));
    }
    fn tomb(&self, id: &str, wt: &str, sid: &str) {
        self.put(&self.ds(&format!("archived/{id}.json")), &self.desc(id, wt, sid));
    }
    /// The whole home, timestamps masked, with the files that legitimately differ between the two modes left out.
    fn snapshot(&self) -> BTreeMap<String, String> {
        let ts = regex::Regex::new(r"\b1[0-9]{12}\b").unwrap();
        norm::dump(&self.home)
            .into_iter()
            .filter(|(k, _)| !k.starts_with(".anti-hall/logs/") && !k.starts_with("repos/") && !k.contains("/witness"))
            .map(|(k, v)| (k, ts.replace_all(&v, "T").into_owned()))
            .collect()
    }
}

const STAGES: [&str; 4] = ["fold-all-stores", "heal-orphan-partitions", "fold-archived-rows", "heal-registry-rows"];
const KEYS: [&str; 4] = ["foldAllStores", "healOrphanPartitions", "", "healRegistry"];

/// Seed `stage` with work in the store `k`; the rotation points at the stage and its marker says the stores are pending.
fn seed(f: &Fix, stage: usize, stores: &[(&str, &str)]) {
    f.put(&f.ds("deferred-sweep-state.json"), &format!("{{\"nextStageIndex\":{stage}}}"));
    let pending: Vec<String> = stores.iter().map(|(k, _)| format!("\"{k}\"")).collect();
    for (k, wt) in stores {
        match stage {
            0 => {
                f.row(k, "w-live", wt, Some("s1"));
                f.row(k, "w-ph", wt, None);
            }
            1 => {
                f.msg(k, "o1");
                f.live("o1", wt, "so1");
            }
            2 => {
                f.tomb("a1", wt, "s1");
                f.row(k, "a1", wt, Some("s1"));
            }
            _ => {
                f.row(k, "w1", wt, Some("s1"));
                f.put(&f.ds("workspaces/w1.json"), &f.desc("w1", wt, "s1"));
            }
        }
    }
    if stage == 2 {
        let buckets: Vec<String> = stores.iter().map(|(k, _)| format!("\"{k}\":[\"a1\"]")).collect();
        f.put(&f.ds("fold-archived-resume.json"), &format!("{{\"buckets\":{{{}}},\"ts\":1}}", buckets.join(",")));
    } else {
        f.put(
            ".anti-hall/update-sweep-state.json",
            &format!("{{\"{}\":{{\"pendingVersion\":\"9.9.9\",\"pendingHashes\":[{}]}}}}", KEYS[stage], pending.join(",")),
        );
    }
}

fn two_repos(f: &Fix, n: usize) -> Vec<(String, String)> {
    (0..n)
        .map(|i| {
            let wt = f.repo(&format!("p{i}"));
            (f.key_of(&wt), wt)
        })
        .collect()
}

fn refs(v: &[(String, String)]) -> Vec<(&str, &str)> {
    v.iter().map(|(a, b)| (a.as_str(), b.as_str())).collect()
}

#[test]
fn every_stage_ends_in_the_same_state_in_engine_mode_as_in_node_mode() {
    if !node_ready() {
        return;
    }
    let mut engine_items = 0;
    for stage in 0..4 {
        let node_home = fix(&format!("e2e-node-{stage}"));
        let eng_home = fix(&format!("e2e-eng-{stage}")).engine();
        // twin repositories must have the same paths in both homes for the snapshots to compare, so seed with the SAME relative layout
        // and compare after replacing each home's own path
        let (a, b) = (two_repos(&node_home, 2), two_repos(&eng_home, 2));
        seed(&node_home, stage, &refs(&a));
        seed(&eng_home, stage, &refs(&b));
        let runner = System::configured();
        let nrec = ah_engine::dssup::deferred::duty(&node_home.ctx(), &runner);
        let erec = ah_engine::dssup::deferred::duty(&eng_home.ctx(), &runner);
        assert!(nrec.get("engine").is_none(), "node mode: {nrec}");
        let items = erec["engine"]["items"].as_array().unwrap_or_else(|| panic!("engine mode ran no item: {erec}"));
        assert!(!items.is_empty(), "{erec}");
        engine_items += items.iter().filter(|i| i["by"] == "engine").count();
        // same final state
        let norm_home = |f: &Fix, repos: &[(String, String)]| {
            let own = f.home.to_string_lossy().into_owned();
            f.snapshot()
                .into_iter()
                .map(|(k, v)| (k.replace(&own, "H"), v.replace(&own, "H")))
                .map(|(k, v)| {
                    let mut v = v;
                    for (i, (key, wt)) in repos.iter().enumerate() {
                        v = v.replace(wt.as_str(), &format!("WT{i}")).replace(key.as_str(), &format!("K{i}"));
                    }
                    (k, v)
                })
                .collect::<BTreeMap<_, _>>()
        };
        let (mut ns, mut es) = (norm_home(&node_home, &a), norm_home(&eng_home, &b));
        // the stores are named by their key, which differs between the two homes
        let rename = |m: &mut BTreeMap<String, String>, repos: &[(String, String)]| {
            *m = std::mem::take(m)
                .into_iter()
                .map(|(mut k, v)| {
                    for (i, (key, _)) in repos.iter().enumerate() {
                        k = k.replace(key.as_str(), &format!("K{i}"));
                    }
                    (k, v)
                })
                .collect();
        };
        rename(&mut ns, &a);
        rename(&mut es, &b);
        assert_eq!(ns.keys().collect::<Vec<_>>(), es.keys().collect::<Vec<_>>(), "stage {}: the same files", STAGES[stage]);
        for (k, v) in &ns {
            assert_eq!(v, &es[k], "stage {}: {k} differs between Node mode and engine mode", STAGES[stage]);
        }
        // the result Node's stage function returned and the engine's say the same
        let (nr, er) = (&nrec["detail"]["result"], &erec["detail"]["result"]);
        for field in ["attempted", "errors", "budgetExhausted"] {
            assert_eq!(nr.get(field), er.get(field), "stage {} result.{field}\nnode:   {nr}\nengine: {er}", STAGES[stage]);
        }
        println!("PARITY S8.{} files={} engine_items={}", STAGES[stage], ns.len(), items.iter().filter(|i| i["by"] == "engine").count());
    }
    assert!(engine_items >= 4, "the engine did items itself ({engine_items})");
}

fn marker(f: &Fix) -> OVal {
    OVal::parse(&f.read(".anti-hall/update-sweep-state.json").unwrap()).unwrap()
}

#[test]
fn the_marker_is_written_like_nodes_with_a_resume_list_and_then_a_completed_stamp() {
    if !node_ready() {
        return;
    }
    let mut f = fix("marker").engine();
    let repos = two_repos(&f, 2);
    seed(&f, 3, &refs(&repos));
    // a budget of zero stops after the first item (Node: `i > 0 && elapsed >= budget`)
    f.st.env.insert("ANTIHALL_SUPERVISOR_SWEEP_BUDGET_MS".into(), "0".into());
    let r = System::configured();
    let rec = ah_engine::dssup::deferred::duty(&f.ctx(), &r);
    let res = &rec["detail"]["result"];
    assert_eq!((res["budgetExhausted"].as_bool(), res["pending"].as_u64()), (Some(true), Some(1)), "{rec}");
    let m = marker(&f);
    let e = m.get("healRegistry").unwrap();
    assert_eq!(
        e.stringify(),
        format!("{{\"pendingVersion\":\"9.9.9\",\"pendingHashes\":[\"{}\"],\"lastCompletedHash\":\"{}\",\"completedVersion\":null}}", repos[1].0, repos[0].0)
    );
    // the next tick (rotation back on the stage) resumes the list and stamps the version
    f.put(&f.ds("deferred-sweep-state.json"), "{\"nextStageIndex\":3}");
    f.st.env.remove("ANTIHALL_SUPERVISOR_SWEEP_BUDGET_MS");
    let rec = ah_engine::dssup::deferred::duty(&f.ctx(), &r);
    assert_eq!(rec["detail"]["result"]["budgetExhausted"], false, "{rec}");
    let e = marker(&f);
    let e = e.get("healRegistry").unwrap();
    assert!(matches!(e.get("completedVersion"), Some(OVal::Str(v)) if v == "9.9.9"), "{}", e.stringify());
    assert!(matches!(e.get("pendingHashes"), Some(OVal::Arr(a)) if a.is_empty()));
    assert!(matches!(e.get("pendingVersion"), Some(OVal::Null)));
    assert!(e.get("completedTs").is_some());
}

#[test]
fn a_stage_without_a_usable_resume_list_is_nodes_whole() {
    if !node_ready() {
        return;
    }
    let f = fix("nolist").engine();
    f.put(&f.ds("deferred-sweep-state.json"), "{\"nextStageIndex\":3}");
    f.put(".anti-hall/update-sweep-state.json", "{\"healRegistry\":{\"pendingVersion\":\"9.9.9\",\"pendingHashes\":[1,2]}}");
    let before = f.read(".anti-hall/update-sweep-state.json");
    assert!(ah_engine::dssup::recon::stage::run(&f.ctx(), &System::configured(), STAGES[3], &Hooks::none()).is_none());
    assert_eq!(f.read(".anti-hall/update-sweep-state.json"), before, "nothing written");
    let g = fix("nomode");
    seed(&g, 3, &refs(&two_repos(&g, 1)));
    assert!(ah_engine::dssup::recon::stage::run(&g.ctx(), &System::configured(), STAGES[3], &Hooks::none()).is_none(), "node mode: the engine takes no stage");
}

#[test]
fn an_item_node_must_do_is_handed_to_nodes_own_function_and_still_counts() {
    if !node_ready() {
        return;
    }
    // an orphan whose family already has registry rows is the fold's work, which the orphan heal hands back
    let f = fix("handback").engine();
    let repos = two_repos(&f, 1);
    let (k, wt) = (&repos[0].0, &repos[0].1);
    f.put(&f.ds("deferred-sweep-state.json"), "{\"nextStageIndex\":1}");
    f.row(k, "w-live", wt, Some("s1"));
    f.live("w-live", wt, "s1");
    f.msg(k, "o1");
    f.live("o1", wt, "so1");
    f.put(".anti-hall/update-sweep-state.json", &format!("{{\"healOrphanPartitions\":{{\"pendingVersion\":\"9.9.9\",\"pendingHashes\":[\"{k}\"]}}}}"));
    let rec = ah_engine::dssup::deferred::duty(&f.ctx(), &System::configured());
    let items = rec["engine"]["items"].as_array().unwrap();
    assert_eq!(items.len(), 1, "{rec}");
    assert_eq!(rec["detail"]["result"]["attempted"], true, "{rec}");
    println!("handback item: {}", items[0]);
}

// ---- crash safety -----------------------------------------------------------------------------------------------------------

fn kill_hook(point: &str) -> impl Fn(&str) + '_ {
    move |name| {
        if name == point {
            // SAFETY: SIGKILL of this very process, the point of the crash test
            unsafe { libc::kill(libc::getpid(), libc::SIGKILL) };
        }
    }
}

#[test]
fn crash_child() {
    // the child half of the crash tests: does nothing unless the parent set the environment
    let (Ok(home), Ok(at)) = (std::env::var("S8_CRASH_HOME"), std::env::var("S8_CRASH_AT")) else { return };
    init_defaults();
    let home = PathBuf::from(home);
    let mut env: HashMap<String, String> = HashMap::new();
    env.insert("HOME".into(), home.to_string_lossy().into_owned());
    env.insert("ANTIHALL_DEVSWARM_SWEEP_TAIL_MODE".into(), "engine".into());
    let st = Settings { home: home.to_string_lossy().into_owned(), env };
    let root = ah_engine::defaults::root().unwrap();
    let ctx = Ctx { home: &home, root: &root, st: &st, now: now_ms(), engine_pokes: false };
    let hook = kill_hook(&at);
    let _ = ah_engine::dssup::deferred::duty_with(&ctx, &System::configured(), &Hooks { at: &hook });
}

fn crashed(stage: usize, point: &str) -> Fix {
    let f = fix(&format!("crash-{stage}"));
    let repos = two_repos(&f, 2);
    seed(&f, stage, &refs(&repos));
    let o = Command::new(std::env::current_exe().unwrap())
        .args(["--exact", "crash_child", "--nocapture", "--test-threads=1"])
        .env("S8_CRASH_HOME", &f.home)
        .env("S8_CRASH_AT", point)
        .output()
        .unwrap();
    use std::os::unix::process::ExitStatusExt;
    assert_eq!(o.status.signal(), Some(9), "{point}: {}", String::from_utf8_lossy(&o.stderr));
    f
}

#[test]
fn a_sigkill_between_two_items_keeps_the_old_marker_and_the_rerun_ends_where_an_uninterrupted_run_ends() {
    if !node_ready() {
        return;
    }
    let mut checked = 0;
    for stage in [0usize, 1, 3] {
        // the uninterrupted reference
        let reference = fix(&format!("crash-ref-{stage}")).engine();
        let repos = two_repos(&reference, 2);
        seed(&reference, stage, &refs(&repos));
        let r = System::configured();
        let _ = ah_engine::dssup::deferred::duty(&reference.ctx(), &r);
        let want = marker(&reference);
        for point in [format!("stage:{}:0:after", STAGES[stage]), format!("stage:{}:record:before", STAGES[stage]), format!("stage:{}:1:before", STAGES[stage])]
        {
            let f = crashed(stage, &point);
            // the marker is the pre-run marker whole (the write is one rename), and parses
            let m = marker(&f);
            let e = m.get(KEYS[stage]).unwrap();
            assert!(matches!(e.get("pendingHashes"), Some(OVal::Arr(a)) if a.len() == 2), "{point}: the resume list is whole: {}", e.stringify());
            // the rerun (the next tick; the rotation moved on, so point it back) finishes the same way
            f.put(&f.ds("deferred-sweep-state.json"), &format!("{{\"nextStageIndex\":{stage}}}"));
            let mut f = f;
            f.st.env.insert("ANTIHALL_DEVSWARM_SWEEP_TAIL_MODE".into(), "engine".into());
            let rec = ah_engine::dssup::deferred::duty(&f.ctx(), &r);
            assert_eq!(rec["detail"]["result"]["attempted"], true, "{point}: {rec}");
            let got = marker(&f);
            let (ge, we) = (got.get(KEYS[stage]).unwrap(), want.get(KEYS[stage]).unwrap());
            for field in ["completedVersion", "pendingVersion", "pendingHashes", "lastCompletedHash"] {
                assert_eq!(ge.get(field).map(OVal::stringify), we.get(field).map(OVal::stringify), "{point}: {field}");
            }
            checked += 1;
        }
    }
    assert_eq!(checked, 9);
}

// ---- the invariant over every reconcile module ------------------------------------------------------------------------------

#[test]
fn no_reconcile_module_can_delete_or_rewrite_a_message_row() {
    let re = regex::Regex::new(r"(?i)(delete\s+from\s+messages|update\s+messages|insert\s+(or\s+\w+\s+)?into\s+messages|drop\s+table|truncate)").unwrap();
    let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("src/dssup/recon");
    let mut n = 0;
    for e in std::fs::read_dir(&dir).unwrap().flatten() {
        let p = e.path();
        if p.extension().is_some_and(|x| x == "rs") {
            let text = std::fs::read_to_string(&p).unwrap();
            assert!(!re.is_match(&text), "{} addresses a message row", p.display());
            n += 1;
        }
    }
    assert!(n >= 12, "all the reconcile modules were read ({n})");
    // the SQL the port owns: the only statement that removes a row is the guarded registry delete
    let sql = std::fs::read_to_string(Path::new(env!("CARGO_MANIFEST_DIR")).join("src/sql.rs")).unwrap();
    let removers: Vec<&str> = sql.lines().filter(|l| l.contains("pub const RECON_") && l.to_ascii_uppercase().contains("DELETE")).collect();
    assert_eq!(removers.len(), 1, "{removers:?}");
    assert!(removers[0].contains("FROM registry WHERE id = ? AND session_id IS ? AND updated_at IS ? AND write_seq IS ?"));
    let writers: Vec<&str> = sql.lines().filter(|l| l.contains("pub const RECON_") && l.to_ascii_uppercase().contains("INTO MESSAGES")).collect();
    assert!(writers.is_empty(), "{writers:?}");
    // no std::fs removal of a directory tree anywhere but the gate's own scratch mirrors
    let mut trees = Vec::new();
    for e in std::fs::read_dir(&dir).unwrap().flatten() {
        let text = std::fs::read_to_string(e.path()).unwrap_or_default();
        trees.extend(text.lines().filter(|l| l.contains("remove_dir_all")).map(|l| format!("{}: {}", e.file_name().to_string_lossy(), l.trim())));
    }
    assert_eq!(trees.len(), 1, "{trees:?}");
    assert!(trees[0].starts_with("gate.rs:") && trees[0].contains("scratch"), "{trees:?}");
}
