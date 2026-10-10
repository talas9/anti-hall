//! Node-vs-engine parity for the read-side answers of `devswarm-child-drain` and `devswarm-parent-gate`.
//!
//! Every case runs the engine (`ah-engine check <name>`) and the real Node hook on the same isolated home, the same
//! environment and the same payload. The rule under test is one-directional: where the engine answers, Node must print
//! nothing, exit 0 and change nothing in the home (the engine's answer is byte for byte Node's); where Node would act
//! (a drain nudge from a seeded store, a Stop gate that reads state) the engine must defer. The engine itself never
//! writes. Homes are isolated (`HOME`, `USERPROFILE`) and `ANTIHALL_INGEST_DRY_RUN=1` is set on every process, so the
//! real `~/.anti-hall/devswarm` store is never touched.
#![allow(clippy::unwrap_used, clippy::expect_used)] // a test crate: a panic is the failure report, and E2 exempts tests
use serde_json::{Value, json};
use std::collections::BTreeMap;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::Mutex;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::{Duration, Instant};

static SERIAL: Mutex<()> = Mutex::new(());
static N: AtomicUsize = AtomicUsize::new(0);
const FALLBACK: &str = "AHFALLBACK";
const DRAIN: &str = "devswarm-child-drain";
const GATE: &str = "devswarm-parent-gate";
const DESC: &str = ".anti-hall/devswarm/workspaces/abc-123.json";

#[derive(Clone, Copy, PartialEq, Debug)]
enum Want {
    /// The engine answers and Node is silent with no state change.
    Answer,
    /// The engine defers.
    Defer,
    /// The engine defers and Node really does act (prints a nudge): the case that proves "never weaker".
    DeferNodeActs,
}

#[derive(Clone)]
struct Case {
    name: String,
    hook: &'static str,
    env: Vec<(String, String)>,
    seed: Vec<(String, String)>,
    /// Seed a git worktree, a descriptor with an NDJSON inbox and a store: (ndjson lines, store rows).
    store: Option<(u32, u32)>,
    /// Run the Node hook once first (with a payload that does nothing) so the stable launchers exist.
    warm: bool,
    stdin: Value,
    raw_stdin: Option<String>,
    want: Want,
}

fn case(name: &str, hook: &'static str, want: Want, extra: &[(&str, &str)], stdin: Value) -> Case {
    let mut env: BTreeMap<String, String> =
        [("DEVSWARM_REPO_ID", "repo-1"), ("DEVSWARM_BUILDER_ID", "abc-123")].iter().map(|(k, v)| (k.to_string(), v.to_string())).collect();
    if hook == DRAIN {
        env.insert("DEVSWARM_SOURCE_BRANCH".into(), "feature/x".into());
    }
    for (k, v) in extra {
        match k.strip_prefix('-') {
            Some(gone) => env.remove(gone),
            None => env.insert(k.to_string(), v.to_string()),
        };
    }
    Case { name: name.into(), hook, env: env.into_iter().collect(), seed: vec![], store: None, warm: true, stdin, raw_stdin: None, want }
}

fn drain(name: &str, want: Want, extra: &[(&str, &str)], stdin: Value) -> Case {
    case(name, DRAIN, want, extra, stdin)
}

fn gate(name: &str, want: Want, extra: &[(&str, &str)], stdin: Value) -> Case {
    case(name, GATE, want, extra, stdin)
}

impl Case {
    fn seed(mut self, rel: &str, body: &str) -> Case {
        self.seed.push((rel.into(), body.into()));
        self
    }
    fn desc(self, body: &str) -> Case {
        self.seed(DESC, body)
    }
    fn cold(mut self) -> Case {
        self.warm = false;
        self
    }
    fn raw(mut self, s: &str) -> Case {
        self.raw_stdin = Some(s.into());
        self
    }
    fn store(mut self, nd: u32, rows: u32) -> Case {
        self.store = Some((nd, rows));
        self
    }
}

fn plugin() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("..").join("plugins/anti-hall").canonicalize().unwrap()
}

fn temp_dir(tag: &str) -> PathBuf {
    let d = std::env::temp_dir().join(format!("ah-dsrs-{tag}-{}-{}", std::process::id(), N.fetch_add(1, Ordering::Relaxed)));
    ah_engine::discard::harmless(std::fs::remove_dir_all(&d));
    std::fs::create_dir_all(&d).unwrap();
    d.canonicalize().unwrap()
}

fn run(mut cmd: Command, input: &str) -> (i32, String, String) {
    cmd.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = cmd.spawn().unwrap();
    let mut stdin = child.stdin.take().unwrap();
    let input = input.as_bytes().to_vec();
    let w = std::thread::spawn(move || ah_engine::discard::harmless(stdin.write_all(&input)));
    let (mut o, mut e) = (child.stdout.take().unwrap(), child.stderr.take().unwrap());
    let ro = std::thread::spawn(move || {
        let mut b = Vec::new();
        o.read_to_end(&mut b).unwrap();
        b
    });
    let re = std::thread::spawn(move || {
        let mut b = Vec::new();
        e.read_to_end(&mut b).unwrap();
        b
    });
    let deadline = Instant::now() + Duration::from_secs(30);
    let status = loop {
        if let Some(s) = child.try_wait().unwrap() {
            break s;
        }
        assert!(Instant::now() < deadline, "child exceeded 30 s: {cmd:?}");
        std::thread::sleep(Duration::from_millis(5));
    };
    w.join().unwrap();
    (status.code().unwrap_or(-1), String::from_utf8_lossy(&ro.join().unwrap()).into_owned(), String::from_utf8_lossy(&re.join().unwrap()).into_owned())
}

fn base_env(cmd: &mut Command, home: &str, case: &Case, root: &Path) {
    cmd.env_clear()
        .env("PATH", std::env::var("PATH").unwrap_or_default())
        .env("ANTIHALL_TEST_ISOLATION", "1")
        .env("ANTIHALL_INGEST_DRY_RUN", "1")
        .env("HOME", home)
        .env("USERPROFILE", home)
        .env("AH_ENGINE_PLUGIN_ROOT", root);
    for (k, v) in &case.env {
        cmd.env(k, v);
    }
}

fn node(case: &Case, home: &str, root: &Path, input: &str) -> (i32, String, String) {
    let mut cmd = Command::new("node");
    cmd.arg(root.join(if case.hook == DRAIN { "hooks/devswarm-child-drain.js" } else { "hooks/devswarm-parent-gate.js" }));
    base_env(&mut cmd, home, case, root);
    run(cmd, input)
}

fn engine(case: &Case, home: &str, root: &Path, input: &str) -> (i32, String, String) {
    let mut cmd = Command::new(env!("CARGO_BIN_EXE_ah-engine"));
    cmd.arg("check").arg(case.hook);
    base_env(&mut cmd, home, case, root);
    cmd.env("AH_ENGINE_DIR", std::env::temp_dir().join("ah-dsrs-engine-state"));
    run(cmd, input)
}

fn tree(dir: &Path) -> BTreeMap<String, Vec<u8>> {
    fn walk(base: &Path, d: &Path, out: &mut BTreeMap<String, Vec<u8>>) {
        for e in std::fs::read_dir(d).into_iter().flatten().flatten() {
            let p = e.path();
            if p.is_dir() {
                walk(base, &p, out);
            } else {
                out.insert(p.strip_prefix(base).unwrap().to_string_lossy().into_owned(), std::fs::read(&p).unwrap_or_default());
            }
        }
    }
    let mut out = BTreeMap::new();
    walk(dir, dir, &mut out);
    out
}

/// The payload that makes the Node hook do nothing, used to install the launchers before the compared run.
fn warm_payload(hook: &str) -> String {
    if hook == DRAIN {
        json!({"hook_event_name": "PostToolUse", "tool_name": "Read", "session_id": "w"}).to_string()
    } else {
        json!({"hook_event_name": "Stop", "stop_hook_active": true, "session_id": "w"}).to_string()
    }
}

/// Returns "answer" or "defer".
fn exec(case: &Case) -> &'static str {
    let tmp = temp_dir(&case.name.replace(|ch: char| !ch.is_ascii_alphanumeric(), "_"));
    let home_dir = tmp.join("home");
    std::fs::create_dir_all(&home_dir).unwrap();
    let home = home_dir.to_string_lossy().into_owned();
    for (rel, body) in &case.seed {
        let p = home_dir.join(rel);
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(p, body).unwrap();
    }
    if let Some((nd, rows)) = case.store {
        let wt = tmp.join("wt");
        let init = Command::new("git").args(["init", "-q"]).arg(&wt).status().unwrap();
        assert!(init.success());
        let seed = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/it/mesh_support/readside_seed.js");
        let out = Command::new("node")
            .arg(seed)
            .args([&home, wt.to_str().unwrap(), "abc-123", &nd.to_string(), &rows.to_string()])
            .env("HOME", &home)
            .env("ANTIHALL_INGEST_DRY_RUN", "1")
            .output()
            .unwrap();
        assert!(out.status.success(), "{}: seeding failed: {}", case.name, String::from_utf8_lossy(&out.stderr));
    }
    let root = plugin();
    if case.warm {
        let (code, out, _) = node(case, &home, &root, &warm_payload(case.hook));
        assert_eq!((code, out.as_str()), (0, ""), "{}: warm-up run", case.name);
    }
    let input = case.raw_stdin.clone().unwrap_or_else(|| case.stdin.to_string());
    let before = tree(&home_dir);
    let (ecode, eout, eerr) = engine(case, &home, &root, &input);
    assert_eq!(ecode, 0, "{}: engine exit {ecode}: {eerr}", case.name);
    assert_eq!(tree(&home_dir), before, "{}: the engine changed the home", case.name);
    if eout.trim_end() == FALLBACK {
        assert_ne!(case.want, Want::Answer, "{}: engine deferred but the case expects an answer", case.name);
        if case.want == Want::DeferNodeActs {
            let (ncode, nout, _) = node(case, &home, &root, &input);
            assert!(ncode == 0 && !nout.trim().is_empty(), "{}: the case expects Node to act, it printed {nout:?}", case.name);
        }
        return "defer";
    }
    assert_eq!(case.want, Want::Answer, "{}: engine answered {eout:?} but the case expects a deferral", case.name);
    let (ncode, nout, nerr) = node(case, &home, &root, &input);
    assert_eq!((ecode, &eout, &eerr), (ncode, &nout, &nerr), "{}: engine and Node differ", case.name);
    assert_eq!(tree(&home_dir), before, "{}: Node changed the home, the engine did not", case.name);
    "answer"
}

fn bash(cmd: &str) -> Value {
    json!({"hook_event_name": "PostToolUse", "tool_name": "Bash", "tool_input": {"command": cmd}, "session_id": "s1"})
}

fn tool(t: Value) -> Value {
    json!({"hook_event_name": "PostToolUse", "tool_name": t, "tool_input": {"command": "ls"}, "session_id": "s1"})
}

fn with(mut v: Value, k: &str, x: Value) -> Value {
    v[k] = x;
    v
}

const INBOX: &str = "{\"inboxPath\":\"/nonexistent/in.ndjson\",\"cursorPath\":\"/nonexistent/cur\"}";

fn drain_cases() -> Vec<Case> {
    let (a, d) = (Want::Answer, Want::Defer);
    let id = "DEVSWARM_BUILDER_ID";
    let b = || bash("ls -la");
    let mut v = vec![
        drain("tool-read", a, &[], tool(json!("Read"))).desc(INBOX),
        drain("tool-lowercase-bash", a, &[], tool(json!("bash"))).desc(INBOX),
        drain("tool-null", a, &[], tool(Value::Null)).desc(INBOX),
        drain("tool-number", a, &[], tool(json!(7))).desc(INBOX),
        drain("tool-empty-string", a, &[], tool(json!(""))).desc(INBOX),
        drain("tool-absent-continues", d, &[], json!({"hook_event_name":"PostToolUse","tool_input":{"command":"ls"}})).desc(INBOX),
        drain("subagent-agent-id", a, &[], with(b(), "agent_id", json!("a1"))).desc(INBOX),
        drain("subagent-agent-type", a, &[], with(b(), "agent_type", json!("Explore"))).desc(INBOX),
        drain("subagent-empty-agent-id", a, &[], with(b(), "agent_id", json!(""))).desc(INBOX),
        drain("subagent-zero-agent-id", a, &[], with(b(), "agent_id", json!(0))).desc(INBOX),
        drain("subagent-false-agent-type", a, &[], with(b(), "agent_type", json!(false))).desc(INBOX),
        drain("subagent-null-ids-are-not-subagents", d, &[], with(with(b(), "agent_id", Value::Null), "agent_type", Value::Null)).desc(INBOX),
        drain("read-primary", a, &[], bash("node x/devswarm.js inbox read-primary")).desc(INBOX),
        drain("read-primary-upper", a, &[], bash("NODE X INBOX READ-PRIMARY")).desc(INBOX),
        drain("read-primary-flags", a, &[], bash("devswarm.js inbox -s abc read-primary --json")).desc(INBOX),
        drain("read-primary-two-flags", a, &[], bash("devswarm.js inbox -a -b val read-primary")).desc(INBOX),
        drain("read-primary-tab", a, &[], bash("devswarm.js inbox\tread-primary")).desc(INBOX),
        drain("read-primary-nbsp", a, &[], bash("devswarm.js inbox\u{a0}read-primary")).desc(INBOX),
        drain("read-primary-newline", a, &[], bash("echo 1\ndevswarm.js inbox\nread-primary")).desc(INBOX),
        drain("read-primary-prefixed-word-defers", d, &[], bash("xinbox read-primary")).desc(INBOX),
        drain("read-primary-suffixed-word-defers", d, &[], bash("devswarm.js inbox read-primaryx")).desc(INBOX),
        drain("read-primary-dash-word-matches", a, &[], bash("devswarm.js inbox read-primary-extra")).desc(INBOX),
        drain("read-primary-underscore-defers", d, &[], bash("devswarm.js inbox read-primary_x")).desc(INBOX),
        drain("read-primary-between-defers", d, &[], bash("devswarm.js inbox pull read-primary")).desc(INBOX),
        drain("read-primary-kelvin-sign-defers", d, &[], bash("INBOX READ-PRIMARY".replace('K', "\u{212a}").replace("INBOX", "\u{212a}NBOX").as_str()))
            .desc(INBOX),
        drain("command-not-a-string-defers", d, &[], json!({"tool_name":"Bash","tool_input":{"command":["inbox","read-primary"]}})).desc(INBOX),
        drain("tool-input-absent-defers", d, &[], json!({"tool_name":"Bash"})).desc(INBOX),
        drain("id-missing", a, &[("-DEVSWARM_BUILDER_ID", "")], b()).desc(INBOX),
        drain("id-empty", a, &[(id, "")], b()).desc(INBOX),
        drain("id-space", a, &[(id, "a b")], b()).desc(INBOX),
        drain("id-slash", a, &[(id, "../x")], b()).desc(INBOX),
        drain("id-dotdot-inside", a, &[(id, "a..b")], b()).desc(INBOX),
        drain("id-dot", a, &[(id, ".")], b()),
        drain("id-unicode", a, &[(id, "id-\u{e9}")], b()).desc(INBOX),
        drain("id-trailing-newline", a, &[(id, "abc-123\n")], b()).desc(INBOX),
        drain("descriptor-missing", a, &[], b()),
        drain("descriptor-missing-other-id", a, &[(id, "other_1.x")], b()).desc(INBOX),
        drain("descriptor-is-a-directory", a, &[], b()).seed(&format!("{DESC}/x"), "y"),
        drain("descriptor-empty-object", a, &[], b()).desc("{}"),
        drain("descriptor-array", a, &[], b()).desc("[{\"inboxPath\":\"x\"}]"),
        drain("descriptor-null", a, &[], b()).desc("null"),
        drain("descriptor-string", a, &[], b()).desc("\"inboxPath\""),
        drain("descriptor-number", a, &[], b()).desc("5"),
        drain("descriptor-inbox-empty", a, &[], b()).desc("{\"inboxPath\":\"\"}"),
        drain("descriptor-inbox-null", a, &[], b()).desc("{\"inboxPath\":null}"),
        drain("descriptor-inbox-false", a, &[], b()).desc("{\"inboxPath\":false}"),
        drain("descriptor-inbox-zero", a, &[], b()).desc("{\"inboxPath\":0}"),
        drain("descriptor-inbox-negative-zero", a, &[], b()).desc("{\"inboxPath\":-0}"),
        drain("descriptor-inbox-wrong-case-key", a, &[], b()).desc("{\"inboxpath\":\"x\"}"),
        drain("descriptor-inbox-string-defers", d, &[], b()).desc(INBOX),
        drain("descriptor-inbox-true-defers", d, &[], b()).desc("{\"inboxPath\":true}"),
        drain("descriptor-inbox-one-defers", d, &[], b()).desc("{\"inboxPath\":1}"),
        drain("descriptor-inbox-object-defers", d, &[], b()).desc("{\"inboxPath\":{}}"),
        drain("descriptor-inbox-array-defers", d, &[], b()).desc("{\"inboxPath\":[]}"),
        drain("descriptor-inbox-duplicate-key-last-wins", a, &[], b()).desc("{\"inboxPath\":\"x\",\"inboxPath\":\"\"}"),
        drain("descriptor-malformed-defers", d, &[], b()).desc("{not json"),
        drain("descriptor-empty-file-defers", d, &[], b()).desc(""),
        drain("descriptor-lone-surrogate-defers", d, &[], b()).desc("{\"inboxPath\":\"\\ud800\"}"),
        drain("descriptor-overflow-number-defers", d, &[], b()).desc("{\"inboxPath\":1e999}"),
        drain("payload-not-object-defers", d, &[], json!(["x"])).desc(INBOX),
        drain("payload-null-defers", d, &[], Value::Null).desc(INBOX),
        drain("payload-malformed-defers", d, &[], Value::Null).raw("{not json").desc(INBOX),
        drain("payload-empty-defers", d, &[], Value::Null).raw("").desc(INBOX),
        // the role and switch gates the engine already answered stay answered
        drain("primary-is-silent", a, &[("-DEVSWARM_SOURCE_BRANCH", "")], b()).desc(INBOX),
        drain("inactive-is-silent", a, &[("-DEVSWARM_REPO_ID", "")], b()).desc(INBOX),
        drain("switch-off", a, &[], b()).desc(INBOX).seed(".anti-hall/settings.json", "{\"devswarm\":{\"childDrain\":false}}"),
        // the launchers: Node installs them when it runs, so a cold home is Node's to answer
        drain("cold-launcher-defers", d, &[], tool(json!("Read"))).cold(),
        drain("cold-launcher-setting-off-env", a, &[("ANTIHALL_DEVSWARM_STABLE_LAUNCHER", "0")], tool(json!("Read"))).cold(),
        drain("cold-launcher-setting-off-file", a, &[], tool(json!("Read")))
            .cold()
            .seed(".anti-hall/settings.json", "{\"devswarm\":{\"stableLauncher\":false}}"),
        // Node acts here: the engine must not answer
        drain("unread-ndjson-node-nudges", Want::DeferNodeActs, &[], b()).store(3, 0),
        drain("unread-store-node-nudges", Want::DeferNodeActs, &[], b()).store(0, 2),
        drain("unread-both-node-nudges", Want::DeferNodeActs, &[], b()).store(2, 2),
        drain("nothing-unread-defers", d, &[], b()).store(0, 0),
    ];
    // the two drain-only seeds above need the throttle not to exist; a second Bash call after a nudge is Node's to throttle
    v.push(drain("read-primary-with-unread-is-silent", a, &[], bash("devswarm.js inbox read-primary")).store(3, 2));
    v.push(drain("subagent-with-unread-is-silent", a, &[], with(b(), "agent_id", json!("a1"))).store(3, 2));
    v.push(drain("non-bash-with-unread-is-silent", a, &[], tool(json!("Edit"))).store(3, 2));
    v
}

fn gate_cases() -> Vec<Case> {
    let (a, d) = (Want::Answer, Want::Defer);
    let stop = |x: Value| json!({"hook_event_name": "Stop", "session_id": "s1", "cwd": "/nonexistent-ds", "stop_hook_active": x});
    vec![
        gate("continuing-after-a-block", a, &[], stop(json!(true))),
        gate("continuing-with-unread-mail", a, &[], stop(json!(true))).store(3, 2),
        gate("continuing-without-descriptors", a, &[], stop(json!(true))),
        gate("continuing-setting-off-env-cold", a, &[("ANTIHALL_DEVSWARM_STABLE_LAUNCHER", "0")], stop(json!(true))).cold(),
        gate("continuing-setting-off-file-cold", a, &[], stop(json!(true)))
            .cold()
            .seed(".anti-hall/settings.json", "{\"devswarm\":{\"stableLauncher\":\"off\"}}"),
        gate("continuing-supervisor-on", a, &[("-DEVSWARM_REPO_ID", ""), ("ANTIHALL_DEVSWARM_SUPERVISOR", "on")], stop(json!(true))),
        gate("not-continuing-inert-answers", a, &[], stop(json!(false))),
        gate("flag-string-true-inert-answers", a, &[], stop(json!("true"))),
        gate("flag-one-inert-answers", a, &[], stop(json!(1))),
        gate("flag-null-inert-answers", a, &[], stop(Value::Null)),
        gate("flag-absent-defers", d, &[], json!({"hook_event_name": "Stop", "session_id": "s1"})),
        gate("cold-launchers-defer", d, &[], stop(json!(true))).cold(),
        gate("payload-array-defers", d, &[], json!([{"stop_hook_active": true}])),
        gate("payload-malformed-defers", d, &[], Value::Null).raw("{\"stop_hook_active\":true").cold(),
        gate("payload-empty-defers", d, &[], Value::Null).raw(""),
        gate("duplicate-key-last-wins", a, &[], Value::Null).raw("{\"hook_event_name\":\"Stop\",\"stop_hook_active\":false,\"stop_hook_active\":true}"),
        gate("duplicate-key-last-wins-false-defers", d, &[], Value::Null)
            .raw("{\"hook_event_name\":\"Stop\",\"stop_hook_active\":true,\"stop_hook_active\":false}"),
        // the gates the engine already answered stay answered
        gate("child-is-silent", a, &[("DEVSWARM_SOURCE_BRANCH", "feature/x")], stop(json!(true))),
        gate("inactive-is-silent", a, &[("-DEVSWARM_REPO_ID", "")], stop(json!(false))),
        gate("gate-switch-off", a, &[], stop(json!(false))).seed(".anti-hall/settings.json", "{\"devswarm\":{\"parentGate\":false}}"),
    ]
}

fn run_all(cases: Vec<Case>, min: usize, what: &str) {
    let _g = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
    assert!(cases.len() >= min, "the corpus needs at least {min} cases, has {}", cases.len());
    let (mut answers, mut defers) = (0, 0);
    for case in &cases {
        match exec(case) {
            "answer" => answers += 1,
            _ => defers += 1,
        }
    }
    eprintln!("{what} parity: {} cases, {answers} answered byte-identically to Node, {defers} deferred", cases.len());
}

#[test]
fn devswarm_child_drain_read_side_matches_node() {
    run_all(drain_cases(), 70, "devswarm-child-drain read-side");
}

#[test]
fn devswarm_parent_gate_read_side_matches_node() {
    run_all(gate_cases(), 18, "devswarm-parent-gate read-side");
}
