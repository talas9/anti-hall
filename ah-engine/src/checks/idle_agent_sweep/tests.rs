//! Unit tests of the transcript replays behind the idle-agent-sweep script. The full Node comparison is `tests/prompt_emit_parity`.
use super::*;
use serde_json::json;

const T0: f64 = 1_790_000_000_000.0;

fn iso(ms: f64) -> String {
    let total = ms as i64;
    let (secs, milli) = (total / 1000, total % 1000);
    let (days, sod) = (secs / 86400, secs % 86400);
    let z = days + 719_468;
    let era = z / 146_097;
    let doe = z % 146_097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + i64::from(m <= 2);
    format!("{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}.{milli:03}Z", sod / 3600, sod % 3600 / 60, sod % 60)
}

fn spawn(name: &str, ts: f64) -> Vec<String> {
    vec![
        json!({"type":"assistant","timestamp":iso(ts - 10.0),"message":{"content":[{"type":"tool_use","id":"tu1","name":"Agent","input":{}}]}}).to_string(),
        json!({"type":"user","timestamp":iso(ts),"toolUseResult":{"status":"teammate_spawned","name":name,"agent_id":format!("a{name}-4e73c1cee12244e6"),"teammate_id":format!("{name}@t")},"message":{"content":[{"type":"tool_result","tool_use_id":"tu1","content":"s"}]}}).to_string(),
    ]
}

fn report(name: &str, ts: f64, reason: &str) -> String {
    let body = json!({"type":"idle_notification","from":name,"timestamp":iso(ts),"idleReason":reason});
    json!({"type":"user","timestamp":iso(ts + 100.0),"message":{"content":format!("Another Claude session sent a message:\n<teammate-message teammate_id=\"{name}\">\n{body}\n</teammate-message>")}}).to_string()
}

fn lines(v: Vec<String>) -> Vec<String> {
    v
}

#[test]
fn a_teammate_that_reported_available_and_was_not_stopped_is_finished() {
    let mut l = spawn("amy", T0 - 3_000_000.0);
    l.push(report("amy", T0 - 2_000_000.0, "available"));
    assert_eq!(scan::finished_teammates(lines(l)), Ok(vec![scan::Finished { name: "amy".into(), idle_since_ms: T0 - 2_000_000.0, stop_id: "amy@t".into() }]));
}

/// PR #893 review: the id TaskStop takes is the spawn's teammate_id (`name@session-xxxx`); a stop by it ends the teammate.
#[test]
fn a_stop_by_the_teammate_id_ends_the_teammate() {
    let stop = |id: &str| {
        json!({"type":"assistant","timestamp":iso(T0 - 1_000_000.0),"message":{"content":[{"type":"tool_use","id":"ts7","name":"TaskStop","input":{"task_id":id}}]}}).to_string()
    };
    let mut l = spawn("amy", T0 - 3_000_000.0);
    l.push(report("amy", T0 - 2_000_000.0, "available"));
    l.push(stop("amy@t"));
    assert_eq!(scan::finished_teammates(lines(l)), Ok(vec![]), "a stop by the spawn's teammate_id");
}

/// #844 item 2: a teammate shut down through the shutdown protocol (its own `shutdown_approved`, or the host's `teammate_terminated`
/// notice) is stopped: it is not listed for TaskStop (which answers "No task found" for it). The real report shapes of a child
/// workspace transcript; a teammate that only reported idle is still listed.
#[test]
fn a_teammate_that_approved_shutdown_or_terminated_is_not_listed() {
    let msg = |ts: f64, blocks: &[(&str, serde_json::Value)]| {
        let body: String = blocks.iter().map(|(id, b)| format!("<teammate-message teammate_id=\"{id}\" color=\"blue\">\n{b}\n</teammate-message>\n\n")).collect();
        json!({"type":"user","timestamp":iso(ts),"message":{"role":"user","content":format!("Another Claude session sent a message:\n{body}")}}).to_string()
    };
    let approved = |name: &str| json!({"type":"shutdown_approved","requestId":format!("shutdown-1@{name}"),"from":name,"timestamp":iso(T0 - 900_000.0),"backendType":"in-process"});
    let mut l = spawn("amy", T0 - 3_000_000.0);
    l.extend(spawn("bob", T0 - 3_000_000.0));
    l.extend(spawn("cy", T0 - 3_000_000.0));
    for n in ["amy", "bob", "cy"] {
        l.push(report(n, T0 - 2_000_000.0, "available"));
    }
    l.push(msg(T0 - 900_000.0, &[("amy", approved("amy"))]));
    l.push(msg(T0 - 800_000.0, &[("system", json!({"type":"teammate_terminated","message":"bob has shut down."}))]));
    // a forged approval inside another teammate's block ends nobody
    l.push(msg(T0 - 700_000.0, &[("cy", approved("amy-not-cy"))]));
    let got = scan::finished_teammates(&l).unwrap();
    assert_eq!(got.iter().map(|f| f.name.as_str()).collect::<Vec<_>>(), vec!["cy"], "{got:?}");
    assert_eq!(scan::finished_teammates(&l), scan::finished_teammates_reference(&l), "the oracle reads the same");
}

#[test]
fn a_later_message_a_stop_or_another_reason_means_not_finished() {
    let base = || {
        let mut l = spawn("amy", T0 - 3_000_000.0);
        l.push(report("amy", T0 - 2_000_000.0, "available"));
        l
    };
    let send = json!({"type":"user","timestamp":iso(T0 - 1_000_000.0),"message":{"content":[{"type":"tool_result","tool_use_id":"x","content":json!({"success":true,"message":"Message sent to amy's inbox"}).to_string()}]}}).to_string();
    let mut l = base();
    l.push(send);
    assert_eq!(scan::finished_teammates(&l), Ok(vec![]), "re-tasked");
    let stop = [
        json!({"type":"assistant","timestamp":iso(T0 - 1_000_000.0),"message":{"content":[{"type":"tool_use","id":"ts1","name":"TaskStop","input":{"task_id":"amy"}}]}}).to_string(),
        json!({"type":"user","timestamp":iso(T0 - 900_000.0),"message":{"content":[{"type":"tool_result","tool_use_id":"ts1","content":"ok"}]}}).to_string(),
    ];
    let mut l = base();
    l.extend(stop.clone());
    assert_eq!(scan::finished_teammates(&l), Ok(vec![]), "stopped");
    let mut l = spawn("amy", T0 - 3_000_000.0);
    l.push(report("amy", T0 - 2_000_000.0, "interrupted"));
    assert_eq!(scan::finished_teammates(&l), Ok(vec![]), "an idle reason that is not final");
    let mut l = base();
    l.extend(stop);
    let last = l.len() - 1;
    l[last] = json!({"type":"user","timestamp":iso(T0 - 900_000.0),"message":{"content":[{"type":"tool_result","tool_use_id":"ts1","is_error":true,"content":"no such task"}]}}).to_string();
    assert_eq!(scan::finished_teammates(&l).unwrap().len(), 1, "a stop that errored stopped nothing");
}

#[test]
fn a_stop_that_errored_because_the_task_is_gone_still_ended_the_agent() {
    let mut l = spawn("live31", T0 - 3_000_000.0);
    l.push(report("live31", T0 - 2_000_000.0, "available"));
    l.push(json!({"type":"assistant","timestamp":iso(T0 - 1_000_000.0),"message":{"content":[{"type":"tool_use","id":"ts9","name":"TaskStop","input":{"task_id":"live31"}}]}}).to_string());
    l.push(json!({"type":"user","timestamp":iso(T0 - 900_000.0),"message":{"content":[{"type":"tool_result","tool_use_id":"ts9","is_error":true,"content":"No task found with ID: live31"}]}}).to_string());
    assert_eq!(scan::finished_teammates(&l), Ok(vec![]), "gone agent must drop out");
}

#[test]
fn a_teammate_named_like_a_background_agent_is_not_listed() {
    let mut l = vec![json!({"type":"user","timestamp":iso(T0 - 4_000_000.0),"message":{"content":"<task-notification>\n<task-id>abcdef12</task-id>\n<status>completed</status>\n</task-notification>"}}).to_string()];
    l.extend(spawn("abcdef12", T0 - 3_000_000.0));
    l.push(report("abcdef12", T0 - 2_000_000.0, "available"));
    assert_eq!(scan::finished_teammates(&l), Ok(vec![]));
}

#[test]
fn a_line_with_a_marker_that_no_parser_reads_defers_and_an_odd_timestamp_defers() {
    let mut l = spawn("amy", T0 - 3_000_000.0);
    l.push("{\"type\":\"user\" tool_result BROKEN".into());
    assert_eq!(scan::finished_teammates(&l), Err(Defer));
    let l = vec![json!({"type":"user","timestamp":"2026-01-01 00:00:00","message":{"content":[{"type":"tool_result","content":"x"}]}}).to_string()];
    assert_eq!(scan::finished_teammates(&l), Err(Defer));
    let l = vec!["unrelated garbage".to_string(), String::new(), "{\"type\":\"assistant\"}".to_string()];
    assert_eq!(scan::finished_teammates(&l), Ok(vec![]), "lines without a marker are not read at all");
}

#[test]
fn codex_agents_are_finished_until_closed_or_retasked() {
    let call = |ts: f64, name: &str, args: serde_json::Value, id: &str| {
        json!({"timestamp":iso(ts),"payload":{"type":"function_call","name":name,"arguments":args.to_string(),"call_id":id}}).to_string()
    };
    let out = |ts: f64, id: &str, o: serde_json::Value| {
        json!({"timestamp":iso(ts),"payload":{"type":"function_call_output","call_id":id,"output":o.to_string()}}).to_string()
    };
    let uuid = "11111111-2222-3333-4444-555555555555";
    let base = || {
        vec![
            call(T0 - 5000.0, "spawn_agent", json!({}), "c1"),
            out(T0 - 4000.0, "c1", json!({"agent_id": uuid, "nickname": "Ada"})),
            call(T0 - 3000.0, "wait_agent", json!({}), "c2"),
            out(T0 - 2000.0, "c2", json!({"status": {uuid: {"completed": "ok"}}})),
        ]
    };
    let got = codex::finished(base()).unwrap();
    assert_eq!(got, vec![codex::CodexAgent { id: uuid.into(), label: format!("Ada ({uuid})"), idle_since_ms: T0 - 2000.0 }]);
    let mut closed = base();
    closed.push(call(T0 - 1000.0, "close_agent", json!({"targets": [uuid]}), "c3"));
    assert_eq!(codex::finished(&closed).unwrap(), vec![]);
    let mut again = base();
    again.push(call(T0 - 1000.0, "send_input", json!({"target": uuid}), "c3"));
    assert_eq!(codex::finished(&again).unwrap(), vec![]);
}

/// #953: the teammate scan now reads its lines through the shared incremental view. Its answer is the one the whole-window read gave
/// (`tail_lines_bounded` + `finished_teammates`), across appended turns, window sizes (cut and whole) and a rewritten file.
#[test]
fn the_teammate_scan_through_the_view_equals_the_whole_window_read() {
    use std::io::Write;
    let d = crate::tmpsweep::scratch("ah-tm-view-", "parity");
    let p = d.join("t.jsonl").to_string_lossy().to_string();
    let old = |w: u64| -> String {
        let Some((mut it, _)) = crate::checks::guardkit::tail::tail_lines_bounded(&p, w, crate::defaults::num("agent_scan.max_line_bytes")) else {
            return "null".into();
        };
        let found = scan::finished_teammates_reference(it.by_ref());
        if it.skipped() > 0 {
            return r#"{"unsure":true}"#.into();
        }
        match found {
            Ok(v) => json!({"teammates": v.iter().map(|f| json!({"name": f.name, "idleSinceMs": f.idle_since_ms, "stopId": f.stop_id})).collect::<Vec<_>>()}).to_string(),
            Err(_) => r#"{"unsure":true}"#.into(),
        }
    };
    let add = |ls: &[String]| {
        let mut f = std::fs::OpenOptions::new().create(true).append(true).open(&p).unwrap();
        for l in ls {
            writeln!(f, "{l}").unwrap();
        }
    };
    let stop = |id: &str, ts: f64| {
        json!({"type":"assistant","timestamp":iso(ts),"message":{"content":[{"type":"tool_use","id":"ts7","name":"TaskStop","input":{"task_id":id}}]}}).to_string()
    };
    let noise = |n: usize| (0..n).map(|i| json!({"type":"user","timestamp":iso(T0 + i as f64),"message":{"content":format!("noise {i} {}", "z".repeat(90))}}).to_string()).collect::<Vec<_>>();
    let check = |tag: &str| {
        for w in [300u64, 2_000, 9_000, 40_000, 100_000_000] {
            assert_eq!(crate::script::host_ts::teammates(&p, w as f64), old(w), "{tag}: window {w}");
        }
    };
    add(&noise(30));
    add(&spawn("amy", T0 - 3_000_000.0));
    add(&spawn("bob", T0 - 2_900_000.0));
    check("spawned");
    add(&noise(20));
    add(&[report("amy", T0 - 2_000_000.0, "available")]);
    check("amy idle");
    add(&noise(10));
    add(&[report("bob", T0 - 1_500_000.0, "failed"), stop("amy@t", T0 - 1_000_000.0)]);
    check("amy stopped");
    add(&noise(200));
    check("more noise");
    // a compaction: the file is replaced by a shorter one
    std::fs::write(&p, "").unwrap();
    add(&spawn("cy", T0 - 500_000.0));
    add(&[report("cy", T0 - 400_000.0, "available")]);
    check("rewritten");
    assert!(crate::script::host_ts::teammates(&p, 1e8).contains("\"cy\""), "the fixture holds a finished teammate, so the parity is not vacuous");
}

/// #953: the digest-and-apply scan equals the scan as it was, line for line, on every shape the replay tests build, and on the
/// real transcript named by `AH_TEST_TRANSCRIPT` when one is set (its tail, whole).
#[test]
fn the_digest_and_apply_scan_equals_the_scan_as_it_was() {
    let stop = |id: &str, ts: f64, tuid: &str| {
        json!({"type":"assistant","timestamp":iso(ts),"message":{"content":[{"type":"tool_use","id":tuid,"name":"TaskStop","input":{"task_id":id}}]}}).to_string()
    };
    let result = |tuid: &str, text: &str, err: bool, ts: f64| {
        json!({"type":"user","timestamp":iso(ts),"message":{"content":[{"type":"tool_result","tool_use_id":tuid,"is_error":err,"content":text}]}}).to_string()
    };
    let launch = |tuid: &str, ts: f64| {
        let call = json!({"type":"assistant","timestamp":iso(ts - 5.0),"message":{"content":[{"type":"tool_use","id":tuid,"name":"Agent","input":{}}]}}).to_string();
        let res = json!({"type":"user","timestamp":iso(ts),"toolUseResult":{"agentId":"a0123456789abcdef"},"message":{"content":[{"type":"tool_result","tool_use_id":tuid,"content":"Async agent launched successfully. agentId: a0123456789abcdef"}]}}).to_string();
        vec![call, res]
    };
    let send = |tuid: &str, name: &str, ts: f64| {
        vec![
            json!({"type":"assistant","timestamp":iso(ts - 1.0),"message":{"content":[{"type":"tool_use","id":tuid,"name":"SendMessage","input":{}}]}}).to_string(),
            result(tuid, &json!({"success":true,"message":format!("Message sent to {name}'s inbox")}).to_string(), false, ts),
        ]
    };
    let mut scenarios: Vec<Vec<String>> = Vec::new();
    let base = || {
        let mut l = spawn("amy", T0 - 3_000_000.0);
        l.extend(spawn("bob", T0 - 2_900_000.0));
        l
    };
    let mut a = base();
    a.push(report("amy", T0 - 2_000_000.0, "available"));
    a.push(report("bob", T0 - 1_900_000.0, "failed"));
    scenarios.push(a.clone());
    a.extend(send("s1", "amy", T0 - 1_800_000.0));
    scenarios.push(a.clone());
    a.push(report("amy", T0 - 1_700_000.0, "available"));
    scenarios.push(a.clone());
    a.push(stop("bob@t", T0 - 1_600_000.0, "k1"));
    a.push(result("k1", "No task found with ID: amy", true, T0 - 1_590_000.0));
    scenarios.push(a.clone());
    a.push(stop("amy", T0 - 1_500_000.0, "k2"));
    scenarios.push(a.clone());
    let mut b = base();
    b.extend(launch("l1", T0 - 2_500_000.0));
    b.push(report("amy", T0 - 2_000_000.0, "available"));
    b.push(result("r1", "{\"success\":true,\"message\":\"Resuming amy\"}", false, T0 - 1_900_000.0));
    scenarios.push(b.clone());
    b.push(report("zed", T0 - 1_000_000.0, "available")); // an unspawned name
    scenarios.push(b);
    scenarios.push(vec!["{\"type\":\"user\" idle_notification not json".into()]); // a marked line neither parser reads: defer
    scenarios.push(vec![]);
    for (i, l) in scenarios.iter().enumerate() {
        assert_eq!(scan::finished_teammates(l), scan::finished_teammates_reference(l), "scenario {i}");
        for cut in [1usize, 3, 5] {
            let t: Vec<String> = l.iter().skip(cut.min(l.len())).cloned().collect();
            assert_eq!(scan::finished_teammates(&t), scan::finished_teammates_reference(&t), "scenario {i} without its first {cut} lines");
        }
    }
    if let Ok(p) = std::env::var("AH_TEST_TRANSCRIPT")
        && let Some((it, _)) = crate::checks::guardkit::tail::tail_lines(&p, 16 << 20)
    {
        let all: Vec<String> = it.collect();
        assert_eq!(scan::finished_teammates(&all), scan::finished_teammates_reference(&all), "the real transcript tail");
    }
}

/// #953: the waiting-teammate scan moved from the script into the engine. The script's own answer (the new `idWaiting`) is compared with
/// the old JavaScript function (`tests/fixtures/idle-waiting-before-953.js`, run in the same script) on transcripts that spawn, idle,
/// re-task, stop and report "No task found" for teammates, across windows and appended turns.
#[test]
fn the_waiting_scan_in_the_engine_equals_the_script_it_replaced() {
    use crate::reqenv::RequestEnv;
    use serde_json::Value;
    use std::io::Write;
    let manifest = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
    let shipped = std::fs::read_to_string(manifest.join("../plugins/anti-hall/engine/logic/idle-agent-sweep.js")).unwrap();
    let old = std::fs::read_to_string(manifest.join("tests/fixtures/idle-waiting-before-953.js")).unwrap();
    // the shipped script with the old function beside the new one, and a `decide` that answers both as text
    let harness = format!(
        "{shipped}\n{old}\nfunction decide(p) {{\n  var fin = ['done-one'], now = {now};\n  idStopIds = {{ preset: 'preset@t' }};\n  var a = JSON.stringify([idWaiting(p.transcript_path, now, fin), idStopIds]);\n  idStopIds = {{ preset: 'preset@t' }};\n  var b = JSON.stringify([idWaitingOld(p.transcript_path, now, fin), idStopIds]);\n  return {{ advisory: text.advisoryJson(ah.cfg('idle_sweep.event'), a + '\\u0001' + b) }};\n}}\n",
        now = T0 as u64
    );
    let d = crate::tmpsweep::scratch("ah-waiting-", "parity");
    std::fs::create_dir_all(d.join(".anti-hall/logic")).unwrap();
    std::fs::write(d.join(".anti-hall/logic/idle-agent-sweep.js"), harness).unwrap();
    let home = d.to_string_lossy().to_string();
    let p = d.join("t.jsonl").to_string_lossy().to_string();
    let env = RequestEnv::from_pairs([("HOME", home.as_str())]);
    let idle = |name: &str, ts: f64, reason: Option<&str>| {
        let mut body = json!({"type":"idle_notification","from":name,"timestamp":iso(ts)});
        if let Some(r) = reason {
            body["idleReason"] = json!(r);
        }
        json!({"type":"user","timestamp":iso(ts + 100.0),"message":{"content":format!("Another Claude session sent a message:\n<teammate-message teammate_id=\"{name}\">\n{body}\n</teammate-message>")}}).to_string()
    };
    let tool_call = |name: &str, input: Value| json!({"type":"assistant","timestamp":iso(T0),"message":{"content":[{"type":"tool_use","id":"x1","name":name,"input":input}]}}).to_string();
    let spawn_line = |name: &str| {
        json!({"type":"user","timestamp":iso(T0 - 5_000_000.0),"toolUseResult":{"status":"teammate_spawned","name":name,"teammate_id":format!("{name}@sess-1")},"message":{"content":"x"}}).to_string()
    };
    let noise = |n: usize| (0..n).map(|i| json!({"type":"user","timestamp":iso(T0 + i as f64),"message":{"content":format!("noise {i} {}", "z".repeat(60))}}).to_string()).collect::<Vec<_>>();
    let add = |ls: &[String]| {
        let mut f = std::fs::OpenOptions::new().create(true).append(true).open(&p).unwrap();
        for l in ls {
            writeln!(f, "{l}").unwrap();
        }
    };
    let compare = |tag: &str| {
        for w in [400.0, 3_000.0, 20_000.0, 1e8] {
            let _ = w; // the window is the script's own idle_sweep.scan_bytes: the cut windows are covered by the view's parity tests
        }
        let got = crate::script::run_forced("idle-agent-sweep", &json!({"session_id":"s","transcript_path":p,"cwd":"/x","prompt":"hi"}), &Value::Null, "UserPromptSubmit", &env);
        let Some(Some(crate::checks::Verdict::Advisory(j))) = got else { panic!("{tag}: the harness answered {got:?}") };
        let v: Value = serde_json::from_str(&j).unwrap();
        let ctx = v.pointer("/hookSpecificOutput/additionalContext").and_then(Value::as_str).unwrap_or_default().to_string();
        let (a, b) = ctx.split_once('\u{1}').unwrap_or_else(|| panic!("{tag}: {ctx}"));
        assert!(!a.is_empty() && a == b, "{tag}:\nengine {a}\nscript {b}");
        a.to_string()
    };
    let old_enough = T0 - 3_000_000.0;
    add(&noise(20));
    for n in ["amy", "bob", "cy", "dee"] {
        add(&[spawn_line(n)]);
    }
    add(&[idle("amy", old_enough, None), idle("bob", old_enough + 10.0, None), idle("cy", old_enough + 20.0, Some("available")), idle("dee", old_enough + 30.0, None)]);
    let first = compare("four idle");
    assert!(first.contains("amy") && first.contains("bob"), "the fixture holds waiting teammates, so the parity is not vacuous: {first}");
    add(&noise(15));
    add(&[tool_call("SendMessage", json!({"to":"amy","message":"go on"}))]);
    compare("amy re-tasked");
    add(&[tool_call("TaskStop", json!({"task_id":"bob@sess-1"}))]);
    compare("bob stopped by id");
    add(&[idle("bob", old_enough + 500.0, None)]);
    compare("a late idle report of a stopped teammate");
    add(&[json!({"type":"user","timestamp":iso(T0),"message":{"content":[{"type":"tool_result","tool_use_id":"x9","is_error":true,"content":"No task found with ID: dee@sess-1"}]}}).to_string()]);
    compare("dee gone");
    add(&[spawn_line("bob"), idle("bob", old_enough + 900.0, None)]);
    compare("bob spawned again and idle");
    add(&noise(300));
    compare("more noise");
    std::fs::write(&p, "").unwrap();
    add(&[spawn_line("zed"), idle("zed", old_enough, None)]);
    compare("rewritten");
}
