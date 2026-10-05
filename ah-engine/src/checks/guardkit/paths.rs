//! Node `path` (posix) functions the guards use, on absolute or relative strings, without touching the file system.
use crate::checks::git::util::posix_normalize;

/// `path.isAbsolute`.
pub fn is_absolute(p: &str) -> bool {
    p.starts_with('/')
}

/// `path.basename(p)`: the last segment, ignoring trailing slashes.
pub fn basename(p: &str) -> &str {
    p.trim_end_matches('/').rsplit('/').next().unwrap_or("")
}

/// `path.join(a, b)`: `a/b` normalized (empty parts are skipped by Node; callers here never pass one).
pub fn join(a: &str, b: &str) -> String {
    posix_normalize(&format!("{a}/{b}"))
}

/// `path.resolve(p)` for an absolute `p`: normalized, with no trailing slash (except the root).
pub fn resolve_abs(p: &str) -> String {
    let n = posix_normalize(p);
    if n.len() > 1 { n.trim_end_matches('/').to_string() } else { n }
}

/// `path.relative(from, to)` for two absolute paths.
pub fn relative(from: &str, to: &str) -> String {
    let f = resolve_abs(from);
    let t = resolve_abs(to);
    let fp: Vec<&str> = f.split('/').filter(|s| !s.is_empty()).collect();
    let tp: Vec<&str> = t.split('/').filter(|s| !s.is_empty()).collect();
    let common = fp.iter().zip(&tp).take_while(|(a, b)| a == b).count();
    let mut parts: Vec<&str> = vec![".."; fp.len() - common];
    parts.extend(&tp[common..]);
    parts.join("/")
}
