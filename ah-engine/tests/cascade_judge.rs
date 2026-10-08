//! The Jev-first cascade through the engine binary (`ah-engine jev ask --json`), with no real model and no real Jev: a loopback
//! server plays Jev, a FAKE `claude` first on PATH records its argv and stdin and prints a canned answer. Covers what the unit
//! tests cannot: the real CLI argv (model alias `haiku`, isolated flags), the prompt bytes the model is given, the telemetry
//! row and the switches (per-integration, global kill switch, show-Jev-answer).
#![allow(clippy::unwrap_used, clippy::expect_used)] // a test crate: a panic is the failure report, and E2 exempts tests

use serde_json::{Value, json};
use std::io::{Read, Write};
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::Mutex;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Duration;

static N: AtomicUsize = AtomicUsize::new(0);
static SERIAL: Mutex<()> = Mutex::new(());

fn scratch(tag: &str) -> PathBuf {
    let d = std::env::temp_dir().join(format!("ah-cascade-it-{tag}-{}-{}", std::process::id(), N.fetch_add(1, Ordering::Relaxed)));
    ah_engine::discard::harmless(std::fs::remove_dir_all(&d));
    std::fs::create_dir_all(&d).unwrap();
    d.canonicalize().unwrap()
}

fn fake_bin(dir: &Path) {
    let script = "#!/bin/sh\nd=\"$FAKE_CLAUDE_LOG/call-$$\"\nmkdir -p \"$d\"\nfor a in \"$@\"; do printf '%s\\0' \"$a\"; done > \"$d/argv\"\ncat > \"$d/stdin\"\ncat \"$FAKE_CLAUDE_REPLY\"\n";
    let p = dir.join("claude");
    std::fs::write(&p, script).unwrap();
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o755)).unwrap();
}

/// A loopback Jev answering every call with a Noul probability.
fn jev_server(answers: Value) -> u16 {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    std::thread::spawn(move || {
        for conn in listener.incoming() {
            let Ok(mut c) = conn else { break };
            c.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
            let mut buf = Vec::new();
            let mut chunk = [0u8; 4096];
            while let Ok(n) = c.read(&mut chunk) {
                if n == 0 {
                    break;
                }
                buf.extend_from_slice(&chunk[..n]);
                let Some(h) = buf.windows(4).position(|w| w == b"\r\n\r\n") else { continue };
                let head = String::from_utf8_lossy(&buf[..h]).to_ascii_lowercase();
                let want: usize = head.lines().find_map(|l| l.strip_prefix("content-length:")).and_then(|v| v.trim().parse().ok()).unwrap_or(0);
                if buf.len() >= h + 4 + want {
                    break;
                }
            }
            let body = json!({"answers": answers, "usage": {"input_tokens": 9, "output_tokens": 1}}).to_string();
            let out = format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len());
            ah_engine::discard::harmless(c.write_all(out.as_bytes()));
        }
    });
    port
}

struct Run {
    decision: Value,
    argv: Vec<Vec<String>>,
    stdin: Vec<String>,
    telemetry: Vec<Value>,
}

/// One `jev ask` of integration `claimLedger` (a yes/no question) against a Jev that says `noul`, with the model replying
/// `model_reply`; `extra` are more environment variables.
fn ask(noul: f64, model_reply: &str, extra: &[(&str, &str)]) -> Run {
    let home = scratch("run");
    std::fs::create_dir_all(home.join("bin")).unwrap();
    std::fs::create_dir_all(home.join("tmp")).unwrap();
    fake_bin(&home.join("bin"));
    let reply = home.join("reply.txt");
    std::fs::write(&reply, json!({"type": "result", "is_error": false, "result": model_reply}).to_string()).unwrap();
    let port = jev_server(json!({"decision": {"noul": noul}}));
    let mut cmd = Command::new(env!("CARGO_BIN_EXE_ah-engine"));
    cmd.args(["jev", "ask", "--json"])
        .env_clear()
        .env("PATH", format!("{}:{}", home.join("bin").display(), std::env::var("PATH").unwrap_or_default()))
        .env("HOME", &home)
        .env("USERPROFILE", &home)
        .env("TMPDIR", home.join("tmp"))
        .env("AH_ENGINE_DIR", home.join("engine-state"))
        .env("ANTIHALL_TEST_ISOLATION", "1")
        .env("ANTIHALL_INGEST_DRY_RUN", "1")
        .env("ANTIHALL_JEV", "1")
        .env("CLAUDE_PLUGIN_OPTION_JEV_VERCEL_API_KEY", "cascade-test-key-not-real")
        .env("ANTIHALL_JEV_TEST_ENDPOINT_VERCEL", format!("http://127.0.0.1:{port}/v1/systemone"))
        .env("FAKE_CLAUDE_LOG", home.join("calls"))
        .env("FAKE_CLAUDE_REPLY", &reply)
        .current_dir(&home)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    for (k, v) in extra {
        cmd.env(k, v);
    }
    let line = json!({
        "id": "claimLedger",
        "question": {"type": "noul", "instructions": "Is the claim unsupported?", "criteria": {"true": "unsupported", "false": "supported"}},
        "state": "the build is slow because of the cache",
        "trust": "add-block",
        "baseline": false
    });
    let mut child = cmd.spawn().unwrap();
    child.stdin.take().unwrap().write_all(format!("{line}\n").as_bytes()).unwrap();
    let out = child.wait_with_output().unwrap();
    assert_eq!(out.status.code(), Some(0), "{}", String::from_utf8_lossy(&out.stderr));
    let decision: Value = serde_json::from_str(String::from_utf8_lossy(&out.stdout).lines().next().unwrap()).unwrap();
    let mut dirs: Vec<PathBuf> = std::fs::read_dir(home.join("calls")).map(|rd| rd.flatten().map(|e| e.path()).collect()).unwrap_or_default();
    dirs.sort();
    let argv = dirs
        .iter()
        .map(|d| {
            let raw = std::fs::read(d.join("argv")).unwrap();
            let mut v: Vec<String> = raw.split(|b| *b == 0).map(|a| String::from_utf8_lossy(a).into_owned()).collect();
            v.pop();
            v
        })
        .collect();
    let stdin = dirs.iter().map(|d| String::from_utf8_lossy(&std::fs::read(d.join("stdin")).unwrap()).into_owned()).collect();
    let telemetry = std::fs::read_to_string(home.join(".anti-hall/logs/judge-calls.ndjson"))
        .unwrap_or_default()
        .lines()
        .map(|l| serde_json::from_str(l).unwrap())
        .collect();
    ah_engine::discard::harmless(std::fs::remove_dir_all(&home));
    Run { decision, argv, stdin, telemetry }
}

const ON: (&str, &str) = ("ANTIHALL_JEV_CASCADE_CLAIM_LEDGER", "1");

#[test]
fn an_unsure_jev_answer_is_rejudged_by_the_cli_with_the_alias_and_jevs_answer_shown() {
    let _g = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
    // Jev: noul 0.8 -> true at confidence 0.6, under the 0.85 act threshold
    let r = ask(0.8, r#"{"answer":false,"confidence":0.95}"#, &[ON]);
    assert_eq!(r.argv.len(), 1, "one model call");
    let a = &r.argv[0];
    let at = |flag: &str| a.iter().position(|x| x == flag).map(|i| a[i + 1].clone()).unwrap();
    assert_eq!(at("--model"), "haiku", "the alias from settings, never a pinned version");
    assert!(a.contains(&"-p".to_string()) && a.contains(&"--strict-mcp-config".to_string()) && a.contains(&"{\"disableAllHooks\":true}".to_string()));
    assert!(at("--system-prompt").starts_with("You are the second opinion"));
    assert!(
        r.stdin[0].starts_with("QUESTION:\nIs the claim unsupported?\n\nALLOWED ANSWERS:\nfalse: supported\ntrue: unsupported\n")
            || r.stdin[0].contains("ALLOWED ANSWERS:"),
        "{}",
        r.stdin[0]
    );
    assert!(r.stdin[0].contains("EVIDENCE:\nthe build is slow because of the cache"), "{}", r.stdin[0]);
    assert!(r.stdin[0].contains("FIRST CLASSIFIER ANSWERED: true (confidence 0.6"), "{}", r.stdin[0]);
    assert_eq!((r.decision["jev"].clone(), r.decision["confidence"].clone()), (json!(false), json!(0.95)), "the model's answer replaced Jev's");
    let t = &r.telemetry[0];
    assert_eq!(
        (t["backend"].as_str(), t["model"].as_str(), t["jevAnswer"].as_str(), t["haikuAnswer"].as_str(), t["agree"].as_bool()),
        (Some("cascade"), Some("haiku"), Some("true"), Some("false"), Some(false))
    );
    assert_eq!((t["jevConfidence"].as_f64().map(|c| (c * 10.0).round()), t["showJevAnswer"].as_bool(), t["error"].is_null()), (Some(6.0), Some(true), true));
    assert!(t["addedMs"].is_u64() && t["ms"].is_u64() && t["integration"] == "claimLedger");
}

#[test]
fn hiding_jevs_answer_the_kill_switch_a_confident_jev_and_an_off_integration_behave() {
    let _g = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
    let blind = ask(0.8, r#"{"answer":true,"confidence":0.9}"#, &[ON, ("ANTIHALL_JEV_CASCADE_SHOW_JEV_ANSWER", "0")]);
    assert!(!blind.stdin[0].contains("FIRST CLASSIFIER"), "{}", blind.stdin[0]);
    assert_eq!((blind.telemetry[0]["showJevAnswer"].as_bool(), blind.telemetry[0]["agree"].as_bool()), (Some(false), Some(true)));
    for (why, noul, extra) in [
        ("confident jev", 0.99, vec![ON]),
        ("integration off", 0.8, vec![]),
        ("global kill switch", 0.8, vec![ON, ("ANTIHALL_JEV_CASCADE", "0")]),
        ("integration env off", 0.8, vec![("ANTIHALL_JEV_CASCADE_CLAIM_LEDGER", "0")]),
    ] {
        let r = ask(noul, r#"{"answer":false,"confidence":0.95}"#, &extra);
        assert!(r.argv.is_empty() && r.telemetry.is_empty(), "{why}: the model must not be called");
    }
}

#[test]
fn a_model_that_answers_nonsense_leaves_jevs_answer_and_an_error_row() {
    let _g = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
    let r = ask(0.8, "I cannot say", &[ON]);
    assert_eq!(r.decision["jev"], json!(true));
    assert_eq!((r.telemetry[0]["error"].as_str(), r.telemetry[0]["haikuAnswer"].is_null()), (Some("answer"), true));
}

#[test]
fn triage_with_the_cascade_backend_rejudges_a_label_jev_was_unsure_of() {
    let _g = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
    let home = scratch("triage");
    std::fs::create_dir_all(home.join("bin")).unwrap();
    std::fs::create_dir_all(home.join("tmp")).unwrap();
    fake_bin(&home.join("bin"));
    let reply = home.join("reply.txt");
    std::fs::write(&reply, json!({"type": "result", "is_error": false, "result": r#"{"answer":"blocker","confidence":0.97}"#}).to_string()).unwrap();
    // kind: Jev is unsure (0.5 < 0.85); urgency: confident normal (noul 0.01 -> false at 0.98)
    let port = jev_server(json!({"kind": {"choice": "fyi", "confidence": 0.5}, "urgency": {"noul": 0.01}}));
    let mut cmd = Command::new(env!("CARGO_BIN_EXE_ah-engine"));
    cmd.args(["jev", "triage"])
        .env_clear()
        .env("PATH", format!("{}:{}", home.join("bin").display(), std::env::var("PATH").unwrap_or_default()))
        .env("HOME", &home)
        .env("USERPROFILE", &home)
        .env("TMPDIR", home.join("tmp"))
        .env("AH_ENGINE_DIR", home.join("engine-state"))
        .env("ANTIHALL_TEST_ISOLATION", "1")
        .env("ANTIHALL_INGEST_DRY_RUN", "1")
        .env("ANTIHALL_JEV", "1")
        .env("ANTIHALL_JEV_TRIAGE_BACKEND", "cascade")
        .env("CLAUDE_PLUGIN_OPTION_JEV_VERCEL_API_KEY", "cascade-test-key-not-real")
        .env("ANTIHALL_JEV_TEST_ENDPOINT_VERCEL", format!("http://127.0.0.1:{port}/v1/systemone"))
        .env("FAKE_CLAUDE_LOG", home.join("calls"))
        .env("FAKE_CLAUDE_REPLY", &reply)
        .current_dir(&home)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = cmd.spawn().unwrap();
    let input = json!({"items": [{"hash": "h1", "text": "I am blocked on the merge"}], "timeoutMs": 20000, "urgentThreshold": 0.9});
    child.stdin.take().unwrap().write_all(input.to_string().as_bytes()).unwrap();
    let out = child.wait_with_output().unwrap();
    let v: Value = serde_json::from_str(&String::from_utf8_lossy(&out.stdout)).unwrap();
    assert_eq!(
        (v["h1"]["kind"].as_str(), v["h1"]["urgency"].as_str(), v["h1"]["backend"].as_str()),
        (Some("blocker"), Some("normal"), Some("jev+haiku")),
        "{v}"
    );
    let calls = std::fs::read_dir(home.join("calls")).unwrap().count();
    assert_eq!(calls, 1, "only the unsure label went to the model");
    let rows: Vec<Value> =
        std::fs::read_to_string(home.join(".anti-hall/logs/judge-calls.ndjson")).unwrap().lines().map(|l| serde_json::from_str(l).unwrap()).collect();
    let esc = rows.iter().find(|r| r["backend"] == "cascade").unwrap();
    assert_eq!(
        (esc["integration"].as_str(), esc["jevAnswer"].as_str(), esc["haikuAnswer"].as_str(), esc["agree"].as_bool()),
        (Some("triage"), Some("fyi"), Some("blocker"), Some(false))
    );
    ah_engine::discard::harmless(std::fs::remove_dir_all(&home));
}
