//! The native kill-and-resume (lane l7b) against Node's own `target-session.js` and `recovery.js`: the confirm-gate on a corpus
//! of process tables, the whole `recover` sequence (signals, recovery log, liveness verdict, return value) on scenario after
//! scenario with the machine faked on both sides, and one test with a REAL process that is killed through the real signals.
use ah_engine::db::TempDir;
use ah_engine::dsact::runner::System;
use ah_engine::dssup::kill::{self, Job, Sys, Target};
use serde_json::{Value, json};
use std::cell::RefCell;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Command;

fn have_node() -> bool {
    Command::new("node").arg("--version").output().is_ok_and(|o| o.status.success())
}

fn plugin() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap().join("plugins").join("anti-hall")
}

fn node(code: &str, args: &[&str]) -> Value {
    let o = Command::new("node").args(["-e", code]).arg(plugin()).args(args).env("ANTIHALL_TEST_ISOLATION", "1").output().unwrap();
    assert!(o.status.success(), "node: {}", String::from_utf8_lossy(&o.stderr));
    serde_json::from_str(String::from_utf8_lossy(&o.stdout).lines().last().unwrap_or("null")).unwrap_or(Value::Null)
}

const S: &str = "11111111-2222-3333-4444-555555555555";
const OTHER: &str = "99999999-2222-3333-4444-555555555555";
const W: &str = "/work/ws-1";

/// A faked machine: a process table, working directories, transcripts and which pids are alive; records every signal.
#[derive(Default)]
struct Fake {
    ps: RefCell<String>,
    cwd: RefCell<HashMap<i64, String>>,
    transcripts: RefCell<Vec<String>>,
    alive: RefCell<bool>,
    self_pid: i64,
    signals: RefCell<Vec<(String, i64, i32)>>,
    printed: String,
    /// after the SIGTERM wait, replace the process table (a recycled pid)
    after_grace: RefCell<Option<String>>,
    resumed: RefCell<Vec<(String, String, String)>>,
}

impl Sys for Fake {
    fn ps(&self) -> String {
        self.ps.borrow().clone()
    }
    fn cwd_of(&self, pid: i64) -> Option<String> {
        self.cwd.borrow().get(&pid).cloned()
    }
    fn transcript_exists(&self, _dir: &Path, uuid: &str) -> bool {
        self.transcripts.borrow().iter().any(|t| t == uuid)
    }
    fn kill(&self, pid: i64, sig: i32) -> bool {
        self.signals.borrow_mut().push(("pid".into(), pid, sig));
        sig != 0 || *self.alive.borrow()
    }
    fn kill_group(&self, pid: i64, sig: i32) -> bool {
        self.signals.borrow_mut().push(("group".into(), pid, sig));
        true
    }
    fn sleep(&self, _ms: u64) {
        if let Some(t) = self.after_grace.borrow_mut().take() {
            *self.ps.borrow_mut() = t;
        }
    }
    fn spawn_resume(&self, uuid: &str, cwd: &str, prompt: &str) -> String {
        self.resumed.borrow_mut().push((uuid.into(), cwd.into(), prompt.into()));
        self.printed.clone()
    }
    fn self_pid(&self) -> i64 {
        self.self_pid
    }
}

fn row(pid: i64, ppid: i64, cmd: &str) -> String {
    format!("{pid:>6} {ppid:>6} {cmd}\n")
}

/// Each case: the process table, the working directories, the transcripts present, self pid, whether an interactive session is allowed.
struct Case {
    name: &'static str,
    ps: String,
    cwd: Vec<(i64, &'static str)>,
    transcripts: Vec<&'static str>,
    self_pid: i64,
    allow_interactive: bool,
    worktree: &'static str,
    session: &'static str,
}

fn cases() -> Vec<Case> {
    let c = |name, ps: String, cwd: Vec<(i64, &'static str)>, transcripts: Vec<&'static str>| Case {
        name,
        ps,
        cwd,
        transcripts,
        self_pid: 7,
        allow_interactive: false,
        worktree: W,
        session: S,
    };
    let head = format!("claude -p --resume {S} --dangerously-skip-permissions");
    vec![
        c("one headless match", row(1, 0, "/sbin/launchd") + &row(100, 1, &head), vec![(100, W)], vec![S]),
        c(
            "a shell wrapper and the claude child both match: ambiguous",
            row(200, 1, &format!("sh -c claude -p --resume {S}")) + &row(201, 200, &head),
            vec![(200, W), (201, W)],
            vec![S],
        ),
        c("interactive only: left alone by default", row(100, 1, &format!("claude --resume {S}")), vec![(100, W)], vec![S]),
        Case {
            allow_interactive: true,
            ..c("interactive allowed by the owner's recover", row(100, 1, &format!("claude --resume {S}")), vec![(100, W)], vec![S])
        },
        c("the cwd differs", row(100, 1, &head), vec![(100, "/work/other")], vec![S]),
        c("the cwd is the worktree spelled with a trailing slash and dots", row(100, 1, &head), vec![(100, "/work/./ws-1/")], vec![S]),
        c("no transcript for the session", row(100, 1, &head), vec![(100, W)], vec![]),
        c("another session", row(100, 1, &format!("claude -p --resume {OTHER}")), vec![(100, W)], vec![S, OTHER]),
        Case { self_pid: 100, ..c("the engine's own pid is never a target", row(100, 1, &head), vec![(100, W)], vec![S]) },
        Case {
            self_pid: 50,
            ..c("a descendant of the engine is never a target", row(50, 1, "ah-engine serve") + &row(100, 50, &head), vec![(100, W)], vec![S])
        },
        c("an empty process table", String::new(), vec![], vec![S]),
        c("claudette is not claude", row(100, 1, &format!("claudette -p --resume {S}")), vec![(100, W)], vec![S]),
        c("CLAUDE in capitals matches", row(100, 1, &format!("/usr/bin/CLAUDE -p --resume {S}")), vec![(100, W)], vec![S]),
        c("--session-id works like --resume", row(100, 1, &format!("claude -p --session-id {S}")), vec![(100, W)], vec![S]),
        c("--print is headless", row(100, 1, &format!("claude --print --resume {S}")), vec![(100, W)], vec![S]),
        c("-p inside another word is not the flag", row(100, 1, &format!("claude --resume {S} --append-prompt")), vec![(100, W)], vec![S]),
        c("an unreadable cwd", row(100, 1, &head), vec![], vec![S]),
        Case { worktree: "", ..c("no worktree", row(100, 1, &head), vec![(100, W)], vec![S]) },
        Case { session: "", ..c("no session id", row(100, 1, &head), vec![(100, W)], vec![S]) },
        c("garbage lines are skipped", "garbage\n  x y z\n".to_string() + &row(100, 1, &head), vec![(100, W)], vec![S]),
    ]
}

fn fake_of(c: &Case) -> Fake {
    let f = Fake { self_pid: c.self_pid, ..Fake::default() };
    *f.ps.borrow_mut() = c.ps.clone();
    *f.cwd.borrow_mut() = c.cwd.iter().map(|(p, d)| (*p, (*d).to_string())).collect();
    *f.transcripts.borrow_mut() = c.transcripts.iter().map(|t| (*t).to_string()).collect();
    f
}

#[test]
fn the_confirm_gate_picks_nodes_target_on_every_process_table() {
    if !have_node() {
        return;
    }
    ah_engine::defaults::init().unwrap();
    let home = Path::new("/home/x");
    for c in cases() {
        let fx = json!({"ps": c.ps, "cwd": c.cwd.iter().map(|(p, d)| (p.to_string(), d)).collect::<HashMap<_, _>>(), "transcripts": c.transcripts,
                        "selfPid": c.self_pid, "worktree": c.worktree, "session": c.session, "allowInteractive": c.allow_interactive, "home": "/home/x"});
        let theirs = node(
            "const T=require(process.argv[1]+'/companion/lib/target-session.js');const fx=JSON.parse(process.argv[2]);const runners={ps:()=>fx.ps,cwdOf:(p)=>(fx.cwd[p]===undefined?null:fx.cwd[p]),transcriptExists:(d,u)=>fx.transcripts.includes(u)};console.log(JSON.stringify(T.findTarget({worktreePath:fx.worktree,sessionId:fx.session,home:fx.home,runners,selfPid:fx.selfPid,allowInteractive:fx.allowInteractive})))",
            &[&fx.to_string()],
        );
        let mine = kill::find_target(&fake_of(&c), home, c.worktree, c.session, c.allow_interactive).to_json(c.worktree);
        assert_eq!(mine, theirs, "case {:?}", c.name);
    }
    // the corpus decides all three ways
    let kinds: Vec<String> = cases()
        .iter()
        .map(|c| match kill::find_target(&fake_of(c), home, c.worktree, c.session, c.allow_interactive) {
            Target::One { .. } => "one".to_string(),
            Target::Ambiguous { reason, .. } => reason,
        })
        .collect();
    for want in ["one", "multiple-candidates", "interactive-candidate", "no-candidate", "no-worktree-path", "no-session-id"] {
        assert!(kinds.iter().any(|k| k == want), "{want} is exercised: {kinds:?}");
    }
    // the transcript directory name is the lossy forward-only encoding
    assert_eq!(kill::encode_worktree_path("/Users/x/a.b:c\\d"), "-Users-x-a-b-c-d");
    assert_eq!(kill::project_dir("/w/x", home), PathBuf::from("/home/x/.claude/projects/-w-x"));
}

#[test]
fn the_unread_backlog_is_the_inbox_after_the_cursor_as_nodes_is() {
    if !have_node() {
        return;
    }
    let t = TempDir::new("backlog");
    let d = std::fs::canonicalize(&t.0).unwrap();
    std::fs::write(d.join("inbox"), "one\n\ntwo\n  \nthree\nfour\n").unwrap();
    let mut cases: Vec<(Option<&str>, Option<String>)> = vec![];
    for (name, body) in [
        ("c0", Some("0")),
        ("c2", Some("2")),
        ("cjson", Some("{\"line\":1}")),
        ("cbig", Some("99")),
        ("cbad", Some("nope")),
        ("cneg", Some("-1")),
        ("cnone", None),
    ] {
        if let Some(b) = body {
            std::fs::write(d.join(name), b).unwrap();
        }
        cases.push((Some("inbox"), Some(name.to_string())));
    }
    cases.push((None, Some("c0".into())));
    cases.push((Some("missing"), Some("c0".into())));
    for (inbox, cursor) in cases {
        let (i, c) = (inbox.map(|x| d.join(x).to_string_lossy().into_owned()), cursor.as_ref().map(|x| d.join(x).to_string_lossy().into_owned()));
        let theirs = node(
            "const L=require(process.argv[1]+'/companion/lib/liveness.js');const a=process.argv.slice(2);const r=L.unreadBacklog(a[0]==='-'?null:a[0],a[1]==='-'?null:a[1]);console.log(JSON.stringify(r.lines))",
            &[i.as_deref().unwrap_or("-"), c.as_deref().unwrap_or("-")],
        );
        assert_eq!(json!(kill::unread_backlog(i.as_deref(), c.as_deref())), theirs, "{inbox:?} {cursor:?}");
    }
}

// ---- the whole sequence ------------------------------------------------------------------------------------------------------

struct Scenario {
    name: &'static str,
    /// the verdict file before (recoveries etc.), or none
    prior: Option<Value>,
    /// is the pid still alive after the SIGTERM grace
    survives: bool,
    /// `reconfirm` answers in order (Node's io.reconfirm); the engine gets the same effect from its process table
    reconfirm: Vec<bool>,
    printed: &'static str,
    ambiguous: bool,
    locked: bool,
}

fn scenarios() -> Vec<Scenario> {
    let s = |name, survives, reconfirm: Vec<bool>| Scenario { name, prior: None, survives, reconfirm, printed: "", ambiguous: false, locked: false };
    vec![
        s("terminated by SIGTERM and resumed", false, vec![true]),
        s("survives the grace: SIGKILL after a second confirmation", true, vec![true, true]),
        s("identity changed before SIGTERM", false, vec![false]),
        s("identity changed during the grace: no SIGKILL", true, vec![true, false]),
        Scenario {
            prior: Some(json!({"status": "stale", "recoveries": 3, "nudgeAttempts": 2, "nudgedAt": 5})),
            ..s("max recoveries reached: escalate", false, vec![true])
        },
        Scenario {
            prior: Some(json!({"status": "stale", "recoveries": 1, "nudgeAttempts": 2, "nudgedAt": 5, "staleSince": 9})),
            ..s("a second recovery keeps the other path's fields", false, vec![true])
        },
        Scenario { printed: "Error: No conversation found with session ID", ..s("the session no longer exists: escalate", false, vec![true]) },
        Scenario { ambiguous: true, ..s("ambiguous target: abstain, nothing signalled", false, vec![]) },
        Scenario { locked: true, ..s("another recovery of this id holds the lock", false, vec![true]) },
    ]
}

fn norm_log(t: &str) -> Vec<String> {
    t.lines().map(regex_ts).collect()
}

fn regex_ts(l: &str) -> String {
    match l.find("\"ts\":") {
        Some(i) => {
            let rest = &l[i + 5..];
            let end = rest.find([',', '}']).unwrap_or(rest.len());
            format!("{}\"ts\":T{}", &l[..i], &rest[end..])
        }
        None => l.to_string(),
    }
}

#[test]
fn recover_does_what_nodes_recover_does_scenario_by_scenario() {
    if !have_node() {
        return;
    }
    ah_engine::defaults::init().unwrap();
    for sc in scenarios() {
        let t = TempDir::new("recover");
        let root = std::fs::canonicalize(&t.0).unwrap();
        let (he, hn) = (root.join("engine-home"), root.join("node-home"));
        let desc = json!({"id": "ws-1", "worktreePath": W, "sessionId": S, "inboxPath": root.join("inbox"), "cursorPath": root.join("cursor")});
        std::fs::write(root.join("inbox"), "m1\nm2\nm3\n").unwrap();
        std::fs::write(root.join("cursor"), "1").unwrap();
        for h in [&he, &hn] {
            std::fs::create_dir_all(h.join(".anti-hall/devswarm/liveness")).unwrap();
            if let Some(p) = &sc.prior {
                std::fs::write(h.join(".anti-hall/devswarm/liveness/ws-1.json"), p.to_string()).unwrap();
            }
        }
        let now = 1_790_000_000_000i64;
        // ---- Node, with the machine faked through its io
        let target = if sc.ambiguous {
            json!({"ambiguous": true, "reason": "multiple-candidates", "candidates": []})
        } else {
            json!({"pid": 100, "uuid": S, "worktreePath": W})
        };
        let spec =
            json!({"desc": desc, "target": target, "now": now, "survives": sc.survives, "reconfirm": sc.reconfirm, "printed": sc.printed, "locked": sc.locked});
        let theirs = node(
            "const R=require(process.argv[1]+'/companion/lib/recovery.js');const sp=JSON.parse(process.argv[3]);process.env.HOME=process.argv[2];const sig=[];let rc=0;const io={platform:'linux',selfPid:7,kill:(p,s)=>{sig.push(['pid',p,s]);return s===0?sp.survives:true},killGroup:(p,s)=>{sig.push(['group',p,s]);return true},sleep:()=>{},reconfirm:()=>{const v=sp.reconfirm[rc++];return v===undefined?true:v},spawnResume:(a)=>({output:sp.printed,uuid:a.uuid,cwd:a.cwd,prompt:a.prompt})};if(sp.locked)io.lock=()=>null;const ret=R.recover({descriptor:sp.desc,target:sp.target,home:process.argv[2],now:sp.now,maxRecoveries:3,graceMs:5000,allowInteractive:true,io});console.log(JSON.stringify({ret,sig}))",
            &[hn.to_str().unwrap(), &spec.to_string()],
        );
        // ---- the engine, same machine: the process table the reconfirm reads is scripted to give the same answers
        let fake = Fake { self_pid: 7, ..Fake::default() };
        *fake.alive.borrow_mut() = sc.survives;
        let table = row(100, 1, &format!("claude -p --resume {S}"));
        *fake.ps.borrow_mut() = table.clone();
        fake.cwd.borrow_mut().insert(100, W.into());
        fake.transcripts.borrow_mut().push(S.into());
        // reconfirm #1 is the first verify, #2 the verify after the grace
        match sc.reconfirm.as_slice() {
            [false] => *fake.ps.borrow_mut() = String::new(),
            [true, false] => *fake.after_grace.borrow_mut() = Some(String::new()),
            _ => {}
        }
        let held = sc.locked.then(|| ah_engine::meshw::idlock::acquire(&he, "ws-1").unwrap());
        let mut fake = fake;
        fake.printed = sc.printed.to_string();
        let tgt = if sc.ambiguous {
            Target::Ambiguous { reason: "multiple-candidates".into(), candidates: vec![] }
        } else {
            Target::One { pid: 100, uuid: S.into() }
        };
        let job = Job { home: &he, id: "ws-1", descriptor: &desc, now, max_recoveries: 3, grace_ms: 5000, allow_interactive: true };
        let mine = kill::recover(&fake, &job, &tgt);
        if let Some(h) = held {
            h.release();
        }
        assert_eq!(mine, theirs["ret"], "{}: the return value", sc.name);
        let sigs: Vec<Value> = fake
            .signals
            .borrow()
            .iter()
            .map(|(k, p, s)| {
                json!([
                    k,
                    p,
                    if *s == libc::SIGTERM {
                        "SIGTERM"
                    } else if *s == libc::SIGKILL {
                        "SIGKILL"
                    } else {
                        "0"
                    }
                ])
            })
            .collect();
        let node_sigs: Vec<Value> =
            theirs["sig"].as_array().unwrap().iter().map(|s| json!([s[0], s[1], if s[2] == 0 { json!("0") } else { s[2].clone() }])).collect();
        assert_eq!(json!(sigs), json!(node_sigs), "{}: the signals, in order", sc.name);
        let rd = |h: &Path, rel: &str| std::fs::read_to_string(h.join(".anti-hall/devswarm").join(rel)).unwrap_or_default();
        assert_eq!(norm_log(&rd(&he, "recovery.log")), norm_log(&rd(&hn, "recovery.log")), "{}: the recovery log", sc.name);
        assert_eq!(rd(&he, "liveness/ws-1.json"), rd(&hn, "liveness/ws-1.json"), "{}: the liveness verdict, byte for byte", sc.name);
        // the resume got the guardrail, then the unread backlog (after the cursor) and the worktree as cwd
        let resumed = fake.resumed.borrow();
        if mine["action"] == "resumed" || sc.printed.contains("No conversation") {
            assert_eq!(resumed.len(), 1, "{}", sc.name);
            assert_eq!((resumed[0].0.as_str(), resumed[0].1.as_str()), (S, W));
            assert!(resumed[0].2.starts_with("You were interrupted mid-task and resumed.") && resumed[0].2.ends_with("\n\nm2\nm3"), "{}", resumed[0].2);
        } else {
            assert!(resumed.is_empty(), "{}: nothing was resumed", sc.name);
        }
    }
}

// ---- a real process --------------------------------------------------------------------------------------------------------------

/// Everything real except the resume (which would start Claude).
struct RealButResume<'a> {
    inner: kill::Real<'a>,
    resumed: RefCell<Vec<String>>,
}

impl Sys for RealButResume<'_> {
    fn ps(&self) -> String {
        self.inner.ps()
    }
    fn cwd_of(&self, pid: i64) -> Option<String> {
        self.inner.cwd_of(pid)
    }
    fn transcript_exists(&self, d: &Path, u: &str) -> bool {
        self.inner.transcript_exists(d, u)
    }
    fn kill(&self, pid: i64, sig: i32) -> bool {
        self.inner.kill(pid, sig)
    }
    fn kill_group(&self, pid: i64, sig: i32) -> bool {
        self.inner.kill_group(pid, sig)
    }
    fn sleep(&self, ms: u64) {
        self.inner.sleep(ms.min(300));
    }
    fn spawn_resume(&self, uuid: &str, _cwd: &str, _prompt: &str) -> String {
        self.resumed.borrow_mut().push(uuid.to_string());
        String::new()
    }
    fn self_pid(&self) -> i64 {
        2_000_000_000 // a pid that is in no table: the test's own child is not the engine's descendant here, or the gate would (correctly) exclude it
    }
}

#[test]
fn a_real_process_is_confirmed_signalled_and_only_that_one() {
    ah_engine::defaults::init().unwrap();
    let t = TempDir::new("real-kill");
    let root = std::fs::canonicalize(&t.0).unwrap();
    let (home, wt) = (root.join("home"), root.join("wt"));
    std::fs::create_dir_all(&wt).unwrap();
    let wt_s = wt.to_string_lossy().into_owned();
    let uuid = "abcdefab-1234-5678-9abc-def012345678";
    let pdir = kill::project_dir(&wt_s, &home);
    std::fs::create_dir_all(&pdir).unwrap();
    std::fs::write(pdir.join(format!("{uuid}.jsonl")), "{}\n").unwrap();
    // the target: a headless-looking claude (argv names claude, -p and the session) running in the worktree
    let mut target = Command::new("perl").args(["-e", "sleep 120", "claude", "-p", "--resume", uuid]).current_dir(&wt).spawn().unwrap();
    // a bystander with the same session id in ANOTHER directory, and a claude of another session in the right one
    let mut bystander = Command::new("perl").args(["-e", "sleep 120", "claude", "-p", "--resume", uuid]).current_dir(&root).spawn().unwrap();
    let mut other =
        Command::new("perl").args(["-e", "sleep 120", "claude", "-p", "--resume", "00000000-0000-0000-0000-000000000000"]).current_dir(&wt).spawn().unwrap();
    std::thread::sleep(std::time::Duration::from_millis(400));
    let sys = RealButResume {
        inner: kill::Real { runner: &System::configured(), claude: PathBuf::from("claude"), readiness_ms: 100 },
        resumed: RefCell::new(vec![]),
    };
    let found = kill::find_target(&sys, &home, &wt_s, uuid, true);
    let pid = match &found {
        Target::One { pid, uuid: u } => {
            assert_eq!(u, uuid);
            *pid
        }
        other => panic!("expected the one confirmed process, got {other:?}"),
    };
    assert_eq!(pid, i64::from(target.id()), "the confirmed process is the one that was started in the worktree");
    // in production the target's parent reaps it; here the test is the parent, so a thread does, or a zombie would still answer kill(pid, 0)
    let reaper = std::thread::spawn(move || target.wait().unwrap());
    let desc = json!({"id": "ws-1", "worktreePath": wt_s, "sessionId": uuid});
    let job = Job { home: &home, id: "ws-1", descriptor: &desc, now: 1_790_000_000_000, max_recoveries: 3, grace_ms: 300, allow_interactive: true };
    let out = kill::recover(&sys, &job, &found);
    assert_eq!(out["action"], "resumed", "{out}");
    // the target is gone (reaped by wait); the bystander and the other session are untouched
    let status = reaper.join().unwrap();
    assert!(!status.success(), "terminated by a signal");
    assert!(bystander.try_wait().unwrap().is_none(), "same session id in another directory: left alone");
    assert!(other.try_wait().unwrap().is_none(), "another session in the same directory: left alone");
    assert_eq!(sys.resumed.borrow().as_slice(), [uuid.to_string()]);
    let log = std::fs::read_to_string(home.join(".anti-hall/devswarm/recovery.log")).unwrap();
    assert!(log.contains("\"action\":\"sigterm\"") && log.contains("\"action\":\"resumed\""), "{log}");
    let v: Value = serde_json::from_str(&std::fs::read_to_string(home.join(".anti-hall/devswarm/liveness/ws-1.json")).unwrap()).unwrap();
    assert_eq!((v["status"].as_str(), v["recoveries"].as_u64()), (Some("recovering"), Some(1)));
    // with the target gone there is nothing to confirm: a second request abstains without a signal
    let again = kill::find_target(&sys, &home, &wt_s, uuid, true);
    assert!(matches!(again, Target::Ambiguous { ref reason, .. } if reason == "no-candidate"), "{again:?}");
    for c in [&mut bystander, &mut other] {
        c.kill().unwrap();
        c.wait().unwrap();
    }
}
