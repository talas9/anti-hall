//! `ah-hook <verb> [args...]`: the thin client runs `ah-engine <verb> [args...]` by exec. Scratch HOME and plugin root only.
#![allow(clippy::unwrap_used, clippy::expect_used)]

mod common;
use common::Env;
use std::process::Command;

fn engine(e: &Env) -> std::path::PathBuf {
    // names its arguments and the plugin root it was given, echoes stdin, exits 3
    e.script(
        "eng",
        "printf 'ENGINE[%s] root=%s\\n' \"$*\" \"${AH_ENGINE_PLUGIN_ROOT:-}\"\ncat\nexit 3",
    )
}

#[test]
fn a_verb_is_the_engines_command_with_its_exit_and_stdin() {
    let e = Env::new("cli-verb");
    let eng = engine(&e);
    let o = e.run_args("settings", &["show", "--json"], b"{\"a\":1}\n", Some(&eng), &[]);
    let out = String::from_utf8_lossy(&o.out);
    assert_eq!(o.code, 3, "{}", o.err);
    assert!(out.starts_with("ENGINE[settings show --json] root="), "{out}");
    assert!(out.ends_with("{\"a\":1}\n"), "stdin reaches the engine unchanged: {out}");
    assert!(!out.contains("--plugin-root"), "the shim's root pair is not forwarded: {out}");
    let root = std::fs::canonicalize(&e.root).unwrap();
    assert!(out.contains(&format!("root={}", root.display())), "{out}");
}

#[test]
fn an_explicit_plugin_root_override_is_kept() {
    let e = Env::new("cli-root");
    let eng = engine(&e);
    let o = e.run_args("defect", &["list"], b"", Some(&eng), &[("AH_ENGINE_PLUGIN_ROOT", "/elsewhere")]);
    assert!(String::from_utf8_lossy(&o.out).contains("root=/elsewhere\n"), "{} {}", String::from_utf8_lossy(&o.out), o.err);
}

#[test]
fn the_root_may_come_first() {
    let e = Env::new("cli-first");
    let eng = engine(&e);
    let mut c = Command::new(env!("CARGO_BIN_EXE_ah-hook"));
    c.env_clear()
        .env("PATH", "/usr/bin:/bin")
        .env("HOME", &e.home)
        .env("AH_WRAPPER_TEST", "1")
        .env("AH_ENGINE_BIN", &eng)
        .arg("--plugin-root")
        .arg(&e.root)
        .args(["jev-setup", "status"]);
    let o = e.run_with(c, |_| {});
    assert_eq!(o.code, 3, "{}", o.err);
    assert!(String::from_utf8_lossy(&o.out).starts_with("ENGINE[jev-setup status] "));
}

#[test]
fn without_an_engine_nothing_runs_and_the_exit_is_the_configured_one() {
    let e = Env::new("cli-none");
    let o = e.run_args("harvest", &["--dir", "/x"], b"", None, &[]);
    assert_eq!(o.code, 127, "{}", o.err);
    assert!(o.out.is_empty());
    assert!(o.err.contains("`harvest` did not run"), "{}", o.err);
    e.set("launcher.cli_no_engine_exit", "9");
    assert_eq!(e.run_args("harvest", &[], b"", None, &[]).code, 9);
}

#[test]
fn an_unrunnable_engine_is_reported_the_same_way() {
    let e = Env::new("cli-bad");
    let bad = e.path("bad-engine");
    std::fs::write(&bad, b"#!/nonexistent/interpreter\n").unwrap(); // execve fails (ENOENT)
    std::fs::set_permissions(&bad, std::os::unix::fs::PermissionsExt::from_mode(0o755)).unwrap();
    let o = e.run_args("settings", &[], b"", Some(&bad), &[]);
    assert_eq!(o.code, 127, "{}", o.err);
    assert!(o.err.contains("`settings` did not run"), "{}", o.err);
}

#[test]
fn the_engine_gets_signals_and_no_launcher_cpu_limit() {
    let e = Env::new("cli-sig");
    // a TERM blocked by the launcher would stay pending and the script would print "survived"
    let eng = e.script("eng", "ulimit -t\nkill -TERM $$\nsleep 1\necho survived");
    let o = e.run_args("status", &[], b"", Some(&eng), &[]);
    let out = String::from_utf8_lossy(&o.out);
    assert!(!out.contains("survived"), "SIGTERM was blocked in the engine: {out}");
    assert_eq!(o.code, -1, "the engine died by SIGTERM: {out} {}", o.err);
    let limit = out.lines().next().unwrap_or_default();
    let mine = String::from_utf8_lossy(&Command::new("sh").args(["-c", "ulimit -t"]).output().unwrap().stdout).trim().to_string();
    assert_eq!(limit, mine, "the engine runs with the CPU limit the launcher was started with");
}

#[test]
fn events_still_go_to_the_hook_path() {
    let e = Env::new("cli-event");
    let eng = e.script("eng", "printf '%s' \"$*\"");
    let o = e.run("UserPromptSubmit", b"{}", Some(&eng), &[]);
    assert_eq!(String::from_utf8_lossy(&o.out), "hook --event UserPromptSubmit --host claude");
    e.set("launcher.cli_lowercase_verbs", "0");
    let o = e.run("settings", b"{}", Some(&eng), &[]);
    assert_eq!(String::from_utf8_lossy(&o.out), "hook --event settings --host claude", "with the switch off every word is an event");
}

#[test]
fn the_test_only_engine_override_is_ignored_without_the_test_flag() {
    let e = Env::new("cli-knob");
    let eng = engine(&e);
    let o = e.run_args("statusline", &[], b"z", Some(&eng), &[("AH_WRAPPER_TEST", "0")]);
    assert_eq!(o.code, 127, "a stray AH_ENGINE_BIN must not replace the engine: {}", o.err);
    assert!(o.out.is_empty());
}
