//! The engine binary the hooks run (`<home>/.anti-hall/ah-engine/bin/ah-engine`, pinned by the plugin's `ah-engine.lock`,
//! recorded by the bootstrap in `bootstrap.installed`): is it there, executable, a real executable for THIS machine (OS,
//! architecture, Rosetta), the build the bootstrap verified, the version the plugin pins, not quarantined, and does it run?
//!
//! [`classify`] is a pure function of the facts ([`super::facts::Host`], the file's kind, mode and header) so the whole host x
//! binary matrix is unit-tested with injected facts; [`section`] gathers the real ones.
use super::facts::{self, Header, Host};
use super::{Doc, Fix, Level};
use crate::defaults;
use crate::migrate::Ctx;
use std::path::{Path, PathBuf};

/// What is at the binary's path.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Kind {
    /// Nothing.
    Missing,
    /// A regular file.
    File,
    /// A directory.
    Dir,
    /// A symlink whose target does not exist.
    Dangling,
    /// Anything else (a socket, a device).
    Other,
}

/// The facts [`classify`] reads about the file.
#[derive(Debug, Clone)]
pub struct Binary {
    /// Where it is.
    pub path: PathBuf,
    /// What is there.
    pub kind: Kind,
    /// Permission bits.
    pub mode: u32,
    /// Its header (`Err` carries the OS error text).
    pub header: Result<Header, String>,
    /// True when macOS quarantines it.
    pub quarantined: bool,
}

/// One classified finding plus the repair that would fix it.
pub struct Found {
    /// Severity.
    pub level: Level,
    /// The finding text.
    pub msg: String,
    /// The safe repair, when there is one.
    pub fix: Option<Fix>,
    /// True when no further check of this binary makes sense (it cannot be a program).
    pub stop: bool,
}

fn f(level: Level, msg: String) -> Found {
    Found { level, msg, fix: None, stop: false }
}

fn stop(mut x: Found) -> Found {
    x.stop = true;
    x
}

/// The bootstrap invocation shown in fixes.
fn bootstrap_cmd(root: Option<&Path>) -> String {
    let script = defaults::text("doctor.bootstrap_script");
    match root {
        Some(r) => r.join(script).display().to_string(),
        None => script.to_string(),
    }
}

/// BIN-01..06, 11 and 03's repair: the findings about the file itself on `host`.
pub fn classify(host: &Host, b: &Binary, root: Option<&Path>) -> Vec<Found> {
    let path = b.path.display().to_string();
    let boot = bootstrap_cmd(root);
    let mut out = Vec::new();
    let kind_name = |k: &Kind| match k {
        Kind::Dir => defaults::text("doctor_msg.kind_dir"),
        Kind::Dangling => defaults::text("doctor_msg.kind_dangling"),
        _ => defaults::text("doctor_msg.kind_other"),
    };
    match b.kind {
        Kind::Missing => {
            out.push(stop(f(Level::Warn, defaults::render("doctor_msg.bin_missing", &[("path", &path), ("bootstrap", &boot)]))));
            return out;
        }
        Kind::Dir | Kind::Dangling | Kind::Other => {
            out.push(stop(f(Level::Bad, defaults::render("doctor_msg.bin_not_file", &[("path", &path), ("kind", &kind_name(&b.kind)), ("bootstrap", &boot)]))));
            return out;
        }
        Kind::File => {}
    }
    let header = match &b.header {
        Ok(h) => h.clone(),
        Err(e) => {
            out.push(stop(f(Level::Bad, defaults::render("doctor_msg.bin_unreadable", &[("path", &path), ("err", e), ("bootstrap", &boot)]))));
            return out;
        }
    };
    let why_key = match header {
        Header::Empty => Some("doctor_msg.why_empty"),
        Header::Truncated => Some("doctor_msg.why_truncated"),
        Header::Unknown => Some("doctor_msg.why_unknown"),
        _ => None,
    };
    if let Some(key) = why_key {
        out.push(stop(f(Level::Bad, defaults::render("doctor_msg.bin_corrupt", &[("path", &path), ("why", &defaults::text(key)), ("bootstrap", &boot)]))));
        return out;
    }
    if let Some(bin_os) = facts::header_os(&header)
        && bin_os != host.os
    {
        out.push(stop(f(
            Level::Bad,
            defaults::render("doctor_msg.bin_wrong_os", &[("path", &path), ("bin_os", &bin_os), ("host_os", &host.os), ("bootstrap", &boot)]),
        )));
        return out;
    }
    let archs: Vec<String> = match &header {
        Header::Elf(a) => vec![a.clone()],
        Header::MachO(a) => a.clone(),
        _ => Vec::new(),
    };
    if !archs.is_empty() && !archs.contains(&host.arch) {
        let x86 = facts::normalize_arch(defaults::text("doctor.intel_name"));
        let runnable_translated = host.apple_silicon() && archs.contains(&x86);
        let list = archs.join("/");
        let args: &[(&str, &dyn std::fmt::Display)] =
            &[("path", &path), ("bin_arch", &list), ("host_os", &host.os), ("host_arch", &host.arch), ("bootstrap", &boot)];
        if runnable_translated && host.rosetta {
            out.push(f(Level::Warn, defaults::render("doctor_msg.bin_rosetta", args)));
        } else if runnable_translated {
            out.push(stop(f(Level::Bad, defaults::render("doctor_msg.bin_no_rosetta", args))));
            return out;
        } else {
            out.push(stop(f(Level::Bad, defaults::render("doctor_msg.bin_wrong_arch", args))));
            return out;
        }
    }
    if b.quarantined {
        let mut q = f(Level::Bad, defaults::render("doctor_msg.bin_quarantined", &[("path", &path)]));
        q.fix = Some(Fix::Unquarantine(b.path.clone()));
        out.push(q);
    }
    if b.mode & defaults::num("doctor.exec_bit") as u32 == 0 {
        let mut e = f(
            Level::Bad,
            defaults::render("doctor_msg.bin_not_exec", &[("path", &path), ("mode", &format!("{:o}", b.mode & defaults::num("doctor.mode_mask") as u32))]),
        );
        e.fix = Some(Fix::MakeExecutable(b.path.clone()));
        out.push(e);
    }
    out
}

/// The `<home>/.anti-hall/ah-engine` directory the wrapper and the bootstrap use.
pub fn engine_dir(home: &str) -> PathBuf {
    Path::new(home).join(defaults::text("paths.base_dir")).join(defaults::text("paths.state_dir"))
}

fn gather(path: &Path) -> Binary {
    use std::os::unix::fs::PermissionsExt;
    let kind_of = |m: &std::fs::Metadata| {
        if m.is_file() {
            Kind::File
        } else if m.is_dir() {
            Kind::Dir
        } else {
            Kind::Other
        }
    };
    let (kind, mode) = match std::fs::metadata(path) {
        Ok(m) => (kind_of(&m), m.permissions().mode()),
        Err(_) if std::fs::symlink_metadata(path).is_ok() => (Kind::Dangling, 0),
        Err(_) => (Kind::Missing, 0),
    };
    let is_file = kind == Kind::File;
    let header = if is_file { facts::read_header(path).map_err(|e| e.to_string()) } else { Ok(Header::Empty) };
    Binary { path: path.to_path_buf(), kind, mode, header, quarantined: is_file && facts::quarantined(path) }
}

/// `ah-engine.lock` as the bootstrap reads it: its version and asset names.
pub struct Lock {
    /// The pinned version.
    pub version: String,
    /// The release asset names it lists.
    pub assets: Vec<String>,
}

/// Read the plugin's lock; `Err` is the reason it cannot be used.
pub fn read_lock(root: &Path) -> Result<Lock, String> {
    let p = root.join(defaults::text("doctor.lock_file"));
    let text = std::fs::read_to_string(&p).map_err(|e| e.to_string())?;
    let v: serde_json::Value = serde_json::from_str(&text).map_err(|e| e.to_string())?;
    let version = v.get("version").and_then(|x| x.as_str()).ok_or_else(|| defaults::text("doctor_msg.lock_no_version").to_string())?.to_string();
    let assets = v.get("assets").and_then(|a| a.as_object()).map(|o| o.keys().cloned().collect()).unwrap_or_default();
    Ok(Lock { version, assets })
}

/// The bootstrap's marker: `<version> <asset sha256> [<binary sha256>]`.
fn read_marker(dir: &Path) -> Option<(String, Option<String>)> {
    let text = std::fs::read_to_string(dir.join(defaults::text("doctor.marker_file"))).ok()?;
    let mut it = text.split_whitespace();
    let version = it.next()?.to_string();
    let _asset = it.next();
    Some((version, it.next().map(str::to_string)))
}

/// The release asset triple pattern for `host`, e.g. `aarch64-apple-darwin`; for Linux the libc is left open.
fn triple(host: &Host) -> String {
    defaults::raw("doctor.triples").get(&host.os).and_then(defaults::V::as_str).map(|t| defaults::fill(t, &[("cpu", &host.arch)])).unwrap_or_default()
}

/// The first line a child printed, shortened.
fn first_line(bytes: &[u8]) -> String {
    let text = String::from_utf8_lossy(bytes);
    text.lines().map(str::trim).find(|l| !l.is_empty()).unwrap_or("").chars().take(defaults::num("doctor.why_max") as usize).collect()
}

/// Run `<bin> version` bounded; the version it reports or why it did not.
fn run_version(bin: &Path, root: Option<&Path>) -> Result<String, String> {
    let mut cmd = std::process::Command::new(bin);
    cmd.arg(defaults::text("doctor.version_arg"));
    if let Some(r) = root {
        cmd.env(crate::bootstrap::ROOT_ENVS[0], r);
    }
    match crate::proc::run(cmd, defaults::text("doctor.bin_label"), defaults::millis("doctor.probe_timeout_ms"), defaults::millis("doctor.probe_poll_ms")) {
        Ok(o) if o.status.success() => Ok(first_line(&o.stdout)),
        Ok(o) => {
            let err = first_line(&o.stderr);
            Err(match std::os::unix::process::ExitStatusExt::signal(&o.status) {
                Some(sig) => defaults::render("doctor_msg.why_signal", &[("sig", &sig), ("err", &err)]),
                None => defaults::render("doctor_msg.why_exit", &[("code", &o.status.code().unwrap_or(-1)), ("err", &err)]),
            })
        }
        Err(crate::proc::Error::Timeout) => Err(defaults::text("doctor_msg.why_timeout").to_string()),
        Err(e) => Err(e.into_io().to_string()),
    }
}

/// Everything about the installed engine binary; returns true when it is usable (the "no engine" question of ND-04).
pub fn section(doc: &mut Doc, fixes: &mut Vec<Fix>, ctx: &Ctx, root: Option<&Path>, host: &Host) -> bool {
    doc.head(defaults::text("doctor_msg.head_install"));
    let dir = engine_dir(&ctx.home);
    let path = dir.join(defaults::text("doctor.bin_dir")).join(defaults::text("doctor.bin_name"));
    let b = gather(&path);
    let shown = path.display().to_string();
    let boot = bootstrap_cmd(root);
    let found = classify(host, &b, root);
    let halted = found.iter().any(|x| x.stop);
    let mut usable = !halted && b.kind == Kind::File;
    for x in found {
        if let Some(fx) = x.fix {
            fixes.push(fx);
        }
        doc.push(x.level, x.msg);
        if x.level == Level::Bad {
            usable = false;
        }
    }
    // the lock: what the plugin pins
    let lock = root.map(|r| read_lock(r).map_err(|e| (r.join(defaults::text("doctor.lock_file")), e)));
    let pinned = match &lock {
        Some(Ok(l)) => Some(l.version.clone()),
        Some(Err((p, e))) => {
            doc.warnl(defaults::render("doctor_msg.lock_unreadable", &[("path", &p.display()), ("err", e)]));
            None
        }
        None => None,
    };
    if let Some(Ok(l)) = &lock {
        let t = triple(host);
        if !t.is_empty() && !l.assets.iter().any(|a| a.contains(&t)) {
            doc.warnl(defaults::render("doctor_msg.lock_no_asset", &[("triple", &t)]));
        }
    }
    if b.kind != Kind::File {
        return false;
    }
    let marker = read_marker(&dir);
    if !halted {
        match (&marker, facts::sha256_file(&path)) {
            (None, _) => doc.infol(defaults::render("doctor_msg.bin_not_bootstrapped", &[("path", &shown)])),
            (Some((_, Some(want))), Ok(have)) if *want != have => {
                doc.warnl(defaults::render(
                    "doctor_msg.bin_hash_differs",
                    &[
                        ("path", &shown),
                        ("have", &have.chars().take(defaults::num("doctor.hash_shown") as usize).collect::<String>()),
                        ("want", &want.chars().take(defaults::num("doctor.hash_shown") as usize).collect::<String>()),
                        ("bootstrap", &boot),
                    ],
                ));
            }
            _ => {}
        }
        // a quarantine repair is only safe on the build the bootstrap verified
        if let (Some((_, Some(want))), Ok(have)) = (&marker, facts::sha256_file(&path)) {
            if *want != have {
                fixes.retain(|x| !matches!(x, Fix::Unquarantine(_)));
            }
        } else {
            fixes.retain(|x| !matches!(x, Fix::Unquarantine(_)));
        }
    }
    // does it run
    let own = std::env::current_exe().ok().and_then(|e| e.canonicalize().ok());
    let is_self = own.as_deref().is_some_and(|o| path.canonicalize().ok().as_deref() == Some(o));
    let reported = if halted || !usable {
        None
    } else if is_self {
        Some(crate::version())
    } else {
        match run_version(&path, root) {
            Ok(v) => Some(v),
            Err(why) => {
                doc.bad(defaults::render("doctor_msg.bin_no_run", &[("path", &shown), ("why", &why), ("bootstrap", &boot)]));
                usable = false;
                None
            }
        }
    };
    if let Some(v) = &reported {
        if let Some(want) = &pinned
            && !v.contains(want.as_str())
        {
            doc.warnl(defaults::render("doctor_msg.bin_version_differs", &[("have", v), ("want", want), ("bootstrap", &boot)]));
        } else {
            doc.ok(defaults::render("doctor_msg.bin_ok", &[("path", &shown), ("triple", &format!("{}-{}", host.arch, host.os)), ("ver", v)]));
        }
        if !is_self {
            doc.infol(defaults::render("doctor_msg.bin_other_engine", &[("running", &crate::version()), ("installed", v)]));
        }
    } else if let (Some((have, _)), Some(want)) = (&marker, &pinned)
        && have != want
    {
        doc.warnl(defaults::render("doctor_msg.bin_version_differs", &[("have", have), ("want", want), ("bootstrap", &boot)]));
    }
    usable
}

#[cfg(test)]
mod tests {
    use super::*;

    fn host(os: &str, arch: &str, rosetta: bool) -> Host {
        Host { os: os.into(), arch: arch.into(), rosetta }
    }

    fn bin(header: Header, mode: u32) -> Binary {
        Binary { path: PathBuf::from("/x/ah-engine"), kind: Kind::File, mode, header: Ok(header), quarantined: false }
    }

    fn texts(v: &[Found]) -> Vec<String> {
        v.iter().map(|x| format!("{:?}: {}", x.level, x.msg)).collect()
    }

    fn init() {
        crate::defaults::init().unwrap();
    }

    #[test]
    fn host_by_binary_matrix() {
        init();
        let mac_arm = host("macos", "aarch64", true);
        let mac_arm_no_rosetta = host("macos", "aarch64", false);
        let mac_intel = host("macos", "x86_64", false);
        let lin_x86 = host("linux", "x86_64", false);
        let lin_arm = host("linux", "aarch64", false);
        let macho = |a: &str| Header::MachO(vec![a.into()]);
        let elf = |a: &str| Header::Elf(a.into());
        let level = |h: &Host, hd: Header| classify(h, &bin(hd, 0o755), None).iter().map(|x| x.level).max_by_key(|l| *l as u8);
        // native builds are clean
        assert!(classify(&mac_arm, &bin(macho("aarch64"), 0o755), None).is_empty());
        assert!(classify(&mac_intel, &bin(macho("x86_64"), 0o755), None).is_empty());
        assert!(classify(&lin_x86, &bin(elf("x86_64"), 0o755), None).is_empty());
        assert!(classify(&lin_arm, &bin(elf("aarch64"), 0o755), None).is_empty());
        // x86_64 on Apple Silicon: warn with Rosetta, fail without
        let w = texts(&classify(&mac_arm, &bin(macho("x86_64"), 0o755), None));
        assert!(w.len() == 1 && w[0].starts_with("Warn") && w[0].contains("Rosetta"), "{w:?}");
        let b = texts(&classify(&mac_arm_no_rosetta, &bin(macho("x86_64"), 0o755), None));
        assert!(b.len() == 1 && b[0].starts_with("Bad") && b[0].contains("softwareupdate"), "{b:?}");
        // arm64 on Intel, and either arch on the other Linux arch: cannot run
        for (h, hd) in [(&mac_intel, macho("aarch64")), (&lin_x86, elf("aarch64")), (&lin_arm, elf("x86_64"))] {
            let t = texts(&classify(h, &bin(hd, 0o755), None));
            assert!(t.len() == 1 && t[0].starts_with("Bad") && t[0].contains("cannot run") || t[0].contains("built for"), "{t:?}");
        }
        // wrong OS
        for (h, hd) in [(&mac_arm, elf("aarch64")), (&lin_x86, macho("x86_64"))] {
            let t = texts(&classify(h, &bin(hd, 0o755), None));
            assert!(t.len() == 1 && t[0].starts_with("Bad"), "{t:?}");
        }
        // a universal binary that holds the host's arch is fine
        assert!(classify(&mac_intel, &bin(Header::MachO(vec!["aarch64".into(), "x86_64".into()]), 0o755), None).is_empty());
        assert!(level(&mac_arm, Header::Script).is_none());
    }

    #[test]
    fn file_kinds_modes_and_quarantine() {
        init();
        let h = host("macos", "aarch64", true);
        let mut b = bin(Header::MachO(vec!["aarch64".into()]), 0o644);
        let t = classify(&h, &b, None);
        assert!(t.len() == 1 && t[0].fix.is_some() && t[0].msg.contains("not executable"), "{:?}", texts(&t));
        b.quarantined = true;
        let t = classify(&h, &b, None);
        assert!(t.iter().any(|x| x.msg.contains("Gatekeeper") && x.fix.is_some()));
        for (kind, header) in [(Kind::Dir, Ok(Header::Empty)), (Kind::Dangling, Ok(Header::Empty)), (Kind::Missing, Ok(Header::Empty))] {
            let t = classify(&h, &Binary { kind, header, ..b.clone() }, None);
            assert!(t.len() == 1 && t[0].stop);
        }
        for (hd, word) in [(Header::Empty, "empty"), (Header::Truncated, "truncated"), (Header::Unknown, "unrecognised")] {
            let t = classify(&h, &bin(hd, 0o755), None);
            assert!(t.len() == 1 && t[0].level == Level::Bad && t[0].msg.contains(word), "{:?}", texts(&t));
        }
    }
}
