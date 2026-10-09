//! Plain `roster` parity: `ah-engine mesh roster ...` (mesh.engine_writes = on) against `node scripts/devswarm.js roster ...`.
//!
//! The engine answers a roster only when the project has no rows at all (see `src/meshw/roster.rs`); every other project
//! is Node's, decided before `hivecontrol` is started. The cases drive the real code on both sides against a stub
//! `hivecontrol` (an executable script first on PATH): empty answers, garbage, failures, a hang, a binary that ignores the
//! termination signal (only the engine runs that one: Node would wait for it for ever), a child it does report, and no
//! binary at all. A fixture app database and the split-brain fallback summary are in play where they could matter.
#![allow(clippy::unwrap_used, clippy::expect_used)] // a test crate: a panic is the failure report, and E2 exempts tests
use serde_json::{Value, json};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

#[path = "mesh_write_support/fx.rs"]
mod fx;
use fx::*;

const NOW: i64 = 1_795_000_000_000;

struct Case {
    name: &'static str,
    /// `empty` (a project with no registry row), `busy` (the seeded project), `none` (a git repo with no store),
    /// `nongit` (a directory outside any repository).
    project: &'static str,
    argv: Vec<&'static str>,
    /// The stub hivecontrol's answer to `workspace list children` (None: no hivecontrol on PATH).
    stub: Option<&'static str>,
    /// Whether the stub's `workspace --help` lists the `list` verb.
    help_lists: bool,
    /// What Node's capability probe has cached for the stub before the verb runs.
    prime: Prime,
    extra: Vec<(&'static str, String)>,
    /// Runs on the home after seeding.
    setup: fn(&Path, &Path),
    native: bool,
    /// The stub is edited after Node cached its probe (the cache no longer matches the file).
    stale: bool,
    /// The cached probe is overwritten with this text after priming (an injected fault).
    corrupt_cache: Option<&'static str>,
    /// The stub's permission bits after priming (an injected fault).
    stub_mode: Option<u32>,
    /// Never run in Node (it would wait for ever, or is not the point): only the engine's own answer is checked.
    engine_only: Option<&'static str>,
    expect: Vec<&'static str>,
}

#[derive(Clone, Copy, PartialEq)]
enum Prime {
    /// Nothing cached: Node would probe the binary and write the cache.
    No,
    /// The probe is cached.
    Probe,
    /// The probe is cached and Node has already recorded the dormant line (the stub's help lacks the verb).
    Dormant,
}

fn tools_path(root: &Path, with_node: bool) -> PathBuf {
    let bin = root.join(if with_node { "tools-bin" } else { "nonode-bin" });
    fs::create_dir_all(&bin).unwrap();
    let list: &[&str] = if with_node { &["node", "git", "ps"] } else { &["git", "ps"] };
    for t in list {
        let out = Command::new("sh").args(["-c", &format!("command -v {t}")]).output().unwrap();
        let src = String::from_utf8_lossy(&out.stdout).trim().to_string();
        std::os::unix::fs::symlink(&src, bin.join(t)).ok();
    }
    bin
}

fn stub_dir(root: &Path, name: &str, body: &str, lists: bool) -> PathBuf {
    let d = root.join(format!("stub-{name}"));
    fs::create_dir_all(&d).unwrap();
    let f = d.join("hivecontrol");
    let help = if lists { "Commands:\\n  list  List workspaces\\n  info  Info\\n" } else { "Commands:\\n  info  Info\\n" };
    fs::write(
        &f,
        format!(
            "#!/bin/sh\ncase \"$*\" in\n  \"--version\") echo \"hivecontrol 2.6.0\";;\n  \"workspace --help\") printf '{help}';;\n  \"workspace list children\") {body};;\n  *) exit 0;;\nesac\n"
        ),
    )
    .unwrap();
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(&f, fs::Permissions::from_mode(0o755)).unwrap();
    d
}

/// Node's own probe (and, for a stub without the verb, Node's recording of the dormant line), run once on a home.
fn prime_cache(home: &Path, path: &str, dormant: bool) {
    let caps = plugin_root().join("companion/lib/devswarm-capabilities.js");
    let dorm = if dormant { "c.can('workspace.list',{env:process.env,home:process.env.HOME});" } else { "" };
    let src = format!("const c=require({:?});c.probe({{env:process.env,home:process.env.HOME}});{dorm}", caps);
    let o = Command::new("node").args(["-e", &src]).env_clear().env("PATH", path).env("HOME", home).output().unwrap();
    assert!(o.status.success(), "{}", String::from_utf8_lossy(&o.stderr));
}

fn nothing(_: &Path, _: &Path) {}

fn app_db(h: &Path, _: &Path) {
    let p = h.join("app.db");
    let c = rusqlite::Connection::open(&p).unwrap();
    c.execute_batch(
        "CREATE TABLE builders (id TEXT, repositoryId TEXT, sourceBranch TEXT, branchName TEXT, worktreePath TEXT, terminalId TEXT, label TEXT, createdAt TEXT, lastAccessed TEXT, rank INTEGER, isHidden INTEGER, pullRequestId TEXT, builderType TEXT, isPinned INTEGER, isActive INTEGER, lastSelectedAt TEXT);
         INSERT INTO builders (id, branchName, worktreePath, label, rank, isHidden, builderType, isPinned, isActive) VALUES ('b-1', 'feat', '/nowhere/wt', 'Feature', 1, 0, 'standard', 0, 1), ('b-2', 'old', '/nowhere/old', 'Old', 2, 1, 'standard', 0, 0);
         CREATE TABLE builder_terminals (id TEXT, builderId TEXT, terminalId TEXT, terminalType TEXT, aiAgent TEXT, ai_session_config TEXT, isActive INTEGER, panelStatus TEXT, createdAt TEXT, lastViewedAt TEXT, initialPrompt TEXT, initialPromptDeliveredAt TEXT, initialPromptWithheldAt TEXT);
         CREATE TABLE pull_requests (id TEXT, repositoryId TEXT, branchName TEXT, number INTEGER, state TEXT, isDraft INTEGER, url TEXT, checkStatus TEXT, reviewStatus TEXT, lastSyncedAt TEXT);
         CREATE TABLE repositories (id TEXT, path TEXT, name TEXT, defaultBaseBranch TEXT);",
    )
    .unwrap();
}

/// Heartbeat broadcasts in the empty project's store, so `recent` is not empty.
fn heartbeats(h: &Path, key: &Path) {
    let db = h.join(".anti-hall/devswarm/store").join(key.file_name().unwrap()).join("devswarm.db");
    let c = rusqlite::Connection::open(db).unwrap();
    for (i, body) in ["working on the parser", "working on the parser", "now on tests"].iter().enumerate() {
        c.execute(
            "INSERT INTO messages (workspace_id, ts, hash, body, sender, recipient, mtype, urgency, is_heartbeat, needs_reply, orig_hash, instance_nonce, seq) VALUES ('*mesh-broadcast*', ?, ?, ?, 'someone', NULL, 'broadcast', 'low', 1, 0, NULL, NULL, (SELECT COALESCE(MAX(seq),0)+1 FROM messages))",
            rusqlite::params![1_790_000_000_000i64 + i as i64 * 1000, format!("mesh:hb{i}"), body],
        )
        .unwrap();
    }
}

/// An archived descriptor of this project (owned by its key) and some of other projects, unreadable ones and odd ones.
fn archived_descriptor(h: &Path, key: &Path) {
    let d = h.join(".anti-hall/devswarm/archived");
    fs::create_dir_all(&d).unwrap();
    fs::write(
        d.join("old-ws.json"),
        json!({"id": "old-ws", "worktreePath": "/nowhere/old", "ownerKey": key.file_name().unwrap().to_string_lossy()}).to_string(),
    )
    .unwrap();
}

fn archived_elsewhere(h: &Path, _: &Path) {
    let d = h.join(".anti-hall/devswarm/archived");
    fs::create_dir_all(&d).unwrap();
    fs::write(d.join("other-1.json"), json!({"id": "other-1", "worktreePath": "/nowhere/o", "ownerKey": "repo-someone-else"}).to_string()).unwrap();
    fs::write(d.join("other-2.json"), json!({"id": "other-2", "worktreePath": "/nowhere/o", "repoKey": "repo-another"}).to_string()).unwrap();
    fs::write(d.join("other-3.json"), json!({"id": "other-3", "worktreePath": "/nowhere/missing-repo"}).to_string()).unwrap();
    fs::write(d.join("no-wt.json"), json!({"id": "no-wt"}).to_string()).unwrap();
    fs::write(d.join("broken.json"), "{not json").unwrap();
    fs::write(d.join("array.json"), "[1,2]").unwrap();
    fs::write(d.join("note.txt"), "not a descriptor").unwrap();
    fs::create_dir_all(d.join("a-dir.json")).unwrap();
}

fn fallback_summary(h: &Path, key: &Path) {
    // the file named by the hash of the Primary's id (the test prepares it under every plausible spelling of the project)
    let d = h.join(".anti-hall/devswarm/summaries");
    fs::create_dir_all(&d).unwrap();
    let _ = key;
    for e in fs::read_dir(h.parent().unwrap().join("fallbacks")).unwrap().flatten() {
        fs::write(d.join(format!("{}.json", e.file_name().to_string_lossy())), json!({"workspaces": {}}).to_string()).unwrap();
    }
}

fn chmod(p: &Path, mode: u32) {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(p, fs::Permissions::from_mode(mode)).unwrap();
}

/// Undo every injected permission fault under `dir`, so the scratch tree can be removed.
fn reset_modes(dir: &Path) {
    use std::os::unix::fs::PermissionsExt;
    if let Ok(m) = fs::symlink_metadata(dir) {
        if m.file_type().is_symlink() {
            return;
        }
        fs::set_permissions(dir, fs::Permissions::from_mode(if m.is_dir() { 0o755 } else { 0o644 })).ok();
        if m.is_dir() {
            for e in fs::read_dir(dir).into_iter().flatten().flatten() {
                reset_modes(&e.path());
            }
        }
    }
}

fn unreadable_archived_dir(h: &Path, _: &Path) {
    let d = h.join(".anti-hall/devswarm/archived");
    fs::create_dir_all(&d).unwrap();
    chmod(&d, 0o000);
}

fn unreadable_store(h: &Path, key: &Path) {
    chmod(&h.join(".anti-hall/devswarm/store").join(key.file_name().unwrap()).join("devswarm.db"), 0o000);
}

fn store_not_a_database(h: &Path, key: &Path) {
    fs::write(h.join(".anti-hall/devswarm/store").join(key.file_name().unwrap()).join("devswarm.db"), b"this is not sqlite").unwrap();
}

fn cases(absent_native: bool) -> Vec<Case> {
    let base = |name: &'static str, project: &'static str, argv: Vec<&'static str>, stub: Option<&'static str>, native: bool, expect: Vec<&'static str>| Case {
        name,
        project,
        argv,
        stub,
        help_lists: true,
        prime: if stub.is_some() { Prime::Probe } else { Prime::No },
        extra: vec![],
        setup: nothing,
        native,
        stale: false,
        corrupt_cache: None,
        stub_mode: None,
        engine_only: None,
        expect,
    };
    let empty_json = "\"workspaces\":[]";
    vec![
        // ---- native: a project with no rows ----
        base("empty-no-hivecontrol-text", "empty", vec!["roster"], None, absent_native, vec!["no live workspaces"]),
        base("empty-no-hivecontrol-json", "empty", vec!["roster", "--json"], None, absent_native, vec![empty_json, "\"liveCount\":0"]),
        Case {
            setup: archived_elsewhere,
            ..base("empty-with-archived-descriptors-of-other-projects", "empty", vec!["roster", "--json"], None, absent_native, vec![empty_json])
        },
        base("empty-all-flag", "empty", vec!["roster", "--all"], None, absent_native, vec!["no live workspaces"]),
        base("stub-prints-an-empty-array", "empty", vec!["roster", "--json"], Some("echo '[]'"), true, vec![empty_json]),
        base("stub-prints-an-empty-wrapper", "empty", vec!["roster"], Some("echo '{\"children\":[]}'"), true, vec!["no live workspaces"]),
        base("stub-prints-garbage", "empty", vec!["roster"], Some("echo 'definitely not json'"), true, vec!["no live workspaces"]),
        base("stub-prints-nothing", "empty", vec!["roster"], Some("exit 0"), true, vec!["no live workspaces"]),
        base("stub-prints-scalars-only", "empty", vec!["roster", "--json"], Some("echo '[1,\"a\",null]'"), true, vec![empty_json]),
        base("stub-exits-1-after-printing-children", "empty", vec!["roster"], Some("echo '[{\"id\":\"x\"}]'; exit 1"), true, vec!["no live workspaces"]),
        base("stub-killed-by-a-signal", "empty", vec!["roster"], Some("echo '[{\"id\":\"x\"}]'; kill -9 $$"), true, vec!["no live workspaces"]),
        base("stub-hangs-until-it-is-stopped", "empty", vec!["roster"], Some("exec sleep 60"), true, vec!["no live workspaces"]),
        base("stub-prints-a-lot-then-succeeds", "empty", vec!["roster"], Some("yes '[]' | head -c 1100000"), true, vec!["no live workspaces"]),
        Case {
            setup: heartbeats,
            ..base("empty-with-heartbeat-broadcasts-in-recent", "empty", vec!["roster", "--json"], None, absent_native, vec!["\"recent\":[{"])
        },
        Case {
            setup: app_db,
            extra: vec![("ANTIHALL_DEVSWARM_APP_DB", "{HOME}/app.db".into())],
            ..base("empty-with-an-app-database", "empty", vec!["roster", "--json"], None, absent_native, vec![empty_json])
        },
        Case {
            help_lists: false,
            prime: Prime::Dormant,
            ..base(
                "the-build-lacks-the-verb-and-the-dormant-line-is-recorded",
                "empty",
                vec!["roster"],
                Some("echo started >> \"$0.ran\"; echo '[{\"id\":\"x\"}]'"),
                true,
                vec!["no live workspaces"],
            )
        },
        // ---- injected faults ----
        Case {
            stub_mode: Some(0o644),
            ..base(
                "fault-the-binary-is-not-executable-the-spawn-fails",
                "empty",
                vec!["roster"],
                Some("echo '[{\"id\":\"x\"}]'"),
                true,
                vec!["no live workspaces"],
            )
        },
        Case {
            setup: unreadable_archived_dir,
            ..base("fault-the-archived-directory-is-unreadable", "empty", vec!["roster", "--json"], Some("echo '[]'"), true, vec![empty_json])
        },
        Case {
            corrupt_cache: Some("{not json"),
            ..base("fault-the-cached-probe-is-garbage", "empty", vec!["roster"], Some("echo '[]'"), false, vec!["no live workspaces"])
        },
        Case {
            corrupt_cache: Some("[]"),
            ..base("fault-the-cached-probe-is-an-array", "empty", vec!["roster"], Some("echo '[]'"), false, vec!["no live workspaces"])
        },
        Case { setup: unreadable_store, ..base("fault-the-store-file-is-unreadable", "empty", vec!["roster"], Some("echo '[]'"), false, vec![]) },
        Case { setup: store_not_a_database, ..base("fault-the-store-is-not-a-database", "empty", vec!["roster"], Some("echo '[]'"), false, vec![]) },
        // ---- rows (lane l8f: tests/devswarm_l8f_parity.rs holds the full table) ----
        base("a-project-with-workspaces", "busy", vec!["roster"], Some("echo '[]'"), true, vec!["| workspace |"]),
        base("a-project-with-workspaces-json", "busy", vec!["roster", "--json"], Some("echo '[]'"), true, vec!["\"action\":\"roster\""]),
        Case { setup: archived_descriptor, ..base("an-archived-descriptor-of-this-project", "empty", vec!["roster", "--all"], None, absent_native, vec![]) },
        // ---- deferrals: nothing may be written ----
        Case { setup: fallback_summary, ..base("a-fallback-summary-of-the-primary", "empty", vec!["roster"], None, false, vec![]) },
        base(
            "a-native-child-is-reported",
            "empty",
            vec!["roster"],
            Some("echo '[{\"id\":\"c1\",\"branch\":\"feat-x\",\"path\":\"/nowhere/wt\",\"label\":\"Feat X\"}]'"),
            false,
            vec!["feat-x", "Feat X"],
        ),
        base(
            "a-native-child-in-a-wrapper",
            "empty",
            vec!["roster", "--json"],
            Some("echo '{\"children\":[{\"branch\":\"b\"}]}'"),
            false,
            vec!["\"source\":\"native\""],
        ),
        Case { prime: Prime::No, ..base("no-cached-probe-for-the-binary", "empty", vec!["roster"], Some("echo '[]'"), false, vec!["no live workspaces"]) },
        Case {
            stale: true,
            ..base("the-cached-probe-no-longer-matches-the-binary", "empty", vec!["roster"], Some("echo '[]'"), false, vec!["no live workspaces"])
        },
        Case {
            help_lists: false,
            ..base("the-build-lacks-the-verb-but-no-dormant-line-is-recorded", "empty", vec!["roster"], Some("echo '[]'"), false, vec!["no live workspaces"])
        },
        base("no-store-yet", "none", vec!["roster"], None, false, vec![]),
        base("outside-any-repository", "nongit", vec!["roster"], None, false, vec![]),
        base("an-unknown-flag", "empty", vec!["roster", "--bogus"], None, false, vec!["no live workspaces"]),
        base("a-valued-json-flag", "empty", vec!["roster", "--json", "x"], None, false, vec![empty_json]),
        base("an-extra-positional", "empty", vec!["roster", "extra"], None, false, vec!["no live workspaces"]),
        // Node would wait for this binary for ever: only the engine's own, bounded, answer is checked
        Case {
            engine_only: Some("no live workspaces"),
            ..base("stub-ignores-the-termination-signal", "empty", vec!["roster"], Some("trap '' TERM; while :; do sleep 1; done"), true, vec![])
        },
    ]
}

fn project_dirs(fx: &Fx) -> (PathBuf, PathBuf, PathBuf, PathBuf) {
    // a second repository with an EMPTY store, one with no store, and a directory outside any repository
    let mk = |name: &str| {
        let d = fx.root.join(name);
        fs::create_dir_all(&d).unwrap();
        git(&["init", "-q"], &d);
        git(&["commit", "-q", "--allow-empty", "-m", "init"], &d);
        real(&d)
    };
    let (empty, none) = (mk("repo-empty"), mk("repo-none"));
    let nongit = fx.root.join("not-a-repo");
    fs::create_dir_all(&nongit).unwrap();
    (empty, none, real(&nongit), fx.child.clone())
}

fn node_eval(src: &str) -> String {
    let o = Command::new("node").args(["-e", src]).env_clear().env("PATH", std::env::var("PATH").unwrap()).output().unwrap();
    assert!(o.status.success(), "{}", String::from_utf8_lossy(&o.stderr));
    String::from_utf8_lossy(&o.stdout).trim().to_string()
}

#[test]
fn roster_matches_node_for_a_project_with_no_rows_and_defers_every_other() {
    if !node_sqlite_available() {
        eprintln!("SKIPPED: Node with node:sqlite is not available, so there is no Node to compare with");
        return;
    }
    let fx = fixture("roster");
    let (empty, none, nongit, child) = project_dirs(&fx);
    let plugin = plugin_root();
    let ident = |p: &Path| {
        node_eval(&format!(
            "const i=require({:?});const c=i.resolveContext({:?},{{memo:false}});console.log(JSON.stringify({{k:c.repoKey,m:c.meshId}}))",
            plugin.join("companion/lib/identity.js"),
            p
        ))
    };
    let v: Value = serde_json::from_str(&ident(&empty)).unwrap();
    let (empty_key, empty_mesh) = (v["k"].as_str().unwrap().to_string(), v["m"].as_str().unwrap().to_string());
    // an empty store for the empty project, written by Node's own store code
    let home_template = fx.root.join("home-template");
    copy_tree(&fx.seed_home, &home_template);
    let o = Command::new("node")
        .arg(support("ack_seed.js"))
        .arg(&home_template)
        .arg(&empty_key)
        .arg("{}")
        .env_clear()
        .env("PATH", std::env::var("PATH").unwrap())
        .env("HOME", &home_template)
        .output()
        .unwrap();
    assert!(o.status.success(), "{}", String::from_utf8_lossy(&o.stderr));
    // the file names a split-brain fallback would use: the hash of the Primary's id
    let fallbacks = fx.root.join("fallbacks");
    fs::create_dir_all(&fallbacks).unwrap();
    let hex = empty_mesh.strip_prefix("primary-").unwrap_or(&empty_mesh).to_string();
    fs::write(fallbacks.join(&hex), "").unwrap();
    let tools = tools_path(&fx.root, true);
    let nonode = tools_path(&fx.root, false);
    let (mut native, mut deferred) = (0, 0);
    let installed = cfg!(target_os = "macos") && Path::new("/Applications/DevSwarm.app/Contents/Resources/cli/hivecontrol").is_file();
    for (i, c) in cases(!installed).iter().enumerate() {
        struct Undo(Vec<PathBuf>);
        impl Drop for Undo {
            fn drop(&mut self) {
                self.0.iter().for_each(|p| reset_modes(p));
            }
        }
        let _undo = Undo(["node", "engine", "defer"].iter().map(|k| fx.root.join(format!("{}-{k}", c.name))).collect());
        let now = NOW + i as i64 * 7_919;
        let cwd = match c.project {
            "empty" => empty.clone(),
            "none" => none.clone(),
            "nongit" => nongit.clone(),
            _ => child.clone(),
        };
        let (hn, he, hd) = (fx.root.join(format!("{}-node", c.name)), fx.root.join(format!("{}-engine", c.name)), fx.root.join(format!("{}-defer", c.name)));
        for h in [&hn, &he, &hd] {
            copy_tree(&home_template, h);
            fs::create_dir_all(h.join(".anti-hall")).unwrap();
            fs::write(h.join(".anti-hall").join("settings.json"), "{\"mesh\":{\"engine_writes\":\"on\"}}\n").unwrap();
            let key_dir = h.join(".anti-hall/devswarm/store").join(&empty_key);
            (c.setup)(h, &key_dir);
        }
        let stub = c.stub.map(|b| stub_dir(&fx.root, c.name, b, c.help_lists));
        let path_with = |base: &Path| match &stub {
            Some(s) => format!("{}:{}", s.display(), base.display()),
            None => base.display().to_string(),
        };
        // what Node's capability probe has cached for the stub, identically in all three homes
        if let Some(stub_dir) = stub.as_ref().filter(|_| c.prime != Prime::No) {
            prime_cache(&hn, &path_with(&tools), c.prime == Prime::Dormant);
            let cache = hn.join(".anti-hall/devswarm/capabilities.json");
            for h in [&he, &hd] {
                fs::copy(&cache, h.join(".anti-hall/devswarm/capabilities.json")).unwrap();
            }
            if let Some(text) = c.corrupt_cache {
                for h in [&hn, &he, &hd] {
                    fs::write(h.join(".anti-hall/devswarm/capabilities.json"), text).unwrap();
                }
            }
            if let Some(mode) = c.stub_mode {
                use std::os::unix::fs::PermissionsExt;
                fs::set_permissions(stub_dir.join("hivecontrol"), fs::Permissions::from_mode(mode)).unwrap();
            }
            if c.stale {
                let f = stub_dir.join("hivecontrol");
                let mut t = fs::read_to_string(&f).unwrap();
                t.push_str("# edited after the probe was cached\n");
                fs::write(&f, t).unwrap();
            }
        }
        let extra_for = |h: &Path, path: String| -> Vec<(String, String)> {
            let mut v: Vec<(String, String)> = c.extra.iter().map(|(k, x)| ((*k).to_string(), x.replace("{HOME}", &h.to_string_lossy()))).collect();
            v.push(("PATH".into(), path));
            v
        };
        let av: Vec<&str> = c.argv.clone();
        let run_node = |h: &Path| {
            let e = extra_for(h, path_with(&tools));
            let x: Vec<(&str, &str)> = e.iter().map(|(k, v)| (k.as_str(), v.as_str())).collect();
            node_verb(h, &h.join("state"), &cwd, &av, now, None, &x)
        };
        let run_engine = |h: &Path, base: &Path| {
            let e = extra_for(h, path_with(base));
            let x: Vec<(&str, &str)> = e.iter().map(|(k, v)| (k.as_str(), v.as_str())).collect();
            engine_verb(h, &h.join("state"), &cwd, &av, now, None, &x)
        };
        if let Some(want) = c.engine_only {
            native += 1;
            let t0 = std::time::Instant::now();
            let e = run_engine(&he, &tools);
            assert!(e.stdout.contains(want), "{}: {}", c.name, e.stdout);
            assert_eq!(last_log(&he.join("state"))["result"], "native", "{}", c.name);
            assert!(t0.elapsed() < std::time::Duration::from_secs(20), "{}: the hung binary must be stopped within the bound", c.name);
            continue;
        }
        let n = run_node(&hn);
        for want in &c.expect {
            assert!(n.stdout.contains(want), "{}: Node's output lacks {want:?}: {}", c.name, n.stdout);
        }
        let e = run_engine(&he, &tools);
        let log = last_log(&he.join("state"));
        assert_eq!(log["result"] == "native", c.native, "{}: expected native={} but the engine logged {log}", c.name, c.native);
        if c.native {
            native += 1;
            assert_eq!(log["verb"], "Roster", "{}: telemetry names the verb", c.name);
            assert_eq!((e.code, &e.stdout), (n.code, &n.stdout), "{}: stdout/exit differ", c.name);
            let dump = |h: &Path| (store_dump(h, &empty_key), home_files(h));
            let (de, dn) = (dump(&he), dump(&hn));
            assert!(de.0 == dn.0, "{}: store differs: {}", c.name, first_diff(&dn.0, &de.0));
            let norm = |h: &Path, m: &std::collections::BTreeMap<String, Vec<u8>>| -> std::collections::BTreeMap<String, String> {
                m.iter().map(|(k, v)| (k.clone(), String::from_utf8_lossy(v).replace(h.to_string_lossy().as_ref(), "<HOME>"))).collect()
            };
            let (te, tn) = (norm(&he, &de.1), norm(&hn, &dn.1));
            for k in te.keys().chain(tn.keys()) {
                assert!(te.get(k) == tn.get(k), "{}: the home tree differs at {k}:\n engine: {:?}\n node:   {:?}", c.name, te.get(k), tn.get(k));
            }
            if c.name.starts_with("the-build-lacks-the-verb-and") {
                assert!(!stub.as_ref().unwrap().join("hivecontrol.ran").exists(), "{}: a refused call must not start the binary", c.name);
            }
            let verify = verify_line(&he.join("state"));
            assert_eq!(verify["result"], "match", "{}: the background Node shadow disagrees: {verify}", c.name);
        } else {
            deferred += 1;
            assert_eq!(e.code, n.code, "{}: exit code of the fallback", c.name);
            let pre_tree = home_files(&hd);
            let pre_db = store_dump(&hd, &empty_key);
            let ran = stub.as_ref().map(|s| s.join("hivecontrol.ran"));
            if let Some(r) = &ran {
                fs::remove_file(r).ok(); // Node's own run above started the stub
            }
            let d = run_engine(&hd, &nonode);
            assert_eq!(d.code, 75, "{}: a deferral the engine cannot hand to Node exits 75, got {} / {}", c.name, d.code, d.stdout);
            assert!(d.stdout.is_empty(), "{}: nothing is printed on a deferral: {}", c.name, d.stdout);
            assert_eq!(last_log(&hd.join("state"))["result"], "defer", "{}", c.name);
            assert!(pre_tree == home_files(&hd) && pre_db == store_dump(&hd, &empty_key), "{}: deferral wrote", c.name);
        }
    }
    eprintln!("roster parity: {} cases, {native} answered by the engine and identical to Node, {deferred} deferred with nothing written", cases(true).len());
    assert!(native >= 15 && deferred >= 14, "{native} native, {deferred} deferred");
}

fn verify_line(state: &Path) -> Value {
    for _ in 0..300 {
        if let Ok(t) = fs::read_to_string(state.join("mesh-verify.jsonl"))
            && let Some(l) = t.lines().last()
        {
            return serde_json::from_str(l).unwrap();
        }
        std::thread::sleep(std::time::Duration::from_millis(100));
    }
    json!({"result": "none"})
}

fn store_dump(home: &Path, key: &str) -> String {
    let db = home.join(".anti-hall/devswarm/store").join(key).join("devswarm.db");
    if !db.is_file() {
        return String::new();
    }
    match fs::read(&db) {
        Err(_) => "<unreadable>".to_string(),
        Ok(b) if b.starts_with(b"SQLite format 3\0") => raw_dump(&db),
        Ok(b) => format!("not a database: {b:?}"),
    }
}
