//! The thin launcher (`plugins/anti-hall/scripts/ah-run.sh`) and the two things that rely on it: the status line command the
//! engine's installer writes, and the migration that moves an existing install to it.
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

fn legacy_settings() -> String {
    format!(
        "{{\n  \"theme\": \"dark\",\n  \"statusLine\": {{\n    \"type\": \"command\",\n    \"command\": \"node \\\"{}\\\"\",\n    \"padding\": 0\n  }}\n}}\n",
        dispatcher()
    )
}

fn command_in(text: &str) -> String {
    let v: serde_json::Value = serde_json::from_str(text).unwrap();
    v["statusLine"]["command"].as_str().unwrap().to_string()
}

#[test]
fn the_engine_installer_writes_the_launcher_command_and_a_rerun_changes_nothing() {
    let h = home_with_settings("inst", Some("{\"theme\":\"dark\"}"));
    let o = engine(&h, &["install-statusline"], &[("ANTIHALL_DISPATCHER_OVERRIDE", &dispatcher())]);
    assert_eq!(o.code, 0, "{}{}", o.stdout, o.stderr);
    let want = format!("sh \"{}\" --stdin statusline -- \"{}\"", launcher(), dispatcher());
    assert_eq!(command_in(&settings_text(&h)), want);
    let before = settings_text(&h);
    let o = engine(&h, &["install-statusline"], &[("ANTIHALL_DISPATCHER_OVERRIDE", &dispatcher())]);
    assert_eq!(o.code, 0);
    assert!(o.stdout.contains("No changes made") || o.stdout.to_lowercase().contains("already"), "{}", o.stdout);
    assert_eq!(settings_text(&h), before, "idempotent");
    // the knob gives the Node installer's command
    let h2 = home_with_settings("inst-node", Some("{}"));
    let o = engine(&h2, &["install-statusline"], &[("ANTIHALL_DISPATCHER_OVERRIDE", &dispatcher()), ("ANTIHALL_STATUSLINE_NODE_ONLY", "1")]);
    assert_eq!(o.code, 0);
    assert_eq!(command_in(&settings_text(&h2)), format!("node \"{}\"", dispatcher()));
}

#[test]
fn node_recognises_the_engine_installed_command_as_anti_halls() {
    if !have_node() {
        return;
    }
    let h = home_with_settings("nodeinst", Some("{}"));
    assert_eq!(engine(&h, &["install-statusline"], &[("ANTIHALL_DISPATCHER_OVERRIDE", &dispatcher())]).code, 0);
    let installed = settings_text(&h);
    let mut cmd = Command::new("node");
    cmd.arg(plugin().join("statusline/install-statusline.js"))
        .env_clear()
        .env("PATH", std::env::var("PATH").unwrap())
        .env("HOME", &h.home)
        .env("ANTIHALL_TEST_ISOLATION", "1")
        .env("TMPDIR", h.home.join("tmp"))
        .current_dir(&h.cwd);
    let o = finish(cmd, "");
    assert!(o.stdout.contains("already installed") || o.stdout.contains("already"), "Node must see its own: {}{}", o.stdout, o.stderr);
    assert_eq!(settings_text(&h), installed, "Node's installer changes nothing");
    assert!(!h.home.join(".anti-hall/base-statusline.json").exists(), "the engine's command was not wrapped as a foreign base line");
}

#[test]
fn the_migration_moves_a_node_only_install_once_and_keeps_everything_else() {
    let h = home_with_settings("mig", Some(&legacy_settings()));
    let o = engine(&h, &["migrate", "--json", "--home", h.home.to_str().unwrap(), "--cwd", h.cwd.to_str().unwrap()], &[]);
    assert_eq!(o.code, 0, "{}{}", o.stdout, o.stderr);
    let report: serde_json::Value = serde_json::from_str(o.stdout.lines().last().unwrap()).unwrap();
    let rows: Vec<&serde_json::Value> = report["repairs"].as_array().unwrap().iter().filter(|r| r["id"] == "migrate-statusline-engine").collect();
    assert_eq!(rows.len(), 1, "{}", o.stdout);
    assert_eq!(rows[0]["status"], "fixed");
    let after = settings_text(&h);
    assert_eq!(command_in(&after), format!("sh \"{}\" --stdin statusline -- \"{}\"", launcher(), dispatcher()));
    assert_eq!(
        after,
        legacy_settings()
            .replace(&format!("node \\\"{}\\\"", dispatcher()), &format!("sh \\\"{}\\\" --stdin statusline -- \\\"{}\\\"", launcher(), dispatcher())),
        "only the one string changed, in place"
    );
    assert_eq!(fs::read_to_string(h.home.join(".claude/settings.json.bak-antihall")).unwrap(), legacy_settings(), "the one-time backup holds the original");
    // idempotent: a second run finds nothing to do and reports no row
    let o = engine(&h, &["migrate", "--json", "--home", h.home.to_str().unwrap(), "--cwd", h.cwd.to_str().unwrap()], &[]);
    assert!(!o.stdout.contains("migrate-statusline-engine"), "{}", o.stdout);
    assert_eq!(settings_text(&h), after);
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
    // a command that is not ours, a path with no launcher beside it, invalid JSON, a dry run and an existing backup
    let foreign = "{\"statusLine\":{\"type\":\"command\",\"command\":\"node /somewhere/else/line.js\"}}";
    let no_launcher = "{\"statusLine\":{\"type\":\"command\",\"command\":\"node \\\"/x/anti-hall/statusline/statusline.js\\\"\"}}";
    for (tag, body) in [
        ("foreign", foreign.to_string()),
        ("nolauncher", no_launcher.to_string()),
        ("badjson", "{\"statusLine\":".to_string()),
        ("empty", String::new()),
        ("twice", legacy_settings().replace("\"padding\": 0", &format!("\"padding\": 0, \"note\": \"node \\\"{}\\\"\"", dispatcher()))),
    ] {
        let h = home_with_settings(tag, Some(&body));
        let o = run(&h, &[]);
        assert!(o.code == 0 || tag == "badjson" || tag == "empty", "{tag}: {}{}", o.stdout, o.stderr);
        assert_eq!(
            settings_text(&h),
            if tag == "twice" {
                legacy_settings().replace("\"padding\": 0", &format!("\"padding\": 0, \"note\": \"node \\\"{}\\\"\"", dispatcher()))
            } else {
                body.clone()
            },
            "{tag}: unchanged"
        );
        assert!(!h.home.join(".claude/settings.json.bak-antihall").exists(), "{tag}: no backup for a file that was not touched");
    }
    // a dry run reports and writes nothing
    let h = home_with_settings("dry", Some(&legacy_settings()));
    let mut a = args(&h);
    a.push("--dry-run".into());
    let a: Vec<&str> = a.iter().map(String::as_str).collect();
    let o = engine(&h, &a, &[]);
    assert!(o.stdout.contains("would update the statusLine"), "{}", o.stdout);
    assert_eq!(settings_text(&h), legacy_settings());
    // a backup that already exists is never overwritten
    let h = home_with_settings("bak", Some(&legacy_settings()));
    fs::write(h.home.join(".claude/settings.json.bak-antihall"), "older original").unwrap();
    assert_eq!(run(&h, &[]).code, 0);
    assert_eq!(fs::read_to_string(h.home.join(".claude/settings.json.bak-antihall")).unwrap(), "older original");
    assert!(command_in(&settings_text(&h)).starts_with("sh "));
    // a file that cannot be written is reported as failed and left alone
    let h = home_with_settings("ro", Some(&legacy_settings()));
    fs::set_permissions(h.home.join(".claude/settings.json"), fs::Permissions::from_mode(0o444)).unwrap();
    fs::set_permissions(h.home.join(".claude"), fs::Permissions::from_mode(0o555)).unwrap();
    let o = run(&h, &[]);
    fs::set_permissions(h.home.join(".claude"), fs::Permissions::from_mode(0o755)).unwrap();
    assert_eq!(settings_text(&h), legacy_settings(), "unchanged");
    assert!(o.stdout.contains("\"failed\"") || o.stdout.contains("unchanged") || o.stdout.contains("left the statusLine"), "{}", o.stdout);
    drop(h.t);
}
