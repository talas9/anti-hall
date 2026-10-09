//! Parity of the PostToolUse pass of the built-in `coordinator-work-guard` check against `hooks/coordinator-work-guard.js`
//! (PreToolUse and `--post`), end to end: the Node side runs both passes in its own home; the engine side answers the
//! PostToolUse pass itself when it can and, as the dispatcher does, hands every other call (the PreToolUse pass, a command the
//! engine cannot classify, a lock it cannot take) to the real Node hook in the engine's own home. Outputs and the state files
//! (window files byte for byte except clock values; metrics, trips log and stamp at the end of each context) must be equal.
//! Real commands from a developer's sessions (`AH_PARITY_REAL_CMDS`, optional local data) extend the corpus.

use super::guard::*;
use super::support::*;
use regex::Regex;
use serde_json::{Value, json};
use std::path::Path;
use std::sync::Arc;

include!("coordinator_post_tables.rs");

type Extra = Arc<dyn Fn(&Path, &Path) + Send + Sync>;

/// A window file's text, keys in the order the guard writes them; `over` replaces values (JSON text) of existing keys.
fn mk(t0: i64, version: &str, over: &[(&str, String)]) -> String {
    let defaults: [(&str, String); 11] = [
        ("v", "1".into()),
        ("version", json!(version).to_string()),
        ("firstTs", (t0 - 1000).to_string()),
        ("ts", "[]".into()),
        ("armed", "true".into()),
        ("calls", "0".into()),
        ("work", "0".into()),
        ("blocks", "0".into()),
        ("lastBlockAt", "0".into()),
        ("skippedWouldBlock", "0".into()),
        ("pre", "[]".into()),
    ];
    let body: Vec<String> = defaults
        .iter()
        .map(|(k, d)| {
            let v = over.iter().find(|(n, _)| n == k).map_or(d.as_str(), |(_, v)| v.as_str());
            format!("\"{k}\":{v}")
        })
        .collect();
    format!("{{{}}}", body.join(","))
}

fn setup_with(t0: i64, extra: Option<Extra>) -> Arc<dyn Fn(&Path) + Send + Sync> {
    Arc::new(move |home: &Path| {
        let d = home.join(".anti-hall");
        std::fs::create_dir_all(&d).expect("state directory");
        let old = |name: &str, body: &str, days: f64| {
            let f = d.join(name);
            write_file(&f, body.as_bytes());
            set_mtime(&f, now_ms() as f64 / 1000.0 - days * 86400.0);
        };
        // stale windows to be folded (versions, counters, a corrupt one, a tokenless-lock one)
        old(
            "coordinator-work-session-stale-a.json",
            &mk(t0, "0.1.0", &[("calls", "5".into()), ("work", "3".into()), ("blocks", "1".into()), ("skippedWouldBlock", "2".into())]),
            10.0,
        );
        old("coordinator-work-session-stale-b.json", &mk(t0, "0.1.0", &[("calls", "2".into()), ("work", "1".into())]), 9.0);
        old("coordinator-work-session-stale-c.json", &mk(t0, "0.2.0", &[("calls", "7".into()), ("work", "7".into()), ("blocks", "4".into())]), 8.0);
        old("coordinator-work-session-stale-d.json", "{not json", 20.0);
        old("coordinator-work-session-stale-e.json", "[1,2]", 20.0);
        old("coordinator-work-session-stale-f.json", "{\"version\":12,\"calls\":\"5\",\"work\":2}", 30.0);
        old("coordinator-work-session-stale-g.json", &mk(t0, "1", &[("calls", "1".into())]), 31.0);
        old("coordinator-work-session-fresh-h.json", &mk(t0, "0.1.0", &[("calls", "9".into())]), 1.0);
        if let Some(e) = &extra {
            e(home, &d);
        }
    })
}

fn lock_rec(ts: i64, pid: Option<u32>) -> String {
    format!("{{\"pid\":{},\"host\":{},\"ts\":{ts},\"token\":\"seed:{ts}\"}}", pid.unwrap_or_else(std::process::id), json!(hostname()))
}

fn base(event: &str, s: &Value, command: &str, id: Option<&str>, extra: &Value) -> Value {
    let mut p = json!({"hook_event_name": event, "tool_name": "Bash", "session_id": s, "cwd": "/tmp", "tool_input": {"command": command}});
    if let Some(i) = id {
        p["tool_use_id"] = json!(i);
    }
    assign(p, extra.clone())
}
fn pre(s: &Value, c: &str, id: Option<&str>, extra: &Value) -> Step {
    Step::new(base("PreToolUse", s, c, id, extra))
}
fn post(s: &Value, c: &str, id: Option<&str>, extra: &Value) -> Step {
    Step::argv(base("PostToolUse", s, c, id, extra), &["--post"])
}
fn pair(s: &Value, c: &str, id: Option<&str>, extra: &Value) -> Vec<Step> {
    vec![pre(s, c, id, extra), post(s, c, id, extra)]
}

struct Corpus {
    r: Rng,
    n: usize,
    t0: i64,
    out: Vec<Scenario>,
}

impl Corpus {
    fn sid(&mut self) -> Value {
        let v = json!(format!("c{}", self.n));
        self.n += 1;
        v
    }
    fn add(&mut self, steps: Vec<Step>, ctx: &Arc<Ctx>, id: String) {
        self.out.push(Scenario { id, ctx: Some(ctx.clone()), steps });
    }
    /// A context with the CLI entry point (`C` of the retired runner): the extra variables replace it where they name it.
    fn c(&self, env: &[(&str, &str)], f: impl FnOnce(Ctx) -> Ctx) -> Arc<Ctx> {
        let mut ctx = Ctx::new().env("CLAUDE_CODE_ENTRYPOINT", "cli");
        for (k, v) in env {
            ctx = ctx.env(k, v);
        }
        ctx.setup = Some(setup_with(self.t0, None));
        f(ctx).arc()
    }
    /// A session of Pre/Post pairs; `pool` supplies the commands.
    fn sess(&mut self, name: &str, ctx: &Arc<Ctx>, (count, len): (usize, usize), pool: &[&str], no_ids: bool, extra: &Value) {
        for i in 0..count {
            let s = self.sid();
            let mut steps = Vec::new();
            for k in 0..len {
                let c = *self.r.pick(pool);
                let idv = format!("t{k}");
                let id = if no_ids { None } else { Some(idv.as_str()) };
                let kind = self.r.next();
                if kind < 0.8 {
                    steps.extend(pair(&s, c, id, extra));
                } else if kind < 0.9 {
                    steps.push(post(&s, c, id, extra));
                } else {
                    steps.push(pre(&s, c, id, extra));
                }
            }
            self.add(steps, ctx, format!("{name}-{i}"));
        }
    }
}

fn norm_text(f: &str, t: &str) -> String {
    if f.ends_with(".lock") {
        return "LOCK".into();
    }
    if f.starts_with("coordinator-work-session-") && f.ends_with(".json") {
        // "firstTs" and "lastBlockAt": a clock value (anything but a bare 0) becomes T; "ts": every entry becomes T
        fn clock(t: &str, key: &str) -> String {
            let re = Regex::new(&format!("\"{key}\":([0-9.e+-]+)")).unwrap();
            for m in re.captures_iter(t) {
                let whole = m.get(0).unwrap();
                let val = m.get(1).unwrap();
                let after = &t[whole.start() + key.len() + 3..];
                if after.starts_with("0,") || after.starts_with("0}") {
                    continue;
                }
                return format!("{}\"{key}\":T{}", &t[..whole.start()], &t[val.end()..]);
            }
            t.to_string()
        }
        let t = clock(t, "firstTs");
        let t = clock(&t, "lastBlockAt");
        let ts = Regex::new(r#""ts":\[([^\]]*)\]"#).unwrap();
        return ts
            .replace(&t, |c: &regex::Captures| format!("\"ts\":[{}]", c[1].split(',').filter(|x| !x.is_empty()).map(|_| "T").collect::<Vec<_>>().join(",")))
            .to_string();
    }
    if f.ends_with("trips.log") {
        let ts = Regex::new(r#""ts":"[^"]*""#).unwrap();
        let mut lines: Vec<String> = t.split('\n').filter(|l| !l.is_empty()).map(|l| ts.replace(l, "\"ts\":\"T\"").to_string()).collect();
        lines.sort();
        return lines.join("\n");
    }
    if f.contains("fold-stamp") {
        return Regex::new(r"\d+").unwrap().replace(t, "T").to_string();
    }
    t.to_string()
}

fn files(p: &Value) -> Regex {
    let sidv = p.get("session_id").and_then(Value::as_str).map(|s| s.trim_matches(js_ws).to_string()).unwrap_or_default();
    Regex::new(&format!("^coordinator-work-session-{}\\.json(\\.lock)?$", regex::escape(&safe_sid(&sidv, 80)))).unwrap()
}

type Shape = (&'static str, fn(&mut Value));

fn shapes() -> Vec<Shape> {
    fn rm(p: &mut Value, k: &str) {
        if let Some(m) = p.as_object_mut() {
            m.remove(k);
        }
    }
    fn sid_with(p: &mut Value, f: impl FnOnce(&str) -> String) {
        let cur = p["session_id"].as_str().unwrap_or("undefined").to_string();
        p["session_id"] = json!(f(&cur));
    }
    vec![
        ("noTool", |p| rm(p, "tool_name")),
        ("otherTool", |p| p["tool_name"] = json!("Edit")),
        ("noSid", |p| rm(p, "session_id")),
        ("sidBlank", |p| p["session_id"] = json!("   ")),
        ("sidNum", |p| p["session_id"] = json!(5)),
        ("sidPad", |p| sid_with(p, |s| format!("  pad{s}  "))),
        ("sidLong", |p| sid_with(p, |s| format!("{s}{}", "L".repeat(120)))),
        ("sidWeird", |p| sid_with(p, |s| format!("{s}a/b c\u{1F600}\u{e9}"))),
        ("noInput", |p| rm(p, "tool_input")),
        ("nullInput", |p| p["tool_input"] = Value::Null),
        ("cmdNum", |p| p["tool_input"]["command"] = json!(5)),
        ("cmdEmpty", |p| p["tool_input"]["command"] = json!("")),
        ("cmdWs", |p| p["tool_input"]["command"] = json!("   ")),
        ("noId", |p| rm(p, "tool_use_id")),
        ("idNum", |p| p["tool_use_id"] = json!(5)),
        ("idEmpty", |p| p["tool_use_id"] = json!("")),
        ("longCmd", |p| p["tool_input"]["command"] = json!(format!("ls {}", "a".repeat(5000)))),
        ("unicodeCmd", |p| p["tool_input"]["command"] = json!("ls \u{e9}")),
        ("cr", |p| p["tool_input"]["command"] = json!("ls\r\npwd")),
    ]
}

pub(crate) fn scenarios() -> Vec<Scenario> {
    let t0 = now_ms() as i64;
    let mut k = Corpus { r: Rng::new(1), n: 0, t0, out: Vec::new() };
    let none = json!({});
    let all: Vec<&str> = WORK.iter().chain(RECOVERY.iter()).chain(READ.iter()).chain(OTHER.iter()).copied().collect();
    let workish: Vec<&str> = WORK.iter().chain(WORK.iter()).chain(READ.iter()).chain(RECOVERY.iter()).chain(OTHER[..8].iter()).copied().collect();
    let ctx_default = k.c(&[], |c| c);
    k.sess("default", &ctx_default, (40, 10), &workish, false, &none);
    k.sess("default-all", &ctx_default, (25, 12), &all, false, &none);
    k.sess("default-read", &ctx_default, (15, 8), &READ, false, &none);
    k.sess("default-noid", &ctx_default, (15, 9), &workish, true, &none);
    // thresholds
    let thr = |k: &Corpus, nudge: &str, block: &str, window: Option<&str>, cap: Option<&str>| {
        let mut env = vec![("ANTIHALL_COORDINATOR_WORK_NUDGE_AT", nudge), ("ANTIHALL_COORDINATOR_WORK_BLOCK_AT", block)];
        if let Some(w) = window {
            env.push(("ANTIHALL_COORDINATOR_WORK_WINDOW_MINUTES", w));
        }
        if let Some(c) = cap {
            env.push(("ANTIHALL_COORDINATOR_WORK_MAX_ENTRIES", c));
        }
        k.c(&env, |c| c)
    };
    let thrs: Vec<(&str, Arc<Ctx>)> = vec![
        ("n1b2", thr(&k, "1", "2", None, None)),
        ("n2b3", thr(&k, "2", "3", None, None)),
        ("n2b0", thr(&k, "2", "0", None, None)),
        ("n0b3", thr(&k, "0", "3", None, None)),
        ("n3b5cap2", thr(&k, "3", "5", None, Some("2"))),
        ("n2b4cap1", thr(&k, "2", "4", None, Some("1"))),
        ("win0", thr(&k, "2", "3", Some("0"), None)),
        ("win1", thr(&k, "2", "3", Some("1"), None)),
        ("n5b6", thr(&k, "5", "6", None, None)),
        ("floats", thr(&k, "2.7", "3.2", None, None)),
        ("junk", thr(&k, "abc", "x", None, None)),
        ("neg", thr(&k, "-1", "-5", None, None)),
        ("blank", thr(&k, " ", "", None, None)),
    ];
    for (name, c) in &thrs {
        k.sess(&format!("thr-{name}"), c, (12, 9), &workish, false, &none);
    }
    // settings.json instead of the environment, junk shapes
    let sets: Vec<(&str, Result<Value, &str>)> = vec![
        ("file", Ok(json!({"guards": {"coordinatorWorkNudgeAt": 2, "coordinatorWorkBlockAt": 3}}))),
        ("fileStr", Ok(json!({"guards": {"coordinatorWorkNudgeAt": "2", "coordinatorWorkBlockAt": " 3 "}}))),
        ("fileJunk", Ok(json!({"guards": {"coordinatorWorkNudgeAt": true, "coordinatorWorkBlockAt": [1], "coordinatorWorkWindowMinutes": null}}))),
        ("fileWin", Ok(json!({"guards": {"coordinatorWorkWindowMinutes": 0}}))),
        ("fileBad", Err("{no")),
        ("fileArr", Err("[1]")),
        ("fileSection", Ok(json!({"guards": 3}))),
        ("fileNeg", Ok(json!({"guards": {"coordinatorWorkNudgeAt": -3, "coordinatorWorkMaxEntries": 0}}))),
        ("fileCap", Ok(json!({"guards": {"coordinatorWorkMaxEntries": 2, "coordinatorWorkNudgeAt": 2}}))),
    ];
    for (name, s) in sets {
        let c = k.c(&[], |c| match s {
            Ok(v) => c.settings(v),
            Err(raw) => c.settings_raw(raw),
        });
        k.sess(&format!("set-{name}"), &c, (8, 8), &workish, false, &none);
    }
    // switches: command-guard off / skipped, the guard's own skip, entry points, subagents, Codex
    let now = now_ms() as i64;
    let sws: Vec<(&str, Arc<Ctx>)> = vec![
        ("cgOff", k.c(&[], |c| c.settings(json!({"safety": {"commandGuard": false}})))),
        ("cgOffEnv", k.c(&[("ANTIHALL_COMMAND_GUARD", "off")], |c| c)),
        ("cgOn", k.c(&[("ANTIHALL_COMMAND_GUARD", "1")], |c| c.settings(json!({"safety": {"commandGuard": false}})))),
        ("skipCg", k.c(&[], |c| c.skip(json!({"command-guard": now + 3600000})))),
        ("skipAll", k.c(&[], |c| c.skip(json!({"all": now + 3600000})))),
        ("skipGuard", k.c(&[("ANTIHALL_COORDINATOR_WORK_NUDGE_AT", "2")], |c| c.skip(json!({"coordinator-work-guard": now + 3600000})))),
        ("skipExpired", k.c(&[], |c| c.skip(json!({"command-guard": now - 5000})))),
        ("epVscode", k.c(&[("CLAUDE_CODE_ENTRYPOINT", "vscode")], |c| c)),
        ("epJetbrains", k.c(&[("CLAUDE_CODE_ENTRYPOINT", "jetbrains")], |c| c)),
        ("epIde", k.c(&[("CLAUDE_CODE_ENTRYPOINT", "terminal_ide_x")], |c| c)),
        ("epAgent", k.c(&[("CLAUDE_CODE_ENTRYPOINT", "agent_tool")], |c| c)),
        ("epUnknown", k.c(&[("CLAUDE_CODE_ENTRYPOINT", "sdk-ts")], |c| c)),
        ("epNone", {
            let mut c = Ctx::new();
            c.setup = Some(setup_with(t0, None));
            c.arc()
        }),
        ("epEmpty", k.c(&[("CLAUDE_CODE_ENTRYPOINT", "")], |c| c)),
    ];
    for (name, c) in &sws {
        k.sess(&format!("sw-{name}"), c, (6, 8), &workish, false, &none);
    }
    let whos: Vec<(&str, Value)> = vec![
        ("agent", json!({"agent_id": "a1"})),
        ("agentType", json!({"agent_type": "Explore"})),
        ("agentFalsy", json!({"agent_id": ""})),
        ("agentNum", json!({"agent_id": 0})),
        ("codex", json!({"turn_id": "t1", "model": "gpt-5.5"})),
        ("codexAgent", json!({"turn_id": "t1", "model": "gpt-5.5", "agent_id": "x"})),
        ("codexNullAgent", json!({"turn_id": "t1", "model": "gpt-5.5", "agent_id": null})),
        ("codexHalf", json!({"turn_id": "t1"})),
    ];
    for (name, extra) in &whos {
        k.sess(&format!("who-{name}"), &ctx_default, (5, 7), &workish, false, extra);
    }
    let noep = {
        let mut c = Ctx::new();
        c.setup = Some(setup_with(t0, None));
        c.arc()
    };
    k.sess("who-codex-noep", &noep, (5, 7), &workish, false, &json!({"turn_id": "t1", "model": "gpt-5.5"}));
    // payload shapes
    for (name, f) in shapes() {
        for c in ["ls", "git commit -m x", "git status && ls"] {
            let s = k.sid();
            let mut a = pair(&s, c, Some("x1"), &none);
            let mut b = pair(&s, c, Some("x2"), &none);
            for st in a.iter_mut().chain(b.iter_mut()) {
                f(&mut st.payload);
            }
            let mut steps = a;
            steps.extend(b);
            steps.extend(pair(&s, c, Some("x3"), &none));
            k.add(steps, &ctx_default, format!("shape-{name}-{}", clip(c, 8)));
        }
    }
    // seeded session state (the engine reads and rewrites what Node wrote)
    let s = |x: &str| x.to_string();
    let pre_entry = |id: &str, work: &str, blockable: &str| format!("{{\"id\":{},\"work\":{work},\"blockable\":{blockable}}}", json!(id));
    let many_pre: Vec<String> = (0..30).map(|i| pre_entry(&format!("q{i}"), if i % 2 == 0 { "true" } else { "false" }, "true")).collect();
    let seeds: Vec<(&str, String)> = vec![
        (
            "fresh",
            mk(t0, "0.1.0", &[("calls", s("3")), ("work", s("3")), ("ts", format!("[{},{},{}]", t0 - 5000, t0 - 4000, t0 - 3000)), ("armed", s("false"))]),
        ),
        (
            "armedTrue",
            mk(t0, "0.1.0", &[("calls", s("3")), ("work", s("3")), ("ts", format!("[{},{},{}]", t0 - 5000, t0 - 4000, t0 - 3000)), ("armed", s("true"))]),
        ),
        ("old", mk(t0, "0.1.0", &[("calls", s("3")), ("work", s("3")), ("ts", format!("[{},{},{}]", t0 - 7200000, t0 - 7100000, t0 - 7000000))])),
        (
            "withPre",
            mk(
                t0,
                "0.1.0",
                &[("pre", format!("[{},{},{}]", pre_entry("p1", "true", "true"), pre_entry("p2", "false", "false"), pre_entry("p1", "false", "true")))],
            ),
        ),
        ("manyPre", mk(t0, "0.1.0", &[("pre", format!("[{}]", many_pre.join(",")))])),
        ("corrupt", s("{not json")),
        ("arr", s("[1]")),
        ("num", s("5")),
        ("nul", s("null")),
        ("str", s("\"x\"")),
        ("empty", s("")),
        ("ver12", s("{\"version\":12,\"calls\":1}")),
        ("noVer", s("{\"calls\":1,\"work\":1}")),
        ("floats", mk(t0, "0.1.0", &[("calls", s("1.5")), ("work", s("0.5")), ("ts", format!("[{t0},\"x\",null,1000]"))])),
        ("strNums", s("{\"version\":\"0.1.0\",\"calls\":\"3\",\"work\":\"2\",\"firstTs\":\"5\",\"ts\":[\"1\",2],\"armed\":\"false\"}")),
        (
            "badPre",
            mk(
                t0,
                "0.1.0",
                &[(
                    "pre",
                    format!(
                        "[{},{},{{\"id\":\"ok\",\"work\":\"yes\",\"blockable\":true}},null,\"x\",{}]",
                        "{\"id\":5,\"work\":true,\"blockable\":true}",
                        "{\"id\":\"\",\"work\":true,\"blockable\":true}",
                        pre_entry("good", "true", "false")
                    ),
                )],
            ),
        ),
        ("negCounters", mk(t0, "0.1.0", &[("calls", s("-1")), ("work", s("-2")), ("blocks", s("-3"))])),
        (
            "extraKeys",
            format!(
                "{{\"v\":1,\"version\":\"0.1.0\",\"junk\":[1],\"firstTs\":{t0},\"ts\":[],\"armed\":true,\"calls\":0,\"work\":0,\"blocks\":0,\"lastBlockAt\":0,\"skippedWouldBlock\":0,\"pre\":[]}}"
            ),
        ),
    ];
    let seed_files: Vec<(String, String)> = seeds.iter().map(|(n, v)| (format!("coordinator-work-session-seed-{n}.json"), v.clone())).collect();
    let seed_ctx = {
        let extra: Extra = Arc::new(move |_home: &Path, d: &Path| {
            for (n, v) in &seed_files {
                write_file(&d.join(n), v.as_bytes());
            }
        });
        let mut c =
            Ctx::new().env("CLAUDE_CODE_ENTRYPOINT", "cli").env("ANTIHALL_COORDINATOR_WORK_NUDGE_AT", "4").env("ANTIHALL_COORDINATOR_WORK_BLOCK_AT", "6");
        c.setup = Some(setup_with(t0, Some(extra)));
        c.arc()
    };
    for (name, _) in &seeds {
        let sv = json!(format!("seed-{name}"));
        let mut steps = Vec::new();
        steps.extend(pair(&sv, "git commit -m a", Some("p1"), &none));
        steps.extend(pair(&sv, "git commit -m b", Some("p2"), &none));
        steps.extend(pair(&sv, "ls", Some("p3"), &none));
        steps.extend(pair(&sv, "git push", Some("p4"), &none));
        steps.extend(pair(&sv, "git commit -m c", Some("q1"), &none));
        steps.push(post(&sv, "git status", Some("q2"), &none));
        k.add(steps, &seed_ctx, format!("seed-{name}"));
    }
    // stored pre-verdicts are reused: a Post whose command differs from its Pre (the script was deleted) follows the stored verdict
    for i in 0..10 {
        let sv = k.sid();
        let w1 = *k.r.pick(&WORK);
        let w2 = *k.r.pick(&WORK);
        let w3 = *k.r.pick(&WORK);
        let w4 = *k.r.pick(&WORK);
        let steps = vec![
            pre(&sv, w1, Some("k1"), &none),
            post(&sv, "ls", Some("k1"), &none),
            pre(&sv, "ls", Some("k2"), &none),
            post(&sv, w2, Some("k2"), &none),
            pre(&sv, w3, Some("k3"), &none),
            post(&sv, w4, Some("k3"), &none),
        ];
        k.add(steps, &ctx_default, format!("reuse-{i}"));
    }
    // locks held by a live process, abandoned locks, and torn lock files
    let held = now_ms() as i64 + 3600000;
    let lock_ctx = |k: &Corpus, extra: Extra| {
        let mut c = Ctx::new()
            .env("CLAUDE_CODE_ENTRYPOINT", "cli")
            .env("ANTIHALL_COORDINATOR_WORK_NUDGE_AT", "2")
            .env("ANTIHALL_TEST_HOME_ISOLATED", "1")
            .env("ANTIHALL_COORDINATOR_WORK_LOCK_WAIT_MS", "30");
        c.setup = Some(setup_with(k.t0, Some(extra)));
        c.arc()
    };
    let write_lock = |name: &'static str, body: Box<dyn Fn() -> String + Send + Sync>| -> Extra {
        Arc::new(move |_h: &Path, d: &Path| write_file(&d.join(name), body().as_bytes()))
    };
    let torn_lock = |fresh: bool| -> Extra {
        Arc::new(move |_h: &Path, d: &Path| {
            let f = d.join("coordinator-work-session-lk.json.lock");
            write_file(&f, b"{\"pid\":");
            // "fresh" is an hour ahead, not the write time: the lock goes stale five seconds after its mtime, and a CI runner
            // loaded by the other sweeps runs the seven steps of this scenario slower than that, so the two sides (set up one
            // after the other) crossed the limit at different steps
            set_mtime(&f, now_ms() as f64 / 1000.0 + if fresh { 3600.0 } else { -60.0 });
        })
    };
    let stale = || lock_rec(now_ms() as i64 - 60000, Some(999999));
    let locks: Vec<(&str, Extra)> = vec![
        ("sessionHeld", write_lock("coordinator-work-session-lk.json.lock", Box::new(move || lock_rec(held, None)))),
        ("sessionStale", write_lock("coordinator-work-session-lk.json.lock", Box::new(stale))),
        ("sessionTorn", torn_lock(false)),
        ("sessionTornFresh", torn_lock(true)),
        ("metricsHeld", write_lock("coordinator-work-metrics.json.lock", Box::new(move || lock_rec(held, None)))),
        ("metricsStale", write_lock("coordinator-work-metrics.json.lock", Box::new(stale))),
        ("foldLockHeld", write_lock("coordinator-work-session-stale-a.json.lock", Box::new(move || lock_rec(held, None)))),
        ("foldLockStale", write_lock("coordinator-work-session-stale-a.json.lock", Box::new(stale))),
    ];
    for (name, f) in locks {
        let lk = json!("lk");
        let mut steps = Vec::new();
        steps.extend(pair(&lk, "git commit -m a", Some("a1"), &none));
        steps.extend(pair(&lk, "git commit -m b", Some("a2"), &none));
        steps.extend(pair(&lk, "git commit -m c", Some("a3"), &none));
        steps.push(post(&lk, "ls", Some("a4"), &none));
        steps.push(post(&lk, "git push", Some("a5"), &none));
        let c = lock_ctx(&k, f);
        k.add(steps, &c, format!("lock-{name}"));
    }
    // real commands (local data) and fuzz
    let cmds: Vec<Value> = real_cmds().into_iter().filter(|c| !c["cmd"].as_str().unwrap_or("").contains("$HOME")).collect();
    let mut by_session: Vec<(Value, Vec<Value>)> = Vec::new();
    for c in cmds {
        let key = c.get("session").cloned().unwrap_or(Value::Null);
        match by_session.iter_mut().find(|(s, _)| *s == key) {
            Some((_, l)) => l.push(c),
            None => by_session.push((key, vec![c])),
        }
    }
    let mut real = 0;
    for (_, list) in &by_session {
        if real >= real_limit().min(600) {
            break;
        }
        let sv = k.sid();
        let mut steps = Vec::new();
        for (i, c) in list.iter().take(12).enumerate() {
            steps.extend(pair(&sv, c["cmd"].as_str().unwrap_or(""), Some(&format!("r{i}")), &json!({"cwd": "/tmp"})));
        }
        real += list.len().min(12);
        let c = k.c(&[("ANTIHALL_COORDINATOR_WORK_NUDGE_AT", "3"), ("ANTIHALL_COORDINATOR_WORK_BLOCK_AT", "5")], |c| c);
        k.add(steps, &c, format!("real-{real}"));
    }
    let fz = k.c(&[("ANTIHALL_COORDINATOR_WORK_NUDGE_AT", "3"), ("ANTIHALL_COORDINATOR_WORK_BLOCK_AT", "6")], |c| c);
    for i in 0..600 {
        let sv = k.sid();
        let mut steps = Vec::new();
        for kk in 0..4 {
            let mut parts = String::new();
            let m = 1 + k.r.below(8);
            for _ in 0..m {
                parts.push_str(k.r.pick(&FRAG));
                parts.push_str(k.r.pick(&WS));
            }
            steps.extend(pair(&sv, &parts, Some(&format!("f{kk}")), &none));
        }
        k.add(steps, &fz, format!("fuzz-{i}"));
    }
    k.out
}

pub(crate) fn opts() -> Opts {
    let mut o = Opts::new("coordinator-work-guard-post", "coordinator-work-guard", "coordinator-work-guard.js");
    o.mode = Mode::Daemon;
    o.events = vec!["PreToolUse", "PostToolUse"];
    o.tools = vec!["*"];
    o.dual = true;
    o.fallback_real = true;
    o.fallback_argv = vec![("PostToolUse", vec!["--post"])];
    o.state_files = Some(files);
    o.state_norm = Some(norm_text);
    o.shared_files = Some(Regex::new(r"^(coordinator-work-metrics\.json|coordinator-work-trips\.log|\.coordinator-work-fold-stamp\.json|coordinator-work-session-(stale|fresh)-.*\.json)$").unwrap());
    o.conc = 4;
    o.node_argv = Some(|s: &Step| if s.payload.get("hook_event_name").and_then(Value::as_str) == Some("PostToolUse") { strs(&["--post"]) } else { Vec::new() });
    o
}
