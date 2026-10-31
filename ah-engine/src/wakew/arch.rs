//! The archived-workspace questions of the wake watcher: is MY child workspace archived (then the watcher stays silent), and
//! does this Primary have no live child (then it need not arm at all). Port of `isOwnChildArchived` of
//! `companion/lib/devswarm-wake-watch.js` and of `idleSkipApplies` / `liveChildState` of
//! `companion/lib/devswarm-live-children.js`, over the parts of `row-eligibility.js` / `row-state.js` /
//! `devswarm-archived.js` they use.
//!
//! The supervisor's active-list cache (`hivecontrol-active.json`, `isAppArchived` of `companion/lib/devswarm-archived-cache.js`) is
//! read for a worktree under the DevSwarm repos root that the app database has no opinion on: a fresh snapshot of the project that
//! lists neither the child's id nor its worktree, and is at least the grace newer than the child's descriptor, calls it archived.
use super::who::{Proc, read_checkout_rows, read_descriptors, str_member};
use crate::checks::guardkit::text::js_trim;
use crate::checks::jsport::json::J;
use crate::defaults;
use crate::meshw::ident::{self, R};
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

/// `normalizeWorktreePath(p)`: `path.resolve` (against the working directory), then the real path when it exists.
fn normalize_wt(p: &str, cwd: &str) -> String {
    let resolved = ident::resolve(cwd, p);
    ident::realpath(&resolved).unwrap_or(resolved)
}

/// `resolveArchivedCacheMaxAgeMs(env)`: the variable when it is a positive integer, else a multiple of the reconcile sweep interval.
fn active_max_age_ms(p: &Proc) -> f64 {
    let from_env = p
        .env
        .get(text("wake_watch.env_active_max_age"))
        .map(|v| v.trim())
        .filter(|v| !v.is_empty() && v.bytes().all(|b| b.is_ascii_digit()))
        .and_then(|v| v.parse::<f64>().ok())
        .filter(|n| *n > 0.0);
    if let Some(n) = from_env {
        return n;
    }
    let sec = crate::checks::guardkit::settings::get_num(&p.st, defaults::raw("devswarm_sup.set_reconcile_sec"));
    let sweep = if sec.is_finite() && sec > 0.0 { sec * 1000.0 } else { defaults::num("wake_watch.sweep_fallback_ms") as f64 };
    defaults::num("wake_watch.active_max_age_mult") as f64 * sweep
}

/// `isAppArchived({ home, repoKey, id, worktreePath })` for a row under the app's repos root: the project's snapshot is fresh and
/// holds records, lists none with the row's id or worktree, and is at least the grace newer than the row's descriptor (a row the
/// snapshot predates is not archived by its absence). Every unknown answers no.
fn absent_from_active_list(p: &Proc, repo_key: &str, id: &str, worktree: &str) -> bool {
    let Some(snap @ J::Obj(_)) = read_json(&devswarm_root(&p.home).join(text("wake_watch.active_cache_file"))) else { return false };
    let Some(J::Num(fetched_at)) = snap.get("fetchedAt").filter(|v| matches!(v, J::Num(n) if n.is_finite())) else { return false };
    let age = now_ms() as f64 - fetched_at;
    if !(age >= 0.0 && age <= active_max_age_ms(p)) {
        return false;
    }
    let Some(J::Obj(by_repo)) = snap.get("byRepoKey") else { return false };
    let Some(J::Arr(records)) = by_repo.iter().rev().find(|(k, _)| k == repo_key).map(|(_, v)| v) else { return false };
    let mut listed: Vec<(String, Option<String>)> = Vec::new();
    for r in records {
        if !matches!(r, J::Obj(_) | J::Arr(_)) {
            continue;
        }
        let rid = match r.get("id") {
            None | Some(J::Null) => String::new(),
            Some(x) => j_string(x),
        };
        if rid.is_empty() {
            continue;
        }
        let rwt = match r.get("worktreePath") {
            Some(J::Str(w)) if !w.is_empty() => Some(normalize_wt(w, &p.cwd)),
            _ => None,
        };
        listed.push((rid, rwt));
    }
    if listed.is_empty() {
        return false;
    }
    let want = normalize_wt(worktree, &p.cwd);
    if listed.iter().any(|(rid, rwt)| rid == id || rwt.as_deref() == Some(want.as_str())) {
        return false;
    }
    let first_seen = std::fs::metadata(devswarm_root(&p.home).join(text("mesh_write.dir_workspaces")).join(format!("{id}{}", text("mesh_write.json_suffix"))))
        .ok()
        .and_then(|m| m.modified().ok())
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs_f64() * 1000.0)
        .filter(|ms| ms.is_finite());
    let Some(first_seen) = first_seen else { return false };
    let grace = crate::checks::guardkit::settings::get_num(&p.st, defaults::raw("wake_watch.set_archived_grace_ms"));
    fetched_at - first_seen >= grace
}

/// `liveChildState` with `excludeHeldIgnored`, answered as the idle-skip needs it.
fn live_children(p: &Proc) -> R<Live> {
    let mut descriptors = read_descriptors(&p.home);
    // GH #507: a child registered a moment ago has a descriptor but no session yet; it is live for the spawn grace
    let grace_ms = crate::checks::guardkit::settings::get_num(&p.st, defaults::raw("wake_watch.set_spawn_grace_sec")) * 1000.0;
    if grace_ms.is_finite() && grace_ms > 0.0 {
        let dir = devswarm_root(&p.home).join(text("mesh_write.dir_workspaces"));
        for d in read_checkout_rows(&p.home) {
            let Some(id) = str_member(&d, "id") else { continue };
            if str_member(&d, "sessionId").is_some() {
                continue;
            }
            let age = std::fs::metadata(dir.join(format!("{id}{}", text("mesh_write.json_suffix"))))
                .ok()
                .and_then(|m| m.modified().ok())
                .and_then(|t| std::time::SystemTime::now().duration_since(t).ok())
                .map(|a| a.as_secs_f64() * 1000.0);
            if age.is_some_and(|a| a <= grace_ms) {
                crate::metrics::bump("wake_watch_spawn_grace_live", &[]);
                descriptors.push(d);
            }
        }
    }
    if descriptors.is_empty() {
        return Ok(Live::No);
    }
    let Some(self_key) = ident::repo_key_for_worktree(&p.cwd)? else { return Ok(Live::Yes) };
    let self_real = ident::realpath(&p.cwd).unwrap_or_else(|| p.cwd.clone());
    let held = held_ids(p);
    let ignore_dir = devswarm_root(&p.home).join(text("wake_watch.dir_archive_ignore"));
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
        // a worktree under the DevSwarm repos root
        if under_repos_root(&wt, &p.cwd) && absent_from_active_list(p, &self_key, &id, &wt) {
            continue;
        }
        return Ok(Live::Yes);
    }
    Ok(Live::No)
}

/// `idleSkipApplies(home, cwd, { env })` for a Primary: `NotApplicable` means "arm", `Applies` is Node's one idle line.
pub fn idle_skip(p: &Proc) -> R<IdleSkip> {
    if p.switched_off("wake_watch.set_idle_skip") {
        return Ok(IdleSkip::NotApplicable);
    }
    Ok(match live_children(p)? {
        Live::Yes => IdleSkip::NotApplicable,
        Live::No => IdleSkip::Applies,
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{Duration, SystemTime};

    const KEY: &str = "proj-aaaaaaaa";

    fn proc_in(tag: &str) -> Proc {
        let home = std::env::temp_dir().join(format!("ah-arch-{tag}-{}", std::process::id()));
        crate::discard::harmless(std::fs::remove_dir_all(&home)); // keep: an absent directory is the goal state
        std::fs::create_dir_all(&home).unwrap();
        let home_s = home.to_string_lossy().into_owned();
        Proc {
            home,
            cwd: home_s.clone(),
            env: Default::default(),
            st: crate::checks::git::util::Settings { home: home_s, env: Default::default() },
            root: String::new(),
        }
    }

    /// The active-list snapshot and the child's descriptor, `age` old.
    fn seed(p: &Proc, fetched_ago_ms: f64, listed: &[(&str, &str)], descriptor_age: Duration) {
        let root = devswarm_root(&p.home);
        std::fs::create_dir_all(root.join("workspaces")).unwrap();
        let recs: Vec<String> = listed.iter().map(|(id, wt)| format!(r#"{{"id":"{id}","worktreePath":"{wt}"}}"#)).collect();
        let snap = format!(r#"{{"fetchedAt":{},"byRepoKey":{{"{KEY}":[{}]}},"recordCount":{}}}"#, now_ms() as f64 - fetched_ago_ms, recs.join(","), recs.len());
        std::fs::write(root.join(text("wake_watch.active_cache_file")), snap).unwrap();
        let f = std::fs::File::create(root.join("workspaces").join("child-1.json")).unwrap();
        f.set_modified(SystemTime::now() - descriptor_age).unwrap();
    }

    /// A fresh snapshot of the project that lists neither the id nor the worktree, and is older than the grace past the descriptor, is
    /// Node's `isAppArchived`: the child is not live (this used to hand the whole verb to Node).
    #[test]
    fn a_child_absent_from_a_fresh_active_list_reads_as_archived_in_the_app() {
        let p = proc_in("absent");
        let hour = Duration::from_secs(3600);
        seed(&p, 1000.0, &[("someone-else", "/w/other")], 2 * hour);
        assert!(absent_from_active_list(&p, KEY, "child-1", "/w/child"));
        assert!(!absent_from_active_list(&p, "other-key", "child-1", "/w/child"), "no snapshot of this project is no evidence");
        seed(&p, 1000.0, &[("child-1", "/w/else")], 2 * hour);
        assert!(!absent_from_active_list(&p, KEY, "child-1", "/w/child"), "listed by id");
        seed(&p, 1000.0, &[("x", "/w/child")], 2 * hour);
        assert!(!absent_from_active_list(&p, KEY, "child-1", "/w/child"), "listed by worktree");
        seed(&p, 1000.0, &[("x", "/w/other")], Duration::from_secs(60));
        assert!(!absent_from_active_list(&p, KEY, "child-1", "/w/child"), "a child the snapshot barely predates is not archived by its absence");
        seed(&p, 10.0 * 3600.0 * 1000.0, &[("x", "/w/other")], 20 * hour);
        assert!(!absent_from_active_list(&p, KEY, "child-1", "/w/child"), "a stale snapshot is ignored");
    }

    #[test]
    fn just_spawned_child_without_session_is_live_within_grace_only() {
        let mut p = proc_in("spawn-grace");
        let git = |dir: &Path, args: &[&str]| {
            let ok = std::process::Command::new("git")
                .args(["-c", "user.name=t", "-c", "user.email=t@example.invalid"])
                .args(args)
                .current_dir(dir)
                .env("HOME", &p.home)
                .env("GIT_CONFIG_NOSYSTEM", "1")
                .output()
                .unwrap()
                .status
                .success();
            assert!(ok, "git {args:?}");
        };
        let main = p.home.join("primary");
        std::fs::create_dir_all(&main).unwrap();
        git(&main, &["init", "-q"]);
        git(&main, &["commit", "-q", "--allow-empty", "-m", "init"]);
        let kid = p.home.join("kid");
        git(&main, &["worktree", "add", "-q", kid.to_str().unwrap(), "-b", "kid"]);
        p.cwd = main.to_string_lossy().into_owned();
        let dir = p.home.join(".anti-hall/devswarm/workspaces");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("kid-1.json"), format!(r#"{{"id":"kid-1","worktreePath":"{}","sessionId":null}}"#, kid.display())).unwrap();
        // inside the grace the session-less descriptor is a live child: keep the watcher armed
        assert_eq!(idle_skip(&p).ok(), Some(IdleSkip::NotApplicable), "a just-registered child must keep the watcher armed");
        // grace off: the descriptor is ignored as before
        p.st.env.insert("ANTIHALL_DEVSWARM_WAKE_WATCH_SPAWN_GRACE_SEC".into(), "0".into());
        assert_eq!(idle_skip(&p).ok(), Some(IdleSkip::Applies));
    }
}
