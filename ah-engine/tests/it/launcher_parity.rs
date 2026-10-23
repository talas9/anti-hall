//! The thin launcher (`plugins/anti-hall/scripts/ah-run.sh`), the status line command the engine's installer writes (the
//! engine's own `"<engine>" statusline`, no launcher and no Node script), and the migration that moves an existing install
//! (Node-only or launcher form) to it.
//!
//! The launcher runs the engine and nothing else: the legacy Node script it is given is ignored, every engine exit (75, 64,
//! 70, 126/127 included) is the command's own, and with no engine the status line stays silent (exit 0) while any other command
//! says so on stderr and exits 127. With `--stdin` the host's JSON is handed to the engine unchanged. Without it (a Monitor)
//! the engine runs as a child and SIGTERM/SIGINT are passed on. The migration is engine-only (Node's repair pass has no such step); it is idempotent, fail-open and keeps the
//! one-time backup. Nothing here touches the real home.
#![allow(clippy::unwrap_used, clippy::expect_used)] // a test crate: a panic is the failure report, and E2 exempts tests
use ah_engine::db::TempDir;
use std::fs;
use std::io::Write;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

const BIN: &str = env!("CARGO_BIN_EXE_ah-engine");

fn plugin() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap().join("plugins").join("anti-hall").canonicalize().unwrap()
}

struct Out {
    stdout: String,
    stderr: String,
    code: i32,
}

fn finish(mut cmd: Command, stdin: &str) -> Out {
    cmd.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = cmd.spawn().unwrap();
    let mut pipe = child.stdin.take().unwrap();
    let input = stdin.as_bytes().to_vec();
    let w = std::thread::spawn(move || {
        // a launcher that never reads its stdin closes the pipe first: a failed write is the normal case
        drop(pipe.write_all(&input));
    });
    let o = child.wait_with_output().unwrap();
    w.join().unwrap();
    Out {
        stdout: String::from_utf8_lossy(&o.stdout).into_owned(),
        stderr: String::from_utf8_lossy(&o.stderr).into_owned(),
        code: o.status.code().unwrap_or(-1),
    }
}

// ---- the installer's command and the migration -------------------------------------------------------------------------------

struct Home {
    t: TempDir,
    home: PathBuf,
    cwd: PathBuf,
}

fn home_with_settings(tag: &str, settings: Option<&str>) -> Home {
    let t = TempDir::new(tag);
    let root = fs::canonicalize(&t.0).unwrap();
    let (home, cwd) = (root.join("home"), root.join("proj"));
    fs::create_dir_all(home.join(".claude")).unwrap();
    fs::create_dir_all(home.join("tmp")).unwrap();
    fs::create_dir_all(&cwd).unwrap();
    if let Some(s) = settings {
        fs::write(home.join(".claude/settings.json"), s).unwrap();
    }
    Home { t, home, cwd }
}

fn engine(h: &Home, args: &[&str], extra: &[(&str, &str)]) -> Out {
    let mut cmd = Command::new(BIN);
    cmd.args(args)
        .env_clear()
        .env("PATH", std::env::var("PATH").unwrap())
        .env("HOME", &h.home)
        .env("TMPDIR", h.home.join("tmp"))
        .env("AH_ENGINE_PLUGIN_ROOT", plugin())
        .env("ANTIHALL_TEST_ISOLATION", "1")
        .current_dir(&h.cwd);
    for (k, v) in extra {
        cmd.env(k, v);
    }
    finish(cmd, "")
}

fn settings_text(h: &Home) -> String {
    fs::read_to_string(h.home.join(".claude/settings.json")).unwrap()
}

fn dispatcher() -> String {
    plugin().join("../anti-hall-node/statusline/statusline.js").display().to_string()
}

fn launcher() -> String {
    plugin().join("scripts/ah-run.sh").display().to_string()
}

fn command_in(text: &str) -> String {
    let v: serde_json::Value = serde_json::from_str(text).unwrap();
    v["statusLine"]["command"].as_str().unwrap().to_string()
}

/// The launcher form an earlier engine installer wrote.
fn launcher_command() -> String {
    format!("sh \"{}\" --stdin statusline -- \"{}\"", launcher(), dispatcher())
}

/// The engine the installer points at in a scratch home with no installed engine: this very binary.
fn this_engine() -> String {
    fs::canonicalize(BIN).unwrap().display().to_string()
}

fn engine_command(engine: &str) -> String {
    format!("\"{engine}\" statusline")
}

fn settings_with(cmd: &str) -> String {
    format!(
        "{{\n  \"theme\": \"dark\",\n  \"statusLine\": {{\n    \"type\": \"command\",\n    \"command\": {},\n    \"padding\": 0\n  }}\n}}\n",
        serde_json::to_string(cmd).unwrap()
    )
}

#[test]
fn the_engine_installer_is_retired_and_writes_no_statusline() {
    let h = home_with_settings("inst", Some("{\"theme\":\"dark\"}"));
    let before = settings_text(&h);
    let o = engine(&h, &["install-statusline"], &[]);
    assert_eq!(o.code, 0, "{}{}", o.stdout, o.stderr);
    assert!(o.stdout.contains("retired") || o.stdout.contains("no statusLine"), "{}", o.stdout);
    assert_eq!(settings_text(&h), before, "retired installer leaves settings untouched");
    let o = engine(&h, &["install-statusline"], &[]);
    assert_eq!(o.code, 0);
    assert_eq!(settings_text(&h), before, "idempotent");
    // The old Node-only knob no longer re-enables installer writes.
    let h2 = home_with_settings("inst-node", Some("{}"));
    let before = settings_text(&h2);
    let o = engine(&h2, &["install-statusline"], &[("ANTIHALL_DISPATCHER_OVERRIDE", &dispatcher()), ("ANTIHALL_STATUSLINE_NODE_ONLY", "1")]);
    assert_eq!(o.code, 0);
    assert_eq!(settings_text(&h2), before);
    // A scratch installed engine path also no longer re-enables installer writes.
    let h3 = home_with_settings("inst-home", Some("{}"));
    let bin = h3.home.join(".anti-hall/ah-engine/bin");
    fs::create_dir_all(&bin).unwrap();
    std::os::unix::fs::symlink(BIN, bin.join("ah-engine")).unwrap();
    assert_eq!(engine(&h3, &["install-statusline"], &[]).code, 0);
    assert_eq!(settings_text(&h3), "{}");
}

#[test]
fn the_engine_uninstaller_recognises_the_engine_command() {
    let h = home_with_settings("uninst", Some(&settings_with(&engine_command(&this_engine()))));
    fs::create_dir_all(h.home.join(".anti-hall")).unwrap();
    fs::write(h.home.join(".anti-hall/base-statusline.json"), "{\"command\":\"echo mine\"}").unwrap();
    assert_eq!(command_in(&settings_text(&h)), engine_command(&this_engine()));
    let o = engine(&h, &["uninstall-statusline"], &[]);
    assert_eq!(o.code, 0, "{}{}", o.stdout, o.stderr);
    assert_eq!(command_in(&settings_text(&h)), "echo mine", "the wrapped line 1 comes back: {}", o.stdout);
}

#[test]
fn migrations_no_longer_upgrade_or_write_statusline_settings() {
    for (tag, old) in [("mig-node", format!("node \"{}\"", dispatcher())), ("mig-launcher", launcher_command())] {
        let h = home_with_settings(tag, Some(&settings_with(&old)));
        let before = settings_text(&h);
        let o = engine(&h, &["migrate", "--json", "--home", h.home.to_str().unwrap(), "--cwd", h.cwd.to_str().unwrap()], &[]);
        assert_eq!(o.code, 0, "{tag}: {}{}", o.stdout, o.stderr);
        let report: serde_json::Value = serde_json::from_str(o.stdout.lines().last().unwrap()).unwrap();
        let rows: Vec<&serde_json::Value> = report["repairs"].as_array().unwrap().iter().filter(|r| r["id"] == "migrate-statusline-engine").collect();
        assert!(rows.is_empty(), "{tag}: migration/update path must not report an upgrade row: {}", o.stdout);
        assert_eq!(settings_text(&h), before, "{tag}: existing statusLine left untouched");
        assert!(!h.home.join(".claude/settings.json.bak-antihall").exists(), "{tag}: no backup for an untouched file");
        // idempotent: a second run still reports no row and writes nothing
        let o = engine(&h, &["migrate", "--json", "--home", h.home.to_str().unwrap(), "--cwd", h.cwd.to_str().unwrap()], &[]);
        assert!(!o.stdout.contains("migrate-statusline-engine"), "{tag}: {}", o.stdout);
        assert_eq!(settings_text(&h), before);
    }
    // the retired installer also does not upgrade an older form
    let h = home_with_settings("inst-upgrade", Some(&settings_with(&launcher_command())));
    let before = settings_text(&h);
    let o = engine(&h, &["install-statusline"], &[]);
    assert_eq!(o.code, 0, "{}{}", o.stdout, o.stderr);
    assert_eq!(settings_text(&h), before);
}

#[test]
fn the_migration_leaves_what_it_cannot_be_sure_of_exactly_as_it_is() {
    let args =
        |h: &Home| vec!["migrate".to_string(), "--json".into(), "--home".into(), h.home.display().to_string(), "--cwd".into(), h.cwd.display().to_string()];
    let run = |h: &Home, extra: &[(&str, &str)]| {
        let a = args(h);
        let a: Vec<&str> = a.iter().map(String::as_str).collect();
        engine(h, &a, extra)
    };
    // a command that is not ours, a launcher form naming some other launcher, a wrapped dispatcher, invalid JSON, an empty file,
    // and the command text appearing twice
    let legacy = settings_with(&format!("node \"{}\"", dispatcher()));
    let twice =
        legacy.replace("\"padding\": 0", &format!("\"padding\": 0, \"note\": {}", serde_json::to_string(&format!("node \"{}\"", dispatcher())).unwrap()));
    for (tag, body) in [
        ("foreign", settings_with("node /somewhere/else/line.js")),
        ("otherlauncher", settings_with(&format!("sh \"/elsewhere/ah-run.sh\" --stdin statusline -- \"{}\"", dispatcher()))),
        ("wrapped", settings_with(&format!("node \"{}\" | tee /dev/null", dispatcher()))),
        ("badjson", "{\"statusLine\":".to_string()),
        ("empty", String::new()),
        ("twice", twice),
    ] {
        let h = home_with_settings(tag, Some(&body));
        let o = run(&h, &[]);
        assert!(o.code == 0 || tag == "badjson" || tag == "empty", "{tag}: {}{}", o.stdout, o.stderr);
        assert_eq!(settings_text(&h), body, "{tag}: unchanged");
        assert!(!h.home.join(".claude/settings.json.bak-antihall").exists(), "{tag}: no backup for a file that was not touched");
    }
    // a dry run reports no statusline upgrade row and writes nothing
    let h = home_with_settings("dry", Some(&legacy));
    let mut a = args(&h);
    a.push("--dry-run".into());
    let a: Vec<&str> = a.iter().map(String::as_str).collect();
    let o = engine(&h, &a, &[]);
    assert!(!o.stdout.contains("migrate-statusline-engine"), "{}", o.stdout);
    assert_eq!(settings_text(&h), legacy);
    // a backup that already exists is never overwritten because no migration writes
    let h = home_with_settings("bak", Some(&legacy));
    fs::write(h.home.join(".claude/settings.json.bak-antihall"), "older original").unwrap();
    assert_eq!(run(&h, &[]).code, 0);
    assert_eq!(fs::read_to_string(h.home.join(".claude/settings.json.bak-antihall")).unwrap(), "older original");
    assert_eq!(settings_text(&h), legacy);
    // a read-only file is left alone and no statusline write failure is reported
    let h = home_with_settings("ro", Some(&legacy));
    fs::set_permissions(h.home.join(".claude/settings.json"), fs::Permissions::from_mode(0o444)).unwrap();
    fs::set_permissions(h.home.join(".claude"), fs::Permissions::from_mode(0o555)).unwrap();
    let o = run(&h, &[]);
    fs::set_permissions(h.home.join(".claude"), fs::Permissions::from_mode(0o755)).unwrap();
    assert_eq!(settings_text(&h), legacy, "unchanged");
    assert!(!o.stdout.contains("migrate-statusline-engine"), "{}", o.stdout);
    drop(h.t);
}
