//! Unit tests of the batch-6 host primitives (D88): the task list, the agent scan, the Jev outcome and cache probes, the plugin
//! versions and the CPU count. None of them holds a rule; these tests pin what they extract and their bounds.
use super::*;
use serde_json::json;

fn home(tag: &str) -> String {
    let d = std::env::temp_dir().join(format!("ah-hostd-{tag}-{}", std::process::id()));
    crate::discard::harmless(std::fs::remove_dir_all(&d)); // keep: cleanup that raced; an absent dir is the goal state
    std::fs::create_dir_all(d.join(".anti-hall/logic")).unwrap();
    std::fs::canonicalize(&d).unwrap().to_string_lossy().to_string()
}

fn env(h: &str) -> RequestEnv {
    RequestEnv::from_pairs([("HOME", h)])
}

fn put_override(h: &str, name: &str, body: &str) {
    std::fs::write(format!("{h}/.anti-hall/logic/{name}.js"), body).unwrap();
}

fn run(name: &str, p: &Value, e: &RequestEnv) -> Option<Option<Verdict>> {
    super::run_forced(name, p, &Value::Null, "PreToolUse", e)
}

fn line(v: Value) -> String {
    format!("{v}\n")
}

fn assistant_tool(id: &str, name: &str, input: Value, ts: &str) -> String {
    line(
        json!({"type": "assistant", "timestamp": ts, "message": {"role": "assistant", "content": [{"type": "tool_use", "id": id, "name": name, "input": input}]}}),
    )
}

fn result(id: &str, text: &str) -> String {
    line(json!({"type": "user", "message": {"role": "user", "content": [{"type": "tool_result", "tool_use_id": id, "content": text}]}}))
}

#[test]
fn transcript_tasks_rebuilds_the_task_list_in_map_order_for_each_variant() {
    let h = home("tasks");
    let t = format!("{h}/t.jsonl");
    let mut text = String::new();
    text.push_str(&assistant_tool("c1", "TaskCreate", json!({"subject": "first", "priority": "P0"}), "2026-10-06T12:00:00.000Z"));
    text.push_str(&result("c1", "Task #1 created successfully: first"));
    text.push_str(&assistant_tool("c2", "TaskCreate", json!({"subject": "second", "description": "why"}), "2026-10-06T12:01:00.000Z"));
    text.push_str(&result("c2", "Task #2 created successfully: second"));
    text.push_str(&assistant_tool("u1", "TaskUpdate", json!({"taskId": "1", "status": "in_progress", "owner": "w1"}), "2026-10-06T12:02:00.000Z"));
    std::fs::write(&t, text).unwrap();
    let guard: Value = serde_json::from_str(&host_d::transcript_tasks(&t, "guard", 1_000_000.0, 0.0)).unwrap();
    let tasks = guard["tasks"].as_array().unwrap();
    assert_eq!(tasks.iter().map(|x| x["id"].as_str().unwrap()).collect::<Vec<_>>(), ["1", "2"]);
    assert_eq!(tasks[0]["status"], json!("in_progress"));
    assert_eq!(tasks[0]["owner"], json!("w1"));
    assert_eq!(tasks[0]["priority"], json!("P0"));
    assert!(tasks[1]["sinceMs"].as_f64().unwrap() > 0.0, "the guard variant keeps the time a task was created");
    assert!(tasks[1].get("blockedOn").is_none(), "a marker never set is absent, not null");
    assert_eq!(guard["truncated"], json!(false));
    let state: Value = serde_json::from_str(&host_d::transcript_tasks(&t, "state", 1_000_000.0, 0.0)).unwrap();
    assert_eq!(state["tasks"][1]["description"], json!("why"), "the state variant keeps descriptions");
    assert_eq!(state["tasks"][0]["sinceMs"], Value::Null);
    let scan: Value = serde_json::from_str(&host_d::transcript_tasks(&t, "scan", 1_000_000.0, 1_000_000.0)).unwrap();
    assert_eq!(scan["openTaskIds"], json!(["1", "2"]));
    assert_eq!((scan["sawTaskActivity"].clone(), scan["inProgressCount"].clone()), (json!(true), json!(1)));
    let gone: Value = serde_json::from_str(&host_d::transcript_tasks(&format!("{h}/none"), "guard", 1000.0, 0.0)).unwrap();
    assert_eq!(gone, json!({"tasks": [], "unreadable": true}));
    let quiet = format!("{h}/q.jsonl");
    std::fs::write(&quiet, "null\n").unwrap();
    assert_eq!(serde_json::from_str::<Value>(&host_d::transcript_tasks(&quiet, "scan", 1000.0, 1000.0)).unwrap(), json!({"quiet": true}));
    // through the script API
    put_override(
        &h,
        "zz-tasks",
        &format!(
            "function decide(p){{ var r = ah.transcript.tasks('{t}', 'guard', 1000000); return r && r.tasks.length === 2 && r.tasks[0].blockedBy.length === 0 ? 'allow' : 'defer'; }}"
        ),
    );
    assert_eq!(run("zz-tasks", &json!({}), &env(&h)), Some(Some(Verdict::Allow)));
}

#[test]
fn agent_scan_lists_launched_agents_with_their_times_and_terminal_ids() {
    let h = home("agents");
    let t = format!("{h}/t.jsonl");
    let launch = "Async agent launched successfully. (internal metadata)\nagentId: a1b2c3d4e5f60718 (internal ID - do not mention to user. Use SendMessage with to: 'a1b2c3d4e5f60718', summary: '<5-10 word recap>' to continue this agent.)\nThe agent is working in the background.\noutput_file: /nonexistent/out.output\nDo NOT Read or tail this file via the shell tool.";
    let mut text = String::new();
    text.push_str(&assistant_tool(
        "a1",
        "Agent",
        json!({"description": "scan the thing", "prompt": "p", "run_in_background": true}),
        "2026-10-06T12:00:00.000Z",
    ));
    text.push_str(&line(json!({"type": "user", "timestamp": "2026-10-06T12:00:01.000Z", "message": {"role": "user", "content": [{"type": "tool_result", "tool_use_id": "a1", "content": launch}]}, "toolUseResult": {"isAsync": true, "status": "async_launched", "agentId": "a1b2c3d4e5f60718"}})));
    std::fs::write(&t, text).unwrap();
    let scan: Value = serde_json::from_str(&host_d::agent_scan(&t, 1_000_000.0)).unwrap();
    assert_eq!(scan["terminal"], json!([]));
    let rows = scan["launched"].as_array().unwrap();
    assert_eq!(rows.len(), 1, "{scan}");
    assert_eq!(rows[0]["id"], json!("a1b2c3d4e5f60718"));
    assert_eq!(rows[0]["description"], json!("scan the thing"));
    assert_eq!(rows[0]["outputFile"], json!("/nonexistent/out.output"));
    assert!(rows[0]["launchedAtMs"].as_f64().unwrap() > 0.0);
    assert_eq!(rows[0]["spawnInput"]["run_in_background"], json!(true));
    put_override(
        &h,
        "zz-agents",
        &format!(
            "function decide(p){{ var s = ah.transcript.agentScan('{t}', 1000000); var r = ah.transcript.agents('{t}'); return s.launched.length === 1 && r.rows.length === 1 && r.rows[0].outputFile === '/nonexistent/out.output' ? 'allow' : 'defer'; }}"
        ),
    );
    assert_eq!(run("zz-agents", &json!({}), &env(&h)), Some(Some(Verdict::Allow)));
    assert_eq!(host_d::agent_scan(&format!("{h}/none"), 1000.0), "null");
    assert_eq!(serde_json::from_str::<Value>(&host_d::agent_scan("relative.jsonl", 1000.0)).unwrap(), json!({"unsure": true}));
}

#[test]
fn a_routed_verdict_carries_its_route_telemetry_and_a_malformed_one_defers() {
    let h = home("routed");
    let meta = "{requested_model:'opus',parent_model:'sonnet',task_class:'unknown',recommended_tier:'opus',selected_model:'opus',outcome:'allow',spawn_key:'spawn-1',delegate:false,blocked:false}";
    put_override(&h, "zz-routed", &format!("function decide(p){{ return {{routed: {{verdict: 'allow', meta: [{meta}]}}}}; }}"));
    match run("zz-routed", &json!({}), &env(&h)) {
        Some(Some(Verdict::Routed(inner, metas))) => {
            assert_eq!(*inner, Verdict::Allow);
            assert_eq!(metas.len(), 1);
            assert_eq!((metas[0].spawn_key.as_str(), metas[0].delegate, metas[0].blocked), ("spawn-1", false, false));
        }
        other => panic!("{other:?}"),
    }
    put_override(&h, "zz-routed2", "function decide(p){ return {routed: {verdict: {exact: {code: 2, out: 'o', err: ''}}, meta: [{outcome: 'deny'}]}}; }");
    assert_eq!(run("zz-routed2", &json!({}), &env(&h)), Some(Some(Verdict::Defer)), "a meta missing fields is a script failure");
}

#[test]
fn plugin_versions_name_the_running_and_the_registered_version() {
    let h = home("versions");
    let root = format!("{h}/plugin");
    std::fs::create_dir_all(format!("{root}/.claude-plugin")).unwrap();
    std::fs::write(format!("{root}/.claude-plugin/plugin.json"), r#"{"name":"anti-hall","version":"1.2.3"}"#).unwrap();
    let reg_dir = format!("{h}/.claude/plugins");
    std::fs::create_dir_all(format!("{reg_dir}/marketplaces/m")).unwrap();
    std::fs::write(format!("{reg_dir}/installed_plugins.json"), r#"{"plugins":{"anti-hall@anti-hall":[{"scope":"user","version":"1.4.0"}]}}"#).unwrap();
    put_override(
        &h,
        "zz-versions",
        &format!(
            "function decide(p){{ var v = ah.plugin.versions('{root}'); return v.running === '1.2.3' && v.registered === '1.4.0' && !v.unsure && ah.plugin.versions('').running === null ? 'allow' : 'defer'; }}"
        ),
    );
    assert_eq!(run("zz-versions", &json!({}), &env(&h)), Some(Some(Verdict::Allow)));
}

#[test]
fn the_cpu_count_is_a_positive_number_where_the_engine_can_read_it_like_node() {
    let h = home("cores");
    put_override(&h, "zz-cores", "function decide(p){ var c = ah.sys.cores(); return c === null || c >= 1 ? 'allow' : 'defer'; }");
    assert_eq!(run("zz-cores", &json!({}), &env(&h)), Some(Some(Verdict::Allow)));
}

#[test]
fn the_jev_cache_probe_and_the_outcome_record_work_on_the_request_home() {
    let h = home("jev");
    put_override(
        &h,
        "zz-jev",
        "function decide(p){ var had = ah.jev.cacheHas('abc'); ah.jev.recordOutcome('speculation', 'h1', 'evidence', 'regex', ''); return had === false ? 'allow' : 'defer'; }",
    );
    assert_eq!(run("zz-jev", &json!({}), &env(&h)), Some(Some(Verdict::Allow)));
    let log = std::fs::read_to_string(format!("{h}/{}/{}", defaults::text("paths.base_dir"), defaults::text("jev.log_file"))).unwrap();
    assert!(log.contains(r#""type":"outcome""#) && log.contains(r#""h":"h1""#) && log.contains(r#""source":"regex""#), "{log}");
    // a cache file with an answer under a hash
    std::fs::create_dir_all(format!("{h}/.anti-hall/cache")).unwrap();
    std::fs::write(format!("{h}/{}/{}", defaults::text("paths.base_dir"), defaults::text("jev.cache_file")), r#"{"abc":{"v":true}}"#).unwrap();
    put_override(&h, "zz-jev2", "function decide(p){ return ah.jev.cacheHas('abc') === true && ah.jev.cacheHas('zzz') === false ? 'allow' : 'defer'; }");
    assert_eq!(run("zz-jev2", &json!({}), &env(&h)), Some(Some(Verdict::Allow)));
}

#[test]
fn ah_clock_now_reads_the_engine_clock_and_follows_an_injected_one() {
    let h = home("clock");
    put_override(&h, "zz-clock", "function decide(p){ var t = ah.clock.now(); return typeof t === 'number' && t === ah.clock.now() ? 'allow' : 'defer'; }");
    put_override(&h, "zz-clock2", "function decide(p){ return ah.clock.now() === 1700000000123 && ah.clock.local().year === 2023 ? 'allow' : 'defer'; }");
    host::set_clock(Some(1_700_000_000_123.0));
    assert_eq!(run("zz-clock2", &json!({}), &env(&h)), Some(Some(Verdict::Allow)), "the injected clock, with no script-side override");
    host::set_clock(None);
    let real = host::now_ms();
    assert_eq!(run("zz-clock2", &json!({}), &env(&h)), Some(Some(Verdict::Defer)), "the system clock when nothing is injected");
    assert!(real > 1_700_000_000_000.0);
    host::set_clock(Some(5.0));
    assert_eq!(run("zz-clock", &json!({}), &env(&h)), Some(Some(Verdict::Allow)));
    host::set_clock(None);
}

#[test]
fn ah_state_readtext_remove_and_sweep_are_installed_and_scoped() {
    let h = home("state");
    std::fs::create_dir_all(format!("{h}/.anti-hall/d")).unwrap();
    std::fs::write(format!("{h}/.anti-hall/d/a.txt"), "hello").unwrap();
    std::fs::write(format!("{h}/.anti-hall/d/pre-1.json"), "{}").unwrap();
    put_override(
        &h,
        "zz-state",
        "function decide(p){ var t = ah.state.readText('.anti-hall/d/a.txt'); var none = ah.state.readText('.anti-hall/d/none'); \
         var swept = ah.state.sweep('.anti-hall/d', 'pre-', 0, 5); var gone = ah.state.remove('.anti-hall/d/a.txt'); \
         return t === 'hello' && none === null && swept === 1 && gone === true && ah.state.readText('.anti-hall/d/a.txt') === null ? 'allow' : 'defer'; }",
    );
    // a freshly written file is not older than 0 ms only when the clock has moved on: age the sweep by backdating through the clock
    host::set_clock(Some(host::now_ms() + 10_000.0));
    assert_eq!(run("zz-state", &json!({}), &env(&h)), Some(Some(Verdict::Allow)));
    host::set_clock(None);
    assert!(!std::path::Path::new(&format!("{h}/.anti-hall/d/pre-1.json")).exists());
}

/// Every `ahHost.<name>` the shipped API scripts call is registered by the engine: a primitive documented but never installed throws
/// "not a function" in the first script that uses it (`ahHost.now` and `ahHost.stateRead` once were).
#[test]
fn every_ahhost_function_the_api_scripts_call_is_registered() {
    use std::collections::BTreeSet;
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
    let mut used = BTreeSet::new();
    let logic = root.join("../plugins/anti-hall/engine/logic");
    let mut files: Vec<_> = std::fs::read_dir(logic.join("lib")).unwrap().flatten().map(|e| e.path()).collect();
    files.extend(std::fs::read_dir(&logic).unwrap().flatten().map(|e| e.path()));
    for f in files.iter().filter(|f| f.extension().is_some_and(|x| x == "js")) {
        let text = std::fs::read_to_string(f).unwrap();
        let mut rest = text.as_str();
        while let Some(i) = rest.find("ahHost.") {
            rest = &rest[i + 7..];
            let name: String = rest.chars().take_while(|c| c.is_ascii_alphanumeric() || *c == '_').collect();
            used.insert(name);
        }
    }
    let mut registered = BTreeSet::new();
    for e in std::fs::read_dir(root.join("src/script")).unwrap().flatten() {
        if e.path().extension().is_some_and(|x| x == "rs") {
            let text = std::fs::read_to_string(e.path()).unwrap();
            let mut rest = text.as_str();
            while let Some(i) = rest.find("h.set(") {
                rest = &rest[i + 6..];
                let tail = rest.trim_start();
                if let Some(q) = tail.strip_prefix('"') {
                    registered.insert(q.chars().take_while(|c| *c != '"').collect::<String>());
                }
            }
        }
    }
    let missing: Vec<_> = used.difference(&registered).collect();
    assert!(missing.is_empty(), "ahHost functions the API scripts call but the engine never registers: {missing:?}");
    assert!(used.len() > 40, "the scan found the API ({} names)", used.len());
}
