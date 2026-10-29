//! A Stop through task-guard on a session holding many tasks: the verdict is the one the per-task logic gives (owner-decision tasks are
//! left out of the block, the rest are listed), and the count does not depend on how the config/settings reads are cached.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic, clippy::unreachable)]

use ah_engine::reqenv::RequestEnv;
use serde_json::json;
use std::io::Write;

#[test]
fn many_open_tasks_give_the_same_verdict() {
    let home = std::env::temp_dir().join(format!("ah-tgmany-{}", std::process::id()));
    std::fs::create_dir_all(&home).unwrap();
    let real = std::fs::canonicalize(&home).unwrap();
    let tp = real.join("t.jsonl");
    let mut f = std::fs::File::create(&tp).unwrap();
    writeln!(f, r#"{{"type":"user","uuid":"u0","timestamp":"2026-10-07T10:00:00.000Z","message":{{"role":"user","content":"start"}}}}"#).unwrap();
    for i in 0..300 {
        // every third task waits on the owner (an `OWNER:` subject), the rest are plain open tasks
        let subject = if i % 3 == 0 { format!("OWNER: decide {i}") } else { format!("task {i}") };
        writeln!(
            f,
            r#"{{"type":"assistant","timestamp":"2026-10-07T10:00:01.000Z","message":{{"role":"assistant","content":[{{"type":"tool_use","id":"t{i}","name":"TaskCreate","input":{{"subject":"{subject}","status":"pending"}}}}]}}}}"#
        )
        .unwrap();
        writeln!(
            f,
            r#"{{"type":"user","timestamp":"2026-10-07T10:00:02.000Z","message":{{"role":"user","content":[{{"type":"tool_result","tool_use_id":"t{i}","content":"Task #{} created successfully: {subject}"}}]}}}}"#,
            i + 1
        )
        .unwrap();
    }
    drop(f);
    let env = RequestEnv::from_pairs(vec![("HOME".to_string(), real.to_string_lossy().into_owned())]);
    let payload = json!({"cwd": real, "hook_event_name": "Stop", "session_id": "s1", "transcript_path": tp});
    let verdict = format!("{:?}", ah_engine::script::run_forced("task-guard", &payload, &json!({}), "Stop", &env));
    assert!(verdict.contains("block"), "open tasks block the Stop: {verdict}");
    // 300 tasks, every third one waiting on the owner: 200 are left for the block (the same on the unmemoized reads, measured on origin/dev)
    assert!(verdict.contains("200 open tasks"), "the owner-waiting tasks are left out: {verdict}");
    std::fs::remove_dir_all(&home).ok();
}

/// Host calls made by `ah.cfg` / `ah.settings.bool` inside one check call: a loop of 1000 reads costs ONE `cfgGen` and ONE `settingBool`,
/// and the next call (a fresh request) checks the defaults generation again, so a defaults reload between calls is still seen.
#[test]
fn config_and_settings_reads_cost_one_host_call_per_check_call() {
    let home = std::env::temp_dir().join(format!("ah-tgcalls-{}", std::process::id()));
    std::fs::create_dir_all(home.join(".anti-hall/logic")).unwrap();
    let real = std::fs::canonicalize(&home).unwrap();
    std::fs::write(
        real.join(".anti-hall/logic/ship-it-guard.js"),
        r#"function decide(p) {
  var n = { gen: 0, bool: 0 }, g = ahHost.cfgGen, b = ahHost.settingBool;
  ahHost.cfgGen = function () { n.gen++; return g(); };
  ahHost.settingBool = function (k) { n.bool++; return b(k); };
  var v;
  for (var i = 0; i < 1000; i++) { v = ah.cfg('dispatch_tier.owner_values'); ah.settings.bool('dispatch_tier.owner_marker_setting'); }
  ahHost.cfgGen = g; ahHost.settingBool = b;
  return { block: JSON.stringify(n) + (Array.isArray(v) ? ' array' : ' other') };
}"#,
    )
    .unwrap();
    let env = RequestEnv::from_pairs(vec![("HOME".to_string(), real.to_string_lossy().into_owned())]);
    let payload = json!({"tool_name": "Write", "tool_input": {"file_path": "a.rs"}, "cwd": "/x"});
    for _ in 0..2 {
        let v = format!("{:?}", ah_engine::script::run_forced("ship-it-guard", &payload, &json!({}), "PreToolUse", &env));
        assert!(v.contains(r#"{\"gen\":1,\"bool\":1} array"#), "one cfgGen and one settingBool for 1000 reads of each: {v}");
    }
    std::fs::remove_dir_all(&home).ok();
}
