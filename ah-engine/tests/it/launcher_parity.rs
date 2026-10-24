//! The status line command the engine's installer writes (the engine's own `"<engine>" statusline`, no launcher and no Node
//! script), and the recognition of the forms earlier installers wrote (Node-only, and the retired launcher
//! `scripts/ah-run.sh --stdin statusline -- <dispatcher>`). The launcher itself is retired: engine commands go through the thin
//! client (`hooks/ah-hook.sh <verb>` -> `ah-hook <verb>`, tested in ah-launcher/tests/cli.rs); the script is kept, unshipped,
//! in plugins/anti-hall-node/legacy-sh/. Nothing here touches the real home.
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

/// The thin client a migrated status line command runs: a stand-in executable at the installed path.
fn install_client(h: &Home) -> String {
    let p = h.home.join(".anti-hall/ah-engine/bin/ah-hook");
    fs::create_dir_all(p.parent().unwrap()).unwrap();
    fs::write(&p, "#!/bin/sh\nexit 0\n").unwrap();
    fs::set_permissions(&p, fs::Permissions::from_mode(0o755)).unwrap();
    p.display().to_string()
}

fn migrate(h: &Home, extra: &[&str]) -> Out {
    let mut a = vec!["migrate", "--json", "--home", h.home.to_str().unwrap(), "--cwd", h.cwd.to_str().unwrap()];
    a.extend_from_slice(extra);
    engine(h, &a, &[])
}

fn statusline_rows(o: &Out) -> Vec<serde_json::Value> {
    let report: serde_json::Value = serde_json::from_str(o.stdout.lines().last().unwrap()).unwrap();
    report["repairs"].as_array().unwrap().iter().filter(|r| r["id"].as_str().is_some_and(|i| i.contains("statusline"))).cloned().collect()
}

#[test]
fn the_migration_rewrites_a_statusline_that_runs_the_retired_wrapper_to_the_thin_client_and_nothing_else() {
    // the Node-only form is not the shell wrapper: left exactly as it is
    let node = settings_with(&format!("node \"{}\"", dispatcher()));
    let h = home_with_settings("mig-node", Some(&node));
    install_client(&h);
    let o = migrate(&h, &[]);
    assert_eq!(o.code, 0, "{}{}", o.stdout, o.stderr);
    assert!(statusline_rows(&o).is_empty(), "{}", o.stdout);
    assert_eq!(settings_text(&h), node);
    // the retired shell wrapper form becomes the thin client's command: one string changes, the backup is kept, nothing is deleted
    let old = settings_with(&launcher_command());
    let h = home_with_settings("mig-launcher", Some(&old));
    // no thin client installed: nothing to point the status line at, the file is left alone
    assert_eq!(migrate(&h, &[]).code, 0);
    assert_eq!(settings_text(&h), old, "no client, no change");
    let client = install_client(&h);
    // a dry run reports what it would do and writes nothing
    let o = migrate(&h, &["--dry-run"]);
    assert_eq!(statusline_rows(&o).len(), 1, "{}", o.stdout);
    assert_eq!(settings_text(&h), old);
    assert!(!h.home.join(".claude/settings.json.bak-antihall").exists());
    let o = migrate(&h, &[]);
    let rows = statusline_rows(&o);
    assert_eq!(rows.len(), 1, "{}", o.stdout);
    assert_eq!(rows[0]["status"], "fixed", "{}", o.stdout);
    let after = settings_text(&h);
    assert_eq!(command_in(&after), format!("\"{client}\" statusline"));
    assert_eq!(
        after,
        old.replace(&serde_json::to_string(&launcher_command()).unwrap(), &serde_json::to_string(&format!("\"{client}\" statusline")).unwrap()),
        "only the command string changed"
    );
    assert_eq!(fs::read_to_string(h.home.join(".claude/settings.json.bak-antihall")).unwrap(), old, "the backup is the original");
    // idempotent: the new form is not an old one
    let o = migrate(&h, &[]);
    assert!(statusline_rows(&o).is_empty(), "{}", o.stdout);
    assert_eq!(settings_text(&h), after);
    // the retired installer still writes no statusLine
    let h2 = home_with_settings("inst-upgrade", Some(&old));
    let before = settings_text(&h2);
    let o = engine(&h2, &["install-statusline"], &[]);
    assert_eq!(o.code, 0, "{}{}", o.stdout, o.stderr);
    assert_eq!(settings_text(&h2), before);
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
    assert!(statusline_rows(&o).is_empty(), "{}", o.stdout);
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
    assert!(statusline_rows(&o).is_empty(), "{}", o.stdout);
    drop(h.t);
}
