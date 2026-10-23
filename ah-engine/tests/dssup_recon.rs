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
//! The reconcile port, slices S0 to S2 and S6, against Node's own functions.
//!
//! Every case builds a scratch home, plans with the engine, and runs the witness gate: Node's function on one mirror, the engine's
//! op list on another, byte-compared, then applied to the real (scratch) home. A case passes only when the gate agrees (or the
//! engine defers for a stated reason before writing). Each test prints a `PARITY` line: cases / identical / deferred.
//! Crash tests kill a child process with SIGKILL at every op boundary and then let Node's next sweep converge.
#![allow(clippy::unwrap_used, clippy::expect_used)] // a test crate: a panic is the failure report

use ah_engine::checks::git::util::Settings;
use ah_engine::checks::guardkit::ojson::OVal;
use ah_engine::dsact::runner::System;
use ah_engine::dssup::recon::gate::{self, Job, Verdict};
use ah_engine::dssup::recon::{Hooks, UnitEnd, apply, fold, heal, norm, orphans, rehome, side};
use ah_engine::dssup::tick::Ctx;
use ah_engine::meshw::store::{CursorPut, MeshRow, MeshStore, RegistryRow};
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
        // the hivecontrol guard (src/hcguard.rs) only lets a stub run from a scratch root; the fixtures live under ~/.anti-hall/scratch
        // SAFETY: same once-guarded init as above, before any thread reads it
        unsafe { std::env::set_var("AH_HC_STUB_DIR", PathBuf::from(std::env::var("HOME").unwrap()).join(".anti-hall/scratch/recon-tests")) };
        ah_engine::defaults::init().expect("defaults load");
    });
}

fn fix(tag: &str) -> Fix {
    init_defaults();
    static N: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let home = PathBuf::from(std::env::var("HOME").unwrap()).join(".anti-hall/scratch/recon-tests").join(format!(
        "recon-{tag}-{}-{}",
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
            assert!(
                Command::new("git").args(["-c", "user.name=t", "-c", "user.email=t@t"]).args(args).current_dir(dir).output().unwrap().status.success(),
                "git {args:?}"
            );
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
        let r = RegistryRow {
            id: id.into(),
            worktree_path: Some(wt.into()),
            session_id: Some(sid.into()),
            inbox_path: None,
            cursor_path: None,
            nudge_command: Some("[\"a\",\"b\"]".into()),
        };
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

// ---------------------------------------------------------------- the gate applies what the planner decided

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
    let mut s = format!(
        "{{\"id\":\"{id}\",\"worktreePath\":\"{wt}\",\"sessionId\":\"{sid}\",\"inboxPath\":null,\"cursorPath\":null,\"nudgeCommand\":null,\"repoId\":null"
    );
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
        HealCase {
            name: "empty store",
            build: |f| {
                let (_, k, _) = base(f);
                f.store(&k);
            },
            deferred: &[],
        },
        HealCase {
            name: "already healed",
            build: |f| {
                let (p, k, _) = base(f);
                f.row(&k, "w1", &p, "s1");
                f.descriptor("w1", &desc_json("w1", &p, "s1", Some(&k), Some(&k)));
            },
            deferred: &[],
        },
        HealCase {
            name: "stale owner and repo keys",
            build: |f| {
                let (p, k, _) = base(f);
                f.row(&k, "w1", &p, "s1");
                f.descriptor("w1", &desc_json("w1", &p, "s1", Some("deadbeef"), Some("other-1")));
            },
            deferred: &[],
        },
        HealCase {
            name: "keys missing from the descriptor",
            build: |f| {
                let (p, k, _) = base(f);
                f.row(&k, "w1", &p, "s1");
                f.descriptor("w1", &desc_json("w1", &p, "s1", None, None));
            },
            deferred: &[],
        },
        HealCase {
            name: "stale registry worktree path",
            build: |f| {
                let (p, k, _) = base(f);
                f.row(&k, "w1", "/old/path", "s1");
                f.descriptor("w1", &desc_json("w1", &p, "s1", Some(&k), Some(&k)));
            },
            deferred: &[],
        },
        HealCase {
            name: "stale path and stale keys",
            build: |f| {
                let (p, k, _) = base(f);
                f.row(&k, "w1", "/old/path", "s1");
                f.descriptor("w1", &desc_json("w1", &p, "s1", None, Some("zzz")));
            },
            deferred: &[],
        },
        HealCase {
            name: "no descriptor",
            build: |f| {
                let (p, k, _) = base(f);
                f.row(&k, "w1", &p, "s1");
            },
            deferred: &[],
        },
        HealCase {
            name: "descriptor of another session",
            build: |f| {
                let (p, k, _) = base(f);
                f.row(&k, "w1", "/old", "s1");
                f.descriptor("w1", &desc_json("w1", &p, "foreign", None, None));
            },
            deferred: &[],
        },
        HealCase {
            name: "unclaimed sessions never confirm",
            build: |f| {
                let (p, k, _) = base(f);
                f.row(&k, "w1", "/old", "unclaimed:w1");
                f.descriptor("w1", &desc_json("w1", &p, "unclaimed:w1", None, None));
            },
            deferred: &[],
        },
        HealCase {
            name: "descriptor id differs",
            build: |f| {
                let (p, k, _) = base(f);
                f.row(&k, "w1", &p, "s1");
                f.descriptor("w1", &desc_json("w9", &p, "s1", None, None));
            },
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
            name: "mis-keyed row is moved",
            build: |f| {
                let (_, k, q) = base(f);
                f.row(&k, "w1", &q, "s1");
                f.descriptor("w1", &desc_json("w1", &q, "s1", None, None));
            },
            deferred: &[],
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
            build: |f| {
                let (_, k, _) = base(f);
                f.row(&k, "w1", "/gone/for/good", "s1");
                f.descriptor("w1", &desc_json("w1", "/gone/for/good", "s1", None, None));
            },
            deferred: &[],
        },
        HealCase {
            name: "unsafe id in the registry",
            build: |f| {
                let (p, k, _) = base(f);
                f.row(&k, "bad id", &p, "s1");
            },
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
            deferred: &[],
        },
    ]
}

#[test]
fn s2_rehome_core_answers_the_trivial_cases_and_moves_nothing_for_them() {
    let f = fix("s2core");
    let ctx = f.ctx();
    assert_eq!(rehome::core(&ctx, "w1", ""), rehome::Moved::default());
    assert_eq!(rehome::core(&ctx, "w1", &ah_engine::meshw::send::hash_from_workspace_id("w1")), rehome::Moved::default());
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
        OrphanCase {
            name: "no store directory",
            build: |f| {
                let (_, k, _) = base(f);
                let _ = k;
            },
            want: Ok((0, 0)),
        },
        OrphanCase {
            name: "no orphans",
            build: |f| {
                let (p, k, _) = base(f);
                f.row(&k, "w1", &p, "s1");
                f.msg(&k, "w1");
            },
            want: Ok((0, 0)),
        },
        OrphanCase {
            name: "one live orphan is adopted",
            build: |f| {
                let (p, k, _) = base(f);
                f.msg(&k, "o1");
                f.descriptor("o1", &desc_json("o1", &p, "so1", Some(&k), Some(&k)));
            },
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
        OrphanCase {
            name: "no descriptor anywhere",
            build: |f| {
                let (_, k, _) = base(f);
                f.msg(&k, "o1");
            },
            want: Ok((0, 1)),
        },
        OrphanCase {
            name: "descriptor of another repository",
            build: |f| {
                let (_, k, q) = base(f);
                f.msg(&k, "o1");
                f.descriptor("o1", &desc_json("o1", &q, "so1", None, None));
            },
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
            build: |f| {
                let (p, k, _) = base(f);
                f.msg(&k, "o1");
                f.msg(&k, "o3");
                f.descriptor("o1", &desc_json("o1", &p, "so1", None, None));
            },
            want: Err("summary-orphan"),
        },
        OrphanCase {
            name: "worktree family already in the registry",
            build: |f| {
                let (p, k, _) = base(f);
                f.row(&k, "w1", &p, "s1");
                f.msg(&k, "o1");
                f.descriptor("o1", &desc_json("o1", &p, "so1", None, None));
            },
            want: Err("orphan-family"),
        },
        OrphanCase {
            name: "descriptor only in archived/",
            build: |f| {
                let (p, k, _) = base(f);
                f.msg(&k, "o1");
                f.put(&f.ds("archived/o1.json"), &desc_json("o1", &p, "so1", None, None));
            },
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
            build: |f| {
                let (p, k, _) = base(f);
                f.msg(&k, "o1");
                f.descriptor("o1", &desc_json("o1", &p, "so1", None, None));
                f.put(&f.ds("archived/o1.json"), "{not json");
            },
            want: Err("orphan-archived"),
        },
        OrphanCase {
            name: "a descriptor field of a type the engine does not model",
            build: |f| {
                let (p, k, _) = base(f);
                f.msg(&k, "o1");
                f.descriptor("o1", &desc_json("o1", &p, "so1", None, None).replace("\"so1\"", "5"));
            },
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
            build: |f| {
                let (_, k, _) = base(f);
                f.msg(&k, "o1");
                f.descriptor("o1", "{\"id\":\"o1\",\"sessionId\":\"so1\"}");
            },
            want: Ok((1, 0)),
        },
    ]
}

fn msg_count(f: &Fix, key: &str) -> i64 {
    let db = f.home.join(f.ds(&format!("store/{key}/devswarm.db")));
    rusqlite::Connection::open(db).and_then(|c| c.query_row("SELECT COUNT(*) FROM messages", [], |r| r.get(0))).unwrap_or(0)
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
    ah_engine::dssup::recon::view::registry(&f.home, key)
        .unwrap()
        .into_iter()
        .map(|r| (r.row.id, r.row.worktree_path.map(|p| p.rsplit('/').next().unwrap_or("").to_string()), r.row.session_id))
        .collect()
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
    fn db(&self, key: &str) -> rusqlite::Connection {
        rusqlite::Connection::open(self.home.join(self.ds(&format!("store/{key}/devswarm.db")))).unwrap()
    }
    fn touch(&self, key: &str, id: &str, updated_at: i64) {
        self.db(key).execute("UPDATE registry SET updated_at = ?1 WHERE id = ?2", rusqlite::params![updated_at, id]).unwrap();
    }
    /// A direct message in `part`'s partition (`sender` empty makes it non-forwardable).
    fn msg_at(&self, key: &str, part: &str, ts: i64, body: &str, sender: &str) {
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
                f.msg_at(&k, "w-ph", 10, "one", "snd");
                f.msg_at(&k, "w-ph", 11, "two", "snd");
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
                f.msg_at(&k, "w-zdup", 10, "kept", "snd");
                (k.clone(), vec![k, wt])
            },
            retired: &[],
            forwarded: 1,
            deferred: 0,
            whole: true,
        },
        FoldCase {
            name: "the id-first row is not the live one: the live row survives",
            build: |f| {
                let (wt, k) = s6_base(f);
                f.row_s(&k, "w-live", &wt, Some("s1"));
                f.row_s(&k, "w-adup", &wt, None);
                f.floors(&k, "w-adup", 0);
                f.msg_at(&k, "w-adup", 10, "kept", "snd");
                (k.clone(), pair(&k, &wt))
            },
            retired: &["w-adup"],
            forwarded: 1,
            deferred: 0,
            whole: true,
        },
        FoldCase {
            name: "a retired partition left with unread mail cannot be summarised natively: Node's",
            build: |f| {
                let (wt, k) = s6_base(f);
                f.row_s(&k, "w-live", &wt, Some("s1"));
                f.row_s(&k, "w-ph", &wt, None);
                f.floors(&k, "w-ph", 0);
                f.msg_at(&k, "w-ph", 10, "native", "");
                f.msg_at(&k, "w-ph", 11, "real", "snd");
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
                f.msg_at(&k, "w-ph", 10, "read", "snd");
                f.msg_at(&k, "w-ph", 11, "unread-a", "snd");
                f.msg_at(&k, "w-ph", 12, "unread-b", "snd");
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
                f.msg_at(&k, "w-b", 10, "same", "snd");
                f.msg_at(&k, "w-c", 10, "same", "snd");
                (k.clone(), vec![k, wt])
            },
            retired: &["w-b", "w-c"],
            forwarded: 1,
            deferred: 0,
            whole: true,
        },
        FoldCase {
            name: "a stale cross-reference makes two live-shaped rows: the aliased one is not the survivor",
            build: |f| {
                let (wt, k) = s6_base(f);
                f.row_s(&k, "w-live", &wt, Some("s1"));
                f.row_s(&k, "w-x", &wt, Some("w-live"));
                f.descriptor("w-x", &desc_json("w-x", &wt, "w-live", None, None));
                (k.clone(), vec![k, wt])
            },
            retired: &["w-x"],
            forwarded: 0,
            deferred: 0,
            whole: true,
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
                f.msg_at(&k, "w-b", 10, "from the subdir", "snd");
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
            name: "two live sessions: the freshest live row survives",
            build: |f| {
                let (wt, k) = s6_base(f);
                f.row_s(&k, "w-a", &wt, Some("s1"));
                f.row_s(&k, "w-b", &wt, Some("s2"));
                (k.clone(), pair(&k, &wt))
            },
            retired: &["w-b"],
            forwarded: 0,
            deferred: 0,
            whole: true,
        },
        FoldCase {
            name: "two live rows, the anchor (newest) survives and the older live row folds into it",
            build: |f| {
                let (wt, k) = s6_base(f);
                let anchor = ah_engine::meshw::ident::primary_workspace_id(&wt).unwrap();
                f.row_s(&k, "w-live", &wt, Some("s1"));
                f.row_s(&k, &anchor, &wt, Some("s9"));
                (k.clone(), vec![k, wt, anchor])
            },
            retired: &["w-live"],
            forwarded: 0,
            deferred: 0,
            whole: true,
        },
        FoldCase {
            name: "unread mail without floor rows is decided by the engine, like Node",
            build: |f| {
                let (wt, k) = s6_base(f);
                f.row_s(&k, "w-live", &wt, Some("s1"));
                f.row_s(&k, "w-ph", &wt, None);
                f.msg_at(&k, "w-ph", 10, "one", "snd");
                (k.clone(), pair(&k, &wt))
            },
            retired: &["w-ph"],
            forwarded: 1,
            deferred: 0,
            whole: true,
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
        .filter(|(k, _)| {
            !k.starts_with(".anti-hall/logs")
                && !k.starts_with(".anti-hall/scratch")
                && !k.contains("/locks/")
                && !k.starts_with("repos/")
                && !k.starts_with(".git")
        })
        .map(|(k, v)| (fix_up(&k), fix_up(&v)))
        .collect()
}

/// A cross-referenced anchor keeps only the unforgeable half of its liveness: a heartbeat written to its own file right now. With one it
/// stays (left, not retired); without, the ordinary path folds it into the live survivor. The engine decides both itself.
#[test]
fn dssup_recon_s6_a_fresh_heartbeat_protects_a_cross_referenced_anchor_and_its_absence_does_not() {
    if !have("git") {
        return;
    }
    for (beating, retired) in [(true, vec![]), (false, vec!["anchor".to_string()])] {
        let f = fix6("s6-anchor-beat");
        let (wt, k) = s6_base(&f);
        let anchor = ah_engine::meshw::ident::primary_workspace_id(&wt).unwrap();
        f.row_s(&k, "w-live", &wt, Some("s1"));
        f.row_s(&k, &anchor, &wt, Some("w-live")); // its session names another row of the group: a stale cross-reference
        f.floors(&k, &anchor, 0);
        if beating {
            f.put(&f.ds(&format!("heartbeats/{anchor}.json")), &format!("{{\"ts\":{}}}", NOW - 1000));
        }
        let end = fold::run(&f.ctx(), &System::configured(), &k, &Hooks::none()).unwrap();
        let want: Vec<String> = retired.iter().map(|_| anchor.clone()).collect();
        assert_eq!(end.result.retired, want, "beating={beating}: {:?}", end.deferred);
        assert!(end.deferred.is_empty(), "beating={beating}: decided natively, not handed back: {:?}", end.deferred);
        assert_eq!(f.rows(&k).contains(&anchor), beating, "beating={beating}");
    }
}

#[test]
fn s6_the_engine_switch_is_off_by_default_and_a_deferred_store_writes_nothing() {
    // the switch (`devswarm_sup.sweep_tail_mode`) defaults to the engine; `off` hands the store to nobody: the pass is refused before
    // anything is read, nothing is written (counted as disabled)
    let mut f = fix("s6-off");
    let (wt, k) = s6_base(&f);
    f.row_s(&k, "w-live", &wt, Some("s1"));
    f.row_s(&k, "w-ph", &wt, None);
    f.st.env.insert("ANTIHALL_DEVSWARM_SWEEP_TAIL_MODE".into(), "off".into());
    let before = f.snapshot();
    assert!(fold::run(&f.ctx(), &System::configured(), &k, &Hooks::none()).is_err(), "off: the engine takes no store");
    assert_eq!(f.snapshot(), before);
    // a missing store: nothing to fold, and nothing is created
    let g = fix6("s6-none");
    let end = fold::run(&g.ctx(), &System::configured(), "no-such-store", &Hooks::none()).unwrap();
    assert!(end.result.retired.is_empty());
    assert!(!g.home.join(g.ds("store/no-such-store")).exists());
}

// ---- S6 crash safety: SIGKILL at each op boundary of a fold, then Node's next fold converges

fn crash_fold_fixture(f: &Fix) -> String {
    let (wt, k) = s6_base(f);
    f.row_s(&k, "w-live", &wt, Some("s1"));
    f.row_s(&k, "w-ph", &wt, None);
    f.floors(&k, "w-ph", 0);
    f.msg_at(&k, "w-ph", 10, "one", "snd");
    f.msg_at(&k, "w-ph", 11, "two", "snd");
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
    // every source file of the module tree, sub-modules included
    let mut todo = vec![dir.clone()];
    while let Some(d) = todo.pop() {
        for e in std::fs::read_dir(&d).unwrap().flatten() {
            if e.path().is_dir() {
                todo.push(e.path());
                continue;
            }
            let text = std::fs::read_to_string(e.path()).unwrap();
            assert!(!re.is_match(&text), "{} modifies message rows", e.path().display());
            checked += 1;
        }
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
