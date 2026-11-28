//! #969 item 3: a compiled program run by path is no script. The git check read every program a Bash call ran by path (`/usr/bin/grep`,
//! `/bin/ls`) under `git.script_scan_max_bytes` as text and parsed the binary as a shell script: 130-310 ms of CPU per call, the
//! largest cost of the PreToolUse judge on a loaded machine. Plus the profiling bench (ignored; run by hand): the CPU the `git` PreToolUse check spends per Bash command over a corpus of
//! real commands (`AH_PROF_CORPUS`, one `{"command": ...}` per line), with the request's cwd in a real git checkout (`AH_PROF_CWD`).
//! Prints the thread CPU per call (p50, p95, mean, total) and the costliest commands.
//! `AH_PROF_CORPUS=<file> AH_PROF_CWD=<repo> cargo test --profile ci-test --test git_program_scan -- --ignored --nocapture`
#![allow(clippy::unwrap_used, clippy::expect_used)] // a test crate: a panic is the failure report
#![allow(clippy::panic, clippy::unreachable)]

#[path = "common/testtmp.rs"]
mod testtmp;

use ah_engine::reqenv::RequestEnv;
use serde_json::{Value, json};

fn thread_cpu_us() -> u64 {
    let mut ts = libc::timespec { tv_sec: 0, tv_nsec: 0 };
    // SAFETY: `ts` is a live, writable timespec.
    unsafe { libc::clock_gettime(libc::CLOCK_THREAD_CPUTIME_ID, &mut ts) };
    ts.tv_sec as u64 * 1_000_000 + ts.tv_nsec as u64 / 1000
}

#[test]
#[ignore = "profiling bench: run by hand with AH_PROF_CORPUS and AH_PROF_CWD"]
fn git_check_cpu_per_command() {
    let (Ok(corpus), Ok(cwd)) = (std::env::var("AH_PROF_CORPUS"), std::env::var("AH_PROF_CWD")) else { return };
    let check = std::env::var("AH_PROF_CHECK").unwrap_or_else(|_| "git".into());
    let home = testtmp::path(format!("ah-gitprof-{}", std::process::id()));
    std::fs::create_dir_all(&home).unwrap();
    let home = home.to_string_lossy().into_owned();
    let env = RequestEnv::from_pairs(vec![("HOME".to_string(), home.clone()), ("PATH".to_string(), std::env::var("PATH").unwrap_or_default())]);
    let cmds: Vec<String> =
        std::fs::read_to_string(corpus).unwrap().lines().filter_map(|l| serde_json::from_str::<Value>(l).ok()).filter_map(|v| v["command"].as_str().map(String::from)).collect();
    let payload = |c: &str| json!({"hook_event_name": "PreToolUse", "tool_name": "Bash", "tool_input": {"command": c}, "cwd": cwd, "session_id": "prof"});
    // warm the interpreter and the check's module once
    let _ = ah_engine::script::run_forced(&check, &payload("true"), &Value::Null, "PreToolUse", &env);
    let rounds: usize = std::env::var("AH_PROF_ROUNDS").ok().and_then(|v| v.parse().ok()).unwrap_or(1);
    let mut rows: Vec<(u64, u64, String)> = Vec::new();
    for _ in 0..rounds {
        for c in &cmds {
            let (t0, w0) = (thread_cpu_us(), std::time::Instant::now());
            let _ = ah_engine::script::run_forced(&check, &payload(c), &Value::Null, "PreToolUse", &env);
            rows.push((thread_cpu_us() - t0, w0.elapsed().as_micros() as u64, c.clone()));
        }
    }
    let mut cpu: Vec<u64> = rows.iter().map(|r| r.0).collect();
    cpu.sort_unstable();
    let pct = |p: usize| cpu[(cpu.len() * p / 100).min(cpu.len() - 1)];
    let total: u64 = cpu.iter().sum();
    println!("check {check}: {} calls, cpu p50 {} us, p95 {} us, max {} us, mean {} us, total {} ms", cpu.len(), pct(50), pct(95), cpu[cpu.len() - 1], total / cpu.len() as u64, total / 1000);
    rows.sort_by_key(|r| std::cmp::Reverse(r.0));
    for (c, w, cmd) in rows.iter().take(15) {
        println!("{c:>8} us cpu {w:>8} us wall  {}", cmd.replace('\n', "\\n").chars().take(160).collect::<String>());
    }
    ah_engine::discard::harmless(std::fs::remove_dir_all(&home)); // keep: scratch cleanup
}

fn verdict(home: &str, command: &str) -> ah_engine::checks::Verdict {
    let env = RequestEnv::from_pairs(vec![("HOME".to_string(), home.to_string())]);
    let payload = json!({"cwd": home, "hook_event_name": "PreToolUse", "session_id": "bin", "tool_name": "Bash", "tool_input": {"command": command}});
    ah_engine::script::run_forced("git", &payload, &json!({}), "PreToolUse", &env).expect("git script").expect("a verdict")
}

/// A compiled program (NUL bytes in it) run by path is not parsed as a shell script: a commit line with an AI credit that happens to
/// sit in its bytes blocks nothing, while the same text in a real script still blocks.
#[test]
fn a_compiled_program_run_by_path_is_not_scanned_as_a_script() {
    let home = testtmp::path(format!("ah-gitbin-{}", std::process::id()));
    std::fs::create_dir_all(&home).unwrap();
    let home = std::fs::canonicalize(&home).unwrap().to_string_lossy().into_owned();
    let line = "git commit -m 'fix the gauge' -m 'Co-Authored-By: Claude <noreply@anthropic.com>'\n";
    let exec = |name: &str, body: &[u8]| {
        let p = std::path::Path::new(&home).join(name);
        std::fs::write(&p, body).unwrap();
        std::fs::set_permissions(&p, std::os::unix::fs::PermissionsExt::from_mode(0o755)).unwrap();
    };
    let mut bin = b"\xcf\xfa\xed\xfe\x00\x00\x00\x01\n".to_vec();
    bin.extend_from_slice(line.as_bytes());
    exec("prog", &bin);
    exec("script.sh", format!("#!/bin/sh\n{line}").as_bytes());
    let b = verdict(&home, &format!("{home}/prog"));
    let s = verdict(&home, &format!("{home}/script.sh"));
    ah_engine::discard::harmless(std::fs::remove_dir_all(&home)); // keep: scratch cleanup
    assert!(!format!("{b:?}").contains("Block"), "a binary is no script: {b:?}");
    assert!(format!("{s:?}").contains("Block"), "the same line in a real script still blocks: {s:?}");
}
