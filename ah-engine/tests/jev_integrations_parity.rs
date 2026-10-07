//! Node-vs-engine parity of the Jev calls the response checks make: the HTTP request each side sends (method, path, headers
//! and body) and the rows each side writes to the Jev decision log, for the same hook input.
//!
//! No real network and no real key: both sides run with an isolated home, ANTIHALL_INGEST_DRY_RUN=1, a made-up key and the
//! test endpoint override pointing at a loopback mock of their own (the override is honoured only for a loopback host).
//! The Node hook is the real `hooks/*.js`; the engine side is `ah-engine check <name>`, a one-shot process, so an ask that
//! nobody waits for goes through the detached `jev ask` child exactly as it does for a one-shot hook.
//!
//! Compared: the request line (method and path), every header except the HTTP client's own identity headers (see
//! `IDENTITY`) with the Authorization value masked, the body byte for byte, and every log row with its clock fields
//! (`ts`, `ms`) removed. Requests are sorted by body, since several detached asks race to the server.
#[path = "common/replies.rs"]
mod replies;

use replies::{asst, user};
use serde_json::{Value, json};
use std::collections::BTreeMap;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

/// The HTTP clients differ (Node's undici, the engine's ureq) in headers that name the client or its connection handling and
/// that carry no decision text or key; everything else must be equal.
const IDENTITY: &[&str] = &["host", "user-agent", "connection", "accept-encoding", "accept-language", "sec-fetch-mode", "accept", "keep-alive", "te"];

static SERIAL: Mutex<()> = Mutex::new(());
static N: AtomicUsize = AtomicUsize::new(0);

#[derive(Debug, Clone, PartialEq)]
struct Seen {
    line: String,
    headers: BTreeMap<String, String>,
    body: String,
}

struct Mock {
    port: u16,
    seen: Arc<Mutex<Vec<Seen>>>,
}

fn read_request(s: &mut TcpStream) -> Option<Seen> {
    s.set_read_timeout(Some(Duration::from_secs(5))).ok()?;
    let mut buf = Vec::new();
    let mut chunk = [0u8; 4096];
    let head_end = loop {
        let n = s.read(&mut chunk).ok()?;
        if n == 0 {
            return None;
        }
        buf.extend_from_slice(&chunk[..n]);
        if let Some(p) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
            break p + 4;
        }
    };
    let head = String::from_utf8_lossy(&buf[..head_end]).to_string();
    let mut lines = head.split("\r\n");
    let line = lines.next().unwrap_or("").to_string();
    let headers: BTreeMap<String, String> = lines.filter_map(|l| l.split_once(':').map(|(k, v)| (k.trim().to_ascii_lowercase(), v.trim().to_string()))).collect();
    let want: usize = headers.get("content-length").and_then(|v| v.parse().ok()).unwrap_or(0);
    while buf.len() < head_end + want {
        let n = s.read(&mut chunk).ok()?;
        if n == 0 {
            break;
        }
        buf.extend_from_slice(&chunk[..n]);
    }
    Some(Seen { line, headers, body: String::from_utf8_lossy(&buf[head_end..]).to_string() })
}

impl Mock {
    /// A loopback server that answers every request with a confident `noul` of `noul`.
    fn start(noul: f64) -> Mock {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let seen = Arc::new(Mutex::new(Vec::new()));
        let s2 = seen.clone();
        std::thread::spawn(move || {
            for conn in listener.incoming() {
                let Ok(mut c) = conn else { break };
                let Some(req) = read_request(&mut c) else { continue };
                s2.lock().unwrap().push(req);
                let body = format!(r#"{{"answers":{{"decision":{{"noul":{noul}}}}}}}"#);
                let out = format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len());
                let _ = c.write_all(out.as_bytes());
            }
        });
        Mock { port, seen }
    }
}

fn repo() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap().to_path_buf()
}

fn run(mut cmd: Command, input: &str) -> (i32, String, String) {
    cmd.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = cmd.spawn().unwrap();
    let mut stdin = child.stdin.take().unwrap();
    let input = input.as_bytes().to_vec();
    let w = std::thread::spawn(move || {
        let _ = stdin.write_all(&input);
    });
    let out = child.wait_with_output().unwrap();
    w.join().unwrap();
    (out.status.code().unwrap_or(-1), String::from_utf8_lossy(&out.stdout).into_owned(), String::from_utf8_lossy(&out.stderr).into_owned())
}

/// What one scenario feeds both sides.
struct Scenario {
    name: &'static str,
    hook: &'static str,
    check: &'static str,
    env: Vec<(&'static str, &'static str)>,
    transcript: Vec<String>,
    payload: Value,
    /// How many requests each side must have sent.
    requests: usize,
    /// How many log rows each side must have written.
    rows: usize,
    /// The confidence-weighted `noul` the mock answers with (0.97: confidently true; 0.03: confidently false).
    noul: f64,
    /// Row fields that may differ on purpose (D36: Jev never removes a block or advisory, so the engine's `advisory` trust
    /// keeps a `true` baseline where Node's lowers it).
    deviation: &'static [&'static str],
    /// The `jevIntegrations` modes written to the home's settings.json (`""`: none, so every integration is at its default).
    modes: &'static str,
    /// Files under the home (relative paths) whose content must be the same on both sides, ts and ms removed.
    files: &'static [&'static str],
    /// Files seeded into the home before the hook runs.
    seed: &'static [(&'static str, &'static str)],
}

struct Side {
    out: (i32, String, String),
    requests: Vec<Seen>,
    rows: Vec<Value>,
    /// The hook's own files that the scenario compares (`Scenario::files`), clock fields removed.
    files: Vec<String>,
}

fn run_side(sc: &Scenario, engine: bool) -> Side {
    let n = N.fetch_add(1, Ordering::Relaxed);
    let home = std::env::temp_dir().join(format!("ah-jevpar-{}-{n}", std::process::id()));
    let _ = std::fs::remove_dir_all(&home);
    let cwd = home.join("proj");
    std::fs::create_dir_all(&cwd).unwrap();
    std::fs::create_dir_all(home.join(".anti-hall")).unwrap();
    if !sc.modes.is_empty() {
        std::fs::write(home.join(".anti-hall/settings.json"), sc.modes).unwrap();
    }
    for (rel, body) in sc.seed {
        let f = home.join(rel);
        std::fs::create_dir_all(f.parent().unwrap()).unwrap();
        std::fs::write(f, body).unwrap();
    }
    let t = home.join("transcript.jsonl");
    std::fs::write(&t, sc.transcript.join("\n") + "\n").unwrap();
    let mock = Mock::start(sc.noul);
    let mut payload = sc.payload.clone();
    payload["transcript_path"] = json!(t.to_string_lossy());
    let mut c = if engine {
        let mut c = Command::new(env!("CARGO_BIN_EXE_ah-engine"));
        c.arg("check").arg(sc.check).env("AH_ENGINE_DIR", home.join("engine-state"));
        c
    } else {
        let mut c = Command::new("node");
        c.arg(repo().join("plugins/anti-hall/hooks").join(sc.hook));
        c
    };
    c.env_clear()
        .env("PATH", std::env::var("PATH").unwrap_or_default())
        .env("HOME", &home)
        .env("USERPROFILE", &home)
        .env("ANTIHALL_TEST_ISOLATION", "1")
        .env("ANTIHALL_INGEST_DRY_RUN", "1")
        .env("ANTIHALL_JEV", "1")
        .env("CLAUDE_PLUGIN_OPTION_JEV_VERCEL_API_KEY", "parity-test-key-not-real")
        .env("ANTIHALL_JEV_TEST_ENDPOINT_VERCEL", format!("http://127.0.0.1:{}/v1/systemone", mock.port))
        .current_dir(&cwd);
    for (k, v) in &sc.env {
        c.env(k, v);
    }
    let out = run(c, &payload.to_string());
    let log = home.join(".anti-hall/logs/jev-assist.ndjson");
    let rows_of = || -> Vec<Value> { std::fs::read_to_string(&log).unwrap_or_default().lines().filter_map(|l| serde_json::from_str(l).ok()).collect() };
    // the asks nobody waits for finish after the hook has returned: wait until everything expected has arrived
    let end = Instant::now() + Duration::from_secs(20);
    while Instant::now() < end && (mock.seen.lock().unwrap().len() < sc.requests || rows_of().len() < sc.rows) {
        std::thread::sleep(Duration::from_millis(25));
    }
    std::thread::sleep(Duration::from_millis(150)); // and a moment for anything extra, which would be a difference
    let requests = mock.seen.lock().unwrap().clone();
    let rows = rows_of();
    let files = sc
        .files
        .iter()
        .map(|rel| {
            let text = std::fs::read_to_string(home.join(rel)).unwrap_or_else(|_| "<absent>".into());
            text.lines().map(|l| serde_json::from_str::<Value>(l).map_or(l.to_string(), |v| normalise_row(&v, &[]).to_string())).collect::<Vec<_>>().join("\n")
        })
        .collect();
    let _ = std::fs::remove_dir_all(&home);
    Side { out, requests, rows, files }
}

fn normalise_request(s: &Seen) -> (String, BTreeMap<String, String>, String) {
    let mut h: BTreeMap<String, String> = s.headers.iter().filter(|(k, _)| !IDENTITY.contains(&k.as_str())).map(|(k, v)| (k.clone(), v.clone())).collect();
    if let Some(a) = h.get_mut("authorization") {
        *a = a.split_whitespace().next().unwrap_or("").to_string() + " <key>";
    }
    // `POST /v1/systemone HTTP/1.1`: the protocol token is the client's business
    let line = s.line.rsplit_once(' ').map_or(s.line.clone(), |(a, _)| a.to_string());
    (line, h, s.body.clone())
}

fn normalise_row(r: &Value, deviation: &[&str]) -> Value {
    let mut r = r.clone();
    let o = r.as_object_mut().unwrap();
    o.remove("ts");
    o.remove("ms");
    for k in deviation {
        o.remove(*k);
    }
    r
}

fn compare(sc: &Scenario) {
    let node = run_side(sc, false);
    let eng = run_side(sc, true);
    let who = sc.name;
    assert_eq!((node.out.0, &node.out.1, &node.out.2), (eng.out.0, &eng.out.1, &eng.out.2), "{who}: hook output differs");
    let sort = |v: &[Seen]| {
        let mut n: Vec<_> = v.iter().map(normalise_request).collect();
        n.sort_by(|a, b| a.2.cmp(&b.2));
        n
    };
    let (nr, er) = (sort(&node.requests), sort(&eng.requests));
    assert_eq!(nr.len(), sc.requests, "{who}: node sent {} requests, expected {}", nr.len(), sc.requests);
    assert_eq!(nr, er, "{who}: the requests differ");
    let rows = |s: &Side| {
        let mut v: Vec<String> = s.rows.iter().map(|r| normalise_row(r, sc.deviation).to_string()).collect();
        v.sort();
        v
    };
    assert_eq!(node.rows.len(), sc.rows, "{who}: node wrote {} rows, expected {}", node.rows.len(), sc.rows);
    assert_eq!(rows(&node), rows(&eng), "{who}: the decision-log rows differ");
    assert_eq!(node.files, eng.files, "{who}: the compared files differ ({:?})", sc.files);
    if !sc.deviation.is_empty() {
        // the deviation is exactly D36's: the engine never lowers a `true` baseline, Node's advisory trust does
        assert!(eng.rows.iter().all(|r| r["final"] == json!(true)) && node.rows.iter().all(|r| r["final"] == json!(false)), "{who}: the deviation is not the D36 one");
    }
}

fn stop(session: &str) -> Value {
    json!({"hook_event_name":"Stop","session_id":session,"cwd":"/tmp"})
}

fn claim_transcript() -> Vec<String> {
    vec![user("go"), asst("I ran 12 files and 3 tests today, commit abcdef1234567 landed")]
}

fn post_bash(command: &str, output: &str) -> Value {
    json!({"hook_event_name":"PostToolUse","tool_name":"Bash","session_id":"pv","cwd":"/tmp","tool_input":{"command":command},"tool_response":{"stdout":output}})
}

fn merge(cmd: &str) -> Value {
    json!({"hook_event_name":"PreToolUse","tool_name":"Bash","session_id":"mg","cwd":"/tmp","tool_input":{"command":cmd}})
}

fn stop_with(session: &str, reply: &str) -> Value {
    json!({"hook_event_name":"Stop","session_id":session,"cwd":"/tmp","last_assistant_message":reply})
}

const SPEC_FILES: &[&str] = &[".anti-hall/logs/jev-judge.ndjson", ".anti-hall/speculation-guard-state-sp.json"];

fn spec(name: &'static str, reply: &str, noul: f64, modes: &'static str, requests: usize, rows: usize, seed: &'static [(&'static str, &'static str)]) -> Scenario {
    Scenario {
        name,
        hook: "speculation-guard.js",
        check: "speculation-guard",
        env: vec![],
        transcript: vec![user("go")],
        payload: stop_with("sp", reply),
        requests,
        rows,
        noul,
        deviation: &[],
        modes,
        files: SPEC_FILES,
        seed,
    }
}

fn scenarios() -> Vec<Scenario> {
    let mixed = "Tests:  2 failed, 8 passed, 10 total\nPASS src/a.test.js\nFAIL src/b.test.js";
    vec![
        spec("speculation: a long reply is cut to the same 8000 units", &format!("{} it is probably fine", "word ".repeat(1700)), 0.97, "", 1, 1, &[]),
        spec("speculation: Jev confidently adds a block", "All done, it works.", 0.97, "", 1, 1, &[]),
        spec("speculation: Jev says grounded, the regex block stands", "It is probably the cache.", 0.03, "", 1, 1, &[]),
        spec("speculation: Jev says speculative on a hedge too", "It is probably the cache.", 0.97, "", 1, 1, &[]),
        spec("speculation: framed hit asks twice and shadow keeps the block", "Should be blocked: X probably fails", 0.03, "", 2, 2, &[]),
        spec(
            "speculation: framed hit relaxed in on mode",
            "Should be blocked: X probably fails",
            0.03,
            r#"{"jevIntegrations":{"speculationFramed":"on"}}"#,
            2,
            2,
            &[],
        ),
        spec(
            "speculation: the Stop after a block reports its outcome",
            "I haven't checked yet.",
            0.03,
            "",
            1,
            2,
            &[(".anti-hall/speculation-guard-state-sp.json", r#"{"hash":"old","blocks":1,"pending":{"h":"abc123","source":"jev"}}"#)],
        ),
        spec("speculation: integration off logs the off row", "It is probably the cache.", 0.97, r#"{"jevIntegrations":{"speculation":"off"}}"#, 0, 1, &[]),
        spec("speculation: loop-safe asks nothing", "It is probably the cache.", 0.97, "", 0, 0, &[(".anti-hall/speculation-guard-state-sp.json", r#"{"hash":"750370cdc2d22d0fbff359cb4d01da213431e939","blocks":1,"pending":null}"#)]),
        Scenario { name: "claimLedger shadow, three flags", hook: "claim-ledger.js", check: "claim-ledger", env: vec![], transcript: claim_transcript(), payload: stop("s1"), requests: 3, rows: 3, noul: 0.97, deviation: &[], modes: "", files: &[], seed: &[] },
        Scenario { name: "claimLedger on", hook: "claim-ledger.js", check: "claim-ledger", env: vec![], transcript: claim_transcript(), payload: stop("s2"), requests: 3, rows: 3, noul: 0.97, deviation: &[], modes: r#"{"jevIntegrations":{"claimLedger":"on"}}"#, files: &[], seed: &[] },
        Scenario { name: "claimLedger on, Jev confidently disagrees: relax-block relaxes as in Node", hook: "claim-ledger.js", check: "claim-ledger", env: vec![], transcript: claim_transcript(), payload: stop("s5"), requests: 3, rows: 3, noul: 0.03, deviation: &[], modes: r#"{"jevIntegrations":{"claimLedger":"on"}}"#, files: &[], seed: &[] },
        Scenario { name: "claimLedger off writes the off rows", hook: "claim-ledger.js", check: "claim-ledger", env: vec![("ANTIHALL_JEV_CLAIM_LEDGER", "0")], transcript: claim_transcript(), payload: stop("s3"), requests: 0, rows: 3, noul: 0.97, deviation: &[], modes: "", files: &[], seed: &[] },
        Scenario { name: "claimLedger with Jev disabled", hook: "claim-ledger.js", check: "claim-ledger", env: vec![("ANTIHALL_JEV", "0")], transcript: claim_transcript(), payload: stop("s4"), requests: 0, rows: 3, noul: 0.97, deviation: &[], modes: "", files: &[], seed: &[] },
        Scenario { name: "outputVerifyGuard mixed run", hook: "output-verify-guard.js", check: "output-verify-guard", env: vec![], transcript: vec![user("run the tests")], payload: post_bash("npm test", mixed), requests: 1, rows: 1, noul: 0.97, deviation: &[], modes: "", files: &[], seed: &[] },
        Scenario {
            name: "outputVerifyGuard long output is cut to the same window",
            hook: "output-verify-guard.js",
            check: "output-verify-guard",
            env: vec![],
            transcript: vec![user("run the tests")],
            payload: post_bash("npm test", &format!("PASS first\n{}\nFAIL last 2 failed", "x".repeat(6000))),
            requests: 1,
            rows: 1,
            noul: 0.97,
            deviation: &[],
            modes: "",
            files: &[],
            seed: &[],
        },
        Scenario { name: "outputVerifyGuard clean run", hook: "output-verify-guard.js", check: "output-verify-guard", env: vec![], transcript: vec![user("run the tests")], payload: post_bash("cargo test", "test result: ok. 5 passed; 0 failed"), requests: 1, rows: 1, noul: 0.97, deviation: &[], modes: "", files: &[], seed: &[] },
        Scenario {
            name: "outputVerifyGuard on, Jev disagrees with the regex (D36 deviation)",
            hook: "output-verify-guard.js",
            check: "output-verify-guard",
            env: vec![],
            transcript: vec![user("run the tests")],
            payload: post_bash("npm test", mixed),
            requests: 1,
            rows: 1,
            noul: 0.03,
            deviation: &["final", "changed", "wouldChange"],
            modes: r#"{"jevIntegrations":{"outputVerifyGuard":"on"}}"#,
            files: &[],
            seed: &[],
        },
        Scenario { name: "outputVerifyGuard off", hook: "output-verify-guard.js", check: "output-verify-guard", env: vec![("ANTIHALL_JEV_OUTPUT_VERIFY_GUARD", "0")], transcript: vec![user("run the tests")], payload: post_bash("npm test", mixed), requests: 0, rows: 1, noul: 0.97, deviation: &[], modes: "", files: &[], seed: &[] },
        Scenario { name: "mergeGateHedge unresolved", hook: "merge-gate.js", check: "merge-gate", env: vec![("ANTIHALL_MERGE_GATE", "1")], transcript: vec![asst("this is a first-pass, pending review"), user("ok")], payload: merge("gh pr merge 5"), requests: 1, rows: 1, noul: 0.97, deviation: &[], modes: "", files: &[], seed: &[] },
        Scenario {
            name: "mergeGateHedge resolved is skipped with a row",
            hook: "merge-gate.js",
            check: "merge-gate",
            env: vec![("ANTIHALL_MERGE_GATE", "1")],
            transcript: vec![asst("first-pass, pending review"), user("owner approved, go")],
            payload: merge("gh pr merge 5"),
            requests: 0,
            rows: 1,
            noul: 0.97,
            deviation: &[],
            modes: "",
            files: &[],
            seed: &[],
        },
        Scenario {
            name: "mergeGateHedge long text keeps the last 4000 characters",
            hook: "merge-gate.js",
            check: "merge-gate",
            env: vec![("ANTIHALL_MERGE_GATE", "1")],
            transcript: vec![asst(&format!("{} pending review {}", "a".repeat(5000), "b".repeat(100)))],
            payload: merge("gh pr merge 5"),
            requests: 1,
            rows: 1,
            noul: 0.97,
            deviation: &[],
            modes: "",
            files: &[],
            seed: &[],
        },
        Scenario { name: "mergeGateHedge off", hook: "merge-gate.js", check: "merge-gate", env: vec![("ANTIHALL_MERGE_GATE", "1"), ("ANTIHALL_JEV_MERGE_GATE_HEDGE", "0")], transcript: vec![asst("do not merge")], payload: merge("gh pr merge 5"), requests: 0, rows: 1, noul: 0.97, deviation: &[], modes: "", files: &[], seed: &[] },
        Scenario { name: "mergeGateHedge without a hedge asks nothing", hook: "merge-gate.js", check: "merge-gate", env: vec![("ANTIHALL_MERGE_GATE", "1")], transcript: vec![asst("all done")], payload: merge("gh pr merge 5"), requests: 0, rows: 0, noul: 0.97, deviation: &[], modes: "", files: &[], seed: &[] },
    ]
}

#[test]
fn the_requests_and_the_decision_rows_are_the_same_as_the_node_hooks() {
    let _g = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
    for sc in scenarios() {
        compare(&sc);
    }
}
