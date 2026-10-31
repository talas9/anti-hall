//! PR #472 round 5: the repository state a HARD outcome is measured against. Full credit for a passing check, build or test, or a
//! verified shell write, needs a change in repo state since the last such credit, not a new command text. The state is the git
//! status of the call's repository (its `# branch.oid` line holds HEAD) plus the content of every modified or untracked,
//! non-ignored file, hashed. It is read only when a call would otherwise earn HARD, bounded by agent_tracker.repo_state.timeout_ms;
//! git missing, failing or timing out is None and the caller falls back to the verified-write rule, so the breaker never wedges.
use crate::defaults::{self, V};
use std::hash::{DefaultHasher, Hasher};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

fn cfg() -> &'static V {
    defaults::raw("agent_tracker.repo_state")
}

fn num(k: &str) -> u64 {
    cfg().get(k).and_then(V::as_integer).unwrap_or(0).max(0) as u64
}

fn list(k: &str) -> Vec<&'static str> {
    cfg().get(k).map(V::strings).unwrap_or_default()
}

#[cfg(test)]
pub(crate) use tests::GIT_OVERRIDE;

fn git_and_timeout() -> (String, u64) {
    #[cfg(test)]
    if let Some(o) = GIT_OVERRIDE.with(|g| g.borrow().clone()) {
        return o;
    }
    (cfg().str_field("git").to_string(), num("timeout_ms"))
}

/// Run git with `args` in `dir`; its stdout when it exited with one of `ok_exits` (the status), else None (missing, failed, timed out).
fn git(dir: &Path, args: &[&str], ok_exits: &[i32], until: Instant) -> Option<(i32, Vec<u8>)> {
    let (bin, _) = git_and_timeout();
    let left = until.checked_duration_since(Instant::now()).filter(|d| !d.is_zero())?;
    let mut cmd = std::process::Command::new(&bin);
    cmd.arg(cfg().str_field("dir_flag")).arg(dir).args(args);
    for a in list("env") {
        if let Some((k, v)) = a.split_once('=') {
            cmd.env(k, v);
        }
    }
    for k in list("env_remove") {
        cmd.env_remove(k);
    }
    let timeout = crate::deadline::clamp(left);
    let o = crate::proc::run(cmd, &bin, timeout, Duration::from_millis(num("poll_ms"))).ok()?;
    let code = o.status.code()?;
    ok_exits.contains(&code).then_some((code, o.stdout))
}

/// The repository `dir` is in (its canonical top-level directory) and its state hash, or None (no repo, git missing, failed, timeout).
pub(crate) fn state(dir: &str) -> Option<(String, String)> {
    if dir.is_empty() {
        return None;
    }
    let ok = [0];
    // one bound for the whole read (every git run and the content hashing): past it the state is unknown (None)
    let until = Instant::now() + Duration::from_millis(git_and_timeout().1);
    let (_, top) = git(Path::new(dir), &list("toplevel"), &ok, until)?;
    let top = String::from_utf8_lossy(&top).trim_end_matches(['\n', '\r']).to_string();
    let top = std::fs::canonicalize(&top).ok()?;
    let (_, status) = git(&top, &list("status"), &ok, until)?;
    let (_, paths) = git(&top, &list("paths"), &ok, until)?;
    let mut h = DefaultHasher::new();
    h.write(&status);
    let (max_bytes, max_files) = (num("file_max_bytes"), num("files_max") as usize);
    for rel in paths.split(|b| *b == 0).filter(|r| !r.is_empty()).take(max_files) {
        if Instant::now() > until {
            return None;
        }
        h.write(rel);
        let p = top.join(String::from_utf8_lossy(rel).as_ref());
        match std::fs::symlink_metadata(&p) {
            Ok(md) if md.is_file() && md.len() <= max_bytes => h.write(&std::fs::read(&p).unwrap_or_default()),
            Ok(md) => {
                h.write_u64(md.len());
                h.write_u128(md.modified().ok().and_then(|m| m.duration_since(std::time::UNIX_EPOCH).ok()).map_or(0, |d| d.as_nanos()));
            }
            Err(_) => h.write_u8(0),
        }
    }
    Some((top.to_string_lossy().into_owned(), format!("{:x}", h.finish())))
}

/// Which of `paths` (absolute, inside `top`) git ignores. git failing counts none as ignored (the state check still applies).
pub(crate) fn ignored(top: &str, paths: &[String]) -> Vec<String> {
    if paths.is_empty() {
        return Vec::new();
    }
    let mut args = list("ignored");
    args.extend(paths.iter().map(String::as_str));
    let exits: Vec<i32> =
        cfg().get("ignored_exits").and_then(V::as_array).map_or_else(Vec::new, |a| a.iter().filter_map(V::as_integer).map(|n| n as i32).collect());
    let until = Instant::now() + Duration::from_millis(git_and_timeout().1);
    let Some((_, out)) = git(Path::new(top), &args, &exits, until) else { return Vec::new() };
    let hit: Vec<PathBuf> = out.split(|b| *b == 0).filter(|r| !r.is_empty()).map(|r| Path::new(top).join(String::from_utf8_lossy(r).as_ref())).collect();
    paths
        .iter()
        .filter(|p| hit.iter().any(|h| h == Path::new(p.as_str()) || std::fs::canonicalize(h).is_ok_and(|c| c == Path::new(p.as_str()))))
        .cloned()
        .collect()
}

/// Whether `path` (canonical) is under a temp directory (tmp_prefixes, or the directory a tmp_env variable names) and outside `dir`
/// (the call's directory): a scratch file of the call, never work in itself.
pub(crate) fn scratch(path: &str, dir: &str) -> bool {
    let p = Path::new(path);
    let canon = |s: &str| std::fs::canonicalize(s).unwrap_or_else(|_| PathBuf::from(s));
    if !dir.is_empty() && p.starts_with(canon(dir)) {
        return false;
    }
    let env: Vec<String> = list("tmp_env").iter().filter_map(|k| std::env::var(k).ok()).filter(|v| !v.is_empty()).collect();
    list("tmp_prefixes").into_iter().map(str::to_string).chain(env).any(|t| p.starts_with(&t) || p.starts_with(canon(&t)))
}

#[cfg(test)]
mod tests {
    thread_local! {
        /// Test override of the git program and the timeout (ms), per test thread: a missing program or one that hangs (spec (f)).
        pub(crate) static GIT_OVERRIDE: std::cell::RefCell<Option<(String, u64)>> = const { std::cell::RefCell::new(None) };
    }
}
