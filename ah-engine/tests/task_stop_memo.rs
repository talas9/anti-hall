//! One Stop request reconstructs the task list of a transcript once per variant, not once per check: the Stop checks task-guard
//! (which asks twice), task-pair-guard and tasklist-guard are run in dispatch order over one unchanged transcript whose tail is cut
//! mid-history (so each reconstruction would scan back through the file), and the engine's count of reconstructions it actually
//! computed (`taskstate::memo::computes`) must not exceed the three variants. The session has no task store of its own, as a
//! session on a named task list has none, so the guards read the transcript.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic, clippy::unreachable)]

mod common;

use ah_engine::checks::taskstate::memo::computes;
use ah_engine::reqenv::RequestEnv;
use serde_json::json;
use std::io::Write;
use std::path::Path;

/// A transcript row shaped like a long coordinator session: prompts, big tool results, background-agent launches, task calls.
fn line(i: u64) -> String {
    let ts = format!("2026-10-07T{:02}:{:02}:{:02}.000Z", (i / 3600) % 24, (i / 60) % 60, i % 60);
    // AH_TSCOST_SHAPE=old: tasks are created only at the start of the session; the tail only updates them
    let old = true;
    let k = if old && i >= 5000 && matches!(i % 50, 1 | 2) { 6 } else { i % 50 };
    match k {
        0 => format!(r#"{{"type":"user","uuid":"u{i}","timestamp":"{ts}","message":{{"role":"user","content":"prompt number {i} about the engine"}}}}"#),
        1 => format!(
            r#"{{"type":"assistant","timestamp":"{ts}","message":{{"role":"assistant","content":[{{"type":"tool_use","id":"t{i}","name":"TaskCreate","input":{{"subject":"task {i}","description":"d","status":"pending"}}}}]}}}}"#
        ),
        2 => format!(
            r#"{{"type":"user","timestamp":"{ts}","message":{{"role":"user","content":[{{"type":"tool_result","tool_use_id":"t{}","content":"Task #{} created successfully: task {}"}}]}}}}"#,
            i - 1,
            i / 50 + 1,
            i - 1
        ),
        3 => format!(
            r#"{{"type":"assistant","timestamp":"{ts}","message":{{"role":"assistant","content":[{{"type":"tool_use","id":"u{i}","name":"TaskUpdate","input":{{"taskId":"{}","status":"in_progress","owner":"w{}"}}}}]}}}}"#,
            (i / 50) % 100 + 1,
            i % 7
        ),
        4 => format!(
            r#"{{"type":"assistant","timestamp":"{ts}","message":{{"role":"assistant","content":[{{"type":"tool_use","id":"a{i}","name":"Agent","input":{{"description":"agent {i}","run_in_background":true,"prompt":"do the thing"}}}}]}}}}"#
        ),
        5 => format!(
            r#"{{"type":"user","timestamp":"{ts}","message":{{"role":"user","content":[{{"type":"tool_result","tool_use_id":"a{}","content":"Async agent launched successfully.\nagentId: {:016x}\noutput_file: /nonexistent/tasks/{:016x}.output"}}]}}}}"#,
            i - 1,
            i,
            i
        ),
        k if k % 3 == 0 => format!(
            r#"{{"type":"assistant","timestamp":"{ts}","message":{{"role":"assistant","content":[{{"type":"tool_use","id":"b{i}","name":"Bash","input":{{"command":"cargo test --lib module_{i}"}}}}]}}}}"#
        ),
        k if k % 3 == 1 => format!(
            r#"{{"type":"user","timestamp":"{ts}","message":{{"role":"user","content":[{{"type":"tool_result","tool_use_id":"b{}","content":"{}"}}]}}}}"#,
            i - 1,
            "output line of a test run, padded; ".repeat(60)
        ),
        _ => {
            format!(r#"{{"type":"assistant","timestamp":"{ts}","message":{{"role":"assistant","content":[{{"type":"text","text":"{}"}}]}}}}"#, "x".repeat(600))
        }
    }
}

fn grow(path: &Path, from: u64, to: u64) {
    let mut f = std::io::BufWriter::new(std::fs::OpenOptions::new().create(true).append(true).open(path).unwrap());
    for i in from..to {
        writeln!(f, "{}", line(i)).unwrap();
    }
}

const STOP_CHECKS: [&str; 4] = ["task-guard", "task-pair-guard", "tasklist-guard", "task-guard"];

#[test]
fn a_stop_reconstructs_the_task_list_once_per_variant() {
    let root = common::TempDir::at(std::env::temp_dir().join(format!("ah-stopmemo-{}", std::process::id())));
    let home = root.join("home");
    std::fs::create_dir_all(&home).unwrap();
    let home = std::fs::canonicalize(&home).unwrap();
    assert!(home.starts_with(std::fs::canonicalize(std::env::temp_dir()).unwrap()), "the HOME is under the scratch temp dir");
    let tp = home.join("t.jsonl");
    grow(&tp, 0, 9_000); // about 8 MB: far past the 1.5 MiB tail window
    let size = std::fs::metadata(&tp).unwrap().len();
    assert!(size > 4 * 1024 * 1024, "the transcript must outgrow the tail window, got {size}");
    let env = RequestEnv::from_pairs(vec![("HOME".to_string(), home.to_string_lossy().into_owned()), ("ANTIHALL_MAX_PARALLEL_DISPATCH".into(), "4".into())]);
    let payload = json!({"cwd": home, "hook_event_name": "Stop", "session_id": "memo-session", "transcript_path": tp});
    let stop = |name: &str| ah_engine::script::run_forced(name, &payload, &json!({}), "Stop", &env).unwrap();

    // dispatch order; the work each check adds, counted by what the engine actually computed
    let mut verdicts: Vec<String> = Vec::new();
    let mut added: Vec<u64> = Vec::new();
    for c in STOP_CHECKS {
        let from = computes();
        verdicts.push(format!("{:?}", stop(c)));
        added.push(computes() - from);
    }
    println!("reconstructions computed per check {STOP_CHECKS:?}: {added:?}");
    assert_eq!(added[3], 0, "task-guard's second reconstruction of the same transcript state is served: {added:?}");
    // the three variants (guard, state, scan) at most once each, and a backward scan once per distinct set of wanted tasks
    assert!(added.iter().sum::<u64>() <= 5, "one Stop request computed more reconstructions than its variants need: {added:?}");
    assert!(added[0] >= 1, "the first check reconstructs");

    // the same request again on the unchanged file: everything is served
    let again_from = computes();
    let again: Vec<String> = STOP_CHECKS.iter().map(|c| format!("{:?}", stop(c))).collect();
    assert_eq!(computes() - again_from, 0, "an unchanged transcript is not reconstructed again");
    // (the repeated task-guard prints its unknown-state note under its own per-session throttle, so only the first three compare)
    assert_eq!(verdicts[..3], again[..3], "a served answer is the answer a fresh reconstruction gave");

    // an append changes the state of the file: reconstructed again, again once per variant
    grow(&tp, 9_000, 9_003);
    let grown_from = computes();
    for c in STOP_CHECKS {
        stop(c);
    }
    let grown = computes() - grown_from;
    assert!((1..=5).contains(&grown), "after an append one Stop request computed {grown} reconstructions");
    let _ = (root, Path::new(""));
}
