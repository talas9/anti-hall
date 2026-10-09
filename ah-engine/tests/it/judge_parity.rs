//! Node-vs-engine parity for the LLM judge calls the engine makes itself (`src/judge/`): the speculation-judge Stop check
//! through the Claude CLI, and `ah-engine jev triage` against `hooks/lib/jev-triage-worker.js`.
//!
//! No real model is ever called. A FAKE `claude` first on PATH records each call (argv, stdin, working directory, the
//! judge-child marker, the environment's variable names) and prints a canned answer; a loopback server plays Jev; the
//! Node worker's Anthropic API call is answered by a `node -r` stub of `https.request`. Each case runs the real Node hook
//! and the engine binary with their own isolated homes and compares what they print, the state they leave and every byte
//! they send to the model.

use serde_json::{Value, json};
use std::collections::BTreeMap;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

static N: AtomicUsize = AtomicUsize::new(0);
/// The cases spawn real processes; one at a time keeps the machine calm.
static SERIAL: Mutex<()> = Mutex::new(());

fn repo() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap().to_path_buf()
}

fn scratch(tag: &str) -> PathBuf {
    let d = std::env::temp_dir().join(format!("ah-judgepar-{tag}-{}-{}", std::process::id(), N.fetch_add(1, Ordering::Relaxed)));
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
    let out = child.wait_with_output().unwrap();
    w.join().unwrap();
    (out.status.code().unwrap_or(-1), String::from_utf8_lossy(&out.stdout).into_owned(), String::from_utf8_lossy(&out.stderr).into_owned())
}

// ---- the fake claude -------------------------------------------------------------------------------------------

/// Write the fake `claude` into `dir`. Each call gets `$FAKE_CLAUDE_LOG/call-<pid>/` with `argv` (NUL-separated), `stdin`,
/// `cwd` (physical), `child` (the judge-child marker) and `envnames`; it then sleeps `$FAKE_CLAUDE_SLEEP` seconds if set,
/// prints the file `$FAKE_CLAUDE_REPLY` and exits with `$FAKE_CLAUDE_EXIT`.
fn fake_bin(dir: &Path) {
    let script = r#"#!/bin/sh
d="$FAKE_CLAUDE_LOG/call-$$"
mkdir -p "$d"
for a in "$@"; do printf '%s\0' "$a"; done > "$d/argv"
cat > "$d/stdin"
pwd -P > "$d/cwd"
printf '%s' "$ANTIHALL_JUDGE_CHILD" > "$d/child"
env | sed 's/=.*//' | sort > "$d/envnames"
if [ -n "$FAKE_CLAUDE_SLEEP" ]; then sleep "$FAKE_CLAUDE_SLEEP"; fi
cat "$FAKE_CLAUDE_REPLY"
exit "${FAKE_CLAUDE_EXIT:-0}"
"#;
    let p = dir.join("claude");
    std::fs::write(&p, script).unwrap();
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o755)).unwrap();
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct Call {
    argv: Vec<String>,
    stdin: Vec<u8>,
    cwd: String,
    child: String,
    envnames: Vec<String>,
}

fn calls(log: &Path) -> Vec<Call> {
    let Ok(rd) = std::fs::read_dir(log) else { return Vec::new() };
    // in the order the calls were made (a directory is named by the fake's pid, which is not ordered)
    let mut dirs: Vec<PathBuf> = rd.flatten().map(|e| e.path()).collect();
    dirs.sort_by_key(|d| std::fs::metadata(d.join("argv")).and_then(|m| m.modified()).ok());
    dirs.iter()
        .map(|d| {
            let read = |n: &str| std::fs::read(d.join(n)).unwrap_or_default();
            let argv = read("argv").split(|b| *b == 0).map(|a| String::from_utf8_lossy(a).into_owned()).collect::<Vec<_>>();
            Call {
                argv: argv[..argv.len().saturating_sub(1)].to_vec(),
                stdin: read("stdin"),
                cwd: String::from_utf8_lossy(&read("cwd")).trim().to_string(),
                child: String::from_utf8_lossy(&read("child")).into_owned(),
                envnames: String::from_utf8_lossy(&read("envnames")).lines().map(str::to_string).collect(),
            }
        })
        .collect()
}

/// Every file under `dir` (a home's `.anti-hall`) except the engine's own state and its judge telemetry (Node writes none).
fn tree(home: &Path) -> BTreeMap<String, String> {
    fn walk(root: &Path, dir: &Path, out: &mut BTreeMap<String, String>) {
        let Ok(rd) = std::fs::read_dir(dir) else { return };
        for e in rd.flatten() {
            let p = e.path();
            if p.is_dir() {
                walk(root, &p, out);
            } else {
                let rel = p.strip_prefix(root).unwrap().to_string_lossy().into_owned();
                if rel.starts_with("engine-state") || rel.ends_with("judge-calls.ndjson") || rel == "transcript.jsonl" {
                    continue;
                }
                out.insert(rel, String::from_utf8_lossy(&std::fs::read(&p).unwrap()).into_owned());
            }
        }
    }
    let mut out = BTreeMap::new();
    walk(home, home, &mut out);
    out
}

fn telemetry(home: &Path) -> Vec<Value> {
    std::fs::read_to_string(home.join(".anti-hall/logs/judge-calls.ndjson")).unwrap_or_default().lines().map(|l| serde_json::from_str(l).unwrap()).collect()
}

// ---- speculation-judge --------------------------------------------------------------------------------------------

struct JudgeCase {
    name: &'static str,
    env: Vec<(&'static str, String)>,
    transcript: Vec<String>,
    payload: Value,
    /// What the fake claude prints.
    reply: String,
    exit: i32,
    /// How many times the same payload is sent (the second one exercises the loop safety).
    steps: usize,
    seed: Vec<(&'static str, String)>,
    /// How many model calls each side must make.
    calls: usize,
    /// True when the hook must block (on the first step).
    blocks: bool,
}

impl JudgeCase {
    fn new(name: &'static str, reply: &str) -> JudgeCase {
        JudgeCase {
            name,
            env: Vec::new(),
            transcript: evidence_transcript(),
            payload: json!({"hook_event_name": "Stop", "session_id": "s1", "last_assistant_message": "The cause is the stale build artifact."}),
            reply: reply.to_string(),
            exit: 0,
            steps: 1,
            seed: Vec::new(),
            calls: 1,
            blocks: false,
        }
    }
}

/// The CLI's JSON envelope around a model answer.
fn envelope(result: &str) -> String {
    json!({"type": "result", "subtype": "success", "is_error": false, "duration_ms": 1234, "result": result, "session_id": "x", "total_cost_usd": 0.001})
        .to_string()
}

fn evidence_transcript() -> Vec<String> {
    vec![
        json!({"type":"user","message":{"role":"user","content":"why is the build slow? here is the log:\n```\nstep 1 took 40s\n```\n"}}).to_string(),
        json!({"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"Checking."},{"type":"tool_use","id":"t1","name":"Bash","input":{"command":"ls -la build/","description":"list"}}]}}).to_string(),
        json!({"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"t1","content":"total 8\n-rw-r--r-- 1 u g 0 Oct 1 artifact.o"}]}}).to_string(),
        json!({"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","id":"t2","name":"Edit","input":{"file_path":"/x"}}]}}).to_string(),
        json!({"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"t3","content":[{"type":"text","text":"line a"},{"type":"text","text":"line b"}]}]}}).to_string(),
        json!({"type":"user","isMeta":true,"message":{"role":"user","content":"meta text"}}).to_string(),
        json!({"type":"user","message":{"role":"user","content":"<task-notification>agent done: 3 passed</task-notification>"}}).to_string(),
        "not json at all".to_string(),
        json!({"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"The cause is the stale build artifact."}]}}).to_string(),
    ]
}

/// What one side of a case produced.
struct JudgeSide {
    /// Exit code, stdout and stderr of each step.
    outs: Vec<(i32, String, String)>,
    calls: Vec<Call>,
    tree: BTreeMap<String, String>,
    telemetry: Vec<Value>,
    /// The temporary root the side was given (TMPDIR).
    tmp: PathBuf,
    /// Entries left under the temporary root after the run (a private judge directory that was not removed).
    leftover: Vec<String>,
}

/// Run one case on one side.
fn judge_side(c: &JudgeCase, engine: bool, plugin_root: Option<&Path>) -> JudgeSide {
    let home = scratch(if engine { "e" } else { "n" });
    std::fs::create_dir_all(home.join(".anti-hall")).unwrap();
    for (rel, body) in &c.seed {
        let f = home.join(rel);
        std::fs::create_dir_all(f.parent().unwrap()).unwrap();
        std::fs::write(f, body).unwrap();
    }
    let bin = home.join("bin");
    std::fs::create_dir_all(&bin).unwrap();
    fake_bin(&bin);
    let log = home.join("calls");
    let tmp = home.join("tmp");
    std::fs::create_dir_all(&tmp).unwrap();
    let reply = home.join("reply.txt");
    std::fs::write(&reply, &c.reply).unwrap();
    let t = home.join("transcript.jsonl");
    std::fs::write(&t, c.transcript.join("\n") + "\n").unwrap();
    let mut payload = c.payload.clone();
    if payload.get("transcript_path").is_none() {
        payload["transcript_path"] = json!(t.to_string_lossy());
    }
    let mut outs = Vec::new();
    for _ in 0..c.steps {
        let mut cmd = if engine {
            let mut cmd = Command::new(env!("CARGO_BIN_EXE_ah-engine"));
            cmd.arg("check").arg("speculation-judge").env("AH_ENGINE_DIR", home.join("engine-state"));
            cmd
        } else {
            let mut cmd = Command::new("node");
            cmd.arg(repo().join("plugins/anti-hall/hooks/speculation-judge.js"));
            cmd
        };
        cmd.env_clear()
            .env("PATH", format!("{}:{}", bin.display(), std::env::var("PATH").unwrap_or_default()))
            .env("HOME", &home)
            .env("USERPROFILE", &home)
            .env("TMPDIR", &tmp)
            .env("ANTIHALL_TEST_ISOLATION", "1")
            .env("ANTIHALL_INGEST_DRY_RUN", "1")
            .env("ANTIHALL_SEMANTIC_JUDGE", "1")
            .env("ANTIHALL_JUDGE_BACKEND", "cli")
            .env("FAKE_CLAUDE_LOG", &log)
            .env("FAKE_CLAUDE_REPLY", &reply)
            .env("FAKE_CLAUDE_EXIT", c.exit.to_string())
            .current_dir(&home);
        if let Some(root) = plugin_root {
            cmd.env("AH_ENGINE_PLUGIN_ROOT", root);
        }
        for (k, v) in &c.env {
            cmd.env(k, v);
        }
        outs.push(run(cmd, &payload.to_string()));
    }
    let leftover = std::fs::read_dir(&tmp).unwrap().flatten().map(|e| e.file_name().to_string_lossy().into_owned()).collect();
    // without a session id the state file is named by the hash of the side's own transcript path: name it alike
    let own_session = ah_engine::checks::jsport::text::sha1_hex(t.to_string_lossy().as_bytes())[..16].to_string();
    let tree = tree(&home.join(".anti-hall")).into_iter().map(|(k, v)| (k.replace(&own_session, "<transcript-hash>"), v)).collect();
    let side = JudgeSide { outs, calls: calls(&log), tree, telemetry: telemetry(&home), tmp, leftover };
    ah_engine::discard::harmless(std::fs::remove_dir_all(&home));
    side
}

fn judge_cases() -> Vec<JudgeCase> {
    let block = |claim: &str| envelope(&json!({"decision": "block", "claim": claim}).to_string());
    let mut v = Vec::new();
    let mut c = JudgeCase::new("block-then-loop-safe", &block("The stale build artifact is the cause."));
    c.steps = 2;
    c.blocks = true;
    v.push(c);
    v.push(JudgeCase::new("allow", &envelope(r#"{"decision":"allow"}"#)));
    let mut c = JudgeCase::new("fenced-block-no-claim", &envelope("```json\n{\"decision\":\"block\"}\n```"));
    c.blocks = true;
    v.push(c);
    let mut c = JudgeCase::new("prose-around-json", &envelope("Verdict: {\"decision\":\"block\",\"claim\":\"x\\u0001y\\n z\"} ok"));
    c.blocks = true;
    v.push(c);
    v.push(JudgeCase::new("is-error", &json!({"is_error": true, "result": "{\"decision\":\"block\"}"}).to_string()));
    let mut c = JudgeCase::new("exit-1", &block("x"));
    c.exit = 1;
    v.push(c);
    v.push(JudgeCase::new("garbage-stdout", "not json"));
    v.push(JudgeCase::new("result-not-a-string", &json!({"result": {"decision": "block"}}).to_string()));
    v.push(JudgeCase::new("decision-maybe", &envelope(r#"{"decision":"maybe"}"#)));
    v.push(JudgeCase::new("claim-not-a-string", &envelope(r#"{"decision":"block","claim":5}"#)));
    v.last_mut().unwrap().blocks = true;
    let mut c = JudgeCase::new("long-claim-cut-through-an-emoji", &block(&format!("{}\u{1F600} and more text after it", "a".repeat(119))));
    c.blocks = true;
    v.push(c);
    let mut c = JudgeCase::new("long-claim-cut-at-a-space", &block(&format!("{} {}", "b".repeat(119), "c".repeat(40))));
    c.blocks = true;
    v.push(c);
    let mut c = JudgeCase::new("claim-bidi-and-controls", &block("evil\u{202E}txt\u{2066} \u{7}\u{85}tab\there"));
    c.blocks = true;
    v.push(c);
    let mut c = JudgeCase::new("block-cap-reached", &block("x"));
    c.seed = vec![(".anti-hall/judge-state-s1.json", r#"{"hash":"other","blocks":3}"#.into())];
    c.calls = 0;
    v.push(c);
    let mut c = JudgeCase::new("third-block", &block("x"));
    c.seed = vec![(".anti-hall/judge-state-s1.json", r#"{"hash":"other","blocks":2}"#.into())];
    c.blocks = true;
    v.push(c);
    let mut c = JudgeCase::new("legacy-state-string", &block("x"));
    c.seed = vec![(".anti-hall/judge-state-s1.json", "\"abc\"".into())];
    c.blocks = true;
    v.push(c);
    let mut c = JudgeCase::new("reply-from-the-transcript", &block("x"));
    c.payload = json!({"hook_event_name": "Stop", "session_id": "s/2 x"});
    c.blocks = true;
    v.push(c);
    let mut c = JudgeCase::new("no-session-id", &block("x"));
    c.payload = json!({"hook_event_name": "Stop", "last_assistant_message": "It is fixed now."});
    c.blocks = true;
    v.push(c);
    let mut c = JudgeCase::new("empty-reply-no-call", &block("x"));
    c.payload = json!({"hook_event_name": "Stop", "last_assistant_message": "   "});
    c.transcript = vec![json!({"type":"user","message":{"role":"user","content":"hi"}}).to_string()];
    c.calls = 0;
    v.push(c);
    // big evidence: more than 6000 units, surrogate pairs at the cuts, and secrets that must be scrubbed before they leave
    let mut c = JudgeCase::new("big-evidence-scrubbed-and-cut", &envelope(r#"{"decision":"allow"}"#));
    let mut t = vec![json!({"type":"user","message":{"role":"user","content":format!("deploy with key sk-ant-api03-{} please", "Q".repeat(90))}}).to_string()];
    for i in 0..6 {
        let body = format!("{}\u{1F600}{} AKIA{} ghp_{}", "e".repeat(1499 - i), "f".repeat(800), "ABCDEFGHIJKLMNOP", "x".repeat(36));
        t.push(json!({"type":"user","message":{"role":"user","content":[{"type":"tool_result","content":body}]}}).to_string());
    }
    c.transcript = t;
    c.payload = json!({"hook_event_name": "Stop", "session_id": "s1", "last_assistant_message": format!("{}\u{1F600}tail token=sk-ant-api03-{}", "m".repeat(7999), "Z".repeat(95))});
    v.push(c);
    // Codex rollout shapes
    let mut c = JudgeCase::new("codex-shapes", &envelope(r#"{"decision":"allow"}"#));
    c.transcript = vec![
        json!({"type":"event_msg","payload":{"type":"user_message","message":"fix it\n~~~\npasted log\n~~~\n"}}).to_string(),
        json!({"type":"response_item","payload":{"type":"function_call","name":"shell","arguments":"{\"command\":[\"ls\"]}"}}).to_string(),
        json!({"type":"response_item","payload":{"type":"function_call_output","output":"a.txt"}}).to_string(),
        json!({"type":"response_item","payload":{"type":"custom_tool_call","name":"apply_patch","input":"x"}}).to_string(),
        json!({"type":"response_item","payload":{"type":"local_shell_call","action":{"z":1,"a":[1,2]}}}).to_string(),
        json!({"type":"response_item","payload":{"type":"message","role":"assistant"}}).to_string(),
    ];
    v.push(c);
    let mut c = JudgeCase::new("model-from-env", &envelope(r#"{"decision":"allow"}"#));
    c.env = vec![("ANTIHALL_JUDGE_MODEL", " sonnet ".into())];
    v.push(c);
    let mut c = JudgeCase::new("model-from-settings", &envelope(r#"{"decision":"allow"}"#));
    c.seed = vec![(".anti-hall/settings.json", r#"{"jev":{"judgeModel":"opus"}}"#.into())];
    v.push(c);
    let mut c = JudgeCase::new("auto-without-a-key-uses-the-cli", &envelope(r#"{"decision":"allow"}"#));
    c.env = vec![("ANTIHALL_JUDGE_BACKEND", "auto".into())];
    v.push(c);
    let mut c = JudgeCase::new("api-without-a-key-makes-no-call", &block("x"));
    c.env = vec![("ANTIHALL_JUDGE_BACKEND", "api".into())];
    c.calls = 0;
    v.push(c);
    let mut c = JudgeCase::new("jev-speculation-on-stands-down", &block("x"));
    c.env = vec![("ANTIHALL_JEV", "1".into())];
    c.calls = 0;
    v.push(c);
    v
}

fn is_block(out: &(i32, String, String)) -> bool {
    out.1.contains("\"decision\":\"block\"")
}

#[test]
fn the_speculation_judge_makes_the_same_cli_call_and_decision_as_node() {
    let _g = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
    let mut failures = Vec::new();
    let cases = judge_cases();
    for c in &cases {
        let n = judge_side(c, false, None);
        let e = judge_side(c, true, None);
        let (no, nc, nt, ntmp) = (&n.outs, &n.calls, &n.tree, &n.tmp);
        let (eo, ec, et, etel, etmp) = (&e.outs, &e.calls, &e.tree, &e.telemetry, &e.tmp);
        let who = c.name;
        for (side, left) in [("node", &n.leftover), ("engine", &e.leftover)] {
            if !left.is_empty() {
                failures.push(format!("{who}: {side} left {left:?} in its temporary directory"));
            }
        }
        // D88: the model call is the Node hook's; the speculation-judge script answers every path without one and defers the rest
        if c.calls > 0 {
            if !eo.iter().all(|o| o.0 == 0 && o.1.contains("AHFALLBACK")) || !ec.is_empty() {
                failures.push(format!("{who}: the engine must defer without calling the model: {eo:?} calls={}", ec.len()));
            }
            continue;
        }
        if no != eo {
            failures.push(format!("{who}: output differs\n  node  ={no:?}\n  engine={eo:?}"));
        }
        if eo.iter().any(|o| o.1.contains("AHFALLBACK")) {
            failures.push(format!("{who}: the engine deferred"));
        }
        if is_block(&eo[0]) != c.blocks {
            failures.push(format!("{who}: block expected {} got {:?}", c.blocks, eo[0]));
        }
        if nt != et {
            failures.push(format!("{who}: state differs\n  node  ={nt:?}\n  engine={et:?}"));
        }
        if nc.len() != c.calls || ec.len() != c.calls {
            failures.push(format!("{who}: calls node={} engine={} expected {}", nc.len(), ec.len(), c.calls));
            continue;
        }
        for (n, e) in nc.iter().zip(ec.iter()) {
            if n.argv != e.argv {
                failures.push(format!("{who}: argv differs\n  node  ={:?}\n  engine={:?}", n.argv, e.argv));
            }
            if n.stdin != e.stdin {
                failures.push(format!(
                    "{who}: stdin differs\n  node  ={:?}\n  engine={:?}",
                    String::from_utf8_lossy(&n.stdin),
                    String::from_utf8_lossy(&e.stdin)
                ));
            }
            if (n.child.as_str(), e.child.as_str()) != ("1", "1") {
                failures.push(format!("{who}: judge-child marker node={:?} engine={:?}", n.child, e.child));
            }
            // the shell's own variables, the engine's state directory (set for the engine side only) and the variable
            // macOS adds to every Node process are not part of what the judge is given
            let own = ["AH_ENGINE_DIR", "PWD", "OLDPWD", "SHLVL", "_", "__CF_USER_TEXT_ENCODING"];
            let strip = |names: &[String]| names.iter().filter(|k| !own.contains(&k.as_str())).cloned().collect::<Vec<_>>();
            if strip(&n.envnames) != strip(&e.envnames) {
                failures.push(format!("{who}: child environment names differ\n  node  ={:?}\n  engine={:?}", n.envnames, e.envnames));
            }
            for (side, call, tmp) in [("node", n, ntmp), ("engine", e, etmp)] {
                let prefix = format!("{}/antihall-judge-", tmp.display());
                if !call.cwd.starts_with(&prefix) || call.cwd.len() != prefix.len() + 6 {
                    failures.push(format!("{who}: {side} cwd {:?} is not a private {prefix}XXXXXX", call.cwd));
                }
            }
        }
        if etel.len() != c.calls {
            failures.push(format!("{who}: {} telemetry rows for {} calls", etel.len(), c.calls));
        }
        for row in etel {
            let model_arg = ec[0].argv.get(2).cloned().unwrap_or_default();
            if row["integration"] != "speculation" || row["backend"] != "haiku-cli" || row["model"] != model_arg.as_str() || !row["ms"].is_u64() {
                failures.push(format!("{who}: telemetry row {row}"));
            }
        }
    }
    eprintln!("speculation-judge cli parity: {} cases, {} failures", cases.len(), failures.len());
    assert!(failures.is_empty(), "{}", failures.join("\n---\n"));
}

#[test]
fn the_jev_backend_switch_and_the_api_backend_never_call_the_cli() {
    let _g = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
    let block = envelope(r#"{"decision":"block"}"#);
    let mut c = JudgeCase::new("switch-jev", &block);
    c.env = vec![("ANTIHALL_JEV_SPECULATION_BACKEND", "jev".into())];
    let e = judge_side(&c, true, None);
    assert_eq!((e.outs[0].0, e.outs[0].1.as_str(), e.calls.len(), e.tree.len(), e.telemetry.len()), (0, "", 0, 0, 0), "{:?}", e.outs);
    // the API route with a key is Node's: the engine defers before any call
    let mut c = JudgeCase::new("api-with-key", &block);
    c.env = vec![("ANTIHALL_JUDGE_BACKEND", "api".into()), ("CLAUDE_PLUGIN_OPTION_ANTHROPIC_API_KEY", "parity-key-not-real".into())];
    let e = judge_side(&c, true, None);
    assert_eq!((e.outs[0].1.trim(), e.calls.len()), ("AHFALLBACK", 0));
}

/// A copy of the plugin's engine directory with `edit` applied to judge.toml, for a test that needs a smaller limit.
fn plugin_with(edit: impl Fn(String) -> String) -> PathBuf {
    let root = scratch("plugin");
    let src = repo().join("plugins/anti-hall/engine");
    fn cp(from: &Path, to: &Path) {
        std::fs::create_dir_all(to).unwrap();
        for e in std::fs::read_dir(from).unwrap().flatten() {
            let p = e.path();
            if p.is_dir() {
                cp(&p, &to.join(e.file_name()));
            } else {
                std::fs::copy(&p, to.join(e.file_name())).unwrap();
            }
        }
    }
    cp(&src, &root.join("engine"));
    let f = root.join("engine/defaults/judge.toml");
    std::fs::write(&f, edit(std::fs::read_to_string(&f).unwrap())).unwrap();
    root
}

#[test]
fn a_judge_call_is_left_to_node_so_the_engine_never_waits_for_the_model() {
    let _g = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
    let root = plugin_with(|t| {
        t.replace("[speculation_judge.timeout_ms]\ndoc = ", "[speculation_judge.timeout_ms]\nvalue = 2000\ndoc = ").replace("\nvalue = 25000\n", "\n")
    });
    let mut c = JudgeCase::new("timeout", &envelope(r#"{"decision":"block"}"#));
    c.env = vec![("FAKE_CLAUDE_SLEEP", "8".into())];
    let started = Instant::now();
    let e = judge_side(&c, true, Some(&root));
    // the script never waits on a model: it defers at once and the Node hook owns the call and its timeout
    assert!(started.elapsed() < Duration::from_secs(6), "the engine waited for the model: {:?}", started.elapsed());
    assert!(e.outs[0].1.contains("AHFALLBACK"), "{:?}", e.outs);
    assert!(e.calls.is_empty() && e.tree.is_empty() && e.telemetry.is_empty(), "no call, no state: {:?}", e.calls.len());
    ah_engine::discard::harmless(std::fs::remove_dir_all(&root));
}

// ---- jev triage -------------------------------------------------------------------------------------------------

#[derive(Debug, Clone, Default)]
struct Seen {
    body: String,
}

/// A loopback Jev server answering every multi-question call with `answers`.
struct Mock {
    port: u16,
    seen: Arc<Mutex<Vec<Seen>>>,
}

fn read_request(s: &mut TcpStream) -> Option<Seen> {
    s.set_read_timeout(Some(crate::common::IO_CEILING)).ok()?;
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
    let head = String::from_utf8_lossy(&buf[..head_end]).to_ascii_lowercase();
    let want: usize = head.lines().find_map(|l| l.strip_prefix("content-length:")).and_then(|v| v.trim().parse().ok()).unwrap_or(0);
    while buf.len() < head_end + want {
        let n = s.read(&mut chunk).ok()?;
        if n == 0 {
            break;
        }
        buf.extend_from_slice(&chunk[..n]);
    }
    Some(Seen { body: String::from_utf8_lossy(&buf[head_end..]).into_owned() })
}

impl Mock {
    fn start(answers: Value) -> Mock {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let seen = Arc::new(Mutex::new(Vec::new()));
        let s2 = seen.clone();
        std::thread::spawn(move || {
            for conn in listener.incoming() {
                let Ok(mut c) = conn else { break };
                let Some(req) = read_request(&mut c) else { continue };
                s2.lock().unwrap().push(req);
                let body = json!({"answers": answers, "usage": {"input_tokens": 900, "output_tokens": 20}}).to_string();
                let out = format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len());
                ah_engine::discard::harmless(c.write_all(out.as_bytes()));
            }
        });
        Mock { port, seen }
    }
}

/// A `node -r` preload that answers `https.request` (the worker's Anthropic API call) with `$STUB_REPLY` as the model's
/// text, and appends each request body to `$STUB_LOG`.
const HTTPS_STUB: &str = r#"
const https = require('https');
const { EventEmitter } = require('events');
const fs = require('fs');
https.request = function (opts, cb) {
  const req = new EventEmitter();
  let body = '';
  req.write = (d) => { body += d; };
  req.destroy = () => {};
  req.end = () => {
    fs.appendFileSync(process.env.STUB_LOG, JSON.stringify({ host: opts.hostname, path: opts.path, headers: opts.headers, body }) + '\n');
    setImmediate(() => {
      const res = new EventEmitter();
      cb(res);
      res.emit('data', JSON.stringify({ content: [{ type: 'text', text: fs.readFileSync(process.env.STUB_REPLY, 'utf8') }] }));
      res.emit('end');
      req.emit('close');
    });
  };
  return req;
};
"#;

struct TriageSide {
    out: (i32, String, String),
    requests: Vec<Seen>,
    api: Vec<Value>,
    calls: Vec<Call>,
    telemetry: Vec<Value>,
}

fn triage_side(engine: bool, env: &[(&str, String)], answers: Value, model_text: &str, input: &Value) -> TriageSide {
    let home = scratch(if engine { "te" } else { "tn" });
    std::fs::create_dir_all(home.join(".anti-hall")).unwrap();
    let bin = home.join("bin");
    std::fs::create_dir_all(&bin).unwrap();
    fake_bin(&bin);
    let reply = home.join("reply.txt");
    std::fs::write(&reply, envelope(model_text)).unwrap();
    let stub_reply = home.join("stub-reply.txt");
    std::fs::write(&stub_reply, model_text).unwrap();
    let stub = home.join("https-stub.js");
    std::fs::write(&stub, HTTPS_STUB).unwrap();
    let mock = Mock::start(answers);
    let mut cmd = if engine {
        let mut cmd = Command::new(env!("CARGO_BIN_EXE_ah-engine"));
        cmd.arg("jev").arg("triage").env("AH_ENGINE_DIR", home.join("engine-state"));
        cmd
    } else {
        let mut cmd = Command::new("node");
        cmd.arg("-r").arg(&stub).arg(repo().join("plugins/anti-hall/hooks/lib/jev-triage-worker.js"));
        cmd
    };
    cmd.env_clear()
        .env("PATH", format!("{}:{}", bin.display(), std::env::var("PATH").unwrap_or_default()))
        .env("HOME", &home)
        .env("USERPROFILE", &home)
        .env("TMPDIR", home.join("tmp"))
        .env("ANTIHALL_TEST_ISOLATION", "1")
        .env("ANTIHALL_INGEST_DRY_RUN", "1")
        .env("ANTIHALL_JEV_TEST_ENDPOINT_VERCEL", format!("http://127.0.0.1:{}/v1/systemone", mock.port))
        .env("FAKE_CLAUDE_LOG", home.join("calls"))
        .env("FAKE_CLAUDE_REPLY", &reply)
        .env("STUB_LOG", home.join("api.ndjson"))
        .env("STUB_REPLY", &stub_reply)
        .current_dir(&home);
    std::fs::create_dir_all(home.join("tmp")).unwrap();
    for (k, v) in env {
        cmd.env(k, v);
    }
    let out = run(cmd, &input.to_string());
    let api = std::fs::read_to_string(home.join("api.ndjson")).unwrap_or_default().lines().map(|l| serde_json::from_str(l).unwrap()).collect();
    let side = TriageSide { out, requests: mock.seen.lock().unwrap().clone(), api, calls: calls(&home.join("calls")), telemetry: telemetry(&home) };
    ah_engine::discard::harmless(std::fs::remove_dir_all(&home));
    side
}

/// The worker's stdout with each `ms` (a clock reading) replaced by 0.
fn mask_ms(stdout: &str) -> Value {
    let mut v: Value = serde_json::from_str(stdout).unwrap_or(Value::Null);
    if let Some(m) = v.as_object_mut() {
        for (_, label) in m.iter_mut() {
            if let Some(o) = label.as_object_mut()
                && o.contains_key("ms")
            {
                o.insert("ms".into(), json!(0));
            }
        }
    }
    v
}

fn items() -> Value {
    json!({
        "items": [
            {"hash": "h-blocker", "text": "I am blocked on the merge: can you approve PR 12? token ghp_abcdefghijklmnopqrstuvwxyz0123456789"},
            {"hash": "h-blank", "text": "   "},
            {"hash": 7, "text": "number hash"},
            {"hash": "h-notext"},
            {"hash": "7", "text": format!("{}\u{1F600}tail", "s".repeat(4000))},
            {"hash": "h-blocker", "text": "the same hash again, later"}
        ],
        "timeoutMs": 8000,
        "urgentThreshold": 0.9
    })
}

#[test]
fn jev_triage_answers_like_the_node_worker() {
    let _g = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
    let key = ("CLAUDE_PLUGIN_OPTION_JEV_VERCEL_API_KEY", "parity-test-key-not-real".to_string());
    // 1. Jev off and no Anthropic key: every valid item is attempted and gets no label
    let (n, e) = (triage_side(false, &[], json!({}), "", &items()), triage_side(true, &[], json!({}), "", &items()));
    assert_eq!(n.out, e.out, "jev off");
    assert_eq!(n.out.1, r#"{"7":null,"h-blocker":null}"#);
    // 2. Jev on: one multi-question call per message; the labels kept at their thresholds
    for (answers, label) in [
        (json!({"kind": {"choice": "blocker", "confidence": 0.95}, "urgency": {"noul": 0.99}}), "both"),
        (json!({"kind": {"choice": "fyi", "confidence": 0.5}, "urgency": {"noul": 0.94}}), "urgent below its stricter threshold"),
        (json!({"kind": {"choice": "nonsense", "confidence": 0.99}, "urgency": {"noul": 0.01}}), "unknown kind, confident normal"),
        (json!({"kind": {"choice": "done-report", "confidence": 0.9}}), "no urgency answer"),
    ] {
        let env = [("ANTIHALL_JEV", "1".to_string()), key.clone()];
        let (n, e) = (triage_side(false, &env, answers.clone(), "", &items()), triage_side(true, &env, answers.clone(), "", &items()));
        assert_eq!((n.out.0, mask_ms(&n.out.1), n.out.2.as_str()), (e.out.0, mask_ms(&e.out.1), e.out.2.as_str()), "{label}: {:?} vs {:?}", n.out, e.out);
        let bodies = |s: &TriageSide| s.requests.iter().map(|r| r.body.clone()).collect::<Vec<_>>();
        assert_eq!(bodies(&n), bodies(&e), "{label}: the Jev request bodies");
        assert_eq!(e.requests.len(), 3, "{label}: one call per attempted item");
        assert_eq!(e.telemetry.len(), 3, "{label}: one telemetry row per Jev call");
        assert_eq!(e.telemetry[0]["backend"], "jev");
    }
    // 3. the haiku backend through the Claude CLI makes the request Node's Anthropic API path makes: same system prompt,
    //    same user text, same model alias, and the same labels from the same answer
    for text in [r#"{"kind":"question-needs-answer","urgency":"urgent"}"#, "```json\n{\"kind\":\"fyi\",\"urgency\":\"later\"}\n```", "nope", "0"] {
        let n = triage_side(false, &[("CLAUDE_PLUGIN_OPTION_ANTHROPIC_API_KEY", "parity-key-not-real".to_string())], json!({}), text, &items());
        let e = triage_side(
            true,
            &[("ANTIHALL_JEV_TRIAGE_BACKEND", "haiku".to_string()), ("ANTIHALL_JUDGE_BACKEND", "cli".to_string())],
            json!({}),
            text,
            &items(),
        );
        assert_eq!(mask_ms(&n.out.1), mask_ms(&e.out.1), "{text}: labels {:?} vs {:?}", n.out, e.out);
        assert_eq!((n.api.len(), e.calls.len()), (3, 3), "{text}");
        for (api, call) in n.api.iter().zip(&e.calls) {
            let body: Value = serde_json::from_str(api["body"].as_str().unwrap()).unwrap();
            let arg = |flag: &str| call.argv.iter().position(|a| a == flag).map(|i| call.argv[i + 1].clone()).unwrap();
            assert_eq!(body["system"].as_str().unwrap(), arg("--system-prompt"), "system prompt");
            assert_eq!(body["model"].as_str().unwrap(), arg("--model"), "model alias");
            assert_eq!(body["messages"][0]["content"].as_str().unwrap().as_bytes(), call.stdin.as_slice(), "user text");
            assert_eq!(call.child, "1");
        }
        assert_eq!(e.telemetry.len(), 3);
        assert_eq!(e.telemetry[0]["backend"], "haiku-cli");
    }
    // 4. the default backend with an Anthropic key visible would need the API: the engine leaves the run to Node, untouched
    let e = triage_side(true, &[("ANTIHALL_JEV", "1".to_string()), key, ("CLAUDE_PLUGIN_OPTION_ANTHROPIC_API_KEY", "k".to_string())], json!({}), "", &items());
    assert_eq!((e.out.0, e.out.1.as_str(), e.requests.len(), e.calls.len()), (75, "", 0, 0), "{:?}", e.out);
    // 5. malformed input prints {} on both sides
    for raw in [json!(null), json!({"items": "x"}), json!([1])] {
        let (n, e) = (triage_side(false, &[], json!({}), "", &raw), triage_side(true, &[], json!({}), "", &raw));
        assert_eq!((n.out.0, n.out.1.as_str()), (e.out.0, e.out.1.as_str()), "{raw}");
    }
}
