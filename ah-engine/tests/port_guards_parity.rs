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

// ---- swarm-guard ---------------------------------------------------------------------------------------------

fn spawn_payload(tool: &str, input: Value, transcript: Option<&str>) -> Value {
    let mut p = json!({"hook_event_name":"PreToolUse","tool_name":tool,"tool_input":input,"session_id":"s","cwd":"/tmp"});
    if let Some(t) = transcript {
        p["transcript_path"] = json!(t);
    }
    p
}

fn log_of(ages_ms: &[u64]) -> String {
    ages_ms.iter().map(|a| format!("{{NOW-{a}}}\n")).collect()
}

fn swarm_cases() -> Vec<Case> {
    let ex = Expect::Same;
    let explore = || json!({"subagent_type":"Explore","prompt":"look"});
    let general = || json!({"subagent_type":"general-purpose","prompt":"do it"});
    let fresh_lock = |age: u64| format!(r#"{{"pid":1,"host":"other","ts":{{NOW-{age}}},"token":"t:1:1:x"}}"#);
    let log = ".anti-hall/swarm-spawns.log";
    let lock = ".anti-hall/swarm-spawns.lock";
    let recent = |n: usize| -> Vec<u64> { (0..n).map(|i| 1000 + i as u64 * 100).collect() };
    let mut out = vec![
        Case::json("empty-home-explore", spawn_payload("Agent", explore(), Some("/t.jsonl")), ex),
        Case::json("empty-home-task-tool", spawn_payload("Task", explore(), Some("/t.jsonl")), ex),
        Case::json("empty-home-general-no-transcript", spawn_payload("Agent", general(), None), ex),
        Case::json("one-recent", spawn_payload("Agent", explore(), None), ex).file(log, &log_of(&[2000])),
        Case::json("nineteen-recent-allows", spawn_payload("Agent", explore(), None), ex).file(log, &log_of(&recent(19))),
        Case::json("twenty-recent-blocks", spawn_payload("Agent", explore(), None), ex).file(log, &log_of(&recent(20))),
        Case::json("twenty-five-recent-blocks", spawn_payload("Task", general(), Some("/t")), ex).file(log, &log_of(&recent(25))),
        Case::json("twenty-with-one-old-allows", spawn_payload("Agent", explore(), None), ex).file(log, &log_of(&[70_000, 1000, 1100, 1200, 1300, 1400, 1500, 1600, 1700, 1800, 1900, 2000, 2100, 2200, 2300, 2400, 2500, 2600, 2700, 2800])),
        Case::json("near-window-edge-counts", spawn_payload("Agent", explore(), None), ex).file(log, &log_of(&[59_000; 20])),
        Case::json("garbage-lines", spawn_payload("Agent", explore(), None), ex).file(log, "abc\n{NOW-1000}abc\n\n-5\n0\n+{NOW-500}\n 12 \n0x10\n1e3\n"),
        Case::json("crlf-log", spawn_payload("Agent", explore(), None), ex).file(log, "{NOW-1000}\r\n{NOW-900}\r\n"),
        Case::json("only-whitespace-log", spawn_payload("Agent", explore(), None), ex).file(log, "  \n\t\n"),
        Case::json("no-trailing-newline", spawn_payload("Agent", explore(), None), ex).file(log, "{NOW-1000}"),
        Case::json("log-is-a-directory", spawn_payload("Agent", explore(), None), ex).file(".anti-hall/swarm-spawns.log/keep", "x"),
        Case::json("huge-entry-defers", spawn_payload("Agent", explore(), None), Expect::Defer).file(log, "99999999999999999999\n"),
        Case::json("huge-entry-but-capped-blocks", spawn_payload("Agent", explore(), None), ex).file(log, &format!("99999999999999999999\n{}", log_of(&recent(19)))),
        Case::json("skip-file", spawn_payload("Agent", explore(), None), ex).file(".anti-hall/skip.json", r#"{"swarm-guard":99999999999999}"#).file(log, &log_of(&recent(25))),
        Case::json("skip-all", spawn_payload("Agent", explore(), None), ex).file(".anti-hall/skip.json", r#"{"all":99999999999999}"#).file(log, &log_of(&recent(25))),
        Case::json("skip-expired-still-blocks", spawn_payload("Agent", explore(), None), ex).file(".anti-hall/skip.json", r#"{"swarm-guard":5}"#).file(log, &log_of(&recent(25))),
        Case::json("switch-off-env", spawn_payload("Agent", explore(), None), ex).env("ANTIHALL_SWARM_GUARD", "0").file(log, &log_of(&recent(25))),
        Case::json("switch-off-settings", spawn_payload("Agent", explore(), None), ex).file(".anti-hall/settings.json", r#"{"safety":{"swarmGuard":false}}"#).file(log, &log_of(&recent(25))),
        Case::json("switch-off-plugin-option", spawn_payload("Agent", explore(), None), ex).env("CLAUDE_PLUGIN_OPTION_SAFETY_SWARM_GUARD", "false").file(log, &log_of(&recent(25))),
        Case::json("switch-plugin-option-default-ignored", spawn_payload("Agent", explore(), None), ex).env("CLAUDE_PLUGIN_OPTION_SAFETY_SWARM_GUARD", "true").file(log, &log_of(&recent(25))),
        Case::json("switch-garbage-stays-on", spawn_payload("Agent", explore(), None), ex).file(".anti-hall/settings.json", r#"{"safety":{"swarmGuard":"maybe"}}"#).file(log, &log_of(&recent(25))),
        // the lock
        Case::json("fresh-foreign-lock-fails-open-unrecorded", spawn_payload("Agent", explore(), None), ex).file(lock, &fresh_lock(100)).file(log, &log_of(&recent(25))),
        Case::json("stale-lock-is-taken-over", spawn_payload("Agent", explore(), None), ex).file(lock, &fresh_lock(9000)),
        Case::json("stale-lock-then-block", spawn_payload("Agent", explore(), None), ex).file(lock, &fresh_lock(9000)).file(log, &log_of(&recent(21))),
        Case::json("corrupt-fresh-lock-fails-open", spawn_payload("Agent", explore(), None), ex).file(lock, "{torn"),
        Case::json("empty-fresh-lock-fails-open", spawn_payload("Agent", explore(), None), ex).file(lock, ""),
        Case::json("stale-lock-with-stale-reclaim-marker", spawn_payload("Agent", explore(), None), ex).file(lock, &fresh_lock(9000)).file(".anti-hall/swarm-spawns.lock.reclaim", &fresh_lock(9000)),
        Case::json("stale-lock-with-fresh-reclaim-marker", spawn_payload("Agent", explore(), None), ex).file(lock, &fresh_lock(9000)).file(".anti-hall/swarm-spawns.lock.reclaim", &fresh_lock(100)),
        Case::json("lock-without-ts-record", spawn_payload("Agent", explore(), None), ex).file(lock, r#"{"pid":1,"token":"x"}"#),
        // the advisory (needs the transcript scan, so the engine defers whenever it could be due)
        Case::json("general-with-transcript-defers", spawn_payload("Agent", general(), Some("/t.jsonl")), Expect::Defer),
        Case::json("task-general-with-transcript-defers", spawn_payload("Task", general(), Some("/t.jsonl")), Expect::Defer),
        Case::json("no-type-with-transcript-defers", spawn_payload("Agent", json!({"prompt":"x"}), Some("/t.jsonl")), Expect::Defer),
        Case::json("input-array-with-transcript-defers", spawn_payload("Agent", json!(["x"]), Some("/t.jsonl")), Expect::Defer),
        Case::json("tools-with-edit-defers", spawn_payload("Agent", json!({"tools":["Read","Edit"]}), Some("/t.jsonl")), Expect::Defer),
        Case::json("nested-tools-defers", spawn_payload("Agent", json!({"tools":[["Edit"]]}), Some("/t.jsonl")), Expect::Defer),
        Case::json("general-with-transcript-at-cap-still-blocks", spawn_payload("Agent", general(), Some("/t.jsonl")), ex).file(log, &log_of(&recent(20))),
        Case::json("isolated-worktree-silent", spawn_payload("Agent", json!({"subagent_type":"general-purpose","isolation":"Worktree"}), Some("/t.jsonl")), ex),
        Case::json("isolated-remote-silent", spawn_payload("Agent", json!({"isolation":" remote "}), Some("/t.jsonl")), ex),
        Case::json("isolation-other-defers", spawn_payload("Agent", json!({"isolation":"none"}), Some("/t.jsonl")), Expect::Defer),
        Case::json("read-only-allowlist-silent", spawn_payload("Agent", json!({"tools":"Read, Grep"}), Some("/t.jsonl")), ex),
        Case::json("empty-allowlist-silent", spawn_payload("Agent", json!({"tools":[]}), Some("/t.jsonl")), ex),
        Case::json("camel-allowlist-silent", spawn_payload("Agent", json!({"allowedTools":["Read"]}), Some("/t.jsonl")), ex),
        Case::json("deny-all-writes-silent", spawn_payload("Agent", json!({"disallowedTools":["Edit","Write","MultiEdit"]}), Some("/t.jsonl")), ex),
        Case::json("deny-some-writes-defers", spawn_payload("Agent", json!({"disallowedTools":["Edit","Write"]}), Some("/t.jsonl")), Expect::Defer),
        Case::json("omc-read-only-type-silent", spawn_payload("Agent", json!({"subagent_type":"oh-my-claudecode:Verifier"}), Some("/t.jsonl")), ex),
        Case::json("shared-tree-switch-off-silent", spawn_payload("Agent", general(), Some("/t.jsonl")), ex).file(".anti-hall/settings.json", r#"{"guards":{"sharedTreeAgentNote":false}}"#),
        Case::json("shared-tree-env-off-silent", spawn_payload("Agent", general(), Some("/t.jsonl")), ex).env("ANTIHALL_SHARED_TREE_AGENT_NOTE", "off"),
        Case::json("transcript-empty-silent", spawn_payload("Agent", general(), Some("")), ex),
        Case::json("transcript-number-silent", {
            let mut p = spawn_payload("Agent", general(), None);
            p["transcript_path"] = json!(5);
            p
        }, ex),
        Case::json("tool-input-missing-silent", json!({"tool_name":"Agent","transcript_path":"/t"}), ex),
        Case::json("tool-input-string-silent", spawn_payload("Agent", json!("x"), Some("/t")), ex),
        Case::json("tool-input-null-silent", spawn_payload("Agent", Value::Null, Some("/t")), ex),
        // payload shapes and trip-log labels
        Case::json("label-camel-agent-type-at-cap", spawn_payload("Agent", json!({"agentType":"ünï","prompt":"x"}), None), ex).file(log, &log_of(&recent(20))),
        Case::json("label-snake-agent-type-at-cap", spawn_payload("Task", json!({"agent_type":"snake"}), None), ex).file(log, &log_of(&recent(20))),
        Case::json("label-empty-type-at-cap", spawn_payload("Task", json!({"subagent_type":"","agentType":"second"}), None), ex).file(log, &log_of(&recent(20))),
        Case::json("label-no-tool-name-at-cap", json!({"tool_input":{"subagent_type":"x"}}), ex).file(log, &log_of(&recent(20))),
        Case::json("label-numeric-type-at-cap", spawn_payload("Agent", json!({"subagent_type":5}), None), ex).file(log, &log_of(&recent(20))),
        Case::json("payload-array", json!([1]), ex),
        Case::new("payload-null", "null", ex),
        Case::new("payload-number-at-cap", "7", ex).file(log, &log_of(&recent(20))),
        Case::new("payload-empty-stdin", "", Expect::Defer),
        Case::new("payload-garbage", "{nope", Expect::Defer),
    ];
    // a pre-existing trip log keeps its lines and gets one appended
    out.push(Case::json("trip-log-appends", spawn_payload("Agent", explore(), None), ex).file(log, &log_of(&recent(20))).file(".anti-hall/swarm-trips.log", "old\tline\n"));
    out
}

#[test]
fn swarm_guard_matches_node() {
    let rows = swarm_cases();
    assert!(rows.len() >= 30, "need at least 30 rows, got {}", rows.len());
    // the same rows drive both tools: `swarm-guard.js` is registered for Agent and for Task
    let (same, deferred) = check_rows("swarm-guard.js", "swarm-guard", rows);
    assert!(same >= 30 && deferred >= 5);
}
