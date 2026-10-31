//! #519: a background agent whose output has been quiet past guards.silentAgentNudgeMin is nudged at Stop (the Claude Code launch
//! shape of 2026-10: the tool result names `agentId` and `output_file`, the output file is the agent's sidechain transcript), and
//! one that wrote recently is not. Scratch HOME only.
#![allow(clippy::unwrap_used, clippy::expect_used)]

use ah_engine::reqenv::RequestEnv;
use serde_json::json;
use std::path::Path;

const SID: &str = "0b5e7c1a-1111-4222-8333-944455556666";

fn age(path: &Path, secs: i64) {
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_secs() as i64;
    let tv = libc::timeval { tv_sec: (now - secs) as libc::time_t, tv_usec: 0 };
    let c = std::ffi::CString::new(path.to_string_lossy().as_bytes()).unwrap();
    // SAFETY: a valid C path and two valid timevals
    assert_eq!(unsafe { libc::utimes(c.as_ptr(), [tv, tv].as_ptr()) }, 0);
}

fn fixture(tag: &str, quiet_s: i64) -> (std::path::PathBuf, std::path::PathBuf) {
    let home = std::env::temp_dir().join(format!("ah-snfire-{tag}-{}", std::process::id()));
    std::fs::create_dir_all(home.join(".anti-hall")).unwrap();
    let home = std::fs::canonicalize(&home).unwrap();
    let proj = home.join("projects");
    let tasks = home.join("tmp").join(SID).join("tasks");
    std::fs::create_dir_all(proj.join(SID).join("subagents")).unwrap();
    std::fs::create_dir_all(&tasks).unwrap();
    let side = proj.join(SID).join("subagents/agent-a1b2c3d4e5f60718.jsonl");
    std::fs::write(&side, "{\"type\":\"user\"}\n").unwrap();
    let out = tasks.join("a1b2c3d4e5f60718.output");
    std::os::unix::fs::symlink(&side, &out).unwrap();
    age(&side, quiet_s);
    let launched = chrono_like(quiet_s + 60);
    let tp = proj.join(format!("{SID}.jsonl"));
    let lines = [
        json!({"type":"assistant","timestamp":launched,"message":{"role":"assistant","content":[{"type":"tool_use","id":"toolu_1","name":"Agent","input":{"description":"Build the engine","prompt":"go","run_in_background":true}}]}}),
        json!({"type":"user","timestamp":launched,"message":{"role":"user","content":[{"tool_use_id":"toolu_1","type":"tool_result","content":[{"type":"text","text":format!("Async agent launched successfully.\nagentId: a1b2c3d4e5f60718 (internal ID)\nThe agent is working in the background.\noutput_file: {}\n", out.display())}]}]}}),
    ];
    std::fs::write(&tp, lines.iter().map(|l| l.to_string() + "\n").collect::<String>()).unwrap();
    (home, tp)
}

/// An ISO time `secs` ago (UTC), the transcript's timestamp shape.
fn chrono_like(secs: i64) -> String {
    let t = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_secs() as i64 - secs;
    let (days, rem) = (t.div_euclid(86_400), t.rem_euclid(86_400));
    // civil-from-days (H. Hinnant)
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + i64::from(m <= 2);
    format!("{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}.000Z", rem / 3600, rem % 3600 / 60, rem % 60)
}

fn stop(home: &Path, tp: &Path) -> String {
    let env = RequestEnv::from_pairs(vec![("HOME".to_string(), home.to_string_lossy().into_owned())]);
    let payload = json!({"cwd": home, "hook_event_name": "Stop", "session_id": SID, "transcript_path": tp});
    format!("{:?}", ah_engine::script::run_forced("silent-agent-nudge", &payload, &json!({}), "Stop", &env))
}

#[test]
fn a_background_agent_quiet_past_the_threshold_is_nudged_at_stop() {
    let (home, tp) = fixture("stale", 30 * 60);
    let v = stop(&home, &tp);
    assert!(v.contains("block") && v.contains("Build the engine"), "{v}");
    std::fs::remove_dir_all(&home).ok();
}

#[test]
fn a_background_agent_that_wrote_recently_is_not_nudged() {
    let (home, tp) = fixture("fresh", 60);
    let v = stop(&home, &tp);
    assert!(!v.contains("block"), "{v}");
    std::fs::remove_dir_all(&home).ok();
}
