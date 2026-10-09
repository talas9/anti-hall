//! Node-vs-engine parity for the checks of port batches 14 to 16: devswarm-comms-guard, swarm-guard, jev-weekly-scorecard,
//! jev-review-reminder and repair-on-reload.
//!
//! Each row runs the real Node hook and `ah-engine check <name>` on separate, identically prepared isolated homes
//! (`HOME` and `USERPROFILE` pointed at a fresh directory, `ANTIHALL_TEST_ISOLATION=1`, no inherited environment) and
//! compares the exit code, the stdout bytes, the stderr bytes and every file under the home afterwards (with the
//! timestamps of the run normalized). A row either must match exactly or must make the engine defer to Node; which one
//! is part of the row, so a check that quietly defers everything cannot pass as parity.
#![allow(clippy::unwrap_used, clippy::expect_used)] // a test crate: a panic is the failure report, and E2 exempts tests
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
    /// A deferral row where Node must visibly act (print or change a file): proves the deferral is not a lost optimization.
    acts: bool,
    /// Do not run the Node hook (it would start a detached repair process); the row only proves the engine defers.
    skip_node: bool,
}

impl Case {
    fn new(name: &str, input: impl Into<String>, expect: Expect) -> Case {
        Case { name: name.into(), input: input.into(), env: Vec::new(), files: Vec::new(), expect, acts: false, skip_node: false }
    }
    fn json(name: &str, v: Value, expect: Expect) -> Case {
        Case::new(name, serde_json::to_string(&v).unwrap(), expect)
    }
    fn env(mut self, k: &str, v: &str) -> Case {
        self.env.push((k.into(), v.into()));
        self
    }
    fn acts(mut self) -> Case {
        self.acts = true;
        self
    }
    fn skip_node(mut self) -> Case {
        self.skip_node = true;
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

fn plugin_version() -> String {
    let t = std::fs::read_to_string(repo().join("plugins/anti-hall/.claude-plugin/plugin.json")).unwrap();
    serde_json::from_str::<Value>(&t).unwrap()["version"].as_str().unwrap().to_string()
}

fn template(s: &str, home: &Path, now: u128) -> String {
    let mut out = s.replace("{HOME}", &home.to_string_lossy()).replace("{NOW}", &now.to_string()).replace("{V}", &plugin_version());
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
    ah_engine::discard::harmless(writer.join());
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
    run(c, &case.input.replace("{HOME}", &home.to_string_lossy()))
}

fn run_engine(check: &str, home: &Path, case: &Case) -> (i32, Vec<u8>, Vec<u8>) {
    let mut c = Command::new(env!("CARGO_BIN_EXE_ah-engine"));
    c.arg("check").arg(check);
    base_env(&mut c, home, case);
    c.env("AH_ENGINE_DIR", home.join("engine-state")).env("AH_ENGINE_PLUGIN_ROOT", repo().join("plugins/anti-hall"));
    run(c, &case.input.replace("{HOME}", &home.to_string_lossy()))
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
        let node = if case.skip_node { (0, Vec::new(), Vec::new()) } else { unhome(run_node(hook, &nh, case), &nh) };
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
                } else if case.acts && node.1.is_empty() && node_snap == BTreeMap::from_iter(setup_snapshot(&case.files, &nh, now)) {
                    bad.push(format!("{}: marked as a row where Node acts, but Node printed and wrote nothing", case.name));
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
        ah_engine::discard::harmless(std::fs::remove_dir_all(&nh));
        ah_engine::discard::harmless(std::fs::remove_dir_all(&rh));
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
        c.file(".claude/sessions/broken.json", "{not json")
            .file(".claude/sessions/notes.txt", "{\"name\":\"txt-peer\",\"cwd\":\"/x\"}")
            .file(".claude/sessions/arr.json", "[1,2]")
    };
    let ex = Expect::Same;
    // inactive without DevSwarm: every target is silent
    out.push(with_sessions(Case::json("inactive-no-env", send(json!("fix-login-9f")), ex)));
    out.push(with_sessions(
        Case::json("inactive-disable", send(json!("fix-login-9f")), ex).env("DEVSWARM_REPO_ID", "r1").env("DISABLE_ANTIHALL_DEVSWARM", "1"),
    ));
    out.push(with_sessions(Case::json("mode-off", send(json!("fix-login-9f")), ex).env("DEVSWARM_REPO_ID", "r1").env("ANTIHALL_DEVSWARM_SUPERVISOR", "off")));
    out.push(with_sessions(Case::json("mode-on-no-repo-id", send(json!("fix-login-9f")), ex).env("ANTIHALL_DEVSWARM_SUPERVISOR", " ON ")));
    out.push(with_sessions(
        Case::json("mode-invalid-falls-to-auto", send(json!("fix-login-9f")), ex).env("DEVSWARM_REPO_ID", "r1").env("ANTIHALL_DEVSWARM_SUPERVISOR", "maybe"),
    ));
    out.push(with_sessions(Case::json("repo-id-blank", send(json!("fix-login-9f")), ex).env("DEVSWARM_REPO_ID", "   ")));
    out.push(with_sessions(
        Case::json("mode-from-settings-file", send(json!("fix-login-9f")), ex).file(".anti-hall/settings.json", r#"{"devswarm":{"supervisorMode":"on"}}"#),
    ));
    out.push(with_sessions(
        Case::json("mode-settings-file-invalid", send(json!("fix-login-9f")), ex)
            .file(".anti-hall/settings.json", r#"{"devswarm":{"supervisorMode":"nope"}}"#)
            .env("DEVSWARM_REPO_ID", "r1"),
    ));
    out.push(with_sessions(
        Case::json("mode-plugin-option-off", send(json!("fix-login-9f")), ex)
            .env("DEVSWARM_REPO_ID", "r1")
            .env("CLAUDE_PLUGIN_OPTION_DEVSWARM_SUPERVISOR_MODE", "off"),
    ));
    out.push(with_sessions(
        Case::json("mode-plugin-option-default-ignored", send(json!("fix-login-9f")), ex)
            .env("DEVSWARM_REPO_ID", "r1")
            .env("CLAUDE_PLUGIN_OPTION_DEVSWARM_SUPERVISOR_MODE", "auto"),
    ));
    // the switch
    out.push(on(with_sessions(
        Case::json("switch-off-settings", send(json!("fix-login-9f")), ex).file(".anti-hall/settings.json", r#"{"devswarm":{"commsGuard":false}}"#),
    )));
    out.push(on(with_sessions(
        Case::json("switch-off-string", send(json!("fix-login-9f")), ex).file(".anti-hall/settings.json", r#"{"devswarm":{"commsGuard":"off"}}"#),
    )));
    out.push(on(with_sessions(
        Case::json("switch-garbage-stays-on", send(json!("fix-login-9f")), ex).file(".anti-hall/settings.json", r#"{"devswarm":{"commsGuard":"banana"}}"#),
    )));
    out.push(on(with_sessions(
        Case::json("switch-off-plugin-option", send(json!("fix-login-9f")), ex).env("CLAUDE_PLUGIN_OPTION_DEVSWARM_COMMS_GUARD", "false"),
    )));
    out.push(on(with_sessions(
        Case::json("skip-file", send(json!("fix-login-9f")), ex).file(".anti-hall/skip.json", r#"{"devswarm-comms-guard":99999999999999}"#),
    )));
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
    assert!(rows.len() >= 50, "need at least 50 rows, got {}", rows.len());
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

/// A transcript whose tail launched one background agent from `input` (still running unless `finished`).
fn launch_transcript(input: Value, finished: bool) -> String {
    launches_transcript(&[("toolu_1", "a1b2c3d4e5f60718", input)], finished)
}

fn launches_transcript(agents: &[(&str, &str, Value)], finished: bool) -> String {
    let mut out = String::new();
    for (tu, id, input) in agents {
        let call = json!({"type":"assistant","message":{"content":[{"type":"tool_use","id":tu,"name":"Agent","input":input}]}});
        let result = json!({"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":tu,
            "content":format!("Async agent launched successfully.\nagentId: {id} (internal ID - do not mention to user)\noutput_file: /tmp/ah-none/{id}.output")}]}});
        out.push_str(&format!("{call}\n{result}\n"));
        if finished {
            let note = json!({"type":"user","message":{"role":"user","content":format!("<task-notification>\n<task-id>{id}</task-id>\n<status>completed</status>\n</task-notification>")}});
            out.push_str(&format!("{note}\n"));
        }
    }
    out
}

/// The shared-tree advisory: spawns beside a running writer, the silent shapes, the repo rule that drops the isolation hint,
/// and the shapes the engine hands to Node.
fn shared_tree_cases() -> Vec<Case> {
    let ex = Expect::Same;
    let general = || json!({"subagent_type":"general-purpose","prompt":"do it"});
    let t = ".anti-hall/t.jsonl";
    let tp = "{HOME}/.anti-hall/t.jsonl";
    let at = |tool: &str, input: Value| {
        let mut p = spawn_payload(tool, input, Some(tp));
        p["cwd"] = json!("{HOME}");
        p
    };
    let busy = || launch_transcript(general(), false);
    let mut out = vec![
        Case::json("adv-writer-beside-writer", at("Agent", general()), ex).file(t, &busy()),
        Case::json("adv-task-tool", at("Task", general()), ex).file(t, &busy()),
        Case::json("adv-no-type-spawn", at("Agent", json!({"prompt":"x"})), ex).file(t, &busy()),
        Case::json("adv-other-agent-has-no-type", at("Agent", general()), ex).file(t, &launch_transcript(json!({"prompt":"x"}), false)),
        Case::json("adv-claude-md-forbids-worktrees", at("Agent", general()), ex).file(t, &busy()).file("CLAUDE.md", "Rules\n- No worktrees in this repo.\n"),
        Case::json("adv-agents-md-forbids-git-worktree", at("Agent", general()), ex).file(t, &busy()).file("AGENTS.md", "never: NO GIT WORKTREE use\n"),
        Case::json("adv-claude-md-unrelated", at("Agent", general()), ex).file(t, &busy()).file("CLAUDE.md", "Use worktrees for features.\n"),
        Case::json("adv-claude-md-is-a-directory", at("Agent", general()), ex).file(t, &busy()).file("CLAUDE.md/keep", "x"),
        Case::json("adv-rule-in-a-parent-directory", {
            let mut p = at("Agent", general());
            p["cwd"] = json!("{HOME}/sub/deeper");
            p
        }, ex)
        .file(t, &busy())
        .file("sub/deeper/keep", "x")
        .file("CLAUDE.md", "no worktrees\n"),
        Case::json("adv-rule-stops-at-the-repo-root", {
            let mut p = at("Agent", general());
            p["cwd"] = json!("{HOME}/repo/sub");
            p
        }, ex)
        .file(t, &busy())
        .file("repo/.git/HEAD", "ref: refs/heads/main\n")
        .file("repo/sub/keep", "x")
        .file("CLAUDE.md", "no worktrees\n"),
        Case::json("adv-rule-inside-the-repo", {
            let mut p = at("Agent", general());
            p["cwd"] = json!("{HOME}/repo/sub");
            p
        }, ex)
        .file(t, &busy())
        .file("repo/.git/HEAD", "ref: refs/heads/main\n")
        .file("repo/sub/keep", "x")
        .file("repo/AGENTS.md", "no worktrees\n"),
        Case::json("adv-cwd-is-missing-on-disk", {
            let mut p = at("Agent", general());
            p["cwd"] = json!("{HOME}/not/there");
            p
        }, ex)
        .file(t, &busy())
        .file("CLAUDE.md", "no worktrees\n"),
        Case::json("adv-scratch-statement-with-in-repo-is-not-scratch", at("Agent", json!({"prompt":"work in a scratch clone under /tmp/x, in the repo"})), ex).file(t, &busy()),
        Case::json("adv-negated-scratch-is-not-scratch", at("Agent", json!({"prompt":"not in scratch /tmp/x"})), ex).file(t, &busy()),
        Case::json("adv-bare-scratch-mention-is-not-scratch", at("Agent", json!({"prompt":"use a scratch directory for notes"})), ex).file(t, &busy()),
        Case::json("adv-scratch-in-description-only", at("Agent", json!({"description":"work in a scratch clone","prompt":"x"})), ex).file(t, &busy()),
        Case::json("adv-prompt-is-a-number", at("Agent", json!({"prompt":5})), ex).file(t, &busy()),
        Case::json("adv-two-agents-one-isolated", at("Agent", general()), ex).file(
            t,
            &launches_transcript(&[("toolu_1", "a1b2c3d4e5f60718", json!({"isolation":"worktree"})), ("toolu_2", "b1b2c3d4e5f60718", general())], false),
        ),
        Case::json("quiet-spawn-is-read-only", at("Agent", json!({"subagent_type":"Explore"})), ex).file(t, &busy()),
        Case::json("quiet-spawn-is-isolated", at("Agent", json!({"isolation":"worktree"})), ex).file(t, &busy()),
        Case::json("quiet-spawn-in-scratch", at("Agent", json!({"prompt":"work in a scratch clone under /tmp/x"})), ex).file(t, &busy()),
        Case::json("quiet-spawn-cd-to-private-tmp", at("Agent", json!({"prompt":"cd /private/tmp/ws and edit"})), ex).file(t, &busy()),
        Case::json("quiet-spawn-scratchpad-path", at("Agent", json!({"prompt":"cwd: /Users/x/scratchpad/y"})), ex).file(t, &busy()),
        Case::json("quiet-other-agent-read-only", at("Agent", general()), ex).file(t, &launch_transcript(json!({"subagent_type":"Explore"}), false)),
        Case::json("quiet-other-agent-isolated", at("Agent", general()), ex).file(t, &launch_transcript(json!({"isolation":"remote"}), false)),
        Case::json("quiet-other-agent-in-scratch", at("Agent", general()), ex).file(t, &launch_transcript(json!({"prompt":"work in a scratch clone under /tmp/x"}), false)),
        Case::json("quiet-other-agent-finished", at("Agent", general()), ex).file(t, &launch_transcript(general(), true)),
        Case::json("quiet-no-agent-in-transcript", at("Agent", general()), ex).file(t, "{\"type\":\"user\",\"message\":{\"content\":\"hi\"}}\n"),
        Case::json("quiet-empty-transcript", at("Agent", general()), ex).file(t, ""),
        Case::json("quiet-transcript-garbage", at("Agent", general()), ex).file(t, "{nope\n\u{1}\n"),
        Case::json("quiet-transcript-missing", at("Agent", general()), ex),
        Case::json("quiet-switch-off-with-a-writer", at("Agent", general()), ex).file(t, &busy()).file(".anti-hall/settings.json", r#"{"guards":{"sharedTreeAgentNote":false}}"#),
        Case::json("quiet-env-off-with-a-writer", at("Agent", general()), ex).file(t, &busy()).env("ANTIHALL_SHARED_TREE_AGENT_NOTE", "0"),
        Case::json("quiet-guard-skipped", at("Agent", general()), ex).file(t, &busy()).file(".anti-hall/skip.json", r#"{"swarm-guard":99999999999999}"#),
        Case::json("quiet-tool-input-array", at("Agent", json!(["x"])), ex).file(t, &busy()),
        Case::json("at-cap-the-block-wins-over-the-advisory", at("Agent", general()), ex)
            .file(t, &busy())
            .file(".anti-hall/swarm-spawns.log", &log_of(&(0..20).map(|i| 1000 + i * 100).collect::<Vec<u64>>())),
        // the engine hands these to Node, which then records the spawn once
        Case::json("defer-no-cwd-for-node-to-use-its-own", {
            let mut p = at("Agent", general());
            p.as_object_mut().unwrap().remove("cwd");
            p
        }, Expect::Defer)
        .file(t, &busy()),
        Case::json("defer-relative-transcript-path", {
            let mut p = at("Agent", general());
            p["transcript_path"] = json!(".anti-hall/t.jsonl");
            p
        }, Expect::Defer)
        .file(t, &busy()),
        Case::json("defer-cwd-not-in-normal-form", {
            let mut p = at("Agent", general());
            p["cwd"] = json!("{HOME}/sub/../sub2");
            p
        }, Expect::Defer)
        .file(t, &busy()),
        Case::json("adv-transcript-line-with-a-lone-surrogate-escape", at("Agent", general()), ex)
            .file(t, &format!("{}{{\"type\":\"user\",\"message\":{{\"content\":\"\\ud800\"}}}}\n", busy())),
    ];
    // the Task tool runs the same rows
    out.push(Case::json("adv-task-beside-task-launch", at("Task", general()), ex).file(t, &busy()));
    out
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
        Case::json("twenty-with-one-old-allows", spawn_payload("Agent", explore(), None), ex)
            .file(log, &log_of(&[70_000, 1000, 1100, 1200, 1300, 1400, 1500, 1600, 1700, 1800, 1900, 2000, 2100, 2200, 2300, 2400, 2500, 2600, 2700, 2800])),
        Case::json("near-window-edge-counts", spawn_payload("Agent", explore(), None), ex).file(log, &log_of(&[59_000; 20])),
        Case::json("garbage-lines", spawn_payload("Agent", explore(), None), ex).file(log, "abc\n{NOW-1000}abc\n\n-5\n0\n+{NOW-500}\n 12 \n0x10\n1e3\n"),
        Case::json("crlf-log", spawn_payload("Agent", explore(), None), ex).file(log, "{NOW-1000}\r\n{NOW-900}\r\n"),
        Case::json("only-whitespace-log", spawn_payload("Agent", explore(), None), ex).file(log, "  \n\t\n"),
        Case::json("no-trailing-newline", spawn_payload("Agent", explore(), None), ex).file(log, "{NOW-1000}"),
        Case::json("log-is-a-directory", spawn_payload("Agent", explore(), None), ex).file(".anti-hall/swarm-spawns.log/keep", "x"),
        Case::json("huge-entry-defers", spawn_payload("Agent", explore(), None), Expect::Defer).file(log, "99999999999999999999\n"),
        Case::json("huge-entry-but-capped-blocks", spawn_payload("Agent", explore(), None), ex)
            .file(log, &format!("99999999999999999999\n{}", log_of(&recent(19)))),
        Case::json("skip-file", spawn_payload("Agent", explore(), None), ex)
            .file(".anti-hall/skip.json", r#"{"swarm-guard":99999999999999}"#)
            .file(log, &log_of(&recent(25))),
        Case::json("skip-all", spawn_payload("Agent", explore(), None), ex)
            .file(".anti-hall/skip.json", r#"{"all":99999999999999}"#)
            .file(log, &log_of(&recent(25))),
        Case::json("skip-expired-still-blocks", spawn_payload("Agent", explore(), None), ex)
            .file(".anti-hall/skip.json", r#"{"swarm-guard":5}"#)
            .file(log, &log_of(&recent(25))),
        Case::json("switch-off-env", spawn_payload("Agent", explore(), None), ex).env("ANTIHALL_SWARM_GUARD", "0").file(log, &log_of(&recent(25))),
        Case::json("switch-off-settings", spawn_payload("Agent", explore(), None), ex)
            .file(".anti-hall/settings.json", r#"{"safety":{"swarmGuard":false}}"#)
            .file(log, &log_of(&recent(25))),
        Case::json("switch-off-plugin-option", spawn_payload("Agent", explore(), None), ex)
            .env("CLAUDE_PLUGIN_OPTION_SAFETY_SWARM_GUARD", "false")
            .file(log, &log_of(&recent(25))),
        Case::json("switch-plugin-option-default-ignored", spawn_payload("Agent", explore(), None), ex)
            .env("CLAUDE_PLUGIN_OPTION_SAFETY_SWARM_GUARD", "true")
            .file(log, &log_of(&recent(25))),
        Case::json("switch-garbage-stays-on", spawn_payload("Agent", explore(), None), ex)
            .file(".anti-hall/settings.json", r#"{"safety":{"swarmGuard":"maybe"}}"#)
            .file(log, &log_of(&recent(25))),
        // the lock
        Case::json("fresh-foreign-lock-fails-open-unrecorded", spawn_payload("Agent", explore(), None), ex)
            .file(lock, &fresh_lock(100))
            .file(log, &log_of(&recent(25))),
        Case::json("stale-lock-is-taken-over", spawn_payload("Agent", explore(), None), ex).file(lock, &fresh_lock(9000)),
        Case::json("stale-lock-then-block", spawn_payload("Agent", explore(), None), ex).file(lock, &fresh_lock(9000)).file(log, &log_of(&recent(21))),
        Case::json("corrupt-fresh-lock-fails-open", spawn_payload("Agent", explore(), None), ex).file(lock, "{torn"),
        Case::json("empty-fresh-lock-fails-open", spawn_payload("Agent", explore(), None), ex).file(lock, ""),
        Case::json("stale-lock-with-stale-reclaim-marker", spawn_payload("Agent", explore(), None), ex)
            .file(lock, &fresh_lock(9000))
            .file(".anti-hall/swarm-spawns.lock.reclaim", &fresh_lock(9000)),
        Case::json("stale-lock-with-fresh-reclaim-marker", spawn_payload("Agent", explore(), None), ex)
            .file(lock, &fresh_lock(9000))
            .file(".anti-hall/swarm-spawns.lock.reclaim", &fresh_lock(100)),
        Case::json("lock-without-ts-record", spawn_payload("Agent", explore(), None), ex).file(lock, r#"{"pid":1,"token":"x"}"#),
        // the advisory (needs the transcript scan, so the engine defers whenever it could be due)
        Case::json("general-with-transcript-missing-transcript-silent", spawn_payload("Agent", general(), Some("/t.jsonl")), ex),
        Case::json("task-general-with-transcript-missing-transcript-silent", spawn_payload("Task", general(), Some("/t.jsonl")), ex),
        Case::json("no-type-with-transcript-missing-transcript-silent", spawn_payload("Agent", json!({"prompt":"x"}), Some("/t.jsonl")), ex),
        Case::json("input-array-with-transcript-missing-transcript-silent", spawn_payload("Agent", json!(["x"]), Some("/t.jsonl")), ex),
        Case::json("tools-with-edit-missing-transcript-silent", spawn_payload("Agent", json!({"tools":["Read","Edit"]}), Some("/t.jsonl")), ex),
        Case::json("nested-tools-missing-transcript-silent", spawn_payload("Agent", json!({"tools":[["Edit"]]}), Some("/t.jsonl")), ex),
        Case::json("general-with-transcript-at-cap-still-blocks", spawn_payload("Agent", general(), Some("/t.jsonl")), ex).file(log, &log_of(&recent(20))),
        Case::json("isolated-worktree-silent", spawn_payload("Agent", json!({"subagent_type":"general-purpose","isolation":"Worktree"}), Some("/t.jsonl")), ex),
        Case::json("isolated-remote-silent", spawn_payload("Agent", json!({"isolation":" remote "}), Some("/t.jsonl")), ex),
        Case::json("isolation-other-missing-transcript-silent", spawn_payload("Agent", json!({"isolation":"none"}), Some("/t.jsonl")), ex),
        Case::json("read-only-allowlist-silent", spawn_payload("Agent", json!({"tools":"Read, Grep"}), Some("/t.jsonl")), ex),
        Case::json("empty-allowlist-silent", spawn_payload("Agent", json!({"tools":[]}), Some("/t.jsonl")), ex),
        Case::json("camel-allowlist-silent", spawn_payload("Agent", json!({"allowedTools":["Read"]}), Some("/t.jsonl")), ex),
        Case::json("deny-all-writes-silent", spawn_payload("Agent", json!({"disallowedTools":["Edit","Write","MultiEdit"]}), Some("/t.jsonl")), ex),
        Case::json("deny-some-writes-missing-transcript-silent", spawn_payload("Agent", json!({"disallowedTools":["Edit","Write"]}), Some("/t.jsonl")), ex),
        Case::json("omc-read-only-type-silent", spawn_payload("Agent", json!({"subagent_type":"oh-my-claudecode:Verifier"}), Some("/t.jsonl")), ex),
        Case::json("shared-tree-switch-off-silent", spawn_payload("Agent", general(), Some("/t.jsonl")), ex)
            .file(".anti-hall/settings.json", r#"{"guards":{"sharedTreeAgentNote":false}}"#),
        Case::json("shared-tree-env-off-silent", spawn_payload("Agent", general(), Some("/t.jsonl")), ex).env("ANTIHALL_SHARED_TREE_AGENT_NOTE", "off"),
        Case::json("transcript-empty-silent", spawn_payload("Agent", general(), Some("")), ex),
        Case::json(
            "transcript-number-silent",
            {
                let mut p = spawn_payload("Agent", general(), None);
                p["transcript_path"] = json!(5);
                p
            },
            ex,
        ),
        Case::json("tool-input-missing-silent", json!({"tool_name":"Agent","transcript_path":"/t"}), ex),
        Case::json("tool-input-string-silent", spawn_payload("Agent", json!("x"), Some("/t")), ex),
        Case::json("tool-input-null-silent", spawn_payload("Agent", Value::Null, Some("/t")), ex),
        // payload shapes and trip-log labels
        Case::json("label-camel-agent-type-at-cap", spawn_payload("Agent", json!({"agentType":"ünï","prompt":"x"}), None), ex).file(log, &log_of(&recent(20))),
        Case::json("label-snake-agent-type-at-cap", spawn_payload("Task", json!({"agent_type":"snake"}), None), ex).file(log, &log_of(&recent(20))),
        Case::json("label-empty-type-at-cap", spawn_payload("Task", json!({"subagent_type":"","agentType":"second"}), None), ex)
            .file(log, &log_of(&recent(20))),
        Case::json("label-no-tool-name-at-cap", json!({"tool_input":{"subagent_type":"x"}}), ex).file(log, &log_of(&recent(20))),
        Case::json("label-numeric-type-at-cap", spawn_payload("Agent", json!({"subagent_type":5}), None), ex).file(log, &log_of(&recent(20))),
        Case::json("payload-array", json!([1]), ex),
        Case::new("payload-null", "null", ex),
        Case::new("payload-number-at-cap", "7", ex).file(log, &log_of(&recent(20))),
        Case::new("payload-empty-stdin", "", Expect::Defer),
        Case::new("payload-garbage", "{nope", Expect::Defer),
    ];
    // a pre-existing trip log keeps its lines and gets one appended
    out.extend(shared_tree_cases());
    out.push(
        Case::json("trip-log-appends", spawn_payload("Agent", explore(), None), ex)
            .file(log, &log_of(&recent(20)))
            .file(".anti-hall/swarm-trips.log", "old\tline\n"),
    );
    out
}

#[test]
fn swarm_guard_matches_node() {
    let rows = swarm_cases();
    assert!(rows.len() >= 50, "need at least 50 rows, got {}", rows.len());
    // the same rows drive both tools: `swarm-guard.js` is registered for Agent and for Task
    let (same, deferred) = check_rows("swarm-guard.js", "swarm-guard", rows);
    assert!(same >= 70 && deferred >= 3);
}

// ---- jev-weekly-scorecard ------------------------------------------------------------------------------------

fn session_start() -> Value {
    json!({"hook_event_name":"SessionStart","session_id":"s","cwd":"/tmp","source":"startup"})
}

const DAY: u64 = 86_400_000;

fn weekly_cases() -> Vec<Case> {
    let ex = Expect::Same;
    let df = Expect::Defer;
    let on = |c: Case| c.file(".anti-hall/settings.json", r#"{"jev":{"enabled":true}}"#);
    let latch = |age: u64| format!(r#"{{"lastCheckedTs":{{NOW-{age}}}}}"#);
    let l = ".anti-hall/state/jev-weekly-notice.json";
    const LOG: &str = ".anti-hall/logs/jev-assist.ndjson";
    vec![
        Case::json("jev-off-by-default", session_start(), ex),
        Case::json("jev-off-explicit", session_start(), ex).file(".anti-hall/settings.json", r#"{"jev":{"enabled":false}}"#),
        on(Case::json("on-no-latch-stamps", session_start(), ex)),
        on(Case::json("on-latch-yesterday-silent", session_start(), ex).file(l, &latch(DAY))),
        on(Case::json("on-latch-six-days-silent", session_start(), ex).file(l, &latch(6 * DAY))),
        on(Case::json("on-latch-eight-days-stamps", session_start(), ex).file(l, &latch(8 * DAY))),
        on(Case::json("on-latch-in-the-future-silent", session_start(), ex)
            .file(l, r#"{"lastCheckedTs":{NOW}0}"#.replace("{NOW}0", "99999999999999").as_str())),
        on(Case::json("on-latch-garbage-stamps", session_start(), ex).file(l, "{torn")),
        on(Case::json("on-latch-string-ts-stamps", session_start(), ex).file(l, r#"{"lastCheckedTs":"x"}"#)),
        on(Case::json("on-latch-array-stamps", session_start(), ex).file(l, "[1]")),
        on(Case::json("on-latch-null-stamps", session_start(), ex).file(l, "null")),
        Case::json("on-by-env", session_start(), ex).env("ANTIHALL_JEV", "1"),
        Case::json("env-off-beats-settings-on", session_start(), ex).env("ANTIHALL_JEV", "0").file(".anti-hall/settings.json", r#"{"jev":{"enabled":true}}"#),
        Case::json("on-by-legacy-file", session_start(), ex).file(".anti-hall/jev.json", r#"{"enabled":true}"#),
        Case::json("on-by-legacy-file-string", session_start(), ex).file(".anti-hall/jev.json", r#"{"enabled":"yes"}"#),
        Case::json("legacy-file-off", session_start(), ex).file(".anti-hall/jev.json", r#"{"enabled":false}"#),
        Case::json("legacy-file-corrupt", session_start(), ex).file(".anti-hall/jev.json", "{torn"),
        Case::json("settings-off-beats-legacy-on", session_start(), ex)
            .file(".anti-hall/jev.json", r#"{"enabled":true}"#)
            .file(".anti-hall/settings.json", r#"{"jev":{"enabled":false}}"#),
        Case::json("on-by-plugin-option", session_start(), ex).env("CLAUDE_PLUGIN_OPTION_JEV_ENABLED", "true"),
        Case::json("plugin-option-default-ignored", session_start(), ex).env("CLAUDE_PLUGIN_OPTION_JEV_ENABLED", "false"),
        Case::json("plugin-option-default-never-masks-legacy-on", session_start(), ex)
            .file(".anti-hall/jev.json", r#"{"enabled":true}"#)
            .env("CLAUDE_PLUGIN_OPTION_JEV_ENABLED", "false"),
        Case::json("unstamped-legacy-off-beats-plugin-option-on", session_start(), ex)
            .file(".anti-hall/jev.json", r#"{"enabled":false}"#)
            .env("CLAUDE_PLUGIN_OPTION_JEV_ENABLED", "true"),
        Case::json("stamped-plugin-option-on-beats-legacy-off", session_start(), ex)
            .file(".anti-hall/jev.json", r#"{"enabled":false}"#)
            .file(".anti-hall/update-sweep-state.json", r#"{"migrateSettingsFromLegacy":{"completedVersion":"{V}"}}"#)
            .env("CLAUDE_PLUGIN_OPTION_JEV_ENABLED", "true"),
        Case::json("stamped-at-other-version-still-legacy-first", session_start(), ex)
            .file(".anti-hall/jev.json", r#"{"enabled":false}"#)
            .file(".anti-hall/update-sweep-state.json", r#"{"migrateSettingsFromLegacy":{"completedVersion":"0.0.1"}}"#)
            .env("CLAUDE_PLUGIN_OPTION_JEV_ENABLED", "true"),
        Case::json("notice-off-settings", session_start(), ex).file(".anti-hall/settings.json", r#"{"jev":{"enabled":true,"weeklyNotice":false}}"#),
        on(Case::json("notice-off-legacy-file", session_start(), ex).file(".anti-hall/jev.json", r#"{"weeklyNotice":false}"#)),
        on(Case::json("notice-off-plugin-option", session_start(), ex).env("CLAUDE_PLUGIN_OPTION_JEV_WEEKLY_NOTICE", "false")),
        on(Case::json("notice-garbage-stays-on", session_start(), ex).file(".anti-hall/jev.json", r#"{"weeklyNotice":"maybe"}"#)),
        on(Case::json("child-workspace-silent", session_start(), ex).env("DEVSWARM_SOURCE_BRANCH", "feature/x")),
        on(Case::json("child-env-blank-stamps", session_start(), ex).env("DEVSWARM_SOURCE_BRANCH", "   ")),
        on(Case::json("judge-child-silent", session_start(), ex).env("ANTIHALL_JUDGE_CHILD", "1")),
        on(Case::json("judge-child-other-value-stamps", session_start(), ex).env("ANTIHALL_JUDGE_CHILD", "0")),
        // the decision log the weekly report reads (jev-assist.js retainedLogFiles + readNdjsonFiles)
        on(Case::json("log-empty-file-stamps", session_start(), ex).file(LOG, "")),
        on(Case::json("log-blank-lines-stamps", session_start(), ex).file(LOG, "\n  \n\t\r\n")),
        on(Case::json("log-blank-generations-stamps", session_start(), ex).file(&format!("{LOG}.1"), "\n").file(&format!("{LOG}.12"), " ")),
        on(Case::json("log-is-a-directory-stamps", session_start(), ex).file(&format!("{LOG}/x"), "{\"id\":\"speculation\"}")),
        on(Case::json("log-non-generation-names-ignored", session_start(), ex)
            .file(&format!("{LOG}.bak"), "{\"id\":\"speculation\"}\n")
            .file(&format!("{LOG}.1x"), "{\"id\":\"speculation\"}\n")
            .file(&format!("{LOG}."), "{\"id\":\"speculation\"}\n")
            .file(".anti-hall/logs/jev-triage.ndjson", "{\"hash\":\"h\",\"backend\":\"jev\"}\n")),
        on(Case::json("log-row-defers", session_start(), df).acts().file(LOG, "{\"id\":\"speculation\",\"ts\":\"2020-01-01\"}\n")),
        on(Case::json("log-row-in-generation-defers", session_start(), df).acts().file(&format!("{LOG}.3"), "{\"id\":\"speculation\"}\n")),
        on(Case::json("log-garbage-line-defers", session_start(), df).acts().file(LOG, "{torn\n")),
        on(Case::json("log-row-but-latch-recent-silent", session_start(), ex).file(l, &latch(DAY)).file(LOG, "{\"id\":\"speculation\"}\n")),
        on(Case::json("state-dir-is-a-file-silent", session_start(), ex).file(".anti-hall/state", "x")),
        on(Case::json("latch-fractional-old-stamps", session_start(), ex).file(l, r#"{"lastCheckedTs":5.5}"#)),
        on(Case::json("latch-huge-number-stamps", session_start(), ex).file(l, r#"{"lastCheckedTs":1e400}"#)),
        on(Case::new("empty-stdin-defers", "", df)),
        on(Case::new("garbage-stdin-defers", "{nope", df)),
        on(Case::new("payload-null-stamps", "null", ex)),
        on(Case::json("payload-other-event-name", json!({"hook_event_name":"Other"}), ex)),
    ]
}

#[test]
fn jev_weekly_scorecard_matches_node() {
    let rows = weekly_cases();
    assert!(rows.len() >= 50, "need at least 50 rows, got {}", rows.len());
    let (same, deferred) = check_rows("jev-weekly-scorecard.js", "jev-weekly-scorecard", rows);
    assert!(same >= 40 && deferred >= 5);
}

// ---- jev-review-reminder -------------------------------------------------------------------------------------

fn review_cases() -> Vec<Case> {
    let ex = Expect::Same;
    let df = Expect::Defer;
    let l = ".anti-hall/state/jev-recommend-notice.json";
    let shown = |age: u64| format!(r#"{{"lastShownTs":{{NOW-{age}}}}}"#);
    let sub = |k: &str, v: Value| {
        let mut p = session_start();
        p[k] = v;
        p
    };
    vec![
        Case::json("first-run-recommend-due", session_start(), ex),
        Case::json("shown-yesterday-silent", session_start(), ex).file(l, &shown(DAY)),
        Case::json("shown-29-days-silent", session_start(), ex).file(l, &shown(29 * DAY)),
        Case::json("shown-31-days-due", session_start(), ex).file(l, &shown(31 * DAY)),
        Case::json("shown-in-the-future-due", session_start(), ex).file(l, r#"{"lastShownTs":99999999999999}"#),
        Case::json("latch-zero-due", session_start(), ex).file(l, r#"{"lastShownTs":0}"#),
        Case::json("latch-garbage-due", session_start(), ex).file(l, "{torn"),
        Case::json("latch-string-due", session_start(), ex).file(l, r#"{"lastShownTs":"x"}"#),
        Case::json("recommend-off-settings", session_start(), ex).file(".anti-hall/settings.json", r#"{"jev":{"recommendNotice":false}}"#),
        Case::json("recommend-off-env", session_start(), ex).env("ANTIHALL_JEV_RECOMMEND_NOTICE", "off"),
        Case::json("recommend-off-plugin-option", session_start(), ex).env("CLAUDE_PLUGIN_OPTION_JEV_RECOMMEND_NOTICE", "false"),
        Case::json("recommend-garbage-stays-on", session_start(), ex).file(".anti-hall/settings.json", r#"{"jev":{"recommendNotice":"perhaps"}}"#),
        Case::json("jev-on-defers", session_start(), df).file(".anti-hall/settings.json", r#"{"jev":{"enabled":true}}"#),
        Case::json("jev-on-legacy-defers", session_start(), df).file(".anti-hall/jev.json", r#"{"enabled":true}"#),
        Case::json("jev-on-env-defers", session_start(), df).env("ANTIHALL_JEV", "1"),
        Case::json("jev-on-but-recent-latch-still-defers", session_start(), df).env("ANTIHALL_JEV", "1").file(l, &shown(DAY)),
        Case::json("semantic-judge-on-defers", session_start(), df).file(".anti-hall/settings.json", r#"{"jev":{"semanticJudge":true}}"#).file(l, &shown(DAY)),
        Case::json("semantic-judge-env-defers", session_start(), df).env("ANTIHALL_SEMANTIC_JUDGE", "1").file(l, &shown(DAY)),
        Case::json("jev-explicitly-off-recent-latch-silent", session_start(), ex)
            .file(".anti-hall/settings.json", r#"{"jev":{"enabled":false}}"#)
            .file(l, &shown(DAY)),
        Case::json("subagent-agent-id", sub("agent_id", json!("a1")), ex),
        Case::json("subagent-agent-type", sub("agent_type", json!("Explore")), ex),
        Case::json("subagent-sidechain", sub("isSidechain", json!(true)), ex),
        Case::json("subagent-sidechain-snake", sub("is_sidechain", json!(true)), ex),
        Case::json("sidechain-string-is-not-subagent", sub("isSidechain", json!("true")), ex),
        Case::json("agent-id-empty-string-is-not-subagent", sub("agent_id", json!("")), ex),
        Case::json("agent-id-null-is-not-subagent", sub("agent_id", Value::Null), ex),
        Case::json("agent-id-zero-is-not-subagent", sub("agent_id", json!(0)), ex),
        Case::json("headless-recent-latch-silent", session_start(), ex).env("CLAUDE_CODE_ENTRYPOINT", "sdk-cli").file(l, &shown(DAY)),
        Case::json("headless-model-only-is-not-codex", sub("model", json!("gpt-5")), ex).env("CLAUDE_CODE_ENTRYPOINT", "sdk-cli").file(l, &shown(DAY)),
        Case::json(
            "headless-codex-recent-latch-silent",
            sub("model", json!("gpt-5"))
                .as_object()
                .map(|o| {
                    let mut o = o.clone();
                    o.insert("turn_id".into(), json!("t1"));
                    Value::Object(o)
                })
                .unwrap(),
            ex,
        )
        .env("CLAUDE_CODE_ENTRYPOINT", "sdk-cli")
        .file(l, &shown(DAY)),
        Case::json("interactive-entrypoint-recent-latch-silent", session_start(), ex).env("CLAUDE_CODE_ENTRYPOINT", "cli").file(l, &shown(DAY)),
        Case::json("judge-child-silent", session_start(), ex).env("ANTIHALL_JUDGE_CHILD", "1"),
        // the recommend notice in a non-interactive run (jev-recommend.js isHeadless / headlessAllowed)
        Case::json("headless-first-run-silent-no-latch", session_start(), ex).env("CLAUDE_CODE_ENTRYPOINT", "sdk-cli"),
        Case::json("headless-sdk-ts-silent", session_start(), ex).env("CLAUDE_CODE_ENTRYPOINT", "sdk-ts"),
        Case::json("entrypoint-sdk-without-dash-is-interactive", session_start(), ex).env("CLAUDE_CODE_ENTRYPOINT", "sdk"),
        Case::json("headless-allowed-by-env", session_start(), ex).env("CLAUDE_CODE_ENTRYPOINT", "sdk-cli").env("ANTIHALL_JEV_NOTICE_HEADLESS", "1"),
        Case::json("headless-allowed-by-settings", session_start(), ex)
            .env("CLAUDE_CODE_ENTRYPOINT", "sdk-cli")
            .file(".anti-hall/settings.json", r#"{"jev":{"recommendNoticeHeadless":true}}"#),
        Case::json("headless-garbage-setting-is-unset", session_start(), ex)
            .env("CLAUDE_CODE_ENTRYPOINT", "sdk-cli")
            .env("ANTIHALL_JEV_NOTICE_HEADLESS", "maybe"),
        Case::json("headless-protocol-full-allows", session_start(), ex).env("CLAUDE_CODE_ENTRYPOINT", "sdk-cli").env("ANTIHALL_PROTOCOL_LEVEL", "full"),
        Case::json("headless-protocol-full-in-settings-allows", session_start(), ex)
            .env("CLAUDE_CODE_ENTRYPOINT", "sdk-cli")
            .file(".anti-hall/settings.json", r#"{"context":{"protocolLevel":" FULL "}}"#),
        Case::json("headless-protocol-full-but-explicit-off-silent", session_start(), ex)
            .env("CLAUDE_CODE_ENTRYPOINT", "sdk-cli")
            .env("ANTIHALL_PROTOCOL_LEVEL", "full")
            .file(".anti-hall/settings.json", r#"{"jev":{"recommendNoticeHeadless":false}}"#),
        Case::json("headless-protocol-compact-silent", session_start(), ex).env("CLAUDE_CODE_ENTRYPOINT", "sdk-cli").env("ANTIHALL_PROTOCOL_LEVEL", "compact"),
        Case::json("headless-allowed-but-recent-latch-silent", session_start(), ex)
            .env("CLAUDE_CODE_ENTRYPOINT", "sdk-cli")
            .env("ANTIHALL_JEV_NOTICE_HEADLESS", "true")
            .file(l, &shown(DAY)),
        Case::json(
            "headless-codex-first-run-shows",
            sub("model", json!("gpt-5"))
                .as_object()
                .map(|o| {
                    let mut o = o.clone();
                    o.insert("turn_id".into(), json!("t1"));
                    Value::Object(o)
                })
                .unwrap(),
            ex,
        )
        .env("CLAUDE_CODE_ENTRYPOINT", "sdk-cli"),
        Case::json("codex-apply-patch-payload-shows", sub("tool_name", json!("apply_patch")), ex).env("CLAUDE_CODE_ENTRYPOINT", "sdk-cli"),
        // the event name the notice carries, and the latch write
        Case::json("event-name-echoed", sub("hook_event_name", json!("Other")), ex),
        Case::json("event-name-empty-defaults", sub("hook_event_name", json!("")), ex),
        Case::json("event-name-not-a-string-defaults", sub("hook_event_name", json!(7)), ex),
        Case::json("no-event-name-defaults", json!({"session_id":"s"}), ex),
        Case::json("latch-fractional-recent-silent", session_start(), ex).file(l, r#"{"lastShownTs":{NOW-1000}.5}"#),
        Case::json("latch-array-due", session_start(), ex).file(l, "[1]"),
        Case::json("latch-null-due", session_start(), ex).file(l, "null"),
        Case::json("latch-huge-number-due", session_start(), ex).file(l, r#"{"lastShownTs":1e400}"#),
        Case::json("latch-negative-due", session_start(), ex).file(l, r#"{"lastShownTs":-5}"#),
        Case::json("latch-other-keys-kept-out", session_start(), ex).file(l, r#"{"lastShownTs":5,"extra":1}"#),
        Case::json("state-dir-is-a-file-silent", session_start(), ex).file(".anti-hall/state", "x"),
        Case::json("recommend-on-explicit-shows", session_start(), ex).file(".anti-hall/settings.json", r#"{"jev":{"recommendNotice":true,"enabled":false}}"#),
        Case::json("jev-off-env-shows", session_start(), ex).env("ANTIHALL_JEV", "0"),
        Case::json("legacy-jev-off-shows", session_start(), ex).file(".anti-hall/jev.json", r#"{"enabled":false}"#),
        Case::json("judge-off-env-shows", session_start(), ex).env("ANTIHALL_SEMANTIC_JUDGE", "0"),
        Case::new("empty-stdin-defers", "", df),
        Case::new("garbage-stdin-defers", "{nope", df),
        Case::new("payload-null", "null", ex),
        Case::json("payload-array", json!([1]), ex),
    ]
}

#[test]
fn jev_review_reminder_matches_node() {
    let rows = review_cases();
    assert!(rows.len() >= 50, "need at least 50 rows, got {}", rows.len());
    let (same, deferred) = check_rows("jev-review-reminder.js", "jev-review-reminder", rows);
    assert!(same >= 55 && deferred >= 7);
}

// ---- repair-on-reload ----------------------------------------------------------------------------------------

const MIGRATION_KEYS: [&str; 11] = [
    "mergeSplitBackendStores",
    "foldAllStores",
    "healOrphanPartitions",
    "foldArchivedRows",
    "foldArchivedFamilyDescriptors",
    "repairReaderFloors",
    "reconcileDualPartitionAcks",
    "markAppArchived",
    "retireStaleArchivedMarkers",
    "repairChildSenderLabels",
    "foldReadReceipts",
];

fn markers(version_for: impl Fn(&str) -> Option<String>) -> String {
    let mut o = serde_json::Map::new();
    for k in MIGRATION_KEYS {
        if let Some(v) = version_for(k) {
            o.insert(k.into(), json!({"completedVersion": v}));
        }
    }
    Value::Object(o).to_string()
}

fn prompt_submit() -> Value {
    json!({"hook_event_name":"UserPromptSubmit","session_id":"s","cwd":"/tmp","prompt":"hello"})
}

fn repair_cases() -> Vec<Case> {
    let ex = Expect::Same;
    let df = Expect::Defer;
    let m = ".anti-hall/update-sweep-state.json";
    let done = markers(|_| Some("{V}".into()));
    let cool = ".anti-hall/repair-on-reload.last.json";
    let recent = r#"{"ts":{NOW-1000},"version":"{V}"}"#;
    let mut rows = vec![
        Case::json("all-stamped-session-start", session_start(), ex).file(m, &done),
        Case::json("all-stamped-prompt", prompt_submit(), ex).file(m, &done),
        Case::json("all-stamped-newer", prompt_submit(), ex).file(m, &markers(|_| Some("99.0.0".into()))),
        Case::json("all-stamped-equal-version-leading-zero", prompt_submit(), ex).file(m, &markers(|_| Some("00099.00.0".into()))),
        Case::json("empty-home-pending", prompt_submit(), df).skip_node(),
        Case::json("stamped-older-pending", prompt_submit(), df).skip_node().file(m, &markers(|_| Some("0.0.1".into()))),
        Case::json("one-key-missing-pending", prompt_submit(), df).skip_node().file(m, &markers(|k| (k != "foldReadReceipts").then(|| "99.0.0".into()))),
        Case::json("one-key-garbage-version-pending", prompt_submit(), df)
            .skip_node()
            .file(m, &markers(|k| Some(if k == "foldAllStores" { "abc".into() } else { "99.0.0".into() }))),
        Case::json("one-key-prerelease-version-pending", prompt_submit(), df)
            .skip_node()
            .file(m, &markers(|k| Some(if k == "foldAllStores" { "99.0.0-rc.1".into() } else { "99.0.0".into() }))),
        Case::json("markers-corrupt-pending", prompt_submit(), df).skip_node().file(m, "{torn"),
        Case::json("markers-array-pending", prompt_submit(), df).skip_node().file(m, "[]"),
        Case::json("markers-entry-not-object-pending", prompt_submit(), df).skip_node().file(m, r#"{"foldAllStores":5}"#),
        Case::json("extra-key-ignored", prompt_submit(), ex)
            .file(m, &markers(|_| Some("99.0.0".into())).replacen('{', r#"{"someOtherMigration":{"completedVersion":"0.0.1"},"#, 1)),
        // cooldown
        Case::json("cooldown-recent-silences-pending", prompt_submit(), ex).file(cool, recent),
        Case::json("cooldown-other-version-pending", prompt_submit(), df).skip_node().file(cool, r#"{"ts":{NOW-1000},"version":"0.0.1"}"#),
        Case::json("cooldown-two-hours-old-pending", prompt_submit(), df).skip_node().file(cool, r#"{"ts":{NOW-7200000},"version":"{V}"}"#),
        Case::json("cooldown-in-the-future-pending", prompt_submit(), df).skip_node().file(cool, r#"{"ts":99999999999999,"version":"{V}"}"#),
        Case::json("cooldown-string-ts-pending", prompt_submit(), df).skip_node().file(cool, r#"{"ts":"x","version":"{V}"}"#),
        Case::json("cooldown-garbage-pending", prompt_submit(), df).skip_node().file(cool, "{torn"),
        Case::json("cooldown-array-pending", prompt_submit(), df).skip_node().file(cool, "[1]"),
        // the lock: whether Node skips (a live holder) or steals and spawns is Node's to judge
        Case::json("lock-held-pending", prompt_submit(), df).skip_node().file(".anti-hall/repair-on-reload.lock", r#"{"pid":1,"ts":{NOW}}"#),
        // switches, skip, payload
        Case::json("switch-off-env", prompt_submit(), ex).env("ANTIHALL_REPAIR_ON_RELOAD", "off"),
        Case::json("switch-off-env-zero", prompt_submit(), ex).env("ANTIHALL_REPAIR_ON_RELOAD", "0"),
        Case::json("switch-off-settings", prompt_submit(), ex).file(".anti-hall/settings.json", r#"{"maintenance":{"repairOnReload":false}}"#),
        Case::json("switch-off-plugin-option", prompt_submit(), ex).env("CLAUDE_PLUGIN_OPTION_MAINTENANCE_REPAIR_ON_RELOAD", "false"),
        Case::json("switch-garbage-stays-on", prompt_submit(), df)
            .skip_node()
            .file(".anti-hall/settings.json", r#"{"maintenance":{"repairOnReload":"maybe"}}"#),
        Case::json("skip-file", prompt_submit(), ex).file(".anti-hall/skip.json", r#"{"repair-on-reload":99999999999999}"#),
        Case::json("skip-all", prompt_submit(), ex).file(".anti-hall/skip.json", r#"{"all":99999999999999}"#),
        Case::json("skip-expired-pending", prompt_submit(), df).skip_node().file(".anti-hall/skip.json", r#"{"repair-on-reload":5}"#),
        Case::json(
            "subagent-agent-id",
            {
                let mut p = prompt_submit();
                p["agent_id"] = json!("a1");
                p
            },
            ex,
        ),
        Case::json(
            "subagent-agent-type",
            {
                let mut p = prompt_submit();
                p["agent_type"] = json!("Explore");
                p
            },
            ex,
        ),
        Case::json(
            "subagent-empty-string-marker-still-subagent",
            {
                let mut p = prompt_submit();
                p["agent_id"] = json!("");
                p
            },
            ex,
        ),
        Case::json(
            "subagent-zero-marker-still-subagent",
            {
                let mut p = prompt_submit();
                p["agent_type"] = json!(0);
                p
            },
            ex,
        ),
        Case::json(
            "null-marker-is-not-subagent",
            {
                let mut p = prompt_submit();
                p["agent_id"] = Value::Null;
                p
            },
            df,
        )
        .skip_node(),
        Case::json("judge-child-silent", prompt_submit(), ex).env("ANTIHALL_JUDGE_CHILD", "1"),
        Case::new("empty-stdin-all-stamped-defers", "", df).file(m, &done),
        Case::new("garbage-stdin-all-stamped-defers", "{nope", df).file(m, &done),
        Case::new("payload-null-all-stamped", "null", ex).file(m, &done),
        Case::json("payload-array-all-stamped", json!([1]), ex).file(m, &done),
    ];
    rows.push(Case::json("codex-style-payload-all-stamped", json!({"turn_id":"t","model":"gpt-5","hook_event_name":"UserPromptSubmit"}), ex).file(m, &done));
    rows
}

#[test]
fn repair_on_reload_matches_node() {
    let rows = repair_cases();
    assert!(rows.len() >= 50, "need at least 50 rows, got {}", rows.len());
    let (same, deferred) = check_rows("repair-on-reload.js", "repair-on-reload", rows);
    assert!(same >= 15 && deferred >= 12);
}

/// The migration keys the engine lists must be exactly the Node default (non-opt-in) migrations, in order.
#[test]
fn repair_migration_keys_match_the_node_list() {
    let out = Command::new("node")
        .arg("-e")
        .arg("process.stdout.write(JSON.stringify(require('./plugins/anti-hall/companion/lib/migrations.js').defaultMigrations().map(m => m.key)))")
        .current_dir(repo())
        .env("ANTIHALL_TEST_ISOLATION", "1")
        .output()
        .unwrap();
    let node: Vec<String> = serde_json::from_slice(&out.stdout).unwrap();
    let engine: Vec<String> = ah_engine::defaults::list("repair_reload.migration_keys").into_iter().map(String::from).collect();
    assert_eq!(engine, node, "defaults/session_gates.toml repair_reload.migration_keys drifted from companion/lib/migrations.js");
    assert_eq!(engine, MIGRATION_KEYS.map(String::from).to_vec());
}

/// The engine's lock file and Node's `companion/lib/lock.js` honour each other: a lock one holds is respected by the other,
/// and a lock one released can be taken by the other.
#[test]
fn the_engine_and_node_respect_each_others_swarm_lock() {
    let _serial = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
    let home = temp_home("lock");
    let lock = home.join(".anti-hall/swarm-spawns.lock");
    let node = |script: &str| Command::new("node").arg("-e").arg(script).arg(&lock).current_dir(repo()).env("ANTIHALL_TEST_ISOLATION", "1").output().unwrap();
    let lib = "const L=require('./plugins/anti-hall/companion/lib/lock.js');const p=process.argv[1];";
    // Node holds, the engine (via a spawn through the check) must not take it: the guard fails open without recording.
    let held =
        node(&format!("{lib}const h=L.acquire(p,{{staleMs:5000,liveStaleMs:5000,maxTries:Infinity,waitMs:50,stepMs:5}});process.stdout.write(h?'held':'no');"));
    assert_eq!(String::from_utf8_lossy(&held.stdout), "held");
    let case = Case::json("spawn", spawn_payload("Agent", json!({"subagent_type":"Explore"}), None), Expect::Same);
    let eng = run_engine("swarm-guard", &home, &case);
    assert_eq!(eng.0, 0);
    assert!(!home.join(".anti-hall/swarm-spawns.log").exists(), "the engine must not record a spawn it could not lock");
    ah_engine::discard::harmless(std::fs::remove_file(&lock));
    let released = node(&format!("{lib}const h=L.acquire(p,{{staleMs:5000}});h.release();process.stdout.write(L.inspect(p)===null?'free':'left');"));
    assert_eq!(String::from_utf8_lossy(&released.stdout), "free");
    let eng2 = run_engine("swarm-guard", &home, &case);
    assert_eq!(eng2.0, 0);
    assert_eq!(std::fs::read_to_string(home.join(".anti-hall/swarm-spawns.log")).unwrap().lines().count(), 1, "a released lock is taken by the engine");
    assert!(!lock.exists(), "the engine releases its lock");
    ah_engine::discard::harmless(std::fs::remove_dir_all(&home));
}
