//! Node-vs-engine parity of the idle-wake Monitor: `node companion/lib/devswarm-wake-watch.js --auto` against
//! `ah-engine devswarm wake-watch --auto`.
//!
//! Each scenario seeds two identical scratch homes (HOME at the fixture, an otherwise empty environment, never the real home), starts
//! one watcher of each kind, applies the same scripted changes to the store files they read (the summary, the NDJSON inbox) and
//! compares what the Monitor would deliver: every stdout line, in order, with nothing extra after the settle time; then the stderr
//! diagnostics that carry no pid or clock, the exit code after SIGTERM, the persisted cursor file byte for byte and the lock file
//! (gone). The refusal paths (not a DevSwarm session, a held lock, a Primary without a live child) are compared the same way.
//!
//! The engine also wakes its tick early on a file event, so it may print a line sooner than Node's poll: lines are compared, never
//! their timing.
#![allow(clippy::unwrap_used, clippy::expect_used)] // a test crate: a panic is the failure report, and E2 exempts tests
use ah_engine::db::TempDir;
use ah_engine::meshw::ident;
use std::fs;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

const BIN: &str = env!("CARGO_BIN_EXE_ah-engine");
const POLL_MS: &str = "250";

fn have_node() -> bool {
    Command::new("node").arg("--version").output().is_ok_and(|o| o.status.success())
}

fn plugin() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap().join("plugins").join("anti-hall").canonicalize().unwrap()
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Kind {
    Node,
    Engine,
}

struct Side {
    kind: Kind,
    child: Child,
    out: Arc<Mutex<Vec<String>>>,
    err: Arc<Mutex<Vec<String>>>,
}

impl Drop for Side {
    fn drop(&mut self) {
        // an already-exited child is the normal case: neither call may fail the test
        if self.child.kill().is_ok() {
            drop(self.child.wait());
        }
    }
}

impl Side {
    fn lines(&self) -> Vec<String> {
        self.out.lock().unwrap().clone()
    }
    fn stderr(&self) -> Vec<String> {
        self.err.lock().unwrap().clone()
    }
    fn wait_lines(&self, n: usize, what: &str) {
        let end = Instant::now() + Duration::from_secs(15);
        while Instant::now() < end {
            if self.out.lock().unwrap().len() >= n {
                return;
            }
            std::thread::sleep(Duration::from_millis(25));
        }
        panic!("{:?}: waited for {n} lines ({what}), got {:?}; stderr {:?}", self.kind, self.lines(), self.stderr());
    }
    fn exited(&mut self) -> Option<i32> {
        let end = Instant::now() + Duration::from_secs(15);
        while Instant::now() < end {
            if let Some(st) = self.child.try_wait().unwrap() {
                return Some(st.code().unwrap_or(-1));
            }
            std::thread::sleep(Duration::from_millis(25));
        }
        None
    }
    fn term(&mut self) -> Option<i32> {
        // SAFETY: SIGTERM to the child we started.
        unsafe { libc::kill(self.child.id() as i32, libc::SIGTERM) };
        self.exited()
    }
}

fn pipe_lines(r: impl std::io::Read + Send + 'static, sink: Arc<Mutex<Vec<String>>>) {
    std::thread::spawn(move || {
        for l in BufReader::new(r).lines().map_while(Result::ok) {
            sink.lock().unwrap().push(l);
        }
    });
}

struct Fx {
    _t: TempDir,
    home: PathBuf,
    cwd: PathBuf,
}

impl Fx {
    fn new(tag: &str) -> Fx {
        let t = TempDir::new(tag);
        let root = fs::canonicalize(&t.0).unwrap();
        let (home, cwd) = (root.join("home"), root.join("work"));
        fs::create_dir_all(home.join("tmp")).unwrap();
        fs::create_dir_all(&cwd).unwrap();
        Fx { _t: t, home, cwd }
    }
    fn root(&self) -> PathBuf {
        self.home.join(".anti-hall").join("devswarm")
    }
    fn write(&self, rel: &str, text: &str) {
        let p = self.root().join(rel);
        fs::create_dir_all(p.parent().unwrap()).unwrap();
        fs::write(p, text).unwrap();
    }
    fn append(&self, rel: &str, text: &str) {
        use std::io::Write;
        let p = self.root().join(rel);
        fs::create_dir_all(p.parent().unwrap()).unwrap();
        fs::OpenOptions::new().append(true).create(true).open(p).unwrap().write_all(text.as_bytes()).unwrap();
    }
    fn read(&self, rel: &str) -> Option<String> {
        fs::read_to_string(self.root().join(rel)).ok()
    }
    fn spawn(&self, kind: Kind, env: &[(&str, &str)], args: &[&str]) -> Side {
        let mut cmd = match kind {
            Kind::Node => {
                let mut c = Command::new("node");
                c.arg(plugin().join("companion/lib/devswarm-wake-watch.js"));
                c
            }
            Kind::Engine => {
                let mut c = Command::new(BIN);
                c.args(["devswarm", "wake-watch"]);
                c
            }
        };
        cmd.args(args)
            .env_clear()
            .env("PATH", std::env::var("PATH").unwrap())
            .env("HOME", &self.home)
            .env("TMPDIR", self.home.join("tmp"))
            .env("ANTIHALL_DEVSWARM_WAKE_WATCH_POLL_MS", POLL_MS)
            .env("ANTIHALL_INGEST_DRY_RUN", "1")
            .env("AH_ENGINE_PLUGIN_ROOT", plugin())
            .current_dir(&self.cwd)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        for (k, v) in env {
            cmd.env(k, v);
        }
        let mut child = cmd.spawn().unwrap();
        let (out, err) = (Arc::new(Mutex::new(Vec::new())), Arc::new(Mutex::new(Vec::new())));
        pipe_lines(child.stdout.take().unwrap(), Arc::clone(&out));
        pipe_lines(child.stderr.take().unwrap(), Arc::clone(&err));
        Side { kind, child, out, err }
    }
}

fn hash_of(id: &str) -> String {
    ah_engine::meshw::send::hash_from_workspace_id(id)
}

fn summary(h: &str, rows: &[(&str, u64, Option<u64>)]) -> String {
    let ws: Vec<String> = rows
        .iter()
        .map(|(id, total, b)| format!("\"{id}\":{{\"total\":{total}{}}}", b.map_or(String::new(), |b| format!(",\"broadcastUnreadFromOthers\":{b}"))))
        .collect();
    format!("{{\"hash\":\"{h}\",\"workspaces\":{{{}}}}}", ws.join(","))
}

const CHILD_ENV: &[(&str, &str)] = &[("DEVSWARM_SOURCE_BRANCH", "feature/x"), ("DEVSWARM_BUILDER_ID", "childA")];

/// Apply `change` to both fixtures, wait until each side printed `n` lines in total, settle, then compare the lines.
fn step(fx: &(Fx, Fx), sides: &(Side, Side), n: usize, what: &str, change: &dyn Fn(&Fx)) {
    change(&fx.0);
    change(&fx.1);
    sides.0.wait_lines(n, what);
    sides.1.wait_lines(n, what);
    // a spurious extra line would show up within a few ticks
    std::thread::sleep(Duration::from_millis(1100));
    assert_eq!(sides.0.lines(), sides.1.lines(), "{what}: node vs engine");
    assert_eq!(sides.0.lines().len(), n, "{what}: node printed {:?}", sides.0.lines());
}

fn pair(tag: &str) -> (Fx, Fx) {
    (Fx::new(&format!("{tag}-node")), Fx::new(&format!("{tag}-engine")))
}

fn norm_stderr(s: &[String]) -> Vec<String> {
    s.iter().filter(|l| l.starts_with("[wake-watch]")).cloned().collect()
}

#[test]
fn a_child_watcher_prints_the_same_lines_as_node_for_every_channel() {
    if !have_node() {
        return;
    }
    let fx = pair("child");
    let h = hash_of("childA");
    for f in [&fx.0, &fx.1] {
        f.write(&format!("summaries/{h}.json"), &summary(&h, &[("childA", 2, Some(0))]));
        f.write("inbox/childA.ndjson", "{\"a\":1}\n");
    }
    let sides = (fx.0.spawn(Kind::Node, CHILD_ENV, &["--auto"]), fx.1.spawn(Kind::Engine, CHILD_ENV, &["--auto"]));
    for s in [&sides.0, &sides.1] {
        s.wait_lines(1, "armed");
    }
    assert_eq!(sides.0.lines(), sides.1.lines(), "the arm line");
    assert!(sides.0.lines()[0].starts_with("[wake-watch] armed: watching child childA"));
    // a fresh cursor file seeds from the first read: no false wake for the mail that was already there
    std::thread::sleep(Duration::from_millis(900));
    assert_eq!(sides.0.lines().len(), 1);
    assert_eq!(sides.1.lines().len(), 1);
    step(&fx, &sides, 2, "inbox grows", &|f| f.append("inbox/childA.ndjson", "{\"b\":2}\n"));
    step(&fx, &sides, 3, "mesh-direct total grows", &|f| f.write(&format!("summaries/{h}.json"), &summary(&h, &[("childA", 4, Some(0))])));
    step(&fx, &sides, 4, "both channels in one tick", &|f| {
        f.append("inbox/childA.ndjson", "{\"c\":3}\n");
        f.write(&format!("summaries/{h}.json"), &summary(&h, &[("childA", 5, Some(0))]));
    });
    step(&fx, &sides, 5, "a broadcast arrives", &|f| f.write(&format!("summaries/{h}.json"), &summary(&h, &[("childA", 5, Some(2))])));
    step(&fx, &sides, 5, "an ack lowers the broadcast count: no line", &|f| f.write(&format!("summaries/{h}.json"), &summary(&h, &[("childA", 5, Some(1))])));
    step(&fx, &sides, 6, "the next broadcast counts from the lowered value", &|f| {
        f.write(&format!("summaries/{h}.json"), &summary(&h, &[("childA", 5, Some(3))]))
    });
    let (mut node, mut eng) = sides;
    assert_eq!(norm_stderr(&node.stderr()), norm_stderr(&eng.stderr()), "stderr diagnostics");
    assert_eq!((node.term(), eng.term()), (Some(0), Some(0)), "SIGTERM exits 0");
    assert_eq!(fx.0.read("wake/childA.seen"), fx.1.read("wake/childA.seen"), "the persisted cursor");
    assert_eq!(fx.1.read("wake/childA.seen").unwrap(), "{\"lastTotal\":3,\"lastTotal2\":5,\"lastBroadcastUnread\":3,\"meshTotal\":5,\"ndjsonTotal\":3}");
    for f in [&fx.0, &fx.1] {
        assert!(!f.root().join("locks/wake-watch-childA.lock").exists(), "the lock is released");
    }
}

#[test]
fn old_cursor_files_and_a_cursor_written_by_the_other_role_do_not_wake_falsely() {
    if !have_node() {
        return;
    }
    for (tag, seen) in [
        ("legacy", "{\"lastTotal\":7,\"lastTotal2\":30}"),
        ("byprimary", "{\"lastTotal\":30,\"lastTotal2\":30,\"lastBroadcastUnread\":1,\"meshTotal\":30}"),
        ("newer", "{\"future\":{\"x\":1},\"lastTotal\":2,\"lastTotal2\":2,\"lastBroadcastUnread\":0,\"meshTotal\":2,\"ndjsonTotal\":1}"),
        ("garbage", "[1,2"),
    ] {
        let fx = pair(tag);
        let h = hash_of("childA");
        for f in [&fx.0, &fx.1] {
            f.write(&format!("summaries/{h}.json"), &summary(&h, &[("childA", 30, Some(189))]));
            f.write("inbox/childA.ndjson", "{\"a\":1}\n{\"b\":2}\n");
            f.write("wake/childA.seen", seen);
        }
        let mut sides = (fx.0.spawn(Kind::Node, CHILD_ENV, &["--auto"]), fx.1.spawn(Kind::Engine, CHILD_ENV, &["--auto"]));
        for s in [&sides.0, &sides.1] {
            s.wait_lines(1, "armed");
        }
        std::thread::sleep(Duration::from_millis(1100));
        assert_eq!(sides.0.lines(), sides.1.lines(), "{tag}: node vs engine");
        let (a, b) = (sides.0.term(), sides.1.term());
        assert_eq!((a, b), (Some(0), Some(0)), "{tag}");
        assert_eq!(fx.0.read("wake/childA.seen"), fx.1.read("wake/childA.seen"), "{tag}: the persisted cursor");
    }
}

fn git(args: &[&str], cwd: &Path) {
    let st = Command::new("git")
        .args(["-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "init.defaultBranch=main", "-c", "commit.gpgsign=false"])
        .args(args)
        .current_dir(cwd)
        .env_remove("GIT_DIR")
        .env_remove("GIT_WORK_TREE")
        .output()
        .unwrap();
    assert!(st.status.success(), "git {args:?}");
}

/// A repo at the fixture's working directory (a Primary runs from its checkout) with, optionally, a registered child workspace so the
/// Primary has someone to hear from. Returns its repo key and Primary id.
fn primary_fixture(f: &Fx, with_child: bool) -> (String, String) {
    let repo = &f.cwd;
    git(&["init", "-q"], repo);
    git(&["commit", "-q", "--allow-empty", "-m", "init"], repo);
    if with_child {
        let child_wt = f.home.parent().unwrap().join("child-wt");
        git(&["worktree", "add", "-q", child_wt.to_str().unwrap(), "-b", "child-branch"], repo);
        f.write(
            "workspaces/child1.json",
            &format!("{{\"id\":\"child1\",\"worktreePath\":\"{}\",\"sessionId\":\"sess-1\"}}", fs::canonicalize(&child_wt).unwrap().display()),
        );
    }
    let real = fs::canonicalize(repo).unwrap();
    let key = ident::repo_key_for_worktree(real.to_str().unwrap()).unwrap().unwrap();
    let id = ident::primary_workspace_id(real.to_str().unwrap()).unwrap();
    (key, id)
}

#[test]
fn a_primary_watcher_prints_the_same_lines_as_node() {
    if !have_node() {
        return;
    }
    let fx = pair("primary");
    let mut ids = Vec::new();
    for f in [&fx.0, &fx.1] {
        ids.push(primary_fixture(f, true));
    }
    // the repo paths differ between the two fixtures, so each side gets its own ids; the lines carry the id, so compare shapes
    let id_of = |i: usize| ids[i].1.clone();
    for (i, f) in [&fx.0, &fx.1].into_iter().enumerate() {
        f.write(&format!("summaries/{}.json", ids[i].0), &summary(&ids[i].0, &[(&id_of(i), 3, Some(0))]));
    }
    let repo_env = [("DEVSWARM_REPO_ID", "repo-1")];
    let mut node = fx.0.spawn(Kind::Node, &repo_env, &["--auto"]);
    let mut eng = fx.1.spawn(Kind::Engine, &repo_env, &["--auto"]);
    node.wait_lines(1, "armed");
    eng.wait_lines(1, "armed");
    let shape = |lines: Vec<String>, id: &str| -> Vec<String> { lines.into_iter().map(|l| l.replace(id, "<ID>")).collect() };
    assert_eq!(shape(node.lines(), &id_of(0)), shape(eng.lines(), &id_of(1)), "the arm line");
    fx.0.write(&format!("summaries/{}.json", ids[0].0), &summary(&ids[0].0, &[(&id_of(0), 6, Some(0))]));
    fx.1.write(&format!("summaries/{}.json", ids[1].0), &summary(&ids[1].0, &[(&id_of(1), 6, Some(0))]));
    node.wait_lines(2, "mail");
    eng.wait_lines(2, "mail");
    std::thread::sleep(Duration::from_millis(1100));
    assert_eq!(shape(node.lines(), &id_of(0)), shape(eng.lines(), &id_of(1)));
    assert!(node.lines()[1].contains("direct total 3 -> 6 (+3)"), "{:?}", node.lines());
    assert_eq!((node.term(), eng.term()), (Some(0), Some(0)));
}

#[test]
fn refusals_print_the_same_and_an_idle_primary_is_left_to_node() {
    if !have_node() {
        return;
    }
    // not a DevSwarm session: silent when auto-started, one closed-vocabulary line when armed by the model
    for (args, expect) in [(&["--auto"][..], vec![]), (&[][..], vec!["[wake-watch] REFUSED TO ARM: not-a-devswarm-session".to_string()])] {
        let fx = pair("refuse");
        let (mut a, mut b) = (fx.0.spawn(Kind::Node, &[], args), fx.1.spawn(Kind::Engine, &[], args));
        assert_eq!((a.exited(), b.exited()), (Some(0), Some(0)));
        assert_eq!(a.lines(), expect);
        assert_eq!(b.lines(), expect);
        assert_eq!(norm_stderr(&a.stderr()), norm_stderr(&b.stderr()));
        assert!(fx.0.read("wake").is_none() && fx.1.read("wake").is_none(), "a refused watcher creates nothing");
    }
    // the setting switches it off
    let fx = pair("off");
    for f in [&fx.0, &fx.1] {
        fs::create_dir_all(f.home.join(".anti-hall")).unwrap();
        fs::write(f.home.join(".anti-hall").join("settings.json"), "{\"devswarm\":{\"wakeWatch\":false}}").unwrap();
    }
    let (mut a, mut b) = (fx.0.spawn(Kind::Node, CHILD_ENV, &[]), fx.1.spawn(Kind::Engine, CHILD_ENV, &[]));
    assert_eq!((a.exited(), b.exited()), (Some(0), Some(0)));
    assert_eq!(a.lines(), vec!["[wake-watch] REFUSED TO ARM: disabled-by-settings".to_string()]);
    assert_eq!(a.lines(), b.lines());
    // a Primary with no live child: Node prints its one idle line; the engine answers 75 and prints nothing
    let fx = pair("idle");
    let ids: Vec<(String, String)> = [&fx.0, &fx.1].iter().map(|f| primary_fixture(f, false)).collect();
    for (i, f) in [&fx.0, &fx.1].into_iter().enumerate() {
        f.write(&format!("summaries/{}.json", ids[i].0), &summary(&ids[i].0, &[(&ids[i].1, 3, Some(0))]));
    }
    let repo_env = [("DEVSWARM_REPO_ID", "repo-1")];
    let (mut a, mut b) = (fx.0.spawn(Kind::Node, &repo_env, &["--auto"]), fx.1.spawn(Kind::Engine, &repo_env, &["--auto"]));
    assert_eq!(a.exited(), Some(0));
    assert_eq!(b.exited(), Some(75), "the engine leaves the idle line to Node");
    assert!(a.lines().len() == 1 && a.lines()[0].starts_with("[wake-watch] idle-skip: no live child workspaces"), "{:?}", a.lines());
    assert!(b.lines().is_empty(), "nothing printed before a deferral");
    assert!(fx.1.read("rearm-cues.jsonl").is_none() && fx.1.read("wake").is_none(), "nothing written before a deferral");
}

#[test]
fn a_second_watcher_for_the_same_workspace_is_refused_and_the_first_keeps_running() {
    if !have_node() {
        return;
    }
    let fx = pair("lock");
    let h = hash_of("childA");
    for f in [&fx.0, &fx.1] {
        f.write(&format!("summaries/{h}.json"), &summary(&h, &[("childA", 2, Some(0))]));
    }
    let (mut n1, mut e1) = (fx.0.spawn(Kind::Node, CHILD_ENV, &["--auto"]), fx.1.spawn(Kind::Engine, CHILD_ENV, &["--auto"]));
    n1.wait_lines(1, "armed");
    e1.wait_lines(1, "armed");
    let (mut n2, mut e2) = (fx.0.spawn(Kind::Node, CHILD_ENV, &["--auto"]), fx.1.spawn(Kind::Engine, CHILD_ENV, &["--auto"]));
    assert_eq!((n2.exited(), e2.exited()), (Some(0), Some(0)), "a refused second watcher exits 0");
    assert_eq!(n2.lines(), vec!["[wake-watch] REFUSED TO ARM: lock-held".to_string()]);
    assert_eq!(e2.lines(), n2.lines());
    let held = |s: &Side| s.stderr().into_iter().find(|l| l.contains("already holds the lock")).unwrap_or_default();
    let strip = |l: String| l.split(" (holder").next().unwrap_or_default().to_string();
    assert_eq!(strip(held(&n2)), strip(held(&e2)));
    assert!(held(&e2).contains("session=unavailable") && held(&e2).contains("version="), "{}", held(&e2));
    // the holder's lock carries its build and is still ours
    let lock = fx.1.read("locks/wake-watch-childA.lock").unwrap();
    assert!(lock.contains("\"version\":\"") && lock.contains("\"token\":"), "{lock}");
    assert_eq!((n1.term(), e1.term()), (Some(0), Some(0)));
}
