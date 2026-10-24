//! `ah-hook install [--lock FILE] [--print-target] [--auto] [-v]`: install the engine (and the thin client itself, when the release
//! ships it) pinned by the plugin's `ah-engine.lock`. The port of `hooks/ah-engine-bootstrap.sh`.
//!
//! - Pinned: the version and the sha256 of every release archive come from the lock, never from the network; an archive whose
//!   sha256 differs is refused and nothing is installed.
//! - Safe: never fails a session. Every outcome exits 0 and is logged (`install.file_log`); a skipped install is harmless because the
//!   hooks pass through while the engine is absent.
//! - Idempotent: the marker records `<version> <archive sha256> <engine sha256> [<ah-hook sha256>]` of what this installed; the same
//!   lock does nothing, and a binary that does not match the marker (a local build) is never overwritten.
//! - Rate limited: after a failed attempt the next automatic one waits `install.retry_s`.
//! - Atomic: each binary is staged inside the state directory and renamed over its target; the replaced one is kept as `.prev`.
//! - `--auto` is the form the session start uses: it installs only when the setting `engine.bootstrap` (opt-in, default off) or the
//!   environment variable says so. Without `--auto` the operator asked for it, so the setting is not consulted.
//!
//! Every name, command line, path and number comes from `[install.*]` of the plugin's `engine/defaults/engine.toml`; a file that lacks
//! one means there is nothing safe to do (one log line, exit 0).

use crate::cfg::Settings;
use crate::integrity::Integ;
use crate::rec::{self, epoch_s};
use crate::util::{env_nonempty, fill};
use sha2::{Digest, Sha256};
use std::fs;
use std::io::{Read, Write};
use std::os::unix::fs::PermissionsExt;
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

/// Every `[install.*]` setting, read once. `None` from `load` = the file lacks one: nothing safe to do.
struct Cfg {
    release_base: String,
    release_dir: String,
    asset_name: String,
    member_dir: String,
    member_engine: String,
    member_hook: String,
    lock_schema: u64,
    retry_s: u64,
    run_s: u64,
    kill_grace: Duration,
    poll: Duration,
    stale_lock_s: u64,
    log_max: u64,
    log_keep: usize,
    file_log: String,
    file_marker: String,
    file_attempt: String,
    dir_lock: String,
    prev_suffix: String,
    tmp_prefix: String,
    settings_file: String,
    setting_section: String,
    setting_key: String,
    setting_on: Vec<String>,
    setting_off: Vec<String>,
    os_macos: String,
    os_linux: String,
    cpu_arm: Vec<String>,
    cpu_x86: Vec<String>,
    cpu_arm_name: String,
    cpu_x86_name: String,
    triple_macos: String,
    triple_linux: String,
    libc_default: String,
    libc_musl: String,
    musl_globs: Vec<String>,
    musl_probe: Vec<String>,
    musl_word: String,
    wsl_word: String,
    rosetta_sysctl: String,
    curl_cmd: Vec<String>,
    curl_cmd_test: Vec<String>,
    wget_cmd: Vec<String>,
    connect_s: u64,
    max_time_s: u64,
    max_filesize: u64,
    tar_cmd: Vec<String>,
}

fn text(s: &Settings, k: &str) -> Option<String> {
    s.shipped(k)?
        .as_str()
        .filter(|v| !v.is_empty())
        .map(str::to_string)
}

fn num(s: &Settings, k: &str) -> Option<u64> {
    s.shipped(k)?.as_integer()?;
    Some(s.num(k))
}

fn list(s: &Settings, k: &str) -> Option<Vec<String>> {
    let v: Vec<String> = s
        .shipped(k)?
        .as_array()?
        .iter()
        .filter_map(|x| x.as_str().map(str::to_string))
        .collect();
    (!v.is_empty()).then_some(v)
}

impl Cfg {
    fn load(s: &Settings) -> Option<Cfg> {
        let t = |k: &str| text(s, &format!("install.{k}"));
        let n = |k: &str| num(s, &format!("install.{k}"));
        let l = |k: &str| list(s, &format!("install.{k}"));
        Some(Cfg {
            release_base: t("release_base")?,
            release_dir: t("release_dir")?,
            asset_name: t("asset_name")?,
            member_dir: t("member_dir")?,
            member_engine: t("member_engine")?,
            member_hook: t("member_hook")?,
            lock_schema: n("lock_schema")?,
            retry_s: n("retry_s")?,
            run_s: n("run_s")?.max(1),
            kill_grace: Duration::from_secs(n("kill_grace_s")?),
            poll: Duration::from_millis(n("poll_ms")?.max(1)),
            stale_lock_s: n("stale_lock_s")?,
            log_max: n("log_max_bytes")?,
            log_keep: n("log_keep_lines")? as usize,
            file_log: t("file_log")?,
            file_marker: t("file_marker")?,
            file_attempt: t("file_attempt")?,
            dir_lock: t("dir_lock")?,
            prev_suffix: t("prev_suffix")?,
            tmp_prefix: t("tmp_prefix")?,
            settings_file: t("settings_file")?,
            setting_section: t("setting_section")?,
            setting_key: t("setting_key")?,
            setting_on: l("setting_on")?,
            setting_off: l("setting_off")?,
            os_macos: t("os_macos")?,
            os_linux: t("os_linux")?,
            cpu_arm: l("cpu_arm")?,
            cpu_x86: l("cpu_x86")?,
            cpu_arm_name: t("cpu_arm_name")?,
            cpu_x86_name: t("cpu_x86_name")?,
            triple_macos: t("triple_macos")?,
            triple_linux: t("triple_linux")?,
            libc_default: t("libc_default")?,
            libc_musl: t("libc_musl")?,
            musl_globs: l("musl_globs")?,
            musl_probe: l("musl_probe")?,
            musl_word: t("musl_word")?,
            wsl_word: t("wsl_word")?,
            rosetta_sysctl: t("rosetta_sysctl")?,
            curl_cmd: l("curl_cmd")?,
            curl_cmd_test: l("curl_cmd_test")?,
            wget_cmd: l("wget_cmd")?,
            connect_s: n("connect_timeout_s")?,
            max_time_s: n("max_time_s")?,
            max_filesize: n("max_filesize")?,
            tar_cmd: l("tar_cmd")?,
        })
    }
}

// ---- running commands under a hard limit -----------------------------------------------------------------------------------

pub enum Ran {
    Done(i32),
    TimedOut,
    CannotStart,
}

/// Run `argv` (stdin null; stdout and stderr to `out` when given) in its own process group with a hard limit: TERM at `limit`, KILL
/// `grace` later. Nothing downloaded is trusted to terminate.
pub fn run_limited(
    argv: &[String],
    envs: &[(&str, &Path)],
    out: Option<&Path>,
    limit: Duration,
    grace: Duration,
    poll: Duration,
) -> Ran {
    let Some((prog, rest)) = argv.split_first() else {
        return Ran::CannotStart;
    };
    let mut cmd = Command::new(prog);
    cmd.args(rest).stdin(Stdio::null()).process_group(0);
    for (k, v) in envs {
        cmd.env(k, v);
    }
    match out.map(fs::File::create) {
        Some(Ok(f)) => {
            let Ok(g) = f.try_clone() else {
                return Ran::CannotStart;
            };
            cmd.stdout(f).stderr(g);
        }
        Some(Err(_)) => return Ran::CannotStart,
        None => {
            cmd.stdout(Stdio::null()).stderr(Stdio::null());
        }
    }
    let Ok(mut child) = cmd.spawn() else {
        return Ran::CannotStart;
    };
    let pgid = child.id() as libc::pid_t;
    let t0 = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(st)) => {
                return Ran::Done(st.code().unwrap_or_else(|| {
                    128 + std::os::unix::process::ExitStatusExt::signal(&st).unwrap_or(0)
                }));
            }
            Ok(None) => {}
            Err(_) => return Ran::CannotStart,
        }
        if t0.elapsed() >= limit {
            break;
        }
        std::thread::sleep(poll);
    }
    // SAFETY: signalling the child's own process group.
    unsafe {
        libc::kill(-pgid, libc::SIGTERM);
    }
    let t1 = Instant::now();
    while t1.elapsed() < grace {
        if matches!(child.try_wait(), Ok(Some(_))) {
            return Ran::TimedOut;
        }
        std::thread::sleep(poll);
    }
    // SAFETY: as above.
    unsafe {
        libc::kill(-pgid, libc::SIGKILL);
    }
    let _ = child.wait();
    Ran::TimedOut
}

pub fn subst(argv: &[String], subs: &[(&str, &str)]) -> Vec<String> {
    argv.iter().map(|a| fill(a, subs)).collect()
}

pub fn sha256_file(p: &Path) -> Option<String> {
    let mut f = fs::File::open(p).ok()?;
    let mut h = Sha256::new();
    let mut buf = vec![0u8; 1 << 16];
    loop {
        let n = f.read(&mut buf).ok()?;
        if n == 0 {
            break;
        }
        h.update(&buf[..n]);
    }
    Some(h.finalize().iter().map(|b| format!("{b:02x}")).collect())
}

// ---- platform ------------------------------------------------------------------------------------------------------------------

struct Platform {
    triple: String,
    /// The kernel flavour for the log (a WSL kernel is Linux, noted as such).
    note: String,
}

fn field(c: &[libc::c_char]) -> String {
    let bytes: Vec<u8> = c
        .iter()
        .take_while(|b| **b != 0)
        .map(|b| *b as u8)
        .collect();
    String::from_utf8_lossy(&bytes).into_owned()
}

pub fn host_uname() -> (String, String, String) {
    // SAFETY: uname fills a zeroed utsname.
    unsafe {
        let mut u: libc::utsname = std::mem::zeroed();
        if libc::uname(&mut u) != 0 {
            return Default::default();
        }
        (field(&u.sysname), field(&u.machine), field(&u.release))
    }
}

/// Whether the `sysctl` flag `name` reads 1; only macOS has `sysctlbyname`, so on every other OS the answer is no.
#[cfg(not(target_os = "macos"))]
pub fn is_apple_silicon(_name: &str) -> bool {
    false
}

#[cfg(target_os = "macos")]
pub fn is_apple_silicon(name: &str) -> bool {
    let Ok(c) = std::ffi::CString::new(name) else {
        return false;
    };
    let mut val: libc::c_int = 0;
    let mut len = std::mem::size_of::<libc::c_int>();
    // SAFETY: sysctlbyname writes at most `len` bytes into `val`.
    let rc = unsafe {
        libc::sysctlbyname(
            c.as_ptr(),
            (&mut val as *mut libc::c_int).cast(),
            &mut len,
            std::ptr::null_mut(),
            0,
        )
    };
    rc == 0 && val == 1
}

fn is_musl(c: &Cfg, probe: &dyn Fn(&[String]) -> Option<String>) -> bool {
    for g in &c.musl_globs {
        let p = Path::new(g);
        let (Some(dir), Some(prefix)) = (p.parent(), p.file_name().and_then(|n| n.to_str())) else {
            continue;
        };
        if fs::read_dir(dir).is_ok_and(|mut rd| {
            rd.any(|e| e.is_ok_and(|e| e.file_name().to_string_lossy().starts_with(prefix)))
        }) {
            return true;
        }
    }
    probe(&c.musl_probe).is_some_and(|o| o.to_lowercase().contains(&c.musl_word.to_lowercase()))
}

/// The release triple of this machine, or the reason there is none. `knob(k)` is a test-only override (None outside tests).
fn detect(
    c: &Cfg,
    knob: &dyn Fn(&str) -> Option<String>,
    probe: &dyn Fn(&[String]) -> Option<String>,
) -> Result<Platform, String> {
    let (hs, hm, hr) = host_uname();
    let os = knob("uname_s").unwrap_or(hs);
    let arch = knob("uname_m").unwrap_or(hm);
    let rel = knob("uname_r").unwrap_or(hr);
    let cpu_x86 = c.cpu_x86.contains(&arch);
    let mut cpu = if c.cpu_arm.contains(&arch) {
        c.cpu_arm_name.clone()
    } else if cpu_x86 {
        c.cpu_x86_name.clone()
    } else {
        return Err(format!("cpu {arch}"));
    };
    if os == c.os_macos {
        // a shell under Rosetta reports x86 on an arm64 machine: take the machine's architecture
        if cpu_x86 && knob("uname_m").is_none() && is_apple_silicon(&c.rosetta_sysctl) {
            cpu = c.cpu_arm_name.clone();
        }
        return Ok(Platform {
            triple: fill(&c.triple_macos, &[("cpu", &cpu)]),
            note: "macos".into(),
        });
    }
    if os == c.os_linux {
        let note = if rel.to_lowercase().contains(&c.wsl_word.to_lowercase()) {
            "wsl"
        } else {
            "linux"
        };
        let libc_name = match knob("libc") {
            Some(l) if l == c.libc_default || l == c.libc_musl => l,
            Some(_) => c.libc_default.clone(),
            None => {
                if is_musl(c, probe) {
                    c.libc_musl.clone()
                } else {
                    c.libc_default.clone()
                }
            }
        };
        return Ok(Platform {
            triple: fill(&c.triple_linux, &[("cpu", &cpu), ("libc", &libc_name)]),
            note: note.into(),
        });
    }
    Err(format!("os {os}"))
}

// ---- the lock and the settings ---------------------------------------------------------------------------------------------

struct Lock {
    version: String,
    assets: serde_json::Map<String, serde_json::Value>,
}

fn read_lock(c: &Cfg, path: &Path) -> Result<Lock, String> {
    let t = fs::read_to_string(path).map_err(|_| "no_lock".to_string())?;
    let v: serde_json::Value =
        serde_json::from_str(&t).map_err(|_| "bad_lock_schema".to_string())?;
    if v.get("schema").and_then(|s| s.as_u64()) != Some(c.lock_schema) {
        return Err("bad_lock_schema".into());
    }
    let version = v
        .get("version")
        .and_then(|s| s.as_str())
        .unwrap_or("")
        .to_string();
    let dotted = version.split('.').count() == 3
        && version
            .split('.')
            .all(|p| p.starts_with(|ch: char| ch.is_ascii_digit()));
    if !dotted
        || !version
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || ch == '.' || ch == '-')
    {
        return Err("bad_lock_version".into());
    }
    let assets = v
        .get("assets")
        .and_then(|a| a.as_object())
        .cloned()
        .unwrap_or_default();
    Ok(Lock { version, assets })
}

/// The opt-in: the environment variable (0 = off, 1 = on) first, then the setting; absent = off.
fn auto_allowed(s: &Settings, c: &Cfg, base: &Path) -> bool {
    match env_nonempty(&s.text("env.bootstrap")).as_deref() {
        Some("0") => return false,
        Some("1") => return true,
        _ => {}
    }
    let Ok(t) = fs::read_to_string(base.join(&c.settings_file)) else {
        return false;
    };
    let Ok(v) = serde_json::from_str::<serde_json::Value>(&t) else {
        return false;
    };
    let Some(x) = v
        .get(&c.setting_section)
        .and_then(|s| s.get(&c.setting_key))
    else {
        return false;
    };
    let word = match x {
        serde_json::Value::Bool(b) => b.to_string(),
        serde_json::Value::Number(n) => n.to_string(),
        serde_json::Value::String(s) => s.to_lowercase(),
        _ => return false,
    };
    c.setting_on.contains(&word) && !c.setting_off.contains(&word)
}

// ---- the install ---------------------------------------------------------------------------------------------------------------

struct Run<'a> {
    c: &'a Cfg,
    log: PathBuf,
    verbose: bool,
}

impl Run<'_> {
    fn rec(&self, event: &str, kv: &[(&str, &str)]) {
        rec::append(&self.log, self.c.log_max, self.c.log_keep, event, kv);
        if self.verbose {
            crate::util::say(&format!(
                "{} {}",
                rec::stamp_log(epoch_s()),
                rec::pairs(&[("event", event)], kv)
            ));
        }
    }
}

fn first_fields(p: &Path) -> Vec<String> {
    fs::read_to_string(p)
        .map(|t| t.split_whitespace().map(str::to_string).collect())
        .unwrap_or_default()
}

pub fn make_exec(p: &Path) {
    let _ = fs::set_permissions(p, fs::Permissions::from_mode(0o755));
}

/// Parsed command line of the verb.
struct Args {
    lock: Option<PathBuf>,
    print_target: bool,
    auto: bool,
    verbose: bool,
}

fn parse(args: &[String]) -> Args {
    let mut a = Args {
        lock: None,
        print_target: false,
        auto: false,
        verbose: false,
    };
    let mut it = args.iter();
    while let Some(x) = it.next() {
        match x.as_str() {
            "--lock" => a.lock = it.next().map(PathBuf::from),
            "--print-target" => a.print_target = true,
            "--auto" => a.auto = true,
            "-v" => a.verbose = true,
            _ => {}
        }
    }
    a
}

/// `ah-hook install ...`. Exit code 0 always.
pub fn run(
    s: &Settings,
    state: &Path,
    base: &Path,
    plugin_root: Option<&Path>,
    args: &[String],
) -> i32 {
    crate::limits::restore_cpu_limit(); // a maintenance verb, not a hook call
    let Some(c) = Cfg::load(s) else { return 0 };
    let a = parse(args);
    let test = env_nonempty(&s.text("launcher.test_flag_env")).is_some_and(|v| v == "1");
    let knob = |k: &str| -> Option<String> {
        if test {
            env_nonempty(&s.text(&format!("launcher.knob_{k}")))
        } else {
            None
        }
    };
    let limit = Duration::from_secs(
        knob("install_run_s")
            .and_then(|v| v.parse().ok())
            .filter(|n: &u64| *n > 0)
            .unwrap_or(c.run_s),
    );
    let retry_s: u64 = knob("install_retry_s")
        .and_then(|v| v.parse().ok())
        .unwrap_or(c.retry_s);
    let probe = |argv: &[String]| -> Option<String> {
        let tmp = std::env::temp_dir().join(format!("ah-probe-{}", std::process::id()));
        let r = run_limited(argv, &[], Some(&tmp), limit, c.kill_grace, c.poll);
        let out = fs::read_to_string(&tmp).ok();
        let _ = fs::remove_file(&tmp);
        matches!(r, Ran::Done(_)).then_some(out).flatten()
    };
    let plat = detect(&c, &knob, &probe);
    if a.print_target {
        let shown = plat.map_or_else(|_| s.text("msg.install_unsupported"), |p| p.triple);
        let _ = writeln!(std::io::stdout(), "{shown}");
        return 0;
    }
    if a.auto && !auto_allowed(s, &c, base) {
        return 0;
    }
    if state.as_os_str().is_empty() || fs::create_dir_all(state.join("bin")).is_err() {
        return 0;
    }
    let r = Run {
        c: &c,
        log: state.join(&c.file_log),
        verbose: a.verbose,
    };
    let lock_path = a
        .lock
        .clone()
        .or_else(|| plugin_root.map(|p| p.join(s.text("launcher.engine_lock_file"))))
        .unwrap_or_default();
    let lock = match read_lock(&c, &lock_path) {
        Ok(l) => l,
        Err(why) => return skip(&r, &why, &[("path", &lock_path.display().to_string())]),
    };
    let plat = match plat {
        Ok(p) => p,
        Err(why) => return skip(&r, "unsupported_platform", &[("why", &why)]),
    };
    let subs = [
        ("version", lock.version.as_str()),
        ("triple", plat.triple.as_str()),
    ];
    let asset = fill(&c.asset_name, &subs);
    let sha = lock
        .assets
        .get(&asset)
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    if sha.len() != 64 || !sha.chars().all(|ch| matches!(ch, '0'..='9' | 'a'..='f')) {
        return skip(&r, "lock_has_no_sha", &[("asset", &asset)]);
    }

    let engine_bin = state.join("bin").join(&c.member_engine);
    let hook_bin = state.join("bin").join(&c.member_hook);
    let marker = state.join(&c.file_marker);
    let m = first_fields(&marker);
    let mark = |i: usize| m.get(i).map(String::as_str).unwrap_or("");
    let want = format!("{} {sha}", lock.version);
    // may each binary be replaced? absent, or exactly what this installer put there
    let engine_free = if engine_bin.exists() {
        if m.is_empty() {
            r.rec(
                "skip_unmanaged",
                &[("path", &engine_bin.display().to_string())],
            );
            false
        } else if !mark(2).is_empty() && sha256_file(&engine_bin).unwrap_or_default() != mark(2) {
            r.rec(
                "skip_local_build",
                &[("path", &engine_bin.display().to_string())],
            );
            false
        } else {
            true
        }
    } else {
        true
    };
    let hook_free = !hook_bin.exists()
        || (mark(3).len() == 64 && sha256_file(&hook_bin).unwrap_or_default() == mark(3));
    if !engine_free && !hook_free {
        return 0;
    }
    if engine_bin.exists() && format!("{} {}", mark(0), mark(1)) == want {
        return 0; // this archive is what is installed
    }
    let attempt = state.join(&c.file_attempt);
    let now = epoch_s();
    let att = first_fields(&attempt);
    if att.len() >= 3
        && att[1] == lock.version
        && att[2] == sha
        && att[0]
            .parse::<u64>()
            .is_ok_and(|t| now.saturating_sub(t) < retry_s)
    {
        return 0;
    }
    let seen = if engine_bin.exists() {
        sha256_file(&engine_bin).unwrap_or_default()
    } else {
        String::new()
    };

    // one installer at a time; a lock older than install.stale_lock_s is stale
    let lockdir = state.join(&c.dir_lock);
    if fs::create_dir(&lockdir).is_err() {
        let old = fs::metadata(&lockdir)
            .and_then(|md| md.modified())
            .ok()
            .and_then(|t| t.elapsed().ok())
            .is_some_and(|age| age.as_secs() > c.stale_lock_s);
        if !(old && fs::remove_dir(&lockdir).is_ok() && fs::create_dir(&lockdir).is_ok()) {
            return 0;
        }
    }
    let tmp = state.join(format!("{}{}", c.tmp_prefix, std::process::id()));
    let _guard = Cleanup {
        dirs: vec![lockdir, tmp.clone()],
    };
    let fail = |why: &str, detail: &str| -> i32 {
        r.rec("fail", &[("why", why), ("detail", detail)]);
        let _ = fs::write(&attempt, format!("{now} {} {sha}\n", lock.version));
        0
    };
    let _ = fs::remove_dir_all(&tmp);
    if fs::create_dir_all(&tmp).is_err() {
        return fail("cannot_create_scratch", &tmp.display().to_string());
    }
    let release_base = knob_release_base(s, test).unwrap_or_else(|| c.release_base.clone());
    let url = format!("{release_base}/{}/{asset}", fill(&c.release_dir, &subs));
    r.rec(
        "start",
        &[
            ("asset", &asset),
            ("platform", &plat.note),
            ("sha256", &sha[..8]),
        ],
    );

    // download
    let archive = tmp.join("asset");
    let (connect, max_time, max_size) = (
        c.connect_s.to_string(),
        c.max_time_s.to_string(),
        c.max_filesize.to_string(),
    );
    let out_s = archive.display().to_string();
    let dl_subs = [
        ("connect", connect.as_str()),
        ("max_time", max_time.as_str()),
        ("max_size", max_size.as_str()),
        ("out", out_s.as_str()),
        ("url", url.as_str()),
    ];
    let dl = if test { &c.curl_cmd_test } else { &c.curl_cmd };
    let have = on_path;
    let argv = if dl.first().is_some_and(|p| have(p)) {
        subst(dl, &dl_subs)
    } else if c.wget_cmd.first().is_some_and(|p| have(p)) {
        subst(&c.wget_cmd, &dl_subs)
    } else {
        return fail("no_downloader", "");
    };
    let total = Duration::from_secs(c.max_time_s + c.connect_s).max(limit);
    if !matches!(
        run_limited(&argv, &[], None, total, c.kill_grace, c.poll),
        Ran::Done(0)
    ) {
        return fail("download_failed", &url);
    }
    let got = sha256_file(&archive).unwrap_or_default();
    if got != sha {
        return fail("sha256_mismatch", &format!("expected={sha} got={got}"));
    }

    // extract the members by name, to fixed paths, never the archive's own paths
    let extract = |name: &str, dest: &Path| -> bool {
        let member = format!("{}/{name}", fill(&c.member_dir, &subs));
        let arch_s = archive.display().to_string();
        let argv = subst(&c.tar_cmd, &[("archive", &arch_s), ("member", &member)]);
        matches!(
            run_limited(&argv, &[], Some(dest), limit, c.kill_grace, c.poll),
            Ran::Done(0)
        ) && fs::metadata(dest).is_ok_and(|md| md.len() > 0)
    };
    let new_engine = tmp.join(&c.member_engine);
    let new_hook = tmp.join(&c.member_hook);
    if !extract(&c.member_engine, &new_engine) {
        return fail("archive_has_no_engine", &c.member_engine);
    }
    make_exec(&new_engine);
    let have_hook = extract(&c.member_hook, &new_hook);
    if have_hook {
        make_exec(&new_hook);
    } else {
        r.rec("hook_not_in_archive", &[]);
    }
    // The engine reads its settings from the plugin at run time, so the version check names the plugin whose lock pinned the
    // binary and a scratch state directory: it must not depend on a host variable or touch the real state.
    let vout = tmp.join("version.out");
    let root_env = s.text("env.plugin_root");
    let dir_env = s.text("env.dir");
    let scratch_state = tmp.join("state");
    let mut envs: Vec<(&str, &Path)> = vec![(dir_env.as_str(), scratch_state.as_path())];
    if let Some(p) = plugin_root {
        envs.push((root_env.as_str(), p));
    }
    let vargv = vec![new_engine.display().to_string(), "version".to_string()];
    match run_limited(&vargv, &envs, Some(&vout), limit, c.kill_grace, c.poll) {
        Ran::TimedOut => return fail("version_check_timed_out", &format!("{}s", limit.as_secs())),
        Ran::CannotStart => return fail("version_check_cannot_start", ""),
        Ran::Done(_) => {}
    }
    let reported = fs::read_to_string(&vout)
        .ok()
        .and_then(|t| t.lines().next().map(str::to_string))
        .unwrap_or_default();
    if !reported.contains(&lock.version) {
        return fail("version_mismatch", &reported);
    }

    // hold the shared install lock from here to the record; a held lock is not a failed attempt
    let integ = Integ::new(s, state);
    let token = format!("{} {now}", std::process::id());
    let mut held = false;
    if let Some(i) = &integ {
        if !i.lock_take(&token, i.lock_wait) {
            r.rec("skip_install_lock_held", &[]);
            return 0;
        }
        held = true;
    }
    let _unlock = Unlock {
        integ: integ.as_ref(),
        token: held.then_some(token),
    };
    let now_sha = if engine_bin.exists() {
        sha256_file(&engine_bin).unwrap_or_default()
    } else {
        String::new()
    };
    if engine_free && now_sha != seen {
        r.rec(
            "skip_changed_meanwhile",
            &[("path", &engine_bin.display().to_string())],
        );
        return 0;
    }
    let mut hook_sha = String::new();
    if engine_free {
        keep_prev(&engine_bin, &c.prev_suffix);
        if fs::rename(&new_engine, &engine_bin).is_err() {
            return fail("cannot_install", &engine_bin.display().to_string());
        }
    }
    if have_hook && hook_free {
        keep_prev(&hook_bin, &c.prev_suffix);
        hook_sha = sha256_file(&new_hook).unwrap_or_default();
        if fs::rename(&new_hook, &hook_bin).is_err() {
            r.rec(
                "hook_cannot_install",
                &[("path", &hook_bin.display().to_string())],
            );
            hook_sha.clear();
        }
    }
    let engine_sha = sha256_file(&engine_bin).unwrap_or_default();
    let hook_field = if hook_sha.is_empty() {
        mark(3).to_string()
    } else {
        hook_sha
    };
    let fields = [want.as_str(), engine_sha.as_str(), hook_field.as_str()];
    let _ = fs::write(
        &marker,
        format!(
            "{}\n",
            fields
                .iter()
                .filter(|f| !f.is_empty())
                .copied()
                .collect::<Vec<_>>()
                .join(" ")
        ),
    );
    if let Some(i) = &integ {
        i.record(); // under this install's hold: no check runs between the swap and the record
    }
    let _ = fs::remove_file(&attempt);
    r.rec(
        "installed",
        &[
            ("version", &lock.version),
            ("triple", &plat.triple),
            ("path", &engine_bin.display().to_string()),
        ],
    );
    0
}

fn knob_release_base(s: &Settings, test: bool) -> Option<String> {
    test.then(|| env_nonempty(&s.text("env.release_base")))
        .flatten()
}

fn skip(r: &Run, why: &str, kv: &[(&str, &str)]) -> i32 {
    let mut all = vec![("why", why)];
    all.extend_from_slice(kv);
    r.rec("skip", &all);
    0
}

fn keep_prev(bin: &Path, sfx: &str) {
    if bin.exists() {
        let mut o = bin.as_os_str().to_os_string();
        o.push(sfx);
        let prev = PathBuf::from(o);
        let tmp = bin.with_extension(format!("prev.{}", std::process::id()));
        if fs::copy(bin, &tmp).is_ok() {
            let _ = fs::rename(&tmp, prev);
        } else {
            let _ = fs::remove_file(&tmp);
        }
    }
}

/// Removes the scratch directory and the installer lock on every way out.
struct Cleanup {
    dirs: Vec<PathBuf>,
}

impl Drop for Cleanup {
    fn drop(&mut self) {
        for d in &self.dirs {
            let _ = fs::remove_dir_all(d); // keep: the installer's own scratch directory and its lock directory
        }
    }
}

struct Unlock<'a> {
    integ: Option<&'a Integ>,
    token: Option<String>,
}

impl Drop for Unlock<'_> {
    fn drop(&mut self) {
        if let (Some(i), Some(t)) = (self.integ, &self.token) {
            i.lock_give(t);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn arguments() {
        let a = parse(&[
            "--lock".into(),
            "/x".into(),
            "--auto".into(),
            "-v".into(),
            "--print-target".into(),
        ]);
        assert_eq!(a.lock.as_deref(), Some(Path::new("/x")));
        assert!(a.auto && a.verbose && a.print_target);
        assert!(parse(&[]).lock.is_none());
    }
}

/// True when an executable file `prog` is in a directory of the search path.
pub fn on_path(prog: &str) -> bool {
    find_on_path(prog).is_some()
}

/// The first executable file `prog` in the search path.
pub fn find_on_path(prog: &str) -> Option<std::path::PathBuf> {
    std::env::var_os("PATH").and_then(|p| {
        std::env::split_paths(&p)
            .map(|d| d.join(prog))
            .find(|f| f.is_file())
    })
}

/// The search path as the doctor reports on it.
pub fn path_env() -> String {
    std::env::var_os("PATH")
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_default()
}

/// The release triple of this machine for the updater: the triple, or the "unsupported" word.
pub fn platform_triple(s: &Settings, test: bool) -> String {
    let Some(c) = Cfg::load(s) else {
        return s.text("msg.install_unsupported");
    };
    let knob = |k: &str| -> Option<String> {
        if test {
            env_nonempty(&s.text(&format!("launcher.knob_{k}")))
        } else {
            None
        }
    };
    let probe = |argv: &[String]| -> Option<String> {
        let tmp = std::env::temp_dir().join(format!("ah-probe-{}", std::process::id()));
        let r = run_limited(
            argv,
            &[],
            Some(&tmp),
            Duration::from_secs(c.run_s),
            c.kill_grace,
            c.poll,
        );
        let out = fs::read_to_string(&tmp).ok();
        let _ = fs::remove_file(&tmp);
        matches!(r, Ran::Done(_)).then_some(out).flatten()
    };
    detect(&c, &knob, &probe).map_or_else(|_| s.text("msg.install_unsupported"), |p| p.triple)
}
