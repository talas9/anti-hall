//! Node-vs-engine parity for the built-in `devswarm-child-gate`, `devswarm-parent-reply-tracker` and `devswarm-child-drain`
//! checks. Every case runs the engine check; where it answers (an allow) the real Node hook must print nothing, exit 0 and
//! leave the isolated home exactly as it was. Where the engine defers, Node decides, so there is nothing to compare: the
//! guard direction is that an engine allow is never a stop Node would have held (D74).
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

/// Environments and files shared by the three hooks; `setting` is the hook's own switch key.
fn variants(setting: &'static str, guard: &'static str, plugin_env: &'static str) -> Vec<Variant> {
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
    let _ = setting;
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
    let _ = writer.join().unwrap();
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
            for (k, val) in &x.env {
                c.env(k, val);
            }
            let (code, out, err) = run(c, input);
            let out = String::from_utf8_lossy(&out).to_string();
            let label = format!("{hook} / {} / {pname}", x.name);
            if out.trim() == "AHFALLBACK" {
                assert_eq!(code, 0, "{label}: a deferral exits 0");
                t.deferred += 1;
                let _ = std::fs::remove_dir_all(&home);
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
            let _ = std::fs::remove_dir_all(&home);
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
    let vs = variants("childGate", "devswarm-child-gate", "CLAUDE_PLUGIN_OPTION_DEVSWARM_CHILD_GATE");
    let t = compare(&repo(), "devswarm-child-gate", "devswarm-child-gate", &vs, &stop_payloads());
    report("devswarm-child-gate", &t, 300);
}

#[test]
fn reply_tracker_allow_is_node_silence_and_a_plausible_send_defers() {
    let vs = variants("parentReplyTracker", "devswarm-parent-reply-tracker", "CLAUDE_PLUGIN_OPTION_DEVSWARM_PARENT_REPLY_TRACKER");
    let t = compare(&repo(), "devswarm-parent-reply-tracker", "devswarm-parent-reply-tracker", &vs, &bash_payloads());
    report("devswarm-parent-reply-tracker", &t, 300);
}

#[test]
fn child_drain_allow_is_node_silence_and_a_child_workspace_defers() {
    let vs = variants("childDrain", "devswarm-child-drain", "CLAUDE_PLUGIN_OPTION_DEVSWARM_CHILD_DRAIN");
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
