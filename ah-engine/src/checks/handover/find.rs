//! Locating handover artifacts under `<repo>/.anti-hall/handovers/<date>/<session-id>/` (`hooks/lib/handover-find.js`).
// Discard triage (E3): every `.ok()` / `unwrap_or_default()` in this file is a deliberate keep, for these reasons:
// - an unreadable optional file is the same as an absent one (fail-open, as Node's try/catch)
// A failure that must be seen goes through `crate::discard` instead.

use crate::checks::git::util::{path_join, posix_dirname};
use crate::checks::jsport::ident::{self, Ctx};
use crate::checks::jsport::{date, fsx};
use crate::defaults;
use crate::reqenv::RequestEnv;

/// What the port cannot decide exactly; the check then answers "defer" and Node decides.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Unsure;

/// One handover or snapshot file.
#[derive(Debug, Clone, PartialEq)]
pub struct Cand {
    /// The file's path.
    pub file_path: String,
    /// `stat.mtimeMs`.
    pub mtime_ms: f64,
    /// The date directory name.
    pub date: String,
    /// The session directory name.
    pub session_id: String,
    /// The sequence number in the file name (1 when the name has none).
    pub seq: u64,
}

/// Which file name pattern to collect.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    /// `HANDOVER.md` or `HANDOVER-<n>.md`.
    Handover,
    /// `PRECOMPACT-<n>.md`.
    Precompact,
}

/// The sequence number a file name carries for `kind`: `Some(None)` for a match without a number, `None` for no match.
pub fn match_name(name: &str, kind: Kind) -> Option<Option<&str>> {
    let ext = defaults::text("codex_handover.md_suffix");
    let body = name.strip_suffix(ext)?;
    match kind {
        Kind::Handover => {
            let rest = body.strip_prefix(defaults::text("codex_handover.handover_prefix"))?;
            if rest.is_empty() {
                return Some(None);
            }
            let digits = rest.strip_prefix('-')?;
            (!digits.is_empty() && digits.bytes().all(|b| b.is_ascii_digit())).then_some(Some(digits))
        }
        Kind::Precompact => {
            let digits = body.strip_prefix(defaults::text("codex_handover.precompact_prefix"))?;
            (!digits.is_empty() && digits.bytes().all(|b| b.is_ascii_digit())).then_some(Some(digits))
        }
    }
}

fn list_dirs(p: &str) -> Vec<String> {
    fsx::read_dir_names(p).unwrap_or_default().into_iter().filter(|(_, t)| t.is_dir()).map(|(n, _)| n).collect()
}

/// `collect(root, re, onlySessionId)`.
pub fn collect(root: &str, kind: Kind, only: Option<&str>) -> Result<Vec<Cand>, Unsure> {
    let mut out = Vec::new();
    for d in list_dirs(root) {
        let date_path = format!("{root}/{d}");
        for sid in list_dirs(&date_path) {
            if only.is_some_and(|o| o != sid) {
                continue;
            }
            let sess = format!("{date_path}/{sid}");
            let Some(files) = fsx::read_dir_names(&sess) else { continue };
            for (fname, _) in files {
                let Some(num) = match_name(&fname, kind) else { continue };
                let seq = match num {
                    Some(n) if n.len() > defaults::num("codex_handover.seq_max_digits") as usize => return Err(Unsure),
                    Some(n) => n.parse::<u64>().unwrap_or(1),
                    None => 1,
                };
                let file_path = format!("{sess}/{fname}");
                let Ok(md) = std::fs::metadata(&file_path) else { continue };
                if !md.is_file() {
                    continue;
                }
                out.push(Cand { file_path, mtime_ms: fsx::mtime_ms(&md), date: d.clone(), session_id: sid.clone(), seq });
            }
        }
    }
    Ok(out)
}

/// `findNewestHandover(root, wantSessionId)`: the newest by mtime, a same-session file winning over a newer foreign one.
pub fn newest_handover(root: &str, want: &str) -> Result<Option<Cand>, Unsure> {
    let all = collect(root, Kind::Handover, None)?;
    if all.is_empty() {
        return Ok(None);
    }
    let same: Vec<Cand> = if want.is_empty() { Vec::new() } else { all.iter().filter(|c| c.session_id == want).cloned().collect() };
    let mut pool = if same.is_empty() { all } else { same };
    pool.sort_by(|a, b| b.mtime_ms.partial_cmp(&a.mtime_ms).unwrap_or(std::cmp::Ordering::Equal));
    Ok(pool.into_iter().next())
}

/// `findNewestPrecompact(root, sessionId)`: this session's newest snapshot, ties broken by sequence number.
pub fn newest_precompact(root: &str, sid: &str) -> Result<Option<Cand>, Unsure> {
    if sid.is_empty() {
        return Ok(None);
    }
    let mut c = collect(root, Kind::Precompact, Some(sid))?;
    c.sort_by(|a, b| {
        let d = b.mtime_ms - a.mtime_ms;
        if d == 0.0 || d.is_nan() { b.seq.cmp(&a.seq) } else { d.partial_cmp(&0.0).unwrap_or(std::cmp::Ordering::Equal) }
    });
    Ok(c.into_iter().next())
}

/// `realHome()`: the real path of the home directory, or the raw value.
fn real_home(home: &str) -> String {
    std::fs::canonicalize(home).map_or_else(|_| home.to_string(), |p| p.to_string_lossy().into_owned())
}

/// `repoRoot(cwd)`: the git toplevel of `cwd`, or `cwd` itself outside a repository or when the toplevel is the home.
pub fn repo_root(cwd: &str, home: &str, env: &RequestEnv) -> Result<String, Unsure> {
    let ctx: Ctx = ident::resolve_context(cwd, false, env);
    if ctx.unsure {
        return Err(Unsure);
    }
    Ok(match ctx.toplevel {
        Some(t) if t != real_home(home) => t,
        _ => cwd.to_string(),
    })
}

/// `handoversRoot(cwd)`.
pub fn handovers_root(cwd: &str, home: &str, env: &RequestEnv) -> Result<String, Unsure> {
    let root = repo_root(cwd, home, env)?;
    Ok(path_join(&root, defaults::text("codex_handover.handovers_dir")))
}

/// The repository root a handovers root belongs to (`dirname(dirname(root))` of `<repo>/.anti-hall/handovers`).
pub fn repo_of_handovers(root: &str) -> String {
    posix_dirname(&posix_dirname(root))
}

/// `localDate()`: today's date in local time.
pub fn local_date() -> Result<String, Unsure> {
    date::local_ymd(date::now_ms()).ok_or(Unsure)
}
