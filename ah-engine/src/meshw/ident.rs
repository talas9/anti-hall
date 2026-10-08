//! Who is calling and which project they are in, resolved the way Node's mesh CLI does it, or not at all.
//!
//! Ports `companion/lib/identity.js` `resolveContext` (git-free: `.git` files and directories, `commondir`, absorbed
//! submodules), `install-devswarm-ingest.js` `primaryWorkspaceId`, `devswarm-lib/identity.js` `callerIdentityDetailed`,
//! `projectCwdFor`, `childSenderId`, `senderIdentityDetailed`, `declaredSelfId`, `canonicalMeshId`,
//! `canonicalWorktreeRealPath`, `rawPathMeshId`, `companion/lib/devswarm-app-db.js` `builderForWorktree` and
//! `companion/lib/reader-identity.js` `deriveReaderNonce`.
//!
//! Node answers some of these by running git (`rev-parse --show-superproject-working-tree` for a checkout nested in
//! another one). The engine never runs git here: where Node would, the answer is [`Defer`] and the verb goes to Node.
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

/// The engine cannot reproduce Node's answer here without running what Node runs; the verb goes to Node.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Defer(pub String);

/// Shorthand for a deferral with a reason code (the code names a `mesh_write.defer_*` setting's purpose).
pub fn defer<T>(code: &str) -> Result<T, Defer> {
    Err(Defer(code.to_string()))
}

/// Result of a resolution that may defer.
pub type R<T> = Result<T, Defer>;

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
    if !wt.starts_with('/') {
        return defer("relative-path");
    }
    Ok(realpath(wt).unwrap_or_else(|| resolve_abs(wt)))
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
    if !p.starts_with('/') {
        return defer("relative-path");
    }
    Ok(Some(mesh_id_for_real_path(&resolve_abs(p))))
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

/// Whether `<gitdir>/config` names a `core.worktree` (Node then hops to that checkout; the engine defers).
fn has_core_worktree(gitdir: &str) -> bool {
    let Ok(cfg) = std::fs::read(format!("{gitdir}/{}", defaults::text("mesh_write.git_config_file"))) else { return false };
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
            && rest.trim_start().starts_with('=')
        {
            return true;
        }
    }
    false
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
}

fn null_ctx(kind: &str) -> Ctx {
    Ctx { kind: kind.to_string(), ..Ctx::default() }
}

/// `resolveContext(cwd, { memo: false, superCache: true, missingPath })`; `ancestor` = `missingPath: 'ancestor'`.
pub fn resolve_context(cwd: &str, ancestor: bool) -> R<Ctx> {
    if !cwd.starts_with('/') {
        return defer("relative-path");
    }
    let abs = resolve_abs(cwd);
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
    // superOf(root, ri): Some(Some(p)) a superproject, Some(None) none, Err when only git can tell
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
                return Ok(None);
            }
        }
        defer("git-superproject")
    };
    let mut root = t.clone();
    let t = t.clone();
    let mut ri = info;
    let mut depth = 0u64;
    while depth < defaults::num("mesh_write.max_submodule_hops") {
        let sp = super_of(&root, &ri)?;
        if sp.is_none() && ri.is_file && ri.has_commondir && has_core_worktree(&ri.common) {
            return defer("core-worktree");
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
    if !p.starts_with('/') {
        return defer("relative-path");
    }
    let r = resolve_abs(p);
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
        ValueRef::Real(f) => Some(crate::checks::guardkit::ojson::js_number_text(f)),
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
    let Ok(conn) = rusqlite::Connection::open_with_flags(&file, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX) else {
        return Ok(None);
    };
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
fn process_start_ms(pid: i64) -> Option<f64> {
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
    let sess = home.join(defaults::text("mesh_write.claude_dir")).join(defaults::text("mesh_write.sessions_dir"));
    let mut table: Option<Option<HashMap<i64, i64>>> = None;
    let mut pid = i64::from(std::process::id());
    let mut seen = std::collections::HashSet::new();
    for _ in 0..=defaults::num("mesh_write.max_ppid_hops") {
        if pid <= 1 || !seen.insert(pid) {
            return None;
        }
        let file = sess.join(format!("{pid}{}", defaults::text("mesh_write.json_suffix")));
        let rec = std::fs::read(&file).ok().and_then(|b| OVal::parse(&String::from_utf8_lossy(&b)));
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
                return Some(format!("{}{pid}:{}", defaults::text("mesh_write.nonce_prefix"), crate::checks::guardkit::ojson::js_number_text(start)));
            }
        }
        let t = table.get_or_insert_with(ppid_table);
        pid = *t.as_ref().and_then(|m| m.get(&pid))?;
    }
    None
}
