//! Node-vs-engine parity for the built-in `devswarm-child-gate`, `devswarm-parent-reply-tracker` and `devswarm-child-drain`
//! checks. Every case runs the engine check; where it answers (an allow) the real Node hook must print nothing, exit 0 and
//! leave the isolated home exactly as it was. Where the engine defers, Node decides, so there is nothing to compare: the
//! guard direction is that an engine allow is never a stop Node would have held (D74).
#![allow(clippy::unwrap_used, clippy::expect_used)] // a test crate: a panic is the failure report, and E2 exempts tests
use serde_json::{Value, json};
use std::collections::BTreeMap;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

static HOME_ID: AtomicUsize = AtomicUsize::new(0);

struct Variant {
    name: &'static str,
    env: Vec<(&'static str, &'static str)>,
    settings: Option<&'static str>,
    host_settings: Option<&'static str>,
    skip: Option<String>,
}

fn v(name: &'static str, env: &[(&'static str, &'static str)]) -> Variant {
    Variant { name, env: env.to_vec(), settings: None, host_settings: None, skip: None }
}

fn future_ms() -> u128 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_millis() + 3_600_000
}

const CHILD: [(&str, &str); 3] = [("DEVSWARM_REPO_ID", "r1"), ("DEVSWARM_SOURCE_BRANCH", "feat/x"), ("DEVSWARM_BUILDER_ID", "b-1")];

fn with(extra: &[(&'static str, &'static str)]) -> Vec<(&'static str, &'static str)> {
    let mut e = CHILD.to_vec();
    e.extend_from_slice(extra);
    e
}

/// Environments and files shared by the three hooks, for one hook's skip name and plugin-option variable.
fn variants(guard: &'static str, plugin_env: &'static str) -> Vec<Variant> {
    let mut out = vec![
        v("none", &[]),
        v("repo-only (a Primary)", &[("DEVSWARM_REPO_ID", "r1")]),
        v("child", &CHILD),
        v("source-branch-only", &[("DEVSWARM_SOURCE_BRANCH", "b")]),
        v("source-branch-blank", &[("DEVSWARM_REPO_ID", "r1"), ("DEVSWARM_SOURCE_BRANCH", " \t ")]),
        v("child-kill-1", &with(&[("DISABLE_ANTIHALL_DEVSWARM", "1")])),
        v("child-kill-true", &with(&[("DISABLE_ANTIHALL_DEVSWARM", "true")])),
        v("child-mode-off", &with(&[("ANTIHALL_DEVSWARM_SUPERVISOR", "off")])),
        v("child-mode-ON-padded", &with(&[("ANTIHALL_DEVSWARM_SUPERVISOR", " ON ")])),
        v("child-mode-invalid", &with(&[("ANTIHALL_DEVSWARM_SUPERVISOR", "maybe")])),
        v("source-branch-mode-on", &[("DEVSWARM_SOURCE_BRANCH", "b"), ("ANTIHALL_DEVSWARM_SUPERVISOR", "on")]),
        v("repo-id-blank", &[("DEVSWARM_REPO_ID", "  "), ("DEVSWARM_SOURCE_BRANCH", "b")]),
        v("child-plugin-option-false", &with(&[(plugin_env, "false")])),
        v("child-plugin-option-true", &with(&[(plugin_env, "true")])),
        v("child-plugin-option-garbage", &with(&[(plugin_env, "zzz")])),
        v("child-supervisor-plugin-option-off", &with(&[("CLAUDE_PLUGIN_OPTION_DEVSWARM_SUPERVISOR_MODE", "off")])),
        v("child-supervisor-plugin-option-auto", &with(&[("CLAUDE_PLUGIN_OPTION_DEVSWARM_SUPERVISOR_MODE", "auto")])),
    ];
    for (name, body) in [
        ("child-file-false", r#"{"devswarm":{"childGate":false,"childDrain":false,"parentReplyTracker":false}}"#),
        ("child-file-off-string", r#"{"devswarm":{"childGate":"off","childDrain":"off","parentReplyTracker":"off"}}"#),
        ("child-file-zero", r#"{"devswarm":{"childGate":0,"childDrain":0,"parentReplyTracker":0}}"#),
        ("child-file-maybe", r#"{"devswarm":{"childGate":"maybe","childDrain":"maybe","parentReplyTracker":"maybe"}}"#),
        ("child-file-true", r#"{"devswarm":{"childGate":true,"childDrain":true,"parentReplyTracker":true}}"#),
        ("child-file-corrupt", "{not json"),
        ("child-file-supervisor-off", r#"{"devswarm":{"supervisorMode":"off"}}"#),
        ("child-file-supervisor-on-no-repo", r#"{"devswarm":{"supervisorMode":"on"}}"#),
        ("child-file-supervisor-number", r#"{"devswarm":{"supervisorMode":1}}"#),
    ] {
        let mut x = v(name, &CHILD);
        if name == "child-file-supervisor-on-no-repo" {
            x.env = vec![("DEVSWARM_SOURCE_BRANCH", "b")];
        }
        x.settings = Some(body);
        out.push(x);
    }
    let mut x = v("child-host-option-false", &CHILD);
    x.host_settings =
        Some(r#"{"pluginConfigs":{"anti-hall":{"options":{"devswarm_child_gate":false,"devswarm_child_drain":false,"devswarm_parent_reply_tracker":false}}}}"#);
    out.push(x);
    let mut x = v("child-host-flat-false", &CHILD);
    x.host_settings = Some(
        r#"{"pluginConfigs":{"anti-hall@anti-hall":{"devswarm_child_gate":"false","devswarm_child_drain":"false","devswarm_parent_reply_tracker":"false"}}}"#,
    );
    out.push(x);
    let mut x = v("child-host-supervisor-off", &CHILD);
    x.host_settings = Some(r#"{"pluginConfigs":{"anti-hall":{"options":{"devswarm_supervisor_mode":"off"}}}}"#);
    out.push(x);
    let mut x = v("child-skip-named", &CHILD);
    x.skip = Some(format!("{{\"{guard}\":{}}}", future_ms()));
    out.push(x);
    let mut x = v("child-skip-all", &CHILD);
    x.skip = Some(format!("{{\"all\":{}}}", future_ms()));
    out.push(x);
    let mut x = v("child-skip-expired", &CHILD);
    x.skip = Some(format!("{{\"{guard}\":1,\"all\":1}}"));
    out.push(x);
    let mut x = v("child-skip-string-expiry", &CHILD);
    x.skip = Some(format!("{{\"{guard}\":\"{}\"}}", future_ms()));
    out.push(x);
    let mut x = v("child-skip-corrupt", &CHILD);
    x.skip = Some("[1".into());
    out.push(x);
    out
}

fn run(mut cmd: Command, input: &[u8]) -> (i32, Vec<u8>, Vec<u8>) {
    cmd.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = cmd.spawn().unwrap();
    let mut stdin = child.stdin.take().unwrap();
    let input = input.to_vec();
    let writer = std::thread::spawn(move || stdin.write_all(&input));
    let mut so = child.stdout.take().unwrap();
    let mut se = child.stderr.take().unwrap();
    let ro = std::thread::spawn(move || {
        let mut b = Vec::new();
        so.read_to_end(&mut b).unwrap();
        b
    });
    let re = std::thread::spawn(move || {
        let mut b = Vec::new();
        se.read_to_end(&mut b).unwrap();
        b
    });
    let deadline = Instant::now() + Duration::from_secs(20);
    let status = loop {
        if let Some(s) = child.try_wait().unwrap() {
            break s;
        }
        assert!(Instant::now() < deadline, "child exceeded 20 seconds: {cmd:?}");
        std::thread::sleep(Duration::from_millis(5));
    };
    ah_engine::discard::harmless(writer.join().unwrap());
    (status.code().unwrap_or(-1), ro.join().unwrap(), re.join().unwrap())
}

fn temp_home(tag: &str) -> PathBuf {
    let nonce = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
    let d = std::env::temp_dir().join(format!("ah-dsg-par-{tag}-{}-{nonce}-{}", std::process::id(), HOME_ID.fetch_add(1, Ordering::Relaxed)));
    std::fs::create_dir_all(d.join(".anti-hall")).unwrap();
    std::fs::create_dir_all(d.join(".claude")).unwrap();
    d
}

fn seed(home: &Path, x: &Variant) {
    if let Some(s) = x.settings {
        std::fs::write(home.join(".anti-hall/settings.json"), s).unwrap();
    }
    if let Some(s) = x.host_settings {
        std::fs::write(home.join(".claude/settings.json"), s).unwrap();
    }
    if let Some(s) = &x.skip {
        std::fs::write(home.join(".anti-hall/skip.json"), s).unwrap();
    }
}

fn snapshot(root: &Path) -> BTreeMap<String, Vec<u8>> {
    fn walk(base: &Path, dir: &Path, out: &mut BTreeMap<String, Vec<u8>>) {
        for e in std::fs::read_dir(dir).into_iter().flatten().flatten() {
            let p = e.path();
            let rel = p.strip_prefix(base).unwrap().to_string_lossy().into_owned();
            if p.is_dir() {
                out.insert(format!("{rel}/"), Vec::new());
                walk(base, &p, out);
            } else {
                out.insert(rel, std::fs::read(&p).unwrap_or_default());
            }
        }
    }
    let mut m = BTreeMap::new();
    walk(root, root, &mut m);
    m
}

#[derive(Default)]
struct Tally {
    cases: usize,
    allowed: usize,
    deferred: usize,
}

fn compare(repo: &Path, hook: &str, check: &str, variants: &[Variant], payloads: &[(String, Vec<u8>)]) -> Tally {
    let mut t = Tally::default();
    for x in variants {
        for (pname, input) in payloads {
            t.cases += 1;
            let home = temp_home("c");
            seed(&home, x);
            let mut c = Command::new(env!("CARGO_BIN_EXE_ah-engine"));
            c.arg("check").arg(check).env_clear().env("PATH", std::env::var("PATH").unwrap_or_default());
            c.env("HOME", &home).env("USERPROFILE", &home).env("AH_ENGINE_DIR", home.join("engine")).env("ANTIHALL_TEST_ISOLATION", "1");
            crate::node_parity::support::forward_test_scale(&mut c);
            for (k, val) in &x.env {
                c.env(k, val);
            }
            let (code, out, err) = run(c, input);
            let out = String::from_utf8_lossy(&out).to_string();
            let label = format!("{hook} / {} / {pname}", x.name);
            if out.trim() == "AHFALLBACK" {
                assert_eq!(code, 0, "{label}: a deferral exits 0");
                t.deferred += 1;
                ah_engine::discard::harmless(std::fs::remove_dir_all(&home));
                continue;
            }
            assert!(code == 0 && out.is_empty() && err.is_empty(), "{label}: the engine answered with something other than allow: {code} {out:?} {err:?}");
            t.allowed += 1;
            // The engine allowed: Node must say nothing, exit 0 and touch nothing in the (identically seeded) home.
            let before = snapshot(&home);
            let mut n = Command::new("node");
            n.arg(repo.join("plugins/anti-hall/hooks").join(format!("{hook}.js")))
                .env_clear()
                .env("PATH", std::env::var("PATH").unwrap_or_default())
                .env("HOME", &home)
                .env("USERPROFILE", &home)
                .env("ANTIHALL_TEST_ISOLATION", "1")
                .env("ANTIHALL_INGEST_DRY_RUN", "1")
                .current_dir(&home);
            for (k, val) in &x.env {
                n.env(k, val);
            }
            let (ncode, nout, nerr) = run(n, input);
            assert_eq!(
                (ncode, nout.as_slice(), nerr.as_slice()),
                (0, b"".as_slice(), b"".as_slice()),
                "{label}: the engine allowed but Node answered {ncode} {:?} {:?}",
                String::from_utf8_lossy(&nout),
                String::from_utf8_lossy(&nerr)
            );
            assert_eq!(before, snapshot(&home), "{label}: Node changed state the engine allow skipped");
            ah_engine::discard::harmless(std::fs::remove_dir_all(&home));
        }
    }
    t
}

fn repo() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..")
}

fn raw(name: &str, s: &str) -> (String, Vec<u8>) {
    (name.to_string(), s.as_bytes().to_vec())
}

fn js(name: &str, v: Value) -> (String, Vec<u8>) {
    (name.to_string(), v.to_string().into_bytes())
}

fn stop_payloads() -> Vec<(String, Vec<u8>)> {
    let big = "x".repeat(200_000);
    vec![
        js("stop", json!({"hook_event_name":"Stop","session_id":"s1","stop_hook_active":false,"cwd":"/tmp"})),
        js("stop-active", json!({"hook_event_name":"Stop","session_id":"s1","stop_hook_active":true})),
        js("empty-object", json!({})),
        js("unicode-session", json!({"hook_event_name":"Stop","session_id":"s\u{e9}\u{1F600}\u{2028}","cwd":"/t\u{e9}"})),
        js("huge-transcript-path", json!({"hook_event_name":"Stop","session_id":"s","transcript_path":big})),
        js("no-session-with-transcript", json!({"hook_event_name":"Stop","transcript_path":"/tmp/t.jsonl"})),
        js("number-root", json!(5)),
        js("array-root", json!([1, 2])),
        raw("null", "null"),
        raw("empty-stdin", ""),
        raw("malformed", "{not json"),
        raw("truncated", "{\"hook_event_name\":\"Stop\",\"session_id\":"),
        raw("lone-surrogate", "{\"session_id\":\"\\ud800\"}"),
    ]
}

fn post_payload(tool: &str, command: Value) -> Value {
    json!({"hook_event_name":"PostToolUse","tool_name":tool,"tool_input":{"command":command},"tool_response":{"stdout":"{\"ok\":true,\"action\":\"send\",\"type\":\"direct\",\"toId\":\"w\",\"sent\":true}\n","stderr":""},"session_id":"s1","cwd":"/tmp"})
}

fn bash_payloads() -> Vec<(String, Vec<u8>)> {
    let mut out = Vec::new();
    for (name, c) in [
        ("send", "node ~/.anti-hall/bin/devswarm.js send --to w --message hi"),
        ("send-upper", "NODE DEVSWARM.JS SEND --TO W"),
        ("send-multiline", "CLI=./scripts/devswarm.js\nnode \"$CLI\" send --to w --message-file f"),
        ("send-reversed", "echo send | node devswarm"),
        ("send-underscore", "node devswarm_send.js"),
        ("send-prefixed", "node xdevswarm.js xsend"),
        ("devswarm-only", "node devswarm.js status"),
        ("send-only", "git send-email"),
        ("send-unicode", "node devswarm.js send --to w --message \"h\u{e9}llo \u{1F600}\""),
        ("send-long-s", "node devswarm.js sen\u{17f}"),
        ("read-primary", "node devswarm.js inbox read-primary"),
        ("ls", "ls -la"),
        ("empty", ""),
        ("huge", &"devswarm send ".repeat(20_000)),
    ] {
        out.push(js(&format!("bash-{name}"), post_payload("Bash", json!(c))));
    }
    out.push(js("read-tool-send", post_payload("Read", json!("devswarm send"))));
    out.push(js("command-number", post_payload("Bash", json!(5))));
    out.push(js("command-null", post_payload("Bash", Value::Null)));
    out.push(js("tool-input-string", json!({"tool_name":"Bash","tool_input":"devswarm send"})));
    out.push(js("no-tool-input", json!({"tool_name":"Bash"})));
    out.push(js("no-tool-name", json!({"tool_input":{"command":"devswarm send"}})));
    out.push(js("agent-marker", json!({"tool_name":"Bash","agent_id":"a1","tool_input":{"command":"node devswarm.js send"}})));
    out.push(js("array-root", json!([1])));
    out.push(raw("null", "null"));
    out.push(raw("empty-stdin", ""));
    out.push(raw("malformed", "{not json"));
    out
}

fn report(name: &str, t: &Tally, min_cases: usize) {
    eprintln!("{name}: {} cases, {} engine allows (each compared with Node), {} deferred to Node", t.cases, t.allowed, t.deferred);
    assert!(t.cases >= min_cases, "{name}: corpus too small ({})", t.cases);
    assert!(t.allowed >= 30, "{name}: too few allow cases compared with Node ({})", t.allowed);
    assert!(t.deferred >= 1, "{name}: the corpus must also hold cases the engine defers");
}

#[test]
fn child_gate_allow_is_node_silence_and_a_child_workspace_defers() {
    let vs = variants("devswarm-child-gate", "CLAUDE_PLUGIN_OPTION_DEVSWARM_CHILD_GATE");
    let t = compare(&repo(), "devswarm-child-gate", "devswarm-child-gate", &vs, &stop_payloads());
    report("devswarm-child-gate", &t, 300);
}

#[test]
fn reply_tracker_allow_is_node_silence_and_a_plausible_send_defers() {
    let vs = variants("devswarm-parent-reply-tracker", "CLAUDE_PLUGIN_OPTION_DEVSWARM_PARENT_REPLY_TRACKER");
    let t = compare(&repo(), "devswarm-parent-reply-tracker", "devswarm-parent-reply-tracker", &vs, &bash_payloads());
    report("devswarm-parent-reply-tracker", &t, 300);
}

#[test]
fn child_drain_allow_is_node_silence_and_a_child_workspace_defers() {
    let vs = variants("devswarm-child-drain", "CLAUDE_PLUGIN_OPTION_DEVSWARM_CHILD_DRAIN");
    let t = compare(&repo(), "devswarm-child-drain", "devswarm-child-drain", &vs, &bash_payloads());
    report("devswarm-child-drain", &t, 300);
}

/// A home with a git worktree, a registered child workspace `b-1` and an inbox with two unread messages.
fn child_home(tag: &str) -> PathBuf {
    let home = temp_home(tag);
    let wt = home.join("wt");
    std::fs::create_dir_all(home.join(".anti-hall/devswarm/workspaces")).unwrap();
    std::fs::create_dir_all(&wt).unwrap();
    for args in [vec!["init", "-q", "."], vec!["-c", "user.email=a@b", "-c", "user.name=n", "commit", "-q", "--allow-empty", "-m", "i"]] {
        assert!(Command::new("git").args(&args).current_dir(&wt).env_remove("GIT_DIR").output().unwrap().status.success());
    }
    std::fs::write(home.join("inbox.ndjson"), "{\"m\":1}\n{\"m\":2}\n").unwrap();
    std::fs::write(home.join("cursor.json"), "0").unwrap();
    let desc = json!({"id":"b-1","inboxPath":home.join("inbox.ndjson"),"cursorPath":home.join("cursor.json")});
    std::fs::write(home.join(".anti-hall/devswarm/workspaces/b-1.json"), desc.to_string()).unwrap();
    home
}

fn engine_says(home: &Path, check: &str, env: &[(&str, &str)], input: &str) -> (i32, String) {
    let mut c = Command::new(env!("CARGO_BIN_EXE_ah-engine"));
    c.arg("check").arg(check).env_clear().env("PATH", std::env::var("PATH").unwrap_or_default());
    c.env("HOME", home).env("USERPROFILE", home).env("AH_ENGINE_DIR", home.join("engine")).env("ANTIHALL_TEST_ISOLATION", "1");
    crate::node_parity::support::forward_test_scale(&mut c);
    for (k, val) in env {
        c.env(k, val);
    }
    let (code, out, _) = run(c, input.as_bytes());
    (code, String::from_utf8_lossy(&out).trim().to_string())
}

fn node_says(repo: &Path, hook: &str, home: &Path, env: &[(&str, &str)], input: &str) -> (i32, String) {
    let mut n = Command::new("node");
    n.arg(repo.join("plugins/anti-hall/hooks").join(format!("{hook}.js")))
        .env_clear()
        .env("PATH", std::env::var("PATH").unwrap_or_default())
        .env("HOME", home)
        .env("USERPROFILE", home)
        .env("ANTIHALL_TEST_ISOLATION", "1")
        .env("ANTIHALL_INGEST_DRY_RUN", "1")
        .current_dir(home);
    for (k, val) in env {
        n.env(k, val);
    }
    let (code, out, _) = run(n, input.as_bytes());
    (code, String::from_utf8_lossy(&out).to_string())
}

/// The cases that matter most: Node really acts (blocks a stop, nudges, records a reply), and the engine must not allow.
#[test]
fn where_node_acts_the_engine_defers() {
    let repo = repo();
    // Child Stop gate: the held stop, and the state write of a continuing stop.
    let home = child_home("gate-act");
    let stop = json!({"hook_event_name":"Stop","session_id":"s1","cwd":home.join("wt")}).to_string();
    let (code, out) = node_says(&repo, "devswarm-child-gate", &home, &CHILD, &stop);
    assert!(code == 0 && out.contains("\"decision\":\"block\""), "Node must hold this stop: {code} {out}");
    assert_eq!(engine_says(&home, "devswarm-child-gate", &CHILD, &stop), (0, "AHFALLBACK".to_string()), "a held stop must go to Node");
    let home = child_home("gate-state");
    let cont = json!({"hook_event_name":"Stop","session_id":"s2","stop_hook_active":true,"cwd":home.join("wt")}).to_string();
    let before = snapshot(&home);
    let (_, out) = node_says(&repo, "devswarm-child-gate", &home, &CHILD, &cont);
    assert!(out.is_empty(), "a continuing stop is allowed by Node: {out}");
    assert_ne!(before, snapshot(&home), "Node records the check in its state file, which an engine allow would skip");
    assert_eq!(engine_says(&home, "devswarm-child-gate", &CHILD, &cont), (0, "AHFALLBACK".to_string()));
    // Child drain: the nudge and its throttle state.
    let home = child_home("drain-act");
    let bash = json!({"hook_event_name":"PostToolUse","tool_name":"Bash","tool_input":{"command":"ls"},"session_id":"s1","cwd":home.join("wt")}).to_string();
    let (code, out) = node_says(&repo, "devswarm-child-drain", &home, &CHILD, &bash);
    assert!(code == 0 && out.contains("2 unread message(s)"), "Node must nudge: {code} {out}");
    assert_eq!(engine_says(&home, "devswarm-child-drain", &CHILD, &bash), (0, "AHFALLBACK".to_string()), "a nudge must go to Node");
    // Reply tracker: the recorded reply.
    let home = child_home("track-act");
    let send = json!({"hook_event_name":"PostToolUse","tool_name":"Bash","tool_input":{"command":"node devswarm.js send --to w --message hi"},
        "tool_response":{"stdout":"{\"ok\":true,\"action\":\"send\",\"type\":\"direct\",\"toId\":\"w\",\"sent\":true}\n","stderr":""},"session_id":"s1","cwd":home.join("wt")})
    .to_string();
    let primary = [("DEVSWARM_REPO_ID", "r1")];
    let before = snapshot(&home);
    let (code, out) = node_says(&repo, "devswarm-parent-reply-tracker", &home, &primary, &send);
    assert!(code == 0 && out.is_empty());
    assert!(snapshot(&home).keys().any(|k| k.contains("parent-gate") && k.ends_with("-replies.json")), "Node must record the reply");
    assert_ne!(before, snapshot(&home));
    assert_eq!(engine_says(&home, "devswarm-parent-reply-tracker", &primary, &send), (0, "AHFALLBACK".to_string()), "a recorded reply must go to Node");
}

//
// Each case is a short sequence of Stops over one seeded home. At every step the engine runs first on a snapshot; when it
// answers, the home is put back and the real Node gate runs on the same state: output, exit code AND the resulting home
// must be byte-identical (the loop state the block writes or the clean pass removes, the app cache). When the engine
// defers it must leave the home untouched, and Node then advances the state for the next step.

#[derive(Clone, Copy, PartialEq, Debug)]
enum PgWant {
    Answer,
    Defer,
}

struct PgCase {
    name: &'static str,
    env: Vec<(&'static str, String)>,
    seeds: Vec<(String, String)>,
    /// The payload's cwd is a fresh git checkout (else a path that does not exist).
    git_cwd: bool,
    /// A second git checkout the child descriptors point at (`{wt2}` in seeds).
    child_wt: bool,
    /// Seed this Primary's own descriptor, summary and store (Node's own writers).
    own_store: bool,
    /// A linked worktree of the cwd checkout (same project, another workspace: `{wt3}` in seeds).
    linked: bool,
    payload: Option<Value>,
    steps: Vec<PgWant>,
    /// The seconds in "awaiting child pickup (Ns)" are masked before comparing: the engine and Node run a moment apart.
    fuzz_secs: bool,
}

/// `YYYY-MM-DDTHH:MM:SS.mmmZ` of a time in ms.
fn iso_of(ms: u128) -> String {
    let (secs, milli) = ((ms / 1000) as i64, (ms % 1000) as u32);
    let (days, rem) = (secs.div_euclid(86_400), secs.rem_euclid(86_400));
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + i64::from(m <= 2);
    format!("{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}.{milli:03}Z", rem / 3600, rem % 3600 / 60, rem % 60)
}

fn mask_secs(s: &str) -> String {
    let re = regex::Regex::new(r"\(\d+s\)").unwrap();
    re.replace_all(s, "(Ns)").into_owned()
}

fn pg(name: &'static str, steps: &[PgWant]) -> PgCase {
    PgCase {
        name,
        env: vec![],
        seeds: vec![],
        git_cwd: false,
        child_wt: false,
        own_store: false,
        linked: false,
        payload: None,
        steps: steps.to_vec(),
        fuzz_secs: false,
    }
}

impl PgCase {
    fn seed(mut self, rel: &str, body: &str) -> PgCase {
        self.seeds.push((rel.to_string(), body.to_string()));
        self
    }
    fn env(mut self, k: &'static str, v: &str) -> PgCase {
        self.env.push((k, v.to_string()));
        self
    }
    fn git(mut self) -> PgCase {
        self.git_cwd = true;
        self
    }
    fn child(mut self) -> PgCase {
        self.child_wt = true;
        self
    }
    fn own(mut self) -> PgCase {
        self.git_cwd = true;
        self.own_store = true;
        self
    }
    fn linked(mut self) -> PgCase {
        self.git_cwd = true;
        self.linked = true;
        self
    }
    fn fuzz(mut self) -> PgCase {
        self.fuzz_secs = true;
        self
    }
    fn payload(mut self, v: Value) -> PgCase {
        self.payload = Some(v);
        self
    }
}

/// The modification time of every file under `root`: a restore puts them back, because the busy test reads a transcript's.
fn pg_mtimes(root: &Path) -> BTreeMap<String, SystemTime> {
    fn walk(base: &Path, dir: &Path, out: &mut BTreeMap<String, SystemTime>) {
        for e in std::fs::read_dir(dir).into_iter().flatten().flatten() {
            let p = e.path();
            if p.is_dir() {
                walk(base, &p, out);
            } else if let Ok(t) = std::fs::metadata(&p).and_then(|m| m.modified()) {
                out.insert(p.strip_prefix(base).unwrap().to_string_lossy().into_owned(), t);
            }
        }
    }
    let mut m = BTreeMap::new();
    walk(root, root, &mut m);
    m
}

fn pg_restore(home: &Path, snap: &BTreeMap<String, Vec<u8>>, times: &BTreeMap<String, SystemTime>) {
    std::fs::remove_dir_all(home).unwrap();
    std::fs::create_dir_all(home).unwrap();
    for (rel, body) in snap {
        if let Some(d) = rel.strip_suffix('/') {
            std::fs::create_dir_all(home.join(d)).unwrap();
        } else {
            let p = home.join(rel);
            std::fs::create_dir_all(p.parent().unwrap()).unwrap();
            std::fs::write(&p, body).unwrap();
            if let Some(t) = times.get(rel) {
                std::fs::OpenOptions::new().write(true).open(&p).unwrap().set_modified(*t).unwrap();
            }
        }
    }
}

fn pg_env(c: &mut Command, home: &Path, case: &PgCase) {
    c.env_clear()
        .env("PATH", std::env::var("PATH").unwrap_or_default())
        .env("HOME", home)
        .env("USERPROFILE", home)
        .env("ANTIHALL_TEST_ISOLATION", "1")
        .env("ANTIHALL_INGEST_DRY_RUN", "1")
        .env("DEVSWARM_REPO_ID", "r1")
        .env("DEVSWARM_BUILDER_ID", "b-1")
        .env("DEVSWARM_AI_AGENT", "claude");
    for (k, v) in &case.env {
        c.env(k, v);
    }
}

fn pg_git(dir: &Path) {
    let ok = Command::new("git").args(["init", "-q"]).arg(dir).status().unwrap();
    assert!(ok.success());
}

/// What one case did: steps answered, steps deferred, answered blocks, answered escalations.
#[derive(Default)]
struct PgTally {
    answered: usize,
    deferred: usize,
    blocks: usize,
    escalations: usize,
}

/// Runs one case.
fn pg_exec(case: &PgCase) -> PgTally {
    let repo = repo();
    let root = repo.join("plugins/anti-hall").canonicalize().unwrap();
    let tmp = temp_home(&format!("pg-{}", case.name));
    let home = tmp.join("h");
    std::fs::create_dir_all(home.join(".anti-hall")).unwrap();
    let wt = tmp.join("wt");
    let wt2 = tmp.join("wt2");
    if case.git_cwd {
        pg_git(&wt);
    }
    if case.child_wt {
        pg_git(&wt2);
    }
    let wt3 = tmp.join("wt3");
    if case.linked {
        let git = |args: &[&str]| {
            let ok = Command::new("git").arg("-C").arg(&wt).args(["-c", "user.name=t", "-c", "user.email=t@example.invalid"]).args(args).output().unwrap();
            assert!(ok.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&ok.stderr));
        };
        git(&["commit", "-q", "--allow-empty", "-m", "x"]);
        git(&["worktree", "add", "-q", wt3.to_str().unwrap()]);
    }
    let cwd = if case.git_cwd { wt.canonicalize().unwrap().to_string_lossy().into_owned() } else { "/nonexistent-pg/x".to_string() };
    let (mut key, mut own) = (String::new(), String::new());
    if case.git_cwd {
        let mut c = Command::new("node");
        c.arg(repo.join("ah-engine/tests/it/mesh_support/pgate_seed.js")).arg(&home).arg(&cwd).arg(if case.own_store { "own" } else { "ids" });
        pg_env(&mut c, &home, case);
        let (code, out, err) = run(c, b"");
        assert_eq!(code, 0, "{}: seeding failed: {}", case.name, String::from_utf8_lossy(&err));
        let v: Value = serde_json::from_slice(&out).unwrap();
        key = v["key"].as_str().unwrap().to_string();
        own = v["own"].as_str().unwrap().to_string();
    }
    for (rel, body) in &case.seeds {
        let now_ms = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_millis();
        let now = now_ms.to_string();
        let enc2: String = wt2.to_string_lossy().chars().map(|c| if "/\\:.".contains(c) { '-' } else { c }).collect();
        let body = body
            .replace("{iso}", &iso_of(now_ms))
            .replace("{old}", &(now_ms - 7_200_000).to_string())
            .replace("{five}", &(now_ms - 300_000).to_string())
            .replace("{pid}", &std::process::id().to_string())
            .replace("{wt2}", &wt2.to_string_lossy())
            .replace("{wt3}", &wt3.to_string_lossy())
            .replace("{home}", &home.to_string_lossy())
            .replace("{now}", &now);
        let (aged, rel) = match rel.strip_prefix("~aged/") {
            Some(r) => (true, r.to_string()),
            None => (false, rel.clone()),
        };
        let rel = rel.replace("{key}", &key).replace("{own}", &own).replace("{enc2}", &enc2).replace("{pid}", &std::process::id().to_string());
        let p = home.join(rel);
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(&p, body).unwrap();
        if aged {
            let f = std::fs::OpenOptions::new().write(true).open(&p).unwrap();
            f.set_modified(SystemTime::now() - Duration::from_secs(3600)).unwrap();
        }
    }
    let node_run = |input: &str| {
        let mut n = Command::new("node");
        n.arg(root.join("hooks/devswarm-parent-gate.js")).current_dir(&tmp);
        pg_env(&mut n, &home, case);
        run(n, input.as_bytes())
    };
    // install the stable launchers the way a running session has them
    let (code, out, _) = node_run(&json!({"hook_event_name":"Stop","session_id":"w","stop_hook_active":true}).to_string());
    assert_eq!((code, out.as_slice()), (0, b"".as_slice()), "{}: warm-up", case.name);
    let payload = case.payload.clone().unwrap_or_else(|| json!({"hook_event_name":"Stop","session_id":"s1","cwd":cwd,"stop_hook_active":false}));
    let input = payload.to_string();
    let mut t = PgTally::default();
    for (i, want) in case.steps.iter().enumerate() {
        let label = format!("{} step {}", case.name, i + 1);
        let before = snapshot(&home);
        let times = pg_mtimes(&home);
        let mut e = Command::new(env!("CARGO_BIN_EXE_ah-engine"));
        e.arg("check").arg("devswarm-parent-gate");
        pg_env(&mut e, &home, case);
        e.env("AH_ENGINE_PLUGIN_ROOT", &root).env("AH_ENGINE_DIR", tmp.join("engine"));
        crate::node_parity::support::forward_test_scale(&mut e);
        let (ecode, eout, eerr) = run(e, input.as_bytes());
        if String::from_utf8_lossy(&eout).trim() == "AHFALLBACK" {
            assert_eq!(*want, PgWant::Defer, "{label}: the engine deferred, the case expects an answer");
            assert_eq!(snapshot(&home), before, "{label}: a deferral must write nothing");
            let (ncode, _, _) = node_run(&input);
            assert_eq!(ncode, 0);
            t.deferred += 1;
            continue;
        }
        assert_eq!(*want, PgWant::Answer, "{label}: the engine answered {:?}, the case expects a deferral", String::from_utf8_lossy(&eout));
        let after_engine = snapshot(&home);
        pg_restore(&home, &before, &times);
        let (ncode, nout, nerr) = node_run(&input);
        let norm = |b: &[u8]| {
            let t = String::from_utf8_lossy(b).into_owned();
            if case.fuzz_secs { mask_secs(&t) } else { t }
        };
        assert_eq!((ecode, norm(&eout), norm(&eerr)), (ncode, norm(&nout), norm(&nerr)), "{label}: engine and Node differ");
        assert_eq!(after_engine, snapshot(&home), "{label}: the home differs after the engine and after Node");
        let text = String::from_utf8_lossy(&eout);
        t.blocks += usize::from(text.contains("\"decision\":\"block\""));
        t.escalations += usize::from(text.contains("Escalation: this neglect signature"));
        t.answered += 1;
    }
    ah_engine::discard::harmless(std::fs::remove_dir_all(&tmp));
    t
}

const PG_INBOX_DESC: &str = r#"{"id":"c-1","worktreePath":"{wt2}","sessionId":"sess-c1","inboxPath":"{home}/in.ndjson","cursorPath":"{home}/cur.json"}"#;
const PG_TRANSCRIPT: &str = ".claude/projects/{enc2}/sess-c1.jsonl";
const T_HUMAN: &str = r#"{"type":"user","timestamp":"{iso}","message":{"role":"user","content":"please do it"}}"#;
const T_TOOL: &str =
    r#"{"type":"assistant","timestamp":"{iso}","message":{"role":"assistant","content":[{"type":"tool_use","id":"t1","name":"Read","input":{}}]}}"#;
const T_RESULT: &str = r#"{"type":"user","timestamp":"{iso}","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"t1","content":"ok"}]}}"#;
const T_CLOSE: &str = r#"{"type":"system","subtype":"turn_duration","timestamp":"{iso}"}"#;
const T_FIRE: &str = r#"{"type":"system","subtype":"scheduled_task_fire","timestamp":"{iso}"}"#;
const T_META: &str = r#"{"type":"user","isMeta":true,"timestamp":"{iso}","message":{"role":"user","content":"tick"}}"#;
const T_PING_TOOL: &str = r#"{"type":"assistant","timestamp":"{iso}","message":{"role":"assistant","content":[{"type":"tool_use","id":"t2","name":"Bash","input":{"command":"node /p/scripts/devswarm.js inbox tick c-1 --quiet 2>&1 | tail -3"}}]}}"#;
const T_PING_TOOL_2: &str = r#"{"type":"assistant","timestamp":"{iso}","message":{"role":"assistant","content":[{"type":"tool_use","id":"t2","name":"Bash","input":{"command":"node \"/p/scripts/devswarm.js\" roster --json | head -5"}},{"type":"tool_use","id":"t3","name":"CronList","input":{}}]}}"#;
const T_SEND_TOOL: &str = r#"{"type":"assistant","timestamp":"{iso}","message":{"role":"assistant","content":[{"type":"tool_use","id":"t2","name":"Bash","input":{"command":"node /p/scripts/devswarm.js send --to c-1 --message hi"}}]}}"#;
const T_CHAIN_TOOL: &str = r#"{"type":"assistant","timestamp":"{iso}","message":{"role":"assistant","content":[{"type":"tool_use","id":"t2","name":"Bash","input":{"command":"node /p/scripts/devswarm.js inbox tick c-1; rm -rf x"}}]}}"#;
const T_ASK: &str = r#"{"type":"assistant","timestamp":"{iso}","message":{"role":"assistant","content":[{"type":"tool_use","id":"t9","name":"AskUserQuestion","input":{"questions":[{"question":"Which   way\nshould I go?"}]}}]}}"#;

fn lines(l: &[&str]) -> String {
    l.iter().map(|x| format!("{x}\n")).collect()
}

const PG_GATE_STATE: &str = ".anti-hall/devswarm/parent-gate/s1.json";
const PG_CHILD: &str = ".anti-hall/devswarm/workspaces/c-1.json";
const PG_CHILD_BODY: &str = r#"{"id":"c-1","worktreePath":"{wt2}","sessionId":"sess-c1"}"#;

fn pg_cases() -> Vec<PgCase> {
    use PgWant::{Answer as A, Defer as D};
    let child = |name: &'static str, steps: &[PgWant]| pg(name, steps).child().seed(PG_CHILD, PG_CHILD_BODY);
    let children_sig = ah_engine::checks::jsport::text::sha1_hex("devswarm-parent:children");
    vec![
        pg("inert-no-state", &[A, A]),
        pg("inert-clears-loop-state", &[A]).seed(PG_GATE_STATE, r#"{"sig":"x","blocks":2,"escalated":true}"#),
        pg("inert-git-cwd-no-summary", &[A]).git(),
        pg("still-continuing-is-silent", &[A]).payload(json!({"hook_event_name":"Stop","session_id":"s1","stop_hook_active":true})),
        pg("no-cwd-defers", &[D]).payload(json!({"hook_event_name":"Stop","session_id":"s1","stop_hook_active":false})),
        pg("relative-cwd-defers", &[D]).payload(json!({"hook_event_name":"Stop","session_id":"s1","cwd":"rel/x"})),
        pg("session-id-number-defers", &[D]).payload(json!({"hook_event_name":"Stop","session_id":7,"cwd":"/nonexistent-pg"})),
        pg("no-session-id-uses-nosession", &[A]).payload(json!({"hook_event_name":"Stop","cwd":"/nonexistent-pg"})).seed(
            ".anti-hall/devswarm/parent-gate/nosession.json",
            "{}",
        ),
        // the child with no readable inbox: block, block, block, escalate once, then quiet
        child("child-no-inbox-block-cap-escalate-quiet", &[A, A, A, A, A, A]),
        child("child-no-inbox-not-claude", &[A, A]).env("DEVSWARM_AI_AGENT", "codex"),
        child("child-no-inbox-no-builder-id", &[A]).env("DEVSWARM_BUILDER_ID", "bad id!"),
        child("child-no-inbox-session-with-odd-chars", &[A]).payload(json!({"hook_event_name":"Stop","session_id":"a/b c","cwd":"/nonexistent-pg"})),
        child("child-cursor-missing", &[A]).seed(PG_CHILD, r#"{"id":"c-1","worktreePath":"{wt2}","sessionId":"sess-c1","inboxPath":"{home}/in.ndjson","cursorPath":"{home}/cur.json"}"#).seed("in.ndjson", ""),
        child("child-cursor-corrupt", &[A])
            .seed(PG_CHILD, r#"{"id":"c-1","worktreePath":"{wt2}","sessionId":"sess-c1","inboxPath":"{home}/in.ndjson","cursorPath":"{home}/cur.json"}"#)
            .seed("in.ndjson", "{\"message\":\"x\"}\n")
            .seed("cur.json", "{oops"),
        child("child-cursor-negative", &[A])
            .seed(PG_CHILD, r#"{"id":"c-1","worktreePath":"{wt2}","sessionId":"sess-c1","inboxPath":"{home}/in.ndjson","cursorPath":"{home}/cur.json"}"#)
            .seed("in.ndjson", "")
            .seed("cur.json", "{\"line\":-1}"),
        child("child-read-up-is-clean", &[A])
            .seed(PG_CHILD, r#"{"id":"c-1","worktreePath":"{wt2}","sessionId":"sess-c1","inboxPath":"{home}/in.ndjson","cursorPath":"{home}/cur.json"}"#)
            .seed("in.ndjson", "{\"message\":\"a\"}\n{\"message\":\"b\"}\n")
            .seed("cur.json", "2")
            .seed(PG_GATE_STATE, r#"{"sig":"x","blocks":1}"#),
        child("child-only-poke-noise-is-clean", &[A])
            .seed(PG_CHILD, r#"{"id":"c-1","worktreePath":"{wt2}","sessionId":"sess-c1","inboxPath":"{home}/in.ndjson","cursorPath":"{home}/cur.json"}"#)
            .seed("in.ndjson", "{\"message\":\"  [Primary poke] wake\"}\n")
            .seed("cur.json", "0"),
        child("child-noise-and-real-blocks", &[A])
            .seed(PG_CHILD, r#"{"id":"c-1","worktreePath":"{wt2}","sessionId":"sess-c1","inboxPath":"{home}/in.ndjson","cursorPath":"{home}/cur.json"}"#)
            .seed("in.ndjson", "{\"message\":\"  [Primary poke] wake\"}\n{\"message\":\"real\"}\n")
            .seed("cur.json", "0"),
        child("child-with-unread-blocks", &[A])
            .seed(PG_CHILD, r#"{"id":"c-1","worktreePath":"{wt2}","sessionId":"sess-c1","inboxPath":"{home}/in.ndjson","cursorPath":"{home}/cur.json"}"#)
            .seed("in.ndjson", "{\"message\":\"hi\",\"ts\":1}\n")
            .seed("cur.json", "0"),
        // ---- the busy advisory, the grace window and the waiting line (childBusyState over the child's transcript) ----
        child("busy-child-is-an-advisory-and-keeps-loop-state", &[A])
            .seed(PG_CHILD, PG_INBOX_DESC)
            .seed("in.ndjson", "{\"message\":\"hi\",\"ts\":{five}}\n")
            .seed("cur.json", "0")
            .seed(PG_TRANSCRIPT, &lines(&[T_HUMAN, T_TOOL]))
            .seed(PG_GATE_STATE, r#"{"sig":"x","blocks":2}"#),
        child("busy-child-with-iso-row-time-is-an-advisory", &[A])
            .seed(PG_CHILD, PG_INBOX_DESC)
            .seed("in.ndjson", "{\"message\":\"hi\",\"ts\":\"{iso}\"}\n")
            .seed("cur.json", "0")
            .seed(PG_TRANSCRIPT, &lines(&[T_HUMAN, T_TOOL])),
        child("busy-child-with-old-mail-blocks-with-an-age-line", &[A])
            .seed(PG_CHILD, PG_INBOX_DESC)
            .seed("in.ndjson", "{\"message\":\"hi\",\"ts\":{old}}\n")
            .seed("cur.json", "0")
            .seed(PG_TRANSCRIPT, &lines(&[T_HUMAN, T_TOOL])),
        child("busy-child-with-no-digit-row-time-blocks", &[A])
            .seed(PG_CHILD, PG_INBOX_DESC)
            .seed("in.ndjson", "{\"message\":\"hi\",\"ts\":\"last tuesday\"}\n")
            .seed("cur.json", "0")
            .seed(PG_TRANSCRIPT, &lines(&[T_HUMAN, T_TOOL])),
        child("busy-child-with-timeless-row-blocks", &[A])
            .seed(PG_CHILD, PG_INBOX_DESC)
            .seed("in.ndjson", "{\"message\":\"hi\"}\n")
            .seed("cur.json", "0")
            .seed(PG_TRANSCRIPT, &lines(&[T_HUMAN, T_TOOL])),
        child("ping-only-last-turn-is-not-busy", &[A])
            .seed(PG_CHILD, PG_INBOX_DESC)
            .seed("in.ndjson", "{\"message\":\"hi\",\"ts\":{five}}\n")
            .seed("cur.json", "0")
            .seed(PG_TRANSCRIPT, &lines(&[T_HUMAN, T_TOOL, T_RESULT, T_CLOSE, T_FIRE, T_META, T_PING_TOOL])),
        child("quoted-roster-pipe-last-turn-is-a-ping", &[A])
            .seed(PG_CHILD, PG_INBOX_DESC)
            .seed("in.ndjson", "{\"message\":\"hi\",\"ts\":{five}}\n")
            .seed("cur.json", "0")
            .seed(PG_TRANSCRIPT, &lines(&[T_HUMAN, T_TOOL, T_RESULT, T_CLOSE, T_FIRE, T_META, T_PING_TOOL_2])),
        child("wake-turn-with-a-real-tool-is-busy", &[A])
            .seed(PG_CHILD, PG_INBOX_DESC)
            .seed("in.ndjson", "{\"message\":\"hi\",\"ts\":{five}}\n")
            .seed("cur.json", "0")
            .seed(PG_TRANSCRIPT, &lines(&[T_HUMAN, T_TOOL, T_RESULT, T_CLOSE, T_FIRE, T_META, T_SEND_TOOL])),
        child("wake-turn-chained-command-is-busy", &[A])
            .seed(PG_CHILD, PG_INBOX_DESC)
            .seed("in.ndjson", "{\"message\":\"hi\",\"ts\":{five}}\n")
            .seed("cur.json", "0")
            .seed(PG_TRANSCRIPT, &lines(&[T_HUMAN, T_TOOL, T_RESULT, T_CLOSE, T_FIRE, T_META, T_CHAIN_TOOL])),
        child("stale-transcript-is-not-busy", &[A])
            .seed(PG_CHILD, PG_INBOX_DESC)
            .seed("in.ndjson", "{\"message\":\"hi\",\"ts\":{five}}\n")
            .seed("cur.json", "0")
            .seed(&format!("~aged/{PG_TRANSCRIPT}"), &lines(&[T_HUMAN, T_TOOL])),
        child("fresh-mail-is-a-grace-advisory", &[A])
            .fuzz()
            .seed(PG_CHILD, PG_INBOX_DESC)
            .seed("in.ndjson", "{\"message\":\"hi\",\"ts\":{now}}\n")
            .seed("cur.json", "0")
            .seed(PG_GATE_STATE, r#"{"sig":"x","blocks":1}"#),
        child("waiting-on-a-question-in-a-live-session", &[A])
            .seed(PG_CHILD, PG_INBOX_DESC)
            .seed("in.ndjson", "{\"message\":\"hi\",\"ts\":{five}}\n")
            .seed("cur.json", "0")
            .seed(".claude/sessions/{pid}.json", r#"{"pid":{pid},"sessionId":"sess-c1"}"#)
            .seed(PG_TRANSCRIPT, &lines(&[T_HUMAN, T_ASK])),
        child("waiting-on-a-question-with-a-name-cached", &[A])
            .seed(PG_CHILD, PG_INBOX_DESC)
            .seed("in.ndjson", "{\"message\":\"hi\",\"ts\":{five}}\n")
            .seed("cur.json", "0")
            .seed(".anti-hall/devswarm/names/c-1.json", r#"{"name":"Fix the gate"}"#)
            .seed(".claude/sessions/{pid}.json", r#"{"pid":{pid},"sessionId":"sess-c1"}"#)
            .seed(PG_TRANSCRIPT, &lines(&[T_HUMAN, T_ASK])),
        child("open-question-without-a-live-session-is-no-wait", &[A])
            .seed(PG_CHILD, PG_INBOX_DESC)
            .seed("in.ndjson", "{\"message\":\"hi\",\"ts\":{five}}\n")
            .seed("cur.json", "0")
            .seed(PG_TRANSCRIPT, &lines(&[T_HUMAN, T_ASK])),
        child("unresolved-tool-on-a-quiet-transcript-waits", &[A])
            .seed(PG_CHILD, PG_INBOX_DESC)
            .seed("in.ndjson", "{\"message\":\"hi\",\"ts\":{five}}\n")
            .seed("cur.json", "0")
            .seed(".claude/sessions/{pid}.json", r#"{"pid":{pid},"sessionId":"sess-c1"}"#)
            .seed(&format!("~aged/{PG_TRANSCRIPT}"), &lines(&[T_HUMAN, T_TOOL])),
        child("live-idle-child-escalates-with-the-archive-hint", &[A, A])
            .seed(PG_CHILD, PG_INBOX_DESC)
            .seed("in.ndjson", "{\"message\":\"hi\",\"ts\":{old}}\n")
            .seed("cur.json", "0")
            .seed(".claude/sessions/{pid}.json", r#"{"pid":{pid},"sessionId":"sess-c1"}"#)
            .seed(&format!("~aged/{PG_TRANSCRIPT}"), &lines(&[T_HUMAN, T_TOOL, T_RESULT, T_CLOSE]))
            .seed(PG_GATE_STATE, &format!(r#"{{"sig":"{children_sig}","blocks":3}}"#)),
        child("heartbeat-of-another-session-is-unknown-state", &[A])
            .seed(PG_CHILD, PG_INBOX_DESC)
            .seed("in.ndjson", "{\"message\":\"hi\",\"ts\":{five}}\n")
            .seed("cur.json", "0")
            .seed(".anti-hall/devswarm/heartbeats/c-1.json", r#"{"sessionId":"other","ts":1}"#)
            .seed(PG_TRANSCRIPT, &lines(&[T_HUMAN, T_TOOL])),
        child("busy-setting-defers", &[D])
            .env("ANTIHALL_DEVSWARM_PARENT_GATE_BUSY_FRESH_MIN", "10")
            .seed(PG_CHILD, PG_INBOX_DESC)
            .seed("in.ndjson", "{\"message\":\"hi\",\"ts\":{five}}\n")
            .seed("cur.json", "0")
            .seed(PG_TRANSCRIPT, &lines(&[T_HUMAN, T_TOOL])),
        child("busy-child-in-the-primary-twin-family-and-a-quiet-one", &[A])
            .seed(PG_CHILD, PG_INBOX_DESC)
            .seed("in.ndjson", "{\"message\":\"hi\",\"ts\":{five}}\n")
            .seed("cur.json", "0")
            .seed(".anti-hall/devswarm/workspaces/c-2.json", r#"{"id":"c-2","worktreePath":"{wt2}","sessionId":"sess-c2"}"#)
            .seed(PG_TRANSCRIPT, &lines(&[T_HUMAN, T_TOOL])),
        child("child-archived-marker-is-clean", &[A]).seed(".anti-hall/devswarm/archived/c-1.json", r#"{"id":"c-1","worktreePath":"{wt2}","sessionId":"sess-c1"}"#),
        child("child-archived-marker-other-session-blocks", &[A]).seed(".anti-hall/devswarm/archived/c-1.json", r#"{"id":"c-1","sessionId":"old"}"#),
        child("child-archived-marker-other-worktree-blocks", &[A]).seed(".anti-hall/devswarm/archived/c-1.json", r#"{"id":"c-1","worktreePath":"/elsewhere"}"#),
        child("child-nag-ignored-is-clean", &[A]).seed(".anti-hall/devswarm/ignore.json", r#"{"ids":["c-1"]}"#),
        child("child-archive-ignored-is-clean", &[A]).seed(".anti-hall/devswarm/archive-ignore/c-1.json", "{}"),
        child("child-held-defers", &[D]).env("ANTIHALL_DEVSWARM_HELD_PARTITIONS", "c-1"),
        child("child-cap-setting-defers", &[D]).env("ANTIHALL_DEVSWARM_PARENT_GATE_CAP", "4"),
        child("child-cap-in-settings-file-defers", &[D]).seed(".anti-hall/settings.json", r#"{"devswarm":{"parentGateCap":5}}"#),
        child("child-live-session-record-blocks", &[A]).seed(".claude/sessions/4242.json", r#"{"pid":4242,"sessionId":"sess-c1"}"#),
        child("child-other-session-record-blocks", &[A]).seed(".claude/sessions/4242.json", r#"{"pid":4242,"sessionId":"someone-else"}"#),
        child("child-stale-verdict-defers", &[D]).seed(".anti-hall/devswarm/liveness/c-1.json", r#"{"status":"stale"}"#),
        child("child-ok-verdict-blocks", &[A]).seed(".anti-hall/devswarm/liveness/c-1.json", r#"{"status":"ok"}"#),
        child("child-stray-plan-defers", &[D]).seed(".anti-hall/devswarm/stray/c-1.json", r#"{"id":"c-1","active":[]}"#),
        child("child-loop-state-other-sig-restarts", &[A]).seed(PG_GATE_STATE, r#"{"sig":"other","blocks":3,"escalated":true,"intents":{"other":{"r":1}}}"#),
        child("child-loop-state-escalated-is-quiet", &[A]).seed(PG_GATE_STATE, &format!(r#"{{"sig":"{children_sig}","blocks":4,"escalated":true}}"#)),
        child("child-loop-state-intent-raises-budget", &[A, A]).seed(
            PG_GATE_STATE,
            &format!(r#"{{"sig":"{children_sig}","blocks":3,"escalated":false,"qSig":"q","qBlocks":2,"intents":{{"{children_sig}":{{"ts":1,"reason":"waiting on CI"}},"stale":{{"ts":0}}}},"intentAcks":1.5}}"#),
        ),
        child("child-loop-state-array-intents", &[A]).seed(PG_GATE_STATE, &format!(r#"{{"sig":"{children_sig}","blocks":1,"intents":[1]}}"#)),
        child("child-loop-state-corrupt", &[A]).seed(PG_GATE_STATE, "{oops"),
        child("child-loop-state-array", &[A]).seed(PG_GATE_STATE, "[1,2]"),
        child("child-twin-descriptors-one-family", &[A, A]).seed(".anti-hall/devswarm/workspaces/c-2.json", r#"{"id":"c-2","worktreePath":"{wt2}","sessionId":"sess-c2"}"#),
        child("child-and-dead-descriptor", &[A])
            .seed(".anti-hall/devswarm/workspaces/d-1.json", r#"{"id":"d-1","worktreePath":"/nonexistent-pg/gone","sessionId":"sd","inboxPath":"/nonexistent-pg/in.ndjson","cursorPath":"/nonexistent-pg/c"}"#),
        pg("dead-descriptor-only-is-clean", &[A])
            .seed(".anti-hall/devswarm/workspaces/d-1.json", r#"{"id":"d-1","worktreePath":"/nonexistent-pg/gone","sessionId":"sd","inboxPath":"/nonexistent-pg/in.ndjson","cursorPath":"/nonexistent-pg/c"}"#),
        pg("descriptor-without-session-is-ignored", &[A]).seed(".anti-hall/devswarm/workspaces/x.json", r#"{"id":"x","worktreePath":"/a"}"#),
        pg("descriptor-unsafe-id-is-ignored", &[A]).seed(".anti-hall/devswarm/workspaces/x.json", r#"{"id":"../x","worktreePath":"/a","sessionId":"s"}"#),
        pg("descriptor-corrupt-is-ignored", &[A]).seed(".anti-hall/devswarm/workspaces/x.json", "{oops"),
        child("child-blocks-with-stale-build-is-quiet", &[A, A]).seed(
            ".claude/plugins/installed_plugins.json",
            r#"{"version":2,"plugins":{"anti-hall@anti-hall":[{"scope":"user","version":"999.0.0","installPath":"/x"}]}}"#,
        ),
        child("child-blocks-with-current-build", &[A]).seed(
            ".claude/plugins/installed_plugins.json",
            r#"{"version":2,"plugins":{"anti-hall@anti-hall":[{"scope":"user","version":"0.0.1","installPath":"/x"}]}}"#,
        ),
        child("child-intent-backstop-escalates", &[A, A]).seed(
            PG_GATE_STATE,
            &format!(r#"{{"sig":"{children_sig}","blocks":15,"escalated":false,"intents":{{"{children_sig}":{{"ts":1,"reason":"r"}}}},"intentAcks":15}}"#),
        ),
        pg("linked-child-no-inbox-blocks", &[A, A]).linked().seed(".anti-hall/devswarm/workspaces/c-3.json", r#"{"id":"c-3","worktreePath":"{wt3}","sessionId":"sess-c3"}"#),
        pg("linked-done-child-escalates-with-archive-hint", &[A, A])
            .linked()
            .seed(".anti-hall/devswarm/workspaces/c-3.json", r#"{"id":"c-3","worktreePath":"{wt3}","sessionId":"sess-c3"}"#)
            .seed(".anti-hall/devswarm/summaries/{key}.json", r#"{"workspaces":{"c-3":{"archive_ready":true}}}"#)
            .seed(PG_GATE_STATE, &format!(r#"{{"sig":"{children_sig}","blocks":3}}"#)),
        pg("linked-child-live-clean-pass-defers", &[D])
            .linked()
            .seed(".anti-hall/devswarm/workspaces/c-3.json", r#"{"id":"c-3","worktreePath":"{wt3}","sessionId":"sess-c3","inboxPath":"{home}/in.ndjson","cursorPath":"{home}/cur.json"}"#)
            .seed("in.ndjson", "")
            .seed("cur.json", "0"),
        // the Primary's own mailbox
        pg("own-summary-corrupt-blocks-then-conservation-defers", &[A, A, A, D]).git().seed(".anti-hall/devswarm/summaries/{key}.json", "{oops"),
        pg("own-store-clean-pass", &[A, A]).own(),
        pg("own-store-clean-clears-state", &[A]).own().seed(PG_GATE_STATE, r#"{"sig":"x","blocks":2}"#),
        pg("own-store-other-project-child-is-clean", &[A, A]).own().child().seed(PG_CHILD, PG_CHILD_BODY),
        pg("own-pending-question-defers", &[D]).own().env("PG_SUMMARY", "question"),
        pg("own-unread-defers", &[D]).own().env("PG_SUMMARY", "unread"),
        pg("own-parked-escalation-defers", &[D]).own().seed(".anti-hall/devswarm/escalation-pending/e1.json", r#"{"parentId":"p","row":{}}"#),
        pg("own-drain-marker-defers", &[D])
            .git()
            .seed(".anti-hall/devswarm/summaries/{key}.json", "{oops")
            .seed(".anti-hall/devswarm/drain/{own}.json", r#"{"startedAt":{now},"sessionId":"s1","pid":1,"count":0}"#),
    ]
}

#[test]
fn parent_gate_answers_match_node_byte_for_byte() {
    let (mut cases, mut sum) = (0, PgTally::default());
    for case in pg_cases() {
        let t = pg_exec(&case);
        cases += 1;
        sum.answered += t.answered;
        sum.deferred += t.deferred;
        sum.blocks += t.blocks;
        sum.escalations += t.escalations;
    }
    eprintln!(
        "devswarm-parent-gate parity: {cases} cases, {} steps answered byte-identically to Node ({} blocks, {} escalations), {} deferred",
        sum.answered, sum.blocks, sum.escalations, sum.deferred
    );
    assert!(cases >= 50 && sum.answered >= 50 && sum.blocks >= 20 && sum.escalations >= 2, "the corpus shrank or stopped blocking");
}
