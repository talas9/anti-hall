//! File-system helpers with the semantics of the Node calls the hooks make.
use crate::checks::git::util::{posix_dirname, posix_normalize};
use std::fs;
use std::os::unix::fs::{FileTypeExt, MetadataExt};
use std::path::Path;

/// `stat.mtimeMs`: seconds times 1000 plus nanoseconds over a million, in doubles, as Node computes it.
pub fn mtime_ms(m: &fs::Metadata) -> f64 {
    m.mtime() as f64 * 1000.0 + m.mtime_nsec() as f64 / 1e6
}

/// `fs.readFileSync(p, 'utf8')`: invalid UTF-8 becomes U+FFFD, as Node's decoder does.
pub fn read_utf8(p: &str) -> Option<String> {
    fs::read(p).ok().map(|b| String::from_utf8_lossy(&b).into_owned())
}

/// Directory entry names in the order `fs.readdirSync` returns them: libuv sorts the names bytewise.
pub fn read_dir_names(p: &str) -> Option<Vec<(String, fs::FileType)>> {
    let mut out: Vec<(String, fs::FileType)> =
        fs::read_dir(p).ok()?.flatten().filter_map(|e| Some((e.file_name().to_str()?.to_string(), e.file_type().ok()?))).collect();
    out.sort_by(|a, b| a.0.as_bytes().cmp(b.0.as_bytes()));
    Some(out)
}

/// A regular file after following symlinks (`fs.statSync(p).isFile()`).
pub fn is_file(p: &str) -> bool {
    fs::metadata(p).is_ok_and(|m| m.is_file())
}

/// A directory after following symlinks.
pub fn is_dir(p: &str) -> bool {
    fs::metadata(p).is_ok_and(|m| m.is_dir())
}

/// `fs.accessSync(p, X_OK)`.
pub fn is_executable(p: &str) -> bool {
    let Ok(c) = std::ffi::CString::new(p) else { return false };
    // SAFETY: `c` is a valid NUL-terminated string.
    unsafe { libc::access(c.as_ptr(), libc::X_OK) == 0 }
}

/// `realpathOrSelf` of `hooks/lib/scratchpad.js`: the real path, or the nearest existing ancestor's real path with the
/// rest appended, or the input itself when nothing resolves.
pub fn realpath_or_self(p: &str) -> String {
    if let Ok(r) = fs::canonicalize(p) {
        return r.to_string_lossy().into_owned();
    }
    let mut cur = p.to_string();
    let mut suffix: Vec<String> = Vec::new();
    loop {
        let parent = posix_dirname(&cur);
        if parent == cur {
            return p.to_string();
        }
        suffix.insert(0, crate::checks::git::util::posix_basename(&cur));
        cur = parent;
        if let Ok(r) = fs::canonicalize(&cur) {
            let mut out = r.to_string_lossy().into_owned();
            for s in &suffix {
                out = posix_normalize(&format!("{out}/{s}"));
            }
            return out;
        }
    }
}

/// `path.relative(from, to)` for two absolute paths.
pub fn relative(from: &str, to: &str) -> String {
    crate::checks::guardkit::paths::relative(from, to)
}

/// `isInsideDir(p, dir)`: `p` resolves strictly inside `dir`, both made real first.
pub fn is_inside_dir(p: &str, dir: &str) -> bool {
    let rel = relative(&realpath_or_self(dir), &realpath_or_self(p));
    !rel.is_empty() && !rel.starts_with("..") && !rel.starts_with('/')
}

/// True when `p` exists as anything (`lstat` succeeds), without following a final symlink.
pub fn lexists(p: &str) -> bool {
    fs::symlink_metadata(p).is_ok()
}

/// Create the directory and its parents (`fs.mkdirSync(p, { recursive: true })`).
pub fn mkdir_p(p: &str) -> bool {
    fs::create_dir_all(Path::new(p)).is_ok()
}

/// A special file that `fs.statSync` reports but is neither file nor directory (socket, fifo): reading it could block.
pub fn is_special(p: &str) -> bool {
    fs::metadata(p).is_ok_and(|m| {
        let t = m.file_type();
        t.is_fifo() || t.is_socket() || t.is_char_device() || t.is_block_device()
    })
}
