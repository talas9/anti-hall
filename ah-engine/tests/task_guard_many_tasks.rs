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

/// The memo hits and misses of `ah.cfg` / `ah.settings` reach `cfg_cache{result}` through the next call's one `cfgGen` read: 1000 reads
/// of one cfg key and one setting are 2 misses and 1998 hits, and the host sees one `cfgGen` per call, not one per read.
#[test]
fn cfg_cache_hits_and_misses_are_counted_without_extra_host_calls() {
    let home = std::env::temp_dir().join(format!("ah-tgcachecnt-{}", std::process::id()));
    std::fs::create_dir_all(home.join(".anti-hall/logic")).unwrap();
    let real = std::fs::canonicalize(&home).unwrap();
    std::fs::write(
        real.join(".anti-hall/logic/ship-it-guard.js"),
        r#"function decide(p) {
  var n = 0, g = ahHost.cfgGen;
  ahHost.cfgGen = function (h, m) { n++; return g(h, m); };
  for (var i = 0; i < 1000; i++) { ah.cfg('dispatch_tier.owner_values'); ah.settings.bool('dispatch_tier.owner_marker_setting'); }
  ahHost.cfgGen = g;
  return { block: 'cfgGen calls ' + n };
}"#,
    )
    .unwrap();
    let env = RequestEnv::from_pairs(vec![("HOME".to_string(), real.to_string_lossy().into_owned())]);
    let payload = json!({"tool_name": "Write", "tool_input": {"file_path": "a.rs"}, "cwd": "/x"});
    let mut m = ah_engine::metrics::Metrics::default();
    ah_engine::metrics::drain_pending(&mut m);
    for _ in 0..2 {
        let v = format!("{:?}", ah_engine::script::run_forced("ship-it-guard", &payload, &json!({}), "PreToolUse", &env));
        assert!(v.contains("cfgGen calls 1"), "counting adds no host call: {v}");
    }
    ah_engine::metrics::drain_pending(&mut m);
    // the second call's own tally is still waiting for a third call, so only the first call's counts are in: >= 1998 hits, >= 2 misses
    assert!(m.counter("cfg_cache", &[("result", "hit")]) >= 1998, "hits: {}", m.counter("cfg_cache", &[("result", "hit")]));
    assert!(m.counter("cfg_cache", &[("result", "miss")]) >= 2, "misses: {}", m.counter("cfg_cache", &[("result", "miss")]));
    std::fs::remove_dir_all(&home).ok();
}

/// `tailLinesNewest` with a cap counts `tail_newest_reads{mode=capped}`, without one `{mode=fallback_full}`.
#[test]
fn newest_tail_reads_are_counted_by_mode() {
    let home = std::env::temp_dir().join(format!("ah-tgtailcnt-{}", std::process::id()));
    std::fs::create_dir_all(home.join(".anti-hall/logic")).unwrap();
    let real = std::fs::canonicalize(&home).unwrap();
    let tp = real.join("t.jsonl");
    std::fs::write(&tp, "a\nb\nc\n").unwrap();
    std::fs::write(
        real.join(".anti-hall/logic/ship-it-guard.js"),
        format!(
            r#"function decide(p) {{ ah.fs.tailLinesNewest('{}', 1000, false, [], 2); ah.fs.tailLinesNewest('{}', 1000, false, [], 0); ah.fs.tailLinesNewest('{}', 1000, false, [], 0); return {{ block: 'x' }}; }}"#,
            tp.display(),
            tp.display(),
            tp.display()
        ),
    )
    .unwrap();
    let env = RequestEnv::from_pairs(vec![("HOME".to_string(), real.to_string_lossy().into_owned())]);
    let payload = json!({"tool_name": "Write", "tool_input": {"file_path": "a.rs"}, "cwd": "/x"});
    let mut m = ah_engine::metrics::Metrics::default();
    ah_engine::metrics::drain_pending(&mut m);
    ah_engine::script::run_forced("ship-it-guard", &payload, &json!({}), "PreToolUse", &env);
    ah_engine::metrics::drain_pending(&mut m);
    assert!(m.counter("tail_newest_reads", &[("mode", "capped")]) >= 1);
    assert!(m.counter("tail_newest_reads", &[("mode", "fallback_full")]) >= 2);
    std::fs::remove_dir_all(&home).ok();
}
