//! Who the watcher is and whether it may arm: the settings it reads, the DevSwarm gate, the identity (child, Primary) and the
//! summary buckets of the project. Port of `isDevswarmActiveGate`, `resolveIdentity`, `realFormsOf`, `resolvePrimaryHashes`,
//! `resolveChildHashes` and `pollMsFromEnv` of `companion/lib/devswarm-wake-watch.js`, plus `readDescriptors` of
//! `companion/devswarm-supervisor.js`.
//!
//! Where Node would run git (a checkout nested in another one) the engine cannot reproduce the answer: the identity functions
//! return [`Defer`] and the verb is left to Node before anything is written.
use super::read::Hashes;
use crate::checks::git::util::Settings;
use crate::checks::guardkit::settings::{get_num, get_setting};
use crate::checks::guardkit::text::js_trim;
use crate::checks::jsport::json::J;
use crate::defaults;
use crate::meshw::ident::{self, Defer, Env, R};
use crate::meshw::idlock::{devswarm_root, is_safe_id};
use crate::migrate::{j_string, j_truthy};
use serde_json::Value;
use std::collections::HashSet;
use std::path::{Path, PathBuf};

/// The process the watcher runs in: its home, directory, environment and settings.
pub struct Proc {
    /// The home directory.
    pub home: PathBuf,
    /// The working directory.
    pub cwd: String,
    /// The environment.
    pub env: Env,
    /// The settings reader's view of both.
    pub st: Settings,
    /// The plugin root (the settings chain may depend on it).
    pub root: String,
}

impl Proc {
    /// The value of an environment variable named by the shipped key, trimmed; `None` when blank.
    pub fn env_nonblank(&self, key: &str) -> Option<String> {
        self.env.get(defaults::text(key)).map(|v| js_trim(v).to_string()).filter(|v| !v.is_empty())
    }

    /// `settings.getWithEnv(...) === false` for the boolean setting entry `key`; an undecidable read counts as "not false"
    /// (Node: any error arms as before).
    pub fn switched_off(&self, key: &str) -> bool {
        matches!(get_setting(&self.st, defaults::raw(key), None, &self.root), Ok(Some(Value::Bool(false))))
    }

    /// `pollMsFromEnv`: the poll interval in milliseconds, clamped to the schema's bounds.
    pub fn poll_ms(&self) -> u64 {
        let entry = defaults::raw("wake_watch.set_poll_ms");
        let n = get_num(&self.st, entry);
        let (lo, hi) = (defaults::num("wake_watch.poll_min_ms") as f64, defaults::num("wake_watch.poll_max_ms") as f64);
        n.clamp(lo, hi) as u64
    }
}

/// `isChildWorkspace(env)`: a non-blank `DEVSWARM_SOURCE_BRANCH`.
pub fn is_child_workspace(p: &Proc) -> bool {
    p.env_nonblank("wake_watch.env_source_branch").is_some()
}

/// The registered descriptors (`readDescriptors`): the `*.json` files of `workspaces/` that parse and carry a worktree path, a
/// session id and a safe id, in file-name order.
pub fn read_descriptors(home: &Path) -> Vec<J> {
    let dir = devswarm_root(home).join(defaults::text("mesh_write.dir_workspaces"));
    let Ok(rd) = std::fs::read_dir(&dir) else { return Vec::new() };
    let mut names: Vec<String> =
        rd.flatten().map(|e| e.file_name().to_string_lossy().into_owned()).filter(|n| n.ends_with(defaults::text("mesh_write.json_suffix"))).collect();
    names.sort_by(|a, b| a.as_bytes().cmp(b.as_bytes()));
    let mut out = Vec::new();
    for n in names {
        let Some(d) = super::read::read_text(&dir.join(&n)).and_then(|t| super::read::parse_json(&t)) else { continue };
        let safe_id = matches!(d.get("id"), Some(J::Str(s)) if is_safe_id(s));
        if matches!(d, J::Obj(_)) && j_truthy(d.get("worktreePath")) && j_truthy(d.get("sessionId")) && safe_id {
            out.push(d);
        }
    }
    out
}

/// A string member that is JavaScript-truthy.
pub fn str_member(d: &J, key: &str) -> Option<String> {
    match d.get(key) {
        Some(J::Str(s)) if !s.is_empty() => Some(s.clone()),
        Some(v) if j_truthy(Some(v)) => Some(j_string(v)),
        _ => None,
    }
}

/// `realFormsOf(p)`: the resolved path and its real path.
pub fn real_forms(p: &str, cwd: &str) -> HashSet<String> {
    let mut forms = HashSet::new();
    if p.is_empty() {
        return forms;
    }
    let resolved = ident::resolve(cwd, p);
    if let Some(real) = ident::realpath(&resolved) {
        forms.insert(real);
    }
    forms.insert(resolved);
    forms
}

/// The descriptor (if any) whose worktree is the working directory.
fn descriptor_at(descriptors: &[J], cwd: &str) -> Option<J> {
    let cwd_forms = real_forms(cwd, cwd);
    descriptors.iter().find(|d| str_member(d, "worktreePath").is_some_and(|wt| !real_forms(&wt, cwd).is_disjoint(&cwd_forms))).cloned()
}

/// `isDevswarmActive`: the kill switch, the supervisor mode, then the DevSwarm repo variable. `Err` when the mode needs a plugin root
/// the caller does not have. Keys: `spawn_ctx.*` (the same ones the compiled spawn-context helpers read).
fn devswarm_active(st: &Settings, plugin_root: &str) -> Result<bool, crate::checks::guardkit::settings::Undecidable> {
    if st.env.get(defaults::text("spawn_ctx.devswarm_kill_env")).map(String::as_str) == Some(defaults::text("spawn_ctx.devswarm_kill_value")) {
        return Ok(false);
    }
    let mode = get_setting(st, defaults::raw("spawn_ctx.supervisor_setting"), Some(Value::String("auto".into())), plugin_root)?;
    let mode = mode.as_ref().and_then(Value::as_str).map(|m| js_trim(m).to_lowercase()).unwrap_or_default();
    Ok(match mode.as_str() {
        "off" => false,
        "on" => true,
        _ => st.env.get(defaults::text("spawn_ctx.devswarm_repo_env")).is_some_and(|v| !js_trim(v).is_empty()),
    })
}

/// `isDevswarmActiveGate`: arms on positive evidence of DevSwarm and on nothing else.
pub fn gate(p: &Proc) -> R<bool> {
    // (a) the explicit opt-in / feature-detect
    match devswarm_active(&p.st, &p.root) {
        Ok(true) => return Ok(true),
        Ok(false) => {}
        Err(_) => return ident::defer("settings-undecidable"),
    }
    // (b) tier 1 of the identity: a child workspace with a builder id
    if is_child_workspace(p) && p.env_nonblank("mesh_write.env_builder_id").is_some() {
        return Ok(true);
    }
    // (c) tier 2: a registered descriptor for this directory
    if descriptor_at(&read_descriptors(&p.home), &p.cwd).is_some() {
        return Ok(true);
    }
    // (d) DevSwarm state on disk for this repo's own key
    if let Some(key) = ident::repo_key_for_worktree(&p.cwd)?
        && super::read::summary_path(&p.home, &key).exists()
    {
        return Ok(true);
    }
    Ok(false)
}

/// The resolved identity of a watcher.
#[derive(Clone, Debug)]
pub struct Identity {
    /// Watching as the Primary (otherwise as a child).
    pub primary: bool,
    /// The workspace id.
    pub id: String,
    /// The descriptor the identity was matched by (a child resolved by directory).
    pub descriptor: Option<J>,
}

impl Identity {
    /// The role word of the lines.
    pub fn role(&self) -> &'static str {
        if self.primary { defaults::text("wake_watch.role_primary") } else { defaults::text("wake_watch.role_child") }
    }
}

fn main_worktree(cwd: &str) -> R<Option<String>> {
    Ok(ident::resolve_context(cwd, false)?.main_worktree)
}

/// `resolveIdentity`: env first, then a descriptor matched by directory, then the Primary of the project.
pub fn resolve_identity(p: &Proc) -> R<Option<Identity>> {
    if is_child_workspace(p)
        && let Some(bid) = p.env_nonblank("mesh_write.env_builder_id")
    {
        return Ok(Some(Identity { primary: false, id: bid, descriptor: None }));
    }
    if let Some(d) = descriptor_at(&read_descriptors(&p.home), &p.cwd) {
        let id = str_member(&d, "id").unwrap_or_default();
        if id.starts_with(defaults::text("mesh_write.primary_prefix")) {
            // a Primary's own record: confirm it against the registered id of this repo before relabelling it
            let registered = match main_worktree(&p.cwd)? {
                Some(main) => Some(ident::primary_workspace_id(&main)?),
                None => None,
            };
            if registered.as_deref() == Some(id.as_str()) {
                return Ok(Some(Identity { primary: true, id, descriptor: None }));
            }
        }
        return Ok(Some(Identity { primary: false, id, descriptor: Some(d) }));
    }
    let Some(main) = main_worktree(&p.cwd)? else { return Ok(None) };
    let id = ident::primary_workspace_id(&main)?;
    Ok(if id.is_empty() { None } else { Some(Identity { primary: true, id, descriptor: None }) })
}

fn legacy_hash(id: &str) -> String {
    crate::meshw::send::hash_from_workspace_id(id)
}

/// `resolvePrimaryHashes`: the repo-key bucket and the legacy per-id bucket of the Primary.
pub fn primary_hashes(cwd: &str) -> R<Option<Hashes>> {
    let repo_key = ident::repo_key_for_worktree(cwd)?;
    let fallback = match main_worktree(cwd)? {
        Some(main) => Some(legacy_hash(&ident::primary_workspace_id(&main)?)),
        None => None,
    };
    if repo_key.is_none() && fallback.is_none() {
        return Ok(None);
    }
    let fallback = fallback.filter(|f| Some(f) != repo_key.as_ref());
    Ok(Some(Hashes { repo_key, fallback }))
}

/// `resolveChildHashes`: the repo-key bucket and the child's own legacy bucket.
pub fn child_hashes(cwd: &str, id: &str) -> R<Option<Hashes>> {
    let repo_key = ident::repo_key_for_worktree(cwd)?;
    let fallback = (!id.is_empty()).then(|| legacy_hash(id));
    if repo_key.is_none() && fallback.is_none() {
        return Ok(None);
    }
    let fallback = fallback.filter(|f| Some(f) != repo_key.as_ref());
    Ok(Some(Hashes { repo_key, fallback }))
}

/// A deferral reason for a caller that wants the code only.
pub fn defer_reason(d: &Defer) -> &str {
    &d.0
}
