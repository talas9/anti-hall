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
    assert_eq!(
        serde_json::from_str::<Value>(&host_d::transcript_tasks(&quiet, "scan", 1000.0, 1000.0)).unwrap(),
        json!({"inProgressCount": 0, "openTaskIds": [], "sawTaskActivity": false, "taskStoreReset": false, "unsure": true})
    );
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
    let scan: Value = serde_json::from_str(&host_d::agent_scan(&t, 1_000_000.0, false)).unwrap();
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
    assert_eq!(host_d::agent_scan(&format!("{h}/none"), 1000.0, false), "null");
    assert_eq!(serde_json::from_str::<Value>(&host_d::agent_scan("relative.jsonl", 1000.0, false)).unwrap(), json!({"unsure": true}));
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
    assert_eq!(
        run("zz-routed2", &json!({}), &env(&h)),
        Some(Some(Verdict::Allow)),
        "a meta missing fields is a script failure: the failure policy decides (open)"
    );
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

// ---- #390: the task snapshot (the transcript tail alone loses a task list once the creates lie beyond the window) ----

const SNAP_WINDOW: u64 = 1_048_576;

/// A non-task transcript line of about 1 KB, repeated until `bytes` have been written to the end of `path`.
fn pad(path: &str, bytes: usize) {
    use std::io::Write;
    let one = line(json!({"type": "assistant", "message": {"role": "assistant", "content": [{"type": "text", "text": "x".repeat(900)}]}}));
    let mut f = std::fs::OpenOptions::new().append(true).open(path).unwrap();
    for _ in 0..bytes / one.len() + 1 {
        f.write_all(one.as_bytes()).unwrap();
    }
}

fn snap_create(n: u32, subject: &str) -> String {
    assistant_tool(&format!("c{n}"), "TaskCreate", json!({"subject": subject, "description": format!("why {n}")}), "2026-10-06T12:00:00.000Z")
        + &result(&format!("c{n}"), &format!("Task #{n} created successfully: {subject}"))
}

/// The overnight shape: three tasks at the head, task 1 taken (owner w1, in progress).
fn snap_head() -> String {
    snap_create(1, "first")
        + &snap_create(2, "second")
        + &snap_create(3, "third")
        + &assistant_tool("u1", "TaskUpdate", json!({"taskId": "1", "status": "in_progress", "owner": "w1"}), "2026-10-06T12:02:00.000Z")
        + &result("u1", "Updated task #1")
}

/// A script that rebuilds the guard task list of `p.t` over a window of `p.w` bytes and files `[id, content, status, owner]` rows (and
/// `windowReset`) as `.anti-hall/out-<p.n>.json`; the verdict is always allow.
fn snap_probe(h: &str) {
    put_override(
        h,
        "zz-snap",
        "function decide(p){ var r = ah.transcript.tasks(p.t, 'guard', p.w, 0, p.s); \
         ah.state.writeAtomic('.anti-hall/out-' + p.n + '.json', JSON.stringify({rows: (r.tasks || []).map(function (t) { return [t.id, t.content, t.status, t.owner, t.description]; }), reset: !!r.windowReset})); \
         return 'allow'; }",
    );
}

fn snap_rebuild(h: &str, t: &str, n: &str) -> Value {
    snap_rebuild_as(h, t, n, "")
}

/// [`snap_rebuild`] for the session `sid` (the hook payload's session id; empty: none given).
fn snap_rebuild_as(h: &str, t: &str, n: &str, sid: &str) -> Value {
    assert_eq!(run("zz-snap", &json!({"t": t, "w": SNAP_WINDOW, "n": n, "s": sid}), &env(h)), Some(Some(Verdict::Allow)));
    serde_json::from_str(&std::fs::read_to_string(format!("{h}/.anti-hall/out-{n}.json")).unwrap()).unwrap()
}

fn snap_rows(v: &Value) -> Vec<(String, String, String, String)> {
    v["rows"]
        .as_array()
        .unwrap()
        .iter()
        .map(|r| (r[0].as_str().unwrap().into(), r[1].as_str().unwrap().into(), r[2].as_str().unwrap().into(), r[3].as_str().unwrap().into()))
        .collect()
}

fn snap_all(h: &str) -> Vec<String> {
    let mut v: Vec<String> = std::fs::read_dir(format!("{h}/.anti-hall/{}", defaults::text("taskstate.snapshot_dir")))
        .map_or_else(|_| Vec::new(), |d| d.flatten().map(|e| e.file_name().to_string_lossy().into_owned()).collect());
    v.sort();
    v
}

/// The snapshot files of the home (the lock files beside them are [`snap_all`]'s).
fn snap_files(h: &str) -> Vec<String> {
    snap_all(h).into_iter().filter(|f| f.ends_with(".json")).collect()
}

/// The one snapshot file of the home, parsed (panics when there is not exactly one).
fn snap_doc(h: &str) -> Value {
    let files = snap_files(h);
    assert_eq!(files.len(), 1, "exactly one snapshot file: {files:?}");
    let p = format!("{h}/.anti-hall/{}/{}", defaults::text("taskstate.snapshot_dir"), files[0]);
    serde_json::from_str(&std::fs::read_to_string(p).unwrap()).unwrap()
}

/// The ids the snapshot holds for a variant.
fn snap_ids(doc: &Value, variant: &str) -> Vec<String> {
    doc["variants"][variant]["tasks"].as_array().map_or_else(Vec::new, |a| a.iter().filter_map(|t| t["id"].as_str().map(str::to_string)).collect())
}

/// What the calling thread bumped on `name` with the one label `label=value`.
fn bumped(name: &str, label: &str, value: &str) -> u64 {
    crate::metrics::bumped_on_this_thread(name, &[(label, value)])
}

fn append(t: &str, text: &str) {
    std::fs::OpenOptions::new().append(true).open(t).and_then(|mut f| std::io::Write::write_all(&mut f, text.as_bytes())).unwrap();
}

fn row(id: &str, content: &str, status: &str, owner: &str) -> (String, String, String, String) {
    (id.into(), content.into(), status.into(), owner.into())
}

#[test]
fn a_task_list_whose_creates_left_the_tail_window_is_still_read_through_its_snapshot() {
    let h = home("snap-overnight");
    let t = format!("{h}/t.jsonl");
    std::fs::write(&t, snap_head()).unwrap();
    snap_probe(&h);
    let first = snap_rebuild(&h, &t, "a");
    let want = vec![row("1", "first", "in_progress", "w1"), row("2", "second", "pending", ""), row("3", "third", "pending", "")];
    assert_eq!(snap_rows(&first), want, "the first rebuild sees the whole small file");
    pad(&t, SNAP_WINDOW as usize + 200_000);
    let night = snap_rebuild(&h, &t, "b");
    assert_eq!(snap_rows(&night), want, "the creates lie beyond the window: the snapshot answers");
    assert_eq!(snap_files(&h).len(), 1, "one snapshot file for the session, rewritten in place: {:?}", snap_files(&h));
}

/// Round 4: the snapshot was written before the tasks were finished and no rebuild ran until a burst pushed the finishing out of the tail
/// window; the bytes between the snapshot's size and the tail's start are read, so the snapshot never answers with a stale list.
#[test]
fn a_completion_in_the_gap_between_the_snapshot_and_the_tail_is_read_not_missed() {
    let h = home("snap-gap-read");
    let t = format!("{h}/t.jsonl");
    std::fs::write(&t, snap_head()).unwrap();
    snap_probe(&h);
    snap_rebuild(&h, &t, "a");
    let upd = assistant_tool("u2", "TaskUpdate", json!({"taskId": "2", "status": "completed"}), "2026-10-06T20:00:00.000Z") + &result("u2", "Updated task #2");
    append(&t, &upd);
    pad(&t, SNAP_WINDOW as usize + 200_000);
    let got = snap_rebuild(&h, &t, "b");
    assert_eq!(
        snap_rows(&got),
        vec![row("1", "first", "in_progress", "w1"), row("2", "second", "completed", ""), row("3", "third", "pending", "")],
        "the completion lies between the snapshot's size and the tail's start: the rebuild reads it, task 1 and 3 stay open from the snapshot"
    );
    assert_eq!(bumped("snapshot_gap", "result", "caught_up"), 1);
    assert_eq!(bumped("snapshot_discarded", "reason", "gap"), 0);
}

#[test]
fn a_tail_that_only_touches_one_task_keeps_the_others_and_the_fields_it_does_not_state() {
    let h = home("snap-update");
    let t = format!("{h}/t.jsonl");
    std::fs::write(&t, snap_head()).unwrap();
    snap_probe(&h);
    snap_rebuild(&h, &t, "a");
    pad(&t, SNAP_WINDOW as usize + 200_000);
    let upd = assistant_tool("u2", "TaskUpdate", json!({"taskId": "1", "status": "completed"}), "2026-10-06T20:00:00.000Z") + &result("u2", "Updated task #1");
    std::fs::OpenOptions::new().append(true).open(&t).and_then(|mut f| std::io::Write::write_all(&mut f, upd.as_bytes())).unwrap();
    let got = snap_rebuild(&h, &t, "b");
    assert_eq!(
        snap_rows(&got),
        vec![row("1", "first", "completed", "w1"), row("2", "second", "pending", ""), row("3", "third", "pending", "")],
        "the tail's status wins; the subject and owner it does not state, and the untouched tasks, come from the snapshot"
    );
    // the overlay was written back: the next rebuild after yet another burst still has it
    pad(&t, SNAP_WINDOW as usize + 200_000);
    assert_eq!(snap_rows(&snap_rebuild(&h, &t, "c")), snap_rows(&got));
}

#[test]
fn an_empty_task_list_in_the_tail_discards_the_snapshot_for_good() {
    let h = home("snap-empty");
    let t = format!("{h}/t.jsonl");
    std::fs::write(&t, snap_head()).unwrap();
    snap_probe(&h);
    snap_rebuild(&h, &t, "a");
    pad(&t, SNAP_WINDOW as usize + 200_000);
    let list = assistant_tool("l1", "TaskList", json!({}), "2026-10-06T20:00:00.000Z") + &result("l1", "No tasks found");
    std::fs::OpenOptions::new().append(true).open(&t).and_then(|mut f| std::io::Write::write_all(&mut f, list.as_bytes())).unwrap();
    let got = snap_rebuild(&h, &t, "b");
    assert!(snap_rows(&got).is_empty(), "No tasks found: the snapshot is not laid back: {got}");
    // without snapshots all of this holds too, so pin that the snapshot was there and was dropped for the reset
    assert_eq!(bumped("snapshot_discarded", "reason", "reset"), 1, "the reset discarded a snapshot that existed");
    assert!(snap_ids(&snap_doc(&h), "guard").is_empty(), "the empty list replaced the snapshot's tasks");
    pad(&t, SNAP_WINDOW as usize + 200_000);
    assert!(snap_rows(&snap_rebuild(&h, &t, "c")).is_empty(), "the empty list left the window and the old tasks did not come back");
}

#[test]
fn a_transcript_smaller_than_its_snapshot_is_another_file_and_the_snapshot_is_ignored() {
    let h = home("snap-shrunk");
    let t = format!("{h}/t.jsonl");
    std::fs::write(&t, snap_head()).unwrap();
    pad(&t, 50_000);
    snap_probe(&h);
    snap_rebuild(&h, &t, "a");
    assert_eq!(snap_ids(&snap_doc(&h), "guard"), ["1", "2", "3"], "a snapshot of the first file's list exists");
    std::fs::write(&t, snap_create(1, "other list")).unwrap();
    let got = snap_rebuild(&h, &t, "b");
    assert_eq!(snap_rows(&got), vec![row("1", "other list", "pending", "")], "only the new file's list");
    assert_eq!(bumped("snapshot_discarded", "reason", "shrunk"), 1, "the smaller file discarded a snapshot that existed");
    assert_eq!(snap_ids(&snap_doc(&h), "guard"), ["1"], "the snapshot now holds the new file's list");
}

#[test]
fn no_new_snapshot_file_is_made_once_the_cap_is_reached_and_nothing_is_deleted() {
    let h = home("snap-cap");
    let dir = format!("{h}/.anti-hall/{}", defaults::text("taskstate.snapshot_dir"));
    std::fs::create_dir_all(&dir).unwrap();
    let cap = defaults::num("taskstate.snapshot_max_files");
    for i in 0..cap {
        std::fs::write(format!("{dir}/old-{i}.json"), "{}").unwrap();
    }
    let t = format!("{h}/t.jsonl");
    std::fs::write(&t, snap_head()).unwrap();
    snap_probe(&h);
    let first = snap_rebuild(&h, &t, "a");
    assert_eq!(snap_rows(&first).len(), 3, "the rebuild itself still answers");
    assert_eq!(snap_files(&h).len() as u64, cap, "no file was added and none removed: {}", snap_files(&h).len());
    assert_eq!(bumped("snapshot_error", "kind", "cap"), 1, "the refused file is counted (the rebuild reached the snapshot code)");
    pad(&t, SNAP_WINDOW as usize + 200_000);
    assert!(snap_rows(&snap_rebuild(&h, &t, "b")).is_empty(), "with no snapshot the tail alone answers (fail-open, today's behaviour)");
}

// ---- #390 fix round: deletions, renumbering and file identity ----

#[test]
fn a_task_the_tail_found_deleted_does_not_come_back_from_the_snapshot() {
    let h = home("snap-deleted");
    let t = format!("{h}/t.jsonl");
    std::fs::write(&t, snap_head()).unwrap();
    snap_probe(&h);
    snap_rebuild(&h, &t, "a");
    pad(&t, SNAP_WINDOW as usize + 200_000);
    let get = assistant_tool("g1", "TaskGet", json!({"taskId": "1"}), "2026-10-06T20:00:00.000Z") + &result("g1", "Task #1 not found");
    let done = assistant_tool("u2", "TaskUpdate", json!({"taskId": "2", "status": "completed"}), "2026-10-06T20:01:00.000Z") + &result("u2", "Updated task #2");
    append(&t, &(get + &done));
    let got = snap_rebuild(&h, &t, "b");
    assert_eq!(
        snap_rows(&got),
        vec![row("2", "second", "completed", ""), row("3", "third", "pending", "")],
        "#1 was found not found in the tail: it is gone, the others stay"
    );
    assert!(!snap_ids(&snap_doc(&h), "guard").contains(&"1".to_string()), "the deletion was written back");
}

#[test]
fn a_task_deleted_and_made_again_in_the_tail_is_the_new_one() {
    let h = home("snap-deleted-again");
    let t = format!("{h}/t.jsonl");
    std::fs::write(&t, snap_head()).unwrap();
    snap_probe(&h);
    snap_rebuild(&h, &t, "a");
    pad(&t, SNAP_WINDOW as usize + 200_000);
    let get = assistant_tool("g1", "TaskGet", json!({"taskId": "3"}), "2026-10-06T20:00:00.000Z") + &result("g1", "Task #3 not found");
    let upd = assistant_tool("u3", "TaskUpdate", json!({"taskId": "3", "status": "in_progress", "subject": "third again"}), "2026-10-06T20:01:00.000Z");
    append(&t, &(get + &upd));
    let got = snap_rows(&snap_rebuild(&h, &t, "b"));
    assert!(got.iter().any(|r| r.0 == "3" && r.2 == "in_progress"), "what the tail states after the deletion is listed: {got:?}");
}

#[test]
fn a_new_list_numbered_from_one_again_after_the_snapshot_replaces_it() {
    let h = home("snap-renumber");
    let t = format!("{h}/t.jsonl");
    std::fs::write(&t, snap_head()).unwrap();
    snap_probe(&h);
    snap_rebuild(&h, &t, "a");
    pad(&t, 1_700_000);
    let done = assistant_tool("u9", "TaskUpdate", json!({"taskId": "1", "status": "completed"}), "2026-10-06T20:01:00.000Z");
    append(&t, &(snap_create(1, "fresh list") + &done));
    let got = snap_rebuild(&h, &t, "b");
    assert_eq!(snap_rows(&got), vec![row("1", "fresh list", "completed", "")], "the old #2 and #3 belong to the list this one replaced");
    assert_eq!(bumped("snapshot_discarded", "reason", "renumbered"), 1);
    assert_eq!(snap_ids(&snap_doc(&h), "guard"), ["1"], "the snapshot now holds the new list");
}

#[test]
fn creates_the_snapshot_already_saw_in_an_overlapping_tail_are_not_a_new_list() {
    let h = home("snap-overlap");
    let t = format!("{h}/t.jsonl");
    std::fs::write(&t, snap_create(1, "first")).unwrap();
    pad(&t, 500_000);
    append(&t, &snap_create(2, "second"));
    snap_probe(&h);
    snap_rebuild(&h, &t, "a");
    assert_eq!(snap_ids(&snap_doc(&h), "guard"), ["1", "2"]);
    pad(&t, 700_000); // #1 left the tail window, #2 is still inside it and was already in the snapshot
    let got = snap_rows(&snap_rebuild(&h, &t, "b"));
    assert_eq!(got.iter().map(|r| r.0.as_str()).collect::<Vec<_>>(), ["1", "2"], "the re-seen create of #2 does not drop #1: {got:?}");
    assert_eq!(bumped("snapshot_discarded", "reason", "renumbered"), 0);
}

/// `size` bytes of non-task lines, exactly.
fn filler(size: usize, ch: char) -> String {
    let base = line(json!({"type": "assistant", "message": {"role": "assistant", "content": [{"type": "text", "text": ""}]}}));
    let body =
        line(json!({"type": "assistant", "message": {"role": "assistant", "content": [{"type": "text", "text": ch.to_string().repeat(size - base.len())}]}}));
    assert_eq!(body.len(), size);
    body
}

#[test]
fn another_session_on_the_same_path_does_not_inherit_the_snapshot() {
    let h = home("snap-session");
    let t = format!("{h}/t.jsonl");
    let old = snap_head() + &filler(20_000, 'x');
    std::fs::write(&t, &old).unwrap();
    snap_probe(&h);
    assert_eq!(snap_rows(&snap_rebuild_as(&h, &t, "a", "sess-old")).len(), 3);
    assert_eq!(snap_doc(&h)["session"], json!("sess-old"), "the snapshot names its session");
    std::fs::write(&t, filler(old.len(), 'y')).unwrap(); // the same path, the same size, another conversation
    let got = snap_rebuild_as(&h, &t, "b", "sess-new");
    assert!(snap_rows(&got).is_empty(), "the old session's tasks are not this session's: {got}");
    assert_eq!(bumped("snapshot_discarded", "reason", "session"), 1);
}

#[test]
fn the_same_session_on_a_replaced_file_of_the_same_size_does_not_inherit_the_snapshot() {
    let h = home("snap-replaced");
    let t = format!("{h}/t.jsonl");
    let old = snap_head() + &filler(20_000, 'x');
    std::fs::write(&t, &old).unwrap();
    snap_probe(&h);
    assert_eq!(snap_rows(&snap_rebuild_as(&h, &t, "a", "sess")).len(), 3);
    std::fs::write(&t, filler(old.len(), 'y')).unwrap();
    let got = snap_rebuild_as(&h, &t, "b", "sess");
    assert!(snap_rows(&got).is_empty(), "the file under the path is another generation: {got}");
    assert_eq!(bumped("snapshot_discarded", "reason", "replaced"), 1);
}

#[test]
fn a_file_that_keeps_its_first_bytes_but_changes_before_the_tail_window_is_another_generation() {
    let h = home("snap-replaced-mid");
    let t = format!("{h}/t.jsonl");
    std::fs::write(&t, snap_head()).unwrap();
    pad(&t, 900_000);
    snap_probe(&h);
    assert_eq!(snap_rows(&snap_rebuild_as(&h, &t, "a", "sess")).len(), 3);
    pad(&t, 700_000); // the file grows by more than snapshot_refresh_bytes: the snapshot is rewritten for the larger file
    assert_eq!(snap_rows(&snap_rebuild_as(&h, &t, "b", "sess")).len(), 3, "the same file, grown: still its snapshot");
    assert_eq!(bumped("snapshot_discarded", "reason", "replaced"), 0);
    let mut bytes = std::fs::read(&t).unwrap();
    let keep = 2 * defaults::num("taskstate.snapshot_fingerprint_bytes") as usize + 4096;
    for b in bytes.iter_mut().skip(keep) {
        if *b == b'x' {
            *b = b'z';
        }
    }
    std::fs::write(&t, &bytes).unwrap(); // same size, same start, other text before the window
    let got = snap_rebuild_as(&h, &t, "c", "sess");
    assert!(snap_rows(&got).is_empty(), "the bytes before the tail window changed: {got}");
    assert_eq!(bumped("snapshot_discarded", "reason", "replaced"), 1);
}

// ---- #390 fix round: a damaged or unwritable snapshot never changes the answer ----

#[test]
fn a_snapshot_with_a_malformed_task_is_ignored_and_repaired() {
    for (tag, bad) in [("null", json!(null)), ("number", json!(17)), ("no-id", json!({"status": "pending"})), ("status", json!({"id": "1", "status": 7}))] {
        let h = home(&format!("snap-malformed-{tag}"));
        let t = format!("{h}/t.jsonl");
        std::fs::write(&t, snap_head()).unwrap();
        snap_probe(&h);
        snap_rebuild(&h, &t, "a");
        let dir = format!("{h}/.anti-hall/{}", defaults::text("taskstate.snapshot_dir"));
        let file = format!("{dir}/{}", snap_files(&h)[0]);
        let mut doc = snap_doc(&h);
        doc["variants"]["guard"]["tasks"] = json!([bad]);
        std::fs::write(&file, doc.to_string()).unwrap();
        let got = snap_rebuild(&h, &t, "b");
        assert_eq!(snap_rows(&got).len(), 3, "{tag}: the tail alone answers, nothing is thrown: {got}");
        assert_eq!(snap_ids(&snap_doc(&h), "guard"), ["1", "2", "3"], "{tag}: the damaged section was overwritten with the rebuilt list");
    }
}

#[test]
#[cfg(unix)]
fn a_snapshot_that_cannot_be_written_leaves_the_tail_alone_as_the_answer() {
    use std::os::unix::fs::PermissionsExt;
    let h = home("snap-unwritable");
    let t = format!("{h}/t.jsonl");
    std::fs::write(&t, snap_head()).unwrap();
    snap_probe(&h);
    snap_rebuild(&h, &t, "a");
    pad(&t, SNAP_WINDOW as usize + 200_000);
    let upd = assistant_tool("u2", "TaskUpdate", json!({"taskId": "2", "status": "completed"}), "2026-10-06T20:00:00.000Z") + &result("u2", "Updated task #2");
    append(&t, &upd);
    let dir = format!("{h}/.anti-hall/{}", defaults::text("taskstate.snapshot_dir"));
    std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o555)).unwrap();
    let got = snap_rebuild(&h, &t, "b");
    std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o755)).unwrap();
    let ids: Vec<String> = snap_rows(&got).into_iter().map(|r| r.0).collect();
    assert_eq!(ids, ["2"], "the write failed, so the answer is the tail's alone, as the switch-off path gives it: {got}");
    assert_eq!(bumped("snapshot_error", "kind", "write"), 1);
}

#[test]
fn the_guard_and_state_variants_do_not_lose_each_others_section() {
    let h = home("snap-race");
    let t = format!("{h}/t.jsonl");
    std::fs::write(&t, snap_head()).unwrap();
    // the guard variant reads the snapshot; before it writes, the state variant files its own section (what a concurrent hook does)
    put_override(
        &h,
        "zz-snap-race",
        "function decide(p){ var inner = false, read = ah.state.readText; \
         ah.state.readText = function (rel) { var raw = read(rel); if (!inner && p.race) { inner = true; ah.transcript.tasks(p.t, 'state', p.w, 0, ''); } return raw; }; \
         ah.transcript.tasks(p.t, 'guard', p.w, 0, ''); ah.state.readText = read; return 'allow'; }",
    );
    let go = |race: bool| assert_eq!(run("zz-snap-race", &json!({"t": t, "w": SNAP_WINDOW, "race": race}), &env(&h)), Some(Some(Verdict::Allow)));
    go(false);
    assert_eq!(snap_ids(&snap_doc(&h), "guard"), ["1", "2", "3"], "the guard section is there");
    append(
        &t,
        &(assistant_tool("u2", "TaskUpdate", json!({"taskId": "2", "status": "completed"}), "2026-10-06T20:00:00.000Z") + &result("u2", "Updated task #2")),
    );
    go(true);
    let doc = snap_doc(&h);
    assert_eq!(snap_ids(&doc, "guard"), ["1", "2", "3"], "the guard section is current");
    assert_eq!(snap_ids(&doc, "state"), ["1", "2", "3"], "the state section filed during the guard's read survived the guard's write: {doc}");
}

// ---- #390 fix round 3: a task's identity is the tool-use id of its TaskCreate, never its subject ----

/// A `TaskCreate` of task `n` under the tool-use id `use_id` (a number that is made again by a new list gets another id).
fn snap_create_as(n: u32, subject: &str, use_id: &str) -> String {
    assistant_tool(use_id, "TaskCreate", json!({"subject": subject, "description": format!("why {n}")}), "2026-10-06T12:00:00.000Z")
        + &result(use_id, &format!("Task #{n} created successfully: {subject}"))
}

fn snap_update(use_id: &str, input: Value) -> String {
    assistant_tool(use_id, "TaskUpdate", input, "2026-10-06T12:05:00.000Z") + &result(use_id, "Updated task")
}

/// The ids the snapshot recorded for a variant: `{task number: tool-use id}`.
fn snap_created_ids(doc: &Value, variant: &str) -> Value {
    doc["variants"][variant]["ids"].clone()
}

#[test]
fn renaming_a_task_created_inside_an_overlapping_tail_does_not_drop_the_older_pending_task() {
    // reviewer P1-A: the snapshot holds pending #1; the tail creates #2, renames it and completes it. A rename is not a new list.
    let h = home("snap-id-rename-create");
    let t = format!("{h}/t.jsonl");
    std::fs::write(&t, snap_create(1, "genuine open task 1")).unwrap();
    pad(&t, 800_000);
    snap_probe(&h);
    snap_rebuild(&h, &t, "a");
    append(&t, &snap_create(2, "original task 2"));
    snap_rebuild(&h, &t, "b");
    assert_eq!(snap_ids(&snap_doc(&h), "guard"), ["1", "2"]);
    pad(&t, 600_000); // #1's create left the tail window; #2's create (after the snapshot's #1) is still inside it
    append(&t, &(snap_update("r2", json!({"taskId": "2", "subject": "renamed task 2"})) + &snap_update("d2", json!({"taskId": "2", "status": "completed"}))));
    let got = snap_rows(&snap_rebuild(&h, &t, "c"));
    assert_eq!(got, vec![row("1", "genuine open task 1", "pending", ""), row("2", "renamed task 2", "completed", "")], "the pending #1 is still listed");
    assert_eq!(bumped("snapshot_discarded", "reason", "renumbered"), 0);
    assert_eq!(snap_created_ids(&snap_doc(&h), "guard"), json!({"1": "c1", "2": "c2"}), "the identities are the create tool-use ids");
}

#[test]
fn a_rename_of_a_snapshot_task_inside_an_overlapping_tail_is_not_a_new_list() {
    let h = home("snap-id-rename-snapshot-task");
    let t = format!("{h}/t.jsonl");
    std::fs::write(&t, snap_create(1, "first")).unwrap();
    pad(&t, 500_000);
    append(&t, &snap_create(2, "original second"));
    snap_probe(&h);
    snap_rebuild(&h, &t, "a");
    append(&t, &snap_update("r2", json!({"taskId": "2", "subject": "renamed second"})));
    pad(&t, 700_000); // #2's create and its rename are inside the tail, #1's create is not
    let got = snap_rows(&snap_rebuild(&h, &t, "b"));
    assert_eq!(got, vec![row("1", "first", "pending", ""), row("2", "renamed second", "pending", "")], "{got:?}");
    assert_eq!(bumped("snapshot_discarded", "reason", "renumbered"), 0);
}

#[test]
fn a_new_task_one_with_the_same_subject_as_the_old_one_is_a_new_list_and_drops_the_obsolete_tasks() {
    // reviewer P1-B: equal subjects defeated the old rule; the tool-use id tells the new #1 from the one the snapshot holds.
    let h = home("snap-id-same-subject");
    let t = format!("{h}/t.jsonl");
    std::fs::write(&t, snap_create(1, "same") + &snap_create(2, "obsolete task 2")).unwrap();
    pad(&t, 800_000);
    snap_probe(&h);
    snap_rebuild(&h, &t, "a");
    assert_eq!(snap_ids(&snap_doc(&h), "guard"), ["1", "2"]);
    pad(&t, 500_000); // the old creates left the window; the snapshot (800 KB) still overlaps it
    append(&t, &(snap_create_as(1, "same", "new-c1") + &snap_update("d1", json!({"taskId": "1", "status": "completed"}))));
    let got = snap_rows(&snap_rebuild(&h, &t, "b"));
    assert_eq!(got, vec![row("1", "same", "completed", "")], "the obsolete #2 belongs to the list the new #1 replaced: {got:?}");
    assert_eq!(bumped("snapshot_discarded", "reason", "renumbered"), 1);
    assert_eq!(snap_created_ids(&snap_doc(&h), "guard"), json!({"1": "new-c1"}));
}

#[test]
fn the_same_create_seen_in_two_overlapping_tails_is_never_a_new_list() {
    let h = home("snap-id-seen-twice");
    let t = format!("{h}/t.jsonl");
    std::fs::write(&t, snap_create(1, "first")).unwrap();
    pad(&t, 500_000);
    append(&t, &snap_create(2, "second"));
    snap_probe(&h);
    snap_rebuild(&h, &t, "a");
    pad(&t, 400_000);
    let b = snap_rows(&snap_rebuild(&h, &t, "b"));
    pad(&t, 400_000); // #2's create is inside every tail from here on; #1's left the window
    let c = snap_rows(&snap_rebuild(&h, &t, "c"));
    for (tag, got) in [("b", b), ("c", c)] {
        assert_eq!(got.iter().map(|r| r.0.as_str()).collect::<Vec<_>>(), ["1", "2"], "{tag}: {got:?}");
    }
    assert_eq!(bumped("snapshot_discarded", "reason", "renumbered"), 0);
    assert_eq!(crate::metrics::bumped_on_this_thread("snapshot_identity_unknown", &[]), 0);
}

#[test]
fn a_create_the_tail_cannot_name_leaves_the_snapshot_alone() {
    // a TaskCreate line with no tool-use id makes no task in the rebuild: nothing says a new list began
    let h = home("snap-id-create-without-id");
    let t = format!("{h}/t.jsonl");
    std::fs::write(&t, snap_create(1, "first") + &snap_create(2, "second")).unwrap();
    pad(&t, 800_000);
    snap_probe(&h);
    snap_rebuild(&h, &t, "a");
    pad(&t, 500_000);
    append(
        &t,
        &(line(
            json!({"type": "assistant", "message": {"role": "assistant", "content": [{"type": "tool_use", "name": "TaskCreate", "input": {"subject": "first"}}]}}),
        ) + &result("nobody", "Task #1 created successfully: first")),
    );
    let got = snap_rows(&snap_rebuild(&h, &t, "b"));
    assert_eq!(got.iter().map(|r| r.0.as_str()).collect::<Vec<_>>(), ["1", "2"], "{got:?}");
    assert_eq!(bumped("snapshot_discarded", "reason", "renumbered"), 0);
}

#[test]
fn a_snapshot_task_with_no_recorded_create_cannot_be_told_from_a_new_one_and_the_snapshot_is_kept_and_counted() {
    let h = home("snap-id-unrecorded");
    let t = format!("{h}/t.jsonl");
    std::fs::write(&t, snap_create(1, "first") + &snap_create(2, "second")).unwrap();
    pad(&t, 800_000);
    snap_probe(&h);
    snap_rebuild(&h, &t, "a");
    let file = format!("{h}/.anti-hall/{}/{}", defaults::text("taskstate.snapshot_dir"), snap_files(&h)[0]);
    let mut doc = snap_doc(&h);
    doc["variants"]["guard"].as_object_mut().unwrap().remove("ids");
    std::fs::write(&file, doc.to_string()).unwrap();
    pad(&t, 500_000);
    append(&t, &snap_create_as(1, "first", "someone-else"));
    let got = snap_rows(&snap_rebuild(&h, &t, "b"));
    assert_eq!(got.iter().map(|r| r.0.as_str()).collect::<Vec<_>>(), ["1", "2"], "the snapshot's #2 is kept: {got:?}");
    assert_eq!(bumped("snapshot_discarded", "reason", "renumbered"), 0);
    assert_eq!(crate::metrics::bumped_on_this_thread("snapshot_identity_unknown", &[]), 1, "fail-open to the snapshot is counted");
    assert_eq!(snap_created_ids(&snap_doc(&h), "guard"), json!({"1": "someone-else"}), "the id the tail names is recorded");
}

#[test]
fn a_list_made_by_todowrite_has_no_create_ids_and_is_still_kept_and_still_replaced_by_a_new_list() {
    let h = home("snap-id-todowrite");
    let t = format!("{h}/t.jsonl");
    let todos = json!({"todos": [{"id": "1", "content": "alpha", "status": "pending"}, {"id": "2", "content": "beta", "status": "in_progress"}]});
    std::fs::write(&t, assistant_tool("tw", "TodoWrite", todos, "2026-10-06T12:00:00.000Z")).unwrap();
    snap_probe(&h);
    let first = snap_rows(&snap_rebuild(&h, &t, "a"));
    assert_eq!(first.len(), 2, "{first:?}");
    pad(&t, 1_700_000);
    let night = snap_rows(&snap_rebuild(&h, &t, "b"));
    assert_eq!(night, first, "the todo list left the tail window: the snapshot answers");
    assert_eq!(snap_created_ids(&snap_doc(&h), "guard"), json!({}), "no TaskCreate made them");
    pad(&t, 1_100_000); // the tail now starts past the snapshot's bytes, so a create in it is certainly a later one
    append(&t, &snap_create(1, "fresh list"));
    let got = snap_rows(&snap_rebuild(&h, &t, "c"));
    assert_eq!(got, vec![row("1", "fresh list", "pending", "")], "a create after the snapshot's bytes is a new list");
    assert_eq!(bumped("snapshot_discarded", "reason", "renumbered"), 1);
}

#[test]
fn a_snapshot_over_the_size_cap_is_a_damaged_file_and_is_replaced_even_when_its_tasks_are_unchanged() {
    let h = home("snap-oversize");
    let t = format!("{h}/t.jsonl");
    std::fs::write(&t, snap_head()).unwrap();
    snap_probe(&h);
    snap_rebuild(&h, &t, "a");
    let file = format!("{h}/.anti-hall/{}/{}", defaults::text("taskstate.snapshot_dir"), snap_files(&h)[0]);
    let mut doc = snap_doc(&h);
    let mut tasks = doc["variants"]["guard"]["tasks"].as_array().unwrap().clone();
    for i in 4..2504 {
        tasks.push(json!({"id": i.to_string(), "content": format!("stale task {i} {}", "x".repeat(120)), "description": "", "status": "pending", "owner": "", "blockedBy": [], "priority": null, "subjectUpdated": false, "unknown": null, "blockUnknown": false, "sinceMs": null}));
    }
    doc["variants"]["guard"]["tasks"] = json!(tasks);
    let big = doc.to_string();
    assert!(big.len() > defaults::num("taskstate.snapshot_max_bytes") as usize, "the file is over the cap: {}", big.len());
    std::fs::write(&file, big).unwrap();
    let got = snap_rebuild(&h, &t, "b");
    assert_eq!(snap_rows(&got).len(), 3, "the oversized snapshot lays nothing over the tail: {}", snap_rows(&got).len());
    assert_eq!(bumped("snapshot_error", "kind", "big"), 1);
    assert_eq!(snap_ids(&snap_doc(&h), "guard"), ["1", "2", "3"], "the file was replaced by the rebuilt list");
    assert!(std::fs::metadata(&file).unwrap().len() <= defaults::num("taskstate.snapshot_max_bytes"));
}

#[test]
fn a_rebuild_that_cannot_take_the_snapshot_lock_writes_nothing_and_answers_as_before() {
    let h = home("snap-lock-busy");
    let t = format!("{h}/t.jsonl");
    std::fs::write(&t, snap_head()).unwrap();
    std::fs::write(format!("{h}/.anti-hall/settings.json"), r#"{"taskstate":{"snapshot_lock_kind":"file"}}"#).unwrap(); // the kill switch: the lock file
    put_override(
        &h,
        "zz-snap-lock",
        "function decide(p){ var lk = ah.state.lock(taskSnap.rel(p.t) + ah.cfg('taskstate.snapshot_lock_suffix'), ah.cfg('taskstate.snapshot_lock_group'), 5); \
         var r = ah.transcript.tasks(p.t, 'guard', p.w, 0, ''); ah.state.unlock(lk); \
         ah.state.writeAtomic('.anti-hall/out-lock.json', JSON.stringify({held: lk !== null, n: r.tasks.length})); return 'allow'; }",
    );
    assert_eq!(run("zz-snap-lock", &json!({"t": t, "w": SNAP_WINDOW}), &env(&h)), Some(Some(Verdict::Allow)));
    let out: Value = serde_json::from_str(&std::fs::read_to_string(format!("{h}/.anti-hall/out-lock.json")).unwrap()).unwrap();
    assert_eq!(out, json!({"held": true, "n": 3}), "the rebuild still answers");
    assert_eq!(bumped("snapshot_error", "kind", "lock"), 1, "the busy lock is counted");
    assert!(snap_files(&h).is_empty(), "no snapshot was written under a lock held by another: {:?}", snap_all(&h));
    snap_probe(&h);
    snap_rebuild(&h, &t, "free");
    assert_eq!(snap_ids(&snap_doc(&h), "guard"), ["1", "2", "3"], "the next rebuild writes");
    assert_eq!(snap_all(&h).iter().filter(|f| f.ends_with(".lock")).count(), 0, "a released lock leaves no file: {:?}", snap_all(&h));
}

// ---- #407: the snapshot lock is a kernel flock ----

/// A script that rebuilds the `p.v` variant of the list of `p.t`.
fn snap_probe_variant(h: &str) {
    put_override(h, "zz-snapv", "function decide(p){ ah.transcript.tasks(p.t, p.v, p.w, 0, ''); return 'allow'; }");
}

/// The snapshot path (relative to the home) and the flock file path (absolute) of a transcript.
fn snap_flock_path(h: &str, t: &str) -> String {
    put_override(h, "zz-snaprel", "function decide(p){ ah.state.writeAtomic('.anti-hall/out-rel.json', JSON.stringify(taskSnap.rel(p.t))); return 'allow'; }");
    assert_eq!(run("zz-snaprel", &json!({"t": t}), &env(h)), Some(Some(Verdict::Allow)));
    let rel: String = serde_json::from_str(&std::fs::read_to_string(format!("{h}/.anti-hall/out-rel.json")).unwrap()).unwrap();
    format!("{h}/{rel}{}", defaults::text("taskstate.snapshot_flock_suffix"))
}

/// A child process that holds the exclusive flock of `path` until it is killed.
fn flock_holder(path: &str) -> std::process::Child {
    use std::io::BufRead;
    let mut c = std::process::Command::new("python3")
        .args(["-c", "import fcntl,sys,time\nf=open(sys.argv[1],'a')\nfcntl.flock(f,fcntl.LOCK_EX)\nprint('held',flush=True)\ntime.sleep(600)", path])
        .stdout(std::process::Stdio::piped())
        .spawn()
        .expect("python3 to hold the lock");
    let mut got = String::new();
    std::io::BufReader::new(c.stdout.as_mut().unwrap()).read_line(&mut got).unwrap();
    assert_eq!(got.trim(), "held");
    c
}

#[test]
fn the_snapshot_lock_is_a_flock_that_leaves_one_persistent_file_and_is_counted() {
    let h = home("snap-flock-take");
    let t = format!("{h}/t.jsonl");
    std::fs::write(&t, snap_head()).unwrap();
    snap_probe(&h);
    snap_rebuild(&h, &t, "a");
    assert_eq!(snap_ids(&snap_doc(&h), "guard"), ["1", "2", "3"]);
    let all = snap_all(&h);
    assert_eq!(all.len(), 2, "the snapshot and its flock file, nothing else: {all:?}");
    assert!(all.iter().any(|f| f.ends_with(&defaults::text("taskstate.snapshot_flock_suffix"))), "{all:?}");
    assert!(all.iter().all(|f| !f.ends_with(&defaults::text("taskstate.snapshot_lock_suffix"))), "no Node lock file: {all:?}");
    assert_eq!(std::fs::metadata(snap_flock_path(&h, &t)).unwrap().len(), 0, "the lock file is never written");
    assert_eq!(crate::metrics::bumped_on_this_thread("snapshot_lock", &[("kind", "flock"), ("result", "taken")]), 1);
    assert_eq!(crate::metrics::bumped_on_this_thread("snapshot_lock", &[("kind", "file"), ("result", "taken")]), 0);
}

#[test]
fn a_rebuild_whose_flock_is_held_in_this_process_writes_nothing_counts_busy_and_still_answers() {
    let h = home("snap-flock-busy");
    let t = format!("{h}/t.jsonl");
    std::fs::write(&t, snap_head()).unwrap();
    put_override(
        &h,
        "zz-flock-busy",
        "function decide(p){ var lk = ah.state.flock(taskSnap.rel(p.t) + ah.cfg('taskstate.snapshot_flock_suffix'), ah.cfg('taskstate.snapshot_lock_group'), 5); \
         var r = ah.transcript.tasks(p.t, 'guard', p.w, 0, ''); ah.state.unlock(lk); \
         ah.state.writeAtomic('.anti-hall/out-lock.json', JSON.stringify({held: typeof lk === 'number', n: r.tasks.length})); return 'allow'; }",
    );
    assert_eq!(run("zz-flock-busy", &json!({"t": t, "w": SNAP_WINDOW}), &env(&h)), Some(Some(Verdict::Allow)));
    let out: Value = serde_json::from_str(&std::fs::read_to_string(format!("{h}/.anti-hall/out-lock.json")).unwrap()).unwrap();
    assert_eq!(out, json!({"held": true, "n": 3}));
    assert_eq!(bumped("snapshot_error", "kind", "lock"), 1);
    assert_eq!(crate::metrics::bumped_on_this_thread("snapshot_lock", &[("kind", "flock"), ("result", "busy")]), 1);
    assert!(snap_files(&h).is_empty(), "nothing written under a held lock: {:?}", snap_all(&h));
    snap_probe(&h);
    snap_rebuild(&h, &t, "free");
    assert_eq!(snap_ids(&snap_doc(&h), "guard"), ["1", "2", "3"], "the unlock freed it: the next rebuild writes");
}

#[test]
fn a_flock_held_by_another_process_blocks_the_write_and_a_killed_holder_frees_it_at_once() {
    let h = home("snap-flock-proc");
    let t = format!("{h}/t.jsonl");
    std::fs::write(&t, snap_head()).unwrap();
    snap_probe(&h);
    let lockfile = snap_flock_path(&h, &t);
    std::fs::create_dir_all(std::path::Path::new(&lockfile).parent().unwrap()).unwrap();
    let mut holder = flock_holder(&lockfile);
    let got = snap_rebuild(&h, &t, "busy");
    assert_eq!(snap_rows(&got).len(), 3, "the rebuild still answers");
    assert_eq!(bumped("snapshot_error", "kind", "lock"), 1);
    assert!(snap_files(&h).is_empty(), "{:?}", snap_all(&h));
    holder.kill().unwrap();
    holder.wait().unwrap();
    let started = std::time::Instant::now();
    snap_rebuild(&h, &t, "freed");
    let waited = started.elapsed();
    assert_eq!(snap_ids(&snap_doc(&h), "guard"), ["1", "2", "3"], "the dead holder's lock is gone with it: no stale wait");
    assert!(waited < std::time::Duration::from_millis(defaults::num("taskstate.snapshot_lock_wait_ms")), "no wait for a dead holder: {waited:?}");
}

/// The body of the child processes of the concurrency test: rebuild every transcript as the variant named in `AH_T_CHILD`.
fn flock_child_work(h: &str, variant: &str) {
    for i in 0..CONCURRENT_FILES {
        let t = format!("{h}/t{i}.jsonl");
        let r = run("zz-snapv", &json!({"t": t, "v": variant, "w": SNAP_WINDOW}), &env(h));
        assert_eq!(r, Some(Some(Verdict::Allow)));
    }
}

const CONCURRENT_FILES: usize = 12;

#[test]
fn concurrent_creates_from_threads_and_processes_lose_no_section() {
    if let Ok(spec) = std::env::var("AH_T_CHILD") {
        let (h, v) = spec.split_once('|').unwrap();
        flock_child_work(h, v);
        std::fs::write(format!("{h}/child-{}.done", std::process::id()), "").unwrap(); // proof the child ran the work, not zero tests
        return;
    }
    let h = home("snap-flock-conc");
    for i in 0..CONCURRENT_FILES {
        std::fs::write(format!("{h}/t{i}.jsonl"), snap_head()).unwrap();
    }
    snap_probe_variant(&h);
    let exe = std::env::current_exe().unwrap();
    let mut kids: Vec<std::process::Child> = ["guard", "state", "guard", "state"]
        .iter()
        .map(|v| {
            std::process::Command::new(&exe)
                .args(["--exact", "script::tests_host_d::concurrent_creates_from_threads_and_processes_lose_no_section", "--nocapture", "--test-threads=1"])
                .env("AH_T_CHILD", format!("{h}|{v}"))
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .spawn()
                .unwrap()
        })
        .collect();
    let threads: Vec<_> = ["guard", "state", "guard", "state"]
        .iter()
        .map(|v| {
            let (h, v) = (h.clone(), v.to_string());
            std::thread::spawn(move || flock_child_work(&h, &v))
        })
        .collect();
    for th in threads {
        th.join().unwrap();
    }
    for k in &mut kids {
        assert!(k.wait().unwrap().success());
    }
    let done = std::fs::read_dir(&h).unwrap().flatten().filter(|e| e.file_name().to_string_lossy().ends_with(".done")).count();
    assert_eq!(done, 4, "all four child processes ran the work");
    let files = snap_files(&h);
    assert_eq!(files.len(), CONCURRENT_FILES, "{files:?}");
    for f in &files {
        let p = format!("{h}/.anti-hall/{}/{f}", defaults::text("taskstate.snapshot_dir"));
        let doc: Value = serde_json::from_str(&std::fs::read_to_string(&p).unwrap()).expect("every snapshot is whole, valid JSON");
        for v in ["guard", "state"] {
            assert_eq!(snap_ids(&doc, v), ["1", "2", "3"], "{f} lost its {v} section");
        }
    }
}

#[test]
fn crash_leftovers_and_legacy_lock_files_beside_the_snapshot_change_nothing_and_are_not_counted_against_the_cap() {
    let h = home("snap-flock-left");
    let t = format!("{h}/t.jsonl");
    std::fs::write(&t, snap_head()).unwrap();
    snap_probe(&h);
    let flock = snap_flock_path(&h, &t);
    let dir = std::path::Path::new(&flock).parent().unwrap().to_path_buf();
    std::fs::create_dir_all(&dir).unwrap();
    // a snapshot cap's worth of files minus two (the crash's temporary file below still counts, as it always did), a legacy lock with an owner record, and an empty flock file from an earlier run
    let cap = defaults::num("taskstate.snapshot_max_files");
    for i in 0..cap - 2 {
        std::fs::write(dir.join(format!("old-{i}.json")), "{}").unwrap();
    }
    let base = flock.trim_end_matches(&defaults::text("taskstate.snapshot_flock_suffix")).to_string();
    std::fs::write(format!("{base}{}", defaults::text("taskstate.snapshot_lock_suffix")), r#"{"pid":1,"host":"gone","token":"x"}"#).unwrap();
    std::fs::write(&flock, "").unwrap();
    std::fs::write(format!("{base}.tmp{}", defaults::text("atomic.tmp_suffix")), "{\"cut").unwrap();
    std::fs::write(dir.join("zz-other.flock"), "").unwrap();
    let got = snap_rebuild(&h, &t, "a");
    assert_eq!(snap_rows(&got).len(), 3);
    assert_eq!(bumped("snapshot_error", "kind", "cap"), 0, "lock files are no snapshots");
    assert_eq!(bumped("snapshot_error", "kind", "lock"), 0);
    let doc: Value = serde_json::from_str(&std::fs::read_to_string(&base).unwrap()).unwrap();
    assert_eq!(snap_ids(&doc, "guard"), ["1", "2", "3"]);
    assert!(std::path::Path::new(&format!("{base}{}", defaults::text("taskstate.snapshot_lock_suffix"))).exists(), "the legacy lock file is left alone");
}

#[test]
fn seeded_bad_snapshots_are_replaced_under_the_flock() {
    for (tag, seed) in [
        ("corrupt", "{not json".to_string()),
        ("format", json!({"format": 99, "variants": {}}).to_string()),
        ("session", json!({"format": 1, "session": "someone-else", "path": "/elsewhere", "variants": {}}).to_string()),
    ] {
        let h = home(&format!("snap-flock-bad-{tag}"));
        let t = format!("{h}/t.jsonl");
        std::fs::write(&t, snap_head()).unwrap();
        snap_probe(&h);
        let flock = snap_flock_path(&h, &t);
        let base = flock.trim_end_matches(&defaults::text("taskstate.snapshot_flock_suffix")).to_string();
        std::fs::create_dir_all(std::path::Path::new(&base).parent().unwrap()).unwrap();
        std::fs::write(&base, seed).unwrap();
        let got = snap_rebuild(&h, &t, "a");
        assert_eq!(snap_rows(&got).len(), 3, "{tag}: the tail answers");
        assert_eq!(snap_ids(&snap_doc(&h), "guard"), ["1", "2", "3"], "{tag}: the bad file was replaced");
    }
}

#[test]
fn an_unwritable_snapshot_directory_falls_back_to_the_lock_file_and_the_failed_write_is_counted() {
    use std::os::unix::fs::PermissionsExt;
    // SAFETY: geteuid takes no arguments and cannot fail.
    if unsafe { libc::geteuid() } == 0 {
        return; // root writes anywhere
    }
    let h = home("snap-flock-ro");
    let t = format!("{h}/t.jsonl");
    std::fs::write(&t, snap_head()).unwrap();
    snap_probe(&h);
    let flock = snap_flock_path(&h, &t);
    let dir = std::path::Path::new(&flock).parent().unwrap().to_path_buf();
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o555)).unwrap();
    let got = snap_rebuild(&h, &t, "a");
    std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o755)).unwrap();
    assert_eq!(snap_rows(&got).len(), 3, "the rebuild still answers");
    assert_eq!(crate::metrics::bumped_on_this_thread("snapshot_lock", &[("kind", "fallback"), ("result", "null")]), 1);
    assert_eq!(bumped("snapshot_error", "kind", "write"), 1);
    assert!(snap_all(&h).is_empty(), "{:?}", snap_all(&h));
}

#[test]
fn the_kill_switch_restores_the_lock_file_protocol_and_leaves_no_flock_file() {
    let h = home("snap-flock-off");
    std::fs::write(format!("{h}/.anti-hall/settings.json"), r#"{"taskstate":{"snapshot_lock_kind":"file"}}"#).unwrap();
    let t = format!("{h}/t.jsonl");
    std::fs::write(&t, snap_head()).unwrap();
    snap_probe(&h);
    snap_rebuild(&h, &t, "a");
    assert_eq!(snap_ids(&snap_doc(&h), "guard"), ["1", "2", "3"]);
    assert_eq!(snap_all(&h).len(), 1, "no flock file and the released Node lock is gone: {:?}", snap_all(&h));
    assert_eq!(crate::metrics::bumped_on_this_thread("snapshot_lock", &[("kind", "file"), ("result", "taken")]), 1);
}

/// Installs the owner's file layers for a test and removes them on drop (the overlay is process-wide: nextest runs each test in its own
/// process, and the guard keeps a failing assertion from leaking the override into whatever runs next in this one).
struct Overlay;

impl Overlay {
    fn set(values: &[(&str, Value)]) -> Overlay {
        defaults::set_overlay(values);
        Overlay
    }
}

impl Drop for Overlay {
    fn drop(&mut self) {
        defaults::set_overlay(&[]);
    }
}

/// #390 round 5: `ah.cfg` is the shipped value for every logic read (about 3,000 calls rely on that); only `ah.cfgLive` is the owner's
/// layers. The task snapshot's switch is a documented setting and is read through `cfgLive`; nothing else changed meaning.
#[test]
fn ah_cfg_stays_the_shipped_value_whatever_the_owner_sets_and_cfg_live_is_the_owners_layers() {
    let h = home("cfg-scope");
    std::fs::write(format!("{h}/.anti-hall/settings.json"), r#"{"taskstate":{"snapshot_enabled":false}}"#).unwrap();
    put_override(
        &h,
        "zz-cfg-scope",
        "function decide(p){ ah.state.writeAtomic('.anti-hall/out-cfg.json', JSON.stringify({ \
         heavy: ah.cfg('command.heavy_patterns'), enabled: ah.cfg('taskstate.snapshot_enabled'), live: ah.cfgLive('taskstate.snapshot_enabled'), \
         gate: taskSnap.enabled(), dir: ah.cfg('taskstate.snapshot_dir') })); return 'allow'; }",
    );
    let read = |h: &str| -> Value { serde_json::from_str(&std::fs::read_to_string(format!("{h}/.anti-hall/out-cfg.json")).unwrap()).unwrap() };
    let shipped = |k: &str| defaults::shipped(k).to_json();
    let _owner =
        Overlay::set(&[("command.heavy_patterns", json!(["("])), ("taskstate.snapshot_enabled", json!(false)), ("taskstate.snapshot_dir", json!("elsewhere"))]);
    assert_eq!(run("zz-cfg-scope", &json!({}), &env(&h)), Some(Some(Verdict::Allow)));
    let got = read(&h);
    assert_eq!(got["heavy"], shipped("command.heavy_patterns"), "ah.cfg of a user-overridden pattern list is the shipped list");
    assert_eq!(got["enabled"], json!(true), "ah.cfg of the overridden switch is the shipped value");
    assert_eq!(got["dir"], shipped("taskstate.snapshot_dir"), "an unrelated overridden key is the shipped value too");
    assert_eq!(got["live"], json!(false), "cfgLive reads the owner's settings.json");
    assert_eq!(got["gate"], json!(false), "the snapshot gate honours the owner's switch");
}

/// The confirmed regression of round 4: `command.js` compiles `command.heavy_patterns` without a guard, so an owner override that is not a
/// regex used to reach the command guard through `ah.cfg`. It must answer exactly as it does without the override.
#[test]
fn a_hostile_heavy_patterns_override_leaves_the_command_guard_as_it_is_at_base() {
    let h = home("cfg-hostile");
    let proj = format!("{h}/proj");
    std::fs::create_dir_all(format!("{proj}/.git/refs/heads")).unwrap();
    std::fs::write(format!("{proj}/.git/HEAD"), "ref: refs/heads/main\n").unwrap();
    let e = RequestEnv::from_pairs([
        ("HOME", h.as_str()),
        ("CLAUDE_CODE_ENTRYPOINT", "cli"),
        ("DEVSWARM_REPO_ID", "r1"),
        ("DEVSWARM_SOURCE_BRANCH", "feat"),
        ("ANTIHALL_INGEST_DRY_RUN", "1"),
    ]);
    let call = |sid: &str, c: &str| {
        super::run_forced(
            "command",
            &json!({"tool_name": "Bash", "session_id": sid, "cwd": proj, "tool_input": {"command": c}}),
            &Value::Null,
            "PreToolUse",
            &e,
        )
    };
    let cmds = ["npm run build", "ls -la"];
    let base: Vec<_> = cmds.iter().map(|c| call("base", c)).collect();
    assert!(matches!(base.first(), Some(Some(Some(Verdict::Exact(x)))) if x.code == 2), "base: a heavy command is blocked: {base:?}");
    assert!(matches!(base.get(1), Some(Some(Some(Verdict::Allow)))), "base: a light one passes: {base:?}");
    let _owner = Overlay::set(&[("command.heavy_patterns", json!(["(", "[a-"]))]);
    let hostile: Vec<_> = cmds.iter().map(|c| call("hostile", c)).collect();
    assert_eq!(hostile, base, "the owner's pattern list does not reach the command guard");
}
