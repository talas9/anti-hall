//! The thin launcher (`plugins/anti-hall/scripts/ah-run.sh`), the status line command the engine's installer writes (the
//! engine's own `"<engine>" statusline`, no launcher and no Node script), and the migration that moves an existing install
//! (Node-only or launcher form) to it.
//!
//! The launcher runs the engine first and the Node script when the engine is absent or answers "leave this to Node" (exit 75,
//! 64, 70, or the shell's 126/127); any other exit is the command's own. With `--stdin` the host's JSON is read once and given to
//! whichever runs. Without it (a Monitor) the engine runs as a child so a deferral can still fall back, and SIGTERM/SIGINT are
//! passed on. The migration is engine-only (Node's repair pass has no such step); it is idempotent, fail-open and keeps the
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

/// A PATH with node's directory and the system ones, and no directory that might hold an `ah-engine`.
fn bare_path() -> String {
    let node = Command::new("sh").args(["-c", "command -v node"]).output().unwrap();
    let node = String::from_utf8_lossy(&node.stdout).trim().to_string();
    let dir = Path::new(&node).parent().map(|d| d.display().to_string()).unwrap_or_default();
    format!("{dir}:/usr/bin:/bin")
}

fn have_node() -> bool {
    Command::new("node").arg("--version").output().is_ok_and(|o| o.status.success())
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

fn script(dir: &Path, name: &str, body: &str) -> PathBuf {
    let p = dir.join(name);
    fs::write(&p, body).unwrap();
    fs::set_permissions(&p, fs::Permissions::from_mode(0o755)).unwrap();
    p
}

/// The launcher run in a scratch home, with `engine` as the engine binary (`None`: none installed) and `node_js` as the Node script.
fn launch(t: &TempDir, engine: Option<&Path>, stdin_mode: bool, node_js: &Path, words: &[&str], args: &[&str], stdin: &str) -> Out {
    let home = t.0.join("home");
    fs::create_dir_all(&home).unwrap();
    let mut cmd = Command::new("sh");
    cmd.arg(plugin().join("scripts/ah-run.sh"));
    if stdin_mode {
        cmd.arg("--stdin");
    }
    cmd.args(words).arg("--").arg(node_js).args(args).env_clear().env("PATH", std::env::var("PATH").unwrap()).env("HOME", &home);
    if let Some(e) = engine {
        cmd.env("AH_WRAPPER_TEST", "1").env("AH_ENGINE_BIN", e);
    }
    finish(cmd, stdin)
}

fn node_echo(dir: &Path) -> PathBuf {
    // a stand-in Node script: names its arguments and echoes its stdin
    let p = dir.join("node-echo.js");
    fs::write(&p, "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{process.stdout.write('NODE['+process.argv.slice(2).join(',')+']'+s)});").unwrap();
    p
}

#[test]
fn the_engine_answers_and_the_node_script_never_runs() {
    if !have_node() {
        return;
    }
    let t = TempDir::new("launch-engine");
    let eng = script(&t.0, "eng.sh", "#!/bin/sh\nprintf 'ENGINE[%s]' \"$*\"\ncat\n");
    let o = launch(&t, Some(&eng), true, &node_echo(&t.0), &["statusline"], &[], "{\"a\":1}\n\n");
    assert_eq!((o.code, o.stdout.as_str()), (0, "ENGINE[statusline]{\"a\":1}\n\n"), "stdin reaches the engine byte for byte, trailing newlines included");
}

#[test]
fn a_deferral_hands_the_same_stdin_to_node_and_flags_only_are_passed_on() {
    if !have_node() {
        return;
    }
    for code in [75, 64, 70, 126, 127] {
        let t = TempDir::new("launch-defer");
        let eng = script(&t.0, "eng.sh", &format!("#!/bin/sh\ncat >/dev/null\nexit {code}\n"));
        let o = launch(&t, Some(&eng), true, &node_echo(&t.0), &["devswarm", "wake-watch"], &["--auto"], "{\"b\":2}\n");
        assert_eq!((o.code, o.stdout.as_str()), (0, "NODE[--auto]{\"b\":2}\n"), "exit {code} falls back to Node with the flags and the same stdin");
    }
}

#[test]
fn any_other_engine_exit_is_the_commands_own() {
    if !have_node() {
        return;
    }
    for code in [1, 2, 3, 124] {
        let t = TempDir::new("launch-own");
        let eng = script(&t.0, "eng.sh", &format!("#!/bin/sh\ncat >/dev/null\necho partial\nexit {code}\n"));
        let o = launch(&t, Some(&eng), true, &node_echo(&t.0), &["statusline"], &[], "x");
        assert_eq!((o.code, o.stdout.as_str()), (code, "partial\n"), "exit {code} is passed on and Node is not run");
    }
}

#[test]
fn without_an_engine_node_runs() {
    if !have_node() {
        return;
    }
    let t = TempDir::new("launch-none");
    let o = launch(&t, None, true, &node_echo(&t.0), &["statusline"], &[], "{\"c\":3}");
    // no engine under the scratch HOME and none on PATH named ah-engine in a clean checkout of the test machine
    if o.stdout.starts_with("NODE[") {
        assert_eq!(o.stdout, "NODE[]{\"c\":3}");
    }
    let mut cmd = Command::new("sh");
    cmd.arg(plugin().join("scripts/ah-run.sh")).args(["--stdin", "statusline", "--"]).arg(node_echo(&t.0));
    cmd.env_clear().env("PATH", bare_path()).env("HOME", t.0.join("home2"));
    let o = finish(cmd, "in");
    assert_eq!((o.code, o.stdout.as_str()), (0, "NODE[]in"));
}

#[test]
fn a_monitor_run_falls_back_on_a_deferral_and_forwards_a_signal() {
    if !have_node() {
        return;
    }
    // a deferral: Node runs in the launcher's place (no stdin involved)
    let t = TempDir::new("launch-monitor");
    let eng = script(&t.0, "eng.sh", "#!/bin/sh\nexit 75\n");
    let o = launch(&t, Some(&eng), false, &node_echo(&t.0), &["devswarm", "wake-watch"], &["--auto"], "");
    assert_eq!((o.code, o.stdout.as_str()), (0, "NODE[--auto]"));
    // a running engine gets SIGTERM and the launcher exits with its code, without running Node
    let t = TempDir::new("launch-signal");
    let marker = t.0.join("got-term");
    let eng =
        script(&t.0, "eng.sh", &format!("#!/bin/sh\ntrap 'echo term > \"{}\"; exit 7' TERM\necho armed\nwhile :; do sleep 0.1; done\n", marker.display()));
    let home = t.0.join("home");
    fs::create_dir_all(&home).unwrap();
    let mut cmd = Command::new("sh");
    cmd.arg(plugin().join("scripts/ah-run.sh")).args(["devswarm", "wake-watch", "--"]).arg(node_echo(&t.0));
    cmd.env_clear().env("PATH", std::env::var("PATH").unwrap()).env("HOME", &home).env("AH_WRAPPER_TEST", "1").env("AH_ENGINE_BIN", &eng);
    cmd.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = cmd.spawn().unwrap();
    let mut line = String::new();
    std::io::BufRead::read_line(&mut std::io::BufReader::new(child.stdout.as_mut().unwrap()), &mut line).unwrap();
    assert_eq!(line, "armed\n");
    // SAFETY: SIGTERM to the launcher we started.
    unsafe { libc::kill(child.id() as i32, libc::SIGTERM) };
    let st = child.wait().unwrap();
    assert_eq!(st.code(), Some(7), "the engine's own exit code, not a Node fallback");
    assert_eq!(fs::read_to_string(&marker).unwrap().trim(), "term", "the engine received the signal");
}

#[test]
fn the_test_only_engine_override_is_ignored_without_the_test_flag() {
    if !have_node() {
        return;
    }
    let t = TempDir::new("launch-knob");
    let eng = script(&t.0, "eng.sh", "#!/bin/sh\necho ENGINE\n");
    let home = t.0.join("home");
    fs::create_dir_all(&home).unwrap();
    let mut cmd = Command::new("sh");
    cmd.arg(plugin().join("scripts/ah-run.sh")).args(["--stdin", "statusline", "--"]).arg(node_echo(&t.0));
    cmd.env_clear().env("PATH", bare_path()).env("HOME", &home).env("AH_ENGINE_BIN", &eng);
    let o = finish(cmd, "z");
    assert_eq!(o.stdout, "NODE[]z", "a stray AH_ENGINE_BIN must not replace the engine");
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
        .env("AH_ENGINE_SHADOW_RATE_INSTALL", "0")
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
    plugin().join("statusline/statusline.js").display().to_string()
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
