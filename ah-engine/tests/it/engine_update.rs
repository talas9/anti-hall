//! `engine-update` (issue #140) only hands the arguments to the thin client's updater (`ah-hook update`); the engine has no network code.
use std::process::Command;

const BIN: &str = env!("CARGO_BIN_EXE_ah-engine");

/// The built thin client (`ah-launcher`): AH_HOOK_BIN, else its release or debug build in this checkout.
fn launcher_bin() -> std::path::PathBuf {
    if let Some(p) = std::env::var_os("AH_HOOK_BIN").map(std::path::PathBuf::from).filter(|p| p.is_file()) {
        return p;
    }
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap().join("ah-launcher/target");
    ["release", "debug"]
        .iter()
        .map(|b| root.join(b).join("ah-hook"))
        .find(|p| p.is_file())
        .expect("no ah-hook binary: build ah-launcher (cargo build in ah-launcher/) or set AH_HOOK_BIN")
}

fn scratch_root(name: &str) -> std::path::PathBuf {
    let root = std::env::temp_dir().join(format!("ah-engine-update-it-{}-{name}", std::process::id()));
    std::fs::create_dir_all(root.join("hooks")).unwrap();
    // the engine reads its defaults from the plugin root: link the real ones
    let engine = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../plugins/anti-hall/engine");
    #[cfg(unix)]
    std::os::unix::fs::symlink(engine.canonicalize().unwrap(), root.join("engine")).unwrap();
    root
}

fn run(root: &std::path::Path, args: &[&str]) -> (i32, String, String) {
    let home = root.join("home");
    std::fs::create_dir_all(&home).unwrap();
    let out = Command::new(BIN)
        .arg("engine-update")
        .args(args)
        .env("HOME", &home)
        .env("AH_ENGINE_DIR", root.join("state"))
        .env("AH_ENGINE_PLUGIN_ROOT", root)
        .env("AH_ENGINE_NOSPAWN", "1")
        .output()
        .unwrap();
    (out.status.code().unwrap_or(-1), String::from_utf8_lossy(&out.stdout).into_owned(), String::from_utf8_lossy(&out.stderr).into_owned())
}

#[test]
fn hands_the_arguments_to_the_thin_client_and_returns_its_exit_code() {
    let root = scratch_root("args");
    let client = root.join("state/bin/ah-hook");
    std::fs::create_dir_all(client.parent().unwrap()).unwrap();
    std::fs::write(&client, "#!/bin/sh\necho \"args: $*\"\nexit 7\n").unwrap();
    std::fs::set_permissions(&client, std::os::unix::fs::PermissionsExt::from_mode(0o755)).unwrap();
    let (code, out, _) = run(&root, &["--channel", "dev", "--dry-run"]);
    assert_eq!(code, 7);
    assert!(out.contains("update --channel dev --dry-run"), "{out}");
    std::fs::remove_dir_all(&root).ok();
}

#[test]
fn a_missing_thin_client_is_reported_and_fails() {
    let root = scratch_root("missing");
    let (code, _, err) = run(&root, &["--auto"]);
    assert_eq!(code, 1);
    assert!(err.contains("the thin client is not installed"), "{err}");
    three_parts(&err);
    std::fs::remove_dir_all(&root).ok();
}

/// Every failure message says what failed, the state it left, and one next step (#143).
fn three_parts(msg: &str) {
    let lines: Vec<&str> = msg.lines().collect();
    assert!(lines.first().is_some_and(|l| l.starts_with("engine-update: ") && l.len() > "engine-update: ".len()), "what failed: {msg}");
    assert!(lines.iter().any(|l| l.starts_with("  state: ") && l.len() > "  state: ".len()), "current state: {msg}");
    assert!(lines.iter().any(|l| l.starts_with("  next: ") && l.len() > "  next: ".len()), "next step: {msg}");
}

#[test]
fn every_failure_message_of_the_verb_says_what_failed_the_state_and_the_next_step() {
    ah_engine::defaults::init().unwrap();
    three_parts(&ah_engine::defaults::render("engine_update.msg_no_client", &[("path", &"/p/bin/ah-hook")]));
    three_parts(&ah_engine::defaults::render("engine_update.msg_spawn_failed", &[("path", &"/p/bin/ah-hook"), ("why", &"No such file")]));
}

#[test]
fn an_unknown_command_names_it_and_prints_the_usage_hint() {
    let root = scratch_root("unknown");
    let out = Command::new(BIN)
        .arg("no-such-verb")
        .env("HOME", root.join("home"))
        .env("AH_ENGINE_DIR", root.join("state"))
        .env("AH_ENGINE_PLUGIN_ROOT", &root)
        .env("AH_ENGINE_NOSPAWN", "1")
        .output()
        .unwrap();
    let err = String::from_utf8_lossy(&out.stderr);
    assert_eq!(out.status.code(), Some(64), "{err}");
    assert!(err.contains("unknown command 'no-such-verb'"), "what failed: {err}");
    assert!(err.contains("usage: ah-engine "), "the hint: {err}");
    std::fs::remove_dir_all(&root).ok();
}

/// The updater runs `ah-hook --selftest --engine <new>` before it swaps anything in, and a rejection aborts the update (#199).
fn selftest_run(tag: &str, launcher_body: &str) -> (i32, String, std::path::PathBuf) {
    let root = std::env::temp_dir().join(format!("ah-update-selftest-{}-{tag}", std::process::id()));
    std::fs::remove_dir_all(&root).ok();
    let plugin = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../plugins/anti-hall").canonicalize().unwrap();
    let home = root.join("home");
    std::fs::create_dir_all(&home).unwrap();
    let engine = root.join("new-engine");
    std::fs::write(&engine, "#!/bin/sh\necho 9.9.9\n").unwrap();
    let launcher = root.join("ah-hook");
    std::fs::write(&launcher, launcher_body).unwrap();
    for f in [&engine, &launcher] {
        std::fs::set_permissions(f, std::os::unix::fs::PermissionsExt::from_mode(0o755)).unwrap();
    }
    let sha = {
        let o = Command::new("shasum").args(["-a", "256"]).arg(&engine).output().unwrap();
        String::from_utf8_lossy(&o.stdout).split_whitespace().next().unwrap().to_string()
    };
    let out = Command::new(launcher_bin())
        .arg("--plugin-root")
        .arg(&plugin)
        .arg("update")
        .args(["--from"])
        .arg(&engine)
        .args(["--sha256", &sha, "--dry-run", "--launcher"])
        .arg(&launcher)
        .env("HOME", &home)
        .env("AH_ENGINE_PLUGIN_ROOT", &plugin)
        .output()
        .unwrap();
    let text = format!("{}{}", String::from_utf8_lossy(&out.stdout), String::from_utf8_lossy(&out.stderr));
    (out.status.code().unwrap_or(-1), text, root)
}

#[test]
fn the_updater_runs_the_launcher_selftest_with_the_candidate_engine_and_a_rejection_aborts() {
    // accepted: the launcher got `--selftest --engine <candidate>`
    let (code, text, root) = selftest_run("ok", "#!/bin/sh\necho \"$*\" > \"$HOME/launcher.args\"\nexit 0\n");
    assert_eq!(code, 0, "{text}");
    assert!(text.contains("launcher self-test: ok"), "{text}");
    let args = std::fs::read_to_string(root.join("home/launcher.args")).unwrap();
    assert!(args.starts_with("--selftest --engine "), "{args}");
    std::fs::remove_dir_all(&root).ok();
    // rejected: the update fails, says why, and nothing is installed
    let (code, text, root) = selftest_run("bad", "#!/bin/sh\necho 'engine binary: not executable'\nexit 1\n");
    assert_eq!(code, 1, "{text}");
    assert!(text.contains("launcher self-test") && text.contains("not executable"), "{text}");
    assert!(text.contains("state:") && text.contains("next:"), "three-part failure: {text}");
    assert!(!root.join("home/.anti-hall/ah-engine/bin/ah-engine").exists(), "nothing was swapped in");
    std::fs::remove_dir_all(&root).ok();
}
