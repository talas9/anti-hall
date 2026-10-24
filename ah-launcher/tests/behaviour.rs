//! End-to-end behaviour of the `ah-hook` launcher against fake engines, one section per hardening item. Every test runs the
//! real binary with a scratch HOME and a scratch plugin root; none touches the live engine, ~/.claude or the network.
//! The edge-case table in THIN-LAUNCHER.md names these tests.

mod common;

use common::*;
use std::io::Write;
use std::os::unix::net::UnixListener;
use std::time::Duration;

const PAYLOAD: &[u8] =
    b"{\"session_id\":\"s-1\",\"tool_name\":\"Bash\",\"tool_input\":{\"command\":\"ls\"}}";

/// A fake engine that records its argv and payload and answers with `body`.
fn engine(env: &Env, body: &str) -> std::path::PathBuf {
    let args = env.path("args");
    let payload = env.path("payload");
    env.script(
        "engine.sh",
        &format!(
            "echo \"$*\" >>{}\ncat >{}\n{body}",
            args.display(),
            payload.display()
        ),
    )
}

// ---------------------------------------------------------------------------------------------------------------------------
// 1. never panic: every internal failure lets the hook through
// ---------------------------------------------------------------------------------------------------------------------------

#[test]
fn panic_is_caught_and_fails_open_with_one_stderr_line() {
    let env = Env::new("panic");
    let e = engine(&env, "exit 0");
    let o = env.run(
        "PreToolUse",
        PAYLOAD,
        Some(&e),
        &[("AH_LAUNCHER_FAULT", "panic")],
    );
    assert_eq!(o.code, 0, "{}", o.err);
    assert!(o.out.is_empty());
    assert_eq!(o.err.lines().count(), 1, "{}", o.err);
    assert!(o.err.contains("launcher internal failure"), "{}", o.err);
    assert!(
        env.log().contains("internal panic"),
        "failure path writes the log: {}",
        env.log()
    );
}

#[test]
fn no_event_argument_fails_open() {
    let env = Env::new("noevent");
    let mut c = std::process::Command::new(env!("CARGO_BIN_EXE_ah-hook"));
    c.env_clear().env("HOME", &env.home);
    let o = env.run_with(c, |_| {});
    assert_eq!(o.code, 0);
    assert!(o.out.is_empty());
}

#[test]
fn stdout_and_stderr_closed_does_not_panic() {
    let env = Env::new("closedfds");
    let e = engine(&env, "echo out; echo err >&2; exit 0");
    let c0 = env.command("PreToolUse", &[], Some(&e), &[]);
    // the shell closes our stdout and stderr before exec: every write fails with EBADF
    let mut c = std::process::Command::new("sh");
    c.arg("-c")
        .arg(format!("exec {} >&- 2>&-", shell_words(&c0)))
        .env_clear();
    for (k, v) in c0.get_envs() {
        if let Some(v) = v {
            c.env(k, v);
        }
    }
    let o = env.run_with(c, |mut si| {
        let _ = si.write_all(PAYLOAD);
    });
    assert_eq!(
        o.code, 0,
        "a closed stdout/stderr must not turn into a crash"
    );
}

fn shell_words(c: &std::process::Command) -> String {
    let mut v = vec![c.get_program().to_string_lossy().into_owned()];
    v.extend(c.get_args().map(|a| a.to_string_lossy().into_owned()));
    v.iter()
        .map(|w| format!("'{}'", w.replace('\'', "'\\''")))
        .collect::<Vec<_>>()
        .join(" ")
}

#[test]
fn engine_block_passes_through_and_internal_failure_never_blocks() {
    let env = Env::new("block");
    let e = engine(&env, "echo denied >&2; exit 2");
    let o = env.run("PreToolUse", PAYLOAD, Some(&e), &[]);
    assert_eq!((o.code, o.err.trim()), (2, "denied"));
    let o = env.run(
        "PreToolUse",
        PAYLOAD,
        Some(&e),
        &[("AH_LAUNCHER_FAULT", "panic")],
    );
    assert_eq!(o.code, 0, "an internal failure is not a block");
}

// ---------------------------------------------------------------------------------------------------------------------------
// 2. timeouts on every step
// ---------------------------------------------------------------------------------------------------------------------------

#[test]
fn hung_engine_is_killed_at_the_deadline() {
    let env = Env::new("hung");
    let pid = env.path("pid");
    let e = engine(&env, &format!("echo $$ >{}\nexec sleep 60", pid.display()));
    let o = env.run(
        "UserPromptSubmit",
        PAYLOAD,
        Some(&e),
        &[("AH_HOOK_TIMEOUT_MS", "1000")],
    );
    assert_eq!(o.code, 0);
    assert!(o.ms < 4000, "ms={}", o.ms);
    assert!(
        wait_until(Duration::from_secs(2), || !alive(pid_from(&pid).unwrap())),
        "engine group killed"
    );
    assert!(
        env.log().contains("engine_timed"),
        "failure path is logged: {}",
        env.log()
    );
}

#[test]
fn stopped_engine_is_killed_not_waited_for() {
    let env = Env::new("stopped");
    let pid = env.path("pid");
    let e = engine(
        &env,
        &format!("echo $$ >{}\nkill -STOP $$\nexit 0", pid.display()),
    );
    let o = env.run(
        "UserPromptSubmit",
        PAYLOAD,
        Some(&e),
        &[("AH_HOOK_TIMEOUT_MS", "1000")],
    );
    assert_eq!(o.code, 0);
    assert!(o.ms < 4000, "ms={}", o.ms);
    assert!(
        wait_until(Duration::from_secs(2), || !alive(pid_from(&pid).unwrap())),
        "SIGSTOPped engine killed"
    );
}

#[test]
fn host_that_never_finishes_the_payload_is_cut_off_at_the_idle_timeout() {
    let env = Env::new("idle");
    env.set("launcher.stdin_idle_ms", "300");
    let e = engine(&env, "exit 0");
    let mut cmd = env.command("UserPromptSubmit", &[], Some(&e), &[]);
    let o = env.run_with(
        std::mem::replace(&mut cmd, std::process::Command::new("true")),
        |mut si| {
            let _ = si.write_all(b"{\"partial\":");
            std::thread::sleep(Duration::from_millis(2500)); // stdin stays open, no more data
        },
    );
    assert_eq!(o.code, 0);
    assert!(
        o.ms < 2200,
        "launcher did not wait for the host: ms={}",
        o.ms
    );
    assert_eq!(
        env.read("payload"),
        "{\"partial\":",
        "the engine got what had arrived"
    );
}

#[test]
fn engine_that_stops_reading_stalls_the_write_for_at_most_the_write_timeout() {
    let env = Env::new("stall");
    env.set("launcher.write_timeout_ms", "200");
    let e2 = env.script("noread.sh", "sleep 1.5\nexit 0"); // never reads its input
    let big = pattern(8 << 20);
    let o = env.run(
        "UserPromptSubmit",
        &big,
        Some(&e2),
        &[("AH_HOOK_TIMEOUT_MS", "4000")],
    );
    assert_eq!(o.code, 0);
    assert!(env.diag().contains("write_timeout=1"), "{}", env.diag());
    assert!(o.ms < 3500, "ms={}", o.ms);
}

#[test]
fn wall_clock_backstop_fires_when_the_launcher_itself_hangs() {
    let env = Env::new("wall");
    let e = engine(&env, "exit 0");
    let o = env.run(
        "UserPromptSubmit",
        PAYLOAD,
        Some(&e),
        &[("AH_LAUNCHER_FAULT", "hang"), ("AH_HOOK_TIMEOUT_MS", "300")],
    );
    assert_eq!(o.code, 0, "{}", o.err);
    assert!(o.err.contains("time limit"), "{}", o.err);
    assert!(
        o.ms >= 600 && o.ms < 4000,
        "alarm at the planned path plus the margin: ms={}",
        o.ms
    );
}

// ---------------------------------------------------------------------------------------------------------------------------
// 3. retry only a failed start
// ---------------------------------------------------------------------------------------------------------------------------

#[test]
fn engine_is_started_exactly_once_even_when_it_times_out_after_the_write() {
    let env = Env::new("once");
    let e = engine(&env, "sleep 30");
    let o = env.run(
        "UserPromptSubmit",
        PAYLOAD,
        Some(&e),
        &[("AH_HOOK_TIMEOUT_MS", "1500")],
    );
    assert_eq!(o.code, 0);
    assert_eq!(
        env.read("args").lines().count(),
        1,
        "no retry after the request was written: {}",
        env.read("args")
    );
}

#[test]
fn transient_start_failure_is_retried_a_bounded_number_of_times_then_fails_open() {
    use std::os::unix::process::CommandExt;
    let env = Env::new("eagain");
    env.set("launcher.spawn_retry_max", "3");
    env.set("launcher.spawn_backoff_base_ms", "10");
    env.set("launcher.spawn_backoff_cap_ms", "20");
    let e = engine(&env, "exit 0");
    let mut cmd = env.command("UserPromptSubmit", &[], Some(&e), &[]);
    // the launcher may start no further process: its fork() fails with EAGAIN, a transient start failure
    // SAFETY: setrlimit is async-signal-safe and runs in the child between fork and exec.
    unsafe {
        cmd.pre_exec(|| {
            let one = libc::rlimit {
                rlim_cur: 1,
                rlim_max: 1,
            };
            libc::setrlimit(libc::RLIMIT_NPROC, &one);
            Ok(())
        });
    }
    let o = env.run_with(cmd, |mut si| {
        let _ = si.write_all(PAYLOAD);
    });
    assert_eq!(o.code, 0, "{}", o.err);
    assert!(o.out.is_empty());
    let d = env.diag();
    assert!(
        d.contains("spawn_retries=3") && d.contains("spawn_fail=1"),
        "{d}"
    );
    assert!(
        !env.path("args").exists(),
        "the engine never started, so nothing was retried after a write"
    );
    assert!(env.log().contains("engine_spawn_failed"), "{}", env.log());
    assert!(o.ms < 3000, "ms={}", o.ms);
}

// ---------------------------------------------------------------------------------------------------------------------------
// 4. streaming I/O, fixed buffers
// ---------------------------------------------------------------------------------------------------------------------------

#[test]
fn hundred_megabyte_payload_streams_through_with_flat_memory() {
    let env = Env::new("huge");
    let sum = env.path("sum");
    let e = env.script("sum.sh", &format!("cksum >{}\nexit 0", sum.display()));
    let data = pattern(100 << 20);
    let expect = {
        let tmp = env.path("expect.bin");
        std::fs::write(&tmp, &data).unwrap();
        let o = std::process::Command::new("cksum")
            .arg(&tmp)
            .output()
            .unwrap();
        String::from_utf8_lossy(&o.stdout)
            .split_whitespace()
            .take(2)
            .collect::<Vec<_>>()
            .join(" ")
    };
    let o = env.run(
        "UserPromptSubmit",
        &data,
        Some(&e),
        &[("AH_HOOK_TIMEOUT_MS", "20000")],
    );
    assert_eq!(o.code, 0, "{}", o.err);
    let got = env.read("sum");
    assert_eq!(
        got.split_whitespace().take(2).collect::<Vec<_>>().join(" "),
        expect,
        "every byte arrived"
    );
    let peak: usize = env
        .diag()
        .split("mem_peak=")
        .nth(1)
        .and_then(|r| r.split_whitespace().next())
        .and_then(|n| n.parse().ok())
        .expect("mem_peak in the diag line");
    assert!(
        peak < 4 << 20,
        "heap stayed flat: peak {peak} for a 100 MB payload"
    );
}

#[test]
fn payload_bytes_are_passed_exactly_invalid_json_and_non_utf8_included() {
    let env = Env::new("bytes");
    let e = engine(&env, "exit 0");
    for (name, bytes) in [
        ("invalid_json", b"{\"tool_name\": ".to_vec()),
        (
            "non_utf8",
            b"\xff\xfe{\"session_id\":\"\xc3\x28\"}\x00tail".to_vec(),
        ),
        ("empty", Vec::new()),
        ("not_json_at_all", b"hello\nworld".to_vec()),
    ] {
        let o = env.run("UserPromptSubmit", &bytes, Some(&e), &[]);
        assert_eq!(o.code, 0, "{name}");
        assert_eq!(
            std::fs::read(env.path("payload")).unwrap(),
            bytes,
            "{name}: the engine decides what is invalid"
        );
    }
}

#[test]
fn stdin_hard_limit_stops_reading_and_counts() {
    let env = Env::new("stdinhard");
    env.set("launcher.stdin_soft_bytes", "1048576");
    env.set("launcher.stdin_hard_bytes", "3145728");
    let e = engine(&env, "exit 0");
    let o = env.run(
        "UserPromptSubmit",
        &pattern(6 << 20),
        Some(&e),
        &[("AH_HOOK_TIMEOUT_MS", "5000")],
    );
    assert_eq!(o.code, 0);
    let got = std::fs::metadata(env.path("payload")).unwrap().len();
    assert_eq!(got, 3 << 20, "the engine got exactly the hard limit");
    let d = env.diag();
    assert!(
        d.contains("stdin_hard=1") && d.contains("stdin_soft=1"),
        "{d}"
    );
}

#[test]
fn stdin_closed_before_any_data_is_an_empty_payload() {
    let env = Env::new("stdinclosed");
    let e = engine(&env, "exit 0");
    let mut c = env.command("UserPromptSubmit", &[], Some(&e), &[]);
    c.stdin(std::process::Stdio::null());
    let o = c
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .output()
        .unwrap();
    assert_eq!(o.status.code(), Some(0));
    assert_eq!(std::fs::metadata(env.path("payload")).unwrap().len(), 0);
}

#[test]
fn an_engine_that_hands_a_large_call_back_is_answered_with_one_notice_and_no_runner() {
    let env = Env::new("replay");
    // the retired shell wrapper must never be started: a marker would show it
    let marker = env.path("runner-ran");
    std::fs::write(
        env.root.join("hooks/ah-hook.sh"),
        format!("touch {}\nexit 0\n", marker.display()),
    )
    .unwrap();
    let e = env.script("defer.sh", "exit 75"); // defers without reading anything
    let data = pattern(5 << 20);
    let o = env.run(
        "UserPromptSubmit",
        &data,
        Some(&e),
        &[("AH_HOOK_TIMEOUT_MS", "5000")],
    );
    assert_eq!(o.code, 0, "{}", o.err);
    assert!(o.out.is_empty(), "no answer is invented");
    assert_eq!(
        o.err.matches("handed the call back").count(),
        1,
        "one notice: {}",
        o.err
    );
    assert!(!marker.exists(), "no shell runner is started");
}

#[test]
fn a_guard_event_the_engine_hands_back_goes_through_with_the_notice_and_starts_no_runner() {
    let env = Env::new("nospool");
    let marker = env.path("runner-ran");
    std::fs::write(
        env.root.join("hooks/ah-hook.sh"),
        format!("touch {}\nexit 0\n", marker.display()),
    )
    .unwrap();
    let e = env.script("defer.sh", "exit 75");
    let data = pattern(5 << 20);
    for event in ["PreToolUse", "UserPromptSubmit"] {
        let o = env.run(event, &data, Some(&e), &[("AH_HOOK_TIMEOUT_MS", "5000")]);
        assert_eq!(o.code, 0, "{event}: {}", o.err);
        if event == "PreToolUse" {
            // the notice is once per session
            assert!(o.err.contains("handed the call back"), "{event}: {}", o.err);
        }
    }
    assert!(!marker.exists(), "no shell runner is started");
}

// ---------------------------------------------------------------------------------------------------------------------------
// 5. limits on the launcher itself
// ---------------------------------------------------------------------------------------------------------------------------

#[test]
fn cpu_hard_limit_stops_a_spinning_launcher_and_fails_open() {
    let env = Env::new("cpu");
    env.set("launcher.cpu_hard_s", "1");
    let e = engine(&env, "exit 0");
    let o = env.run(
        "UserPromptSubmit",
        PAYLOAD,
        Some(&e),
        &[
            ("AH_LAUNCHER_FAULT", "spin"),
            ("AH_HOOK_TIMEOUT_MS", "8000"),
        ],
    );
    assert_eq!(o.code, 0, "{}", o.err);
    assert!(o.err.contains("CPU limit"), "{}", o.err);
    assert!(o.ms < 6000, "ms={}", o.ms);
}

#[test]
fn memory_hard_limit_stops_a_growing_launcher_and_fails_open() {
    let env = Env::new("mem");
    env.set("launcher.mem_soft_bytes", "8388608");
    env.set("launcher.mem_hard_bytes", "20971520");
    let e = engine(&env, "exit 0");
    let o = env.run(
        "UserPromptSubmit",
        PAYLOAD,
        Some(&e),
        &[("AH_LAUNCHER_FAULT", "alloc")],
    );
    assert_eq!(o.code, 0, "{}", o.err);
    assert!(o.err.contains("memory limit"), "{}", o.err);
}

#[test]
fn soft_limits_warn_and_count_without_changing_the_outcome() {
    let env = Env::new("soft");
    env.set("launcher.mem_soft_bytes", "1");
    env.set("launcher.cpu_soft_ms", "1");
    let e = engine(&env, "echo fine; exit 0");
    let o = env.run("UserPromptSubmit", PAYLOAD, Some(&e), &[]);
    assert_eq!(
        (o.code, String::from_utf8_lossy(&o.out).trim().to_string()),
        (0, "fine".into())
    );
    assert!(env.diag().contains("mem_soft=1"), "{}", env.diag());
    assert!(
        env.log().contains("soft_limit"),
        "a soft hit is logged: {}",
        env.log()
    );
}

#[test]
fn many_concurrent_cold_start_hooks_ask_for_one_daemon_start() {
    let env = Env::new("cold");
    std::fs::create_dir_all(&env.state).unwrap();
    let kicks = env.path("kicks");
    let e = env.script(
        "cold.sh",
        &format!(
            "cat >/dev/null\ncase \"$*\" in *ColdStartKick*) echo kick >>{}; exit 0;; esac\nexit 0",
            kicks.display()
        ),
    );
    let sock = env.state.join("e.sock");
    // the "daemon" comes up 400 ms after the first start request
    let kicks2 = kicks.clone();
    let daemon = std::thread::spawn(move || {
        assert!(wait_until(Duration::from_secs(5), || kicks2.exists()));
        std::thread::sleep(Duration::from_millis(400));
        let l = UnixListener::bind(&sock).unwrap();
        std::thread::sleep(Duration::from_secs(4));
        drop(l);
    });
    let mut handles = Vec::new();
    for i in 0..8 {
        let (envdir, root, home, engine_path) = (
            env.dir.clone(),
            env.root.clone(),
            env.home.clone(),
            e.clone(),
        );
        handles.push(std::thread::spawn(move || {
            let mut c = std::process::Command::new(env!("CARGO_BIN_EXE_ah-hook"));
            c.env_clear()
                .env("PATH", "/usr/bin:/bin")
                .env("HOME", &home)
                .env("AH_WRAPPER_TEST", "1")
                .env("AH_ENGINE_BIN", &engine_path)
                .arg("PreToolUse")
                .arg("--plugin-root")
                .arg(&root)
                .stdin(std::process::Stdio::piped())
                .stdout(std::process::Stdio::piped())
                .stderr(std::process::Stdio::piped());
            let _ = &envdir;
            let mut ch = c.spawn().unwrap();
            let mut si = ch.stdin.take().unwrap();
            let _ = si.write_all(format!("{{\"session_id\":\"s{i}\"}}").as_bytes());
            drop(si);
            ch.wait_with_output().unwrap().status.code()
        }));
    }
    let codes: Vec<_> = handles.into_iter().map(|h| h.join().unwrap()).collect();
    daemon.join().unwrap();
    assert!(codes.iter().all(|c| *c == Some(0)), "{codes:?}");
    assert_eq!(
        env.read("kicks").lines().count(),
        1,
        "one start request for eight cold hooks"
    );
}

#[test]
fn a_daemon_that_died_right_after_a_start_request_is_asked_for_again_at_once() {
    let env = Env::new("stale");
    std::fs::create_dir_all(&env.state).unwrap();
    let kicks = env.path("kicks");
    let e = env.script(
        "stale.sh",
        &format!(
            "cat >/dev/null\ncase \"$*\" in *ColdStartKick*) echo kick >>{}; exit 0;; esac\nexit 0",
            kicks.display()
        ),
    );
    // a start request only a moment old (younger than client.cold_guard_wait_ms) ...
    std::fs::write(
        env.state.join("launcher.spawns"),
        format!(
            "{}\n",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_millis()
        ),
    )
    .unwrap();
    std::thread::sleep(Duration::from_millis(20));
    // ... and the daemon it started has died since: its socket file (newer than the request) is left behind, nobody listens on it
    drop(UnixListener::bind(env.state.join("e.sock")).unwrap());
    let o = env.run("PreToolUse", PAYLOAD, Some(&e), &[]);
    assert_eq!(o.code, 0, "{}", o.err);
    assert_eq!(
        env.read("kicks").lines().count(),
        1,
        "a dead daemon is asked for at once, not waited for: {}",
        o.err
    );
}

#[test]
fn crash_loop_window_stops_the_start_requests() {
    let env = Env::new("loop");
    std::fs::create_dir_all(&env.state).unwrap();
    env.set("launcher.crashloop_max", "2");
    env.set("client.cold_guard_wait_ms", "1500");
    env.set("client.cold_guard_poll_ms", "50");
    let kicks = env.path("kicks");
    let e = env.script(
        "cold.sh",
        &format!(
            "cat >/dev/null\ncase \"$*\" in *ColdStartKick*) echo kick >>{}; exit 0;; esac\nexit 0",
            kicks.display()
        ),
    );
    for i in 0..5 {
        std::thread::sleep(Duration::from_millis(1600)); // each ask is no longer fresh
        let o = env.run(
            "PreToolUse",
            format!("{{\"session_id\":\"c{i}\"}}").as_bytes(),
            Some(&e),
            &[("AH_HOOK_TIMEOUT_S", "6"), ("AH_HOOK_TIMEOUT_MS", "800")],
        );
        assert_eq!(o.code, 0, "{}", o.err);
    }
    assert_eq!(
        env.read("kicks").lines().count(),
        2,
        "the window allows two starts, then the launcher stops asking"
    );
    assert!(
        env.diag().contains("kick_skipped=1") || env.log().contains("cold_kick_tripped"),
        "{}",
        env.log()
    );
}

// ---------------------------------------------------------------------------------------------------------------------------
// 6. telemetry rides in the request, no per-call file write
// ---------------------------------------------------------------------------------------------------------------------------

#[test]
fn counters_travel_to_the_engine_in_the_environment() {
    let env = Env::new("stats");
    let seen = env.path("stats");
    let e = env.script(
        "stats.sh",
        &format!(
            "cat >/dev/null\nprintf '%s' \"$AH_LAUNCHER_STATS\" >{}",
            seen.display()
        ),
    );
    let o = env.run("UserPromptSubmit", PAYLOAD, Some(&e), &[]);
    assert_eq!(o.code, 0);
    let s = env.read("stats");
    assert!(
        s.starts_with("v=1;")
            && s.contains(&format!("prefix={}", PAYLOAD.len()))
            && s.contains("host=claude"),
        "{s}"
    );
}

#[test]
fn a_successful_call_writes_no_launcher_file() {
    let env = Env::new("nowrite");
    let e = engine(&env, "echo ok; exit 0");
    for _ in 0..3 {
        let o = env.run("UserPromptSubmit", PAYLOAD, Some(&e), &[]);
        assert_eq!(o.code, 0);
    }
    let listing: Vec<String> = std::fs::read_dir(&env.state)
        .map(|d| {
            d.flatten()
                .map(|e| e.file_name().to_string_lossy().into_owned())
                .collect()
        })
        .unwrap_or_default();
    assert!(
        listing.iter().all(|n| !n.starts_with("launcher.")),
        "no per-call telemetry file: {listing:?}"
    );
}

#[test]
fn the_failure_path_appends_a_bounded_log_line() {
    let env = Env::new("faillog");
    let e = env.script("silent.sh", "cat >/dev/null\nexit 1"); // no done mark: an engine failure
    let o = env.run("UserPromptSubmit", PAYLOAD, Some(&e), &[]);
    assert_eq!(o.code, 0);
    assert!(env.log().contains("engine_silent_exit"), "{}", env.log());
}

#[test]
fn a_fail_open_the_engine_reported_in_its_reply_is_counted_and_logged() {
    let env = Env::new("foreply");
    // the engine client appends `reason=.. check=..` to the file the launcher named when the daemon's reply was a fail-open
    let e = env.script(
        "fo.sh",
        "cat >/dev/null\nprintf 'reason=deadline_cut check=agent-scan\\n' >> \"$AH_ENGINE_FAIL_OPEN_FILE\"\n: > \"$AH_ENGINE_DONE_FILE\"\nexit 0",
    );
    let o = env.run("UserPromptSubmit", PAYLOAD, Some(&e), &[]);
    assert_eq!(o.code, 0, "{}", o.err);
    assert!(
        env.log().contains("engine_fail_open") && env.log().contains("reason=deadline_cut"),
        "{}",
        env.log()
    );
    // and nothing is left behind in the run directory
    let quiet = env.script(
        "quiet.sh",
        "cat >/dev/null\n: > \"$AH_ENGINE_DONE_FILE\"\nexit 0",
    );
    let before = env.log();
    env.run("UserPromptSubmit", PAYLOAD, Some(&quiet), &[]);
    assert_eq!(
        env.log(),
        before,
        "a call that did not fail open adds nothing to the log"
    );
}

// ---------------------------------------------------------------------------------------------------------------------------
// 7. --selftest
// ---------------------------------------------------------------------------------------------------------------------------

fn selftest(env: &Env, engine: Option<&std::path::Path>) -> Out {
    let args: Vec<String> = engine
        .map(|e| vec!["--engine".to_string(), e.display().to_string()])
        .unwrap_or_default();
    let refs: Vec<&str> = args.iter().map(String::as_str).collect();
    env.run_args("--selftest", &refs, b"", None, &[])
}

#[test]
fn selftest_passes_with_good_config_engine_and_limits() {
    let env = Env::new("st-ok");
    let e = env.script("ver.sh", "echo ah-engine test-build");
    let o = selftest(&env, Some(&e));
    assert_eq!(o.code, 0, "{}", o.err);
    for check in ["config", "socket", "engine", "limits"] {
        assert!(o.err.contains(&format!("ok {check}")), "{}", o.err);
    }
}

#[test]
fn selftest_fails_for_each_kind_of_insanity() {
    let good = Env::new("st-good");
    let ok_engine = good.script("ver.sh", "echo v1");
    // missing engine binary
    assert_eq!(selftest(&good, Some(&good.path("no-such-engine"))).code, 1);
    // an engine whose version check fails
    let bad = good.script("bad.sh", "exit 3");
    let o = selftest(&good, Some(&bad));
    assert_eq!(o.code, 1);
    assert!(o.err.contains("FAIL engine"), "{}", o.err);
    // a hung engine is cut off by the selftest timeout
    good.set("launcher.selftest_engine_timeout_ms", "300");
    let hang = good.script("hang.sh", "sleep 30");
    let t = std::time::Instant::now();
    assert_eq!(selftest(&good, Some(&hang)).code, 1);
    assert!(t.elapsed() < Duration::from_secs(3));
    // not executable
    let plain = good.path("plain");
    std::fs::write(&plain, "x").unwrap();
    assert_eq!(selftest(&good, Some(&plain)).code, 1);
    // corrupt binary (not an executable format)
    let corrupt = good.script("corrupt.sh", "true");
    std::fs::write(&corrupt, b"\x7fELF-not-really\x00\x01\x02").unwrap();
    assert_eq!(selftest(&good, Some(&corrupt)).code, 1);

    // incoherent limits: soft above hard
    let e1 = Env::new("st-limits");
    e1.set("launcher.mem_soft_bytes", "99999999999");
    let eng = e1.script("ver.sh", "echo v1");
    let o = selftest(&e1, Some(&eng));
    assert_eq!(o.code, 1);
    assert!(o.err.contains("FAIL config"), "{}", o.err);
    // invalid TOML
    let e2 = Env::new("st-toml");
    e2.edit_toml("engine.toml", |_| "[[[ nope".into());
    let eng = e2.script("ver.sh", "echo v1");
    assert_eq!(selftest(&e2, Some(&eng)).code, 1);
    // socket path too long for sockaddr_un
    let e3 = Env::new("st-sock");
    let long = e3.dir.join("x".repeat(120));
    std::fs::create_dir_all(&long).unwrap();
    let eng = e3.script("ver.sh", "echo v1");
    let mut c = e3.command(
        "--selftest",
        &["--engine", &eng.display().to_string()],
        None,
        &[],
    );
    c.env("HOME", &long);
    let o = e3.run_with(c, |_| {});
    assert_eq!(o.code, 1);
    assert!(o.err.contains("FAIL socket"), "{}", o.err);
    // HOME unset: no state directory
    let mut c = e3.command(
        "--selftest",
        &["--engine", &eng.display().to_string()],
        None,
        &[],
    );
    c.env_remove("HOME");
    let o = e3.run_with(c, |_| {});
    assert_eq!(o.code, 1);
    assert!(o.err.contains("FAIL socket"), "{}", o.err);
    let _ = ok_engine;
}

// ---------------------------------------------------------------------------------------------------------------------------
// 8. a SIGKILLed launcher leaves no engine behind
// ---------------------------------------------------------------------------------------------------------------------------

#[test]
fn sigkilled_launcher_takes_its_hung_engine_and_run_dir_with_it() {
    let env = Env::new("orphan");
    let pid = env.path("pid");
    let e = engine(&env, &format!("echo $$ >{}\nexec sleep 120", pid.display()));
    let mut cmd = env.command(
        "UserPromptSubmit",
        &[],
        Some(&e),
        &[("AH_HOOK_TIMEOUT_MS", "60000")],
    );
    let mut child = env.spawn(&mut cmd);
    child.stdin.take().unwrap().write_all(PAYLOAD).unwrap();
    assert!(
        wait_until(Duration::from_secs(5), || pid_from(&pid).is_some()),
        "engine started"
    );
    let engine_pid = pid_from(&pid).unwrap();
    let run_dir = env
        .home
        .join(".anti-hall/tmp")
        .join(format!("ah-launch.{}", child.id()));
    assert!(
        run_dir.is_dir(),
        "the launcher's run dir exists while it runs"
    );
    // SAFETY: SIGKILL to the child we spawned.
    unsafe { libc::kill(child.id() as i32, libc::SIGKILL) };
    let _ = child.wait();
    assert!(
        wait_until(Duration::from_secs(3), || !alive(engine_pid)),
        "the hung engine was killed by the watcher"
    );
    assert!(
        wait_until(Duration::from_secs(3), || !run_dir.exists()),
        "the watcher removed the run dir"
    );
}

#[test]
fn a_normally_finished_call_leaves_no_watcher_kill_behind() {
    let env = Env::new("nokill");
    let e = engine(&env, "exit 0");
    let by = std::process::Command::new("sleep")
        .arg("30")
        .spawn()
        .unwrap(); // a bystander in its own group
    let o = env.run("UserPromptSubmit", PAYLOAD, Some(&e), &[]);
    assert_eq!(o.code, 0);
    std::thread::sleep(Duration::from_millis(300));
    assert!(
        alive(by.id() as i32),
        "the watcher stood down (D byte) and killed nothing"
    );
    let mut by = by;
    let _ = by.kill();
    let _ = by.wait();
}

// ---------------------------------------------------------------------------------------------------------------------------
// 9. the wait-marker race (LAUNCHER-RCA): a finished answer is never dropped, soft walls are per event
// ---------------------------------------------------------------------------------------------------------------------------

/// The engine writes its answer and the done mark, then drops the wait marker, then needs a while to exit (telemetry flush):
/// at the budget instant only the done mark exists. The launcher used to look for the wait marker alone, kill the engine and
/// drop the captured answer.
#[test]
fn a_done_mark_without_the_wait_marker_extends_the_budget_and_the_answer_is_delivered() {
    let env = Env::new("race");
    let e = engine(
        &env,
        ": >\"$AH_ENGINE_WAIT_FILE\"\nsleep 0.2\nprintf ANSWER\n: >\"$AH_ENGINE_DONE_FILE\"\nrm -f \"$AH_ENGINE_WAIT_FILE\"\nsleep 0.8\nexit 0",
    );
    let o = env.run(
        "SessionStart",
        PAYLOAD,
        Some(&e),
        &[("AH_HOOK_TIMEOUT_MS", "700")],
    );
    assert_eq!(
        (o.code, o.out.as_slice()),
        (0, b"ANSWER".as_slice()),
        "{}",
        env.log()
    );
    assert!(
        !env.log().contains("engine_timed") && !env.diag().contains("engine_timed"),
        "no timeout may be logged for a call that answered: {} {}",
        env.log(),
        env.diag()
    );
}

/// An engine that answered but does not leave before the hard deadline is cut, and what it printed is still delivered.
#[test]
fn an_answered_engine_cut_at_the_hard_deadline_still_delivers_its_output() {
    let env = Env::new("race-cut");
    let e = engine(
        &env,
        "printf ANSWER\n: >\"$AH_ENGINE_DONE_FILE\"\nexec sleep 60",
    );
    let o = env.run(
        "SessionStart",
        PAYLOAD,
        Some(&e),
        &[
            ("AH_HOOK_TIMEOUT_MS", "1500"),
            ("AH_ENGINE_SLOW_FALLBACK_MAX_MS", "2500"),
        ],
    );
    assert_eq!(
        (o.code, o.out.as_slice()),
        (0, b"ANSWER".as_slice()),
        "{}",
        env.log()
    );
    assert!(!env.log().contains("engine_timed"), "{}", env.log());
}

/// No marker at all: the call is cut at the budget, and the log line now says how long the launcher had run.
#[test]
fn engine_timed_logs_the_wall_time() {
    let env = Env::new("timed-wall");
    let e = engine(&env, "exec sleep 60");
    let o = env.run(
        "UserPromptSubmit",
        PAYLOAD,
        Some(&e),
        &[("AH_HOOK_TIMEOUT_MS", "400")],
    );
    assert_eq!(o.code, 0);
    let log = env.log();
    let line = log
        .lines()
        .find(|l| l.contains("engine_timed"))
        .unwrap_or_else(|| panic!("no engine_timed line: {log}"));
    let wall: u128 = line
        .split("wall_ms=")
        .nth(1)
        .and_then(|r| r.split_whitespace().next())
        .and_then(|n| n.parse().ok())
        .unwrap_or_else(|| panic!("no wall_ms in {line}"));
    assert!((400..4000).contains(&wall), "{line}");
}

/// `launcher.wall_soft_ms` is a per-event table: an event with an entry is judged against it, an event without one against the
/// `default` (0 = the fail-fast formula), and the soft_limit line carries the wall time.
#[test]
fn the_soft_wall_is_a_per_event_table_and_logs_the_wall_time() {
    let env = Env::new("soft-table");
    env.set(
        "launcher.wall_soft_ms",
        "{ default = 0, SessionStart = 50, SessionEnd = 99999 }",
    );
    let e = engine(&env, "sleep 0.3\n: >\"$AH_ENGINE_DONE_FILE\"\nexit 0");
    for ev in ["SessionStart", "SessionEnd", "UserPromptSubmit"] {
        env.run(ev, PAYLOAD, Some(&e), &[]);
    }
    let log = env.log();
    let soft: Vec<&str> = log.lines().filter(|l| l.contains("soft_limit")).collect();
    assert_eq!(
        soft.len(),
        1,
        "only SessionStart is over its soft wall: {log}"
    );
    assert!(
        soft[0].contains("event=SessionStart") && soft[0].contains("wall_ms="),
        "{log}"
    );
}

#[test]
fn plugin_root_reaches_the_engine_in_canonical_form() {
    // #64: the hook client's defaults cache holds ONE plugin root; two spellings of the same root (the shim's fork-free
    // `<hooks>/..` and a resolved path) would make every other call miss the cache and re-parse every TOML file
    let env = Env::new("canon");
    let seen = env.path("root");
    let e = env.script(
        "root.sh",
        &format!(
            "cat >/dev/null\nprintf '%s' \"$AH_ENGINE_PLUGIN_ROOT\" >{}\nexit 0",
            seen.display()
        ),
    );
    let spelled = format!("{}/hooks/..", env.root.display());
    let mut c = std::process::Command::new(env!("CARGO_BIN_EXE_ah-hook"));
    c.env_clear()
        .env("PATH", "/usr/bin:/bin")
        .env("HOME", &env.home)
        .env("AH_WRAPPER_TEST", "1")
        .env("AH_HOOK_TIMEOUT_MS", "8000")
        .env("AH_ENGINE_BIN", &e)
        .args(["PostToolUse", "--plugin-root", &spelled]); // not a guard event: no cold-start wait for a daemon
    let o = env.run_with(c, |mut si| {
        let _ = si.write_all(PAYLOAD);
    });
    assert_eq!(o.code, 0, "{}", o.err);
    let want = std::fs::canonicalize(&env.root).unwrap();
    assert_eq!(
        env.read("root"),
        want.display().to_string(),
        "stderr: {} log: {}",
        o.err,
        env.log()
    );
}

/// Linux commonly has no TMPDIR; a broken HOME must still leave the wait/done marker channel available.
#[test]
fn an_unusable_home_without_tmpdir_keeps_the_slow_reply_and_done_mark() {
    let env = Env::new("no-tmpdir");
    let homefile = env.path("homefile");
    std::fs::write(&homefile, b"not a directory").unwrap();
    let home = homefile.join("h");
    let e = engine(
        &env,
        ": >\"$AH_ENGINE_WAIT_FILE\"\nsleep 1\nprintf ANSWER\n: >\"$AH_ENGINE_DONE_FILE\"\nexit 1",
    );
    let mut c = env.command(
        "UserPromptSubmit",
        &[],
        Some(&e),
        &[("AH_HOOK_TIMEOUT_MS", "500")],
    );
    c.env("HOME", &home).env_remove("TMPDIR");
    let o = env.run_with(c, |mut si| si.write_all(PAYLOAD).unwrap());
    assert_eq!(
        (o.code, o.out.as_slice()),
        (1, b"ANSWER".as_slice()),
        "{}",
        o.err
    );
}
