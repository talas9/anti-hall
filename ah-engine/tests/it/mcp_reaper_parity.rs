//! Node-vs-engine parity for the SessionEnd MCP sweep (`session-end-mcp-reaper`).
//!
//! The sweep is destructive, so this suite proves the engine selects exactly the processes the Node hook selects, and never
//! more. Each case runs the real Node hook and `ah-engine check session-end-mcp-reaper` on the same payload, each with its own
//! isolated home (never the real one) and its own directory of FAKE `ps` and `launchctl` programs placed first on `PATH`, and
//! compares the exit code, the output, the audit log and the whole state of the home, and also the exact commands each side ran
//! (the fakes record their arguments). The fake process tables name pids far above any real pid limit, so a signal sent to one
//! reaches nothing; the one test that does signal real processes (`the_engine_really_signals_what_it_selects`) signals only
//! children it spawned itself. A case marked `defer` is one the engine must hand to Node (`AHFALLBACK`), leaving the home as
//! seeded.
use crate::common::TempDir;
use serde_json::{Value, json};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::Mutex;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::{Duration, Instant};

static SERIAL: Mutex<()> = Mutex::new(());
static ID: AtomicUsize = AtomicUsize::new(0);

#[derive(Clone)]
struct Case {
    payload: Value,
    /// The successive answers of the process listing; the last one repeats. `None` makes that call fail.
    ps: Vec<Option<String>>,
    etimes: Option<String>,
    lstart: Option<String>,
    launchctl: Option<String>,
    env: Vec<(String, String)>,
}

fn table(rows: &[String]) -> Option<String> {
    Some(format!("{}\n", rows.join("\n")))
}

fn case(_name: &str, rows: Vec<String>) -> Case {
    Case {
        payload: json!({"hook_event_name":"SessionEnd","reason":"prompt_input_exit","session_id":"s1"}),
        ps: vec![table(&rows)],
        etimes: None,
        lstart: None,
        launchctl: Some("PID\tStatus\tLabel\n-\t0\tcom.example.other\n".into()),
        env: Vec::new(),
    }
}

fn plugin() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("..").canonicalize().unwrap().join("plugins/anti-hall")
}

/// The harness's bound on one run of either side (see [`run`]).
const RUN_CAP: Duration = Duration::from_secs(40);

/// The plugin root the engine side runs with: the plugin itself (every entry linked), except that the sweep's process-listing
/// and probe timeouts are raised to just under [`RUN_CAP`]. Node's probes have no timeout at all, and the fakes are shell
/// scripts that a loaded machine can take seconds to start; with the shipped timeouts the engine, correctly failing closed,
/// gave up on a slow fake (`launchd-unverifiable`, or no sweep at all) where Node waited, so the comparison measured the
/// machine instead of the selection. What a timed-out probe does is covered on a fake system by `checks::mcp_reaper::tests`.
fn engine_plugin() -> &'static Path {
    static ROOT: std::sync::OnceLock<PathBuf> = std::sync::OnceLock::new();
    ROOT.get_or_init(|| {
        // A static is never dropped, so this tree lives in the build's own temp dir (not the system one), one per test process;
        // the trees of processes that are gone are removed first.
        let base = Path::new(env!("CARGO_TARGET_TMPDIR"));
        for e in std::fs::read_dir(base).into_iter().flatten().flatten() {
            let n = e.file_name().to_string_lossy().to_string();
            if let Some(pid) = n.strip_prefix("ah-reaper-plugin-").and_then(|p| p.parse::<i32>().ok())
                && !crate::common::alive(pid)
            {
                ah_engine::discard::harmless(std::fs::remove_dir_all(e.path())); // keep: cleanup of a dead run's scratch tree
            }
        }
        let root = base.join(format!("ah-reaper-plugin-{}", std::process::id()));
        ah_engine::discard::harmless(std::fs::remove_dir_all(&root)); // keep: a leftover under a reused pid
        std::fs::create_dir_all(&root).unwrap();
        let (src, root) = (plugin(), root.canonicalize().unwrap());
        let link = |from: &Path, to: &Path| std::os::unix::fs::symlink(from, to).unwrap();
        for e in std::fs::read_dir(&src).unwrap().flatten() {
            if e.file_name() != "engine" {
                link(&e.path(), &root.join(e.file_name()));
            }
        }
        let engine = root.join("engine");
        std::fs::create_dir_all(engine.join("defaults")).unwrap();
        for e in std::fs::read_dir(src.join("engine")).unwrap().flatten() {
            if e.file_name() != "defaults" {
                link(&e.path(), &engine.join(e.file_name()));
            }
        }
        let cap = (RUN_CAP - Duration::from_secs(10)).as_millis();
        for e in std::fs::read_dir(src.join("engine/defaults")).unwrap().flatten() {
            let mut text = std::fs::read_to_string(e.path()).unwrap();
            if e.file_name() == "host_proc.toml" {
                for key in ["hostproc.list_timeout_ms", "hostproc.probe_timeout_ms"] {
                    let at = text.find(&format!("[{key}]\n")).unwrap_or_else(|| panic!("{key} is not in host_proc.toml"));
                    let v = at + text[at..].find("\nvalue = ").unwrap() + 1;
                    let end = v + text[v..].find('\n').unwrap();
                    text = format!("{}value = {cap}{}", &text[..v], &text[end..]);
                }
                // The real children of the "really signals" test must not look systemd-managed: on Linux a test process
                // may sit in a `.service` control group, and the sweep then (correctly) leaves it alone. A path no pid has makes
                // the control-group read find nothing; the fake-pid corpus has no /proc entry either way.
                let key = "hostproc.cgroup_path";
                let at = text.find(&format!("[{key}]\n")).unwrap_or_else(|| panic!("{key} is not in host_proc.toml"));
                let v = at + text[at..].find("\nvalue = ").unwrap() + 1;
                let end = v + text[v..].find('\n').unwrap();
                text = format!("{}value = \"{}/no-cgroup/{{pid}}\"{}", &text[..v], root.display(), &text[end..]);
            }
            std::fs::write(engine.join("defaults").join(e.file_name()), text).unwrap();
        }
        root
    })
}

fn scratch(tag: &str) -> TempDir {
    TempDir::at(std::env::temp_dir().join(format!("ah-reaper-{tag}-{}-{}", std::process::id(), ID.fetch_add(1, Ordering::Relaxed))))
}

/// The fake `ps` and `launchctl`: they answer from files in `dir` and record every invocation's arguments in `dir/calls`.
fn install_fakes(dir: &Path, c: &Case) {
    let bin = dir.join("bin");
    std::fs::create_dir_all(&bin).unwrap();
    let d = dir.to_string_lossy();
    let script = |name: &str, body: String| {
        let p = bin.join(name);
        std::fs::write(&p, body).unwrap();
        std::fs::set_permissions(&p, std::os::unix::fs::PermissionsExt::from_mode(0o755)).unwrap();
    };
    script(
        "ps",
        format!(
            "#!/bin/sh\necho \"ps $*\" >> '{d}/calls'\ncase \"$*\" in\n  *etimes*) [ -f '{d}/etimes' ] && cat '{d}/etimes' && exit 0; exit 1 ;;\n  *lstart*) [ -f '{d}/lstart' ] && cat '{d}/lstart' && exit 0; exit 1 ;;\nesac\nn=$(cat '{d}/n' 2>/dev/null || echo 0)\nn=$((n+1))\necho $n > '{d}/n'\nf='{d}/ps.'$n\n[ -f \"$f\" ] || f=$(ls '{d}'/ps.[0-9]* | sort -t. -k2 -n | tail -1)\n[ -f \"$f\" ] && [ ! -f \"$f.fail\" ] && cat \"$f\" && exit 0\nexit 1\n"
        ),
    );
    script("launchctl", format!("#!/bin/sh\necho \"launchctl $*\" >> '{d}/calls'\n[ -f '{d}/launchctl' ] && cat '{d}/launchctl' && exit 0\nexit 1\n"));
    for (i, ps) in c.ps.iter().enumerate() {
        match ps {
            Some(t) => std::fs::write(dir.join(format!("ps.{}", i + 1)), t).unwrap(),
            None => {
                std::fs::write(dir.join(format!("ps.{}", i + 1)), "").unwrap();
                std::fs::write(dir.join(format!("ps.{}.fail", i + 1)), "").unwrap();
            }
        }
    }
    for (name, body) in [("etimes", &c.etimes), ("lstart", &c.lstart), ("launchctl", &c.launchctl)] {
        if let Some(b) = body {
            std::fs::write(dir.join(name), b).unwrap();
        }
    }
}

type Out = (i32, Vec<u8>, Vec<u8>);

fn run(mut cmd: Command, input: &[u8]) -> Out {
    cmd.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = cmd.spawn().unwrap();
    let mut stdin = child.stdin.take().unwrap();
    let data = input.to_vec();
    let w = std::thread::spawn(move || ah_engine::discard::harmless(stdin.write_all(&data))); // keep: the child may exit before reading
    let (mut so, mut se) = (child.stdout.take().unwrap(), child.stderr.take().unwrap());
    let ro = std::thread::spawn(move || {
        let mut b = Vec::new();
        ah_engine::discard::harmless(so.read_to_end(&mut b)); // keep: a closed pipe ends the read
        b
    });
    let re = std::thread::spawn(move || {
        let mut b = Vec::new();
        ah_engine::discard::harmless(se.read_to_end(&mut b)); // keep: a closed pipe ends the read
        b
    });
    let deadline = Instant::now() + RUN_CAP;
    let status = loop {
        if let Some(s) = child.try_wait().unwrap() {
            break s;
        }
        assert!(Instant::now() < deadline, "child exceeded {RUN_CAP:?}: {cmd:?}");
        std::thread::sleep(Duration::from_millis(3));
    };
    ah_engine::discard::harmless(w.join()); // keep: the writer only feeds stdin
    (status.code().unwrap_or(-1), ro.join().unwrap(), re.join().unwrap())
}

fn base_env(c: &mut Command, home: &Path, fakes: &Path, case: &Case) {
    let path = format!("{}:{}", fakes.join("bin").display(), std::env::var("PATH").unwrap_or_default());
    c.env_clear().env("PATH", path).env("HOME", home).env("USERPROFILE", home).env("ANTIHALL_TEST_ISOLATION", "1").env("ANTIHALL_INGEST_DRY_RUN", "1");
    for (k, v) in &case.env {
        c.env(k, v);
    }
}

fn run_engine(home: &Path, fakes: &Path, case: &Case, input: &[u8]) -> Out {
    let mut c = Command::new(env!("CARGO_BIN_EXE_ah-engine"));
    c.arg("check").arg("session-end-mcp-reaper").current_dir(std::env::temp_dir());
    base_env(&mut c, home, fakes, case);
    c.env("AH_ENGINE_DIR", home.join("engine-state")).env("AH_ENGINE_PLUGIN_ROOT", engine_plugin());
    run(c, input)
}

const MCP: &str = "node /srv/mcp-server.js";

/// The sweep on real processes: only children this test spawned, behind a fake process table. The first ends on the polite
/// signal, the second ignores it and needs the forced one, the third is not in the table and must be left alone.
#[test]
fn the_engine_really_signals_what_it_selects_and_nothing_else() {
    let _g = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
    let spawn = |script: &str| Command::new("sh").arg("-c").arg(script).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).spawn().unwrap();
    let mut polite = spawn("exec sleep 300");
    let mut stubborn = spawn("trap '' TERM; while :; do sleep 1; done");
    let mut bystander = spawn("exec sleep 300");
    std::thread::sleep(Duration::from_millis(300)); // let the stubborn shell install its trap
    let (p1, p2) = (polite.id(), stubborn.id());
    let c = {
        let mut c = case("real", vec![]);
        c.ps = vec![Some(format!("      1       0 /sbin/launchd\n{p1:>7}       1 {MCP}\n{p2:>7}       1 node /opt/x/mcp-server.js\n"))];
        c.etimes = Some(format!("{p1} 3600\n{p2} 3600\n"));
        c
    };
    let (home, fakes) = (scratch("real-h"), scratch("real-f"));
    install_fakes(&fakes, &c);
    let out = run_engine(&home, &fakes, &c, c.payload.to_string().as_bytes());
    assert_eq!(out.0, 0, "{}", String::from_utf8_lossy(&out.2));
    let status = |ch: &mut std::process::Child| {
        let t = Instant::now();
        loop {
            if let Some(s) = ch.try_wait().unwrap() {
                break Some(s);
            }
            if t.elapsed() > Duration::from_secs(5) {
                break None;
            }
            std::thread::sleep(Duration::from_millis(10));
        }
    };
    use std::os::unix::process::ExitStatusExt;
    assert_eq!(status(&mut polite).and_then(|s| s.signal()), Some(libc::SIGTERM), "the polite signal ends the first");
    assert_eq!(status(&mut stubborn).and_then(|s| s.signal()), Some(libc::SIGKILL), "the second ignores it and gets the forced one");
    assert!(bystander.try_wait().unwrap().is_none(), "a process outside the table is never touched");
    ah_engine::discard::harmless(bystander.kill()); // keep: this test's own child, being cleaned up
    ah_engine::discard::harmless(bystander.wait()); // keep: reaping this test's own child
    let log = std::fs::read_to_string(home.join(".anti-hall/logs/session-end-reaper.log")).unwrap();
    assert_eq!(log.lines().count(), 1 + 2 + 2, "a scan line, two polite and two forced signals: {log}");
}
