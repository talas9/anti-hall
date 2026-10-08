//! Filesystem type of a path, to decide whether OS change events can be trusted there.
//!
//! macOS asks the system (`statfs`, `f_fstypename`); Linux (including WSL2) reads the mount table and takes the longest
//! mount point that holds the path. The mount-table parser is plain text handling and is compiled on every target so
//! its fixtures run everywhere (Intel and Apple Silicon Macs, Linux x86_64 and arm64, WSL2).

use std::path::Path;

/// The filesystem type name of the filesystem that holds `path` (`apfs`, `ext4`, `9p`, ...), or `None` when it cannot be
/// told (the caller then uses the safe choice, polling).
pub fn fs_type(path: &Path) -> Option<String> {
    platform(path)
}

#[cfg(target_os = "macos")]
fn platform(path: &Path) -> Option<String> {
    use std::os::unix::ffi::OsStrExt;
    let c = std::ffi::CString::new(path.as_os_str().as_bytes()).ok()?;
    // SAFETY: `statfs` is plain-old-data that the call below fills in; an all-zero value is a valid starting state.
    let mut buf: libc::statfs = unsafe { std::mem::zeroed() };
    // SAFETY: `c` is a NUL-terminated path that outlives the call and `buf` is a valid, writable `statfs`.
    let rc = unsafe { libc::statfs(c.as_ptr(), &mut buf) };
    if rc != 0 {
        return None;
    }
    let bytes: Vec<u8> = buf.f_fstypename.iter().take_while(|b| **b != 0).map(|b| *b as u8).collect();
    String::from_utf8(bytes).ok().filter(|s| !s.is_empty())
}

#[cfg(target_os = "linux")]
fn platform(path: &Path) -> Option<String> {
    let table = std::fs::read_to_string(crate::defaults::text("realtime.mounts_file")).ok()?;
    let real = std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
    type_from_mounts(&table, &real)
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
fn platform(_path: &Path) -> Option<String> {
    None
}

/// Decode the octal escapes (`\040` for a space, `\011`, `\012`, `\134`) the kernel writes into mount-table fields.
fn unescape(field: &str) -> String {
    let b = field.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        let octal = (b[i] == b'\\' && i + 4 <= b.len()).then(|| field.get(i + 1..i + 4)).flatten().and_then(|d| u8::from_str_radix(d, 8).ok());
        match octal {
            Some(v) => {
                out.push(v);
                i += 4;
            }
            None => {
                out.push(b[i]);
                i += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// The filesystem type for `path` from the text of a Linux mount table (`device mountpoint type options ...` per line):
/// the longest mount point that equals the path or is one of its ancestors wins, and among equal mount points the later
/// line (a mount over a mount) wins.
pub fn type_from_mounts(table: &str, path: &Path) -> Option<String> {
    let mut best: Option<(usize, String)> = None;
    for line in table.lines() {
        let mut f = line.split_whitespace();
        let (Some(_dev), Some(mp), Some(ty)) = (f.next(), f.next(), f.next()) else { continue };
        let mp = unescape(mp);
        let mp_path = Path::new(&mp);
        if path.starts_with(mp_path) {
            let len = mp_path.components().count();
            if best.as_ref().is_none_or(|(l, _)| len >= *l) {
                best = Some((len, ty.to_string()));
            }
        }
    }
    best.map(|(_, t)| t)
}

/// True when `fstype` matches one of `patterns`: an exact name, or a name with a leading and/or trailing `*` wildcard.
pub fn matches_any(fstype: &str, patterns: &[&str]) -> bool {
    patterns.iter().any(|p| {
        let (lead, trail) = (p.starts_with('*'), p.ends_with('*') && p.len() > 1);
        let core = p.trim_start_matches('*').trim_end_matches('*');
        match (lead, trail) {
            (true, true) => fstype.contains(core),
            (true, false) => fstype.ends_with(core),
            (false, true) => fstype.starts_with(core),
            (false, false) => fstype == *p,
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const WSL: &str = "sysfs /sys sysfs rw 0 0\n/dev/sdc / ext4 rw 0 0\nC:\\134 /mnt/c 9p rw,aname=drvfs 0 0\ndrvfs /mnt/d drvfs rw 0 0\ntmpfs /mnt/wsl tmpfs rw 0 0\n/dev/sdc /home/me/My\\040Docs ext4 rw 0 0\n";

    #[test]
    fn longest_mount_point_wins_and_octal_escapes_decode() {
        assert_eq!(type_from_mounts(WSL, Path::new("/mnt/c/Users/me/app.db")).as_deref(), Some("9p"));
        assert_eq!(type_from_mounts(WSL, Path::new("/mnt/d")).as_deref(), Some("drvfs"));
        assert_eq!(type_from_mounts(WSL, Path::new("/home/me/work")).as_deref(), Some("ext4"));
        assert_eq!(type_from_mounts(WSL, Path::new("/home/me/My Docs/x")).as_deref(), Some("ext4"));
        assert_eq!(type_from_mounts(WSL, Path::new("/mnt/cc/x")).as_deref(), Some("ext4"), "/mnt/cc is not under /mnt/c");
        assert_eq!(type_from_mounts("", Path::new("/x")), None);
    }

    #[test]
    fn a_later_mount_over_the_same_point_wins() {
        let t = "a /data ext4 rw 0 0\nb /data nfs4 rw 0 0\n";
        assert_eq!(type_from_mounts(t, Path::new("/data/x")).as_deref(), Some("nfs4"));
    }

    #[test]
    fn patterns_match_exact_prefix_suffix_and_contains() {
        let p = ["9p", "nfs", "fuse*", "*fuse", "*afp*"];
        for yes in ["9p", "nfs", "fuseblk", "fuse", "macfuse", "xafpx"] {
            assert!(matches_any(yes, &p), "{yes}");
        }
        for no in ["apfs", "ext4", "nfs4", "btrfs", "9p2000"] {
            assert!(!matches_any(no, &p), "{no}");
        }
    }

    #[test]
    fn the_running_system_names_the_type_of_the_temp_dir() {
        crate::defaults::init().expect("defaults load in a test");
        let t = fs_type(&std::env::temp_dir());
        assert!(t.as_deref().is_some_and(|s| !s.is_empty()), "fs type of the temp dir: {t:?}");
    }
}
