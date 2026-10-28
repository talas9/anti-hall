#![allow(
    clippy::panic,
    clippy::unreachable,
    dead_code,
    clippy::type_complexity,
    clippy::collapsible_if,
    clippy::needless_range_loop,
    clippy::useless_vec,
    clippy::regex_creation_in_loops,
    clippy::let_underscore_must_use
)]
//! The reconcile port, slice S7 (archived registry rows and twin descriptors), against Node's own functions.
//!
//! Every case builds a scratch home, plans with the engine and runs the witness gate: Node's function on one mirror, the engine's
//! op list on another, byte-compared (hard-link counts included), then applied to the real (scratch) home. A case passes only
//! when the gate agrees, or the engine defers for a stated reason before writing. Crash tests kill a child process with SIGKILL at
//! every op boundary and then let Node's next run converge. Each parity test prints a `PARITY` line.
#![allow(clippy::unwrap_used, clippy::expect_used)] // a test crate: a panic is the failure report

use ah_engine::checks::git::util::Settings;
use ah_engine::checks::guardkit::ojson::OVal;
use ah_engine::dsact::runner::{Runner, System};
use ah_engine::dssup::recon::gate::Verdict;
use ah_engine::dssup::recon::{Hooks, RegRow, archive, norm, view};
use ah_engine::dssup::tick::Ctx;
use ah_engine::meshw::store::{MeshStore, RegistryRow};
use std::collections::HashMap;
use std::os::unix::fs::MetadataExt;
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
    let home = PathBuf::from(std::env::var("HOME").unwrap()).join(".anti-hall/scratch/recon-tests").join(format!(
        "s7-{tag}-{}-{}",
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
        Ctx { home: &self.home, root: &self.root, st: &self.st, now: NOW, engine_pokes: false }
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
    fn exists(&self, rel: &str) -> bool {
        self.home.join(rel).exists()
    }
    fn ino(&self, rel: &str) -> Option<(u64, u64)> {
        std::fs::symlink_metadata(self.home.join(rel)).ok().map(|m| (m.dev(), m.ino()))
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
    fn row(&self, key: &str, id: &str, wt: &str, sid: &str) {
        let st = self.store(key);
        let r = RegistryRow {
            id: id.into(),
            worktree_path: Some(wt.into()),
            session_id: Some(sid.into()),
            inbox_path: None,
            cursor_path: None,
            nudge_command: None,
        };
        assert!(st.upsert_registry(&r, 1_000, |_, _| true).unwrap());
    }
    fn desc(&self, id: &str, wt: &str, sid: &str) -> String {
        format!("{{\"id\":\"{id}\",\"worktreePath\":\"{wt}\",\"sessionId\":\"{sid}\",\"inboxPath\":null,\"cursorPath\":null,\"nudgeCommand\":null}}")
    }
    fn live(&self, id: &str, wt: &str, sid: &str) {
        self.put(&self.ds(&format!("workspaces/{id}.json")), &self.desc(id, wt, sid));
    }
    fn tomb(&self, id: &str, wt: &str, sid: &str) {
        self.put(&self.ds(&format!("archived/{id}.json")), &self.desc(id, wt, sid));
    }
    fn snapshot(&self) -> std::collections::BTreeMap<String, String> {
        let mut m = norm::dump(&self.home);
        m.retain(|k, _| !k.starts_with(".anti-hall/logs/devswarm-recon-witness"));
        m
    }
    fn registry(&self, key: &str) -> Vec<RegRow> {
        view::registry(&self.home, key).unwrap()
    }
}

struct Tally {
    name: &'static str,
    cases: std::cell::Cell<u32>,
    identical: std::cell::Cell<u32>,
    deferred: std::cell::Cell<u32>,
}

impl Tally {
    fn new(name: &'static str) -> Tally {
        Tally { name, cases: 0.into(), identical: 0.into(), deferred: 0.into() }
    }
    fn case(&self, deferred: bool) {
        self.cases.set(self.cases.get() + 1);
        if deferred { self.deferred.set(self.deferred.get() + 1) } else { self.identical.set(self.identical.get() + 1) }
    }
    fn print(&self) {
        println!("PARITY {}: cases={} identical={} deferred={}", self.name, self.cases.get(), self.identical.get(), self.deferred.get());
    }
}

/// Run a plan through the gate: the witness must agree and every unit must apply.
fn agreed(f: &Fix, plan: &archive::Plan) -> archive::Run {
    let r = archive::run_plan(&f.ctx(), &System::configured() as &dyn Runner, plan, &Hooks::none());
    assert_eq!(r.verdict, Verdict::Agreed, "{}: {:?}", plan.job.label, r.verdict);
    assert!(r.deferred.is_empty(), "{}: {:?}", plan.job.label, r.deferred);
    r
}

/// The second pass over the result writes nothing (the resume marker may be rewritten with the same bytes).
fn settles(f: &Fix, again: impl Fn() -> archive::Plan) {
    let before = f.snapshot();
    agreed(f, &again());
    assert_eq!(f.snapshot(), before, "the second pass wrote something");
}

fn reg_row(id: &str, wt: &str, sid: Option<&str>) -> RegRow {
    RegRow {
        row: RegistryRow {
            id: id.into(),
            worktree_path: Some(wt.into()),
            session_id: sid.map(Into::into),
            inbox_path: None,
            cursor_path: None,
            nudge_command: None,
        },
        updated_at: Some(1),
        write_seq: Some(1),
    }
}

// ---- retireIdentityFamilyDescriptors ------------------------------------------------------------------------------------------

struct RetireCase {
    name: &'static str,
    build: fn(&Fix, &str),
    require_gone: bool,
    retired: &'static [&'static str],
    left: &'static [(&'static str, &'static str)],
}

const GONE: &str = "/nonexistent/s7/gone";

fn retire_cases() -> Vec<RetireCase> {
    vec![
        RetireCase {
            name: "twin by session cross-link, no gate",
            build: |f, p| {
                f.tomb("A", p, "B");
                f.live("B", p, "x");
            },
            require_gone: false,
            retired: &["B"],
            left: &[],
        },
        RetireCase {
            name: "twin whose own session is the tombstone id",
            build: |f, p| {
                f.tomb("A", p, "s");
                f.live("B", p, "A");
            },
            require_gone: false,
            retired: &["B"],
            left: &[],
        },
        RetireCase {
            name: "migration gate: worktree still there stays active",
            build: |f, p| {
                f.tomb("A", p, "B");
                f.live("B", p, "x");
            },
            require_gone: true,
            retired: &[],
            left: &[("B", "live-or-unprovable-worktree")],
        },
        RetireCase {
            name: "migration gate: worktree provably gone is retired",
            build: |f, _| {
                f.tomb("A", GONE, "B");
                f.live("B", GONE, "x");
            },
            require_gone: true,
            retired: &["B"],
            left: &[],
        },
        RetireCase {
            name: "unrelated live sibling on the same worktree is never retired",
            build: |f, p| {
                f.tomb("A", p, "s1");
                f.live("B", p, "s2");
            },
            require_gone: false,
            retired: &[],
            left: &[],
        },
        RetireCase {
            name: "an archived file that is another inode is never clobbered",
            build: |f, p| {
                f.tomb("A", p, "B");
                f.live("B", p, "x");
                f.put(&f.ds("archived/B.json"), "{\"id\":\"B\",\"other\":true}");
            },
            require_gone: false,
            retired: &[],
            left: &[("B", "archived-tombstone-differs")],
        },
        RetireCase {
            name: "equal bytes at another inode is equally not ours",
            build: |f, p| {
                f.tomb("A", p, "B");
                f.live("B", p, "x");
                f.put(&f.ds("archived/B.json"), &f.desc("B", p, "x"));
            },
            require_gone: false,
            retired: &[],
            left: &[("B", "archived-tombstone-differs")],
        },
        RetireCase {
            name: "a half-done retire (already linked) is finished",
            build: |f, p| {
                f.tomb("A", p, "B");
                f.live("B", p, "x");
                std::fs::hard_link(f.home.join(f.ds("workspaces/B.json")), f.home.join(f.ds("archived/B.json"))).unwrap();
            },
            require_gone: false,
            retired: &["B"],
            left: &[],
        },
        RetireCase {
            name: "two twins and a malformed descriptor",
            build: |f, p| {
                f.tomb("A", p, "B");
                f.live("B", p, "x");
                f.live("C", p, "A");
                f.put(&f.ds("workspaces/D.json"), "{\"id\":\"WRONG\",\"sessionId\":\"A\"}");
                f.put(&f.ds("workspaces/E.json"), "not json");
            },
            require_gone: false,
            retired: &["B", "C"],
            left: &[],
        },
        RetireCase {
            name: "no twins at all",
            build: |f, p| {
                f.tomb("A", p, "s");
            },
            require_gone: false,
            retired: &[],
            left: &[],
        },
    ]
}

fn tomb_of(f: &Fix, id: &str) -> OVal {
    OVal::parse(&f.read(&f.ds(&format!("archived/{id}.json"))).unwrap()).unwrap()
}

#[test]
fn retire_creates_the_archived_directory_like_node_and_retires_into_it() {
    let f = fix("retire-nodir");
    let p = f.repo("p");
    f.live("B", &p, "x");
    let desc = OVal::parse(&f.desc("A", &p, "B")).unwrap();
    assert!(!f.exists(&f.ds("archived")));
    let plan = archive::retire_identity_family(&f.home, "A", &desc, false).unwrap();
    assert_eq!(plan.result["retired"], serde_json::json!(["B"]));
    agreed(&f, &plan);
    assert!(f.exists(&f.ds("archived/B.json")) && !f.exists(&f.ds("workspaces/B.json")));
    // with nothing to retire the directory is still created, as Node's `checkedArchivedDir(home, { create: true })` does
    let g = fix("retire-nodir-empty");
    let q = g.repo("p");
    let desc = OVal::parse(&g.desc("A", &q, "B")).unwrap();
    let plan = archive::retire_identity_family(&g.home, "A", &desc, false).unwrap();
    agreed(&g, &plan);
    assert!(g.exists(&g.ds("archived")));
}

// ---- foldArchivedFamilyDescriptors ----------------------------------------------------------------------------------------------

// ---- foldArchivedRegistryRows ------------------------------------------------------------------------------------------------

// ---- restoreArchivedDescriptor ---------------------------------------------------------------------------------------------

fn restore_fixture(f: &Fix, with_row: bool) -> (String, String) {
    let p = f.repo("p");
    let k = f.key_of(&p);
    f.put(
        &f.ds("archived/W.json"),
        &format!("{{\"id\":\"W\",\"worktreePath\":\"{p}\",\"sessionId\":\"sw\",\"archivedBy\":\"op\",\"archivedAt\":5,\"inboxPath\":null,\"cursorPath\":null,\"nudgeCommand\":[\"a\",\"b\"]}}"),
    );
    // the owner's store exists (an empty one, or with the id's row)
    let st = f.store(&k);
    if with_row {
        let r = RegistryRow {
            id: "W".into(),
            worktree_path: Some(p.clone()),
            session_id: Some("old".into()),
            inbox_path: None,
            cursor_path: None,
            nudge_command: None,
        };
        assert!(st.upsert_registry(&r, 1_000, |_, _| true).unwrap());
    }
    (p, k)
}

// ---- crash safety ---------------------------------------------------------------------------------------------------------------

fn kill_hook(point: &str) -> impl Fn(&str) + '_ {
    move |name| {
        if name == point || point.strip_prefix('*').is_some_and(|tail| name.ends_with(tail)) {
            // SAFETY: SIGKILL of this very process, the point of the crash test
            unsafe { libc::kill(libc::getpid(), libc::SIGKILL) };
        }
    }
}

fn crash_fixture(f: &Fix, kind: &str) -> String {
    let p = f.repo("p");
    let k = f.key_of(&p);
    match kind {
        "retire" => {
            f.tomb("A", &p, "B");
            f.live("B", &p, "x");
        }
        "restore" => {
            let _ = restore_fixture(f, false);
        }
        _ => {
            f.tomb("a1", &p, "s1");
            f.row(&k, "a1", &p, "s1");
        }
    }
    k
}

#[test]
fn crash_child() {
    // the child half of the crash tests: does nothing unless the parent set the environment
    let (Ok(home), Ok(at), Ok(kind)) = (std::env::var("S7_CRASH_HOME"), std::env::var("S7_CRASH_AT"), std::env::var("S7_CRASH_KIND")) else { return };
    init_defaults();
    let home = PathBuf::from(home);
    let mut env: HashMap<String, String> = HashMap::new();
    env.insert("HOME".into(), home.to_string_lossy().into_owned());
    let st = Settings { home: home.to_string_lossy().into_owned(), env };
    let root = ah_engine::defaults::root().unwrap();
    let ctx = Ctx { home: &home, root: &root, st: &st, now: NOW, engine_pokes: false };
    let hook = kill_hook(&at);
    let plan = match kind.as_str() {
        "retire" => {
            let desc = OVal::parse(&std::fs::read_to_string(home.join(".anti-hall/devswarm/archived/A.json")).unwrap()).unwrap();
            archive::retire_identity_family(&home, "A", &desc, false).unwrap()
        }
        "restore" => archive::restore_archived_descriptor(&home, "W", &archive::RestoreOpts::default()).unwrap(),
        _ => archive::fold_archived_rows(&ctx, None).unwrap(),
    };
    let _ = archive::run_plan(&ctx, &System::configured(), &plan, &Hooks { at: &hook });
}

fn crash_run(kind: &str, point: &str) -> Option<(Fix, String)> {
    let f = fix(&format!("crash-{kind}"));
    let k = crash_fixture(&f, kind);
    let o = Command::new(std::env::current_exe().unwrap())
        .args(["--exact", "crash_child", "--nocapture", "--test-threads=1"])
        .env("S7_CRASH_HOME", &f.home)
        .env("S7_CRASH_AT", point)
        .env("S7_CRASH_KIND", kind)
        .output()
        .unwrap();
    use std::os::unix::process::ExitStatusExt;
    (o.status.signal() == Some(9)).then_some((f, k))
}

// ---- the mode switch and the invariants -------------------------------------------------------------------------------------

#[test]
fn the_sweep_tail_is_node_s_unless_the_setting_says_engine() {
    // the engine decides the sweep tail by default; `off` disables it (counted, nothing run); an unknown word reads as the default
    let mut f = fix("mode");
    assert!(archive::engine_mode(&f.st), "the default is the engine");
    f.st.env.insert("ANTIHALL_DEVSWARM_SWEEP_TAIL_MODE".into(), "off".into());
    assert!(!archive::engine_mode(&f.st), "off disables the sweep tail");
    f.st.env.insert("ANTIHALL_DEVSWARM_SWEEP_TAIL_MODE".into(), "engine".into());
    assert!(archive::engine_mode(&f.st));
    f.st.env.insert("ANTIHALL_DEVSWARM_SWEEP_TAIL_MODE".into(), "bogus".into());
    assert!(archive::engine_mode(&f.st), "an unknown value reads as the default, which is the engine");
}

#[test]
fn the_archive_module_cannot_address_a_message_row() {
    let re = regex::Regex::new(r"(?i)(delete\s+from\s+messages|update\s+messages|insert\s+into\s+messages)").unwrap();
    let text = std::fs::read_to_string(Path::new(env!("CARGO_MANIFEST_DIR")).join("src/dssup/recon/archive.rs")).unwrap();
    assert!(!re.is_match(&text));
    // the only SQL steps that remove anything are registry deletes: the conditional one (the fold) and the re-home's removal of the
    // SOURCE store's registry row, made after the copy was verified (Node's `removeRegistry`); never a message row
    let sql = std::fs::read_to_string(Path::new(env!("CARGO_MANIFEST_DIR")).join("src/sql.rs")).unwrap();
    let removers: Vec<&str> = sql.lines().filter(|l| l.contains("pub const RECON_") && l.to_ascii_uppercase().contains("DELETE")).collect();
    assert_eq!(removers.len(), 2, "{removers:?}");
    assert!(removers.iter().all(|l| l.contains("FROM registry WHERE id = ?")), "{removers:?}");
    assert!(removers.iter().any(|l| l.contains("FROM registry WHERE id = ? AND session_id IS ? AND updated_at IS ? AND write_seq IS ?")));
}
