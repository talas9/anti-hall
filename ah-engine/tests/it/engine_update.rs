//! `engine-update` (issue #140) only runs the plugin's updater script with the arguments given; the engine has no network code.
use std::process::Command;

const BIN: &str = env!("CARGO_BIN_EXE_ah-engine");

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
fn runs_the_script_with_the_arguments_and_returns_its_exit_code() {
    let root = scratch_root("args");
    std::fs::write(root.join("hooks/ah-update.sh"), "echo \"args: $*\"\nexit 7\n").unwrap();
    let (code, out, _) = run(&root, &["--channel", "dev", "--dry-run"]);
    assert_eq!(code, 7);
    assert!(out.contains("args: --channel dev --dry-run"), "{out}");
    std::fs::remove_dir_all(&root).ok();
}

#[test]
fn a_missing_script_is_reported_and_fails() {
    let root = scratch_root("missing");
    let (code, _, err) = run(&root, &["--auto"]);
    assert_eq!(code, 1);
    assert!(err.contains("the updater script is missing"), "{err}");
    std::fs::remove_dir_all(&root).ok();
}
