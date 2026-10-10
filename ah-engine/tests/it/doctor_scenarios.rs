//! `ah-engine doctor` against every documented failure scenario, each simulated in a scratch HOME:
//! stub and fixture binaries (a wrong-OS or wrong-architecture header, a quarantined file), fake sockets and lock holders,
//! read-only and unowned directories, a scratch copy of the plugin with its files broken, stub `node`/`git` programs on a
//! restricted PATH. The shell doctor (`ah-hook.sh --doctor`) runs on the same fixtures and must say the same thing for every
//! check both make. Nothing here touches the real HOME.
#![allow(clippy::unwrap_used, clippy::expect_used)] // a test crate: a panic is the failure report, and E2 exempts tests
use std::fs;
use std::io::Write;
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt, symlink};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicUsize, Ordering};

static N: AtomicUsize = AtomicUsize::new(0);
const BIN: &str = env!("CARGO_BIN_EXE_ah-engine");

fn real_plugin() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap().join("plugins/anti-hall")
}

fn copy_dir(from: &Path, to: &Path) {
    fs::create_dir_all(to).unwrap();
    for e in fs::read_dir(from).unwrap().flatten() {
        let (p, q) = (e.path(), to.join(e.file_name()));
        if p.is_dir() {
            copy_dir(&p, &q);
        } else {
            fs::copy(&p, &q).unwrap();
        }
    }
}

fn is_root() -> bool {
    // SAFETY: `geteuid` takes no arguments and cannot fail.
    unsafe { libc::geteuid() == 0 }
}

fn host_os() -> &'static str {
    std::env::consts::OS
}

fn host_arch() -> &'static str {
    std::env::consts::ARCH
}

/// What one run printed.
struct Out {
    code: i32,
    text: String,
    err: String,
}

impl Out {
    /// Assert a finding of `level` (`ok`, `bad`, `warn`, `info`) containing every needle exists.
    fn has(&self, level: &str, needles: &[&str]) {
        let mark = match level {
            "ok" => "  ✅ ",
            "bad" => "  ❌ ",
            "warn" => "  ⚠️ ",
            _ => "  i ",
        };
        let hit = self.text.lines().any(|l| l.starts_with(mark) && needles.iter().all(|n| l.contains(n)));
        assert!(hit, "no {level} finding with {needles:?}\n--- stdout ---\n{}\n--- stderr ---\n{}", self.text, self.err);
    }

    /// Assert no finding of any level contains `needle`.
    fn lacks(&self, needle: &str) {
        assert!(!self.text.contains(needle), "unexpected {needle:?}\n{}\n--- stderr ---\n{}", self.text, self.err);
    }

    /// The lines of one section (heading line to the next blank line).
    fn section(&self, title: &str) -> Vec<String> {
        let mut out = Vec::new();
        let mut inside = false;
        for l in self.text.lines() {
            if l == title {
                inside = true;
            } else if inside && l.is_empty() {
                break;
            } else if inside {
                out.push(l.to_string());
            }
        }
        out
    }
}

/// A scratch HOME, project directory and (on demand) a private copy of the plugin.
struct Sc {
    root: PathBuf,
    home: PathBuf,
    cwd: PathBuf,
    plugin: PathBuf,
    path: String,
}

impl Drop for Sc {
    fn drop(&mut self) {
        // restore write permission so the scratch tree can go
        fn open_up(p: &Path) {
            if let Ok(m) = fs::symlink_metadata(p)
                && m.is_dir()
            {
                fs::set_permissions(p, fs::Permissions::from_mode(0o755)).ok();
                if let Ok(rd) = fs::read_dir(p) {
                    rd.flatten().for_each(|e| open_up(&e.path()));
                }
            }
        }
        open_up(&self.root);
        fs::remove_dir_all(&self.root).ok();
    }
}

impl Sc {
    fn new() -> Sc {
        let root = std::env::temp_dir().join(format!("ah-doctor-sc-{}-{}", std::process::id(), N.fetch_add(1, Ordering::Relaxed)));
        let (home, cwd) = (root.join("home"), root.join("cwd"));
        fs::create_dir_all(&home).unwrap();
        fs::create_dir_all(&cwd).unwrap();
        assert!(home.starts_with(std::env::temp_dir()), "a scratch home is always under the temp dir, never the real home");
        Sc { root, home, cwd, plugin: real_plugin(), path: std::env::var("PATH").unwrap_or_default() }
    }

    /// Give this scenario its own copy of the plugin (the files a test breaks), with a lock for this machine.
    fn own_plugin(&mut self) -> &Path {
        let p = self.root.join("plugin");
        let real = real_plugin();
        copy_dir(&real.join("engine"), &p.join("engine"));
        copy_dir(&real.join("hooks"), &p.join("hooks"));
        copy_dir(&real.join(".claude-plugin"), &p.join(".claude-plugin"));
        copy_dir(&real.join("statusline"), &p.join("statusline"));
        // the libraries the DevSwarm hook self-tests run through: read-only links to the real ones (a test that edits one copies it first)
        for dir in ["companion", "scripts", "skills", "agents", "assets", "monitors", "docs"] {
            symlink(real.join(dir), p.join(dir)).unwrap();
        }
        copy_dir(&real.join("codex/hooks"), &p.join("codex/hooks"));
        self.plugin = p;
        self.write_lock("0.1.0", &self.triples());
        // the real `claude doctor` is not run from a test: the PATH has only the tools the doctor needs
        self.programs(&[], &["claude"]);
        &self.plugin
    }

    /// The asset names a lock for this machine lists.
    fn triples(&self) -> Vec<String> {
        let t = match host_os() {
            "macos" => format!("{}-apple-darwin", host_arch()),
            _ => format!("{}-unknown-linux-gnu", host_arch()),
        };
        vec![t]
    }

    fn write_lock(&self, version: &str, triples: &[String]) {
        let assets: Vec<String> = triples.iter().map(|t| format!("    \"ah-engine-v{version}-{t}.tar.gz\": \"{}\"", "a".repeat(64))).collect();
        let text = format!(
            "{{\n  \"schema\": 1,\n  \"version\": \"{version}\",\n  \"tag\": \"ah-engine-v{version}\",\n  \"fingerprint\": \"x\",\n  \"assets\": {{\n{}\n  }}\n}}\n",
            assets.join(",\n")
        );
        fs::write(self.plugin.join("ah-engine.lock"), text).unwrap();
    }

    fn state(&self) -> PathBuf {
        self.home.join(".anti-hall/ah-engine")
    }

    fn bin(&self) -> PathBuf {
        self.state().join("bin/ah-engine")
    }

    /// Write a file under the home, creating directories.
    fn put(&self, rel: &str, content: &[u8]) -> PathBuf {
        let p = self.home.join(rel);
        fs::create_dir_all(p.parent().unwrap()).unwrap();
        fs::write(&p, content).unwrap();
        p
    }

    /// Install `content` as the engine binary with the given mode.
    fn install_bin(&self, content: &[u8], mode: u32) -> PathBuf {
        let p = self.bin();
        fs::create_dir_all(p.parent().unwrap()).unwrap();
        fs::write(&p, content).unwrap();
        fs::set_permissions(&p, fs::Permissions::from_mode(mode)).unwrap();
        p
    }

    /// A stub engine that answers `version` with `v`.
    fn stub_engine(&self, v: &str) -> PathBuf {
        self.install_bin(format!("#!/bin/sh\n[ \"$1\" = version ] && echo {v}\nexit 0\n").as_bytes(), 0o755)
    }

    /// The bootstrap's marker for the installed binary: version, a fake asset digest, the binary's real digest.
    fn marker(&self, version: &str) {
        let sha = sha256(&self.bin());
        fs::write(self.state().join("bootstrap.installed"), format!("{version} {} {sha}\n", "a".repeat(64))).unwrap();
    }

    /// Put stub programs (`name` -> script body) in a directory placed first on PATH, and hide the named real programs.
    fn programs(&mut self, stubs: &[(&str, &str)], hide: &[&str]) {
        let farm = self.root.join("bin");
        fs::remove_dir_all(&farm).ok();
        fs::create_dir_all(&farm).unwrap();
        for (name, body) in stubs {
            let p = farm.join(name);
            fs::write(&p, format!("#!/bin/sh\n{body}\n")).unwrap();
            fs::set_permissions(&p, fs::Permissions::from_mode(0o755)).unwrap();
        }
        // the real tools the doctor and the shell doctor need, minus the hidden ones and the stubbed ones
        let wanted = "sh ps tr sed awk od find tar uname id kill mkdir mv date head tail wc cut grep ls stat dirname mktemp sleep cat rm sysctl xattr git gh node sha256sum shasum openssl";
        for name in wanted.split_whitespace() {
            if hide.contains(&name) || stubs.iter().any(|s| s.0 == name) {
                continue;
            }
            if let Some(real) = which(name) {
                symlink(real, farm.join(name)).ok();
            }
        }
        self.path = farm.display().to_string();
    }

    fn env(&self, c: &mut Command) {
        // AH_ENGINE_PLUGIN_ROOT is what the hook wrapper exports: the engine reads its settings from this plugin; TMPDIR is
        // forwarded so a long scratch path falls back to the same private socket directory the test computes
        c.env_clear()
            .env("PATH", &self.path)
            .env("HOME", &self.home)
            .env("AH_ENGINE_PLUGIN_ROOT", &self.plugin)
            .env("TMPDIR", std::env::temp_dir())
            .current_dir(&self.cwd);
    }

    fn doctor(&self, args: &[&str]) -> Out {
        let mut c = Command::new(BIN);
        c.arg("doctor").arg("--check").arg("--plugin-root").arg(&self.plugin).args(args);
        self.env(&mut c);
        self.finish(c)
    }

    /// `doctor` without `--check` and with extra flags (repair runs).
    fn doctor_raw(&self, args: &[&str]) -> Out {
        let mut c = Command::new(BIN);
        c.arg("doctor").arg("--plugin-root").arg(&self.plugin).args(args);
        self.env(&mut c);
        self.finish(c)
    }

    fn finish(&self, mut c: Command) -> Out {
        let o = c.output().expect("ah-engine");
        Out { code: o.status.code().unwrap_or(-1), text: String::from_utf8_lossy(&o.stdout).into_owned(), err: String::from_utf8_lossy(&o.stderr).into_owned() }
    }

    /// The shell doctor of the same plugin.
    fn shell(&self) -> Out {
        let mut c = Command::new("sh");
        c.arg(self.plugin.join("hooks/ah-hook.sh")).arg("--doctor");
        self.env(&mut c);
        c.env("AH_WRAPPER_TEST", "1");
        self.finish(c)
    }
}

fn which(name: &str) -> Option<PathBuf> {
    std::env::var("PATH").ok()?.split(':').map(|d| Path::new(d).join(name)).find(|p| p.is_file())
}

fn sha256(p: &Path) -> String {
    let out = Command::new("shasum").args(["-a", "256"]).arg(p).output().expect("shasum");
    String::from_utf8_lossy(&out.stdout).split_whitespace().next().unwrap().to_string()
}

fn macho(cpu: u32) -> Vec<u8> {
    let mut b = vec![0xcf, 0xfa, 0xed, 0xfe];
    b.extend(cpu.to_le_bytes());
    b.resize(64, 0);
    b
}

fn elf(machine: u16) -> Vec<u8> {
    let mut b = vec![0x7f, b'E', b'L', b'F', 2, 1, 1];
    b.resize(64, 0);
    b[18..20].copy_from_slice(&machine.to_le_bytes());
    b
}

/// A header of the host's own OS format for an architecture the host cannot run at all.
fn wrong_arch_fixture() -> Vec<u8> {
    match (host_os(), host_arch()) {
        ("macos", "x86_64") => macho(0x0100_000c),
        ("macos", _) => macho(7),
        (_, "x86_64") => elf(0xb7),
        _ => elf(0x3e),
    }
}

/// A header for the other OS.
fn wrong_os_fixture() -> Vec<u8> {
    if host_os() == "macos" { elf(0x3e) } else { macho(0x0100_0007) }
}

/// A header for this machine's own OS and architecture.
fn native_fixture() -> Vec<u8> {
    match (host_os(), host_arch()) {
        ("macos", "aarch64") => macho(0x0100_000c),
        ("macos", _) => macho(0x0100_0007),
        (_, "aarch64") => elf(0xb7),
        _ => elf(0x3e),
    }
}

// ---- BIN: the engine binary ---------------------------------------------------------------------------------------------------

#[test]
fn bin_01_missing() {
    let mut sc = Sc::new();
    sc.own_plugin();
    let d = sc.doctor(&[]);
    d.has("warn", &["engine binary not installed at", "bin/ah-engine", "- Fix: sh", "ah-engine-bootstrap.sh -v"]);
    assert_eq!(d.code, 0, "a missing installed engine is a warning, the Node hooks still work\n{}", d.text);
}

#[test]
fn bin_02_a_directory_and_a_dangling_symlink() {
    let mut sc = Sc::new();
    sc.own_plugin();
    fs::create_dir_all(sc.bin()).unwrap();
    sc.doctor(&[]).has("bad", &["is not a regular file (a directory)"]);
    fs::remove_dir(sc.bin()).unwrap();
    symlink("/nonexistent/ah-engine", sc.bin()).unwrap();
    let d = sc.doctor(&[]);
    d.has("bad", &["is not a regular file (a symlink to nothing)"]);
    assert_eq!(d.code, 1);
}

#[test]
fn bin_03_not_executable_and_the_repair() {
    let mut sc = Sc::new();
    sc.own_plugin();
    sc.install_bin(&native_fixture(), 0o644);
    let d = sc.doctor(&[]);
    d.has("bad", &["is not executable (mode 644)", "chmod u+x"]);
    assert_eq!(d.code, 1);
    // a dry run changes nothing and says what it would do
    let dry = sc.doctor_raw(&["--dry-run"]);
    dry.has("info", &["engine-binary-exec", "would have made"]);
    assert_eq!(fs::metadata(sc.bin()).unwrap().permissions().mode() & 0o111, 0);
    // the repair makes it executable, and a second run finds nothing left to do
    let fixed = sc.doctor_raw(&["--repair"]);
    fixed.has("ok", &["engine-binary-exec", "made", "executable"]);
    assert_ne!(fs::metadata(sc.bin()).unwrap().permissions().mode() & 0o100, 0);
    let again = sc.doctor(&[]);
    again.lacks("is not executable");
    assert!(!sc.doctor_raw(&["--repair"]).text.contains("engine-binary-exec"), "idempotent");
}

#[test]
fn bin_04_corrupt_empty_truncated_unrecognised() {
    let mut sc = Sc::new();
    sc.own_plugin();
    for (content, why) in [
        (Vec::new(), "empty file"),
        (vec![0x7f, b'E', b'L', b'F'], "truncated header"),
        (vec![0x41; 200], "unrecognised header"),
        (b"tiny".to_vec(), "truncated header"),
    ] {
        sc.install_bin(&content, 0o755);
        let d = sc.doctor(&[]);
        d.has("bad", &["is not a runnable program", why, "reinstall"]);
        assert_eq!(d.code, 1, "{why}");
        let shell = sc.shell();
        assert_eq!(d.section("Engine install"), shell.section("Engine install"), "{why}: the shell doctor agrees\nengine: {}\nshell: {}", d.text, shell.text);
    }
}

#[test]
fn bin_05_wrong_os() {
    let mut sc = Sc::new();
    sc.own_plugin();
    sc.install_bin(&wrong_os_fixture(), 0o755);
    let d = sc.doctor(&[]);
    let other = if host_os() == "macos" { "linux" } else { "macos" };
    d.has("bad", &["was built for", other, &format!("this machine runs {}", host_os())]);
    assert_eq!(d.section("Engine install"), sc.shell().section("Engine install"));
}

#[test]
fn bin_06_wrong_architecture_cannot_run() {
    let mut sc = Sc::new();
    sc.own_plugin();
    sc.install_bin(&wrong_arch_fixture(), 0o755);
    let d = sc.doctor(&[]);
    d.has("bad", &["was built for", &format!("this {} machine is {}", host_os(), host_arch()), "it cannot run"]);
    assert_eq!(d.code, 1);
    assert_eq!(d.section("Engine install"), sc.shell().section("Engine install"));
}

#[test]
fn bin_06_x86_64_on_apple_silicon_depends_on_rosetta() {
    if !(host_os() == "macos" && host_arch() == "aarch64") {
        return; // the other hosts are covered by the injected-host matrix in src/doctor/install.rs
    }
    let mut sc = Sc::new();
    sc.own_plugin();
    sc.install_bin(&macho(0x0100_0007), 0o755);
    let d = sc.doctor(&[]);
    if Path::new("/Library/Apple/usr/libexec/oah/libRosettaRuntime").exists() {
        d.has("warn", &["x86_64 build running under Rosetta"]);
    } else {
        d.has("bad", &["Rosetta is not installed", "softwareupdate --install-rosetta"]);
    }
    assert_eq!(
        d.section("Engine install").first(),
        sc.shell().section("Engine install").first(),
        "the fixture is not a runnable program, so only the verdict on the file is compared"
    );
}

#[test]
fn bin_07_08_09_marker_digest_and_versions() {
    let mut sc = Sc::new();
    sc.own_plugin();
    sc.stub_engine("0.1.0");
    // no marker: a local build
    let d = sc.doctor(&[]);
    d.has("info", &["was not installed by the bootstrap (a local build)"]);
    // a marker that matches: healthy
    sc.marker("0.1.0");
    let d = sc.doctor(&[]);
    d.has("ok", &["engine binary", "runs and reports 0.1.0"]);
    d.lacks("differs from the build the bootstrap installed");
    // the file changes after the bootstrap installed it
    sc.stub_engine("0.1.0 ");
    fs::write(sc.bin(), "#!/bin/sh\n[ \"$1\" = version ] && echo 0.1.0\n# edited\nexit 0\n").unwrap();
    let d = sc.doctor(&[]);
    d.has("warn", &["differs from the build the bootstrap installed", "sha256", "mv", ".local"]);
    assert_eq!(d.section("Engine install").iter().filter(|l| l.contains("differs from")).count(), 1);
    // the installed version is not the pinned one
    let mut sc2 = Sc::new();
    sc2.own_plugin();
    sc2.stub_engine("0.0.9");
    sc2.marker("0.0.9");
    let d = sc2.doctor(&[]);
    d.has("warn", &["engine 0.0.9 is installed but the plugin pins 0.1.0", "next session start"]);
    assert_eq!(
        d.section("Engine install").into_iter().filter(|l| !l.contains("this doctor is engine")).collect::<Vec<_>>(),
        sc2.shell().section("Engine install")
    );
}

#[test]
fn bin_10_15_the_lock() {
    let mut sc = Sc::new();
    sc.own_plugin();
    sc.stub_engine("0.1.0");
    sc.write_lock("0.1.0", &["riscv64-unknown-linux-gnu".to_string()]);
    let d = sc.doctor(&[]);
    d.has("warn", &["the plugin's ah-engine.lock has no build for", "the Node hooks stay in use"]);
    fs::remove_file(sc.plugin.join("ah-engine.lock")).unwrap();
    let d = sc.doctor(&[]);
    d.has("warn", &["ah-engine.lock is missing or unreadable at", "No such file or directory (os error 2)"]);
    let shell = sc.shell();
    shell.has("warn", &["ah-engine.lock is missing or unreadable at", "No such file or directory (os error 2)"]);
}

#[test]
fn bin_11_quarantined_by_gatekeeper_and_the_repair() {
    if host_os() != "macos" {
        return; // the attribute exists only on macOS
    }
    let mut sc = Sc::new();
    sc.own_plugin();
    sc.stub_engine("0.1.0");
    sc.marker("0.1.0");
    let st = Command::new("xattr").args(["-w", "com.apple.quarantine", "0081;5f0;Safari;"]).arg(sc.bin()).status().unwrap();
    assert!(st.success());
    let d = sc.doctor(&[]);
    d.has("bad", &["is quarantined by macOS Gatekeeper", "xattr -d com.apple.quarantine"]);
    assert_eq!(d.code, 1);
    let shell = sc.shell();
    shell.has("bad", &["is quarantined by macOS Gatekeeper", "xattr -d com.apple.quarantine"]);
    // the repair applies only to the build the bootstrap verified
    let fixed = sc.doctor_raw(&["--repair"]);
    fixed.has("ok", &["engine-binary-quarantine", "removed the quarantine attribute"]);
    sc.doctor(&[]).lacks("quarantined by macOS Gatekeeper");
    // a binary the bootstrap did not verify (marker digest differs) is never un-quarantined automatically
    fs::write(sc.state().join("bootstrap.installed"), format!("0.1.0 {} {}\n", "a".repeat(64), "b".repeat(64))).unwrap();
    Command::new("xattr").args(["-w", "com.apple.quarantine", "0081;5f0;Safari;"]).arg(sc.bin()).status().unwrap();
    let kept = sc.doctor_raw(&["--repair"]);
    assert!(!kept.text.contains("engine-binary-quarantine"), "{}", kept.text);
    kept.has("bad", &["quarantined"]);
}

#[test]
fn bin_12_does_not_run() {
    let mut sc = Sc::new();
    sc.own_plugin();
    for (body, want) in [("exit 3", "exit 3"), ("echo boom >&2; exit 9", "boom"), ("kill -9 $$", "killed by signal 9")] {
        sc.install_bin(format!("#!/bin/sh\n{body}\n").as_bytes(), 0o755);
        let d = sc.doctor(&[]);
        d.has("bad", &["does not run:", want, "reinstall"]);
        assert_eq!(d.code, 1);
    }
    // a hang is cut off by the probe timeout, which lives in the plugin's settings
    let mut slow = Sc::new();
    slow.own_plugin();
    let toml = slow.plugin.join("engine/defaults/doctor.toml");
    let text = fs::read_to_string(&toml).unwrap().replace("value = 5000", "value = 300");
    fs::write(&toml, text).unwrap();
    fs::write(slow.plugin.join("engine/defaults.pristine/doctor.toml"), fs::read_to_string(&toml).unwrap()).unwrap();
    slow.install_bin(b"#!/bin/sh\nexec sleep 30\n", 0o755);
    let d = slow.doctor(&[]);
    d.has("bad", &["does not run: timed out"]);
}

#[test]
fn bin_14_healthy_and_the_shell_agrees() {
    let mut sc = Sc::new();
    sc.own_plugin();
    sc.stub_engine("0.1.0");
    sc.marker("0.1.0");
    let d = sc.doctor(&[]);
    d.has("ok", &["engine binary", "runs and reports 0.1.0"]);
    let shell = sc.shell();
    assert_eq!(d.section("Engine install").into_iter().filter(|l| !l.contains("this doctor is engine")).collect::<Vec<_>>(), shell.section("Engine install"));
    assert_eq!(shell.code, i32::from(shell.text.contains("  ❌")));
}

// ---- DMN: the daemon ------------------------------------------------------------------------------------------------------------

/// A fake daemon: holds the singleton lock and a socket that accepts and never answers.
struct FakeDaemon {
    _lock: fs::File,
    stop: std::sync::Arc<std::sync::atomic::AtomicBool>,
    thread: Option<std::thread::JoinHandle<()>>,
}

impl FakeDaemon {
    fn start(state: &Path) -> FakeDaemon {
        use std::os::unix::io::AsRawFd;
        fs::create_dir_all(state).unwrap();
        let sock = ah_engine::paths::socket_in(state);
        fs::create_dir_all(sock.parent().unwrap()).unwrap();
        let lock_path = ah_engine::paths::lock_for(&sock);
        let lock = fs::OpenOptions::new().create(true).read(true).write(true).truncate(false).open(&lock_path).unwrap();
        // SAFETY: `lock` is an open file owned by this value; `flock` takes the descriptor and a flag only.
        assert_eq!(unsafe { libc::flock(lock.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) }, 0);
        fs::write(&lock_path, std::process::id().to_string()).unwrap();
        let listener = std::os::unix::net::UnixListener::bind(&sock).unwrap();
        listener.set_nonblocking(true).unwrap();
        let stop = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let flag = stop.clone();
        let thread = std::thread::spawn(move || {
            let mut held = Vec::new();
            while !flag.load(Ordering::Relaxed) {
                match listener.accept() {
                    Ok((s, _)) => held.push(s),
                    Err(_) => std::thread::sleep(std::time::Duration::from_millis(10)),
                }
            }
        });
        FakeDaemon { _lock: lock, stop, thread: Some(thread) }
    }
}

impl Drop for FakeDaemon {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
        if let Some(t) = self.thread.take() {
            t.join().ok();
        }
    }
}

fn now_ms() -> u128 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis()
}

#[test]
fn dmn_02_down_and_dmn_01_up() {
    let mut sc = Sc::new();
    sc.own_plugin();
    sc.doctor(&[]).has("info", &["the engine daemon is not running (it starts on the first hook call)"]);
    // a real daemon in the scratch home
    let mut child = Command::new(BIN)
        .arg("serve")
        .env_clear()
        .env("PATH", &sc.path)
        .env("HOME", &sc.home)
        .env("AH_ENGINE_PLUGIN_ROOT", &sc.plugin)
        .env("TMPDIR", std::env::temp_dir())
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    let sock = ah_engine::paths::socket_in(&sc.state());
    let t = std::time::Instant::now();
    while t.elapsed().as_secs() < 10 && ah_engine::client::ping(&sock).is_none() {
        std::thread::sleep(std::time::Duration::from_millis(50));
    }
    let d = sc.doctor(&[]);
    crate::common::stop_child(&sock, &mut child);
    d.has("ok", &["the engine daemon is running (pong"]);
    d.lacks("do not serve");
}

#[test]
fn dmn_03_hung_daemon_holds_the_lock_and_never_answers() {
    let mut sc = Sc::new();
    sc.own_plugin();
    let _fake = FakeDaemon::start(&sc.state());
    let d = sc.doctor(&[]);
    d.has("bad", &["a daemon holds", ".sock.lock", &format!("(pid {})", std::process::id()), "does not answer on", "it is hung", "ah-engine stop"]);
    assert_eq!(d.code, 1);
}

#[test]
fn dmn_04_stale_socket_and_dmn_05_not_a_socket() {
    let mut sc = Sc::new();
    sc.own_plugin();
    let state = sc.state();
    fs::create_dir_all(&state).unwrap();
    let sock = ah_engine::paths::socket_in(&state);
    drop(std::os::unix::net::UnixListener::bind(&sock).unwrap()); // the file stays, nobody listens
    let d = sc.doctor(&[]);
    d.has("warn", &["exists but no daemon holds the lock", "the next daemon replaces it"]);
    assert_eq!(d.code, 0);
    fs::remove_file(&sock).unwrap();
    fs::write(&sock, "x").unwrap();
    let d = sc.doctor(&[]);
    d.has("bad", &["exists but is not a socket (a regular file)", "mv"]);
    sc.shell().has("bad", &["exists but is not a socket (a regular file)"]);
    fs::remove_file(&sock).unwrap();
    fs::create_dir(&sock).unwrap();
    sc.doctor(&[]).has("bad", &["is not a socket (a directory)"]);
}

#[test]
fn dmn_06_07_stale_pid_files() {
    let mut sc = Sc::new();
    sc.own_plugin();
    let state = sc.state();
    fs::create_dir_all(&state).unwrap();
    let lock = ah_engine::paths::lock_for(&ah_engine::paths::socket_in(&state));
    // a pid that is gone
    let mut gone = Command::new("true").spawn().unwrap();
    gone.wait().unwrap();
    fs::write(&lock, gone.id().to_string()).unwrap();
    let d = sc.doctor(&[]);
    d.has("info", &["names pid", &gone.id().to_string(), "which is gone; the next daemon takes it over"]);
    sc.shell().has("info", &["which is gone; the next daemon takes it over"]);
    // a pid reused by another program: reported, never signalled
    let mut other = Command::new("sleep").arg("30").spawn().unwrap();
    fs::write(&lock, other.id().to_string()).unwrap();
    let d = sc.doctor(&[]);
    d.has("warn", &["which is now another program", "sleep", "nothing signals that process", "do NOT kill"]);
    sc.shell().has("warn", &["which is now another program", "do NOT kill"]);
    assert!(other.try_wait().unwrap().is_none(), "the doctor must not signal the stranger");
    other.kill().ok();
    other.wait().ok();
}

#[test]
fn dmn_08_09_crash_loop_and_breaker_with_the_recorded_failure() {
    let mut sc = Sc::new();
    sc.own_plugin();
    let state = sc.state();
    fs::create_dir_all(&state).unwrap();
    fs::write(state.join("crashloop.until"), (now_ms() + 60_000).to_string()).unwrap();
    fs::write(
        state.join("failure.json"),
        format!(
            "{{\"ts\":{},\"class\":\"env\",\"kind\":\"crashloop\",\"code\":\"os28\",\"hint\":\"free disk space\",\"reason\":\"3 crashes in 60s\"}}",
            now_ms()
        ),
    )
    .unwrap();
    let d = sc.doctor(&[]);
    d.has("bad", &["daemon crash-looping: restarts halted for", "3 crashes in 60s", "ah-engine reset"]);
    d.has("warn", &["last recorded failure (env): 3 crashes in 60s", "free disk space"]);
    assert_eq!(d.code, 1);
    sc.shell().has("bad", &["daemon crash-looping: restarts halted for", "3 crashes in 60s"]);
    fs::remove_file(state.join("crashloop.until")).unwrap();
    fs::write(state.join("breaker.until"), (now_ms() + 60_000).to_string()).unwrap();
    let d = sc.doctor(&[]);
    d.has("warn", &["client circuit breaker open for", "hooks use the Node fallback meanwhile"]);
    assert_eq!(d.code, 0);
    // an expired cooldown is not reported
    fs::write(state.join("breaker.until"), (now_ms() - 1000).to_string()).unwrap();
    sc.doctor(&[]).lacks("circuit breaker");
}

/// A process that looks like an engine daemon to the pid check (`<name> serve` on its command line).
fn fake_serve() -> std::process::Child {
    Command::new("sh").args(["-c", "sleep 30; :", "ah-engine", "serve"]).stdin(Stdio::null()).spawn().unwrap()
}

#[test]
fn dmn_10_two_daemons_in_one_state_directory() {
    let mut sc = Sc::new();
    sc.own_plugin();
    let state = sc.state();
    fs::create_dir_all(&state).unwrap();
    let (mut a, mut b) = (fake_serve(), fake_serve());
    // the event log of this state directory says both started here
    let log: String = [&a, &b].iter().map(|c| format!("{}\tstart\t-\tv0.1.0 pid {} mem_limit 0\n", now_ms(), c.id())).collect();
    fs::write(state.join("ah-engine.log"), log).unwrap();
    std::thread::sleep(std::time::Duration::from_millis(200));
    let d = sc.doctor(&[]);
    d.has("warn", &["engine daemons are running", &a.id().to_string(), &b.id().to_string(), "ah-engine stop"]);
    // a logged daemon that has exited, or a pid that is another program, is not a second daemon
    a.kill().ok();
    a.wait().ok();
    b.kill().ok();
    b.wait().ok();
    let mut stranger = Command::new("sleep").arg("30").spawn().unwrap();
    fs::write(
        state.join("ah-engine.log"),
        format!("{}\tstart\t-\tv0.1.0 pid {} mem_limit 0\n{}\tstart\t-\tv0.1.0 pid {} mem_limit 0\n", now_ms(), a.id(), now_ms(), stranger.id()),
    )
    .unwrap();
    sc.doctor(&[]).lacks("engine daemons are running");
    stranger.kill().ok();
    stranger.wait().ok();
}

// ---- ST: the state directory ---------------------------------------------------------------------------------------------------

#[test]
fn st_01_missing_is_created_by_the_repair_and_a_second_run_finds_nothing() {
    let mut sc = Sc::new();
    sc.own_plugin();
    sc.shell().has("info", &["does not exist yet; it is created on first use"]);
    let d = sc.doctor(&[]);
    d.has("info", &["does not exist yet; it is created on first use"]);
    assert_eq!(d.code, 0);

    let dry = sc.doctor_raw(&["--dry-run"]);
    dry.has("info", &["state-dir-create", "would have created the private state directory"]);
    fs::remove_dir_all(sc.state()).ok(); // (the run's own telemetry line may have created it; the repair below must do so itself)
    sc.doctor_raw(&["--repair"]).has("ok", &["state-dir-create", "created the private state directory"]);
    assert_eq!(fs::metadata(sc.state()).unwrap().permissions().mode() & 0o777, 0o700);
    let again = sc.doctor(&[]);
    again.lacks("does not exist yet");
    again.has("ok", &["is usable"]);
    assert!(!sc.doctor_raw(&["--repair"]).text.contains("state-dir-create"), "idempotent");
}

#[test]
fn st_01b_missing_and_not_creatable() {
    if is_root() {
        return;
    }
    let mut sc = Sc::new();
    sc.own_plugin();
    let ah = sc.home.join(".anti-hall");
    fs::create_dir_all(&ah).unwrap();
    fs::set_permissions(&ah, fs::Permissions::from_mode(0o500)).unwrap();
    let d = sc.doctor(&[]);
    d.has("bad", &["cannot be created", "is not writable"]);
    assert_eq!(d.code, 1);
    let shell = sc.shell();
    shell.has("bad", &["cannot be created", "is not writable"]);
    assert_eq!(d.section("State directory"), shell.section("State directory"));
}

#[test]
fn st_02_a_file_where_the_directory_should_be() {
    let mut sc = Sc::new();
    sc.own_plugin();
    // the state directory itself is a file
    fs::create_dir_all(sc.home.join(".anti-hall")).unwrap();
    fs::write(sc.state(), "not a directory").unwrap();
    let d = sc.doctor(&[]);
    d.has("bad", &["is a file where the state directory (or a parent) should be", "mv", ".old"]);
    assert_eq!(d.code, 1);
    assert_eq!(d.section("State directory"), sc.shell().section("State directory"));
    // a parent is a file (ENOTDIR on the way down)
    fs::remove_file(sc.state()).unwrap();
    fs::remove_dir_all(sc.home.join(".anti-hall")).unwrap();
    fs::write(sc.home.join(".anti-hall"), "a file").unwrap();
    let d = sc.doctor(&[]);
    d.has("bad", &[&format!("{} is a file where the state directory", sc.home.join(".anti-hall").display())]);
    assert_eq!(d.section("State directory"), sc.shell().section("State directory"));
}

#[test]
fn st_03_read_only_state_directory() {
    if is_root() {
        return;
    }
    let mut sc = Sc::new();
    sc.own_plugin();
    fs::create_dir_all(sc.state()).unwrap();
    fs::set_permissions(sc.state(), fs::Permissions::from_mode(0o500)).unwrap();
    let d = sc.doctor(&[]);
    d.has("bad", &["is not writable", "chmod u+w"]);
    assert_eq!(d.code, 1);
    assert_eq!(d.section("State directory"), sc.shell().section("State directory"));
}

#[test]
fn st_04_disk_nearly_full_by_the_plugins_threshold() {
    let mut sc = Sc::new();
    sc.own_plugin();
    fs::create_dir_all(sc.state()).unwrap();
    fs::set_permissions(sc.state(), fs::Permissions::from_mode(0o700)).unwrap();
    // the limit is a plugin setting: raise it above any disk and the volume counts as nearly full
    let toml = sc.plugin.join("engine/defaults/doctor.toml");
    let text = fs::read_to_string(&toml).unwrap();
    let a = text.find("[doctor.min_free_mb]").unwrap();
    let patched = format!("{}{}", &text[..a], text[a..].replacen("value = 100", "value = 999999999999", 1));
    fs::write(&toml, patched).unwrap();
    let d = sc.doctor(&[]);
    d.has("warn", &["MB free on the volume of", "(limit 999999999999)", "free disk space"]);
    assert_eq!(d.code, 0, "low space is a warning");
}

#[test]
fn st_05_wrong_owner() {
    if is_root() {
        return;
    }
    let mut sc = Sc::new();
    sc.own_plugin();
    // /usr is owned by root on macOS and Linux
    let mut c = Command::new(BIN);
    c.arg("doctor").arg("--check").arg("--plugin-root").arg(&sc.plugin);
    sc.env(&mut c);
    c.env("AH_ENGINE_DIR", "/usr");
    let d = sc.finish(c);
    d.has("bad", &["/usr is owned by uid 0, not you", "sudo chown"]);
    assert_eq!(d.code, 1);
}

#[test]
fn st_06_state_directory_open_to_others_and_the_repair() {
    if is_root() {
        return;
    }
    let mut sc = Sc::new();
    sc.own_plugin();
    fs::create_dir_all(sc.state()).unwrap();
    fs::set_permissions(sc.state(), fs::Permissions::from_mode(0o755)).unwrap();
    let d = sc.doctor(&[]);
    d.has("warn", &["is accessible to others (mode 755)", "chmod 700"]);
    sc.doctor_raw(&["--repair"]).has("ok", &["state-dir-private", "to mode 700"]);
    assert_eq!(fs::metadata(sc.state()).unwrap().permissions().mode() & 0o777, 0o700);
    sc.doctor(&[]).lacks("accessible to others");
}

#[test]
fn st_09_a_database_that_is_not_sqlite() {
    let mut sc = Sc::new();
    sc.own_plugin();
    fs::create_dir_all(sc.state()).unwrap();
    fs::set_permissions(sc.state(), fs::Permissions::from_mode(0o700)).unwrap();
    fs::write(sc.state().join("hot.db"), b"this is not a database at all").unwrap();
    let d = sc.doctor(&[]);
    d.has("bad", &["hot.db is not a SQLite database (bad header)", ".bad"]);
    fs::write(sc.state().join("hot.db"), b"").unwrap();
    sc.doctor(&[]).lacks("not a SQLite database");
}

// ---- CF: configuration ---------------------------------------------------------------------------------------------------------

#[test]
fn cf_01_healthy_configuration() {
    let mut sc = Sc::new();
    sc.own_plugin();
    sc.doctor(&[]).has("ok", &["configuration:", "settings read from the plugin's defaults"]);
}

#[test]
fn cf_02_a_broken_edit_falls_back_to_the_pristine_copy() {
    let mut sc = Sc::new();
    sc.own_plugin();
    let f = sc.plugin.join("engine/defaults/limits.toml");
    let mut text = fs::read_to_string(&f).unwrap();
    text.push_str("\n[[[ this is not toml\n");
    fs::write(&f, text).unwrap();
    let d = sc.doctor(&[]);
    d.has("warn", &["limits.toml", "using the pristine copy instead", "restore the file from engine/defaults.pristine/"]);
    assert_eq!(d.code, 0, "the engine keeps working on the pristine copy\n{}", d.text);
}

#[test]
fn cf_03_a_defaults_file_lacks_a_setting_and_the_repair_adds_it() {
    let mut sc = Sc::new();
    sc.own_plugin();
    // an older edited copy: drop one setting from an edited file (the pristine copy still has it)
    let f = sc.plugin.join("engine/defaults/doctor.toml");
    let text = fs::read_to_string(&f).unwrap();
    let a = text.find("[doctor.day_s]").unwrap();
    let b = a + text[a..].find("\n\n").unwrap() + 2;
    fs::write(&f, format!("{}{}", &text[..a], &text[b..])).unwrap();
    let d = sc.doctor(&[]);
    d.has("warn", &["doctor.toml lacks 1 setting(s)", "doctor.day_s", "ah-engine config heal"]);
    sc.doctor_raw(&["--repair"]).has("ok", &["config-heal"]);
    let after = sc.doctor(&[]);
    after.lacks("lacks 1 setting");
    assert!(fs::read_to_string(&f).unwrap().contains("[doctor.day_s]"), "the setting is back in the edited file");
}

#[test]
fn cf_04_pristine_copy_missing() {
    let mut sc = Sc::new();
    sc.own_plugin();
    fs::remove_dir_all(sc.plugin.join("engine/defaults.pristine")).unwrap();
    let d = sc.doctor(&[]);
    d.has("warn", &["engine/defaults.pristine is missing", "no last-resort copy"]);
    sc.shell().has("warn", &["engine/defaults.pristine is missing", "no last-resort copy"]);
}

#[test]
fn cf_05_unknown_settings_are_reported_not_failed() {
    let mut sc = Sc::new();
    sc.own_plugin();
    let f = sc.plugin.join("engine/defaults/doctor.toml");
    let mut text = fs::read_to_string(&f).unwrap();
    text.push_str("\n[doctor.not_a_real_key]\ndoc = \"a typo\"\nvalue = 1\n");
    fs::write(&f, text).unwrap();
    let d = sc.doctor(&[]);
    d.has("info", &["doctor.toml: unknown setting(s) doctor.not_a_real_key", "a typo?"]);
    assert_eq!(d.code, 0);
}

#[test]
fn cf_06_07_the_users_own_config_and_settings_files() {
    let mut sc = Sc::new();
    sc.own_plugin();
    fs::create_dir_all(sc.state()).unwrap();
    fs::set_permissions(sc.state(), fs::Permissions::from_mode(0o700)).unwrap();
    fs::write(sc.state().join("config.toml"), "[daemon\nworkers = ").unwrap();
    sc.put(".anti-hall/settings.json", b"{ not json");
    let d = sc.doctor(&[]);
    d.has("warn", &["config.toml", "ignored, the plugin defaults apply"]);
    d.has("warn", &["settings.json is unreadable", "settings fall back to defaults"]);
    assert_eq!(d.code, 0);
}

#[test]
fn cf_08_defaults_cannot_load_at_all_hands_over_to_the_shell_doctor() {
    let mut sc = Sc::new();
    sc.own_plugin();
    fs::remove_dir_all(sc.plugin.join("engine/defaults.pristine")).unwrap();
    fs::write(sc.plugin.join("engine/defaults/index.toml"), "[[[ garbage").unwrap();
    let mut c = Command::new(BIN);
    c.arg("doctor").arg("--check").arg("--plugin-root").arg(&sc.plugin);
    sc.env(&mut c);
    let d = sc.finish(c);
    assert_eq!(d.code, 1, "{}\n{}", d.text, d.err);
    assert!(d.err.contains("defaults unavailable"), "the engine says why on stderr: {}", d.err);
    d.has("bad", &["engine defaults cannot be loaded:", "hooks use the Node fallback"]);
    assert!(d.text.contains("anti-hall doctor v"), "{}", d.text);
    assert!(!sc.state().join("defaults.error").exists(), "the doctor wrote nothing");
    // with no plugin root at all there is nobody to hand over to: a plain failure
    let mut c = Command::new(BIN);
    c.arg("doctor").arg("--check");
    sc.env(&mut c);
    c.env("AH_ENGINE_PLUGIN_ROOT", sc.root.join("nowhere"));
    let d = sc.finish(c);
    assert_eq!(d.code, 70);
    assert!(d.err.contains("defaults unavailable"));
}

// ---- PL: the plugin registry ---------------------------------------------------------------------------------------------------

fn registry(sc: &Sc, entries: &[(&str, &Path, &str)]) {
    let plugins: Vec<String> =
        entries.iter().map(|(k, p, v)| format!("\"{k}\":[{{\"scope\":\"user\",\"installPath\":\"{}\",\"version\":\"{v}\"}}]", p.display())).collect();
    sc.put(".claude/plugins/installed_plugins.json", format!("{{\"version\":2,\"plugins\":{{{}}}}}", plugins.join(",")).as_bytes());
}

fn enabled(sc: &Sc, flags: &[(&str, bool)]) {
    let m: Vec<String> = flags.iter().map(|(k, v)| format!("\"{k}\":{v}")).collect();
    sc.put(".claude/settings.json", format!("{{\"enabledPlugins\":{{{}}}}}", m.join(",")).as_bytes());
}

fn plugin_version(sc: &Sc) -> String {
    let t = fs::read_to_string(sc.plugin.join(".claude-plugin/plugin.json")).unwrap();
    t.split("\"version\"").nth(1).unwrap().split('"').nth(1).unwrap().to_string()
}

#[test]
fn pl_08_registered_and_enabled() {
    let mut sc = Sc::new();
    sc.own_plugin();
    let (p, v) = (sc.plugin.clone(), plugin_version(&sc));
    registry(&sc, &[("anti-hall@anti-hall", &p, &v)]);
    enabled(&sc, &[("anti-hall@anti-hall", true)]);
    sc.doctor(&[]).has("ok", &["plugin anti-hall@anti-hall", "is registered and enabled"]);
}

#[test]
fn pl_02_no_registry_is_info_and_an_empty_one_is_a_warning() {
    let mut sc = Sc::new();
    sc.own_plugin();
    sc.doctor(&[]).has("info", &["no plugin registry at", "plugin enablement was not checked"]);
    registry(&sc, &[("other@market", Path::new("/x"), "1.0.0")]);
    sc.doctor(&[]).has("warn", &["no anti-hall plugin is registered in", "/plugin install anti-hall@anti-hall"]);
}

#[test]
fn pl_03_installed_but_disabled() {
    let mut sc = Sc::new();
    sc.own_plugin();
    let (p, v) = (sc.plugin.clone(), plugin_version(&sc));
    registry(&sc, &[("anti-hall@anti-hall", &p, &v)]);
    enabled(&sc, &[("anti-hall@anti-hall", false)]);
    let d = sc.doctor(&[]);
    d.has("bad", &["anti-hall (anti-hall@anti-hall) is installed but disabled", "/plugin enable anti-hall@anti-hall"]);
    assert_eq!(d.code, 1);
}

#[test]
fn pl_04_05_two_enabled_and_an_old_node_build() {
    let mut sc = Sc::new();
    sc.own_plugin();
    let old = sc.root.join("old-plugin");
    fs::create_dir_all(old.join("hooks")).unwrap();
    fs::write(
        old.join("hooks/hooks.json"),
        r#"{"hooks":{"PreToolUse":[{"hooks":[{"type":"command","command":"node ${CLAUDE_PLUGIN_ROOT}/hooks/git-guard.js"}]}]}}"#,
    )
    .unwrap();
    let (p, v) = (sc.plugin.clone(), plugin_version(&sc));
    registry(&sc, &[("anti-hall@anti-hall", &p, &v), ("anti-hall@legacy", &old, "0.120.0")]);
    enabled(&sc, &[("anti-hall@anti-hall", true), ("anti-hall@legacy", true)]);
    let d = sc.doctor(&[]);
    d.has("bad", &["2 anti-hall plugins are enabled", "anti-hall@anti-hall", "anti-hall@legacy", "every hook runs twice"]);
    d.has("bad", &["enabled plugin anti-hall@legacy (v0.120.0) still wires Node hooks directly"]);
    assert_eq!(d.code, 1);
    // one of them disabled: no double
    enabled(&sc, &[("anti-hall@anti-hall", true), ("anti-hall@legacy", false)]);
    sc.doctor(&[]).lacks("every hook runs twice");
}

#[test]
fn pl_07_the_registered_install_path_is_gone() {
    let mut sc = Sc::new();
    sc.own_plugin();
    let gone = sc.root.join("cache/anti-hall/9.9.9");
    registry(&sc, &[("anti-hall@anti-hall", &gone, "9.9.9")]);
    enabled(&sc, &[("anti-hall@anti-hall", true)]);
    let d = sc.doctor(&[]);
    d.has("bad", &["anti-hall@anti-hall is registered at", "9.9.9", "which does not exist (moved or pruned)", "claude plugin update"]);
    assert_eq!(d.code, 1);
}

#[test]
fn pl_06_registry_and_session_versions_differ() {
    let mut sc = Sc::new();
    sc.own_plugin();
    let p = sc.plugin.clone();
    registry(&sc, &[("anti-hall@anti-hall", &p, "999.0.0")]);
    enabled(&sc, &[("anti-hall@anti-hall", true)]);
    sc.doctor(&[]).has("warn", &["the plugin registry says 999.0.0", "/reload-plugins"]);
    registry(&sc, &[("anti-hall@anti-hall", &p, "0.0.1")]);
    sc.doctor(&[]).has("warn", &["the plugin registry still says 0.0.1", "claude plugin update"]);
}

#[test]
fn pl_09_registry_or_settings_not_json() {
    let mut sc = Sc::new();
    sc.own_plugin();
    sc.put(".claude/plugins/installed_plugins.json", b"{ nope");
    sc.put(".claude/settings.json", b"also nope");
    let d = sc.doctor(&[]);
    d.has("warn", &["installed_plugins.json is not valid JSON"]);
    d.has("warn", &["settings.json is not valid JSON"]);
    assert_eq!(d.code, 0);
}

// ---- HK: the thin hooks files --------------------------------------------------------------------------------------------------

#[test]
fn hk_01_hooks_json_not_the_thin_form() {
    let mut sc = Sc::new();
    sc.own_plugin();
    sc.doctor(&[]).has("ok", &["hooks/hooks.json is the thin form"]);
    let f = sc.plugin.join("hooks/hooks.json");
    let text = fs::read_to_string(&f).unwrap().replace("ah-hook.sh\\\" PreToolUse", "git-guard.js\\\" PreToolUse");
    fs::write(&f, text).unwrap();
    let d = sc.doctor(&[]);
    d.has("bad", &["hooks/hooks.json is not the thin form: 1 event(s) differ", "PreToolUse", "ah-engine gen-hooks --host claude"]);
    assert_eq!(d.code, 1);
    let shell = sc.shell();
    shell.has("bad", &["hooks/hooks.json is not the thin form", "ah-engine gen-hooks --host claude"]);
    // the codex file is checked too
    let c = sc.plugin.join("codex/hooks/hooks.json");
    fs::write(&c, "{\"hooks\":{}}").unwrap();
    sc.doctor(&[]).has("bad", &["codex/hooks/hooks.json is not the thin form"]);
}

#[test]
fn hk_02_03_hooks_json_missing_or_broken_and_wrapper_missing() {
    let mut sc = Sc::new();
    sc.own_plugin();
    fs::write(sc.plugin.join("hooks/hooks.json"), "{ nope").unwrap();
    sc.doctor(&[]).has("bad", &["hooks.json"]);
    fs::remove_file(sc.plugin.join("hooks/hooks.json")).unwrap();
    sc.doctor(&[]).has("bad", &["hooks/hooks.json is missing", "reinstall the plugin"]);
    fs::remove_file(sc.plugin.join("hooks/ah-hook.sh")).unwrap();
    sc.doctor(&[]).has("bad", &["ah-hook.sh is missing; every hook command fails"]);
}

// ---- ND / EV: Node, tools, HOME, PATH -------------------------------------------------------------------------------------------

#[test]
fn nd_node_missing_old_broken_and_fine() {
    let mut sc = Sc::new();
    sc.own_plugin();
    sc.programs(&[], &["node"]);
    let d = sc.doctor(&[]);
    d.has("warn", &["node is not on PATH", "Node is optional", "none needed"]);
    d.has("bad", &["no working engine", "Node is not needed"]);
    assert_eq!(d.code, 1);
    // the engine works: no node is only a warning, Node is not a requirement
    sc.stub_engine("0.1.0");
    let d = sc.doctor(&[]);
    d.has("warn", &["node is not on PATH"]);
    d.lacks("no working engine");
    assert_eq!(d.code, 0);
    let shell = sc.shell();
    shell.has("warn", &["node is not on PATH", "Node is optional"]);
    shell.lacks("no working engine");
    // too old, broken, fine: warnings and a note, never a failure while the engine works
    sc.programs(&[("node", "echo v18.19.0")], &[]);
    let d = sc.doctor(&[]);
    d.has("warn", &["Node v18.19.0 is < 22; Node is optional"]);
    assert_eq!(d.code, 0);
    sc.shell().has("warn", &["Node v18.19.0 is < 22; Node is optional"]);
    sc.programs(&[("node", "echo oops >&2; exit 4")], &[]);
    let d = sc.doctor(&[]);
    d.has("warn", &["node does not run: exit 4 oops"]);
    assert_eq!(d.code, 0);
    sc.programs(&[("node", "echo v22.3.0")], &[]);
    sc.doctor(&[]).has("info", &["Node v22.3.0 (>= 22) found; optional"]);
    sc.shell().has("info", &["Node v22.3.0 (>= 22) found; optional"]);
}

#[test]
fn nd_with_node_twins_off_the_doctor_never_starts_node() {
    // a node on PATH that records every start: with doctor.node_twins off, the engine doctor (live self-tests, statusline
    // render, supervisor and renderer syntax checks) must not run it beyond the optional version probe, and every self-test the
    // engine defers is a warning, never a pass
    let mut sc = Sc::new();
    sc.own_plugin();
    sc.stub_engine("0.1.0");
    for dir in ["engine/defaults", "engine/defaults.pristine"] {
        let f = sc.plugin.join(dir).join("doctor.toml");
        let t = fs::read_to_string(&f).unwrap();
        let at = t.find("[doctor.node_twins]").unwrap();
        let v = at + t[at..].find("value = true").unwrap();
        fs::write(&f, format!("{}value = false{}", &t[..v], &t[v + "value = true".len()..])).unwrap();
    }
    let log = sc.root.join("node-starts.log");
    sc.programs(&[("node", &format!("echo \"$*\" >> '{}'\necho v22.3.0", log.display()))], &[]);
    let d = sc.doctor(&[]);
    let starts = fs::read_to_string(&log).unwrap_or_default();
    let real: Vec<&str> = starts.lines().filter(|l| l.trim() != "--version").collect();
    assert!(real.is_empty(), "the doctor started node: {real:?}\n{}", d.text);
    d.has("warn", &["the engine defers this self-test to its Node hook, so it was not exercised here"]);
}

#[test]
fn lg_logs_flag_lists_the_recent_warn_and_error_entries() {
    let mut sc = Sc::new();
    sc.own_plugin();
    let logs = sc.root.join("central-logs");
    fs::create_dir_all(&logs).unwrap();
    let run = |sc: &Sc| {
        let mut c = Command::new(BIN);
        c.arg("doctor").arg("--check").arg("--logs").arg("--plugin-root").arg(&sc.plugin);
        sc.env(&mut c);
        c.env("ANTI_HALL_LOG_DIR", &logs);
        sc.finish(c)
    };
    let d = run(&sc);
    d.has("info", &["no warn/error entries in the central anti-hall log", &logs.display().to_string()]);
    d.lacks("--logs is not handled");
    let mut body = String::from("{\"ts\":\"t0\",\"level\":\"info\",\"component\":\"x\",\"op\":\"y\",\"msg\":\"quiet\"}\n{torn\n");
    for i in 0..12 {
        body.push_str(&format!("{{\"ts\":\"t{i}\",\"level\":\"warn\",\"component\":\"ingest\",\"op\":\"tick\",\"msg\":\"m{i}\\nsecond\"}}\n"));
    }
    body.push_str("{\"ts\":\"tz\",\"level\":\"error\",\"component\":\"cli\",\"op\":\"send\",\"repoKey\":\"r1\",\"err\":{\"message\":\"boom\"}}\n");
    fs::write(logs.join("devswarm.jsonl"), body).unwrap();
    let d = run(&sc);
    d.has("warn", &["13 warn/error entries in the central anti-hall log across 2 component(s) — cli:1, ingest:12"]);
    d.has("info", &["showing the most recent 10 of 13"]);
    d.has("warn", &["[t11] warn ingest/tick: m11"]);
    d.has("warn", &["[tz] error cli/send repoKey=r1: boom"]);
    d.lacks("quiet");
    d.lacks("[t2] warn");
    d.lacks("second");
    // report-only: the entries are warnings, not failures
    assert_eq!(d.code, run(&sc).code);
}

#[test]
fn ev_01_02_03_home_unset_relative_or_not_a_directory() {
    let mut sc = Sc::new();
    sc.own_plugin();
    // unset
    let mut c = Command::new(BIN);
    c.arg("doctor").arg("--check").arg("--plugin-root").arg(&sc.plugin).env_clear().env("PATH", &sc.path).current_dir(&sc.cwd);
    let d = sc.finish(c);
    d.has("bad", &["HOME is not set; the engine cannot find its state", "export HOME="]);
    assert_eq!(d.code, 1);
    let mut s = Command::new("sh");
    s.arg(sc.plugin.join("hooks/ah-hook.sh")).arg("--doctor").env_clear().env("PATH", &sc.path).current_dir(&sc.cwd);
    sc.finish(s).has("bad", &["HOME is not set; the engine cannot find its state"]);
    // relative
    let mut c = Command::new(BIN);
    c.arg("doctor").arg("--check").arg("--plugin-root").arg(&sc.plugin).env_clear().env("PATH", &sc.path).env("HOME", "rel/home").current_dir(&sc.cwd);
    let d = sc.finish(c);
    d.has("bad", &["HOME is \"rel/home\", a relative path"]);
    let mut s = Command::new("sh");
    s.arg(sc.plugin.join("hooks/ah-hook.sh")).arg("--doctor").env_clear().env("PATH", &sc.path).env("HOME", "rel/home").current_dir(&sc.cwd);
    sc.finish(s).has("bad", &["HOME is \"rel/home\", a relative path"]);
    // not a directory
    let missing = sc.root.join("no-such-home");
    let mut c = Command::new(BIN);
    c.arg("doctor").arg("--check").arg("--plugin-root").arg(&sc.plugin).env_clear().env("PATH", &sc.path).env("HOME", &missing).current_dir(&sc.cwd);
    sc.finish(c).has("bad", &["is not a directory"]);
}

#[test]
fn ev_05_06_07_git_and_gh() {
    let mut sc = Sc::new();
    sc.own_plugin();
    sc.programs(&[], &["git", "gh"]);
    let d = sc.doctor(&[]);
    d.has("warn", &["git is not on PATH; git-aware guards and project detection are off"]);
    d.has("info", &["gh is not on PATH; only the optional PR/CI helpers need it"]);
    sc.shell().has("warn", &["git is not on PATH; git-aware guards and project detection are off"]);
    // the macOS shim with no developer tools: present but failing
    sc.programs(&[("git", "echo 'xcode-select: note: no developer tools were found' >&2; exit 1")], &["gh"]);
    let d = sc.doctor(&[]);
    d.has("warn", &["git is on PATH but does not run (exit 1 xcode-select: note: no developer tools were found)", "xcode-select --install"]);
    sc.shell().has("warn", &["git is on PATH but does not run (exit 1 xcode-select: note: no developer tools were found)"]);
}

#[test]
fn ev_08_path_oddities() {
    let mut sc = Sc::new();
    sc.own_plugin();
    let run = |path: &str| {
        let mut c = Command::new(BIN);
        c.arg("doctor").arg("--check").arg("--plugin-root").arg(&sc.plugin);
        sc.env(&mut c);
        c.env("PATH", path);
        sc.finish(c)
    };
    let sys = sc.path.clone();
    run("").has("bad", &["PATH is empty; no tool can be found"]);
    run(&format!("{sys}:.")).has("warn", &["PATH has . entry, resolved against the current directory"]);
    run(&format!("{sys}::/tmp")).has("warn", &["PATH has an empty entry"]);
    run("/nonexistent").has("warn", &["PATH lacks /usr/bin, /bin"]);
    // the shell doctor says the same
    let mut s = Command::new("sh");
    s.arg(sc.plugin.join("hooks/ah-hook.sh")).arg("--doctor");
    sc.env(&mut s);
    s.env("PATH", format!("{sys}:."));
    sc.finish(s).has("warn", &["PATH has . entry, resolved against the current directory"]);
}

#[test]
fn ev_10_required_tools_missing() {
    let mut sc = Sc::new();
    sc.own_plugin();
    sc.programs(&[], &["awk", "od"]);
    let d = sc.doctor(&[]);
    d.has("warn", &["required tool(s) missing from PATH: awk, od", "install coreutils/procps"]);
    sc.shell().has("warn", &["required tool(s) missing from PATH: awk, od"]);
}

#[test]
fn ev_11_userland_flavour_is_reported() {
    let mut sc = Sc::new();
    sc.own_plugin();
    sc.doctor(&[]).has("info", &["userland:", "stat"]);
}

// ---- LG: logs and telemetry ----------------------------------------------------------------------------------------------------

#[test]
fn lg_logs_huge_corrupt_and_quarantined_spool() {
    let mut sc = Sc::new();
    sc.own_plugin();
    let st = sc.state();
    fs::create_dir_all(&st).unwrap();
    fs::set_permissions(&st, fs::Permissions::from_mode(0o700)).unwrap();
    sc.doctor(&[]).has("ok", &["event log and telemetry inbox look healthy"]);
    // a log far over its cap (sparse) and with garbage lines
    let log = st.join("ah-engine.log");
    let mut f = fs::OpenOptions::new().create(true).write(true).truncate(true).mode(0o600).open(&log).unwrap();
    f.write_all(format!("{}\tstart\t-\tv0.1.0 pid 1 mem_limit 0\nthis is not an event line\n", now_ms()).as_bytes()).unwrap();
    f.set_len(512 * 1024 * 1024).unwrap();
    drop(f);
    let d = sc.doctor(&[]);
    d.has("warn", &["ah-engine.log is 512 MB", "the engine's trim is not running", "ah-engine maintain"]);
    // the inbox
    fs::remove_file(&log).unwrap();
    fs::write(st.join("telemetry-inbox.jsonl"), "{\"ok\":1}\nnot json\n{broken\n").unwrap();
    sc.doctor(&[]).has("warn", &["2 of the last 3 lines of", "telemetry-inbox.jsonl are not JSON"]);
    fs::write(st.join("ah-engine.log"), "garbage line one\nmore garbage\n").unwrap();
    sc.doctor(&[]).has("warn", &["2 of the last 2 lines of", "are not event lines"]);
    // quarantined spool files
    let q = st.join("spool.quarantine");
    fs::create_dir_all(&q).unwrap();
    fs::write(q.join("a.bad"), "x").unwrap();
    let name = ah_engine::defaults::init().ok().map(|()| ah_engine::defaults::text("files.spool_quarantine")).unwrap_or("spool.quarantine");
    let q2 = st.join(name);
    fs::create_dir_all(&q2).unwrap();
    fs::write(q2.join("b.bad"), "x").unwrap();
    sc.doctor(&[]).has("warn", &["spool file(s) were quarantined in"]);
}

// ---- SH: the Node witness kit --------------------------------------------------------------------------------------------------

#[test]
fn sh_witness_absent_present_and_every_way_it_goes_wrong() {
    let mut sc = Sc::new();
    sc.own_plugin();
    sc.doctor(&[]).has("info", &["Node witness not installed (optional)"]);
    let kit = sc.home.join(".anti-hall/ah-node-shadow");
    fs::create_dir_all(&kit).unwrap();
    fs::write(kit.join("node-shadow.sh"), "#!/bin/sh\n").unwrap();
    // no skip list: the worker runs nothing
    sc.doctor(&[]).has("warn", &["has no node-shadow.skip; the witness runs nothing", "node-shadow.sh --install"]);
    fs::write(kit.join("node-shadow.skip"), "# skip\n").unwrap();
    fs::write(kit.join("root"), sc.plugin.display().to_string()).unwrap();
    sc.doctor(&[]).has("ok", &["Node witness installed"]);
    // its root is gone
    fs::write(kit.join("root"), sc.root.join("gone").display().to_string()).unwrap();
    sc.doctor(&[]).has("warn", &["the witness root", "does not exist"]);
    fs::write(kit.join("root"), sc.plugin.display().to_string()).unwrap();
    // a registered hook whose script is gone
    let script = kit.join("node-shadow.sh");
    sc.put(
        ".claude/settings.json",
        format!("{{\"hooks\":{{\"PreToolUse\":[{{\"hooks\":[{{\"type\":\"command\",\"command\":\"sh {} PreToolUse\"}}]}}]}}}}", script.display()).as_bytes(),
    );
    sc.doctor(&[]).has("ok", &["Node witness installed (1 hook entries"]);
    fs::remove_file(&script).unwrap();
    sc.doctor(&[]).has("warn", &["settings.json runs sh", "which does not exist", "node-shadow.sh --install"]);
    fs::write(&script, "#!/bin/sh\n").unwrap();
    // a huge log, and a registered witness whose log went quiet
    let log = kit.join("node-shadow.ndjson");
    let f = fs::OpenOptions::new().create(true).write(true).truncate(true).open(&log).unwrap();
    f.set_len(300 * 1024 * 1024).unwrap();
    f.set_modified(std::time::SystemTime::now() - std::time::Duration::from_secs(20 * 86400)).unwrap();
    drop(f);
    let d = sc.doctor(&[]);
    d.has("warn", &["node-shadow.ndjson is 300 MB", "rotate it"]);
    d.has("warn", &["the witness log has not changed for 20 days"]);
}

// ---- the report's shape and the repair gate ----------------------------------------------------------------------------------------

#[test]
fn a_read_only_run_writes_no_install_state_and_repair_without_a_cause_does_nothing() {
    let mut sc = Sc::new();
    sc.own_plugin();
    sc.stub_engine("0.1.0");
    sc.marker("0.1.0");
    fs::set_permissions(sc.state(), fs::Permissions::from_mode(0o700)).unwrap();
    let before = fs::read(sc.bin()).unwrap();
    let d = sc.doctor(&[]);
    assert_eq!(fs::read(sc.bin()).unwrap(), before);
    assert!(d.text.contains("Engine install") && d.text.contains("State directory") && d.text.contains("Configuration"), "{}", d.text);
    let r = sc.doctor_raw(&["--repair"]);
    for id in ["engine-binary-exec", "engine-binary-quarantine", "state-dir-create", "state-dir-private", "config-heal"] {
        assert!(!r.text.contains(id), "nothing to repair, yet {id} ran:\n{}", r.text);
    }
}

#[test]
fn json_output_carries_the_new_sections() {
    let mut sc = Sc::new();
    sc.own_plugin();
    let d = sc.doctor(&["--json"]);
    let v: serde_json::Value = serde_json::from_str(d.text.trim()).unwrap();
    let titles: Vec<&str> = v["sections"].as_array().unwrap().iter().filter_map(|s| s["title"].as_str()).collect();
    for want in [
        "Engine install",
        "State directory",
        "Configuration",
        "Plugin registration",
        "Hooks wiring (thin form)",
        "Toolchain and environment",
        "Logs and telemetry",
        "Node witness",
    ] {
        assert!(titles.contains(&want), "{want} in {titles:?}");
    }
}

// ---- the Node doctor as the shadow: the checks both make give the same answer ---------------------------------------------------

#[test]
fn shadow_the_node_doctor_agrees_on_a_missing_hook_script_and_on_node_itself() {
    let mut sc = Sc::new();
    sc.own_plugin();
    fs::remove_file(sc.plugin.join("hooks/git-guard.js")).unwrap();
    let mut n = Command::new("node");
    // the Node doctor runs read-only (--dry-run previews the repairs) from the scratch copy, in the scratch home
    n.arg(sc.plugin.join("hooks/doctor.js")).arg("--dry-run");
    n.env_clear()
        .env("PATH", std::env::var("PATH").unwrap_or_default())
        .env("HOME", &sc.home)
        .env("USERPROFILE", &sc.home)
        .env("ANTIHALL_INGEST_DRY_RUN", "1")
        .current_dir(&sc.cwd);
    let node = sc.finish(n);
    let engine = sc.doctor(&[]);
    // both call the missing script a failure, in the same words, and both exit non-zero
    let bad = |o: &Out| o.text.lines().any(|l| l.contains("git-guard.js") && l.contains("REGISTERED BUT MISSING"));
    assert!(bad(&node), "node: {}", node.text);
    assert!(bad(&engine), "engine: {}", engine.text);
    assert_ne!(node.code, 0);
    assert_ne!(engine.code, 0);
    // and both see this Node (the engine doctor as an optional one)
    node.has("ok", &["Node v", "hooks can run"]);
    engine.has("info", &["Node v", "found; optional"]);
}

// ---- the optional `claude doctor` sub-check ---------------------------------------------------------------------------------------

#[test]
fn claude_doctor_missing_clean_problems_unsupported_and_hung() {
    let mut sc = Sc::new();
    sc.own_plugin();
    sc.doctor(&[]).has("info", &["the claude CLI is not on PATH", "skipped"]);
    let script = |body: &str| format!("if [ \"$1\" = --version ]; then echo '9.9.9 (Claude Code)'; exit 0; fi\n{body}");
    sc.programs(&[("claude", &script("echo 'Claude Code doctor'; echo; echo 'No installation issues found.'"))], &[]);
    sc.doctor(&[]).has("ok", &["claude doctor (Claude Code 9.9.9 (Claude Code)): no installation issues found"]);
    sc.programs(&[("claude", &script("echo 'Claude Code doctor'; echo 'Warning: settings.json has an invalid hook'; echo 'Path: /x'"))], &[]);
    let d = sc.doctor(&[]);
    d.has("warn", &["claude doctor: Warning: settings.json has an invalid hook"]);
    d.lacks("Path: /x");
    assert_eq!(d.code, 0, "its findings are warnings here, ours decide the exit");
    // a version without the subcommand: skipped, and remembered per version
    fs::create_dir_all(sc.state()).unwrap();
    fs::set_permissions(sc.state(), fs::Permissions::from_mode(0o700)).unwrap();
    sc.programs(&[("claude", &script("echo 'error: unknown command doctor' >&2; exit 1"))], &[]);
    sc.doctor(&[]).has("info", &["has no usable `claude doctor`; skipped"]);
    assert!(fs::read_to_string(sc.state().join("claude-doctor.version")).unwrap().contains("no"));
    // the cached verdict spares the second probe: even a claude that would now succeed is not run for the same version
    sc.programs(&[("claude", &script("echo 'Claude Code doctor'; echo 'Warning: x'"))], &[]);
    sc.doctor(&[]).has("info", &["has no usable `claude doctor`; skipped"]);
    // a hang is cut off
    fs::remove_file(sc.state().join("claude-doctor.version")).unwrap();
    let toml = sc.plugin.join("engine/defaults/doctor.toml");
    fs::write(&toml, fs::read_to_string(&toml).unwrap().replace("value = 20000", "value = 300")).unwrap();
    fs::write(sc.plugin.join("engine/defaults.pristine/doctor.toml"), fs::read_to_string(&toml).unwrap()).unwrap();
    sc.programs(&[("claude", &script("exec sleep 30"))], &[]);
    sc.doctor(&[]).has("info", &["did not finish in time; skipped"]);
}

// ---- regressions -----------------------------------------------------------------------------------------------------------------

#[test]
fn the_plugin_root_flag_wins_over_the_environment() {
    // the environment names a plugin whose pristine copy is missing and whose limits.toml is broken; the flag names a healthy one
    let mut broken = Sc::new();
    broken.own_plugin();
    fs::write(broken.plugin.join("engine/defaults/limits.toml"), "[[[ nope").unwrap();
    let mut good = Sc::new();
    good.own_plugin();
    let mut c = Command::new(BIN);
    c.arg("doctor").arg("--check").arg("--plugin-root").arg(&good.plugin);
    good.env(&mut c);
    c.env("AH_ENGINE_PLUGIN_ROOT", &broken.plugin);
    let d = good.finish(c);
    d.lacks("limits.toml:");
    d.has("ok", &["configuration:", "settings read from the plugin's defaults"]);
    // and the other way round: the flag at the broken plugin is what is read, whatever the variable says
    let mut c = Command::new(BIN);
    c.arg("doctor").arg("--check").arg("--plugin-root").arg(&broken.plugin);
    good.env(&mut c);
    let d = good.finish(c);
    d.has("warn", &["limits.toml", "using the pristine copy instead"]);
}

#[test]
fn doctor_check_leaves_the_state_directory_alone() {
    let mut sc = Sc::new();
    sc.own_plugin();
    let d = sc.doctor(&[]);
    assert_eq!(d.code, 0, "{}", d.text);
    assert!(!sc.home.join(".anti-hall").exists(), "a check created {}", sc.home.join(".anti-hall").display());
    // the repair, which does write, still may
    sc.doctor_raw(&["--repair"]);
    assert!(sc.state().exists());
}

#[test]
fn ds_the_supervisor_files_must_parse_and_the_hook_tests_must_pass() {
    let mut sc = Sc::new();
    sc.own_plugin();
    sc.programs(&[], &[]);
    // the hooks the self-tests run need the companion libraries and the scripts beside them
    fs::remove_file(sc.plugin.join("companion")).unwrap();
    copy_dir(&real_plugin().join("companion"), &sc.plugin.join("companion"));
    // a supervisor script that does not parse is a failure, even with DevSwarm dormant
    let live = sc.plugin.join("companion/lib/liveness.js");
    let good = fs::read(&live).unwrap();
    fs::write(&live, "function (((\n").unwrap();
    let d = sc.doctor(&[]);
    d.has("bad", &["supervisor lib SYNTAX ERROR: liveness.js"]);
    assert_eq!(d.code, 1);
    fs::write(&live, good).unwrap();
    let d = sc.doctor(&[]);
    d.lacks("DevSwarm liveness supervisor");
    assert_eq!(d.code, 0);
    // an installed supervisor (a launchd agent or a systemd timer file) makes the section appear
    let unit = if host_os() == "macos" {
        "Library/LaunchAgents/com.anti-hall.devswarm-supervisor.plist"
    } else {
        ".config/systemd/user/anti-hall-devswarm-supervisor.timer"
    };
    sc.put(unit, b"x");
    let d = sc.doctor(&[]);
    d.has("ok", &["supervisor companion INSTALLED (", "background sweep)"]);
    assert_eq!(d.code, 0);
}
