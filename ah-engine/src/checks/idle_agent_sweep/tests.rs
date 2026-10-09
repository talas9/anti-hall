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
        json!({"type":"user","timestamp":iso(ts),"toolUseResult":{"status":"teammate_spawned","name":name,"agent_id":format!("{name}@t")},"message":{"content":[{"type":"tool_result","tool_use_id":"tu1","content":"s"}]}}).to_string(),
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
    assert_eq!(scan::finished_teammates(lines(l)), Ok(vec![scan::Finished { name: "amy".into(), idle_since_ms: T0 - 2_000_000.0 }]));
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

