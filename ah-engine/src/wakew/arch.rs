//! The archived-workspace questions of the wake watcher: is MY child workspace archived (then the watcher stays silent), and
//! does this Primary have no live child (then it need not arm at all). Port of `isOwnChildArchived` of
//! `companion/lib/devswarm-wake-watch.js` and of `idleSkipApplies` / `liveChildState` of
//! `companion/lib/devswarm-live-children.js`, over the parts of `row-eligibility.js` / `row-state.js` /
//! `devswarm-archived.js` they use.
//!
//! One source stays with Node: the supervisor's active-list cache (`hivecontrol-active.json`), consulted only for a worktree
//! under the DevSwarm repos root that the app database has no opinion on. Where it could change the answer the engine reports
//! [`Live::Unsure`] and the verb is left to Node.
use super::who::{Proc, read_descriptors, str_member};
use crate::checks::guardkit::text::js_trim;
use crate::checks::jsport::json::J;
use crate::defaults;
use crate::meshw::ident::{self, R, defer};
use crate::meshw::idlock::{devswarm_root, is_safe_id};
use crate::migrate::j_string;
use std::path::Path;

fn text(key: &str) -> &'static str {
    defaults::text(key)
}

fn now_ms() -> i64 {
    crate::health::now_ms() as i64
}

fn real_sid(v: Option<&J>) -> Option<String> {
    match v {
        None | Some(J::Null) => None,
        Some(x) => Some(j_string(x)).filter(|s| !s.is_empty()),
    }
}

fn same_path(a: &str, b: &str) -> bool {
    if a.is_empty() || b.is_empty() {
        return false;
    }
    ident::realpath(a).unwrap_or_else(|| a.to_string()) == ident::realpath(b).unwrap_or_else(|| b.to_string())
}

fn read_json(path: &Path) -> Option<J> {
    super::read::read_text(path).and_then(|t| super::read::parse_json(&t))
}

/// `isArchivedWorkspace(home, id, worktreePath, { sessionId })`: anti-hall's own `archived/<id>.json` marker, unless the
/// workspace was re-registered under another session since.
fn marker_archived(home: &Path, id: &str, worktree: Option<&str>, session: Option<&str>) -> bool {
    if !is_safe_id(id) {
        return false;
    }
    let root = devswarm_root(home);
    let suffix = text("mesh_write.json_suffix");
    let Some(desc @ J::Obj(_)) = read_json(&root.join(text("mesh_write.dir_archived")).join(format!("{id}{suffix}"))) else { return false };
    if let Some(wt) = worktree.filter(|w| !w.is_empty()) {
        let archived_wt = match desc.get("worktreePath") {
            Some(J::Str(s)) if !s.is_empty() => Some(s.clone()),
            _ => None,
        };
        if archived_wt.is_some_and(|a| !same_path(&a, wt)) {
            return false;
        }
    }
    if let Some(marker_sid) = real_sid(desc.get("sessionId")) {
        let live_sid = session
            .filter(|s| !s.is_empty())
            .map(str::to_string)
            .or_else(|| read_json(&root.join(text("mesh_write.dir_workspaces")).join(format!("{id}{suffix}"))).and_then(|d| real_sid(d.get("sessionId"))));
        if live_sid.is_some_and(|l| l != marker_sid) {
            return false;
        }
    }
    true
}

/// What the DevSwarm app database says about a workspace (`appArchivedVerdict`): `Some(true)` archived, `Some(false)` active,
/// `None` no opinion (also when the engine cannot reproduce the read: the fail-open answer of the Node caller).
fn app_verdict(p: &Proc, id: &str, worktree: Option<&str>) -> Option<bool> {
    crate::meshw::appdb::archived_verdict(&p.home, &p.env, now_ms(), id, worktree, false).ok().and_then(|(v, _)| v)
}

/// `isOwnChildArchived(identity, env)`: true only for a child whose descriptor is archived. Fail-open: any doubt reads false.
pub fn own_child_archived(p: &Proc, id: &str) -> bool {
    if p.switched_off("wake_watch.set_archived_stop") {
        return false;
    }
    let root = devswarm_root(&p.home);
    let active_path = root.join(text("mesh_write.dir_workspaces")).join(format!("{id}{}", text("mesh_write.json_suffix")));
    let active = active_path.exists();
    let mut worktree = if active { read_json(&active_path).and_then(|d| str_member(&d, "worktreePath")) } else { None };
    if worktree.is_none() {
        worktree = ident::resolve_context(&p.cwd, true).ok().and_then(|c| c.toplevel);
    }
    let Some(wt) = worktree else { return false };
    let marker = marker_archived(&p.home, id, Some(&wt), None);
    let verdict = app_verdict(p, id, Some(&wt));
    // The projection's own guards: with an ACTIVE descriptor only the app database may call it archived, and only when it says
    // so by id or worktree; without one, anti-hall's marker must say so and the app database must not say it is active.
    if active { verdict == Some(true) } else { marker && verdict != Some(false) }
}

/// The answer to "does this Primary have a live child?".
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Live {
    /// At least one child is live (or nothing proves otherwise): arm.
    Yes,
    /// Positive proof of zero live children: the idle-skip applies.
    No,
    /// The answer depends on a source the engine does not read: leave the verb to Node.
    Unsure,
}

fn held_ids(p: &Proc) -> Vec<String> {
    let csv = |v: &str| -> Vec<String> { v.split(',').map(|s| js_trim(s).to_string()).filter(|s| !s.is_empty()).collect() };
    if let Some(v) = p.env.get(text("mesh_write.held_partitions_env")).map(|v| js_trim(v).to_string()).filter(|v| !v.is_empty()) {
        return csv(&v);
    }
    let file = format!("{}/{}", p.st.home, text("guardkit.settings_file"));
    let from_file = super::read::read_text(Path::new(&file)).and_then(|t| super::read::parse_json(&t)).and_then(|o| {
        o.get(text("mesh_write.settings_devswarm_section")).and_then(|s| s.get(text("mesh_write.held_partitions_key"))).and_then(|v| match v {
            J::Str(s) => Some(csv(s)).filter(|c| !c.is_empty()),
            _ => None,
        })
    });
    from_file.unwrap_or_default()
}

fn under_repos_root(path: &str, cwd: &str) -> bool {
    let resolved = ident::resolve(cwd, path);
    let normalized = ident::realpath(&resolved).unwrap_or(resolved);
    crate::checks::guardkit::jsre::compile(text("wake_watch.repos_root_re"), false).is_match(&normalized)
}

/// `liveChildState` with `excludeHeldIgnored`, answered as the idle-skip needs it.
fn live_children(p: &Proc) -> R<Live> {
    let descriptors = read_descriptors(&p.home);
    if descriptors.is_empty() {
        return Ok(Live::No);
    }
    let Some(self_key) = ident::repo_key_for_worktree(&p.cwd)? else { return Ok(Live::Yes) };
    let self_real = ident::realpath(&p.cwd).unwrap_or_else(|| p.cwd.clone());
    let held = held_ids(p);
    let ignore_dir = devswarm_root(&p.home).join(text("wake_watch.dir_archive_ignore"));
    let mut unsure = false;
    for d in &descriptors {
        let (Some(wt), Some(id)) = (str_member(d, "worktreePath"), str_member(d, "id")) else { continue };
        let d_real = ident::realpath(&wt).unwrap_or_else(|| wt.clone());
        if d_real == self_real {
            continue;
        }
        if ident::repo_key_for_worktree(&wt)?.as_deref() != Some(self_key.as_str()) {
            continue;
        }
        // held and archive-ignored children count as zero live, like archived ones
        if held.contains(&id) || ignore_dir.join(format!("{id}{}", text("mesh_write.json_suffix"))).exists() {
            continue;
        }
        let session = str_member(d, "sessionId");
        if marker_archived(&p.home, &id, Some(&wt), session.as_deref()) {
            continue;
        }
        match app_verdict(p, &id, Some(&wt)) {
            Some(true) => continue,
            Some(false) => return Ok(Live::Yes),
            None => {}
        }
        // no opinion from the app database: only the supervisor's active-list cache could still call it archived, and only for
        // a worktree under the DevSwarm repos root while that cache exists
        if under_repos_root(&wt, &p.cwd) && devswarm_root(&p.home).join(text("wake_watch.active_cache_file")).exists() {
            unsure = true;
            continue;
        }
        return Ok(Live::Yes);
    }
    Ok(if unsure { Live::Unsure } else { Live::No })
}

/// `idleSkipApplies(home, cwd, { env })` for a Primary: `No` means "arm", `Yes`/`Unsure` need Node's line.
pub fn idle_skip(p: &Proc) -> R<IdleSkip> {
    if p.switched_off("wake_watch.set_idle_skip") {
        return Ok(IdleSkip::NotApplicable);
    }
    Ok(match live_children(p)? {
        Live::Yes => IdleSkip::NotApplicable,
        Live::No => IdleSkip::Applies,
        Live::Unsure => return defer("active-list-cache"),
    })
}

/// The idle-skip decision.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum IdleSkip {
    /// There is a live child, or the setting is off: arm.
    NotApplicable,
    /// No live child: Node prints its one idle line and exits.
    Applies,
}
