//! Platform facts the install checks read: the host (OS, machine architecture, Rosetta), the header of an executable, a file's
//! digest, the macOS quarantine attribute, free disk space and the account's home. Everything OS-specific sits here behind one
//! interface, so the checks above are pure functions of these facts and are tested with injected ones (every OS x arch x
//! Rosetta combination) as well as with real fixtures. The format constants (magic bytes, CPU codes) come from `doctor.exe_*`
//! in the plugin's defaults.
use crate::defaults;
use std::io::Read;
use std::path::Path;

/// The machine the doctor runs on, as the engine must see it: the OS, the machine's own architecture (not the architecture of a
/// process that Rosetta translates) and whether Rosetta is installed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Host {
    /// `macos` or `linux`.
    pub os: String,
    /// `aarch64` or `x86_64`, as the release assets name them.
    pub arch: String,
    /// True when this is an Apple Silicon Mac with Rosetta installed.
    pub rosetta: bool,
}

/// Map a machine name (`arm64`, `amd64`, ...) to the name the release assets use.
pub fn normalize_arch(machine: &str) -> String {
    match defaults::raw("doctor.arch_aliases").get(machine).and_then(defaults::V::as_str) {
        Some(n) => n.to_string(),
        None => machine.to_string(),
    }
}

/// The machine name `uname` reports for this process.
fn uname_machine() -> String {
    // SAFETY: `utsname` is plain data, all zeroes is a valid value of it; `uname` fills it and reads nothing else.
    let mut u: libc::utsname = unsafe { std::mem::zeroed() };
    // SAFETY: `u` is a valid, writable `utsname`.
    if unsafe { libc::uname(&mut u) } != 0 {
        return std::env::consts::ARCH.to_string();
    }
    // SAFETY: after a successful `uname` the `machine` field holds a NUL-terminated string inside the struct.
    unsafe { std::ffi::CStr::from_ptr(u.machine.as_ptr()) }.to_string_lossy().into_owned()
}

/// `sysctlbyname(name)` as an integer, when the kernel has that name.
#[cfg(target_os = "macos")]
fn sysctl_int(name: &str) -> Option<i64> {
    let cname = std::ffi::CString::new(name).ok()?;
    let mut value: i32 = 0;
    let mut len = std::mem::size_of::<i32>();
    // SAFETY: `cname` is NUL-terminated; `value`/`len` describe a writable i32; no new value is passed.
    let rc = unsafe { libc::sysctlbyname(cname.as_ptr(), (&mut value as *mut i32).cast(), &mut len, std::ptr::null_mut(), 0) };
    (rc == 0).then_some(i64::from(value))
}

impl Host {
    /// Read the facts from this machine.
    pub fn detect() -> Host {
        let os = std::env::consts::OS.to_string();
        #[allow(unused_mut)] // only the macOS arm below reassigns it
        let mut arch = normalize_arch(&uname_machine());
        #[cfg(target_os = "macos")]
        if sysctl_int(defaults::text("doctor.rosetta_sysctl")) == Some(1) {
            // a shell or process under Rosetta reports x86_64 on an arm64 machine: the machine's own architecture decides
            arch = normalize_arch(defaults::text("doctor.apple_silicon_name"));
        }
        let rosetta = os == defaults::text("doctor.macos_name")
            && arch == normalize_arch(defaults::text("doctor.apple_silicon_name"))
            && Path::new(defaults::text("doctor.rosetta_marker")).exists();
        Host { os, arch, rosetta }
    }

    /// True on a Mac with an Apple-Silicon CPU.
    pub fn apple_silicon(&self) -> bool {
        self.os == defaults::text("doctor.macos_name") && self.arch == normalize_arch(defaults::text("doctor.apple_silicon_name"))
    }
}

/// What the first bytes of a file say it is.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Header {
    /// Zero bytes.
    Empty,
    /// An interpreter script (`#!`): a stand-in, runnable on any machine that has its interpreter.
    Script,
    /// A Mach-O or ELF header that ends before its CPU field.
    Truncated,
    /// Neither a script nor a known executable format.
    Unknown,
    /// An ELF executable for this CPU.
    Elf(String),
    /// A Mach-O executable (thin, or fat with one entry per CPU).
    MachO(Vec<String>),
}

fn hex_bytes(s: &str) -> Vec<u8> {
    (0..s.len() / 2).filter_map(|i| u8::from_str_radix(s.get(i * 2..i * 2 + 2)?, 16).ok()).collect()
}

fn be32(b: &[u8], at: usize) -> Option<u32> {
    Some(u32::from_be_bytes(b.get(at..at + 4)?.try_into().ok()?))
}

fn le32(b: &[u8], at: usize) -> Option<u32> {
    Some(u32::from_le_bytes(b.get(at..at + 4)?.try_into().ok()?))
}

fn cpu_name(table: &str, code: u32) -> String {
    let key = format!("{code:x}");
    defaults::raw(table).get(&key).and_then(defaults::V::as_str).map(str::to_string).unwrap_or_else(|| defaults::text("doctor.cpu_other").to_string())
}

/// Classify the leading bytes of an executable.
pub fn classify_header(b: &[u8]) -> Header {
    if b.is_empty() {
        return Header::Empty;
    }
    let magic = |k: &str| hex_bytes(defaults::text(k));
    let f = |k: &str| defaults::num(k) as usize;
    if b.starts_with(&magic("doctor.exe_magic_script")) {
        return Header::Script;
    }
    if b.starts_with(&magic("doctor.exe_magic_elf")) {
        let machine = b.get(f("doctor.elf_machine_offset")..f("doctor.elf_machine_offset") + 2).and_then(|m| m.try_into().ok());
        let big = b.get(f("doctor.elf_data_offset")).copied() == Some(2);
        return match machine {
            Some(m) => {
                let code = if big { u16::from_be_bytes(m) } else { u16::from_le_bytes(m) };
                Header::Elf(cpu_name("doctor.elf_machines", u32::from(code)))
            }
            None => Header::Truncated,
        };
    }
    if b.starts_with(&magic("doctor.exe_magic_macho64")) {
        return match le32(b, f("doctor.macho_cpu_offset")) {
            Some(c) => Header::MachO(vec![cpu_name("doctor.macho_cpus", c)]),
            None => Header::Truncated,
        };
    }
    if b.starts_with(&magic("doctor.exe_magic_fat")) {
        let Some(n) = be32(b, f("doctor.fat_count_offset")) else { return Header::Truncated };
        let mut cpus = Vec::new();
        for i in 0..(n as usize).min(f("doctor.fat_max_entries")) {
            match be32(b, f("doctor.fat_first_offset") + i * f("doctor.fat_entry_size")) {
                Some(c) => cpus.push(cpu_name("doctor.macho_cpus", c)),
                None => return Header::Truncated,
            }
        }
        return Header::MachO(cpus);
    }
    if b.len() < defaults::num("doctor.exe_min_bytes") as usize {
        return Header::Truncated;
    }
    Header::Unknown
}

/// The header of the file at `path`.
pub fn read_header(path: &Path) -> std::io::Result<Header> {
    let mut buf = vec![0u8; defaults::num("doctor.header_read_bytes") as usize];
    let n = std::fs::File::open(path)?.read(&mut buf)?;
    buf.truncate(n);
    Ok(classify_header(&buf))
}

/// The OS an executable header is for (`macos`, `linux`), or `None` for a script / unknown.
pub fn header_os(h: &Header) -> Option<&'static str> {
    match h {
        Header::MachO(_) => Some(defaults::text("doctor.macos_name")),
        Header::Elf(_) => Some(defaults::text("doctor.linux_name")),
        _ => None,
    }
}

/// SHA-256 of a file, lowercase hex.
pub fn sha256_file(path: &Path) -> std::io::Result<String> {
    let mut f = std::fs::File::open(path)?;
    let mut ctx = ring::digest::Context::new(&ring::digest::SHA256);
    let mut buf = vec![0u8; defaults::num("doctor.hash_chunk") as usize];
    loop {
        let n = f.read(&mut buf)?;
        if n == 0 {
            break;
        }
        ctx.update(&buf[..n]);
    }
    Ok(ctx.finish().as_ref().iter().map(|b| format!("{b:02x}")).collect())
}

/// True when the macOS quarantine attribute is set on `path` (always false elsewhere).
#[cfg(target_os = "macos")]
pub fn quarantined(path: &Path) -> bool {
    use std::os::unix::ffi::OsStrExt;
    let (Ok(p), Ok(n)) = (std::ffi::CString::new(path.as_os_str().as_bytes()), std::ffi::CString::new(defaults::text("doctor.quarantine_attr"))) else {
        return false;
    };
    // SAFETY: both strings are NUL-terminated; a zero-size query reads no value and only reports the attribute's length.
    unsafe { libc::getxattr(p.as_ptr(), n.as_ptr(), std::ptr::null_mut(), 0, 0, 0) >= 0 }
}

/// True when the macOS quarantine attribute is set on `path` (always false elsewhere).
#[cfg(not(target_os = "macos"))]
pub fn quarantined(_path: &Path) -> bool {
    false
}

/// Remove the quarantine attribute from `path`.
#[cfg(target_os = "macos")]
pub fn clear_quarantine(path: &Path) -> std::io::Result<()> {
    use std::os::unix::ffi::OsStrExt;
    let p = std::ffi::CString::new(path.as_os_str().as_bytes()).map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidInput, e))?;
    let n = std::ffi::CString::new(defaults::text("doctor.quarantine_attr")).map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidInput, e))?;
    // SAFETY: both strings are NUL-terminated.
    if unsafe { libc::removexattr(p.as_ptr(), n.as_ptr(), 0) } == 0 { Ok(()) } else { Err(std::io::Error::last_os_error()) }
}

/// Remove the quarantine attribute from `path` (nothing to do elsewhere).
#[cfg(not(target_os = "macos"))]
pub fn clear_quarantine(_path: &Path) -> std::io::Result<()> {
    Ok(())
}

/// Free bytes for an unprivileged user on the volume holding `path`.
pub fn free_bytes(path: &Path) -> Option<u64> {
    use std::os::unix::ffi::OsStrExt;
    let p = std::ffi::CString::new(path.as_os_str().as_bytes()).ok()?;
    // SAFETY: `statvfs` is plain data, all zeroes is valid; the call fills it and reads only the NUL-terminated path.
    let mut s: libc::statvfs = unsafe { std::mem::zeroed() };
    // SAFETY: `p` is NUL-terminated and `s` is writable.
    if unsafe { libc::statvfs(p.as_ptr(), &mut s) } != 0 {
        return None;
    }
    Some((s.f_bavail as u64).saturating_mul(s.f_frsize as u64))
}

/// The account's home directory from the user database (not from `HOME`).
pub fn passwd_home() -> Option<String> {
    // SAFETY: `passwd` is plain data (pointers may be null), all zeroes is valid.
    let mut pw: libc::passwd = unsafe { std::mem::zeroed() };
    let mut buf = vec![0u8; defaults::num("doctor.passwd_buf") as usize];
    let mut out: *mut libc::passwd = std::ptr::null_mut();
    // SAFETY: the buffer and the result slot are valid for the call; `getpwuid_r` is the thread-safe form.
    let rc = unsafe { libc::getpwuid_r(crate::limits::uid(), &mut pw, buf.as_mut_ptr().cast(), buf.len(), &mut out) };
    if rc != 0 || out.is_null() || pw.pw_dir.is_null() {
        return None;
    }
    // SAFETY: on success `pw_dir` points at a NUL-terminated string inside `buf`, which is alive here.
    Some(unsafe { std::ffi::CStr::from_ptr(pw.pw_dir) }.to_string_lossy().into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn macho(cpu: u32) -> Vec<u8> {
        let mut b = hex_bytes(defaults::text("doctor.exe_magic_macho64"));
        b.extend(cpu.to_le_bytes());
        b.resize(32, 0);
        b
    }

    #[test]
    fn headers_classify() {
        crate::defaults::init().unwrap();
        assert_eq!(classify_header(b""), Header::Empty);
        assert_eq!(classify_header(b"#!/bin/sh\n"), Header::Script);
        assert_eq!(classify_header(&macho(0x0100_000c)), Header::MachO(vec!["aarch64".into()]));
        assert_eq!(classify_header(&macho(0x0100_0007)), Header::MachO(vec!["x86_64".into()]));
        assert_eq!(classify_header(&hex_bytes(defaults::text("doctor.exe_magic_macho64"))), Header::Truncated);
        assert_eq!(classify_header(&[0x7f, b'E', b'L', b'F']), Header::Truncated);
        assert_eq!(classify_header(&[0x41; 64]), Header::Unknown);
    }
}
