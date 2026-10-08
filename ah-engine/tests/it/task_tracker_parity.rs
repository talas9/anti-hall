//! Node-vs-engine parity for the task-tracker check (UserPromptSubmit).
//!
//! Each case is a sequence of prompts fed to the real Node hook and to `ah-engine check task-tracker`, each side in its own
//! isolated home (`ANTIHALL_INGEST_DRY_RUN=1`, never the real one) seeded identically, and compares every step's exit code and
//! output and, after the last step, the whole home: the directive's state file, the dedupe store, the unknown-state note
//! files, the demand metrics and the Jev decision log (clock fields removed; the detached asks are given time to land). A
//! case marked `defer` must be handed to Node (`AHFALLBACK`) with the home left as seeded.
use serde_json::{Value, json};
use std::collections::BTreeMap;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::Mutex;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

static SERIAL: Mutex<()> = Mutex::new(());
static ID: AtomicUsize = AtomicUsize::new(0);
const FALLBACK: &str = "AHFALLBACK\n";

#[derive(Clone)]
struct Step {
    payload: Value,
    /// Lines written to `$HOME/t.jsonl` before this step (None: leave as is).
    transcript: Option<Vec<String>>,
}

#[derive(Clone)]
struct Case {
    name: String,
    steps: Vec<Step>,
    env: Vec<(String, String)>,
    files: Vec<(String, String)>,
    defer: bool,
}

fn now_ms() -> u128 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_millis()
}

fn p(session: &str) -> Value {
    json!({"hook_event_name":"UserPromptSubmit","session_id":session,"prompt":"please do the thing","cwd":"$HOME/proj","transcript_path":"$HOME/t.jsonl"})
}

fn step(payload: Value) -> Step {
    Step { payload, transcript: None }
}

fn case(name: &str, steps: Vec<Step>) -> Case {
    Case { name: name.into(), steps, env: Vec::new(), files: Vec::new(), defer: false }
}

impl Case {
    fn env(mut self, k: &str, v: &str) -> Case {
        self.env.push((k.into(), v.into()));
        self
    }
    fn file(mut self, rel: &str, body: &str) -> Case {
        self.files.push((rel.into(), body.into()));
        self
    }
    fn defer(mut self) -> Case {
        self.defer = true;
        self
    }
}

fn task(n: u32, subject: &str, status: &str, extra: Value) -> Vec<String> {
    let mut input = json!({"subject": subject});
    for (k, v) in extra.as_object().cloned().unwrap_or_default() {
        input[k] = v;
    }
    vec![
        json!({"type":"assistant","timestamp":"2026-10-06T08:00:00.000Z","message":{"id":format!("m{n}"),"role":"assistant","content":[{"type":"tool_use","id":format!("c{n}"),"name":"TaskCreate","input":input}]}}).to_string(),
        json!({"type":"user","timestamp":"2026-10-06T08:00:01.000Z","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":format!("c{n}"),"content":format!("Task #{n} created successfully: {subject}")}]}}).to_string(),
        json!({"type":"assistant","timestamp":"2026-10-06T08:00:02.000Z","message":{"id":format!("u{n}"),"role":"assistant","content":[{"type":"tool_use","id":format!("t{n}"),"name":"TaskUpdate","input":{"taskId":n.to_string(),"status":status}}]}}).to_string(),
        json!({"type":"user","timestamp":"2026-10-06T08:00:03.000Z","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":format!("t{n}"),"content":format!("Updated task #{n}")}]}}).to_string(),
    ]
}

fn plugin() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("..").canonicalize().unwrap().join("plugins/anti-hall")
}

fn scratch(tag: &str) -> PathBuf {
    let d = std::env::temp_dir().join(format!("ah-tt-{tag}-{}-{}", std::process::id(), ID.fetch_add(1, Ordering::Relaxed)));
    ah_engine::discard::harmless(std::fs::remove_dir_all(&d)); // keep: a leftover of an earlier run of this test
    std::fs::create_dir_all(&d).unwrap();
    d.canonicalize().unwrap()
}

fn subst(s: &str, home: &Path) -> String {
    s.replace("$HOME", &home.to_string_lossy())
}

fn norm(s: &str, now: u128) -> String {
    let b = s.as_bytes();
    let (mut out, mut i) = (String::new(), 0);
    while i < b.len() {
        if b[i].is_ascii_digit() {
            let j = (i..b.len()).find(|&k| !b[k].is_ascii_digit()).unwrap_or(b.len());
            let run = &s[i..j];
            out.push_str(&if run.len() == 13 && run.parse::<u128>().is_ok_and(|n| n.abs_diff(now) < 120_000) { "<NOW>".to_string() } else { run.to_string() });
            i = j;
        } else {
            let ch = s[i..].chars().next().unwrap();
            out.push(ch);
            i += ch.len_utf8();
        }
    }
    out
}

fn tp_re() -> &'static regex::Regex {
    static R: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    R.get_or_init(|| regex::Regex::new(r#""tp":"[0-9a-f]{16}""#).unwrap())
}

/// The home as `path -> content`; JSON-lines files lose their clock fields, and temporary files their pid.
fn snapshot(home: &Path, now: u128) -> BTreeMap<String, String> {
    fn walk(dir: &Path, root: &Path, out: &mut BTreeMap<String, String>, now: u128) {
        let Ok(rd) = std::fs::read_dir(dir) else { return };
        for e in rd.flatten() {
            let path = e.path();
            let rel = path.strip_prefix(root).unwrap().to_string_lossy().to_string();
            if rel == "engine-state" {
                continue;
            }
            if e.file_type().unwrap().is_dir() {
                out.insert(format!("{rel}/"), String::new());
                walk(&path, root, out, now);
            } else {
                let body = String::from_utf8_lossy(&std::fs::read(&path).unwrap()).replace(&root.to_string_lossy().to_string(), "$HOME");
                let body = if rel.ends_with(".ndjson") {
                    body.lines()
                        .map(|l| {
                            serde_json::from_str::<Value>(l).map_or(l.to_string(), |mut v| {
                                if let Some(o) = v.as_object_mut() {
                                    o.remove("ts");
                                    o.remove("ms");
                                }
                                v.to_string()
                            })
                        })
                        .collect::<Vec<_>>()
                        .join("\n")
                } else {
                    body
                };
                // the transcript id hashes a path that holds the side's own home: only its presence can be compared
                let body = tp_re().replace_all(&body, "\"tp\":\"<TP>\"").into_owned();
                out.insert(rel, norm(&body, now));
            }
        }
    }
    let mut out = BTreeMap::new();
    walk(home, home, &mut out, now);
    out
}

type Out = (i32, Vec<u8>, Vec<u8>);

fn run(mut cmd: Command, input: &[u8]) -> Out {
    cmd.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = cmd.spawn().unwrap();
    let mut stdin = child.stdin.take().unwrap();
    let data = input.to_vec();
    let w = std::thread::spawn(move || ah_engine::discard::harmless(stdin.write_all(&data))); // keep: the child may exit before reading
    let (mut so, mut se) = (child.stdout.take().unwrap(), child.stderr.take().unwrap());
    let ro = std::thread::spawn(move || {
        let mut b = Vec::new();
        ah_engine::discard::harmless(so.read_to_end(&mut b)); // keep: a closed pipe ends the read
        b
    });
    let re = std::thread::spawn(move || {
        let mut b = Vec::new();
        ah_engine::discard::harmless(se.read_to_end(&mut b)); // keep: a closed pipe ends the read
        b
    });
    let deadline = Instant::now() + Duration::from_secs(40);
    let status = loop {
        if let Some(s) = child.try_wait().unwrap() {
            break s;
        }
        assert!(Instant::now() < deadline, "child exceeded 40 seconds: {cmd:?}");
        std::thread::sleep(Duration::from_millis(3));
    };
    ah_engine::discard::harmless(w.join()); // keep: the writer only feeds stdin
    (status.code().unwrap_or(-1), ro.join().unwrap(), re.join().unwrap())
}

fn base_env(c: &mut Command, home: &Path, case: &Case) {
    c.env_clear()
        .env("PATH", std::env::var("PATH").unwrap_or_default())
        .env("HOME", home)
        .env("USERPROFILE", home)
        .env("ANTIHALL_TEST_ISOLATION", "1")
        .env("ANTIHALL_INGEST_DRY_RUN", "1");
    for (k, v) in &case.env {
        c.env(k, subst(v, home));
    }
}

fn run_side(engine: bool, home: &Path, case: &Case) -> Vec<Out> {
    case.steps
        .iter()
        .map(|s| {
            if let Some(lines) = &s.transcript {
                std::fs::write(home.join("t.jsonl"), subst(&lines.join("\n"), home) + "\n").unwrap();
            }
            let input = subst(&s.payload.to_string(), home).into_bytes();
            let mut c;
            if engine {
                c = Command::new(env!("CARGO_BIN_EXE_ah-engine"));
                c.arg("check").arg("task-tracker").env("AH_ENGINE_DIR", home.join("engine-state")).env("AH_ENGINE_PLUGIN_ROOT", plugin());
            } else {
                c = Command::new("node");
                c.arg(plugin().join("hooks/task-tracker.js"));
            }
            c.current_dir(std::env::temp_dir());
            base_env(&mut c, home, case);
            let out = run(c, &input);
            // a deferring step is not followed by more: the Node hook would take over from there
            out
        })
        .collect()
}

/// Wait for the detached Jev asks of this home to land (the row count stops changing).
fn settle(home: &Path) {
    let log = home.join(".anti-hall/logs/jev-assist.ndjson");
    let count = || std::fs::read_to_string(&log).map(|t| t.lines().count()).unwrap_or(0);
    let (mut last, mut since) = (count(), Instant::now());
    while since.elapsed() < Duration::from_millis(400) {
        std::thread::sleep(Duration::from_millis(40));
        let n = count();
        if n != last {
            (last, since) = (n, Instant::now());
        }
    }
}

fn drive(name: &str, cases: Vec<Case>) -> (usize, usize, usize) {
    let _g = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
    let (mut same, mut deferred, mut emitted) = (0, 0, 0);
    for case in &cases {
        let now = now_ms();
        let (hn, he) = (scratch(&format!("{name}-n")), scratch(&format!("{name}-e")));
        for h in [&hn, &he] {
            for (rel, body) in &case.files {
                let f = h.join(rel);
                std::fs::create_dir_all(f.parent().unwrap()).unwrap();
                std::fs::write(f, subst(body, h)).unwrap();
            }
        }
        let seeded = snapshot(&he, now);
        let node = run_side(false, &hn, case);
        let eng = run_side(true, &he, case);
        settle(&hn);
        settle(&he);
        let (an, ae) = (snapshot(&hn, now), snapshot(&he, now));
        let ctx = |what: &str| {
            format!(
                "{name}/{}: {what}\n node: {:?}\n  eng: {:?}\n node home: {an:?}\n  eng home: {ae:?}",
                case.name,
                node.iter().map(|o| (o.0, String::from_utf8_lossy(&o.1).to_string(), String::from_utf8_lossy(&o.2).to_string())).collect::<Vec<_>>(),
                eng.iter().map(|o| (o.0, String::from_utf8_lossy(&o.1).to_string(), String::from_utf8_lossy(&o.2).to_string())).collect::<Vec<_>>()
            )
        };
        if case.defer {
            assert_eq!(String::from_utf8_lossy(&eng[0].1), FALLBACK, "{}", ctx("the first step must defer"));
            assert_eq!(
                snapshot(&he, now).keys().filter(|k| *k != "t.jsonl").collect::<Vec<_>>(),
                seeded.keys().collect::<Vec<_>>(),
                "{}",
                ctx("a deferral leaves the home as seeded")
            );
            deferred += 1;
        } else {
            for (i, (n, e)) in node.iter().zip(&eng).enumerate() {
                assert_ne!(String::from_utf8_lossy(&e.1), FALLBACK, "{}", ctx(&format!("step {i}: the engine deferred but this case expects an answer")));
                assert_eq!((n.0, &n.1, &n.2), (e.0, &e.1, &e.2), "{}", ctx(&format!("step {i}: exit code and output")));
                if !n.1.is_empty() {
                    emitted += 1;
                }
            }
            assert_eq!(an, ae, "{}", ctx("the home"));
            same += 1;
        }
    }
    eprintln!("{name}: same={same} deferred={deferred} emitted-steps={emitted}");
    (same, deferred, emitted)
}

fn cases() -> Vec<Case> {
    let mut v: Vec<Case> = Vec::new();
    let now = now_ms() as f64;
    let day = 86_400_000.0;
    // the directive, the reminder and the keepalive
    v.push(case("first-prompt", vec![step(p("s1"))]));
    v.push(case("first-then-short-then-rationed", vec![step(p("s1")), step(p("s1")), step(p("s1")), step(p("s1"))]));
    v.push(
        case("keepalive-every-two", vec![step(p("s1")), step(p("s1")), step(p("s1")), step(p("s1")), step(p("s1"))])
            .env("ANTIHALL_INJECTION_REPEAT_EVERY", "2"),
    );
    v.push(case("keepalive-zero-every-turn", vec![step(p("s1")), step(p("s1")), step(p("s1"))]).env("ANTIHALL_INJECTION_REPEAT_EVERY", "0"));
    v.push(case("two-sessions", vec![step(p("a")), step(p("b")), step(p("a")), step(p("b"))]));
    v.push(case("compact-level-default", vec![step(p("s1"))]));
    v.push(case("full-level", vec![step(p("s1")), step(p("s1"))]).env("ANTIHALL_PROTOCOL_LEVEL", "full"));
    v.push(case(
        "codex-turn-id",
        vec![step({
            let mut x = p("s1");
            x["turn_id"] = json!("t1");
            x
        })],
    ));
    v.push(case(
        "codex-rollout-path",
        vec![step({
            let mut x = p("s1");
            x["transcript_path"] = json!("$HOME/.codex/sessions/rollout-1.jsonl");
            x
        })],
    ));
    v.push(case("switch-off", vec![step(p("s1"))]).env("CLAUDE_PLUGIN_OPTION_CONTEXT_TASK_TRACKER", "false"));
    v.push(case("switch-off-file", vec![step(p("s1"))]).file(".anti-hall/settings.json", r#"{"context":{"taskTracker":false}}"#));
    v.push(case("skipped", vec![step(p("s1"))]).file(".anti-hall/skip.json", r#"{"task-tracker": 4102444800000}"#));
    v.push(case("skip-expired", vec![step(p("s1"))]).file(".anti-hall/skip.json", r#"{"task-tracker": 5}"#));
    v.push(case("skip-all", vec![step(p("s1"))]).file(".anti-hall/skip.json", r#"{"all": 4102444800000}"#));
    v.push(case("judge-child", vec![step(p("s1"))]).env("ANTIHALL_JUDGE_CHILD", "1"));
    // the window and the stamp
    let stamp = |last: f64, size: i64| format!("{{\"lastFull\":{},\"lastFullSize\":{size}}}", last as i64);
    v.push(case("window-fresh", vec![step(p("s1"))]).file(".anti-hall/task-tracker-s1.json", &stamp(now - 1000.0, 0)));
    v.push(case("window-expired", vec![step(p("s1"))]).file(".anti-hall/task-tracker-s1.json", &stamp(now - 7.0 * 3_600_000.0, 0)));
    v.push(case("stamp-future-corrupt", vec![step(p("s1"))]).file(".anti-hall/task-tracker-s1.json", &stamp(now + 3_600_000.0, 0)));
    v.push(case("stamp-slightly-ahead-ok", vec![step(p("s1"))]).file(".anti-hall/task-tracker-s1.json", &stamp(now + 60_000.0, 0)));
    v.push(case("stamp-garbage", vec![step(p("s1"))]).file(".anti-hall/task-tracker-s1.json", "not json"));
    v.push(case("stamp-array", vec![step(p("s1"))]).file(".anti-hall/task-tracker-s1.json", "[1,2]"));
    v.push(case("stamp-empty", vec![step(p("s1"))]).file(".anti-hall/task-tracker-s1.json", "  \n"));
    v.push(case("stamp-string-timestamp", vec![step(p("s1"))]).file(".anti-hall/task-tracker-s1.json", r#"{"lastFull":"1"}"#));
    v.push(case("stamp-no-size-baseline", vec![step(p("s1"))]).file(".anti-hall/task-tracker-s1.json", &format!("{{\"lastFull\":{}}}", (now - 1000.0) as i64)));
    v.push(case("stamp-negative-size", vec![step(p("s1"))]).file(".anti-hall/task-tracker-s1.json", &stamp(now - 1000.0, -5)));
    let mut grew = step(p("s1"));
    grew.transcript = Some(vec!["x".repeat(300_000)]);
    v.push(case("growth-triggers-full", vec![grew.clone()]).file(".anti-hall/task-tracker-s1.json", &stamp(now - 1000.0, 10)));
    v.push(case("growth-below-threshold", vec![grew.clone()]).file(".anti-hall/task-tracker-s1.json", &stamp(now - 1000.0, 200_000)));
    v.push(case(
        "no-transcript-path",
        vec![step({
            let mut x = p("s1");
            x.as_object_mut().unwrap().remove("transcript_path");
            x
        })],
    ));
    v.push(case("missing-transcript-file", vec![step(p("s1"))]));
    // old state files are swept
    v.push(case("prune-old-sessions", vec![step(p("s1"))]).file(".anti-hall/task-tracker-old.json", "{}"));
    // the open tasks line
    let mut open = task(1, "Write the parser", "in_progress", json!({}));
    open.extend(task(2, "OWNER: pick a name", "pending", json!({})));
    open.extend(task(3, "Wait for review", "pending", json!({"metadata": {"blockedOn": "external"}})));
    open.extend(task(4, "Done already", "completed", json!({})));
    let with = |lines: Vec<String>| Step { payload: p("s1"), transcript: Some(lines) };
    v.push(case("open-and-blocked", vec![with(open.clone()), step(p("s1"))]));
    v.push(case("open-unowned-in-progress-only", vec![with(task(1, "Only one", "in_progress", json!({})))]));
    v.push(case("open-long-subject", vec![with(task(1, &format!("{}  {}\t{}", "a".repeat(40), "b".repeat(30), "c"), "in_progress", json!({})))]));
    v.push(case("open-control-chars-subject", vec![with(task(1, "tab\tnew\\nline \u{7f}x", "in_progress", json!({})))]));
    v.push(case("open-unicode-subject", vec![with(task(1, "\u{65e5}\u{672c}\u{8a9e} \u{1f600} subject", "in_progress", json!({})))]));
    v.push(case("open-all-blocked", vec![with(task(1, "OWNER DECISION: x", "pending", json!({})))]));
    v.push(case("open-owned-pending-not-actionable", vec![with(task(1, "Owned", "pending", json!({"owner": "worker-1"})))]));
    v.push(case("open-blocked-by-open", {
        let mut l = task(1, "Base", "in_progress", json!({}));
        l.extend(task(2, "Waits", "pending", json!({"blockedBy": ["1"]})));
        vec![with(l)]
    }));
    v.push(case("nothing-open", vec![with(task(1, "done", "completed", json!({})))]));
    v.push(case("empty-transcript", vec![Step { payload: p("s1"), transcript: Some(vec![]) }]));
    v.push(case("unknown-state-note", {
        let upd = json!({"type":"assistant","timestamp":"2026-10-06T08:00:00.000Z","message":{"id":"m1","role":"assistant","content":[{"type":"tool_use","id":"u1","name":"TaskUpdate","input":{"taskId":"5","description":"d"}}]}}).to_string();
        let res = json!({"type":"user","timestamp":"2026-10-06T08:00:01.000Z","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"u1","content":"Updated task #5"}]}}).to_string();
        vec![with(vec![upd, res]), step(p("s1")), step(p("s1"))]
    }));
    // what the engine hands to Node
    v.push(case("actionable-pending-defers", vec![with(task(1, "Free and pending", "pending", json!({})))]).defer());
    v.push(case("actionable-pending-demand-off", vec![with(task(1, "Free and pending", "pending", json!({})))]).env("ANTIHALL_DISPATCH_DEMAND", "0"));
    v.push(case("devswarm-primary-defers", vec![step(p("s1"))]).env("DEVSWARM_REPO_ID", "r").defer());
    v.push(case("devswarm-child-answers", vec![step(p("s1"))]).env("DEVSWARM_REPO_ID", "r").env("DEVSWARM_SOURCE_BRANCH", "b"));
    v.push(
        case("dispatch-tier-outcome-pending-defers", vec![with(task(1, "x", "completed", json!({})))])
            .file(".anti-hall/dispatch-tier-state.json", r#"{"requested":{},"sessions":{"s1":{"t":1,"tasks":{"1":{"tier":"subagent","h":"x"}}}}}"#)
            .defer(),
    );
    v.push(case("dispatch-tier-outcome-complete", vec![with(task(1, "x", "completed", json!({})))]).file(
        ".anti-hall/dispatch-tier-state.json",
        r#"{"requested":{},"sessions":{"s1":{"t":1,"tasks":{"1":{"tier":"subagent","h":"x","dispatch":"subagent","result":"one-lane"}}}}}"#,
    ));
    // no session / odd payloads
    v.push(case(
        "no-session-with-cwd",
        vec![step({
            let mut x = p("s1");
            x["cwd"] = json!("/tmp/fixed-proj");
            x.as_object_mut().unwrap().remove("session_id");
            x
        })],
    ));
    v.push(case("no-session-no-cwd-defers", vec![step(json!({"prompt": "x"}))]).defer());
    v.push(case(
        "numeric-session",
        vec![step({
            let mut x = p("s1");
            x["session_id"] = json!(42);
            x
        })],
    ));
    v.push(case("unsafe-session-chars", vec![step(p("a/b c\u{fc}!")), step(p("a/b c\u{fc}!"))]));
    v.push(case("no-prompt", vec![step(json!({"hook_event_name":"UserPromptSubmit","session_id":"s1","cwd":"$HOME/proj"}))]));
    v.push(case(
        "blank-prompt",
        vec![step({
            let mut x = p("s1");
            x["prompt"] = json!("   ");
            x
        })],
    ));
    v.push(case("null-payload", vec![step(Value::Null)]));
    v.push(case(
        "long-prompt",
        vec![step({
            let mut x = p("s1");
            x["prompt"] = json!("word ".repeat(2000));
            x
        })],
    ));
    // demand metrics left by the Node hook
    let fresh_spawn = {
        let ts = ah_engine::checks::taskkit::time::iso((now - 1000.0) as i64);
        json!({"type":"assistant","timestamp":ts,"message":{"role":"assistant","content":[{"type":"tool_use","id":"a","name":"Agent","input":{}}]}}).to_string()
    };
    let metrics = |s1_ts: f64| {
        format!(
            r#"{{"demandsShown":4,"tier":{{"x":1}},"pending":{{"s1":{{"ts":{},"n":2}},"gone":{{"ts":{}}},"bad":"x"}}}}"#,
            s1_ts as i64,
            (now - 2.0 * day) as i64
        )
    };
    v.push(
        case("metrics-demand-followed", vec![Step { payload: p("s1"), transcript: Some(vec![fresh_spawn.clone()]) }])
            .file(".anti-hall/dispatch-demand-metrics.json", &metrics(now - 5000.0)),
    );
    v.push(
        case("metrics-demand-ignored", vec![Step { payload: p("s1"), transcript: Some(vec!["{}".into()]) }])
            .file(".anti-hall/dispatch-demand-metrics.json", &metrics(now - 5000.0)),
    );
    v.push(
        case("metrics-expired-dropped", vec![Step { payload: p("s1"), transcript: Some(vec![fresh_spawn]) }])
            .file(".anti-hall/dispatch-demand-metrics.json", &metrics(now - 2.0 * day)),
    );
    v.push(case("metrics-garbage", vec![step(p("s1"))]).file(".anti-hall/dispatch-demand-metrics.json", "{oops"));
    v.push(case("metrics-array-defers", vec![step(p("s1"))]).file(".anti-hall/dispatch-demand-metrics.json", "[]").defer());
    v.push(
        case("metrics-clean-no-rewrite", vec![step(p("s1"))])
            .file(".anti-hall/dispatch-demand-metrics.json", r#"{"demandsShown":1,"demandsFollowed":0,"demandsIgnored":0,"idleNeglectBlocks":0,"pending":{}}"#),
    );
    // the burst collapse: a queued prompt delivered twice with the same text
    v.push(case("burst-same-session-twice", vec![step(p("s1")), step(p("s1"))]).env("ANTIHALL_INJECTION_REPEAT_EVERY", "0"));
    v.push(case("dedupe-store-garbage", vec![step(p("s1"))]).file(".anti-hall/emit-dedupe/dedupe-s1.json", "{oops").defer());
    v
}

#[test]
fn the_tracker_says_and_writes_exactly_what_node_does() {
    let cs = cases();
    assert!(cs.len() >= 60, "the corpus must stay broad: {}", cs.len());
    let (same, deferred, emitted) = drive("tracker", cs);
    assert!(same >= 50 && deferred >= 5, "answered {same} deferred {deferred}");
    assert!(emitted >= 40, "the corpus must exercise the emitted texts: {emitted}");
}
