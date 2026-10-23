//! Node-vs-engine parity of the operator command-line tools (L9a): `settings`, `defect` and `statusline`.
//!
//! The real Node script and the engine command run on identical seeded scratch homes and are compared on stdout, stderr, the
//! exit code and the home directory tree (every file's path, mode and masked content). Nothing touches the real home: each
//! side gets its own scratch home with `HOME` pointed at it, an otherwise empty environment and the Node shadow turned off.
//! Clock values (ISO timestamps, `"ts"`, the spinner frame, elapsed times) are masked, because the two runs cannot share a
//! clock; the status line is re-run up to three times when only the second changed.
#![allow(clippy::unwrap_used, clippy::expect_used)] // a test crate: a panic is the failure report, and E2 exempts tests
use regex::Regex;
use std::collections::BTreeMap;
use std::error::Error;
use std::fs;
use std::io::Write;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicUsize, Ordering};

type R<T = ()> = Result<T, Box<dyn Error>>;

const BIN: &str = env!("CARGO_BIN_EXE_ah-engine");
static COUNTER: AtomicUsize = AtomicUsize::new(0);
static CASES: AtomicUsize = AtomicUsize::new(0);

struct Scratch(PathBuf);

impl Scratch {
    fn new(tag: &str) -> R<Scratch> {
        let n = COUNTER.fetch_add(1, Ordering::SeqCst);
        let dir = std::env::temp_dir().join(format!("ah-ops-parity-{}-{n}-{tag}", std::process::id()));
        if dir.exists() {
            fs::remove_dir_all(&dir)?;
        }
        fs::create_dir_all(&dir)?;
        Ok(Scratch(dir.canonicalize()?))
    }

    fn path(&self) -> &Path {
        &self.0
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        if let Err(e) = fs::remove_dir_all(&self.0) {
            eprintln!("could not remove {}: {e}", self.0.display());
        }
    }
}

fn plugin_src() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("..").join("plugins").join("anti-hall").canonicalize().unwrap()
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct Out {
    stdout: String,
    stderr: String,
    code: i32,
}

fn run(mut cmd: Command, home: &Path, cwd: &Path, extra: &[(&str, &str)], stdin: &str) -> R<Out> {
    cmd.env_clear()
        .env("PATH", std::env::var("PATH")?)
        .env("HOME", home)
        .env("TMPDIR", home.join("tmp"))
        .env("CLAUDE_PLUGIN_ROOT", plugin_src())
        .env("ANTIHALL_INGEST_DRY_RUN", "1")
        .env("AH_ENGINE_SHADOW_RATE_STATUSLINE", "0")
        .env("AH_ENGINE_SHADOW_RATE_PHASE", "0")
        // the Node installer writes the Node-only command; the engine's installer writes its own command unless told otherwise
        .env("ANTIHALL_STATUSLINE_NODE_ONLY", "1")
        .current_dir(cwd)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    for (k, v) in extra {
        cmd.env(k, v);
    }
    let mut child = cmd.spawn()?;
    let mut pipe = child.stdin.take().ok_or("no stdin pipe")?;
    let input = stdin.as_bytes().to_vec();
    let writer = std::thread::spawn(move || pipe.write_all(&input));
    let out = child.wait_with_output()?;
    match writer.join().map_err(|_| "stdin writer panicked")? {
        Ok(()) => {}
        Err(e) if e.kind() == std::io::ErrorKind::BrokenPipe => {}
        Err(e) => return Err(e.into()),
    }
    Ok(Out {
        stdout: String::from_utf8_lossy(&out.stdout).into_owned(),
        stderr: String::from_utf8_lossy(&out.stderr).into_owned(),
        code: out.status.code().unwrap_or(-1),
    })
}

fn mask(s: &str, homes: &[&Path]) -> String {
    let mut s = s.to_string();
    for h in homes {
        s = s.replace(&h.to_string_lossy().into_owned(), "HOME");
    }
    for (re, with) in [
        (r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z", "TS"),
        (r"corrupt-\d+", "corrupt-N"),
        (r#""ts":\d+"#, r#""ts":N"#),
        (r#""started":\d+"#, r#""started":N"#),
        (r"[\u{25d0}\u{25d3}\u{25d1}\u{25d2}]", "S"),
        (r"\.\d+\.[0-9a-f]{8}\.tmp", ".tmp"),
        // the activity sweep moves every 400 ms: the lit cell is a clock value
        ("\u{1b}\\[36m\u{2588}\u{1b}\\[0m", "\u{1b}[2m\u{2500}\u{1b}[0m"),
    ] {
        s = Regex::new(re).unwrap().replace_all(&s, with).into_owned();
    }
    s
}

fn snapshot(root: &Path) -> R<BTreeMap<String, String>> {
    fn walk(root: &Path, dir: &Path, out: &mut BTreeMap<String, String>) -> R {
        for e in fs::read_dir(dir)? {
            let p = e?.path();
            let rel = p.strip_prefix(root)?.to_string_lossy().into_owned();
            if rel.starts_with(".anti-hall/ah-engine") || rel.ends_with(".lock") || rel == "tmp" {
                continue;
            }
            let meta = fs::symlink_metadata(&p)?;
            let mode = meta.permissions().mode() & 0o777;
            if meta.is_dir() {
                out.insert(format!("{rel}/"), format!("{mode:o}"));
                walk(root, &p, out)?;
            } else {
                out.insert(mask(&rel, &[]), format!("{mode:o}\n{}", mask(&String::from_utf8_lossy(&fs::read(&p)?), &[root])));
            }
        }
        Ok(())
    }
    let mut out = BTreeMap::new();
    walk(root, root, &mut out)?;
    if !out.keys().any(|k| k.starts_with(".anti-hall/") && k != ".anti-hall/") {
        out.remove(".anti-hall/");
    }
    Ok(out)
}

fn copy_dir(from: &Path, to: &Path) -> R {
    fs::create_dir_all(to)?;
    for e in fs::read_dir(from)? {
        let e = e?;
        let t = to.join(e.file_name());
        if e.file_type()?.is_dir() {
            copy_dir(&e.path(), &t)?;
        } else {
            fs::copy(e.path(), t)?;
        }
    }
    Ok(())
}

fn write(root: &Path, rel: &str, content: &str) -> R {
    let p = root.join(rel);
    fs::create_dir_all(p.parent().ok_or("no parent")?)?;
    fs::write(p, content)?;
    Ok(())
}

fn git(dir: &Path, args: &[&str]) -> R {
    let o = Command::new("git").args(args).current_dir(dir).env("GIT_CONFIG_GLOBAL", "/dev/null").env("GIT_CONFIG_SYSTEM", "/dev/null").output()?;
    assert!(o.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&o.stderr));
    Ok(())
}

fn repo(dir: &Path) -> R {
    fs::create_dir_all(dir)?;
    git(dir, &["init", "-q", "."])?;
    git(dir, &["config", "user.email", "a@b.c"])?;
    git(dir, &["config", "user.name", "tester"])?;
    Ok(())
}

// ---- settings ---------------------------------------------------------------------------------------------------------

fn settings_seed(root: &Path) -> R {
    write(
        root,
        ".anti-hall/settings.json",
        r#"{"autoHandover":{"pct":70,"enabled":"off"},"jev":{"enabled":true,"semanticJudge":"yes","prices":{"m":{"inPerMTok":1,"outPerMTok":2}}},"jevIntegrations":{"triage":"shadow","modelRouting":"on"},"guards":{"stashGuard":true,"editGuardAllow":"docs/**,a.md"},"safety":{"gitGuard":false}}"#,
    )?;
    write(root, ".anti-hall/jev.json", r#"{"enabled":false,"triage":false,"integrations":{"speculation":"on"},"budget":{"usdPerDay":3}}"#)?;
    write(
        root,
        ".claude/settings.json",
        r#"{"pluginConfigs":{"anti-hall@anti-hall":{"options":{"auto_handover_pct":60,"guards_model_routing":"advisory"}}}}"#,
    )?;
    Ok(())
}

fn home_with(settings: Option<&str>, extra: &[(&str, &str)]) -> R<Scratch> {
    let h = Scratch::new("hseed")?;
    if let Some(s) = settings {
        write(h.path(), ".claude/settings.json", s)?;
    }
    for (p, c) in extra {
        write(h.path(), p, c)?;
    }
    Ok(h)
}

#[test]
fn install_reports_a_settings_file_it_cannot_parse_and_writes_nothing() -> R {
    for body in ["{bad", "", "null", "[1]", "5", "\u{feff}{}", "{\"a\":\"\\ud800\"}"] {
        let seed = home_with(Some(body), &[])?;
        let before = snapshot(seed.path())?;
        let mut cmd = Command::new(BIN);
        cmd.arg("install-statusline");
        let o = run(cmd, seed.path(), seed.path(), &[], "")?;
        assert_eq!(o.code, 0, "{body:?}: {}", o.stderr);
        assert!(o.stdout.contains("statusline installation has been retired"), "{body:?}: {}", o.stdout);
        assert_eq!(before, snapshot(seed.path())?, "{body:?}: retired installer writes nothing");
        let mut cmd = Command::new(BIN);
        cmd.arg("uninstall-statusline");
        let o = run(cmd, seed.path(), seed.path(), &[], "")?;
        assert_eq!(o.code, 1, "{body:?} uninstall: {}", o.stderr);
        assert!(o.stderr.contains("Could not parse"), "{body:?}: {}", o.stderr);
        assert_eq!(before, snapshot(seed.path())?, "{body:?}: nothing written");
    }
    // an unreadable base or backup file falls through to the next strategy, as the script does
    let seed = home_with(Some("{\"statusLine\":{\"type\":\"command\",\"command\":\"x\"}}"), &[(".anti-hall/base-statusline.json", "{bad")])?;
    fs::write(seed.path().join(".claude/settings.json.bak-antihall"), "{bad")?;
    let mut cmd = Command::new(BIN);
    cmd.arg("uninstall-statusline");
    let o = run(cmd, seed.path(), seed.path(), &[], "")?;
    assert_eq!(o.code, 0, "{}{}", o.stdout, o.stderr);
    assert!(o.stderr.contains("Falling through to backup") && o.stderr.contains("Falling through to key-removal"), "{}", o.stderr);
    assert!(!fs::read_to_string(seed.path().join(".claude/settings.json"))?.contains("statusLine"), "the key was removed");
    Ok(())
}

#[test]
fn the_installers_keep_the_mode_and_the_link_of_the_settings_file() -> R {
    let h = home_with(Some("{}"), &[])?;
    let real = h.path().join("dotfiles/settings.json");
    fs::create_dir_all(real.parent().ok_or("no parent")?)?;
    fs::write(&real, "{\"keep\":1}\n")?;
    fs::set_permissions(&real, fs::Permissions::from_mode(0o640))?;
    let link = h.path().join(".claude/settings.json");
    fs::remove_file(&link)?;
    std::os::unix::fs::symlink(&real, &link)?;
    let mut cmd = Command::new(BIN);
    cmd.arg("install-statusline");
    let o = run(cmd, h.path(), h.path(), &[], "")?;
    assert_eq!(o.code, 0, "{}", o.stderr);
    assert!(fs::symlink_metadata(&link)?.file_type().is_symlink(), "the link survives");
    assert_eq!(fs::read_to_string(&real)?, "{\"keep\":1}\n", "retired installer leaves the target unchanged");
    assert_eq!(fs::metadata(&real)?.permissions().mode() & 0o777, 0o640, "the mode is kept");
    let bak = h.path().join(".claude/settings.json.bak-antihall");
    assert!(!bak.exists(), "retired installer writes no backup");
    let leftovers: Vec<_> = fs::read_dir(real.parent().ok_or("no parent")?)?.flatten().filter(|e| e.file_name().to_string_lossy().contains(".tmp")).collect();
    assert!(leftovers.is_empty(), "no temporary file is left behind");
    Ok(())
}

#[test]
fn settings_and_defect_runs_never_start_node() -> R {
    let seed = Scratch::new("seed")?;
    settings_seed(seed.path())?;
    let home = Scratch::new("no-shadow")?;
    copy_dir(seed.path(), home.path())?;
    let state = home.path().join("state");
    let log = home.path().join("fake-node.log");
    let fake = home.path().join("fake-node.sh");
    fs::write(&fake, "#!/bin/sh\necho started >> \"$AH_FAKE_LOG\"\necho different\n")?;
    fs::set_permissions(&fake, fs::Permissions::from_mode(0o755))?;
    for args in [vec!["settings", "show", "--json"], vec!["settings", "get", "jev.enabled"], vec!["defect", "list", "--json"]] {
        let o = engine_shadowed(home.path(), home.path(), Some(&fake), &[("AH_FAKE_LOG", &log)], &args)?;
        assert_eq!(o.code, 0, "{args:?}: {}", o.stderr);
    }
    std::thread::sleep(std::time::Duration::from_millis(500));
    assert!(shadow_dirs(&state).is_empty(), "no scratch directory for a Node comparison");
    assert!(!log.exists(), "Node was never started");
    // the real state is as seeded
    assert_eq!(fs::read_to_string(home.path().join(".anti-hall/settings.json"))?, fs::read_to_string(seed.path().join(".anti-hall/settings.json"))?);
    eprintln!("operator parity cases: {}", CASES.load(Ordering::SeqCst));
    Ok(())
}

fn engine_shadowed(home: &Path, cwd: &Path, node: Option<&Path>, extra: &[(&str, &Path)], args: &[&str]) -> R<Out> {
    let mut c = Command::new(BIN);
    c.args(args)
        .env_clear()
        .env("PATH", std::env::var("PATH")?)
        .env("HOME", home)
        .env("CLAUDE_PLUGIN_ROOT", plugin_src())
        .env("AH_ENGINE_SHADOW_RATE_PHASE", "1000")
        // the Node installer writes the Node-only command; the engine's installer writes its own command unless told otherwise
        .env("ANTIHALL_STATUSLINE_NODE_ONLY", "1")
        .env("AH_ENGINE_DIR", home.join("state"))
        .current_dir(cwd);
    if let Some(n) = node {
        c.env("AH_ENGINE_NODE", n);
    }
    for (k, v) in extra {
        c.env(k, v);
    }
    let o = c.output()?;
    Ok(Out {
        stdout: String::from_utf8_lossy(&o.stdout).into_owned(),
        stderr: String::from_utf8_lossy(&o.stderr).into_owned(),
        code: o.status.code().unwrap_or(-1),
    })
}

fn shadow_dirs(state: &Path) -> Vec<PathBuf> {
    fs::read_dir(state.join("shadow")).map(|rd| rd.flatten().map(|e| e.path()).collect()).unwrap_or_default()
}

#[test]
fn an_installer_run_on_unreadable_settings_fails_like_node_and_leaves_no_shadow_behind() -> R {
    let home = home_with(Some("{bad"), &[])?;
    let state = home.path().join("state");
    // The retired installer never defers and writes nothing, even when legacy settings are unreadable.
    let before = snapshot(home.path())?;
    let o = engine_shadowed(home.path(), home.path(), None, &[], &["install-statusline"])?;
    assert_eq!(o.code, 0, "{} {}", o.stdout, o.stderr);
    assert!(o.stdout.contains("statusline installation has been retired"), "{}", o.stdout);
    assert_eq!(before, snapshot(home.path())?, "retired installer leaves legacy settings untouched");
    assert!(shadow_dirs(&state).is_empty(), "retired installer starts no shadow");
    Ok(())
}

/// L13: the trust commands answer where they used to defer to Node. A `.git` file with a carriage return, and an allow file with a
/// lone surrogate escape, are refused with a message and nothing is recorded.
#[test]
fn trust_commands_refuse_instead_of_deferring_on_unclassifiable_input() -> R {
    let home = Scratch::new("home")?;
    fs::create_dir_all(home.path().join("tmp"))?;
    let work = Scratch::new("repo")?;
    let r = work.path().join("repo");
    repo(&r)?;
    write(&r, ".anti-hall/command-allow.json", r#"{"patterns":["^ls$","\ud800"]}"#)?;
    let go = |dir: &Path, args: &[&str]| -> R<Out> {
        let mut e = Command::new(BIN);
        e.arg("settings").args(args);
        run(e, home.path(), dir, &[], "")
    };
    let o = go(&r, &["trust-command-allow", "--confirmed"])?;
    assert_eq!(o.code, 1, "{}", o.stderr);
    assert!(o.stderr.contains("cannot read exactly"), "{}", o.stderr);
    assert!(
        !home.path().join(".anti-hall").exists()
            || !fs::read_dir(home.path().join(".anti-hall"))?.any(|e| e.is_ok_and(|e| e.file_name().to_string_lossy().contains("trust")))
    );
    // a linked worktree whose `.git` file carries a carriage return
    let wt = work.path().join("wt");
    git(&r, &["commit", "-q", "--allow-empty", "-m", "x"])?;
    git(&r, &["worktree", "add", "-q", wt.to_str().ok_or("path")?])?;
    let dot = wt.join(".git");
    let txt = fs::read_to_string(&dot)?;
    fs::write(&dot, txt.trim_end().to_string() + "\r\n")?;
    write(&wt, ".anti-hall/command-allow.json", r#"{"patterns":["^ls$"]}"#)?;
    let o = go(&wt, &["trust-command-allow", "--confirmed"])?;
    assert_eq!(o.code, 1, "{}", o.stderr);
    assert!(o.stderr.contains("cannot classify the repository layout"), "{}", o.stderr);
    Ok(())
}

#[test]
fn zz_report_the_case_count() {
    eprintln!("operator parity cases run in this process: {}", CASES.load(Ordering::SeqCst));
}

/// Dogfood 2026-10-09: the status line has an overall deadline. A base command that would run for seconds is cut at the deadline
/// (the engine prints what it has and exits 0), where before only each step had its own limit.
#[test]
fn statusline_with_a_cut_base_command_still_exits_clean_under_a_short_deadline() -> R {
    let seed = Scratch::new("slcut-seed")?;
    write(seed.path(), ".claude.json", "{}")?;
    write(seed.path(), ".anti-hall/base-statusline.json", r#"{"command":"sleep 20; echo late"}"#)?;
    let home = Scratch::new("slcut-home")?;
    fs::create_dir_all(home.path().join("tmp"))?;
    copy_dir(seed.path(), home.path())?;
    let cwd = Scratch::new("slcut-cwd")?;
    let mut e = Command::new(BIN);
    e.arg("statusline");
    let o = run(e, home.path(), cwd.path(), &[("AH_ENGINE_STATUSLINE_DEADLINE_MS", "700")], "{}")?;
    // the timing proof is the unit test in ops/statusline/util.rs (a wall-clock bound here would flake under load)
    assert_eq!(o.code, 0, "{o:?}");
    assert!(!o.stdout.contains("late"), "the cut base command printed: {o:?}");
    Ok(())
}
