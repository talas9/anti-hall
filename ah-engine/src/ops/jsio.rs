//! File and path behaviour of the Node scripts the operator ports mirror: Node's wording of an operating-system error, a
//! write that keeps the target's mode and link, `path.join`, and the test guard's "is this inside a temporary directory".
use crate::checks::git::util::posix_normalize;
use crate::checks::guardkit::paths;
use crate::defaults;
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

/// `path.join(a, b)` for any two parts (an empty part is skipped, as Node does).
pub fn join(a: &str, b: &str) -> String {
    match (a.is_empty(), b.is_empty()) {
        (true, true) => ".".into(),
        (true, false) => posix_normalize(b),
        (false, true) => posix_normalize(a),
        _ => posix_normalize(&format!("{a}/{b}")),
    }
}

/// Node's `e.message` of a failed system call: `EACCES: permission denied, open '/x'`. `detail` is one of the
/// `slcfg.err_*` templates.
pub fn node_message(e: &std::io::Error, template: &str, args: &[(&str, &dyn std::fmt::Display)]) -> String {
    let words = e
        .raw_os_error()
        .and_then(|n| {
            defaults::list("slcfg.errno_table").iter().find_map(|row| {
                let mut it = row.splitn(3, ' ');
                let (num, code, desc) = (it.next()?, it.next()?, it.next()?);
                (num.parse::<i32>().ok()? == n).then(|| format!("{code}: {desc}"))
            })
        })
        .unwrap_or_else(|| defaults::text("slcfg.errno_unknown").to_string());
    let mut all: Vec<(&str, &dyn std::fmt::Display)> = vec![("err", &words)];
    all.extend_from_slice(args);
    defaults::fill(template, &all)
}

/// `fs.writeFileSync(path, bytes)` that cannot leave a half-written file: the bytes go to a temporary file beside the
/// target and are renamed over it, keeping the target's mode and following a symlink to the real file. A target Node could
/// not open for writing (a read-only file) is refused with Node's error, never replaced; where the directory forbids the
/// temporary file the bytes are written in place, as Node does.
///
/// # Errors
/// Node's wording of the failed open.
pub fn write_file(path: &str, bytes: &[u8]) -> Result<(), String> {
    let p = Path::new(path);
    let fail = |e: &std::io::Error| node_message(e, defaults::text("slcfg.err_open"), &[("path", &path)]);
    let existing = std::fs::metadata(p).ok();
    if existing.is_some() {
        // the open Node's write makes, without truncating: a refusal here is Node's refusal
        std::fs::OpenOptions::new().write(true).open(p).map_err(|e| fail(&e))?;
    }
    let target: PathBuf = if existing.is_some() { std::fs::canonicalize(p).unwrap_or_else(|_| p.to_path_buf()) } else { p.to_path_buf() };
    let mode = existing.as_ref().map(|m| std::os::unix::fs::PermissionsExt::mode(&m.permissions()) & 0o7777);
    let style = crate::atomic::Style { mode, ..crate::atomic::Style::default() };
    if crate::atomic::write_styled(&target, bytes, style).is_ok() {
        if let Some(m) = mode {
            // the process umask must not narrow an existing file's mode
            crate::discard::harmless(std::fs::set_permissions(&target, std::os::unix::fs::PermissionsExt::from_mode(m))); // keep: the content is written; the mode was the file's own already
        }
        return Ok(());
    }
    std::fs::write(&target, bytes).map_err(|e| fail(&e))
}

/// `os.tmpdir()`.
fn os_tmpdir(env: &BTreeMap<String, String>) -> String {
    let from_env = defaults::list("slcfg.tmp_env").iter().find_map(|k| env.get(*k).filter(|v| !v.is_empty()).cloned());
    let t = from_env.unwrap_or_else(|| defaults::text("slcfg.tmp_default").to_string());
    if t.len() > 1 && t.ends_with('/') { t.trim_end_matches('/').to_string() } else { t }
}

/// `pathUnderTmp(p)` of `companion/lib/test-home-guard.js`.
pub fn under_tmp(p: &str, env: &BTreeMap<String, String>, cwd: &str) -> bool {
    let mut roots: Vec<String> = vec![os_tmpdir(env)];
    roots.extend(defaults::list("slcfg.tmp_roots").iter().map(|s| s.to_string()));
    if cfg!(target_os = "macos") {
        roots.extend(defaults::list("slcfg.tmp_roots_macos").iter().map(|s| s.to_string()));
    }
    let mut real: Vec<String> = Vec::new();
    for r in roots {
        if let Ok(c) = std::fs::canonicalize(&r) {
            real.push(c.to_string_lossy().into_owned());
        }
        real.push(r);
    }
    let raw = paths::resolve(cwd, p);
    let mut cands = vec![raw.clone()];
    if let Ok(c) = std::fs::canonicalize(&raw) {
        cands.push(c.to_string_lossy().into_owned());
    }
    cands.iter().any(|h| {
        real.iter().any(|t| {
            let rel = paths::relative(t, h);
            rel.is_empty() || (!rel.starts_with("..") && !paths::is_absolute(&rel))
        })
    })
}

/// `userConfigWriteRefused(target)`: under a test, user configuration outside a temporary directory is off limits.
pub fn config_write_refused(target: &str, env: &BTreeMap<String, String>, cwd: &str) -> bool {
    let under_test = defaults::list("slcfg.test_markers").iter().any(|k| env.get(*k).is_some_and(|v| !v.is_empty()));
    under_test && !under_tmp(target, env, cwd)
}
