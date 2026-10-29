//! The edge-case table of THIN-LAUNCHER.md, one test per row (scenario -> behaviour). The test name is the row's key.

mod common;

use common::*;
use std::io::Write;
use std::os::unix::fs::PermissionsExt;
use std::os::unix::net::UnixListener;
use std::time::Duration;

const PAYLOAD: &[u8] = b"{\"session_id\":\"s-1\",\"tool_name\":\"Bash\"}";

fn engine(env: &Env, body: &str) -> std::path::PathBuf {
    let args = env.path("args");
    env.script(
        "engine.sh",
        &format!(
            "echo \"$*\" >>{}\ncat >{}\n{body}",
            args.display(),
            env.path("payload").display()
        ),
    )
}

/// A guard-event engine that records start requests and stays cold (never makes a socket).
fn cold_engine(env: &Env) -> std::path::PathBuf {
    env.script(
        "cold.sh",
        &format!(
            "cat >/dev/null\ncase \"$*\" in *ColdStartKick*) echo kick >>{}; exit 0;; esac\nexit 0",
            env.path("kicks").display()
        ),
    )
}

fn quick_cold(env: &Env) {
    std::fs::create_dir_all(&env.state).unwrap();
    env.set("client.cold_guard_wait_ms", "2500");
    env.set("client.cold_guard_poll_ms", "50");
}

// ---- the engine binary ----------------------------------------------------------------------------------------------------

#[test]
fn engine_missing_passes_through_logs_and_tells_the_session_once() {
    let env = Env::new("e-missing");
    let o = env.run("PreToolUse", PAYLOAD, None, &[]);
    assert_eq!((o.code, o.out.len()), (0, 0), "{}", o.err);
    assert!(env.log().contains("engine_missing"), "{}", env.log());
    // #229: an unreachable engine is never silent: the session hears it once (the C9 notice), the call still passes through
    assert!(
        o.err.contains("did not answer this PreToolUse call")
            && o.err.contains("went through unchecked"),
        "{}",
        o.err
    );
    let again = env.run("PreToolUse", PAYLOAD, None, &[]);
    assert_eq!(again.code, 0);
    assert!(
        again.err.is_empty(),
        "the same session is told once: {}",
        again.err
    );
}

#[test]
fn a_fresh_daemon_down_marker_passes_through_and_tells_the_session_once() {
    let env = Env::new("e-down-marker");
    let p = engine(&env, "echo should-not-run");
    let until = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis()
        + 60_000;
    std::fs::create_dir_all(&env.state).unwrap();
    std::fs::write(env.state.join("daemon.down.until"), until.to_string()).unwrap();
    let o = env.run("PreToolUse", PAYLOAD, Some(&p), &[]);
    assert_eq!((o.code, o.out.len()), (0, 0), "{}", o.err);
    assert!(
        o.err.contains("did not answer this PreToolUse call")
            && o.err.contains("went through unchecked"),
        "{}",
        o.err
    );
    let again = env.run("PreToolUse", PAYLOAD, Some(&p), &[]);
    assert!(
        again.err.is_empty(),
        "the same session is told once: {}",
        again.err
    );
}

#[test]
fn engine_not_executable_is_treated_as_missing() {
    let env = Env::new("e-noexec");
    let p = env.path("engine");
    std::fs::write(&p, "#!/bin/sh\nexit 2\n").unwrap();
    std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o644)).unwrap();
    let o = env.run("PreToolUse", PAYLOAD, Some(&p), &[]);
    assert_eq!(o.code, 0, "{}", o.err);
    assert!(env.log().contains("engine_missing"));
}

#[test]
fn engine_corrupt_cannot_start_fails_open_and_logs_the_errno() {
    let env = Env::new("e-corrupt");
    let p = env.path("engine");
    std::fs::write(&p, format!("touch {}\n", env.path("ran").display())).unwrap(); // would create the file if run as a shell script
    std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o755)).unwrap();
    let o = env.run("PreToolUse", PAYLOAD, Some(&p), &[]);
    assert_eq!((o.code, o.out.len()), (0, 0), "{}", o.err);
    assert!(
        env.log().contains("engine_spawn_failed") && env.log().contains("errno=8"),
        "{}",
        env.log()
    );
}

#[test]
fn engine_hung_is_killed_and_the_hook_fails_open() {
    let env = Env::new("e-hung");
    let e = engine(&env, "exec sleep 60");
    let o = env.run(
        "UserPromptSubmit",
        PAYLOAD,
        Some(&e),
        &[("AH_HOOK_TIMEOUT_MS", "800")],
    );
    assert_eq!(o.code, 0);
    assert!(o.ms < 4000, "ms={}", o.ms);
}

#[test]
fn engine_sigstopped_is_killed_with_sigkill() {
    let env = Env::new("e-stop");
    let e = engine(&env, "kill -STOP $$\nexit 0");
    let o = env.run(
        "UserPromptSubmit",
        PAYLOAD,
        Some(&e),
        &[("AH_HOOK_TIMEOUT_MS", "800")],
    );
    assert_eq!(o.code, 0);
    assert!(o.ms < 4000, "ms={}", o.ms);
}

// ---- the daemon socket ------------------------------------------------------------------------------------------------------

#[test]
fn stale_socket_file_counts_as_cold_and_asks_for_one_start() {
    let env = Env::new("sock-stale");
    quick_cold(&env);
    drop(UnixListener::bind(env.state.join("e.sock")).unwrap()); // the file stays, nobody listens (ECONNREFUSED)
    let e = cold_engine(&env);
    let o = env.run(
        "PreToolUse",
        PAYLOAD,
        Some(&e),
        &[("AH_HOOK_TIMEOUT_MS", "1000")],
    );
    assert_eq!(o.code, 0, "{}", o.err);
    assert_eq!(
        env.read("kicks").lines().count(),
        1,
        "a stale socket is no daemon: one start request"
    );
    assert!(
        o.err.contains("was not checked"),
        "gave up at the cap with the notice: {}",
        o.err
    );
}

#[test]
fn absent_socket_counts_as_cold_and_asks_for_one_start() {
    let env = Env::new("sock-absent");
    quick_cold(&env);
    let e = cold_engine(&env);
    let o = env.run(
        "PreToolUse",
        PAYLOAD,
        Some(&e),
        &[("AH_HOOK_TIMEOUT_MS", "1000")],
    );
    assert_eq!(o.code, 0, "{}", o.err);
    assert_eq!(env.read("kicks").lines().count(), 1);
}

#[test]
fn live_socket_means_no_start_request_and_the_engine_decides() {
    let env = Env::new("sock-live");
    quick_cold(&env);
    let _daemon = UnixListener::bind(env.state.join("e.sock")).unwrap();
    let e = env.script("block.sh", &format!("cat >/dev/null\ncase \"$*\" in *ColdStartKick*) echo kick >>{}; exit 0;; esac\necho no >&2\nexit 2", env.path("kicks").display()));
    let o = env.run(
        "PreToolUse",
        PAYLOAD,
        Some(&e),
        &[("AH_HOOK_TIMEOUT_MS", "1000")],
    );
    assert_eq!((o.code, o.err.trim()), (2, "no"));
    assert_eq!(env.read("kicks"), "");
}

#[test]
fn stale_pid_file_is_ignored() {
    let env = Env::new("pid-stale");
    std::fs::create_dir_all(&env.state).unwrap();
    std::fs::write(env.state.join("e.pid"), "999999\n").unwrap();
    std::fs::write(env.state.join("daemon.pid"), "999998\n").unwrap();
    let e = engine(&env, "echo fine");
    let o = env.run("UserPromptSubmit", PAYLOAD, Some(&e), &[]);
    assert_eq!(
        (o.code, String::from_utf8_lossy(&o.out).trim().to_string()),
        (0, "fine".into())
    );
}

#[test]
fn two_daemons_one_live_socket_and_one_stale_pid_start_nothing_more() {
    let env = Env::new("two-daemons");
    quick_cold(&env);
    let _live = UnixListener::bind(env.state.join("e.sock")).unwrap();
    std::fs::write(env.state.join("e.pid"), "999999\n").unwrap(); // a second, dead daemon's pid
    let e = cold_engine(&env);
    for _ in 0..3 {
        let o = env.run(
            "PreToolUse",
            PAYLOAD,
            Some(&e),
            &[("AH_HOOK_TIMEOUT_MS", "1000")],
        );
        assert_eq!(o.code, 0);
    }
    assert_eq!(
        env.read("kicks"),
        "",
        "a live socket is answered by exactly the daemon that owns it; the launcher starts nothing"
    );
}

// ---- the payload ------------------------------------------------------------------------------------------------------------

#[test]
fn stdin_closed_early_by_the_host_passes_what_arrived() {
    let env = Env::new("early");
    let e = engine(&env, "exit 0");
    let o = env.run("UserPromptSubmit", b"{\"truncated\":\"", Some(&e), &[]);
    assert_eq!(o.code, 0);
    assert_eq!(env.read("payload"), "{\"truncated\":\"");
}

#[test]
fn stdin_fd_closed_entirely_is_an_empty_payload() {
    let env = Env::new("nofd0");
    let e = engine(&env, "exit 0");
    let c0 = env.command("UserPromptSubmit", &[], Some(&e), &[]);
    let mut c = std::process::Command::new("sh");
    let line: Vec<String> = std::iter::once(c0.get_program().to_string_lossy().into_owned())
        .chain(c0.get_args().map(|a| a.to_string_lossy().into_owned()))
        .map(|w| format!("'{w}'"))
        .collect();
    c.arg("-c")
        .arg(format!("exec {} <&-", line.join(" ")))
        .env_clear();
    for (k, v) in c0.get_envs() {
        if let Some(v) = v {
            c.env(k, v);
        }
    }
    let o = env.run_with(c, |_| {});
    assert_eq!(o.code, 0, "{}", o.err);
    assert_eq!(
        std::fs::metadata(env.path("payload"))
            .map(|m| m.len())
            .unwrap_or(0),
        0
    );
}

// ---- the host's output side -------------------------------------------------------------------------------------------------

#[test]
fn stdout_epipe_keeps_the_engines_exit_code_a_block_still_blocks() {
    let env = Env::new("epipe");
    for (code, body) in [
        (
            0,
            "sleep 0.4\nhead -c 200000 /dev/zero | tr '\\0' x\nexit 0",
        ),
        (
            2,
            "sleep 0.4\nhead -c 200000 /dev/zero | tr '\\0' x\necho why >&2\nexit 2",
        ),
    ] {
        let e = engine(&env, body);
        let mut cmd = env.command("UserPromptSubmit", &[], Some(&e), &[]);
        let mut child = env.spawn(&mut cmd);
        child.stdin.take().unwrap().write_all(PAYLOAD).unwrap();
        drop(child.stdout.take()); // the host closed its end of the pipe: the launcher's write gets EPIPE
        let st = child.wait().unwrap();
        assert_eq!(
            st.code(),
            Some(code),
            "exit {code} survives a broken stdout"
        );
    }
}

// ---- the environment --------------------------------------------------------------------------------------------------------

#[test]
fn home_unset_still_runs_the_engine_and_passes_its_block() {
    let env = Env::new("nohome");
    let e = engine(&env, "echo no >&2\nexit 2");
    let mut c = env.command("PreToolUse", &[], Some(&e), &[]);
    c.env_remove("HOME");
    let o = env.run_with(c, |mut si| {
        let _ = si.write_all(PAYLOAD);
    });
    assert_eq!((o.code, o.err.trim()), (2, "no"));
}

#[test]
fn home_unwritable_still_runs_the_engine() {
    let env = Env::new("rohome");
    std::fs::set_permissions(&env.home, std::fs::Permissions::from_mode(0o500)).unwrap();
    let e = engine(&env, "echo no >&2\nexit 2");
    let o = env.run("PreToolUse", PAYLOAD, Some(&e), &[]);
    std::fs::set_permissions(&env.home, std::fs::Permissions::from_mode(0o700)).unwrap();
    assert_eq!(
        (o.code, o.err.trim()),
        (2, "no"),
        "an unwritable home removes the markers, not the guard"
    );
}

#[test]
fn log_write_failure_never_changes_the_outcome() {
    let env = Env::new("logfail");
    std::fs::create_dir_all(env.state.join("launcher.log")).unwrap(); // opening the log for append fails (a directory)
    if std::path::Path::new("/dev/full").exists() {
        let _ = std::fs::remove_dir_all(env.state.join("launcher.log"));
        std::os::unix::fs::symlink("/dev/full", env.state.join("launcher.log")).unwrap(); // every write fails with ENOSPC
    }
    let e = env.script("silent.sh", "cat >/dev/null\nexit 1"); // an engine failure: the failure path tries to log
    let o = env.run("UserPromptSubmit", PAYLOAD, Some(&e), &[]);
    assert_eq!((o.code, o.out.len()), (0, 0), "{}", o.err);
    // only the engine-unreachable notice reaches the host: a log that cannot be written adds nothing
    assert_eq!(o.err.lines().count(), 1, "{}", o.err);
    assert!(o.err.contains("did not answer"), "{}", o.err);
}

#[test]
fn test_knobs_are_ignored_without_the_test_flag() {
    let env = Env::new("noflag");
    let e = engine(&env, "echo from-test-engine\nexit 2");
    let mut c = env.command("PreToolUse", &[], Some(&e), &[]);
    c.env_remove("AH_WRAPPER_TEST");
    let o = env.run_with(c, |mut si| {
        let _ = si.write_all(PAYLOAD);
    });
    assert_eq!(o.code, 0, "the replaced engine was not honoured");
    assert!(
        o.err.contains("ignoring test-only variables") && o.err.contains("AH_ENGINE_BIN"),
        "{}",
        o.err
    );
}

// ---- events and hosts -------------------------------------------------------------------------------------------------------

#[test]
fn unknown_event_is_passed_to_the_engine_which_decides() {
    let env = Env::new("unknown-ev");
    let e = engine(&env, "echo handled\nexit 0");
    let o = env.run("SomeEventFromTheFuture", PAYLOAD, Some(&e), &[]);
    assert_eq!(
        (o.code, String::from_utf8_lossy(&o.out).trim().to_string()),
        (0, "handled".into())
    );
    assert!(
        env.read("args").contains("--event SomeEventFromTheFuture"),
        "{}",
        env.read("args")
    );
}

#[test]
fn codex_and_claude_hosts_reach_the_engine_with_their_own_host_word() {
    let env = Env::new("hosts");
    let e = engine(&env, "exit 0");
    env.run("UserPromptSubmit", PAYLOAD, Some(&e), &[]);
    env.run_args(
        "UserPromptSubmit",
        &["--host", "codex"],
        PAYLOAD,
        Some(&e),
        &[],
    );
    let o = env.run_args(
        "UserPromptSubmit",
        &["--host", "weird"],
        PAYLOAD,
        Some(&e),
        &[],
    );
    assert!(o.err.contains("unknown --host"), "{}", o.err);
    let lines: Vec<String> = env.read("args").lines().map(String::from).collect();
    assert!(
        lines[0].contains("--host claude") && !lines[0].contains("fallback"),
        "{}",
        lines[0]
    );
    assert!(
        lines[1].contains("--host codex") && !lines[1].contains("fallback"),
        "{}",
        lines[1]
    );
    assert!(
        lines[2].contains("--host claude"),
        "an unknown host falls back to the default: {}",
        lines[2]
    );
}

// ---- the settings files -----------------------------------------------------------------------------------------------------

#[test]
fn toml_missing_runs_on_the_builtin_copy() {
    let env = Env::new("toml-missing");
    let _ = std::fs::remove_dir_all(env.root.join("engine"));
    let e = engine(&env, "echo no >&2\nexit 2");
    let o = env.run("PreToolUse", PAYLOAD, Some(&e), &[]);
    assert_eq!(
        (o.code, o.err.trim()),
        (2, "no"),
        "the guard still works with no settings files"
    );
    assert!(env.diag().contains("config_fallback=1"), "{}", env.diag());
    // and a guard event still fails closed on a bad budget knob, from the built-in guard list
    let o = env.run(
        "PreToolUse",
        PAYLOAD,
        Some(&e),
        &[("AH_HOOK_TIMEOUT_S", "junk")],
    );
    assert_eq!(o.code, 2, "{}", o.err);
    assert!(o.err.contains("fail closed"), "{}", o.err);
}

#[test]
fn toml_invalid_uses_the_builtin_values_for_that_file_only() {
    let env = Env::new("toml-invalid");
    env.edit_toml("dispatch.toml", |_| "[[[ this is not toml".into());
    env.set("launcher.stdin_hard_bytes", "2097152"); // engine.toml is fine and still honoured
    let e = engine(&env, "exit 0");
    let o = env.run(
        "UserPromptSubmit",
        &pattern(4 << 20),
        Some(&e),
        &[("AH_HOOK_TIMEOUT_MS", "5000")],
    );
    assert_eq!(o.code, 0, "{}", o.err);
    assert_eq!(
        std::fs::metadata(env.path("payload")).unwrap().len(),
        2 << 20,
        "the valid file's value is used"
    );
    assert!(
        env.log().contains("defaults file unusable") && env.log().contains("dispatch.toml"),
        "{}",
        env.log()
    );
    let o = env.run(
        "PreToolUse",
        PAYLOAD,
        Some(&e),
        &[("AH_HOOK_TIMEOUT_S", "junk")],
    );
    assert_eq!(
        o.code, 2,
        "the guard list comes from the built-in copy: {}",
        o.err
    );
}

#[test]
fn toml_value_of_the_wrong_type_falls_back_for_that_key_only() {
    let env = Env::new("toml-type");
    env.set("launcher.payload_prefix_bytes", "\"lots\"");
    env.set("launcher.stdin_hard_bytes", "1048576");
    let e = engine(&env, "exit 0");
    let o = env.run(
        "UserPromptSubmit",
        &pattern(3 << 20),
        Some(&e),
        &[("AH_HOOK_TIMEOUT_MS", "5000")],
    );
    assert_eq!(o.code, 0, "{}", o.err);
    assert_eq!(
        std::fs::metadata(env.path("payload")).unwrap().len(),
        1 << 20
    );
}

#[test]
fn many_launchers_at_once_do_not_corrupt_each_other() {
    let env = Env::new("parallel");
    let e = env.script("ok.sh", "cat >/dev/null\necho ok\nexit 0");
    let mut hs = Vec::new();
    for i in 0..12 {
        let (home, root, e) = (env.home.clone(), env.root.clone(), e.clone());
        hs.push(std::thread::spawn(move || {
            let o = std::process::Command::new(env!("CARGO_BIN_EXE_ah-hook"))
                .env_clear()
                .env("PATH", "/usr/bin:/bin")
                .env("HOME", home)
                .env("AH_WRAPPER_TEST", "1")
                .env("AH_ENGINE_BIN", e)
                .env("AH_HOOK_TIMEOUT_MS", "8000")
                .args(["UserPromptSubmit", "--plugin-root"])
                .arg(root)
                .stdin(std::process::Stdio::piped())
                .stdout(std::process::Stdio::piped())
                .spawn()
                .map(|mut c| {
                    let mut si = c.stdin.take().unwrap();
                    let _ = si.write_all(format!("{{\"n\":{i}}}").as_bytes());
                    drop(si);
                    c.wait_with_output().unwrap()
                })
                .unwrap();
            (
                o.status.code(),
                String::from_utf8_lossy(&o.stdout).trim().to_string(),
            )
        }));
    }
    for h in hs {
        assert_eq!(h.join().unwrap(), (Some(0), "ok".to_string()));
    }
    std::thread::sleep(Duration::from_millis(100));
}

/// #231: interleaved sessions each hear the unreachable notice once; B no longer overwrites A's record.
#[test]
fn interleaved_sessions_each_hear_the_unreachable_notice_once() {
    let env = Env::new("e-interleave");
    let pay = |s: &str| format!("{{\"session_id\":\"{s}\",\"tool_name\":\"Bash\",\"tool_input\":{{\"command\":\"ls\"}}}}");
    let says = |s: &str| env.run("PreToolUse", pay(s).as_bytes(), None, &[]).err.contains("went through unchecked");
    assert!(says("sess-a"), "A first failure is told");
    assert!(says("sess-b"), "B first failure is told");
    assert!(!says("sess-a"), "A second failure stays silent after B interleaved");
    assert!(!says("sess-b"), "B second failure stays silent");
    // the set is bounded: with a cap of 2, a third session pushes the oldest out
    env.set("launcher.notice_sessions_max", "2");
    assert!(says("sess-c"), "C is told");
    assert!(says("sess-a"), "A was evicted by the cap, so it hears the notice again");
    assert!(!says("sess-c"), "C is still remembered");
}
