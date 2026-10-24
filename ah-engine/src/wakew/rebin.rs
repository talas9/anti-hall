//! The watcher notices that its own engine binary was replaced on disk (a deploy, an update) and re-executes itself, so a
//! fix takes effect without a manual re-arm (task #175). The identity of the file is read once at start and compared each tick.
//! The path is the one the watcher was started with when it is absolute (a symlink swap shows up there), else the executable
//! path the system reports; the successor gets the very same argument vector.
use std::os::unix::fs::MetadataExt;
use std::path::{Path, PathBuf};

/// What identifies one generation of a binary file: device, inode, size and modification time (ns).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Ident {
    dev: u64,
    ino: u64,
    size: u64,
    mtime_ns: i128,
}

/// The identity of the file at `path` (symlinks followed); `None` when it cannot be read.
pub fn ident(path: &Path) -> Option<Ident> {
    let m = std::fs::metadata(path).ok()?;
    Some(Ident { dev: m.dev(), ino: m.ino(), size: m.size(), mtime_ns: i128::from(m.mtime()) * 1_000_000_000 + i128::from(m.mtime_nsec()) })
}

/// The path to watch and to execute again: `argv[0]` when it is an absolute path to a file, else the running executable.
pub fn watched_path() -> Option<PathBuf> {
    let argv0 = std::env::args_os().next().map(PathBuf::from).filter(|p| p.is_absolute() && p.is_file());
    argv0.or_else(|| std::env::current_exe().ok())
}

/// True when `path` is a regular file with an execute bit: a successor that can be started.
pub fn runnable(path: &Path) -> bool {
    std::fs::metadata(path).is_ok_and(|m| m.is_file() && m.mode() & 0o111 != 0)
}

/// The binary on disk is a different generation than the one at start, and it can be started. A momentarily absent file (the
/// swap is not atomic on this machine) is not a change: the next tick reads it again.
pub fn changed(path: &Path, at_start: Option<Ident>) -> bool {
    let Some(start) = at_start else { return false };
    ident(path).is_some_and(|now| now != start) && runnable(path)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_replaced_file_is_a_change_and_an_untouched_one_is_not() {
        let dir = std::env::temp_dir().join(format!("rebin-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let bin = dir.join("bin");
        std::fs::write(&bin, b"one").unwrap();
        std::fs::set_permissions(&bin, std::os::unix::fs::PermissionsExt::from_mode(0o755)).unwrap();
        let start = ident(&bin);
        assert!(!changed(&bin, start));
        let next = dir.join("next");
        std::fs::write(&next, b"two!").unwrap();
        std::fs::set_permissions(&next, std::os::unix::fs::PermissionsExt::from_mode(0o755)).unwrap();
        std::fs::rename(&next, &bin).unwrap();
        assert!(changed(&bin, start));
        assert!(!changed(&dir.join("absent"), start));
        assert!(!changed(&bin, None));
    }
}
