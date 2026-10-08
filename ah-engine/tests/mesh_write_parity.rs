//! D45 stage 2 parity: `ah-engine mesh <argv>` (mesh.engine_writes = on) against `node scripts/devswarm.js <argv>` on
//! identical scratch homes.
//!
//! Every case builds ONE seeded scratch home (a real git repo with a linked child worktree; the store written by Node's own
//! `devswarm-store.js`), copies it twice, runs Node (`verb.js`: devswarm.js `run()` + `main()`'s rendering, `ctx.now`
//! pinned) on one copy and the engine binary on the other with the same pinned clock, then compares, byte for byte:
//! stdout, the exit code, a raw dump of every store table (every column, rowids and `sqlite_sequence` included; only the
//! wall-clock `updated_at` of the cursor tables is masked, since Node stamps it with `Date.now()`), Node's own canonical
//! dump of both stores (`mesh_support/dump.js`), and every file of the home tree except the store files (compared above),
//! `summaries/` (the summary refresh stays with Node: documented gap) and the engine's own state directory.
//! The engine must ANSWER every `native` case itself (its on-mode log says `native`); a `defer` case must be handed to
//! Node, whose output then is the engine's output.
//!
//! Isolation: HOME is a scratch directory, `ANTIHALL_INGEST_DRY_RUN=1`, `ANTIHALL_DEVSWARM_APP_DB=off`, the environment is
//! cleared, the engine state directory is scratch; nothing under the real home is read or written.
#![allow(clippy::unwrap_used, clippy::expect_used)] // a test crate: a panic is the failure report, and E2 exempts tests
use std::fs;
use std::path::Path;
use std::process::Command;

#[path = "mesh_write_support/fx.rs"]
mod fx;
use fx::*;

struct Case {
    name: &'static str,
    cwd: &'static str,
    argv: Vec<String>,
    stdin: Option<&'static str>,
    extra: Vec<(&'static str, String)>,
    native: bool,
}

#[test]
fn engine_verbs_match_node_byte_for_byte() {
    if !node_sqlite_available() {
        eprintln!("SKIPPED: Node with node:sqlite is not available, so there is no Node writer to compare with");
        return;
    }
    let fx = fixture("parity");
    let s = |x: &str| x.to_string();
    let child_mesh = fx.child_mesh.clone();
    let primary = fx.primary_id.clone();
    let msg_file = fx.root.join("body.txt");
    fs::write(&msg_file, "from a file — with an em dash\nand a second line\n").unwrap();
    let mf = msg_file.to_string_lossy().to_string();
    let as_child = vec![("DEVSWARM_BUILDER_ID", s("child-1"))];
    let cases = vec![
        Case {
            name: "send-direct",
            cwd: "main",
            argv: vec![s("send"), s("--to"), s("child-1"), s("--message"), s("hello child")],
            stdin: None,
            extra: vec![],
            native: true,
        },
        Case {
            name: "send-direct-urgent-question",
            cwd: "main",
            argv: vec![s("send"), s("--to"), s("child-1"), s("--message"), s("can you?"), s("--question"), s("--urgency"), s("urgent")],
            stdin: None,
            extra: vec![],
            native: true,
        },
        Case {
            name: "send-direct-answers",
            cwd: "main",
            argv: vec![s("send"), s("--to=child-1"), s("--answers"), s("--message"), s("done")],
            stdin: None,
            extra: vec![],
            native: true,
        },
        Case {
            name: "send-by-meshid",
            cwd: "main",
            argv: vec![s("send"), s("--to"), child_mesh.clone(), s("--message"), s("via mesh id")],
            stdin: None,
            extra: vec![],
            native: true,
        },
        Case {
            name: "send-quiet",
            cwd: "main",
            argv: vec![s("send"), s("--to"), s("child-1"), s("--message"), s("quiet one"), s("--quiet")],
            stdin: None,
            extra: vec![],
            native: true,
        },
        Case {
            name: "send-quiet-json",
            cwd: "main",
            argv: vec![s("send"), s("--to"), s("child-1"), s("--message"), s("q"), s("--quiet"), s("--json")],
            stdin: None,
            extra: vec![],
            native: true,
        },
        Case {
            name: "send-file",
            cwd: "main",
            argv: vec![s("send"), s("--to"), s("child-1"), s("--message-file"), mf.clone()],
            stdin: None,
            extra: vec![],
            native: true,
        },
        Case {
            name: "send-stdin",
            cwd: "main",
            argv: vec![s("send"), s("--to"), s("child-1"), s("--message-stdin")],
            stdin: Some("body on stdin\n🚀 unicode"),
            extra: vec![],
            native: true,
        },
        Case {
            name: "send-broadcast",
            cwd: "main",
            argv: vec![s("send"), s("--broadcast"), s("--message"), s("all hands"), s("--urgency"), s("high")],
            stdin: None,
            extra: vec![],
            native: true,
        },
        Case {
            name: "send-type-broadcast",
            cwd: "main",
            argv: vec![s("send"), s("--type"), s("broadcast"), s("--message"), s("typed")],
            stdin: None,
            extra: vec![],
            native: true,
        },
        Case {
            name: "send-to-primary-from-child",
            cwd: "child",
            argv: vec![s("send"), s("--to-primary"), s("--message"), s("report")],
            stdin: None,
            extra: as_child.clone(),
            native: true,
        },
        Case {
            name: "send-child-broadcast",
            cwd: "child",
            argv: vec![s("send"), s("--broadcast"), s("--message"), s("child says")],
            stdin: None,
            extra: as_child.clone(),
            native: true,
        },
        Case {
            name: "send-from-subdir",
            cwd: "main/sub",
            argv: vec![s("send"), s("--to"), s("child-1"), s("--message"), s("from a subdir")],
            stdin: None,
            extra: vec![],
            native: true,
        },
        Case {
            name: "send-from-matching",
            cwd: "main",
            argv: vec![s("send"), s("--to"), s("child-1"), s("--from"), primary.clone(), s("--message"), s("declared")],
            stdin: None,
            extra: vec![],
            native: true,
        },
        Case { name: "mesh-read-peek", cwd: "main", argv: vec![s("mesh"), s("read"), s("--peek")], stdin: None, extra: vec![], native: true },
        Case { name: "mesh-read-consume", cwd: "main", argv: vec![s("mesh"), s("read")], stdin: None, extra: vec![], native: true },
        Case { name: "mesh-read-child", cwd: "child", argv: vec![s("mesh"), s("read")], stdin: None, extra: as_child.clone(), native: true },
        Case { name: "mesh-read-seq", cwd: "main", argv: vec![s("mesh"), s("read"), s("--seq"), s("1")], stdin: None, extra: vec![], native: true },
        Case {
            name: "mesh-read-last",
            cwd: "main",
            argv: vec![s("mesh"), s("read"), s("--peek"), s("--last"), s("1")],
            stdin: None,
            extra: vec![],
            native: true,
        },
        Case { name: "mesh-history", cwd: "main", argv: vec![s("mesh"), s("history")], stdin: None, extra: vec![], native: true },
        Case { name: "mesh-history-last", cwd: "main", argv: vec![s("mesh"), s("history"), s("--last"), s("2")], stdin: None, extra: vec![], native: true },
        Case { name: "roster-ack", cwd: "main", argv: vec![s("roster"), s("--ack")], stdin: None, extra: vec![], native: true },
        // refusals and unported branches: the engine hands them to Node, so the output is Node's
        Case {
            name: "send-unregistered",
            cwd: "main",
            argv: vec![s("send"), s("--to"), s("nobody"), s("--message"), s("x")],
            stdin: None,
            extra: vec![],
            native: false,
        },
        Case { name: "send-no-target", cwd: "main", argv: vec![s("send"), s("--message"), s("x")], stdin: None, extra: vec![], native: false },
        Case {
            name: "send-two-targets",
            cwd: "main",
            argv: vec![s("send"), s("--to"), s("child-1"), s("--broadcast"), s("--message"), s("x")],
            stdin: None,
            extra: vec![],
            native: false,
        },
        Case {
            name: "send-empty",
            cwd: "main",
            argv: vec![s("send"), s("--to"), s("child-1"), s("--message"), s("")],
            stdin: None,
            extra: vec![],
            native: false,
        },
        Case {
            name: "send-bad-urgency",
            cwd: "main",
            argv: vec![s("send"), s("--to"), s("child-1"), s("--message"), s("x"), s("--urgency"), s("meh")],
            stdin: None,
            extra: vec![],
            native: false,
        },
        Case {
            name: "send-self",
            cwd: "main",
            argv: vec![s("send"), s("--to"), primary.clone(), s("--message"), s("me")],
            stdin: None,
            extra: vec![],
            native: false,
        },
        Case {
            name: "send-spoof",
            cwd: "main",
            argv: vec![s("send"), s("--to"), s("child-1"), s("--from"), s("child-2"), s("--message"), s("x")],
            stdin: None,
            extra: vec![],
            native: false,
        },
        Case {
            name: "send-multi",
            cwd: "main",
            argv: vec![s("send"), s("--to"), s("child-1,child-2"), s("--message"), s("x")],
            stdin: None,
            extra: vec![],
            native: false,
        },
        Case {
            name: "send-broadcast-question",
            cwd: "main",
            argv: vec![s("send"), s("--broadcast"), s("--question"), s("--message"), s("x")],
            stdin: None,
            extra: vec![],
            native: false,
        },
        Case {
            name: "send-not-git",
            cwd: "nogit",
            argv: vec![s("send"), s("--to"), s("child-1"), s("--message"), s("x")],
            stdin: None,
            extra: vec![],
            native: false,
        },
        Case { name: "send-help", cwd: "main", argv: vec![s("send"), s("--help")], stdin: None, extra: vec![], native: false },
        Case { name: "mesh-read-bare-seq", cwd: "main", argv: vec![s("mesh"), s("read"), s("--seq")], stdin: None, extra: vec![], native: false },
        Case { name: "mesh-read-last-consume", cwd: "main", argv: vec![s("mesh"), s("read"), s("--last"), s("1")], stdin: None, extra: vec![], native: false },
        Case {
            name: "mesh-read-since",
            cwd: "main",
            argv: vec![s("mesh"), s("read"), s("--peek"), s("--since"), s("2h")],
            stdin: None,
            extra: vec![],
            native: false,
        },
        Case {
            name: "jev-on-direct",
            cwd: "main",
            argv: vec![s("send"), s("--to"), s("child-1"), s("--message"), s("labelled?")],
            stdin: None,
            extra: vec![("ANTIHALL_JEV", s("1")), ("ANTIHALL_JEV_TRIAGE", s("0"))],
            native: false,
        },
    ];
    fs::create_dir_all(fx.main.join("sub")).unwrap();
    fs::create_dir_all(fx.root.join("nogit")).unwrap();
    let mut native = 0;
    let mut deferred = 0;
    for (i, c) in cases.iter().enumerate() {
        let now = 1_795_000_000_000 + i as i64 * 7_919;
        let cwd = match c.cwd {
            "main" => fx.main.clone(),
            "main/sub" => fx.main.join("sub"),
            "child" => fx.child.clone(),
            _ => fx.root.join("nogit"),
        };
        let (hn, he) = (fx.root.join(format!("{}-node", c.name)), fx.root.join(format!("{}-engine", c.name)));
        copy_tree(&fx.seed_home, &hn);
        copy_tree(&fx.seed_home, &he);
        for h in [&hn, &he] {
            fs::create_dir_all(h.join(".anti-hall")).unwrap();
            fs::write(h.join(".anti-hall").join("settings.json"), "{\"mesh\":{\"engine_writes\":\"on\"}}\n").unwrap();
        }
        let (sn, se) = (hn.join("state"), he.join("state"));
        let argv: Vec<&str> = c.argv.iter().map(String::as_str).collect();
        let extra: Vec<(&str, &str)> = c.extra.iter().map(|(k, v)| (*k, v.as_str())).collect();
        let n = node_verb(&hn, &sn, &cwd, &argv, now, c.stdin, &extra);
        let e = engine_verb(&he, &se, &cwd, &argv, now, c.stdin, &extra);
        let log = last_log(&se);
        let answered = log["result"] == "native";
        assert_eq!(answered, c.native, "{}: expected native={} but the engine logged {log}", c.name, c.native);
        if answered {
            native += 1;
        } else {
            deferred += 1;
        }
        if !c.native {
            // Node ran it for the engine; the timestamp of a Node run is its own clock, so only refusals are compared exactly
            assert_eq!(e.code, n.code, "{}: exit code of the fallback", c.name);
            if n.code != 0 {
                assert_eq!(e.stdout, n.stdout, "{}: stdout of the fallback", c.name);
            }
            continue;
        }
        assert_eq!((e.code, &e.stdout), (n.code, &n.stdout), "{}: stdout/exit differ", c.name);
        let db = |h: &Path| h.join(".anti-hall/devswarm/store").join(&fx.repo_key).join("devswarm.db");
        let (dn, de) = (raw_dump(&db(&hn)), raw_dump(&db(&he)));
        assert!(dn == de, "{}: raw store dump differs: {}", c.name, first_diff(&dn, &de));
        let (cn, ce) = (node_dump(&hn, &fx.repo_key), node_dump(&he, &fx.repo_key));
        assert!(cn == ce, "{}: canonical dump differs: {}", c.name, first_diff(&cn, &ce));
        let (fn_, fe) = (home_files(&hn), home_files(&he));
        let kn: Vec<&String> = fn_.keys().collect();
        let ke: Vec<&String> = fe.keys().collect();
        assert_eq!(kn, ke, "{}: home tree file set differs", c.name);
        for (k, v) in &fn_ {
            assert!(fe[k] == *v, "{}: {k} differs:\n node:   {}\n engine: {}", c.name, String::from_utf8_lossy(v), String::from_utf8_lossy(&fe[k]));
        }
    }
    eprintln!("parity: {} cases, {native} answered by the engine and byte-identical to Node, {deferred} handed to Node", cases.len());
    assert!(native >= 20 && deferred >= 10);
}

#[test]
fn a_duplicate_send_is_ignored_the_same_way() {
    if !node_sqlite_available() {
        eprintln!("SKIPPED: no node:sqlite");
        return;
    }
    let fx = fixture("dup");
    let now = 1_796_000_000_000;
    let argv = ["send", "--to", "child-1", "--message", "twice"];
    let (hn, he) = (fx.root.join("n"), fx.root.join("e"));
    copy_tree(&fx.seed_home, &hn);
    copy_tree(&fx.seed_home, &he);
    for h in [&hn, &he] {
        fs::write(h.join(".anti-hall").join("settings.json"), "{\"mesh\":{\"engine_writes\":\"on\"}}\n").unwrap();
    }
    // the same call twice at the same pinned millisecond: the second is a duplicate hash (sent:false, seq:null)
    for round in 0..2 {
        let n = node_verb(&hn, &hn.join("state"), &fx.main, &argv, now, None, &[]);
        let e = engine_verb(&he, &he.join("state"), &fx.main, &argv, now, None, &[]);
        assert_eq!(last_log(&he.join("state"))["result"], "native");
        assert_eq!((e.code, &e.stdout), (n.code, &n.stdout), "round {round}");
        if round == 1 {
            assert!(n.stdout.contains("\"sent\":false,\"seq\":null"), "{}", n.stdout);
        }
    }
    let db = |h: &Path| h.join(".anti-hall/devswarm/store").join(&fx.repo_key).join("devswarm.db");
    let (dn, de) = (raw_dump(&db(&hn)), raw_dump(&db(&he)));
    assert!(dn == de, "{}", first_diff(&dn, &de));
    assert!(dn.contains("## sqlite_sequence"), "AUTOINCREMENT state is compared too");
}

#[test]
fn off_mode_hands_every_call_to_node_and_shadow_logs_a_match() {
    if !node_sqlite_available() {
        eprintln!("SKIPPED: no node:sqlite");
        return;
    }
    let fx = fixture("modes");
    let home = fx.root.join("h");
    copy_tree(&fx.seed_home, &home);
    let state = home.join("state");
    let db = home.join(".anti-hall/devswarm/store").join(&fx.repo_key).join("devswarm.db");
    let count = || rusqlite::Connection::open(&db).unwrap().query_row("SELECT COUNT(*) FROM messages", [], |r| r.get::<_, i64>(0)).unwrap();
    let before = count();
    // off (the shipped default, no settings file): Node acts, the engine only forwards and logs nothing
    let mut c = Command::new(BIN);
    c.args(["mesh", "send", "--to", "child-1", "--message", "off mode"]).current_dir(&fx.main).env_clear().envs(base_env(&home, &state, &[]));
    let o = run(&mut c, None);
    assert_eq!(o.status.code(), Some(0), "{}", String::from_utf8_lossy(&o.stderr));
    assert!(String::from_utf8_lossy(&o.stdout).starts_with("{\"ok\":true,\"action\":\"send\""));
    assert_eq!(count(), before + 1);
    assert!(!state.join("mesh-shadow.jsonl").exists(), "off mode logs nothing");
    // shadow: Node acts (its stdout passes through), the engine replays on a copy and logs the comparison
    fs::write(home.join(".anti-hall").join("settings.json"), "{\"mesh\":{\"engine_writes\":\"shadow\"}}\n").unwrap();
    for (argv, effect) in [
        (vec!["send", "--to", "child-1", "--message", "shadowed"], "row"),
        (vec!["send", "--broadcast", "--message", "shadow bcast"], "row"),
        (vec!["mesh", "read"], "cursor"),
        (vec!["mesh", "read", "--peek"], "none"),
    ] {
        let mut c = Command::new(BIN);
        c.arg("mesh").args(&argv).current_dir(&fx.main).env_clear().envs(base_env(&home, &state, &[]));
        let o = run(&mut c, None);
        assert_eq!(o.status.code(), Some(0), "{argv:?}: {}", String::from_utf8_lossy(&o.stderr));
        let rec = last_log(&state);
        assert_eq!(rec["mode"], "shadow");
        assert_eq!(rec["result"], "match", "{argv:?} ({effect}): {rec}");
    }
    assert_eq!(count(), before + 3, "shadow wrote only Node's rows to the real store");
    assert!(!state.join("mesh-shadow").exists() || fs::read_dir(state.join("mesh-shadow")).unwrap().next().is_none(), "the scratch copies are removed");
    // an unported verb runs in Node whatever the mode
    let mut c = Command::new(BIN);
    c.args(["mesh", "roster", "--json"]).current_dir(&fx.main).env_clear().envs(base_env(&home, &state, &[]));
    let o = run(&mut c, None);
    assert_eq!(o.status.code(), Some(0));
    assert!(String::from_utf8_lossy(&o.stdout).contains("\"action\":\"roster\""));
}
