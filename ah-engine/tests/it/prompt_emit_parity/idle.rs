//! Scenarios of the `idle-agent-sweep` check (UserPromptSubmit).
use super::harness::*;
use serde_json::{Value, json};

/// The injected clock of every scenario (the hook honours it under `ANTIHALL_TEST_ISOLATION=1`).
const T0: f64 = 1_790_000_000_000.0;
const MIN: f64 = 60_000.0;
const TP: &str = "$HOME/t.jsonl";

fn pl(sid: &str, prompt: &str) -> String {
    payload(json!({"session_id": sid, "transcript_path": TP, "prompt": prompt, "cwd": "/tmp", "hook_event_name": "UserPromptSubmit"}))
}

fn pl_tp(sid: &str, tp: &str, extra: Value) -> String {
    let mut p = json!({"session_id": sid, "transcript_path": tp, "prompt": "go", "cwd": "/tmp", "hook_event_name": "UserPromptSubmit"});
    if let (Some(o), Some(e)) = (p.as_object_mut(), extra.as_object()) {
        for (k, v) in e {
            o.insert(k.clone(), v.clone());
        }
    }
    p.to_string()
}

fn one(name: &str, raw: String, transcript: String) -> Scn {
    scn(format!("idle-{name}"), "idle-agent-sweep", vec![step(raw)])
        .seed(vec![w("t.jsonl", transcript)])
        .env(&[("ANTIHALL_TEST_NOW_MS", &(T0 as u64).to_string())])
}

fn with_clock(mut s: Scn) -> Scn {
    s.env.push(("ANTIHALL_TEST_NOW_MS".into(), (T0 as u64).to_string()));
    s
}

// ---- Claude transcript builders ---------------------------------------------------------------------------------

fn spawn(name: &str, ts: f64, n: usize) -> String {
    let id = format!("toolu_sp{n}");
    format!(
        "{}{}",
        line(
            json!({"type":"assistant","timestamp":iso(ts - 1000.0),"message":{"role":"assistant","content":[{"type":"tool_use","id":id,"name":"Agent","input":{"description":"d","name":name}}]}})
        ),
        line(
            json!({"type":"user","timestamp":iso(ts),"toolUseResult":{"status":"teammate_spawned","name":name,"agent_id":format!("{name}@team")},"message":{"role":"user","content":[{"type":"tool_result","tool_use_id":id,"content":"Spawned"}]}})
        )
    )
}

fn report_text(blocks: &[(&str, Value)]) -> String {
    let mut s = String::from("Another Claude session sent a message:");
    for (name, body) in blocks {
        s.push_str(&format!("\n<teammate-message teammate_id=\"{name}\" color=\"blue\">\n{body}\n</teammate-message>"));
    }
    s
}

fn idle_body(name: &str, ts: f64, reason: Option<&str>) -> Value {
    let mut b = json!({"type":"idle_notification","from":name,"timestamp":iso(ts)});
    if let Some(r) = reason {
        b["idleReason"] = json!(r);
    }
    b
}

fn report(name: &str, entry_ts: f64, inner_ts: f64, reason: Option<&str>) -> String {
    line(json!({"type":"user","timestamp":iso(entry_ts),"message":{"role":"user","content":report_text(&[(name, idle_body(name, inner_ts, reason))])}}))
}

fn finished(name: &str, idle_ago_min: f64, n: usize) -> String {
    let t = T0 - idle_ago_min * MIN;
    format!("{}{}", spawn(name, t - 60_000.0, n), report(name, t + 500.0, t, Some("available")))
}

fn send(name: &str, ts: f64, n: usize) -> String {
    let id = format!("toolu_sd{n}");
    format!(
        "{}{}",
        line(
            json!({"type":"assistant","timestamp":iso(ts - 100.0),"message":{"role":"assistant","content":[{"type":"tool_use","id":id,"name":"SendMessage","input":{"to":name,"message":"go"}}]}})
        ),
        line(
            json!({"type":"user","timestamp":iso(ts),"message":{"role":"user","content":[{"type":"tool_result","tool_use_id":id,"content":json!({"success":true,"message":format!("Message sent to {name}'s inbox")}).to_string()}]}})
        )
    )
}

fn stop(task_id: &str, ts: f64, n: usize, is_error: bool) -> String {
    let id = format!("toolu_st{n}");
    format!(
        "{}{}",
        line(
            json!({"type":"assistant","timestamp":iso(ts - 100.0),"message":{"role":"assistant","content":[{"type":"tool_use","id":id,"name":"TaskStop","input":{"task_id":task_id}}]}})
        ),
        line(
            json!({"type":"user","timestamp":iso(ts),"message":{"role":"user","content":[{"type":"tool_result","tool_use_id":id,"is_error":is_error,"content":"ok"}]}})
        )
    )
}

fn bg_launch(agent_id: &str, ts: f64, n: usize) -> String {
    let id = format!("toolu_bg{n}");
    format!(
        "{}{}",
        line(
            json!({"type":"assistant","timestamp":iso(ts - 100.0),"message":{"role":"assistant","content":[{"type":"tool_use","id":id,"name":"Agent","input":{"description":"bg","run_in_background":true}}]}})
        ),
        line(
            json!({"type":"user","timestamp":iso(ts),"message":{"role":"user","content":[{"type":"tool_result","tool_use_id":id,"content":format!("Async agent launched successfully\nagentId: {agent_id} (internal ID)")}]}})
        )
    )
}

fn notification(task_id: &str, status: &str, ts: f64) -> String {
    line(
        json!({"type":"user","timestamp":iso(ts),"message":{"role":"user","content":format!("<task-notification>\n<task-id>{task_id}</task-id>\n<status>{status}</status>\n</task-notification>")}}),
    )
}

fn n_finished(count: usize, ago_min: f64) -> String {
    (0..count).map(|i| finished(&format!("agent{i:02}"), ago_min + i as f64 * 0.1, i)).collect()
}

// ---- Codex builders ----------------------------------------------------------------------------------------------

const U1: &str = "11111111-2222-3333-4444-555555555555";
const U2: &str = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

fn cx_call(ts: f64, name: &str, args: Value, call: &str) -> String {
    line(json!({"timestamp":iso(ts),"type":"response_item","payload":{"type":"function_call","name":name,"arguments":args.to_string(),"call_id":call}}))
}

fn cx_out(ts: f64, call: &str, out: Value) -> String {
    line(json!({"timestamp":iso(ts),"type":"response_item","payload":{"type":"function_call_output","call_id":call,"output":out.to_string()}}))
}

fn cx_spawn(ts: f64, id: &str, nick: Option<&str>, call: &str) -> String {
    let mut out = json!({"agent_id": id});
    if let Some(n) = nick {
        out["nickname"] = json!(n);
    }
    format!("{}{}", cx_call(ts, "spawn_agent", json!({"message":"hi"}), call), cx_out(ts + 10.0, call, out))
}

fn cx_wait(ts: f64, status: Value, call: &str) -> String {
    format!("{}{}", cx_call(ts, "wait_agent", json!({"targets":[U1]}), call), cx_out(ts + 10.0, call, json!({"status": status})))
}

pub fn scenarios() -> Vec<Scn> {
    let mut v: Vec<Scn> = Vec::new();
    let sid = "idle-s";
    let raw = pl(sid, "continue");

    // ---- when it fires ------------------------------------------------------------------------------------------
    v.push(one("one-old-fires", raw.clone(), finished("alice", 20.0, 1)));
    v.push(one("one-fresh-quiet", raw.clone(), finished("alice", 5.0, 1)));
    v.push(one("one-edge-15", raw.clone(), finished("alice", 15.0, 1)));
    v.push(one("one-just-under", raw.clone(), finished("alice", 14.9, 1)));
    v.push(one("three-fresh-fires", raw.clone(), n_finished(3, 1.0)));
    v.push(one("two-fresh-quiet", raw.clone(), n_finished(2, 1.0)));
    v.push(one("two-one-old-fires", raw.clone(), format!("{}{}", finished("a", 1.0, 1), finished("b", 40.0, 2))));
    v.push(one("many-twelve", raw.clone(), n_finished(12, 3.0)));
    v.push(one("many-eleven-old", raw.clone(), n_finished(11, 30.0)));
    v.push(one("many-ten", raw.clone(), n_finished(10, 30.0)));
    v.push(one("many-hundred", raw.clone(), n_finished(100, 2.0)));
    v.push(one("sorted-oldest-first", raw.clone(), format!("{}{}{}", finished("new", 3.0, 1), finished("mid", 20.0, 2), finished("old", 60.0, 3))));
    v.push(one(
        "equal-idle-times-keep-spawn-order",
        raw.clone(),
        (0..4).map(|i| spawn(&format!("t{i}"), T0 - 3_600_000.0 - 1000.0 * i as f64, i)).collect::<String>()
            + &(0..4).map(|i| report(&format!("t{}", 3 - i), T0 - 1_800_000.0, T0 - 1_800_000.0, Some("available"))).collect::<String>(),
    ));
    // thresholds
    for (n, kv) in [
        ("count-1", vec![("ANTIHALL_IDLE_AGENT_SWEEP_COUNT", "1")]),
        ("count-2", vec![("ANTIHALL_IDLE_AGENT_SWEEP_COUNT", "2")]),
        ("count-2.5", vec![("ANTIHALL_IDLE_AGENT_SWEEP_COUNT", "2.5")]),
        ("count-junk", vec![("ANTIHALL_IDLE_AGENT_SWEEP_COUNT", "many")]),
        ("count-zero", vec![("ANTIHALL_IDLE_AGENT_SWEEP_COUNT", "0")]),
        ("count-hex", vec![("ANTIHALL_IDLE_AGENT_SWEEP_COUNT", "0x2")]),
        ("min-1", vec![("ANTIHALL_IDLE_AGENT_SWEEP_MIN", "1")]),
        ("min-120", vec![("ANTIHALL_IDLE_AGENT_SWEEP_MIN", "120")]),
        ("min-junk", vec![("ANTIHALL_IDLE_AGENT_SWEEP_MIN", "-")]),
        ("min-frac", vec![("ANTIHALL_IDLE_AGENT_SWEEP_MIN", "0.5")]),
        ("opt-ignored", vec![("CLAUDE_PLUGIN_OPTION_GUARDS_IDLE_AGENT_SWEEP_COUNT", "1")]),
    ] {
        v.push(
            one(&format!("threshold-{n}"), raw.clone(), n_finished(2, 4.0))
                .env(&kv.iter().map(|(a, b)| (*a, *b)).chain([("ANTIHALL_TEST_NOW_MS", "1790000000000")]).collect::<Vec<_>>()),
        );
    }
    for (n, body) in [
        ("file-count-1", "{\"guards\":{\"idleAgentSweepCount\":1}}"),
        ("file-count-str", "{\"guards\":{\"idleAgentSweepCount\":\"2\"}}"),
        ("file-min-str", "{\"guards\":{\"idleAgentSweepMin\":\"2\"}}"),
        ("file-count-bad", "{\"guards\":{\"idleAgentSweepCount\":true}}"),
        ("file-off", "{\"guards\":{\"idleAgentSweep\":false}}"),
        ("file-off-str", "{\"guards\":{\"idleAgentSweep\":\"off\"}}"),
        ("file-on", "{\"guards\":{\"idleAgentSweep\":true}}"),
    ] {
        v.push(
            one(&format!("settings-{n}"), raw.clone(), n_finished(3, 4.0)).seed(vec![w("t.jsonl", n_finished(3, 4.0)), w(".anti-hall/settings.json", body)]),
        );
    }
    for (n, kv) in [("env-off-0", "0"), ("env-off-word", "off"), ("env-on", "1"), ("env-junk", "meh")] {
        v.push(
            one(&format!("switch-{n}"), raw.clone(), n_finished(3, 4.0)).env(&[("ANTIHALL_IDLE_AGENT_SWEEP", kv), ("ANTIHALL_TEST_NOW_MS", "1790000000000")]),
        );
    }
    v.push(one("switch-judge-child", raw.clone(), n_finished(3, 4.0)).env(&[("ANTIHALL_JUDGE_CHILD", "1"), ("ANTIHALL_TEST_NOW_MS", "1790000000000")]));
    v.push(one("clock-set-explicitly", raw.clone(), finished("alice", 20.0, 1)).env(&[("ANTIHALL_TEST_NOW_MS", "1790000000000")]));
    for (n, body) in [
        ("skip-own", format!("{{\"idle-agent-sweep\":{}}}", T0 * 10.0)),
        ("skip-all", format!("{{\"all\":{}}}", T0 * 10.0)),
        ("skip-expired", "{\"idle-agent-sweep\":1000}".to_string()),
        ("skip-string", "{\"idle-agent-sweep\":\"99999999999999\"}".to_string()),
        ("skip-corrupt", "{{".to_string()),
        ("skip-other", format!("{{\"git-guard\":{}}}", T0 * 10.0)),
    ] {
        v.push(one(n, raw.clone(), finished("alice", 20.0, 1)).seed(vec![w("t.jsonl", finished("alice", 20.0, 1)), w(".anti-hall/skip.json", body)]));
    }

    // ---- labels -------------------------------------------------------------------------------------------------
    for (n, name) in [
        ("long", "n".repeat(80)),
        ("exactly-60", "m".repeat(60)),
        ("61", "m".repeat(61)),
        ("unicode", "Zoë-世界".to_string()),
        ("spaces", "a   b\t c".to_string()),
        ("quotes", "say \"hi\" \\ back".to_string()),
        ("braces", "{n} {id} {shown}".to_string()),
        ("control", "x\u{1}y\u{7f}z\u{85}w".to_string()),
        ("trailing-space-cut", format!("{} {}", "p".repeat(59), "tail")),
        ("emoji-cut-pair", format!("{}😀tail", "e".repeat(59))),
        ("emoji-before-cut", format!("{}😀tail", "e".repeat(58))),
        ("newline", "line1\nline2".to_string()),
        ("lt-gt", "<b>&amp;".to_string()),
    ] {
        let sc = one(&format!("label-{n}"), raw.clone(), finished(&name, 30.0, 1));
        v.push(sc); // a label cut inside a surrogate pair is answered like Node (the script cuts by UTF-16 unit)
    }

    // ---- the replay ----------------------------------------------------------------------------------------------
    let t = |m: f64| T0 - m * MIN;
    v.push(one("replay-idle-failed", raw.clone(), format!("{}{}", spawn("a", t(40.0), 1), report("a", t(30.0), t(30.0), Some("failed")))));
    v.push(one("replay-idle-no-reason", raw.clone(), format!("{}{}", spawn("a", t(40.0), 1), report("a", t(30.0), t(30.0), None))));
    v.push(one("replay-idle-other-reason", raw.clone(), format!("{}{}", spawn("a", t(40.0), 1), report("a", t(30.0), t(30.0), Some("interrupted")))));
    v.push(one("replay-send-after-idle", raw.clone(), format!("{}{}{}", finished("a", 30.0, 1), send("a", t(10.0), 1), "")));
    v.push(one(
        "replay-send-before-idle",
        raw.clone(),
        format!("{}{}{}", spawn("a", t(60.0), 1), send("a", t(40.0), 1), report("a", t(30.0), t(30.0), Some("available"))),
    ));
    v.push(one(
        "replay-send-midturn-then-idle",
        raw.clone(),
        format!(
            "{}{}{}{}",
            spawn("a", t(60.0), 1),
            report("a", t(50.0), t(50.0), Some("available")),
            send("a", t(45.0), 1),
            report("a", t(40.0), t(40.0), Some("available"))
        ),
    ));
    v.push(one(
        "replay-two-idles",
        raw.clone(),
        format!("{}{}{}", spawn("a", t(60.0), 1), report("a", t(50.0), t(50.0), Some("available")), report("a", t(30.0), t(30.0), Some("available"))),
    ));
    v.push(one("replay-stop-after", raw.clone(), format!("{}{}", finished("a", 30.0, 1), stop("a", t(10.0), 1, false))));
    v.push(one("replay-stop-by-agent-id", raw.clone(), format!("{}{}", finished("a", 30.0, 1), stop("a@team", t(10.0), 1, false))));
    v.push(one("replay-stop-errored", raw.clone(), format!("{}{}", finished("a", 30.0, 1), stop("a", t(10.0), 1, true))));
    v.push(one(
        "replay-stop-before-idle",
        raw.clone(),
        format!("{}{}{}", spawn("a", t(60.0), 1), stop("a", t(50.0), 1, false), report("a", t(30.0), t(30.0), Some("available"))),
    ));
    v.push(one("replay-stop-unrelated", raw.clone(), format!("{}{}", finished("a", 30.0, 1), stop("someone-else", t(10.0), 1, false))));
    v.push(one("replay-respawn", raw.clone(), format!("{}{}", finished("a", 30.0, 1), spawn("a", t(10.0), 2))));
    v.push(one(
        "replay-two-teammates-one-stopped",
        raw.clone(),
        format!("{}{}{}", finished("a", 30.0, 1), finished("b", 25.0, 2), stop("a", t(5.0), 1, false)),
    ));
    v.push(one("replay-report-before-spawn-unknown", raw.clone(), report("ghost", t(30.0), t(30.0), Some("available"))));
    v.push(one("replay-send-to-unknown-peer", raw.clone(), format!("{}{}", finished("a", 30.0, 1), send("peer", t(10.0), 1))));
    v.push(one("replay-inner-ts-future", raw.clone(), format!("{}{}", spawn("a", t(60.0), 1), report("a", t(30.0), t(30.0) + 60_000.0, Some("available")))));
    v.push(one(
        "replay-inner-ts-slightly-future",
        raw.clone(),
        format!("{}{}", spawn("a", t(60.0), 1), report("a", t(30.0), t(30.0) + 4_000.0, Some("available"))),
    ));
    v.push(one("replay-inner-ts-past", raw.clone(), format!("{}{}", spawn("a", t(60.0), 1), report("a", t(10.0), t(40.0), Some("available")))));
    v.push(one("replay-inner-ts-missing", raw.clone(), format!("{}{}", spawn("a", t(60.0), 1), line(json!({"type":"user","timestamp":iso(t(30.0)),"message":{"content":report_text(&[("a", json!({"type":"idle_notification","from":"a","idleReason":"available"}))])}})))));
    v.push(one("replay-inner-ts-garbage", raw.clone(), format!("{}{}", spawn("a", t(60.0), 1), line(json!({"type":"user","timestamp":iso(t(30.0)),"message":{"content":report_text(&[("a", json!({"type":"idle_notification","from":"a","timestamp":"soon","idleReason":"available"}))])}})))).defers());
    v.push(one(
        "replay-entry-ts-missing",
        raw.clone(),
        format!(
            "{}{}",
            spawn("a", t(60.0), 1),
            line(json!({"type":"user","message":{"content":report_text(&[("a", idle_body("a", t(30.0), Some("available")))])}}))
        ),
    ));
    v.push(one("replay-spawn-ts-missing", raw.clone(), format!("{}{}", line(json!({"type":"user","toolUseResult":{"status":"teammate_spawned","name":"a","agent_id":"a@team"},"message":{"content":[{"type":"tool_result","tool_use_id":"toolu_x","content":"s"}]}})), report("a", t(30.0), t(30.0), Some("available")))));
    v.push(one("replay-spawn-after-report", raw.clone(), format!("{}{}", report("a", t(30.0), t(30.0), Some("available")), spawn("a", t(40.0), 1))));
    for k in [
        "origin",
        "promptSource",
        "turnOrigin",
        "permissionMode",
        "isMeta",
        "isCompactSummary",
        "toolUseResult",
        "sourceToolAssistantUUID",
        "imagePasteIds",
        "queuePriority",
        "scheduledTaskId",
    ] {
        let mut e = json!({"type":"user","timestamp":iso(t(30.0)),"message":{"role":"user","content":report_text(&[("a", idle_body("a", t(30.0), Some("available")))])}});
        e[k] = json!(null);
        v.push(one(&format!("replay-report-key-{k}"), raw.clone(), format!("{}{}", spawn("a", t(60.0), 1), line(e))));
    }
    for (n, val, counts) in [("false", json!(false), true), ("true", json!(true), false)] {
        let mut e = json!({"type":"user","timestamp":iso(t(30.0)),"message":{"role":"user","content":report_text(&[("a", idle_body("a", t(30.0), Some("available")))])}});
        e["isSidechain"] = val;
        let _ = counts;
        v.push(one(&format!("replay-report-sidechain-{n}"), raw.clone(), format!("{}{}", spawn("a", t(60.0), 1), line(e))));
    }
    let blk = |body: &str, name: &str| {
        format!("Another Claude session sent a message:\n<teammate-message teammate_id=\"{name}\" color=\"red\">\n{body}\n</teammate-message>")
    };
    let ok_body = idle_body("a", t(30.0), Some("available")).to_string();
    let entry = |content: String| line(json!({"type":"user","timestamp":iso(t(30.0)),"message":{"role":"user","content":content}}));
    let spawn_a = spawn("a", t(60.0), 1);
    v.push(one(
        "report-two-blocks",
        raw.clone(),
        format!(
            "{}{}{}",
            spawn_a,
            spawn("b", t(60.0), 2),
            entry(report_text(&[("a", idle_body("a", t(30.0), Some("available"))), ("b", idle_body("b", t(20.0), Some("available")))]))
        ),
    ));
    v.push(one(
        "report-prose-before",
        raw.clone(),
        format!(
            "{}{}",
            spawn_a,
            entry(format!("Another Claude session sent a message: hello there\n<teammate-message teammate_id=\"a\">\n{ok_body}\n</teammate-message>"))
        ),
    ));
    v.push(one(
        "report-no-prefix",
        raw.clone(),
        format!("{}{}", spawn_a, entry(format!("<teammate-message teammate_id=\"a\">\n{ok_body}\n</teammate-message>"))),
    ));
    v.push(one(
        "report-multiline-body",
        raw.clone(),
        format!(
            "{}{}",
            spawn_a,
            entry(blk(&format!("{{\n\"type\":\"idle_notification\",\"from\":\"a\",\"idleReason\":\"available\",\"timestamp\":\"{}\"\n}}", iso(t(30.0))), "a"))
        ),
    ));
    v.push(one("report-body-not-json", raw.clone(), format!("{}{}", spawn_a, entry(blk("idle_notification please", "a")))));
    v.push(one(
        "report-body-not-brace",
        raw.clone(),
        format!("{}{}", spawn_a, entry(blk(" {\"type\":\"idle_notification\",\"from\":\"a\",\"idleReason\":\"available\"}", "a"))),
    ));
    v.push(one("report-from-mismatch", raw.clone(), format!("{}{}", spawn_a, entry(blk(&idle_body("zzz", t(30.0), Some("available")).to_string(), "a")))));
    v.push(one(
        "report-type-mismatch",
        raw.clone(),
        format!("{}{}", spawn_a, entry(blk(&json!({"type":"message","from":"a","idleReason":"available"}).to_string(), "a"))),
    ));
    v.push(one(
        "report-attrs-and-newline-in-attrs",
        raw.clone(),
        format!(
            "{}{}",
            spawn_a,
            entry(format!("Another Claude session sent a message:\n<teammate-message teammate_id=\"a\" a=\"x\ny\" b=1>\n{ok_body}\n</teammate-message>"))
        ),
    ));
    v.push(one(
        "report-name-with-space",
        raw.clone(),
        format!("{}{}", spawn("a b", t(60.0), 1), entry(blk(&idle_body("a b", t(30.0), Some("available")).to_string(), "a b"))),
    ));
    v.push(one(
        "report-name-with-newline",
        raw.clone(),
        format!("{}{}", spawn_a, entry("Another Claude session sent a message:\n<teammate-message teammate_id=\"a\nb\">\nx\n</teammate-message>".to_string())),
    ));
    v.push(one(
        "report-empty-body",
        raw.clone(),
        format!("{}{}", spawn_a, entry("Another Claude session sent a message:\n<teammate-message teammate_id=\"a\">\n\n</teammate-message>".to_string())),
    ));
    v.push(one(
        "report-unclosed",
        raw.clone(),
        format!("{}{}", spawn_a, entry(format!("Another Claude session sent a message:\n<teammate-message teammate_id=\"a\">\n{ok_body}\n"))),
    ));
    v.push(one("report-gap-whitespace", raw.clone(), format!("{}{}", spawn_a, entry(format!("Another Claude session sent a message:  \n\n  <teammate-message teammate_id=\"a\">\n{ok_body}\n</teammate-message>\u{a0}\u{feff}\n<teammate-message teammate_id=\"a\">\n{ok_body}\n</teammate-message>")))));
    v.push(one(
        "report-array-content",
        raw.clone(),
        format!("{}{}", spawn_a, line(json!({"type":"user","timestamp":iso(t(30.0)),"message":{"content":[{"type":"text","text":blk(&ok_body, "a")}]}}))),
    ));
    v.push(one(
        "report-assistant-type",
        raw.clone(),
        format!("{}{}", spawn_a, line(json!({"type":"assistant","timestamp":iso(t(30.0)),"message":{"content":blk(&ok_body, "a")}}))),
    ));
    v.push(one(
        "report-quoted-block-in-body",
        raw.clone(),
        format!(
            "{}{}",
            spawn_a,
            entry(blk(
                "{\"type\":\"idle_notification\",\"from\":\"a\",\"idleReason\":\"available\",\"quote\":\"<teammate-message teammate_id=\\\"a\\\">\"}",
                "a"
            ))
        ),
    ));
    v.push(one("spawn-not-answering-agent-call", raw.clone(), format!("{}{}", line(json!({"type":"assistant","timestamp":iso(t(61.0)),"message":{"content":[{"type":"tool_use","id":"toolu_r","name":"Read","input":{}}]}})) + &line(json!({"type":"user","timestamp":iso(t(60.0)),"toolUseResult":{"status":"teammate_spawned","name":"a","agent_id":"a@team"},"message":{"content":[{"type":"tool_result","tool_use_id":"toolu_r","content":"s"}]}})), report("a", t(30.0), t(30.0), Some("available")))));
    v.push(one("spawn-name-empty", raw.clone(), format!("{}{}", line(json!({"type":"user","timestamp":iso(t(60.0)),"toolUseResult":{"status":"teammate_spawned","name":"","agent_id":"x"},"message":{"content":[{"type":"tool_result","tool_use_id":"t","content":"s"}]}})), report("", t(30.0), t(30.0), Some("available")))));
    v.push(one("spawn-content-string", raw.clone(), format!("{}{}", line(json!({"type":"user","timestamp":iso(t(60.0)),"toolUseResult":{"status":"teammate_spawned","name":"a","agent_id":"a@team"},"message":{"content":"spawned"}})), report("a", t(30.0), t(30.0), Some("available")))));
    // a teammate named like a background agent is not a teammate
    v.push(one(
        "collision-launch-id",
        raw.clone(),
        format!("{}{}{}", bg_launch("abcdef12", t(70.0), 1), spawn("abcdef12", t(60.0), 2), report("abcdef12", t(30.0), t(30.0), Some("available"))),
    ));
    v.push(one(
        "collision-notification-id",
        raw.clone(),
        format!(
            "{}{}{}",
            notification("abcdef34", "completed", t(65.0)),
            spawn("abcdef34", t(60.0), 2),
            report("abcdef34", t(30.0), t(30.0), Some("available"))
        ),
    ));
    v.push(one(
        "collision-notification-not-terminal",
        raw.clone(),
        format!("{}{}{}", notification("abcdef56", "running", t(65.0)), spawn("abcdef56", t(60.0), 2), report("abcdef56", t(30.0), t(30.0), Some("available"))),
    ));
    v.push(one(
        "collision-task-status-running",
        raw.clone(),
        format!(
            "{}{}{}",
            line(json!({"type":"attachment","timestamp":iso(t(65.0)),"attachment":{"type":"task_status","taskId":"ts1","status":"running"}})),
            spawn("ts1", t(60.0), 2),
            report("ts1", t(30.0), t(30.0), Some("available"))
        ),
    ));
    v.push(one(
        "collision-task-status-killed",
        raw.clone(),
        format!(
            "{}{}{}",
            line(json!({"type":"attachment","timestamp":iso(t(65.0)),"attachment":{"type":"task_status","taskId":"ts2","status":"killed"}})),
            spawn("ts2", t(60.0), 2),
            report("ts2", t(30.0), t(30.0), Some("available"))
        ),
    ));
    v.push(one(
        "collision-task-status-weird",
        raw.clone(),
        format!(
            "{}{}{}",
            line(json!({"type":"attachment","timestamp":iso(t(65.0)),"attachment":{"type":"task_status","taskId":"ts3","status":["completed"]}})),
            spawn("ts3", t(60.0), 2),
            report("ts3", t(30.0), t(30.0), Some("available"))
        ),
    ));
    v.push(one(
        "collision-notification-case",
        raw.clone(),
        format!("{}{}{}", notification("nc1", "COMPLETED", t(65.0)), spawn("nc1", t(60.0), 2), report("nc1", t(30.0), t(30.0), Some("available"))),
    ));
    v.push(one(
        "collision-notification-spaced-status",
        raw.clone(),
        format!("{}{}{}", notification("nc2", " completed ", t(65.0)), spawn("nc2", t(60.0), 2), report("nc2", t(30.0), t(30.0), Some("available"))),
    ));
    v.push(one(
        "collision-notification-shapes",
        raw.clone(),
        format!(
            "{}{}{}{}{}",
            line(json!({"type":"attachment","timestamp":iso(t(66.0)),"attachment":{"prompt":"<task-notification>\n<task-id>ns1</task-id>\n<status>failed</status>\n</task-notification>"}})),
            line(json!({"type":"queue-operation","timestamp":iso(t(66.0)),"content":"<task-notification>\n<task-id>ns2</task-id>\n<status>stopped</status>\n</task-notification>"})),
            line(json!({"type":"user","timestamp":iso(t(66.0)),"message":{"content":[{"type":"text","text":"<system-reminder>\n<task-notification>\n<task-id>ns3</task-id>\n<status>cancelled</status>\n</task-notification></system-reminder>"}]}})),
            ["ns1", "ns2", "ns3"].iter().enumerate().map(|(i, n)| spawn(n, t(60.0), 10 + i)).collect::<String>(),
            ["ns1", "ns2", "ns3"].iter().map(|n| report(n, t(30.0), t(30.0), Some("available"))).collect::<String>()
        ),
    ));
    v.push(one("collision-quoted-notification-midtext", raw.clone(), format!("{}{}{}", line(json!({"type":"user","timestamp":iso(t(66.0)),"message":{"content":"he said <task-notification>\n<task-id>nq1</task-id>\n<status>completed</status>\n</task-notification>"}})), spawn("nq1", t(60.0), 2), report("nq1", t(30.0), t(30.0), Some("available")))));
    v.push(one("collision-launch-tool-mismatch", raw.clone(), format!("{}{}{}{}", line(json!({"type":"assistant","timestamp":iso(t(71.0)),"message":{"content":[{"type":"tool_use","id":"toolu_bgx","name":"Bash","input":{}}]}})), line(json!({"type":"user","timestamp":iso(t(70.0)),"message":{"content":[{"type":"tool_result","tool_use_id":"toolu_bgx","content":"Async agent launched successfully\nagentId: abcdef99"}]}})), spawn("abcdef99", t(60.0), 2), report("abcdef99", t(30.0), t(30.0), Some("available")))));
    v.push(one("collision-launch-via-toolresult-field", raw.clone(), format!("{}{}{}", line(json!({"type":"user","timestamp":iso(t(70.0)),"toolUseResult":{"agentId":"deadbeef01"},"message":{"content":[{"type":"tool_result","tool_use_id":"t9","content":"Async agent launched successfully"}]}})), spawn("deadbeef01", t(60.0), 2), report("deadbeef01", t(30.0), t(30.0), Some("available")))));
    v.push(one("resume-result-skips-send", raw.clone(), format!("{}{}", finished("a", 30.0, 1), line(json!({"type":"user","timestamp":iso(t(10.0)),"message":{"content":[{"type":"tool_result","tool_use_id":"toolu_q","content":json!({"success":true,"message":"Message sent to a's inbox","resumedAgentId":"abc1234def"}).to_string()}]}})))));
    v.push(one("queued-message-result", raw.clone(), format!("{}{}", finished("a", 30.0, 1), line(json!({"type":"user","timestamp":iso(t(10.0)),"message":{"content":[{"type":"tool_result","tool_use_id":"toolu_q","content":json!({"success":true,"message":"Message queued for delivery to a at its next tool round."}).to_string()}]}})))));
    v.push(one("send-result-wrong-shape", raw.clone(), format!("{}{}", finished("a", 30.0, 1), line(json!({"type":"user","timestamp":iso(t(10.0)),"message":{"content":[{"type":"tool_result","tool_use_id":"toolu_q","content":"Message sent to a's inbox"}]}})))));
    v.push(one("send-result-not-success", raw.clone(), format!("{}{}", finished("a", 30.0, 1), line(json!({"type":"user","timestamp":iso(t(10.0)),"message":{"content":[{"type":"tool_result","tool_use_id":"toolu_q","content":json!({"success":false,"message":"Message sent to a's inbox"}).to_string()}]}})))));
    v.push(one("send-result-array-text", raw.clone(), format!("{}{}", finished("a", 30.0, 1), line(json!({"type":"user","timestamp":iso(t(10.0)),"message":{"content":[{"type":"tool_result","tool_use_id":"toolu_q","content":[{"type":"text","text":json!({"success":true,"message":"Message sent to a's inbox"}).to_string()}]}]}})))));
    v.push(one("send-answering-other-tool", raw.clone(), format!("{}{}{}", finished("a", 30.0, 1), line(json!({"type":"assistant","timestamp":iso(t(11.0)),"message":{"content":[{"type":"tool_use","id":"toolu_o","name":"Bash","input":{}}]}})), line(json!({"type":"user","timestamp":iso(t(10.0)),"message":{"content":[{"type":"tool_result","tool_use_id":"toolu_o","content":json!({"success":true,"message":"Message sent to a's inbox"}).to_string()}]}})))));
    v.push(one("send-tuid-nonstring", raw.clone(), format!("{}{}", finished("a", 30.0, 1), line(json!({"type":"user","timestamp":iso(t(10.0)),"message":{"content":[{"type":"tool_result","tool_use_id":7,"content":json!({"success":true,"message":"Message sent to a's inbox"}).to_string()}]}})))));
    v.push(one(
        "content-string-and-weird-blocks",
        raw.clone(),
        format!(
            "{}{}{}",
            finished("a", 30.0, 1),
            line(json!({"type":"user","timestamp":iso(t(10.0)),"message":{"content":["plain",null,0,5,{"content":null},{"text":"x"},[1]]}})),
            line(json!({"type":"user","timestamp":iso(t(9.0)),"message":"just a string"}))
        ),
    ));
    v.push(one("entry-not-object", raw.clone(), format!("{}[\"tool_result\"]\n\"tool_result\"\n5\ntrue\n", finished("a", 30.0, 1))));

    // ---- the prompt, the transcript, the platform ----------------------------------------------------------------
    let fin = finished("alice", 20.0, 1);
    for (n, prompt) in [
        ("plain", "hi"),
        ("notification", "<task-notification>x</task-notification>"),
        ("notification-leading-space", "  \n <task-notification>"),
        ("notification-midtext", "see <task-notification>"),
        ("empty", ""),
        ("unicode", "世界 😀"),
    ] {
        v.push(one(&format!("prompt-{n}"), pl(sid, prompt), fin.clone()));
    }
    v.push(one("prompt-missing", payload(json!({"session_id": sid, "transcript_path": TP})), fin.clone()));
    v.push(one("prompt-number", payload(json!({"session_id": sid, "transcript_path": TP, "prompt": 5})), fin.clone()));
    v.push(one("tp-missing-file", pl_tp(sid, "/nonexistent/x.jsonl", json!({})), fin.clone()));
    v.push(one("tp-absent", payload(json!({"session_id": sid, "prompt": "x"})), fin.clone()));
    v.push(one("tp-empty", pl_tp(sid, "", json!({})), fin.clone()));
    v.push(one("tp-number", payload(json!({"session_id": sid, "transcript_path": 5, "prompt": "x"})), fin.clone()));
    v.push(one("tp-relative", pl_tp(sid, "t.jsonl", json!({})), fin.clone()).defers());
    v.push(one("tp-relative-notification-prompt", pl_tp(sid, "t.jsonl", json!({"prompt": "<task-notification>"})), fin.clone()));
    v.push(one("tp-empty-file", pl(sid, "x"), String::new()));
    v.push(one("tp-directory", pl_tp(sid, "$HOME", json!({})), fin.clone()));
    v.push(one("tp-no-teammates", pl(sid, "x"), (0..200).map(|i| filler(T0 - 1000.0 * i as f64)).collect()));
    v.push(one("tp-garbage-irrelevant-lines", pl(sid, "x"), format!("garbage\n{{broken\n{}\n\n   \n{}", fin, filler(T0))));
    v.push(
        one("tp-garbage-relevant-line", pl(sid, "x"), format!("{}{{\"type\":\"user\",\"message\":{{\"content\":[{{\"type\":\"tool_result\" BROKEN\n", fin))
            .defers(),
    );
    v.push(one("tp-lone-surrogate-line", pl(sid, "x"), format!("{}{}", fin, "{\"type\":\"user\",\"timestamp\":\"2026-01-01T00:00:00.000Z\",\"message\":{\"content\":[{\"type\":\"tool_result\",\"content\":\"bad \\ud83d here\"}]}}\n")));
    v.push(
        one(
            "tp-timestamp-nonstandard",
            pl(sid, "x"),
            format!(
                "{}{}",
                fin, "{\"type\":\"user\",\"timestamp\":\"2026-01-01 00:00:00\",\"message\":{\"content\":[{\"type\":\"tool_result\",\"content\":\"x\"}]}}\n"
            ),
        )
        .defers(),
    );
    v.push(one(
        "tp-timestamp-number-irrelevant-line",
        pl(sid, "x"),
        format!("{}{}", fin, "{\"type\":\"assistant\",\"timestamp\":5,\"message\":{\"content\":\"hello\"}}\n"),
    ));
    v.push(one("tp-crlf-lines", pl(sid, "x"), fin.replace('\n', "\r\n")));
    v.push(one("tp-no-trailing-newline", pl(sid, "x"), fin.trim_end().to_string()));
    v.push(one(
        "tp-spawn-outside-window",
        pl(sid, "x"),
        format!("{}{}", fin, "x".repeat(13 * 1024 * 1024) + "\n" + &report("alice", T0 - 5.0 * MIN, T0 - 5.0 * MIN, Some("available"))),
    ));
    v.push(one("tp-inside-window-big-file", pl(sid, "x"), format!("{}{}\n{}", "y".repeat(13 * 1024 * 1024), "", fin)));
    // platform detection
    let cx = format!("{}{}", cx_spawn(T0 - 50.0 * MIN, U1, Some("Ada"), "c1"), cx_wait(T0 - 40.0 * MIN, json!({U1: {"completed": "done"}}), "c2"));
    v.push(one("platform-claude-transcript-turn-id", pl_tp(sid, TP, json!({"turn_id": "t-1"})), fin.clone()));
    v.push(one("platform-turn-id-empty", pl_tp(sid, TP, json!({"turn_id": ""})), fin.clone()));
    v.push(one("platform-turn-id-number", pl_tp(sid, TP, json!({"turn_id": 7})), fin.clone()));
    v.push(
        scn("idle-platform-rollout-path", "idle-agent-sweep", vec![step(pl_tp(sid, "$HOME/rollout-2026-01-01T00-abc.jsonl", json!({})))])
            .seed(vec![w("rollout-2026-01-01T00-abc.jsonl", cx.clone())])
            .env(&[("ANTIHALL_TEST_NOW_MS", "1790000000000")]),
    );
    v.push(
        scn("idle-platform-codex-dir", "idle-agent-sweep", vec![step(pl_tp(sid, "$HOME/.codex/sessions/x.jsonl", json!({})))])
            .seed(vec![w(".codex/sessions/x.jsonl", cx.clone())])
            .env(&[("ANTIHALL_TEST_NOW_MS", "1790000000000")]),
    );
    v.push(
        scn("idle-platform-rollout-not-last-segment", "idle-agent-sweep", vec![step(pl_tp(sid, "$HOME/rollout-x/t.jsonl", json!({})))])
            .seed(vec![w("rollout-x/t.jsonl", fin.clone())])
            .env(&[("ANTIHALL_TEST_NOW_MS", "1790000000000")]),
    );
    v.push(
        scn("idle-platform-rollout-wrong-ext", "idle-agent-sweep", vec![step(pl_tp(sid, "$HOME/rollout-x.json", json!({})))])
            .seed(vec![w("rollout-x.json", fin.clone())])
            .env(&[("ANTIHALL_TEST_NOW_MS", "1790000000000")]),
    );
    v.push(
        scn("idle-platform-turn-id-claude-shaped", "idle-agent-sweep", vec![step(pl_tp(sid, TP, json!({"turn_id": "t"})))])
            .seed(vec![w("t.jsonl", cx.clone())])
            .env(&[("ANTIHALL_TEST_NOW_MS", "1790000000000")]),
    );

    // ---- Codex ---------------------------------------------------------------------------------------------------
    let cxone = |name: &str, body: String| {
        scn(format!("idle-cx-{name}"), "idle-agent-sweep", vec![step(pl_tp(sid, "$HOME/rollout-a.jsonl", json!({"turn_id": "t"})))])
            .seed(vec![w("rollout-a.jsonl", body)])
            .env(&[("ANTIHALL_TEST_NOW_MS", "1790000000000")])
    };
    let cx_t = |m: f64| T0 - m * MIN;
    v.push(cxone("completed-old", format!("{}{}", cx_spawn(cx_t(50.0), U1, Some("Ada"), "c1"), cx_wait(cx_t(40.0), json!({U1: {"completed": "ok"}}), "c2"))));
    v.push(cxone("completed-no-nick", format!("{}{}", cx_spawn(cx_t(50.0), U1, None, "c1"), cx_wait(cx_t(40.0), json!({U1: {"completed": "ok"}}), "c2"))));
    v.push(cxone("errored", format!("{}{}", cx_spawn(cx_t(50.0), U1, Some("Bo"), "c1"), cx_wait(cx_t(40.0), json!({U1: {"errored": "boom"}}), "c2"))));
    v.push(cxone(
        "completed-fresh-quiet",
        format!("{}{}", cx_spawn(cx_t(5.0), U1, Some("Ada"), "c1"), cx_wait(cx_t(3.0), json!({U1: {"completed": "ok"}}), "c2")),
    ));
    v.push(cxone("still-running", format!("{}{}", cx_spawn(cx_t(50.0), U1, Some("Ada"), "c1"), cx_wait(cx_t(40.0), json!({U1: {"running": null}}), "c2"))));
    v.push(cxone(
        "closed-after",
        format!(
            "{}{}{}",
            cx_spawn(cx_t(50.0), U1, Some("Ada"), "c1"),
            cx_wait(cx_t(40.0), json!({U1: {"completed": "ok"}}), "c2"),
            cx_call(cx_t(30.0), "close_agent", json!({"target": U1}), "c3")
        ),
    ));
    v.push(cxone(
        "closed-by-id-key",
        format!(
            "{}{}{}",
            cx_spawn(cx_t(50.0), U1, Some("Ada"), "c1"),
            cx_wait(cx_t(40.0), json!({U1: {"completed": "ok"}}), "c2"),
            cx_call(cx_t(30.0), "close_agent", json!({"id": U1}), "c3")
        ),
    ));
    v.push(cxone(
        "closed-by-agent-id-key",
        format!(
            "{}{}{}",
            cx_spawn(cx_t(50.0), U1, Some("Ada"), "c1"),
            cx_wait(cx_t(40.0), json!({U1: {"completed": "ok"}}), "c2"),
            cx_call(cx_t(30.0), "close_agent", json!({"agent_id": U1}), "c3")
        ),
    ));
    v.push(cxone(
        "closed-by-targets",
        format!(
            "{}{}{}",
            cx_spawn(cx_t(50.0), U1, Some("Ada"), "c1"),
            cx_wait(cx_t(40.0), json!({U1: {"completed": "ok"}}), "c2"),
            cx_call(cx_t(30.0), "close_agent", json!({"targets": [U2, U1, 5]}), "c3")
        ),
    ));
    v.push(cxone(
        "close-other-agent",
        format!(
            "{}{}{}",
            cx_spawn(cx_t(50.0), U1, Some("Ada"), "c1"),
            cx_wait(cx_t(40.0), json!({U1: {"completed": "ok"}}), "c2"),
            cx_call(cx_t(30.0), "close_agent", json!({"target": U2}), "c3")
        ),
    ));
    v.push(cxone(
        "retasked-send-input",
        format!(
            "{}{}{}",
            cx_spawn(cx_t(50.0), U1, Some("Ada"), "c1"),
            cx_wait(cx_t(40.0), json!({U1: {"completed": "ok"}}), "c2"),
            cx_call(cx_t(30.0), "send_input", json!({"target": U1, "message": "more"}), "c3")
        ),
    ));
    v.push(cxone(
        "retasked-resume",
        format!(
            "{}{}{}",
            cx_spawn(cx_t(50.0), U1, Some("Ada"), "c1"),
            cx_wait(cx_t(40.0), json!({U1: {"completed": "ok"}}), "c2"),
            cx_call(cx_t(30.0), "resume_agent", json!({"id": U1}), "c3")
        ),
    ));
    v.push(cxone(
        "retasked-then-finished-again",
        format!(
            "{}{}{}{}",
            cx_spawn(cx_t(50.0), U1, Some("Ada"), "c1"),
            cx_wait(cx_t(40.0), json!({U1: {"completed": "ok"}}), "c2"),
            cx_call(cx_t(30.0), "send_input", json!({"target": U1}), "c3"),
            cx_wait(cx_t(20.0), json!({U1: {"completed": "again"}}), "c4")
        ),
    ));
    v.push(cxone(
        "two-agents-one-closed",
        format!(
            "{}{}{}{}",
            cx_spawn(cx_t(50.0), U1, Some("Ada"), "c1"),
            cx_spawn(cx_t(49.0), U2, Some("Bo"), "c1b"),
            cx_wait(cx_t(40.0), json!({U1: {"completed": "ok"}, U2: {"completed": "ok"}}), "c2"),
            cx_call(cx_t(30.0), "close_agent", json!({"target": U2}), "c3")
        ),
    ));
    v.push(cxone(
        "two-agents-order",
        format!(
            "{}{}{}",
            cx_spawn(cx_t(50.0), U2, Some("Bo"), "c1b"),
            cx_spawn(cx_t(49.0), U1, Some("Ada"), "c1"),
            cx_wait(cx_t(40.0), json!({U1: {"completed": "ok"}, U2: {"completed": "ok"}}), "c2")
        ),
    ));
    v.push(cxone(
        "two-agents-staggered",
        format!(
            "{}{}{}{}",
            cx_spawn(cx_t(50.0), U1, Some("Ada"), "c1"),
            cx_spawn(cx_t(49.0), U2, Some("Bo"), "c1b"),
            cx_wait(cx_t(40.0), json!({U2: {"completed": "ok"}}), "c2"),
            cx_wait(cx_t(35.0), json!({U1: {"completed": "ok"}}), "c3")
        ),
    ));
    v.push(cxone(
        "respawn-same-id",
        format!(
            "{}{}{}",
            cx_spawn(cx_t(50.0), U1, Some("Ada"), "c1"),
            cx_wait(cx_t(40.0), json!({U1: {"completed": "ok"}}), "c2"),
            cx_spawn(cx_t(30.0), U1, Some("Ada2"), "c3")
        ),
    ));
    v.push(cxone(
        "uppercase-id",
        format!(
            "{}{}",
            cx_spawn(cx_t(50.0), &U1.to_uppercase(), Some("Ada"), "c1"),
            cx_wait(cx_t(40.0), json!({U1.to_uppercase(): {"completed": "ok"}}), "c2")
        ),
    ));
    v.push(cxone(
        "bad-id-ignored",
        format!("{}{}", cx_spawn(cx_t(50.0), "not-a-uuid", Some("Ada"), "c1"), cx_wait(cx_t(40.0), json!({"not-a-uuid": {"completed": "ok"}}), "c2")),
    ));
    v.push(cxone("wait-for-unknown-id", cx_wait(cx_t(40.0), json!({U1: {"completed": "ok"}}), "c2")));
    v.push(cxone("output-without-call", cx_out(cx_t(40.0), "ghost", json!({"agent_id": U1}))));
    v.push(cxone("call-without-output", cx_call(cx_t(40.0), "spawn_agent", json!({}), "c1")));
    v.push(cxone(
        "output-not-json",
        format!(
            "{}{}",
            cx_call(cx_t(40.0), "spawn_agent", json!({}), "c1"),
            line(json!({"timestamp":iso(cx_t(40.0)),"payload":{"type":"function_call_output","call_id":"c1","output":"plain text"}}))
        ),
    ));
    v.push(cxone(
        "output-not-string",
        format!(
            "{}{}",
            cx_call(cx_t(40.0), "spawn_agent", json!({}), "c1"),
            line(json!({"timestamp":iso(cx_t(40.0)),"payload":{"type":"function_call_output","call_id":"c1","output":{"agent_id":U1}}}))
        ),
    ));
    v.push(cxone("other-tool-names", format!("{}{}", cx_call(cx_t(40.0), "list_agents", json!({}), "c1"), cx_out(cx_t(40.0), "c1", json!({"agent_id": U1})))));
    v.push(cxone(
        "name-with-newline",
        format!("{}{}", cx_call(cx_t(40.0), "spawn_agent\n", json!({}), "c1"), cx_out(cx_t(40.0), "c1", json!({"agent_id": U1}))),
    ));
    v.push(cxone("name-number", line(json!({"timestamp":iso(cx_t(40.0)),"payload":{"type":"function_call","name":5,"arguments":"{}","call_id":"c1"}}))));
    v.push(cxone(
        "wait-no-timestamp",
        format!(
            "{}{}",
            cx_spawn(cx_t(50.0), U1, Some("Ada"), "c1"),
            line(json!({"payload":{"type":"function_call","name":"wait_agent","arguments":"{}","call_id":"c2"}}))
                + &line(json!({"payload":{"type":"function_call_output","call_id":"c2","output":json!({"status":{U1:{"completed":"x"}}}).to_string()}}))
        ),
    ));
    v.push(
        cxone(
            "wait-timestamp-unsupported",
            format!(
                "{}{}",
                cx_spawn(cx_t(50.0), U1, Some("Ada"), "c1"),
                line(json!({"timestamp":"yesterday","payload":{"type":"function_call","name":"wait_agent","arguments":"{}","call_id":"c2"}}))
            ),
        )
        .defers(),
    );
    v.push(cxone("status-entry-not-object", format!("{}{}", cx_spawn(cx_t(50.0), U1, Some("Ada"), "c1"), cx_wait(cx_t(40.0), json!({U1: "completed"}), "c2"))));
    v.push(cxone("status-array", format!("{}{}", cx_spawn(cx_t(50.0), U1, Some("Ada"), "c1"), cx_wait(cx_t(40.0), json!([U1]), "c2"))));
    v.push(cxone(
        "arguments-not-json",
        format!(
            "{}{}",
            cx_spawn(cx_t(50.0), U1, Some("Ada"), "c1"),
            line(json!({"timestamp":iso(cx_t(40.0)),"payload":{"type":"function_call","name":"close_agent","arguments":"nope","call_id":"c3"}}))
        ),
    ));
    v.push(cxone(
        "arguments-array",
        format!(
            "{}{}{}",
            cx_spawn(cx_t(50.0), U1, Some("Ada"), "c1"),
            cx_wait(cx_t(40.0), json!({U1: {"completed": "ok"}}), "c2"),
            cx_call(cx_t(30.0), "close_agent", json!([U1]), "c3")
        ),
    ));
    v.push(cxone(
        "nickname-weird",
        format!("{}{}", cx_spawn(cx_t(50.0), U1, Some("  spaced \t out\n"), "c1"), cx_wait(cx_t(40.0), json!({U1: {"completed": "ok"}}), "c2")),
    ));
    v.push(cxone(
        "nickname-long",
        format!("{}{}", cx_spawn(cx_t(50.0), U1, Some(&"N".repeat(90)), "c1"), cx_wait(cx_t(40.0), json!({U1: {"completed": "ok"}}), "c2")),
    ));
    v.push(cxone(
        "nickname-not-string",
        format!(
            "{}{}{}",
            cx_call(cx_t(50.0), "spawn_agent", json!({}), "c1"),
            cx_out(cx_t(50.0), "c1", json!({"agent_id": U1, "nickname": 5})),
            cx_wait(cx_t(40.0), json!({U1: {"completed": "ok"}}), "c2")
        ),
    ));
    v.push(cxone(
        "many",
        (0..14)
            .map(|i| {
                let id = format!("{:08x}-2222-3333-4444-555555555555", i);
                format!(
                    "{}{}",
                    cx_spawn(cx_t(60.0) + i as f64, &id, Some(&format!("n{i}")), &format!("s{i}")),
                    cx_call(cx_t(40.0), "wait_agent", json!({}), &format!("w{i}"))
                        + &cx_out(cx_t(40.0) + i as f64, &format!("w{i}"), json!({"status": {id.clone(): {"completed": "ok"}}}))
                )
            })
            .collect(),
    ));
    v.push(cxone(
        "payload-not-object",
        format!("{}{}", cx_spawn(cx_t(50.0), U1, Some("Ada"), "c1"), "{\"payload\":5,\"x\":\"_agent\"}\n{\"payload\":null,\"x\":\"_agent\"}\n[\"_agent\"]\n"),
    ));
    v.push(cxone("garbage-relevant-line", format!("{}{}", cx_spawn(cx_t(50.0), U1, Some("Ada"), "c1"), "spawn_agent broken {\n")).defers());
    v.push(cxone("garbage-irrelevant-line", format!("{}{}", cx_spawn(cx_t(50.0), U1, Some("Ada"), "c1"), "nothing here {\n")));
    v.push(cxone("skip-and-switch", cx_wait(cx_t(40.0), json!({U1: {"completed": "ok"}}), "c2")));
    // task-notification prompt on Codex
    v.push(
        scn(
            "idle-cx-notification-prompt",
            "idle-agent-sweep",
            vec![step(pl_tp(sid, "$HOME/rollout-a.jsonl", json!({"turn_id": "t", "prompt": "<task-notification>"})))],
        )
        .seed(vec![w("rollout-a.jsonl", cx.clone())])
        .env(&[("ANTIHALL_TEST_NOW_MS", "1790000000000")]),
    );

    // ---- dedupe of the advisory ----------------------------------------------------------------------------------
    let seq = |name: &str, steps: Vec<Step>, files: Vec<W>| with_clock(scn(format!("idle-dedupe-{name}"), "idle-agent-sweep", steps).seed(files));
    let rawd = pl("dd", "go");
    v.push(seq("twice-same", vec![step(rawd.clone()), step(rawd.clone()), step(rawd.clone())], vec![w("t.jsonl", n_finished(3, 20.0))]));
    v.push(seq(
        "minutes-change-same-block",
        vec![
            step(rawd.clone()),
            step(rawd.clone()).pre(vec![w("t.jsonl", n_finished(3, 21.0))]),
            step(rawd.clone()).pre(vec![w("t.jsonl", n_finished(3, 95.0))]),
        ],
        vec![w("t.jsonl", n_finished(3, 20.0))],
    ));
    v.push(seq(
        "new-agent-new-text",
        vec![step(rawd.clone()), step(rawd.clone()).pre(vec![wa("t.jsonl", finished("zed", 30.0, 77))]), step(rawd.clone())],
        vec![w("t.jsonl", n_finished(3, 20.0))],
    ));
    v.push(seq(
        "delivered-then-repeat",
        vec![
            step(rawd.clone()),
            step(rawd.clone()).after(|prev, _| prev.context().map(|c| vec![wa("t.jsonl", ups_attachment(T0 + 1000.0, &[&c]))]).unwrap_or_default()),
            step(rawd.clone()),
        ],
        vec![w("t.jsonl", n_finished(3, 20.0))],
    ));
    v.push(seq(
        "emit-dedupe-off",
        vec![step(rawd.clone()), step(rawd.clone())],
        vec![w("t.jsonl", n_finished(3, 20.0)), w(".anti-hall/settings.json", "{\"guards\":{\"emitDedupe\":false}}")],
    ));
    v.push(seq(
        "no-session",
        vec![step(payload(json!({"transcript_path": TP, "prompt": "x"}))), step(payload(json!({"transcript_path": TP, "prompt": "x"})))],
        vec![w("t.jsonl", n_finished(3, 20.0))],
    ));
    v.push(seq(
        "sid-number",
        vec![
            step(payload(json!({"session_id": 77, "transcript_path": TP, "prompt": "x"}))),
            step(payload(json!({"session_id": 77, "transcript_path": TP, "prompt": "x"}))),
        ],
        vec![w("t.jsonl", n_finished(3, 20.0))],
    ));
    v.push(
        seq("sid-array", vec![step(payload(json!({"session_id": [1], "transcript_path": TP, "prompt": "x"})))], vec![w("t.jsonl", n_finished(3, 20.0))]),
    );
    v.push(seq(
        "sid-array-quiet-transcript",
        vec![step(payload(json!({"session_id": [1], "transcript_path": TP, "prompt": "x"})))],
        vec![w("t.jsonl", filler(T0))],
    ));
    v.push(seq("state-garbage", vec![step(rawd.clone())], vec![w("t.jsonl", n_finished(3, 20.0)), w(".anti-hall/emit-dedupe/dedupe-dd.json", "}{")]));
    v.push(seq("state-garbage-but-quiet", vec![step(rawd.clone())], vec![w("t.jsonl", filler(T0)), w(".anti-hall/emit-dedupe/dedupe-dd.json", "}{")]));
    v.push(seq(
        "state-old-record",
        vec![step(rawd.clone())],
        vec![
            w("t.jsonl", n_finished(3, 20.0)),
            w(
                ".anti-hall/emit-dedupe/dedupe-dd.json",
                format!(
                    "{{\"idle-agent-sweep\":{{\"hash\":\"x\",\"tp\":null,\"lastEmittedAt\":{},\"lastSeenAt\":{},\"turnsSinceEmit\":0}}}}",
                    now_ms() - 3_000_000.0,
                    now_ms() - 3_000_000.0
                ),
            ),
        ],
    ));
    v
}
