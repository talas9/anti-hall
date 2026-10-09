//! Parity of plain `roster` WITH rows (lane l8f): `ah-engine mesh roster ...` (mesh.engine_writes = on) against the real
//! `node scripts/devswarm.js roster ...`.
//!
//! Every case runs Node and the engine on identical copies of one seeded home (the D45 fixture: a real git repo with a linked
//! child worktree and a store written by Node's own code, three registry rows and an archived marker) with the same pinned
//! clock, and compares the exact stdout (JSON or the text table), the exit code and the whole home tree (a roster writes
//! nothing). Every home carries a stub `hivecontrol` first on PATH with Node's capability probe already cached (this machine's
//! DevSwarm app would otherwise make Node probe and write the cache). A case the engine must hand to Node is run a third time
//! with no Node on the PATH: it must exit 75, print nothing and write nothing. The background Node witness of each answered
//! call must have logged a match.
#![allow(clippy::unwrap_used, clippy::expect_used)] // a test crate: a panic is the failure report, and E2 exempts tests
use serde_json::Value;
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

#[path = "mesh_write_support/fx.rs"]
mod fx;
use fx::*;

const NOW: i64 = 1_795_000_000_000;

/// The Node program the engine's witness uses (pins the clock, loads devswarm.js as the main module).
const SNIPPET: &str = "const c=process.argv[1],n=Number(process.argv[2]);Date.now=()=>n;process.argv=[process.argv[0],c].concat(process.argv.slice(3));require('module')._load(c,null,true);";

type Setup = Box<dyn Fn(&Path)>;

struct Lc {
    /// The stub hivecontrol's answer to `workspace list children` (a shell fragment), and to `workspace list all`.
    children: String,
    all: String,
    /// Stdout fragments the answer must contain (so a case cannot pass by printing nothing).
    expect: Vec<String>,
    name: String,
    argv: Vec<String>,
    /// `child` (the registered child worktree), `main` (the Primary checkout), `rc` (the ready-check repository), `other`, `nongit`.
    cwd: &'static str,
    setup: Setup,
    env: Vec<(String, String)>,
    native: bool,
    label: &'static str,
}

fn lc(name: &str, argv: &[&str], cwd: &'static str, native: bool, label: &'static str) -> Lc {
    Lc { children: "echo '[]'".into(), all: "echo '[]'".into(), expect: vec![], name: name.into(), argv: argv.iter().map(|s| (*s).into()).collect(), cwd, setup: Box::new(|_| {}), env: vec![], native, label }
}

impl Lc {
    fn children(mut self, body: &str) -> Lc {
        self.children = body.into();
        self
    }
    fn all(mut self, body: &str) -> Lc {
        self.all = body.into();
        self
    }
    fn expect(mut self, parts: &[&str]) -> Lc {
        self.expect = parts.iter().map(|p| (*p).into()).collect();
        self
    }
    fn env(mut self, k: &str, v: &str) -> Lc {
        self.env.push((k.into(), v.into()));
        self
    }
    fn setup(mut self, f: impl Fn(&Path) + 'static) -> Lc {
        self.setup = Box::new(f);
        self
    }
}

fn put(h: &Path, rel: &str, text: &str) {
    let p = h.join(rel);
    fs::create_dir_all(p.parent().unwrap()).unwrap();
    fs::write(p, text).unwrap();
}

fn tools_path(root: &Path, with_node: bool) -> String {
    let bin = root.join(if with_node { "tools-bin" } else { "nonode-bin" });
    fs::create_dir_all(&bin).unwrap();
    let list: &[&str] = if with_node { &["node", "git", "ps"] } else { &["git", "ps"] };
    for t in list {
        let out = Command::new("sh").args(["-c", &format!("command -v {t}")]).output().unwrap();
        let src = String::from_utf8_lossy(&out.stdout).trim().to_string();
        std::os::unix::fs::symlink(&src, bin.join(t)).ok();
    }
    bin.display().to_string()
}

fn node_cli(home: &Path, cwd: &Path, argv: &[String], now: i64, env: &[(&str, &str)]) -> Run {
    let cli = plugin_root().join("scripts").join("devswarm.js");
    let mut c = Command::new("node");
    c.arg("-e").arg(SNIPPET).arg(&cli).arg(now.to_string()).args(argv).current_dir(cwd).env_clear().envs(base_env(home, &home.join("state"), env));
    let o = run(&mut c, None);
    Run { code: o.status.code().unwrap_or(-1), stdout: String::from_utf8_lossy(&o.stdout).into_owned() }
}

fn engine_cli(home: &Path, cwd: &Path, argv: &[String], now: i64, env: &[(&str, &str)]) -> Run {
    let mut c = Command::new(BIN);
    c.arg("mesh").args(argv).current_dir(cwd).env_clear().envs(base_env(home, &home.join("state"), env)).env("AH_ENGINE_MESH_NOW_MS", now.to_string());
    let o = run(&mut c, None);
    if std::env::var("AH_L8F_DEBUG").is_ok() || o.status.code() == Some(70) {
        eprintln!("engine {argv:?} -> {:?} stderr: {}", o.status.code(), String::from_utf8_lossy(&o.stderr));
        eprintln!("log: {}", fs::read_to_string(home.join("state/mesh-shadow.jsonl")).unwrap_or_default());
    }
    Run { code: o.status.code().unwrap_or(-1), stdout: String::from_utf8_lossy(&o.stdout).into_owned() }
}

/// The central log's lines carry the wall-clock `ts` and the writer's `pid`, which differ between the engine and Node by design
/// (see tests/devswarm_l8d_parity.rs): both are blanked on both sides.
fn mask_log(text: &str) -> String {
    let ts = regex::Regex::new(r#"(?m)^\{"ts":"[^"]*""#).unwrap();
    let pid = regex::Regex::new(r#""pid":[0-9]+,"msg""#).unwrap();
    pid.replace_all(&ts.replace_all(text, r#"{"ts":"T""#), r#""pid":0,"msg""#).into_owned()
}

fn tree(home: &Path) -> BTreeMap<String, String> {
    home_files(home)
        .into_iter()
        .map(|(k, v)| {
            let text = String::from_utf8_lossy(&v).replace(home.to_string_lossy().as_ref(), "<HOME>");
            (k.clone(), if k.contains("devswarm.jsonl") && !k.ends_with(".lock") { mask_log(&text) } else { text })
        })
        .collect()
}

fn verify_lines(state: &Path) -> Vec<Value> {
    fs::read_to_string(state.join("mesh-verify.jsonl")).unwrap_or_default().lines().filter_map(|l| serde_json::from_str(l).ok()).collect()
}

fn to_ref(e: &[(String, String)]) -> Vec<(&str, &str)> {
    e.iter().map(|(k, v)| (k.as_str(), v.as_str())).collect()
}

fn stub_dir(root: &Path, name: &str, children: &str, all: &str) -> PathBuf {
    let d = root.join(format!("stub-{name}"));
    fs::create_dir_all(&d).unwrap();
    let f = d.join("hivecontrol");
    fs::write(
        &f,
        format!(
            "#!/bin/sh\ncase \"$*\" in\n  \"--version\") echo \"hivecontrol 2.6.0\";;\n  \"workspace --help\") printf 'Commands:\\n  list  List workspaces\\n  info  Info\\n';;\n  \"workspace list children\") {children};;\n  \"workspace list all\") {all};;\n  *) exit 0;;\nesac\n"
        ),
    )
    .unwrap();
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(&f, fs::Permissions::from_mode(0o755)).unwrap();
    d
}

/// Node's own capability probe of the stub, run once on a home.
fn prime_cache(home: &Path, path: &str) {
    let caps = plugin_root().join("companion/lib/devswarm-capabilities.js");
    let src = format!("const c=require({:?});c.probe({{env:process.env,home:process.env.HOME}});", caps);
    let o = Command::new("node").args(["-e", &src]).env_clear().env("PATH", path).env("HOME", home).output().unwrap();
    assert!(o.status.success(), "{}", String::from_utf8_lossy(&o.stderr));
}

/// The shared run: every case against Node, the engine, and the engine with no Node.
fn check(fx: &Fx, cases: &[Lc], extra_dirs: &[(&str, PathBuf)], min_native: usize, min_deferred: usize) {
    check_from(fx, cases, extra_dirs, &fx.seed_home, None, NOW, min_native, min_deferred);
}

/// [`check`] over another seed home (only `only_dirs` of it are copied) and clock base.
#[allow(clippy::too_many_arguments)]
fn check_from(
    fx: &Fx,
    cases: &[Lc],
    extra_dirs: &[(&str, PathBuf)],
    seed: &Path,
    only_dirs: Option<&[&str]>,
    now_base: i64,
    min_native: usize,
    min_deferred: usize,
) {
    let other = fx.root.join("repo-other");
    fs::create_dir_all(&other).unwrap();
    git(&["init", "-q"], &other);
    git(&["commit", "-q", "--allow-empty", "-m", "init"], &other);
    let other = real(&other);
    let nongit = fx.root.join("not-a-repo");
    fs::create_dir_all(&nongit).unwrap();
    let nongit = real(&nongit);
    let tools = tools_path(&fx.root, true);
    let nonode = tools_path(&fx.root, false);
    let key_db = |h: &Path| h.join(".anti-hall/devswarm/store").join(&fx.repo_key).join("devswarm.db");
    let (mut native, mut deferred) = (0, 0);
    let mut pending: Vec<(String, PathBuf)> = Vec::new();
    for (i, c) in cases.iter().enumerate() {
        if std::env::var("AH_L8F_FILTER").is_ok_and(|f| !c.name.contains(&f)) {
            continue;
        }
        let now = now_base + i as i64 % 50;
        let cwd = match c.cwd {
            "child" => fx.child.clone(),
            "main" => fx.main.clone(),
            "other" => other.clone(),
            "nongit" => nongit.clone(),
            k => extra_dirs.iter().find(|(n, _)| *n == k).unwrap().1.clone(),
        };
        let homes: Vec<PathBuf> = ["node", "engine", "defer"].iter().map(|k| fx.root.join(format!("c{i}-{k}"))).collect();
        let stub = stub_dir(&fx.root, &format!("c{i}"), &c.children, &c.all);
        let (p_tools, p_nonode) = (format!("{}:{tools}", stub.display()), format!("{}:{nonode}", stub.display()));
        for h in &homes {
            match only_dirs {
                None => copy_tree(seed, h),
                Some(ds) => {
                    for d in ds {
                        if seed.join(d).exists() {
                            copy_tree(&seed.join(d), &h.join(d));
                        }
                    }
                }
            }
            fs::create_dir_all(h.join(".anti-hall")).unwrap();
            fs::write(h.join(".anti-hall/settings.json"), "{\"mesh\":{\"engine_writes\":\"on\"}}\n").unwrap();
            // Node's capability probe of the stub, cached once and copied (the cache carries a clock)
            let cache = h.join(".anti-hall/devswarm/capabilities.json");
            if h == &homes[0] {
                prime_cache(h, &p_tools);
            } else {
                fs::create_dir_all(cache.parent().unwrap()).unwrap();
                fs::copy(homes[0].join(".anti-hall/devswarm/capabilities.json"), &cache).unwrap();
            }
            (c.setup)(h);
        }
        let env_of = |h: &Path| -> Vec<(String, String)> { c.env.iter().map(|(k, v)| (k.clone(), v.replace("{HOME}", &h.to_string_lossy()))).collect() };
        let run_env = |h: &Path, path: &str| -> Vec<(String, String)> {
            let mut e = env_of(h);
            e.push(("PATH".into(), path.into()));
            e
        };
        let refs = |e: &[(String, String)]| -> Vec<(String, String)> { e.to_vec() };
        let (en, ee, ed) = (refs(&run_env(&homes[0], &p_tools)), refs(&run_env(&homes[1], &p_tools)), refs(&run_env(&homes[2], &p_nonode)));
        let n = node_cli(&homes[0], &cwd, &c.argv, now, &to_ref(&en));
        let e = engine_cli(&homes[1], &cwd, &c.argv, now, &to_ref(&ee));
        let log = last_log(&homes[1].join("state"));
        assert_eq!(
            log["result"] == "native",
            c.native,
            "{}: expected native={} but the engine logged {log} (engine exit {} stdout {:?}; node exit {} stdout {:?})",
            c.name,
            c.native,
            e.code,
            e.stdout,
            n.code,
            n.stdout
        );
        for part in &c.expect {
            assert!(n.stdout.contains(part.as_str()), "{}: Node's answer lacks {part:?}: {}", c.name, n.stdout);
        }
        if c.native {
            native += 1;
            assert_eq!(log["verb"], c.label, "{}: telemetry names the verb", c.name);
            let (es, ns) = (e.stdout.replace(homes[1].to_string_lossy().as_ref(), "<HOME>"), n.stdout.replace(homes[0].to_string_lossy().as_ref(), "<HOME>"));
            assert_eq!((e.code, &es), (n.code, &ns), "{}: stdout/exit differ\n engine: {es:?}\n node:   {ns:?}", c.name);
            let (te, tn) = (tree(&homes[1]), tree(&homes[0]));
            for k in te.keys().chain(tn.keys()) {
                assert!(te.get(k) == tn.get(k), "{}: the home tree differs at {k}:\n engine: {:?}\n node:   {:?}", c.name, te.get(k), tn.get(k));
            }
            if key_db(&homes[0]).is_file() {
                let (de, dn) = (raw_dump(&key_db(&homes[1])), raw_dump(&key_db(&homes[0])));
                assert!(de == dn, "{}: the store differs: {}", c.name, first_diff(&dn, &de));
            }
            pending.push((c.name.clone(), homes[1].join("state")));
        } else {
            deferred += 1;
            assert_eq!(e.code, n.code, "{}: exit code of the fallback", c.name);
            let pre = (tree(&homes[2]), key_db(&homes[2]).is_file().then(|| raw_dump(&key_db(&homes[2]))));
            let d = engine_cli(&homes[2], &cwd, &c.argv, now, &to_ref(&ed));
            assert_eq!(d.code, 75, "{}: a deferral the engine cannot hand to Node exits 75, got {} / {}", c.name, d.code, d.stdout);
            assert!(d.stdout.is_empty(), "{}: nothing is printed on a deferral: {}", c.name, d.stdout);
            assert_eq!(last_log(&homes[2].join("state"))["result"], "defer", "{}", c.name);
            let post = (tree(&homes[2]), key_db(&homes[2]).is_file().then(|| raw_dump(&key_db(&homes[2]))));
            assert!(pre == post, "{}: a deferral wrote", c.name);
        }
    }
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(120);
    for (name, state) in &pending {
        let line = loop {
            if let Some(l) = verify_lines(state).into_iter().last() {
                break l;
            }
            assert!(std::time::Instant::now() < deadline, "{name}: the Node witness never logged");
            std::thread::sleep(std::time::Duration::from_millis(100));
        };
        assert_eq!(line["result"], "match", "{name}: the background Node witness disagrees: {line}");
    }
    eprintln!("l8f roster parity: {} cases, {native} answered by the engine and identical to Node, {deferred} deferred with nothing written", cases.len());
    if std::env::var("AH_L8F_FILTER").is_err() {
        assert!(native >= min_native && deferred >= min_deferred, "{native} native, {deferred} deferred");
    }
}

// ---- done ----------------------------------------------------------------------------------------------------------------


// ---- fixtures of the cases ----------------------------------------------------------------------------------------------

const MIN: i64 = 60_000;
const HOUR: i64 = 3_600_000;
const DAY: i64 = 86_400_000;

fn ds(h: &Path, rel: &str, text: &str) {
    put(h, &format!(".anti-hall/devswarm/{rel}"), text);
}

fn heartbeat(h: &Path, id: &str, ts: i64, session: Option<&str>) {
    let s = session.map(|s| format!(",\"sessionId\":\"{s}\"")).unwrap_or_default();
    ds(h, &format!("heartbeats/{id}.json"), &format!("{{\"id\":\"{id}\",\"ts\":{ts}{s}}}"));
}

/// The directory name Claude keeps a worktree's transcripts under.
fn encoded(wt: &Path) -> String {
    wt.to_string_lossy().chars().map(|c| if "/\\:.".contains(c) { '-' } else { c }).collect()
}

fn transcript(h: &Path, wt: &Path, session: &str, body: &str) {
    put(h, &format!(".claude/projects/{}/{session}.jsonl", encoded(wt)), body);
}

/// The DevSwarm app's database, as `app.db` in the home: (id, label, worktree, rank, isHidden, isActive, builderType, pinned).
type Builder<'a> = (&'a str, &'a str, &'a str, i64, i64, i64, &'a str, i64);

fn app_db(h: &Path, builders: &[Builder]) {
    let c = rusqlite::Connection::open(h.join("app.db")).unwrap();
    c.execute_batch(
        "CREATE TABLE builders (id TEXT, repositoryId TEXT, sourceBranch TEXT, branchName TEXT, worktreePath TEXT, terminalId TEXT, label TEXT, createdAt TEXT, lastAccessed TEXT, rank INTEGER, isHidden INTEGER, pullRequestId TEXT, builderType TEXT, isPinned INTEGER, isActive INTEGER, lastSelectedAt TEXT);
         CREATE TABLE builder_terminals (id TEXT, builderId TEXT, terminalId TEXT, terminalType TEXT, aiAgent TEXT, ai_session_config TEXT, isActive INTEGER, panelStatus TEXT, createdAt TEXT, lastViewedAt TEXT, initialPrompt TEXT, initialPromptDeliveredAt TEXT, initialPromptWithheldAt TEXT);
         CREATE TABLE pull_requests (id TEXT, repositoryId TEXT, branchName TEXT, number INTEGER, state TEXT, isDraft INTEGER, url TEXT, checkStatus TEXT, reviewStatus TEXT, lastSyncedAt TEXT);
         CREATE TABLE repositories (id TEXT, path TEXT, name TEXT, defaultBaseBranch TEXT);",
    )
    .unwrap();
    for (id, label, wt, rank, hidden, active, kind, pinned) in builders {
        c.execute(
            "INSERT INTO builders (id, branchName, worktreePath, label, rank, isHidden, builderType, isPinned, isActive) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
            rusqlite::params![id, format!("br-{id}"), wt, label, rank, hidden, kind, pinned, active],
        )
        .unwrap();
    }
}

/// Broadcast rows of the project's store carrying an instance nonce: (sender, nonce, ts).
fn nonces(h: &Path, key: &str, rows: &[(&str, &str, i64)]) {
    let db = h.join(".anti-hall/devswarm/store").join(key).join("devswarm.db");
    let c = rusqlite::Connection::open(db).unwrap();
    for (i, (sender, nonce, ts)) in rows.iter().enumerate() {
        c.execute(
            "INSERT INTO messages (workspace_id, ts, hash, body, sender, recipient, mtype, urgency, is_heartbeat, needs_reply, orig_hash, instance_nonce, seq) VALUES ('*mesh-broadcast*', ?, ?, 'beat', ?, NULL, 'broadcast', 'low', 0, 0, NULL, ?, (SELECT COALESCE(MAX(seq),0)+1 FROM messages))",
            rusqlite::params![ts, format!("mesh:nonce{i}"), sender, nonce],
        )
        .unwrap();
    }
}

fn settings(h: &Path, extra: &str) {
    fs::write(h.join(".anti-hall/settings.json"), format!("{{\"mesh\":{{\"engine_writes\":\"on\"}},{extra}}}\n")).unwrap();
}

fn roster_cases(fx: &Fx) -> Vec<Lc> {
    let (child, main, key) = (fx.child.clone(), fx.main.clone(), fx.repo_key.clone());
    let (cw, mw) = (child.to_string_lossy().to_string(), main.to_string_lossy().to_string());
    let (pid, cmesh) = (fx.primary_id.clone(), fx.child_mesh.clone());
    let r = |name: &str, argv: &[&str], native: bool| lc(name, argv, "child", native, "Roster");
    let home_db = "{HOME}/app.db";
    let app = ("ANTIHALL_DEVSWARM_APP_DB", home_db);
    let nonexistent = "/nowhere/wt9";
    let c1 = child.clone();
    let c2 = child.clone();
    let c3 = child.clone();
    let c4 = child.clone();
    let c5 = child.clone();
    let c6 = child.clone();
    let c7 = child.clone();
    let (k1, k2, k3) = (key.clone(), key.clone(), key.clone());
    let (cw1, cw2, cw3, cw4) = (cw.clone(), cw.clone(), cw.clone(), cw.clone());
    let (mw1, mw2) = (mw.clone(), mw.clone());
    let (p1, p2, p3, p4) = (pid.clone(), pid.clone(), pid.clone(), pid.clone());
    let marker = move |wt: &str| format!("{{\"id\":\"child-1\",\"worktreePath\":\"{wt}\"}}");
    vec![
        // ---- the shapes and the flags ----
        r("json", &["roster", "--json"], true).expect(&["\"action\":\"roster\"", "\"hints\":["]),
        r("text", &["roster"], true).expect(&["| workspace | status | finish | unread | last |"]),
        r("text-all", &["roster", "--all"], true),
        r("json-all-is-ignored", &["roster", "--json", "--all"], true),
        lc("json-from-the-primary-checkout", &["roster", "--json"], "main", true, "Roster"),
        lc("text-from-the-primary-checkout", &["roster"], "main", true, "Roster"),
        r("text-archived-shown-by-env", &["roster"], true).env("ANTIHALL_ROSTER_HIDE_ARCHIVED", "0"),
        r("an-unknown-flag-is-nodes", &["roster", "--bogus"], false),
        lc("outside-a-project", &["roster", "--json"], "nongit", false, "Roster"),
        lc("a-project-without-a-store", &["roster", "--json"], "other", false, "Roster"),
        // ---- hints from the files ----
        r("a-fresh-heartbeat-is-alive", &["roster", "--json"], true).setup(move |h| heartbeat(h, "child-1", NOW - 1000, None)),
        r("idle-days-from-the-verdict", &["roster", "--json"], true)
            .setup(move |h| ds(h, "liveness/child-1.json", &format!("{{\"lastOutboundTs\":{}}}", NOW - 3 * DAY - 5000)))
            .expect(&["idle 3d"]),
        r("idle-days-in-the-text", &["roster"], true).setup(move |h| ds(h, "liveness/child-1.json", &format!("{{\"lastOutboundTs\":{}}}", NOW - 3 * DAY - 5000))),
        r("a-silent-session-is-dormant", &["roster", "--json"], true).setup(move |h| heartbeat(h, "child-1", NOW - 10 * HOUR, None)).expect(&["dormant"]),
        r("an-empty-transcript-uses-the-tight-window", &["roster", "--json"], true)
            .setup(move |h| {
                heartbeat(h, "child-1", NOW - 2 * HOUR, None);
                transcript(h, &c1, "child-1", "");
            })
            .expect(&["dormant"]),
        r("the-dormant-setting-moves-the-window", &["roster", "--json"], true)
            .setup(move |h| {
                settings(h, "\"devswarm\":{\"dormantMs\":60000}");
                heartbeat(h, "child-1", NOW - 5 * MIN, None);
                transcript(h, &c2, "child-1", "");
            })
            .expect(&["dormant"]),
        r("a-zero-dormant-variable-with-a-transcript-is-nodes", &["roster", "--json"], false)
            .env("ANTIHALL_DEVSWARM_DORMANT_MS", "0")
            .setup(move |h| transcript(h, &c3, "child-1", "")),
        r("a-zero-dormant-variable-nobody-needs", &["roster", "--json"], true).env("ANTIHALL_DEVSWARM_DORMANT_MS", "0"),
        r("the-idle-variable-moves-the-wide-window", &["roster", "--json"], true)
            .env("ANTIHALL_DEVSWARM_IDLE_MS", "1000")
            .setup(move |h| heartbeat(h, "child-1", NOW - 5 * MIN, None))
            .expect(&["dormant"]),
        r("a-running-session-is-idle-alive", &["roster", "--json"], true)
            .setup(move |h| {
                heartbeat(h, "child-1", NOW - 10 * HOUR, None);
                put(h, &format!(".claude/sessions/{}.json", std::process::id()), &format!("{{\"pid\":{},\"sessionId\":\"child-1\"}}", std::process::id()));
            })
            .expect(&["idle (alive)"]),
        // a transcript with content is read natively (is the child waiting on a human?): see roster_transcript_tail_matches_node
        r("a-transcript-without-times-says-nothing", &["roster", "--json"], true)
            .setup(move |h| transcript(h, &c4, "child-1", "{\"type\":\"user\"}\n")),
        r("a-heartbeat-of-another-session-settles-the-wait", &["roster", "--json"], true).setup(move |h| {
            heartbeat(h, "child-1", NOW - 1000, Some("someone-else"));
            transcript(h, &c5, "child-1", "{\"type\":\"user\"}\n");
        }),
        // ---- archived rows and markers ----
        r("a-marker-with-a-live-descriptor-archives-the-row", &["roster", "--json"], true)
            .setup(move |h| {
                ds(h, "workspaces/child-1.json", &format!("{{\"id\":\"child-1\",\"worktreePath\":\"{cw1}\",\"sessionId\":\"child-1\"}}"));
                ds(h, "archived/child-1.json", &marker(&cw2));
            })
            .expect(&["archived"]),
        r("a-marker-of-an-older-occupant-is-nodes", &["roster", "--json"], false).setup(move |h| {
            ds(h, "workspaces/child-1.json", &format!("{{\"id\":\"child-1\",\"worktreePath\":\"{cw3}\",\"sessionId\":\"new\"}}"));
            ds(h, "archived/child-1.json", &format!("{{\"id\":\"child-1\",\"worktreePath\":\"{cw4}\",\"sessionId\":\"old\"}}"));
        }),
        r("an-archived-descriptor-of-this-project-is-a-row", &["roster", "--json"], true)
            .setup(move |h| ds(h, "archived/child-5.json", &format!("{{\"id\":\"child-5\",\"worktreePath\":\"/nowhere/wt5\",\"ownerKey\":\"{k1}\"}}")))
            .expect(&["child-5"]),
        r("an-archived-descriptor-of-this-project-in-the-text", &["roster", "--all"], true)
            .setup(move |h| ds(h, "archived/child-5.json", &format!("{{\"id\":\"child-5\",\"worktreePath\":\"/nowhere/wt5\",\"ownerKey\":\"{k2}\"}}"))),
        r("archived-descriptors-that-are-not-rows", &["roster", "--json"], true).setup(move |h| {
            ds(h, "archived/other.json", "{\"id\":\"other\",\"worktreePath\":\"/nowhere/o\",\"ownerKey\":\"somebody-else\"}");
            ds(h, "archived/array.json", "[1,2]");
            ds(h, "archived/torn.json", "{not json");
            ds(h, "archived/mismatch.json", &format!("{{\"id\":\"another\",\"worktreePath\":\"/nowhere/m\",\"ownerKey\":\"{k3}\"}}"));
            ds(h, "archived/no-wt.json", "{\"id\":\"no-wt\"}");
            ds(h, "archived/note.txt", "not a descriptor");
        }),
        // ---- the app database ----
        r("the-app-orders-and-titles-the-rows", &["roster", "--json"], true)
            .env(app.0, app.1)
            .setup(move |h| {
                app_db(h, &[("child-2", "Second", "/nowhere/s", 1, 0, 1, "standard", 0), ("child-1", "First", c6.to_str().unwrap(), 2, 0, 1, "standard", 1)])
            })
            .expect(&["\"app\":{\"rank\":1", "\"wsName\":\"First\""]),
        r("the-app-orders-and-titles-the-rows-in-the-text", &["roster"], true)
            .env(app.0, app.1)
            .setup(move |h| app_db(h, &[("child-2", "Second", "/nowhere/s", 1, 0, 1, "standard", 0), ("child-1", "First", c7.to_str().unwrap(), 2, 0, 1, "standard", 1)])),
        r("the-app-archived-a-row", &["roster", "--json"], true)
            .env(app.0, app.1)
            .setup(|h| app_db(h, &[("child-2", "Second", "/nowhere/s", 1, 1, 0, "standard", 0)]))
            .expect(&["\"appArchived\":true"]),
        r("the-app-archived-a-row-in-the-text", &["roster"], true).env(app.0, app.1).setup(|h| app_db(h, &[("child-2", "Second", "/nowhere/s", 1, 1, 0, "standard", 0)])),
        r("the-app-knows-nobody-here", &["roster", "--json"], true).env(app.0, app.1).setup(|h| app_db(h, &[("someone", "Else", "/nowhere/e", 1, 0, 1, "standard", 0)])),
        r("the-app-database-is-missing", &["roster", "--json"], true).env(app.0, "{HOME}/no-such.db"),
        r("a-ghost-label-folds-by-alias", &["roster", "--json"], true)
            .setup(move |h| {
                ds(h, "sender-aliases.json", &format!("{{\"version\":1,\"aliases\":{{\"{p1}\":{{\"to\":\"child-1\"}}}}}}"));
            })
            .expect(&["foldedAliases"]),
        r("a-ghost-label-folds-by-tombstone", &["roster", "--json"], true)
            .setup(move |h| ds(h, &format!("retired/{p2}.json"), "{\"retiredTo\":\"child-2\"}"))
            .expect(&["foldedAliases"]),
        r("a-ghost-label-folds-into-the-builder-on-its-worktree", &["roster", "--json"], true)
            .env(app.0, app.1)
            .setup(move |h| app_db(h, &[("child-1", "Builder", &mw1, 1, 0, 1, "standard", 0)]))
            .expect(&["foldedAliases"]),
        r("a-primary-builder-on-the-worktree-folds-nothing", &["roster", "--json"], true)
            .env(app.0, app.1)
            .setup(move |h| app_db(h, &[("child-1", "Builder", &mw2, 1, 0, 1, "primary", 0)])),
        r("a-fold-target-that-is-not-shown-folds-nothing", &["roster", "--json"], true)
            .setup(move |h| ds(h, "sender-aliases.json", &format!("{{\"version\":1,\"aliases\":{{\"{p3}\":{{\"to\":\"nobody\"}}}}}}"))),
        r("the-app-still-shows-an-archived-workspace", &["roster", "--json"], true)
            .env(app.0, app.1)
            .setup({
                let k = key.clone();
                move |h| {
                    ds(h, "archived/child-9.json", &format!("{{\"id\":\"child-9\",\"worktreePath\":\"{nonexistent}\",\"ownerKey\":\"{k}\",\"branch\":\"feat-9\"}}"));
                    app_db(h, &[("child-9", "Nine", "/nowhere/n", 3, 0, 1, "standard", 0)]);
                }
            })
            .expect(&["appStillLive", "app-live"]),
        r("an-app-sourced-marker-is-not-still-live", &["roster", "--json"], true).env(app.0, app.1).setup({
            let k = key.clone();
            move |h| {
                ds(h, "archived/child-9.json", &format!("{{\"id\":\"child-9\",\"worktreePath\":\"/nowhere/wt9\",\"ownerKey\":\"{k}\",\"archivedBy\":\"devswarm-app\"}}"));
                app_db(h, &[("child-9", "Nine", "/nowhere/n", 3, 0, 1, "standard", 0)]);
            }
        }),
        // ---- the mesh facts ----
        r("two-live-instances-are-a-split", &["roster", "--json"], true)
            .setup({
                let k = key.clone();
                move |h| nonces(h, &k, &[("child-1", "n-a", NOW - 5000), ("child-1", "n-b", NOW - 4000), ("child-1", "n-a", NOW - 3000)])
            })
            .expect(&["instance-split", "\"instances\":2"]),
        r("a-restart-is-not-a-split", &["roster", "--json"], true)
            .setup({
                let k = key.clone();
                move |h| nonces(h, &k, &[("child-1", "n-a", NOW - 14 * MIN), ("child-1", "n-b", NOW - 1000)])
            })
            .expect(&["\"instances\":1"]),
        r("an-old-nonce-is-out-of-the-window", &["roster", "--json"], true).setup({
            let k = key.clone();
            move |h| nonces(h, &k, &[("child-1", "n-a", NOW - 3 * DAY)])
        }),
        r("a-name-with-a-pipe-and-unread-broadcasts", &["roster"], true).setup(move |h| ds(h, "names/child-1.json", "{\"name\":\"fix|the parser\"}")),
        r("a-step-plan-is-nodes", &["roster", "--json"], false)
            .setup(move |h| ds(h, &format!("plans/{cmesh}.json"), "{\"steps\":[{\"n\":1,\"text\":\"first\",\"status\":\"pending\"}]}")),
        r("a-plan-of-nobody-here", &["roster", "--json"], true).setup(|h| ds(h, "plans/unrelated.json", "{\"steps\":[{\"n\":1,\"text\":\"first\",\"status\":\"pending\"}]}")),
        r("the-active-list-cache-nobody-needs", &["roster", "--json"], true).setup(|h| ds(h, "hivecontrol-active.json", &format!("{{\"fetchedAt\":{NOW},\"byRepoKey\":{{}}}}"))),
        r("a-fallback-summary-of-a-known-primary", &["roster", "--json"], true).setup(move |h| {
            let hash = p4.strip_prefix("primary-").unwrap_or(&p4).to_string();
            ds(h, &format!("summaries/{hash}.json"), "{\"workspaces\":{}}");
        }),
        // ---- native children ----
        r("a-listed-child-that-is-a-row", &["roster", "--json"], true).children(&format!("echo '[{{\"id\":\"child\",\"path\":\"{cw}\"}}]'")),
        r("a-listed-child-with-the-trusted-repository", &["roster", "--json"], true)
            .children(&format!("echo '[{{\"id\":\"child\",\"path\":\"{cw}\",\"repositoryId\":\"R1\"}}]'"))
            .all("echo '[{\"id\":\"x\",\"repositoryId\":\"R1\"}]'"),
        r("a-listed-child-of-another-repository-is-nodes", &["roster", "--json"], false)
            .children(&format!("echo '[{{\"id\":\"child\",\"path\":\"{cw}\",\"repositoryId\":\"R2\"}}]'"))
            .all("echo '[{\"id\":\"x\",\"repositoryId\":\"R1\"}]'"),
        r("a-listed-child-in-a-wrapper", &["roster", "--json"], true).children(&format!("echo '{{\"children\":[{{\"path\":\"{cw}\"}}]}}'")),
        r("a-listed-child-that-is-new-is-nodes", &["roster", "--json"], false).children("echo '[{\"id\":\"fresh\",\"path\":\"/nowhere/fresh\"}]'"),
        r("a-listed-child-without-a-path-is-nodes", &["roster", "--json"], false).children("echo '[{\"id\":\"fresh\"}]'"),
        r("a-list-that-is-garbage", &["roster", "--json"], true).children("echo 'not json'"),
        r("a-list-that-fails", &["roster", "--json"], true).children("exit 3"),
        r("a-list-of-nulls", &["roster", "--json"], true).children("echo '[null,1,\"x\"]'"),
    ]
}

#[test]
fn roster_with_rows_matches_node() {
    if !node_sqlite_available() {
        eprintln!("SKIPPED: Node with node:sqlite is not available, so there is no Node to compare with");
        return;
    }
    let fx = fixture("l8frows");
    let cases = roster_cases(&fx);
    check(&fx, &cases, &[], 40, 8);
}

// ---- the transcript tail (lane l8g) ---------------------------------------------------------------------------------------

const TS: &str = "2026-11-18T00:00:00.000Z";

fn ln(v: Value) -> String {
    format!("{v}\n")
}

fn t_user(text: &str) -> String {
    ln(serde_json::json!({"type":"user","timestamp":TS,"message":{"role":"user","content":text}}))
}

fn t_meta(text: &str) -> String {
    ln(serde_json::json!({"type":"user","isMeta":true,"timestamp":TS,"message":{"role":"user","content":text}}))
}

/// An assistant entry calling tools: (id, name, input).
fn t_call(calls: &[(&str, &str, Value)]) -> String {
    let blocks: Vec<Value> = calls.iter().map(|(id, name, input)| serde_json::json!({"type":"tool_use","id":id,"name":name,"input":input})).collect();
    ln(serde_json::json!({"type":"assistant","timestamp":TS,"message":{"role":"assistant","content":blocks}}))
}

fn t_result(id: Value) -> String {
    ln(serde_json::json!({"type":"user","timestamp":TS,"message":{"role":"user","content":[{"type":"tool_result","tool_use_id":id,"content":"ok"}]}}))
}

fn t_sys(subtype: &str) -> String {
    ln(serde_json::json!({"type":"system","subtype":subtype,"timestamp":TS}))
}

fn ask(q: &str) -> Value {
    serde_json::json!({"questions":[{"question":q,"options":[]}]})
}

/// A roster case over a transcript written with its mtime `age_ms` before the pinned clock.
fn tcase(name: &str, body: String, age_ms: i64, native: bool, expect: &[&str], wt: &Path) -> Lc {
    let wt = wt.to_path_buf();
    lc(name, &["roster", "--json"], "child", native, "Roster").expect(expect).setup(move |h| {
        transcript(h, &wt, "child-1", &body);
        let f = fs::OpenOptions::new().write(true).open(h.join(format!(".claude/projects/{}/child-1.jsonl", encoded(&wt)))).unwrap();
        f.set_modified(std::time::UNIX_EPOCH + std::time::Duration::from_millis((NOW - age_ms) as u64)).unwrap();
    })
}

fn tail_cases(fx: &Fx) -> Vec<Lc> {
    let w = &fx.child;
    let long = format!("{} {}", "word\n\t   spaced".repeat(20), "\u{1F600}".repeat(60));
    let big_input = serde_json::json!({"content": "x".repeat(300_000)});
    let mut huge = String::new();
    for i in 0..400 {
        huge += &t_call(&[(&format!("h{i}"), "Write", big_input.clone())]);
        huge += &t_result(serde_json::json!(format!("h{i}")));
    }
    let head_open = t_call(&[("early", "AskUserQuestion", ask("asked before the window"))]);
    let cases = vec![
        tcase("tail-active-tool-is-running", t_user("go") + &t_call(&[("a", "Bash", serde_json::json!({"command":"ls"}))]), 10_000, true, &[], w),
        tcase("tail-resolved-call-is-quiet", t_user("go") + &t_call(&[("a", "Bash", serde_json::json!({}))]) + &t_result("a".into()), 10_000, true, &[], w),
        tcase("tail-open-question-waits", t_user("go") + &t_call(&[("q", "AskUserQuestion", ask("Which   branch\nshould I use?"))]), 10_000, true, &["waiting-on-human: Which branch should I use?"], w),
        tcase("tail-open-question-in-text-table", t_user("go") + &t_call(&[("q", "AskUserQuestion", ask("Pick one"))]), 10_000, true, &[], w),
        tcase("tail-plan-approval-long-plan-is-cut", t_user("go") + &t_call(&[("p", "ExitPlanMode", serde_json::json!({"plan": long}))]), 10_000, true, &["waiting-on-human: "], w),
        tcase("tail-question-as-lone-string", t_user("go") + &t_call(&[("q", "AskUserQuestion", serde_json::json!({"question":"Plain?"}))]), 10_000, true, &["waiting-on-human: Plain?"], w),
        tcase("tail-question-without-text", t_user("go") + &t_call(&[("q", "AskUserQuestion", serde_json::json!({"questions":[]}))]), 10_000, true, &["\"waiting-on-human\""], w),
        tcase("tail-idle-turn-is-closed", t_user("go") + &t_call(&[("q", "AskUserQuestion", ask("x"))]) + &t_sys("turn_duration"), 10_000, true, &[], w),
        tcase("tail-closed-then-reopened-by-a-result", t_user("go") + &t_call(&[("q", "Bash", serde_json::json!({}))]) + &t_sys("stop_hook_summary") + &t_result("zz".into()), 10_000, true, &[], w),
        tcase("tail-dormant-quiet-transcript-with-open-tool", t_user("go") + &t_call(&[("a", "Bash", serde_json::json!({}))]), 30 * 3_600_000, true, &["waiting-on-human", "dormant"], w),
        tcase("tail-skewed-future-mtime-is-fresh", t_user("go") + &t_call(&[("a", "Bash", serde_json::json!({}))]), -30_000, true, &[], w),
        tcase("tail-far-future-mtime-is-not-fresh", t_user("go") + &t_call(&[("a", "Bash", serde_json::json!({}))]), -120_000, true, &["waiting-on-human"], w),
        tcase("tail-stale-by-one-minute-over-the-window", t_user("go") + &t_call(&[("a", "Bash", serde_json::json!({}))]), 6 * 60_000, true, &["waiting-on-human"], w),
        tcase(
            "tail-compacted-transcript",
            ln(serde_json::json!({"type":"summary","summary":"earlier work","leafUuid":"u"}))
                + &ln(serde_json::json!({"type":"system","subtype":"compact_boundary","timestamp":TS}))
                + &t_user("This session is being continued from a previous conversation")
                + &t_call(&[("q", "AskUserQuestion", ask("after compaction"))]),
            10_000,
            true,
            &["waiting-on-human: after compaction"],
            w,
        ),
        tcase(
            "tail-sidechain-entries-are-ignored",
            t_user("go") + &t_call(&[("q", "AskUserQuestion", ask("main"))]) + &ln(serde_json::json!({"type":"user","isSidechain":true,"timestamp":TS,"message":{"content":"agent prompt"}})),
            10_000,
            true,
            &["waiting-on-human: main"],
            w,
        ),
        tcase("tail-huge-transcript-open-question-at-the-end", huge.clone() + &t_user("now") + &t_call(&[("q", "AskUserQuestion", ask("at the end of a huge file"))]), 10_000, true, &["waiting-on-human: at the end of a huge file"], w),
        tcase("tail-huge-transcript-question-before-the-window", head_open + &huge, 10_000, true, &[], w),
        tcase("tail-malformed-last-line", t_user("go") + &t_call(&[("q", "AskUserQuestion", ask("before the torn line"))]) + "{\"type\":\"assist", 10_000, true, &["waiting-on-human: before the torn line"], w),
        tcase("tail-blank-and-garbage-lines", t_user("go") + "\n   \nnot json\n[1,2]\n\"s\"\nnull\n" + &t_call(&[("q", "AskUserQuestion", ask("between garbage"))]), 10_000, true, &["waiting-on-human: between garbage"], w),
        tcase("tail-human-prompt-opens-a-new-turn", t_user("go") + &t_call(&[("q", "AskUserQuestion", ask("old"))]) + &t_user("never mind"), 10_000, true, &[], w),
        tcase("tail-meta-prompt-stays-in-the-turn", t_user("go") + &t_call(&[("q", "AskUserQuestion", ask("still open"))]) + &t_meta("a skill body"), 10_000, true, &["waiting-on-human: still open"], w),
        tcase("tail-stop-hook-feedback-opens-a-turn", t_user("go") + &t_call(&[("q", "AskUserQuestion", ask("old"))]) + &t_meta("Stop hook feedback: do it"), 10_000, true, &[], w),
        tcase("tail-cron-fire-then-meta-prompt-opens-a-turn", t_user("go") + &t_call(&[("q", "AskUserQuestion", ask("old"))]) + &t_sys("scheduled_task_fire") + &t_meta("wake up"), 10_000, true, &[], w),
        tcase("tail-notification-wake-opens-a-turn", t_user("go") + &t_call(&[("q", "AskUserQuestion", ask("old"))]) + &t_meta("  <task-notification>Mailbox WAKE</task-notification>"), 10_000, true, &[], w),
        tcase("tail-other-notification-stays-in-the-turn", t_user("go") + &t_call(&[("q", "AskUserQuestion", ask("kept"))]) + &t_meta("<task-notification>done</task-notification>"), 10_000, true, &["waiting-on-human: kept"], w),
        tcase("tail-last-of-several-open-calls-wins", t_user("go") + &t_call(&[("a", "Bash", serde_json::json!({})), ("q", "AskUserQuestion", ask("last open"))]) + &t_result("q".into()), 10_000, true, &[], w),
        tcase("tail-numeric-ids-match-by-text", t_user("go") + &t_call(&[("5", "AskUserQuestion", ask("n"))]) + &t_result(serde_json::json!(5)), 10_000, true, &[], w),
        tcase("tail-array-tool-use-id-is-nodes", t_user("go") + &t_call(&[("q", "AskUserQuestion", ask("n"))]) + &t_result(serde_json::json!(["q"])), 10_000, false, &[], w),
        tcase("tail-odd-timestamp-alone-is-nodes", ln(serde_json::json!({"type":"assistant","timestamp":1700000000000i64,"message":{"content":[]}})), 10_000, false, &[], w),
        tcase("tail-no-timestamps-says-nothing", ln(serde_json::json!({"type":"assistant","message":{"content":[{"type":"tool_use","id":"q","name":"AskUserQuestion","input":{}}]}})), 10_000, true, &[], w),
        tcase("tail-lone-surrogate-in-a-skipped-field", t_user("go") + "{\"type\":\"user\",\"x\":\"\\ud800\"}\n", 10_000, true, &[], w),
        tcase("tail-lone-surrogate-in-a-read-field-is-nodes", t_user("go") + "{\"type\":\"user\",\"message\":{\"content\":\"a\\ud800\"}}\n", 10_000, false, &[], w),
        tcase("tail-out-of-range-number-in-a-skipped-field", t_user("go") + "{\"type\":\"user\",\"x\":1e999}\n", 10_000, true, &[], w),
        tcase("tail-out-of-range-number-in-a-read-field-is-nodes", t_user("go") + "{\"type\":\"user\",\"timestamp\":1e999}\n", 10_000, false, &[], w),
        tcase("tail-deeply-nested-line", t_user("go") + &t_call(&[("q", "AskUserQuestion", ask("old"))]) + &format!("{{\"type\":\"user\",\"message\":{{\"content\":\"deep\"}},\"x\":{}1{}}}\n", "[".repeat(300), "]".repeat(300)), 10_000, true, &[], w),
        tcase("tail-empty-file-says-nothing", String::new(), 10_000, true, &[], w),
    ];
    let mut cases = cases;
    let wm = w.clone();
    cases.push(lc("tail-missing-transcript-says-nothing", &["roster", "--json"], "child", true, "Roster").setup(move |h| {
        heartbeat(h, "child-1", NOW - 1000, None);
        let _ = &wm;
    }));
    cases
}

#[test]
fn roster_transcript_tail_matches_node() {
    if !node_sqlite_available() {
        eprintln!("SKIPPED: Node with node:sqlite is not available, so there is no Node to compare with");
        return;
    }
    let fx = fixture("l8grows");
    let cases = tail_cases(&fx);
    let n = cases.len();
    check(&fx, &cases, &[], n - 4, 4);
}
