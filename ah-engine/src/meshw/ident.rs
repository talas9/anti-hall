//! Who is calling and which project they are in, resolved the way Node's mesh CLI does it, or not at all.
//!
//! Ports `companion/lib/identity.js` `resolveContext` (git-free: `.git` files and directories, `commondir`, absorbed
//! submodules), `install-devswarm-ingest.js` `primaryWorkspaceId`, `devswarm-lib/identity.js` `callerIdentityDetailed`,
//! `projectCwdFor`, `childSenderId`, `senderIdentityDetailed`, `declaredSelfId`, `canonicalMeshId`,
//! `canonicalWorktreeRealPath`, `rawPathMeshId`, `companion/lib/devswarm-app-db.js` `builderForWorktree` and
//! `companion/lib/reader-identity.js` `deriveReaderNonce`.
//!
//! Node answers some of these by running git (`rev-parse --show-superproject-working-tree` for a checkout nested in
//! another one). The engine asks git the same one question, bounded and cached the same way (`git_superproject`); where git
//! does not answer, or Node would run anything else, the answer is [`Defer`] and the verb goes to Node.
// Discard triage (E3): every `.ok()` / `unwrap_or_default()` in this file is a deliberate keep, for these reasons:
// - an unreadable optional file is the same as an absent one (fail-open, as Node's try/catch)
// - text that does not parse or decode is the absent value (Node Number()/JSON.parse catch parity)
// A failure that must be seen goes through `crate::discard` instead.
use crate::checks::git::util::posix_normalize;
use crate::checks::guardkit::ojson::OVal;
use crate::defaults;
use crate::meshw::store::hex;
use rusqlite::types::ValueRef;
use std::collections::HashMap;
use std::os::unix::fs::MetadataExt;
use std::path::Path;

/// The reason a resolution stopped: a refusal that is the verb's own answer ([`refuse`]), a store failure the verb prints as its
/// error ([`Defer::reason`]) or a case the caller holds and retries. Nothing is ever handed to Node; the name is historical.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Defer(pub String);

impl Defer {
    /// The carrier of a stopped resolution with its reason text (every reason is logged or printed by the caller).
    pub fn reason(why: impl Into<String>) -> Self {
        Self(why.into())
    }
}

/// Shorthand for a deferral with a reason code (the code names a `mesh_write.defer_*` setting's purpose).
pub fn defer<T>(code: &str) -> Result<T, Defer> {
    Err(Defer::reason(code))
}

/// JavaScript `String(v)` of a JSON value: `null` is "null", arrays join their elements with a comma (null as empty), an object is
/// "[object Object]".
pub fn js_to_string(v: &OVal) -> String {
    match v {
        OVal::Null => "null".to_string(),
        OVal::Bool(b) => b.to_string(),
        OVal::Num(n) => crate::checks::jsport::num::to_js_string(*n),
        OVal::Str(s) => s.clone(),
        OVal::Arr(a) => a.iter().map(|e| if matches!(e, OVal::Null) { String::new() } else { js_to_string(e) }).collect::<Vec<_>>().join(","),
        OVal::Obj(_) => "[object Object]".to_string(),
    }
}

/// A refusal of the verb that no later code can undo (Node returns it as the verb's result with exit 2), carried up through the
/// deferral channel: the reason is `mesh_write.refusal_prefix` and the refusal's JSON body (without the `action`, which the front
/// door adds from the verb's name). The front door prints it with `mesh_write.exit_refused`; it is never a deferral to Node.
pub fn refuse<T>(body: &str) -> Result<T, Defer> {
    Err(Defer::reason(format!("{}{body}", defaults::text("mesh_write.refusal_prefix"))))
}

/// The verb's own refusal for a store, registry or table that cannot be opened, read or written (Node throws there too): exit 2,
/// reason `store-unavailable`, `what` the `mesh_write.what_*` key naming the thing and `detail` the error's own text.
pub fn unavailable<T>(what_key: &str, detail: &dyn std::fmt::Display) -> Result<T, Defer> {
    let mut body = common_obj();
    body.push(("ok".to_string(), OVal::Bool(false)));
    body.push(("reason".to_string(), OVal::Str(defaults::text("mesh_write.reason_store_unavailable").to_string())));
    let what = defaults::text(what_key);
    body.push(("error".to_string(), OVal::Str(defaults::render("mesh_write.msg_store_unavailable", &[("what", &what), ("detail", detail)]))));
    refuse(&OVal::Obj(body).stringify())
}

fn common_obj() -> Vec<(String, OVal)> {
    Vec::new()
}

/// [`refuse`] for a failure that is the verb's own answer: `{"ok":false,"error":<text of `msg_key` with `vars`>}`.
pub fn refuse_text<T>(msg_key: &str, vars: &[(&str, &str)]) -> Result<T, Defer> {
    let mut o = crate::meshw::common::Obj::default();
    o.put("ok", OVal::Bool(false)).put("error", OVal::Str(defaults::render(msg_key, &vars.iter().map(|(k, v)| (*k, v as &dyn std::fmt::Display)).collect::<Vec<_>>())));
    refuse(&o.done().stringify())
}

/// The JSON body of a refusal carried by [`refuse`]; `None` for any other deferral.
pub fn refusal_body(d: &Defer) -> Option<&str> {
    d.0.strip_prefix(defaults::text("mesh_write.refusal_prefix"))
}

/// Result of a resolution that may defer.
pub type R<T> = Result<T, Defer>;

/// The bytes of a mesh file a path names (a descriptor's inbox or cursor file, a harness session record), read the way Node's
/// `readFileSync` in a try/catch reads it: `Ok(None)` when it is absent, a directory or cannot be opened (Node's catch), and the
/// bytes of a regular file otherwise. A regular file past `mesh_write.file_read_max_bytes` (the soft limit) is still read, counted
/// and logged; one past `mesh_write.file_read_hard_max_bytes` (Node's own string limit, where its read fails into the same catch)
/// is read as absent, counted and logged. Opened non-blocking, and read no further than the hard limit, so a file that grows or is
/// swapped after the check cannot make it allocate without bound.
///
/// A FIFO, socket or device is the one refusal: Node's read of a FIFO blocks for good (a socket or device fails), so there is no
/// answer of Node's to copy, and a mutating caller must never open such a path to append. It is the verb's own refusal (exit 2,
/// `not-a-regular-file`); [`read_or_skip`] is for the callers that carry on without the file.
pub fn read_bounded(path: &Path) -> R<Option<Vec<u8>>> {
    read_with_site(path, defaults::text("mesh_write.site_read_bounded"))
}

/// Count and log a mesh file that was skipped or read past a limit (`mesh_descriptor_read_skipped`), with the site and the reason.
fn note_read_limit(path: &Path, site: &str, reason: &str) {
    crate::metrics::bump("mesh_descriptor_read_skipped", &[("site", site), ("reason", reason)]);
    crate::debug::violated(
        "meshw",
        &defaults::render("mesh_write.msg_descriptor_read_skipped", &[("site", &site), ("reason", &reason), ("path", &path.display())]),
    );
}

/// The verb's own refusal for a path that is a FIFO, socket or device (a read would block for good; Node's blocks too): exit 2,
/// reason `not-a-regular-file`.
fn not_regular<T>(path: &Path) -> R<T> {
    let mut body = Vec::new();
    body.push(("ok".to_string(), OVal::Bool(false)));
    body.push(("reason".to_string(), OVal::Str(defaults::text("mesh_write.read_why_not_regular").to_string())));
    body.push(("error".to_string(), OVal::Str(defaults::render("mesh_write.msg_not_regular", &[("path", &path.display())]))));
    refuse(&OVal::Obj(body).stringify())
}

fn read_with_site(path: &Path, site: &str) -> R<Option<Vec<u8>>> {
    use std::io::Read;
    use std::os::unix::fs::OpenOptionsExt;
    let soft = defaults::num("mesh_write.file_read_max_bytes");
    let hard = defaults::num("mesh_write.file_read_hard_max_bytes").max(soft);
    let Ok(m) = std::fs::metadata(path) else { return Ok(None) };
    if m.is_dir() {
        return Ok(None);
    }
    if !m.is_file() {
        return not_regular(path);
    }
    if m.len() > hard {
        note_read_limit(path, site, defaults::text("mesh_write.read_why_over_hard"));
        return Ok(None);
    }
    let Ok(f) = std::fs::OpenOptions::new().read(true).custom_flags(libc::O_NONBLOCK).open(path) else { return Ok(None) };
    if !f.metadata().is_ok_and(|m| m.is_file()) {
        return not_regular(path);
    }
    let mut buf = Vec::new();
    if f.take(hard.saturating_add(1)).read_to_end(&mut buf).is_err() {
        return Ok(None);
    }
    if buf.len() as u64 > hard {
        note_read_limit(path, site, defaults::text("mesh_write.read_why_over_hard"));
        return Ok(None);
    }
    if buf.len() as u64 > soft {
        note_read_limit(path, site, defaults::text("mesh_write.read_why_over_soft"));
    }
    Ok(Some(buf))
}

/// [`read_bounded`] for a verb that carries on without the file: the bytes, or `None` when the file is absent, unreadable or one a
/// read must not touch (a FIFO, socket or device, or a file past the hard limit). Those, and a read past the soft limit, are counted
/// and logged with the site and the reason, so a skipped file is seen instead of read as an empty one in silence.
pub fn read_or_skip(path: &Path, site: &str) -> Option<Vec<u8>> {
    match read_with_site(path, site) {
        Ok(bytes) => bytes,
        Err(_) => {
            note_read_limit(path, site, defaults::text("mesh_write.read_why_not_regular"));
            None
        }
    }
}

/// `path.resolve(p)` for any path: a relative one is taken against the working directory, as Node's `process.cwd()` is.
pub fn abs_from_cwd(p: &str) -> String {
    if p.starts_with('/') {
        return resolve_abs(p);
    }
    let cwd = std::env::current_dir().ok().and_then(|c| c.to_str().map(str::to_string)).unwrap_or_else(|| "/".to_string());
    resolve_abs(&format!("{cwd}/{p}"))
}

/// `path.resolve(p)` for an absolute path.
pub fn resolve_abs(p: &str) -> String {
    let n = posix_normalize(p);
    if n.len() > 1 { n.trim_end_matches('/').to_string() } else { n }
}

/// `path.resolve(base, p)`.
pub fn resolve(base: &str, p: &str) -> String {
    if p.starts_with('/') { resolve_abs(p) } else { resolve_abs(&format!("{base}/{p}")) }
}

/// `path.dirname(p)` for a normalized absolute path.
pub fn dirname(p: &str) -> String {
    match p.rfind('/') {
        Some(0) => "/".into(),
        Some(i) => p[..i].to_string(),
        None => ".".into(),
    }
}

/// `path.basename(p)`.
pub fn basename(p: &str) -> &str {
    p.trim_end_matches('/').rsplit('/').next().unwrap_or("")
}

/// `fs.realpathSync(p)`; `None` when it throws. A path that is not UTF-8 is treated as unresolvable.
pub fn realpath(p: &str) -> Option<String> {
    std::fs::canonicalize(p).ok().and_then(|x| x.to_str().map(str::to_string))
}

fn lstat_exists(p: &str) -> bool {
    std::fs::symlink_metadata(p).is_ok()
}

fn sha256_hex(s: &str) -> String {
    hex(ring::digest::digest(&ring::digest::SHA256, s.as_bytes()).as_ref())
}

/// `sanitizeRepoName(name)`.
pub fn sanitize_repo_name(name: &str) -> String {
    let lower = name.to_lowercase();
    let mut slug = String::new();
    let mut dash = false;
    for ch in lower.chars() {
        if ch.is_ascii_lowercase() || ch.is_ascii_digit() || ch == '-' {
            if ch == '-' {
                if !dash {
                    slug.push('-');
                }
                dash = true;
            } else {
                slug.push(ch);
                dash = false;
            }
        } else if !dash {
            slug.push('-');
            dash = true;
        }
    }
    let capped: String = slug.chars().take(defaults::num("mesh_write.repo_name_max") as usize).collect();
    let t = capped.trim_matches('-');
    if t.is_empty() { defaults::text("mesh_write.repo_name_fallback").to_string() } else { t.to_string() }
}

/// `repoKeyForCommonDir(commonDir)`.
pub fn repo_key_for_common_dir(common: &str) -> String {
    format!("{}-{}", sanitize_repo_name(basename(&dirname(common))), &sha256_hex(common)[..defaults::num("mesh_write.repo_key_hex") as usize])
}

/// `meshIdForRealPath(p)`.
pub fn mesh_id_for_real_path(p: &str) -> String {
    format!("{}{}", defaults::text("mesh_write.primary_prefix"), &sha256_hex(p)[..defaults::num("mesh_write.mesh_id_hex") as usize])
}

/// `worktreeRealPath(wt)`: its real path, else `path.resolve(wt)`.
pub fn worktree_real_path(wt: &str) -> R<String> {
    Ok(realpath(wt).unwrap_or_else(|| abs_from_cwd(wt)))
}

/// `primaryWorkspaceId(wt)`.
pub fn primary_workspace_id(wt: &str) -> R<String> {
    Ok(mesh_id_for_real_path(&worktree_real_path(wt)?))
}

/// `rawPathMeshId(p)`.
pub fn raw_path_mesh_id(p: &str) -> R<Option<String>> {
    if p.is_empty() {
        return Ok(None);
    }
    Ok(Some(mesh_id_for_real_path(&abs_from_cwd(p))))
}

struct GitDir {
    g: String,
    is_file: bool,
    common: String,
    has_commondir: bool,
}

/// `gitdirOf(T)`.
fn gitdir_of(t: &str) -> Option<GitDir> {
    let dot = format!("{t}/{}", defaults::text("mesh_write.dot_git"));
    let st = std::fs::symlink_metadata(&dot).ok()?;
    let (g, is_file) = if st.is_dir() {
        (realpath(&dot)?, false)
    } else {
        let txt = String::from_utf8_lossy(&std::fs::read(&dot).ok()?).into_owned();
        let target = txt
            .lines()
            .find_map(|l| l.trim_start().strip_prefix(defaults::text("mesh_write.gitdir_key")).map(|r| r.trim().to_string()))
            .filter(|s| !s.is_empty())?;
        let g = realpath(&resolve(t, &target))?;
        if !std::fs::metadata(&g).ok()?.is_dir() {
            return None;
        }
        (g, true)
    };
    let mut common = g.clone();
    let mut has_commondir = false;
    if let Ok(raw) = std::fs::read(format!("{g}/{}", defaults::text("mesh_write.commondir_file"))) {
        let raw = String::from_utf8_lossy(&raw).trim().to_string();
        if !raw.is_empty()
            && let Some(c) = realpath(&resolve(&g, &raw))
        {
            common = c;
            has_commondir = true;
        }
    }
    Some(GitDir { g, is_file, common, has_commondir })
}

/// `nearestDotGit(dir)`.
fn nearest_dot_git(dir: &str) -> Option<String> {
    let mut d = dir.to_string();
    loop {
        if lstat_exists(&format!("{}/{}", d.trim_end_matches('/'), defaults::text("mesh_write.dot_git"))) {
            return Some(d);
        }
        let parent = dirname(&d);
        if parent == d {
            return None;
        }
        d = parent;
    }
}

/// `coreWorktreeOf(gitdir)`: the real path of `core.worktree` in `<gitdir>/config` (resolved against the gitdir), or `None`.
fn core_worktree_of(gitdir: &str) -> Option<String> {
    let cfg = std::fs::read(format!("{gitdir}/{}", defaults::text("mesh_write.git_config_file"))).ok()?;
    let cfg = String::from_utf8_lossy(&cfg);
    let mut in_core = false;
    for line in cfg.lines() {
        let t = line.trim();
        if t.starts_with('[') {
            in_core = t == defaults::text("mesh_write.git_core_section");
            continue;
        }
        if in_core
            && let Some(rest) = t.strip_prefix(defaults::text("mesh_write.git_worktree_key"))
            && let Some(v) = rest.trim_start().strip_prefix('=')
        {
            let v = v.trim();
            return if v.is_empty() { None } else { realpath(&resolve(gitdir, v)) };
        }
    }
    None
}

/// `isGitlinkPath(P, dir)`: `dir` is a submodule path declared in P's `.gitmodules` (pure fs).
fn is_gitlink_path(p: &str, dir: &str) -> bool {
    let Some(rel) = dir.strip_prefix(&format!("{}/", p.trim_end_matches('/'))) else { return false };
    if rel.is_empty() {
        return false;
    }
    let Ok(txt) = std::fs::read(format!("{p}/{}", defaults::text("mesh_write.gitmodules_file"))) else { return false };
    String::from_utf8_lossy(&txt).lines().any(|l| {
        l.trim_start()
            .strip_prefix(defaults::text("mesh_write.gitmodules_path_key"))
            .and_then(|r| r.trim_start().strip_prefix('='))
            .is_some_and(|v| v.trim().trim_end_matches('/') == rel)
    })
}

/// The superproject answers git gave, per nested checkout (identity.js `superCache`): `(answer, when)`. Only an answer git gave
/// is kept; a failed call is asked again next time.
type SuperCache = HashMap<String, (Option<String>, std::time::Instant)>;
static SUPER_CACHE: std::sync::Mutex<Option<SuperCache>> = std::sync::Mutex::new(None);

/// `gitSuperproject(dir)`: the real path of the superproject checkout git names for the nested checkout `root` (a `.git`
/// directory, or a `.git` file layout the disk does not classify, below another repository), `None` for none. A git call that
/// fails or times out, or an answer whose path does not resolve, is `None` too and sets `uncertain` (Node's `c.uncertain`: the
/// answer is "no superproject", flagged as not trustworthy, and is not cached so the next call asks again).
fn git_superproject(root: &str, uncertain: &std::cell::Cell<bool>) -> Option<String> {
    let ttl = defaults::millis("mesh_write.super_cache_ttl_ms");
    if let Ok(g) = SUPER_CACHE.lock()
        && let Some((ans, at)) = g.as_ref().and_then(|m| m.get(root))
        && at.elapsed() < ttl
    {
        return ans.clone();
    }
    let argv: Vec<String> = defaults::list("codex_handover.argv_super").iter().map(|a| a.replace("{root}", root)).collect();
    let out = crate::checks::jsport::gitrun::git_scrubbed(
        root,
        &argv.iter().map(String::as_str).collect::<Vec<_>>(),
        defaults::millis("codex_handover.identity_git_timeout_ms"),
        &crate::reqenv::RequestEnv::default(),
        &defaults::list("codex_handover.git_scrub_env"),
    );
    let Some(out) = out else {
        uncertain.set(true);
        return None;
    };
    let s = crate::checks::guardkit::text::js_trim(&out);
    let ans = if s.is_empty() {
        None
    } else {
        match realpath(s) {
            Some(r) => Some(r),
            None => {
                uncertain.set(true);
                return None;
            }
        }
    };
    if let Ok(mut g) = SUPER_CACHE.lock() {
        let m = g.get_or_insert_with(HashMap::new);
        if m.len() as u64 >= defaults::num("mesh_write.super_cache_max") {
            m.retain(|_, (_, at)| at.elapsed() < ttl);
            if m.len() as u64 >= defaults::num("mesh_write.super_cache_max") {
                m.clear();
            }
        }
        m.insert(root.to_string(), (ans.clone(), std::time::Instant::now()));
    }
    ans
}

fn under(child: &str, parent: &str) -> bool {
    child == parent || child.starts_with(&format!("{parent}/"))
}

/// A resolved context (`resolveContext`), with only the fields the verbs use.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Ctx {
    /// `deleted`, `non-git` or a git kind.
    pub kind: String,
    /// The nearest checkout holding the caller (`toplevel`).
    pub toplevel: Option<String>,
    /// The key-bearing root (the outermost superproject for a submodule).
    pub worktree_root: Option<String>,
    /// The real common dir.
    pub common_dir: Option<String>,
    /// `dirname(commonDir)`.
    pub main_worktree: Option<String>,
    /// `repoKeyForCommonDir(commonDir)`.
    pub repo_key: Option<String>,
    /// A superproject query git could not answer (failed, timed out, or an unresolvable path) read as "none": the keys above are
    /// Node's, but not confirmed (`c.uncertain`).
    pub uncertain: bool,
}

fn null_ctx(kind: &str) -> Ctx {
    Ctx { kind: kind.to_string(), ..Ctx::default() }
}

/// `resolveContext(cwd, { memo: false, superCache: true, missingPath })`; `ancestor` = `missingPath: 'ancestor'`.
pub fn resolve_context(cwd: &str, ancestor: bool) -> R<Ctx> {
    let abs = abs_from_cwd(cwd);
    let cwd_real = match realpath(&abs) {
        Some(r) => r,
        None => {
            if !ancestor {
                return Ok(null_ctx(defaults::text("mesh_write.kind_deleted")));
            }
            let mut d = dirname(&abs);
            loop {
                if let Some(r) = realpath(&d) {
                    break r;
                }
                let p = dirname(&d);
                if p == d {
                    return Ok(null_ctx(defaults::text("mesh_write.kind_deleted")));
                }
                d = p;
            }
        }
    };
    let Some(t) = nearest_dot_git(&cwd_real) else { return Ok(null_ctx(defaults::text("mesh_write.kind_non_git"))) };
    let Some(info) = gitdir_of(&t) else { return Ok(null_ctx(defaults::text("mesh_write.kind_non_git"))) };
    if under(&cwd_real, &info.g) {
        return Ok(null_ctx(defaults::text("mesh_write.kind_non_git")));
    }
    // a git call that failed or timed out reads as "no superproject" and flags the whole resolution (Node's `c.uncertain`)
    let uncertain = std::cell::Cell::new(false);
    // superOf(root, ri): a superproject, or none; git is asked only where the disk cannot tell
    let super_of = |root: &str, ri: &GitDir| -> R<Option<String>> {
        let Some(p) = nearest_dot_git(&dirname(root)) else { return Ok(None) };
        if p == root {
            return Ok(None);
        }
        if ri.is_file {
            if let Some(pi) = gitdir_of(&p)
                && ri.g.starts_with(&format!("{}/{}/", pi.g, defaults::text("mesh_write.git_modules_dir")))
            {
                return Ok(Some(p));
            }
            if ri.has_commondir {
                // a linked worktree of a submodule checked out at a gitlink path of the enclosing checkout
                if core_worktree_of(&ri.common).is_some() && is_gitlink_path(&p, root) {
                    return Ok(Some(p));
                }
                return Ok(None);
            }
        }
        Ok(git_superproject(root, &uncertain))
    };
    let mut root = t.clone();
    let t = t.clone();
    let mut ri = info;
    let mut depth = 0u64;
    while depth < defaults::num("mesh_write.max_submodule_hops") {
        let sp = super_of(&root, &ri)?;
        if sp.is_none() && ri.is_file && ri.has_commondir {
            // a linked worktree of a submodule: hop to the submodule checkout its common dir names when that is itself a submodule
            let co = core_worktree_of(&ri.common).filter(|c| *c != root);
            if let Some((co, co_info)) = co.and_then(|c| gitdir_of(&c).map(|i| (c, i)))
                && co_info.g == ri.common
                && super_of(&co, &co_info)?.is_some()
            {
                root = co;
                ri = co_info;
                depth += 1;
                continue;
            }
        }
        let Some(sp) = sp else { break };
        let Some(spi) = gitdir_of(&sp) else { break };
        root = sp;
        ri = spi;
        depth += 1;
    }
    let common = ri.common.clone();
    let kind = if ri.has_commondir { defaults::text("mesh_write.kind_linked") } else { defaults::text("mesh_write.kind_main") };
    Ok(Ctx {
        kind: if depth > 0 { format!("{}{kind}", defaults::text("mesh_write.kind_submodule_prefix")) } else { kind.to_string() },
        toplevel: Some(t),
        worktree_root: Some(root),
        main_worktree: Some(dirname(&common)),
        repo_key: Some(repo_key_for_common_dir(&common)),
        common_dir: Some(common),
        uncertain: uncertain.get(),
    })
}

/// `resolveCallerWorktree(cwd)`.
pub fn resolve_caller_worktree(cwd: &str) -> R<Option<String>> {
    Ok(resolve_context(cwd, true)?.worktree_root)
}

/// `repokey.repoKeyForWorktree(wt)` (no injected runner: the resolveContext common dir).
pub fn repo_key_for_worktree(wt: &str) -> R<Option<String>> {
    if wt.is_empty() {
        return Ok(None);
    }
    Ok(resolve_context(wt, false)?.repo_key)
}

/// `canonicalWorktreeRealPath(p)`.
pub fn canonical_worktree_real_path(p: &str) -> R<Option<String>> {
    if p.is_empty() {
        return Ok(None);
    }
    let c = resolve_context(p, false)?;
    if c.kind == defaults::text("mesh_write.kind_deleted") {
        return Ok(None);
    }
    match c.worktree_root {
        Some(r) => Ok(Some(r)),
        None => Ok(Some(worktree_real_path(p)?)),
    }
}

/// `canonicalMeshId(p)`.
pub fn canonical_mesh_id(p: &str) -> R<Option<String>> {
    if p.is_empty() {
        return Ok(None);
    }
    let c = resolve_context(p, false)?;
    if c.kind == defaults::text("mesh_write.kind_deleted") {
        return Ok(None);
    }
    Ok(Some(primary_workspace_id(c.worktree_root.as_deref().unwrap_or(p))?))
}

/// The process environment the verb runs with.
pub type Env = HashMap<String, String>;

fn env_nonempty<'a>(env: &'a Env, name: &str) -> Option<&'a str> {
    env.get(name).map(String::as_str).filter(|s| !s.is_empty())
}

/// `{ identity, kind }` of `callerIdentityDetailed`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Caller {
    /// The identity.
    pub identity: String,
    /// `resolved`, `declared`, `unresolvable` or `child`.
    pub kind: String,
    /// The worktree label a child id replaces.
    pub mesh_id: Option<String>,
}

/// `callerIdentityDetailed(env, cwd)`.
pub fn caller_identity_detailed(env: &Env, cwd: &str) -> R<Caller> {
    if let Some(wt) = resolve_caller_worktree(cwd)? {
        return Ok(Caller { identity: primary_workspace_id(&wt)?, kind: defaults::text("mesh_write.kind_resolved").into(), mesh_id: None });
    }
    if let Some(bid) = env_nonempty(env, defaults::text("mesh_write.env_builder_id")) {
        return Ok(Caller { identity: bid.to_string(), kind: defaults::text("mesh_write.kind_declared").into(), mesh_id: None });
    }
    Ok(Caller { identity: primary_workspace_id(cwd)?, kind: defaults::text("mesh_write.kind_unresolvable").into(), mesh_id: None })
}

/// `devswarmRoot(home)/workspaces/<id>.json`, as `readDescriptorFile` reads it: a regular file (not a symlink) holding a
/// JSON object, else `None`.
pub fn read_descriptor(home: &Path, id: &str) -> Option<OVal> {
    let p = crate::meshw::idlock::devswarm_root(home)
        .join(defaults::text("mesh_write.dir_workspaces"))
        .join(format!("{id}{}", defaults::text("mesh_write.json_suffix")));
    let st = std::fs::symlink_metadata(&p).ok()?;
    if !st.is_file() {
        return None;
    }
    match OVal::parse(&String::from_utf8_lossy(&std::fs::read(&p).ok()?)) {
        Some(v @ OVal::Obj(_)) => Some(v),
        _ => None,
    }
}

fn str_field(v: &OVal, k: &str) -> Option<String> {
    match v.get(k) {
        Some(OVal::Str(s)) => Some(s.clone()),
        _ => None,
    }
}

/// `projectCwdFor(ctx)`.
pub fn project_cwd_for(home: &Path, env: &Env, cwd: &str) -> R<String> {
    if resolve_caller_worktree(cwd)?.is_some() {
        return Ok(cwd.to_string());
    }
    if let Some(bid) = env_nonempty(env, defaults::text("mesh_write.env_builder_id"))
        && let Some(d) = read_descriptor(home, bid)
        && let Some(wt) = str_field(&d, defaults::text("mesh_write.field_worktree_path")).filter(|s| !s.is_empty())
        && wt.starts_with('/')
        && Path::new(&wt).exists()
        && resolve_caller_worktree(&wt)?.is_some()
    {
        return Ok(wt);
    }
    if let Some(pd) = env_nonempty(env, defaults::text("mesh_write.env_project_dir"))
        && pd.starts_with('/')
        && Path::new(pd).exists()
        && resolve_caller_worktree(pd)?.is_some()
    {
        return Ok(pd.to_string());
    }
    Ok(cwd.to_string())
}

/// One registry row as the verbs read it.
#[derive(Debug, Clone, PartialEq)]
pub struct Row {
    /// Registry id (`String(r.id)`).
    pub id: String,
    /// `worktree_path || null`.
    pub worktree_path: Option<String>,
    /// `session_id || null`.
    pub session_id: Option<String>,
    /// `updated_at` as a number (NaN as None).
    pub updated_at: Option<f64>,
}

/// Rows from `MeshReader::roster` (sorted-key JSON) into [`Row`]s.
pub fn rows_of(roster: &[serde_json::Value]) -> Vec<Row> {
    roster
        .iter()
        .map(|r| Row {
            id: match &r["id"] {
                serde_json::Value::String(s) => s.clone(),
                serde_json::Value::Null => String::new(),
                other => other.to_string(),
            },
            worktree_path: r["worktreePath"].as_str().map(str::to_string),
            session_id: r["sessionId"].as_str().map(str::to_string),
            updated_at: r["updatedAt"].as_f64(),
        })
        .collect()
}

/// `declaredSelfId(env, cwd, registry)`.
pub fn declared_self_id(env: &Env, cwd: &str, rows: &[Row]) -> R<Option<String>> {
    let Some(bid) = env_nonempty(env, defaults::text("mesh_write.env_builder_id")) else { return Ok(None) };
    let Some(wt) = resolve_caller_worktree(cwd)? else { return Ok(None) };
    let Some(caller_wt) = canonical_worktree_real_path(&wt)? else { return Ok(None) };
    let Some(row) = rows.iter().find(|r| r.id == bid) else { return Ok(None) };
    let Some(rp) = row.worktree_path.as_deref() else { return Ok(None) };
    Ok((canonical_worktree_real_path(rp)?.as_deref() == Some(caller_wt.as_str())).then(|| bid.to_string()))
}

/// The app's builder record for a worktree (`builderForWorktree`): `(id, builderType)`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Builder {
    /// Builder id.
    pub id: String,
    /// `primary`, `standard`, ... or None.
    pub builder_type: Option<String>,
}

/// `appDbPath({ home, env })`.
pub fn app_db_path(home: &Path, env: &Env) -> Option<String> {
    let ov = env.get(defaults::text("mesh_write.env_app_db")).map(|s| s.trim().to_string()).unwrap_or_default();
    if !ov.is_empty() {
        return (!ov.eq_ignore_ascii_case(defaults::text("mesh_write.app_db_off"))).then_some(ov);
    }
    let home = home.to_str()?;
    if cfg!(target_os = "macos") {
        return Some(format!("{home}/{}", defaults::text("mesh_write.app_db_macos")));
    }
    let base = env_nonempty(env, defaults::text("mesh_write.env_xdg_config"))
        .map(str::to_string)
        .unwrap_or_else(|| format!("{home}/{}", defaults::text("mesh_write.xdg_default")));
    Some(format!("{base}/{}", defaults::text("mesh_write.app_db_linux")))
}

/// `normPath(p)`.
fn norm_path(p: &str) -> R<Option<String>> {
    if p.is_empty() {
        return Ok(None);
    }
    let r = abs_from_cwd(p);
    Ok(Some(realpath(&r).unwrap_or(r)))
}

fn js_num(v: ValueRef<'_>) -> f64 {
    match v {
        ValueRef::Null => 0.0,
        ValueRef::Integer(i) => i as f64,
        ValueRef::Real(f) => f,
        ValueRef::Text(t) => {
            let s = String::from_utf8_lossy(t);
            let s = s.trim();
            if s.is_empty() { 0.0 } else { s.parse::<f64>().unwrap_or(f64::NAN) }
        }
        ValueRef::Blob(_) => f64::NAN,
    }
}

fn js_str(v: ValueRef<'_>) -> Option<String> {
    match v {
        ValueRef::Null => None,
        ValueRef::Integer(i) => Some(i.to_string()),
        ValueRef::Real(f) => Some(crate::checks::jsport::num::to_js_string(f)),
        ValueRef::Text(t) => Some(String::from_utf8_lossy(t).into_owned()),
        ValueRef::Blob(_) => None,
    }
}

/// `builderForWorktree({ home, env, worktreePath })`, read from the app's `builders` table. `Ok(None)` wherever Node's
/// snapshot is null (no database, no `builders` table, no `id`/`isActive` column) or the pick is not unique.
pub fn builder_for_worktree(home: &Path, env: &Env, worktree: &str) -> R<Option<Builder>> {
    let Some(file) = app_db_path(home, env) else { return Ok(None) };
    if !std::fs::metadata(&file).map(|m| m.is_file()).unwrap_or(false) {
        return Ok(None);
    }
    // read only and never waiting for a lock, like Node's node:sqlite: a locked database reads as unavailable
    let Some(conn) = crate::meshw::appdb::open(&file) else { return Ok(None) };
    let cols: Vec<String> = match conn.prepare(crate::sql::MESHW_APP_BUILDER_COLUMNS) {
        Ok(mut st) => st.query_map([], |r| r.get::<_, String>(1)).map(|it| it.flatten().collect()).unwrap_or_default(),
        Err(_) => return Ok(None),
    };
    for core in defaults::list("mesh_write.app_core_columns") {
        if !cols.iter().any(|c| c == core) {
            return Ok(None);
        }
    }
    let has = |c: &str| cols.iter().any(|x| x == c);
    let wt_col = if has(defaults::text("mesh_write.app_col_worktree")) { crate::sql::MESHW_APP_COL_WORKTREE } else { crate::sql::MESHW_APP_COL_NULL };
    let type_col = if has(defaults::text("mesh_write.app_col_builder_type")) { crate::sql::MESHW_APP_COL_BUILDER_TYPE } else { crate::sql::MESHW_APP_COL_NULL };
    let q = format!("{}{wt_col}, {type_col}{}", crate::sql::MESHW_APP_BUILDERS_SELECT, crate::sql::MESHW_APP_BUILDERS_FROM);
    let Ok(mut st) = conn.prepare(&q) else { return Ok(None) };
    let Ok(mut rows) = st.query([]) else { return Ok(None) };
    // Map(id -> state): a repeated id keeps its first position with the last values (JavaScript Map.set)
    let mut order: Vec<String> = Vec::new();
    let mut map: HashMap<String, (bool, Option<String>, Option<String>)> = HashMap::new();
    while let Ok(Some(r)) = rows.next() {
        let Ok(idv) = r.get_ref(0) else { return Ok(None) };
        let Some(id) = js_str(idv) else { continue };
        let active = r.get_ref(1).map(js_num).unwrap_or(f64::NAN) == 1.0;
        let wt = match r.get_ref(2).ok().and_then(|v| if let ValueRef::Text(t) = v { Some(String::from_utf8_lossy(t).into_owned()) } else { None }) {
            Some(s) => norm_path(&s)?,
            None => None,
        };
        let bt = r.get_ref(3).ok().and_then(js_str);
        if !map.contains_key(&id) {
            order.push(id.clone());
        }
        map.insert(id, (active, wt, bt));
    }
    let Some(want) = norm_path(worktree)? else { return Ok(None) };
    let all: Vec<(String, bool, Option<String>)> = order
        .iter()
        .filter_map(|id| map.get(id).filter(|(_, wt, _)| wt.as_deref() == Some(want.as_str())).map(|(a, _, bt)| (id.clone(), *a, bt.clone())))
        .collect();
    let act: Vec<&(String, bool, Option<String>)> = all.iter().filter(|b| b.1).collect();
    let pool: Vec<&(String, bool, Option<String>)> = if act.is_empty() { all.iter().collect() } else { act };
    Ok((pool.len() == 1).then(|| Builder { id: pool[0].0.clone(), builder_type: pool[0].2.clone() }))
}

/// `isPrimaryCheckout(worktreeRoot, mainWorktree, home, env)`.
pub fn is_primary_checkout(wt: &str, main: Option<&str>, home: &Path, env: &Env) -> R<bool> {
    if let Some(b) = builder_for_worktree(home, env, wt)?
        && let Some(bt) = b.builder_type.filter(|s| !s.is_empty())
    {
        return Ok(bt == defaults::text("mesh_write.builder_type_primary"));
    }
    let main = main.map(|m| realpath(m).unwrap_or_else(|| m.to_string()));
    Ok(main.as_deref() == Some(wt))
}

/// `childSenderId(env, cwd, registry, home)`.
pub fn child_sender_id(env: &Env, cwd: &str, rows: &[Row], home: &Path) -> R<Option<String>> {
    let c = resolve_context(cwd, true)?;
    let Some(wt) = c.worktree_root.clone() else { return Ok(None) };
    if is_primary_checkout(&wt, c.main_worktree.as_deref(), home, env)? {
        return Ok(None);
    }
    if let Some(d) = declared_self_id(env, cwd, rows)? {
        return Ok(Some(d));
    }
    let mut on_wt: Vec<String> = Vec::new();
    for r in rows {
        if r.id.is_empty() || r.id.starts_with(defaults::text("mesh_write.primary_prefix")) {
            continue;
        }
        let Some(p) = r.worktree_path.as_deref() else { continue };
        if canonical_worktree_real_path(p)?.as_deref() == Some(wt.as_str()) && !on_wt.contains(&r.id) {
            on_wt.push(r.id.clone());
        }
    }
    if let Some(app) = builder_for_worktree(home, env, &wt)?
        && rows.iter().any(|r| r.id == app.id)
    {
        return Ok(Some(app.id));
    }
    Ok((on_wt.len() == 1).then(|| on_wt[0].clone()))
}

/// `senderIdentityDetailed(env, cwd, registry, home)`; the child case also returns the alias to record.
pub fn sender_identity_detailed(env: &Env, cwd: &str, rows: &[Row], home: &Path) -> R<Caller> {
    let d = caller_identity_detailed(env, cwd)?;
    if d.kind != defaults::text("mesh_write.kind_resolved") {
        return Ok(d);
    }
    match child_sender_id(env, cwd, rows, home)? {
        Some(child) if child != d.identity => Ok(Caller { identity: child, kind: defaults::text("mesh_write.kind_child").into(), mesh_id: Some(d.identity) }),
        _ => Ok(d),
    }
}

// ---- the reader nonce (companion/lib/reader-identity.js) ------------------------------------------------------------

/// The parent of `pid` as the kernel reports it, with no process spawned: `ps -ax` listed every process of the machine (about 16 ms of
/// CPU and a fork per hook call, at every Stop and prompt of a DevSwarm Primary). Where the system gives no such lookup the table of
/// `ps` is used.
#[cfg(any(target_os = "linux", target_os = "macos"))]
fn parent_of(pid: i64, _table: &mut Option<Option<HashMap<i64, i64>>>) -> Option<i64> {
    crate::procid::parent(u32::try_from(pid).ok()?).map(i64::from)
}

#[cfg(not(any(target_os = "linux", target_os = "macos")))]
fn parent_of(pid: i64, table: &mut Option<Option<HashMap<i64, i64>>>) -> Option<i64> {
    let t = table.get_or_insert_with(ppid_table);
    t.as_ref().and_then(|m| m.get(&pid)).copied()
}

#[cfg(not(any(target_os = "linux", target_os = "macos")))]
fn ppid_table() -> Option<HashMap<i64, i64>> {
    let out = std::process::Command::new(defaults::text("mesh_write.ps_bin"))
        .args(defaults::list("mesh_write.ps_ppid_args"))
        .stdin(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let mut m = HashMap::new();
    for line in String::from_utf8_lossy(&out.stdout).lines() {
        let p: Vec<&str> = line.split_whitespace().collect();
        if p.len() == 2
            && let (Ok(a), Ok(b)) = (p[0].parse::<i64>(), p[1].parse::<i64>())
        {
            m.insert(a, b);
        }
    }
    Some(m)
}

/// `processStartMs(pid)`: `Date.parse` of `ps -o lstart= -p <pid>` (local time), or None.
pub(crate) fn process_start_ms(pid: i64) -> Option<f64> {
    if let Some(ms) = native_start_ms(pid) {
        return Some(ms);
    }
    let out = std::process::Command::new(defaults::text("mesh_write.ps_bin"))
        .args(defaults::list("mesh_write.ps_lstart_args"))
        .arg(pid.to_string())
        .stdin(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    parse_lstart(String::from_utf8_lossy(&out.stdout).trim())
}

/// The start of `pid` in whole seconds, in milliseconds, from the kernel (what `ps -o lstart=` prints, with no process spawned); `None`
/// where the system gives no such lookup or the process is gone.
#[cfg(target_os = "macos")]
fn native_start_ms(pid: i64) -> Option<f64> {
    crate::procid::start(u32::try_from(pid).ok()?).map(|us| (us / 1_000_000 * 1000) as f64)
}

#[cfg(target_os = "linux")]
fn native_start_ms(pid: i64) -> Option<f64> {
    static BOOT_SECS: std::sync::OnceLock<Option<u64>> = std::sync::OnceLock::new();
    let boot = (*BOOT_SECS.get_or_init(|| {
        let text = std::fs::read_to_string("/proc/stat").ok()?;
        text.lines().find_map(|l| l.strip_prefix("btime ")?.trim().parse::<u64>().ok())
    }))?;
    // SAFETY: `sysconf` takes a constant and reads no memory.
    let hz = u64::try_from(unsafe { libc::sysconf(libc::_SC_CLK_TCK) }).ok().filter(|h| *h > 0)?;
    let ticks = crate::procid::start(u32::try_from(pid).ok()?)?;
    Some(((boot + ticks / hz) * 1000) as f64)
}

#[cfg(not(any(target_os = "linux", target_os = "macos")))]
fn native_start_ms(_pid: i64) -> Option<f64> {
    None
}

/// `Date.parse("Wed Oct  8 09:12:33 2026")` in the local time zone.
pub(crate) fn parse_lstart(s: &str) -> Option<f64> {
    let p: Vec<&str> = s.split_whitespace().collect();
    if p.len() != 5 {
        return None;
    }
    let mon = defaults::list("mesh_write.month_names").iter().position(|m| m.eq_ignore_ascii_case(p[1]))? as i32;
    let day: i32 = p[2].parse().ok()?;
    let hms: Vec<i32> = p[3].split(':').map(|x| x.parse().ok()).collect::<Option<Vec<i32>>>()?;
    if hms.len() != 3 {
        return None;
    }
    let year: i32 = p[4].parse().ok()?;
    // SAFETY: tm is fully initialized by zeroed() and then set field by field; mktime only reads and normalizes it.
    let mut tm: libc::tm = unsafe { std::mem::zeroed() };
    tm.tm_year = year - 1900;
    tm.tm_mon = mon;
    tm.tm_mday = day;
    tm.tm_hour = hms[0];
    tm.tm_min = hms[1];
    tm.tm_sec = hms[2];
    tm.tm_isdst = -1;
    // SAFETY: a valid, initialized tm.
    let t = unsafe { libc::mktime(&mut tm) };
    (t != -1).then_some(t as f64 * 1000.0)
}

fn pid_alive_raw(pid: i64) -> Option<bool> {
    if pid <= 0 || pid > i64::from(i32::MAX) {
        return None;
    }
    // SAFETY: signal 0 only probes for the process.
    let rc = unsafe { libc::kill(pid as i32, 0) };
    if rc == 0 {
        return Some(true);
    }
    match std::io::Error::last_os_error().raw_os_error() {
        Some(libc::ESRCH) => Some(false),
        Some(libc::EPERM) => Some(true),
        _ => None,
    }
}

/// `deriveReaderNonce({ home })`: `h:<pid>:<startMs>` of the nearest live harness ancestor (a `~/.claude/sessions/<pid>.json`
/// record), else None. Starts at this process.
pub fn reader_nonce(home: &Path) -> Option<String> {
    reader_nonce_from(home, i64::from(std::process::id()))
}

/// [`reader_nonce`] starting at `start` instead of this process: the daemon starts at the hook client that sent the request
/// (its peer on the socket), which is where the Node hook would have started, one process below the host.
pub fn reader_nonce_from(home: &Path, start: i64) -> Option<String> {
    let sess = home.join(defaults::text("mesh_write.claude_dir")).join(defaults::text("mesh_write.sessions_dir"));
    let mut table: Option<Option<HashMap<i64, i64>>> = None;
    let mut pid = start;
    let mut seen = std::collections::HashSet::new();
    for _ in 0..=defaults::num("mesh_write.max_ppid_hops") {
        if pid <= 1 || !seen.insert(pid) {
            return None;
        }
        let file = sess.join(format!("{pid}{}", defaults::text("mesh_write.json_suffix")));
        // a record that is no regular file or is over the cap is not one this walk can read safely: it counts as unreadable
        let rec = read_bounded(&file).ok().flatten().and_then(|b| OVal::parse(&String::from_utf8_lossy(&b)));
        if let Some(rec) = rec
            && matches!(rec.get("pid"), Some(OVal::Num(n)) if *n == pid as f64)
        {
            let since = std::fs::metadata(&file).ok().map(|m| m.mtime() as f64 * 1000.0 + m.mtime_nsec() as f64 / 1e6);
            let mut alive = pid_alive_raw(pid);
            if alive == Some(true)
                && let Some(s) = since
                && let Some(start) = process_start_ms(pid)
                && start > s
            {
                alive = Some(false);
            }
            if alive != Some(false) {
                let start = match rec.get("startedAt") {
                    Some(OVal::Num(n)) if n.is_finite() => *n,
                    _ => since.unwrap_or(0.0),
                };
                return Some(format!("{}{pid}:{}", defaults::text("mesh_write.nonce_prefix"), crate::checks::jsport::num::to_js_string(start)));
            }
        }
        pid = parent_of(pid, &mut table)?;
    }
    None
}

/// Test helpers for the bounded-read tests: a FIFO in a scratch directory and a run that fails when it blocks.
#[cfg(test)]
pub(crate) mod fifo_kit {
    use std::path::{Path, PathBuf};

    /// Runs `f` on a thread and returns its answer; fails when it takes longer than the bound (a read blocked on a FIFO).
    pub fn within<T: Send + 'static>(what: &str, f: impl FnOnce() -> T + Send + 'static) -> T {
        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || crate::discard::harmless(tx.send(f())));
        let bound = std::time::Duration::from_millis(crate::defaults::num("mesh_write.fifo_test_bound_ms"));
        rx.recv_timeout(bound).unwrap_or_else(|_| panic!("{what}: still blocked after {bound:?}"))
    }

    /// A fresh scratch directory.
    pub fn scratch(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("ah-fifo-{}-{tag}", std::process::id()));
        crate::discard::harmless(std::fs::remove_dir_all(&dir)); // keep: an absent directory is the goal state
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// `mkfifo(p)`.
    pub fn fifo(p: &Path) {
        let c = std::ffi::CString::new(p.to_string_lossy().as_bytes()).unwrap();
        // SAFETY: `c` is a NUL-terminated path that outlives the call; mkfifo only creates the node.
        assert_eq!(unsafe { libc::mkfifo(c.as_ptr(), 0o600) }, 0, "mkfifo");
    }
}

#[cfg(test)]
mod tests {
    use super::fifo_kit::*;
    use super::*;

    /// The kernel lookups that replaced `ps` answer as `ps` does: the parent of this process, and its start to the second.
    #[test]
    #[cfg(any(target_os = "linux", target_os = "macos"))]
    fn the_native_parent_and_start_answer_as_ps_does() {
        let me = i64::from(std::process::id());
        let ps = |args: &[&str]| {
            let out = std::process::Command::new(defaults::text("mesh_write.ps_bin")).args(args).arg(me.to_string()).output().unwrap();
            String::from_utf8_lossy(&out.stdout).trim().to_string()
        };
        let mut table = None;
        assert_eq!(parent_of(me, &mut table), ps(&["-o", "ppid=", "-p"]).parse::<i64>().ok());
        let via_ps = {
            let out = std::process::Command::new(defaults::text("mesh_write.ps_bin"))
                .args(defaults::list("mesh_write.ps_lstart_args"))
                .arg(me.to_string())
                .output()
                .unwrap();
            parse_lstart(String::from_utf8_lossy(&out.stdout).trim())
        };
        assert_eq!(native_start_ms(me), via_ps);
        assert_eq!(parent_of(i64::from(i32::MAX), &mut table), None, "a process that does not exist has no parent");
    }

    #[test]
    fn a_fifo_is_skipped_and_counted_at_once_instead_of_blocking() {
        let dir = scratch("skip");
        let f = dir.join("d.json");
        fifo(&f);
        let g = f.clone();
        assert_eq!(within("read_or_skip", move || read_or_skip(&g, "test")), None);
        std::fs::write(dir.join("ok.json"), b"{}").unwrap();
        assert_eq!(read_or_skip(&dir.join("ok.json"), "test"), Some(b"{}".to_vec()), "a regular file reads as before");
        assert_eq!(read_or_skip(&dir.join("none.json"), "test"), None, "an absent file is Node's caught read");
        crate::discard::harmless(std::fs::remove_dir_all(dir)); // keep: cleanup of a scratch directory
    }

    fn git(dir: &Path, args: &[&str]) {
        let st = std::process::Command::new("git")
            .current_dir(dir)
            .args(["-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "protocol.file.allow=always", "-c", "commit.gpgsign=false"])
            .args(args)
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .output()
            .unwrap();
        assert!(st.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&st.stderr));
    }

    /// A checkout inside a submodule keys the mesh on its superproject, so every verb that resolves a context may run there:
    /// the context's key is the superproject's, and its kind only labels the nesting (2026-10-23: four verbs deferred on the label).
    #[test]
    fn a_submodule_checkout_resolves_to_its_superprojects_key() {
        let root = scratch("submodule");
        let (sup, lib) = (root.join("sup"), root.join("lib"));
        std::fs::create_dir_all(&sup).unwrap();
        std::fs::create_dir_all(&lib).unwrap();
        git(&lib, &["init", "-q", "-b", "main"]);
        std::fs::write(lib.join("f"), "x").unwrap();
        git(&lib, &["add", "f"]);
        git(&lib, &["commit", "-q", "-m", "l"]);
        git(&sup, &["init", "-q", "-b", "main"]);
        git(&sup, &["submodule", "add", "-q", lib.to_str().unwrap(), "vendor/lib"]);
        git(&sup, &["commit", "-q", "-m", "s"]);
        let sup_s = sup.canonicalize().unwrap().to_str().unwrap().to_string();
        let sub = format!("{sup_s}/vendor/lib");
        let outer = resolve_context(&sup_s, true).unwrap();
        let inner = resolve_context(&sub, true).unwrap();
        assert!(inner.kind.starts_with(defaults::text("mesh_write.kind_submodule_prefix")), "{}", inner.kind);
        assert_eq!(inner.repo_key, outer.repo_key);
        assert!(inner.repo_key.is_some());
        crate::discard::harmless(std::fs::remove_dir_all(root)); // keep: cleanup of a scratch directory
    }

    // ---- the cases that used to hand the verb to Node (2026-10-23, #171) ----

    /// Node's `path.resolve` takes a relative path against the working directory; no verb defers on it.
    #[test]
    fn a_relative_path_is_taken_against_the_working_directory() {
        let cwd = std::env::current_dir().unwrap();
        let want = mesh_id_for_real_path(&format!("{}/rel-dir", cwd.display()));
        assert_eq!(raw_path_mesh_id("rel-dir").unwrap(), Some(want.clone()));
        assert_eq!(worktree_real_path("rel-dir/../rel-dir").unwrap(), format!("{}/rel-dir", cwd.display()));
        assert_eq!(primary_workspace_id("rel-dir").unwrap(), want);
        assert_eq!(abs_from_cwd("/a/b/../c"), "/a/c");
        let ctx = resolve_context("rel-dir-that-does-not-exist", false).unwrap();
        assert_eq!(ctx.kind, defaults::text("mesh_write.kind_deleted"));
    }

    /// An empty `cwd` is the process's own (`resolveContext` takes `process.cwd()` for it).
    #[test]
    fn an_empty_cwd_resolves_from_the_process_directory() {
        let c = resolve_context("", true).unwrap();
        let here = resolve_context(std::env::current_dir().unwrap().to_str().unwrap(), true).unwrap();
        assert_eq!(c, here);
    }

    /// A resolution git was never asked about is not uncertain.
    #[test]
    fn a_plain_checkout_resolves_with_certainty() {
        let root = scratch("certain");
        git(&root, &["init", "-q", "-b", "main"]);
        let c = resolve_context(root.canonicalize().unwrap().to_str().unwrap(), true).unwrap();
        assert!(c.repo_key.is_some() && !c.uncertain);
        crate::discard::harmless(std::fs::remove_dir_all(root)); // keep: cleanup of a scratch directory
    }

    /// A file past the soft limit is still read (counted and logged); a path past the hard limit reads as absent, as Node's failed read does.
    #[test]
    fn a_file_between_the_soft_and_hard_limit_is_read_and_one_past_the_hard_limit_is_absent() {
        let dir = scratch("limits");
        let soft = dir.join("soft.ndjson");
        std::fs::File::create(&soft).unwrap().set_len(defaults::num("mesh_write.file_read_max_bytes") + 1).unwrap();
        assert_eq!(read_bounded(&soft).unwrap().map(|b| b.len() as u64), Some(defaults::num("mesh_write.file_read_max_bytes") + 1));
        let hard = dir.join("hard.ndjson");
        std::fs::File::create(&hard).unwrap().set_len(defaults::num("mesh_write.file_read_hard_max_bytes") + 1).unwrap();
        assert_eq!(read_bounded(&hard).unwrap(), None);
        assert_eq!(read_or_skip(&hard, "test"), None);
        crate::discard::harmless(std::fs::remove_dir_all(dir)); // keep: cleanup of a scratch directory
    }

    /// A store that cannot be opened or written is the verb's own refusal (exit 2, `store-unavailable`), not a hand-over.
    #[test]
    fn an_unavailable_store_is_a_worded_refusal() {
        let err = unavailable::<()>("mesh_write.what_store", &"disk full").unwrap_err();
        let body = refusal_body(&err).unwrap();
        assert!(body.contains("store-unavailable") && body.contains("the mesh store is unavailable (disk full)"), "{body}");
        assert_eq!(js_to_string(&OVal::Arr(vec![OVal::Num(1.0), OVal::Null, OVal::Str("a".into())])), "1,,a");
        assert_eq!(js_to_string(&OVal::Obj(vec![])), "[object Object]");
    }

    /// A FIFO read as a mesh file is the verb's refusal (exit 2, `not-a-regular-file`), and returns at once.
    #[test]
    fn a_fifo_is_a_clean_refusal() {
        let dir = scratch("fifo-refusal");
        let f = dir.join("in.ndjson");
        fifo(&f);
        let g = f.clone();
        let err = within("read_bounded", move || read_bounded(&g)).unwrap_err();
        let body = refusal_body(&err).unwrap();
        assert!(body.contains("not-a-regular-file") && body.contains("in.ndjson"), "{body}");
        crate::discard::harmless(std::fs::remove_dir_all(dir)); // keep: cleanup of a scratch directory
    }
}
