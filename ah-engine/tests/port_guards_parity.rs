//! Node-vs-engine parity for the checks of port batches 14 to 16: devswarm-comms-guard, swarm-guard, jev-weekly-scorecard,
//! jev-review-reminder and repair-on-reload.
//!
//! Each row runs the real Node hook and `ah-engine check <name>` on separate, identically prepared isolated homes
//! (`HOME` and `USERPROFILE` pointed at a fresh directory, `ANTIHALL_TEST_ISOLATION=1`, no inherited environment) and
//! compares the exit code, the stdout bytes, the stderr bytes and every file under the home afterwards (with the
//! timestamps of the run normalized). A row either must match exactly or must make the engine defer to Node; which one
//! is part of the row, so a check that quietly defers everything cannot pass as parity.
use serde_json::{Value, json};
use std::collections::BTreeMap;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::Mutex;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

static SERIAL: Mutex<()> = Mutex::new(());
static HOME_ID: AtomicUsize = AtomicUsize::new(0);
const FALLBACK: &str = "AHFALLBACK";

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Expect {
    /// Node and the engine must agree exactly, and the engine must not defer.
    Same,
    /// The engine must defer to Node.
    Defer,
}

struct Case {
    name: String,
    input: String,
    env: Vec<(String, String)>,
    /// (path relative to the home, content); `{HOME}`, `{NOW}` and `{NOW-<ms>}` are replaced.
    files: Vec<(String, String)>,
    expect: Expect,
}

impl Case {
    fn new(name: &str, input: impl Into<String>, expect: Expect) -> Case {
        Case { name: name.into(), input: input.into(), env: Vec::new(), files: Vec::new(), expect }
    }
    fn json(name: &str, v: Value, expect: Expect) -> Case {
        Case::new(name, serde_json::to_string(&v).unwrap(), expect)
    }
    fn env(mut self, k: &str, v: &str) -> Case {
        self.env.push((k.into(), v.into()));
        self
    }
    fn file(mut self, rel: &str, content: &str) -> Case {
        self.files.push((rel.into(), content.into()));
        self
    }
}

fn repo() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..")
}

fn now_ms() -> u128 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_millis()
}

fn temp_home(tag: &str) -> PathBuf {
    let n = HOME_ID.fetch_add(1, Ordering::Relaxed);
    let d = std::env::temp_dir().join(format!("ah-b1416-{tag}-{}-{}-{n}", std::process::id(), now_ms()));
    std::fs::create_dir_all(d.join(".anti-hall")).unwrap();
    d
}

fn template(s: &str, home: &Path, now: u128) -> String {
    let mut out = s.replace("{HOME}", &home.to_string_lossy()).replace("{NOW}", &now.to_string());
    while let Some(i) = out.find("{NOW-") {
        let j = out[i..].find('}').unwrap() + i;
        let n: u128 = out[i + 5..j].parse().unwrap();
        out = format!("{}{}{}", &out[..i], now - n, &out[j + 1..]);
    }
    out
}

fn setup(home: &Path, case: &Case, now: u128) {
    for (rel, content) in &case.files {
        let p = home.join(rel);
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(p, template(content, home, now)).unwrap();
    }
}

fn run(mut cmd: Command, input: &str) -> (i32, Vec<u8>, Vec<u8>) {
    cmd.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = cmd.spawn().unwrap();
    let mut stdin = child.stdin.take().unwrap();
    let input = input.as_bytes().to_vec();
    let writer = std::thread::spawn(move || stdin.write_all(&input));
    let mut stdout = child.stdout.take().unwrap();
    let mut stderr = child.stderr.take().unwrap();
    let so = std::thread::spawn(move || {
        let mut b = Vec::new();
        stdout.read_to_end(&mut b).unwrap();
        b
    });
    let se = std::thread::spawn(move || {
        let mut b = Vec::new();
        stderr.read_to_end(&mut b).unwrap();
        b
    });
    let deadline = Instant::now() + Duration::from_secs(20);
    let status = loop {
        if let Some(s) = child.try_wait().unwrap() {
            break s;
        }
        assert!(Instant::now() < deadline, "child exceeded 20 seconds: {cmd:?}");
        std::thread::sleep(Duration::from_millis(3));
    };
    let _ = writer.join();
    (status.code().unwrap_or(-1), so.join().unwrap(), se.join().unwrap())
}

fn base_env(c: &mut Command, home: &Path, case: &Case) {
    c.env_clear()
        .env("PATH", std::env::var("PATH").unwrap_or_default())
        .env("HOME", home)
        .env("USERPROFILE", home)
        .env("ANTIHALL_TEST_ISOLATION", "1")
        .current_dir(home);
    for (k, v) in &case.env {
        c.env(k, template(v, home, 0));
    }
}

fn run_node(hook: &str, home: &Path, case: &Case) -> (i32, Vec<u8>, Vec<u8>) {
    let mut c = Command::new("node");
    c.arg(repo().join("plugins/anti-hall/hooks").join(hook));
    base_env(&mut c, home, case);
    run(c, &case.input)
}

fn run_engine(check: &str, home: &Path, case: &Case) -> (i32, Vec<u8>, Vec<u8>) {
    let mut c = Command::new(env!("CARGO_BIN_EXE_ah-engine"));
    c.arg("check").arg(check);
    base_env(&mut c, home, case);
    c.env("AH_ENGINE_DIR", home.join("engine-state")).env("AH_ENGINE_PLUGIN_ROOT", repo().join("plugins/anti-hall"));
    run(c, &case.input)
}

fn walk(dir: &Path, root: &Path, out: &mut Vec<PathBuf>) {
    let Ok(rd) = std::fs::read_dir(dir) else { return };
    let mut es: Vec<_> = rd.flatten().collect();
    es.sort_by_key(|e| e.file_name());
    for e in es {
        let p = e.path();
        if p.is_dir() {
            walk(&p, root, out);
        } else {
            out.push(p.strip_prefix(root).unwrap().to_path_buf());
        }
    }
}

/// Every file under the home after a run, with this run's timestamps and temp paths normalized.
fn snapshot(home: &Path, started: u128) -> BTreeMap<String, String> {
    let ms = regex::Regex::new(r"\b1[0-9]{12}\b").unwrap();
    let iso = regex::Regex::new(r"\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z").unwrap();
    let mut files = Vec::new();
    walk(home, home, &mut files);
    let mut out = BTreeMap::new();
    for rel in files {
        let rels = rel.to_string_lossy().to_string();
        if rels.starts_with("engine-state") {
            continue; // the engine's own state directory (a socket-less one-shot run may create it)
        }
        let text = String::from_utf8_lossy(&std::fs::read(home.join(&rel)).unwrap_or_default()).to_string();
        let text = text.replace(&home.to_string_lossy().to_string(), "<HOME>");
        let text = ms
            .replace_all(&text, |c: &regex::Captures| {
                let n: u128 = c[0].parse().unwrap();
                if n + 5000 >= started && n <= now_ms() + 5000 { "<NOW>".to_string() } else { c[0].to_string() }
            })
            .to_string();
        out.insert(rels, iso.replace_all(&text, "<ISO>").to_string());
    }
    out
}

/// The run's output with its home directory replaced by a placeholder (the two sides use different homes).
fn unhome(r: (i32, Vec<u8>, Vec<u8>), home: &Path) -> (i32, Vec<u8>, Vec<u8>) {
    let h = home.to_string_lossy().to_string();
    let f = |b: Vec<u8>| String::from_utf8_lossy(&b).replace(&h, "<HOME>").into_bytes();
    (r.0, f(r.1), f(r.2))
}

fn show(r: &(i32, Vec<u8>, Vec<u8>)) -> String {
    format!("({}, {:?}, {:?})", r.0, String::from_utf8_lossy(&r.1), String::from_utf8_lossy(&r.2))
}

/// Run every row on both sides; returns (rows compared exactly, rows deferred).
fn check_rows(hook: &str, check: &str, rows: Vec<Case>) -> (usize, usize) {
    let _serial = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
    let (mut same, mut deferred) = (0, 0);
    let (mut blocks, mut advisories, mut silent) = (0, 0, 0);
    let mut bad = Vec::new();
    for (i, case) in rows.iter().enumerate() {
        let (nh, rh) = (temp_home(&format!("n{i}")), temp_home(&format!("r{i}")));
        let now = now_ms();
        setup(&nh, case, now);
        setup(&rh, case, now);
        let started = now_ms();
        let node = unhome(run_node(hook, &nh, case), &nh);
        let node_snap = snapshot(&nh, started);
        let eng = unhome(run_engine(check, &rh, case), &rh);
        let eng_snap = snapshot(&rh, started);
        let deferred_now = eng.0 == 0 && eng.1 == format!("{FALLBACK}\n").as_bytes() && eng.2.is_empty();
        match case.expect {
            Expect::Defer => {
                if !deferred_now {
                    bad.push(format!("{}: expected the engine to defer, got {}", case.name, show(&eng)));
                } else if eng_snap != BTreeMap::from_iter(setup_snapshot(&case.files, &rh, now)) {
                    bad.push(format!("{}: a deferral must leave the home untouched, got {eng_snap:?}", case.name));
                } else {
                    deferred += 1;
                }
            }
            Expect::Same => {
                if node != eng || node_snap != eng_snap {
                    let diff: Vec<String> = node_snap
                        .keys()
                        .chain(eng_snap.keys())
                        .filter(|k| node_snap.get(*k) != eng_snap.get(*k))
                        .map(|k| format!("{k}: node={:?} eng={:?}", node_snap.get(k), eng_snap.get(k)))
                        .collect();
                    bad.push(format!("{}\nnode={}\neng ={}\nfile diffs: {diff:?}", case.name, show(&node), show(&eng)));
                } else {
                    same += 1;
                    match (node.0, node.1.is_empty()) {
                        (2, _) => blocks += 1,
                        (_, false) => advisories += 1,
                        _ => silent += 1,
                    }
                }
            }
        }
        let _ = std::fs::remove_dir_all(&nh);
        let _ = std::fs::remove_dir_all(&rh);
    }
    assert!(bad.is_empty(), "{} / {} {check} rows failed:\n{}", bad.len(), rows.len(), bad.join("\n\n"));
    println!("{check} parity: {same} exact ({blocks} blocks, {advisories} with output, {silent} silent), {deferred} deferred, of {}", rows.len());
    (same, deferred)
}

/// The snapshot a home has straight after `setup` (normalized the way `snapshot` does), for the "deferral touches nothing" rule.
fn setup_snapshot(files: &[(String, String)], home: &Path, now: u128) -> Vec<(String, String)> {
    let ms = regex::Regex::new(r"\b1[0-9]{12}\b").unwrap();
    files
        .iter()
        .map(|(rel, c)| {
            let t = template(c, home, now).replace(&home.to_string_lossy().to_string(), "<HOME>");
            let t = ms
                .replace_all(&t, |c: &regex::Captures| {
                    let n: u128 = c[0].parse().unwrap();
                    if n + 5000 >= now && n <= now + 5000 { "<NOW>".to_string() } else { c[0].to_string() }
                })
                .to_string();
            (rel.clone(), t)
        })
        .collect()
}

// ---- devswarm-comms-guard ---------------------------------------------------------------------------------

fn send(to: Value) -> Value {
    json!({"hook_event_name":"PreToolUse","tool_name":"SendMessage","tool_input":{"to":to,"message":"hi"},"session_id":"s","cwd":"/tmp"})
}

fn session_file(pid: u32, name: &str, cwd: &str) -> (String, String) {
    (format!(".claude/sessions/{pid}.json"), json!({"name":name,"cwd":cwd,"pid":pid}).to_string())
}

fn comms_cases() -> Vec<Case> {
    let on = |c: Case| c.env("DEVSWARM_REPO_ID", "r1");
    let ws = "{HOME}/.devswarm/repos/0/32ac85da/fix-login";
    let mut out: Vec<Case> = Vec::new();
    let with_sessions = |mut c: Case| {
        for (rel, content) in [
            session_file(101, "fix-login-9f", ws),
            session_file(102, "plain-peer", "/Users/someone/project"),
            session_file(103, "a1b2c3d4", ws),
            session_file(104, "rel-peer", "relative/dir"),
            session_file(105, "empty-cwd", ""),
            session_file(106, "root-itself", "{HOME}/.devswarm/repos"),
            session_file(107, "sibling", "{HOME}/.devswarm/repos2/x"),
            session_file(108, "dotdot", "{HOME}/.devswarm/repos/../elsewhere"),
            session_file(109, "slashes", "{HOME}//.devswarm///repos/0/x/"),
            session_file(110, "ünï-peer", "/p/ü"),
            session_file(111, "dup", "/first"),
            session_file(112, "dup", "{HOME}/.devswarm/repos/0/y"),
        ] {
            c = c.file(&rel, &content);
        }
        c.file(".claude/sessions/broken.json", "{not json").file(".claude/sessions/notes.txt", "{\"name\":\"txt-peer\",\"cwd\":\"/x\"}").file(".claude/sessions/arr.json", "[1,2]")
    };
    let ex = Expect::Same;
    // inactive without DevSwarm: every target is silent
    out.push(with_sessions(Case::json("inactive-no-env", send(json!("fix-login-9f")), ex)));
    out.push(with_sessions(Case::json("inactive-disable", send(json!("fix-login-9f")), ex).env("DEVSWARM_REPO_ID", "r1").env("DISABLE_ANTIHALL_DEVSWARM", "1")));
    out.push(with_sessions(Case::json("mode-off", send(json!("fix-login-9f")), ex).env("DEVSWARM_REPO_ID", "r1").env("ANTIHALL_DEVSWARM_SUPERVISOR", "off")));
    out.push(with_sessions(Case::json("mode-on-no-repo-id", send(json!("fix-login-9f")), ex).env("ANTIHALL_DEVSWARM_SUPERVISOR", " ON ")));
    out.push(with_sessions(Case::json("mode-invalid-falls-to-auto", send(json!("fix-login-9f")), ex).env("DEVSWARM_REPO_ID", "r1").env("ANTIHALL_DEVSWARM_SUPERVISOR", "maybe")));
    out.push(with_sessions(Case::json("repo-id-blank", send(json!("fix-login-9f")), ex).env("DEVSWARM_REPO_ID", "   ")));
    out.push(with_sessions(Case::json("mode-from-settings-file", send(json!("fix-login-9f")), ex).file(".anti-hall/settings.json", r#"{"devswarm":{"supervisorMode":"on"}}"#)));
    out.push(with_sessions(Case::json("mode-settings-file-invalid", send(json!("fix-login-9f")), ex).file(".anti-hall/settings.json", r#"{"devswarm":{"supervisorMode":"nope"}}"#).env("DEVSWARM_REPO_ID", "r1")));
    out.push(with_sessions(Case::json("mode-plugin-option-off", send(json!("fix-login-9f")), ex).env("DEVSWARM_REPO_ID", "r1").env("CLAUDE_PLUGIN_OPTION_DEVSWARM_SUPERVISOR_MODE", "off")));
    out.push(with_sessions(Case::json("mode-plugin-option-default-ignored", send(json!("fix-login-9f")), ex).env("DEVSWARM_REPO_ID", "r1").env("CLAUDE_PLUGIN_OPTION_DEVSWARM_SUPERVISOR_MODE", "auto")));
    // the switch
    out.push(on(with_sessions(Case::json("switch-off-settings", send(json!("fix-login-9f")), ex).file(".anti-hall/settings.json", r#"{"devswarm":{"commsGuard":false}}"#))));
    out.push(on(with_sessions(Case::json("switch-off-string", send(json!("fix-login-9f")), ex).file(".anti-hall/settings.json", r#"{"devswarm":{"commsGuard":"off"}}"#))));
    out.push(on(with_sessions(Case::json("switch-garbage-stays-on", send(json!("fix-login-9f")), ex).file(".anti-hall/settings.json", r#"{"devswarm":{"commsGuard":"banana"}}"#))));
    out.push(on(with_sessions(Case::json("switch-off-plugin-option", send(json!("fix-login-9f")), ex).env("CLAUDE_PLUGIN_OPTION_DEVSWARM_COMMS_GUARD", "false"))));
    out.push(on(with_sessions(Case::json("skip-file", send(json!("fix-login-9f")), ex).file(".anti-hall/skip.json", r#"{"devswarm-comms-guard":99999999999999}"#))));
    out.push(on(with_sessions(Case::json("skip-all", send(json!("fix-login-9f")), ex).file(".anti-hall/skip.json", r#"{"all":99999999999999}"#))));
    out.push(on(with_sessions(Case::json("skip-expired", send(json!("fix-login-9f")), ex).file(".anti-hall/skip.json", r#"{"devswarm-comms-guard":1}"#))));
    // targets while active
    for (name, to) in [
        ("workspace-peer-block", json!("fix-login-9f")),
        ("workspace-peer-with-ref", json!("fix-login-9f [9b8fa3]")),
        ("workspace-peer-padded", json!("  fix-login-9f  ")),
        ("workspace-agentid-shaped-name", json!("a1b2c3d4")),
        ("plain-peer-label", json!("plain-peer")),
        ("plain-peer-ref-label", json!("plain-peer [abcd1234]")),
        ("main-lower", json!("main")),
        ("main-upper", json!("MAIN")),
        ("main-padded", json!(" Main ")),
        ("agent-id-bare", json!("a6042fcc9b2813dac")),
        ("agent-id-hyphen", json!("a6042fcc-9b28-13da")),
        ("agent-id-upper", json!("ABCDEF123")),
        ("unknown-name", json!("nobody-here")),
        ("empty-cwd-peer", json!("empty-cwd")),
        ("root-itself-peer", json!("root-itself")),
        ("sibling-prefix-peer", json!("sibling")),
        ("dotdot-peer", json!("dotdot")),
        ("slashes-peer", json!("slashes")),
        ("unicode-peer", json!("ünï-peer")),
        ("first-dup-wins", json!("dup")),
        ("txt-file-ignored", json!("txt-peer")),
        ("empty-to", json!("")),
        ("blank-to", json!("   ")),
        ("to-number", json!(5)),
        ("to-null", Value::Null),
        ("to-array", json!(["main"])),
        ("ref-too-short", json!("plain-peer [abc]")),
        ("ref-newline-inside", json!("plain\npeer [abcd1234]")),
    ] {
        out.push(on(with_sessions(Case::json(name, send(to), ex))));
    }
    // payload shapes
    let base = send(json!("fix-login-9f"));
    let mut other_tool = base.clone();
    other_tool["tool_name"] = json!("Agent");
    out.push(on(with_sessions(Case::json("tool-other-silent", other_tool, ex))));
    let mut no_tool = base.clone();
    no_tool.as_object_mut().unwrap().remove("tool_name");
    out.push(on(with_sessions(Case::json("tool-missing-still-gates", no_tool, ex))));
    let mut no_input = base.clone();
    no_input.as_object_mut().unwrap().remove("tool_input");
    out.push(on(with_sessions(Case::json("tool-input-missing", no_input, ex))));
    out.push(on(with_sessions(Case::json("payload-array", json!([1, 2]), ex))));
    out.push(on(with_sessions(Case::new("payload-null", "null", ex))));
    out.push(on(with_sessions(Case::new("payload-number", "42", ex))));
    out.push(on(with_sessions(Case::new("payload-empty-stdin", "", Expect::Defer))));
    out.push(on(with_sessions(Case::new("payload-garbage", "{nope", Expect::Defer))));
    out.push(on(with_sessions(Case::new("payload-lone-surrogate", "{\"tool_name\":\"SendMessage\",\"tool_input\":{\"to\":\"\\ud800\"}}", Expect::Defer))));
    out.push(on(Case::json("no-session-dir", send(json!("fix-login-9f")), ex)));
    out.push(on(Case::json("huge-to", send(json!("x".repeat(200_000))), ex)));
    // cases the engine cannot decide identically
    out.push(on(with_sessions(Case::json("relative-session-cwd-defers", send(json!("rel-peer")), Expect::Defer))));
    out
}

#[test]
fn devswarm_comms_guard_matches_node() {
    let rows = comms_cases();
    assert!(rows.len() >= 30, "need at least 30 rows, got {}", rows.len());
    let (same, deferred) = check_rows("devswarm-comms-guard.js", "devswarm-comms-guard", rows);
    assert!(same >= 30 && deferred >= 1);
}
