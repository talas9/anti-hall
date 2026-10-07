//! Node-vs-engine parity for the built-in `ask-guard`, `silent-agent-nudge` and `stale-agent-stop-note` checks.
//!
//! Each scenario builds one isolated home (settings, skip file, state, heartbeats, a transcript with the line shapes the
//! harness writes, output files with chosen ages), runs the REAL Node hook against one copy and `ah-engine check <name>`
//! against an identical second copy, and compares exit code, stdout, stderr and every file the run left in the home. A
//! scenario either expects the engine to answer exactly as Node did, or to defer (`AHFALLBACK`) because Node's answer
//! cannot be reproduced exactly (the reason is part of the scenario's name); a deferral is never counted as parity.
//!
//! Node runs with `ANTIHALL_INGEST_DRY_RUN=1` and an isolated HOME, so nothing touches the real store.
use ah_engine::checks::agent_scan::iso_utc;
use serde_json::{Value, json};
use std::collections::BTreeMap;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

fn now_ms() -> f64 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_millis() as f64
}

/// An ISO timestamp `min` minutes before the scenario clock.
fn ago(min: f64) -> String {
    iso_utc((NOW.with(|n| *n) - min * 60_000.0).floor())
}

thread_local! {
    static NOW: f64 = now_ms();
}

#[derive(Clone)]
struct File {
    rel: String,
    body: Vec<u8>,
    /// Age of the file's mtime, in minutes, when it matters.
    age_min: Option<f64>,
}

#[derive(Clone, Copy, PartialEq, Debug)]
enum Expect {
    /// The engine must answer exactly as Node did.
    Same,
    /// The engine must defer to Node.
    Defer,
    /// Either: a deferral is allowed only where Node itself would block, an answer must equal Node's.
    Auto,
}

#[derive(Clone)]
struct Sc {
    name: String,
    hook: &'static str,
    payload: Value,
    /// A raw stdin body that replaces the payload (malformed input).
    raw: Option<String>,
    files: Vec<File>,
    env: Vec<(String, String)>,
    expect: Expect,
    /// Run the Node hook once in both homes first, so the compared run starts from the state Node left (a nudge already given).
    warm: bool,
}

fn sc(name: &str, hook: &'static str, payload: Value) -> Sc {
    Sc { name: name.into(), hook, payload, raw: None, files: Vec::new(), env: Vec::new(), expect: Expect::Same, warm: false }
}

impl Sc {
    fn file(mut self, rel: &str, body: &str) -> Sc {
        self.files.push(File { rel: rel.into(), body: body.as_bytes().to_vec(), age_min: None });
        self
    }
    fn aged(mut self, rel: &str, body: &str, age_min: f64) -> Sc {
        self.files.push(File { rel: rel.into(), body: body.as_bytes().to_vec(), age_min: Some(age_min) });
        self
    }
    fn env(mut self, k: &str, v: &str) -> Sc {
        self.env.push((k.into(), v.into()));
        self
    }
    fn settings(self, v: Value) -> Sc {
        self.file(".anti-hall/settings.json", &v.to_string())
    }
    fn transcript(self, lines: &[String]) -> Sc {
        let mut body = lines.join("\n");
        body.push('\n');
        self.file("t/session.jsonl", &body)
    }
    fn defers(mut self) -> Sc {
        self.expect = Expect::Defer;
        self
    }
    fn raw(mut self, s: &str) -> Sc {
        self.raw = Some(s.into());
        self
    }
}

// ---- transcript line builders (the shapes of tests/hooks/silent-agent-nudge.test.js and teammate-fixtures.js) ----------

fn assistant_use(id: &str, name: &str, input: Value, ts: &str) -> String {
    json!({"type": "assistant", "message": {"role": "assistant", "content": [{"type": "tool_use", "id": id, "name": name, "input": input}]}, "timestamp": ts})
        .to_string()
}

fn result_blocks(id: &str, text: &str, ts: &str, extra: Value) -> String {
    let mut e = json!({"type": "user", "message": {"role": "user", "content": [{"tool_use_id": id, "type": "tool_result", "content": [{"type": "text", "text": text}]}]}, "timestamp": ts});
    if let (Some(o), Some(x)) = (e.as_object_mut(), extra.as_object()) {
        for (k, v) in x {
            o.insert(k.clone(), v.clone());
        }
    }
    e.to_string()
}

fn agent_use(id: &str, desc: &str, ts: &str) -> String {
    assistant_use(id, "Agent", json!({"description": desc, "subagent_type": "general-purpose", "prompt": "do the thing", "run_in_background": true}), ts)
}

fn launch_text(agent: &str, out: &str) -> String {
    format!(
        "Async agent launched successfully. (internal metadata)\nagentId: {agent} (internal ID - do not mention to user. Use SendMessage with to: '{agent}', summary: '<5-10 word recap>' to continue this agent.)\nThe agent is working in the background.\noutput_file: {out}\nDo NOT Read or tail this file via the shell tool."
    )
}

fn launch(tuid: &str, agent: &str, out: &str, ts: &str) -> String {
    result_blocks(tuid, &launch_text(agent, out), ts, json!({}))
}

fn launch_sid(tuid: &str, agent: &str, out: &str, ts: &str) -> String {
    result_blocks(tuid, &launch_text(agent, out), ts, json!({"toolUseResult": {"isAsync": true, "status": "async_launched", "agentId": agent}}))
}

fn notif_text(id: &str, status: &str) -> String {
    format!(
        "<task-notification>\n<task-id>{id}</task-id>\n<tool-use-id>toolu_01ABCDEF</tool-use-id>\n<output-file>/tmp/x/{id}.output</output-file>\n<status>{status}</status>\n<summary>done</summary>\n</task-notification>"
    )
}

fn notif_user(id: &str, status: &str, ts: &str) -> String {
    json!({"type": "user", "message": {"role": "user", "content": notif_text(id, status)}, "timestamp": ts}).to_string()
}

fn notif_attachment(id: &str, status: &str, ts: &str) -> String {
    json!({"type": "attachment", "attachment": {"type": "prompt", "commandMode": false, "prompt": notif_text(id, status), "timestamp": ts}, "timestamp": ts})
        .to_string()
}

fn notif_queue(id: &str, status: &str, ts: &str) -> String {
    json!({"type": "queue-operation", "operation": "enqueue", "content": notif_text(id, status), "timestamp": ts}).to_string()
}

fn task_status(id: &str, status: &str, out: &str, desc: &str, ts: &str) -> String {
    json!({"type": "attachment", "attachment": {"type": "task_status", "taskId": id, "status": status, "outputFilePath": out, "description": desc}, "timestamp": ts}).to_string()
}

fn resume_json(full: &str, short: &str, ts: &str, tuid: &str) -> Vec<String> {
    let text = json!({"success": true, "message": format!("Resuming agent {short} in the background"), "resumedAgentId": full}).to_string();
    vec![assistant_use(tuid, "SendMessage", json!({"to": short, "summary": "s", "message": "go on"}), ts), result_blocks(tuid, &text, ts, json!({}))]
}

fn stop_call(tuid: &str, task: &str, ts: &str, answered: bool, error: bool) -> Vec<String> {
    let mut v = vec![assistant_use(tuid, "TaskStop", json!({"task_id": task}), ts)];
    if answered {
        let content = if error { json!("No task found") } else { json!(json!({"message": "Successfully stopped task: t1", "task_id": "t1"}).to_string()) };
        let mut blk = json!({"tool_use_id": tuid, "type": "tool_result", "content": content});
        if error {
            blk["is_error"] = json!(true);
        }
        v.push(json!({"type": "user", "message": {"role": "user", "content": [blk]}, "timestamp": ts}).to_string());
    }
    v
}

fn teammate_spawn(tuid: &str, name: &str, ts: &str) -> Vec<String> {
    vec![
        assistant_use(tuid, "Agent", json!({"description": format!("teammate {name}"), "subagent_type": "general-purpose", "name": name, "prompt": "p"}), ts),
        result_blocks(
            tuid,
            &format!("Spawned successfully.\nagent_id: {name}@session-fx\nname: {name}\nThe agent is now running."),
            ts,
            json!({"toolUseResult": {"status": "teammate_spawned", "teammate_id": format!("{name}@session-fx"), "agent_id": format!("{name}@session-fx"), "agent_type": "general-purpose", "name": name, "team_name": "session-fx"}}),
        ),
    ]
}

fn inbox_text(name: &str) -> String {
    json!({"success": true, "message": format!("Message sent to {name}'s inbox"), "msg_id": "m-1"}).to_string()
}

fn teammate_send(tuid: &str, name: &str, ts: &str) -> Vec<String> {
    vec![assistant_use(tuid, "SendMessage", json!({"to": name, "summary": "s", "message": "c"}), ts), result_blocks(tuid, &inbox_text(name), ts, json!({}))]
}

fn idle_block(name: &str, inner: &str, reason: &str) -> String {
    format!(
        "<teammate-message teammate_id=\"{name}\" color=\"blue\">\n{}\n</teammate-message>",
        json!({"type": "idle_notification", "from": name, "timestamp": inner, "idleReason": reason, "result": "report"})
    )
}

fn teammate_idle(name: &str, inner: &str, entry_ts: &str) -> String {
    let content = format!(
        "Another Claude session sent a message:\n<teammate-message teammate_id=\"{name}\" color=\"blue\" summary=\"s\">\nreport text\n</teammate-message>\n\n{}\n\nThis came from another Claude session.",
        idle_block(name, inner, "available")
    );
    json!({"type": "user", "message": {"role": "user", "content": content}, "timestamp": entry_ts}).to_string()
}

fn delivery(tuid: &str, agent: &str, ts: &str) -> Vec<String> {
    vec![
        assistant_use(tuid, "TaskOutput", json!({"task_id": agent, "block": false}), ts),
        result_blocks(tuid, &format!("<retrieval_status>success</retrieval_status>\n<task_id>{agent}</task_id>\n<output>report</output>"), ts, json!({})),
    ]
}

fn noise() -> Vec<String> {
    vec![
        String::new(),
        "not json at all".into(),
        "{\"type\":\"user\",".into(),
        "[1,2,3]".into(),
        "null".into(),
        json!({"type": "assistant", "message": {"role": "assistant", "content": [{"type": "text", "text": "plain chatter"}]}, "timestamp": ago(30.0)})
            .to_string(),
    ]
}

// ---- the harness -----------------------------------------------------------------------------------------------

struct Run {
    code: i32,
    out: String,
    err: String,
}

fn run(mut cmd: Command, input: &str) -> Run {
    cmd.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = cmd.spawn().unwrap();
    let mut stdin = child.stdin.take().unwrap();
    let input = input.as_bytes().to_vec();
    let w = std::thread::spawn(move || stdin.write_all(&input));
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
    let deadline = Instant::now() + Duration::from_secs(60);
    let status = loop {
        if let Some(s) = child.try_wait().unwrap() {
            break s;
        }
        if Instant::now() > deadline {
            child.kill().unwrap();
            panic!("child exceeded 60 s");
        }
        std::thread::sleep(Duration::from_millis(2));
    };
    let _ = w.join();
    Run {
        code: status.code().unwrap_or(-1),
        out: String::from_utf8_lossy(&ro.join().unwrap()).to_string(),
        err: String::from_utf8_lossy(&re.join().unwrap()).to_string(),
    }
}

fn subst(v: &Value, home: &str) -> Value {
    match v {
        Value::String(s) => Value::String(s.replace("$HOME", home)),
        Value::Array(a) => Value::Array(a.iter().map(|x| subst(x, home)).collect()),
        Value::Object(o) => Value::Object(o.iter().map(|(k, x)| (k.clone(), subst(x, home))).collect()),
        o => o.clone(),
    }
}

fn materialize(root: &Path, tag: &str, s: &Sc) -> PathBuf {
    let home = root.join(tag);
    std::fs::create_dir_all(home.join(".anti-hall")).unwrap();
    let h = home.to_string_lossy().to_string();
    for f in &s.files {
        let p = home.join(&f.rel);
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        let body = String::from_utf8_lossy(&f.body).replace("$HOME", &h);
        std::fs::write(&p, body.as_bytes()).unwrap();
        if let Some(a) = f.age_min {
            let t = SystemTime::now() - Duration::from_millis((a * 60_000.0) as u64);
            std::fs::File::options().write(true).open(&p).unwrap().set_modified(t).unwrap();
        }
    }
    home
}

fn snapshot(home: &Path) -> BTreeMap<String, String> {
    fn walk(base: &Path, dir: &Path, out: &mut BTreeMap<String, String>) {
        let Ok(rd) = std::fs::read_dir(dir) else { return };
        for e in rd.flatten() {
            let p = e.path();
            let rel = p.strip_prefix(base).unwrap().to_string_lossy().to_string();
            if rel == "engine" {
                continue;
            }
            if p.is_dir() {
                walk(base, &p, out);
            } else {
                let mut body = String::from_utf8_lossy(&std::fs::read(&p).unwrap_or_default()).to_string();
                if rel.ends_with("ask-guard.ndjson") {
                    body = body
                        .lines()
                        .map(|l| l.split("\"ts\":\"").next().unwrap_or("").to_string() + "\"ts\":\"X\"," + l.split_once("\",").map_or("", |x| x.1))
                        .collect::<Vec<_>>()
                        .join("\n");
                }
                if rel.ends_with("silent-agent-nudge-state.json") {
                    // Times differ between the two runs by construction (the run clock, the mtime of each home's own output
                    // file); everything else, keys, their order and the snapshot text around the times, must be identical.
                    let mut masked = String::new();
                    let mut run_len = 0;
                    for c in body.chars() {
                        if c.is_ascii_digit() {
                            run_len += 1;
                            if run_len == 10 {
                                masked.truncate(masked.len() - 9);
                                masked.push('#');
                            } else if run_len < 10 {
                                masked.push(c);
                            }
                        } else {
                            run_len = 0;
                            masked.push(c);
                        }
                    }
                    body = masked;
                }
                out.insert(rel, body.replace(&base.to_string_lossy().to_string(), "$HOME"));
            }
        }
    }
    let mut m = BTreeMap::new();
    walk(home, home, &mut m);
    m
}

fn repo() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("..")
}

fn base_env(c: &mut Command, home: &Path) {
    c.env_clear()
        .env("PATH", std::env::var("PATH").unwrap_or_default())
        .env("HOME", home)
        .env("USERPROFILE", home)
        .env("ANTIHALL_TEST_ISOLATION", "1")
        .env("ANTIHALL_INGEST_DRY_RUN", "1");
}

struct Outcome {
    deferred: bool,
    node_kind: &'static str,
}

fn check_one(root: &Path, idx: usize, s: &Sc, mismatches: &mut Vec<String>) -> Outcome {
    let nh = materialize(root, &format!("{idx}-node"), s);
    let eh = materialize(root, &format!("{idx}-eng"), s);
    let body = |h: &Path| s.raw.clone().unwrap_or_else(|| subst(&s.payload, &h.to_string_lossy()).to_string());
    let mut n = Command::new("node");
    n.arg(repo().join(format!("plugins/anti-hall/hooks/{}.js", s.hook)));
    base_env(&mut n, &nh);
    let mut e = Command::new(env!("CARGO_BIN_EXE_ah-engine"));
    e.arg("check").arg(s.hook);
    base_env(&mut e, &eh);
    e.env("AH_ENGINE_DIR", eh.join("engine"));
    for (k, v) in &s.env {
        n.env(k, v);
        e.env(k, v);
    }
    if s.warm {
        for h in [&nh, &eh] {
            let mut w = Command::new("node");
            w.arg(repo().join(format!("plugins/anti-hall/hooks/{}.js", s.hook)));
            base_env(&mut w, h);
            for (k, v) in &s.env {
                w.env(k, v);
            }
            run(w, &body(h));
        }
    }
    let nr = run(n, &body(&nh));
    let er = run(e, &body(&eh));
    let norm = |t: &str, h: &Path| t.replace(&h.to_string_lossy().to_string(), "$HOME").trim_end().to_string();
    let (nout, nerr) = (norm(&nr.out, &nh), norm(&nr.err, &nh));
    let kind = if nr.code == 2 {
        "block"
    } else if nout.contains("\"decision\":\"block\"") {
        "stop-block"
    } else if nout.contains("additionalContext") {
        "advisory"
    } else if nout.is_empty() {
        "silent"
    } else {
        "other"
    };
    let deferred = er.out.trim_end() == "AHFALLBACK";
    let tag = |m: &str| format!("{} [{}]: {m}", s.name, s.hook);
    match (s.expect, deferred) {
        (Expect::Defer, false) => mismatches.push(tag(&format!("expected a deferral, engine answered code={} out={:?}", er.code, er.out))),
        (Expect::Same, true) => mismatches.push(tag(&format!("engine deferred where it should answer (node: code={} out={:?})", nr.code, nout))),
        (Expect::Auto, true) if kind != "stop-block" => {
            mismatches.push(tag(&format!("engine deferred where Node did not block (node: code={} out={:?})", nr.code, nout)))
        }
        (Expect::Auto, true) => {}
        (Expect::Same | Expect::Auto, false) => {
            let (eout, eerr) = (norm(&er.out, &eh), norm(&er.err, &eh));
            if nr.code != er.code || nout != eout || nerr != eerr {
                mismatches.push(tag(&format!("node code={} out={:?} err={:?} | engine code={} out={:?} err={:?}", nr.code, nout, nerr, er.code, eout, eerr)));
            }
            let (ns, es) = (snapshot(&nh), snapshot(&eh));
            if ns != es {
                let keys: Vec<&String> = ns.keys().chain(es.keys()).collect();
                let diff: Vec<String> = keys
                    .iter()
                    .filter(|k| ns.get(**k) != es.get(**k))
                    .map(|k| {
                        format!(
                            "{k}: node={:?} engine={:?}",
                            ns.get(*k).map(|x| x.chars().take(300).collect::<String>()),
                            es.get(*k).map(|x| x.chars().take(300).collect::<String>())
                        )
                    })
                    .collect();
                mismatches.push(tag(&format!("files differ: {}", diff.join(" || "))));
            }
        }
        (Expect::Defer, true) => {}
    }
    Outcome { deferred, node_kind: kind }
}

fn run_all(tag: &str, list: Vec<Sc>, min_kinds: &[(&str, usize)]) {
    assert!(list.len() >= 30, "{tag}: the corpus must hold at least 30 payloads, has {}", list.len());
    let root = std::env::temp_dir().join(format!("ah-agent-controls-{tag}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    std::fs::create_dir_all(&root).unwrap();
    let mut mismatches = Vec::new();
    let mut kinds: BTreeMap<&str, usize> = BTreeMap::new();
    let (mut same, mut deferred) = (0, 0);
    for (i, s) in list.iter().enumerate() {
        let o = check_one(&root, i, s, &mut mismatches);
        *kinds.entry(o.node_kind).or_default() += 1;
        if o.deferred {
            deferred += 1;
            if o.node_kind == "silent" {
                eprintln!("  deferred where Node was silent: {}", s.name);
            }
        } else {
            same += 1
        }
    }
    let _ = std::fs::remove_dir_all(&root);
    eprintln!("{tag}: {} scenarios, engine answered {same}, deferred {deferred}, node outcomes {kinds:?}", list.len());
    assert!(mismatches.is_empty(), "{tag}: {} mismatches:\n{}", mismatches.len(), mismatches.join("\n"));
    for (k, n) in min_kinds {
        assert!(kinds.get(k).copied().unwrap_or(0) >= *n, "{tag}: the corpus is vacuous: fewer than {n} Node outcomes of kind {k}: {kinds:?}");
    }
}

// ---- stale-agent-stop-note -------------------------------------------------------------------------------------

fn stop_payload(task: Value) -> Value {
    json!({"hook_event_name": "PreToolUse", "tool_name": "TaskStop", "tool_input": {"task_id": task}, "transcript_path": "$HOME/t/session.jsonl", "session_id": "s1", "cwd": "/tmp"})
}

fn stale_corpus() -> Vec<Sc> {
    let h = "stale-agent-stop-note";
    let mut v: Vec<Sc> = Vec::new();
    let mut add = |s: Sc| v.push(s);
    let team = |name: &str| teammate_spawn("tu_spawn", name, &ago(60.0));
    let join = |parts: Vec<Vec<String>>| parts.into_iter().flatten().collect::<Vec<String>>();
    let pend =
        |name: &str, send_min: f64| join(vec![team(name), vec![teammate_idle(name, &ago(50.0), &ago(49.0))], teammate_send("tu_send", name, &ago(send_min))]);
    add(sc("teammate-sent-after-report", h, stop_payload(json!("alice"))).transcript(&pend("alice", 5.0)));
    add(sc("teammate-by-agent-id", h, stop_payload(json!("alice@session-fx"))).transcript(&pend("alice", 5.0)));
    add(sc("teammate-send-old-not-live", h, stop_payload(json!("alice"))).transcript(&pend("alice", 45.0)));
    add(sc("teammate-reported-after-send", h, stop_payload(json!("alice")))
        .transcript(&join(vec![pend("alice", 20.0), vec![teammate_idle("alice", &ago(10.0), &ago(9.0))]])));
    add(sc("teammate-no-prior-report", h, stop_payload(json!("alice"))).transcript(&join(vec![team("alice"), teammate_send("tu_send", "alice", &ago(4.0))])));
    add(sc("teammate-sidechain-newer", h, stop_payload(json!("alice"))).transcript(&pend("alice", 12.0)).aged(
        "t/session/subagents/agent-aalice-0123abcd.jsonl",
        "{}\n",
        2.0,
    ));
    add(sc("teammate-sidechain-older-than-send", h, stop_payload(json!("alice"))).transcript(&pend("alice", 6.0)).aged(
        "t/session/subagents/agent-aalice-0123abcd.jsonl",
        "{}\n",
        30.0,
    ));
    add(sc("teammate-sidechain-bad-name", h, stop_payload(json!("alice")))
        .transcript(&pend("alice", 6.0))
        .aged("t/session/subagents/agent-aalice-XYZ.jsonl", "{}\n", 1.0)
        .aged("t/session/subagents/agent-aalice-0f.txt", "{}\n", 1.0));
    add(sc("teammate-stopped-after-send", h, stop_payload(json!("alice")))
        .transcript(&join(vec![pend("alice", 8.0), stop_call("tu_st", "alice", &ago(7.0), true, false)])));
    add(sc("teammate-stop-errored", h, stop_payload(json!("alice")))
        .transcript(&join(vec![pend("alice", 8.0), stop_call("tu_st", "alice", &ago(7.0), true, true)])));
    add(sc("teammate-stop-unanswered-ignored", h, stop_payload(json!("alice")))
        .transcript(&join(vec![pend("alice", 8.0), stop_call("tu_st", "alice", &ago(7.0), false, false)])));
    add(sc("teammate-two-sends-queued", h, stop_payload(json!("alice"))).transcript(&join(vec![
        team("alice"),
        teammate_send("tu_s1", "alice", &ago(20.0)),
        teammate_send("tu_s2", "alice", &ago(19.0)),
        vec![teammate_idle("alice", &ago(18.0), &ago(17.0))],
    ])));
    add(sc("teammate-unicode-name", h, stop_payload(json!("zoë-日本"))).transcript(&pend("zoë-日本", 5.0)));
    add(sc("teammate-name-with-controls", h, stop_payload(json!("al\nice"))).transcript(&pend("al\nice", 5.0)));
    add(sc("teammate-name-over-60", h, stop_payload(json!("n".repeat(70)))).transcript(&pend(&"n".repeat(70), 5.0)));
    add(sc("teammate-name-over-60-cuts-pair", h, stop_payload(json!(format!("{}{}", "a".repeat(59), "😀tail"))))
        .transcript(&pend(&format!("{}{}", "a".repeat(59), "😀tail"), 5.0))
        .defers());
    add(sc("teammate-two-teammates", h, stop_payload(json!("bob"))).transcript(&join(vec![
        pend("alice", 5.0),
        teammate_spawn("tu_sp2", "bob", &ago(55.0)),
        teammate_send("tu_sd2", "bob", &ago(6.0)),
    ])));
    add(sc("teammate-name-equals-background-id", h, stop_payload(json!("abc123def")))
        .transcript(&join(vec![vec![agent_use("tu_a", "bg", &ago(30.0)), launch("tu_a", "abc123def", "$HOME/out.txt", &ago(30.0))], pend("abc123def", 5.0)])));
    add(sc("teammate-events-without-timestamps", h, stop_payload(json!("alice")))
        .transcript(&pend("alice", 5.0).into_iter().map(|l| l.replace("\"timestamp\"", "\"ts_x\"")).collect::<Vec<_>>()));
    add(sc("teammate-future-inner-timestamp", h, stop_payload(json!("alice"))).transcript(&join(vec![
        team("alice"),
        vec![teammate_idle("alice", &ago(-120.0), &ago(10.0))],
        teammate_send("tu_send", "alice", &ago(5.0)),
    ])));
    add(sc("bg-resumed-no-report", h, stop_payload(json!("a1b2c3d4e5f60718"))).transcript(&join(vec![
        vec![
            agent_use("tu_a", "bg", &ago(60.0)),
            launch("tu_a", "a1b2c3d4e5f60718", "$HOME/out.txt", &ago(60.0)),
            notif_user("a1b2c3d4e5f60718", "stopped", &ago(40.0)),
        ],
        resume_json("a1b2c3d4e5f60718", "a1b2c3d", &ago(10.0), "tu_r"),
    ])));
    add(sc("bg-resumed-then-completed", h, stop_payload(json!("a1b2c3d4e5f60718"))).transcript(&join(vec![
        vec![agent_use("tu_a", "bg", &ago(60.0)), launch("tu_a", "a1b2c3d4e5f60718", "$HOME/out.txt", &ago(60.0))],
        resume_json("a1b2c3d4e5f60718", "a1b2c3d", &ago(10.0), "tu_r"),
        vec![notif_user("a1b2c3d4e5f60718", "completed", &ago(5.0))],
    ])));
    add(sc("bg-stale-terminal-after-resume-order", h, stop_payload(json!("a1b2c3d4e5f60718"))).transcript(&join(vec![
        vec![agent_use("tu_a", "bg", &ago(60.0)), launch("tu_a", "a1b2c3d4e5f60718", "$HOME/out.txt", &ago(60.0))],
        resume_json("a1b2c3d4e5f60718", "a1b2c3d", &ago(10.0), "tu_r"),
        vec![notif_user("a1b2c3d4e5f60718", "stopped", &ago(30.0))],
    ])));
    add(sc("bg-launched-not-resumed", h, stop_payload(json!("a1b2c3d4e5f60718")))
        .transcript(&[agent_use("tu_a", "bg", &ago(60.0)), launch("tu_a", "a1b2c3d4e5f60718", "$HOME/out.txt", &ago(60.0))]));
    add(sc("bg-resume-prefix-only", h, stop_payload(json!("a1b2c3d4e5f60718"))).transcript(&join(vec![
        vec![agent_use("tu_a", "bg", &ago(60.0)), launch("tu_a", "a1b2c3d4e5f60718", "$HOME/out.txt", &ago(60.0))],
        vec![
            assistant_use("tu_r", "SendMessage", json!({"to": "a1b2c3d"}), &ago(9.0)),
            result_blocks("tu_r", "Resuming agent a1b2c3d in the background", &ago(9.0), json!({})),
        ],
    ])));
    add(sc("bg-resume-adopt-unseen-launch", h, stop_payload(json!("ffeeddccbbaa9988"))).transcript(&resume_json(
        "ffeeddccbbaa9988",
        "ffeeddc",
        &ago(9.0),
        "tu_r",
    )));
    add(sc("bg-resume-quoted-in-assistant-text", h, stop_payload(json!("a1b2c3d4e5f60718")))
        .transcript(&[agent_use("tu_a", "bg", &ago(60.0)), launch("tu_a", "a1b2c3d4e5f60718", "$HOME/out.txt", &ago(60.0)),
            json!({"type": "assistant", "message": {"role": "assistant", "content": [{"type": "text", "text": "Resuming agent a1b2c3d4e5f60718 now"}]}, "timestamp": ago(9.0)}).to_string()]));
    add(sc("bg-adopted-task-status-resumed", h, stop_payload(json!("0123456789abcdef"))).transcript(&join(vec![
        vec![task_status("0123456789abcdef", "running", "$HOME/o", "adopted", &ago(50.0))],
        resume_json("0123456789abcdef", "0123456", &ago(9.0), "tu_r"),
    ])));
    add(sc("bg-delivery-evidence-terminal", h, stop_payload(json!("a1b2c3d4e5f60718"))).transcript(&join(vec![
        vec![agent_use("tu_a", "bg", &ago(60.0)), launch("tu_a", "a1b2c3d4e5f60718", "$HOME/out.txt", &ago(60.0))],
        resume_json("a1b2c3d4e5f60718", "a1b2c3d", &ago(20.0), "tu_r"),
        delivery("tu_d", "a1b2c3d4e5f60718", &ago(10.0)),
    ])));
    add(sc("unknown-task-id", h, stop_payload(json!("nobody"))).transcript(&pend("alice", 5.0)));
    add(sc("disabled-by-env", h, stop_payload(json!("alice"))).transcript(&pend("alice", 5.0)).env("ANTIHALL_STALE_AGENT_STOP_NOTE", "off"));
    add(sc("disabled-by-settings", h, stop_payload(json!("alice"))).transcript(&pend("alice", 5.0)).settings(json!({"guards": {"staleAgentStopNote": false}})));
    add(sc("settings-string-false", h, stop_payload(json!("alice"))).transcript(&pend("alice", 5.0)).settings(json!({"guards": {"staleAgentStopNote": "no"}})));
    add(sc("env-garbage-falls-to-settings", h, stop_payload(json!("alice")))
        .transcript(&pend("alice", 5.0))
        .env("ANTIHALL_STALE_AGENT_STOP_NOTE", "maybe")
        .settings(json!({"guards": {"staleAgentStopNote": false}})));
    add(sc("not-taskstop", h, json!({"tool_name": "Bash", "tool_input": {"task_id": "alice"}, "transcript_path": "$HOME/t/session.jsonl"}))
        .transcript(&pend("alice", 5.0)));
    add(sc("missing-task-id", h, json!({"tool_name": "TaskStop", "tool_input": {}, "transcript_path": "$HOME/t/session.jsonl"}))
        .transcript(&pend("alice", 5.0)));
    add(sc("task-id-number", h, stop_payload(json!(5))).transcript(&pend("alice", 5.0)));
    add(sc("task-id-empty", h, stop_payload(json!(""))).transcript(&pend("alice", 5.0)));
    add(sc("no-transcript-path", h, json!({"tool_name": "TaskStop", "tool_input": {"task_id": "alice"}})));
    add(sc("transcript-path-number", h, json!({"tool_name": "TaskStop", "tool_input": {"task_id": "alice"}, "transcript_path": 5})));
    add(sc("transcript-missing-file", h, json!({"tool_name": "TaskStop", "tool_input": {"task_id": "alice"}, "transcript_path": "$HOME/nope.jsonl"})));
    add(sc("transcript-empty-file", h, stop_payload(json!("alice"))).file("t/session.jsonl", ""));
    add(sc("transcript-is-directory", h, json!({"tool_name": "TaskStop", "tool_input": {"task_id": "alice"}, "transcript_path": "$HOME/t"})).file("t/x", ""));
    add(sc("tool-input-missing", h, json!({"tool_name": "TaskStop", "transcript_path": "$HOME/t/session.jsonl"})).transcript(&pend("alice", 5.0)));
    add(sc("payload-array", h, json!([1, 2])));
    add(sc("payload-null", h, json!(null)));
    add(sc("malformed-stdin-defers-to-node", h, json!({})).raw("{not json").defers());
    add(sc("empty-stdin-defers-to-node", h, json!({})).raw("").defers());
    add(sc("noise-lines-around", h, stop_payload(json!("alice"))).transcript(&join(vec![noise(), pend("alice", 5.0), noise()])));
    add(sc("crlf-transcript", h, stop_payload(json!("alice"))).file("t/session.jsonl", &(pend("alice", 5.0).join("\r\n") + "\r\n")));
    add(sc("no-trailing-newline", h, stop_payload(json!("alice"))).file("t/session.jsonl", &pend("alice", 5.0).join("\n")));
    add(sc("lone-surrogate-escape-line", h, stop_payload(json!("alice")))
        .transcript(&join(vec![pend("alice", 5.0), vec![format!("{{\"type\":\"user\",\"message\":{{\"role\":\"user\",\"content\":[{{\"type\":\"tool_result\",\"tool_use_id\":\"x\",\"content\":\"tool_result \\ud800 x\"}}]}},\"timestamp\":\"{}\"}}", ago(1.0))]]))
        .defers());
    add(sc("non-iso-timestamp-defers", h, stop_payload(json!("alice")))
        .transcript(&join(vec![team("alice"), teammate_send("tu_send", "alice", "Oct 6 2026 10:00:00")]))
        .defers());
    add(sc("garbage-timestamp-nan", h, stop_payload(json!("alice"))).transcript(&join(vec![team("alice"), teammate_send("tu_send", "alice", "garbage")])));
    add(sc("offset-timestamps", h, stop_payload(json!("alice"))).transcript(&join(vec![
        team("alice").into_iter().map(|l| l.replace(&ago(60.0), "2026-01-01T00:00:00.000+02:00")).collect(),
        teammate_send("tu_send", "alice", &ago(5.0).replace('Z', "+00:00")),
    ])));
    add(sc("huge-irrelevant-line", h, stop_payload(json!("alice"))).transcript(&join(vec![
        vec![json!({"type": "user", "message": {"role": "user", "content": "x".repeat(3_000_000)}, "timestamp": ago(20.0)}).to_string()],
        pend("alice", 5.0),
    ])));
    add(sc("send-beyond-default-window", h, stop_payload(json!("alice"))).transcript(&join(vec![
        pend("alice", 5.0),
        vec![json!({"type": "user", "message": {"role": "user", "content": "x".repeat(3_000_000)}, "timestamp": ago(2.0)}).to_string()],
    ])));
    v
}

#[test]
fn stale_agent_stop_note_matches_node() {
    run_all("stale", stale_corpus(), &[("advisory", 8), ("silent", 10)]);
}

// ---- ask-guard -------------------------------------------------------------------------------------------------

fn ask_payload(qs: Value) -> Value {
    json!({"hook_event_name": "PreToolUse", "tool_name": "AskUserQuestion", "tool_input": {"questions": qs}, "transcript_path": "$HOME/t/session.jsonl", "session_id": "s1", "cwd": "/tmp"})
}

fn q(header: &str, question: &str) -> Value {
    json!([{"question": question, "header": header, "options": [{"label": "a", "description": "A"}, {"label": "b", "description": "B"}], "multiSelect": false}])
}

fn running(n: usize) -> Vec<String> {
    let mut v = Vec::new();
    for i in 0..n {
        let id = format!("{:016x}", 0xa1b2c3d4e5f60700u64 + i as u64);
        v.push(agent_use(&format!("tu_{i}"), &format!("worker number {i}"), &ago(30.0)));
        v.push(launch(&format!("tu_{i}"), &id, &format!("$HOME/out{i}.txt"), &ago(30.0)));
    }
    v
}

fn ask_corpus() -> Vec<Sc> {
    let h = "ask-guard";
    let mut v: Vec<Sc> = Vec::new();
    let mut add = |s: Sc| v.push(s);
    let on = |s: Sc, mode: &str| s.env("ANTIHALL_NO_BLOCKING_QUESTIONS", mode);
    add(sc("default-off-silent", h, ask_payload(q("h", "Which one?"))).transcript(&running(2)).settings(json!({"guards": {"questionAgentsNote": false}})));
    add(sc("default-note-with-two-agents", h, ask_payload(q("h", "Which one?"))).transcript(&running(2)));
    add(sc("default-note-with-one-agent", h, ask_payload(q("h", "Which one?"))).transcript(&running(1)));
    add(sc("note-seven-agents-more", h, ask_payload(q("h", "Which one?"))).transcript(&running(7)));
    add(sc("note-exactly-five", h, ask_payload(q("h", "Which one?"))).transcript(&running(5)));
    add(sc("note-no-agents", h, ask_payload(q("h", "Which one?"))).transcript(&[
        agent_use("tu_a", "w", &ago(30.0)),
        launch("tu_a", "a1b2c3d4e5f60718", "$HOME/o", &ago(30.0)),
        notif_user("a1b2c3d4e5f60718", "completed", &ago(10.0)),
    ]));
    add(sc("note-agent-finished-attachment-shape", h, ask_payload(q("h", "Which one?"))).transcript(&[
        agent_use("tu_a", "w", &ago(30.0)),
        launch("tu_a", "a1b2c3d4e5f60718", "$HOME/o", &ago(30.0)),
        notif_attachment("a1b2c3d4e5f60718", "failed", &ago(10.0)),
    ]));
    add(sc("note-agent-finished-queue-shape", h, ask_payload(q("h", "Which one?"))).transcript(&[
        agent_use("tu_a", "w", &ago(30.0)),
        launch("tu_a", "a1b2c3d4e5f60718", "$HOME/o", &ago(30.0)),
        notif_queue("a1b2c3d4e5f60718", "KILLED", &ago(10.0)),
    ]));
    add(sc("note-status-not-terminal", h, ask_payload(q("h", "Which one?"))).transcript(&[
        agent_use("tu_a", "w", &ago(30.0)),
        launch("tu_a", "a1b2c3d4e5f60718", "$HOME/o", &ago(30.0)),
        notif_user("a1b2c3d4e5f60718", "running", &ago(10.0)),
    ]));
    add(sc("note-notification-quoted-not-terminal", h, ask_payload(q("h", "Which one?"))).transcript(&[
        agent_use("tu_a", "w", &ago(30.0)),
        launch("tu_a", "a1b2c3d4e5f60718", "$HOME/o", &ago(30.0)),
        json!({"type": "user", "message": {"role": "user", "content": format!("see {}", notif_text("a1b2c3d4e5f60718", "completed"))}, "timestamp": ago(10.0)})
            .to_string(),
    ]));
    add(sc("note-agent-stopped-by-taskstop", h, ask_payload(q("h", "Which one?"))).transcript(
        &[agent_use("tu_a", "w", &ago(30.0)), launch("tu_a", "a1b2c3d4e5f60718", "$HOME/o", &ago(30.0))]
            .into_iter()
            .chain(stop_call("tu_s", "a1b2c3d4e5f60718", &ago(9.0), true, false))
            .collect::<Vec<_>>(),
    ));
    add(sc("note-description-controls", h, ask_payload(q("h", "Which one?")))
        .transcript(&[agent_use("tu_a", "line one\nline\ttwo\u{1}end", &ago(30.0)), launch("tu_a", "a1b2c3d4e5f60718", "$HOME/o", &ago(30.0))]));
    add(sc("note-description-unicode", h, ask_payload(q("h", "Which one?")))
        .transcript(&[agent_use("tu_a", "größe 日本語 \u{1F600}", &ago(30.0)), launch("tu_a", "a1b2c3d4e5f60718", "$HOME/o", &ago(30.0))]));
    add(sc("note-description-empty", h, ask_payload(q("h", "Which one?")))
        .transcript(&[agent_use("tu_a", "", &ago(30.0)), launch("tu_a", "a1b2c3d4e5f60718", "$HOME/o", &ago(30.0))]));
    add(sc("note-description-over-60", h, ask_payload(q("h", "Which one?")))
        .transcript(&[agent_use("tu_a", &"d".repeat(90), &ago(30.0)), launch("tu_a", "a1b2c3d4e5f60718", "$HOME/o", &ago(30.0))]));
    add(sc("note-description-cuts-pair", h, ask_payload(q("h", "Which one?")))
        .transcript(&[
            agent_use("tu_a", &format!("{}{}", "d".repeat(59), "\u{1F600}more"), &ago(30.0)),
            launch("tu_a", "a1b2c3d4e5f60718", "$HOME/o", &ago(30.0)),
        ])
        .defers());
    add(sc("note-launch-via-structured-agent-id", h, ask_payload(q("h", "Which one?")))
        .transcript(&[agent_use("tu_a", "w", &ago(30.0)), launch_sid("tu_a", "a1b2c3d4e5f60718", "$HOME/o", &ago(30.0))]));
    add(sc("note-teammate-pending", h, ask_payload(q("h", "Which one?")))
        .transcript(&[teammate_spawn("tu_sp", "alice", &ago(40.0)), teammate_send("tu_sd", "alice", &ago(4.0))].concat()));
    add(sc("note-adopted-task-status", h, ask_payload(q("h", "Which one?"))).transcript(&[task_status(
        "0123456789abcdef",
        "running",
        "$HOME/o",
        "adopted agent",
        &ago(20.0),
    )]));
    let two_aaaa = || {
        vec![
            agent_use("tu_1", "first", &ago(30.0)),
            launch("tu_1", "aaaa000011112222", "$HOME/o1", &ago(30.0)),
            agent_use("tu_2", "second", &ago(30.0)),
            launch("tu_2", "aaaa0000ffff3333", "$HOME/o2", &ago(30.0)),
        ]
    };
    let output_call = |prefix: &str, text: &str| {
        vec![assistant_use("tu_o", "TaskOutput", json!({"task_id": prefix, "block": false}), &ago(9.0)), result_blocks("tu_o", text, &ago(9.0), json!({}))]
    };
    add(sc("delivery-ambiguous-prefix-ends-nothing", h, ask_payload(q("h", "x")))
        .transcript(&[two_aaaa(), output_call("aaaa0000", "done: aaaa000011112222 and aaaa0000ffff3333 finished")].concat()));
    add(sc("delivery-unique-prefix-ends-one", h, ask_payload(q("h", "x")))
        .transcript(&[two_aaaa(), output_call("aaaa00001", "done: aaaa000011112222 finished")].concat()));
    add(sc("delivery-by-other-tool-ends-nothing", h, ask_payload(q("h", "x"))).transcript(
        &[
            two_aaaa(),
            vec![
                assistant_use("tu_o", "Read", json!({"file_path": "aaaa000011112222"}), &ago(9.0)),
                result_blocks("tu_o", "aaaa000011112222 finished", &ago(9.0), json!({})),
            ],
        ]
        .concat(),
    ));
    add(sc("delivery-text-without-the-id-ends-nothing", h, ask_payload(q("h", "x")))
        .transcript(&[two_aaaa(), output_call("aaaa000011112222", "finished, no id here")].concat()));
    add(sc("delivery-result-of-unseen-call-ends-it", h, ask_payload(q("h", "x")))
        .transcript(&[two_aaaa(), vec![result_blocks("tu_unseen", "report for aaaa000011112222", &ago(9.0), json!({}))]].concat()));
    add(sc("note-no-transcript-path", h, json!({"tool_name": "AskUserQuestion", "tool_input": {"questions": q("h", "x")}})));
    add(sc(
        "note-transcript-missing",
        h,
        json!({"tool_name": "AskUserQuestion", "tool_input": {"questions": q("h", "x")}, "transcript_path": "$HOME/nope.jsonl"}),
    ));
    add(sc("note-transcript-empty", h, ask_payload(q("h", "x"))).file("t/session.jsonl", ""));
    add(sc("note-large-transcript-launch-before-window", h, ask_payload(q("h", "x"))).transcript(
        &[running(1), vec![json!({"type": "user", "message": {"role": "user", "content": "x".repeat(2_000_000)}, "timestamp": ago(20.0)}).to_string()]]
            .concat(),
    ));
    add(sc("note-large-transcript-launch-inside-wide-window", h, ask_payload(q("h", "x"))).transcript(
        &[
            running(1),
            vec![json!({"type": "user", "message": {"role": "user", "content": "x".repeat(2_000_000)}, "timestamp": ago(20.0)}).to_string()],
            vec![notif_user("a1b2c3d4e5f60700", "completed", &ago(5.0))],
        ]
        .concat(),
    ));
    add(sc("note-large-transcript-running-in-window", h, ask_payload(q("h", "x"))).transcript(
        &[vec![json!({"type": "user", "message": {"role": "user", "content": "x".repeat(2_000_000)}, "timestamp": ago(40.0)}).to_string()], running(1)]
            .concat(),
    ));
    add(sc("note-noise-lines", h, ask_payload(q("h", "x"))).transcript(&[noise(), running(1), noise()].concat()));
    add(sc("note-lone-surrogate-line-defers", h, ask_payload(q("h", "x")))
        .transcript(
            &[running(1), vec![format!("{{\"type\":\"user\",\"message\":{{\"content\":\"tool_result \\ud800\"}},\"timestamp\":\"{}\"}}", ago(1.0))]].concat(),
        )
        .defers());
    add(sc("advise-mode", h, ask_payload(q("h", "Which one?")))
        .env("ANTIHALL_NO_BLOCKING_QUESTIONS", "advise")
        .settings(json!({"guards": {"questionAgentsNote": false}})));
    add(on(sc("advise-with-agents", h, ask_payload(q("h", "Which one?"))).transcript(&running(2)), "ADVISE"));
    add(on(sc("advise-child", h, ask_payload(q("h", "Which one?"))).transcript(&running(1)).env("DEVSWARM_SOURCE_BRANCH", "feature/x"), "advise"));
    add(on(sc("advise-child-blank-branch", h, ask_payload(q("h", "Which one?"))).env("DEVSWARM_SOURCE_BRANCH", "   "), "advise"));
    add(sc("advise-from-settings-file", h, ask_payload(q("h", "Which one?")))
        .settings(json!({"guards": {"noBlockingQuestions": "advise", "questionAgentsNote": false}})));
    add(sc("mode-invalid-env-falls-to-file", h, ask_payload(q("h", "x")))
        .env("ANTIHALL_NO_BLOCKING_QUESTIONS", "loud")
        .settings(json!({"guards": {"noBlockingQuestions": "block"}})));
    add(sc("mode-invalid-everywhere-is-off", h, ask_payload(q("h", "x")))
        .env("ANTIHALL_NO_BLOCKING_QUESTIONS", "loud")
        .settings(json!({"guards": {"noBlockingQuestions": "sometimes", "questionAgentsNote": false}})));
    add(on(sc("block-plain-question", h, ask_payload(q("h", "Which one?"))), "block"));
    add(on(sc("block-child", h, ask_payload(q("h", "Which one?"))).env("DEVSWARM_SOURCE_BRANCH", "feat"), "block"));
    add(on(sc("block-marker-in-header", h, ask_payload(q("DESTRUCTIVE: delete", "ok?"))), "block"));
    add(on(sc("block-marker-credential-header", h, ask_payload(q("CREDENTIAL:", "ok?"))), "block"));
    add(on(sc("block-marker-in-question", h, ask_payload(q("h", "  DESTRUCTIVE: really?"))), "block"));
    add(on(sc("block-marker-trimmed-header", h, ask_payload(q("\u{a0}\tCREDENTIAL: x", "?"))), "block"));
    add(on(sc("block-marker-lowercase-rejected", h, ask_payload(q("destructive: x", "destructive: y"))), "block"));
    add(on(sc("block-marker-midtext-rejected", h, ask_payload(q("x", "is this DESTRUCTIVE: yes"))), "block"));
    add(on(
        sc(
            "block-marker-only-second-question",
            h,
            ask_payload(json!([{"question": "a", "header": "a"}, {"question": "DESTRUCTIVE: b", "header": "DESTRUCTIVE:"}])),
        ),
        "block",
    ));
    add(on(sc("block-marker-with-agents-note", h, ask_payload(q("DESTRUCTIVE: x", "?"))).transcript(&running(2)), "block"));
    add(on(sc("block-marker-logs-twice", h, ask_payload(q("CREDENTIAL: x", "?"))).file(".anti-hall/logs/ask-guard.ndjson", "{\"old\":1}\n"), "block"));
    add(on(sc("block-questions-empty-array", h, ask_payload(json!([]))), "block"));
    add(on(sc("block-questions-missing", h, json!({"tool_name": "AskUserQuestion", "tool_input": {}})), "block"));
    add(on(sc("block-questions-not-array", h, ask_payload(json!("DESTRUCTIVE: x"))), "block"));
    add(on(sc("block-first-question-null", h, ask_payload(json!([null, {"header": "DESTRUCTIVE:"}]))), "block"));
    add(on(sc("block-first-question-string", h, ask_payload(json!(["DESTRUCTIVE: x"]))), "block"));
    add(on(sc("block-first-question-array", h, ask_payload(json!([["DESTRUCTIVE: x"]]))), "block"));
    add(on(sc("block-header-number", h, ask_payload(json!([{"header": 5, "question": "DESTRUCTIVE: q"}]))), "block"));
    add(on(sc("block-no-tool-input", h, json!({"tool_name": "AskUserQuestion"})), "block"));
    add(on(sc("block-unicode-reason", h, ask_payload(q("héader ✓", "日本語?"))), "block"));
    add(on(
        sc("skipped-by-skip-file", h, ask_payload(q("h", "x"))).file(".anti-hall/skip.json", &json!({"ask-guard": 99999999999999u64}).to_string()),
        "block",
    ));
    add(on(sc("skipped-by-all", h, ask_payload(q("h", "x"))).file(".anti-hall/skip.json", &json!({"all": 99999999999999u64}).to_string()), "block"));
    add(on(sc("skip-expired", h, ask_payload(q("h", "x"))).file(".anti-hall/skip.json", &json!({"ask-guard": 1}).to_string()), "block"));
    add(on(sc("skip-file-corrupt", h, ask_payload(q("h", "x"))).file(".anti-hall/skip.json", "{oops"), "block"));
    add(on(sc("other-tool", h, json!({"tool_name": "Bash", "tool_input": {"command": "ls"}})), "block"));
    add(on(sc("tool-name-missing", h, json!({"tool_input": {}})), "block"));
    add(on(sc("payload-array", h, json!([1])), "block"));
    add(on(sc("payload-string", h, json!("x")), "block"));
    add(on(sc("malformed-stdin-defers-to-node", h, json!({})).raw("{nope"), "block").defers());
    add(on(sc("empty-stdin-defers-to-node", h, json!({})).raw(""), "block").defers());
    add(sc("note-off-and-mode-off-never-reads-stdin", h, json!({})).raw("{nope").settings(json!({"guards": {"questionAgentsNote": false}})).defers());
    add(sc("plugin-option-note-ignored", h, ask_payload(q("h", "x"))).transcript(&running(1)).env("CLAUDE_PLUGIN_OPTION_GUARDS_QUESTION_AGENTS_NOTE", "false"));
    add(sc("claude-settings-plugin-config-ignored", h, ask_payload(q("h", "x")))
        .transcript(&running(1))
        .file(".claude/settings.json", &json!({"pluginConfigs": {"anti-hall": {"options": {"guards_question_agents_note": false}}}}).to_string()));
    v
}

#[test]
fn ask_guard_matches_node() {
    run_all("ask", ask_corpus(), &[("advisory", 10), ("block", 8), ("silent", 10)]);
}

// ---- silent-agent-nudge ----------------------------------------------------------------------------------------

fn stop_payload_for(session: Value) -> Value {
    json!({"hook_event_name": "Stop", "session_id": session, "transcript_path": "$HOME/t/session.jsonl", "cwd": "/tmp", "stop_hook_active": false})
}

fn stale_run(n: &str) -> Vec<String> {
    vec![
        agent_use(&format!("tu_{n}"), &format!("agent {n}"), &ago(90.0)),
        launch(&format!("tu_{n}"), &format!("a1b2c3d4e5f6{n}"), &format!("$HOME/out-{n}.txt"), &ago(90.0)),
    ]
}

fn state_json(nudged: Value, ever: Value) -> String {
    json!({"nudged": nudged, "everNudged": ever}).to_string()
}

fn hb(id: &str, session: &str, status: &str, ts_ago_min: f64) -> String {
    json!({"id": id, "session": session, "status": status, "step": "working", "ts": (NOW.with(|n| *n) - ts_ago_min * 60_000.0).floor()}).to_string()
}

fn silent_corpus() -> Vec<Sc> {
    let h = "silent-agent-nudge";
    let mut v: Vec<Sc> = Vec::new();
    let mut add = |s: Sc| v.push(s);
    let fresh = |s: Sc, n: &str| s.aged(&format!("out-{n}.txt"), "{}\n", 2.0);
    let old = |s: Sc, n: &str| s.aged(&format!("out-{n}.txt"), "{}\n", 60.0);
    // quiet: nothing silent
    add(fresh(sc("fresh-output-no-candidates", h, stop_payload_for(json!("s1"))).transcript(&stale_run("01")), "01"));
    add(sc("no-agents-at-all", h, stop_payload_for(json!("s1"))).transcript(&noise()));
    add(sc("no-transcript-path", h, json!({"hook_event_name": "Stop", "session_id": "s1"})));
    add(sc("transcript-missing", h, json!({"hook_event_name": "Stop", "session_id": "s1", "transcript_path": "$HOME/nope.jsonl"})));
    add(sc("transcript-empty", h, stop_payload_for(json!("s1"))).file("t/session.jsonl", ""));
    add(sc("finished-agent", h, stop_payload_for(json!("s1")))
        .transcript(&[stale_run("01"), vec![notif_user("a1b2c3d4e5f601", "completed", &ago(10.0))]].concat()));
    // Node would nudge: the engine defers (before touching any state)
    add(old(sc("silent-agent-first-time-defers", h, stop_payload_for(json!("s1"))).transcript(&stale_run("01")), "01").defers());
    add(sc("output-file-missing-defers", h, stop_payload_for(json!("s1"))).transcript(&stale_run("01")).defers());
    add(old(sc("silent-agent-no-session-defers", h, stop_payload_for(json!(null))).transcript(&stale_run("01")), "01").defers());
    add(old(sc("two-silent-agents-defer", h, stop_payload_for(json!("s1"))).transcript(&[stale_run("01"), stale_run("02")].concat()), "01")
        .aged("out-02.txt", "{}\n", 70.0)
        .defers());
    // already nudged: state is rewritten exactly as Node does, nothing is said
    add(sc("missing-output-already-nudged", h, stop_payload_for(json!("s1")))
        .transcript(&stale_run("01"))
        .file(".anti-hall/silent-agent-nudge-state.json", &state_json(json!({"t:a1b2c3d4e5f601": "missing"}), json!({}))));
    add(sc("missing-output-capped-ever", h, stop_payload_for(json!("s1")))
        .transcript(&stale_run("01"))
        .file(".anti-hall/silent-agent-nudge-state.json", &state_json(json!({}), json!({"s1::a1b2c3d4e5f601": (NOW.with(|n| *n) - 1000.0).floor()}))));
    add(sc("ever-cap-other-session-does-not-cap", h, stop_payload_for(json!("s1")))
        .transcript(&stale_run("01"))
        .file(".anti-hall/silent-agent-nudge-state.json", &state_json(json!({}), json!({"s2::a1b2c3d4e5f601": (NOW.with(|n| *n) - 1000.0).floor()})))
        .defers());
    add(sc("ever-cap-expired-defers", h, stop_payload_for(json!("s1")))
        .transcript(&stale_run("01"))
        .file(
            ".anti-hall/silent-agent-nudge-state.json",
            &state_json(json!({}), json!({"s1::a1b2c3d4e5f601": (NOW.with(|n| *n) - 40.0 * 86_400_000.0).floor()})),
        )
        .defers());
    add(sc("state-prunes-dead-keys", h, stop_payload_for(json!("s1"))).transcript(&stale_run("01"))
        .file(".anti-hall/silent-agent-nudge-state.json", &state_json(json!({"t:gone": "x", "t:a1b2c3d4e5f601": "missing", "h:old": "5"}), json!({"s1::gone": (NOW.with(|n| *n) - 1000.0).floor(), "s1::a1b2c3d4e5f601": (NOW.with(|n| *n) - 2000.0).floor(), "s0::x": (NOW.with(|n| *n) - 50.0 * 86_400_000.0).floor()}))));
    add(sc("ever-values-coerced-by-number", h, stop_payload_for(json!("s1"))).transcript(&stale_run("01"))
        .file(".anti-hall/silent-agent-nudge-state.json", &format!("{{\"nudged\":{{\"t:a1b2c3d4e5f601\":\"missing\"}},\"everNudged\":{{\"a\":\"{}\",\"b\":null,\"c\":true,\"d\":[{}],\"e\":{{}},\"f\":\"\",\"g\":\"0x10\"}}}}", (NOW.with(|n| *n) - 5000.0).floor(), (NOW.with(|n| *n) - 6000.0).floor())));
    add(sc("state-corrupt-json-defers-for-first-nudge", h, stop_payload_for(json!("s1")))
        .transcript(&stale_run("01"))
        .file(".anti-hall/silent-agent-nudge-state.json", "{oops")
        .defers());
    add(sc("state-not-an-object", h, stop_payload_for(json!("s1")))
        .transcript(&stale_run("01"))
        .file(".anti-hall/silent-agent-nudge-state.json", "[1,2]")
        .defers());
    add(sc("state-extra-keys-dropped", h, stop_payload_for(json!("s1")))
        .transcript(&stale_run("01"))
        .file(".anti-hall/silent-agent-nudge-state.json", &json!({"nudged": {"t:a1b2c3d4e5f601": "missing"}, "everNudged": {}, "extra": 1}).to_string()));
    add(sc("state-nudged-is-list-defers", h, stop_payload_for(json!("s1")))
        .transcript(&stale_run("01"))
        .file(".anti-hall/silent-agent-nudge-state.json", &json!({"nudged": [1], "everNudged": {}}).to_string())
        .defers());
    add(sc("state-index-like-key-defers", h, stop_payload_for(json!("s1")))
        .transcript(&stale_run("01"))
        .file(".anti-hall/silent-agent-nudge-state.json", "{\"nudged\":{\"t:a1b2c3d4e5f601\":\"missing\",\"7\":\"x\"},\"everNudged\":{}}")
        .defers());
    add(sc("state-nudged-null-members", h, stop_payload_for(json!("s1")))
        .transcript(&stale_run("01"))
        .file(".anti-hall/silent-agent-nudge-state.json", "{\"nudged\":null,\"everNudged\":5}")
        .defers());
    // heartbeat source
    add(sc("heartbeat-stale-defers", h, stop_payload_for(json!("s1"))).file(".anti-hall/agents/hb1.json", &hb("hb1", "s1", "running", 90.0)).defers());
    add(sc("heartbeat-fresh", h, stop_payload_for(json!("s1"))).file(".anti-hall/agents/hb1.json", &hb("hb1", "s1", "running", 2.0)));
    add(sc("heartbeat-finished-status", h, stop_payload_for(json!("s1"))).file(".anti-hall/agents/hb1.json", &hb("hb1", "s1", " Done ", 90.0)));
    add(sc("heartbeat-other-session", h, stop_payload_for(json!("s1"))).file(".anti-hall/agents/hb1.json", &hb("hb1", "s2", "running", 90.0)));
    add(sc("heartbeat-no-session-in-payload", h, stop_payload_for(json!(null))).file(".anti-hall/agents/hb1.json", &hb("hb1", "s2", "running", 90.0)));
    add(sc("heartbeat-recent-spawn-marker", h, stop_payload_for(json!("s1"))).file(".anti-hall/agents/recent-spawn.json", &json!({"ts": 5}).to_string()));
    add(sc("heartbeat-devswarm-file", h, stop_payload_for(json!("s1"))).file(".anti-hall/agents/devswarm-x.json", &hb("x", "s1", "running", 90.0)));
    add(sc("heartbeat-no-id", h, stop_payload_for(json!("s1")))
        .file(".anti-hall/agents/a.json", &json!({"session": "s1", "status": "running", "ts": 5}).to_string()));
    add(sc("heartbeat-ts-zero", h, stop_payload_for(json!("s1")))
        .file(".anti-hall/agents/a.json", &json!({"id": "a", "session": "s1", "status": "running", "ts": 0}).to_string()));
    add(sc("heartbeat-ts-string", h, stop_payload_for(json!("s1")))
        .file(".anti-hall/agents/a.json", &json!({"id": "a", "session": "s1", "status": "running", "ts": "5"}).to_string()));
    add(sc("heartbeat-corrupt", h, stop_payload_for(json!("s1"))).file(".anti-hall/agents/a.json", "{bad"));
    add(sc("heartbeat-not-json-ext", h, stop_payload_for(json!("s1"))).file(".anti-hall/agents/a.txt", &hb("a", "s1", "running", 90.0)));
    let hb_ts = (NOW.with(|n| *n) - 90.0 * 60_000.0).floor();
    add(sc("heartbeat-already-nudged", h, stop_payload_for(json!("s1")))
        .file(".anti-hall/agents/hb1.json", &json!({"id": "hb1", "session": "s1", "status": "running", "step": "w", "ts": hb_ts}).to_string())
        .file(".anti-hall/silent-agent-nudge-state.json", &state_json(json!({"h:hb1": format!("{}", hb_ts as i64)}), json!({}))));
    add(sc("heartbeat-ts-float-defers", h, stop_payload_for(json!("s1")))
        .file(".anti-hall/agents/a.json", &json!({"id": "a", "session": "s1", "status": "running", "ts": 1.5}).to_string())
        .defers());
    // settings, skip, judge child
    add(old(sc("disabled-by-env", h, stop_payload_for(json!("s1"))).transcript(&stale_run("01")).env("ANTIHALL_SILENT_AGENT_NUDGE", "off"), "01"));
    add(old(
        sc("disabled-by-settings", h, stop_payload_for(json!("s1"))).transcript(&stale_run("01")).settings(json!({"guards": {"silentAgentNudge": false}})),
        "01",
    ));
    add(old(
        sc("disabled-by-plugin-option", h, stop_payload_for(json!("s1")))
            .transcript(&stale_run("01"))
            .env("CLAUDE_PLUGIN_OPTION_GUARDS_SILENT_AGENT_NUDGE", "false"),
        "01",
    ));
    add(old(
        sc("plugin-option-equal-default-ignored", h, stop_payload_for(json!("s1")))
            .transcript(&stale_run("01"))
            .env("CLAUDE_PLUGIN_OPTION_GUARDS_SILENT_AGENT_NUDGE", "true"),
        "01",
    )
    .defers());
    add(old(
        sc("skipped", h, stop_payload_for(json!("s1")))
            .transcript(&stale_run("01"))
            .file(".anti-hall/skip.json", &json!({"silent-agent-nudge": 99999999999999u64}).to_string()),
        "01",
    ));
    add(old(
        sc("skipped-all", h, stop_payload_for(json!("s1")))
            .transcript(&stale_run("01"))
            .file(".anti-hall/skip.json", &json!({"all": 99999999999999u64}).to_string()),
        "01",
    ));
    add(old(sc("judge-child-is-silent", h, stop_payload_for(json!("s1"))).transcript(&stale_run("01")).env("ANTIHALL_JUDGE_CHILD", "1"), "01"));
    add(old(sc("judge-child-other-value", h, stop_payload_for(json!("s1"))).transcript(&stale_run("01")).env("ANTIHALL_JUDGE_CHILD", "0"), "01").defers());
    // threshold
    add(old(
        sc("threshold-env-huge-keeps-quiet", h, stop_payload_for(json!("s1"))).transcript(&stale_run("01")).env("ANTIHALL_SILENT_AGENT_NUDGE_MIN", "500"),
        "01",
    ));
    add(old(sc("threshold-env-small-defers", h, stop_payload_for(json!("s1"))).transcript(&stale_run("01")).env("ANTIHALL_SILENT_AGENT_NUDGE_MIN", "5"), "01")
        .defers());
    add(old(
        sc("threshold-zero-clamped-to-one", h, stop_payload_for(json!("s1"))).transcript(&stale_run("01")).env("ANTIHALL_SILENT_AGENT_NUDGE_MIN", "0"),
        "01",
    )
    .defers());
    add(old(
        sc("threshold-garbage-uses-default", h, stop_payload_for(json!("s1")))
            .transcript(&stale_run("01"))
            .env("ANTIHALL_SILENT_AGENT_NUDGE_MIN", "soon")
            .settings(json!({"guards": {"silentAgentNudgeMin": 500}})),
        "01",
    ));
    add(old(sc("threshold-hex-env", h, stop_payload_for(json!("s1"))).transcript(&stale_run("01")).env("ANTIHALL_SILENT_AGENT_NUDGE_MIN", "0x1F4"), "01"));
    add(old(
        sc("threshold-from-settings", h, stop_payload_for(json!("s1"))).transcript(&stale_run("01")).settings(json!({"guards": {"silentAgentNudgeMin": 500}})),
        "01",
    ));
    add(old(
        sc("threshold-plugin-option", h, stop_payload_for(json!("s1")))
            .transcript(&stale_run("01"))
            .env("CLAUDE_PLUGIN_OPTION_GUARDS_SILENT_AGENT_NUDGE_MIN", "500"),
        "01",
    ));
    add(old(sc("threshold-fraction", h, stop_payload_for(json!("s1"))).transcript(&stale_run("01")).env("ANTIHALL_SILENT_AGENT_NUDGE_MIN", "61.5"), "01"));
    // shapes of agent state
    add(sc("resumed-agent-fresh-resume-quiet", h, stop_payload_for(json!("s1")))
        .transcript(&[stale_run("01"), resume_json("a1b2c3d4e5f601", "a1b2c3d", &ago(1.0), "tu_r")].concat())
        .aged("out-01.txt", "{}\n", 60.0));
    add(sc("adopted-without-timestamp-never-nudged", h, stop_payload_for(json!("s1"))).transcript(&[
        json!({"type": "attachment", "attachment": {"type": "task_status", "taskId": "0123456789abcdef", "status": "running", "outputFilePath": "$HOME/nope"}})
            .to_string(),
    ]));
    add(sc("adopted-with-timestamp-missing-output-defers", h, stop_payload_for(json!("s1")))
        .transcript(&[task_status("0123456789abcdef", "running", "$HOME/nope", "adopted", &ago(90.0))])
        .defers());
    add(sc("adopted-then-terminal", h, stop_payload_for(json!("s1"))).transcript(&[
        task_status("0123456789abcdef", "running", "$HOME/nope", "adopted", &ago(90.0)),
        task_status("0123456789abcdef", "completed", "", "", &ago(10.0)),
    ]));
    add(old(
        sc("sidechain-newer-than-output", h, stop_payload_for(json!("s1"))).transcript(&stale_run("01")).aged(
            "t/session/subagents/agent-a1b2c3d4e5f601.jsonl",
            "{}\n",
            1.0,
        ),
        "01",
    ));
    add(sc("teammate-pending-message-never-blocks", h, stop_payload_for(json!("s1")))
        .transcript(&[teammate_spawn("tu_sp", "alice", &ago(120.0)), teammate_send("tu_sd", "alice", &ago(30.0))].concat()));
    add(old(
        sc("noise-lines", h, stop_payload_for(json!("s1")))
            .transcript(&[noise(), stale_run("01"), noise(), vec![notif_attachment("a1b2c3d4e5f601", "stopped", &ago(5.0))]].concat()),
        "01",
    ));
    add(old(
        sc("taskstop-ended-it", h, stop_payload_for(json!("s1")))
            .transcript(&[stale_run("01"), stop_call("tu_s", "a1b2c3d4e5f601", &ago(30.0), true, false)].concat()),
        "01",
    ));
    add(old(
        sc("delivery-evidence-ended-it", h, stop_payload_for(json!("s1")))
            .transcript(&[stale_run("01"), delivery("tu_d", "a1b2c3d4e5f601", &ago(30.0))].concat()),
        "01",
    ));
    add(old(
        sc("running-row-not-delivery", h, stop_payload_for(json!("s1"))).transcript(
            &[
                stale_run("01"),
                vec![
                    assistant_use("tu_l", "TaskOutput", json!({"task_id": "a1b2c3d4e5f601"}), &ago(30.0)),
                    result_blocks("tu_l", "a1b2c3d4e5f601  ·  general  ·  running  ·  started 20m ago", &ago(30.0), json!({})),
                ],
            ]
            .concat(),
        ),
        "01",
    )
    .defers());
    add(sc("lone-surrogate-line-defers", h, stop_payload_for(json!("s1")))
        .transcript(
            &[stale_run("01"), vec![format!("{{\"type\":\"user\",\"message\":{{\"content\":\"tool_result \\ud800\"}},\"timestamp\":\"{}\"}}", ago(1.0))]]
                .concat(),
        )
        .defers());
    add(old(sc("payload-array-still-evaluated", h, json!([])), "01"));
    add(sc("payload-string", h, json!("x")));
    add(sc("malformed-stdin-defers-to-node", h, json!({})).raw("{nope").defers());
    add(sc("empty-stdin-defers-to-node", h, json!({})).raw("").defers());
    add(old(
        sc("session-id-number", h, json!({"hook_event_name": "Stop", "session_id": 5, "transcript_path": "$HOME/t/session.jsonl"}))
            .transcript(&stale_run("01")),
        "01",
    )
    .defers());
    add(old(
        sc("huge-transcript-with-stale-agent", h, stop_payload_for(json!("s1"))).transcript(
            &[
                stale_run("01"),
                vec![json!({"type": "user", "message": {"role": "user", "content": "x".repeat(3_000_000)}, "timestamp": ago(20.0)}).to_string()],
            ]
            .concat(),
        ),
        "01",
    )
    .defers());
    v
}

#[test]
fn silent_agent_nudge_matches_node() {
    let list = silent_corpus();
    run_all("silent", list, &[("silent", 20)]);
}

/// State that names the exact snapshot of an output file: the output file is created first, its mtime read back, and the
/// state written from it, in each home, so both runs see the same snapshot.
#[test]
fn silent_agent_nudge_state_with_real_snapshots() {
    let root = std::env::temp_dir().join(format!("ah-agent-controls-snap-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    std::fs::create_dir_all(&root).unwrap();
    let mut mismatches = Vec::new();
    for (i, (name, resumed)) in [("snapshot-already-nudged-rewrites-state", false), ("resumed-snapshot-already-nudged", true)].iter().enumerate() {
        let mut s = sc(name, "silent-agent-nudge", stop_payload_for(json!("s1")));
        let mut lines = vec![agent_use("tu_01", "agent 01", &ago(90.0)), launch("tu_01", "a1b2c3d4e5f601ab", "$HOME/out-01.txt", &ago(90.0))];
        let resume_ts = (NOW.with(|n| *n) - 2.0 * 60_000.0).floor();
        if *resumed {
            lines.extend(resume_json("a1b2c3d4e5f601ab", "a1b2c3d", &iso_utc(resume_ts), "tu_r"));
        }
        s = s.transcript(&lines).aged("out-01.txt", "{}\n", 60.0);
        // Build both homes, then write each home's state from its own output file's mtime.
        let nh = materialize(&root, &format!("{i}-node"), &s);
        let eh = materialize(&root, &format!("{i}-eng"), &s);
        for h in [&nh, &eh] {
            let mt = std::fs::metadata(h.join("out-01.txt")).unwrap();
            use std::os::unix::fs::MetadataExt;
            let ms = mt.mtime() as f64 * 1000.0 + mt.mtime_nsec() as f64 / 1e6;
            let mut snap = format!("{}", ms.floor() as i64);
            if *resumed {
                snap = format!("{snap}@r{}", resume_ts as i64);
            }
            let key_ever = if *resumed { format!("s1::a1b2c3d4e5f601ab@r{}", resume_ts as i64) } else { "s1::zzz".to_string() };
            std::fs::write(
                h.join(".anti-hall/silent-agent-nudge-state.json"),
                state_json(json!({"t:a1b2c3d4e5f601ab": snap}), json!({key_ever: (NOW.with(|n| *n) - 5000.0).floor()})),
            )
            .unwrap();
        }
        let mut n = Command::new("node");
        n.arg(repo().join("plugins/anti-hall/hooks/silent-agent-nudge.js"));
        base_env(&mut n, &nh);
        let mut e = Command::new(env!("CARGO_BIN_EXE_ah-engine"));
        e.arg("check").arg("silent-agent-nudge");
        base_env(&mut e, &eh);
        e.env("AH_ENGINE_DIR", eh.join("engine"));
        let nr = run(n, &subst(&s.payload, &nh.to_string_lossy()).to_string());
        let er = run(e, &subst(&s.payload, &eh.to_string_lossy()).to_string());
        if er.out.trim_end() == "AHFALLBACK" {
            mismatches.push(format!("{name}: engine deferred (node out={:?})", nr.out));
            continue;
        }
        if nr.code != er.code || nr.out != er.out || nr.err != er.err {
            mismatches.push(format!("{name}: node {} {:?} {:?} engine {} {:?} {:?}", nr.code, nr.out, nr.err, er.code, er.out, er.err));
        }
        let (a, b) = (snapshot(&nh), snapshot(&eh));
        let a: BTreeMap<_, _> = a.into_iter().filter(|(k, _)| k.ends_with("state.json")).collect();
        let b: BTreeMap<_, _> = b.into_iter().filter(|(k, _)| k.ends_with("state.json")).collect();
        let norm = |m: &BTreeMap<String, String>| m.values().map(|v| v.replace(|c: char| c.is_ascii_digit(), "#")).collect::<Vec<_>>();
        if norm(&a) != norm(&b) || a.values().all(String::is_empty) {
            mismatches.push(format!("{name}: state differs or is empty: node {a:?} engine {b:?}"));
        }
        assert!(nr.out.is_empty(), "{name}: the scenario must be a quiet one for Node, got {:?}", nr.out);
    }
    let _ = std::fs::remove_dir_all(&root);
    assert!(mismatches.is_empty(), "{}", mismatches.join("\n"));
}

// ---- a differential fuzz of the scan itself ----------------------------------------------------------------------

struct Rng(u64);

impl Rng {
    fn next(&mut self) -> u64 {
        self.0 = self.0.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
        self.0 >> 33
    }
    fn below(&mut self, n: usize) -> usize {
        (self.next() % n as u64) as usize
    }
    fn chance(&mut self, pct: usize) -> bool {
        self.below(100) < pct
    }
}

const BG: [&str; 4] = ["aaaa000011112222", "aaaa0000ffff3333", "bbbb111122223333", "cccc222233334444"];
const TEAM: [&str; 2] = ["alice", "bob"];

/// One random transcript over a small universe of background agents and teammates, plus the output files their launches name.
fn fuzz_transcript(r: &mut Rng) -> (Vec<String>, Vec<File>) {
    let mut lines: Vec<String> = Vec::new();
    let mut files: Vec<File> = Vec::new();
    let mut tick = 90.0f64;
    let mut n = 0usize;
    let events = 4 + r.below(26);
    for _ in 0..events {
        tick -= r.below(5) as f64 * 0.7 + if r.chance(10) { -3.0 } else { 0.1 };
        let ts = if r.chance(3) { "no-timestamp-here".to_string() } else { ago(tick.max(0.0)) };
        let ts = if ts == "no-timestamp-here" { String::from("garbage") } else { ts };
        n += 1;
        let tu = format!("tu{n}");
        let b = r.below(BG.len());
        let id = BG[b];
        let t = TEAM[r.below(TEAM.len())];
        match r.below(16) {
            0..=2 => {
                lines.push(agent_use(&tu, &format!("agent-{b}"), &ts));
                let out = format!("$HOME/out-{b}.txt");
                lines.push(if r.chance(30) { launch_sid(&tu, id, &out, &ts) } else { launch(&tu, id, &out, &ts) });
                if r.chance(80) {
                    let age = [2.0, 8.0, 30.0, 90.0][r.below(4)];
                    files.retain(|f| f.rel != format!("out-{b}.txt"));
                    files.push(File { rel: format!("out-{b}.txt"), body: b"{}\n".to_vec(), age_min: Some(age) });
                }
            }
            3..=4 => {
                let status = ["completed", "failed", "stopped", "killed", "cancelled", "canceled", "running", "COMPLETED", " completed ", "done"][r.below(10)];
                lines.push(match r.below(3) {
                    0 => notif_user(id, status, &ts),
                    1 => notif_attachment(id, status, &ts),
                    _ => notif_queue(id, status, &ts),
                });
            }
            5..=6 => {
                if r.chance(60) {
                    lines.extend(resume_json(id, &id[..7], &ts, &tu));
                } else {
                    lines.push(assistant_use(&tu, "SendMessage", json!({"to": &id[..7]}), &ts));
                    lines.push(result_blocks(&tu, &format!("Resuming agent {} (x)", &id[..7 + r.below(4)]), &ts, json!({})));
                }
            }
            7 => {
                let target: String = match r.below(4) {
                    0 => id.to_string(),
                    1 => t.to_string(),
                    2 => format!("{t}@session-fx"),
                    _ => "nobody".to_string(),
                };
                lines.extend(stop_call(&tu, &target, &ts, r.chance(80), r.chance(20)));
            }
            8 => lines.extend(teammate_spawn(&tu, t, &ts)),
            9..=10 => lines.extend(teammate_send(&tu, t, &ts)),
            11..=12 => {
                let inner = if r.chance(10) { ago(tick - 30.0) } else { ago((tick + 0.5).max(0.0)) };
                lines.push(teammate_idle(t, &inner, &ts));
            }
            13 => {
                if r.chance(50) {
                    lines.extend(delivery(&tu, id, &ts));
                } else {
                    lines.push(assistant_use(&tu, "TaskOutput", json!({"task_id": &id[..8]}), &ts));
                    let text = if r.chance(50) {
                        format!("{id}  \u{b7}  general  \u{b7}  running  \u{b7}  started 20m ago")
                    } else {
                        format!("report for {id} complete")
                    };
                    lines.push(result_blocks(&tu, &text, &ts, json!({})));
                }
            }
            14 => lines.push(task_status(id, ["running", "completed", "failed"][r.below(3)], &format!("$HOME/out-{b}.txt"), &format!("agent-{b}"), &ts)),
            _ => lines.extend(noise()),
        }
    }
    (lines, files)
}

#[test]
fn the_scan_matches_node_on_random_transcripts() {
    let cases: usize = std::env::var("AH_FUZZ_CASES").ok().and_then(|v| v.parse().ok()).unwrap_or(60);
    let seed: u64 = std::env::var("AH_FUZZ_SEED").ok().and_then(|v| v.parse().ok()).unwrap_or(7);
    let root = std::env::temp_dir().join(format!("ah-agent-controls-fuzz-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    std::fs::create_dir_all(&root).unwrap();
    let mut r = Rng(seed);
    let mut mismatches = Vec::new();
    let mut kinds: BTreeMap<String, usize> = BTreeMap::new();
    let mut idx = 0usize;
    for case in 0..cases {
        let (lines, files) = fuzz_transcript(&mut r);
        let mut base = sc(&format!("fuzz{case}"), "ask-guard", ask_payload(q("h", "x"))).transcript(&lines);
        base.files.extend(files);
        let mut list = vec![base.clone()];
        let mut stale_targets: Vec<String> = BG.iter().map(|s| s.to_string()).collect();
        stale_targets.extend(TEAM.iter().map(|t| t.to_string()));
        stale_targets.push("alice@session-fx".into());
        for t in stale_targets {
            let mut s = base.clone();
            s.name = format!("fuzz{case}-stale-{t}");
            s.hook = "stale-agent-stop-note";
            s.payload = stop_payload(json!(t));
            list.push(s);
        }
        let mut s = base.clone();
        s.name = format!("fuzz{case}-silent");
        s.hook = "silent-agent-nudge";
        s.payload = stop_payload_for(json!("s1"));
        s.expect = Expect::Auto;
        let mut warm = s.clone();
        warm.name = format!("fuzz{case}-silent-warm");
        warm.warm = true;
        warm.expect = Expect::Same;
        list.push(s);
        list.push(warm);
        for s in &list {
            idx += 1;
            let o = check_one(&root, idx, s, &mut mismatches);
            *kinds.entry(format!("{}:{}{}", s.hook, o.node_kind, if o.deferred { ":deferred" } else { "" })).or_default() += 1;
        }
    }
    let _ = std::fs::remove_dir_all(&root);
    eprintln!("fuzz: {cases} transcripts, outcomes {kinds:?}");
    assert!(mismatches.is_empty(), "{} mismatches:\n{}", mismatches.len(), mismatches.iter().take(12).cloned().collect::<Vec<_>>().join("\n"));
    assert!(
        kinds.keys().any(|k| k.starts_with("ask-guard:advisory")) && kinds.keys().any(|k| k.starts_with("stale-agent-stop-note:advisory")),
        "the fuzz is vacuous: {kinds:?}"
    );
}
