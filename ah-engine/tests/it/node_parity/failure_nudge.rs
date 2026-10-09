//! Parity of the built-in `failure-root-cause-nudge` check against `hooks/failure-root-cause-nudge.js` (PostToolUseFailure on
//! Bash), run as the real script in a child process. The engine gets its own home; the once-per-turn state file
//! (`turn-gate/tg-<session>.json`) is compared byte for byte after every step.
//!
//! Corpus: (1) expected-failure commands x exit-code texts, (2) payload shapes incl. malformed raw stdin, (3) turn gating over
//! transcripts (human prompts, tool results, meta/sidechain/injected entries, uuid/timestamp, partial tail line, agents),
//! (4) seeded turn-gate state files of every shape, (5) switches and skip (env, settings.json, plugin option, skip.json),
//! (6) real commands from field data as failures (`AH_PARITY_REAL_CMDS`, local data, optional), (7) fuzzed commands.

use super::guard::*;
use super::support::*;
use regex::Regex;
use serde_json::{Value, json};
use std::cell::Cell;
use std::sync::Arc;

include!("failure_nudge_tables.rs");

fn fail(s: &Value, command: &Value, error: Option<&str>, extra: Value) -> Value {
    let mut p = json!({"hook_event_name": "PostToolUseFailure", "tool_name": "Bash", "session_id": s, "cwd": "/tmp", "tool_input": {"command": command}});
    if let Some(e) = error {
        p["error"] = json!(e);
    }
    assign(p, extra)
}

fn jl(lines: &[Value]) -> String {
    format!("{}\n", lines.iter().map(|x| x.as_str().map_or_else(|| x.to_string(), str::to_string)).collect::<Vec<_>>().join("\n"))
}
fn human(uuid: &str, text: &str, extra: Value) -> Value {
    assign(json!({"type": "user", "uuid": uuid, "message": {"role": "user", "content": text}}), extra)
}
fn human_arr(uuid: &str, parts: Value, extra: Value) -> Value {
    assign(json!({"type": "user", "uuid": uuid, "message": {"role": "user", "content": parts}}), extra)
}
fn asst(uuid: &str) -> Value {
    json!({"type": "assistant", "uuid": uuid, "message": {"role": "assistant", "content": [{"type": "text", "text": "ok"}]}})
}
fn none() -> Value {
    json!({})
}

fn transcripts() -> Vec<(&'static str, String)> {
    let filler = format!("{{\"type\":\"assistant\",\"message\":{{\"content\":\"{}\"}}}}\n", "z".repeat(1000)).repeat(700);
    vec![
        ("plain", jl(&[human("u1", "fix the bug", none()), asst("a1")])),
        ("twoPrompts", jl(&[human("u1", "first", none()), asst("a1"), human("u2", "second", none()), asst("a2")])),
        ("toolResultLast", jl(&[human("u1", "run it", none()), asst("a1"), human_arr("u2", json!([{"type": "tool_result", "content": "x"}]), none())])),
        (
            "injectedLast",
            jl(&[
                human("u1", "real prompt", none()),
                human("u2", "<system-reminder>hi</system-reminder>", none()),
                human("u3", "  <task-notification>x", none()),
                human("u4", "<command-name>/x</command-name>", none()),
            ]),
        ),
        (
            "metaLast",
            jl(&[human("u1", "real", none()), human("u2", "meta prompt", json!({"isMeta": true})), human("u3", "side", json!({"isSidechain": true}))]),
        ),
        ("arrText", jl(&[human("u0", "old", none()), human_arr("u9", json!([{"type": "text", "text": "array prompt"}, {"type": "image"}]), none())])),
        ("arrNoText", jl(&[human("u1", "old", none()), human_arr("u2", json!([{"type": "image"}]), none())])),
        ("ts", jl(&[json!({"type": "user", "timestamp": "2026-01-01T00:00:00Z", "message": {"content": "only timestamp"}})])),
        ("noId", jl(&[json!({"type": "user", "message": {"content": "no id at all"}})])),
        ("numId", jl(&[json!({"type": "user", "uuid": 12345, "message": {"content": "numeric id"}})])),
        ("emptyContent", jl(&[human("u1", "real", none()), human("u2", "", none())])),
        ("garbage", format!("not json\n{{\"type\":\"user\"\n\"user\" nope\n{}", jl(&[human("ug", "after garbage", none())]))),
        ("crlf", format!("{}\r\n{}\r\n", human("c1", "one", none()), asst("c2"))),
        ("noTrailingNl", human("n1", "no newline at end", none()).to_string()),
        ("unicode", jl(&[human("\u{e9}-1", "\u{fc}n\u{ef} \u{2603} \u{1F600}", none())])),
        ("empty", String::new()),
        ("onlyAssistant", jl(&[asst("a1"), asst("a2")])),
        ("bigTail", format!("{}{}{}", jl(&[human("early", "early prompt", none())]), jl(&[asst("x")]), filler)),
        ("bigTailPrompt", format!("{}{}", filler, jl(&[human("late", "late prompt", none())]))),
        (
            "partialFirst",
            format!(
                "{{\"type\":\"user\",\"uuid\":\"cut\",\"message\":{{\"content\":\"{}\"}}}}\n{}",
                "y".repeat(530000),
                jl(&[human("tail", "tail prompt", none())])
            ),
        ),
    ]
}

fn tp(k: &str) -> String {
    format!("$HOME/tr-{k}.jsonl")
}

/// `String(session_id)` as the engine's gate file name is built from it.
fn gate(p: &Value) -> Regex {
    let sidv = match p.get("session_id") {
        None | Some(Value::Null) => String::new(),
        Some(Value::Array(a)) => a
            .iter()
            .map(|x| match x {
                Value::Null => String::new(),
                Value::String(s) => s.clone(),
                other => other.to_string(),
            })
            .collect::<Vec<_>>()
            .join(","),
        Some(Value::Object(_)) => "[object Object]".to_string(),
        Some(Value::String(s)) => s.clone(),
        Some(other) => other.to_string(),
    };
    Regex::new(&format!("^turn-gate/tg-{}\\.json$", regex::escape(&safe_sid(&sidv, 80)))).unwrap()
}

type Shape = (&'static str, fn(&mut Value));

fn shapes() -> Vec<Shape> {
    fn cmd(p: &mut Value, v: Value) {
        p["tool_input"]["command"] = v;
    }
    vec![
        ("noTool", |p| {
            without_in_place(p, "tool_name");
        }),
        ("otherTool", |p| p["tool_name"] = json!("Edit")),
        ("lowerTool", |p| p["tool_name"] = json!("bash")),
        ("noInput", |p| {
            without_in_place(p, "tool_input");
        }),
        ("nullInput", |p| p["tool_input"] = Value::Null),
        ("cmdNum", |p| cmd(p, json!(5))),
        ("cmdNull", |p| cmd(p, Value::Null)),
        ("cmdArr", |p| cmd(p, json!(["a"]))),
        ("noCmd", |p| p["tool_input"] = json!({})),
        ("emptyCmd", |p| cmd(p, json!(""))),
        ("errNum", |p| p["error"] = json!(1)),
        ("errNull", |p| p["error"] = Value::Null),
        ("noErr", |p| {
            without_in_place(p, "error");
        }),
        ("interrupt", |p| p["is_interrupt"] = json!(true)),
        ("interruptStr", |p| p["is_interrupt"] = json!("true")),
        ("interruptFalse", |p| p["is_interrupt"] = json!(false)),
        ("noSid", |p| {
            without_in_place(p, "session_id");
        }),
        ("sidNum", |p| p["session_id"] = json!(7)),
        ("sidEmpty", |p| p["session_id"] = json!("")),
        ("sidObj", |p| p["session_id"] = json!({"a": 1})),
        ("sidArr", |p| p["session_id"] = json!(["x", "y"])),
        ("sidBool", |p| p["session_id"] = json!(true)),
        ("sidZero", |p| p["session_id"] = json!(0)),
        ("agent", |p| p["agent_id"] = json!("agent-1")),
        ("agentNum", |p| p["agent_id"] = json!(5)),
        ("agentEmpty", |p| p["agent_id"] = json!("")),
        ("longCmd", |p| cmd(p, json!("x".repeat(200)))),
        ("cmd80", |p| cmd(p, json!("y".repeat(80)))),
        ("cmd81", |p| cmd(p, json!("y".repeat(81)))),
        ("ws", |p| cmd(p, json!("  echo \t a \n b   "))),
        ("uni", |p| cmd(p, json!("echo \u{e9}\u{2603}\u{1F600}x"))),
        ("emoji79", |p| cmd(p, json!(format!("{}\u{1F600}tail", "a".repeat(79))))),
        ("emoji80", |p| cmd(p, json!(format!("{}\u{1F600}tail", "a".repeat(78))))),
        ("emoji81", |p| cmd(p, json!(format!("{}\u{1F600}tail", "a".repeat(80))))),
        ("cjk", |p| cmd(p, json!("\u{65e5}\u{672c}\u{8a9e}".repeat(40)))),
        ("nl", |p| cmd(p, json!("a\nb\r\nc\u{2028}d\u{a0}e"))),
        ("bt", |p| cmd(p, json!("echo `x` \"y\" 'z' \\ $ { }"))),
        ("quote", |p| cmd(p, json!("echo \"he said \\\"hi\\\"\""))),
        ("tpNum", |p| p["transcript_path"] = json!(5)),
        ("tpEmpty", |p| p["transcript_path"] = json!("")),
        ("tpMissing", |p| p["transcript_path"] = json!("/nonexistent/x.jsonl")),
        ("tpDir", |p| p["transcript_path"] = json!("/tmp")),
    ]
}

fn without_in_place(p: &mut Value, k: &str) {
    if let Some(m) = p.as_object_mut() {
        m.remove(k);
    }
}

pub(crate) fn scenarios() -> Vec<Scenario> {
    let mut r = Rng::new(1);
    let counter = Cell::new(0usize);
    let sid = || {
        let v = counter.get();
        counter.set(v + 1);
        json!(format!("f{v}"))
    };
    let mut out: Vec<Scenario> = Vec::new();
    let add = |out: &mut Vec<Scenario>, steps: Vec<Step>, ctx: Option<&Arc<Ctx>>, id: String| out.push(Scenario { id, ctx: ctx.cloned(), steps });
    let one = |command: &str, error: Option<&str>, s: Value| vec![Step::new(fail(&s, &json!(command), error, none()))];

    // ---- transcripts (written into the home of the context that names them)
    let tr = transcripts();
    let tr_files: Vec<(String, Vec<u8>)> = tr.iter().map(|(k, v)| (format!("tr-{k}.jsonl"), v.clone().into_bytes())).collect();
    let with_tr = |extra: Vec<(String, Vec<u8>)>| {
        let mut c = Ctx::new();
        c.files = tr_files.clone();
        c.files.extend(extra);
        c
    };

    // ---- (1) expected-failure commands x error texts
    let exit1 = "Exit code 1\n";
    for c in PRED {
        for e in ERR {
            let s = sid();
            add(&mut out, one(c, e, s), None, format!("exp-{}", clip(c, 24)));
        }
    }
    for c in NOTPRED {
        for e in [exit1, "Exit code 2\n", ""] {
            let s = sid();
            add(&mut out, one(c, Some(e), s), None, format!("notexp-{}", clip(c, 24)));
        }
    }

    // ---- (2) payload shapes
    let base = || fail(&sid(), &json!("false"), Some("Exit code 1\n"), none());
    for (k, f) in shapes() {
        let mut p = base();
        f(&mut p);
        add(&mut out, vec![Step::new(p)], None, format!("shape-{k}"));
        // the corpus also built (and discarded) a second payload per shape; it consumed a session id
        let mut p2 = base();
        f(&mut p2);
    }
    for (k, raw) in [
        ("notjson", "not json".to_string()),
        ("empty", String::new()),
        ("ws", "   ".into()),
        ("arr", "[1]".into()),
        ("num", "5".into()),
        ("str", "\"x\"".into()),
        ("nul", "null".into()),
        ("tru", "true".into()),
        ("obj", "{}".into()),
        ("truncated", "{\"tool_name\":\"Bash\"".into()),
        ("bom", "\u{feff}{\"tool_name\":\"Bash\"}".into()),
        ("deep", format!("{}{}", "[".repeat(200), "]".repeat(200))),
    ] {
        add(&mut out, vec![Step::raw(json!({}), &raw)], None, format!("raw-{k}"));
    }

    // ---- (3) turn gating over transcripts
    let f1 = |s: &Value, k: &str, command: Option<&str>, extra: Value| {
        Step::new(fail(s, &json!(command.unwrap_or("false")), Some("Exit code 2\nboom"), assign(json!({"transcript_path": tp(k)}), extra)))
    };
    let ctx_t = with_tr(Vec::new()).arc();
    for (k, _) in &tr {
        let s = sid();
        let steps = vec![f1(&s, k, None, none()), f1(&s, k, Some("false2"), none()), f1(&s, k, Some("false3"), none()), f1(&sid(), k, None, none())];
        add(&mut out, steps, Some(&ctx_t), format!("turn-{k}"));
    }
    {
        let s = sid();
        let steps = vec![
            f1(&s, "plain", None, none()),
            f1(&s, "plain", None, none()),
            f1(&s, "twoPrompts", None, none()),
            f1(&s, "twoPrompts", None, none()),
            f1(&s, "plain", None, none()),
            f1(&s, "plain", None, none()),
        ];
        add(&mut out, steps, Some(&ctx_t), "turn-newturn".into());
        let s2 = sid();
        let steps = vec![
            f1(&s2, "plain", Some("x"), json!({"agent_id": "ag1"})),
            f1(&s2, "plain", Some("x"), json!({"agent_id": "ag1"})),
            f1(&s2, "plain", Some("x"), json!({"agent_id": "ag2"})),
            f1(&s2, "plain", Some("x"), none()),
            f1(&s2, "plain", Some("x"), none()),
            f1(&s2, "plain", Some("x"), json!({"agent_id": "ag1"})),
        ];
        add(&mut out, steps, Some(&ctx_t), "turn-agents".into());
        let s3 = sid();
        let nopath = |s: &Value| {
            let mut st = f1(s, "plain", Some("x"), none());
            st.payload = without(st.payload, &["transcript_path"]);
            st
        };
        let steps = vec![nopath(&s3), nopath(&s3), f1(&s3, "plain", Some("x"), json!({"transcript_path": 5}))];
        add(&mut out, steps, Some(&ctx_t), "turn-nopath".into());
        let ids: Vec<(Value, String)> = vec![
            (json!("weird id/1"), "\"weird id/1\"".into()),
            (json!("\u{fc}n\u{ef}"), "\"\u{fc}n\u{ef}\"".into()),
            (json!("a".repeat(100)), format!("\"{}\"", "a".repeat(100))),
            (json!("\u{1F600}x"), "\"\u{1F600}x\"".into()),
            (json!("x y"), "\"x y\"".into()),
            (json!(".."), "\"..\"".into()),
            (json!("a.b-c_d"), "\"a.b-c_d\"".into()),
            (json!(12), "12".into()),
            (json!(true), "true".into()),
            (json!(["a", "b"]), "[\"a\",\"b\"]".into()),
            (json!({"k": 1}), "{\"k\":1}".into()),
            (json!(format!("{}\u{1F600}", "a".repeat(79))), format!("\"{}\u{1F600}\"", "a".repeat(79))),
        ];
        for (id, shown) in ids {
            let c = with_tr(Vec::new()).arc();
            add(&mut out, vec![f1(&id, "plain", None, none()), f1(&id, "plain", None, none())], Some(&c), format!("turn-sid-{}", clip(&shown, 12)));
        }
    }

    // ---- (4) seeded turn-gate state files
    let slot = "failure-root-cause-nudge|main";
    let many: Vec<String> = (0..30).map(|i| format!("\"s{i}\"")).collect();
    let states: Vec<(&str, String)> = vec![
        ("corrupt", "{nope".into()), ("empty", String::new()), ("arr", "[]".into()), ("arrFull", "[1,2,3]".into()), ("num", "5".into()), ("zero", "0".into()), ("str", "\"x\"".into()), ("emptyStr", "\"\"".into()), ("nul", "null".into()),
        ("tru", "true".into()), ("fls", "false".into()), ("obj", "{}".into()),
        ("sameTurn", format!("{{\"{slot}\":{{\"turn\":\"u1\",\"sigs\":[\"\"]}}}}")),
        ("sameTurnNoEmpty", format!("{{\"{slot}\":{{\"turn\":\"u1\",\"sigs\":[\"x\"]}}}}")),
        ("otherTurn", format!("{{\"{slot}\":{{\"turn\":\"u0\",\"sigs\":[\"\"]}}}}")),
        ("noSigs", format!("{{\"{slot}\":{{\"turn\":\"u1\"}}}}")),
        ("sigsStr", format!("{{\"{slot}\":{{\"turn\":\"u1\",\"sigs\":\"\"}}}}")),
        ("turnNum", format!("{{\"{slot}\":{{\"turn\":1,\"sigs\":[\"\"]}}}}")),
        ("slotNull", format!("{{\"{slot}\":null}}")),
        ("slotStr", format!("{{\"{slot}\":\"x\"}}")),
        ("manySigs", format!("{{\"{slot}\":{{\"turn\":\"u1\",\"sigs\":[{}]}}}}", many.join(","))),
        ("otherKeys", "{\"z\":1,\"output-verify-guard|main\":{\"turn\":\"u1\",\"sigs\":[\"a\",\"b\"]},\"a\":{\"x\":[1,{\"y\":2}],\"b\":null},\"10\":1,\"2\":\"two\",\"01\":3}".into()),
        ("dupKeys", format!("{{\"a\":1,\"a\":2,\"{slot}\":{{\"turn\":\"u0\",\"sigs\":[]}}}}")),
        ("nested", "{\"k\":{\"b\":1,\"a\":2,\"c\":{\"z\":1,\"y\":2}}}".into()),
        ("numbers", "{\"n\":1e3,\"m\":1.5,\"big\":12345678901234567890,\"neg\":-0,\"tiny\":1e-7,\"huge\":1e21,\"f\":0.1}".into()),
        ("unicodeKeys", "{\"\u{e9}\":1,\"\u{1F600}\":2,\"a\\u0000b\":3}".into()),
        ("ws", "  {\n  \"k\" : 1 \n}\n".into()),
        ("spaced", "{\"a\": [1, 2, {\"b\": 3}]}".into()),
    ];
    let st_ctx = with_tr(states.iter().map(|(k, v)| (format!(".anti-hall/turn-gate/tg-st-{k}.json"), v.clone().into_bytes())).collect()).arc();
    for (k, _) in &states {
        let s = json!(format!("st-{k}"));
        add(
            &mut out,
            vec![f1(&s, "plain", None, none()), f1(&s, "plain", Some("again"), none()), f1(&s, "twoPrompts", Some("next turn"), none())],
            Some(&st_ctx),
            format!("state-{k}"),
        );
    }

    // ---- (5) switches and skip
    let sws = json!("sw");
    let sw = vec![f1(&sws, "plain", None, none()), f1(&sws, "plain", Some("again"), none())];
    let now = now_ms() as i64;
    let swp = || with_tr(Vec::new());
    let g = |k: &str, v: Value| json!({"guards": {k: v}});
    let ctxs: Vec<(&str, Ctx)> = vec![
        ("off", swp().settings(g("failureRootCauseNudge", json!(false)))),
        ("offStr", swp().settings(g("failureRootCauseNudge", json!("off")))),
        ("offNum", swp().settings(g("failureRootCauseNudge", json!(0)))),
        ("onStr", swp().settings(g("failureRootCauseNudge", json!("yes")))),
        ("junk", swp().settings(g("failureRootCauseNudge", json!("maybe")))),
        ("badjson", swp().settings_raw("{no")),
        ("section", swp().settings(json!({"guards": 5}))),
        ("envOff", swp().env("ANTIHALL_FAILURE_ROOT_CAUSE_NUDGE", "off")),
        ("env0", swp().env("ANTIHALL_FAILURE_ROOT_CAUSE_NUDGE", "0")),
        ("env1", swp().env("ANTIHALL_FAILURE_ROOT_CAUSE_NUDGE", "1").settings(g("failureRootCauseNudge", json!(false)))),
        ("envJunk", swp().env("ANTIHALL_FAILURE_ROOT_CAUSE_NUDGE", "zz").settings(g("failureRootCauseNudge", json!(false)))),
        ("optFalse", swp().env("CLAUDE_PLUGIN_OPTION_GUARDS_FAILURE_ROOT_CAUSE_NUDGE", "false")),
        ("optTrue", swp().env("CLAUDE_PLUGIN_OPTION_GUARDS_FAILURE_ROOT_CAUSE_NUDGE", "true")),
        ("optHost", swp().claude(json!({"pluginConfigs": {"anti-hall": {"options": {"guards_failure_root_cause_nudge": false}}}}))),
        ("noFilter", swp().settings(g("failureNudgeFilter", json!(false)))),
        ("noFilterEnv", swp().env("ANTIHALL_FAILURE_NUDGE_FILTER", "off")),
        ("filterOnEnv", swp().env("ANTIHALL_FAILURE_NUDGE_FILTER", "1").settings(g("failureNudgeFilter", json!(false)))),
        ("noFilterStr", swp().settings(g("failureNudgeFilter", json!("no")))),
        ("skip", swp().skip(json!({"failure-root-cause-nudge": now + 3600000}))),
        ("skipAll", swp().skip(json!({"all": now + 3600000}))),
        ("skipExpired", swp().skip(json!({"failure-root-cause-nudge": now - 1000, "all": now - 1000}))),
        ("skipJunk", swp().skip_raw("{no")),
        ("skipStr", swp().skip(json!({"failure-root-cause-nudge": "x"}))),
    ];
    for (k, c) in ctxs {
        let c = c.arc();
        add(&mut out, sw.clone(), Some(&c), format!("ctx-{k}"));
        let steps = vec![
            f1(&json!("sw2"), "plain", Some("grep a f"), none()),
            Step::new(fail(&json!("sw2"), &json!("grep -q a f"), Some(exit1), json!({"transcript_path": tp("plain")}))),
            f1(&json!("sw2"), "plain", Some("x"), none()),
        ];
        add(&mut out, steps, Some(&c), format!("ctx2-{k}"));
    }

    // ---- (6) real commands as failures (local data), (7) fuzz
    let cmds: Vec<Value> = real_cmds().into_iter().filter(|c| !c["cmd"].as_str().unwrap_or("").contains("$HOME")).collect();
    let want = real_limit().min(3000);
    let tpk: Vec<&str> = tr.iter().map(|(k, _)| *k).collect();
    for i in 0..want.min(cmds.len()) {
        let c = cmds[r.below(cmds.len())].clone();
        let err = *r.pick(&[exit1, exit1, "Exit code 2\n", "Exit code 127\n", "Exit code 1\nstdout...", ""]);
        let s = sid();
        add(&mut out, vec![Step::new(fail(&s, &c["cmd"], Some(err), none()))], None, format!("real-{i}"));
    }
    for i in 0..4000 {
        let mut parts = String::new();
        let k = 1 + r.below(9);
        for _ in 0..k {
            parts.push_str(r.pick(&FRAG));
            parts.push_str(r.pick(&WS));
        }
        let s = sid();
        let err = *r.pick(&[exit1, exit1, exit1, "Exit code 2\n"]);
        add(&mut out, vec![Step::new(fail(&s, &json!(parts), Some(err), none()))], None, format!("fuzz-{i}"));
    }
    // the human-text / state fuzz over transcripts
    for i in 0..300 {
        let s = sid();
        let k = *r.pick(&tpk);
        let k2 = *r.pick(&tpk);
        add(
            &mut out,
            vec![f1(&s, k, Some("false"), none()), f1(&s, k2, Some("false"), none()), f1(&s, k, Some("false"), none())],
            Some(&ctx_t),
            format!("turnfuzz-{i}"),
        );
    }
    out
}

pub(crate) fn opts() -> Opts {
    let mut o = Opts::new("failure-root-cause-nudge", "failure-root-cause-nudge", "failure-root-cause-nudge.js");
    o.node_cli = true;
    o.events = vec!["PostToolUseFailure"];
    o.mode = Mode::Daemon;
    o.state_files = Some(gate);
    o.conc = 6;
    o
}
